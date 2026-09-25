"""Private one-operation JSON-RPC peer for contained desktop test commands."""

from __future__ import annotations

import os
import queue
import sys
import threading
from pathlib import Path
from typing import Any, BinaryIO, Callable

from sidecar.ai.tools.builtins.owned_process import OwnedProcessService
from sidecar.protocol import (
    API_VERSION,
    CONTENT_LENGTH_HEADER,
    WORKSPACE_TEST_CANCEL_METHOD,
    WORKSPACE_TEST_CLEANUP_METHOD,
    WORKSPACE_TEST_CLOSE_METHOD,
    WORKSPACE_TEST_RUN_METHOD,
)
from sidecar.runtime.external_child_env import external_child_environment
from sidecar.runtime.framing import read_framed_message, write_framed_message
from sidecar.runtime.rpc import JsonRpcEnvelopeError, result_response, validate_jsonrpc_envelope

WORKSPACE_TEST_HELPER_FLAG = "--workspace-test-runner-helper"
MAX_MESSAGE_BYTES = 1024 * 1024
MAX_COMMAND_CHARS = 32 * 1024
MAX_PATH_CHARS = 32 * 1024
MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000
MAX_OUTPUT_LIMIT = 64 * 1024
MAX_ENV_KEYS = 128
MAX_ENV_KEY_CHARS = 256


def _read(stream: BinaryIO) -> dict[str, Any]:
    return read_framed_message(
        stdin_buffer=stream,
        content_length_header=CONTENT_LENGTH_HEADER,
        max_content_length_bytes=MAX_MESSAGE_BYTES,
    )


def _write(stream: BinaryIO, message: dict[str, Any]) -> None:
    write_framed_message(
        stdout_buffer=stream,
        content_length_header=CONTENT_LENGTH_HEADER,
        message=message,
    )


def _token(value: Any, limit: int) -> str:
    return value if isinstance(value, str) and value and len(value) <= limit else ""


def _validate_run(message: dict[str, Any]) -> tuple[str | int, dict[str, Any]]:
    envelope = validate_jsonrpc_envelope(message)
    params = envelope.params
    expected = {
        "accept_version", "command", "cwd", "operation_id",
        "output_limit", "timeout_ms", "user_env",
    }
    operation_id = _token(params.get("operation_id"), 128)
    command = _token(params.get("command"), MAX_COMMAND_CHARS)
    cwd = _token(params.get("cwd"), MAX_PATH_CHARS)
    timeout_ms = params.get("timeout_ms")
    output_limit = params.get("output_limit")
    user_env = params.get("user_env")
    if (
        envelope.kind != "request"
        or envelope.method != WORKSPACE_TEST_RUN_METHOD
        or envelope.message_id != operation_id
        or set(params) != expected
        or params.get("accept_version") != API_VERSION
        or not operation_id
        or not command
        or not cwd
        or not isinstance(timeout_ms, int)
        or isinstance(timeout_ms, bool)
        or not 1 <= timeout_ms <= MAX_TIMEOUT_MS
        or not isinstance(output_limit, int)
        or isinstance(output_limit, bool)
        or not 1 <= output_limit <= MAX_OUTPUT_LIMIT
        or not isinstance(user_env, dict)
        or len(user_env) > MAX_ENV_KEYS
        or any(
            not isinstance(key, str)
            or not key
            or len(key) > MAX_ENV_KEY_CHARS
            or not isinstance(value, str)
            or len(value) > 32 * 1024
            or "\x00" in key
            or "\x00" in value
            for key, value in user_env.items()
        )
    ):
        raise ValueError("workspace test run request is invalid")
    return envelope.message_id, {
        "operation_id": operation_id,
        "command": command,
        "cwd": cwd,
        "timeout_ms": timeout_ms,
        "output_limit": output_limit,
        "user_env": user_env,
    }


def _shell_argv(command: str) -> list[str]:
    if os.name == "nt":
        return ["cmd.exe", "/d", "/s", "/c", command]
    return ["/bin/sh", "-c", command]


def _cleanup_payload(verdict: Any) -> dict[str, Any]:
    metadata = verdict.metadata()
    return {
        "cleanup": metadata["cleanup"],
        "process_tree_terminated": metadata["process_tree_terminated"],
        "output_readers_terminated": metadata["output_readers_terminated"],
        "reason": metadata["reason"],
    }


def _reader(
    stream: BinaryIO,
    operation_id: str,
    abort_event: threading.Event,
    inbox: queue.Queue[dict[str, Any]],
) -> None:
    try:
        while True:
            message = _read(stream)
            envelope = validate_jsonrpc_envelope(message)
            if envelope.method == WORKSPACE_TEST_CANCEL_METHOD and envelope.kind == "request":
                if envelope.message_id is None and envelope.params == {
                    "operation_id": operation_id
                }:
                    abort_event.set()
                    continue
            if envelope.method == WORKSPACE_TEST_CLEANUP_METHOD and envelope.kind == "request":
                if envelope.message_id == f"{operation_id}:cleanup" and envelope.params == {
                    "operation_id": operation_id
                }:
                    inbox.put(message)
                    continue
            if envelope.method == WORKSPACE_TEST_CLOSE_METHOD and envelope.kind == "request":
                if envelope.message_id is None and envelope.params == {
                    "operation_id": operation_id
                }:
                    inbox.put({"terminal_close": True})
                    return
            raise ValueError("workspace test helper received an invalid follow-up")
    except (EOFError, OSError, ValueError, JsonRpcEnvelopeError) as error:
        abort_event.set()
        inbox.put({"terminal_error": str(error)})


def run_workspace_test_helper(
    stdin_buffer: BinaryIO | None = None,
    stdout_buffer: BinaryIO | None = None,
    *,
    service_factory: Callable[..., OwnedProcessService] = OwnedProcessService,
    platform_name: str = os.name,
) -> int:
    if platform_name != "nt":
        return 5
    stdin = stdin_buffer or sys.stdin.buffer
    stdout = stdout_buffer or sys.stdout.buffer
    try:
        message_id, request = _validate_run(_read(stdin))
    except (EOFError, OSError, ValueError, JsonRpcEnvelopeError):
        return 2
    operation_id = request["operation_id"]
    abort_event = threading.Event()
    inbox: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=8)
    reader = threading.Thread(
        target=_reader,
        args=(stdin, operation_id, abort_event, inbox),
        name="workspace-test-helper-control",
        daemon=True,
    )
    reader.start()
    env = external_child_environment()
    env.update(request["user_env"])
    service = service_factory(
        max_active=1,
        max_queued=0,
        max_capture_bytes=request["output_limit"] * 2,
    )
    try:
        result = service.run(
            _shell_argv(request["command"]),
            cwd=Path(request["cwd"]),
            timeout_seconds=request["timeout_ms"] / 1000,
            env=env,
            abort_event=abort_event,
        )
    except BaseException:
        return 3
    if result.aborted:
        status = "aborted"
    elif result.timed_out:
        status = "timeout"
    else:
        status = "passed" if result.returncode == 0 else "failed"
    cleanup = _cleanup_payload(result.cleanup_verdict)
    _write(stdout, result_response(message_id, {
        "schema_version": 1,
        "operation_id": operation_id,
        "status": status,
        "exit_code": result.returncode,
        "duration_ms": max(0, round(result.duration_seconds * 1000)),
        "stdout_tail": result.stdout,
        "stderr_tail": result.stderr,
        "cleanup": cleanup,
    }))
    while cleanup["cleanup"] != "confirmed":
        follow_up = inbox.get()
        if "terminal_error" in follow_up or "terminal_close" in follow_up:
            return 4
        envelope = validate_jsonrpc_envelope(follow_up)
        if envelope.method != WORKSPACE_TEST_CLEANUP_METHOD:
            continue
        verdicts = service.retry_quarantined_cleanup()
        verdict = verdicts[-1] if verdicts else result.cleanup_verdict
        cleanup = _cleanup_payload(verdict)
        _write(stdout, result_response(envelope.message_id, {
            "schema_version": 1,
            "operation_id": operation_id,
            "cleanup": cleanup,
        }))
    terminal = inbox.get()
    if "terminal_close" not in terminal:
        return 4
    reader.join(timeout=1)
    return 0 if not reader.is_alive() else 4


__all__ = ["WORKSPACE_TEST_HELPER_FLAG", "run_workspace_test_helper"]
