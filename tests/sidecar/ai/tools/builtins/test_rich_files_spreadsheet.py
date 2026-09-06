"""Rich-file spreadsheet inspect adapter tests."""

from __future__ import annotations

import importlib
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING,
    CMP_TOOL_RICH_FILES_UNSUPPORTED,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _spreadsheet_module():
    try:
        return importlib.import_module("sidecar.ai.tools.builtins.rich_files.spreadsheet")
    except ModuleNotFoundError as exc:
        pytest.fail(f"spreadsheet inspect adapter is not implemented: {exc}")


def _spreadsheet_tool():
    return _spreadsheet_module().spreadsheet_inspect_tool


def _write_workbook(path: Path, *, many_sheets: int = 0) -> None:
    openpyxl = pytest.importorskip("openpyxl")
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Visible"
    sheet.append(["Name", "Amount", "Computed"])
    sheet.append(["Alpha", 7, "=SUM(B2:B2)"])
    hidden = workbook.create_sheet("Hidden")
    hidden.sheet_state = "hidden"
    hidden["A1"] = "private hidden value"
    very_hidden = workbook.create_sheet("VeryHidden")
    very_hidden.sheet_state = "veryHidden"
    very_hidden["A1"] = "=NOW()"
    for index in range(many_sheets):
        extra = workbook.create_sheet(f"Extra {index + 1}")
        extra["A1"] = f"extra {index + 1}"
    workbook.save(path)


def _write_hidden_first_workbook(path: Path) -> None:
    openpyxl = pytest.importorskip("openpyxl")
    workbook = openpyxl.Workbook()
    hidden = workbook.active
    hidden.title = "Hidden First"
    hidden.sheet_state = "hidden"
    hidden["A1"] = "hidden secret"
    visible = workbook.create_sheet("Visible Second")
    visible["A1"] = "visible sample"
    workbook.save(path)


def _write_hidden_dimensions_workbook(path: Path) -> None:
    openpyxl = pytest.importorskip("openpyxl")
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet["A1"] = "hidden row value"
    sheet["B1"] = "=NOW()"
    sheet["A2"] = "visible value"
    sheet["B2"] = "hidden column value"
    sheet["C2"] = "later visible column"
    sheet["A3"] = "later visible row"
    sheet["C3"] = "later visible cell"
    sheet.row_dimensions[1].hidden = True
    sheet.column_dimensions["B"].hidden = True
    workbook.save(path)


def _replace_zip_part(path: Path, part_name: str, content: bytes) -> None:
    replacement = path.with_suffix(".replacement")
    with zipfile.ZipFile(path) as source, zipfile.ZipFile(replacement, "w") as target:
        for info in source.infolist():
            target.writestr(info, content if info.filename == part_name else source.read(info))
    replacement.replace(path)


def test_spreadsheet_inspect_returns_workbook_summary_and_samples_visible_rows(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "sample.xlsx"
    _write_workbook(source_path)

    result = _spreadsheet_tool()(
        {
            "path": "sample.xlsx",
            "max_sheets": 5,
            "max_rows_per_sheet": 3,
            "max_columns_per_sheet": 3,
        },
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.success is True
    assert result.generated_artifacts == ()
    assert result.metadata["result_kind"] == "spreadsheet_inspect"
    assert result.metadata["previews"] == []
    assert result.metadata["source"]["path"] == "sample.xlsx"
    assert result.metadata["summary"]["sheet_count"] == 3
    assert result.metadata["summary"]["visible_sheet_count"] == 1
    assert result.metadata["summary"]["hidden_sheet_count"] == 2
    assert result.metadata["summary"]["macro_enabled"] is False
    visible = result.metadata["summary"]["sheets"][0]
    assert visible["name"] == "Visible"
    assert visible["state"] == "visible"
    assert visible["has_formulas"] is True
    assert visible["sampled_rows"][0] == ["Name", "Amount", "Computed"]
    assert visible["sampled_rows"][1] == ["Alpha", 7, "[formula]"]
    hidden = result.metadata["summary"]["sheets"][1]
    assert hidden["name"] == "Hidden"
    assert hidden["has_formulas"] is False
    assert hidden["sampled_rows"] == []
    assert hidden["sample_skipped"] == "hidden_sheet"
    assert hidden["formula_scan_skipped"] == "hidden_sheet"
    very_hidden = result.metadata["summary"]["sheets"][2]
    assert very_hidden["state"] == "veryHidden"
    assert very_hidden["has_formulas"] is False
    assert very_hidden["sampled_rows"] == []
    assert very_hidden["formula_scan_skipped"] == "hidden_sheet"
    assert "private hidden value" not in result.output
    assert "=SUM" not in result.output
    assert "=NOW" not in result.output
    assert str(workspace_root) not in result.output


def test_spreadsheet_inspect_prioritizes_visible_sheets_for_sheet_cap(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "hidden-first.xlsx"
    _write_hidden_first_workbook(source_path)

    result = _spreadsheet_tool()(
        {"path": "hidden-first.xlsx", "max_sheets": 1},
        WorkspaceGuard(str(workspace_root)),
    )

    summary = result.metadata["summary"]
    assert summary["sheet_count"] == 2
    assert summary["visible_sheet_count"] == 1
    assert summary["hidden_sheet_count"] == 1
    assert summary["omitted_sheet_count"] == 1
    assert len(summary["sheets"]) == 1
    visible = summary["sheets"][0]
    assert visible["name"] == "Visible Second"
    assert visible["state"] == "visible"
    assert visible["sampled_rows"] == [["visible sample"]]
    assert "hidden secret" not in result.output


def test_spreadsheet_inspect_caps_sheet_rows_and_columns(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "many.xlsx"
    _write_workbook(source_path, many_sheets=4)

    result = _spreadsheet_tool()(
        {
            "path": "many.xlsx",
            "max_sheets": 1,
            "max_rows_per_sheet": 1,
            "max_columns_per_sheet": 2,
        },
        WorkspaceGuard(str(workspace_root)),
    )

    summary = result.metadata["summary"]
    assert summary["sheet_count"] == 7
    assert summary["omitted_sheet_count"] == 6
    assert len(summary["sheets"]) == 1
    visible = summary["sheets"][0]
    assert visible["sampled_rows"] == [["Name", "Amount"]]
    assert visible["sample_truncated"] is True
    assert visible["formula_scan_truncated"] is True


def test_spreadsheet_inspect_omits_hidden_rows_and_columns(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "hidden-dimensions.xlsx"
    _write_hidden_dimensions_workbook(source_path)

    result = _spreadsheet_tool()(
        {
            "path": "hidden-dimensions.xlsx",
            "max_rows_per_sheet": 2,
            "max_columns_per_sheet": 2,
        },
        WorkspaceGuard(str(workspace_root)),
    )

    sheet = result.metadata["summary"]["sheets"][0]
    assert sheet["sampled_rows"] == [
        ["visible value", "later visible column"],
        ["later visible row", "later visible cell"],
    ]
    assert sheet["has_formulas"] is False
    assert sheet["formula_cells_sampled"] == 0
    assert "hidden row value" not in result.output
    assert "hidden column value" not in result.output


def test_spreadsheet_inspect_rejects_invalid_caps(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "sample.xlsx"
    _write_workbook(source_path)

    with pytest.raises(ToolExecutionFailure) as exc_info:
        _spreadsheet_tool()(
            {"path": "sample.xlsx", "max_rows_per_sheet": 0},
            WorkspaceGuard(str(workspace_root)),
        )

    assert exc_info.value.code == CMP_TOOL_RICH_FILES_UNSUPPORTED


def test_spreadsheet_inspect_marks_macro_enabled_extensions(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "macro.xlsm"
    _write_workbook(source_path)

    result = _spreadsheet_tool()(
        {"path": "macro.xlsm"},
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.success is True
    assert result.metadata["summary"]["macro_enabled"] is True


def test_spreadsheet_inspect_detects_vba_project_in_renamed_package(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "renamed.xlsx"
    _write_workbook(source_path)
    with zipfile.ZipFile(source_path, "a") as archive:
        archive.writestr("XL/VBAPROJECT.BIN", b"vba")

    result = _spreadsheet_tool()(
        {"path": "renamed.xlsx"},
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.metadata["summary"]["macro_enabled"] is True


def test_spreadsheet_lazy_worksheet_parse_failure_returns_unsupported(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    source_path = workspace_root / "malformed-sheet.xlsx"
    _write_workbook(source_path)
    _replace_zip_part(
        source_path,
        "xl/worksheets/sheet1.xml",
        (
            b'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            b'<dimension ref="A1"/><sheetData><row r="1"><c r="A1"/></row>'
        ),
    )

    result = _spreadsheet_tool()(
        {"path": "malformed-sheet.xlsx"},
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.success is True
    assert result.metadata["status"] == "unsupported"
    assert result.metadata["failure"]["reason"] == "spreadsheet_parse_failed"


def test_spreadsheet_inspect_dependency_missing_degrades(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "sample.xlsx").write_bytes(b"PK\x03\x04")
    module = _spreadsheet_module()

    def _missing_openpyxl(name: str):
        if name == "openpyxl":
            raise ModuleNotFoundError("missing openpyxl")
        return importlib.import_module(name)

    monkeypatch.setattr(module.importlib, "import_module", _missing_openpyxl)

    result = module.spreadsheet_inspect_tool(
        {"path": "sample.xlsx"},
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.success is True
    assert result.metadata["status"] == "unavailable"
    assert result.metadata["failure"]["error_code"] == CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING


def test_spreadsheet_inspect_requires_xml_bomb_protection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "sample.xlsx").write_bytes(b"PK\x03\x04")
    module = _spreadsheet_module()

    def _fake_openpyxl(name: str):
        if name == "openpyxl":
            return SimpleNamespace(DEFUSEDXML=False)
        return importlib.import_module(name)

    monkeypatch.setattr(module.importlib, "import_module", _fake_openpyxl)

    result = module.spreadsheet_inspect_tool(
        {"path": "sample.xlsx"},
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.success is True
    assert result.metadata["status"] == "unavailable"
    assert result.metadata["failure"]["error_code"] == CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING
    assert "defusedxml" in result.metadata["failure"]["reason"]


def test_spreadsheet_inspect_unsupported_extension_is_nonfatal(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "legacy.xls").write_bytes(b"not an ooxml workbook")

    result = _spreadsheet_tool()(
        {"path": "legacy.xls"},
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.success is True
    assert result.metadata["status"] == "unsupported"
    assert result.metadata["failure"]["reason"] == "spreadsheet_format_unsupported"


def test_spreadsheet_inspect_corrupt_workbook_returns_unsupported(tmp_path: Path) -> None:
    pytest.importorskip("openpyxl")
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "broken.xlsx").write_bytes(b"not really a workbook")

    result = _spreadsheet_tool()(
        {"path": "broken.xlsx"},
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.success is True
    assert result.metadata["status"] == "unsupported"
    assert result.metadata["failure"]["reason"] == "spreadsheet_parse_failed"
