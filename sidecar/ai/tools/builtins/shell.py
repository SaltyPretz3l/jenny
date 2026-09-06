"""Shell tool builtin with workspace jail, timeout controls, security
classification, semantic exit codes, background execution, large-output
persistence, and post-execution git operation tracking.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess  # noqa: F401 - compatibility seam for injected unit fakes.
import uuid
from pathlib import Path

from sidecar.ai.config import read_environment_value
from sidecar.ai.error_codes import (
    CMP_TOOL_BACKGROUND_NOT_FOUND,
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_COMMAND_ABORTED,
    CMP_TOOL_COMMAND_BLOCKED,
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
)
from sidecar.ai.tools.builtins import cancellation, output_chunk_slot
from sidecar.ai.tools.builtins.git_tracking import detect_git_operations
from sidecar.ai.tools.builtins.owned_process import (
    OwnedProcessCapacityError,
    OwnedProcessResult,
    OwnedProcessShutdownError,
    get_owned_process_service,
)
from sidecar.ai.tools.builtins.shell_background import (
    is_valid_job_id,
    read_background_job,
    start_background_job,
    stop_background_job,
)
from sidecar.ai.tools.builtins.shell_command_split import split_compound_command
from sidecar.ai.tools.builtins.shell_security import (
    CommandVerdict,
    classify_command,
    find_blocked_pattern,
)
from sidecar.ai.tools.builtins.shell_settings import _FEATURE_FLAGS
from sidecar.ai.tools.builtins.shell_settings import (
    configure_shell_security as _configure_shell_security,
)
from sidecar.ai.tools.builtins.tool_output_stream import ToolOutputStreamer
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.distill import (
    FILTER_SNIFF_CHARS,
    FULL_OUTPUT_PATH_PLACEHOLDER,
    MAX_DISTILL_INPUT_CHARS,
    distill_command_output,
    is_distill_enabled,
    open_omission_store,
    select_filter,
)
from sidecar.ai.tools.sanitization import sanitize_tool_output_no_truncate
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_store import (
    GuardedWorkspaceStore,
    StoredObject,
    WorkspaceStoreKind,
)

logger = logging.getLogger(__name__)

configure_shell_security = _configure_shell_security

DEFAULT_TIMEOUT_SECONDS = 10.0
MAX_TIMEOUT_SECONDS = 600.0
MAX_OUTPUT_CHARS = 20_000
MAX_FAILURE_STREAM_CHARS = 6_000
MAX_EXPECTED_EXIT_CODES = 16
_MIN_COMPOUND_SEGMENTS = 2

# Semantic exit-code overrides: command prefix -> {exit_code: explanation}.
SEMANTIC_EXIT_OVERRIDES: dict[str, dict[int, str]] = {
    "git grep": {1: "no matches found"},
    "grep": {1: "no matches found"},
    "rg": {1: "no matches found"},
    "diff": {1: "files differ (normal)"},
    "cmp": {1: "files differ (normal)"},
    "test": {1: "condition is false (normal)"},
}

# ── Module-level config ───────────────────────────────────────────────

def _shell_security_enabled() -> bool:
    return _FEATURE_FLAGS.get("shell_security", False)


def _git_tracking_enabled() -> bool:
    return _FEATURE_FLAGS.get("git_tracking", False)


# ── Helpers ───────────────────────────────────────────────────────────


def _truncate(value: str) -> str:
    if len(value) <= MAX_OUTPUT_CHARS:
        return value
    return f"{value[:MAX_OUTPUT_CHARS]}\n...[truncated]"


def _truncate_failure_stream(value: str) -> str:
    if len(value) <= MAX_FAILURE_STREAM_CHARS:
        return value
    return f"{value[-MAX_FAILURE_STREAM_CHARS:]}\n...[earlier output omitted]"


def _parse_timeout(arguments: dict[str, object]) -> float:
    raw = arguments.get("timeout_seconds")
    if isinstance(raw, (int, float)):
        timeout_seconds = float(raw)
    elif isinstance(raw, str):
        try:
            timeout_seconds = float(raw)
        except ValueError:
            timeout_seconds = DEFAULT_TIMEOUT_SECONDS
    else:
        timeout_seconds = DEFAULT_TIMEOUT_SECONDS
    timeout_seconds = max(0.1, timeout_seconds)
    return min(timeout_seconds, MAX_TIMEOUT_SECONDS)


def _parse_command(arguments: dict[str, object]) -> str:
    raw_command = arguments.get("command")
    if not isinstance(raw_command, str) or not raw_command.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'command' must be a non-empty string",
            retryable=False,
        )

    command = raw_command.strip()

    # Always-active blocked-pattern check, shared with shell_security.
    blocked_pattern = find_blocked_pattern(command)
    if blocked_pattern is not None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_COMMAND_BLOCKED,
            message=f"command blocked by policy: {blocked_pattern}",
            retryable=False,
        )

    return command


def _resolve_cwd(arguments: dict[str, object], workspace: WorkspaceGuard) -> Path:
    cwd_value = arguments.get("cwd")
    if cwd_value is None:
        return workspace.require_root()
    if not isinstance(cwd_value, str):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'cwd' must be a string",
            retryable=False,
        )
    return workspace.resolve_list_path(cwd_value)


def _display_cwd(cwd: Path, workspace: WorkspaceGuard) -> str:
    try:
        return cwd.relative_to(workspace.require_root()).as_posix()
    except ValueError:
        return str(cwd)


def _is_semantic_ok(command: str, exit_code: int) -> str | None:
    """Return an explanation when *exit_code* is semantically OK."""
    lower = command.lower()
    if re.search(r"(?:&&|\|\||[;|\r\n])", lower):
        return None
    if (
        (lower == "git diff" or lower.startswith("git diff "))
        and ("--exit-code" in lower or "--quiet" in lower)
        and exit_code == 1
    ):
        return "differences found (normal for git diff --exit-code/--quiet)"
    for prefix, overrides in SEMANTIC_EXIT_OVERRIDES.items():
        if (lower == prefix or lower.startswith(f"{prefix} ")) and exit_code in overrides:
            return overrides[exit_code]
    return None


def _separator_masks_prior_exit_code(separator: str) -> bool:
    index = 0
    while index < len(separator):
        pair = separator[index : index + 2]
        if pair in {"&&", "||"}:
            index += 2
            continue
        if separator[index] == ";" and os.name == "nt":
            index += 1
            continue
        if separator[index] in {"&", "|", ";", "\r", "\n"}:
            return True
        index += 1
    return False


def _exit_code_covers_final_segment(command: str) -> bool:
    """Return whether the active shell grammar found a masking separator."""
    segments = split_compound_command(command)
    if len(segments) < _MIN_COMPOUND_SEGMENTS:
        return False
    cursor = 0
    for index, segment in enumerate(segments[:-1]):
        segment_start = command.find(segment, cursor)
        if segment_start < 0:
            return False
        separator_start = segment_start + len(segment)
        next_start = command.find(segments[index + 1], separator_start)
        if next_start < 0:
            return False
        if _separator_masks_prior_exit_code(command[separator_start:next_start]):
            return True
        cursor = next_start
    return False


def _parse_expected_exit_codes(arguments: dict[str, object]) -> tuple[int, ...] | None:
    if "expected_exit_codes" not in arguments:
        return None
    value = arguments.get("expected_exit_codes")
    if not isinstance(value, list) or not value or len(value) > MAX_EXPECTED_EXIT_CODES:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'expected_exit_codes' must contain 1-16 unique integers",
            retryable=False,
        )
    parsed: list[int] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int) or item in parsed:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="tool argument 'expected_exit_codes' must contain 1-16 unique integers",
                retryable=False,
            )
        parsed.append(item)
    return tuple(parsed)


def _shell_name() -> str:
    return "cmd.exe" if os.name == "nt" else "/bin/sh"


def _powershell_directory() -> Path | None:
    """Canonical Windows PowerShell directory, when it exists on this host."""
    system_root = read_environment_value("SystemRoot") or read_environment_value("windir")
    if not system_root:
        return None
    candidate = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0"
    return candidate if (candidate / "powershell.exe").is_file() else None


def _shell_environment() -> dict[str, str] | None:
    r"""Inherit the parent env, but guarantee PowerShell is resolvable.

    ``powershell.exe`` lives in ``System32\WindowsPowerShell\v1.0``, which is a
    PATH entry separate from ``System32`` itself. A launcher that trims PATH can
    leave cmd.exe resolvable while ``powershell`` is not, so a perfectly good
    command dies with "'powershell' is not recognized" on a Windows-first app
    where both the user and the model reach for PowerShell by reflex.
    """
    if os.name != "nt":
        return None
    directory = _powershell_directory()
    if directory is None:
        return None
    env = dict(os.environ)
    path_value = env.get("PATH") or ""
    entries = [entry for entry in path_value.split(os.pathsep) if entry]
    if any(os.path.normcase(os.path.normpath(entry)) ==
           os.path.normcase(os.path.normpath(str(directory))) for entry in entries):
        return None
    entries.append(str(directory))
    env["PATH"] = os.pathsep.join(entries)
    return env


def _shell_argv(command: str) -> list[str]:
    """Resolve the advertised platform shell before starting the owned process."""
    if os.name == "nt":
        interpreter_name = _shell_name()
        interpreter = shutil.which(interpreter_name)
        if interpreter is None:
            raise ToolExecutionFailure(
                code=CMP_TOOL_IO_FAILED,
                message=f"shell interpreter is unavailable: {interpreter_name}",
                retryable=False,
            )
        return [interpreter, "/d", "/s", "/c", command]
    interpreter_name = _shell_name()
    interpreter = shutil.which(interpreter_name)
    if interpreter is None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"shell interpreter is unavailable: {interpreter_name}",
            retryable=False,
        )
    return [interpreter, "-c", command]


_UNRESOLVED_COMMAND_RE = re.compile(
    r"'([^']+)' is not recognized as an internal or external command"
    r"|([^\s:]+): (?:command not found|not found)",
    re.IGNORECASE,
)


def _unresolved_command_hint(stderr: str) -> str | None:
    """Turn a bare shell "not recognized" line into actionable guidance.

    Without this the model sees only the shell's own message, concludes it
    should retry with a full path, announces that, and burns another turn.
    """
    match = _UNRESOLVED_COMMAND_RE.search(stderr or "")
    if match is None:
        return None
    name = (match.group(1) or match.group(2) or "").strip()
    if not name:
        return None
    resolved = shutil.which(name)
    if resolved:
        return f"{name!r} is not on this shell's PATH; invoke it as {resolved!r}."
    if name.lower() in {"powershell", "powershell.exe", "pwsh", "pwsh.exe"}:
        directory = _powershell_directory()
        if directory is not None:
            return (
                f"{name!r} is not on this shell's PATH; invoke it as "
                f"{str(directory / 'powershell.exe')!r}."
            )
    return (
        f"{name!r} could not be resolved by {_shell_name()}. Use an absolute "
        "path, or a different tool for this step."
    )


def _run_owned_process(
    argv: list[str],
    *,
    cwd: Path,
    timeout_seconds: float,
) -> OwnedProcessResult:
    # An active per-call notification writer receives batched, sanitized
    # stdout/stderr lines while the command runs. The final captured result
    # stays authoritative.
    writer = output_chunk_slot.current_writer()
    streamer = ToolOutputStreamer(emit=writer) if writer is not None else None
    try:
        return get_owned_process_service().run(
            argv,
            cwd=cwd,
            timeout_seconds=timeout_seconds,
            env=_shell_environment(),
            # Set by the builtin server's reader thread when the turn is
            # cancelled mid-call; wait() then terminates the owned tree.
            abort_event=cancellation.current_abort_event(),
            on_output_chunk=streamer.on_chunk if streamer is not None else None,
        )
    finally:
        if streamer is not None:
            streamer.close()


def _persist_large_output(
    workspace: WorkspaceGuard,
    output: str,
    job_id: str,
    *,
    force: bool = False,
) -> StoredObject | None:
    """Write only redacted output when it exceeds ``MAX_OUTPUT_CHARS``."""
    safe_output = sanitize_tool_output_no_truncate(output, tool_name="run_command")
    if not force and len(safe_output) <= MAX_OUTPUT_CHARS:
        return None
    store = GuardedWorkspaceStore(workspace.require_root())
    output_ref = store.resolve(WorkspaceStoreKind.TOOL_RESULTS, f"{job_id}.txt")
    try:
        return store.write_text_atomic(output_ref, safe_output)
    except ToolExecutionFailure:
        # Output persistence is best-effort; the refusal is only observable
        # via this log line (no full_output_path is ever returned/written).
        logger.warning(
            "guarded store refused large command output persistence",
            exc_info=True,
        )
        return None


def _maybe_distill_output(
    workspace: WorkspaceGuard,
    command: str,
    raw_stdout: str,
    raw_stderr: str,
    output_id: str,
) -> tuple[str, str, bool]:
    """Errors-first distillation of stdout/stderr when ``tools_distill_enabled``.

    Distillation runs on already-redacted bytes (``sanitize_tool_output_no_truncate``)
    so the omission store never holds an un-redacted secret. The distilled result is
    used ONLY when a filter actually collapsed something; otherwise the raw streams
    fall through to today's path (byte-identical to flag-off). Any failure — store
    construction, filter, or redaction — falls back to the raw streams, losing nothing.
    """
    if not is_distill_enabled():
        return raw_stdout, raw_stderr, False
    try:
        # Cheap pre-checks BEFORE the redaction pipeline runs: the ~25-regex
        # sanitize pass over the full stream is the expensive part, and most
        # run_command output (ls, git, cat, ...) matches no filter. Sniff on
        # the raw command + a bounded head of the raw output; skip outsized
        # inputs entirely (the model only sees the first MAX_OUTPUT_CHARS and
        # the complete bounded capture is already available via a redacted
        # full_output_path artifact).
        if len(raw_stdout) + len(raw_stderr) > MAX_DISTILL_INPUT_CHARS:
            return raw_stdout, raw_stderr, False
        sniff_head = (
            f"{raw_stdout}\n{raw_stderr}" if raw_stderr else raw_stdout
        )[:FILTER_SNIFF_CHARS]
        if select_filter(command=command, content=sniff_head) is None:
            return raw_stdout, raw_stderr, False

        root = workspace.require_root()
        redacted_stdout = sanitize_tool_output_no_truncate(raw_stdout)
        redacted_stderr = sanitize_tool_output_no_truncate(raw_stderr)
        store = open_omission_store(GuardedWorkspaceStore(root))
        result = distill_command_output(
            stdout=redacted_stdout,
            stderr=redacted_stderr,
            command=command,
            store=store,
            source=output_id,
        )
        if result.distilled:
            return result.stdout, result.stderr, True
        return raw_stdout, raw_stderr, False
    except Exception:  # noqa: BLE001 — fallback-to-raw is the invariant
        logger.warning("tool-output distillation failed; using raw output", exc_info=True)
        return raw_stdout, raw_stderr, False


# ── Main tool handler ─────────────────────────────────────────────────


def run_command_tool(  # noqa: PLR0915 - linear tool-result assembly is intentional.
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    """Execute a shell command with safety checks and enriched output."""
    if arguments.get("shell") is True:
        raise ToolExecutionFailure(
            code=CMP_TOOL_COMMAND_BLOCKED,
            message="shell execution mode is disabled",
            retryable=False,
        )

    command = _parse_command(arguments)
    cwd = _resolve_cwd(arguments, workspace)
    display_cwd = _display_cwd(cwd, workspace)
    timeout_seconds = _parse_timeout(arguments)
    expected_exit_codes = _parse_expected_exit_codes(arguments)
    if expected_exit_codes is not None and arguments.get("run_in_background") is True:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="expected_exit_codes cannot be used with run_in_background",
            retryable=False,
        )

    # ── Security classification (when feature is enabled) ─────────
    classification_meta: dict[str, str] | None = None
    if _shell_security_enabled():
        verdict = classify_command(command)
        classification_meta = {
            "verdict": verdict.verdict.value,
            "reason": verdict.reason,
            "executable": verdict.executable,
        }
        if verdict.verdict is CommandVerdict.BLOCKED:
            raise ToolExecutionFailure(
                code=CMP_TOOL_COMMAND_BLOCKED,
                message=f"command blocked by security classifier: {verdict.reason}",
                retryable=False,
            )

    argv = _shell_argv(command)

    # ── Background execution ──────────────────────────────────────
    if arguments.get("run_in_background") is True:
        root = workspace.require_root()
        started = start_background_job(
            argv,
            cwd=cwd,
            workspace_root=root,
            timeout_seconds=timeout_seconds,
        )
        job_id = started.job_id
        bg_payload = {
            "job_id": job_id,
            "status": "started",
            "message": f"Background job {job_id} started. Use check_background_job to check status.",
            "shell": _shell_name(),
        }
        return ToolHandlerResult(
            output=json.dumps(bg_payload, ensure_ascii=False, indent=2),
            success=True,
            # background_job_pid is the KILL authority Electron binds at
            # registration; the workspace status.json pid is display-only.
            metadata={
                "background_job_id": job_id,
                "background_job_pid": started.pid,
                "shell": _shell_name(),
            },
        )

    # ── Synchronous execution ─────────────────────────────────────
    try:
        completed = _run_owned_process(
            argv,
            cwd=cwd,
            timeout_seconds=timeout_seconds,
        )
    except (OwnedProcessCapacityError, OwnedProcessShutdownError) as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_CAP_EXCEEDED,
            message=f"command process capacity unavailable: {error}",
            retryable=True,
        ) from error
    except FileNotFoundError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"command not found: {argv[0]}",
            retryable=False,
        ) from error
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to execute command: {error}",
            retryable=True,
        ) from error
    raw_stdout = completed.stdout or ""
    raw_stderr = completed.stderr or ""
    captured_output = getattr(completed, "output", None)
    output_counters = (
        captured_output.counters()
        if captured_output is not None and hasattr(captured_output, "counters")
        else None
    )
    output_truncated = bool(
        (
            captured_output is not None
            and getattr(captured_output, "truncated", False)
        )
        or getattr(completed, "drain_incomplete", False)
    )

    if getattr(completed, "aborted", False):
        # Distinct from timeout: the user cancelled the turn and the owned
        # subprocess tree was terminated on request.
        raise ToolExecutionFailure(
            code=CMP_TOOL_COMMAND_ABORTED,
            message="command aborted by user cancellation",
            retryable=False,
        )
    if getattr(completed, "timed_out", False):
        timeout_payload: dict[str, object] = {
            "command": command,
            "cwd": display_cwd,
            "stdout": _truncate_failure_stream(raw_stdout),
            "stderr": _truncate_failure_stream(raw_stderr),
            "ok": False,
            "shell": _shell_name(),
            "timed_out": True,
            "timeout_seconds": timeout_seconds,
        }
        if output_counters is not None:
            timeout_payload["output_counters"] = output_counters
        if output_truncated:
            timeout_payload["output_truncated"] = True
        return ToolHandlerResult(
            output=json.dumps(timeout_payload, ensure_ascii=False, indent=2),
            success=False,
            error_code=CMP_TOOL_IO_FAILED,
            metadata={
                "shell": _shell_name(),
                "timed_out": True,
                "timeout_seconds": timeout_seconds,
                **({"output_counters": output_counters} if output_counters is not None else {}),
                **({"output_truncated": True} if output_truncated else {}),
            },
        )
    exit_code = int(completed.returncode)

    # ── Semantic exit-code interpretation ─────────────────────────
    expectation_met = (
        exit_code in expected_exit_codes if expected_exit_codes is not None else None
    )
    semantic = None if expected_exit_codes is not None else _is_semantic_ok(command, exit_code)
    is_ok = bool(expectation_met) if expected_exit_codes is not None else (
        exit_code == 0 or semantic is not None
    )

    # ── Large-output persistence ──────────────────────────────────
    combined_raw = raw_stdout + raw_stderr
    if output_truncated and output_counters is not None:
        combined_raw = (
            f"{combined_raw}\n...[{output_counters['discarded_bytes']} output bytes discarded "
            "after the bounded capture limit]"
        )
    output_id = uuid.uuid4().hex[:12]
    # ── Optional errors-first distillation (flag-gated, default OFF) ──
    payload_stdout, payload_stderr, distilled = _maybe_distill_output(
        workspace, command, raw_stdout, raw_stderr, output_id
    )
    full_path = _persist_large_output(
        workspace,
        combined_raw,
        output_id,
        force=distilled,
    )
    if distilled and full_path is None:
        payload_stdout, payload_stderr = raw_stdout, raw_stderr
        distilled = False
    elif distilled and full_path is not None:
        display_path = full_path.display_path
        payload_stdout = payload_stdout.replace(FULL_OUTPUT_PATH_PLACEHOLDER, display_path)
        payload_stderr = payload_stderr.replace(FULL_OUTPUT_PATH_PLACEHOLDER, display_path)

    # ── Build response payload ────────────────────────────────────
    payload: dict[str, object] = {
        "command": command,
        "cwd": display_cwd,
        "exit_code": exit_code,
        "stdout": _truncate(payload_stdout),
        "stderr": _truncate(payload_stderr),
        "ok": is_ok,
        "shell": _shell_name(),
    }
    exit_code_covers_final_segment = _exit_code_covers_final_segment(command)
    completed_with_warnings = exit_code_covers_final_segment and bool(raw_stderr)
    if exit_code_covers_final_segment:
        payload["exit_code_covers"] = "final_segment_only"
        payload["semantic_note"] = (
            "The exit code reflects only the final segment of this chained command; "
            "earlier segments may have failed. Check stderr."
        )
        if completed_with_warnings:
            payload["completed_with_warnings"] = True
    if expected_exit_codes is not None:
        payload["expected_exit_codes"] = list(expected_exit_codes)
        payload["expectation_met"] = expectation_met
        if expectation_met and exit_code != 0:
            payload["expectation_note"] = f"Observed expected exit code: {exit_code}"
    if semantic is not None:
        payload["semantic_note"] = semantic
    if full_path is not None:
        payload["full_output_path"] = full_path.absolute_path
        payload["full_output_display_path"] = full_path.display_path
        payload["full_output_complete"] = not output_truncated
    if output_counters is not None:
        payload["output_counters"] = output_counters
    if output_truncated:
        payload["output_truncated"] = True
    if not is_ok:
        hint = _unresolved_command_hint(raw_stderr)
        if hint is not None:
            payload["hint"] = hint

    # ── Metadata enrichment ───────────────────────────────────────
    metadata: dict[str, object] = {"shell": _shell_name()}
    if expected_exit_codes is not None:
        metadata["expected_exit_codes"] = list(expected_exit_codes)
        metadata["expectation_met"] = expectation_met
    if classification_meta is not None:
        metadata["classification"] = classification_meta
    if full_path is not None:
        metadata["full_output_path"] = full_path.absolute_path
        metadata["full_output_display_path"] = full_path.display_path
        metadata["full_output_complete"] = not output_truncated
    if output_counters is not None:
        metadata["output_counters"] = output_counters
    if output_truncated:
        metadata["output_truncated"] = True
    if exit_code_covers_final_segment:
        metadata["exit_code_covers"] = "final_segment_only"
        if completed_with_warnings:
            metadata["completed_with_warnings"] = True

    # ── Git operation tracking ────────────────────────────────────
    if _git_tracking_enabled():
        git_ops = detect_git_operations(command, raw_stdout, raw_stderr)
        if git_ops:
            ops_data: object = [
                {
                    "kind": op.kind,
                    "branch": op.branch,
                    "sha": op.sha,
                    "pr_number": op.pr_number,
                    "pr_url": op.pr_url,
                    "summary": op.summary,
                }
                for op in git_ops
            ]
            payload["git_operations"] = ops_data
            metadata["git_operations"] = ops_data

    return ToolHandlerResult(
        output=json.dumps(payload, ensure_ascii=False, indent=2),
        success=is_ok,
        # A failing command must carry a code like every other tool failure.
        # Without one the failure summaries the model and the UI are shown
        # degrade to a bare tool name (``_summarize_failed_tool_outcomes``
        # formats ``"tool [code]"`` and drops the bracket when the code is
        # empty), which is exactly the tool that most often fails.
        error_code=None if is_ok else CMP_TOOL_EXECUTION_FAILED,
        metadata=metadata,
    )


# ── Background-job check tool ────────────────────────────────────────


def _validated_background_job_id(arguments: dict[str, object]) -> str:
    job_id = arguments.get("job_id")
    if not isinstance(job_id, str) or not job_id.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'job_id' must be a non-empty string",
            retryable=False,
        )
    if not is_valid_job_id(job_id):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'job_id' must be exactly 12 lowercase hex characters",
            retryable=False,
        )
    return job_id


def check_background_job_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    """Check status and output of a background shell job."""
    job_id = _validated_background_job_id(arguments)
    root = workspace.require_root()
    status = read_background_job(root, job_id)
    if status.get("state") == "not_found":
        raise ToolExecutionFailure(
            code=CMP_TOOL_BACKGROUND_NOT_FOUND,
            message=f"no background job found with id: {job_id}",
            retryable=False,
        )
    return ToolHandlerResult(
        output=json.dumps(status, ensure_ascii=False, indent=2),
        success=status.get("state") in ("completed", "running"),
    )


def stop_background_job_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    """Stop an active background shell job owned by this workspace."""
    job_id = _validated_background_job_id(arguments)
    status = stop_background_job(workspace.require_root(), job_id)
    if status.get("state") == "not_found":
        raise ToolExecutionFailure(
            code=CMP_TOOL_BACKGROUND_NOT_FOUND,
            message=f"no background job found with id: {job_id}",
            retryable=False,
        )
    return ToolHandlerResult(
        output=json.dumps(status, ensure_ascii=False, indent=2),
        success=status.get("state") in ("completed", "failed"),
        metadata={
            "background_job_id": job_id,
            "stop_requested": bool(status.get("stop_requested")),
        },
    )
