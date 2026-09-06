from __future__ import annotations

import json
from pathlib import Path

from sidecar.ai.routing.turn_event_contract import (
    CANONICAL_TURN_COUNTER_FIELDS,
    CANONICAL_TURN_SCHEMA_VERSION,
    DURABLE_EVENT_TYPES,
    EPHEMERAL_EVENT_TYPES,
    EVENT_CAPS,
    UNPERSISTED_DURABLE_TYPES,
    build_canonical_turn_event,
    reduce_to_semantic_part,
    reduce_to_turn_event_kind,
    validate_turn_event,
)

FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "fixtures"
    / "canonical-turn-events"
    / "cases.json"
)


def _fixture_cases() -> list[dict]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["cases"]


def test_packet_0_contract_constants_lock_schema_caps_and_counters() -> None:
    assert CANONICAL_TURN_SCHEMA_VERSION == 1
    assert EVENT_CAPS["id"] == 128
    assert EVENT_CAPS["text_delta"] == 8192
    assert EVENT_CAPS["reasoning_delta"] == 4096
    assert EVENT_CAPS["tool_input_summary"] == 8192
    assert EVENT_CAPS["tool_output_summary"] == 16384
    assert EVENT_CAPS["event_payload_bytes"] == 32768
    assert "tool_input_delta" in EPHEMERAL_EVENT_TYPES
    assert CANONICAL_TURN_COUNTER_FIELDS == (
        "canonical_events_emitted",
        "legacy_notifications_emitted",
        "canonical_event_bytes",
        "legacy_notification_bytes",
        "sidecar_notification_to_electron_ms",
        "electron_ingest_to_renderer_commit_ms",
        "orphan_tool_repair_count",
        "live_replay_divergence_count",
        "unknown_or_dropped_canonical_event_count",
    )


def test_durable_event_types_are_exhaustively_partitioned_by_persistence() -> None:
    persisted_types = {
        event_type
        for event_type in DURABLE_EVENT_TYPES
        if reduce_to_turn_event_kind(
            {"type": event_type, "durability": "durable"}
        )
        is not None
    }
    assert persisted_types | UNPERSISTED_DURABLE_TYPES == DURABLE_EVENT_TYPES
    assert persisted_types.isdisjoint(UNPERSISTED_DURABLE_TYPES)


def test_build_canonical_turn_event_assigns_stable_ids_and_part_ids() -> None:
    event = build_canonical_turn_event(
        event_type="text_part_completed",
        turn_id="turn_abc",
        seq=3,
        payload={"text": "Hello"},
    )

    assert event.event_id == "turn_abc:canonical:3"
    assert event.part_id == "turn_abc:text_part:3"
    assert event.durability == "durable"
    assert event.payload["text"] == "Hello"


def test_validate_turn_event_shared_fixture_cases() -> None:
    for case in _fixture_cases():
        result = validate_turn_event(case["input"])
        expected = case["expected"]

        assert result.status == expected["status"], case["name"]
        if expected["status"] != "accepted":
            assert result.event is None
            assert result.diagnostics[0]["code"] == expected["diagnostic_code"]
            continue

        assert result.event is not None
        event = result.event
        assert event.durability == expected["durability"]
        if expected.get("event_id"):
            assert event.event_id == expected["event_id"]
        if expected.get("part_id"):
            assert event.part_id == expected["part_id"]
        assert reduce_to_turn_event_kind(event) == expected["persisted_kind"]
        part = reduce_to_semantic_part(event)
        assert part is not None
        assert part["part_kind"] == expected["part_kind"]
        assert part["state"] == expected["part_state"]
        if expected.get("sanitized_payload"):
            assert event.payload == expected["sanitized_payload"], case["name"]
        serialized = json.dumps(event.to_payload(), sort_keys=True)
        for needle in expected.get("redacted_substrings_absent", []):
            assert needle not in serialized, case["name"]
        # Presence assertions pin the redaction *shape*, not just the absence
        # of the raw value: the file:/// prefix survives its own redaction
        # token, and scheme separators in http(s) URLs stay legible instead of
        # being read as drive letters. Mirrored in the JS suite; keep in sync.
        for needle in expected.get("redacted_substrings_present", []):
            assert needle in serialized, case["name"]


def test_payload_caps_and_truncation_diagnostics_are_applied() -> None:
    result = validate_turn_event(
        {
            "v": 1,
            "turn_id": "turn_caps",
            "seq": 5,
            "type": "text_delta",
            "payload": {"delta": "x" * (EVENT_CAPS["text_delta"] + 100)},
        }
    )

    assert result.status == "accepted"
    assert result.event is not None
    assert result.event.payload["delta"] == "x" * EVENT_CAPS["text_delta"]
    assert any(item["code"] == "payload_truncated" for item in result.diagnostics)


def test_approval_policy_presentation_fields_are_independently_capped_and_redacted() -> None:
    result = validate_turn_event(
        {
            "v": 1,
            "turn_id": "turn_approval_policy",
            "seq": 6,
            "type": "tool_approval_requested",
            "tool_call_id": "call_approval_policy",
            "payload": {
                "policy_scope": "Workspace " + ("x" * 200),
                "policy_consequence": (
                    "May change C:/Users/example/private.txt with "
                    "api_key=sk-abcdefghijklmnop"
                ),
            },
        }
    )

    assert result.status == "accepted"
    assert result.event is not None
    assert len(result.event.payload["policy_scope"].encode("utf-8")) <= 120
    assert "C:/Users/example/private.txt" not in result.event.payload["policy_consequence"]
    assert "sk-abcdefghijklmnop" not in result.event.payload["policy_consequence"]


def test_malformed_identifiers_reject_instead_of_stringifying() -> None:
    for turn_id in (0, False, ["turn_array"], {"id": "turn_object"}, "bad id", "会話"):
        result = validate_turn_event(
            {"v": 1, "turn_id": turn_id, "seq": 1, "type": "text_delta", "payload": {"delta": "x"}}
        )
        assert result.status == "dropped"
        assert result.diagnostics[0]["code"] == "missing_turn_id"


def test_utf8_caps_and_structural_bombs_are_contained() -> None:
    cjk = validate_turn_event(
        {
            "v": 1,
            "turn_id": "turn_cjk",
            "seq": 1,
            "type": "text_delta",
            "payload": {"delta": "会" * EVENT_CAPS["text_delta"]},
        }
    )
    assert cjk.event is not None
    assert len(cjk.event.payload["delta"].encode("utf-8")) <= EVENT_CAPS["text_delta"]
    assert any(item["code"] == "payload_truncated" for item in cjk.diagnostics)

    deep: dict = {"leaf": True}
    for _index in range(14):
        deep = {"child": deep}
    bomb = validate_turn_event(
        {"v": 1, "turn_id": "turn_depth", "seq": 1, "type": "status_part", "payload": deep}
    )
    assert bomb.status == "accepted"
    assert bomb.event is not None
    assert bomb.event.payload == {"truncated": True, "summary": "[truncated:structure]"}
    assert any(item["code"] == "structure_budget_exceeded" for item in bomb.diagnostics)


def test_durable_payload_redaction_removes_prompt_paths_data_uris_and_provider_maps() -> None:
    result = validate_turn_event(
        {
            "v": 1,
            "turn_id": "turn_redact",
            "seq": 7,
            "type": "tool_execution_completed",
            "tool_call_id": "call_1",
            "payload": {
                "tool_name": "read_file",
                "tool_output_summary": "Read C:/Users/example/private.txt",
                "prompt": "private prompt text",
                "diagnostics": {"raw": "private diagnostics"},
                "image": "data:image/png;base64,abcdef",
            },
        }
    )

    assert result.status == "accepted"
    assert result.event is not None
    serialized = json.dumps(result.event.to_payload(), sort_keys=True)
    assert "private prompt text" not in serialized
    assert "private diagnostics" not in serialized
    assert "C:/Users/example/private.txt" not in serialized
    assert "data:image/png" not in serialized
    assert "[redacted:path]" in serialized
    assert "[redacted:path]/private.txt" in serialized
    assert "[redacted:data-uri]" in serialized


def test_reasoning_part_completed_with_persist_false_is_ephemeral() -> None:
    result = validate_turn_event(
        {
            "v": 1,
            "turn_id": "turn_reasoning",
            "seq": 1,
            "type": "reasoning_part_completed",
            "payload": {"text": "transient", "persist": False},
        }
    )

    assert result.status == "accepted"
    assert result.event is not None
    assert result.event.durability == "ephemeral"
    assert reduce_to_turn_event_kind(result.event) is None


def test_nonfinite_seq_and_version_are_rejected_without_throwing() -> None:
    # CTL-015 parity table, non-finite rows: these cannot ride the shared JSON
    # fixture (JSON has no NaN/Infinity literals), so both language suites pin
    # them natively with identical verdicts. int(float("inf")) raises
    # OverflowError, which must read as malformed input, not a crash.
    for bad in (float("inf"), float("-inf"), float("nan")):
        result = validate_turn_event(
            {
                "v": 1,
                "turn_id": "turn_nonfinite",
                "seq": bad,
                "type": "text_delta",
                "payload": {"delta": "x"},
            }
        )
        assert result.status == "dropped", repr(bad)
        assert result.diagnostics[0]["code"] == "invalid_seq", repr(bad)

        result = validate_turn_event(
            {
                "v": bad,
                "turn_id": "turn_nonfinite",
                "seq": 1,
                "type": "text_delta",
                "payload": {"delta": "x"},
            }
        )
        assert result.status == "unsupported", repr(bad)
        assert result.diagnostics[0]["code"] == "unsupported_version", repr(bad)


def test_unknown_event_type_is_unsupported_without_throwing() -> None:
    result = validate_turn_event(
        {
            "v": 1,
            "turn_id": "turn_future",
            "seq": 8,
            "type": "future_event_type",
            "payload": {"raw": "ignored"},
        }
    )

    assert result.status == "unsupported"
    assert result.event is None
    assert result.diagnostics[0]["code"] == "unsupported_event_type"


def test_payload_sanitizer_converts_nonfinite_floats_to_none() -> None:
    # CTL-011: canonical payload sanitation must enforce finiteness so a
    # malformed provider metric can never serialize as invalid JSON downstream.
    result = validate_turn_event(
        {
            "v": 1,
            "turn_id": "turn_nonfinite_payload",
            "seq": 1,
            "type": "status_part",
            "payload": {
                "rate": float("nan"),
                "nested": {"speed": float("inf")},
                "list": [float("-inf"), 2.5],
                "finite": 1.25,
            },
        }
    )
    assert result.status == "accepted"
    payload = result.event.payload
    assert payload["rate"] is None
    assert payload["nested"]["speed"] is None
    assert payload["list"] == [None, 2.5]
    assert payload["finite"] == 1.25
    # The sanitized event must serialize under JavaScript-parity strictness.
    json.dumps(result.event.to_payload(), allow_nan=False)


def test_truncated_display_fields_carry_ellipsis_marker_inside_cap() -> None:
    result = validate_turn_event(
        {
            "v": 1,
            "turn_id": "turn_marker",
            "seq": 6,
            "type": "tool_execution_completed",
            "payload": {"summary": "s" * (EVENT_CAPS["summary"] + 60)},
        }
    )

    assert result.status == "accepted"
    assert result.event is not None
    capped = result.event.payload["summary"]
    assert capped.endswith("…")
    assert len(capped.encode("utf-8")) <= EVENT_CAPS["summary"]
    assert any(item["code"] == "payload_truncated" for item in result.diagnostics)


def test_concatenating_delta_fields_never_carry_the_marker() -> None:
    # text_delta marker-freedom is already pinned by the caps test above; this
    # covers the arguments_delta stream field, which shares the named-field
    # caps with marked display fields.
    args = validate_turn_event(
        {
            "v": 1,
            "turn_id": "turn_marker_args",
            "seq": 8,
            "type": "tool_input_delta",
            "payload": {"arguments_delta": "a" * (EVENT_CAPS["tool_input_summary"] + 100)},
        }
    )
    assert args.event is not None
    assert args.event.payload["arguments_delta"] == "a" * EVENT_CAPS["tool_input_summary"]
