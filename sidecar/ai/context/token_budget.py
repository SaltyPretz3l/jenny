"""Token counting and budget calculation.

Provider-agnostic context budget management with pluggable tokenizer
backends.  The default ``CharEstimationBackend`` uses a 4-chars-per-token
heuristic that works across all providers without external dependencies.

Feature-flag gated via ``FEATURE_TOKEN_BUDGET``.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, Iterable, Mapping, Protocol, runtime_checkable

if TYPE_CHECKING:
    from sidecar.ai.config import RuntimeConfig
    from sidecar.ai.engines.base import BaseEngine

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tokenizer backend protocol
# ---------------------------------------------------------------------------

_CHARS_PER_TOKEN = 4
_MESSAGE_OVERHEAD_TOKENS = 4  # role / separator / framing per message

# Last-resort window when neither the engine nor the config knows one. Matches
# the CharEstimationBackend fallback so budgeting is self-consistent.
DEFAULT_CONTEXT_WINDOW = 200_000


@runtime_checkable
class TokenizerBackend(Protocol):
    """Provider-agnostic interface for token estimation."""

    def count_tokens(self, text: str) -> int: ...
    def get_context_window(self, model: str) -> int: ...
    def get_max_output_tokens(self, model: str) -> int: ...


class CharEstimationBackend:
    """Default backend using the ~4 chars/token heuristic."""

    def count_tokens(self, text: str) -> int:
        if not text:
            return 0
        return max(1, len(text) // _CHARS_PER_TOKEN)

    def get_context_window(self, model: str) -> int:  # noqa: ARG002
        return 200_000

    def get_max_output_tokens(self, model: str) -> int:  # noqa: ARG002
        return 16_384


# ---------------------------------------------------------------------------
# Token budget
# ---------------------------------------------------------------------------

# Defaults are applied when RuntimeConfig leaves the corresponding override
# field as None. See docs/operations/resource-budgets.md § "Token budget
# constants" for the rationale and per-knob semantics. The error-ratio is
# intentionally *not* exposed as an override — it is the non-negotiable
# backstop that marks a context as unrecoverable.
_DEFAULT_RESERVED_FOR_SUMMARY = 8_192
_DEFAULT_TOOL_OVERHEAD = 500

# Smallest output headroom we ever reserve when budgeting, so a usably-small
# window (e.g. a 2K-4K model) still plans for *some* generation room.
_MIN_OUTPUT_RESERVATION = 1_024

_WARNING_RATIO = 0.80
_AUTO_COMPACT_RATIO = 0.90
_ERROR_RATIO = 0.95

_TOOL_SCHEMA_BUDGET_CAPS = {
    "warning": 12,
    "auto_compact": 8,
    "error": 5,
}


@dataclass(frozen=True)
class TokenBudget:
    """Per-request context budget derived from engine/config values."""

    context_window: int
    max_output_tokens: int
    output_reservation_tokens: int | None = None
    reserved_for_summary: int = _DEFAULT_RESERVED_FOR_SUMMARY
    tool_overhead_per_tool: int = _DEFAULT_TOOL_OVERHEAD
    warning_ratio: float = _WARNING_RATIO
    auto_compact_ratio: float = _AUTO_COMPACT_RATIO

    def _output_reservation(self) -> int:
        # Cap the output reservation used for budgeting so a model's advertised
        # final + thinking allowance cannot consume nearly the whole prompt
        # window. Budgeting only: the generation num_predict sent to the model
        # is computed independently and is NOT reduced here.
        quarter = self.context_window // 4
        output_reservation_cap = min(
            self.context_window,
            max(quarter, _MIN_OUTPUT_RESERVATION),
        )
        return (
            min(max(int(self.output_reservation_tokens), 0), output_reservation_cap)
            if self.output_reservation_tokens is not None
            else min(self.max_output_tokens, output_reservation_cap)
        )

    def effective_context(self, num_tools: int = 0) -> int:
        quarter = self.context_window // 4
        overhead = min(
            self.tool_overhead_per_tool * max(0, int(num_tools)),
            quarter,
        )
        output_reservation = self._output_reservation()
        summary_reservation = min(
            self.reserved_for_summary,
            max(self.context_window // 8, 1_024),
        )
        raw = self.context_window - output_reservation - summary_reservation - overhead
        return max(0, raw)

    def hard_prompt_limit(self) -> int:
        return self.context_window - self._output_reservation()

    def with_reserved_tokens(self, tokens: int) -> "TokenBudget":
        """A budget whose window already carries ``tokens`` the message
        estimator cannot see (current-turn image tiles), so admission and
        compaction judge the prompt the provider will actually receive."""
        reserved = int(tokens or 0)
        if reserved <= 0:
            return self
        return replace(self, context_window=max(self.context_window - reserved, 1))

    def warning_threshold(self, num_tools: int = 0) -> int:
        return int(self.effective_context(num_tools) * self.warning_ratio)

    def auto_compact_threshold(self, num_tools: int = 0) -> int:
        return int(self.effective_context(num_tools) * self.auto_compact_ratio)

    def error_threshold(self, num_tools: int = 0) -> int:
        return int(self.effective_context(num_tools) * _ERROR_RATIO)


# ---------------------------------------------------------------------------
# Tool schema budget filtering
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ToolSchemaBudgetPlan:
    """Conservative per-turn full-schema allocation under context pressure."""

    level: str
    cap: int | None
    kept_names: tuple[str, ...]
    filtered_names: frozenset[str]
    mandatory_names: tuple[str, ...]
    active: bool


def tool_schema_cap_for_budget_level(level: Any) -> int | None:
    """Return the conservative full-schema cap for a budget pressure level."""
    normalized = str(level or "").strip().lower()
    return _TOOL_SCHEMA_BUDGET_CAPS.get(normalized)


def build_tool_schema_budget_plan(
    tool_names: Iterable[str],
    *,
    level: Any,
    mandatory_names: Iterable[str] = (),
    preferred_names: Iterable[str] = (),
) -> ToolSchemaBudgetPlan:
    """Pick prompt-visible full schemas for a budget pressure level.

    Mandatory names are retained even when they exceed the cap. Preferred
    names fill the remaining capacity before the deterministic input order.
    """
    candidates = ordered_unique_names(tool_names)
    cap = tool_schema_cap_for_budget_level(level)
    normalized_level = str(level or "").strip().lower()
    if cap is None:
        return ToolSchemaBudgetPlan(
            level=normalized_level,
            cap=None,
            kept_names=candidates,
            filtered_names=frozenset(),
            mandatory_names=(),
            active=False,
        )

    candidate_set = frozenset(candidates)
    mandatory = tuple(
        name for name in ordered_unique_names(mandatory_names) if name in candidate_set
    )
    preferred = tuple(
        name for name in ordered_unique_names(preferred_names) if name in candidate_set
    )
    kept: list[str] = []
    seen: set[str] = set()

    for name in mandatory:
        kept.append(name)
        seen.add(name)
    capacity = max(0, cap - len(kept))
    for ordered_names in (preferred, candidates):
        if capacity <= 0:
            break
        for name in ordered_names:
            if name in seen:
                continue
            kept.append(name)
            seen.add(name)
            capacity -= 1
            if capacity <= 0:
                break

    filtered = frozenset(name for name in candidates if name not in seen)
    return ToolSchemaBudgetPlan(
        level=normalized_level,
        cap=cap,
        kept_names=tuple(kept),
        filtered_names=filtered,
        mandatory_names=mandatory,
        active=bool(filtered),
    )


def ordered_unique_names(values: Iterable[str]) -> tuple[str, ...]:
    """Return *values* trimmed and deduplicated, preserving first-seen order."""
    names: list[str] = []
    seen: set[str] = set()
    for value in values:
        name = str(value or "").strip()
        if not name or name in seen:
            continue
        names.append(name)
        seen.add(name)
    return tuple(names)


# ---------------------------------------------------------------------------
# Message token estimation
# ---------------------------------------------------------------------------


def estimate_messages_tokens(
    messages: Iterable[Mapping[str, Any]],
    backend: TokenizerBackend | None = None,
) -> int:
    """Estimate total token consumption for a message list."""
    if backend is None:
        backend = CharEstimationBackend()
    total = 0
    for message in messages:
        content = message.get("content")
        if isinstance(content, str) and content:
            total += backend.count_tokens(content)
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, list):
            for call in tool_calls:
                if isinstance(call, dict):
                    args_text = str(call.get("arguments", ""))
                    total += backend.count_tokens(args_text)
        total += _MESSAGE_OVERHEAD_TOKENS
    return total


# ---------------------------------------------------------------------------
# Budget status
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BudgetStatus:
    """Result of checking current token usage against a budget."""

    level: str  # "ok" | "warning" | "auto_compact" | "error"
    tokens_used: int
    tokens_available: int
    utilization_pct: float

    @property
    def should_compact(self) -> bool:
        return self.level in ("auto_compact", "error")


def check_budget(
    token_count: int,
    budget: TokenBudget,
    *,
    num_tools: int = 0,
) -> BudgetStatus:
    """Compare current token usage against the budget thresholds."""
    effective = budget.effective_context(num_tools)
    if effective <= 0:
        return BudgetStatus(
            level="error",
            tokens_used=token_count,
            tokens_available=0,
            utilization_pct=1.0,
        )
    utilization = token_count / effective
    if token_count >= budget.error_threshold(num_tools):
        level = "error"
    elif token_count >= budget.auto_compact_threshold(num_tools):
        level = "auto_compact"
    elif token_count >= budget.warning_threshold(num_tools):
        level = "warning"
    else:
        level = "ok"
    return BudgetStatus(
        level=level,
        tokens_used=token_count,
        tokens_available=max(0, effective - token_count),
        utilization_pct=min(utilization, 1.0),
    )


# ---------------------------------------------------------------------------
# Budget tracker (per-request, stateful across agent-loop iterations)
# ---------------------------------------------------------------------------

_DIMINISHING_RETURNS_THRESHOLD = 500
_DIMINISHING_RETURNS_WINDOW = 3
_ITER_HISTORY_LIMIT = 64


@dataclass
class BudgetTracker:
    """Tracks token usage across agent-loop iterations for a single request."""

    budget: TokenBudget | None = None
    num_tools: int = 0
    # The tokenizer backend apply_budget_check already built and paid for.
    # Carried here so every downstream comparison counts with the SAME backend
    # the window headroom was derived from, instead of silently re-defaulting to
    # the chars//4 estimator. TokenBudget stays frozen; this is the mutable
    # per-request companion, so the field belongs on the tracker.
    backend: TokenizerBackend | None = None
    _progress_tokens: list[int | None] = field(default_factory=list)
    _made_tool_progress: list[bool] = field(default_factory=list)
    _cumulative_progress_tokens: int = 0
    _current_context_tokens: int = 0
    _iteration_total_count: int = 0

    def record_iteration(
        self,
        progress_tokens: int | None,
        current_context_tokens: int,
        *,
        made_tool_progress: bool = False,
    ) -> None:
        safe_progress: int | None = None
        if progress_tokens is not None:
            safe_progress = max(0, int(progress_tokens))
        safe_context = max(0, int(current_context_tokens))
        self._iteration_total_count += 1
        self._progress_tokens.append(safe_progress)
        self._made_tool_progress.append(made_tool_progress)
        if len(self._progress_tokens) > _ITER_HISTORY_LIMIT:
            self._progress_tokens = self._progress_tokens[-_ITER_HISTORY_LIMIT:]
            self._made_tool_progress = self._made_tool_progress[-_ITER_HISTORY_LIMIT:]
        if safe_progress is not None:
            self._cumulative_progress_tokens += safe_progress
        self._current_context_tokens = safe_context

    def stop_reason(self) -> str | None:
        """Which rule says the loop must stop: context_budget, diminishing_returns, or None."""
        if self.budget is not None:
            threshold = self.budget.error_threshold(self.num_tools)
            if threshold > 0 and self._current_context_tokens >= threshold:
                return "context_budget"
        window = self._progress_tokens[-_DIMINISHING_RETURNS_WINDOW:]
        tool_progress_window = self._made_tool_progress[-_DIMINISHING_RETURNS_WINDOW:]
        if len(window) >= _DIMINISHING_RETURNS_WINDOW:
            known_window = [t for t in window if t is not None]
            if (
                len(known_window) == len(window)
                and all(t < _DIMINISHING_RETURNS_THRESHOLD for t in known_window)
                and not any(tool_progress_window)
            ):
                return "diminishing_returns"
        return None

    def check_should_continue(self) -> bool:
        return self.stop_reason() is None

    @property
    def total_tokens(self) -> int:
        return self._cumulative_progress_tokens

    @property
    def cumulative_progress_tokens(self) -> int:
        return self._cumulative_progress_tokens

    @property
    def current_context_tokens(self) -> int:
        return self._current_context_tokens

    @property
    def iteration_count(self) -> int:
        return self._iteration_total_count

    @property
    def iter_history_limit(self) -> int:
        return _ITER_HISTORY_LIMIT

    @property
    def iter_history(self) -> tuple[int | None, ...]:
        return tuple(self._progress_tokens)

    def snapshot(self) -> dict[str, Any]:
        effective = 0
        if self.budget is not None:
            effective = self.budget.effective_context(self.num_tools)
        return {
            "total_tokens": self._cumulative_progress_tokens,
            "cumulative_progress_tokens": self._cumulative_progress_tokens,
            "current_context_tokens": self._current_context_tokens,
            "iterations": self._iteration_total_count,
            "iteration_history_retained": len(self._progress_tokens),
            "iteration_history_limit": _ITER_HISTORY_LIMIT,
            "effective_context": effective,
            "utilization_pct": (
                min(self._current_context_tokens / effective, 1.0) if effective > 0 else 0.0
            ),
        }


# ---------------------------------------------------------------------------
# Integration helper (keeps router.py changes minimal)
# ---------------------------------------------------------------------------


def resolve_auto_compact_ratio(config: Any, *, model_id: str | None) -> float:
    """Resolve the auto-compact ratio for the active model.

    Precedence: per-model entry in ``token_budget_auto_compact_ratio_by_model``
    > ``token_budget_auto_compact_ratio`` (existing global override)
    > ``_AUTO_COMPACT_RATIO`` (module default).
    """
    def valid_ratio(value: Any) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        normalized = float(value)
        return normalized if math.isfinite(normalized) and 0.1 <= normalized <= 0.99 else None

    normalized_model_id = str(model_id or "").strip()
    by_model = getattr(config, "token_budget_auto_compact_ratio_by_model", None)
    if normalized_model_id and isinstance(by_model, dict):
        per_model = valid_ratio(by_model.get(normalized_model_id))
        if per_model is not None:
            return per_model
    global_ratio = valid_ratio(getattr(config, "token_budget_auto_compact_ratio", None))
    if global_ratio is not None:
        return global_ratio
    return _AUTO_COMPACT_RATIO


def _positive_int(value: Any) -> int | None:
    """Coerce *value* to a positive int, or ``None``.

    Deliberately the same shape as
    ``sidecar.runtime.local_engine.snapshot._positive_int`` so the budgeting
    clamp below and the ``context_metadata_payload`` the app surfaces to the
    renderer cannot drift apart.
    """
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _engine_window(engine: Any, getter_name: str) -> int | None:
    """Read a positive window from ``engine.<getter_name>()`` if it exists.

    Duck-typed on purpose: only ``OllamaEngine`` defines
    ``get_configured_context_length`` today, and a budget read must never fail a
    turn because a provider engine does not expose one.
    """
    getter = getattr(engine, getter_name, None)
    if not callable(getter):
        return None
    try:
        return _positive_int(getter())
    except Exception:  # noqa: BLE001 — a window read must never break a turn
        return None


def resolve_context_window_hint(engine: Any, config: Any = None) -> int | None:
    """Resolve the window every request is ACTUALLY served with, or ``None``.

    ``get_model_context_length()`` returns the model's NATIVE window (read off
    ``/api/show`` for Ollama). But every Ollama request is stamped with
    ``options['num_ctx']`` from the CONFIGURED context length
    (``_apply_configured_num_ctx``), so the runner's real window is the
    configured clamp — typically 32768 against a 131072-262144 native value, and
    up to 15x smaller on an app profile. Budgeting off the native number means
    auto-compaction and the error threshold cannot fire before the runner's real
    window is blown.

    Semantics mirror ``local_engine/snapshot.py::context_metadata_payload``:
    ``min(configured, native)`` when both are known, else whichever one is.
    When the engine exposes NO configured getter we deliberately do NOT clamp by
    ``config.context_length``: chatgpt / vLLM / provider_http do not stamp a
    per-request num_ctx, so their budgeting stays byte-identical to before.

    Returns ``None`` when nothing is known, so hint-only callers (the renderer's
    context-meter fields) can leave their key unset instead of publishing a
    fabricated default.
    """
    native = _engine_window(engine, "get_model_context_length")
    configured = _engine_window(engine, "get_configured_context_length")
    if native is not None and configured is not None:
        if configured < native:
            logger.debug(
                "Clamping context budget to the configured num_ctx window.",
                extra={
                    "event": "ai.context.token_budget.context_window_clamped",
                    "native_context_length": native,
                    "configured_context_length": configured,
                },
            )
        return min(native, configured)
    if native is not None:
        return native
    if configured is not None:
        return configured
    return _positive_int(getattr(config, "context_length", None))


def resolve_effective_context_window(engine: Any, config: Any = None) -> int:
    """``resolve_context_window_hint`` with the module's last-resort default.

    Every budgeting read of "how big is the window" goes through here so the
    native/configured clamp can never be bypassed by an OR-chain at a call site.
    """
    return resolve_context_window_hint(engine, config) or DEFAULT_CONTEXT_WINDOW


def resolve_request_output_reservation(
    engine: Any,
    *,
    reasoning_effort: str | None,
    max_output_tokens: int,
) -> int | None:
    """Return a request-specific reservation only when it exceeds the final allowance."""

    reservation_getter = getattr(engine, "get_request_output_reservation", None)
    request_reservation = (
        reservation_getter(reasoning_effort) if callable(reservation_getter) else None
    )
    if request_reservation is None:
        return None
    normalized = int(request_reservation)
    return normalized if normalized != int(max_output_tokens) else None


def apply_budget_check(
    working_messages: list[dict[str, Any]],
    config: "RuntimeConfig",
    engine: "BaseEngine",
    *,
    num_tools: int = 0,
    reasoning_effort: str | None = None,
) -> tuple[list[dict[str, Any]], TokenBudget | None, BudgetTracker | None]:
    """Construct a budget from engine/config and check the current context.

    Returns the (possibly unchanged) message list, the computed budget,
    and a tracker ready for the agent loop.  Called from ``router.py``
    when the ``token_budget`` feature flag is enabled.
    """
    # NOT engine.get_model_context_length(): that is the model's NATIVE window,
    # while every request is served with the configured num_ctx clamp. See
    # resolve_effective_context_window.
    context_window = resolve_effective_context_window(engine, config)
    max_output = (
        engine.get_model_max_output_tokens() or getattr(config, "max_tokens", 16_384) or 16_384
    )
    explicit_output_reservation = resolve_request_output_reservation(
        engine,
        reasoning_effort=reasoning_effort,
        max_output_tokens=int(max_output),
    )
    backend = _create_best_backend(config)
    headroom = getattr(backend, "headroom_factor", 0.0)
    # Optional per-config overrides (None => fall back to module defaults).
    budget_kwargs: dict[str, Any] = {}
    reserved_for_summary = getattr(config, "token_budget_reserved_for_summary", None)
    tool_overhead = getattr(config, "token_budget_tool_overhead", None)
    warning_ratio = getattr(config, "token_budget_warning_ratio", None)
    if reserved_for_summary is not None:
        budget_kwargs["reserved_for_summary"] = int(reserved_for_summary)
    if tool_overhead is not None:
        budget_kwargs["tool_overhead_per_tool"] = int(tool_overhead)
    if warning_ratio is not None:
        budget_kwargs["warning_ratio"] = float(warning_ratio)
    budget_kwargs["auto_compact_ratio"] = resolve_auto_compact_ratio(
        config,
        model_id=str(getattr(config, "model", "") or ""),
    )
    window = int(context_window)
    if headroom > 0:
        window = int(context_window * (1.0 - headroom))
    budget = TokenBudget(
        context_window=window,
        max_output_tokens=int(max_output),
        output_reservation_tokens=explicit_output_reservation,
        **budget_kwargs,
    )
    tracker = BudgetTracker(budget=budget, num_tools=num_tools, backend=backend)
    return working_messages, budget, tracker


def resolve_tokenizer_backend(config: Any) -> "TokenizerBackend":
    """Public entry point to the config-aware tokenizer backend factory.

    Callers outside the ``apply_budget_check`` lane (notably the router's
    context-token estimate) went through the bare ``create_tokenizer_backend()``
    and so skipped the Ollama model-family resolution that ``_create_best_backend``
    performs. Routing both through here keeps a single family-resolution rule, so
    the "tokens used" figure cannot depend on which call site produced it.
    """
    return _create_best_backend(config)


def _create_best_backend(config: "RuntimeConfig") -> "TokenizerBackend":
    """Create the best available tokenizer backend for the current config."""
    model_family = ""
    try:
        engine_type = str(getattr(config, "engine_type", "") or "").strip().lower()
        if engine_type == "ollama":
            from sidecar.ai.engines.ollama_templates import resolve_template

            model = str(getattr(config, "model", "") or "")
            entry = resolve_template(family=model.split(":", maxsplit=1)[0].lower())
            if entry:
                model_family = entry.family
    except Exception:  # noqa: BLE001
        pass

    try:
        from sidecar.ai.context.tokenizers import create_tokenizer_backend

        return create_tokenizer_backend(model_family=model_family)
    except Exception:  # noqa: BLE001
        return CharEstimationBackend()
