from __future__ import annotations

import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.engines import codex_cli
from sidecar.ai.engines.codex_cli import (
    CodexCliEngine,
    CodexCliProcessResult,
    _run_codex_process,
)
from sidecar.runtime.multiplexer import TurnCancellationHandle


def _jsonl(*events: dict[str, Any]) -> str:
    return "\n".join(json.dumps(event) for event in events) + "\n"


def _drain_generator(generator):
    chunks: list[Any] = []
    while True:
        try:
            chunks.append(next(generator))
        except StopIteration as stop:
            return chunks, stop.value


def test_codex_cli_engine_runs_default_model_without_model_override(tmp_path: Path) -> None:
    calls: list[dict[str, Any]] = []

    def run_process(**kwargs: Any) -> CodexCliProcessResult:
        calls.append(kwargs)
        return CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl({"type": "agent_message", "message": "Hello from ChatGPT"}),
            stderr="",
        )

    engine = CodexCliEngine(
        command="codex",
        runtime_root=tmp_path,
        request_timeout_seconds=42,
        run_process=run_process,
    )
    engine.load_model("codex-cli/default")

    result = engine.generate(prompt="Say hello", system="System preface")

    assert result == "Hello from ChatGPT"
    assert len(calls) == 1
    assert calls[0]["command"] == "codex"
    assert calls[0]["cwd"] == tmp_path
    assert calls[0]["timeout_seconds"] == 42
    # F1: the pinned containment profile. Every flag is a Jenny decision the
    # user's ~/.codex/config.toml must not be able to reopen -- the CLI reads
    # that file on every `exec`, so anything not overridden explicitly is
    # whatever the machine happens to be configured for.
    assert calls[0]["args"] == [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--cd",
        str(tmp_path),
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
        "-c",
        "mcp_servers={}",
        "-c",
        "tools.web_search=false",
        "-c",
        'sandbox_mode="read-only"',
        "-",
    ]
    assert "--model" not in calls[0]["args"]
    assert "System preface" in calls[0]["input_text"]
    assert "Say hello" in calls[0]["input_text"]


def test_codex_cli_stream_clamps_process_timeout_to_absolute_deadline(
    tmp_path: Path,
) -> None:
    captured_timeout: list[float] = []

    def run_process(**kwargs: Any) -> CodexCliProcessResult:
        captured_timeout.append(float(kwargs["timeout_seconds"]))
        return CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl({"type": "agent_message", "message": "ok"}),
        )

    engine = CodexCliEngine(
        runtime_root=tmp_path,
        request_timeout_seconds=300,
        run_process=run_process,
    )
    chunks, result = _drain_generator(
        engine.stream_with_tools(
            prompt="hello",
            tools=[],
            wall_clock_deadline=time.monotonic() + 0.04,
        )
    )

    assert chunks == ["ok"]
    assert result.content == "ok"
    assert captured_timeout and captured_timeout[0] <= 0.06


def test_codex_cli_engine_treats_bare_provider_model_as_default(tmp_path: Path) -> None:
    calls: list[dict[str, Any]] = []

    def run_process(**kwargs: Any) -> CodexCliProcessResult:
        calls.append(kwargs)
        return CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl({"type": "agent_message", "message": "Default model ok"}),
            stderr="",
        )

    engine = CodexCliEngine(command="codex", runtime_root=tmp_path, run_process=run_process)
    engine.load_model("codex-cli")

    assert engine.generate(prompt="Use default") == "Default model ok"
    assert "--model" not in calls[0]["args"]


def test_codex_cli_engine_strips_model_prefix_for_custom_model(tmp_path: Path) -> None:
    calls: list[dict[str, Any]] = []

    def run_process(**kwargs: Any) -> CodexCliProcessResult:
        calls.append(kwargs)
        return CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl({"type": "agent_message", "content": "Custom model ok"}),
            stderr="",
        )

    engine = CodexCliEngine(command="codex", runtime_root=tmp_path, run_process=run_process)
    engine.load_model("codex-cli/gpt-5.5")

    assert engine.generate(prompt="Use custom") == "Custom model ok"
    model_index = calls[0]["args"].index("--model")
    assert calls[0]["args"][model_index + 1] == "gpt-5.5"


def test_codex_cli_engine_forwards_supported_reasoning_effort_and_omits_default(
    tmp_path: Path,
) -> None:
    calls: list[dict[str, Any]] = []

    def run_process(**kwargs: Any) -> CodexCliProcessResult:
        calls.append(kwargs)
        return CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl({"type": "agent_message", "content": "ok"}),
        )

    engine = CodexCliEngine(command="codex", runtime_root=tmp_path, run_process=run_process)
    assert engine.generate(prompt="deep", reasoning_effort="xhigh") == "ok"
    assert engine.generate(prompt="automatic", reasoning_effort=None) == "ok"

    first_args = calls[0]["args"]
    effort_index = first_args.index("-c", first_args.index('sandbox_mode="read-only"') + 1)
    assert first_args[effort_index + 1] == 'model_reasoning_effort="xhigh"'
    assert not any("model_reasoning_effort" in arg for arg in calls[1]["args"])


def test_codex_cli_engine_extracts_jenny_owned_inband_tool_calls(tmp_path: Path) -> None:
    engine = CodexCliEngine(
        command="codex",
        runtime_root=tmp_path,
        run_process=lambda **_kwargs: CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl(
                {
                    "type": "agent_message",
                    "content": (
                        "I need the file.\n"
                        '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>'
                    ),
                }
            ),
            stderr="",
        ),
    )
    engine.load_model("codex-cli/default")

    result = engine.generate_with_tools(
        prompt="Read README",
        tools=[{"name": "read_file", "parameters": {"type": "object"}}],
    )

    assert engine.supports_inband_tool_calling is True
    assert result.finish_reason == "tool_calls"
    assert result.content == "I need the file."
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_id == "read_file"
    assert result.tool_calls[0].arguments == {"path": "README.md"}


@pytest.mark.parametrize(
    ("content", "expected_failed"),
    [
        ("<tool_call>\n{not valid json}\n</tool_call>", True),
        ("The report mentions read_file(path=README.md) successfully.", False),
    ],
)
def test_codex_cli_engine_reports_only_explicit_inband_parse_failures(
    tmp_path: Path,
    content: str,
    expected_failed: bool,
) -> None:
    engine = CodexCliEngine(
        command="codex",
        runtime_root=tmp_path,
        run_process=lambda **_kwargs: CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl({"type": "agent_message", "content": content}),
            stderr="",
        ),
    )
    engine.load_model("codex-cli/default")

    result = engine.generate_with_tools(
        prompt="Read README",
        tools=[{"name": "read_file", "parameters": {"type": "object"}}],
    )

    assert result.content == content
    assert result.finish_reason == "stop"
    assert result.inband_tool_call_parse_failed is expected_failed


def test_codex_cli_tool_stream_preserves_tool_semantics_and_cancel_handle(
    tmp_path: Path,
) -> None:
    captured: dict[str, Any] = {}

    def run_process(**kwargs: Any) -> CodexCliProcessResult:
        captured.update(kwargs)
        return CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl(
                {
                    "type": "agent_message",
                    "content": (
                        "Checking now.\n"
                        '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}'
                        "</tool_call>"
                    ),
                }
            ),
        )

    engine = CodexCliEngine(command="codex", runtime_root=tmp_path, run_process=run_process)
    cancel_handle = TurnCancellationHandle(request_id="req-codex-tools")
    chunks, result = _drain_generator(
        engine.stream_with_tools(
            prompt="Read README",
            tools=[{"name": "read_file", "parameters": {"type": "object"}}],
            cancel_handle=cancel_handle,
        )
    )

    assert captured["cancel_handle"] is cancel_handle
    assert chunks == ["Checking now."]
    assert result.finish_reason == "tool_calls"
    assert result.tool_calls[0].tool_id == "read_file"


@pytest.mark.slow
def test_codex_cli_process_rejects_output_over_byte_budget(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(codex_cli, "_MAX_CODEX_OUTPUT_BYTES", 1024)

    with pytest.raises(RuntimeError, match="output exceeded"):
        _run_codex_process(
            command=sys.executable,
            args=["-c", "import sys; sys.stdin.read(); sys.stdout.write('x' * 4096)"],
            input_text="prompt",
            cwd=tmp_path,
            timeout_seconds=10,
        )


def test_codex_cli_engine_fails_closed_when_cli_attempts_own_tooling(tmp_path: Path) -> None:
    engine = CodexCliEngine(
        command="codex",
        runtime_root=tmp_path,
        run_process=lambda **_kwargs: CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl({"type": "tool_call", "name": "shell", "arguments": {"cmd": "pwd"}}),
            stderr="",
        ),
    )
    engine.load_model("codex-cli/default")

    with pytest.raises(RuntimeError, match="Codex CLI attempted to use its own tool"):
        engine.generate(prompt="Try tool")


def test_codex_cli_engine_fails_closed_on_nested_cli_tool_events(tmp_path: Path) -> None:
    engine = CodexCliEngine(
        command="codex",
        runtime_root=tmp_path,
        run_process=lambda **_kwargs: CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl(
                {
                    "type": "item.started",
                    "item": {
                        "id": "item_1",
                        "type": "command_execution",
                        "command": "bash -lc ls",
                    },
                }
            ),
            stderr="",
        ),
    )
    engine.load_model("codex-cli/default")

    with pytest.raises(RuntimeError, match="Codex CLI attempted to use its own tool"):
        engine.generate(prompt="Try nested tool")


def test_codex_cli_engine_only_uses_agent_message_text(tmp_path: Path) -> None:
    engine = CodexCliEngine(
        command="codex",
        runtime_root=tmp_path,
        run_process=lambda **_kwargs: CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl(
                {
                    "type": "item.completed",
                    "item": {
                        "type": "reasoning",
                        "text": "private chain of thought",
                    },
                },
                {
                    "type": "item.completed",
                    "item": {
                        "type": "agent_message",
                        "text": "Visible final answer",
                    },
                },
            ),
            stderr="",
        ),
    )
    engine.load_model("codex-cli/default")

    assert engine.generate(prompt="Say final") == "Visible final answer"


def test_codex_cli_engine_stream_forwards_cancel_handle_to_process(tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def run_process(**kwargs: Any) -> CodexCliProcessResult:
        captured["cancel_handle"] = kwargs.get("cancel_handle")
        return CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl({"type": "agent_message", "message": "ok"}),
            stderr="",
        )

    engine = CodexCliEngine(command="codex", runtime_root=tmp_path, run_process=run_process)
    cancel_handle = TurnCancellationHandle(request_id="req_codex_cancel")

    assert list(engine.stream(prompt="hello", cancel_handle=cancel_handle)) == ["ok"]
    assert captured["cancel_handle"] is cancel_handle


def test_codex_cli_engine_launches_independent_concurrent_process_calls(
    tmp_path: Path,
) -> None:
    barrier = threading.Barrier(2)
    calls: list[tuple[str, TurnCancellationHandle | None]] = []
    calls_lock = threading.Lock()

    def run_process(**kwargs: Any) -> CodexCliProcessResult:
        input_text = str(kwargs["input_text"])
        cancel_handle = kwargs.get("cancel_handle")
        with calls_lock:
            calls.append((input_text, cancel_handle))
        barrier.wait(timeout=2)
        answer = "first" if "first" in input_text else "second"
        return CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl({"type": "agent_message", "message": answer}),
        )

    engine = CodexCliEngine(
        command="codex",
        runtime_root=tmp_path,
        run_process=run_process,
    )
    handles = (
        TurnCancellationHandle(request_id="child-first"),
        TurnCancellationHandle(request_id="child-second"),
    )
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = (
            executor.submit(lambda: list(engine.stream(prompt="first", cancel_handle=handles[0]))[0]),
            executor.submit(
                lambda: list(engine.stream(prompt="second", cancel_handle=handles[1]))[0]
            ),
        )
        results = [future.result(timeout=2) for future in futures]

    assert results == ["first", "second"]
    assert len(calls) == 2
    assert {id(call[1]) for call in calls} == {id(handle) for handle in handles}


@pytest.mark.slow  # spawns a real python subprocess and cancels it mid-run
def test_codex_cli_process_interrupts_subprocess_on_cancel(tmp_path: Path) -> None:
    cancel_handle = TurnCancellationHandle(request_id="req_codex_cancel_process")
    timer = threading.Timer(0.1, lambda: cancel_handle.cancel(reason="chat_cancel"))
    timer.start()

    try:
        with pytest.raises(Exception, match="cancel"):
            _run_codex_process(
                command=sys.executable,
                args=[
                    "-c",
                    "import sys, time\nsys.stdin.read()\ntime.sleep(10)\n",
                ],
                input_text="prompt",
                cwd=tmp_path,
                timeout_seconds=30,
                cancel_handle=cancel_handle,
            )
    finally:
        timer.cancel()


def test_codex_cli_pinned_profile_survives_a_custom_model(tmp_path: Path) -> None:
    """A --model override must not displace any containment flag."""

    calls: list[dict[str, Any]] = []

    def run_process(**kwargs: Any) -> CodexCliProcessResult:
        calls.append(kwargs)
        return CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl({"type": "agent_message", "message": "ok"}),
        )

    engine = CodexCliEngine(command="codex", runtime_root=tmp_path, run_process=run_process)
    engine.load_model("codex-cli/gpt-5.5")
    engine.generate(prompt="hi")

    args = calls[0]["args"]
    for flag, value in (
        ("--sandbox", "read-only"),
        ("--ask-for-approval", "never"),
    ):
        assert args[args.index(flag) + 1] == value
    for override in ("mcp_servers={}", "tools.web_search=false", 'sandbox_mode="read-only"'):
        assert override in args
        assert args[args.index(override) - 1] == "-c"
    assert args[-1] == "-"
    assert "--ephemeral" in args and "--skip-git-repo-check" in args


# F1: rejection used to be strictly post-hoc -- _parse_jsonl_output inspected
# stdout only after the CLI had already exited, so a native tool call had
# already run by the time Jenny said no. These pin the in-flight tripwire that
# mirrors the byte-budget one.
def test_tool_event_tripwire_trips_on_the_first_tool_event_line() -> None:
    tripwire = codex_cli._ToolEventTripwire.create()

    tripwire.feed(b'{"type":"session.created","id":"s1"}\n')
    assert tripwire.tripped is False

    tripwire.feed(b'{"type":"item.started","item":{"type":"command_execution"}}\n')
    assert tripwire.tripped is True
    assert tripwire.marker


def test_tool_event_tripwire_ignores_partial_lines_and_non_json() -> None:
    tripwire = codex_cli._ToolEventTripwire.create()

    # A tool event split across chunks must not trip until the line completes.
    tripwire.feed(b'{"type":"tool_')
    assert tripwire.tripped is False
    tripwire.feed(b'call","name":"shell"}')
    assert tripwire.tripped is False
    tripwire.feed(b"\n")
    assert tripwire.tripped is True

    benign = codex_cli._ToolEventTripwire.create()
    benign.feed(b"not json at all\n[1,2,3]\n")
    benign.feed(_jsonl({"type": "agent_message", "message": "hello"}).encode("utf-8"))
    assert benign.tripped is False


def test_tool_event_tripwire_bounds_its_partial_line_buffer() -> None:
    tripwire = codex_cli._ToolEventTripwire.create()

    tripwire.feed(b"x" * (codex_cli._MAX_TRIPWIRE_LINE_BYTES + 8192))

    assert len(tripwire.pending) <= codex_cli._MAX_TRIPWIRE_LINE_BYTES
    assert tripwire.tripped is False


@pytest.mark.slow  # spawns a real python subprocess that must be killed in flight
def test_codex_cli_process_kills_the_subprocess_on_the_first_tool_event(
    tmp_path: Path,
) -> None:
    # The child emits a tool event, then would keep running for 30s. Pre-fix
    # _run_codex_process waits for the process to exit before anything inspects
    # stdout, so this would block on the timeout instead of failing fast.
    script = (
        "import sys, time\n"
        "sys.stdin.read()\n"
        'sys.stdout.write(\'{"type":"item.started","item":{"type":"command_execution"}}\\n\')\n'
        "sys.stdout.flush()\n"
        "time.sleep(30)\n"
    )
    started = time.monotonic()
    with pytest.raises(RuntimeError, match="attempted to use its own tool"):
        _run_codex_process(
            command=sys.executable,
            args=["-c", script],
            input_text="prompt",
            cwd=tmp_path,
            timeout_seconds=30,
        )
    assert time.monotonic() - started < 15, "the tripwire must not wait for the timeout"


def test_codex_cli_subprocess_does_not_inherit_ambient_credentials(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """F8: the CLI is a model transport, not a holder of the shell's secrets."""

    monkeypatch.setenv("OPENAI_API_KEY", "sk-proj-SENTINEL0123456789")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_SENTINEL01234567")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "SENTINELawsSecret0123456789")
    monkeypatch.setenv("HF_TOKEN", "hf_SENTINELabcdefghijklmnopqrstuv")
    monkeypatch.setenv("HTTPS_PROXY", "https://user:SENTINELproxy@proxy.internal:8080")

    captured: dict[str, Any] = {}

    class _FakePopen:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            captured["env"] = kwargs.get("env")
            raise OSError("stop before any IO")

    monkeypatch.setattr(codex_cli.subprocess, "Popen", _FakePopen)

    with pytest.raises(RuntimeError):
        _run_codex_process(
            command="codex",
            args=["exec"],
            input_text="prompt",
            cwd=tmp_path,
            timeout_seconds=1,
        )

    env = captured["env"]
    assert env is not None, "an explicit env must be passed, never the inherited one"
    for key in (
        "OPENAI_API_KEY",
        "GITHUB_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "HF_TOKEN",
        "HTTPS_PROXY",
    ):
        assert key not in env, f"{key} must not reach the Codex CLI"
    assert "SENTINEL" not in json.dumps(env)
    # The CLI still needs to find its own ChatGPT auth and its own binary.
    assert "PATH" in env or "Path" in env


def test_windows_codex_teardown_tree_kills_before_closing_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[object] = []

    class _Process:
        pid = 4321
        polls = iter((None, 0))

        @classmethod
        def poll(cls) -> int | None:
            return next(cls.polls)

    class _JobObject:
        @staticmethod
        def close() -> None:
            events.append("close")

    def run(argv: list[str], **kwargs: object) -> None:
        events.append(("taskkill", argv, kwargs))

    monkeypatch.setattr(codex_cli.os, "name", "nt")
    monkeypatch.setattr(codex_cli.subprocess, "run", run)

    thread = codex_cli._terminate_codex_tree(  # noqa: SLF001
        _Process(),  # type: ignore[arg-type]
        _JobObject(),  # type: ignore[arg-type]
        wait=False,
    )
    # The Windows teardown runs off the caller's thread (the cancel callback
    # lives on the dispatch loop); the ordering it must keep is still
    # taskkill while the root is alive, then the job close.
    assert thread is not None
    thread.join(timeout=5.0)
    assert not thread.is_alive()

    assert events[0] == (
        "taskkill",
        ["taskkill", "/T", "/F", "/PID", "4321"],
        {
            "stdout": codex_cli.subprocess.DEVNULL,
            "stderr": codex_cli.subprocess.DEVNULL,
            "timeout": 5,
            "check": False,
        },
    )
    assert events[1] == "close"


def test_codex_cli_engine_fails_closed_on_unrecognized_jsonl(tmp_path: Path) -> None:
    engine = CodexCliEngine(
        command="codex",
        runtime_root=tmp_path,
        run_process=lambda **_kwargs: CodexCliProcessResult(
            exit_code=0,
            stdout=_jsonl({"type": "session.created", "id": "session_1"}),
            stderr="",
        ),
    )

    with pytest.raises(RuntimeError, match="assistant message"):
        engine.generate(prompt="Say final")


def test_windows_codex_cancel_callback_returns_without_blocking_on_taskkill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The cancel callback runs on the sidecar's single dispatch loop under the
    multiplexer lock; a blocking taskkill there stalls every RPC."""
    release = threading.Event()

    class _Process:
        pid = 4321

        @staticmethod
        def poll() -> int | None:
            return None if not release.is_set() else 0

    def slow_taskkill(argv: list[str], **kwargs: object) -> None:
        release.wait(timeout=5.0)

    monkeypatch.setattr(codex_cli.os, "name", "nt")
    monkeypatch.setattr(codex_cli.subprocess, "run", slow_taskkill)

    started = time.perf_counter()
    thread = codex_cli._terminate_codex_tree(_Process(), None, wait=False)  # type: ignore[arg-type]  # noqa: SLF001
    elapsed = time.perf_counter() - started
    release.set()
    assert thread is not None
    thread.join(timeout=5.0)

    assert elapsed < 0.5, f"cancel must not block on taskkill, took {elapsed:.2f}s"
