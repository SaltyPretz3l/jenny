from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.repo_delta.git_delta import run_git


def test_run_git_preserves_raw_stdout_bytes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    raw_stdout = b"\xff\x00M\x00name"

    def run(*_args: object, **kwargs: Any) -> SimpleNamespace:
        on_output_chunk = kwargs.get("on_output_chunk")
        if on_output_chunk is not None:
            on_output_chunk("stdout", raw_stdout)
        return SimpleNamespace(
            timed_out=False,
            aborted=False,
            output=SimpleNamespace(truncated=False),
            returncode=0,
            stdout=raw_stdout.decode("utf-8", errors="replace"),
        )

    monkeypatch.setattr(
        "sidecar.ai.repo_delta.git_delta.get_owned_process_service",
        lambda: SimpleNamespace(run=run),
    )

    result = run_git(tmp_path, "status", "--porcelain=v1", "-z")

    assert result.stdout == raw_stdout
