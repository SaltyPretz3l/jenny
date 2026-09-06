from __future__ import annotations

import io

import pytest

from sidecar.runtime import monitor_manager_streaming


def test_monitor_stream_reader_rejects_never_newline_output_at_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(monitor_manager_streaming, "_MAX_MONITOR_STREAM_LINE_UNITS", 32)

    with pytest.raises(RuntimeError, match="configured limit"):
        monitor_manager_streaming._read_monitor_line(io.BytesIO(b"x" * 33))  # noqa: SLF001

