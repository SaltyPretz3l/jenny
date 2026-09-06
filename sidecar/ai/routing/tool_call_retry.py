"""Reflexive tool-call retry decision layer for the tool loop.

This module holds all logic for the tool-loop's *reflexive retry* — a single,
in-turn corrective nudge issued when the model tried to call a tool but the
result could not be used:

* **Trigger A** (unparseable intent): an engine using the in-band route reports
  that its parser selected an explicit candidate but no parseable tool call
  survived. The corrective message re-states the exact ``<tool_call>``
  envelope and the available tool names.
* **Trigger B** (validation rejection): one or more of this iteration's tool
  calls were rejected with ``CMP_LOOP_TOOL_INPUT_VALIDATION``. The corrective
  message carries the verbatim validation error plus the rejected tool's full
  JSON ``parameters`` schema.

The ``tool_loop`` seam calls the pure :func:`evaluate_reflexive_retry` to obtain
a :class:`RetryDecision`, then (when ``should_retry``) the impure
:func:`apply_reflexive_retry` which appends the corrective message, increments
the ``execution_retry`` reliability counter, and logs a diagnostic — all inside
an exception-swallowing guard so a diagnostic-side failure never fails a turn
(mirrors the defensive posture in ``route_policy_runtime``).

The whole layer is flag-gated: :func:`evaluate_reflexive_retry` returns
``should_retry=False`` immediately when the reliability net is disabled, so the
loop's behavior, messages, and generation calls are byte-identical to today when
``tool_call_reliability_net_enabled`` is off.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Mapping

from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.error_codes import CMP_LOOP_TOOL_INPUT_VALIDATION
from sidecar.ai.routing.route_policy_runtime import increment_counter_for_kernel
from sidecar.ai.routing.tool_call_reliability import emit_tool_call_reliability_event
from sidecar.ai.tools.tool_call_healing import is_healing_enabled
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

# Cap for any user-facing / logged error text so raw prompt fragments never
# leak into logs and corrective messages stay bounded.
_ERROR_PREVIEW_MAX = 300

# The canonical in-band envelope, restated verbatim from
# ``sidecar/ai/context/builder.py`` so a corrective message re-teaches the exact
# shape the parser expects.
_ENVELOPE_RESTATEMENT = (
    "Output a tool call in exactly this format:\n\n"
    "<tool_call>\n"
    '{"name": "TOOL_NAME", "arguments": {"param": "value"}}\n'
    "</tool_call>\n\n"
    "Emit the <tool_call> block directly; do not describe the call in prose."
)


@dataclass(frozen=True)
class RetryDecision:
    """Outcome of a reflexive-retry evaluation.

    ``corrective_message`` matches the loose loop message-dict shape
    (``{"role": "user", "content": ...}``). ``response_format`` is set only when
    the retry generation should be constrained to the in-band envelope shape
    (i.e. native tools are inactive for this engine).
    """

    should_retry: bool
    corrective_message: dict[str, Any] | None
    response_format: Any | None
    trigger: str | None = None


def _bounded(text: str) -> str:
    """Return *text* trimmed to the bounded preview length."""
    cleaned = str(text or "").strip()
    if len(cleaned) <= _ERROR_PREVIEW_MAX:
        return cleaned
    return cleaned[:_ERROR_PREVIEW_MAX]


def _tool_names_line(known_tool_names: frozenset[str]) -> str:
    names = ", ".join(sorted(known_tool_names))
    return f"Available tools: {names}." if names else ""


def build_corrective_message(
    *,
    error_text: str,
    tool_schema: dict | None,
) -> dict[str, Any]:
    """Build the ``{"role": "user", ...}`` corrective message.

    Re-states the in-band envelope, includes the bounded ``error_text``, and —
    when ``tool_schema`` is provided (Trigger B) — appends that tool's full JSON
    ``parameters`` schema so the model can repair its arguments.
    """
    parts = [_bounded(error_text), _ENVELOPE_RESTATEMENT]
    if tool_schema is not None:
        schema_json = json.dumps(tool_schema, indent=2, sort_keys=True)
        parts.append("The tool's expected parameters schema is:\n" + schema_json)
    return {"role": "user", "content": "\n\n".join(part for part in parts if part)}


def _envelope_response_format(
    *,
    known_tool_names: frozenset[str],
    arguments_schema: dict[str, Any],
) -> ResponseFormat:
    """Build the constrained in-band-envelope ``ResponseFormat``."""
    schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "enum": sorted(known_tool_names)},
            "arguments": arguments_schema,
        },
        "required": ["name", "arguments"],
    }
    return ResponseFormat(type="json_object", json_schema=schema)


def evaluate_reflexive_retry(  # noqa: PLR0913 — pure decision surface per contract.
    *,
    inband_tool_call_parse_failed: bool,
    surviving_calls: tuple,
    validation_errors: tuple[dict[str, Any], ...],
    known_tool_names: frozenset[str],
    tool_schemas: Mapping[str, dict],
    already_retried: bool,
    native_tools_active: bool,
) -> RetryDecision:
    """Decide whether to issue a reflexive retry and how to shape it.

    Pure and flag-gated: returns ``should_retry=False`` immediately when the
    reliability net is disabled, already retried this turn, or there are no
    known tools. Trigger B (validation rejection) takes precedence over Trigger
    A (unparseable intent) when both conditions hold.
    """
    _no_retry = RetryDecision(
        should_retry=False,
        corrective_message=None,
        response_format=None,
    )

    if not is_healing_enabled():
        return _no_retry
    if already_retried:
        return _no_retry
    if not known_tool_names:
        return _no_retry

    # -- Trigger B (precedence): a real validation rejection this iteration ---
    if validation_errors:
        first = validation_errors[0]
        tool_name = str(first.get("tool_name") or "").strip()
        error_text = str(first.get("validation_error") or "")
        tool_schema = tool_schemas.get(tool_name) if tool_name else None
        message = build_corrective_message(
            error_text=(
                f"Your call to '{tool_name}' was rejected: {error_text}"
                if tool_name
                else f"Your tool call was rejected: {error_text}"
            ),
            tool_schema=tool_schema if isinstance(tool_schema, dict) else None,
        )
        arguments_schema: dict[str, Any] = (
            tool_schema if isinstance(tool_schema, dict) else {"type": "object"}
        )
        response_format = (
            None
            if native_tools_active
            else _envelope_response_format(
                known_tool_names=known_tool_names,
                arguments_schema=arguments_schema,
            )
        )
        return RetryDecision(
            should_retry=True,
            corrective_message=message,
            response_format=response_format,
            trigger="validation_rejection",
        )

    # -- Trigger A: the active in-band parser rejected an explicit candidate --
    if (
        not native_tools_active
        and not surviving_calls
        and inband_tool_call_parse_failed
    ):
        names_line = _tool_names_line(known_tool_names)
        message = build_corrective_message(
            error_text=(
                "Your tool call could not be parsed as JSON, so no tool ran. "
                + names_line
            ),
            tool_schema=None,
        )
        response_format = _envelope_response_format(
            known_tool_names=known_tool_names,
            arguments_schema={"type": "object"},
        )
        return RetryDecision(
            should_retry=True,
            corrective_message=message,
            response_format=response_format,
            trigger="unparseable_intent",
        )

    return _no_retry


def _names_and_schemas_from_payload(
    tool_payload: Any,
) -> tuple[frozenset[str], dict[str, dict]]:
    """Derive (known_tool_names, tool_schemas) from the runtime ``tool_payload``.

    ``tool_payload`` entries are prompt-shape dicts
    (``{"name", "description", "parameters", ...}``). Defensive: malformed
    entries are skipped so a bad payload never raises at the loop seam.
    """
    names: set[str] = set()
    schemas: dict[str, dict] = {}
    for entry in tool_payload or ():
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        names.add(name)
        parameters = entry.get("parameters")
        if isinstance(parameters, dict):
            schemas[name] = parameters
    return frozenset(names), schemas


def native_tools_active_for_kernel(kernel: Any) -> bool:
    """Return whether the engine has native tool-calling active.

    Defensive: any exception yields ``True`` (do not constrain), so the
    constrained in-band envelope format is applied only when the engine's
    public capability contract reports no native support.
    """
    try:
        engine = kernel._engine
        capability = engine.supports_tool_calling
        return bool(capability() if callable(capability) else capability)
    except Exception:  # noqa: BLE001 — defensive; default to unconstrained.
        return True


def evaluate_reflexive_retry_from_payload(  # noqa: PLR0913 — loop-seam adapter.
    *,
    kernel: Any,
    inband_tool_call_parse_failed: bool,
    surviving_calls: tuple,
    validation_errors: tuple[dict[str, Any], ...],
    tool_payload: Any,
    already_retried: bool,
) -> RetryDecision:
    """Loop-seam adapter: derive names/schemas/native-posture, then evaluate.

    Keeps the ``tool_loop`` seam to a thin call. Defensive: any internal failure
    yields a no-retry decision so a diagnostic-side error never fails a turn.
    """
    try:
        names, schemas = _names_and_schemas_from_payload(tool_payload)
        return evaluate_reflexive_retry(
            inband_tool_call_parse_failed=inband_tool_call_parse_failed,
            surviving_calls=surviving_calls,
            validation_errors=validation_errors,
            known_tool_names=names,
            tool_schemas=schemas,
            already_retried=already_retried,
            native_tools_active=native_tools_active_for_kernel(kernel),
        )
    except Exception:  # noqa: BLE001 — diagnostic-only; behave as no-retry.
        return RetryDecision(should_retry=False, corrective_message=None, response_format=None)


def _record_reliability_telemetry(  # noqa: PLR0913 — internal telemetry seam.
    *,
    kernel: Any,
    inband_tool_call_parse_failed: bool,
    surviving_calls: tuple,
    validation_errors: tuple[dict[str, Any], ...],
    tool_payload: Any,
    emit_reliability_event: bool,
    request_id: str,
    session_id: str | None,
) -> None:
    """Count ``parse_failure`` and emit the reliability event (best-effort).

    A Trigger-A condition (explicit failed in-band parse, zero surviving calls,
    no validation errors, native tools inactive) counts one ``parse_failure``
    REGARDLESS of whether the retry itself fires (counting is independent of
    ``already_retried``). The
    reliability event emits on every post-dispatch iteration
    (``emit_reliability_event=True`` from the loop's Trigger-B seam) and on any
    failed-intent generation, so both healthy and failing tool turns are
    visible. Swallows everything — telemetry never fails a turn.
    """
    if not is_healing_enabled():
        return
    try:
        names, _schemas = _names_and_schemas_from_payload(tool_payload)
        intent_failed = bool(
            names
            and not native_tools_active_for_kernel(kernel)
            and not surviving_calls
            and not validation_errors
            and inband_tool_call_parse_failed
        )
        if intent_failed:
            increment_counter_for_kernel(kernel, "parse_failure")
        if intent_failed or emit_reliability_event:
            emit_tool_call_reliability_event(
                kernel=kernel,
                request_id=request_id,
                session_id=session_id,
            )
    except Exception:  # noqa: BLE001 — diagnostic-only; never fail a turn.
        pass


def run_reflexive_retry(  # noqa: PLR0913 — single-call loop seam per contract.
    *,
    kernel: Any,
    inband_tool_call_parse_failed: bool,
    surviving_calls: tuple,
    validation_errors: tuple[dict[str, Any], ...],
    tool_payload: Any,
    working_messages: list,
    already_retried: bool,
    request_id: str,
    session_id: str | None,
    emit_reliability_event: bool = False,
) -> tuple[bool, Any]:
    """Evaluate + apply a reflexive retry in one loop-seam call.

    Returns ``(applied, pending_response_format)``. When no retry fires,
    returns ``(False, None)``. Defensive throughout: any internal failure
    yields ``(False, None)`` so a diagnostic-side error never fails a turn.
    Also owns the per-iteration reliability telemetry (``parse_failure``
    counting + the ``ai.router.tool_call_reliability`` event) so the loop seam
    stays a single thin call.
    """
    _record_reliability_telemetry(
        kernel=kernel,
        inband_tool_call_parse_failed=inband_tool_call_parse_failed,
        surviving_calls=surviving_calls,
        validation_errors=validation_errors,
        tool_payload=tool_payload,
        emit_reliability_event=emit_reliability_event,
        request_id=request_id,
        session_id=session_id,
    )
    decision = evaluate_reflexive_retry_from_payload(
        kernel=kernel,
        inband_tool_call_parse_failed=inband_tool_call_parse_failed,
        surviving_calls=surviving_calls,
        validation_errors=validation_errors,
        tool_payload=tool_payload,
        already_retried=already_retried,
    )
    if not decision.should_retry:
        return False, None
    applied = apply_reflexive_retry(
        kernel=kernel,
        decision=decision,
        working_messages=working_messages,
        request_id=request_id,
        session_id=session_id,
    )
    return (True, decision.response_format) if applied else (False, None)


def record_parse_success(kernel: Any) -> None:
    """Count one well-formed-parse event for a tool-bearing generation.

    The ``parse_success`` half of the ``well_formed_rate`` denominator
    (``parse_failure`` is counted per intent-failed generation above). Called
    from the tool loop once per generation whose tool calls parsed. Defensive
    and flag-gated like all reliability telemetry: never fails a turn.
    """
    try:
        if is_healing_enabled():
            increment_counter_for_kernel(kernel, "parse_success")
    except Exception:  # noqa: BLE001 — telemetry only.
        pass


def collect_validation_errors(outcomes_slice: Any) -> tuple[dict[str, Any], ...]:
    """Build the Trigger-B ``validation_errors`` tuple from an outcomes slice.

    Selects outcomes rejected with ``CMP_LOOP_TOOL_INPUT_VALIDATION`` and shapes
    each into ``{"tool_name", "validation_error"}``. Defensive: any malformed
    outcome is skipped rather than raising.
    """
    errors: list[dict[str, Any]] = []
    for outcome in outcomes_slice or ():
        try:
            if getattr(outcome, "error_code", None) != CMP_LOOP_TOOL_INPUT_VALIDATION:
                continue
            metadata = getattr(outcome, "metadata", None) or {}
            errors.append(
                {
                    "tool_name": str(getattr(outcome, "tool_name", "")),
                    "validation_error": str(metadata.get("validation_error", "")),
                }
            )
        except Exception:  # noqa: BLE001 — defensive; skip a bad outcome.
            continue
    return tuple(errors)


def apply_reflexive_retry(
    *,
    kernel: Any,
    decision: RetryDecision,
    working_messages: list,
    request_id: str,
    session_id: str | None,
) -> bool:
    """Apply a reflexive-retry decision to the loop's working state.

    Appends the corrective message, increments the ``execution_retry``
    reliability counter, and emits a diagnostic event. The append is the sole
    state-changing success criterion; counter and log failures are best-effort.
    """
    if not decision.should_retry or decision.corrective_message is None:
        return False
    try:
        working_messages.append(decision.corrective_message)
    except Exception:  # noqa: BLE001 — state mutation failed; no retry was applied.
        return False
    try:
        increment_counter_for_kernel(kernel, "execution_retry")
    except Exception:  # noqa: BLE001 — best-effort reliability telemetry.
        pass
    try:
        content = str(decision.corrective_message.get("content") or "")
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.tool_call_reflexive_retry",
            message="Issuing a single reflexive tool-call retry with a corrective message.",
            status="retry",
            data={
                "trigger": decision.trigger or "unparseable_intent",
                "error_preview": _bounded(content),
                "session_id": session_id,
            },
            request_id=request_id,
        )
    except Exception:  # noqa: BLE001 — best-effort diagnostic event.
        pass
    return True
