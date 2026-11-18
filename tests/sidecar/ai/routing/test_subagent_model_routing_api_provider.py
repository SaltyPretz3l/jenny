# new-test-file: the api-provider delegate route (row 179 P1); the sibling file is at 458 of 600 lines.
"""An api-provider parent routes delegate tasks to another enabled model of its instance."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.config_models import normalize_subagent_routing
from sidecar.ai.routing.delegate_contracts import DelegateTask
from sidecar.ai.routing.subagent_model_routing import (
    render_subagent_model_guidance,
    resolve_subagent_model_route,
    subagent_model_catalog,
    subagent_router_for_route,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.chat_models import ChatRequestContext

INSTANCE = "anthropic-api"
HAIKU = "claude-haiku-4-5"
SONNET = "claude-sonnet-4-5"
PLAIN = "legacy-no-thinking"
FULL_HAIKU = f"api-provider/{INSTANCE}/{HAIKU}"
FULL_SONNET = f"api-provider/{INSTANCE}/{SONNET}"
FULL_PLAIN = f"api-provider/{INSTANCE}/{PLAIN}"
EFFORTS = ["default", "none", "low", "medium", "high", "xhigh", "max"]
SOURCES = {
    key: "preset"
    for key in ("context_length", "max_output_tokens", "tools", "vision", "reasoning")
}


def _limits(context: int, output: int, *, reasoning: bool = True) -> dict[str, Any]:
    return {
        "context_length": context, "max_output_tokens": output, "tools": True,
        "vision": True, "reasoning": reasoning, "sources": dict(SOURCES),
    }


def _descriptor() -> dict[str, Any]:
    return {
        "descriptor_schema_version": 6, "provider_id": INSTANCE, "label": "Anthropic",
        "endpoint": "https://api.anthropic.com/v1", "transport": "anthropic_messages_v1",
        "auth_profile": "x_api_key", "token_limit_field": "max_tokens",
    }


def _models() -> list[dict[str, Any]]:
    return [
        {"id": HAIKU, "limits": _limits(200_000, 8_192)},
        {"id": SONNET, "limits": _limits(1_000_000, 64_000)},
        {"id": PLAIN, "limits": _limits(100_000, 4_096, reasoning=False)},
    ]


def _config(model: str = FULL_HAIKU, **kwargs: Any) -> Any:
    limits = next(row["limits"] for row in _models() if f"api-provider/{INSTANCE}/{row['id']}" == model)
    raw: dict[str, Any] = {
        "engine_type": "api-provider", "model": model, "api_provider_descriptor": _descriptor(),
        "api_provider_model_limits": limits, "api_provider_key": "sk-ant-test-key",
        "api_provider_subagent_models": _models(), "context_length": limits["context_length"],
    }
    raw.update(kwargs)
    return parse_runtime_config(raw)


def _context(**kwargs: Any) -> ChatRequestContext:
    return ChatRequestContext(
        request_id="parent", session_id="session", agent_id="main@parent", trace_id="trace",
        approvals_pre_granted=False, mode="assist", reasoning_effort="high",
        workspace_root_present=True, **kwargs,
    )


def _router(config: Any, model: str | None = None) -> Any:
    return SimpleNamespace(_config=config, _engine=SimpleNamespace(model_name=model or config.model))


def _route(config: Any, task: DelegateTask, **context: Any) -> Any:
    return resolve_subagent_model_route(_router(config), _context(**context), task)


def test_short_model_id_resolves_to_the_full_namespaced_id() -> None:
    route = _route(_config(), DelegateTask(1, "x", model=SONNET))
    assert (route.provider, route.model) == ("api-provider", FULL_SONNET)
    assert route.context_length == 1_000_000


def test_full_namespaced_id_resolves_and_efforts_follow_the_reasoning_flag() -> None:
    config = _config()
    assert _route(config, DelegateTask(1, "x", model=FULL_SONNET)).model == FULL_SONNET
    route = _route(config, DelegateTask(1, "x", model=SONNET, reasoning_effort="low"))
    assert route.reasoning_effort == "low"
    with pytest.raises(ToolExecutionFailure, match="reasoning effort is unavailable"):
        _route(config, DelegateTask(1, "x", model=PLAIN, reasoning_effort="low"))
    assert _route(config, DelegateTask(1, "x", model=PLAIN)).reasoning_effort == "default"


def test_another_instance_or_unknown_model_fails() -> None:
    config = _config()
    for model in (f"api-provider/other-api/{SONNET}", "claude-opus-9", "chatgpt/gpt-6-luna"):
        with pytest.raises(ToolExecutionFailure, match="unavailable in the active provider"):
            _route(config, DelegateTask(1, "x", model=model))


def test_catalog_rows_carry_limits_context_and_efforts() -> None:
    rows = {row["id"]: row for row in subagent_model_catalog(_config())}
    assert list(rows) == [FULL_HAIKU, FULL_SONNET, FULL_PLAIN]
    assert rows[FULL_SONNET]["context_length"] == 1_000_000
    assert rows[FULL_SONNET]["limits"] == _limits(1_000_000, 64_000)
    assert rows[FULL_SONNET]["reasoning_efforts"] == EFFORTS
    assert rows[FULL_PLAIN]["reasoning_efforts"] == ["default"]
    assert rows[FULL_PLAIN]["default_reasoning_effort"] == "default"
    no_descriptor = _config(api_provider_descriptor=None)
    assert subagent_model_catalog(no_descriptor) == ()


def test_stale_default_fails_instead_of_falling_back_to_the_parent() -> None:
    preferences = {"api-provider": {"defaultModel": f"api-provider/{INSTANCE}/claude-retired"}}
    with pytest.raises(ToolExecutionFailure, match="default model in Settings is unavailable"):
        _route(_config(), DelegateTask(1, "x"), subagent_routing=preferences)


def test_default_model_and_effort_from_settings_apply() -> None:
    preferences = {"api-provider": {"defaultModel": FULL_SONNET, "defaultEffort": "medium"}}
    route = _route(_config(), DelegateTask(1, "x"), subagent_routing=preferences)
    assert (route.model, route.reasoning_effort) == (FULL_SONNET, "medium")


def test_other_instance_preferences_are_ignored() -> None:
    preferences = {"api-provider": {
        "defaultModel": f"api-provider/other-api/{SONNET}", "defaultEffort": "max",
        "allowedModels": [f"api-provider/other-api/{SONNET}"],
        "preferredModels": [f"api-provider/other-api/{SONNET}"],
    }}
    route = _route(_config(), DelegateTask(1, "x"), subagent_routing=preferences)
    assert route.model == FULL_HAIKU
    assert route.reasoning_effort == "high"


def test_allowed_list_is_filtered_by_instance_and_restricts_the_task() -> None:
    preferences = {"api-provider": {"allowedModels": [FULL_SONNET, f"api-provider/other-api/{HAIKU}"]}}
    config = _config()
    assert _route(config, DelegateTask(1, "x", model=SONNET), subagent_routing=preferences).model == FULL_SONNET
    with pytest.raises(ToolExecutionFailure, match="outside the allowed models"):
        _route(config, DelegateTask(1, "x", model=HAIKU), subagent_routing=preferences)
    # An allow-list naming only another instance still restricts this one to the parent's model.
    foreign = {"api-provider": {"allowedModels": [f"api-provider/other-api/{SONNET}"]}}
    assert _route(config, DelegateTask(1, "x", model=HAIKU), subagent_routing=foreign).model == FULL_HAIKU
    assert _route(config, DelegateTask(1, "x"), subagent_routing=foreign).model == FULL_HAIKU
    with pytest.raises(ToolExecutionFailure, match="outside the allowed models"):
        _route(config, DelegateTask(1, "x", model=SONNET), subagent_routing=foreign)


def test_maximum_effort_is_enforced_and_does_not_block_a_non_reasoning_model() -> None:
    preferences = {"api-provider": {"maxEffort": "low"}}
    config = _config()
    with pytest.raises(ToolExecutionFailure, match="exceeds the maximum"):
        _route(config, DelegateTask(1, "x", model=SONNET, reasoning_effort="high"),
               subagent_routing=preferences)
    assert _route(config, DelegateTask(1, "x", model=PLAIN), subagent_routing=preferences).model == FULL_PLAIN


def test_parent_missing_from_the_catalog_keeps_its_engine() -> None:
    config = _config(api_provider_subagent_models=[])
    route = _route(config, DelegateTask(1, "x"))
    assert route.model == FULL_HAIKU
    assert _route(config, DelegateTask(1, "x", model=FULL_HAIKU)).model == FULL_HAIKU
    with pytest.raises(ToolExecutionFailure, match="unavailable"):
        _route(config, DelegateTask(1, "x", model=SONNET))


class _ChildEngine:
    def __init__(self) -> None:
        self.closed = 0

    def close(self) -> None:
        self.closed += 1


def test_child_config_swaps_limits_and_context_and_keeps_descriptor_and_key() -> None:
    config = _config(context_length_override=50_000)
    captured: list[Any] = []
    engine = _ChildEngine()

    def creator(child_config: Any) -> Any:
        captured.append(child_config)
        return SimpleNamespace(_config=child_config, _engine=engine)

    router = _router(config)
    router.create_subagent_router = creator
    route = resolve_subagent_model_route(
        router, _context(), DelegateTask(1, "x", model=SONNET, reasoning_effort="low"))
    with subagent_router_for_route(router, route) as child:
        assert child is not router
    child_config = captured[0]
    assert child_config.model == FULL_SONNET
    assert child_config.api_provider_model_limits == _limits(1_000_000, 64_000)
    assert child_config.context_length == 1_000_000
    assert child_config.context_length_override is None
    assert child_config.fallback_models == ()
    assert child_config.reasoning_effort == "low"
    assert child_config.api_provider_descriptor == config.api_provider_descriptor
    assert child_config.api_provider_key == "sk-ant-test-key"
    assert config.model == FULL_HAIKU and config.api_provider_model_limits == _limits(200_000, 8_192)
    assert engine.closed == 1


def test_same_model_task_reuses_the_parent_router() -> None:
    router = _router(_config())
    router.create_subagent_router = lambda _config: pytest.fail("same model must reuse the parent")
    for task in (DelegateTask(1, "x"), DelegateTask(1, "x", model=HAIKU)):
        route = resolve_subagent_model_route(router, _context(), task)
        with subagent_router_for_route(router, route) as child:
            assert child is router


def test_guidance_lists_short_ids_and_filtered_short_preferences() -> None:
    preferences = {"api-provider": {
        "defaultModel": FULL_SONNET, "preferredModels": [FULL_SONNET, f"api-provider/other-api/{HAIKU}"],
    }}
    text = render_subagent_model_guidance(_config(), subagent_routing=preferences)
    assert f'"id":"{SONNET}"' in text and f'"id":"{HAIKU}"' in text
    assert "api-provider/" not in text.split("Catalog:", 1)[1].split("Subagent preferences:")[0]
    assert f'"defaultModel":"{SONNET}"' in text
    assert f'"preferredModels":["{SONNET}"]' in text
    assert "other-api" not in text
    assert "short" in text.lower()
    assert "stale defaults and inherited effort fall back automatically" not in text


def test_chatgpt_guidance_wording_is_unchanged() -> None:
    config = parse_runtime_config({"engine_type": "chatgpt", "model": "gpt-6.1-sol"})
    text = render_subagent_model_guidance(config, subagent_routing={})
    assert "stale defaults and inherited effort fall back automatically" in text
    assert "short" not in text.lower()


def test_parse_keeps_only_valid_deduplicated_rows() -> None:
    good = {"id": HAIKU, "limits": _limits(200_000, 8_192)}
    broken_limits = {"id": SONNET, "limits": {"context_length": 5}}
    config = parse_runtime_config({
        "engine_type": "api-provider", "model": FULL_HAIKU,
        "api_provider_subagent_models": [
            good, {"id": HAIKU, "limits": _limits(1, 1)}, broken_limits, {"id": "", "limits": _limits(9, 4)},
            {"id": 7, "limits": _limits(9, 4)}, "text", None, {"id": f" {SONNET}", "limits": _limits(9, 4)},
        ],
    })
    assert config.api_provider_subagent_models == (good,)


def test_parse_bounds_the_row_count_and_ignores_a_non_list() -> None:
    rows = [{"id": f"model-{index}", "limits": _limits(10_000, 1_000)} for index in range(80)]
    config = parse_runtime_config({"engine_type": "api-provider", "api_provider_subagent_models": rows})
    assert len(config.api_provider_subagent_models) == 64
    for value in ({"id": HAIKU}, "text", 3, None):
        parsed = parse_runtime_config({"engine_type": "api-provider", "api_provider_subagent_models": value})
        assert parsed.api_provider_subagent_models == ()


def test_routing_preferences_accept_valid_and_reject_malformed_api_provider_ids() -> None:
    def normalized(**row: Any) -> dict[str, Any]:
        return normalize_subagent_routing({"api-provider": row})

    valid = normalized(
        defaultModel="api-provider/anthropic-api/claude-haiku-4-5",
        allowedModels=["api-provider/openrouter/openai/gpt-6-luna"],
    )
    assert valid["api-provider"]["defaultModel"] == "api-provider/anthropic-api/claude-haiku-4-5"
    assert valid["api-provider"]["allowedModels"] == ["api-provider/openrouter/openai/gpt-6-luna"]
    for bad in (
        "claude-haiku-4-5", "api-provider/anthropic-api", "api-provider//model",
        "api-provider/Bad_Instance/model", "api-provider/anthropic-api/ model", "api-provider/x/m",
        "api-provider/anthropic-api/" + "m" * 201,
    ):
        assert normalized(defaultModel=bad) == {}, bad
        assert normalized(preferredModels=[bad]) == {}, bad
    # The chatgpt and codex-cli rules are untouched.
    assert normalize_subagent_routing({"chatgpt": {"defaultModel": "gpt-6-luna"}})["chatgpt"]
    assert not normalize_subagent_routing({"chatgpt": {"defaultModel": "api-provider/a-b/c"}})
