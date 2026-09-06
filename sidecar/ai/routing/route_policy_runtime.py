"""Phase 5 route-policy runtime helpers (impure side of route_policy).

The pure decision function lives in :mod:`sidecar.ai.routing.route_policy`.
This module wraps that function in the kernel-state lookups (profile store,
in-band parser, synthetic-outcome emit) used by
:func:`sidecar.ai.routing.tool_loop.run_tool_loop`. Splitting the impure
side keeps :mod:`route_policy` purely functional and keeps the additions to
the already-oversized :mod:`tool_loop` thin.

Defensive posture: every helper here swallows internal errors and returns a
safe default so a diagnostic-side failure never fails a turn.
"""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import replace as _replace
from typing import Any, TypeAlias

from sidecar.ai.error_codes import CMP_ROUTE_FAIL_CLOSED, CMP_ROUTE_TOOL_DISABLED
from sidecar.ai.routing import loop_runtime as _loop_runtime
from sidecar.ai.routing import route_policy as _route_policy
from sidecar.ai.tools import contracts as _tools_contracts
from sidecar.ai.tools import inband_parser as _tools_inband_parser
from sidecar.ai.tools import models as _tools_models
from sidecar.ai.tools import policy as _tools_policy
from sidecar.ai.tools import schema_roundtrip as _tools_schema_roundtrip
from sidecar.runtime.provider_capability_profile import (
    derive_endpoint_id,
    derive_model_id,
    derive_profile_id,
)

LoopRuntime: TypeAlias = _loop_runtime.LoopRuntime
BLOCK_FAIL_CLOSED = _route_policy.BLOCK_FAIL_CLOSED
BLOCK_TOOL_DISABLED = _route_policy.BLOCK_TOOL_DISABLED
DISPATCH_IN_BAND = _route_policy.DISPATCH_IN_BAND
DOWNGRADE_TO_IN_BAND = _route_policy.DOWNGRADE_TO_IN_BAND
RouteDecision: TypeAlias = _route_policy.RouteDecision
decide_dispatch_route = _route_policy.decide_dispatch_route
ToolExecutionFailure = _tools_contracts.ToolExecutionFailure
extract_inband_tool_calls = _tools_inband_parser.extract_inband_tool_calls
ToolSchema: TypeAlias = _tools_models.ToolSchema
schema_roundtrip_check = _tools_schema_roundtrip.schema_roundtrip_check

_BLOCK_MESSAGE = (
    "Tool '{tool_id}' was not executed: route policy "
    "blocks tool dispatch for this provider/model."
)


def destructive_tool_approval_reason(tool_name: str, arguments: dict[str, Any]) -> str:
    if tool_name == "delete_file":
        target = str(arguments.get("path") or arguments.get("file_path") or "this path").strip()
        tree = ", with everything under it" if arguments.get("recursive") is True else ""
        return (
            f"Moves {target} into the workspace's .jenny/trash folder{tree}; "
            "move_file can restore it. Approve to continue."
        )
    if tool_name == "move_file":
        clobber = (
            " and overwrites any existing destination" if arguments.get("overwrite") is True else ""
        )
        return f"Renames or moves workspace files{clobber}. Approve to continue."
    return "Deletes the registered git worktree directory. Approve to continue."


def build_approval_request(  # noqa: PLR0913 - router-owned value factory seam
    approval_request_type: Any,
    call: Any,
    descriptor: Any,
    *,
    mode: str,
    reason: str,
    policy_decision: Any | None,
) -> Any:
    """Build the router-owned approval value without importing the router here."""

    presentation = _tools_policy.approval_presentation_for_call(
        descriptor, call.arguments
    )
    call_id = str(call.call_id or "").strip() or _tools_policy.tool_policy_call_key(call)
    return approval_request_type(
        tool_name=descriptor.name,
        reason=reason,
        tool_input={str(key): value for key, value in call.arguments.items()},
        mode=mode,
        tool_call_id=call_id,
        policy_decision_id=(
            policy_decision.id if policy_decision is not None else None
        ),
        policy_scope=presentation.policy_scope,
        policy_consequence=presentation.policy_consequence,
    )


@dataclass(frozen=True)
class RouteApplyResult:
    """Outcome of :func:`apply_route_policy_pre_dispatch`.

    ``decision`` is the underlying :class:`RouteDecision` for diagnostic
    correlation. ``result`` is the (possibly recovered) generation result
    that the caller should continue dispatch with. ``blocked`` is True when
    the caller must skip the dispatch branch (the policy blocked all
    requested calls and synthetic outcomes were already emitted).
    """

    decision: RouteDecision
    result: Any
    blocked: bool


def _resolve_store(kernel: Any) -> Any:
    engine = getattr(kernel, "_engine", None)
    return getattr(engine, "_provider_capability_profile_store", None)


def resolve_capability_profile(kernel: Any) -> Any:
    """Best-effort lookup of the active ProviderCapabilityProfile for *kernel*.

    Returns ``None`` if any link in the chain is missing (no engine, no
    store, no profile) so the caller falls back to the safe default ladder
    branch.
    """
    try:
        store = _resolve_store(kernel)
        if store is None:
            return None
        engine_type = str(getattr(kernel._config, "engine_type", "") or "")
        api_url = getattr(kernel._config, "api_url", None)
        model = getattr(kernel._config, "model", None)
        profile_id = derive_profile_id(
            derive_endpoint_id(engine_type, api_url),
            derive_model_id(model),
        )
        return store.get_profile(profile_id)
    except Exception:  # noqa: BLE001 — diagnostic-only.
        return None


def record_route_outcome(kernel: Any, profile: Any, decision: RouteDecision) -> None:
    """Increment the reliability counter named by *decision* if possible."""
    if profile is None or decision.counter_kind is None:
        return
    try:
        store = _resolve_store(kernel)
        if store is None:
            return
        store.record_tool_call_outcome(
            profile_id=profile.profile_id,
            kind=decision.counter_kind,
        )
    except Exception:  # noqa: BLE001 — diagnostic-only.
        pass


def known_tool_names_for_kernel(
    kernel: Any,
    *,
    tool_contract: Any | None = None,
) -> frozenset[str]:
    """Build the in-band recovery allowlist from the effective contract.

    When the request has an assembled contract it is authoritative, including
    an explicitly empty offer.  The MCP-only fallback remains solely for older
    direct callers that do not yet own a request contract.
    """
    try:
        if tool_contract is not None:
            contract_names = {
                str(schema.get("name") or "").strip()
                for schema in (getattr(tool_contract, "prompt_schemas", ()) or ())
                if isinstance(schema, dict)
            }
            return frozenset(name for name in contract_names if name)
        descriptors = getattr(kernel._mcp_client, "available_tools", None) or ()
        names: set[str] = set()
        for descriptor in descriptors:
            name = str(getattr(descriptor, "name", "") or "").strip()
            if name:
                names.add(name)
        return frozenset(names)
    except Exception:  # noqa: BLE001
        return frozenset()


def attempt_in_band_recovery(
    *,
    result: Any,
    kernel: Any,
    tool_contract: Any | None = None,
) -> tuple[Any, bool]:
    """Re-derive ``tool_calls`` from in-band parsing of the visible content.

    Returns ``(updated_result, recovered)``. When recovery succeeds, the
    returned result has ``tool_calls`` replaced with the parsed list and
    ``content`` reduced to the remaining text. When recovery fails the
    original result is returned unchanged.
    """
    try:
        known_names = known_tool_names_for_kernel(
            kernel,
            tool_contract=tool_contract,
        )
        if not known_names:
            return result, False
        text = str(getattr(result, "content", "") or "")
        if not text:
            return result, False
        recovered_calls, remaining_text = extract_inband_tool_calls(text, known_names)
        if not recovered_calls:
            return result, False
        return (
            _replace(
                result,
                tool_calls=tuple(recovered_calls),
                content=remaining_text,
            ),
            True,
        )
    except Exception:  # noqa: BLE001
        return result, False


def emit_synthetic_blocked_outcomes(  # noqa: PLR0913 - loop-state adapter seam.
    *,
    runtime: LoopRuntime,
    kernel: Any,
    result: Any,
    outcomes: list[Any],
    working_messages: list[dict[str, Any]],
    streamed_event_types: set[str],
    request_id: str,
    outcome_index: int,
    error_code: str,
    message_template: str,
    emit_tool_executing: Any,
    emit_tool_result: Any,
) -> int:
    """Emit a synthetic ``tool.result`` outcome per blocked tool call.

    Used when route policy decides ``BLOCK_TOOL_DISABLED`` (the model asked
    for tools but the active route forbids dispatch). Each outcome rides the
    existing ``tool.executing`` + ``tool.result`` notifications so the
    renderer's contract is preserved.

    The two emitter callables (``emit_tool_executing`` /
    ``emit_tool_result``) are passed in to avoid an import cycle with
    :mod:`tool_loop`.
    """
    from sidecar.ai.routing.router import ToolExecutionOutcome  # noqa: PLC0415

    for call in result.tool_calls:
        outcome_index += 1
        synthetic = ToolExecutionOutcome(
            tool_name=call.tool_id,
            output=message_template.format(tool_id=call.tool_id),
            success=False,
            tool_input={str(k): v for k, v in call.arguments.items()},
            error_code=error_code,
            call_id=call.call_id,
        )
        outcomes.append(synthetic)
        call_id = emit_tool_executing(runtime, call, request_id, outcome_index)
        emit_tool_result(runtime, synthetic, call_id)
        if runtime.streaming:
            streamed_event_types.add("tool.executing")
            streamed_event_types.add("tool.result")
        working_messages.append(kernel._assistant_tool_call_message(result, call))
        working_messages.append(kernel._tool_result_message(call, synthetic))
    return outcome_index


def apply_route_policy_pre_dispatch(  # noqa: PLR0913 - called by tool_loop seam.
    *,
    kernel: Any,
    runtime: LoopRuntime,
    result: Any,
    request_id: str,
    outcome_index: int,
    outcomes: list[Any],
    working_messages: list[dict[str, Any]],
    streamed_event_types: set[str],
    emit_tool_executing: Any,
    emit_tool_result: Any,
    tool_payload: list[dict[str, Any]] | None = None,
    tool_contract: Any | None = None,
) -> tuple[RouteApplyResult, int]:
    """One-call wrapper executing the Phase 5 policy ladder for the loop.

    Returns ``(RouteApplyResult, updated_outcome_index)``. The caller must:

    * raise on ``BLOCK_FAIL_CLOSED`` (already raised inside this helper).
    * skip the dispatch branch when ``RouteApplyResult.blocked`` is True.
    * use ``RouteApplyResult.result`` (in-band recovery may have replaced
      ``result.tool_calls``).
    """
    profile = resolve_capability_profile(kernel)
    schema_roundtrip_passed = evaluate_schema_roundtrip(
        kernel=kernel,
        profile=profile,
        tool_payload=tool_payload,
    )
    decision = decide_dispatch_route(
        profile=profile,
        tool_calls_present=True,
        coerced_arguments_present=any(
            bool(getattr(call, "coerced", False)) for call in result.tool_calls
        ),
        schema_roundtrip_passed=schema_roundtrip_passed,
    )
    record_route_outcome(kernel, profile, decision)

    if decision.action == BLOCK_FAIL_CLOSED:
        raise ToolExecutionFailure(
            code=CMP_ROUTE_FAIL_CLOSED,
            message="Route policy blocked tool dispatch (fail-closed).",
            retryable=False,
        )

    if decision.action == BLOCK_TOOL_DISABLED:
        outcome_index = emit_synthetic_blocked_outcomes(
            runtime=runtime,
            kernel=kernel,
            result=result,
            outcomes=outcomes,
            working_messages=working_messages,
            streamed_event_types=streamed_event_types,
            request_id=request_id,
            outcome_index=outcome_index,
            error_code=CMP_ROUTE_TOOL_DISABLED,
            message_template=_BLOCK_MESSAGE,
            emit_tool_executing=emit_tool_executing,
            emit_tool_result=emit_tool_result,
        )
        return RouteApplyResult(decision=decision, result=result, blocked=True), outcome_index

    if decision.action in (DOWNGRADE_TO_IN_BAND, DISPATCH_IN_BAND):
        recovered_result, ok = attempt_in_band_recovery(
            result=result,
            kernel=kernel,
            tool_contract=tool_contract,
        )
        if ok:
            result = recovered_result

    return RouteApplyResult(decision=decision, result=result, blocked=False), outcome_index


def increment_counter_for_kernel(kernel: Any, kind: str) -> None:
    """Best-effort reliability-counter increment from non-routing call sites.

    Used by :mod:`tool_execution` to record validation failures and retry
    events without taking a hard dependency on the routing layer's
    ``RouteDecision``.
    """
    try:
        profile = resolve_capability_profile(kernel)
        if profile is None:
            return
        store = _resolve_store(kernel)
        if store is None:
            return
        store.record_tool_call_outcome(profile_id=profile.profile_id, kind=kind)
    except Exception:  # noqa: BLE001 — diagnostic-only.
        pass


_PROVIDER_ALIASES: dict[str, str] = {
    "openai-compatible": "openai",
}


def _resolve_provider_for_roundtrip(kernel: Any) -> str:
    engine_type = str(getattr(kernel._config, "engine_type", "") or "").strip().lower()
    return _PROVIDER_ALIASES.get(engine_type, engine_type)


def _build_tool_schemas_from_payload(
    tool_payload: list[dict[str, Any]] | None,
) -> list[ToolSchema]:
    """Adapt the runtime ``tool_payload`` (dicts) into ``ToolSchema`` instances.

    The kernel passes prompt-shape dicts (``{"name", "description",
    "parameters", "side_effecting"}``) around at runtime; the pure
    :func:`schema_roundtrip_check` operates on the canonical
    :class:`ToolSchema` dataclass. This adapter is the only place the two
    representations meet.
    """
    schemas: list[ToolSchema] = []
    for entry in tool_payload or ():
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        parameters = entry.get("parameters")
        schemas.append(
            ToolSchema(
                tool_id=name,
                name=name,
                description=str(entry.get("description") or ""),
                parameters=parameters if isinstance(parameters, dict) else {},
                source="runtime",
                version=1,
            )
        )
    return schemas


def evaluate_schema_roundtrip(
    *,
    kernel: Any,
    profile: Any,
    tool_payload: list[dict[str, Any]] | None,
) -> bool:
    """Return whether the active provider/profile passes the schema roundtrip.

    Caches the result on the profile via
    :py:meth:`ProviderCapabilityProfileStore.record_schema_roundtrip_result`
    so subsequent dispatches reuse the prior outcome. Defensive: any
    failure or missing input returns ``True`` so a diagnostic-side error
    never downgrades a turn that would otherwise have dispatched cleanly.
    """
    if profile is None:
        return True
    cached = getattr(profile, "roundtrip", None)
    if cached is not None:
        return bool(getattr(cached, "passed", True))
    try:
        provider = _resolve_provider_for_roundtrip(kernel)
        if not provider:
            return True
        schemas = _build_tool_schemas_from_payload(tool_payload)
        if not schemas:
            return True
        result = schema_roundtrip_check(schemas, provider=provider)
        store = _resolve_store(kernel)
        if store is not None:
            try:
                store.record_schema_roundtrip_result(
                    profile_id=profile.profile_id,
                    result=result,
                )
            except Exception:  # noqa: BLE001 — diagnostic-only.
                pass
        return bool(result.passed)
    except Exception:  # noqa: BLE001 — diagnostic-only.
        return True


__all__ = [
    "RouteApplyResult",
    "apply_route_policy_pre_dispatch",
    "attempt_in_band_recovery",
    "emit_synthetic_blocked_outcomes",
    "evaluate_schema_roundtrip",
    "increment_counter_for_kernel",
    "known_tool_names_for_kernel",
    "record_route_outcome",
    "resolve_capability_profile",
]
