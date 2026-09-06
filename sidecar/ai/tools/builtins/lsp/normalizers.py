"""Normalize raw LSP responses into bounded model-facing payloads."""

from __future__ import annotations

from collections.abc import Iterable

from sidecar.ai.tools.builtins.lsp.limits import (
    DEFAULT_MAX_DEFINITIONS,
    DEFAULT_MAX_DIAGNOSTICS,
    DEFAULT_MAX_REFERENCES,
    DEFAULT_MAX_SYMBOLS,
    MAX_LSP_ITEMS,
    MAX_LSP_MESSAGE_CHARS,
    MAX_LSP_NAME_CHARS,
)
from sidecar.ai.tools.builtins.lsp.paths import workspace_relative_file_uri
from sidecar.ai.tools.workspace import WorkspaceGuard

TRUNCATED_SUFFIX = "...[truncated]"

_DIAGNOSTIC_SEVERITIES = {
    1: "error",
    2: "warning",
    3: "information",
    4: "hint",
}

_SYMBOL_KINDS = {
    1: "file",
    2: "module",
    3: "namespace",
    4: "package",
    5: "class",
    6: "method",
    7: "property",
    8: "field",
    9: "constructor",
    10: "enum",
    11: "interface",
    12: "function",
    13: "variable",
    14: "constant",
    15: "string",
    16: "number",
    17: "boolean",
    18: "array",
    19: "object",
    20: "key",
    21: "null",
    22: "enum_member",
    23: "struct",
    24: "event",
    25: "operator",
    26: "type_parameter",
}


def normalize_diagnostics(
    raw_result: object,
    *,
    file_path: str,
    max_diagnostics: int = DEFAULT_MAX_DIAGNOSTICS,
) -> dict[str, object]:
    """Return a deterministic, capped diagnostic payload."""

    max_items = _bounded_limit(max_diagnostics, default=DEFAULT_MAX_DIAGNOSTICS)
    diagnostics: list[dict[str, object]] = []
    total_count = 0
    for item in _diagnostic_items(raw_result):
        diagnostic = _normalize_diagnostic(item)
        if diagnostic is None:
            continue
        total_count += 1
        if len(diagnostics) < max_items:
            diagnostics.append(diagnostic)
    return {
        "file": file_path,
        "diagnostics": diagnostics,
        "total_count": total_count,
        "truncated": total_count > max_items,
    }


def normalize_symbols(
    raw_result: object,
    *,
    file_path: str,
    max_symbols: int = DEFAULT_MAX_SYMBOLS,
) -> dict[str, object]:
    """Flatten LSP DocumentSymbol/SymbolInformation responses."""

    max_items = _bounded_limit(max_symbols, default=DEFAULT_MAX_SYMBOLS)
    symbols, total_count = _flatten_symbols(
        _symbol_items(raw_result),
        file_path=file_path,
        max_items=max_items,
    )
    return {
        "file": file_path,
        "symbols": symbols,
        "total_count": total_count,
        "truncated": total_count > max_items,
    }


def normalize_definitions(
    raw_result: object,
    *,
    workspace: WorkspaceGuard,
    max_locations: int = DEFAULT_MAX_DEFINITIONS,
) -> dict[str, object]:
    max_items = _bounded_limit(max_locations, default=DEFAULT_MAX_DEFINITIONS)
    (
        locations,
        total_count,
        omitted_external_count,
        malformed_count,
    ) = _normalize_workspace_locations(
        raw_result,
        workspace=workspace,
        max_items=max_items,
    )
    return {
        "definitions": locations,
        "total_count": total_count,
        "omitted_external_count": omitted_external_count,
        "malformed_count": malformed_count,
        "truncated": total_count > max_items,
    }


def normalize_references(
    raw_result: object,
    *,
    workspace: WorkspaceGuard,
    max_references: int = DEFAULT_MAX_REFERENCES,
) -> dict[str, object]:
    max_items = _bounded_limit(max_references, default=DEFAULT_MAX_REFERENCES)
    (
        locations,
        total_count,
        omitted_external_count,
        malformed_count,
    ) = _normalize_workspace_locations(
        raw_result,
        workspace=workspace,
        max_items=max_items,
    )
    return {
        "references_by_file": _group_references_by_file(locations),
        "total_count": total_count,
        "omitted_external_count": omitted_external_count,
        "malformed_count": malformed_count,
        "truncated": total_count > max_items,
    }


def _diagnostic_items(raw_result: object) -> Iterable[object]:
    if isinstance(raw_result, list):
        return raw_result
    if isinstance(raw_result, dict):
        items = raw_result.get("items")
        if isinstance(items, list):
            return items
        diagnostics = raw_result.get("diagnostics")
        if isinstance(diagnostics, list):
            return diagnostics
    return ()


def _location_items(raw_result: object) -> Iterable[object]:
    if raw_result is None:
        return ()
    if isinstance(raw_result, list):
        return raw_result
    if isinstance(raw_result, dict):
        return (raw_result,)
    return ()


def _symbol_items(raw_result: object) -> Iterable[object]:
    if isinstance(raw_result, list):
        return raw_result
    if isinstance(raw_result, dict):
        symbols = raw_result.get("symbols")
        if isinstance(symbols, list):
            return symbols
    return ()


def _normalize_workspace_locations(
    raw_result: object,
    *,
    workspace: WorkspaceGuard,
    max_items: int,
) -> tuple[list[dict[str, object]], int, int, int]:
    normalized: list[dict[str, object]] = []
    total_count = 0
    omitted_external_count = 0
    malformed_count = 0
    for item in _location_items(raw_result):
        if not isinstance(item, dict):
            malformed_count += 1
            continue
        location, disposition = _normalize_workspace_location(item, workspace=workspace)
        if location is not None:
            total_count += 1
            if len(normalized) < max_items:
                normalized.append(location)
        elif disposition == "external":
            omitted_external_count += 1
        else:
            malformed_count += 1
    return normalized, total_count, omitted_external_count, malformed_count


def _normalize_workspace_location(
    item: dict[str, object],
    *,
    workspace: WorkspaceGuard,
) -> tuple[dict[str, object] | None, str]:
    uri = _non_empty_string(item.get("targetUri")) or _non_empty_string(item.get("uri"))
    if uri is None:
        return None, "malformed"
    file_path = workspace_relative_file_uri(uri, workspace)
    if file_path is None:
        return None, "external"
    range_payload = _normalize_range(item.get("targetRange") or item.get("range"))
    if range_payload is None:
        return None, "malformed"
    normalized: dict[str, object] = {
        "file": file_path,
        "range": range_payload,
    }
    selection_range = _normalize_range(item.get("targetSelectionRange"))
    if selection_range is not None:
        normalized["selection_range"] = selection_range
    return normalized, "ok"


def _group_references_by_file(locations: list[dict[str, object]]) -> list[dict[str, object]]:
    groups: list[dict[str, object]] = []
    index_by_file: dict[str, dict[str, object]] = {}
    for location in locations:
        file_path = str(location.get("file") or "")
        if not file_path:
            continue
        group = index_by_file.get(file_path)
        if group is None:
            group = {"file": file_path, "references": []}
            index_by_file[file_path] = group
            groups.append(group)
        reference: dict[str, object] = {"range": location["range"]}
        selection_range = location.get("selection_range")
        if selection_range is not None:
            reference["selection_range"] = selection_range
        references = group["references"]
        if isinstance(references, list):
            references.append(reference)
    return groups


def _normalize_diagnostic(item: object) -> dict[str, object] | None:
    if not isinstance(item, dict):
        return None
    normalized: dict[str, object] = {
        "severity": _DIAGNOSTIC_SEVERITIES.get(_as_int(item.get("severity")), "unknown"),
        "message": _bounded_text(item.get("message"), max_chars=MAX_LSP_MESSAGE_CHARS),
    }
    source = _non_empty_string(item.get("source"))
    if source is not None:
        normalized["source"] = source
    code = item.get("code")
    if isinstance(code, (str, int)):
        normalized["code"] = str(code)
    range_payload = _normalize_range(item.get("range"))
    if range_payload is not None:
        normalized["range"] = range_payload
    return normalized


def _flatten_symbols(
    items: Iterable[object],
    *,
    file_path: str,
    max_items: int,
) -> tuple[list[dict[str, object]], int]:
    flattened: list[dict[str, object]] = []
    total_count = 0
    stack = [(item, "") for item in reversed(list(items))]
    while stack:
        item, container_name = stack.pop()
        if not isinstance(item, dict):
            continue
        symbol = _normalize_symbol(item, file_path=file_path, container_name=container_name)
        if symbol is not None:
            total_count += 1
            if len(flattened) < max_items:
                flattened.append(symbol)
        child_container = str(symbol.get("name", "")) if symbol is not None else container_name
        children = item.get("children")
        if isinstance(children, list):
            for child in reversed(children):
                stack.append((child, child_container))
    return flattened, total_count


def _normalize_symbol(
    item: dict[str, object],
    *,
    file_path: str,
    container_name: str,
) -> dict[str, object] | None:
    name = _non_empty_string(item.get("name"))
    if name is None:
        return None
    normalized: dict[str, object] = {
        "name": _bounded_text(name, max_chars=MAX_LSP_NAME_CHARS),
        "kind": _SYMBOL_KINDS.get(_as_int(item.get("kind")), "unknown"),
        "container_name": _bounded_text(
            _symbol_container_name(item, container_name),
            max_chars=MAX_LSP_NAME_CHARS,
        ),
        "file": file_path,
    }
    range_payload = _normalize_range(item.get("range"))
    if range_payload is None:
        location = item.get("location")
        if isinstance(location, dict):
            range_payload = _normalize_range(location.get("range"))
    if range_payload is not None:
        normalized["range"] = range_payload
    selection_range = _normalize_range(item.get("selectionRange"))
    if selection_range is not None:
        normalized["selection_range"] = selection_range
    return normalized


def _symbol_container_name(item: dict[str, object], fallback: str) -> str:
    value = item.get("containerName")
    if isinstance(value, str):
        return value.strip()
    return fallback


def _normalize_range(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    start = _normalize_position(value.get("start"))
    end = _normalize_position(value.get("end"))
    if start is None or end is None:
        return None
    return {"start": start, "end": end}


def _normalize_position(value: object) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    line = _as_int(value.get("line"))
    character = _as_int(value.get("character"))
    if line < 0 or character < 0:
        return None
    return {"line": line, "character": character}


def _as_int(value: object) -> int:
    if isinstance(value, bool):
        return -1
    if isinstance(value, int):
        return value
    return -1


def _bounded_limit(value: object, *, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    if value < 1:
        return default
    return min(value, MAX_LSP_ITEMS)


def _non_empty_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    token = value.strip()
    return token if token else None


def _bounded_text(value: object, *, max_chars: int) -> str:
    text = str(value or "")
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars]}{TRUNCATED_SUFFIX}"
