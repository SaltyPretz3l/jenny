"""The background-job registry can be read per workspace store (B3S-4)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import shell, shell_background, shell_settings


@pytest.mark.parametrize("enabled", [True, False])
def test_harness_background_spawn_environment(monkeypatch, tmp_path, enabled):
    saved = dict(shell_settings._FEATURE_FLAGS)
    calls = []
    def spawn(*args, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(process=object())
    monkeypatch.setattr(shell_background._owned_process, "get_owned_process_service",
                        lambda: SimpleNamespace(spawn=spawn))
    monkeypatch.setenv("GIT_EDITOR", "code --wait")
    try:
        shell_settings.configure_shell_security({"shell_noninteractive_env": enabled})
        shell_background._spawn_background_process(["fixture"], cwd=tmp_path)
        if enabled:
            assert calls[0]["env"]["GIT_EDITOR"] == "false"
            assert calls[0]["env"] == shell._shell_environment()
        else:
            assert calls[0]["env"] is None
    finally:
        shell_settings.configure_shell_security(saved)


@pytest.mark.parametrize("enabled", [True, False])
@pytest.mark.parametrize("failed", [True, False])
def test_harness_background_output_edges_fit_status_schema(tmp_path, enabled, failed):
    saved = dict(shell_settings._FEATURE_FLAGS)
    text = "FIRST\n" + "x" * 30_000 + "\nLAST"
    store = shell_background.GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(shell_background.WorkspaceStoreKind.TOOL_RESULTS, "abc123abc123")
    try:
        shell_settings.configure_shell_security({"shell_head_tail_output": enabled})
        status = shell_background._build_terminal_status(
            job_id="abc123abc123", state="failed" if failed else "completed",
            exit_code=1 if failed else 0, stdout=text, stderr="",
            store=store, job_ref=ref,
        )
        assert status["stdout"].startswith("FIRST\n")
        assert status["stdout"].endswith("\nLAST") is enabled
        if enabled:
            marker = f"\n...[middle truncated; full output: {status['full_output_path']}]\n"
            head, tail = status["stdout"].split(marker)
            ratio = 0.3 if failed else 0.7
            assert len(head) == int((len(head) + len(tail)) * ratio)
        else:
            assert status["stdout"] == text[:20_000] + "\n...[truncated]"
        assert shell_background._write_status(store, ref, status)
        loaded = shell_background.read_background_job(tmp_path, "abc123abc123")
        assert loaded["stdout"] == status["stdout"]
        assert "LAST" in Path(loaded["full_output_path"]).read_text(encoding="utf-8")
    finally:
        shell_settings.configure_shell_security(saved)


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
