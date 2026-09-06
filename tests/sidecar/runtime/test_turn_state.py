from __future__ import annotations

import pytest

from sidecar.runtime.turn_state import (
    TERMINAL_SUBCODE_COMPLETED_ASSISTANT_RESPONSE,
    TERMINAL_SUBCODE_DENIED_POLICY_DANGEROUS_TOOL,
    TERMINAL_SUBCODE_DENIED_USER_EXPLICIT,
    TURN_STATE_COMPLETED,
    TURN_STATE_DENIED,
    TURN_STATE_TIMEOUT,
    normalize_terminal_subcode,
)


def test_denied_terminal_subcodes_are_preserved() -> None:
    assert (
        normalize_terminal_subcode(TURN_STATE_DENIED, TERMINAL_SUBCODE_DENIED_USER_EXPLICIT)
        == TERMINAL_SUBCODE_DENIED_USER_EXPLICIT
    )
    assert (
        normalize_terminal_subcode(
            TURN_STATE_DENIED,
            TERMINAL_SUBCODE_DENIED_POLICY_DANGEROUS_TOOL,
        )
        == TERMINAL_SUBCODE_DENIED_POLICY_DANGEROUS_TOOL
    )


def test_terminal_subcode_must_match_terminal_state() -> None:
    with pytest.raises(ValueError, match="Unknown terminal subcode"):
        normalize_terminal_subcode(TURN_STATE_TIMEOUT, TERMINAL_SUBCODE_DENIED_USER_EXPLICIT)


def test_completed_terminal_state_ignores_empty_subcode() -> None:
    assert normalize_terminal_subcode(TURN_STATE_COMPLETED, None) is None


def test_completed_terminal_subcode_is_preserved() -> None:
    assert (
        normalize_terminal_subcode(
            TURN_STATE_COMPLETED,
            TERMINAL_SUBCODE_COMPLETED_ASSISTANT_RESPONSE,
        )
        == TERMINAL_SUBCODE_COMPLETED_ASSISTANT_RESPONSE
    )
