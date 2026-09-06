"""Strict UTF-8 decode-or-refuse coverage for edit_file/write_file (P0-3, WIDE-014 stopgap).

Before this change, the shared chokepoint `file_state.load_existing_text_state_for_mutation`
decoded existing file bytes with `errors="replace"` for every caller. Mutators that
re-encode the decoded text back to disk (edit_file's `_edit_locked`) would therefore
silently bake U+FFFD into any non-UTF-8 byte on a successful edit, permanently
corrupting the file while reporting success. These tests pin the fixed contract:

- edit_file refuses (typed `CMP_TOOL_IO_FAILED`, zero bytes changed) on any file that
  is not valid UTF-8, instead of lossily "fixing" it on write.
- UTF-8 BOM files are editable and preserve one marker unless normalization is explicit.
- write_file applies the same classification to an existing file, even when the caller
  supplies a syntactically-valid full read snapshot and intends a wholesale overwrite.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins import edit_file as edit_module
from sidecar.ai.tools.builtins import filesystem as filesystem_module
from sidecar.ai.tools.builtins.file_state import build_read_snapshot
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


@pytest.fixture(autouse=True)
def _reset_filesystem_config() -> Iterator[None]:
    filesystem_module.configure_filesystem_tools(None)
    yield
    filesystem_module.configure_filesystem_tools(None)


def _full_read_snapshot(tmp_path: Path, relative_path: str) -> dict[str, object]:
    result = filesystem_module.read_file_tool({"path": relative_path}, _guard(tmp_path))
    assert result.success is True
    snapshot = result.metadata.get("read_snapshot")
    assert isinstance(snapshot, dict)
    return snapshot


def _manual_full_snapshot(target: Path, relative_path: str) -> dict[str, object]:
    raw = target.read_bytes()
    return build_read_snapshot(
        relative_path=relative_path,
        scope="full",
        stat_result=target.stat(),
        raw_bytes=raw,
    ).to_metadata()


# ---------------------------------------------------------------------------
# edit_file: invalid UTF-8 is refused, zero bytes changed.
# ---------------------------------------------------------------------------


def test_edit_file_refuses_invalid_utf8_latin1_byte_without_mutating(tmp_path: Path) -> None:
    target = tmp_path / "menu.txt"
    original = b"caf\xe9 today\n"
    target.write_bytes(original)

    result = edit_module.edit_file_tool(
        {"file_path": "menu.txt", "old_string": "today", "new_string": "tomorrow"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert "not valid utf-8" in result.output.lower()
    assert "menu.txt" in result.output
    assert target.read_bytes() == original


def test_edit_file_refuses_cp1252_smart_quotes_without_mutating(tmp_path: Path) -> None:
    target = tmp_path / "quote.txt"
    # cp1252 curly quotes (0x93/0x94) are not valid UTF-8 continuation bytes.
    original = b"She said \x93hello\x94 to me\n"
    target.write_bytes(original)

    result = edit_module.edit_file_tool(
        {"file_path": "quote.txt", "old_string": "hello", "new_string": "hi"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert "not valid utf-8" in result.output.lower()
    assert target.read_bytes() == original


def test_edit_file_refuses_utf16_le_bom_file_without_mutating(tmp_path: Path) -> None:
    target = tmp_path / "utf16le.txt"
    original = b"\xff\xfe" + "hello world\n".encode("utf-16-le")
    target.write_bytes(original)

    result = edit_module.edit_file_tool(
        {"file_path": "utf16le.txt", "old_string": "hello", "new_string": "hi"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert target.read_bytes() == original


def test_edit_file_refuses_utf16_be_bom_file_without_mutating(tmp_path: Path) -> None:
    target = tmp_path / "utf16be.txt"
    original = b"\xfe\xff" + "hello world\n".encode("utf-16-be")
    target.write_bytes(original)

    result = edit_module.edit_file_tool(
        {"file_path": "utf16be.txt", "old_string": "hello", "new_string": "hi"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert target.read_bytes() == original


# ---------------------------------------------------------------------------
# edit_file: UTF-8 BOM is preserved or normalized; multibyte UTF-8 stays editable.
# ---------------------------------------------------------------------------


def test_edit_file_preserves_utf8_bom_by_default(tmp_path: Path) -> None:
    target = tmp_path / "bom.txt"
    original = b"\xef\xbb\xbfhello world\n"
    target.write_bytes(original)

    result = edit_module.edit_file_tool(
        {
            "file_path": "bom.txt",
            "old_string": "world",
            "new_string": "earth",
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert target.read_bytes() == b"\xef\xbb\xbfhello earth\n"


def test_edit_file_normalizes_utf8_bom_explicitly(tmp_path: Path) -> None:
    target = tmp_path / "bom.txt"
    target.write_bytes(b"\xef\xbb\xbfhello world\n")
    result = edit_module.edit_file_tool(
        {"file_path": "bom.txt", "old_string": "world", "new_string": "earth", "normalize_bom": True},
        _guard(tmp_path),
    )
    assert result.success is True
    assert target.read_bytes() == b"hello earth\n"


def test_edit_file_edits_valid_multibyte_utf8_content(tmp_path: Path) -> None:
    target = tmp_path / "multibyte.txt"
    target.write_bytes("héllo wörld 日本語\n".encode("utf-8"))

    result = edit_module.edit_file_tool(
        {
            "file_path": "multibyte.txt",
            "old_string": "日本語",
            "new_string": "世界",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "multibyte.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert target.read_bytes() == "héllo wörld 世界\n".encode("utf-8")


# ---------------------------------------------------------------------------
# write_file: every existing file must pass the same editable-text classifier.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "original"),
    [
        ("quote.txt", b"She said \x93hello\x94 to me\n"),
        ("mixed.txt", b"valid caf\xc3\xa9\nlegacy \x96 byte\n"),
        ("truncated.txt", b"valid prefix\ntruncated \xf0\x9f\x8c"),
    ],
)
def test_write_file_refuses_non_editable_existing_bytes_without_mutating(
    tmp_path: Path,
    name: str,
    original: bytes,
) -> None:
    target = tmp_path / name
    target.write_bytes(original)

    result = filesystem_module.write_file_tool(
        {
            "path": name,
            "content": "replacement text\n",
            "expected_read_snapshot": _manual_full_snapshot(target, name),
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert target.read_bytes() == original


def test_write_file_preserves_or_normalizes_utf8_bom(tmp_path: Path) -> None:
    target = tmp_path / "bom.txt"
    target.write_bytes(b"\xef\xbb\xbfhello world\n")
    snapshot = _full_read_snapshot(tmp_path, "bom.txt")
    preserved = filesystem_module.write_file_tool(
        {"path": "bom.txt", "content": "replacement\n", "expected_read_snapshot": snapshot},
        _guard(tmp_path),
    )
    assert preserved.success is True
    assert target.read_bytes() == b"\xef\xbb\xbfreplacement\n"
    snapshot = _full_read_snapshot(tmp_path, "bom.txt")
    normalized = filesystem_module.write_file_tool(
        {"path": "bom.txt", "content": "plain\n", "expected_read_snapshot": snapshot, "normalize_bom": True},
        _guard(tmp_path),
    )
    assert normalized.success is True
    assert target.read_bytes() == b"plain\n"


def test_write_file_never_doubles_utf8_bom(tmp_path: Path) -> None:
    target = tmp_path / "bom.txt"
    target.write_bytes(b"\xef\xbb\xbfhello\n")
    result = filesystem_module.write_file_tool(
        {
            "path": "bom.txt",
            "content": "\ufeffupdated\n",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "bom.txt"),
        },
        _guard(tmp_path),
    )
    assert result.success is True
    assert target.read_bytes() == b"\xef\xbb\xbfupdated\n"


def test_write_file_normalizes_marker_from_new_content(tmp_path: Path) -> None:
    result = filesystem_module.write_file_tool(
        {"path": "new.txt", "content": "\ufeffplain\n", "normalize_bom": True},
        _guard(tmp_path),
    )
    assert result.success is True
    assert (tmp_path / "new.txt").read_bytes() == b"plain\n"
