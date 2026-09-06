"""Assertion helpers for the replay-fixture corpus runner.

Each helper compares an *actual* sequence (yielded engine events, emitted loop
events, captured notification dicts) against the *expected* spec from a
fixture. Volatile fields (request_id, trace_id, timestamps) are stripped before
comparison so that fixture content remains stable across runs.

Failure messages quote the fixture path, the offending index, and the
side-by-side diff of stable fields.
"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any, Iterable, Mapping, Sequence

from sidecar.runtime.rpc import notification as build_notification
from tests.sidecar.replay.fixture_format import (
    VOLATILE_NOTIFICATION_FIELDS,
    VOLATILE_TURN_EVENT_FIELDS,
    build_engine_event,
    build_loop_event,
)


def _to_plain(value: Any) -> Any:
    """Convert a dataclass/tuple/dict tree into a JSON-comparable plain dict/list."""
    if is_dataclass(value) and not isinstance(value, type):
        return _to_plain(asdict(value))
    if isinstance(value, Mapping):
        return {key: _to_plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_plain(item) for item in value]
    return value


def _strip_keys(payload: Mapping[str, Any], volatile: frozenset[str]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if key not in volatile}


def assert_engine_events_match(
    actual: Iterable[Any],
    expected: Sequence[Mapping[str, Any]],
    *,
    fixture_label: str = "<fixture>",
) -> None:
    """Compare engine-yielded events to the fixture's ``expected_engine_events``.

    Each expected entry is materialized into the canonical dataclass before
    comparison so that field-name and default-value drift is caught.
    """
    actual_list = [_to_plain(event) for event in actual]
    expected_list = [_to_plain(build_engine_event(spec)) for spec in expected]
    if actual_list != expected_list:
        raise AssertionError(
            f"engine event sequence mismatch in {fixture_label}\n"
            f"  expected: {expected_list}\n"
            f"  actual:   {actual_list}"
        )


def assert_loop_events_match(
    actual: Iterable[Any],
    expected: Sequence[Mapping[str, Any]],
    *,
    fixture_label: str = "<fixture>",
) -> None:
    """Compare typed loop events emitted by ``stream_generate_with_tools``.

    Strict sequence equality on the full set of dataclass fields.
    """
    actual_list = [_to_plain(event) for event in actual]
    expected_list = [_to_plain(build_loop_event(spec)) for spec in expected]
    if actual_list != expected_list:
        raise AssertionError(
            f"loop event sequence mismatch in {fixture_label}\n"
            f"  expected: {expected_list}\n"
            f"  actual:   {actual_list}"
        )


def assert_notifications_match(
    actual: Sequence[Mapping[str, Any]],
    expected: Sequence[Mapping[str, Any]],
    *,
    fixture_label: str = "<fixture>",
) -> None:
    """Compare wire-format notification dicts after stripping volatile fields.

    Each expected entry is wrapped through ``sidecar.runtime.rpc.notification``
    so that ``ALLOWED_NOTIFICATION_METHODS`` is enforced for both expected and
    actual at compare time.
    """
    actual_stripped = [
        {
            "method": entry.get("method"),
            "params": _strip_keys(
                entry.get("params") or {}, VOLATILE_NOTIFICATION_FIELDS
            ),
        }
        for entry in actual
    ]
    expected_stripped: list[dict[str, Any]] = []
    for spec in expected:
        wrapped = build_notification(spec["method"], spec.get("params") or {})
        expected_stripped.append(
            {
                "method": wrapped["method"],
                "params": _strip_keys(wrapped["params"], VOLATILE_NOTIFICATION_FIELDS),
            }
        )
    if actual_stripped != expected_stripped:
        raise AssertionError(
            f"notification sequence mismatch in {fixture_label}\n"
            f"  expected: {expected_stripped}\n"
            f"  actual:   {actual_stripped}"
        )


def assert_turn_events_match(
    actual: Sequence[Mapping[str, Any]],
    expected: Sequence[Mapping[str, Any]],
    *,
    fixture_label: str = "<fixture>",
) -> None:
    """Compare persisted ``turn_events[]`` after stripping volatile/derived fields."""
    actual_stripped = [
        _strip_keys(entry, VOLATILE_TURN_EVENT_FIELDS) for entry in actual
    ]
    expected_stripped = [
        _strip_keys(entry, VOLATILE_TURN_EVENT_FIELDS) for entry in expected
    ]
    if actual_stripped != expected_stripped:
        raise AssertionError(
            f"turn_events[] sequence mismatch in {fixture_label}\n"
            f"  expected: {expected_stripped}\n"
            f"  actual:   {actual_stripped}"
        )


def assert_generation_result_matches(
    actual: Any,
    expected: Mapping[str, Any],
    *,
    fixture_label: str = "<fixture>",
) -> None:
    """Compare a :class:`GenerationResult` to the fixture's ``expected_generation_result``."""
    actual_plain = _to_plain(actual)
    if not isinstance(actual_plain, Mapping):
        raise AssertionError(
            f"GenerationResult mismatch in {fixture_label}: actual is not a "
            f"dataclass-shaped object (got {type(actual).__name__})"
        )
    relevant_keys = ("content", "finish_reason", "thinking_text")
    actual_subset = {key: actual_plain.get(key) for key in relevant_keys}
    expected_subset = {key: expected.get(key, _default_for(key)) for key in relevant_keys}
    if actual_subset != expected_subset:
        raise AssertionError(
            f"GenerationResult scalar mismatch in {fixture_label}\n"
            f"  expected: {expected_subset}\n"
            f"  actual:   {actual_subset}"
        )
    expected_usage = expected.get("usage")
    if isinstance(expected_usage, Mapping):
        # Provider-truth usage pin (Ollama meter work): token counts and
        # provider must match. `model` is deliberately NOT compared — the
        # real-parser driver runs the engine under a test model name while
        # the fixture metadata records the captured model.
        actual_usage = actual_plain.get("usage")
        if not isinstance(actual_usage, Mapping):
            raise AssertionError(
                f"GenerationResult usage missing in {fixture_label}: expected "
                f"{dict(expected_usage)!r}, got {actual_usage!r}"
            )
        expected_input = int(expected_usage.get("input_tokens", 0))
        usage_keys = {
            "input_tokens": expected_input,
            "output_tokens": int(expected_usage.get("output_tokens", 0)),
            "total_tokens": int(
                expected_usage.get(
                    "total_tokens",
                    expected_input + int(expected_usage.get("output_tokens", 0)),
                )
            ),
            "last_request_input_tokens": int(
                expected_usage.get("last_request_input_tokens", expected_input)
            ),
            "generation_tokens": int(expected_usage.get("generation_tokens", 0)),
            "generation_duration_ms": float(
                expected_usage.get("generation_duration_ms", 0)
            ),
            "prompt_eval_duration_ms": float(
                expected_usage.get("prompt_eval_duration_ms", 0)
            ),
            "load_duration_ms": float(expected_usage.get("load_duration_ms", 0)),
            "time_to_first_token_ms": float(
                expected_usage.get("time_to_first_token_ms", 0)
            ),
            "provider": str(expected_usage.get("provider", "")),
        }
        for key, want in usage_keys.items():
            got = actual_usage.get(key)
            if got != want:
                raise AssertionError(
                    f"GenerationResult.usage.{key} mismatch in {fixture_label}: "
                    f"expected {want!r}, got {got!r}"
                )
    actual_calls = actual_plain.get("tool_calls") or []
    expected_calls = expected.get("tool_calls") or []
    if len(actual_calls) != len(expected_calls):
        raise AssertionError(
            f"GenerationResult tool_call count mismatch in {fixture_label}: "
            f"expected {len(expected_calls)}, got {len(actual_calls)}"
        )
    for index, (got, want) in enumerate(zip(actual_calls, expected_calls, strict=False)):
        for key in ("tool_id", "call_id", "arguments"):
            if got.get(key) != want.get(key, "" if key != "arguments" else {}):
                raise AssertionError(
                    f"GenerationResult.tool_calls[{index}].{key} mismatch in "
                    f"{fixture_label}: expected {want.get(key)!r}, got {got.get(key)!r}"
                )


def _default_for(key: str) -> Any:
    if key in {"content", "thinking_text"}:
        return ""
    if key == "finish_reason":
        return "stop"
    return None
