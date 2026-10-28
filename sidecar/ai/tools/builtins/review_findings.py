"""``report_findings``: normalise a model's code-review findings for the inline list.

The tool is read-only. It never fails the whole call for one bad entry: entries
without a usable title are dropped and counted, unknown severities become
medium, and a location that escapes the workspace is kept as a finding with no
location. The renderer parses the JSON output; the model only needs the note.
"""

from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from sidecar.ai.error_codes import CMP_TOOL_REVIEW_FINDINGS_INVALID
from sidecar.ai.tools.builtins.file_state import is_binary_content, read_capped_bytes
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.sanitization import sanitize_tool_output_no_truncate
from sidecar.ai.tools.workspace import WorkspaceGuard

MAX_FINDINGS: Final[int] = 30
MAX_TITLE_CHARS: Final[int] = 160
MAX_BODY_CHARS: Final[int] = 2_000
MAX_SCOPE_CHARS: Final[int] = 120
MAX_SUMMARY_CHARS: Final[int] = 600
MAX_END_LINE_SPAN: Final[int] = 50
MAX_EXCERPT_FILE_BYTES: Final[int] = 2 * 1024 * 1024
MAX_EXCERPT_LINES: Final[int] = 5
MAX_EXCERPT_LINE_CHARS: Final[int] = 240
# The router bounds every tool result to 16,000 characters
# (sidecar/ai/routing/harness_helpers.py MAX_RESPONSE_CHARS) and compacts larger
# JSON by omitting fields, which would break the renderer's parse. Stay under it.
# Its whole-text secret redaction (`token\s*[:=]\s*[^\s,;'"{}]+`) eats the backslash of an
# escaped quote, so in-string quotes are written as the escape for U+0022 (see _render, _fits).
MAX_OUTPUT_CHARS: Final[int] = 15_000
_JSON_ESCAPE_RE = re.compile(r"\\(.)")
_FIT_BODY_CAPS: Final[tuple[int, ...]] = (1_000, 500, 240)
_FIT_LAST_BODY_CAPS: Final[tuple[int, ...]] = (120, 40)

RESULT_NOTE: Final[str] = (
    "Shown to the user as a list. Do not repeat the findings; reply in one or two sentences."
)
_SEVERITIES: Final[tuple[str, ...]] = ("high", "medium", "low")
_SEVERITY_ALIASES: Final[dict[str, str]] = {
    **dict.fromkeys(("critical", "blocker", "p0", "p1", "high", "error", "major"), "high"),
    **dict.fromkeys(("medium", "moderate", "p2", "warning", "warn"), "medium"),
    **dict.fromkeys(("low", "minor", "p3", "nit", "info", "suggestion"), "low"),
}
_WHITESPACE_RE = re.compile(r"\s+")
_LINE_SUFFIX_RE = re.compile(r":(\d+)(?::\d+)?$")
_INVALID_MESSAGE: Final[str] = (
    "report_findings needs `findings`: a list of 1 to 30 objects, each with a non-empty "
    "`title` and a `severity` of high, medium or low, plus optional `body`, `file` "
    "(workspace-relative path), `line` and `end_line`. Send the findings again in that shape."
)


def _invalid() -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_TOOL_REVIEW_FINDINGS_INVALID, message=_INVALID_MESSAGE, retryable=False
    )


def _text(value: object, *, max_chars: int, collapse: bool = False) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = _WHITESPACE_RE.sub(" ", value) if collapse else value
    return cleaned.strip()[:max_chars].rstrip()


def _severity(value: object) -> str:
    key = value.strip().lower() if isinstance(value, str) else ""
    return _SEVERITY_ALIASES.get(key, "medium")


def _line_number(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    return value if isinstance(value, int) and value >= 1 else 0


def _split_location(value: object) -> tuple[str, int]:
    """Return the cleaned path text and any trailing ``:N`` / ``:N:M`` line."""
    if not isinstance(value, str):
        return "", 0
    path_text = value.strip().replace("\\", "/")
    while path_text.startswith("./"):
        path_text = path_text[2:]
    match = _LINE_SUFFIX_RE.search(path_text)
    if match is None:
        return path_text, 0
    return path_text[: match.start()], _line_number(match.group(1))


def _workspace_relative(path_text: str, workspace: WorkspaceGuard) -> tuple[str, Path | None]:
    """Resolve through the guard; an escaping or invalid path yields no location.

    Non-strict (the write resolver): a finding may name a file the change deleted.
    """
    root = workspace.root
    if not path_text or root is None:
        return "", None
    try:
        resolved = workspace.resolve_write_path(path_text)
    except ToolExecutionFailure:
        return "", None
    relative = resolved.relative_to(root).as_posix()
    return ("", None) if relative == "." else (relative, resolved)


def _read_lines(resolved: Path, relative: str, root: Path | None) -> list[str] | None:
    try:
        info = os.stat(resolved)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_EXCERPT_FILE_BYTES:
            return None
        _, data = read_capped_bytes(
            resolved, max_bytes=MAX_EXCERPT_FILE_BYTES, relative_path=relative, authorized_root=root
        )
    except (OSError, ToolExecutionFailure):
        return None
    if is_binary_content(data):
        return None
    lines = data.decode("utf-8", errors="replace").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def _excerpt(lines: list[str] | None, line: int, end_line: int) -> dict[str, object] | None:
    if lines is None or line < 1 or line > len(lines):
        return None
    start = max(1, line - 1)
    stop = min(end_line + 1, start + MAX_EXCERPT_LINES - 1, len(lines))
    return {
        "start": start,
        "lines": [text.rstrip("\r\n")[:MAX_EXCERPT_LINE_CHARS] for text in lines[start - 1 : stop]],
    }


@dataclass
class _Finding:
    severity: str
    title: str
    body: str
    file: str
    line: int
    end_line: int
    resolved: Path | None
    excerpt: dict[str, object] | None = None

    def to_payload(self, index: int) -> dict[str, object]:
        return {
            "index": index,
            "severity": self.severity,
            "title": self.title,
            "body": self.body,
            "file": self.file,
            "line": self.line,
            "end_line": self.end_line,
            "excerpt": self.excerpt,
        }


def _normalise_finding(entry: object, workspace: WorkspaceGuard) -> _Finding | None:
    if not isinstance(entry, dict):
        return None
    title = _text(entry.get("title"), max_chars=MAX_TITLE_CHARS, collapse=True)
    if not title:
        return None
    path_text, suffix_line = _split_location(entry.get("file"))
    file, resolved = _workspace_relative(path_text, workspace)
    line = (_line_number(entry.get("line")) or suffix_line) if file else 0
    end_line = _line_number(entry.get("end_line"))
    end_line = min(max(end_line, line), line + MAX_END_LINE_SPAN) if line else 0
    return _Finding(
        severity=_severity(entry.get("severity")),
        title=title,
        body=_text(entry.get("body"), max_chars=MAX_BODY_CHARS),
        file=file,
        line=line,
        end_line=end_line,
        resolved=resolved,
    )


def _render(findings: list[_Finding], *, scope: str, summary: str, dropped: int) -> str:
    payload = {
        "kind": "review_findings",
        "version": 1,
        "scope": scope,
        "summary": summary,
        "counts": {
            severity: sum(1 for finding in findings if finding.severity == severity)
            for severity in _SEVERITIES
        },
        "findings": [finding.to_payload(index) for index, finding in enumerate(findings, 1)],
        "dropped": dropped,
        "note": RESULT_NOTE,
    }
    # ASCII only: the router's NFKC pass would turn a fullwidth quote or backslash into a bare
    # one (invalid JSON) and strip zero-width characters from paths; escaped, the filters cannot
    # touch them.
    text = json.dumps(payload, ensure_ascii=True)
    # Escape pairs are matched left to right, so `\\` followed by a closing quote stays as is.
    return _JSON_ESCAPE_RE.sub(lambda m: "\\u0022" if m.group(1) == '"' else m.group(0), text)


def _fits(text: str) -> bool:
    """True when the text is in bounds and still valid JSON after the router's filters."""
    # The filters cost milliseconds per 10 KB (more on hostile text): only run them on a candidate
    # already in bounds, so the oversized ones the shrink loops start from are rejected for free.
    if len(text) > MAX_OUTPUT_CHARS:
        return False
    filtered = sanitize_tool_output_no_truncate(text)
    if len(filtered) > MAX_OUTPUT_CHARS:
        return False
    try:
        json.loads(filtered)
    except ValueError:
        return False
    return True


def _fit_output(findings: list[_Finding], *, scope: str, summary: str, dropped: int) -> str:
    """Shrink bodies, then excerpts, then drop the lowest findings until the JSON fits."""

    def render() -> str:
        return _render(findings, scope=scope, summary=summary, dropped=dropped)

    text = render()
    for cap in _FIT_BODY_CAPS:
        if _fits(text):
            return text
        for finding in findings:
            finding.body = finding.body[:cap].rstrip()
        text = render()
    for finding in reversed(findings):
        if _fits(text):
            return text
        if finding.excerpt is not None:
            finding.excerpt = None
            text = render()
    for cap in _FIT_LAST_BODY_CAPS:
        if _fits(text):
            return text
        for finding in findings:
            finding.body = finding.body[:cap].rstrip()
        text = render()
    while not _fits(text) and len(findings) > 1:
        findings.pop()
        dropped += 1
        text = render()
    return text


def report_findings_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    """Normalise review findings into the ``review_findings`` v1 payload."""
    raw_findings = arguments.get("findings")
    if not isinstance(raw_findings, list):
        raise _invalid()
    findings: list[_Finding] = []
    dropped = 0
    for position, entry in enumerate(raw_findings):
        if len(findings) >= MAX_FINDINGS:
            dropped += len(raw_findings) - position
            break
        finding = _normalise_finding(entry, workspace)
        if finding is None:
            dropped += 1
        else:
            findings.append(finding)
    if not findings:
        raise _invalid()
    findings.sort(key=lambda finding: _SEVERITIES.index(finding.severity))
    # Several findings usually share a file: read each file once, and hold one at a time.
    by_file: dict[Path, list[_Finding]] = {}
    for finding in findings:
        if finding.resolved is not None and finding.line >= 1:
            by_file.setdefault(finding.resolved, []).append(finding)
    for resolved, group in by_file.items():
        lines = _read_lines(resolved, group[0].file, workspace.root)
        for finding in group:
            finding.excerpt = _excerpt(lines, finding.line, finding.end_line)
    output = _fit_output(
        findings,
        scope=_text(arguments.get("scope"), max_chars=MAX_SCOPE_CHARS),
        summary=_text(arguments.get("summary"), max_chars=MAX_SUMMARY_CHARS),
        dropped=dropped,
    )
    return ToolHandlerResult(
        output=output,
        success=True,
        metadata={"result_kind": "review_findings", "finding_count": len(findings)},
    )
