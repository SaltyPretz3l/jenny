"""W2-32-F07: argparse's --permission-mode=value form must count as explicit.

Pre-fix, only the exact "--permission-mode" token was detected, so a
conflicting alias flag silently overrode an equals-form explicit mode
instead of failing the conflict check.
"""

from __future__ import annotations

import pytest

from sidecar.runtime import headless


def test_equals_form_counts_as_explicit() -> None:
    assert headless.permission_mode_flag_present(["--permission-mode=prompt"])
    assert headless.permission_mode_flag_present(["--permission-mode", "prompt"])
    assert not headless.permission_mode_flag_present(["--prompt", "--permission-modes"])


def test_equals_form_conflicts_with_alias_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[object] = []
    monkeypatch.setattr(headless, "run_headless_from_args", lambda args: calls.append(args) or 0)

    with pytest.raises(SystemExit):
        headless.run_headless(
            [
                "--prompt",
                "hello",
                "--permission-mode=prompt",
                "--auto-approve-readonly",
            ]
        )
    assert calls == []


def test_space_form_conflict_still_detected(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[object] = []
    monkeypatch.setattr(headless, "run_headless_from_args", lambda args: calls.append(args) or 0)

    with pytest.raises(SystemExit):
        headless.run_headless(
            [
                "--prompt",
                "hello",
                "--permission-mode",
                "prompt",
                "--auto-approve-readonly",
            ]
        )
    assert calls == []
