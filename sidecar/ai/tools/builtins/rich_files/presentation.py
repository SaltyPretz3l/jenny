"""Read-only OOXML presentation inspect tool."""

from __future__ import annotations

import posixpath
import zipfile
from typing import Any

from sidecar.ai.tools.builtins import filesystem_content
from sidecar.ai.tools.builtins.rich_files.base import (
    RichFileSource,
    RichInspectResult,
    build_dependency_missing_result,
    build_unsupported_result,
    rich_inspect_result_to_tool_result,
    string_argument,
    validate_rich_file_source,
)
from sidecar.ai.tools.builtins.rich_files.ooxml import (
    bounded_excerpt,
    collapse_whitespace,
    has_part,
    integer_cap,
    iter_local,
    load_defused_element_tree,
    local_attribute,
    local_name_of,
    ooxml_boolean,
    preflight_ooxml_archive,
    read_xml_root,
    relationship_counts,
    sorted_numbered_parts,
)
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

SUPPORTED_PRESENTATION_EXTENSIONS = frozenset({".pptx", ".pptm", ".potx", ".potm"})
MACRO_ENABLED_EXTENSIONS = frozenset({".pptm", ".potm"})
DEFAULT_MAX_SLIDES = 20
MAX_SLIDES = 50
TEXT_LOCAL_NAMES = {"t"}


def presentation_inspect_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    requested_path = string_argument(arguments, "path", required=True)
    source = validate_rich_file_source(
        requested_path=requested_path,
        workspace=workspace,
        adapter="presentation",
        max_bytes=filesystem_content.MAX_MEDIA_FILE_BYTES,
    )
    if source.absolute_path.suffix.lower() not in SUPPORTED_PRESENTATION_EXTENSIONS:
        return rich_inspect_result_to_tool_result(
            build_unsupported_result(
                adapter="presentation",
                source=source,
                reason="presentation_format_unsupported",
            )
        )

    caps = _inspect_caps(arguments)
    try:
        element_tree = load_defused_element_tree()
    except ModuleNotFoundError:
        return rich_inspect_result_to_tool_result(
            build_dependency_missing_result(
                adapter="presentation",
                source=source,
                dependency="defusedxml",
                install_hint="Install the optional office extra to enable presentation inspection.",
            )
        )

    try:
        result = _inspect_presentation(source=source, caps=caps, element_tree=element_tree)
    except Exception:  # noqa: BLE001
        return rich_inspect_result_to_tool_result(
            build_unsupported_result(
                adapter="presentation",
                source=source,
                reason="presentation_parse_failed",
            )
        )
    return rich_inspect_result_to_tool_result(result)


def _inspect_presentation(
    *,
    source: RichFileSource,
    caps: dict[str, int],
    element_tree: Any,
) -> RichInspectResult:
    with zipfile.ZipFile(source.absolute_path) as archive:
        part_names = preflight_ooxml_archive(archive)
        lower_part_names = {name.lower() for name in part_names}
        fallback_slide_parts = sorted_numbered_parts(
            archive,
            prefix="ppt/slides/slide",
            suffix=".xml",
            part_names=part_names,
        )
        slide_parts = _ordered_slide_parts(
            archive,
            element_tree=element_tree,
            part_names=part_names,
            fallback=fallback_slide_parts,
        )
        if not slide_parts:
            raise ValueError("no slide parts")
        sampled, hidden_count, visible_count = _sample_slides(
            archive,
            slide_parts=slide_parts,
            element_tree=element_tree,
            max_slides=caps["max_slides"],
        )
        note_parts = sorted_numbered_parts(
            archive,
            prefix="ppt/notesSlides/notesSlide",
            suffix=".xml",
            part_names=part_names,
        )
        comment_count = _presentation_comment_count(
            archive,
            element_tree,
            part_names=part_names,
        )
        rel_counts = relationship_counts(
            archive,
            element_tree,
            part_prefixes=("ppt/",),
            part_names=part_names,
        )
        summary = {
            "slide_count": len(slide_parts),
            "visible_slide_count": visible_count,
            "hidden_slide_count": hidden_count,
            "speaker_notes_present": bool(note_parts),
            "speaker_notes_count": len(note_parts),
            "comments_present": comment_count > 0,
            "comment_count": comment_count,
            "macro_enabled": _macro_enabled(
                source,
                archive,
                lower_part_names=lower_part_names,
            ),
            "external_link_count": rel_counts["external_link_count"],
            "embedded_media_count": rel_counts["embedded_media_count"],
            "omitted_slide_count": max(0, visible_count - len(sampled)),
            "sample_caps": caps,
            "slides": sampled,
        }
    return RichInspectResult(
        status="inspected",
        adapter="presentation",
        source=source,
        summary=summary,
    )


def _sample_slides(
    archive: zipfile.ZipFile,
    *,
    slide_parts: list[str],
    element_tree: Any,
    max_slides: int,
) -> tuple[list[dict[str, object]], int, int]:
    sampled: list[dict[str, object]] = []
    hidden_count = 0
    visible_count = 0
    for slide_number, part_name in enumerate(slide_parts, start=1):
        root = read_xml_root(archive, part_name, element_tree)
        if root is None:
            continue
        hidden, text = _slide_text(root)
        if hidden:
            hidden_count += 1
            continue
        visible_count += 1
        if len(sampled) >= max_slides:
            continue
        excerpt, truncated = bounded_excerpt(text, tool_name="presentation_inspect")
        sampled.append(
            {
                "slide": slide_number,
                "text_excerpt": excerpt,
                "text_truncated": truncated,
            }
        )
    return sampled, hidden_count, visible_count


def _slide_text(root: Any) -> tuple[bool, str]:
    text_parts: list[str] = []
    hidden = False
    for node in root.iter():
        local_name = local_name_of(node.tag)
        if local_name in {"sld", "cSld"} and not ooxml_boolean(
            local_attribute(node, "show"),
            default=True,
        ):
            hidden = True
        if local_name in TEXT_LOCAL_NAMES and node.text:
            text_parts.append(str(node.text))
    return hidden, collapse_whitespace(" ".join(text_parts))


def _ordered_slide_parts(
    archive: zipfile.ZipFile,
    *,
    element_tree: Any,
    part_names: list[str],
    fallback: list[str],
) -> list[str]:
    presentation_root = read_xml_root(
        archive,
        "ppt/presentation.xml",
        element_tree,
    )
    relationships_root = read_xml_root(
        archive,
        "ppt/_rels/presentation.xml.rels",
        element_tree,
    )
    if presentation_root is None or relationships_root is None:
        return fallback

    available_parts = set(part_names)
    slide_targets: dict[str, str] = {}
    for relationship in iter_local(relationships_root, "Relationship"):
        relationship_type = str(local_attribute(relationship, "Type") or "").lower()
        if not relationship_type.endswith("/slide"):
            continue
        relationship_id = str(local_attribute(relationship, "Id") or "")
        target = str(local_attribute(relationship, "Target") or "").replace("\\", "/")
        if not relationship_id or not target:
            continue
        if target.startswith("/"):
            part_name = posixpath.normpath(target.lstrip("/"))
        else:
            part_name = posixpath.normpath(posixpath.join("ppt", target))
        if part_name in available_parts:
            slide_targets[relationship_id] = part_name

    ordered: list[str] = []
    seen: set[str] = set()
    for slide_id in iter_local(presentation_root, "sldId"):
        relationship_id = _slide_relationship_id(slide_id)
        slide_part_name = slide_targets.get(relationship_id)
        if slide_part_name is not None and slide_part_name not in seen:
            ordered.append(slide_part_name)
            seen.add(slide_part_name)
    return ordered


def _slide_relationship_id(slide_id: Any) -> str:
    for name, value in slide_id.attrib.items():
        qualified_name = str(name)
        if local_name_of(qualified_name) == "id" and "relationships" in qualified_name:
            return str(value)
    return ""


def _presentation_comment_count(
    archive: zipfile.ZipFile,
    element_tree: Any,
    *,
    part_names: list[str],
) -> int:
    total = 0
    for part_name in sorted_numbered_parts(
        archive,
        prefix="ppt/comments/comment",
        suffix=".xml",
        part_names=part_names,
    ):
        root = read_xml_root(archive, part_name, element_tree)
        if root is None:
            continue
        total += sum(1 for _ in iter_local(root, "cm"))
    return total


def _macro_enabled(
    source: RichFileSource,
    archive: zipfile.ZipFile,
    *,
    lower_part_names: set[str],
) -> bool:
    return source.absolute_path.suffix.lower() in MACRO_ENABLED_EXTENSIONS or has_part(
        archive,
        "ppt/vbaProject.bin",
        lower_names=lower_part_names,
    )


def _inspect_caps(arguments: dict[str, object]) -> dict[str, int]:
    return {
        "max_slides": integer_cap(
            arguments,
            "max_slides",
            default=DEFAULT_MAX_SLIDES,
            maximum=MAX_SLIDES,
            tool_name="presentation inspect",
        )
    }
