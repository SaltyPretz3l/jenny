"""F14: every context-window read must use the window requests are SERVED with.

``engine.get_model_context_length()`` returns the model's NATIVE window (read
off ``/api/show`` for Ollama), but every Ollama request is stamped with
``options['num_ctx']`` from the CONFIGURED context length. Budgeting off the
native number means auto-compaction and the error threshold cannot fire before
the runner's real window is blown -- shipped clamp 32768 against a typical
131072 native window, and up to 15x on an app profile (gemma4:4b = 8192
configured vs 128000 native).

These pin the clamp at EVERY read site, because the defect was an OR-chain at a
call site rather than a bug inside a shared resolver.
"""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.context.token_budget import (
    DEFAULT_CONTEXT_WINDOW,
    TokenBudget,
    apply_budget_check,
    resolve_auto_compact_ratio,
    resolve_context_window_hint,
    resolve_effective_context_window,
)
from sidecar.runtime.chat_helpers import (
    attach_compact_threshold,
    attach_context_used_tokens,
    attach_context_window,
)

NATIVE = 131_072
CONFIGURED = 32_768


class _OllamaLikeEngine:
    """Only OllamaEngine exposes ``get_configured_context_length`` today."""

    def get_model_context_length(self) -> int:
        return NATIVE

    def get_configured_context_length(self) -> int:
        return CONFIGURED

    def get_model_max_output_tokens(self) -> int:
        return 8_000


class _ProviderEngine:
    """chatgpt / vLLM / provider_http: no per-request num_ctx, so no clamp."""

    def get_model_context_length(self) -> int:
        return 272_000

    def get_model_max_output_tokens(self) -> int:
        return 16_384


class _NullEngine:
    def get_model_context_length(self) -> None:
        return None

    def get_model_max_output_tokens(self) -> None:
        return None


def _config(context_length: int | None = 8_192) -> SimpleNamespace:
    return SimpleNamespace(
        context_length=context_length,
        max_tokens=4_000,
        model="gemma4:4b",
        engine_type="ollama",
    )


# ── the resolver itself ──────────────────────────────────────────────────────


def test_configured_clamp_wins_over_the_native_window() -> None:
    assert resolve_effective_context_window(_OllamaLikeEngine(), _config()) == CONFIGURED
    assert resolve_context_window_hint(_OllamaLikeEngine(), _config()) == CONFIGURED


def test_native_wins_when_it_is_the_smaller_of_the_two() -> None:
    class _Engine(_OllamaLikeEngine):
        def get_model_context_length(self) -> int:
            return 4_096

    # min(configured, native) -- the same rule context_metadata_payload applies.
    assert resolve_effective_context_window(_Engine(), _config()) == 4_096


def test_provider_engines_are_not_clamped_by_config_context_length() -> None:
    # Deliberate: chatgpt/vLLM/provider_http do not stamp a per-request num_ctx,
    # so clamping them by config.context_length would shrink their budget for no
    # reason. Byte-identical to the pre-fix OR-chain for these engines.
    assert resolve_effective_context_window(_ProviderEngine(), _config()) == 272_000


def test_config_context_length_is_the_fallback_when_the_engine_knows_nothing() -> None:
    assert resolve_effective_context_window(_NullEngine(), _config()) == 8_192


def test_unknown_window_falls_back_to_the_module_default() -> None:
    assert resolve_effective_context_window(_NullEngine(), None) == DEFAULT_CONTEXT_WINDOW
    # ...but the hint variant reports "unknown" so meter fields stay unset
    # rather than publishing a fabricated 200K denominator.
    assert resolve_context_window_hint(_NullEngine(), None) is None


def test_non_positive_and_raising_getters_are_ignored() -> None:
    class _Broken:
        def get_model_context_length(self) -> int:
            return 0

        def get_configured_context_length(self) -> int:
            raise RuntimeError("engine not ready")

    assert resolve_context_window_hint(_Broken(), _config()) == 8_192


# ── read site 1: apply_budget_check (the routed/tool lane) ───────────────────


def test_apply_budget_check_budgets_against_the_configured_window() -> None:
    messages = [{"role": "user", "content": "hello"}]
    _msgs, budget, tracker = apply_budget_check(
        messages,
        _config(),  # type: ignore[arg-type]
        _OllamaLikeEngine(),  # type: ignore[arg-type]
        num_tools=0,
    )
    assert budget is not None and tracker is not None
    assert budget.context_window == CONFIGURED, (
        "budgeting off the 131072 native window means auto-compaction cannot "
        "fire before the 32768 num_ctx the request is actually served with"
    )


# ── read site 2: the renderer's context-meter denominator ────────────────────


def test_attach_context_window_reports_the_configured_window() -> None:
    usage: dict[str, object] = {}
    attach_context_window(usage, _OllamaLikeEngine())
    assert usage["context_window"] == CONFIGURED


def test_attach_context_window_leaves_the_key_unset_when_unknown() -> None:
    usage: dict[str, object] = {}
    attach_context_window(usage, _NullEngine())
    assert "context_window" not in usage


# ── read site 3: the renderer's compaction-trigger line ─────────────────────


def test_attach_compact_threshold_uses_the_configured_window() -> None:
    config = _config()
    usage: dict[str, object] = {}
    attach_compact_threshold(usage, _OllamaLikeEngine(), config, num_tools=0)

    expected = TokenBudget(
        context_window=CONFIGURED,
        max_output_tokens=8_000,
        auto_compact_ratio=resolve_auto_compact_ratio(config, model_id=config.model),
    ).auto_compact_threshold(0)
    assert usage["compact_threshold_tokens"] == expected

    native_threshold = TokenBudget(
        context_window=NATIVE,
        max_output_tokens=8_000,
    ).auto_compact_threshold(0)
    assert usage["compact_threshold_tokens"] < native_threshold


# ── read site 4: the meter's numerator (context_used_tokens) ─────────────────
#
# Ollama's prompt_eval_count counts only NEWLY evaluated tokens on a
# server-side prompt-cache hit, so last_request_input_tokens can wildly
# under-report the true prompt size. The sidecar publishes
# max(provider, estimate) as the single authoritative numerator instead of
# leaving that judgment to a renderer guard.


def test_attach_context_used_tokens_prefers_provider_truth_when_it_covers_the_estimate() -> None:
    usage: dict[str, object] = {"last_request_input_tokens": 42_000}
    attach_context_used_tokens(usage, context_tokens_estimate=41_000)
    assert usage["context_used_tokens"] == 42_000
    assert usage["context_used_source"] == "provider"


def test_attach_context_used_tokens_overrides_a_kv_cache_undercount() -> None:
    # The KV-cache case: provider says 900 newly-evaluated tokens, but the
    # assembled prompt is ~42K. The estimate must win.
    usage: dict[str, object] = {"last_request_input_tokens": 900}
    attach_context_used_tokens(usage, context_tokens_estimate=42_000)
    assert usage["context_used_tokens"] == 42_000
    assert usage["context_used_source"] == "estimate"


def test_attach_context_used_tokens_uses_the_estimate_when_provider_truth_is_absent() -> None:
    usage: dict[str, object] = {}
    attach_context_used_tokens(usage, context_tokens_estimate=1_234)
    assert usage["context_used_tokens"] == 1_234
    assert usage["context_used_source"] == "estimate"


def test_attach_context_used_tokens_leaves_keys_unset_when_nothing_is_known() -> None:
    # A present-but-zero record must never read as an authoritative 0.
    usage: dict[str, object] = {}
    attach_context_used_tokens(usage, context_tokens_estimate=None)
    assert "context_used_tokens" not in usage
    assert "context_used_source" not in usage

    attach_context_used_tokens(usage, context_tokens_estimate=0)
    assert "context_used_tokens" not in usage
