"""HB-016: the app profile's output limits must reach the loaded engine.

The container resolves the app profile from the model the engine actually
loaded, so it runs AFTER ``create_engine``. The llama-server engine was built
with the pre-profile config and never saw Bonsai 2's 32k final + 32k thinking
allowance: every dogfood turn dump showed ``provider_num_predict=16384`` and
no thinking headroom. Once the limits do reach the engine, final + headroom
(64k) equals the whole 64k window, so the wire ``max_tokens`` must also be
fitted to the room the prompt leaves.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from sidecar.ai.config import resolve_effective_max_tokens
from sidecar.ai.context.token_budget import apply_budget_check
from sidecar.ai.engines.provider_http import ProviderHttpService
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore

BONSAI2_MODEL = "Ternary-Bonsai-2-27B-Q2_0.gguf"
WINDOW = 65_536


def _install_container_stubs(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import sidecar.ai.container as container_mod
    import sidecar.ai.engines.vllm_engine as vllm_engine_mod

    def _get_json(self: ProviderHttpService, path: str, **_kwargs: Any) -> dict[str, Any]:
        response = httpx.Response(
            200,
            request=httpx.Request("GET", f"{self.base_url}{path}"),
            json={"data": [{"id": BONSAI2_MODEL}]},
        )
        return dict(response.json())

    monkeypatch.setattr(ProviderHttpService, "get_json", _get_json)
    # No /props: the configured window is the served one.
    monkeypatch.setattr(vllm_engine_mod, "probe_server_modalities", lambda **_kwargs: None)
    monkeypatch.setattr(
        container_mod, "resolve_memory_db_path", lambda _cfg: tmp_path / "memory.db"
    )
    # Keep MonitorManager off the live runtime root (it prunes and rewrites
    # the user's real background monitor records).
    monkeypatch.setattr(
        container_mod, "resolve_background_runtime_root", lambda _cfg: tmp_path / "runtime"
    )
    monkeypatch.setattr(container_mod, "MemoryStore", lambda _path: MagicMock())
    monkeypatch.setattr(container_mod, "ContextBuilder", lambda *args, **kwargs: MagicMock())
    monkeypatch.setattr(container_mod, "MCPClient", lambda **kwargs: MagicMock())
    monkeypatch.setattr(container_mod, "ChatRouter", lambda **kwargs: MagicMock())
    monkeypatch.setattr(
        container_mod,
        "HarnessSnapshotBuilder",
        lambda **kwargs: MagicMock(inspect=MagicMock()),
    )


@pytest.fixture
def bonsai_stack(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    _install_container_stubs(monkeypatch, tmp_path)
    from sidecar.ai.container import BrainContainer

    container = BrainContainer()
    stack = container.configure(
        {
            "engine_type": "openai-compatible",
            "model": BONSAI2_MODEL,
            "context_length": WINDOW,
        }
    )
    try:
        yield stack
    finally:
        container.close()


def _send(engine: Any, *, prompt_chars: int, tools: list[dict[str, Any]] | None = None):
    """Run one thinking tool-call request; return (wire payload, diagnostics)."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="hb016", session_id=None, mode="chat")
    engine.begin_request_context(request_id="hb016", diagnostics_store=store)
    captured: dict[str, Any] = {}

    def _fake_post_json(_path: str, payload: dict[str, Any]) -> dict[str, Any]:
        captured.update(payload)
        return {"choices": [{"message": {"content": "ok"}}]}

    engine._service.post_json = _fake_post_json
    try:
        engine.generate_with_tools(
            prompt="",
            tools=tools or [],
            max_tokens=resolve_effective_max_tokens(16_384, engine.get_model_max_output_tokens()),
            reasoning_effort="medium",
            messages=[{"role": "user", "content": "x" * prompt_chars}],
        )
    finally:
        engine.clear_request_context()
    return captured, store.get_snapshot_for_request("hb016") or {}


def _prompt_estimate(payload: dict[str, Any]) -> int:
    messages = json.dumps(payload.get("messages") or [], ensure_ascii=False)
    tools = json.dumps(payload.get("tools") or [], ensure_ascii=False)
    return len(messages) // 4 + len(tools) // 4


def test_bonsai2_profile_output_limits_reach_the_llama_server_engine(bonsai_stack) -> None:
    engine = bonsai_stack.engine
    assert bonsai_stack.config.resolved_app_profile_max_output_tokens == 32_768
    assert engine.get_model_max_output_tokens() == 32_768
    assert engine.get_request_output_reservation("medium") == 32_768 + 32_768

    payload, diagnostics = _send(engine, prompt_chars=4_000)

    # Small prompt: the full profile allowance fits, less the prompt's share.
    room = WINDOW - _prompt_estimate(payload)
    assert 32_768 < payload["max_tokens"] <= room
    assert diagnostics["provider_num_predict"] == payload["max_tokens"]
    assert diagnostics["provider_final_output_tokens"] == 32_768
    assert diagnostics["provider_thinking_headroom_tokens"] == payload["max_tokens"] - 32_768


def test_wire_max_tokens_never_exceeds_the_room_left_after_the_prompt(bonsai_stack) -> None:
    engine = bonsai_stack.engine
    tools = [
        {
            "name": f"tool_{index}",
            "description": "d" * 400,
            "parameters": {"type": "object", "properties": {}},
        }
        for index in range(20)
    ]
    for prompt_chars in (40_000, 120_000, 200_000):
        payload, diagnostics = _send(engine, prompt_chars=prompt_chars, tools=tools)
        room = WINDOW - _prompt_estimate(payload)
        assert payload["max_tokens"] <= room, prompt_chars
        assert diagnostics["provider_num_predict"] == payload["max_tokens"]


def test_wire_room_honors_the_budget_reservation_up_to_the_error_threshold(
    bonsai_stack,
) -> None:
    engine = bonsai_stack.engine
    _messages, budget, _tracker = apply_budget_check(
        [], bonsai_stack.config, engine, reasoning_effort="medium"
    )
    assert budget is not None
    reservation = budget._output_reservation()
    # The budget still caps its planning reservation at a quarter of the window.
    assert reservation == budget.context_window // 4
    # The largest prompt the budget lets through before it errors must still
    # get at least the reservation it planned for.
    largest_prompt_tokens = budget.error_threshold()
    payload, _diagnostics = _send(engine, prompt_chars=largest_prompt_tokens * 4)
    assert reservation <= payload["max_tokens"] <= WINDOW - _prompt_estimate(payload)


def test_container_hands_the_profile_limits_to_an_ollama_engine(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import sidecar.ai.container as container_mod
    from sidecar.ai.container import BrainContainer
    from sidecar.ai.engines.ollama import OllamaEngine

    _install_container_stubs(monkeypatch, tmp_path)
    engine = OllamaEngine()
    engine.model_name = "qwen3.8:27b-q3-k-s"
    monkeypatch.setattr(
        container_mod,
        "create_engine",
        lambda _cfg, **_kwargs: MagicMock(
            engine=engine,
            engine_type="ollama",
            model="qwen3.8:27b-q3-k-s",
            fallback_from=None,
            fallback_reason=None,
        ),
    )
    container = BrainContainer()
    try:
        container.configure(
            {"engine_type": "ollama", "model": "qwen3.8:27b-q3-k-s", "context_length": WINDOW}
        )
        assert engine.get_model_max_output_tokens() == 32_768
        assert engine._profile_thinking_headroom == 32_768
    finally:
        container.close()
