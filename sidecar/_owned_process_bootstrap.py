"""Owned-process bootstrap wire contract -- STDLIB-ONLY BY CONTRACT.

This module is the child-side entry point for the Windows Job-Object owned-process
transport (`sidecar/ai/tools/builtins/owned_process.py`), plus the parent-side
encoder that frames its control payload. Both halves of the wire contract live
here together so the encoder and decoder cannot drift apart.

IMPORT-COST CONTRACT (load-bearing -- do not add imports):
    This module MUST import nothing but the standard library, and specifically
    nothing from the `sidecar` package. Every owned-process spawn pays this
    module's import cost, in a freshly-started interpreter, before the target
    command runs.

    Keep this module at the top of `sidecar/`, isolated from tool-package import
    cost.
    `tests/sidecar/test_owned_process_bootstrap_import_cost.py` gates this.

SECURITY CONTRACT (unchanged by the module's location):
    The parent creates a Job Object, spawns this bootstrap into it, and only then
    releases the real target argv over the bootstrap's stdin. The target therefore
    cannot start until it is already inside the Job, so it can never escape
    containment via a spawn/assign race. `_validate_target_contract` is applied on
    BOTH sides of the wire -- when encoding and again after decoding -- so a
    malformed or hostile payload is rejected by the child even if it somehow
    bypassed the parent's encoder.
"""

from __future__ import annotations

import json
import struct
import subprocess
import sys
from pathlib import Path
from typing import IO, BinaryIO, Mapping, Sequence, cast

BOOTSTRAP_FLAG = "--owned-process-bootstrap"

_BOOTSTRAP_HEADER = struct.Struct("!I")
_BOOTSTRAP_MAX_PAYLOAD_BYTES = 1024 * 1024
_BOOTSTRAP_REJECTED_EXIT_CODE = 125
_BOOTSTRAP_LAUNCH_FAILED_EXIT_CODE = 126
_WINDOWS_CMD_ARGV_LENGTH = 5


def windows_bootstrap_command() -> list[str]:
    """Return the trusted bootstrap command for source and packaged runtimes."""
    if getattr(sys, "frozen", False):
        return [sys.executable, BOOTSTRAP_FLAG]
    return [sys.executable, "-m", "sidecar", BOOTSTRAP_FLAG]


def encode_windows_bootstrap_payload(
    argv: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str] | None,
) -> bytes:
    """Encode one bounded target-launch request for the trusted bootstrap."""
    normalized_argv = [str(argument) for argument in argv]
    normalized_cwd = str(cwd)
    normalized_env = (
        None
        if env is None
        else {str(key): str(value) for key, value in env.items()}
    )
    _validate_target_contract(normalized_argv, normalized_cwd, normalized_env)
    raw_payload = json.dumps(
        {
            "argv": normalized_argv,
            "cwd": normalized_cwd,
            "env": normalized_env,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(raw_payload) > _BOOTSTRAP_MAX_PAYLOAD_BYTES:
        raise ValueError("owned process bootstrap payload exceeds its byte limit")
    return _BOOTSTRAP_HEADER.pack(len(raw_payload)) + raw_payload


def release_windows_bootstrap_target(
    control_stream: IO[bytes],
    framed_payload: bytes,
) -> None:
    """Release the target only after the bootstrap has entered its Job."""
    try:
        control_stream.write(framed_payload)
        control_stream.flush()
    finally:
        control_stream.close()


def run_windows_owned_process_bootstrap(
    control_stream: BinaryIO | None = None,
) -> int:
    """Wait for a validated target request, launch it, and mirror its exit code."""
    stream = control_stream if control_stream is not None else sys.stdin.buffer
    try:
        argv, cwd, env = _read_bootstrap_payload(stream)
    except (OSError, TypeError, ValueError):
        _write_bootstrap_error("owned process bootstrap rejected control payload")
        return _BOOTSTRAP_REJECTED_EXIT_CODE

    try:
        target = subprocess.Popen(
            _windows_target_launch_args(argv),
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, ValueError):
        _write_bootstrap_error("owned process bootstrap target launch failed")
        return _BOOTSTRAP_LAUNCH_FAILED_EXIT_CODE
    return int(target.wait())


def _windows_target_launch_args(argv: list[str]) -> list[str] | str:
    """Preserve cmd.exe's command string without CommandLineToArgvW escaping."""
    if (
        sys.platform == "win32"
        and len(argv) == _WINDOWS_CMD_ARGV_LENGTH
        and argv[0].replace("\\", "/").rsplit("/", 1)[-1].lower()
        in {"cmd", "cmd.exe"}
        and [value.lower() for value in argv[1:4]] == ["/d", "/s", "/c"]
    ):
        return f'{subprocess.list2cmdline(argv[:4])} "{argv[4]}"'
    return argv


def _read_bootstrap_payload(
    control_stream: BinaryIO,
) -> tuple[list[str], str, dict[str, str] | None]:
    header = _read_exact(control_stream, _BOOTSTRAP_HEADER.size)
    payload_size = _BOOTSTRAP_HEADER.unpack(header)[0]
    if payload_size <= 0 or payload_size > _BOOTSTRAP_MAX_PAYLOAD_BYTES:
        raise ValueError("invalid owned process bootstrap payload size")
    raw_payload = _read_exact(control_stream, payload_size)
    decoded = json.loads(raw_payload.decode("utf-8"))
    if not isinstance(decoded, dict) or set(decoded) != {"argv", "cwd", "env"}:
        raise ValueError("invalid owned process bootstrap payload shape")

    payload = cast(dict[str, object], decoded)
    raw_argv = payload["argv"]
    cwd = payload["cwd"]
    raw_env = payload["env"]
    if not isinstance(raw_argv, list) or not all(
        isinstance(argument, str) for argument in raw_argv
    ):
        raise ValueError("invalid owned process bootstrap argv")
    if not isinstance(cwd, str):
        raise ValueError("invalid owned process bootstrap cwd")
    if raw_env is not None and (
        not isinstance(raw_env, dict)
        or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in raw_env.items()
        )
    ):
        raise ValueError("invalid owned process bootstrap environment")

    argv = cast(list[str], raw_argv)
    env = cast(dict[str, str] | None, raw_env)
    _validate_target_contract(argv, cwd, env)
    return argv, cwd, env


def _validate_target_contract(
    argv: Sequence[str],
    cwd: str,
    env: Mapping[str, str] | None,
) -> None:
    if not argv or not argv[0]:
        raise ValueError("owned process target argv cannot be empty")
    values = [*argv, cwd]
    if env is not None:
        for key, value in env.items():
            values.extend((key, value))
    if any("\x00" in value for value in values):
        raise ValueError("owned process target values cannot contain NUL")


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = stream.read(size - len(chunks))
        if not chunk:
            raise ValueError("owned process bootstrap payload ended early")
        chunks.extend(chunk)
    return bytes(chunks)


def _write_bootstrap_error(message: str) -> None:
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()


__all__ = [
    "BOOTSTRAP_FLAG",
    "encode_windows_bootstrap_payload",
    "release_windows_bootstrap_target",
    "run_windows_owned_process_bootstrap",
    "windows_bootstrap_command",
]
