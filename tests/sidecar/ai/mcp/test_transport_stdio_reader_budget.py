"""Row 53 S3: third-party stdout line cap and the aggregate reader-queue budget."""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from typing import Callable

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.mcp import transport_stdio
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.transport_stdio import StdioMCPTransport
from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME

FIVE_MIB = 5 * 1024 * 1024

_STUB_SERVER = """\
import json, sys
mode = sys.argv[1]
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if method == 'initialize':
        result = {'protocolVersion': '2025-03-26', 'capabilities': {}}
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
    elif method == 'tools/call':
        if mode == 'flood':
            count, size = int(sys.argv[2]), int(sys.argv[3])
            for index in range(count):
                params = {'request_id': request['id'], 'sequence': index,
                          'lines': [{'stream': 'stdout', 'text': 'y' * size}]}
                sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'method': 'tool/output_chunk',
                                             'params': params}) + '\\n')
            sys.stdout.flush()
            text = 'done'
        else:
            text = 'x' * int(sys.argv[2])
        result = {'content': [{'type': 'text', 'text': text}]}
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
"""


def _stub_transport(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    name: str,
    args: tuple[str, ...],
) -> StdioMCPTransport:
    script = tmp_path / "budget_stub.py"
    script.write_text(_STUB_SERVER, encoding="utf-8")
    monkeypatch.setattr(transport_stdio, "_validate_stdio_command", lambda _config: None)
    return StdioMCPTransport(
        MCPServerConfig(
            name=name,
            transport="stdio",
            command=sys.executable,
            args=("-u", str(script), *args),
        ),
        request_timeout_seconds=60.0,
    )


def test_external_server_delivers_a_five_mib_single_line_reply_intact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # rea admits replies up to ~10 MiB; a 4-10 MiB line killed the server before.
    transport = _stub_transport(
        tmp_path, monkeypatch, name="rea", args=("reply", str(FIVE_MIB))
    )
    try:
        result = transport.call_tool("big", {})
        assert result["content"][0]["text"] == "x" * FIVE_MIB
        assert transport.is_terminated is False
    finally:
        transport.close()


def test_builtin_server_keeps_its_four_mib_line_contract(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    transport = _stub_transport(
        tmp_path, monkeypatch, name=BUILTIN_MCP_SERVER_NAME, args=("reply", str(FIVE_MIB))
    )
    process = transport._process
    try:
        with pytest.raises(MCPError) as raised:
            transport.call_tool("big", {})
        assert "exceeded its configured limit" in raised.value.message
        process.wait(timeout=5.0)
        assert process.poll() is not None
    finally:
        transport.close()


def test_reader_budget_bounds_queued_text_and_the_producer_still_completes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    budget_chars = 64 * 1024
    chunk_count = 120
    monkeypatch.setattr(transport_stdio, "MCP_READER_QUEUE_MAX_BYTES", budget_chars)
    transport = _stub_transport(
        tmp_path, monkeypatch, name="rea", args=("flood", str(chunk_count), str(8 * 1024))
    )
    seen: list[int] = []

    def slow_consumer(params: dict[str, object]) -> None:
        seen.append(int(params["sequence"]))  # type: ignore[call-overload]
        time.sleep(0.005)

    try:
        result = transport.call_tool("flood", {}, on_output_chunk=slow_consumer)
        peak = transport._reader_budget.peak
        assert result["content"][0]["text"] == "done"
        assert seen == list(range(chunk_count))
        assert peak <= budget_chars
        # The producer outran the consumer, so the budget actually held it back.
        assert peak > budget_chars // 2
        assert transport.is_terminated is False
    finally:
        transport.close()


def test_closing_a_transport_releases_a_reader_blocked_on_the_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    budget_chars = 16 * 1024
    monkeypatch.setattr(transport_stdio, "MCP_READER_QUEUE_MAX_BYTES", budget_chars)
    transport = _stub_transport(
        tmp_path, monkeypatch, name="rea", args=("flood", "200", str(8 * 1024))
    )
    consumer_parked = threading.Event()
    release_consumer = threading.Event()

    def parked_consumer(_params: dict[str, object]) -> None:
        consumer_parked.set()
        release_consumer.wait(timeout=10.0)

    caller = threading.Thread(
        target=_swallow,
        args=(lambda: transport.call_tool("flood", {}, on_output_chunk=parked_consumer),),
        daemon=True,
    )
    caller.start()
    try:
        assert consumer_parked.wait(timeout=10.0)
        # With the only consumer parked, the reader fills the budget and blocks.
        deadline = time.monotonic() + 5.0
        while transport._reader_budget.peak < budget_chars // 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.2)
        assert transport._reader_thread.is_alive()
        assert transport.is_terminated is False

        transport.close()
        transport._reader_thread.join(timeout=2.0)

        assert not transport._reader_thread.is_alive()
        assert transport._reader_budget.peak <= budget_chars
    finally:
        release_consumer.set()
        transport.close()
        caller.join(timeout=10.0)


def _swallow(call: Callable[[], object]) -> None:
    try:
        call()
    except MCPError:
        pass


def test_reader_budget_blocks_until_release_and_admits_an_oversize_line_alone() -> None:
    from sidecar.ai.mcp.transport_stdio_reader import ReaderBudget

    budget = ReaderBudget(100)
    assert budget.reserve(60, timeout=0.01) is True
    assert budget.reserve(60, timeout=0.01) is False
    threading.Timer(0.05, budget.release, args=(60,)).start()
    assert budget.reserve(60, timeout=2.0) is True
    budget.release(60)
    assert budget.reserve(500, timeout=0.01) is True
    assert budget.reserve(1, timeout=0.01) is False
    budget.release(500)
    assert budget.peak == 500


def test_line_caps_split_builtin_and_third_party_servers() -> None:
    from sidecar.ai.mcp import transport_stdio_reader as reader

    assert reader.max_stdout_line_chars(BUILTIN_MCP_SERVER_NAME) == 4 * 1024 * 1024
    assert reader.max_stdout_line_chars("rea") == 16 * 1024 * 1024
    assert reader.MCP_READER_QUEUE_MAX_BYTES == 32 * 1024 * 1024
    # Charged in string storage: a non-BMP line costs its real size, not its length.
    assert reader.ReaderBudget.cost("\U0001f600" * 1024) >= 4 * 1024
    assert reader.ReaderBudget.cost("a" * 1024) >= 1024
    assert reader.ReaderBudget.cost(object()) == 0
    assert transport_stdio.MCP_MAX_STDOUT_LINE_CHARS == 4 * 1024 * 1024
