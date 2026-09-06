"""Execute one auto-cleaned platform shell script outside the workspace."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import tempfile
from dataclasses import replace
from pathlib import Path

from sidecar.ai.error_codes import (
    CMP_TOOL_COERCED_ARGS_REJECTED,
    CMP_TOOL_COMMAND_BLOCKED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
)
from sidecar.ai.tools.builtins import output_chunk_slot
from sidecar.ai.tools.builtins.shell import (
    _parse_command,
    _shell_security_enabled,
    run_command_tool,
)
from sidecar.ai.tools.builtins.shell_security import CommandVerdict, classify_command
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)
MAX_TEMP_SCRIPT_CHARS = 100_000
SCRIPT_SNIFF_LINE_LIMIT = 20
_LANGUAGE_EXTENSIONS = {
    "python": ".py",
    "powershell": ".ps1",
    "cmd": ".cmd",
    "sh": ".sh",
    "javascript": ".js",
}
_RAW_HEREDOC_PATTERN = re.compile(
    r"(?m)^[ \t]*(?:\S.*?[ \t])?<<-?[ \t]*['\"]?[A-Za-z_][A-Za-z0-9_]*['\"]?[ \t]*$"
)
_OMITTED_LANGUAGE_SCRIPT_PATTERNS = (
    (
        "python",
        re.compile(r"^(?:(?:import|from)\s+\w|def\s+\w+\(|print\()"),
    ),
    (
        "javascript",
        re.compile(r"^(?:(?:const|let|var)\s+\w+\s*=|console\.log\(|require\()"),
    ),
    (
        "powershell",
        re.compile(r"^(?:\$\w+\s*=|Write-(?:Host|Output)\b)"),
    ),
)


def run_temp_script_tool(
    arguments: dict[str, object], workspace: WorkspaceGuard
) -> ToolHandlerResult:
    script, cwd, language = _validated_inputs(arguments)
    temp_root = _create_temp_root()
    extension = (
        _LANGUAGE_EXTENSIONS[language]
        if language is not None
        else (".cmd" if os.name == "nt" else ".sh")
    )
    script_path = temp_root / f"script{extension}"
    result: ToolHandlerResult | None = None
    cleanup_error_type: str | None = None
    try:
        script_path.write_text(script, encoding="utf-8", newline="")
        if os.name != "nt":
            script_path.chmod(0o700)
        command = _script_command(script_path, language=language)
        delegated = _delegated_arguments(arguments, command=command, cwd=cwd)
        result = _redact_temp_details(
            _run_with_redacted_live_output(
                delegated,
                workspace=workspace,
                temp_root=temp_root,
            ),
            temp_root=temp_root,
        )
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"temporary script setup failed: {type(error).__name__}",
            retryable=True,
        ) from error
    finally:
        cleanup_error_type = _cleanup_temp_root(temp_root)
    if result is None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="temporary script did not produce a process result",
            retryable=True,
        )
    if cleanup_error_type is not None:
        result = replace(
            result,
            metadata={**result.metadata, "temp_cleanup_failed": True},
        )
    return result


def _create_temp_root() -> Path:
    try:
        return Path(tempfile.mkdtemp(prefix="jenny-tool-"))
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"temporary script setup failed: {type(error).__name__}",
            retryable=True,
        ) from error


def _validated_inputs(
    arguments: dict[str, object],
) -> tuple[str, str | None, str | None]:
    script = arguments.get("script")
    if not isinstance(script, str) or not script.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'script' must be a non-empty string",
            retryable=False,
        )
    if len(script) > MAX_TEMP_SCRIPT_CHARS:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"tool argument 'script' exceeds {MAX_TEMP_SCRIPT_CHARS} characters",
            retryable=False,
        )
    language = _validated_language(arguments.get("language"))
    if language is None and os.name == "nt" and _RAW_HEREDOC_PATTERN.search(script):
        raise ToolExecutionFailure(
            code=CMP_TOOL_COERCED_ARGS_REJECTED,
            message=(
                "POSIX heredoc syntax cannot run under cmd.exe; pass language: python "
                "(or sh on POSIX) instead."
            ),
            retryable=False,
        )
    if language is None:
        script_family = _obvious_script_family(script)
        if script_family is not None:
            raise ToolExecutionFailure(
                code=CMP_TOOL_COERCED_ARGS_REJECTED,
                message=(
                    f"script looks like {script_family}; pass language: {script_family} "
                    "(run_temp_script runs cmd/sh when language is omitted; pass "
                    "language: cmd or sh explicitly if this really is a shell script)"
                ),
                retryable=False,
            )
    _parse_command({"command": script})
    if _shell_security_enabled():
        verdict = classify_command(script)
        if verdict.verdict is CommandVerdict.BLOCKED:
            raise ToolExecutionFailure(
                code=CMP_TOOL_COMMAND_BLOCKED,
                message=f"temporary script blocked by security classifier: {verdict.reason}",
                retryable=False,
            )
    raw_cwd = arguments.get("cwd")
    if raw_cwd is not None and not isinstance(raw_cwd, str):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'cwd' must be a string",
            retryable=False,
        )

    return script, raw_cwd, language


def _obvious_script_family(script: str) -> str | None:
    non_blank_lines: list[str] = []
    for line in script.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        non_blank_lines.append(stripped)
        if len(non_blank_lines) == SCRIPT_SNIFF_LINE_LIMIT:
            break

    for family, pattern in _OMITTED_LANGUAGE_SCRIPT_PATTERNS:
        if any(pattern.search(line) for line in non_blank_lines):
            return family
    return None


def _validated_language(value: object) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or value not in _LANGUAGE_EXTENSIONS:
        valid = "|".join(_LANGUAGE_EXTENSIONS)
        raise ToolExecutionFailure(
            code=CMP_TOOL_COERCED_ARGS_REJECTED,
            message=f"tool argument 'language' must be one of {valid}",
            retryable=False,
        )
    if value == "cmd" and os.name != "nt":
        raise ToolExecutionFailure(
            code=CMP_TOOL_COERCED_ARGS_REJECTED,
            message=(
                "language 'cmd' requires Windows; current platform is POSIX. "
                "Pass language: python instead."
            ),
            retryable=False,
        )
    if value == "sh" and os.name == "nt":
        raise ToolExecutionFailure(
            code=CMP_TOOL_COERCED_ARGS_REJECTED,
            message=(
                "language 'sh' requires POSIX; current platform is Windows. "
                "Pass language: python instead."
            ),
            retryable=False,
        )
    return value


def _script_command(script_path: Path, *, language: str | None) -> str:
    quoted_script = f'"{script_path}"'
    if language is None:
        return f"call {quoted_script}" if os.name == "nt" else f"/bin/sh {quoted_script}"
    if language == "cmd":
        return f"call {quoted_script}"
    if language == "sh":
        return f"/bin/sh {quoted_script}"

    interpreter_names = {
        "python": ("python", "python3"),
        "powershell": ("powershell", "pwsh"),
        "javascript": ("node",),
    }[language]
    interpreter = next(
        (resolved for name in interpreter_names if (resolved := shutil.which(name))),
        None,
    )
    if interpreter is None:
        missing = "/".join(interpreter_names)
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"script interpreter is unavailable: {missing}",
            retryable=False,
            error_details={"failure_class": "unavailable"},
        )
    prefix = f'"{interpreter}"'
    if language == "powershell":
        prefix = f"{prefix} -NoProfile -ExecutionPolicy Bypass -File"
    return f"{prefix} {quoted_script}"


def _delegated_arguments(
    arguments: dict[str, object], *, command: str, cwd: str | None
) -> dict[str, object]:
    delegated: dict[str, object] = {
        "command": command,
        "timeout_seconds": arguments.get("timeout_seconds", 10),
    }
    if cwd is not None:
        delegated["cwd"] = cwd
    if "expected_exit_codes" in arguments:
        delegated["expected_exit_codes"] = arguments["expected_exit_codes"]
    return delegated


def _cleanup_temp_root(temp_root: Path) -> str | None:
    try:
        shutil.rmtree(temp_root)
        return None
    except OSError as error:
        error_type = type(error).__name__
        log_event(
            logger,
            logging.WARNING,
            component="ai.tools.run_temp_script",
            event="ai.tools.run_temp_script.cleanup_failed",
            message="Temporary script cleanup failed.",
            status="degraded",
            data={"error_type": error_type},
        )
        return error_type


def _run_with_redacted_live_output(
    arguments: dict[str, object],
    *,
    workspace: WorkspaceGuard,
    temp_root: Path,
) -> ToolHandlerResult:
    writer = output_chunk_slot.current_writer()
    if writer is None:
        return run_command_tool(arguments, workspace)

    def redacted_writer(batch: dict[str, object]) -> None:
        redacted = dict(batch)
        raw_lines = batch.get("lines")
        if isinstance(raw_lines, list):
            redacted["lines"] = [
                {
                    **line,
                    "text": _redact_temp_path(str(line.get("text") or ""), temp_root),
                }
                if isinstance(line, dict)
                else line
                for line in raw_lines
            ]
        writer(redacted)

    output_chunk_slot.begin_tool_call(redacted_writer)
    try:
        return run_command_tool(arguments, workspace)
    finally:
        output_chunk_slot.begin_tool_call(writer)


def _redact_temp_path(value: str, temp_root: Path) -> str:
    redacted = value.replace(str(temp_root), "<temporary-script>")
    return redacted.replace(str(temp_root).replace("\\", "/"), "<temporary-script>")


def _redact_temp_details(
    result: ToolHandlerResult, *, temp_root: Path
) -> ToolHandlerResult:
    redacted_output = _redact_temp_path(result.output, temp_root)
    try:
        payload = json.loads(redacted_output)
    except (TypeError, json.JSONDecodeError):
        payload = {"output": redacted_output}
    if isinstance(payload, dict):
        payload["command"] = "[temporary script]"
        payload.pop("cwd", None)
        output = json.dumps(payload, ensure_ascii=False, indent=2)
    else:
        output = redacted_output
    return replace(
        result,
        output=output,
        metadata={**result.metadata, "temporary_script": True},
    )
