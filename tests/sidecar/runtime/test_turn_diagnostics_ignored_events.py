"""Store-side bounds on provider ignored-event diagnostics.

The engine sanitizes before it emits, but the diagnostics store is the boundary that
actually reaches the renderer, so it re-applies the same charset, length, and
entry-count rules independently. An event-type string comes off the wire and is
attacker-influenced; only the type NAME and a count are ever recorded, never a
payload.
"""

from __future__ import annotations

import json

from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore


def _snapshot(diagnostics: dict[str, object]) -> dict[str, object]:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req-diag", session_id=None, mode="assist")
    store.record_provider_completion_shape(request_id="req-diag", diagnostics=diagnostics)
    snapshot = store.get_snapshot_for_request("req-diag")
    assert snapshot is not None
    return snapshot.get("provider_completion_shape") or {}


def test_optional_counters_are_absent_when_the_provider_does_not_report_them() -> None:
    shape = _snapshot({"output_text_delta_count": 3})

    assert "ignored_event_count" not in shape
    assert "undecodable_line_count" not in shape
    assert "duplicate_function_call_event_count" not in shape


def test_optional_counters_are_recorded_when_reported() -> None:
    shape = _snapshot(
        {
            "ignored_event_count": 4,
            "undecodable_line_count": 1,
            "duplicate_function_call_event_count": 2,
        }
    )

    assert shape["ignored_event_count"] == 4
    assert shape["undecodable_line_count"] == 1
    assert shape["duplicate_function_call_event_count"] == 2


def test_a_reported_zero_is_preserved_not_dropped() -> None:
    shape = _snapshot({"ignored_event_count": 0})

    assert shape["ignored_event_count"] == 0


def test_negative_counters_clamp_to_zero() -> None:
    shape = _snapshot({"ignored_event_count": -5})

    assert shape["ignored_event_count"] == 0


def test_histogram_records_type_names_and_counts() -> None:
    shape = _snapshot(
        {"ignored_event_types": {"response.created": 2, "response.output_item.added": 1}}
    )

    assert shape["ignored_event_types"] == {
        "response.created": 2,
        "response.output_item.added": 1,
    }


def test_an_empty_histogram_is_dropped_entirely() -> None:
    assert "ignored_event_types" not in _snapshot({"ignored_event_types": {}})
    assert "ignored_event_types" not in _snapshot({"ignored_event_types": None})
    assert "ignored_event_types" not in _snapshot({"ignored_event_types": "nope"})


def test_an_overlong_type_name_collapses_to_the_unsafe_sentinel() -> None:
    overlong = "a" * 500
    shape = _snapshot({"ignored_event_types": {overlong: 1}})

    assert shape["ignored_event_types"] == {"unsafe": 1}
    assert overlong not in json.dumps(shape)


def test_control_and_markup_characters_collapse_to_the_unsafe_sentinel() -> None:
    hostile = {"response.\ncreated": 1, "<script>alert(1)</script>": 2, "a\x00b": 3}
    shape = _snapshot({"ignored_event_types": hostile})

    serialized = json.dumps(shape)
    assert shape["ignored_event_types"] == {"unsafe": 6}
    for fragment in ("script", "alert", "\\n", "\\u0000"):
        assert fragment not in serialized


def test_non_string_keys_collapse_to_the_unsafe_sentinel() -> None:
    shape = _snapshot({"ignored_event_types": {42: 1, None: 2}})

    assert shape["ignored_event_types"] == {"unsafe": 3}


def test_non_integer_and_non_positive_counts_are_dropped() -> None:
    shape = _snapshot(
        {"ignored_event_types": {"a.b": "many", "c.d": 0, "e.f": -1, "g.h": 2}}
    )

    assert shape["ignored_event_types"] == {"g.h": 2}


def test_the_histogram_is_capped_at_twelve_distinct_types() -> None:
    hostile = {f"type.{index}": 1 for index in range(40)}
    shape = _snapshot({"ignored_event_types": hostile})

    histogram = shape["ignored_event_types"]
    assert len(histogram) <= 12
    # Overflow folds into a bucket rather than vanishing, so the total is preserved.
    assert sum(histogram.values()) == 40
    assert "other" in histogram


def test_counts_clamp_at_the_diagnostic_ceiling() -> None:
    shape = _snapshot({"ignored_event_types": {"a.b": 10**12}})

    assert shape["ignored_event_types"]["a.b"] == 1_000_000_000
