"""Read-only OOXML document inspect tool."""

from __future__ import annotations

import io
import re
import zipfile
from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.builtins import filesystem_content
from sidecar.ai.tools.builtins.rich_files.base import (
    RichFileSource,
    RichInspectResult,
    build_dependency_missing_result,
    build_unsupported_result,
    rich_inspect_result_to_tool_result,
    source_bytes,
    string_argument,
    validate_rich_file_source,
)
from sidecar.ai.tools.builtins.rich_files.ooxml import (
    bounded_excerpt,
    collapse_whitespace,
    integer_cap,
    iter_local,
    load_defused_element_tree,
    local_attribute,
    local_name_of,
    macro_enabled,
    ooxml_boolean,
    preflight_ooxml_archive,
    read_xml_root,
    relationship_counts,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

SUPPORTED_DOCUMENT_EXTENSIONS = frozenset({".docx", ".docm", ".dotx", ".dotm"})
DEFAULT_MAX_PARAGRAPHS = 40
MAX_PARAGRAPHS = 100
# One read returns whole paragraphs up to this many characters (the first one
# always fits, clipped at PARAGRAPH_EXCERPT_CHARS), leaving room for the JSON
# envelope under MAX_RICH_INSPECT_OUTPUT_CHARS. The rest is reached through
# ``continue_cursor`` (docx:<digest>:<paragraph index>), bound to the file bytes.
PARAGRAPH_EXCERPT_CHARS = 1_500
SLICE_EXCERPT_CHARS = 7_000
_CURSOR = re.compile(r"docx:([0-9a-f]{16}):([1-9][0-9]{0,8})")
TEXT_LOCAL_NAMES = {"t"}
TRACKED_CHANGE_TAGS = {
    "del",
    "ins",
    "moveFrom",
    "moveFromRangeEnd",
    "moveFromRangeStart",
    "moveTo",
    "moveToRangeEnd",
    "moveToRangeStart",
}
EXCLUDED_REVISION_TEXT_TAGS = {"del", "moveFrom"}


def document_inspect_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    requested_path = string_argument(arguments, "path", required=True)
    source = validate_rich_file_source(
        requested_path=requested_path,
        workspace=workspace,
        adapter="document",
        max_bytes=filesystem_content.MAX_MEDIA_FILE_BYTES,
        supported_suffixes=SUPPORTED_DOCUMENT_EXTENSIONS,
    )
    if source.absolute_path.suffix.lower() not in SUPPORTED_DOCUMENT_EXTENSIONS:
        return rich_inspect_result_to_tool_result(
            build_unsupported_result(
                adapter="document",
                source=source,
                reason="document_format_unsupported",
            )
        )

    # read_file's dispatcher forwards only path/pages/cursor: caps stay at their defaults.
    caps = _inspect_caps(arguments)
    start_index = _cursor_start(arguments.get("cursor"), digest=_digest(source))
    try:
        element_tree = load_defused_element_tree()
    except ModuleNotFoundError:
        return rich_inspect_result_to_tool_result(
            build_dependency_missing_result(
                adapter="document",
                source=source,
                dependency="defusedxml",
                install_hint="Install the optional office extra to enable document inspection.",
            )
        )

    raw_document = source_bytes(
        source,
        workspace=workspace,
        max_bytes=filesystem_content.MAX_MEDIA_FILE_BYTES,
        message="document source changed beyond rich-file size limit",
    )
    try:
        result = _inspect_document(
            source=source,
            raw_document=raw_document,
            caps=caps,
            element_tree=element_tree,
            start_index=start_index,
        )
    except Exception:  # noqa: BLE001
        return rich_inspect_result_to_tool_result(
            build_unsupported_result(
                adapter="document",
                source=source,
                reason="document_parse_failed",
            )
        )
    return rich_inspect_result_to_tool_result(result)


def _inspect_document(
    *,
    source: RichFileSource,
    raw_document: bytes,
    caps: dict[str, int],
    element_tree: Any,
    start_index: int = 1,
) -> RichInspectResult:
    with zipfile.ZipFile(io.BytesIO(raw_document)) as archive:
        part_names = preflight_ooxml_archive(archive)
        root = read_xml_root(archive, "word/document.xml", element_tree)
        if root is None:
            raise ValueError("document.xml missing")
        lower_part_names = {name.lower() for name in part_names}
        comments_root = read_xml_root(archive, "word/comments.xml", element_tree)
        styles_root = read_xml_root(archive, "word/styles.xml", element_tree)
        hidden_style_ids = _hidden_style_ids(styles_root)
        rel_counts = relationship_counts(
            archive,
            element_tree,
            part_prefixes=("word/",),
            part_names=part_names,
        )
        sample = _sample_document_paragraphs(
            root,
            max_paragraphs=caps["max_paragraphs"],
            hidden_style_ids=hidden_style_ids,
            start_index=start_index,
        )
        sampled, visible_count, paragraph_count, hidden_text_present, next_index = sample
        table_count, tracked_changes_present = _document_flags(root)
        summary = {
            "paragraph_count": paragraph_count,
            "table_count": table_count,
            "comment_count": _comment_count(comments_root),
            "tracked_changes_present": tracked_changes_present,
            "hidden_text_present": hidden_text_present,
            "macro_enabled": macro_enabled(
                source.absolute_path,
                archive,
                vba_part="word/vbaProject.bin",
                lower_names=lower_part_names,
            ),
            "external_link_count": rel_counts["external_link_count"],
            "embedded_object_count": rel_counts["embedded_object_count"],
            "omitted_paragraph_count": max(0, visible_count - len(sampled)),
            "sample_caps": caps,
            "paragraphs": sampled,
            **_continuation_fields(source, sampled, next_index),
        }
    return RichInspectResult(
        status="inspected",
        adapter="document",
        source=source,
        summary=summary,
    )


def _digest(source: RichFileSource) -> str:
    return source.sha256[:16]


def _cursor_start(value: object | None, *, digest: str) -> int:
    """The paragraph index a ``continue_cursor`` resumes at (1 without one)."""
    if value is None:
        return 1
    match = _CURSOR.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message=(
                "tool argument 'cursor' is invalid for a Word document; expected the "
                "docx:<digest>:<paragraph> continue_cursor from a previous read"
            ),
            retryable=False,
        )
    if match.group(1) != digest:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message=(
                "cursor is stale: the document changed since it was read; "
                "read it again without 'cursor'"
            ),
            retryable=False,
        )
    return int(match.group(2))


def _continuation_fields(
    source: RichFileSource,
    sampled: list[dict[str, object]],
    next_index: int | None,
) -> dict[str, object]:
    if next_index is None:
        return {}
    cursor = f"docx:{_digest(source)}:{next_index}"
    shown = (
        f"paragraphs {sampled[0]['index']}-{sampled[-1]['index']}" if sampled else "no paragraphs"
    )
    return {
        "continue_cursor": cursor,
        "continuation_hint": (
            # knowledge_view rewrites "call read_file again" to its own tool name.
            f"This read shows {shown}; more of the document follows. To continue, "
            f"call read_file again with the same path and cursor={cursor}."
        ),
    }


def _sample_document_paragraphs(
    root: Any,
    *,
    max_paragraphs: int,
    hidden_style_ids: set[str],
    start_index: int = 1,
) -> tuple[list[dict[str, object]], int, int, bool, int | None]:
    """Whole visible paragraphs from ``start_index`` within the slice budget.

    Also returns the index of the first visible paragraph left for the next
    read, or None when the slice reached the end of the document.
    """
    sampled: list[dict[str, object]] = []
    visible_count = 0
    paragraph_count = 0
    hidden_text_present = False
    next_index: int | None = None
    used_chars = 0
    for index, paragraph in enumerate(iter_local(root, "p"), start=1):
        paragraph_count += 1
        text, paragraph_has_hidden_text = _paragraph_text(
            paragraph,
            hidden_style_ids=hidden_style_ids,
        )
        hidden_text_present = hidden_text_present or paragraph_has_hidden_text
        if not text:
            continue
        visible_count += 1
        if index < start_index or next_index is not None:
            continue
        if len(sampled) >= max_paragraphs:
            next_index = index
            continue
        excerpt, truncated = bounded_excerpt(
            text, tool_name="document_inspect", max_chars=PARAGRAPH_EXCERPT_CHARS
        )
        if sampled and used_chars + len(excerpt) > SLICE_EXCERPT_CHARS:
            next_index = index
            continue
        used_chars += len(excerpt)
        sampled.append(
            {
                "index": index,
                "text_excerpt": excerpt,
                "text_truncated": truncated,
            }
        )
    return sampled, visible_count, paragraph_count, hidden_text_present, next_index


def _paragraph_text(
    paragraph: Any,
    *,
    hidden_style_ids: set[str],
) -> tuple[str, bool]:
    paragraph_properties = _direct_child(paragraph, "pPr")
    paragraph_hidden = _properties_hidden_override(
        paragraph_properties,
        style_local_name="pStyle",
        hidden_style_ids=hidden_style_ids,
    ) is True
    hidden_text_present = False
    text_parts: list[str] = []
    stack: list[tuple[Any, bool, bool]] = [
        (child, paragraph_hidden, False)
        for child in reversed(list(paragraph))
        if local_name_of(child.tag) != "pPr"
    ]
    while stack:
        node, inherited_hidden, excluded_revision = stack.pop()
        local_name = local_name_of(node.tag)
        if local_name == "p":
            continue
        excluded_revision = excluded_revision or local_name in EXCLUDED_REVISION_TEXT_TAGS
        node_hidden = inherited_hidden
        if local_name == "r":
            run_hidden = _properties_hidden_override(
                _direct_child(node, "rPr"),
                style_local_name="rStyle",
                hidden_style_ids=hidden_style_ids,
            )
            if run_hidden is not None:
                node_hidden = run_hidden
        if local_name in TEXT_LOCAL_NAMES and node.text:
            if node_hidden:
                hidden_text_present = True
            elif not excluded_revision:
                text_parts.append(str(node.text))
        stack.extend((child, node_hidden, excluded_revision) for child in reversed(list(node)))
    return collapse_whitespace(" ".join(text_parts)), hidden_text_present


def _properties_hidden_override(
    properties: Any | None,
    *,
    style_local_name: str,
    hidden_style_ids: set[str],
) -> bool | None:
    if properties is None:
        return None
    vanish_value: bool | None = None
    style_id = ""
    for node in properties.iter():
        local_name = local_name_of(node.tag)
        if local_name == "vanish":
            vanish_value = ooxml_boolean(local_attribute(node, "val"), default=True)
        elif local_name == style_local_name:
            style_id = str(local_attribute(node, "val") or "")
    if vanish_value is not None:
        return vanish_value
    return True if style_id in hidden_style_ids else None


def _hidden_style_ids(styles_root: Any | None) -> set[str]:
    if styles_root is None:
        return set()
    definitions: dict[str, tuple[str, bool | None]] = {}
    for style in iter_local(styles_root, "style"):
        style_id = str(local_attribute(style, "styleId") or "")
        if not style_id:
            continue
        based_on = ""
        vanish_value: bool | None = None
        for node in style.iter():
            local_name = local_name_of(node.tag)
            if local_name == "basedOn":
                based_on = str(local_attribute(node, "val") or "")
            elif local_name == "vanish":
                vanish_value = ooxml_boolean(local_attribute(node, "val"), default=True)
        definitions[style_id] = (based_on, vanish_value)

    resolved: dict[str, bool] = {}

    def _style_is_hidden(style_id: str, resolving: set[str]) -> bool:
        if style_id in resolved:
            return resolved[style_id]
        if style_id in resolving:
            return False
        based_on, vanish_value = definitions.get(style_id, ("", None))
        hidden = (
            vanish_value
            if vanish_value is not None
            else bool(based_on and _style_is_hidden(based_on, resolving | {style_id}))
        )
        resolved[style_id] = hidden
        return hidden

    return {style_id for style_id in definitions if _style_is_hidden(style_id, set())}


def _direct_child(node: Any, local_name: str) -> Any | None:
    for child in node:
        if local_name_of(child.tag) == local_name:
            return child
    return None


def _document_flags(root: Any) -> tuple[int, bool]:
    table_count = 0
    tracked_changes_present = False
    for node in root.iter():
        local_name = local_name_of(node.tag)
        if local_name == "tbl":
            table_count += 1
        elif local_name in TRACKED_CHANGE_TAGS:
            tracked_changes_present = True
    return table_count, tracked_changes_present


def _comment_count(root: Any | None) -> int:
    if root is None:
        return 0
    return sum(1 for _ in iter_local(root, "comment"))


def _inspect_caps(arguments: dict[str, object]) -> dict[str, int]:
    return {
        "max_paragraphs": integer_cap(
            arguments,
            "max_paragraphs",
            default=DEFAULT_MAX_PARAGRAPHS,
            maximum=MAX_PARAGRAPHS,
            tool_name="document inspect",
        )
    }
