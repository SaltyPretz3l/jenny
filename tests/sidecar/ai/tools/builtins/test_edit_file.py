from __future__ import annotations

import json
import os
import stat
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_COERCED_ARGS_REJECTED,
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_READ_SNAPSHOT_REQUIRED,
    CMP_TOOL_STALE_READ_SNAPSHOT,
)
from sidecar.ai.tools.builtins import edit_file as edit_module
from sidecar.ai.tools.builtins import file_history as file_history_module
from sidecar.ai.tools.builtins import filesystem as filesystem_module
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


@pytest.fixture(autouse=True)
def _reset_filesystem_config() -> Iterator[None]:
    # No monkeypatch.undo() here: pytest's monkeypatch fixture undoes its own
    # patches at teardown, so an explicit undo was redundant (and required an
    # otherwise-unused monkeypatch parameter).
    filesystem_module.configure_filesystem_tools(None)
    yield
    filesystem_module.configure_filesystem_tools(None)


def _relative_metadata_path(tmp_path: Path, display_path: str) -> Path:
    return tmp_path / Path(display_path.replace("/", os.sep))


def _full_read_snapshot(tmp_path: Path, relative_path: str) -> dict[str, object]:
    result = filesystem_module.read_file_tool({"path": relative_path}, _guard(tmp_path))
    assert result.success is True
    snapshot = result.metadata.get("read_snapshot")
    assert isinstance(snapshot, dict)
    return snapshot


def test_edit_file_replaces_unique_string_and_creates_checkpoint(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    original = b"hello world\r\n"
    target.write_bytes(original)

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "world",
            "new_string": "earth",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "notes.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert target.read_bytes() == b"hello earth\r\n"
    assert result.metadata["path"] == "notes.txt"
    assert result.metadata["replacements"] == 1
    assert result.metadata["replace_all"] is False
    assert result.metadata["checkpoint_created"] is True
    # Snapshot-provided path: the strong stale-write guarantee was exercised.
    assert result.metadata["read_snapshot_validated"] is True
    checkpoint_path = _relative_metadata_path(
        tmp_path, str(result.metadata["checkpoint_display_path"])
    )
    assert checkpoint_path.read_bytes() == original


def test_edit_file_reports_missing_target_string_as_failed_result(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("hello world\n", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "missing",
            "new_string": "earth",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "notes.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_EXECUTION_FAILED
    assert "not found" in result.output.lower()


def test_edit_file_no_match_includes_closest_region_excerpt(tmp_path: Path) -> None:
    target = tmp_path / "app.py"
    target.write_text(
        "def alpha():\n    return 1\n\n\ndef beta():\n    return compute_total(items)\n",
        encoding="utf-8",
    )

    result = edit_module.edit_file_tool(
        {
            "file_path": "app.py",
            # Near-miss: the model dropped the trailing "s" on items.
            "old_string": "return compute_total(item)",
            "new_string": "return compute_total(items, tax)",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "app.py"),
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_EXECUTION_FAILED
    assert "not found" in result.output.lower()
    assert "Closest matching region" in result.output
    # The real file line is quoted with a line number so the model can re-anchor.
    assert "return compute_total(items)" in result.output
    assert "6 |" in result.output


def test_edit_file_no_match_flags_whitespace_only_difference(tmp_path: Path) -> None:
    target = tmp_path / "app.py"
    target.write_text("def f():\n    return 42\n", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "app.py",
            # Same characters, but two spaces before 42 instead of one.
            "old_string": "    return  42",
            "new_string": "    return 43",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "app.py"),
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_EXECUTION_FAILED
    assert "differing only in whitespace" in result.output


def test_edit_file_reports_ambiguous_match_without_replace_all(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("aaa bbb aaa\n", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "aaa",
            "new_string": "ccc",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "notes.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_EXECUTION_FAILED
    assert result.metadata["occurrences"] == 2
    assert "replace_all" in result.output


def test_edit_file_replace_all_updates_all_matches(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("aaa bbb aaa\n", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "aaa",
            "new_string": "ccc",
            "replace_all": True,
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "notes.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert target.read_text(encoding="utf-8") == "ccc bbb ccc\n"
    assert result.metadata["replacements"] == 2
    assert result.metadata["replace_all"] is True


def test_edit_file_rejects_identical_old_and_new_strings(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("hello\n", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "hello",
            "new_string": "hello",
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_EXECUTION_FAILED
    assert "identical" in result.output.lower()


def test_edit_file_preserves_cr_line_endings(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_bytes(b"alpha\rbeta\rgamma\r")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "beta\ngamma",
            "new_string": "beta\ndelta",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "notes.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert target.read_bytes() == b"alpha\rbeta\rdelta\r"


def test_edit_file_refuses_malformed_utf8_without_touching_bytes(tmp_path: Path) -> None:
    # Contract change (WIDE-014 / Q6, 2026-07-10): mutating through a lossy
    # decode used to bake U+FFFD into the file; strict decode now refuses and
    # the original bytes must be untouched.
    target = tmp_path / "notes.txt"
    original = b"prefix \xff suffix\r\n"
    target.write_bytes(original)

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "prefix \ufffd suffix",
            "new_string": "prefix fixed suffix",
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert "not valid UTF-8" in result.output
    assert target.read_bytes() == original


def test_edit_file_rejects_binary_content_as_failed_result(tmp_path: Path) -> None:
    target = tmp_path / "image.dat"
    target.write_bytes(b"\x00\x01hello")

    result = edit_module.edit_file_tool(
        {
            "file_path": "image.dat",
            "old_string": "hello",
            "new_string": "world",
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert "binary" in result.output.lower()


def test_edit_file_respects_configured_size_limit_as_failed_result(tmp_path: Path) -> None:
    filesystem_module.configure_filesystem_tools({"tools_max_edit_file_bytes": 8})
    target = tmp_path / "notes.txt"
    target.write_text("123456789\n", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "123",
            "new_string": "abc",
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert "byte limit" in result.output.lower()


def test_edit_file_crlf_aware_bound_refuses_before_allocating_replacement_buffer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A CRLF file's true rendered size is 1 byte wider per line than the LF-normalized
    working size _apply_edit operates on. The projected-size bound check must account
    for that CRLF expansion and refuse BEFORE _apply_edit ever allocates the replacement
    buffer -- an LF-only estimate can pass this check while the real CRLF-rendered size
    still exceeds the cap, by which point the (up to file-doubling) buffer would already
    be allocated."""
    filesystem_module.configure_filesystem_tools({"tools_max_edit_file_bytes": 12})
    target = tmp_path / "notes.txt"
    original = b"x\r\n"
    target.write_bytes(original)

    def _unexpected_apply_edit(*_args, **_kwargs):
        raise AssertionError(
            "replacement buffer must not be allocated past the CRLF-aware bound check"
        )

    monkeypatch.setattr(edit_module, "_apply_edit", _unexpected_apply_edit)

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "x",
            "new_string": "\n" * 8,
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_CAP_EXCEEDED
    assert target.read_bytes() == original


def test_write_file_creates_checkpoint_for_existing_overwrite(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("before\n", encoding="utf-8")

    result = filesystem_module.write_file_tool(
        {
            "path": "notes.txt",
            "content": "after\n",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "notes.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert target.read_text(encoding="utf-8") == "after\n"
    assert result.metadata["checkpoint_created"] is True
    checkpoint_path = _relative_metadata_path(
        tmp_path, str(result.metadata["checkpoint_display_path"])
    )
    assert checkpoint_path.read_text(encoding="utf-8") == "before\n"


def test_write_file_skips_checkpoint_for_new_file(tmp_path: Path) -> None:
    result = filesystem_module.write_file_tool(
        {"path": "new.txt", "content": "created\n"},
        _guard(tmp_path),
    )

    assert result.success is True
    assert result.metadata["checkpoint_created"] is False
    backups = list((tmp_path / ".jenny" / "backups").glob("*@v*.bak"))
    assert backups == []


def test_write_file_accepts_legacy_path_and_content_aliases(tmp_path: Path) -> None:
    result = filesystem_module.write_file_tool(
        {"file_path": "legacy.txt", "file_content": "legacy\n"},
        _guard(tmp_path),
    )

    assert result.success is True
    assert (tmp_path / "legacy.txt").read_text(encoding="utf-8") == "legacy\n"


@pytest.mark.parametrize("reverse_order", [False, True])
def test_write_file_conflicting_aliases_mutate_nothing(
    tmp_path: Path,
    reverse_order: bool,
) -> None:
    restricted = tmp_path / "restricted.txt"
    decoy = tmp_path / "decoy.txt"
    restricted.write_text("before\n", encoding="utf-8")
    decoy.write_text("decoy\n", encoding="utf-8")
    pairs = [
        ("path", restricted.name),
        ("file_path", decoy.name),
        ("content", "after\n"),
    ]
    if reverse_order:
        pairs.reverse()

    with pytest.raises(ToolExecutionFailure) as exc_info:
        filesystem_module.write_file_tool(dict(pairs), _guard(tmp_path))

    assert exc_info.value.code == CMP_TOOL_COERCED_ARGS_REJECTED
    assert restricted.read_text(encoding="utf-8") == "before\n"
    assert decoy.read_text(encoding="utf-8") == "decoy\n"


def test_write_file_rejects_invalid_utf8_surrogate_content(tmp_path: Path) -> None:
    result = filesystem_module.write_file_tool(
        {"path": "broken.txt", "content": "prefix\udc8fsuffix"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_EXECUTION_FAILED
    assert "utf-8" in result.output.lower()
    assert not (tmp_path / "broken.txt").exists()


def test_write_file_rejects_oversized_new_content_before_mutation(tmp_path: Path) -> None:
    filesystem_module.configure_filesystem_tools({"tools_max_edit_file_bytes": 8})

    result = filesystem_module.write_file_tool(
        {"path": "oversized.txt", "content": "123456789"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_CAP_EXCEEDED
    assert "byte limit" in result.output.lower()
    assert not (tmp_path / "oversized.txt").exists()


def test_edit_file_rejects_projected_oversize_before_checkpoint(tmp_path: Path) -> None:
    filesystem_module.configure_filesystem_tools({"tools_max_edit_file_bytes": 8})
    target = tmp_path / "notes.txt"
    target.write_text("hello", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "h",
            "new_string": "0123456789",
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_CAP_EXCEEDED
    assert target.read_text(encoding="utf-8") == "hello"
    backups = tmp_path / ".jenny" / "backups"
    assert not list(backups.glob("*.bak"))
    assert not list(backups.glob("*.json"))


def test_write_file_rejects_non_session_scoped_artifact_root_writes(tmp_path: Path) -> None:
    result = filesystem_module.write_file_tool(
        {"path": ".jenny/artifacts/butterfly_effect.mmd", "content": "flowchart TD\nA-->B\n"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_INVALID_PATH
    assert "create_artifact" in result.output


def test_write_file_allows_session_scoped_artifact_root_writes(tmp_path: Path) -> None:
    result = filesystem_module.write_file_tool(
        {
            "path": ".jenny/artifacts/session-123/butterfly_effect.mmd",
            "content": "flowchart TD\nA-->B\n",
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert (tmp_path / ".jenny" / "artifacts" / "session-123" / "butterfly_effect.mmd").exists()


def test_write_file_maps_artifact_reference_refusal_to_failed_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = _guard(tmp_path)

    class RefusingStore:
        def resolve(self, *_args: object, **_kwargs: object) -> object:
            raise ToolExecutionFailure(
                code=CMP_TOOL_IO_FAILED,
                message="unsafe artifact reference",
                retryable=False,
            )

    refusing_store = RefusingStore()

    def internal_store() -> RefusingStore:
        return refusing_store

    monkeypatch.setattr(workspace, "internal_store", internal_store)

    result = filesystem_module.write_file_tool(
        {
            "path": ".jenny/artifacts/session-123/result.md",
            "content": "safe result",
        },
        workspace,
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert "unsafe artifact reference" in result.output


def test_write_file_returns_no_change_without_checkpoint_when_content_matches(
    tmp_path: Path,
) -> None:
    target = tmp_path / "same.txt"
    target.write_bytes(b"same\n")

    result = filesystem_module.write_file_tool(
        {
            "path": "same.txt",
            "content": "same\n",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "same.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert result.metadata["checkpoint_created"] is False
    assert result.metadata["changed"] is False
    assert "no changes" in result.output.lower()


def test_write_file_surfaces_lock_timeout_as_failed_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    @contextmanager
    def _timeout_lock(*_args, **_kwargs):
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="timed out waiting for file lock: abc.lock",
            retryable=True,
        )
        yield

    monkeypatch.setattr(filesystem_module, "checkpoint_lock_for", _timeout_lock)

    result = filesystem_module.write_file_tool(
        {"path": "notes.txt", "content": "hello\n"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert "timed out" in result.output.lower()


def test_write_file_rejects_parent_symlink_swap_before_mutation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    safe_dir = tmp_path / "safe"
    outside_dir = tmp_path.parent / f"{tmp_path.name}_outside_write"
    safe_dir.mkdir()
    outside_dir.mkdir()

    @contextmanager
    def _swap_parent_to_symlink(*_args, **_kwargs):
        try:
            safe_dir.rmdir()
            safe_dir.symlink_to(outside_dir, target_is_directory=True)
        except (NotImplementedError, OSError):
            pytest.skip("symlink creation unavailable in this environment")
        yield

    monkeypatch.setattr(filesystem_module, "checkpoint_lock_for", _swap_parent_to_symlink)

    result = filesystem_module.write_file_tool(
        {"path": "safe/notes.txt", "content": "secret\n"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert not (outside_dir / "notes.txt").exists()


def test_edit_file_surfaces_lock_timeout_as_failed_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    @contextmanager
    def _timeout_lock(*_args, **_kwargs):
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="timed out waiting for file lock: abc.lock",
            retryable=True,
        )
        yield

    monkeypatch.setattr(edit_module, "checkpoint_lock_for", _timeout_lock)

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "hello",
            "new_string": "world",
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert "timed out" in result.output.lower()


def test_edit_file_rejects_parent_symlink_swap_before_mutation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    safe_dir = tmp_path / "safe"
    outside_dir = tmp_path.parent / f"{tmp_path.name}_outside_edit"
    safe_dir.mkdir()
    outside_dir.mkdir()
    target = safe_dir / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")
    outside_target = outside_dir / "notes.txt"
    outside_target.write_text("hello\n", encoding="utf-8")

    @contextmanager
    def _swap_parent_to_symlink(*_args, **_kwargs):
        try:
            target.unlink()
            safe_dir.rmdir()
            safe_dir.symlink_to(outside_dir, target_is_directory=True)
        except (NotImplementedError, OSError):
            pytest.skip("symlink creation unavailable in this environment")
        yield

    monkeypatch.setattr(edit_module, "checkpoint_lock_for", _swap_parent_to_symlink)

    result = edit_module.edit_file_tool(
        {
            "file_path": "safe/notes.txt",
            "old_string": "hello",
            "new_string": "world",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "safe/notes.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert outside_target.read_text(encoding="utf-8") == "hello\n"


def test_edit_file_without_snapshot_applies_via_content_anchor(tmp_path: Path) -> None:
    """Relaxed contract: with no ``expected_read_snapshot`` (the model never
    read the file, or the read snapshot was invalidated after a write), the
    edit still applies as long as ``old_string`` uniquely matches the current
    file content. This is the case the daily local models could not satisfy."""
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "hello",
            "new_string": "world",
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert target.read_text(encoding="utf-8") == "world\n"
    assert result.metadata["replacements"] == 1
    # Fallback path is observable: the snapshot guarantee was NOT exercised, so
    # the content-anchored match is what protected the write.
    assert result.metadata["read_snapshot_validated"] is False


def test_edit_file_without_snapshot_no_match_returns_structured_error(tmp_path: Path) -> None:
    """Fallback path must still fail loudly (not silently) when the target text
    is absent — a genuinely-stale edit is rejected with an actionable message
    that tells the model how to re-anchor, exactly like the snapshot path."""
    target = tmp_path / "app.py"
    target.write_text(
        "def alpha():\n    return 1\n\n\ndef beta():\n    return compute_total(items)\n",
        encoding="utf-8",
    )

    result = edit_module.edit_file_tool(
        {
            "file_path": "app.py",
            "old_string": "return compute_total(item)",
            "new_string": "return compute_total(items, tax)",
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_EXECUTION_FAILED
    assert "not found" in result.output.lower()
    assert "Closest matching region" in result.output
    # File is untouched — no silent lost update.
    assert "return compute_total(items)" in target.read_text(encoding="utf-8")


def test_edit_file_without_snapshot_ambiguous_match_requires_replace_all(tmp_path: Path) -> None:
    """Fallback path preserves the uniqueness guarantee: an ambiguous
    ``old_string`` fails structured rather than editing an arbitrary match."""
    target = tmp_path / "notes.txt"
    target.write_text("aaa bbb aaa\n", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "aaa",
            "new_string": "ccc",
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_EXECUTION_FAILED
    assert result.metadata["occurrences"] == 2
    assert "replace_all" in result.output
    assert target.read_text(encoding="utf-8") == "aaa bbb aaa\n"


def test_edit_file_ignores_malformed_model_supplied_snapshot(tmp_path: Path) -> None:
    """A model that fabricates a garbage ``expected_read_snapshot`` (the
    gpt-oss failure mode) must not be hard-blocked: an unusable snapshot is
    treated as absent and the content-anchored fallback carries the edit."""
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "hello",
            "new_string": "world",
            "expected_read_snapshot": {"path": "notes.txt", "hash": "made-up"},
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert target.read_text(encoding="utf-8") == "world\n"
    assert result.metadata["read_snapshot_validated"] is False


def test_edit_file_rejects_stale_full_read_snapshot(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")
    snapshot = _full_read_snapshot(tmp_path, "notes.txt")
    target.write_text("hello again\n", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "hello again",
            "new_string": "world",
            "expected_read_snapshot": snapshot,
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_STALE_READ_SNAPSHOT
    assert "read the file again" in result.output.lower()


def test_concurrent_edits_reject_stale_snapshot(tmp_path: Path) -> None:
    """Two workers racing on the same file: exactly one wins, the other
    is rejected with CMP_TOOL_STALE_READ_SNAPSHOT.

    Both workers capture ``expected_read_snapshot`` before either
    acquires the per-file lock, so they hold identical "expected"
    hashes.  The first to acquire the lock writes successfully; by the
    time the second acquires the lock the on-disk file no longer
    matches the snapshot, and the stale-read guard fires."""

    target = tmp_path / "notes.txt"
    target.write_text("hello world\n", encoding="utf-8")

    snapshot_a = _full_read_snapshot(tmp_path, "notes.txt")
    snapshot_b = _full_read_snapshot(tmp_path, "notes.txt")
    assert snapshot_a == snapshot_b

    def _attempt(new_string: str, snapshot: dict[str, object]):
        return edit_module.edit_file_tool(
            {
                "file_path": "notes.txt",
                "old_string": "world",
                "new_string": new_string,
                "expected_read_snapshot": snapshot,
            },
            _guard(tmp_path),
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        future_a = pool.submit(_attempt, "earth", snapshot_a)
        future_b = pool.submit(_attempt, "mars", snapshot_b)
        result_a = future_a.result(timeout=10)
        result_b = future_b.result(timeout=10)

    successes = [r for r in (result_a, result_b) if r.success]
    failures = [r for r in (result_a, result_b) if not r.success]

    assert len(successes) == 1, f"expected exactly one winner, got {len(successes)}"
    assert len(failures) == 1
    assert failures[0].error_code == CMP_TOOL_STALE_READ_SNAPSHOT
    assert "read the file again" in failures[0].output.lower()

    final = target.read_text(encoding="utf-8")
    assert final in ("hello earth\n", "hello mars\n")


def test_edit_file_delete_line_consumes_trailing_newline(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("alpha\nbeta\n", encoding="utf-8", newline="")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "beta",
            "new_string": "",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "notes.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert target.read_bytes().decode("utf-8") == "alpha\n"


def test_edit_file_supports_utf8_non_ascii_text(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("Hello 你好 🌍\n", encoding="utf-8", newline="")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "你好",
            "new_string": "世界",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "notes.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert target.read_bytes().decode("utf-8") == "Hello 世界 🌍\n"


def test_edit_file_rejects_invalid_utf8_surrogate_replacement(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "hello",
            "new_string": "world\udc8f",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "notes.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_EXECUTION_FAILED
    assert "utf-8" in result.output.lower()
    assert target.read_text(encoding="utf-8") == "hello\n"


def test_write_file_requires_full_read_snapshot_for_existing_files(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("before\n", encoding="utf-8")

    result = filesystem_module.write_file_tool(
        {"path": "notes.txt", "content": "after\n"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_READ_SNAPSHOT_REQUIRED
    assert "read_file" in result.output
    assert target.read_text(encoding="utf-8") == "before\n"
    backups = list((tmp_path / ".jenny" / "backups").glob("*@v*.bak"))
    assert backups == []


def test_write_file_rejects_stale_full_read_snapshot(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("before\n", encoding="utf-8")
    snapshot = _full_read_snapshot(tmp_path, "notes.txt")
    target.write_text("changed\n", encoding="utf-8")

    result = filesystem_module.write_file_tool(
        {
            "path": "notes.txt",
            "content": "after\n",
            "expected_read_snapshot": snapshot,
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_STALE_READ_SNAPSHOT
    assert "read the file again" in result.output.lower()
    backups = list((tmp_path / ".jenny" / "backups").glob("*@v*.bak"))
    assert backups == []


def test_write_file_rejects_existing_binary_file_before_checkpoint(tmp_path: Path) -> None:
    target = tmp_path / "blob.bin"
    target.write_bytes(b"\x00binary")

    result = filesystem_module.write_file_tool(
        {"path": "blob.bin", "content": "hello\n"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert "binary" in result.output.lower()
    assert target.read_bytes() == b"\x00binary"
    backups = list((tmp_path / ".jenny" / "backups").glob("*@v*.bak"))
    assert backups == []


def test_write_file_rejects_existing_oversized_file_before_checkpoint(tmp_path: Path) -> None:
    filesystem_module.configure_filesystem_tools({"tools_max_edit_file_bytes": 8})
    target = tmp_path / "notes.txt"
    target.write_text("123456789\n", encoding="utf-8")

    result = filesystem_module.write_file_tool(
        {"path": "notes.txt", "content": "after\n"},
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert "byte limit" in result.output.lower()
    backups = list((tmp_path / ".jenny" / "backups").glob("*@v*.bak"))
    assert backups == []


def test_write_file_preserves_existing_mode_bits(tmp_path: Path) -> None:
    target = tmp_path / "script.sh"
    target.write_text("echo old\n", encoding="utf-8", newline="")
    os.chmod(target, 0o744)
    before_mode = stat.S_IMODE(target.stat().st_mode)
    snapshot = _full_read_snapshot(tmp_path, "script.sh")

    result = filesystem_module.write_file_tool(
        {
            "path": "script.sh",
            "content": "echo new\n",
            "expected_read_snapshot": snapshot,
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert stat.S_IMODE(target.stat().st_mode) == before_mode


def test_create_checkpoint_skips_unchanged_file(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    first = file_history_module.create_checkpoint(target, tmp_path)
    second = file_history_module.create_checkpoint(target, tmp_path)

    backups = list((tmp_path / ".jenny" / "backups").glob("*@v*.bak"))
    assert first.created is True
    assert second.created is False
    assert len(backups) == 1


def test_create_checkpoint_eviction_removes_oldest_snapshots(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(file_history_module, "MAX_BACKUP_SNAPSHOTS", 2)

    first_file = tmp_path / "one.txt"
    second_file = tmp_path / "two.txt"
    third_file = tmp_path / "three.txt"
    first_file.write_text("one\n", encoding="utf-8")
    second_file.write_text("two\n", encoding="utf-8")
    third_file.write_text("three\n", encoding="utf-8")

    first = file_history_module.create_checkpoint(first_file, tmp_path)
    second = file_history_module.create_checkpoint(second_file, tmp_path)
    assert first.display_path is not None
    assert second.display_path is not None
    first_snapshot = _relative_metadata_path(tmp_path, first.display_path)
    second_snapshot = _relative_metadata_path(tmp_path, second.display_path)
    # Recent-but-ordered mtimes: this test pins COUNT-quota ordering, so the
    # ages stay inside MAX_BACKUP_AGE_DAYS (WIDE-044 added an age quota that
    # would otherwise also fire on epoch-era timestamps).
    now = time.time()
    os.utime(first_snapshot, (now - 200, now - 200))
    os.utime(second_snapshot, (now - 100, now - 100))
    third = file_history_module.create_checkpoint(third_file, tmp_path)

    backups = sorted((tmp_path / ".jenny" / "backups").glob("*@v*.bak"))
    assert third.created is True
    assert len(backups) == 2
    assert first_snapshot.exists() is False


def test_create_checkpoint_uses_monotonic_version_when_metadata_is_corrupt(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")
    paths = file_history_module.checkpoint_paths_for(target, tmp_path)
    backup_root = tmp_path / ".jenny" / "backups"
    backup_root.mkdir(parents=True, exist_ok=True)
    existing_snapshot = backup_root / f"{paths.file_hash}@v3.bak"
    existing_snapshot.write_text("older snapshot\n", encoding="utf-8")
    (backup_root / f"{paths.file_hash}.json").write_text("{not-json", encoding="utf-8")

    checkpoint = file_history_module.create_checkpoint(target, tmp_path)

    assert checkpoint.created is True
    assert checkpoint.version == 4
    assert checkpoint.display_path is not None
    checkpoint_path = _relative_metadata_path(tmp_path, checkpoint.display_path)
    assert checkpoint_path.name.endswith("@v4.bak")
    assert existing_snapshot.exists() is True


def test_create_checkpoint_ignores_oversized_metadata(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")
    paths = file_history_module.checkpoint_paths_for(target, tmp_path)
    metadata_path = tmp_path / ".jenny" / "backups" / f"{paths.file_hash}.json"
    metadata_path.parent.mkdir(parents=True)
    metadata_path.write_text('"' + ("x" * (1024 * 1024 + 1)) + '"', encoding="utf-8")

    checkpoint = file_history_module.create_checkpoint(target, tmp_path)

    assert checkpoint.created is True
    assert checkpoint.version == 1


def test_create_checkpoint_ignores_malformed_snapshot_display_path(tmp_path: Path) -> None:
    # WIDE-044 format 2: the persisted pointer is `snapshot_name` (relative,
    # versioned). A hostile/traversal value must never be honored as a skip
    # justification — the safe direction is a fresh backup.
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")
    first = file_history_module.create_checkpoint(target, tmp_path)
    assert first.version == 1
    paths = file_history_module.checkpoint_paths_for(target, tmp_path)
    metadata_path = tmp_path / ".jenny" / "backups" / f"{paths.file_hash}.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["last_snapshot"]["snapshot_name"] = "../trash/escape.bak"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    checkpoint = file_history_module.create_checkpoint(target, tmp_path)

    assert checkpoint.created is True
    assert checkpoint.version == 2


def test_create_checkpoint_clamps_untrusted_latest_version(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")
    paths = file_history_module.checkpoint_paths_for(target, tmp_path)
    metadata_path = tmp_path / ".jenny" / "backups" / f"{paths.file_hash}.json"
    metadata_path.parent.mkdir(parents=True)
    metadata_path.write_text(
        json.dumps({"latest_version": 10**100}),
        encoding="utf-8",
    )

    checkpoint = file_history_module.create_checkpoint(target, tmp_path)

    assert checkpoint.created is True
    assert checkpoint.version == 1
def test_no_match_reports_prefix_difference_and_line_ending_diagnosis(tmp_path: Path) -> None:
    path = tmp_path / "sample.txt"
    path.write_text("alpha beta gamma\nnext\n", encoding="utf-8")

    result = edit_module.edit_file_tool(
        {
            "file_path": "sample.txt",
            "old_string": "alpha beta delta\r\nnext",
            "new_string": "replacement",
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert "Matched prefix:" in result.output
    assert "First difference" in result.output
    assert "line_ending_only=false" in result.output
