"""H1: the initialize seam brokers secrets without ever writing them to config."""

from __future__ import annotations

import copy
from types import SimpleNamespace

from sidecar.ai.config import RuntimeConfig, parse_runtime_config
from sidecar.ai.context.builder import WorkspaceStatus
from sidecar.runtime.capabilities import (
    _runtime_initialize_config,
    initialize_response,
    initialize_secrets,
)

_SENTINEL = "sentinel-bearer-token-value"


def _stack(config: RuntimeConfig) -> SimpleNamespace:
    return SimpleNamespace(
        config=config,
        engine=SimpleNamespace(capabilities={"text": True}, get_model_context_length=lambda: None),
        router=SimpleNamespace(available_tools=[], tools_status={}),
        mcp_client=SimpleNamespace(diagnostics=lambda: SimpleNamespace(connected=(), failures=())),
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
        engine_fallback_from=None,
        engine_fallback_reason=None,
        secrets={},
    )


class _RecordingBrainContainer:
    """Captures exactly what initialize_response hands BrainContainer.configure."""

    def __init__(self) -> None:
        self.raw_configs: list[dict[str, object]] = []
        self.secrets: list[dict[str, object]] = []

    def configure(self, raw_config, *, secrets=None, progress_callback=None):
        self.raw_configs.append(dict(raw_config) if isinstance(raw_config, dict) else {})
        self.secrets.append(dict(secrets) if isinstance(secrets, dict) else {})
        merged = dict(raw_config) if isinstance(raw_config, dict) else {}
        merged.update(secrets or {})
        return _stack(parse_runtime_config(merged))


# ── _runtime_initialize_config ──────────────────────────────────────


def test_runtime_initialize_config_strips_a_stale_inline_access_token() -> None:
    merged = _runtime_initialize_config(
        {"config": {"engine_type": "chatgpt", "chatgpt_access_token": "stale"}}
    )

    assert merged == {"engine_type": "chatgpt"}
    assert "chatgpt_access_token" not in merged


def test_runtime_initialize_config_strips_every_credential_bearing_key() -> None:
    merged = _runtime_initialize_config(
        {
            "config": {
                "engine_type": "chatgpt",
                "chatgpt_access_token": _SENTINEL,
                "telemetry_dsn": "https://key@sentry.test/1",
                "tools_web_search_provider_keys": {"brave": "brave-key"},
                "openai_api_key": "archived",
            }
        }
    )

    assert merged == {"engine_type": "chatgpt"}


# ── initialize_secrets ──────────────────────────────────────────────


def test_initialize_secrets_returns_only_brokered_keys() -> None:
    secrets = initialize_secrets(
        {
            "secrets": {
                "chatgpt_access_token": _SENTINEL,
                "tools_web_search_provider_keys": {"brave": "brave-key"},
                "telemetry_dsn": "https://key@sentry.test/1",
                "openai_api_key": "archived",
            }
        }
    )

    assert secrets == {
        "chatgpt_access_token": _SENTINEL,
        "tools_web_search_provider_keys": {"brave": "brave-key"},
    }
    # telemetry_dsn is consumed straight off params["secrets"] by
    # _apply_telemetry_config; brokering it would put it back in a config dict.
    assert "telemetry_dsn" not in secrets


def test_initialize_secrets_stringifies_the_access_token_and_skips_none() -> None:
    assert initialize_secrets({"secrets": {"chatgpt_access_token": 12345}}) == {
        "chatgpt_access_token": "12345"
    }
    assert initialize_secrets({"secrets": {"chatgpt_access_token": None}}) == {}


def test_initialize_secrets_stringifies_the_openai_compatible_api_key() -> None:
    assert initialize_secrets({"secrets": {"openai_compatible_api_key": 12345}}) == {
        "openai_compatible_api_key": "12345"
    }
    assert initialize_secrets({"secrets": {"openai_compatible_api_key": None}}) == {}


def test_initialize_secrets_ignores_invalid_payload_shapes() -> None:
    assert initialize_secrets(None) == {}
    assert initialize_secrets({}) == {}
    assert initialize_secrets({"secrets": "bad"}) == {}


# ── initialize_response wiring ──────────────────────────────────────


def test_initialize_response_does_not_mutate_the_request_params() -> None:
    # The deleted _merge_initialize_secrets mutated params["config"] in place,
    # which is how the token reached BrainStack.raw_config in the first place.
    params = {
        "config": {"engine_type": "chatgpt", "model": "gpt-5.5"},
        "secrets": {"chatgpt_access_token": _SENTINEL},
    }
    before = copy.deepcopy(params)

    initialize_response(
        1,
        params,
        api_version="2026-03-06",
        brain_container=_RecordingBrainContainer(),
    )

    assert params == before
    assert "chatgpt_access_token" not in params["config"]


def test_initialize_response_brokers_the_token_off_config_into_secrets() -> None:
    container = _RecordingBrainContainer()

    initialize_response(
        1,
        {
            "config": {"engine_type": "chatgpt", "model": "gpt-5.5"},
            "secrets": {"chatgpt_access_token": _SENTINEL},
        },
        api_version="2026-03-06",
        brain_container=container,
    )

    assert container.raw_configs == [{"engine_type": "chatgpt", "model": "gpt-5.5"}]
    assert container.secrets == [{"chatgpt_access_token": _SENTINEL}]


def test_initialize_response_brokers_secrets_on_the_progress_callback_branch() -> None:
    container = _RecordingBrainContainer()

    initialize_response(
        1,
        {
            "config": {"engine_type": "chatgpt"},
            "secrets": {"chatgpt_access_token": _SENTINEL},
        },
        api_version="2026-03-06",
        brain_container=container,
        progress_callback=lambda _progress: None,
    )

    assert container.secrets == [{"chatgpt_access_token": _SENTINEL}]


def test_runtime_config_still_parses_the_chatgpt_fields() -> None:
    # Coverage moved here from test_chatgpt_subscription.py's deleted
    # _merge_initialize_secrets test. RuntimeConfig.chatgpt_access_token STAYS:
    # engines/factory.py and runtime/provider_capabilities.py read it in-process.
    config = parse_runtime_config(
        {
            "engine_type": "chatgpt",
            "chatgpt_access_token": " config-token ",
            "chatgpt_account_id": " acct_789 ",
            "chatgpt_base_url": " https://example.test/backend-api/codex ",
        }
    )

    assert config.model == ""
    assert config.chatgpt_access_token == "config-token"
    assert config.chatgpt_account_id == "acct_789"
    assert config.chatgpt_base_url == "https://example.test/backend-api/codex"


def test_runtime_config_parses_openai_compatible_api_key_without_repr_leak() -> None:
    config = parse_runtime_config(
        {
            "engine_type": "openai-compatible",
            "openai_compatible_api_key": " secret-key ",
        }
    )

    assert config.openai_compatible_api_key == "secret-key"
    assert "secret-key" not in repr(config)
