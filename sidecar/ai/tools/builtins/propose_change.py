"""``propose_change``: record one suggested change for review, never write it (Plan Plus C2).

Propose mode only. The tool validates a create or replace exactly as edit_file
would match it and returns a ``suggested_change`` v1 record; Electron stores
it and the user decides. It never writes to the workspace, takes no checkpoint
and never captures a pre-change snapshot (``compute_structured_diff`` only).
"""

from __future__ import annotations

from pathlib import Path

from sidecar.ai.error_codes import (
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
)
from sidecar.ai.tools.builtins.file_state import (
    load_existing_text_state_for_mutation,
    refuse_reserved_internal_path,
)
from sidecar.ai.tools.builtins.filesystem import (
    current_max_edit_file_bytes,
    failure_result,
    workspace_relative_path,
)
from sidecar.ai.tools.builtins.propose_suggestion import (
    LIVE_SUGGESTIONS_ARG,
    MAX_SUGGESTION_STRING_CHARS,
    ONE_CHANGE_TEXT,
    RECORDED_TEXT,
    SUGGESTION_KINDS,
    TOO_LARGE_TEXT,
    batch_refusal,
    build_suggestion_record,
    derive_import_facts,
    match_replace,
    overlap_refusal,
    parse_live_context,
    plain_words,
    valid_depends_on,
    valid_group,
    valid_revises,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

_ACTION = "suggest changes to"


def _argument_refusal(arguments: dict[str, object]) -> ToolHandlerResult | None:
    path, kind = arguments.get("path"), arguments.get("kind")
    old_string, new_string = arguments.get("old_string"), arguments.get("new_string")
    problems = (
        (arguments.get("replace_all") is True or "edits" in arguments, ONE_CHANGE_TEXT),
        (
            not isinstance(path, str) or not path.strip(),
            "tool argument 'path' must be a non-empty string",
        ),
        (kind not in SUGGESTION_KINDS, "tool argument 'kind' must be \"create\" or \"replace\""),
        (not isinstance(new_string, str), "tool argument 'new_string' must be a string"),
        (
            kind == "replace" and (not isinstance(old_string, str) or not old_string),
            "kind \"replace\" needs a non-empty old_string copied from the file",
        ),
        (
            kind == "create" and old_string not in (None, ""),
            "old_string is only for kind \"replace\"; a new file has no old text",
        ),
        (
            not valid_revises(arguments.get("revises")),
            "revises must be the id of the suggestion this change replaces",
        ),
        (
            not valid_group(arguments.get("group")),
            "group must be a short label (letters, digits, dot, dash or underscore)",
        ),
        (
            not valid_depends_on(arguments.get("depends_on")),
            "depends_on must be a list of up to 10 suggestion ids",
        ),
    )
    problem = next((message for failed, message in problems if failed), None)
    if problem is not None:
        return failure_result(message=problem, error_code=CMP_TOOL_INVALID_PATH)
    if any(
        isinstance(value, str) and len(value) > MAX_SUGGESTION_STRING_CHARS
        for value in (old_string, new_string)
    ):
        return failure_result(message=TOO_LARGE_TEXT, error_code=CMP_TOOL_CAP_EXCEEDED)
    return None


def _resolve_target(path: str, kind: str, workspace: WorkspaceGuard) -> Path:
    if kind == "replace":
        resolved = workspace.resolve_read_path(path)
        if not resolved.is_file():
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message=f"path must point to a file: {path}",
                retryable=False,
            )
        return resolved
    resolved = workspace.resolve_write_path(path)
    if resolved.exists() or resolved.is_symlink():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=(
                f"{path} already exists. Use kind \"replace\" to suggest a change to it."
            ),
            retryable=False,
        )
    workspace.ensure_safe_mutation_path(resolved)
    return resolved


def _replace_texts(
    resolved: Path, relative_path: str, old_string: str, new_string: str, max_bytes: int
) -> tuple[str, str] | ToolHandlerResult:
    """Current and suggested file text for a replace, or the edit_file-style refusal."""
    if old_string == new_string:
        return failure_result(
            message="old_string and new_string are identical. Nothing to suggest.",
            error_code=CMP_TOOL_EXECUTION_FAILED,
        )
    try:
        existing = load_existing_text_state_for_mutation(
            path=resolved,
            relative_path=relative_path,
            max_bytes=max_bytes,
            expected_snapshot_value=None,
            action="suggesting a change",
            require_read_snapshot=False,
        )
    except ToolExecutionFailure as error:
        return failure_result(message=error.message, error_code=error.code)
    matched = match_replace(
        existing.text, old_string, new_string, relative_path=relative_path, max_bytes=max_bytes
    )
    if isinstance(matched, ToolHandlerResult):
        return matched
    return existing.text, matched


def propose_change_tool(  # noqa: PLR0911 - one refusal per validation stage.
    arguments: dict[str, object], workspace: WorkspaceGuard
) -> ToolHandlerResult:
    refusal = _argument_refusal(arguments)
    if refusal is not None:
        return refusal
    path, kind = str(arguments["path"]).strip(), str(arguments["kind"])
    raw_old, raw_revises = arguments.get("old_string"), arguments.get("revises")
    old_string = raw_old if kind == "replace" and isinstance(raw_old, str) else ""
    new_string = str(arguments["new_string"])
    revises = raw_revises if isinstance(raw_revises, str) else None
    raw_group, raw_depends = arguments.get("group"), arguments.get("depends_on")
    group = raw_group if isinstance(raw_group, str) else None
    depends_on = tuple(raw_depends) if isinstance(raw_depends, list) else ()
    try:
        resolved = _resolve_target(path, kind, workspace)
        relative_path = workspace_relative_path(resolved, workspace.require_root())
        refuse_reserved_internal_path(relative_path, action=_ACTION)
    except ToolExecutionFailure as error:
        return failure_result(message=error.message, error_code=error.code)

    live = parse_live_context(arguments.get(LIVE_SUGGESTIONS_ARG))
    bounded = batch_refusal(live, relative_path)
    if bounded is not None:
        return failure_result(message=bounded, error_code=CMP_TOOL_CAP_EXCEEDED)

    max_bytes = current_max_edit_file_bytes()
    if kind == "create":
        if len(new_string.encode("utf-8", "surrogatepass")) > max_bytes:
            return failure_result(message=TOO_LARGE_TEXT, error_code=CMP_TOOL_CAP_EXCEEDED)
        texts: tuple[str, str] | ToolHandlerResult = ("", new_string)
    else:
        texts = _replace_texts(resolved, relative_path, old_string, new_string, max_bytes)
    if isinstance(texts, ToolHandlerResult):
        return texts
    old_text, new_text = texts
    overlap = overlap_refusal(
        live,
        kind=kind,
        relative_path=relative_path,
        revises=revises,
        content=old_text,
        old_string=old_string,
    )
    if overlap is not None:
        return failure_result(message=overlap, error_code=CMP_TOOL_EXECUTION_FAILED)
    record = build_suggestion_record(
        relative_path=relative_path,
        kind=kind,
        old_string=old_string,
        new_string=new_string,
        texts=plain_words(arguments),
        revises=revises,
        old_text=old_text,
        new_text=new_text,
        group=group,
        depends_on=depends_on,
        facts=derive_import_facts(
            relative_path=relative_path, kind=kind, old_string=old_string,
            new_string=new_string, workspace=workspace, live=live.live,
        ),
    )
    return ToolHandlerResult(
        output=RECORDED_TEXT, success=True, metadata={"suggested_change": record}
    )
