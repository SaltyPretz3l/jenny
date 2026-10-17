"""Exercise real prompt assembly through the read-only RPC, without inference."""

from dataclasses import replace
from types import SimpleNamespace

import pytest

from sidecar.ai.config_models import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.history_reframe import reframe_tool_history_messages
from sidecar.ai.context.messages import compact_semantic_messages_with_report
from sidecar.ai.context.token_budget import estimate_messages_tokens
from sidecar.ai.engines.mock import MockEngine
from sidecar.ai.mcp.client import MCPClient
from sidecar.ai.routing.router import AgentKernel
from sidecar.protocol import API_VERSION, CONTEXT_PREVIEW_METHOD
from sidecar.runtime.request_dispatch_context import process_context_preview
from sidecar.runtime.server_auxiliary_workers import AUXILIARY_FAMILY_BY_METHOD
from tests.sidecar.runtime.test_execution_context import _payload


@pytest.fixture
def preview(tmp_path, monkeypatch):
    engine = MockEngine()

    def forbidden(*_args, **_kwargs):
        pytest.fail("preview must not generate or execute tools")

    monkeypatch.setattr(engine, "generate", forbidden)
    kernel = AgentKernel(
        config=RuntimeConfig(context_length=32768, tools_enabled=False),
        engine=engine,
        mcp_client=MCPClient(),
        context_builder=ContextBuilder(workspace_root=tmp_path),
    )
    params = {
        "accept_version": API_VERSION,
        "request_id": "preview_1",
        "session_id": "session_1",
        "execution_context": _payload(None),
        "messages": [],
        "context_blocks": [],
        "run_mode": "ask",
    }
    container = SimpleNamespace(stack=SimpleNamespace(router=kernel))

    def run(**changes):
        outcome = process_context_preview(1, {**params, **changes}, True, container)
        assert not outcome.notifications
        return outcome.response

    return kernel, run, tmp_path


def test_fresh_prompt_and_changed_system_prompt(preview):
    kernel, run, root = preview
    before = list(root.rglob("*"))
    result = run()["result"]
    assert result["status"] == "estimated"
    assert result["breakdown"]["messages"] == 0
    assert result["breakdown"]["system_prompt"] > 0
    assert result["used_tokens"] == sum(result["breakdown"].values())
    assert result["available_tokens"] == 32768 - result["used_tokens"]
    kernel._config = replace(kernel._config, system_prompt="A different system instruction. " * 900)
    changed = run()["result"]
    assert changed["breakdown"]["system_prompt"] != result["breakdown"]["system_prompt"]
    assert list(root.rglob("*")) == before
    assert "system_prompt" not in changed  # counts only


def test_history_and_modes_use_canonical_counters(preview):
    kernel, run, _root = preview
    messages = [{"role": "user", "content": "Hello world"}]
    result = run(messages=messages)["result"]
    assert result["breakdown"]["messages"] == estimate_messages_tokens(
        messages, kernel._tokenizer_backend()
    )
    plan = run(run_mode="plan", messages=messages)["result"]
    assert plan["used_tokens"] > result["used_tokens"]
    assert plan["used_tokens"] == sum(plan["breakdown"].values())


def test_invalid_authority_model_and_request_are_closed(preview):
    _kernel, run, _root = preview
    assert "error" in run(execution_context=None)
    assert "error" in run(extra="untrusted")
    assert "error" in run(run_mode="bogus")
    assert "error" in run(session_start_date="16 October")
    assert run(preferred_model="other-model")["result"]["reason"] == "model_not_active"
    assert AUXILIARY_FAMILY_BY_METHOD[CONTEXT_PREVIEW_METHOD] == "context_preview"


def test_local_trailing_context_does_not_double_count_copied_history(preview):
    kernel, run, _root = preview
    kernel._config = replace(kernel._config, engine_type="ollama", tools_enabled=False)
    fresh = run()["result"]
    history = [{"role": "user", "content": "A long conversation. " * 3000}]
    populated = run(messages=history)["result"]
    history_tokens = estimate_messages_tokens(
        compact_semantic_messages_with_report(history).messages, kernel._tokenizer_backend()
    )
    assert populated["used_tokens"] == fresh["used_tokens"] + history_tokens
    assert populated["breakdown"]["messages"] == history_tokens
    assert populated["breakdown"]["system_prompt"] == fresh["breakdown"]["system_prompt"]
    assert populated["breakdown"]["other"] == fresh["breakdown"]["other"]
    assert all(value >= 0 for value in populated["breakdown"].values())
    assert populated["used_tokens"] == sum(populated["breakdown"].values())


def test_tool_history_uses_canonical_envelopes_and_admission(preview):
    kernel, run, _root = preview
    history = [
        {"role": "user", "content": "Read the file"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "call_1", "name": "read_file", "arguments": '{"path":"a.txt"}'}
        ]},
        {"role": "tool", "tool_call_id": "call_1", "name": "read_file", "content": "hello"},
    ]
    prepared = compact_semantic_messages_with_report(
        reframe_tool_history_messages(history, config=kernel._config)
    ).messages
    expected = estimate_messages_tokens(prepared, kernel._tokenizer_backend())
    assert expected != estimate_messages_tokens(history, kernel._tokenizer_backend())
    assert run(messages=history)["result"]["breakdown"]["messages"] == expected


def test_workspace_instructions_follow_request_root(preview):
    _kernel, run, root = preview
    (root / "agentj.md").write_text("Project instructions: keep changes small. " * 30)
    rooted = run(execution_context=_payload(root.resolve()))["result"]
    unbound = run()["result"]
    assert rooted["breakdown"]["instructions"] > 0
    assert unbound["breakdown"]["instructions"] == 0


def test_tools_preferences_and_unknown_capacity(preview, monkeypatch):
    kernel, run, root = preview
    kernel._config = replace(kernel._config, tools_enabled=True)
    rooted = _payload(root.resolve())
    unbound = run()["result"]
    normal = run(execution_context=rooted)["result"]
    # A bound root admits the workspace tools, exactly as the real send does.
    assert normal["breakdown"]["tools"] > unbound["breakdown"]["tools"] > 0
    disabled = run(
        execution_context=rooted, tool_preferences={"disabled_tools": ["memory"]}
    )["result"]
    assert disabled["breakdown"]["tools"] < normal["breakdown"]["tools"]
    assert all(count >= 0 for count in normal["breakdown"].values())
    kernel._config = replace(kernel._config, context_length=0)
    monkeypatch.setattr(kernel._engine, "get_model_context_length", lambda: None)
    unknown = run()["result"]
    assert unknown["capacity_tokens"] is None
    assert unknown["reserve_tokens"] is None
    assert unknown["available_tokens"] is None
