"""Dark-path behavioral tests for sidecar/runtime/capabilities.py.

Targets the uncovered regions:
  65-66   _cached_hardware_summary exception path
  105     _tools_status_payload: skip empty/non-string keys in tools_status dict
  116     _tools_status_payload: non-dict value path for a tools_status entry
  129     _tools_status_payload: available_tools is not a list -> return {}
  133     _tools_status_payload: skip non-string/blank entries in available_tools
  150     _configured_mcp_servers_payload: skip MCP server with empty name
  202     _initialize_visible_provider_capabilities: secret-configured-but-not-available branch
  213     continue in the secret-configured branch
  231-232 initialize_response: cleanup exception is swallowed
  246     initialize_response: engine_fallback_from builds fallback payload
  361     models_list_result: engine unavailable path
  398     models_list_result: openai-compatible discovery branch
  401     models_list_result: returned payload for openai-compatible
  419     _runtime_api_url_for_engine: mismatched engine_type returns None
  440     _codex_cli_models: empty/blank/None token skip
  442     _codex_cli_models: token that already has codex-cli/ prefix
  445     _codex_cli_models: deduplication via seen set
  456     _normalized_engine_type: fallback to 'mock' for non-dict / missing value
"""

from __future__ import annotations

import sys
import unittest.mock as mock
from types import SimpleNamespace

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import WorkspaceStatus
from sidecar.ai.engines.catalog import ModelCatalogResult
from sidecar.runtime.capabilities import (
    _cached_hardware_summary,
    _codex_cli_models,
    _configured_mcp_servers_payload,
    _initialize_visible_provider_capabilities,
    _normalized_engine_type,
    _runtime_api_url_for_engine,
    _tools_status_payload,
    initialize_response,
    models_list_result,
)
from sidecar.runtime.provider_capabilities import ProviderCapability


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _minimal_stack(
    *,
    config: object | None = None,
    engine: object | None = None,
    router: object | None = None,
    engine_fallback_from: str | None = None,
    engine_fallback_reason: str | None = None,
) -> SimpleNamespace:
    """Return the minimal stack SimpleNamespace accepted by initialize_response."""
    return SimpleNamespace(
        config=config or RuntimeConfig(engine_type="mock", model="mock"),
        engine=engine
        or SimpleNamespace(
            capabilities={"text": True},
            get_model_context_length=lambda: None,
        ),
        router=router or SimpleNamespace(available_tools=[]),
        mcp_client=SimpleNamespace(
            diagnostics=lambda: SimpleNamespace(connected=(), failures=())
        ),
        context_builder=SimpleNamespace(
            workspace_status=lambda: WorkspaceStatus(
                root=None,
                exists=False,
                skills_loaded=0,
                bootstrap_loaded=0,
                instruction_file_name=None,
                instruction_file_present=False,
            )
        ),
        memory_store=SimpleNamespace(db_path=":memory:", journal_mode="wal"),
        engine_fallback_from=engine_fallback_from,
        engine_fallback_reason=engine_fallback_reason,
    )


# ---------------------------------------------------------------------------
# _cached_hardware_summary – lines 65-66
# ---------------------------------------------------------------------------


def test_cached_hardware_summary_returns_none_on_import_error() -> None:
    """Lines 65-66: when hardware_profile import fails the function returns None."""
    # Inject a module whose get_cached_hardware_summary raises on call
    bad_module = SimpleNamespace(
        get_cached_hardware_summary=lambda: (_ for _ in ()).throw(
            RuntimeError("hardware probe unavailable")
        )
    )
    with mock.patch.dict(
        "sys.modules",
        {"sidecar.runtime.hardware_profile": bad_module},
    ):
        result = _cached_hardware_summary()
    assert result is None


def test_cached_hardware_summary_returns_dict_when_probe_cached() -> None:
    """Lines 63-64: the happy path returns whatever get_cached_hardware_summary gives."""
    fake_summary = {"gpu": "RTX 4090", "vram_gb": 24}
    good_module = SimpleNamespace(get_cached_hardware_summary=lambda: fake_summary)
    with mock.patch.dict(
        "sys.modules",
        {"sidecar.runtime.hardware_profile": good_module},
    ):
        result = _cached_hardware_summary()
    assert result == {"gpu": "RTX 4090", "vram_gb": 24}


# ---------------------------------------------------------------------------
# _tools_status_payload – lines 105, 116, 129, 133
# ---------------------------------------------------------------------------


def test_tools_status_payload_skips_blank_and_non_string_keys() -> None:
    """Line 105: empty string / integer keys in tools_status dict are skipped."""
    router = SimpleNamespace(
        tools_status={
            "": {"available": True, "reason": None, "display_name": "empty", "source_kind": None, "tool_family": None, "server_name": None},
            "   ": {"available": True, "reason": None, "display_name": "blank", "source_kind": None, "tool_family": None, "server_name": None},
            123: {"available": True, "reason": None, "display_name": "num", "source_kind": None, "tool_family": None, "server_name": None},
            "good_tool": {"available": True, "reason": None, "display_name": "Good Tool", "source_kind": "builtin", "tool_family": None, "server_name": None},
        }
    )
    result = _tools_status_payload(router)
    # Only the valid key survives
    assert list(result.keys()) == ["good_tool"]
    assert result["good_tool"]["source_kind"] == "builtin"


def test_tools_status_payload_non_dict_entry_uses_bool_coercion() -> None:
    """Line 116-123: when a tools_status value is not a dict, bool(value) is used as 'available'."""
    router = SimpleNamespace(
        tools_status={
            "truthy_tool": True,
            "falsy_tool": False,
        }
    )
    result = _tools_status_payload(router)
    assert result["truthy_tool"]["available"] is True
    assert result["truthy_tool"]["reason"] is None
    assert result["truthy_tool"]["display_name"] == "truthy_tool"
    assert result["falsy_tool"]["available"] is False
    assert result["falsy_tool"]["source_kind"] is None


def test_tools_status_payload_returns_empty_when_available_tools_not_a_list() -> None:
    """Line 129: when tools_status is absent/None and available_tools is not a list, return {}."""
    router = SimpleNamespace(tools_status=None, available_tools="not-a-list")
    result = _tools_status_payload(router)
    assert result == {}


def test_tools_status_payload_skips_non_string_entries_in_available_tools() -> None:
    """Line 133: integer and blank entries in available_tools list are skipped."""
    router = SimpleNamespace(
        tools_status=None,
        available_tools=["valid_tool", 42, "", "  ", "another_tool"],
    )
    result = _tools_status_payload(router)
    assert set(result.keys()) == {"valid_tool", "another_tool"}
    assert result["valid_tool"]["available"] is True
    assert result["another_tool"]["available"] is True


# ---------------------------------------------------------------------------
# _configured_mcp_servers_payload – line 150
# ---------------------------------------------------------------------------


def test_configured_mcp_servers_payload_skips_empty_name() -> None:
    """Line 150: MCP server entries with empty or blank names are skipped."""
    rc = SimpleNamespace(
        mcp_servers=[
            SimpleNamespace(name="", transport="stdio"),
            SimpleNamespace(name="  ", transport="http"),
            SimpleNamespace(name="my-server", transport=""),  # empty transport -> "stdio"
            SimpleNamespace(name="other", transport="http"),
        ]
    )
    result = _configured_mcp_servers_payload(rc)
    assert len(result) == 2
    assert result[0] == {"name": "my-server", "transport": "stdio"}
    assert result[1] == {"name": "other", "transport": "http"}


# ---------------------------------------------------------------------------
# _initialize_visible_provider_capabilities – lines 202, 213
# ---------------------------------------------------------------------------


def test_initialize_visible_provider_capabilities_promotes_secret_configured_capability() -> None:
    """Lines 202-213: a capability with requires_secret=True, secret_configured=True,
    available=False is re-created with available=True and a descriptive reason.
    """
    cap = ProviderCapability(
        engine="anthropic",
        available=False,
        requires_secret=True,
        secret_configured=True,
        reason="disabled via feature flag",
    )
    result = _initialize_visible_provider_capabilities({"anthropic": cap})
    promoted = result["anthropic"]
    assert promoted.available is True
    assert "anthropic" in promoted.reason
    assert "feature flag" in promoted.reason
    assert promoted.requires_secret is True
    assert promoted.secret_configured is True


def test_initialize_visible_provider_capabilities_does_not_promote_unsecret_unavailable() -> None:
    """Line 214: capability that is unavailable but does NOT have secret configured is NOT promoted."""
    cap = ProviderCapability(
        engine="ollama",
        available=False,
        requires_secret=False,
        secret_configured=False,
        reason="ollama daemon unreachable",
    )
    result = _initialize_visible_provider_capabilities({"ollama": cap})
    # Must be the original capability unchanged
    assert result["ollama"] is cap
    assert result["ollama"].available is False


def test_initialize_visible_provider_capabilities_passthrough_for_available_caps() -> None:
    """Line 214: available capabilities pass through unchanged."""
    cap = ProviderCapability(
        engine="mock",
        available=True,
        requires_secret=False,
        secret_configured=False,
        reason=None,
    )
    result = _initialize_visible_provider_capabilities({"mock": cap})
    assert result["mock"] is cap


# ---------------------------------------------------------------------------
# initialize_response – lines 231-232, 246
# ---------------------------------------------------------------------------


def test_initialize_response_swallows_cleanup_exception() -> None:
    """Lines 231-232: if cleanup_workspace_artifacts raises, initialize_response
    still returns a valid response (exception is silently swallowed).
    """
    rc = RuntimeConfig(engine_type="mock", model="mock", tools_workspace_root="/dummy/path")
    stack = _minimal_stack(config=rc)
    brain = SimpleNamespace(configure=lambda _, **_kwargs: stack)

    with mock.patch(
        "sidecar.runtime.capabilities.cleanup_workspace_artifacts",
        side_effect=OSError("disk full"),
    ) as patched:
        response = initialize_response(
            "msg-1",
            {"config": {"engine_type": "mock"}},
            api_version="2026-03-06",
            brain_container=brain,
        )

    patched.assert_called_once()
    assert response["jsonrpc"] == "2.0"
    assert response["id"] == "msg-1"
    assert "result" in response


def test_initialize_response_includes_fallback_when_engine_fallback_from_set() -> None:
    """Line 246: when engine_fallback_from is set, the fallback payload is active."""
    rc = RuntimeConfig(engine_type="mock", model="mock")
    stack = _minimal_stack(
        config=rc,
        engine_fallback_from="ollama",
        engine_fallback_reason="Ollama daemon not reachable",
    )
    brain = SimpleNamespace(configure=lambda _, **_kwargs: stack)

    response = initialize_response(
        2,
        {"config": {"engine_type": "mock"}},
        api_version="2026-03-06",
        brain_container=brain,
    )

    fallback = response["result"]["local_runtime"]["fallback"]
    assert fallback["active"] is True
    assert fallback["requested_engine"] == "ollama"
    assert fallback["reason"] == "Ollama daemon not reachable"


def test_initialize_response_fallback_inactive_when_not_set() -> None:
    """Sanity check for the non-fallback path: fallback.active must be False."""
    rc = RuntimeConfig(engine_type="mock", model="mock")
    stack = _minimal_stack(config=rc)
    brain = SimpleNamespace(configure=lambda _, **_kwargs: stack)

    response = initialize_response(
        3,
        {"config": {"engine_type": "mock"}},
        api_version="2026-03-06",
        brain_container=brain,
    )

    fallback = response["result"]["local_runtime"]["fallback"]
    assert fallback["active"] is False
    assert fallback["requested_engine"] is None


# ---------------------------------------------------------------------------
# models_list_result – line 361
# ---------------------------------------------------------------------------


def test_models_list_result_returns_unavailable_when_engine_not_available(monkeypatch) -> None:
    """Line 361: when runtime_config is present and is_engine_available returns False,
    a structured 'unavailable' dict is returned and models_for_engine is never called.
    """
    from sidecar.runtime.provider_capabilities import ProviderCapability

    rc = RuntimeConfig(engine_type="ollama", model="qwen3.5:9b")
    calls: list[str] = []

    # Make vllm appear unavailable
    monkeypatch.setattr(
        "sidecar.runtime.capabilities.build_provider_capabilities",
        lambda _config: {
            "vllm": ProviderCapability(
                engine="vllm",
                available=False,
                requires_secret=False,
                secret_configured=False,
                reason="vllm daemon not running",
            )
        },
    )
    monkeypatch.setattr(
        "sidecar.runtime.capabilities.is_engine_available",
        lambda _caps, _engine: False,
    )

    def _models(engine: str) -> list[str]:
        calls.append(engine)
        return ["should-not-appear"]

    result = models_list_result(
        {"engine_type": "vllm", "_runtime_config": rc},
        models_for_engine=_models,
    )

    assert result["available"] is False
    assert result["models"] == []
    assert "unavailable" in result["reason"]
    assert result["engine_type"] == "vllm"
    # models_for_engine must NOT have been called
    assert calls == []


# ---------------------------------------------------------------------------
# models_list_result – lines 398, 401 (openai-compatible)
# ---------------------------------------------------------------------------


def test_models_list_result_openai_compatible_calls_discover_with_correct_url(
    monkeypatch,
) -> None:
    """Lines 398-401: openai-compatible path calls discover_openai_compatible_models
    with the configured api_url when engine_type matches.
    """
    rc = RuntimeConfig(
        engine_type="openai-compatible",
        model="Qwen/Qwen3.5-9B",
        api_url="http://localhost:8001",
    )
    captured: dict[str, object] = {}

    def _fake_discover(**kwargs: object) -> ModelCatalogResult:
        captured.update(kwargs)
        return ModelCatalogResult(models=["model-x", "model-y"], available=True, reason="")

    monkeypatch.setattr(
        "sidecar.runtime.capabilities.discover_openai_compatible_models",
        _fake_discover,
    )

    result = models_list_result(
        {"engine_type": "openai-compatible", "_runtime_config": rc},
        models_for_engine=lambda _e: ["should-not-appear"],
    )

    # The discovery function was called with the matching api_url
    assert captured.get("api_url") == "http://localhost:8001"
    assert result["engine_type"] == "openai-compatible"
    assert result["models"] == ["model-x", "model-y"]
    assert result["available"] is True
    assert result["stale"] is False


def test_models_list_result_openai_compatible_uses_none_url_for_mismatched_engine(
    monkeypatch,
) -> None:
    """Lines 398-401: when active engine_type != 'openai-compatible', api_url is None."""
    rc = RuntimeConfig(
        engine_type="vllm",
        model="Qwen/Qwen3.5-9B",
        api_url="http://localhost:8000",
    )
    captured: dict[str, object] = {}

    def _fake_discover(**kwargs: object) -> ModelCatalogResult:
        captured.update(kwargs)
        return ModelCatalogResult(models=[], available=False, reason="no url")

    monkeypatch.setattr(
        "sidecar.runtime.capabilities.discover_openai_compatible_models",
        _fake_discover,
    )

    result = models_list_result(
        {"engine_type": "openai-compatible", "_runtime_config": rc},
        models_for_engine=lambda _e: ["unused"],
    )

    # api_url must be None because active engine_type is 'vllm', not 'openai-compatible'
    assert captured.get("api_url") is None
    assert result["engine_type"] == "openai-compatible"


# ---------------------------------------------------------------------------
# _runtime_api_url_for_engine – line 419
# ---------------------------------------------------------------------------


def test_runtime_api_url_for_engine_returns_none_for_mismatched_engine_type() -> None:
    """Line 419-423: when active engine_type != requested engine_type, return None."""
    rc = SimpleNamespace(engine_type="vllm", api_url="http://localhost:8000")
    result = _runtime_api_url_for_engine(rc, "ollama")
    assert result is None


def test_runtime_api_url_for_engine_returns_none_when_runtime_config_is_none() -> None:
    """Line 418-419: runtime_config=None -> None."""
    result = _runtime_api_url_for_engine(None, "ollama")
    assert result is None


def test_runtime_api_url_for_engine_returns_api_url_when_engine_matches() -> None:
    """Lines 420-424: when engine types match, the api_url attribute is returned."""
    rc = SimpleNamespace(engine_type="ollama", api_url="http://localhost:11434")
    result = _runtime_api_url_for_engine(rc, "ollama")
    assert result == "http://localhost:11434"


# ---------------------------------------------------------------------------
# _codex_cli_models – lines 440, 442, 445
# ---------------------------------------------------------------------------


def test_codex_cli_models_skips_empty_and_none_tokens() -> None:
    """Line 440: blank strings and None values are skipped entirely."""
    result = _codex_cli_models(["", "  ", None, "valid-model"], [])  # type: ignore[list-item]
    assert result == ["codex-cli/valid-model"]


def test_codex_cli_models_preserves_existing_codex_cli_prefix() -> None:
    """Line 442: tokens that already start with 'codex-cli/' are NOT double-prefixed."""
    result = _codex_cli_models(["codex-cli/gpt-5", "o4-mini"], [])
    assert result == ["codex-cli/gpt-5", "codex-cli/o4-mini"]


def test_codex_cli_models_deduplicates_case_insensitively() -> None:
    """Line 445: duplicate tokens (case-insensitive) are dropped after the first."""
    result = _codex_cli_models(
        ["gpt-5", "GPT-5", "codex-cli/gpt-5"],
        [],
    )
    assert result == ["codex-cli/gpt-5"]


def test_codex_cli_models_merges_default_and_configured() -> None:
    """Lines 437-447: defaults appear first, configured appended, with deduplication."""
    result = _codex_cli_models(
        ["default-model"],
        ["extra-model", "default-model"],  # 'default-model' is a dupe
    )
    assert result == ["codex-cli/default-model", "codex-cli/extra-model"]


# ---------------------------------------------------------------------------
# _normalized_engine_type – line 456
# ---------------------------------------------------------------------------


def test_normalized_engine_type_returns_mock_for_none_params() -> None:
    """Line 456: non-dict params falls through to the default 'mock'."""
    assert _normalized_engine_type(None) == "mock"


def test_normalized_engine_type_returns_mock_for_string_params() -> None:
    """Line 456: string params (not a dict) -> 'mock'."""
    assert _normalized_engine_type("ollama") == "mock"


def test_normalized_engine_type_returns_mock_when_engine_type_is_none() -> None:
    """Line 455-456: dict with engine_type=None -> fallback 'mock'."""
    assert _normalized_engine_type({"engine_type": None}) == "mock"


def test_normalized_engine_type_returns_mock_when_engine_type_is_blank() -> None:
    """Line 455-456: dict with engine_type='  ' -> fallback 'mock'."""
    assert _normalized_engine_type({"engine_type": "   "}) == "mock"


def test_normalized_engine_type_strips_and_lowercases_valid_value() -> None:
    """Lines 454-455: valid string is stripped and lowercased."""
    assert _normalized_engine_type({"engine_type": "  Ollama  "}) == "ollama"
