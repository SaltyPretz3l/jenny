"""Validation and bounded result contracts for the model-facing ``delegate`` tool."""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any, Iterable

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_SUBAGENT_DEPTH_LIMIT,
    CMP_TOOL_SUBAGENT_INVALID_GRANTS,
    CMP_TOOL_SUBAGENT_INVALID_PROMPT,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.sanitization import sanitize_tool_output

DELEGATE_TOOL_NAME = "delegate"
DELEGATE_EXECUTION_FAILURE_CODE = CMP_TOOL_EXECUTION_FAILED
MAX_DELEGATE_TASKS = 3
MAX_DELEGATE_TASK_BYTES = 16_000
MAX_DELEGATE_TOTAL_BYTES = 32_000
MAX_DELEGATE_ANSWER_CHARS = 1_000
MAX_DELEGATE_EVIDENCE_ITEMS = 3
MAX_DELEGATE_EVIDENCE_FIELD_CHARS = 300
MAX_DELEGATE_OUTPUT_CHARS = 8_000
CANONICAL_DELEGATE_EXAMPLE = {"tasks": ["Inspect the repository and identify its test command"]}
CANONICAL_DELEGATE_EXAMPLE_JSON = json.dumps(
    CANONICAL_DELEGATE_EXAMPLE,
    ensure_ascii=False,
    separators=(",", ":"),
)

_TOP_LEVEL_ALIASES = frozenset({"tasks", "task", "prompt"})
_SUPPORTED_EVIDENCE_TOOLS = frozenset({"read_file", "grep_search", "git_status"})
_GREP_LINE_RE = re.compile(r"^(?P<path>.+?):(?P<line>[1-9][0-9]*):(?P<quote>.*)$")


@dataclass(frozen=True)
class DelegateTask:
    ordinal: int
    prompt: str | None = None
    error: dict[str, Any] | None = None


@dataclass(frozen=True)
class DelegateRequest:
    tasks: tuple[DelegateTask, ...]

    @property
    def valid_tasks(self) -> tuple[DelegateTask, ...]:
        return tuple(task for task in self.tasks if task.error is None and task.prompt is not None)


@dataclass(frozen=True)
class CompactDelegateSettlement:
    report: dict[str, Any]
    output: str
    status: str
    success: bool


def validate_delegate_arguments(
    arguments: object,
    *,
    parent_agent_depth: int = 0,
) -> DelegateRequest:
    """Normalize only documented aliases and isolate malformed array items."""

    if not isinstance(arguments, dict):
        raise _top_level_failure("arguments must be an object")
    if parent_agent_depth >= 1:
        raise ToolExecutionFailure(
            code=CMP_TOOL_SUBAGENT_DEPTH_LIMIT,
            message="delegate cannot run inside another subagent (depth limit = 1)",
            retryable=False,
        )

    unknown = [field for field in arguments if field not in _TOP_LEVEL_ALIASES]
    if unknown:
        raise _top_level_failure("unsupported fields are not allowed", grants=True)
    supplied = [field for field in ("tasks", "task", "prompt") if field in arguments]
    if len(supplied) != 1:
        detail = "exactly one of 'tasks', 'task', or 'prompt' is required"
        raise _top_level_failure(detail, grants=len(supplied) > 1)

    raw_value = arguments[supplied[0]]
    if supplied[0] in {"task", "prompt"}:
        if not isinstance(raw_value, str):
            raise _top_level_failure(f"'{supplied[0]}' must be a string")
        raw_tasks: list[object] = [raw_value]
    elif isinstance(raw_value, str):
        raw_tasks = [raw_value]
    elif isinstance(raw_value, list):
        raw_tasks = list(raw_value)
    else:
        raise _top_level_failure("'tasks' must be a string or an array")

    if not 1 <= len(raw_tasks) <= MAX_DELEGATE_TASKS:
        raise _top_level_failure(f"between 1 and {MAX_DELEGATE_TASKS} tasks are required")
    if _aggregate_candidate_bytes(raw_tasks) > MAX_DELEGATE_TOTAL_BYTES:
        raise _top_level_failure(
            f"tasks exceed the {MAX_DELEGATE_TOTAL_BYTES} byte aggregate limit"
        )
    return DelegateRequest(
        tasks=tuple(
            _normalize_task(raw_task, ordinal=ordinal)
            for ordinal, raw_task in enumerate(raw_tasks, start=1)
        )
    )


def extract_tool_observed_evidence(decision: Any | None) -> list[dict[str, Any]]:
    """Build provenance only from successful outcomes of the three supported tools."""

    evidence: list[dict[str, Any]] = []
    for outcome in tuple(getattr(decision, "tool_results", ()) or ()):
        if len(evidence) >= MAX_DELEGATE_EVIDENCE_ITEMS:
            break
        source_tool = str(getattr(outcome, "tool_name", "") or "").strip()
        if source_tool not in _SUPPORTED_EVIDENCE_TOOLS or not bool(
            getattr(outcome, "success", False)
        ):
            continue
        if source_tool == "read_file":
            record = _read_file_evidence(outcome)
            if record:
                evidence.append(record)
        elif source_tool == "grep_search":
            for record in _grep_evidence(outcome):
                if len(evidence) >= MAX_DELEGATE_EVIDENCE_ITEMS:
                    break
                evidence.append(record)
        else:
            record = _git_status_evidence(outcome)
            if record:
                evidence.append(record)
    return evidence


def build_compact_delegate_settlement(
    *,
    execution: str,
    task_reports: Iterable[dict[str, Any]],
) -> CompactDelegateSettlement:
    """Build the only payload inserted into parent-model context."""

    results = [_compact_result(report) for report in task_reports]
    status = _aggregate_status(results)
    report: dict[str, Any] = {
        "status": status,
        "execution": (
            execution if execution in {"single", "sequential", "parallel"} else "sequential"
        ),
        "results": results,
    }
    bounded, output = _bound_compact_report(report)
    return CompactDelegateSettlement(
        report=bounded,
        output=output,
        status=status,
        success=any(item["status"] in {"completed", "partial"} for item in results),
    )


def _normalize_task(raw_task: object, *, ordinal: int) -> DelegateTask:
    try:
        prompt = _task_prompt(raw_task, ordinal=ordinal)
        encoded_size = _task_utf8_size(prompt, ordinal=ordinal)
        if encoded_size > MAX_DELEGATE_TASK_BYTES:
            raise _item_failure(f"task {ordinal} exceeds the {MAX_DELEGATE_TASK_BYTES} byte limit")
        return DelegateTask(ordinal=ordinal, prompt=prompt)
    except ToolExecutionFailure as error:
        return DelegateTask(
            ordinal=ordinal,
            error={
                "code": str(error.code or CMP_TOOL_SUBAGENT_INVALID_PROMPT),
                "message": _safe_text(error.message, max_chars=300),
                "retryable": bool(error.retryable),
            },
        )


def _task_prompt(raw_task: object, *, ordinal: int) -> str:
    value = raw_task
    if isinstance(raw_task, dict):
        keys = set(raw_task)
        if len(keys) != 1 or not keys <= {"task", "prompt"}:
            raise _item_failure(
                f"task {ordinal} object must contain exactly one 'task' or 'prompt' field",
                grants=True,
            )
        value = raw_task[next(iter(keys))]
    if not isinstance(value, str) or not value.strip():
        raise _item_failure(f"task {ordinal} must be a non-empty string")
    return value.strip()


def _aggregate_candidate_bytes(raw_tasks: Iterable[object]) -> int:
    total = 0
    for ordinal, raw_task in enumerate(raw_tasks, start=1):
        value = raw_task
        if isinstance(raw_task, dict) and len(raw_task) == 1:
            value = next(iter(raw_task.values()))
        if isinstance(value, str):
            try:
                total += _task_utf8_size(value, ordinal=ordinal)
            except ToolExecutionFailure:
                # Invalid Unicode belongs to this task, not the whole call. The
                # per-item normalizer below records the structured rejection.
                continue
    return total


def _task_utf8_size(value: str, *, ordinal: int) -> int:
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise _item_failure(f"task {ordinal} contains invalid Unicode") from error


def _read_file_evidence(outcome: Any) -> dict[str, Any] | None:
    metadata = getattr(outcome, "metadata", None)
    metadata = metadata if isinstance(metadata, dict) else {}
    relative_path = _safe_relative_path(metadata.get("path"))
    if not relative_path:
        return None
    output = str(getattr(outcome, "output", "") or "")
    content_lines = output.splitlines()
    if output.startswith("path: "):
        try:
            separator = content_lines.index("")
        except ValueError:
            content_lines = []
        else:
            content_lines = content_lines[separator + 1 :]
    quote = next((line.strip() for line in content_lines if line.strip()), "")
    record: dict[str, Any] = {
        "source_tool": "read_file",
        "relative_path": relative_path,
        "quote": _safe_text(quote, max_chars=MAX_DELEGATE_EVIDENCE_FIELD_CHARS),
        "provenance": "tool_observed",
    }
    line_start = _positive_int(metadata.get("returned_line_start"))
    line_end = _positive_int(metadata.get("returned_line_end"))
    if line_start is None and content_lines:
        line_start = 1
        line_end = len(content_lines)
    if line_start is not None:
        record["line_start"] = line_start
        record["line_end"] = max(line_start, line_end or line_start)
    return _normalize_evidence_record(record)


def _grep_evidence(outcome: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for raw_line in str(getattr(outcome, "output", "") or "").splitlines():
        match = _GREP_LINE_RE.match(raw_line.strip())
        if match is None:
            continue
        relative_path = _safe_relative_path(match.group("path"))
        if not relative_path:
            continue
        line_number = int(match.group("line"))
        record = _normalize_evidence_record(
            {
                "source_tool": "grep_search",
                "relative_path": relative_path,
                "line_start": line_number,
                "line_end": line_number,
                "quote": match.group("quote").strip(),
                "provenance": "tool_observed",
            }
        )
        if record:
            records.append(record)
        if len(records) >= MAX_DELEGATE_EVIDENCE_ITEMS:
            break
    return records


def _git_status_evidence(outcome: Any) -> dict[str, Any] | None:
    lines = [line.strip() for line in str(getattr(outcome, "output", "") or "").splitlines()]
    branch_line = next((line for line in lines if line.startswith("## ")), "")
    if branch_line:
        value = branch_line[3:].split("...", 1)[0].strip()
        fact = "branch"
    elif lines and lines[0] == "(clean working tree)":
        value = "clean"
        fact = "working_tree"
    else:
        value = "dirty" if any(line for line in lines if line) else ""
        fact = "working_tree"
    if not value:
        return None
    return _normalize_evidence_record(
        {
            "source_tool": "git_status",
            "fact": fact,
            "value": value,
            "provenance": "tool_observed",
        }
    )


def _compact_result(report: dict[str, Any]) -> dict[str, Any]:
    raw_status = str(report.get("status") or "failed").strip().lower()
    status = (
        raw_status if raw_status in {"completed", "partial", "failed", "cancelled"} else "failed"
    )
    answer = _truncate_with_ellipsis(
        _safe_text(report.get("summary"), max_chars=MAX_DELEGATE_ANSWER_CHARS * 2),
        MAX_DELEGATE_ANSWER_CHARS,
    )
    evidence: list[dict[str, Any]] = []
    for raw_record in list(report.get("evidence") or ()):
        record = _normalize_evidence_record(raw_record)
        if record:
            evidence.append(record)
        if len(evidence) >= MAX_DELEGATE_EVIDENCE_ITEMS:
            break
    return {
        "ordinal": max(1, int(report.get("ordinal") or 1)),
        "status": status,
        "answer": answer,
        "evidence": evidence,
    }


def _normalize_evidence_record(raw_record: object) -> dict[str, Any] | None:
    if not isinstance(raw_record, dict):
        return None
    source_tool = str(raw_record.get("source_tool") or "").strip()
    if source_tool not in _SUPPORTED_EVIDENCE_TOOLS:
        return None
    if str(raw_record.get("provenance") or "").strip() != "tool_observed":
        return None
    record: dict[str, Any] = {
        "source_tool": source_tool,
        "provenance": "tool_observed",
    }
    for field in ("relative_path", "quote", "fact", "value"):
        value = raw_record.get(field)
        if field == "relative_path":
            normalized = _safe_relative_path(value)
        else:
            normalized = _safe_text(value, max_chars=MAX_DELEGATE_EVIDENCE_FIELD_CHARS)
        if normalized:
            record[field] = normalized
    line_start = _positive_int(raw_record.get("line_start"))
    line_end = _positive_int(raw_record.get("line_end"))
    if line_start is not None:
        record["line_start"] = line_start
        record["line_end"] = max(line_start, line_end or line_start)
    if "relative_path" not in record and "fact" not in record:
        return None
    return record


def _aggregate_status(results: list[dict[str, Any]]) -> str:
    statuses = [str(result.get("status") or "failed") for result in results]
    if statuses and all(status == "completed" for status in statuses):
        return "completed"
    if any(status == "cancelled" for status in statuses):
        return "cancelled"
    if any(status in {"completed", "partial"} for status in statuses):
        return "partial"
    return "failed"


def _bound_compact_report(report: dict[str, Any]) -> tuple[dict[str, Any], str]:
    bounded = copy.deepcopy(report)
    output = _serialize(bounded)
    if len(output) <= MAX_DELEGATE_OUTPUT_CHARS:
        return bounded, output
    for result in reversed(bounded["results"]):
        while result["evidence"]:
            result["evidence"].pop()
            output = _serialize(bounded)
            if len(output) <= MAX_DELEGATE_OUTPUT_CHARS:
                return bounded, output
    for limit in range(MAX_DELEGATE_ANSWER_CHARS - 100, 0, -100):
        for result in reversed(bounded["results"]):
            result["answer"] = _truncate_with_ellipsis(result["answer"], limit)
            output = _serialize(bounded)
            if len(output) <= MAX_DELEGATE_OUTPUT_CHARS:
                return bounded, output
    for result in bounded["results"]:
        result["answer"] = ""
    return bounded, _serialize(bounded)


def _safe_relative_path(value: object) -> str:
    text = _safe_text(value, max_chars=MAX_DELEGATE_EVIDENCE_FIELD_CHARS).replace("\\", "/")
    windows_path = PureWindowsPath(text)
    if (
        not text
        or PurePosixPath(text).is_absolute()
        or windows_path.is_absolute()
        or bool(windows_path.drive)
    ):
        return ""
    if ".." in PurePosixPath(text).parts:
        return ""
    while text.startswith("./"):
        text = text[2:]
    return text


def _positive_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if not isinstance(value, (int, float, str)):
        return None
    try:
        candidate = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return candidate if candidate > 0 else None


def _safe_text(value: object, *, max_chars: int) -> str:
    return sanitize_tool_output(value, max_chars=max_chars, tool_name=DELEGATE_TOOL_NAME).strip()


def _truncate_with_ellipsis(value: object, limit: int) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    if limit <= 1:
        return "\u2026"[:limit]
    return f"{text[: limit - 1]}\u2026"


def _serialize(report: dict[str, Any]) -> str:
    return json.dumps(report, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _item_failure(message: str, *, grants: bool = False) -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=(CMP_TOOL_SUBAGENT_INVALID_GRANTS if grants else CMP_TOOL_SUBAGENT_INVALID_PROMPT),
        message=f"{message}. Canonical form: {CANONICAL_DELEGATE_EXAMPLE_JSON}",
        retryable=False,
    )


def _top_level_failure(message: str, *, grants: bool = False) -> ToolExecutionFailure:
    return _item_failure(f"Invalid delegate arguments: {message}", grants=grants)


__all__ = [
    "CANONICAL_DELEGATE_EXAMPLE",
    "CANONICAL_DELEGATE_EXAMPLE_JSON",
    "DELEGATE_TOOL_NAME",
    "CompactDelegateSettlement",
    "DelegateRequest",
    "DelegateTask",
    "build_compact_delegate_settlement",
    "extract_tool_observed_evidence",
    "validate_delegate_arguments",
]
