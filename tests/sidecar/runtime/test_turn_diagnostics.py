from __future__ import annotations

import sidecar.runtime.turn_diagnostics as _td_module
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore


def test_turn_diagnostics_prunes_oldest_turns_when_retention_cap_is_exceeded() -> None:
    store = TurnDiagnosticsStore(max_retained_turns=2)

    for index in range(3):
        store.begin_turn(
            request_id=f"req_{index}",
            session_id="session_1",
            mode="chat",
        )

    assert store.get_snapshot_for_request("req_0") is None
    assert store.get_snapshot_for_request("req_1")["request_id"] == "req_1"
    assert store.get_snapshot_for_request("req_2")["request_id"] == "req_2"
    assert store.snapshot()["request_id"] == "req_2"


def test_turn_diagnostics_retention_reinserts_existing_request_as_latest() -> None:
    store = TurnDiagnosticsStore(max_retained_turns=2)
    store.begin_turn(request_id="req_1", session_id="session_1", mode="chat")
    store.begin_turn(request_id="req_2", session_id="session_1", mode="chat")
    store.begin_turn(request_id="req_1", session_id="session_1", mode="plan")

    assert store.get_snapshot_for_request("req_2")["request_id"] == "req_2"
    assert store.snapshot()["request_id"] == "req_1"
    assert store.snapshot()["mode"] == "plan"


def test_record_request_fingerprint_surfaces_in_snapshot() -> None:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_fp", session_id="sess", mode="chat")
    fingerprint = {
        "prefix_hash": "ab12cd34ef567890",
        "tool_schema_hash": "1122334455667788",
        "per_tool_schema_hashes": {"alpha": "aaaa00001111bbbb"},
        "prefix_section_count": 3,
        "tool_schema_count": 1,
        "generated_at": "2026-05-01T12:34:56.789Z",
    }
    store.record_request_fingerprint(request_id="req_fp", fingerprint=fingerprint)

    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["request_fingerprint"] == fingerprint


def test_provider_sampler_is_allowlisted_from_effective_outbound_options() -> None:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_sampler", session_id="sess", mode="assist")

    store.record_provider_request(
        request_id="req_sampler",
        think_enabled=True,
        num_predict=2_048,
        temperature=1.0,
        message_count=2,
        tool_count=1,
        tool_capable=True,
        provider_reasoning_effort="medium",
        final_output_tokens=32_768,
        thinking_headroom_tokens=32_768,
        provider_sampler={
            "temperature": 1.0,
            "top_k": 40,
            "repeat_penalty": 1.15,
            "model": "must-not-surface",
            "messages": [{"role": "user", "content": "must-not-surface"}],
            "top_p": float("nan"),
            "min_p": True,
        },
    )

    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["provider_sampler"] == {
        "temperature": 1.0,
        "top_p": None,
        "top_k": 40,
        "min_p": None,
        "presence_penalty": None,
        "repeat_penalty": 1.15,
    }
    assert snapshot["provider_reasoning_effort"] == "medium"
    assert snapshot["provider_final_output_tokens"] == 32_768
    assert snapshot["provider_thinking_headroom_tokens"] == 32_768
    assert snapshot["provider_sampler_present_keys"] == [
        "temperature",
        "top_k",
        "repeat_penalty",
    ]
    assert "must-not-surface" not in repr(snapshot)


def test_record_request_fingerprint_overwrites_previous_value_for_same_request() -> None:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_fp", session_id="sess", mode="chat")

    first = {"prefix_hash": "first0000first00", "tool_schema_count": 1}
    second = {"prefix_hash": "second00second00", "tool_schema_count": 2}

    store.record_request_fingerprint(request_id="req_fp", fingerprint=first)
    store.record_request_fingerprint(request_id="req_fp", fingerprint=second)

    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["request_fingerprint"] == second


def test_record_stream_counters_surfaces_in_snapshot() -> None:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_sc", session_id="sess", mode="chat")
    counters = {
        "visible_text_delta_count": 3,
        "reasoning_delta_count": 1,
        "tool_call_delta_count": 0,
        "tool_call_completed_count": 1,
        "empty_chunk_count": 0,
        "malformed_tool_arguments_count": 0,
        "failed_count": 0,
        "total_chunk_count": 5,
        "provider": "ollama",
    }
    store.record_stream_counters(request_id="req_sc", counters=counters)

    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["stream_counters"] == counters


def test_record_stream_counters_overwrites_previous_value_for_same_request() -> None:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_sc", session_id="sess", mode="chat")

    first = {"visible_text_delta_count": 1, "provider": "ollama"}
    second = {"visible_text_delta_count": 5, "provider": "ollama"}

    store.record_stream_counters(request_id="req_sc", counters=first)
    store.record_stream_counters(request_id="req_sc", counters=second)

    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["stream_counters"] == second


def test_provider_completion_shape_drops_raw_and_unknown_fields() -> None:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_completion", session_id="sess", mode="assist")

    store.record_provider_completion_shape(
        request_id="req_completion",
        diagnostics={
            "output_text_delta_count": 2,
            "output_text_delta_chars": 14,
            "output_text_done_count": 1,
            "output_text_done_chars": 14,
            "tool_call_count": 3,
            "terminal_event_type": "response.completed",
            "terminal_text_source": "delta",
            "finish_reason": "stop",
            "response_text": "must not surface",
            "raw_provider_payload": {"secret": "must not surface"},
        },
    )

    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["provider_completion_shape"] == {
        "output_text_delta_count": 2,
        "output_text_delta_chars": 14,
        "output_text_done_count": 1,
        "output_text_done_chars": 14,
        "tool_call_count": 3,
        "terminal_event_type": "response.completed",
        "terminal_text_source": "delta",
        "finish_reason": "stop",
    }


def test_terminal_completion_locks_foreground_provider_shape() -> None:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_completion", session_id="sess", mode="assist")
    store.record_provider_completion_shape(
        request_id="req_completion",
        diagnostics={
            "output_text_delta_count": 2,
            "output_text_delta_chars": 14,
            "terminal_event_type": "response.completed",
            "terminal_text_source": "delta",
        },
    )
    store.record_terminal_completion(
        request_id="req_completion",
        completion_source="model",
        visible_response_chars=14,
        tool_result_count=2,
        successful_tool_result_count=1,
        fallback_applied=False,
    )

    store.record_provider_completion_shape(
        request_id="req_completion",
        diagnostics={
            "output_text_delta_count": 99,
            "output_text_delta_chars": 99,
            "terminal_event_type": "response.completed",
            "terminal_text_source": "done",
            "response_text": "must not surface",
        },
    )

    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["provider_completion_shape"]["output_text_delta_count"] == 2
    assert snapshot["provider_completion_shape"]["terminal_text_source"] == "delta"
    assert snapshot["post_terminal_provider_completion_shape_ignored_count"] == 1
    assert "response_text" not in repr(snapshot)


def test_record_canonical_turn_counters_surfaces_bounded_metrics() -> None:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_cte", session_id="sess", mode="chat")
    counters = {
        "canonical_events_emitted": 3,
        "legacy_notifications_emitted": 6,
        "canonical_event_bytes": 900,
        "legacy_notification_bytes": 1800,
        "sidecar_notification_to_electron_ms": 12.5,
        "electron_ingest_to_renderer_commit_ms": 24,
        "orphan_tool_repair_count": 1,
        "live_replay_divergence_count": 2,
        "unknown_or_dropped_canonical_event_count": 4,
        "raw_prompt": "must not surface",
    }
    store.record_canonical_turn_counters(request_id="req_cte", counters=counters)

    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["canonical_turn_counters"] == {
        "canonical_events_emitted": 3,
        "legacy_notifications_emitted": 6,
        "canonical_event_bytes": 900,
        "legacy_notification_bytes": 1800,
        "sidecar_notification_to_electron_ms": 12.5,
        "electron_ingest_to_renderer_commit_ms": 24,
        "orphan_tool_repair_count": 1,
        "live_replay_divergence_count": 2,
        "unknown_or_dropped_canonical_event_count": 4,
    }


def test_record_canonical_turn_counters_overwrites_previous_value() -> None:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_cte", session_id="sess", mode="chat")

    store.record_canonical_turn_counters(
        request_id="req_cte",
        counters={"canonical_events_emitted": 1},
    )
    store.record_canonical_turn_counters(
        request_id="req_cte",
        counters={"canonical_events_emitted": 2},
    )

    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["canonical_turn_counters"] == {"canonical_events_emitted": 2}


def test_record_buffered_visible_output_defaults_to_dropped_disposition() -> None:
    """A buffered preamble that the loop never gets to flush is recorded
    with disposition ``"dropped"`` so observability surfaces the data loss.
    """
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_buf", session_id="sess", mode="chat")
    store.record_buffered_visible_output(
        request_id="req_buf",
        text="Sure thing, let me check the harness.",
        reason="tool_calls",
    )

    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["buffered_visible_output_chars"] == len("Sure thing, let me check the harness.")
    assert "tool_calls" in snapshot["buffered_visible_output_reasons"]
    assert snapshot["buffered_visible_output_disposition"] == "dropped"


def test_mark_buffered_visible_output_flushed_promotes_disposition() -> None:
    """``StopController``-driven aborts drain the buffer into chat.token
    events and then call ``mark_buffered_visible_output_flushed`` so the
    snapshot reflects that the user actually saw the buffered content.
    """
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_buf", session_id="sess", mode="chat")
    store.record_buffered_visible_output(
        request_id="req_buf",
        text="partial answer text",
        reason="tool_calls",
    )
    store.mark_buffered_visible_output_flushed(request_id="req_buf")

    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["buffered_visible_output_disposition"] == "flushed"


def test_record_buffered_visible_output_keeps_dropped_when_flush_never_called() -> None:
    """Recording multiple buffered chunks without a follow-up flush call
    leaves the turn-level disposition at ``dropped``. This regression-tests
    the default that the simplified API relies on (the previous explicit
    ``disposition`` parameter has been removed).
    """
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_buf", session_id="sess", mode="chat")
    store.record_buffered_visible_output(
        request_id="req_buf",
        text="first chunk",
        reason="tool_calls",
    )
    store.record_buffered_visible_output(
        request_id="req_buf",
        text="second chunk",
        reason="tool_calls",
    )

    snapshot = store.snapshot()
    assert snapshot is not None
    assert snapshot["buffered_visible_output_chars"] == len("first chunk") + len("second chunk")
    assert snapshot["buffered_visible_output_disposition"] == "dropped"


def test_mark_buffered_visible_output_flushed_no_op_for_unknown_request() -> None:
    """A stale request id must not insert a turn or otherwise corrupt the store."""
    store = TurnDiagnosticsStore()
    store.mark_buffered_visible_output_flushed(request_id="unknown_req")

    assert store.get_snapshot_for_request("unknown_req") is None


# ---------------------------------------------------------------------------
# _estimate_text_tokens — empty-string path (line 13)
# ---------------------------------------------------------------------------


def test_estimate_text_tokens_returns_zero_for_empty_text() -> None:
    """record_visible_output with empty text short-circuits before token accounting.
    We can probe the estimator indirectly: begin a turn, record non-empty text to
    establish a baseline token count, then call record_visible_output with empty
    text and confirm the count did NOT change."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_tok", session_id="sess", mode="chat")
    store.record_visible_output(request_id="req_tok", text="hello")

    snap_before = store.snapshot()
    assert snap_before is not None
    tokens_before = snap_before["visible_output_tokens_estimate"]

    # Empty string → short-circuit in record_visible_output (line 199) AND
    # would return 0 from _estimate_text_tokens (line 13) if reached.
    store.record_visible_output(request_id="req_tok", text="")

    snap_after = store.snapshot()
    assert snap_after is not None
    assert snap_after["visible_output_tokens_estimate"] == tokens_before


# ---------------------------------------------------------------------------
# begin_turn — empty request_id guard (line 48)
# ---------------------------------------------------------------------------


def test_begin_turn_ignores_empty_request_id() -> None:
    """An empty (or whitespace-only) request_id must be silently ignored."""
    store = TurnDiagnosticsStore()
    # Whitespace-only counts as empty after strip
    store.begin_turn(request_id="   ", session_id="sess", mode="chat")
    store.begin_turn(request_id="", session_id="sess", mode="chat")

    # Nothing should have been inserted
    assert store.snapshot() is None


# ---------------------------------------------------------------------------
# record_canonical_turn_counters — bad-value branches (lines 132-135)
# ---------------------------------------------------------------------------


def test_record_canonical_turn_counters_drops_non_numeric_values() -> None:
    """Values that cannot be coerced to float are silently dropped (lines 132-133)."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_cte2", session_id="sess", mode="chat")
    store.record_canonical_turn_counters(
        request_id="req_cte2",
        counters={
            "canonical_events_emitted": "not-a-number",
            "legacy_notifications_emitted": None,
            "orphan_tool_repair_count": 3,
        },
    )

    snap = store.snapshot()
    assert snap is not None
    ctc = snap["canonical_turn_counters"]
    # Only the valid integer survives
    assert ctc == {"orphan_tool_repair_count": 3}


def test_record_canonical_turn_counters_drops_negative_values() -> None:
    """Negative numbers are rejected (line 134-135)."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_cte3", session_id="sess", mode="chat")
    store.record_canonical_turn_counters(
        request_id="req_cte3",
        counters={
            "canonical_events_emitted": -1,
            "legacy_notifications_emitted": 5,
        },
    )

    snap = store.snapshot()
    assert snap is not None
    ctc = snap["canonical_turn_counters"]
    assert "canonical_events_emitted" not in ctc
    assert ctc["legacy_notifications_emitted"] == 5


def test_record_canonical_turn_counters_ms_field_stays_float() -> None:
    """Fields ending in ``_ms`` keep their fractional value (not int-cast)."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_cte4", session_id="sess", mode="chat")
    store.record_canonical_turn_counters(
        request_id="req_cte4",
        counters={
            "sidecar_notification_to_electron_ms": 7.5,
            "canonical_events_emitted": 2.0,  # integer-valued float → int
        },
    )

    snap = store.snapshot()
    assert snap is not None
    ctc = snap["canonical_turn_counters"]
    assert ctc["sidecar_notification_to_electron_ms"] == 7.5
    # 2.0 is integer-valued and the field does NOT end in _ms → stored as int
    assert ctc["canonical_events_emitted"] == 2
    assert isinstance(ctc["canonical_events_emitted"], int)


def test_record_canonical_turn_counters_noop_when_all_values_invalid() -> None:
    """If every value is rejected, no key is stored in the snapshot."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_cte5", session_id="sess", mode="chat")
    store.record_canonical_turn_counters(
        request_id="req_cte5",
        counters={
            "canonical_events_emitted": "bad",
            "legacy_notifications_emitted": -99,
        },
    )

    snap = store.snapshot()
    assert snap is not None
    assert "canonical_turn_counters" not in snap


# ---------------------------------------------------------------------------
# record_first_chunk — unknown request id (line 192)
# ---------------------------------------------------------------------------


def test_record_first_chunk_noop_for_unknown_request() -> None:
    """record_first_chunk must silently ignore an unrecognised request_id."""
    store = TurnDiagnosticsStore()
    # No begin_turn — the turn dict is absent
    store.record_first_chunk(request_id="phantom")
    # Nothing should have been created
    assert store.get_snapshot_for_request("phantom") is None
    assert store.snapshot() is None


# ---------------------------------------------------------------------------
# record_visible_output — empty text (line 199) and unknown request (line 204)
# ---------------------------------------------------------------------------


def test_record_visible_output_noop_for_empty_text() -> None:
    """Empty visible text must not alter the snapshot at all."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_vis", session_id="sess", mode="chat")

    snap_before = store.snapshot()
    assert snap_before is not None
    assert "visible_output_chars" not in snap_before

    store.record_visible_output(request_id="req_vis", text="")

    snap_after = store.snapshot()
    assert snap_after is not None
    assert "visible_output_chars" not in snap_after


def test_record_visible_output_noop_for_unknown_request() -> None:
    """An unrecognised request_id must not insert a turn."""
    store = TurnDiagnosticsStore()
    store.record_visible_output(request_id="ghost", text="hello")
    assert store.get_snapshot_for_request("ghost") is None
    assert store.snapshot() is None


# ---------------------------------------------------------------------------
# record_buffered_visible_output — empty text (line 233) and unknown request (line 239)
# ---------------------------------------------------------------------------


def test_record_buffered_visible_output_noop_for_empty_text() -> None:
    """Empty buffered text must not alter the snapshot."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_buf2", session_id="sess", mode="chat")
    store.record_buffered_visible_output(request_id="req_buf2", text="", reason="tool_calls")

    snap = store.snapshot()
    assert snap is not None
    assert "buffered_visible_output_chars" not in snap


def test_record_buffered_visible_output_noop_for_unknown_request() -> None:
    """An unrecognised request_id must not insert a turn."""
    store = TurnDiagnosticsStore()
    store.record_buffered_visible_output(request_id="ghost_buf", text="text", reason="r")
    assert store.get_snapshot_for_request("ghost_buf") is None


# ---------------------------------------------------------------------------
# mark_buffered_visible_output_flushed — empty request_id guard (line 267)
# ---------------------------------------------------------------------------


def test_mark_buffered_visible_output_flushed_ignores_empty_request_id() -> None:
    """Whitespace-only / empty request_id must be silently ignored."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_real", session_id="sess", mode="chat")
    store.record_buffered_visible_output(
        request_id="req_real", text="preamble", reason="tool_calls"
    )

    # Call with an empty id — must not crash and must not affect the real turn
    store.mark_buffered_visible_output_flushed(request_id="")
    store.mark_buffered_visible_output_flushed(request_id="   ")

    snap = store.snapshot()
    assert snap is not None
    # disposition still "dropped" because flush was called with a wrong id
    assert snap["buffered_visible_output_disposition"] == "dropped"


# ---------------------------------------------------------------------------
# record_provider_usage — coerce helpers and various field paths (lines 315-374)
# ---------------------------------------------------------------------------


def test_record_provider_usage_all_fields_populated() -> None:
    """Populate every optional field and verify all derived metrics appear."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_pu", session_id="sess", mode="chat")
    store.record_provider_usage(
        request_id="req_pu",
        prompt_eval_count=100,
        eval_count=50,
        cached_tokens=20,
        prompt_eval_duration_ns=500_000_000,
        eval_duration_ns=1_000_000_000,
        total_duration_ns=2_000_000_000,
        load_duration_ns=250_000_000,
        provider_label="ollama",
    )

    snap = store.snapshot()
    assert snap is not None
    assert snap["provider_prompt_eval_count"] == 100
    assert snap["provider_eval_count"] == 50
    assert snap["provider_cached_tokens"] == 20
    assert snap["provider_prompt_cache_hit_ratio"] == 0.2
    assert snap["provider_prompt_eval_duration_ns"] == 500_000_000
    assert snap["provider_prompt_eval_duration_ms"] == 500
    assert snap["provider_eval_duration_ns"] == 1_000_000_000
    assert snap["provider_eval_duration_ms"] == 1000
    assert snap["provider_total_duration_ns"] == 2_000_000_000
    assert snap["provider_total_duration_ms"] == 2000
    assert snap["provider_load_duration_ns"] == 250_000_000
    assert snap["provider_load_duration_ms"] == 250
    assert snap["provider_usage_source"] == "ollama"
    # tokens-per-second: 50 tokens / 1.0 second = 50.0
    assert snap["provider_tokens_per_second"] == 50.0


def test_record_provider_usage_tokens_per_second_derived_when_both_positive() -> None:
    """provider_tokens_per_second is only emitted when eval and duration are > 0."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_tps", session_id="sess", mode="chat")
    store.record_provider_usage(
        request_id="req_tps",
        eval_count=200,
        eval_duration_ns=4_000_000_000,  # 4 seconds
    )

    snap = store.snapshot()
    assert snap is not None
    assert snap["provider_tokens_per_second"] == 50.0


def test_record_provider_usage_no_tokens_per_second_when_duration_zero() -> None:
    """Zero eval_duration_ns must suppress provider_tokens_per_second."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_tps2", session_id="sess", mode="chat")
    store.record_provider_usage(
        request_id="req_tps2",
        eval_count=100,
        eval_duration_ns=0,
    )

    snap = store.snapshot()
    assert snap is not None
    assert "provider_tokens_per_second" not in snap


def test_record_provider_usage_no_tokens_per_second_when_eval_count_zero() -> None:
    """Zero eval_count must suppress provider_tokens_per_second."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_tps3", session_id="sess", mode="chat")
    store.record_provider_usage(
        request_id="req_tps3",
        eval_count=0,
        eval_duration_ns=1_000_000_000,
    )

    snap = store.snapshot()
    assert snap is not None
    assert "provider_tokens_per_second" not in snap


def test_record_provider_usage_coerce_handles_bad_count() -> None:
    """Non-numeric values for count fields are treated as absent (None)."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_pu_bad", session_id="sess", mode="chat")
    # Pass a string that cannot be coerced to int
    store.record_provider_usage(
        request_id="req_pu_bad",
        prompt_eval_count="not-a-number",  # type: ignore[arg-type]
        eval_count=10,
    )

    snap = store.snapshot()
    assert snap is not None
    # Bad value is dropped; valid value survives
    assert "provider_prompt_eval_count" not in snap
    assert snap["provider_eval_count"] == 10


def test_record_provider_usage_coerce_clamps_negative_to_zero() -> None:
    """Negative counts are clamped to 0."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_pu_neg", session_id="sess", mode="chat")
    store.record_provider_usage(
        request_id="req_pu_neg",
        prompt_eval_count=-5,
        eval_count=-10,
        load_duration_ns=-1,
    )

    snap = store.snapshot()
    assert snap is not None
    assert snap["provider_prompt_eval_count"] == 0
    assert snap["provider_eval_count"] == 0
    assert snap["provider_load_duration_ns"] == 0


def test_record_provider_usage_noop_when_no_updates() -> None:
    """Calling record_provider_usage with all Nones must not add any fields."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_pu_empty", session_id="sess", mode="chat")

    snap_before = store.snapshot()
    assert snap_before is not None

    store.record_provider_usage(request_id="req_pu_empty")  # all None

    snap_after = store.snapshot()
    assert snap_after is not None
    # No new keys should have appeared
    assert "provider_eval_count" not in snap_after
    assert "provider_usage_source" not in snap_after


def test_record_provider_usage_cache_ratio_only_when_prompt_positive() -> None:
    """Cache ratio is only derived when prompt_eval_count > 0."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_cache_ratio", session_id="sess", mode="chat")
    # cached_tokens provided but prompt_eval_count = 0 → ratio must NOT appear
    store.record_provider_usage(
        request_id="req_cache_ratio",
        prompt_eval_count=0,
        cached_tokens=10,
    )

    snap = store.snapshot()
    assert snap is not None
    assert "provider_prompt_cache_hit_ratio" not in snap
    assert snap["provider_cached_tokens"] == 10


# ---------------------------------------------------------------------------
# complete_provider_request — unknown request (line 382) and visible tps (line 389)
# ---------------------------------------------------------------------------


def test_complete_provider_request_noop_for_unknown_request() -> None:
    """complete_provider_request on an unrecognised id must be a silent no-op."""
    store = TurnDiagnosticsStore()
    store.complete_provider_request(request_id="ghost_complete")
    assert store.get_snapshot_for_request("ghost_complete") is None


def test_complete_provider_request_derives_visible_tokens_per_second(monkeypatch) -> None:
    """When there is visible output spanning multiple seconds, a tps estimate is emitted.

    We freeze time so that complete_provider_request sees a non-zero duration
    since _first_visible_at regardless of how fast the machine runs.
    """
    clock = [1000.0]

    def fake_monotonic() -> float:
        return clock[0]

    monkeypatch.setattr(_td_module.time, "monotonic", fake_monotonic)

    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_cpr", session_id="sess", mode="chat")

    # Advance time: provider request starts
    clock[0] = 1001.0
    store.record_provider_request(
        request_id="req_cpr",
        think_enabled=False,
        num_predict=None,
        temperature=0.7,
        message_count=2,
        tool_count=0,
        tool_capable=True,
    )

    # Advance time: first visible output arrives
    clock[0] = 1002.0
    # "word " * 50 = 250 chars → _estimate_text_tokens = max(1, (250 + 3) // 4) = 63 tokens
    store.record_visible_output(request_id="req_cpr", text="word " * 50)

    # Advance time: turn is completed (2 seconds after first visible token)
    clock[0] = 1004.0
    store.complete_provider_request(request_id="req_cpr")

    snap = store.snapshot()
    assert snap is not None
    # The field is only present when first_visible_at is set and tokens > 0.
    # Concrete value: 63 visible tokens / 2.0 s (1004.0 - 1002.0) = 31.5 tok/s.
    assert "visible_tokens_per_second_estimate" in snap
    assert snap["visible_output_tokens_estimate"] == 63
    assert snap["visible_tokens_per_second_estimate"] == 31.5


def test_complete_provider_request_no_tps_when_no_visible_tokens() -> None:
    """visible_tokens_per_second_estimate must not appear when there is no visible output."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_cpr2", session_id="sess", mode="chat")
    store.complete_provider_request(request_id="req_cpr2")

    snap = store.snapshot()
    assert snap is not None
    assert "visible_tokens_per_second_estimate" not in snap


# ---------------------------------------------------------------------------
# snapshot — returns None when no turns exist (line 404)
# ---------------------------------------------------------------------------


def test_snapshot_returns_none_when_store_is_empty() -> None:
    """A fresh store must return None from snapshot()."""
    store = TurnDiagnosticsStore()
    assert store.snapshot() is None


# ---------------------------------------------------------------------------
# get_snapshot_for_request — empty request_id guard (line 412)
# ---------------------------------------------------------------------------


def test_get_snapshot_for_request_returns_none_for_empty_request_id() -> None:
    """An empty (or whitespace-only) request_id must return None."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_snap", session_id="sess", mode="chat")

    assert store.get_snapshot_for_request("") is None
    assert store.get_snapshot_for_request("   ") is None


# ---------------------------------------------------------------------------
# _merge — no-op when turn is absent (line 425)
# ---------------------------------------------------------------------------


def test_merge_noop_for_absent_turn() -> None:
    """_merge must silently ignore an unknown request_id (no insertion)."""
    store = TurnDiagnosticsStore()
    # record_request_metrics delegates to _merge; use it as a proxy
    store.record_request_metrics(request_id="nonexistent", mode="chat")
    assert store.get_snapshot_for_request("nonexistent") is None


# ---------------------------------------------------------------------------
# _get_turn_locked — empty request_id returns None (line 432)
# ---------------------------------------------------------------------------


def test_get_turn_locked_returns_none_for_empty_request_id() -> None:
    """_get_turn_locked is exercised indirectly by record_first_chunk with an empty id."""
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_gtl", session_id="sess", mode="chat")

    # record_first_chunk calls _get_turn_locked internally
    store.record_first_chunk(request_id="")
    store.record_first_chunk(request_id="   ")

    # The valid turn must still be intact
    snap = store.snapshot()
    assert snap is not None
    assert snap["request_id"] == "req_gtl"


# ---------------------------------------------------------------------------
# _prune_locked — latest_request_id tracks oldest-pruned turn (line 451)
# ---------------------------------------------------------------------------


def test_prune_locked_updates_latest_when_latest_is_pruned() -> None:
    """When the oldest turn happens to be the latest, _latest_request_id advances."""
    store = TurnDiagnosticsStore(max_retained_turns=1)

    # Fill with a single turn so it becomes "latest"
    store.begin_turn(request_id="req_prune_a", session_id="sess", mode="chat")
    # Begin a second turn — this evicts req_prune_a (which WAS latest)
    # and sets latest to req_prune_b
    store.begin_turn(request_id="req_prune_b", session_id="sess", mode="chat")

    assert store.get_snapshot_for_request("req_prune_a") is None
    assert store.snapshot()["request_id"] == "req_prune_b"
