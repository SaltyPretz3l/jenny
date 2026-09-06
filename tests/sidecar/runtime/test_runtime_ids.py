from __future__ import annotations

import pytest

from sidecar.runtime.runtime_ids import (
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
