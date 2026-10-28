"""Deterministic edit matching through the actual file tool and pure ladder."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED
from sidecar.ai.tools.builtins import edit_file, filesystem, shell_settings
from sidecar.ai.tools.builtins.edit_file import edit_file_tool
from sidecar.ai.tools.builtins.file_state import build_no_match_message
from sidecar.ai.tools.builtins.propose_change import propose_change_tool
from sidecar.ai.tools.builtins.propose_suggestion import match_replace
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard


@pytest.fixture(autouse=True)
def _reset_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    filesystem.configure_filesystem_tools(None)
    monkeypatch.setattr(shell_settings, "_FEATURE_FLAGS", {})
    yield
    filesystem.configure_filesystem_tools(None)


def _edit(tmp_path: Path, content: str, old: str, new: str) -> ToolHandlerResult:
    (tmp_path / "sample.txt").write_bytes(content.encode("utf-8"))
    return edit_file_tool(
        {"file_path": "sample.txt", "old_string": old, "new_string": new},
        WorkspaceGuard(str(tmp_path)),
    )


def _assert_fallback(result: ToolHandlerResult, step: str) -> None:
    assert result.success, result.output
    assert result.metadata["match_fallback"] == step
    assert f" (matched after normalising {step})" in result.output


def test_trailing_whitespace(tmp_path: Path) -> None:
    result = _edit(
        tmp_path, "before\nalpha  \nbeta\t\nafter\n", "alpha\nbeta\n", "alpha\nBETA\n"
    )
    _assert_fallback(result, "trailing_whitespace")
    assert (tmp_path / "sample.txt").read_bytes() == b"before\nalpha  \nBETA\nafter\n"


def test_typography(tmp_path: Path) -> None:
    content = 'before\nlabel = “don’t—stop”\nvalue = “old”\nafter\n'
    result = _edit(
        tmp_path, content, 'label = "don\'t-stop"\nvalue = "old"',
        'label = "don\'t-stop"\nvalue = "new"',
    )
    _assert_fallback(result, "typography")
    assert (tmp_path / "sample.txt").read_bytes() == (
        'before\nlabel = “don’t—stop”\nvalue = "new"\nafter\n'.encode()
    )


def test_indentation(tmp_path: Path) -> None:
    content = "before\n                if ready:\n                    run()\nafter\n"
    result = _edit(tmp_path, content, "if ready:\n    run()", "if ready:\n    finish()")
    _assert_fallback(result, "indentation")
    assert (tmp_path / "sample.txt").read_bytes() == (
        b"before\n                if ready:\n                    finish()\nafter\n"
    )


_CASES = [
    ("alpha  \nbeta\t\n", "alpha\nbeta\n", "alpha\nBETA\n", "trailing_whitespace"),
    ('“old”—don’t\n', '"old"-don\'t', '"new"-don\'t', "typography"),
    ("    a\n        b\n", "a\n    b", "a\n    c", "indentation"),
]


@pytest.mark.parametrize(("content", "old", "new", "step"), _CASES)
def test_flag_off_preserves_failure(
    tmp_path: Path, content: str, old: str, new: str, step: str
) -> None:
    shell_settings.configure_shell_security({"edit_match_fallbacks": False})
    result = _edit(tmp_path, content, old, new)
    assert not result.success
    assert result.output == build_no_match_message(content, old, "sample.txt")
    assert "match_fallback" not in result.metadata
    assert (tmp_path / "sample.txt").read_bytes() == content.encode()


@pytest.mark.parametrize(("content", "old", "new", "step"), _CASES)
def test_replace_all_never_uses_ladder(
    tmp_path: Path, content: str, old: str, new: str, step: str
) -> None:
    target = tmp_path / "sample.txt"
    target.write_bytes(content.encode())
    result = edit_file_tool(
        {"file_path": "sample.txt", "old_string": old, "new_string": new, "replace_all": True},
        WorkspaceGuard(str(tmp_path)),
    )
    assert not result.success
    assert result.output == build_no_match_message(content, old, "sample.txt")
    assert target.read_bytes() == content.encode()


@pytest.mark.parametrize(("content", "old", "new", "step"), _CASES)
def test_ambiguity_stops_ladder(
    tmp_path: Path, content: str, old: str, new: str, step: str
) -> None:
    content = content + "separator\n" + content
    result = _edit(tmp_path, content, old, new)
    assert not result.success
    assert result.output == (
        build_no_match_message(content, old, "sample.txt")
        + f"\nA normalised match was ambiguous ({step}: 2 places); "
        "include more surrounding lines."
    )
    assert (tmp_path / "sample.txt").read_bytes() == content.encode()


def test_no_match_retains_exact_diagnostic(tmp_path: Path) -> None:
    content, old = "before\nexisting\nafter\n", "nonexistent\nblock"
    result = _edit(tmp_path, content, old, "changed")
    assert not result.success
    assert result.output == build_no_match_message(content, old, "sample.txt")
    assert (tmp_path / "sample.txt").read_bytes() == content.encode()


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
@pytest.mark.parametrize("case", _CASES)
def test_mapping_preserves_bytes_outside_span(
    tmp_path: Path, newline: str, case: tuple[str, str, str, str]
) -> None:
    content, old, new, step = case
    prefix, suffix = "prefix ‘keep’  \n\t\n", "\t\nsuffix — keep\t\n"
    original = (prefix + content + suffix).replace("\n", newline)
    result = _edit(tmp_path, original, old, new)
    _assert_fallback(result, step)
    actual = (tmp_path / "sample.txt").read_bytes()
    assert actual.startswith(prefix.replace("\n", newline).encode())
    assert actual.endswith(suffix.replace("\n", newline).encode())
    if newline == "\r\n":
        assert b"\n" not in actual.replace(b"\r\n", b"")


def test_exact_match_has_no_fallback_notice(tmp_path: Path) -> None:
    result = _edit(tmp_path, "old\n", "old", "new")
    assert result.success
    assert "match_fallback" not in result.metadata
    assert result.output == "The file sample.txt has been updated."


@pytest.mark.parametrize("fail", [False, True])
def test_batch_atomicity_and_order(tmp_path: Path, fail: bool) -> None:
    content = "alpha\nvalue = “old”\n"
    target = tmp_path / "sample.txt"
    target.write_bytes(content.encode())
    edits = [
        {"old_string": "alpha", "new_string": "ALPHA"},
        {"old_string": 'value = "old"', "new_string": 'value = "new"'},
        {"old_string": "missing" if fail else 'value = "new"', "new_string": "finish"},
    ]
    result = edit_file_tool(
        {"file_path": "sample.txt", "edits": edits}, WorkspaceGuard(str(tmp_path))
    )
    if fail:
        assert not result.success
        assert result.metadata["failed_edits"] == [3]
        assert target.read_bytes() == content.encode()
    else:
        _assert_fallback(result, "typography")
        assert result.metadata["edits_applied"] == 3
        assert target.read_bytes() == b"ALPHA\nfinish\n"


def test_fallback_respects_final_cap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    content = "value = “old”\n"
    monkeypatch.setattr(edit_file, "current_max_edit_file_bytes", lambda: 100)
    result = _edit(tmp_path, content, 'value = "old"', "z" * 101)
    assert not result.success
    assert result.error_code == CMP_TOOL_CAP_EXCEEDED
    assert (tmp_path / "sample.txt").read_bytes() == content.encode()


def test_propose_mode_matches_without_writing(tmp_path: Path) -> None:
    content = "    a\n        b\n"
    target = tmp_path / "sample.txt"
    target.write_bytes(content.encode())
    matched = match_replace(
        content, "a\n    b", "a\n    c", relative_path="sample.txt", max_bytes=1000
    )
    assert not isinstance(matched, ToolHandlerResult)
    assert matched.new_text == "    a\n        c\n"
    assert matched.span == (0, len(content) - 1), "the indentation fallback's span"
    result = propose_change_tool(
        {
            "path": "sample.txt", "kind": "replace", "old_string": "a\n    b",
            "new_string": "a\n    c", "title": "Update b", "what": "Use c", "why": "Required",
        },
        WorkspaceGuard(str(tmp_path)),
    )
    assert result.success, result.output
    assert result.metadata["suggested_change"]["diff"]["additions"] == 1
    assert target.read_bytes() == content.encode()


def test_unit_ladder_maps_exact_original_span() -> None:
    from sidecar.ai.tools.builtins.edit_fallbacks import FallbackMatch, find_fallback

    content = "prefix\nalpha \nbeta\t\n \nsuffix\n"
    result = find_fallback(content, "alpha\nbeta\n", "alpha\nBETA\n")
    assert isinstance(result, FallbackMatch)
    assert content[result.start:result.end] == "alpha \nbeta\t\n"
    assert result.replacement == "alpha \nBETA\n"


@pytest.mark.parametrize("character", list('“”„″‘’‚′–—−\u00a0'))
def test_unit_all_typography_characters(character: str) -> None:
    from sidecar.ai.tools.builtins.edit_fallbacks import FallbackMatch, find_fallback

    if character in '“”„″':
        ascii_character = '"'
    elif character in "‘’‚′":
        ascii_character = "'"
    elif character in "–—−":
        ascii_character = "-"
    else:
        ascii_character = " "
    content = f"prefix value{character}here suffix"
    result = find_fallback(content, f"value{ascii_character}here", "replacement")
    assert isinstance(result, FallbackMatch)
    assert result.step == "typography"
    assert content[:result.start] == "prefix "
    assert content[result.end:] == " suffix"


@pytest.mark.parametrize("old", [" ", "\t", "\n \t\n"])
def test_unit_whitespace_only_does_not_invent_anchor(old: str) -> None:
    from sidecar.ai.tools.builtins.edit_fallbacks import find_fallback

    assert find_fallback("nonempty\n", old, "new") is None


def test_indentation_combines_normalisations_and_keeps_blank_lines(tmp_path: Path) -> None:
    result = _edit(
        tmp_path, 'before\n\t\tif “ready”:  \n\t\t    go()\t\n\nafter\n',
        '    if "ready":\n        go()', '    if "ready":\n\n        finish()',
    )
    _assert_fallback(result, "indentation")
    assert (tmp_path / "sample.txt").read_bytes() == (
        b'before\n\t\tif "ready":\n\n\t\t    finish()\n\nafter\n'
    )


def test_fallback_deletes_whole_line_including_newline(tmp_path: Path) -> None:
    result = _edit(tmp_path, 'before\n“remove”\nafter\n', '"remove"', "")
    _assert_fallback(result, "typography")
    assert (tmp_path / "sample.txt").read_bytes() == b"before\nafter\n"
