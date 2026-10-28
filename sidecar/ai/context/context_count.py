"""Count-source ladder for the context budget.

The plain estimator (chars // 4 with 30% headroom) over-counts a long chat and
compacts a 262k window at ~122k. Where a better source exists, the estimator is
rescaled to the provider's own units instead and judged against the raw
window, the way the tool loop already judges a provider-measured prompt:

1. ``exact``: the engine's server-side count of the assembled request.
2. ``calibrated``: the ratio of the provider's count to our estimate on the
   same session's last turn (same engine, model and estimator).
3. ``estimate``: today's behaviour.

``resolve_token_scale`` picks the source; ``ScaledTokenizerBackend`` carries the
scale to every downstream count (status, compaction, tool loop, preview).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from sidecar.ai.context.token_budget import (
    TokenizerBackend,
    estimate_messages_tokens,
    estimate_tool_schema_tokens,
    resolve_effective_context_window,
    resolve_tokenizer_backend,
)

logger = logging.getLogger(__name__)

SOURCE_EXACT = "exact"
SOURCE_CALIBRATED = "calibrated"
SOURCE_ESTIMATE = "estimate"

# A calibration outside this band is not trusted: below it the provider most
# likely reported only the uncached tail of the prompt (Ollama-style), above it
# the reading is too far off the estimator to carry to the next turn. A trusted
# ratio is floored at 1.0, so a calibration never counts below the estimate.
_CALIBRATED_BAND = (0.9, 1.6)
# An exact count is this request's truth, used unclamped upward (CJK text can
# run ~4x chars/4); only a reading this far off is a broken count. Like a
# calibration it never scales below the estimate: a count that comes in low
# most likely missed part of the prompt.
_EXACT_BAND = (0.25, 8.0)
# Skip the engine round trip on small chats: below this share of a rough
# raw-window trigger the estimate cannot reach compaction anyway.
_EXACT_COUNT_MIN_FRACTION = 0.5
_ROUGH_TRIGGER_RATIO = 0.9
_MAX_LABEL_CHARS = 200


def scale_in_band(value: Any, band: tuple[float, float]) -> float | None:
    """``value`` as a float when it is finite and inside ``band``, else ``None``."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    scale = float(value)
    if not math.isfinite(scale) or not band[0] <= scale <= band[1]:
        return None
    return scale


class ScaledTokenizerBackend:
    """An estimator whose counts are rescaled to a provider's units.

    It needs no window headroom: the scale already carries the estimator's
    error. ``exact`` marks a scale taken from this request's server count.
    """

    def __init__(self, inner: TokenizerBackend, scale: float, *, exact: bool = False) -> None:
        checked = scale_in_band(scale, _EXACT_BAND)
        if checked is None:
            msg = "scale must be a finite number in the exact-count band"
            raise ValueError(msg)
        self._inner = inner
        self._scale = checked
        self._exact = exact

    @property
    def inner(self) -> TokenizerBackend:
        return self._inner

    @property
    def scale(self) -> float:
        return self._scale

    @property
    def headroom_factor(self) -> float:
        return 0.0

    @property
    def is_exact_match(self) -> bool:
        return self._exact

    def count_tokens(self, text: str) -> int:
        if not text:
            return 0
        return math.ceil(self._inner.count_tokens(text) * self._scale)

    def get_context_window(self, model: str) -> int:
        return self._inner.get_context_window(model)

    def get_max_output_tokens(self, model: str) -> int:
        return self._inner.get_max_output_tokens(model)


@dataclass(frozen=True)
class ContextCalibration:
    """One turn's provider-vs-estimate reading, carried back by the client."""

    provider_tokens: int
    estimate_tokens: int
    engine: str
    model: str
    estimator: str

    @property
    def ratio(self) -> float | None:
        """The trusted scale (floored at 1.0), or ``None`` outside the band."""
        if self.provider_tokens <= 0 or self.estimate_tokens <= 0:
            return None
        ratio = scale_in_band(self.provider_tokens / self.estimate_tokens, _CALIBRATED_BAND)
        return None if ratio is None else max(ratio, 1.0)


def _positive_count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def _label(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text if 0 < len(text) <= _MAX_LABEL_CHARS else None


def normalize_context_calibration(raw: Any) -> ContextCalibration | None:
    """Validate a client-supplied calibration; anything malformed is ``None``."""
    if not isinstance(raw, Mapping):
        return None
    provider_tokens = _positive_count(raw.get("provider_tokens"))
    estimate_tokens = _positive_count(raw.get("estimate_tokens"))
    engine = _label(raw.get("engine"))
    model = _label(raw.get("model"))
    estimator = _label(raw.get("estimator"))
    if None in (provider_tokens, estimate_tokens, engine, model, estimator):
        return None
    return ContextCalibration(
        provider_tokens=provider_tokens,  # type: ignore[arg-type]
        estimate_tokens=estimate_tokens,  # type: ignore[arg-type]
        engine=engine,  # type: ignore[arg-type]
        model=model,  # type: ignore[arg-type]
        estimator=estimator,  # type: ignore[arg-type]
    )


def engine_reports_full_prompt_tokens(engine: Any) -> bool:
    """True when the engine's reported input tokens are the whole prompt (not
    only the uncached tail, as Ollama's ``prompt_eval_count`` is)."""
    return getattr(engine, "reports_full_prompt_input_tokens", False) is True


def _exact_scale(
    engine: Any,
    messages: list[dict[str, Any]],
    tool_payload: Iterable[Mapping[str, Any]] | None,
    inner_total: int,
) -> float | None:
    counter = getattr(engine, "count_request_tokens", None)
    if not callable(counter) or inner_total <= 0:
        return None
    try:
        exact_total = counter(messages=messages, tools=list(tool_payload or ()))
    except Exception:  # noqa: BLE001 - a count read must never fail a turn
        logger.debug(
            "Engine request token count failed; falling through the ladder.",
            extra={"event": "ai.context.token_budget.exact_count_failed"},
            exc_info=True,
        )
        return None
    if isinstance(exact_total, bool) or not isinstance(exact_total, int) or exact_total <= 0:
        return None
    scale = scale_in_band(exact_total / inner_total, _EXACT_BAND)
    return None if scale is None else max(scale, 1.0)


def resolve_token_scale(  # noqa: PLR0913 - keyword-only ladder inputs.
    *,
    engine: Any,
    config: Any,
    messages: list[dict[str, Any]],
    tool_payload: Iterable[Mapping[str, Any]] | None,
    calibration: ContextCalibration | None,
    inner_backend: TokenizerBackend | None = None,
    raw_window: int | None = None,
    allow_exact: bool = True,
    extra_tokens: int = 0,
) -> tuple[float | None, str]:
    """Pick the best count source and return ``(scale, source)``.

    ``scale`` multiplies ``inner_backend`` counts into provider units; it is
    ``None`` for the plain estimate path. ``extra_tokens`` is what the caller
    budgets on top of the text count (current-turn image tiles): the router's
    messages carry no images yet, so a server count of them would be text only
    and the turn skips the exact path. The backend and window default to the
    ones ``apply_budget_check`` resolves.
    """
    if inner_backend is None:
        inner_backend = resolve_tokenizer_backend(config)
    if raw_window is None:
        raw_window = resolve_effective_context_window(engine, config)
    scale: float | None = None
    source = SOURCE_ESTIMATE
    payload = list(tool_payload or ())
    counter = getattr(engine, "count_request_tokens", None)
    if allow_exact and extra_tokens <= 0 and callable(counter):
        inner_total = estimate_messages_tokens(messages, inner_backend) + (
            estimate_tool_schema_tokens(payload, inner_backend)
        )
        if inner_total >= _EXACT_COUNT_MIN_FRACTION * _ROUGH_TRIGGER_RATIO * max(raw_window, 0):
            scale = _exact_scale(engine, messages, payload, inner_total)
            if scale is not None:
                source = SOURCE_EXACT
    if scale is None and calibration is not None and engine_reports_full_prompt_tokens(engine):
        ratio = calibration.ratio
        if (
            ratio is not None
            and calibration.engine == str(getattr(config, "engine_type", ""))
            and calibration.model == str(getattr(config, "model", ""))
            and calibration.estimator == type(inner_backend).__name__
        ):
            scale, source = ratio, SOURCE_CALIBRATED
    logger.debug(
        "Context count source resolved.",
        extra={
            "event": "ai.context.token_budget.count_source",
            "count_source": source,
            "token_scale": scale,
        },
    )
    return scale, source


def publish_request_token_scale(engine: Any, scale: float | None) -> None:
    """Hand the turn's scale to the engine's request context, where the engine
    sizes max_tokens from it (``OpenAICompatibleEngine._fit_output_to_window``)."""
    reader = getattr(engine, "_current_request_context", None)
    context = reader() if callable(reader) else None
    if isinstance(context, dict):
        context["prompt_token_scale"] = scale
