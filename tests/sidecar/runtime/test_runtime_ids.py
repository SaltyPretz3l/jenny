from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.runtime.runtime_ids import (
    GuardedRuntimeDirectory,
    RuntimeIdError,
    new_monitor_id,
    parse_monitor_id,
    parse_session_id,
)


@pytest.mark.parametrize(
    "value",
    [
        "",
        ".",
        "..",
        "../escape",
        "..\\escape",
        "/absolute",
        "C:\\absolute",
        "\\\\server\\share",
        "nested/session",
        "nested\\session",
        "control\x00value",
        "x" * 129,
        7,
        None,
    ],
)
def test_parse_session_id_rejects_noncanonical_values(value: object) -> None:
    with pytest.raises(RuntimeIdError, match="session_id"):
        parse_session_id(value)


@pytest.mark.parametrize("value", ["session-123", "abc_DEF.456", "a", "  session  "])
def test_parse_session_id_returns_one_canonical_segment(value: str) -> None:
    assert parse_session_id(value) == value.strip()


@pytest.mark.parametrize(
    "value",
    [
        "",
        "mon_123",
        "mon_ABCDEF012345",
        "mon_abcdef012345/../outside",
        "mon_abcdef012345\\outside",
        "/mon_abcdef012345",
        "C:\\mon_abcdef012345",
        "\\\\server\\mon_abcdef012345",
        1,
        None,
    ],
)
def test_parse_monitor_id_rejects_noncanonical_values(value: object) -> None:
    with pytest.raises(RuntimeIdError, match="monitor_id"):
        parse_monitor_id(value)


def test_new_monitor_id_always_parses() -> None:
    generated = {new_monitor_id() for _ in range(32)}
    assert len(generated) == 32
    assert all(parse_monitor_id(value) == value for value in generated)


def test_child_directory_accepts_a_concurrent_creator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two ledger writers can both miss the directory and race to create it; the
    loser must reuse the winner's directory, not fail the whole write."""
    root = GuardedRuntimeDirectory.create_trusted_root(tmp_path / "root")
    real_mkdir = Path.mkdir

    def mkdir_after_another_process(self: Path, *args: object, **kwargs: object) -> None:
        real_mkdir(self)
        raise FileExistsError(17, "created by another process", str(self))

    monkeypatch.setattr(Path, "mkdir", mkdir_after_another_process)

    child = root.child_directory("operations", create=True)

    assert child is not None
    assert child.path == (tmp_path / "root" / "operations").resolve()
