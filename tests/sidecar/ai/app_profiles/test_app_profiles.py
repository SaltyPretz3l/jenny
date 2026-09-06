"""Tests for the app profile system."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

import pytest

from sidecar.ai.app_profiles import (
    _REGISTRY,
    AppProfile,
    ConfigOverrides,
    apply_behavior,
    apply_overrides,
    canonicalize_model_name,
    resolve_profile,
    resolve_variant,
)
from sidecar.ai.config import RuntimeConfig

# ---------------------------------------------------------------------------
# canonicalize_model_name
# ---------------------------------------------------------------------------


def test_canonicalize_bare_name() -> None:
    assert canonicalize_model_name("gemma4-e4b-it") == "gemma4-e4b-it"


def test_canonicalize_hf_repo_id() -> None:
    assert canonicalize_model_name("Google/Gemma-4-E4B-IT") == "gemma-4-e4b-it"


def test_canonicalize_ollama_tag() -> None:
    assert canonicalize_model_name("gemma4:26b-a4b-it-q4_K_M") == "gemma4"


def test_canonicalize_vllm_style() -> None:
    assert canonicalize_model_name("some-org/gemma-4-e4b-it") == "gemma-4-e4b-it"


def test_canonicalize_empty_string() -> None:
    assert canonicalize_model_name("") == ""


def test_canonicalize_preserves_numeric_segments() -> None:
    assert canonicalize_model_name("gemma4-26b-a4b-it") == "gemma4-26b-a4b-it"


# ---------------------------------------------------------------------------
# resolve_profile — happy path
# ---------------------------------------------------------------------------


def test_resolve_profile_detects_gemma4() -> None:
    profile = resolve_profile("gemma4-e4b-it-ud-q5_k_xl:latest")
    assert profile is not None
    assert profile.family == "gemma4"


def test_resolve_profile_detects_hf_repo_id() -> None:
    profile = resolve_profile("google/gemma-4-26B-A4B-it")
    assert profile is not None
    assert profile.family == "gemma4"


def test_resolve_profile_returns_none_for_non_gemma() -> None:
    assert resolve_profile("llama3.2:8b") is None


def test_resolve_profile_returns_none_for_claude() -> None:
    assert resolve_profile("claude-sonnet-4-6") is None


# ---------------------------------------------------------------------------
# resolve_profile — explicit mismatch
# ---------------------------------------------------------------------------


def test_resolve_profile_explicit_matches() -> None:
    profile = resolve_profile("gemma4-e4b-it", explicit="gemma4")
    assert profile is not None
    assert profile.family == "gemma4"


def test_resolve_profile_stale_explicit_falls_back() -> None:
    """Stale app_profile for a non-Gemma model falls back to auto-detect."""
    profile = resolve_profile("claude-sonnet-4-6", explicit="gemma4")
    assert profile is None  # auto-detect finds nothing for Claude


def test_resolve_profile_unknown_explicit_falls_back() -> None:
    """Unknown explicit profile falls back to auto-detect."""
    profile = resolve_profile("gemma4-e4b-it", explicit="nonexistent")
    assert profile is not None
    assert profile.family == "gemma4"


def test_resolve_profile_blank_model_with_explicit() -> None:
    """Explicit seeds when model string is blank."""
    profile = resolve_profile("", explicit="gemma4")
    assert profile is not None
    assert profile.family == "gemma4"


# ---------------------------------------------------------------------------
# resolve_variant
# ---------------------------------------------------------------------------


def test_resolve_variant_e4b() -> None:
    profile = resolve_profile("gemma4-e4b-it-ud-q5_k_xl:latest")
    assert profile is not None
    variant = resolve_variant(profile, "gemma4-e4b-it-ud-q5_k_xl:latest")
    assert variant.name == "e4b"


def test_resolve_variant_12b() -> None:
    # The 12B (dense, 256K native) must resolve to its own variant rather than
    # falling back to the 4B e4b default — including the full HF GGUF repo id.
    model = "hf.co/unsloth/gemma-4-12b-it-GGUF:UD-Q5_K_XL"
    profile = resolve_profile(model)
    assert profile is not None
    variant = resolve_variant(profile, model)
    assert variant.name == "12b"
    assert variant.param_billions == 12.0
    assert variant.native_context_length == 262_144


def test_resolve_variant_e2b() -> None:
    profile = resolve_profile("gemma4-e2b-it")
    assert profile is not None
    variant = resolve_variant(profile, "gemma4-e2b-it")
    assert variant.name == "e2b"


def test_resolve_variant_26b_a4b() -> None:
    profile = resolve_profile("gemma4-26b-a4b-it")
    assert profile is not None
    variant = resolve_variant(profile, "gemma4-26b-a4b-it")
    assert variant.name == "26b-a4b"


def test_resolve_variant_31b() -> None:
    profile = resolve_profile("gemma4-31b-it")
    assert profile is not None
    variant = resolve_variant(profile, "gemma4-31b-it")
    assert variant.name == "31b"


def test_resolve_variant_hf_repo_26b_a4b() -> None:
    profile = resolve_profile("google/gemma-4-26B-A4B-it")
    assert profile is not None
    variant = resolve_variant(profile, "google/gemma-4-26B-A4B-it")
    assert variant.name == "26b-a4b"


def test_resolve_variant_ollama_tag_26b_a4b() -> None:
    profile = resolve_profile("gemma4:26b-a4b-it-q4_K_M")
    assert profile is not None
    # Variant detection intentionally reads the Ollama tag after ':' so local
    # quantized tags still inherit the matching family variant behavior.
    variant = resolve_variant(profile, "gemma4:26b-a4b-it-q4_K_M")
    assert variant.name == "26b-a4b"


def test_resolve_variant_vllm_style() -> None:
    profile = resolve_profile("some-org/gemma-4-e4b-it")
    assert profile is not None
    variant = resolve_variant(profile, "some-org/gemma-4-e4b-it")
    assert variant.name == "e4b"


def test_resolve_variant_unknown_falls_back_to_default() -> None:
    profile = resolve_profile("gemma4-something-custom")
    assert profile is not None
    variant = resolve_variant(profile, "gemma4-something-custom")
    assert variant.name == "e4b"


# ---------------------------------------------------------------------------
# apply_overrides
# ---------------------------------------------------------------------------


def test_apply_overrides_sets_family_defaults() -> None:
    profile = resolve_profile("gemma4-e4b-it")
    assert profile is not None
    variant = resolve_variant(profile, "gemma4-e4b-it")
    config = RuntimeConfig()
    result = apply_overrides(config, profile, variant)
    assert result.context_length == 32768
    assert result.tools_image_read_enabled is True


def test_apply_overrides_variant_wins_over_family() -> None:
    """E2B variant override (context_length=8192) wins over family (32768)."""
    profile = resolve_profile("gemma4-e2b-it")
    assert profile is not None
    variant = resolve_variant(profile, "gemma4-e2b-it")
    config = RuntimeConfig()
    result = apply_overrides(config, profile, variant)
    assert result.context_length == 8192
    assert result.tools_image_read_enabled is True


def test_apply_overrides_does_not_touch_other_fields() -> None:
    """temperature and max_tokens are NOT in v1 override set."""
    profile = resolve_profile("gemma4-e4b-it")
    assert profile is not None
    variant = resolve_variant(profile, "gemma4-e4b-it")
    config = RuntimeConfig(temperature=0.3, max_tokens=2048)
    result = apply_overrides(config, profile, variant)
    assert result.temperature == 0.3
    assert result.max_tokens == 2048


def test_apply_overrides_overwrites_existing_context_length() -> None:
    """v1 unconditionally applies overrides — even if config has a value."""
    profile = resolve_profile("gemma4-e4b-it")
    assert profile is not None
    variant = resolve_variant(profile, "gemma4-e4b-it")
    config = RuntimeConfig(context_length=4096)
    result = apply_overrides(config, profile, variant)
    assert result.context_length == 32768


# ---------------------------------------------------------------------------
# apply_behavior
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("engine_type", ["ollama", "openai-compatible"])
def test_apply_behavior_sets_request_time_gemma_defaults_for_local_engines(
    engine_type: str,
) -> None:
    profile = resolve_profile("gemma4-e4b-it")
    assert profile is not None
    variant = resolve_variant(profile, "gemma4-e4b-it")
    config = RuntimeConfig(engine_type=engine_type)

    result = apply_behavior(config, profile, variant)

    assert result.resolved_app_profile_family == "gemma4"
    assert result.resolved_app_profile_variant == "e4b"
    assert result.resolved_app_profile_temperature == 1.0
    assert result.resolved_app_profile_top_k == 40
    assert result.resolved_app_profile_reasoning_parser_start == "<|channel>thought"
    assert result.resolved_app_profile_reasoning_parser_end == "<channel|>"
    assert "Gemma 4 runtime guidance" in result.resolved_app_profile_prompt_addendum


def test_apply_behavior_keeps_non_local_engines_metadata_only() -> None:
    profile = resolve_profile("gemma4-e4b-it")
    assert profile is not None
    variant = resolve_variant(profile, "gemma4-e4b-it")
    config = RuntimeConfig(engine_type="anthropic")

    result = apply_behavior(config, profile, variant)

    assert result.resolved_app_profile_family == "gemma4"
    assert result.resolved_app_profile_variant == "e4b"
    assert result.resolved_app_profile_temperature is None
    assert result.resolved_app_profile_top_k is None
    assert result.resolved_app_profile_prompt_addendum == ""


def test_ollama_profile_scopes_include_managed_llama_server() -> None:
    """Managed llama-server serves the same local GGUF models as Ollama."""
    for profile in _REGISTRY.values():
        for variant in profile.variants:
            engine_types = profile.behavior.engine_types
            if variant.behavior is not None and variant.behavior.engine_types:
                engine_types = variant.behavior.engine_types
            if "ollama" in engine_types:
                assert "openai-compatible" in engine_types, (profile.family, variant.name)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def test_resolve_profile_includes_gemma4() -> None:
    profile = resolve_profile("gemma4")
    assert profile is not None
    assert profile.family == "gemma4"


@pytest.mark.parametrize("engine_type", ["ollama", "openai-compatible"])
def test_qwen38_profile_resolves_128k_and_mode_specific_local_behavior(
    engine_type: str,
) -> None:
    model = "hf.co/unsloth/Qwen3.8-27B-GGUF:Q3_K_S"
    profile = resolve_profile(model)
    assert profile is not None
    assert profile.family == "qwen38"
    variant = resolve_variant(profile, model)
    assert variant.name == "27b"
    assert variant.native_context_length == 262_144

    configured = apply_overrides(RuntimeConfig(engine_type=engine_type), profile, variant)
    configured = apply_behavior(configured, profile, variant)

    assert configured.context_length == 131_072
    assert configured.resolved_app_profile_max_output_tokens == 32_768
    assert configured.resolved_app_profile_thinking_token_headroom == 32_768
    assert configured.resolved_app_profile_thinking_sampler == {
        "temperature": 1.0,
        "top_p": 0.95,
        "top_k": 20,
        "min_p": 0.0,
        "presence_penalty": 0.0,
        "repeat_penalty": 1.0,
    }
    assert configured.resolved_app_profile_instruct_sampler == {
        "temperature": 0.7,
        "top_p": 0.8,
        "top_k": 20,
        "min_p": 0.0,
        "presence_penalty": 1.5,
        "repeat_penalty": 1.0,
    }


def test_qwen38_mode_specific_behavior_does_not_leak_to_chatgpt() -> None:
    model = "qwen3.8:27b-q3-k-s"
    profile = resolve_profile(model)
    assert profile is not None
    variant = resolve_variant(profile, model)

    configured = apply_behavior(RuntimeConfig(engine_type="chatgpt"), profile, variant)

    assert configured.resolved_app_profile_family == "qwen38"
    assert configured.resolved_app_profile_thinking_sampler is None
    assert configured.resolved_app_profile_max_output_tokens is None


def test_registry_populated_on_import() -> None:
    """Importing app_profiles should auto-register gemma4."""
    profile = resolve_profile("gemma4-e4b-it")
    assert profile is not None


# ---------------------------------------------------------------------------
# register_profile — validation
# ---------------------------------------------------------------------------


def test_register_duplicate_family_raises() -> None:
    import pytest

    from sidecar.ai.app_profiles import register_profile
    from sidecar.ai.app_profiles.gemma4 import GEMMA4_PROFILE

    with pytest.raises(ValueError, match="duplicate"):
        register_profile(GEMMA4_PROFILE)


def test_register_duplicate_alias_raises() -> None:
    import pytest

    from sidecar.ai.app_profiles import register_profile

    fake = AppProfile(
        family="fake",
        label="Fake",
        family_aliases=("gemma4",),  # collides with existing
        variants=(),
        default_variant="",
        overrides=ConfigOverrides(),
    )
    with pytest.raises(ValueError, match="collides"):
        register_profile(fake)


# ---------------------------------------------------------------------------
# End-to-end: proof-of-concept flow
# ---------------------------------------------------------------------------


def test_proof_of_concept_e4b_target() -> None:
    """The target artifact gemma4-e4b-it-ud-q5_k_xl:latest resolves correctly."""
    model = "gemma4-e4b-it-ud-q5_k_xl:latest"
    config = RuntimeConfig(
        engine_type="ollama",
        model=model,
        temperature=0.7,
        max_tokens=16384,
    )

    profile = resolve_profile(model, config.app_profile or None)
    assert profile is not None
    assert profile.family == "gemma4"

    variant = resolve_variant(profile, model)
    assert variant.name == "e4b"
    assert variant.native_context_length == 131_072

    result = apply_overrides(config, profile, variant)
    assert result.context_length == 32768
    assert result.tools_image_read_enabled is True
    # Generic knobs untouched
    assert result.temperature == 0.7
    assert result.max_tokens == 16384


def test_no_profile_path_unchanged() -> None:
    """Non-Gemma models produce no profile and config is unchanged."""
    config = RuntimeConfig(
        engine_type="anthropic",
        model="claude-sonnet-4-6",
        temperature=0.5,
    )
    profile = resolve_profile(config.model)
    assert profile is None
    # Config stays as-is
    assert config.temperature == 0.5
    assert config.tools_image_read_enabled is False


# ---------------------------------------------------------------------------
# Integration: BrainContainer.configure()
# ---------------------------------------------------------------------------


@dataclass
class _StubEngine:
    """Minimal engine stand-in for BrainContainer tests."""

    model_name: str = ""

    def load_model(self, model_path: str) -> None:
        self.model_name = model_path

    def unload_model(self) -> None:
        pass

    def close(self) -> None:
        pass


def _make_engine_selection(model: str, engine_type: str = "ollama") -> Any:
    from sidecar.ai.engines.factory import EngineSelection

    return EngineSelection(
        engine=_StubEngine(model_name=model),
        engine_type=engine_type,
        model=model,
    )


def _make_mock_fallback(original_model: str) -> Any:
    """Simulate create_engine falling back to mock."""
    from sidecar.ai.engines.factory import EngineSelection

    return EngineSelection(
        engine=_StubEngine(model_name="mock-v1"),
        engine_type="mock",
        model="mock-v1",
        fallback_from="ollama",
        fallback_reason=f"OllamaEngine failed for {original_model}",
    )


@pytest.fixture()
def _patch_container_deps(monkeypatch: pytest.MonkeyPatch, tmp_path):
    """Patch heavy BrainContainer dependencies so configure() runs fast."""
    import sidecar.ai.container as container_mod

    # Lightweight fakes for subsystems that don't matter for profile tests.
    monkeypatch.setattr(container_mod, "MemoryStore", lambda path: MagicMock())
    monkeypatch.setattr(
        container_mod,
        "ContextBuilder",
        lambda *a, **kw: MagicMock(),
    )
    monkeypatch.setattr(container_mod, "MCPClient", lambda **kw: MagicMock())
    monkeypatch.setattr(container_mod, "ChatRouter", lambda **kw: MagicMock())
    monkeypatch.setattr(
        container_mod,
        "HarnessSnapshotBuilder",
        lambda **kw: MagicMock(),
    )
    monkeypatch.setattr(
        container_mod,
        "resolve_memory_db_path",
        lambda cfg: str(tmp_path / "mem.db"),
    )
    # Keep MonitorManager off the live runtime root: its constructor prunes (i.e.
    # DELETES) terminal status records, and configure() calls
    # recover_stale_monitors(), which rewrites running+persistent monitors to
    # state="stale" under ~/.companion/background-memory.
    monkeypatch.setattr(
        container_mod,
        "resolve_background_runtime_root",
        lambda cfg: tmp_path / "runtime",
    )


@pytest.mark.usefixtures("_patch_container_deps")
class TestBrainContainerIntegration:
    """Plan items 23-26: profile overrides flow through BrainContainer.configure()."""

    def test_gemma4_e4b_applies_overrides(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Plan #23: e4b target gets context_length=32768 and vision enabled."""
        import sidecar.ai.container as container_mod

        model = "gemma4-e4b-it-ud-q5_k_xl:latest"
        monkeypatch.setattr(
            container_mod,
            "create_engine",
            lambda cfg, **_kwargs: _make_engine_selection(model),
        )

        from sidecar.ai.container import BrainContainer

        bc = BrainContainer()
        stack = bc.configure({"engine_type": "ollama", "model": model})

        assert stack.config.context_length == 32768
        assert stack.config.tools_image_read_enabled is True
        assert stack.config.resolved_app_profile_family == "gemma4"
        assert stack.config.resolved_app_profile_variant == "e4b"
        assert stack.config.resolved_app_profile_temperature == 1.0
        assert stack.config.resolved_app_profile_top_k == 40
        assert "<|channel>thought" in stack.config.system_prompt

    def test_gemma4_e2b_variant_override(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Plan #24: e2b variant gets context_length=8192."""
        import sidecar.ai.container as container_mod

        model = "gemma4-e2b-it"
        monkeypatch.setattr(
            container_mod,
            "create_engine",
            lambda cfg, **_kwargs: _make_engine_selection(model),
        )

        from sidecar.ai.container import BrainContainer

        bc = BrainContainer()
        stack = bc.configure({"engine_type": "ollama", "model": model})

        assert stack.config.context_length == 8192
        assert stack.config.tools_image_read_enabled is True

    def test_no_profile_path_unchanged(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Plan #25: non-Gemma model behaves identically to before."""
        import sidecar.ai.container as container_mod

        model = "claude-sonnet-4-6"
        monkeypatch.setattr(
            container_mod,
            "create_engine",
            lambda cfg, **_kwargs: _make_engine_selection(model, engine_type="anthropic"),
        )

        from sidecar.ai.container import BrainContainer

        bc = BrainContainer()
        stack = bc.configure(
            {
                "engine_type": "anthropic",
                "model": model,
                "temperature": 0.5,
            }
        )

        # Profile system should not touch anything
        assert stack.config.tools_image_read_enabled is False
        assert stack.config.temperature == 0.5
        assert stack.config.resolved_app_profile_family == ""

    def test_mock_fallback_no_profile_applied(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Plan #26: when create_engine falls back to mock, profile resolution
        runs against 'mock-v1' and finds no match — overrides are NOT applied."""
        import sidecar.ai.container as container_mod

        original_model = "gemma4-e4b-it-ud-q5_k_xl:latest"
        monkeypatch.setattr(
            container_mod,
            "create_engine",
            lambda cfg, **_kwargs: _make_mock_fallback(original_model),
        )

        from sidecar.ai.container import BrainContainer

        bc = BrainContainer()
        stack = bc.configure({"engine_type": "ollama", "model": original_model})

        # Mock fallback changes the model to "mock-v1" — no profile matches.
        assert stack.config.model == "mock-v1"
        assert stack.config.tools_image_read_enabled is False
        assert stack.config.resolved_app_profile_family == ""
        assert stack.engine_fallback_from == "ollama"


# ---------------------------------------------------------------------------
# Vision detection in engines (plan item 27)
# ---------------------------------------------------------------------------


def test_ollama_detect_vision_gemma4() -> None:
    """Plan #27a: gemma4 is detected as a vision model by Ollama engine."""
    from sidecar.ai.engines.ollama import OllamaEngine

    assert OllamaEngine._detect_vision("gemma4-e4b-it", None) is True
    assert OllamaEngine._detect_vision("gemma4-26b-a4b-it", None) is True
    assert OllamaEngine._detect_vision("llama3.2:8b", None) is False


def test_catalog_vision_detection_gemma4() -> None:
    """Plan #27b: gemma4 is detected as a vision model by the catalog."""
    from sidecar.ai.engines.catalog import _is_likely_vision_model

    assert _is_likely_vision_model("gemma4-e4b-it") is True
    assert _is_likely_vision_model("gemma4-26b-a4b-it") is True
    assert _is_likely_vision_model("llama3.2:8b") is False


# ---------------------------------------------------------------------------
# Qwen3.6 profile (Slice A / Task 1)
# ---------------------------------------------------------------------------


QWEN36_MODEL_IDS = [
    "Qwen/Qwen3.6-35B-A3B",
    "qwen3.6-35b-a3b",
    "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
    "unsloth/Qwen3.6-35B-A3B-GGUF",
]


@pytest.mark.parametrize("model_id", QWEN36_MODEL_IDS)
def test_resolve_profile_detects_qwen36(model_id: str) -> None:
    profile = resolve_profile(model_id)
    assert profile is not None
    assert profile.family == "qwen36"


@pytest.mark.parametrize("model_id", QWEN36_MODEL_IDS)
def test_resolve_variant_qwen36_35b_a3b(model_id: str) -> None:
    profile = resolve_profile(model_id)
    assert profile is not None
    variant = resolve_variant(profile, model_id)
    assert variant.name == "35b-a3b"
    assert variant.param_billions == 35.0
    assert variant.active_param_billions == 3.0
    assert variant.native_context_length == 262_144
    assert variant.is_moe is True


def test_registry_includes_qwen36() -> None:
    profile = resolve_profile("qwen36")
    assert profile is not None
    assert profile.family == "qwen36"


def test_apply_behavior_qwen36_sampler_preset_on_vllm() -> None:
    """Qwen3.6 sampler preset flows into RuntimeConfig for vLLM engine."""
    profile = resolve_profile("Qwen/Qwen3.6-35B-A3B")
    assert profile is not None
    variant = resolve_variant(profile, "Qwen/Qwen3.6-35B-A3B")
    config = RuntimeConfig(engine_type="vllm")

    result = apply_behavior(config, profile, variant)

    assert result.resolved_app_profile_family == "qwen36"
    assert result.resolved_app_profile_variant == "35b-a3b"
    assert result.resolved_app_profile_temperature == 0.6
    assert result.resolved_app_profile_top_k == 20
    assert result.resolved_app_profile_top_p == 0.95
    assert result.resolved_app_profile_min_p == 0.0
    assert result.resolved_app_profile_presence_penalty == 0.0
    assert result.resolved_app_profile_repeat_penalty == 1.0


def test_apply_behavior_qwen36_out_of_scope_engine_metadata_only() -> None:
    """Non-scoped engines keep family/variant metadata but not sampler fields."""
    profile = resolve_profile("Qwen/Qwen3.6-35B-A3B")
    assert profile is not None
    variant = resolve_variant(profile, "Qwen/Qwen3.6-35B-A3B")
    config = RuntimeConfig(engine_type="anthropic")

    result = apply_behavior(config, profile, variant)

    assert result.resolved_app_profile_family == "qwen36"
    assert result.resolved_app_profile_variant == "35b-a3b"
    assert result.resolved_app_profile_temperature is None
    assert result.resolved_app_profile_top_k is None
    assert result.resolved_app_profile_top_p is None
    assert result.resolved_app_profile_min_p is None
    assert result.resolved_app_profile_presence_penalty is None
    assert result.resolved_app_profile_repeat_penalty is None


def test_apply_behavior_qwen36_sampler_preset_on_openai_compatible() -> None:
    """Slice B scope: openai-compatible receives the full Qwen3 thinking preset."""
    profile = resolve_profile("Qwen/Qwen3.6-35B-A3B")
    assert profile is not None
    variant = resolve_variant(profile, "Qwen/Qwen3.6-35B-A3B")
    config = RuntimeConfig(engine_type="openai-compatible")

    result = apply_behavior(config, profile, variant)

    assert result.resolved_app_profile_family == "qwen36"
    assert result.resolved_app_profile_variant == "35b-a3b"
    assert result.resolved_app_profile_temperature == 0.6
    assert result.resolved_app_profile_top_k == 20
    assert result.resolved_app_profile_top_p == 0.95
    assert result.resolved_app_profile_min_p == 0.0
    assert result.resolved_app_profile_presence_penalty == 0.0
    assert result.resolved_app_profile_repeat_penalty == 1.0


def test_apply_overrides_qwen36_uses_128k_context() -> None:
    """Native context is 262,144 but default override is 131,072 per model-card guidance."""
    profile = resolve_profile("Qwen/Qwen3.6-35B-A3B")
    assert profile is not None
    variant = resolve_variant(profile, "Qwen/Qwen3.6-35B-A3B")
    config = RuntimeConfig(engine_type="vllm")
    result = apply_overrides(config, profile, variant)
    assert result.context_length == 131_072


# ---------------------------------------------------------------------------
# ornith15 profile
# ---------------------------------------------------------------------------


def test_resolve_profile_detects_ornith15_local_tag() -> None:
    profile = resolve_profile("ornith15:9b-q6-256k")
    assert profile is not None
    assert profile.family == "ornith15"


def test_resolve_profile_detects_ornith15_hf_pull_tag() -> None:
    profile = resolve_profile("hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q8_0")
    assert profile is not None
    assert profile.family == "ornith15"


def test_resolve_profile_ignores_ornith_1_0_tag() -> None:
    """ornith:9b-48k (Ornith 1.0) is deliberately unmatched — its chat-template
    workarounds live elsewhere and its sampler behavior was never diagnosed."""
    assert resolve_profile("ornith:9b-48k") is None


def test_apply_behavior_ornith15_repeat_penalty_replaces_thinking_fallback() -> None:
    """The profile exists to replace the unprofiled 1.15 thinking fallback,
    which suppressed the newline token on long Ornith thinking streams
    (sess_1788049580063: 19/19 reasoning entries with zero newlines)."""
    profile = resolve_profile("ornith15:9b-q6-256k")
    assert profile is not None
    variant = resolve_variant(profile, "ornith15:9b-q6-256k")
    config = RuntimeConfig(engine_type="ollama")

    result = apply_behavior(config, profile, variant)

    assert result.resolved_app_profile_family == "ornith15"
    assert result.resolved_app_profile_variant == "9b"
    assert result.resolved_app_profile_repeat_penalty == 1.05
    # Only the repetition guard is pinned: no invented sampler recipe.
    assert result.resolved_app_profile_thinking_sampler is None
    assert result.resolved_app_profile_instruct_sampler is None
    assert result.resolved_app_profile_temperature is None


def test_apply_overrides_ornith15_leaves_owner_context_choices_alone() -> None:
    """The owner's per-tag context re-quants (48k/256k) must win; the profile
    carries empty ConfigOverrides on purpose."""
    profile = resolve_profile("ornith15:9b-q6-256k")
    assert profile is not None
    variant = resolve_variant(profile, "ornith15:9b-q6-256k")
    config = RuntimeConfig(context_length=4096)
    result = apply_overrides(config, profile, variant)
    assert result.context_length == 4096
