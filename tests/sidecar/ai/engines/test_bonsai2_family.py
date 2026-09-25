"""Bonsai 2 is its own ``bonsai2`` family that speaks the Qwen3.8 chat contract.

PrismML's Ternary-Bonsai-2-27B is a ternary Qwen3.8-27B that runs only on
PrismML's llama.cpp fork, so Jenny serves it through the managed llama-server
(the ``openai-compatible`` engine) with Qwen3.8's ``chat_template_kwargs`` and
samplers. Its card has no ``low`` effort (it behaves close to ``xhigh``), so
``minimal``/``low`` -- what cheap background calls send -- turn thinking off.

Only whole 27B forms match (``[ternary-]bonsai-2-27b``, ``[ternary-]bonsai2-27b``):
``ternary-bonsai-2`` is a prefix of the previous generation's
``ternary-bonsai-27b``, and a bare ``bonsai2`` would claim names such as
``bonsai27b``. The profile sets no context window, so the managed server's
served window wins. Engine behaviour is asserted on the live
``BrainContainer.configure`` path.
"""

from __future__ import annotations

import importlib
import json
from collections.abc import Callable, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import MagicMock

import pytest

import sidecar.ai.container as container_mod
from sidecar.ai.app_profiles import (
    ConfigOverrides,
    apply_behavior,
    apply_overrides,
    canonicalize_model_name,
    resolve_profile,
    resolve_variant,
)
from sidecar.ai.app_profiles import qwen38 as qwen38_profile
from sidecar.ai.config import RuntimeConfig
from sidecar.ai.container import BrainContainer
from sidecar.ai.engines import catalog, model_name, ollama_metadata
from sidecar.ai.engines import vllm_engine as vllm_engine_module
from sidecar.ai.engines.factory import EngineSelection
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.provider_http import ProviderHttpService
from sidecar.ai.engines.vllm_engine import VLLMEngine
from sidecar.runtime.local_engine.request_context import bind_chat_request_context
from sidecar.runtime.local_engine.snapshot import build_local_runtime_payload

REPO_ROOT = Path(__file__).resolve().parents[4]
ACCELERATION_CATALOG_PATH = REPO_ROOT / "config" / "model-acceleration-catalog.json"

# The managed llama-server alias: the GGUF file stem, lowercased.
MANAGED_ALIAS = "ternary-bonsai-2-27b-pq2_0"
BONSAI2_NAMES = (
    "Ternary-Bonsai-2-27B-PQ2_0",
    MANAGED_ALIAS,
    "ternary-bonsai-2-27b-pq2-0",  # settings-key form
    "ternary-bonsai-2-27b-pq2_0:latest",
    "hf.co/prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0",
    "Ternary-Bonsai-2-27B-PQ2_0.gguf",
    "/models/prism-ml/Ternary-Bonsai-2-27B-PQ2_0.gguf",
    "Ternary-Bonsai-2-27B-PQ2_0-00001-of-00002.gguf",  # split GGUF stem
    "Bonsai-2-27B-Q1_0",
    # Hyphenless 27B spellings.
    "Bonsai2-27B-PQ2_0",
    "ternary-bonsai2-27b-pq2_0",
    "bonsai2-27b-pq2-0",
    "hf.co/prism-ml/Bonsai2-27B-GGUF:PQ2_0",
)
# Only canonicalize_model_name folds these separators onto the prefixes; the
# profile and the OpenAI-compatible engine must still agree on them.
BONSAI2_SEPARATOR_VARIANTS = ("Ternary_Bonsai_2_27B_PQ2_0", "ternary bonsai 2 27b", "bonsai.2.27b")
# A bare "bonsai2" prefix would claim every one of these; "bonsai2-27b" claims none.
BARE_BONSAI2_LOOKALIKES = ["bonsai2", "bonsai27b", "Bonsai27B", "bonsai2b", "bonsai20", "bonsai2.5"]
BARE_BONSAI2_LOOKALIKES += ["bonsai2:27b", "bonsai2:8b", "bonsai2-chat:latest", "Bonsai2-270M"]
BARE_BONSAI2_LOOKALIKES += ["bonsai2b-instruct:latest"]
# Other sizes and the previous generation ("ternary-bonsai-2" prefixes "ternary-bonsai-27b").
OTHER_BONSAI_NAMES = ["Ternary-Bonsai-27B-PQ2_0", "bonsai-27b-q1_0", "Ternary-Bonsai-8B-PQ2_0"]
OTHER_BONSAI_NAMES += ["Ternary-Bonsai-4B-PQ2_0", "ternary-bonsai-27b-pq2-0", "bonsai-27b"]
OTHER_BONSAI_NAMES += ["bonsai-8b", "bonsai:27b", "Bonsai-2-270M", "bonsai-2-8b"]
OTHER_BONSAI_NAMES += ["ternary-bonsai-2-8b-pq2_0"]
BASE_BEHAVIOUR_NAMES = [*BARE_BONSAI2_LOOKALIKES, *OTHER_BONSAI_NAMES]
QWEN38_MODEL = "qwen3.8:27b-ud-iq3-s"
# An Ollama /api/show payload that advertises no thinking, so the name decides.
OLLAMA_NO_THINKING_INFO = {"capabilities": ["completion", "tools"], "details": {"family": "llama"}}

SAMPLER_KEYS = ("temperature", "top_p", "top_k", "min_p", "presence_penalty", "repeat_penalty")
# Qwen3.8's recipe, which the Bonsai 2 card repeats: thinking on / thinking off.
THINKING_SAMPLER = dict(zip(SAMPLER_KEYS, (1.0, 0.95, 20, 0.0, 0.0, 1.0), strict=True))
INSTRUCT_SAMPLER = dict(zip(SAMPLER_KEYS, (0.7, 0.8, 20, 0.0, 1.5, 1.0), strict=True))
# Jenny effort -> template effort, thinking on. Bonsai 2 has no "low" level.
BONSAI2_THINKING_EFFORTS = [(None, "medium"), ("default", "medium"), ("medium", "medium")]
BONSAI2_THINKING_EFFORTS += [("high", "xhigh"), ("xhigh", "xhigh"), ("max", "xhigh")]
QWEN38_THINKING_EFFORTS = [*BONSAI2_THINKING_EFFORTS, ("minimal", "low"), ("low", "low")]
ODD_EFFORTS = [None, "", "default", "none", "minimal", "low", "medium", "high"]
ODD_EFFORTS += ["xhigh", "max", "MEDIUM", " None "]
BONSAI2_CATALOG_CAPS = {
    "reasoning_effort": True,
    "reasoning_efforts": ["none", "medium", "xhigh"],
    "default_reasoning_effort": "medium",
}
QWEN38_CATALOG_CAPS = {
    "reasoning_effort": True,
    "reasoning_efforts": ["none", "low", "medium", "xhigh"],
    "default_reasoning_effort": "medium",
}


def _isolate_container(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Stub the stack's storage and tool services; the engine path stays real."""
    monkeypatch.setenv("JENNY_OPERATION_LEDGER_ROOT", str(tmp_path / "ledger"))
    for attr, fake in (
        ("MemoryStore", lambda _path: MagicMock()),
        ("ContextBuilder", lambda *_args, **_kwargs: MagicMock()),
        ("MCPClient", lambda **_kwargs: MagicMock()),
        ("ChatRouter", lambda **_kwargs: MagicMock()),
        ("HarnessSnapshotBuilder", lambda **_kwargs: MagicMock()),
        ("resolve_memory_db_path", lambda _config: str(tmp_path / "memory.db")),
        ("resolve_background_runtime_root", lambda _config: tmp_path / "runtime"),
    ):
        monkeypatch.setattr(container_mod, attr, fake)


@pytest.fixture
def containers() -> Iterator[list[BrainContainer]]:
    built: list[BrainContainer] = []
    yield built
    for container in built:
        container.close()


@pytest.fixture
def live_stack(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    containers: list[BrainContainer],
) -> Callable[..., Any]:
    """Configure a real ``BrainContainer`` against a fake managed llama-server."""
    _isolate_container(monkeypatch, tmp_path)
    served: list[str] = []
    props: dict[str, Any] = {}

    def _get_json(self: ProviderHttpService, path: str, **_kwargs: Any) -> dict[str, Any]:
        del self, path
        return {"data": [{"id": model} for model in served]}

    monkeypatch.setattr(ProviderHttpService, "get_json", _get_json)
    monkeypatch.setattr(
        vllm_engine_module, "probe_server_modalities", lambda **_kwargs: dict(props) or None
    )

    def _configure(model: str, *, served_n_ctx: int | None = None, **raw_config: Any) -> Any:
        served[:] = [model]
        props.clear()
        if served_n_ctx is not None:
            props["default_generation_settings"] = {"n_ctx": served_n_ctx}
        container = BrainContainer()
        containers.append(container)
        raw = {"engine_type": "openai-compatible", "model": model, **raw_config}
        stack = container.configure(raw)
        assert stack.engine_fallback_from is None, stack.engine_fallback_reason
        return stack

    return _configure


def _send(stack: Any, effort: str | None, *, background: bool = False) -> dict[str, Any]:
    """Run one request bound the way runtime/chat.py binds it; return the wire payload."""
    engine = stack.engine
    bind_chat_request_context(
        engine,
        request_context=SimpleNamespace(request_id="bonsai2-family", trace_id="bonsai2-family"),
        runtime_config=stack.config,
    )
    captured: dict[str, Any] = {}

    def _post_json(_path: str, payload: dict[str, Any]) -> dict[str, Any]:
        captured.update(payload)
        return {"choices": [{"message": {"content": "ok"}}]}

    engine._service.post_json = _post_json
    try:
        if background:
            # suggestions.py / commit_message.py: a ~300-token call where "low" means cheap.
            cheap = {"max_tokens": 300, "temperature": 0.3, "system": "SYS"}
            engine.generate(prompt="suggest", reasoning_effort=effort, **cheap)
        else:
            engine.generate_with_tools(prompt="hi", tools=[], reasoning_effort=effort)
    finally:
        engine.clear_request_context()
    return captured


def _sampler(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: payload[key] for key in SAMPLER_KEYS}


def _assert_thinks(payload: dict[str, Any], effort: str) -> None:
    assert payload["chat_template_kwargs"] == {"enable_thinking": True, "reasoning_effort": effort}
    assert payload["reasoning_effort"] == effort
    assert _sampler(payload) == THINKING_SAMPLER


def _assert_does_not_think(payload: dict[str, Any]) -> None:
    assert payload["chat_template_kwargs"] == {"enable_thinking": False}
    assert payload["reasoning_effort"] == "none"
    assert _sampler(payload) == INSTRUCT_SAMPLER


def _profiled_config(model: str, engine_type: str) -> RuntimeConfig:
    """Resolve the app profile as ``container._build_candidate_stack`` does."""
    config = RuntimeConfig(engine_type=engine_type, model=model)
    profile = resolve_profile(model)
    assert profile is not None
    variant = resolve_variant(profile, model)
    return apply_behavior(apply_overrides(config, profile, variant), profile, variant)


def _acceleration_families() -> list[dict[str, Any]]:
    return json.loads(ACCELERATION_CATALOG_PATH.read_text(encoding="utf-8"))["families"]


def _first_acceleration_family(model: str) -> str | None:
    """Mirror services/backend/llama-server-acceleration.js ``findFamily``."""
    token = canonicalize_model_name(model)
    for entry in _acceleration_families():
        if any(token.startswith(prefix) for prefix in entry["matchPrefixes"]):
            return str(entry["family"])
    return None


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", BONSAI2_NAMES + BONSAI2_SEPARATOR_VARIANTS)
def test_bonsai2_names_are_bonsai2_to_every_detector(name: str) -> None:
    profile = resolve_profile(name)
    assert profile is not None
    assert profile.family == "bonsai2"
    assert resolve_variant(profile, name).name == "27b"
    assert model_name.is_bonsai2_model(name) is True
    assert model_name.uses_qwen38_chat_contract(name) is True
    assert OpenAICompatibleEngine._detect_thinking(name) is True
    assert _first_acceleration_family(name) == "bonsai2"
    # Its own family: the Qwen3.8-only Ollama graded levels stay closed.
    assert model_name.is_qwen38_model(name) is False
    assert model_name.supports_ollama_reasoning_levels(name) is False


@pytest.mark.parametrize("name", BASE_BEHAVIOUR_NAMES)
def test_non_bonsai2_names_keep_base_behaviour_everywhere(name: str) -> None:
    # Measured against the pre-Bonsai base: no profile, no contract, no thinking.
    assert resolve_profile(name) is None
    assert resolve_profile(name, "bonsai2") is None  # a stale explicit profile never applies
    assert _first_acceleration_family(name) is None
    assert model_name.is_bonsai2_model(name) is False
    assert model_name.uses_qwen38_chat_contract(name) is False
    assert catalog._is_likely_thinking_model(name) is False
    assert VLLMEngine._detect_thinking(name) is False
    assert OpenAICompatibleEngine._detect_thinking(name) is False
    assert ollama_metadata.is_likely_thinking_model(name) is False
    assert ollama_metadata.detect_thinking(name, OLLAMA_NO_THINKING_INFO) == (False, "unsupported")
    assert ollama_metadata.detect_thinking(name, None) == (False, "unsupported")


@pytest.mark.parametrize("name", BASE_BEHAVIOUR_NAMES)
def test_no_bonsai2_prefix_matches_a_non_bonsai2_name_under_a_detection_form(name: str) -> None:
    # The settings-key form (``bonsai2:27b`` -> ``bonsai2-27b``) only picks a variant
    # inside an already-resolved profile, so it is not a detection form.
    forms = {
        model_name.canonical_model_token(name),  # engine + catalog detectors
        canonicalize_model_name(name),  # app-profile aliases, Node acceleration catalog
    }
    for form in forms:
        assert not form.startswith(model_name.BONSAI2_MODEL_PREFIXES), form


def test_only_whole_27b_bonsai2_prefixes_join_thinking_detection() -> None:
    long_forms = ("ternary-bonsai-2-27b", "bonsai-2-27b", "ternary-bonsai2-27b", "bonsai2-27b")
    assert model_name.BONSAI2_MODEL_PREFIXES == long_forms
    assert set(model_name.BONSAI2_MODEL_PREFIXES) <= set(model_name.THINKING_MODEL_PREFIXES)
    assert "bonsai2" not in model_name.THINKING_MODEL_PREFIXES
    assert model_name.QWEN38_MODEL_PREFIXES == ("qwen3.8", "qwen38", "qwen-3.8")
    # One canonicalizer for the profile registry and the engine detectors.
    assert canonicalize_model_name is model_name.canonicalize_model_name


def test_qwen38_stays_its_own_family() -> None:
    assert model_name.is_qwen38_model(QWEN38_MODEL) is True
    assert model_name.is_bonsai2_model(QWEN38_MODEL) is False
    assert model_name.uses_qwen38_chat_contract(QWEN38_MODEL) is True
    assert model_name.supports_ollama_reasoning_levels(QWEN38_MODEL) is True
    profile = resolve_profile(QWEN38_MODEL)
    assert profile is not None
    assert profile.family == "qwen38"


@pytest.mark.parametrize("name", [*BONSAI2_SEPARATOR_VARIANTS, "Bonsai2-27B-PQ2_0"])
def test_non_canonical_spellings_get_the_bonsai2_profile_and_payload_live(
    live_stack: Callable[..., Any], name: str
) -> None:
    stack = live_stack(name)

    assert stack.config.resolved_app_profile_family == "bonsai2"
    assert stack.engine.capabilities["thinking"] is True
    _assert_thinks(_send(stack, "medium"), "medium")


# ---------------------------------------------------------------------------
# App profile and context window
# ---------------------------------------------------------------------------


def test_bonsai2_profile_reuses_the_qwen38_recipe_on_the_managed_llama_server_only() -> None:
    profile = resolve_profile(MANAGED_ALIAS)
    assert profile is not None
    assert importlib.import_module("sidecar.ai.app_profiles.bonsai2").BONSAI2_PROFILE is profile
    assert profile.family == "bonsai2"
    assert profile.label == "Bonsai 2"
    assert profile.family_aliases == model_name.BONSAI2_MODEL_PREFIXES
    assert profile.default_variant == "27b"
    # No context window: the managed server's served window must win.
    assert profile.overrides == ConfigOverrides()
    (variant,) = profile.variants
    assert variant.aliases == ("27b", "bonsai-2-27b")
    assert variant.overrides is None
    assert variant.native_context_length == 262_144
    assert variant.family_supports_vision is True
    behavior = variant.behavior
    assert behavior is not None
    assert behavior.engine_types == ("openai-compatible",)
    assert behavior.max_output_tokens == 32_768
    assert behavior.thinking_token_headroom == 32_768
    assert behavior.thinking_sampler is qwen38_profile.QWEN38_THINKING_SAMPLER
    assert behavior.instruct_sampler is qwen38_profile.QWEN38_INSTRUCT_SAMPLER


def test_the_live_stack_carries_the_bonsai2_profile_values(live_stack: Callable[..., Any]) -> None:
    config = live_stack(MANAGED_ALIAS).config

    assert config.resolved_app_profile_family == "bonsai2"
    assert config.resolved_app_profile_variant == "27b"
    assert config.resolved_app_profile_max_output_tokens == 32_768
    assert config.resolved_app_profile_thinking_token_headroom == 32_768
    assert config.resolved_app_profile_thinking_sampler == THINKING_SAMPLER
    assert config.resolved_app_profile_instruct_sampler == INSTRUCT_SAMPLER
    # R1 follow-up: assert the live output budget here (minimal/low reserve no thinking headroom).


@pytest.mark.parametrize("engine_type", ["ollama", "vllm", "chatgpt"])
def test_bonsai2_request_behavior_never_applies_off_the_llama_server(engine_type: str) -> None:
    configured = _profiled_config(MANAGED_ALIAS, engine_type)

    assert configured.resolved_app_profile_family == "bonsai2"
    assert configured.resolved_app_profile_thinking_sampler is None
    assert configured.resolved_app_profile_max_output_tokens is None


def test_the_managed_servers_window_wins_over_the_profile(live_stack: Callable[..., Any]) -> None:
    # managed-sidecar-config.js sends context_length = the managed server's context size.
    stack = live_stack(MANAGED_ALIAS, served_n_ctx=32_768, context_length=32_768)
    snapshot = build_local_runtime_payload(runtime_config=stack.config, engine=stack.engine)

    assert stack.config.context_length == 32_768
    assert snapshot["context"]["effective_context_length"] == 32_768
    assert stack.engine.get_configured_context_length() == 32_768


def test_the_bonsai2_profile_invents_no_context_window(live_stack: Callable[..., Any]) -> None:
    assert live_stack(MANAGED_ALIAS).config.context_length is None


# ---------------------------------------------------------------------------
# OpenAI-compatible payload on the live path
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("requested", "resolved"), BONSAI2_THINKING_EFFORTS)
def test_bonsai2_thinking_efforts_map_onto_medium_and_xhigh(
    live_stack: Callable[..., Any], requested: str | None, resolved: str
) -> None:
    _assert_thinks(_send(live_stack(MANAGED_ALIAS), requested), resolved)


@pytest.mark.parametrize("requested", ["none", "minimal", "low"])
def test_bonsai2_none_minimal_and_low_turn_thinking_off(
    live_stack: Callable[..., Any], requested: str
) -> None:
    _assert_does_not_think(_send(live_stack(MANAGED_ALIAS), requested))


@pytest.mark.parametrize("requested", ["minimal", "low"])
def test_a_cheap_background_call_on_bonsai2_does_not_think(
    live_stack: Callable[..., Any], requested: str
) -> None:
    payload = _send(live_stack(MANAGED_ALIAS), requested, background=True)

    assert payload["max_tokens"] == 300
    _assert_does_not_think(payload)


@pytest.mark.parametrize("model", [MANAGED_ALIAS, QWEN38_MODEL])
@pytest.mark.parametrize("effort", ODD_EFFORTS)
def test_top_level_effort_always_matches_the_template_kwargs(
    live_stack: Callable[..., Any], model: str, effort: str | None
) -> None:
    payload = _send(live_stack(model), effort)
    kwargs = payload["chat_template_kwargs"]

    if kwargs["enable_thinking"] is False:
        assert kwargs == {"enable_thinking": False}
        assert payload["reasoning_effort"] == "none"
    else:
        assert payload["reasoning_effort"] == kwargs["reasoning_effort"]
    if model == MANAGED_ALIAS:
        # The template raises on anything but xhigh/medium/low; the card rules out low.
        assert kwargs.get("reasoning_effort", "medium") in {"medium", "xhigh"}


def test_bonsai2_rejects_an_unknown_effort_by_family_name(live_stack: Callable[..., Any]) -> None:
    with pytest.raises(ValueError, match="Unsupported Bonsai 2 reasoning effort: turbo"):
        _send(live_stack(MANAGED_ALIAS), "turbo")


@pytest.mark.parametrize("name", [MANAGED_ALIAS, *BONSAI2_SEPARATOR_VARIANTS])
def test_bonsai2_reasoning_content_reaches_the_turn(
    live_stack: Callable[..., Any], name: str
) -> None:
    engine = live_stack(name).engine

    def _post_json(_path: str, _payload: dict[str, Any]) -> dict[str, Any]:
        message = {"content": "answer", "reasoning_content": "weighing the options"}
        return {"choices": [{"message": message}]}

    engine._service.post_json = _post_json
    result = engine.generate_with_tools(prompt="think", tools=[], reasoning_effort="medium")

    assert result.thinking_text == "weighing the options"
    assert result.content == "answer"


@pytest.mark.parametrize(("requested", "resolved"), QWEN38_THINKING_EFFORTS)
def test_qwen38_payload_keeps_its_native_low_effort(
    live_stack: Callable[..., Any], requested: str | None, resolved: str
) -> None:
    _assert_thinks(_send(live_stack(QWEN38_MODEL), requested), resolved)


# ---------------------------------------------------------------------------
# Model catalog (reasoning-effort picker metadata)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", BONSAI2_NAMES + BONSAI2_SEPARATOR_VARIANTS)
def test_every_bonsai2_spelling_gets_a_thinking_row_on_the_openai_compatible_path(
    name: str,
) -> None:
    rows = catalog._parse_vllm_models_payload(
        {"data": [{"id": name}]}, openai_compatible_controls=True
    )

    assert rows == [{"id": name, "capabilities": {"thinking": True, **BONSAI2_CATALOG_CAPS}}]


def _row_thinks(rows: list[Any] | None) -> bool:
    assert rows is not None
    (row,) = rows
    return isinstance(row, dict) and bool(row.get("capabilities", {}).get("thinking"))


# Only the OpenAI-compatible path speaks the Qwen3.8 contract; the Ollama and
# vLLM rows must say what their own engines detect.
@pytest.mark.parametrize("name", BONSAI2_SEPARATOR_VARIANTS)
def test_the_ollama_row_agrees_with_the_ollama_engine_on_thinking(name: str) -> None:
    tag = name.replace(" ", "_") + ":latest"
    rows = catalog._parse_ollama_tags_payload({"models": [{"name": tag, "model": tag}]})
    engine_thinking, _source = ollama_metadata.detect_thinking(tag, OLLAMA_NO_THINKING_INFO)

    assert _row_thinks(rows) is engine_thinking, rows


@pytest.mark.parametrize("name", BONSAI2_SEPARATOR_VARIANTS)
def test_the_vllm_row_agrees_with_the_vllm_engine_on_thinking(name: str) -> None:
    rows = catalog._parse_vllm_models_payload({"data": [{"id": name}]})

    assert _row_thinks(rows) is VLLMEngine._detect_thinking(name), rows


def test_openai_compatible_discovery_row_for_bonsai2(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        catalog, "_get_provider_json", lambda **_kwargs: {"data": [{"id": MANAGED_ALIAS}]}
    )
    # Vision is evidence from /props (the projector is loaded), never the name.
    monkeypatch.setattr(
        catalog, "probe_server_modalities", lambda **_kwargs: {"modalities": {"vision": True}}
    )

    result = catalog.discover_openai_compatible_models()

    assert result.available is True
    capabilities = {"thinking": True, **BONSAI2_CATALOG_CAPS, "vision": True}
    assert result.models == [{"id": MANAGED_ALIAS, "capabilities": capabilities}]


def test_qwen38_catalog_row_keeps_its_native_efforts() -> None:
    rows = catalog._parse_vllm_models_payload(
        {"data": [{"id": QWEN38_MODEL}]},
        openai_compatible_controls=True,
    )

    assert rows == [{"id": QWEN38_MODEL, "capabilities": {"thinking": True, **QWEN38_CATALOG_CAPS}}]


# ---------------------------------------------------------------------------
# Managed llama-server acceleration catalog and the Ollama window
# ---------------------------------------------------------------------------


def test_acceleration_catalog_lists_bonsai2_without_an_mtp_head() -> None:
    families = _acceleration_families()
    entry = next((item for item in families if item["family"] == "bonsai2"), None)
    assert entry is not None
    assert entry["matchPrefixes"] == list(model_name.BONSAI2_MODEL_PREFIXES)
    assert entry["mtp"] == "no"
    assert entry["mtpShape"] == "native"
    assert entry["ngram"] is True
    assert entry["vramHeadroomMb"] == 2048
    qwen38_entry = next(item for item in families if item["family"] == "qwen38")
    assert set(entry) == set(qwen38_entry)


class _RecordingOllamaEngine:
    """Records the window the container pushes via ``set_configured_context_length``."""

    def __init__(self, model: str) -> None:
        self.model_name = model
        self.context_lengths: list[Any] = []

    def load_model(self, model_path: str) -> None:
        self.model_name = model_path

    def unload_model(self, *_args: Any) -> None:
        return None

    def close(self) -> None:
        return None

    def set_configured_context_length(self, value: Any) -> None:
        self.context_lengths.append(value)


@pytest.mark.parametrize("name", ["bonsai27b", "bonsai2b-instruct:latest"])
def test_a_bare_bonsai2_lookalike_keeps_the_ollama_shell_window(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    containers: list[BrainContainer],
    name: str,
) -> None:
    _isolate_container(monkeypatch, tmp_path)
    engine = _RecordingOllamaEngine(name)
    selection = EngineSelection(engine=cast(Any, engine), engine_type="ollama", model=name)
    monkeypatch.setattr(container_mod, "create_engine", lambda _config, **_kwargs: selection)
    container = BrainContainer()
    containers.append(container)
    # managed-sidecar-config.js sends the VRAM-conscious shell window for Ollama.
    stack = container.configure({"engine_type": "ollama", "model": name, "context_length": 32_768})

    assert engine.context_lengths == [32_768]
    assert stack.config.resolved_app_profile_family == ""
