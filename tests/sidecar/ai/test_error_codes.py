from __future__ import annotations

from scripts.checks import check_error_codes


def test_error_code_registry_sources_match_documentation() -> None:
    assert check_error_codes.registry_drift() == []


def test_error_code_check_rejects_inline_source_literals() -> None:
    violations = check_error_codes.inline_code_violations()
    assert violations == []


def test_error_code_check_rejects_js_template_literals(tmp_path) -> None:
    source = tmp_path / "inline.js"
    source.write_text("throw new Error(`CMP-TOOL-0007 blocked`);\n", encoding="utf-8")

    assert check_error_codes.find_inline_codes(source) == [(1, "CMP-TOOL-0007")]


def test_error_code_check_ignores_js_block_comment_literals(tmp_path) -> None:
    source = tmp_path / "commented.js"
    source.write_text(
        "/*\n"
        "throw new Error(`CMP-TOOL-0007 blocked`);\n"
        "*/\n"
        "throw new Error(`CMP-TOOL-0008 blocked`);\n",
        encoding="utf-8",
    )

    assert check_error_codes.find_inline_codes(source) == [(4, "CMP-TOOL-0008")]
