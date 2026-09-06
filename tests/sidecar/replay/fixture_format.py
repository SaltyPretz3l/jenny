"""Replay fixture schema, loader, and discovery for Phase 3 of the deterministic-local-harness roadmap.

This module is the single owner of the fixture-format contract. Test files
under ``tests/sidecar/replay/`` and ``tests/replay/`` consume the fixtures
through the ``Fixture`` dataclass and the ``load_fixture``/``discover_fixtures``
helpers; no other module should hand-parse the JSON.

Phase 3 introduces no production runtime changes. Validation is enforced
exclusively at fixture load time via :class:`FixtureValidationError`.

Phase 12B widens two ALLOWED-set tokens to admit conversation-scenario
fixtures used by ``scripts/eval/`` (C.B.2): the family
``"conversation_scenario"`` is valid, and ``target_phase: 12`` is accepted.
The widening is additive; existing replay fixtures (target_phase 3..7,
families enumerated below) remain valid without change.

``ALLOWED_TURN_EVENT_KINDS`` admits ``"plan_object"`` for historical
replay/persistence fixtures. Current sidecars no longer emit structured plan
proposals, but older persisted rows remain readable.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

from sidecar.ai.engines.engine_events import EngineEvent
from sidecar.ai.routing import loop_events as _loop_events
from sidecar.ai.tools.models import (
    GenerationResult,
    GenerationUsage,
    StreamingEvent,
    ThinkingDelta,
    ToolCallRequest,
)
from sidecar.protocol import ALLOWED_NOTIFICATION_METHODS

SCHEMA_VERSION = 1

ALLOWED_FIXTURE_FAMILIES: frozenset[str] = frozenset(
    {
        "native_tool_schema_stream",
        "thinking_plus_content_plus_tool",
        "inband_json_tool_call",
        "content_null_between_tool_deltas",
        "malformed_tool_arguments",
        "reasoning_only_completion",
        "tool_delta_then_final_text",
        "parallel_tool_calls",
        "tool_call_canceled_or_rejected",
        # Phase 12B (C.B.2): full-loop conversation scenarios under
        # tests/eval/fixtures/scenarios/. Same v1 schema as the replay
        # corpus; the family token signals "intended for the scenario_replay
        # provider", not a different shape.
        "conversation_scenario",
    }
)

ALLOWED_PROVIDERS: frozenset[str] = frozenset({"ollama", "vllm", "provider_neutral"})

ALLOWED_TARGET_PHASES: frozenset[int] = frozenset({3, 4, 5, 6, 7, 12})

# The 17 canonical persisted-event kinds. Mirrors
# ``renderer-turn-tree-projector.js::EVENT_KIND_PRIORITY``. The master roadmap
# froze this set at 16; Phase 12D / K.B.8 widened it to 17 for ``plan_object``.
# The owner-approved Plan Mode parity contract widens it to 18 for
# ``plan_document`` (2026-08-19)
# (``services/backend/canonical-turn-event-collector.js`` LIVE_CAPTURED_KINDS).
# Do not extend further without explicit user approval.
ALLOWED_TURN_EVENT_KINDS: frozenset[str] = frozenset(
    {
        "user_prompt",
        "attachment_cluster",
        "reasoning_phase",
        "agent_progress",
        "assistant_text_segment",
        "tool_use",
        "approval_requested",
        "approval_resolved",
        "tool_executing",
        "tool_result",
        "assistant_error",
        "interactive_batch",
        "interactive_recap",
        "proactive_suggestion",
        "slash_output",
        "system_notice",
        # Historical plan summaries persisted by
        # services/backend/plan-object-promotion.js.
        "plan_object",
        "plan_document",
    }
)

# Engine-level dataclass discriminator → concrete class. Only frozen dataclasses
# yielded or returned by Jenny's local engine wrappers are listed.
#
# ``EngineEvent`` is the provider-neutral carrier the Ollama wrapper uses for
# the mid-stream ``tool_call_completed`` announcement
# (``sidecar/ai/engines/ollama_tool_call_announce.py``, landed 2026-08-31):
# a fully-parsed tool call is announced as soon as it is parsed instead of
# being held until ``done``.
ENGINE_EVENT_CLASS_REGISTRY: dict[str, type] = {
    "EngineEvent": EngineEvent,
    "StreamingEvent": StreamingEvent,
    "ThinkingDelta": ThinkingDelta,
    "ToolCallRequest": ToolCallRequest,
}

# Routing-level dataclass discriminator → concrete class. Mirrors every public
# event class in ``sidecar.ai.routing.loop_events``.
LOOP_EVENT_CLASS_REGISTRY: dict[str, type] = {
    "IterationStartEvent": _loop_events.IterationStartEvent,
    "ThinkingEvent": _loop_events.ThinkingEvent,
    "PhaseStartedEvent": _loop_events.PhaseStartedEvent,
    "PhaseCompletedEvent": _loop_events.PhaseCompletedEvent,
    "ToolCallCompletedEvent": _loop_events.ToolCallCompletedEvent,
    "ToolExecutingEvent": _loop_events.ToolExecutingEvent,
    "ToolResultEvent": _loop_events.ToolResultEvent,
    "TokenDeltaEvent": _loop_events.TokenDeltaEvent,
    "StreamResetEvent": _loop_events.StreamResetEvent,
    "HeartbeatEvent": _loop_events.HeartbeatEvent,
    "FallbackTriggeredEvent": _loop_events.FallbackTriggeredEvent,
    "StopEvent": _loop_events.StopEvent,
    "ContextCompactedEvent": _loop_events.ContextCompactedEvent,
}

# Volatile fields that the harness fills at runtime. Assertion helpers strip
# these before comparing actual to expected.
VOLATILE_NOTIFICATION_FIELDS: frozenset[str] = frozenset(
    {"request_id", "trace_id", "session_id", "api_version"}
)
VOLATILE_TURN_EVENT_FIELDS: frozenset[str] = frozenset(
    {"event_id", "event_seq", "started_at", "completed_at", "turn_id"}
)

_REQUIRED_TOP_LEVEL_KEYS: frozenset[str] = frozenset(
    {
        "schema_version",
        "metadata",
        "raw_chunks",
        "expected_engine_events",
        "expected_loop_events",
        "expected_notifications",
        "expected_turn_events",
        "expected_generation_result",
    }
)
_REQUIRED_METADATA_KEYS: frozenset[str] = frozenset(
    {"fixture_family", "provider", "model", "description", "target_phase"}
)


class FixtureValidationError(ValueError):
    """Raised when a replay fixture violates the v1 schema contract."""


@dataclass(frozen=True)
class FixtureMetadata:
    fixture_family: str
    provider: str
    model: str
    description: str
    target_phase: int


@dataclass(frozen=True)
class Fixture:
    schema_version: int
    metadata: FixtureMetadata
    raw_chunks: tuple[Mapping[str, Any], ...]
    expected_engine_events: tuple[Mapping[str, Any], ...]
    expected_loop_events: tuple[Mapping[str, Any], ...]
    expected_notifications: tuple[Mapping[str, Any], ...]
    expected_turn_events: tuple[Mapping[str, Any], ...]
    expected_generation_result: Mapping[str, Any]
    path: Path = field(compare=False)
    approval_resolution: Mapping[str, Any] | None = None


def repo_root() -> Path:
    """Return the repository root, resolved from this file's location.

    ``__file__`` lives at ``<repo>/tests/sidecar/replay/fixture_format.py``;
    walk up four levels (file, replay/, sidecar/, tests/, <repo>).
    """
    return Path(__file__).resolve().parents[3]


def fixtures_root() -> Path:
    """Return the canonical replay-fixtures directory."""
    return repo_root() / "tests" / "fixtures" / "replays"


def discover_fixtures(root: Path | None = None) -> list[Path]:
    """Return a sorted list of all replay-fixture JSON paths under *root*."""
    base = root if root is not None else fixtures_root()
    if not base.exists():
        return []
    return sorted(p for p in base.glob("*.json") if p.is_file())


def load_fixture(path: Path) -> Fixture:
    """Load and validate a replay fixture JSON file.

    Raises :class:`FixtureValidationError` with a clear message on any
    schema-contract violation.
    """
    try:
        raw_text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise FixtureValidationError(
            f"replay fixture at {path} could not be read: {error}"
        ) from error
    try:
        document = json.loads(raw_text)
    except json.JSONDecodeError as error:
        raise FixtureValidationError(
            f"replay fixture at {path} is not valid JSON: {error}"
        ) from error
    if not isinstance(document, dict):
        raise FixtureValidationError(
            f"replay fixture at {path} must be a JSON object at the top level"
        )

    _validate_top_level(document, path)
    metadata = _validate_metadata(document["metadata"], path)

    raw_chunks = _validate_list_of_dicts(document["raw_chunks"], "raw_chunks", path)
    expected_engine_events = _validate_list_of_dicts(
        document["expected_engine_events"], "expected_engine_events", path
    )
    expected_loop_events = _validate_list_of_dicts(
        document["expected_loop_events"], "expected_loop_events", path
    )
    expected_notifications = _validate_list_of_dicts(
        document["expected_notifications"], "expected_notifications", path
    )
    expected_turn_events = _validate_list_of_dicts(
        document["expected_turn_events"], "expected_turn_events", path
    )
    expected_generation_result = document["expected_generation_result"]
    if not isinstance(expected_generation_result, dict):
        raise FixtureValidationError(f"{path}: expected_generation_result must be a JSON object")

    _validate_events_against_registry(
        expected_engine_events,
        field_name="expected_engine_events",
        registry=ENGINE_EVENT_CLASS_REGISTRY,
        registry_label="ENGINE_EVENT_CLASS_REGISTRY",
        path=path,
    )
    _validate_events_against_registry(
        expected_loop_events,
        field_name="expected_loop_events",
        registry=LOOP_EVENT_CLASS_REGISTRY,
        registry_label="LOOP_EVENT_CLASS_REGISTRY",
        path=path,
    )
    _validate_notifications(expected_notifications, path)
    _validate_turn_events(expected_turn_events, path)
    _validate_generation_result(expected_generation_result, path)

    approval_resolution_raw = document.get("approval_resolution")
    approval_resolution: Mapping[str, Any] | None = None
    if approval_resolution_raw is not None:
        if not isinstance(approval_resolution_raw, dict):
            raise FixtureValidationError(
                f"{path}: approval_resolution must be a JSON object when present"
            )
        approval_resolution = approval_resolution_raw

    return Fixture(
        schema_version=int(document["schema_version"]),
        metadata=metadata,
        raw_chunks=tuple(raw_chunks),
        expected_engine_events=tuple(expected_engine_events),
        expected_loop_events=tuple(expected_loop_events),
        expected_notifications=tuple(expected_notifications),
        expected_turn_events=tuple(expected_turn_events),
        expected_generation_result=expected_generation_result,
        path=path,
        approval_resolution=approval_resolution,
    )


def _validate_top_level(document: Mapping[str, Any], path: Path) -> None:
    missing = _REQUIRED_TOP_LEVEL_KEYS - set(document.keys())
    if missing:
        raise FixtureValidationError(f"{path}: missing required top-level keys: {sorted(missing)}")
    schema_version = document.get("schema_version")
    if schema_version != SCHEMA_VERSION:
        raise FixtureValidationError(
            f"{path}: schema_version must be {SCHEMA_VERSION}, got {schema_version!r}"
        )


def _validate_metadata(metadata: Any, path: Path) -> FixtureMetadata:
    if not isinstance(metadata, dict):
        raise FixtureValidationError(f"{path}: metadata must be a JSON object")
    missing = _REQUIRED_METADATA_KEYS - set(metadata.keys())
    if missing:
        raise FixtureValidationError(
            f"{path}: metadata is missing required keys: {sorted(missing)}"
        )
    family = metadata["fixture_family"]
    if family not in ALLOWED_FIXTURE_FAMILIES:
        raise FixtureValidationError(
            f"{path}: metadata.fixture_family {family!r} is not in ALLOWED_FIXTURE_FAMILIES"
        )
    provider = metadata["provider"]
    if provider not in ALLOWED_PROVIDERS:
        raise FixtureValidationError(
            f"{path}: metadata.provider {provider!r} is not in ALLOWED_PROVIDERS"
        )
    target_phase = metadata["target_phase"]
    if not isinstance(target_phase, int) or target_phase not in ALLOWED_TARGET_PHASES:
        raise FixtureValidationError(
            f"{path}: metadata.target_phase {target_phase!r} must be one of "
            f"{sorted(ALLOWED_TARGET_PHASES)}"
        )
    description = metadata["description"]
    if not isinstance(description, str) or not description.strip():
        raise FixtureValidationError(f"{path}: metadata.description must be a non-empty string")
    model = metadata["model"]
    if not isinstance(model, str):
        raise FixtureValidationError(f"{path}: metadata.model must be a string")
    return FixtureMetadata(
        fixture_family=family,
        provider=provider,
        model=model,
        description=description,
        target_phase=int(target_phase),
    )


def _validate_list_of_dicts(value: Any, field_name: str, path: Path) -> list[Mapping[str, Any]]:
    if not isinstance(value, list):
        raise FixtureValidationError(
            f"{path}: {field_name} must be a JSON list (got {type(value).__name__})"
        )
    for index, entry in enumerate(value):
        if not isinstance(entry, dict):
            raise FixtureValidationError(f"{path}: {field_name}[{index}] must be a JSON object")
    return list(value)


def _validate_events_against_registry(
    events: Sequence[Mapping[str, Any]],
    *,
    field_name: str,
    registry: Mapping[str, type],
    registry_label: str,
    path: Path,
) -> None:
    for index, event in enumerate(events):
        class_name = event.get("_class")
        if class_name not in registry:
            raise FixtureValidationError(
                f"{path}: {field_name}[{index}]._class {class_name!r} is not in {registry_label}"
            )


def _validate_notifications(notifications: Sequence[Mapping[str, Any]], path: Path) -> None:
    for index, notification in enumerate(notifications):
        method = notification.get("method")
        if method not in ALLOWED_NOTIFICATION_METHODS:
            raise FixtureValidationError(
                f"{path}: expected_notifications[{index}].method {method!r} is "
                f"not in sidecar.protocol.ALLOWED_NOTIFICATION_METHODS"
            )
        params = notification.get("params")
        if not isinstance(params, dict):
            raise FixtureValidationError(
                f"{path}: expected_notifications[{index}].params must be an object"
            )


def _validate_turn_events(events: Sequence[Mapping[str, Any]], path: Path) -> None:
    for index, event in enumerate(events):
        kind = event.get("kind")
        if kind not in ALLOWED_TURN_EVENT_KINDS:
            raise FixtureValidationError(
                f"{path}: expected_turn_events[{index}].kind {kind!r} is not in "
                f"the 16 valid persisted kinds"
            )


def _validate_generation_result(result: Mapping[str, Any], path: Path) -> None:
    finish_reason = result.get("finish_reason")
    if finish_reason is not None and not isinstance(finish_reason, str):
        raise FixtureValidationError(
            f"{path}: expected_generation_result.finish_reason must be a string"
        )
    tool_calls = result.get("tool_calls", [])
    if not isinstance(tool_calls, list):
        raise FixtureValidationError(
            f"{path}: expected_generation_result.tool_calls must be a list"
        )
    for index, call in enumerate(tool_calls):
        if not isinstance(call, dict):
            raise FixtureValidationError(
                f"{path}: expected_generation_result.tool_calls[{index}] must be a JSON object"
            )
        if "tool_id" not in call or "arguments" not in call:
            raise FixtureValidationError(
                f"{path}: expected_generation_result.tool_calls[{index}] must "
                f"include tool_id and arguments"
            )
    usage = result.get("usage")
    if usage is not None:
        if not isinstance(usage, dict):
            raise FixtureValidationError(
                f"{path}: expected_generation_result.usage must be a JSON object"
            )
        for key in (
            "input_tokens",
            "output_tokens",
            "last_request_input_tokens",
            "generation_tokens",
        ):
            value = usage.get(key, 0)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise FixtureValidationError(
                    f"{path}: expected_generation_result.usage.{key} must be a "
                    f"non-negative integer"
                )
        for key in (
            "generation_duration_ms",
            "prompt_eval_duration_ms",
            "load_duration_ms",
            "time_to_first_token_ms",
        ):
            value = usage.get(key, 0)
            if (
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or value < 0
            ):
                raise FixtureValidationError(
                    f"{path}: expected_generation_result.usage.{key} must be a "
                    f"non-negative number"
                )


def build_engine_event(spec: Mapping[str, Any]) -> Any:
    """Construct a concrete engine-level event instance from a fixture entry.

    Strips the ``_class`` discriminator key before invoking the dataclass.
    """
    class_name = spec["_class"]
    cls = ENGINE_EVENT_CLASS_REGISTRY[class_name]
    kwargs = {key: value for key, value in spec.items() if key != "_class"}
    return cls(**kwargs)


def build_loop_event(spec: Mapping[str, Any]) -> Any:
    """Construct a concrete loop-event instance from a fixture entry."""
    class_name = spec["_class"]
    cls = LOOP_EVENT_CLASS_REGISTRY[class_name]
    kwargs = {key: value for key, value in spec.items() if key != "_class"}
    return cls(**kwargs)


def build_generation_result(spec: Mapping[str, Any]) -> GenerationResult:
    """Construct a :class:`GenerationResult` from the fixture's expected_generation_result block."""
    tool_calls = tuple(
        ToolCallRequest(
            tool_id=call["tool_id"],
            arguments=call["arguments"],
            call_id=call.get("call_id", ""),
            idempotency_key=call.get("idempotency_key", ""),
            coerced=bool(call.get("coerced", False)),
        )
        for call in spec.get("tool_calls", [])
    )
    usage_spec = spec.get("usage")
    usage = None
    if isinstance(usage_spec, dict):
        input_tokens = int(usage_spec.get("input_tokens", 0))
        output_tokens = int(usage_spec.get("output_tokens", 0))
        usage = GenerationUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=int(usage_spec.get("total_tokens", input_tokens + output_tokens)),
            provider=str(usage_spec.get("provider", "")),
            model=str(usage_spec.get("model", "")),
            raw_usage=dict(usage_spec.get("raw_usage", {})),
            last_request_input_tokens=int(
                usage_spec.get("last_request_input_tokens", input_tokens)
            ),
            generation_tokens=int(usage_spec.get("generation_tokens", 0)),
            generation_duration_ms=float(
                usage_spec.get("generation_duration_ms", 0)
            ),
            prompt_eval_duration_ms=float(
                usage_spec.get("prompt_eval_duration_ms", 0)
            ),
            load_duration_ms=float(usage_spec.get("load_duration_ms", 0)),
            time_to_first_token_ms=float(
                usage_spec.get("time_to_first_token_ms", 0)
            ),
        )
    return GenerationResult(
        content=spec.get("content", ""),
        tool_calls=tool_calls,
        finish_reason=spec.get("finish_reason", "stop"),
        thinking_text=spec.get("thinking_text", ""),
        usage=usage,
    )
