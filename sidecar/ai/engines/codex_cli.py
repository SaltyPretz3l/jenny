"""Codex CLI-backed engine transport.

Jenny owns sessions, tools, memory, and approvals. This engine uses Codex CLI
only as a ChatGPT-authenticated model subprocess and rejects CLI-owned tool
events before they can become runtime behavior.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import threading
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable, Generator, Sequence, cast

from sidecar.ai.engines.base import BaseEngine, EngineMessage, clamp_timeout_to_deadline
from sidecar.ai.engines.http_utils import (
    raise_if_cancelled as _raise_if_cancelled_shared,
)
from sidecar.ai.engines.http_utils import register_cancel_callback
from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.tools.inband_parser import extract_inband_tool_calls_detailed
from sidecar.ai.tools.models import GenerationResult, StreamChunk
from sidecar.runtime.process_containment import log_containment_degraded
from sidecar.runtime.process_job import WindowsJobObject
from sidecar.runtime.worker_payload import build_background_env as build_child_env

_DEFAULT_COMMAND = "codex"
_DEFAULT_MODEL = "codex-cli/default"
_MODEL_PREFIX = "codex-cli/"
_CODEX_REASONING_EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh"})
_TOOL_EVENT_MARKERS = (
    "tool",
    "command",
    "exec",
    "shell",
    "file",
    "mcp",
    "browser",
    "web",
)
_AGENT_MESSAGE_TYPES = frozenset({"agent_message", "assistant_message"})
_TEXT_EVENT_MARKERS = ("agent_message", "assistant_message", "message")
_TEXT_FIELDS = ("message", "content", "text", "delta", "output_text")
_MAX_CODEX_OUTPUT_BYTES = 16 * 1024 * 1024
_PIPE_READ_CHUNK_BYTES = 64 * 1024
_PROCESS_POLL_INTERVAL_SECONDS = 0.05
# Bound on the tripwire's own partial-line buffer. The JSONL events we inspect
# are small; anything past this is not a line we will ever parse, and holding it
# would reintroduce an unbounded accumulator next to the bounded capture.
_MAX_TRIPWIRE_LINE_BYTES = 1024 * 1024
_TOOL_EVENT_REJECTION_MESSAGE = (
    "Codex CLI attempted to use its own tool; Jenny tools are required"
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CodexCliProcessResult:
    exit_code: int
    stdout: str = ""
    stderr: str = ""


RunProcess = Callable[..., CodexCliProcessResult]


@dataclass
class _BoundedPipeCapture:
    max_bytes: int
    data: bytearray
    total_bytes: int = 0
    exceeded: bool = False

    @classmethod
    def create(cls, max_bytes: int) -> "_BoundedPipeCapture":
        return cls(max_bytes=max(1, int(max_bytes)), data=bytearray())

    def append(self, chunk: bytes) -> None:
        self.total_bytes += len(chunk)
        remaining = max(0, self.max_bytes - len(self.data))
        if remaining:
            self.data.extend(chunk[:remaining])
        if self.total_bytes > self.max_bytes:
            self.exceeded = True


@dataclass
class _ToolEventTripwire:
    """Kill switch for CLI-owned tool events, armed while the process runs.

    The stdout reader sets ``tripped`` as bytes arrive; ``_CodexProcessSession._wait``
    polls it and terminates the process tree so a detected CLI-owned tool event
    cannot continue.

    Deliberately reuses ``_cli_tool_event_marker``: one vocabulary decides what
    a tool event is, whether it is caught in flight or on the parsed output.
    """

    pending: bytearray
    tripped: bool = False
    marker: str = ""

    @classmethod
    def create(cls) -> "_ToolEventTripwire":
        return cls(pending=bytearray())

    def feed(self, chunk: bytes) -> None:
        if self.tripped:
            return
        self.pending.extend(chunk)
        while True:
            index = self.pending.find(b"\n")
            if index < 0:
                break
            line = bytes(self.pending[:index])
            del self.pending[: index + 1]
            self._inspect(line)
            if self.tripped:
                return
        if len(self.pending) > _MAX_TRIPWIRE_LINE_BYTES:
            del self.pending[:-_MAX_TRIPWIRE_LINE_BYTES]

    def _inspect(self, line: bytes) -> None:
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            return
        try:
            event = json.loads(text)
        except json.JSONDecodeError:
            return
        if not isinstance(event, dict):
            return
        marker = _cli_tool_event_marker(event)
        if marker:
            self.tripped = True
            self.marker = marker


class CodexCliEngine(BaseEngine):
    """Run one noninteractive Codex CLI request per generation."""

    def __init__(
        self,
        *,
        command: str | None = None,
        runtime_root: str | Path | None = None,
        request_timeout_seconds: int = 300,
        run_process: RunProcess | None = None,
    ) -> None:
        self.command = str(command or _DEFAULT_COMMAND).strip() or _DEFAULT_COMMAND
        self.runtime_root = Path(runtime_root) if runtime_root is not None else None
        self.request_timeout_seconds = int(request_timeout_seconds or 300)
        self._run_process = run_process or _run_codex_process
        self._loaded_model = _DEFAULT_MODEL

    @property
    def supports_inband_tool_calling(self) -> bool:
        return True

    def load_model(self, model_path: str) -> None:
        token = str(model_path or "").strip()
        self._loaded_model = token or _DEFAULT_MODEL

    def generate(  # noqa: PLR0913 - matches BaseEngine transport contract.
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
    ) -> str:
        return self._generate(
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
            cancel_handle=None,
        )

    def _generate(  # noqa: PLR0913 - mirrors generate with cancellation support.
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
        cancel_handle: Any = None,
        wall_clock_deadline: float | None = None,
    ) -> str:
        _ = max_tokens, temperature, prompt_cache_enabled, response_format
        runtime_root = self._ensure_runtime_root()
        args = self._build_args(runtime_root, reasoning_effort=reasoning_effort)
        input_text = _assemble_prompt(prompt=prompt, system=system, messages=messages)
        _raise_if_cancelled(cancel_handle)
        result = self._run_process(
            command=self.command,
            args=args,
            input_text=input_text,
            cwd=runtime_root,
            timeout_seconds=clamp_timeout_to_deadline(
                self.request_timeout_seconds,
                wall_clock_deadline,
            ),
            cancel_handle=cancel_handle,
        )
        _raise_if_cancelled(cancel_handle)
        if result.exit_code != 0:
            detail = _bounded_text(result.stderr or result.stdout)
            raise RuntimeError(f"Codex CLI exited with status {result.exit_code}: {detail}")
        return _parse_jsonl_output(result.stdout)

    def stream(  # noqa: PLR0913 - matches BaseEngine transport contract.
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
        cancel_handle: Any = None,
    ) -> Generator[StreamChunk, None, None]:
        yield self._generate(
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
            cancel_handle=cancel_handle,
        )

    def generate_with_tools(  # noqa: PLR0913 - matches BaseEngine transport contract.
        self,
        prompt: str,
        tools: list[dict[str, Any]],
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
    ) -> GenerationResult:
        content = self.generate(
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
        )
        known_tool_names = frozenset(
            str(tool.get("name") or tool.get("tool_id") or "").strip()
            for tool in tools
            if isinstance(tool, dict)
        )
        extraction = extract_inband_tool_calls_detailed(content, known_tool_names)
        if extraction.calls:
            return GenerationResult(
                content=extraction.remaining_text,
                tool_calls=extraction.calls,
                finish_reason="tool_calls",
            )
        return GenerationResult(
            content=content,
            finish_reason="stop",
            inband_tool_call_parse_failed=extraction.failed_attempt,
        )

    def stream_with_tools(  # noqa: PLR0913 - BaseEngine transport contract.
        self,
        prompt: str,
        tools: list[dict[str, Any]],
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
        cancel_handle: Any = None,
        wall_clock_deadline: float | None = None,
    ) -> Generator[StreamChunk, None, GenerationResult]:
        content = self._generate(
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
            cancel_handle=cancel_handle,
            wall_clock_deadline=wall_clock_deadline,
        )
        known_tool_names = frozenset(
            str(tool.get("name") or tool.get("tool_id") or "").strip()
            for tool in tools
            if isinstance(tool, dict)
        )
        extraction = extract_inband_tool_calls_detailed(content, known_tool_names)
        if extraction.calls:
            if extraction.remaining_text:
                yield extraction.remaining_text
            return GenerationResult(
                content=extraction.remaining_text,
                tool_calls=extraction.calls,
                finish_reason="tool_calls",
            )
        if content:
            yield content
        return GenerationResult(
            content=content,
            finish_reason="stop",
            inband_tool_call_parse_failed=extraction.failed_attempt,
        )

    def _build_args(
        self,
        runtime_root: Path,
        *,
        reasoning_effort: str | None = None,
    ) -> list[str]:
        # Pinned containment profile. Every flag here is a Jenny decision the
        # user's ~/.codex/config.toml must not be able to reopen: the CLI reads
        # that file on every `exec`, so anything we do not override explicitly
        # is whatever the machine happens to be configured for.
        #
        # --sandbox/--cd/--ephemeral/--skip-git-repo-check already bounded
        # writes and network. The `-c` overrides close the remaining hole,
        # which is unapproved *reads* and CLI-owned tooling: an approval prompt
        # that could escalate out of read-only, MCP servers the user configured
        # for some other project, and the CLI's own web search. Jenny owns
        # tools; the CLI is a model transport.
        args = [
            "exec",
            "--json",
            "--ephemeral",
            "--skip-git-repo-check",
            "--cd",
            str(runtime_root),
            "--sandbox",
            "read-only",
            "--ask-for-approval",
            "never",
            "-c",
            "mcp_servers={}",
            "-c",
            "tools.web_search=false",
            "-c",
            'sandbox_mode="read-only"',
        ]
        normalized_effort = str(reasoning_effort or "").strip().lower()
        if normalized_effort in _CODEX_REASONING_EFFORTS:
            args.extend(["-c", f'model_reasoning_effort="{normalized_effort}"'])
        custom_model = _custom_model_override(self._loaded_model)
        if custom_model:
            args.extend(["--model", custom_model])
        args.append("-")
        return args

    def _ensure_runtime_root(self) -> Path:
        if self.runtime_root is None:
            raise RuntimeError("Codex CLI runtime root is not configured")
        self.runtime_root.mkdir(parents=True, exist_ok=True)
        return self.runtime_root


class _CodexProcessSession:
    def __init__(
        self,
        process: subprocess.Popen[bytes],
        job_object: WindowsJobObject | None,
        *,
        input_text: str,
        cancel_handle: Any,
    ) -> None:
        self.process = process
        self.job_object = job_object
        self.input_text = input_text
        self.cancel_handle = cancel_handle
        per_stream_limit = _MAX_CODEX_OUTPUT_BYTES // 2
        self.stdout_capture = _BoundedPipeCapture.create(per_stream_limit)
        self.stderr_capture = _BoundedPipeCapture.create(
            _MAX_CODEX_OUTPUT_BYTES - per_stream_limit
        )
        self.tool_event_tripwire = _ToolEventTripwire.create()
        self.readers: list[threading.Thread] = []
        self.writer: threading.Thread | None = None

    def run(self, timeout_seconds: float) -> CodexCliProcessResult:
        process = self.process
        if process.stdout is None or process.stderr is None or process.stdin is None:
            raise RuntimeError("Codex CLI process pipes are unavailable")
        unregister_cancel = _register_process_cancel_callback(
            self.cancel_handle,
            self.terminate,
        )
        try:
            _raise_if_cancelled(self.cancel_handle)
            self.readers = [
                _start_pipe_reader(
                    cast(BinaryIO, process.stdout),
                    self.stdout_capture,
                    "stdout",
                    tripwire=self.tool_event_tripwire,
                ),
                _start_pipe_reader(
                    cast(BinaryIO, process.stderr),
                    self.stderr_capture,
                    "stderr",
                ),
            ]
            self.writer = _start_stdin_writer(
                cast(BinaryIO, process.stdin),
                self.input_text.encode("utf-8"),
            )
            self._wait(timeout_seconds)
            self._join_io(timeout=1.0)
            self._raise_if_output_exceeded()
            # Also checked here, not only in the poll loop: a process that
            # exits faster than one poll interval never reaches the loop body.
            self._raise_if_tool_event()
            _raise_if_cancelled(self.cancel_handle)
            return CodexCliProcessResult(
                exit_code=int(process.returncode if process.returncode is not None else 1),
                stdout=bytes(self.stdout_capture.data).decode("utf-8", errors="replace"),
                stderr=bytes(self.stderr_capture.data).decode("utf-8", errors="replace"),
            )
        finally:
            unregister_cancel()

    def terminate(self) -> None:
        # Runs as the turn's cancel callback on the dispatch loop: never wait.
        _terminate_codex_tree(self.process, self.job_object, wait=False)

    def close(self) -> None:
        if self.job_object is not None:
            self.job_object.close()
        for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
            if pipe is not None:
                try:
                    pipe.close()
                except OSError:
                    pass
        self._join_io(timeout=0.2)

    def _wait(self, timeout_seconds: float) -> None:
        deadline = time.monotonic() + max(0.0, float(timeout_seconds))
        while self.process.poll() is None:
            try:
                _raise_if_cancelled(self.cancel_handle)
            except Exception:
                self.terminate()
                raise
            self._raise_if_output_exceeded(terminate=True)
            self._raise_if_tool_event(terminate=True)
            if time.monotonic() >= deadline:
                self.terminate()
                raise RuntimeError("Codex CLI request timed out")
            time.sleep(_PROCESS_POLL_INTERVAL_SECONDS)

    def _raise_if_output_exceeded(self, *, terminate: bool = False) -> None:
        if not (self.stdout_capture.exceeded or self.stderr_capture.exceeded):
            return
        if terminate:
            self.terminate()
        logger.warning(
            "Codex CLI output exceeded its bounded transport contract.",
            extra={
                "event": "ai.engines.codex_cli.output_bounded",
                "stdout_bytes": self.stdout_capture.total_bytes,
                "stderr_bytes": self.stderr_capture.total_bytes,
                "max_output_bytes": _MAX_CODEX_OUTPUT_BYTES,
            },
        )
        raise RuntimeError("Codex CLI output exceeded the byte limit")

    def _raise_if_tool_event(self, *, terminate: bool = False) -> None:
        if not self.tool_event_tripwire.tripped:
            return
        if terminate:
            self.terminate()
        logger.warning(
            "Codex CLI emitted a CLI-owned tool event; the subprocess was killed.",
            extra={
                "event": "ai.engines.codex_cli.tool_event_rejected",
                "marker": self.tool_event_tripwire.marker,
                "terminated": bool(terminate),
            },
        )
        raise RuntimeError(_TOOL_EVENT_REJECTION_MESSAGE)

    def _join_io(self, *, timeout: float) -> None:
        for thread in self.readers:
            thread.join(timeout=timeout)
        if self.writer is not None:
            self.writer.join(timeout=timeout)


def _spawn_codex_process(
    command: str,
    args: Sequence[str],
    *,
    cwd: Path,
) -> tuple[subprocess.Popen[bytes], WindowsJobObject | None]:
    creationflags = 0
    start_new_session = False
    if os.name == "nt":
        creationflags = int(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    else:
        start_new_session = True
    # Explicit env, never the inherited one. Without this the CLI receives
    # whatever credentials the developer/CI shell happened to export --
    # OPENAI_API_KEY, GH_TOKEN, AWS_*, HF_TOKEN, proxy creds -- to a vendor
    # binary Jenny only wants as a ChatGPT-authenticated model transport.
    # build_child_env is the sidecar's existing allowlist baseline (PATH, HOME/
    # USERPROFILE/APPDATA so `codex` can still find its own auth.json, plus
    # JENNY_*/LC_*), reused rather than reimplemented here.
    process = subprocess.Popen(
        [command, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        env=build_child_env(),
        text=False,
        bufsize=0,
        creationflags=creationflags,
        start_new_session=start_new_session,
    )
    job_object: WindowsJobObject | None = None
    try:
        job_object = WindowsJobObject() if os.name == "nt" else None
        if job_object is not None:
            job_object.assign_pid(int(process.pid))
            # The assign return code is not proof of membership; only the
            # kernel's IsProcessInJob is. A refused probe must not disable
            # codex, so a miss fails open with a warning and leaves the
            # taskkill backstop to cover teardown.
            if not job_object.contains_pid(int(process.pid)):
                log_containment_degraded(
                    task_key="codex-cli",
                    stage="verify",
                    reason=f"containment could not be confirmed for pid {process.pid}",
                )
    except Exception:
        if job_object is not None:
            job_object.close()
        _terminate_codex_tree(process, None)
        try:
            process.wait(timeout=1.0)
        except (OSError, subprocess.TimeoutExpired):
            pass
        raise
    return process, job_object


def _run_codex_process(  # noqa: PLR0913 - injected transport contract.
    *,
    command: str,
    args: Sequence[str],
    input_text: str,
    cwd: Path,
    timeout_seconds: float,
    cancel_handle: Any = None,
) -> CodexCliProcessResult:
    session: _CodexProcessSession | None = None
    try:
        process, job_object = _spawn_codex_process(command, args, cwd=cwd)
        session = _CodexProcessSession(
            process,
            job_object,
            input_text=input_text,
            cancel_handle=cancel_handle,
        )
        return session.run(timeout_seconds)
    except OSError as exc:
        if session is not None:
            session.terminate()
        raise RuntimeError(f"Codex CLI failed to start: {type(exc).__name__}") from exc
    finally:
        if session is not None:
            session.close()


def _register_process_cancel_callback(
    cancel_handle: Any,
    terminate: Callable[[], None],
) -> Callable[[], None]:
    return register_cancel_callback(cancel_handle, terminate)


def _raise_if_cancelled(cancel_handle: Any) -> None:
    _raise_if_cancelled_shared(
        cancel_handle,
        make_error=lambda: RuntimeError("Codex CLI request cancelled"),
    )


def _start_pipe_reader(
    pipe: BinaryIO,
    capture: _BoundedPipeCapture,
    stream_name: str,
    *,
    tripwire: "_ToolEventTripwire | None" = None,
) -> threading.Thread:
    def _read() -> None:
        try:
            while True:
                chunk = pipe.read(_PIPE_READ_CHUNK_BYTES)
                if not chunk:
                    return
                capture.append(chunk)
                if tripwire is not None:
                    tripwire.feed(chunk)
        except (OSError, ValueError):
            return

    thread = threading.Thread(
        target=_read,
        daemon=True,
        name=f"codex-cli-{stream_name}",
    )
    thread.start()
    return thread


def _start_stdin_writer(pipe: BinaryIO, payload: bytes) -> threading.Thread:
    def _write() -> None:
        try:
            view = memoryview(payload)
            while view:
                written = pipe.write(view)
                if written is None:
                    written = len(view)
                if written <= 0:
                    return
                view = view[written:]
            pipe.flush()
        except (BrokenPipeError, OSError, ValueError):
            pass
        finally:
            try:
                pipe.close()
            except OSError:
                pass

    thread = threading.Thread(target=_write, daemon=True, name="codex-cli-stdin")
    thread.start()
    return thread


_WINDOWS_TEARDOWN_JOIN_SECONDS = 7.0


def _terminate_codex_tree(
    process: subprocess.Popen[bytes],
    job_object: WindowsJobObject | None,
    *,
    wait: bool = True,
) -> threading.Thread | None:
    """Tear down the codex process tree.

    On Windows the whole teardown runs on a daemon thread: ``taskkill /T /F``
    first (it walks live parent links, so the root must still be alive), then
    the job close, then the direct kill. The turn's cancel callback invokes
    this on the sidecar's single dispatch loop while the multiplexer lock is
    held, and a blocking ``taskkill`` there stalls every other RPC for its
    whole bounded duration -- the stall class 9c42c6cc closed. ``wait`` joins
    the thread (bounded) for callers that need the process gone before they
    continue; the cancel path passes ``wait=False``.
    """
    if os.name == "nt":
        thread = threading.Thread(
            target=_terminate_codex_tree_windows,
            args=(process, job_object),
            daemon=True,
            name="codex-cli-teardown",
        )
        thread.start()
        if wait:
            thread.join(timeout=_WINDOWS_TEARDOWN_JOIN_SECONDS)
        return thread
    if hasattr(os, "killpg"):
        try:
            os.killpg(int(process.pid), signal.SIGTERM)
        except OSError:
            pass
    _finish_codex_termination(process)
    return None


def _terminate_codex_tree_windows(
    process: subprocess.Popen[bytes],
    job_object: WindowsJobObject | None,
) -> None:
    if process.poll() is None:
        # Only while the root is still live, so a reused pid is never the target.
        with suppress(OSError, subprocess.SubprocessError):
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(process.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
    if job_object is not None:
        job_object.close()
    _finish_codex_termination(process)


def _finish_codex_termination(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        process.terminate()
    except OSError:
        pass
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        if os.name != "nt" and hasattr(os, "killpg"):
            try:
                os.killpg(
                    int(process.pid),
                    getattr(signal, "SIGKILL", signal.SIGTERM),
                )
            except (OSError, ProcessLookupError):
                pass
        try:
            process.kill()
            process.wait(timeout=0.5)
        except (OSError, subprocess.TimeoutExpired):
            pass


def _custom_model_override(model_id: str) -> str:
    token = str(model_id or "").strip()
    if token.lower() in {"", _DEFAULT_MODEL, "codex-cli"}:
        return ""
    if token.lower().startswith(_MODEL_PREFIX):
        token = token[len(_MODEL_PREFIX) :].strip()
    return "" if token.lower() == "default" else token


def _assemble_prompt(
    *,
    prompt: str,
    system: str,
    messages: list[EngineMessage] | None,
) -> str:
    sections: list[str] = []
    if system.strip():
        sections.append(f"System:\n{system.strip()}")
    if messages:
        for message in messages:
            role = str(message.get("role") or "user").strip() or "user"
            content = _message_content_to_text(message.get("content"))
            if content:
                sections.append(f"{role}:\n{content}")
    elif str(prompt or "").strip():
        sections.append(f"User:\n{str(prompt).strip()}")
    return "\n\n".join(sections)


def _message_content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                value = item.get("text") or item.get("content")
                if isinstance(value, str) and value.strip():
                    parts.append(value.strip())
            elif isinstance(item, str) and item.strip():
                parts.append(item.strip())
        return "\n".join(parts)
    return "" if content is None else str(content).strip()


def _parse_jsonl_output(stdout: str) -> str:
    parts: list[str] = []
    saw_json = False
    for raw_line in str(stdout or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        saw_json = True
        if not isinstance(event, dict):
            continue
        _reject_cli_tool_event(event)
        text = _extract_text(event)
        if text:
            parts.append(text)
    if parts:
        return "".join(parts).strip()
    if saw_json:
        raise RuntimeError("Codex CLI JSONL output did not contain an assistant message")
    return str(stdout or "").strip()


def _reject_cli_tool_event(event: dict[str, Any]) -> None:
    if _cli_tool_event_marker(event):
        raise RuntimeError(_TOOL_EVENT_REJECTION_MESSAGE)


def _cli_tool_event_marker(event: dict[str, Any]) -> str:
    """Return the marker that makes ``event`` a CLI-owned tool event, or ""."""

    tokens = [
        str(event.get("type") or ""),
        str(event.get("name") or ""),
        str(event.get("tool") or ""),
        str(event.get("tool_name") or ""),
        str(event.get("subtype") or ""),
        str(event.get("event") or ""),
    ]
    item = event.get("item")
    if isinstance(item, dict):
        tokens.extend(
            [
                str(item.get("type") or ""),
                str(item.get("name") or ""),
                str(item.get("tool") or ""),
                str(item.get("tool_name") or ""),
                str(item.get("subtype") or ""),
                str(item.get("command") or ""),
            ]
        )
    normalized = " ".join(token.lower() for token in tokens if token)
    for marker in _TOOL_EVENT_MARKERS:
        if marker in normalized:
            return marker
    return ""


def _extract_text(event: dict[str, Any]) -> str:
    event_type = str(event.get("type") or "").strip().lower()
    item = event.get("item")
    if isinstance(item, dict):
        item_type = str(item.get("type") or "").strip().lower()
        if item_type in _AGENT_MESSAGE_TYPES:
            return _first_text_value(item, ("message", "content", "text"))
        return ""
    if event_type and not _is_text_event_type(event_type):
        return ""
    text = _first_text_value(event, _TEXT_FIELDS)
    if text:
        return text
    response = event.get("response")
    return _first_text_value(response, ("output_text",)) if isinstance(response, dict) else ""


def _is_text_event_type(event_type: str) -> bool:
    return any(marker in event_type for marker in _TEXT_EVENT_MARKERS) or event_type.startswith(
        "response"
    )


def _first_text_value(source: dict[str, Any], keys: Sequence[str]) -> str:
    for key in keys:
        value = source.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _bounded_text(value: str, *, limit: int = 500) -> str:
    token = str(value or "").strip()
    if len(token) <= limit:
        return token
    return f"{token[:limit]}..."
