"""Resolved temporary-script interpreters and metadata-only version probes."""

from __future__ import annotations

import copy
import os
from pathlib import Path
from threading import RLock

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins import cancellation
from sidecar.ai.tools.builtins.owned_process import (
    OwnedProcessError,
    OwnedProcessResult,
    get_owned_process_service,
)
from sidecar.ai.tools.builtins.shell import _shell_environment, _which_on_explicit_path
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.sanitization import sanitize_tool_output_no_truncate

VERSION_PROBE_TIMEOUT_SECONDS = 2.0
MAX_INTERPRETER_VERSION_CHARS = 256
SCRIPT_INTERPRETERS = {
    "python": (("python", "python3"), ".py"),
    "powershell": (("powershell", "pwsh"), ".ps1"),
    "javascript": (("node",), ".js"),
    "cmd": (("cmd.exe",), ".cmd"),
    "sh": (("/bin/sh",), ".sh"),
}
MAX_VERSION_CACHE_ENTRIES = 128
_VERSION_CACHE: dict[tuple, dict[str, object]] = {}
_VERSION_CACHE_LOCK = RLock()


def _version_cache_key(interpreter: str, language: str) -> tuple | None:
    try:
        stat = Path(interpreter).stat()
    except OSError:
        return None
    return (str(Path(interpreter).absolute()), language, stat.st_mtime_ns,
            stat.st_size, stat.st_dev, stat.st_ino)


def resolve_script_interpreter(language: str) -> str:
    environment = _shell_environment()
    names, _extension = SCRIPT_INTERPRETERS[language]
    for name in names:
        resolved = _which_on_explicit_path(name, path=(environment or os.environ).get("PATH", ""))
        if resolved is not None:
            # Preserve invocation identity: a venv Python symlink must be launched
            # through the venv path, not its system-interpreter target.
            return str(Path(resolved).absolute())
    raise ToolExecutionFailure(
        code=CMP_TOOL_IO_FAILED,
        message=f"script interpreter is unavailable: {'/'.join(names)}",
        retryable=False,
        error_details={"failure_class": "unavailable"},
    )


def script_command(script_path: Path, *, language: str, interpreter: str) -> str:
    quoted_script = f'"{script_path}"'
    if language == "cmd":
        return f"call {quoted_script}"
    prefix = f'"{interpreter}"'
    if language == "powershell":
        prefix += " -NoProfile -ExecutionPolicy Bypass -File"
    return f"{prefix} {quoted_script}"


def _version_argv(interpreter: str, language: str) -> list[str] | None:
    if language == "python":
        return [interpreter, "-I", "--version"]
    if language == "javascript":
        return [interpreter, "--version"]
    if language == "powershell":
        return [interpreter, "-NoProfile", "-NonInteractive", "-Command",
                "$PSVersionTable.PSVersion.ToString()"]
    # cmd's `ver` names the OS; POSIX sh has no standard version switch.
    return None


def interpreter_version_metadata(
    interpreter: str | None, language: str, *, execution_completed: bool
) -> dict[str, object]:
    probe: dict[str, object] = {"status": "unavailable"}
    details: dict[str, object] = {
        "interpreter_version": None,
        "interpreter_version_probe": probe,
    }
    abort_event = cancellation.current_abort_event()
    if abort_event is not None and abort_event.is_set():
        probe["reason"] = "cancelled"
        return details
    if interpreter is None or not execution_completed:
        probe["reason"] = "script_not_completed" if interpreter else "interpreter_unavailable"
        return details
    argv = _version_argv(interpreter, language)
    if argv is None:
        probe["reason"] = "unsupported"
        return details
    return _probe_version_metadata(interpreter, language, argv, abort_event)


def _probe_version_metadata(interpreter: str, language: str, argv: list[str],
                            abort_event) -> dict[str, object]:
    probe: dict[str, object] = {"status": "unavailable"}
    details: dict[str, object] = {"interpreter_version": None,
                                  "interpreter_version_probe": probe}
    key = _version_cache_key(interpreter, language)
    with _VERSION_CACHE_LOCK:
        if key is not None and key in _VERSION_CACHE:
            return copy.deepcopy(_VERSION_CACHE[key])
    # Fixed argv only, after execution admission. No script, profile or cwd hook.
    environment = dict(_shell_environment() or os.environ)
    environment.pop("NODE_OPTIONS", None)
    environment.pop("NODE_PATH", None)
    cleanup: dict[str, object] = {}

    def observe_cleanup(verdict) -> None:
        cleanup.update(verdict.metadata())

    try:
        completed = get_owned_process_service().run(
            argv, cwd=Path(interpreter).parent, env=environment,
            timeout_seconds=VERSION_PROBE_TIMEOUT_SECONDS, abort_event=abort_event,
            on_cleanup=observe_cleanup,
        )
    except (OSError, OwnedProcessError) as error:
        probe["reason"] = "probe_failed"
        probe["error_type"] = type(error).__name__
        if cleanup:
            probe["resource_cleanup"] = cleanup
        return details
    probe["resource_cleanup"] = completed.cleanup_verdict.metadata()
    reason = _probe_unavailable_reason(completed)
    if reason is not None:
        probe["reason"] = reason
        return details
    value = sanitize_tool_output_no_truncate(
        completed.stdout or completed.stderr, tool_name="run_temp_script"
    ).strip()
    if not value:
        probe["reason"] = "empty_output"
    else:
        details["interpreter_version"] = value[:MAX_INTERPRETER_VERSION_CHARS]
        probe["status"] = "available"
        if key is not None:
            with _VERSION_CACHE_LOCK:
                if key not in _VERSION_CACHE and len(_VERSION_CACHE) >= MAX_VERSION_CACHE_ENTRIES:
                    del _VERSION_CACHE[next(iter(_VERSION_CACHE))]
                _VERSION_CACHE[key] = copy.deepcopy(details)
    return details


def _probe_unavailable_reason(completed: OwnedProcessResult) -> str | None:
    if completed.aborted:
        return "cancelled"
    if completed.timed_out:
        return "timed_out"
    if completed.cleanup_verdict.cleanup != "confirmed":
        return "cleanup_unconfirmed"
    if completed.returncode != 0 or completed.drain_incomplete:
        return "probe_failed"
    return None


def add_probe_cleanup(metadata: dict[str, object], details: dict[str, object]) -> None:
    """Never let the script's cleanup proof mask an uncertain probe child."""
    probe = details["interpreter_version_probe"]
    cleanup = probe.get("resource_cleanup") if isinstance(probe, dict) else None
    if not isinstance(cleanup, dict) or cleanup.get("cleanup") != "uncertain":
        return
    previous = metadata.get("resource_cleanup")
    if not isinstance(previous, dict) or previous.get("cleanup") == "confirmed":
        metadata["resource_cleanup"] = cleanup
