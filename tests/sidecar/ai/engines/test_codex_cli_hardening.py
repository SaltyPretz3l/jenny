"""Codex CLI transport hardening: oversized records, malformed envelopes, LF framing, teardown."""

from __future__ import annotations

import io
import json
import os
import signal
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.engines import codex_cli
from sidecar.ai.engines.codex_cli import CodexCliEngine, CodexCliProcessResult


def _chunks(data: bytes, size: int) -> list[bytes]:
    return [data[index : index + size] for index in range(0, len(data), size)]


def test_tripwire_trips_on_an_oversized_tool_record_split_into_reader_chunks() -> None:
    record = json.dumps({
        "type": "item.started",
        "item": {"type": "command_execution", "command": "x" * (1_150 * 1024)},
    }).encode("utf-8") + b"\n"
    assert len(record) > 1024 * 1024
    tripwire = codex_cli._ToolEventTripwire.create()
    pieces = _chunks(record, codex_cli._PIPE_READ_CHUNK_BYTES)
    for piece in pieces[:-1]:
        tripwire.feed(piece)
        assert tripwire.tripped is False, "nothing trips before the record completes"
    tripwire.feed(pieces[-1])
    assert tripwire.tripped is True
    assert tripwire.marker


def test_unterminated_record_past_the_stdout_limit_fails_closed_through_the_capture() -> None:
    limit = codex_cli._MAX_CODEX_OUTPUT_BYTES // 2
    capture = codex_cli._BoundedPipeCapture.create(limit)
    tripwire = codex_cli._ToolEventTripwire.create()
    payload = b'{"type":"item.started","item":{"type":"command_execution","command":"'
    payload += b"y" * (limit + 1)
    reader = codex_cli._start_pipe_reader(io.BytesIO(payload), capture, "stdout", tripwire=tripwire)
    reader.join(timeout=10)
    assert not reader.is_alive()
    # The session aborts on an exceeded capture, so the tripwire never has to
    # parse a record it could not hold; its own buffer stays at the same bound.
    assert capture.exceeded is True
    assert len(tripwire.pending) <= limit


_LIST_DIR_TOOL = {"name": "list_dir", "parameters": {"type": "object"}}


def _agent_reply(text: str) -> str:
    return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n"


def _engine_replying(tmp_path: Path, text: str) -> tuple[CodexCliEngine, list[list[str]]]:
    seen: list[list[str]] = []

    def run_process(**kwargs: Any) -> CodexCliProcessResult:
        seen.append(list(kwargs["args"]))
        return CodexCliProcessResult(exit_code=0, stdout=_agent_reply(text))

    return CodexCliEngine(command="codex", runtime_root=tmp_path, run_process=run_process), seen


@pytest.mark.parametrize(
    "reply",
    [
        '{"message":"I will call list_dir({}) later", "tool_calls": [',
        '{"message":"I will call list_dir({}) later", "tool_calls": null}',
        # Astra w2b R1: escaped key spellings decode to the envelope keys; an array root too.
        '{"\\u006dessage":"I will call list_dir({}) later","\\u0074ool_calls":null}',
        '[{"message":"I will call list_dir({}) later","tool_calls":null}]',
    ],
)
def test_malformed_structured_envelope_never_turns_message_text_into_calls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, reply: str,
) -> None:
    monkeypatch.delenv("JENNY_ENABLE_CODEX_STRUCTURED_TOOLS", raising=False)
    engine, seen = _engine_replying(tmp_path, reply)

    result = engine.generate_with_tools(prompt="List", tools=[_LIST_DIR_TOOL])
    _chunks_out, streamed = _drain(engine.stream_with_tools(prompt="List", tools=[_LIST_DIR_TOOL]))

    assert "--output-schema" in seen[0]
    for outcome in (result, streamed):
        assert outcome.tool_calls == ()
        assert outcome.finish_reason == "stop"
        assert outcome.inband_tool_call_parse_failed is True
        diagnostics = outcome.tool_call_parse_diagnostics
        assert diagnostics["transport"] == "structured"
        assert [entry["reason"] for entry in diagnostics["entries"]] == ["malformed_envelope"]
        assert "list_dir({})" not in json.dumps(diagnostics)


def test_plain_text_reply_under_the_schema_still_uses_the_text_bridge(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("JENNY_ENABLE_CODEX_STRUCTURED_TOOLS", raising=False)
    engine, _seen = _engine_replying(
        tmp_path, '<tool_call>{"name": "list_dir", "arguments": {}}</tool_call>'
    )

    result = engine.generate_with_tools(prompt="List", tools=[_LIST_DIR_TOOL])

    assert [call.tool_id for call in result.tool_calls] == ["list_dir"]


def _drain(generator: Any) -> tuple[list[Any], Any]:
    chunks: list[Any] = []
    while True:
        try:
            chunks.append(next(generator))
        except StopIteration as stop:
            return chunks, stop.value


_SEPARATORS = ("\u2028", "\u2029", "\u0085")


def _raw_jsonl(*events: dict[str, Any]) -> str:
    # ensure_ascii=False keeps the separators literal, as the CLI may emit them.
    return "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events)


@pytest.mark.parametrize("separator", _SEPARATORS)
def test_unicode_line_separators_inside_jsonl_strings_keep_their_records(separator: str) -> None:
    from sidecar.ai.engines import codex_cli_transport as transport

    envelope = {
        "message": f"first{separator}second",
        "tool_calls": [{"name": "read_file", "arguments_json": json.dumps({"path": f"a{separator}b"})}],
    }
    stdout = _raw_jsonl(
        {"type": "thread.started", "thread_id": "t1"},
        {"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps(envelope, ensure_ascii=False)}},
        {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}},
    )
    assert separator in stdout

    parts = transport._agent_message_parts(stdout)
    result = transport._structured_result(parts, ["read_file"])

    assert result is not None
    assert result.content == f"first{separator}second"
    assert [(call.tool_id, call.arguments) for call in result.tool_calls] == [
        ("read_file", {"path": f"a{separator}b"})
    ]
    assert transport._jsonl_event_counts(stdout) == {
        "thread.started": 1, "item.completed:agent_message": 1, "turn.completed": 1,
    }


class _GroupDouble:
    """A root that exits on SIGTERM beside a group member that ignores it."""

    def __init__(self) -> None:
        self.signals: list[int] = []
        self.root_alive = True
        self.member_alive = True
        self.pid = 4242

    def killpg(self, pid: int, sig: int) -> None:
        assert pid == self.pid
        self.signals.append(sig)
        if sig == signal.SIGTERM:
            self.root_alive = False  # the member traps SIGTERM and survives
        elif sig == getattr(signal, "SIGKILL", None):
            self.root_alive = self.member_alive = False

    def group_exists(self, group_id: int) -> bool:
        assert group_id == self.pid
        return self.root_alive or self.member_alive

    # Popen surface used by the teardown.
    def poll(self) -> int | None:
        return None if self.root_alive else -15

    def terminate(self) -> None:
        self.root_alive = False

    def wait(self, timeout: float | None = None) -> int:
        return -15

    def kill(self) -> None:
        self.root_alive = False


def test_posix_teardown_kills_a_sigterm_resistant_member_after_the_root_exits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not hasattr(signal, "SIGKILL"):
        monkeypatch.setattr(signal, "SIGKILL", 9, raising=False)
    double = _GroupDouble()
    fake_os = SimpleNamespace(**{**vars(os), "name": "posix", "killpg": double.killpg})
    monkeypatch.setattr(codex_cli, "os", fake_os)
    monkeypatch.setattr(codex_cli, "posix_process_group_exists", double.group_exists, raising=False)

    started = time.monotonic()
    thread = codex_cli._terminate_codex_tree(double, None, wait=False)  # type: ignore[arg-type]
    returned_after = time.monotonic() - started

    # The cancel callback runs under the dispatch lock: the grace wait is off-thread (Astra w2b R3).
    assert thread is not None, "wait=False hands the group escalation to a thread"
    assert returned_after < codex_cli._POSIX_GROUP_GRACE_SECONDS, "cancel must not wait out the grace"
    thread.join(timeout=3.0)
    assert not thread.is_alive(), "the escalation is bounded"
    assert double.signals[0] == signal.SIGTERM
    assert signal.SIGKILL in double.signals, "the surviving member must get group SIGKILL"
    assert double.member_alive is False


@pytest.mark.slow
@pytest.mark.skipif(os.name != "posix", reason="POSIX process groups only")
def test_posix_timeout_reaps_a_sigterm_resistant_child_of_a_clean_root(tmp_path: Path) -> None:
    pid_file = tmp_path / "child.pid"
    child = "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
    script = (
        "import subprocess, sys, time\n"
        f"proc = subprocess.Popen([sys.executable, '-c', {child!r}])\n"
        f"open({str(pid_file)!r}, 'w').write(str(proc.pid))\n"
        "sys.stdin.read()\n"
        "time.sleep(60)\n"
    )
    with pytest.raises(RuntimeError, match="timed out"):
        codex_cli._run_codex_process(
            command=sys.executable, args=["-c", script], input_text="prompt",
            cwd=tmp_path, timeout_seconds=2,
        )
    child_pid = int(pid_file.read_text())
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        os.kill(child_pid, signal.SIGKILL)
        pytest.fail("the SIGTERM-resistant child outlived the teardown")
