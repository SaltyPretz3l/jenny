"""Wire encoding must not depend on a frozen interpreter's environment support."""
import io
import sys

import pytest

from sidecar.ai.mcp.builtin_server import _write_response
from sidecar.ai.mcp.builtin_server_io import configure_stdio


def test_cp1252_streams_are_reconfigured_without_loss(monkeypatch):
    text = "\u2192 caf\u00e9 \u4e2d\u6587 \U0001f642"
    source = io.TextIOWrapper(io.BytesIO((text + "\n").encode()), encoding="cp1252")
    wire = io.BytesIO()
    target = io.TextIOWrapper(wire, encoding="cp1252")
    errors = io.TextIOWrapper(io.BytesIO(), encoding="cp1252")
    monkeypatch.setattr(sys, "stdin", source)
    monkeypatch.setattr(sys, "stdout", target)
    monkeypatch.setattr(sys, "stderr", errors)
    with pytest.raises(UnicodeEncodeError):
        _write_response({"result": text})
    configure_stdio()
    assert source.readline() == text + "\n"
    _write_response({"result": text})
    _write_response({"method": "tool/output_chunk", "params": {"text": text}})
    _write_response({"result": "still alive"})
    assert wire.getvalue().decode().count(text) == 2
    assert "still alive" in wire.getvalue().decode()
    assert errors.errors == "backslashreplace"


def test_text_only_test_streams_need_no_reconfiguration(monkeypatch):
    for name in ("stdin", "stdout", "stderr"):
        monkeypatch.setattr(sys, name, io.StringIO())
    configure_stdio()
