"""Conservative token ceilings for explicitly budgeted provider invocations."""
from __future__ import annotations

from typing import Any

from sidecar.ai.engines.admitted import InferenceAdmissionRefused

_MAX_TOKEN_CEILING = 1_000_000_000_000

def _positive(value: Any) -> bool:
    return (isinstance(value, int) and not isinstance(value, bool)
            and 0 < value <= _MAX_TOKEN_CEILING)


def inference_budget_ceilings(
    engine: Any, max_tokens: int, admission: Any,
) -> tuple[int, int] | None:
    """Reserve native context headroom, including hidden reasoning, without estimates.

    Unknown consumption remains charged at this deliberately conservative ceiling.
    No tokenizer heuristic or fabricated context-window default authorizes dispatch.
    """
    if getattr(admission, "requires_budget", False) is not True:
        return None
    try:
        native = engine.get_inference_budget_context_length()
        configured_getter = getattr(engine, "get_configured_context_length", None)
        configured = configured_getter() if callable(configured_getter) else None
    except Exception as error:
        raise InferenceAdmissionRefused("inference_budget_ceiling_unavailable") from error
    if not _positive(native) or not _positive(max_tokens):
        raise InferenceAdmissionRefused("inference_budget_ceiling_unavailable")
    ceiling = max(native, configured) if _positive(configured) else native
    if max_tokens > ceiling:
        raise InferenceAdmissionRefused("inference_budget_output_exceeds_context")
    return ceiling, ceiling
