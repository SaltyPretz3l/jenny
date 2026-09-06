"""Shared OOXML helpers for read-only rich-file inspection."""

from __future__ import annotations

import importlib
import re
import zipfile
from pathlib import Path
from typing import Any, Iterable

from sidecar.ai.error_codes import CMP_TOOL_RICH_FILES_UNSUPPORTED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.sanitization import (
    sanitize_tool_output,
    sanitize_tool_output_no_truncate,
)

MAX_OOXML_ZIP_ENTRIES = 4096
MAX_OOXML_UNCOMPRESSED_BYTES = 80 * 1024 * 1024
MAX_OOXML_XML_PART_BYTES = 8 * 1024 * 1024
MAX_TEXT_EXCERPT_CHARS = 400
RELATIONSHIP_LOCAL_NAME = "Relationship"


def load_defused_element_tree() -> Any:
    return importlib.import_module("defusedxml.ElementTree")


def preflight_ooxml_zip(path: Path) -> None:
    try:
        with zipfile.ZipFile(path) as archive:
            preflight_ooxml_archive(archive)
    except zipfile.BadZipFile as error:
        raise ValueError("invalid OOXML zip") from error


def preflight_ooxml_archive(archive: zipfile.ZipFile) -> list[str]:
    entries = archive.infolist()
    if len(entries) > MAX_OOXML_ZIP_ENTRIES:
        raise ValueError("too many OOXML zip entries")
    total_uncompressed = 0
    part_names: list[str] = []
    for entry in entries:
        total_uncompressed += int(entry.file_size)
        if total_uncompressed > MAX_OOXML_UNCOMPRESSED_BYTES:
            raise ValueError("OOXML zip uncompressed size exceeds limit")
        part_names.append(entry.filename)
    return part_names


def read_xml_root(archive: zipfile.ZipFile, part_name: str, element_tree: Any) -> Any | None:
    try:
        info = archive.getinfo(part_name)
    except KeyError:
        return None
    if int(info.file_size) > MAX_OOXML_XML_PART_BYTES:
        raise ValueError(f"OOXML XML part exceeds limit: {part_name}")
    return element_tree.fromstring(archive.read(part_name))


def iter_local(root: Any, local_name: str) -> Iterable[Any]:
    for node in root.iter():
        if local_name_of(node.tag) == local_name:
            yield node


def local_name_of(tag: object) -> str:
    text = str(tag or "")
    return text.rsplit("}", 1)[-1] if "}" in text else text


def local_attribute(node: Any, local_name: str) -> object | None:
    for name, value in node.attrib.items():
        if local_name_of(name) == local_name:
            return value
    return None


def ooxml_boolean(value: object, *, default: bool) -> bool:
    if value is None:
        return default
    normalized = str(value).strip().lower()
    if normalized in {"0", "false", "off", "no"}:
        return False
    if normalized in {"1", "true", "on", "yes"}:
        return True
    return default


def collapse_whitespace(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def bounded_excerpt(
    value: object,
    *,
    tool_name: str,
    max_chars: int = MAX_TEXT_EXCERPT_CHARS,
) -> tuple[str, bool]:
    collapsed = collapse_whitespace(value)
    sanitized = sanitize_tool_output_no_truncate(collapsed, tool_name=tool_name)
    truncated = len(sanitized) > max_chars
    excerpt = (
        sanitize_tool_output(sanitized, max_chars=max_chars, tool_name=tool_name)
        if truncated
        else sanitized
    )
    return excerpt, truncated


def relationship_counts(
    archive: zipfile.ZipFile,
    element_tree: Any,
    *,
    part_prefixes: tuple[str, ...],
    part_names: Iterable[str] | None = None,
) -> dict[str, int]:
    external = 0
    embedded_objects = 0
    embedded_media = 0
    names = part_names if part_names is not None else archive.namelist()
    for part_name in names:
        if not part_name.endswith(".rels") or not part_name.startswith(part_prefixes):
            continue
        root = read_xml_root(archive, part_name, element_tree)
        if root is None:
            continue
        for relationship in iter_local(root, RELATIONSHIP_LOCAL_NAME):
            rel_type = str(relationship.attrib.get("Type") or "").lower()
            target_mode = str(relationship.attrib.get("TargetMode") or "").lower()
            if target_mode == "external":
                external += 1
            if "oleobject" in rel_type or rel_type.endswith("/package"):
                embedded_objects += 1
            if any(token in rel_type for token in ("/image", "/audio", "/video", "/media")):
                embedded_media += 1
    return {
        "external_link_count": external,
        "embedded_object_count": embedded_objects,
        "embedded_media_count": embedded_media,
    }


def has_part(
    archive: zipfile.ZipFile,
    part_name: str,
    *,
    lower_names: set[str] | None = None,
) -> bool:
    names = lower_names if lower_names is not None else {
        name.lower() for name in archive.namelist()
    }
    return part_name.lower() in names


def sorted_numbered_parts(
    archive: zipfile.ZipFile,
    *,
    prefix: str,
    suffix: str,
    part_names: Iterable[str] | None = None,
) -> list[str]:
    names = part_names if part_names is not None else archive.namelist()
    candidates = [
        name
        for name in names
        if name.startswith(prefix) and name.endswith(suffix) and "/_rels/" not in name
    ]
    return sorted(candidates, key=_numbered_part_key)


def integer_cap(
    arguments: dict[str, object],
    key: str,
    *,
    default: int,
    maximum: int,
    tool_name: str,
) -> int:
    value = arguments.get(key)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > maximum:
        raise ToolExecutionFailure(
            code=CMP_TOOL_RICH_FILES_UNSUPPORTED,
            message=f"{tool_name} argument '{key}' must be an integer from 1 to {maximum}",
            retryable=False,
        )
    return value


def _numbered_part_key(part_name: str) -> tuple[str, int, str]:
    stem = Path(part_name).stem
    match = re.search(r"(\d+)$", stem)
    number = int(match.group(1)) if match else 0
    return (str(Path(part_name).parent), number, part_name)
