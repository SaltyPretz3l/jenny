"""Bounded context reads: a non-regular workspace entry is rejected before any open."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from sidecar.ai.context.context_io import read_bounded_context_text


def test_non_regular_entry_is_rejected_before_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A directory stands in for a FIFO (which would block the open on POSIX):
    # the stat already says "not a regular file", so no open may happen.
    target = tmp_path / "agentj.md"
    target.mkdir()
    opened: list[str] = []
    real_open = os.open

    def spy(path: object, *args: object, **kwargs: object) -> int:
        opened.append(str(path))
        return real_open(path, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(os, "open", spy)

    result = read_bounded_context_text(
        target, authorized_root=tmp_path, max_bytes=1024, truncate=True
    )

    assert result.text is None
    assert result.reason == "not_regular_file"
    assert opened == []
