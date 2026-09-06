"""Read-only rich spreadsheet inspect tool."""

from __future__ import annotations

import importlib
import zipfile
from datetime import date, datetime, time
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
    MAX_OOXML_XML_PART_BYTES,
    has_part,
    integer_cap,
    local_attribute,
    local_name_of,
    ooxml_boolean,
    preflight_ooxml_zip,
)
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.sanitization import sanitize_tool_output
from sidecar.ai.tools.workspace import WorkspaceGuard

SUPPORTED_SPREADSHEET_EXTENSIONS = frozenset({".xlsx", ".xlsm", ".xltx", ".xltm"})
MACRO_ENABLED_EXTENSIONS = frozenset({".xlsm", ".xltm"})
DEFAULT_MAX_SHEETS = 10
DEFAULT_MAX_ROWS_PER_SHEET = 20
DEFAULT_MAX_COLUMNS_PER_SHEET = 12
MAX_SHEETS = 50
MAX_ROWS_PER_SHEET = 100
MAX_COLUMNS_PER_SHEET = 50
MAX_CELL_STRING_CHARS = 256


def spreadsheet_inspect_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    requested_path = string_argument(arguments, "path", required=True)
    source = validate_rich_file_source(
        requested_path=requested_path,
        workspace=workspace,
        adapter="spreadsheet",
        max_bytes=filesystem_content.MAX_MEDIA_FILE_BYTES,
    )
    if source.absolute_path.suffix.lower() not in SUPPORTED_SPREADSHEET_EXTENSIONS:
        return rich_inspect_result_to_tool_result(
            build_unsupported_result(
                adapter="spreadsheet",
                source=source,
                reason="spreadsheet_format_unsupported",
            )
        )

    try:
        openpyxl = importlib.import_module("openpyxl")
    except ModuleNotFoundError:
        return rich_inspect_result_to_tool_result(
            build_dependency_missing_result(
                adapter="spreadsheet",
                source=source,
                dependency="openpyxl",
                install_hint=(
                    "Install the optional spreadsheet extra to enable spreadsheet inspection."
                ),
            )
        )
    if not getattr(openpyxl, "DEFUSEDXML", False):
        return rich_inspect_result_to_tool_result(
            build_dependency_missing_result(
                adapter="spreadsheet",
                source=source,
                dependency="defusedxml",
                install_hint=(
                    "Install the optional spreadsheet extra to enable XML-hardened "
                    "spreadsheet inspection."
                ),
            )
        )

    caps = _inspect_caps(arguments)
    try:
        preflight_ooxml_zip(source.absolute_path)
        workbook = openpyxl.load_workbook(
            filename=source.absolute_path,
            read_only=True,
            data_only=False,
            keep_links=False,
        )
    except Exception:  # noqa: BLE001
        return rich_inspect_result_to_tool_result(
            build_unsupported_result(
                adapter="spreadsheet",
                source=source,
                reason="spreadsheet_parse_failed",
            )
        )

    try:
        result = _inspect_workbook(source=source, workbook=workbook, caps=caps)
    except Exception:  # noqa: BLE001
        return rich_inspect_result_to_tool_result(
            build_unsupported_result(
                adapter="spreadsheet",
                source=source,
                reason="spreadsheet_parse_failed",
            )
        )
    finally:
        close = getattr(workbook, "close", None)
        if callable(close):
            close()
    return rich_inspect_result_to_tool_result(result)


def _inspect_workbook(
    *,
    source: RichFileSource,
    workbook: Any,
    caps: dict[str, int],
) -> RichInspectResult:
    worksheets = list(getattr(workbook, "worksheets", ()) or ())
    max_sheets = caps["max_sheets"]
    visible_worksheets: list[Any] = []
    hidden_worksheets: list[Any] = []
    for worksheet in worksheets:
        if _sheet_state(worksheet) == "visible":
            visible_worksheets.append(worksheet)
        else:
            hidden_worksheets.append(worksheet)
    selected = (visible_worksheets + hidden_worksheets)[:max_sheets]
    element_tree = importlib.import_module("defusedxml.ElementTree")
    with zipfile.ZipFile(source.absolute_path) as archive:
        sheets_payload = [
            _inspect_sheet(
                archive=archive,
                element_tree=element_tree,
                worksheet=worksheet,
                max_rows=caps["max_rows_per_sheet"],
                max_columns=caps["max_columns_per_sheet"],
            )
            for worksheet in selected
        ]
        macro_enabled = (
            source.absolute_path.suffix.lower() in MACRO_ENABLED_EXTENSIONS
            or has_part(archive, "xl/vbaProject.bin")
        )
    visible_count = len(visible_worksheets)
    hidden_count = len(hidden_worksheets)
    omitted = max(0, len(worksheets) - len(selected))
    warnings = (f"sheet list truncated: omitted {omitted} sheets",) if omitted else ()
    return RichInspectResult(
        status="inspected",
        adapter="spreadsheet",
        source=source,
        summary={
            "sheet_count": len(worksheets),
            "visible_sheet_count": visible_count,
            "hidden_sheet_count": hidden_count,
            "macro_enabled": macro_enabled,
            "omitted_sheet_count": omitted,
            "sample_caps": caps,
            "sheets": sheets_payload,
        },
        warnings=warnings,
    )


def _inspect_sheet(
    *,
    archive: zipfile.ZipFile,
    element_tree: Any,
    worksheet: Any,
    max_rows: int,
    max_columns: int,
) -> dict[str, object]:
    max_row = _positive_int(getattr(worksheet, "max_row", 0))
    max_column = _positive_int(getattr(worksheet, "max_column", 0))
    state = _sheet_state(worksheet)
    has_formulas = False
    formula_count = 0
    payload: dict[str, object] = {
        "name": sanitize_tool_output(
            str(getattr(worksheet, "title", "") or ""),
            max_chars=128,
            tool_name="spreadsheet_inspect",
        ),
        "state": state,
        "max_row": max_row,
        "max_column": max_column,
        "has_formulas": has_formulas,
        "formula_cells_sampled": formula_count,
        "formula_scan_truncated": False,
        "sampled_rows": [],
        "sample_truncated": False,
    }
    if state != "visible":
        payload["sample_skipped"] = "hidden_sheet"
        payload["formula_scan_skipped"] = "hidden_sheet"
        return payload

    hidden_rows, hidden_columns = _hidden_dimensions(
        archive,
        worksheet=worksheet,
        element_tree=element_tree,
        max_rows=max_row,
        max_columns=max_column,
    )
    visible_rows = _visible_indices(max_row, hidden_rows, max_rows)
    visible_columns = _visible_indices(max_column, hidden_columns, max_columns)
    visible_row_count = max(0, max_row - len(hidden_rows))
    visible_column_count = max(0, max_column - len(hidden_columns))
    sampled_rows, has_formulas, formula_count = _sample_visible_cells(
        worksheet=worksheet,
        visible_rows=visible_rows,
        visible_columns=visible_columns,
    )
    payload["has_formulas"] = has_formulas
    payload["formula_cells_sampled"] = formula_count
    payload["sampled_rows"] = sampled_rows
    sample_truncated = (
        visible_row_count > len(visible_rows)
        or visible_column_count > len(visible_columns)
    )
    payload["formula_scan_truncated"] = sample_truncated
    payload["sample_truncated"] = sample_truncated
    return payload


def _sample_visible_cells(
    *,
    worksheet: Any,
    visible_rows: list[int],
    visible_columns: list[int],
) -> tuple[list[list[object]], bool, int]:
    sampled: list[list[object]] = []
    count = 0
    if not visible_rows or not visible_columns:
        return sampled, False, 0
    visible_row_set = set(visible_rows)
    for row_index, row in enumerate(
        worksheet.iter_rows(
            min_row=1,
            max_row=visible_rows[-1],
            max_col=visible_columns[-1],
            values_only=True,
        ),
        start=1,
    ):
        if row_index not in visible_row_set:
            continue
        sampled_row: list[object] = []
        for column_index in visible_columns:
            value = row[column_index - 1] if column_index <= len(row) else None
            if isinstance(value, str) and value.startswith("="):
                count += 1
            sampled_row.append(_serialize_cell_value(value))
        sampled.append(sampled_row)
    return sampled, count > 0, count


def _visible_indices(size: int, hidden: set[int], limit: int) -> list[int]:
    if size <= 0 or limit <= 0:
        return []
    selected: list[int] = []
    for index in range(1, size + 1):
        if index in hidden:
            continue
        selected.append(index)
        if len(selected) >= limit:
            break
    return selected


def _hidden_dimensions(
    archive: zipfile.ZipFile,
    *,
    worksheet: Any,
    element_tree: Any,
    max_rows: int,
    max_columns: int,
) -> tuple[set[int], set[int]]:
    part_name = str(getattr(worksheet, "_worksheet_path", "") or "")
    if not part_name or max_rows <= 0 or max_columns <= 0:
        return set(), set()
    try:
        info = archive.getinfo(part_name)
    except KeyError:
        return set(), set()
    if int(info.file_size) > MAX_OOXML_XML_PART_BYTES:
        raise ValueError(f"OOXML XML part exceeds limit: {part_name}")

    hidden_rows: set[int] = set()
    hidden_columns: set[int] = set()
    last_row_index = 0
    with archive.open(info) as stream:
        for _event, node in element_tree.iterparse(stream, events=("end",)):
            local_name = local_name_of(node.tag)
            if local_name == "col":
                hidden_value = local_attribute(node, "hidden")
                start = _xml_index(local_attribute(node, "min"))
                end = _xml_index(local_attribute(node, "max"))
                if hidden_value is not None and start and end:
                    columns = range(max(1, start), min(max_columns, end) + 1)
                    if ooxml_boolean(hidden_value, default=False):
                        hidden_columns.update(columns)
                    else:
                        hidden_columns.difference_update(columns)
            elif local_name == "row":
                row_index = _xml_index(local_attribute(node, "r")) or last_row_index + 1
                last_row_index = row_index
                if row_index > max_rows:
                    break
                if row_index and ooxml_boolean(
                    local_attribute(node, "hidden"),
                    default=False,
                ):
                    hidden_rows.add(row_index)
            node.clear()
    return hidden_rows, hidden_columns


def _xml_index(value: object) -> int:
    try:
        parsed = int(str(value))
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)


def _serialize_cell_value(value: object) -> object:
    if value is None:
        return ""
    if isinstance(value, str) and value.startswith("="):
        return "[formula]"
    if isinstance(value, str):
        return sanitize_tool_output(
            value,
            max_chars=MAX_CELL_STRING_CHARS,
            tool_name="spreadsheet_inspect",
        )
    if isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    return sanitize_tool_output(
        str(value),
        max_chars=MAX_CELL_STRING_CHARS,
        tool_name="spreadsheet_inspect",
    )


def _inspect_caps(arguments: dict[str, object]) -> dict[str, int]:
    return {
        "max_sheets": integer_cap(
            arguments,
            "max_sheets",
            default=DEFAULT_MAX_SHEETS,
            maximum=MAX_SHEETS,
            tool_name="spreadsheet inspect",
        ),
        "max_rows_per_sheet": integer_cap(
            arguments,
            "max_rows_per_sheet",
            default=DEFAULT_MAX_ROWS_PER_SHEET,
            maximum=MAX_ROWS_PER_SHEET,
            tool_name="spreadsheet inspect",
        ),
        "max_columns_per_sheet": integer_cap(
            arguments,
            "max_columns_per_sheet",
            default=DEFAULT_MAX_COLUMNS_PER_SHEET,
            maximum=MAX_COLUMNS_PER_SHEET,
            tool_name="spreadsheet inspect",
        ),
    }


def _sheet_state(worksheet: Any) -> str:
    state = str(getattr(worksheet, "sheet_state", "") or "visible").strip()
    return state or "visible"


def _positive_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(0, value)
