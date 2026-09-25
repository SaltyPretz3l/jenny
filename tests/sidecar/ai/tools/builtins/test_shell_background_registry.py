"""The background-job registry can be read per workspace store (B3S-4)."""

from __future__ import annotations

import pytest

from sidecar.ai.tools.builtins import shell_background


def test_active_job_ids_filters_by_workspace_store_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        shell_background,
        "_active_jobs",
        {"aaaaaaaaaaaa": object(), "bbbbbbbbbbbb": object(), "cccccccccccc": object()},
    )
    monkeypatch.setattr(
        shell_background,
        "_active_job_store_keys",
        {"aaaaaaaaaaaa": "key-a", "bbbbbbbbbbbb": "key-b"},
    )

    assert shell_background.active_job_ids() == ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]
    assert shell_background.active_job_ids(store_key="key-a") == ["aaaaaaaaaaaa"]
    # A job with no recorded owner is never attributed to a workspace.
    assert shell_background.active_job_ids(store_key="key-c") == []
