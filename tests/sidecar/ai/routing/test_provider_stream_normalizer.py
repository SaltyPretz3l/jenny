"""Unit tests for ``ProviderStreamNormalizer``.

The normalizer is the substrate Phase 4 introduces; these tests exercise the
public surface and the locked classification rules. Each test is independent
and constructs its own normalizer instance — the normalizer is per-stream by
design.

Test coverage map (one assertion per spec rule):

* ``visible_text_delta`` emission for visible-content chunks.
* ``reasoning_delta`` emission for thinking chunks.
* Empty chunks are counted but yield only an ``empty_chunk`` event.
* vLLM-shape ``tool_call_delta`` accumulates argument fragments.
* ``tool_call_completed`` parses successfully.
* ``malformed_tool_arguments`` covers the JSON-decode failure case.
* Reasoning-only completion sets the fail-closed flag at finalize.
* Visible text or a tool call suppresses the reasoning-only flag.
* Counters increment per event.
* ``done`` is always emitted at finalize.
* Sequence numbers are monotonic.
* Module source contains zero provider-branded identifiers
  (``codex_*``, ``openai_*``, ``responses_*``, ``claude_*``, etc.).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from sidecar.ai.routing import provider_stream_normalizer
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_INCOMPLETE,
    FINISH_REASON_PROVIDER_ERROR,
    NORMALIZED_KIND_DONE,
    NORMALIZED_KIND_EMPTY_CHUNK,
    NORMALIZED_KIND_FAILED,
    NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS,
    NORMALIZED_KIND_REASONING_DELTA,
    NORMALIZED_KIND_TOOL_CALL_COMPLETED,
    NORMALIZED_KIND_TOOL_CALL_DELTA,
    NORMALIZED_KIND_VISIBLE_TEXT_DELTA,
    ProviderStreamNormalizer,
    StreamCounters,
    record_counters_to_diagnostics,
)
from sidecar.ai.routing.provider_tool_limits import MAX_TOOL_CALL_ARGUMENT_BYTES
from sidecar.runtime.local_engine.request_context import (
    clear_request_context,
    install_request_context,
)


def _drain_chunk(normalizer: ProviderStreamNormalizer, chunk: dict) -> list:
    return list(normalizer.process_chunk(chunk))


def _drain_finalize(normalizer: ProviderStreamNormalizer) -> list:
    return list(normalizer.finalize())


def test_visible_text_delta_emitted_for_content_chunk() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")
    events = _drain_chunk(
        normalizer,
        {"message": {"role": "assistant", "content": "Hello there"}},
    )
    assert [event.kind for event in events] == [NORMALIZED_KIND_VISIBLE_TEXT_DELTA]
    assert events[0].text == "Hello there"
    assert normalizer.counters.visible_text_delta_count == 1


def test_reasoning_delta_emitted_for_thinking_chunk() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")
    events = _drain_chunk(
        normalizer,
        {"message": {"role": "assistant", "thinking": "Let me think"}},
    )
    assert [event.kind for event in events] == [NORMALIZED_KIND_REASONING_DELTA]
    assert events[0].text == "Let me think"
    assert normalizer.counters.reasoning_delta_count == 1


def test_empty_chunk_counted_and_no_yield() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")
    events = _drain_chunk(
        normalizer,
        {"message": {"role": "assistant", "content": "", "thinking": ""}},
    )
    assert [event.kind for event in events] == [NORMALIZED_KIND_EMPTY_CHUNK]
    assert normalizer.counters.empty_chunk_count == 1
    assert normalizer.counters.visible_text_delta_count == 0


def test_tool_call_delta_accumulates_arguments_across_chunks_vllm() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    first = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_inspect",
                                "function": {"name": "read_file", "arguments": "{\"pat"},
                            }
                        ]
                    }
                }
            ]
        },
    )
    second = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "function": {"arguments": "h\": \"app.py\"}"},
                            }
                        ]
                    }
                }
            ]
        },
    )
    assert all(event.kind == NORMALIZED_KIND_TOOL_CALL_DELTA for event in first)
    assert all(event.kind == NORMALIZED_KIND_TOOL_CALL_DELTA for event in second)
    assert normalizer.counters.tool_call_delta_count == 2
    finalize_events = _drain_finalize(normalizer)
    completed = [e for e in finalize_events if e.kind == NORMALIZED_KIND_TOOL_CALL_COMPLETED]
    assert len(completed) == 1
    assert completed[0].arguments_delta == {"path": "app.py"}
    assert completed[0].tool_call_id == "call_inspect"
    assert completed[0].tool_name == "read_file"


def test_tool_call_completed_emitted_when_arguments_parse_successfully() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_grep",
                                "function": {
                                    "name": "grep",
                                    "arguments": "{\"pattern\": \"TODO\"}",
                                },
                            }
                        ]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        },
    )
    completed = [e for e in events if e.kind == NORMALIZED_KIND_TOOL_CALL_COMPLETED]
    assert len(completed) == 1
    assert completed[0].arguments_delta == {"pattern": "TODO"}
    assert normalizer.counters.tool_call_completed_count == 1


def test_malformed_tool_arguments_emitted_when_arguments_parse_fails() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_bad",
                                "function": {
                                    "name": "read_file",
                                    "arguments": "{\"path\":",
                                },
                            }
                        ]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        },
    )
    malformed = [
        e for e in events if e.kind == NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS
    ]
    assert len(malformed) == 1
    assert malformed[0].tool_call_id == "call_bad"
    assert malformed[0].tool_name == "read_file"
    assert normalizer.counters.malformed_tool_arguments_count == 1
    assert normalizer.counters.tool_call_completed_count == 0


def test_reasoning_only_completion_detected_at_finalize() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    _drain_chunk(
        normalizer,
        {"choices": [{"delta": {"reasoning_content": "thinking..."}}]},
    )
    finalize_events = _drain_finalize(normalizer)
    kinds = [event.kind for event in finalize_events]
    assert NORMALIZED_KIND_FAILED in kinds
    assert kinds[-1] == NORMALIZED_KIND_DONE
    assert normalizer.reasoning_only_detected is True
    assert normalizer.counters.failed_count == 1


def test_vllm_reasoning_delta_emitted_for_bare_reasoning_key() -> None:
    """A vLLM build spelling the field ``reasoning`` must still be read (F13a).

    The vLLM path used to read ONLY ``reasoning_content``, so this chunk
    classified as ``empty_chunk`` and the thinking text was dropped.
    """
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {"choices": [{"delta": {"reasoning": "thinking..."}}]},
    )
    assert [event.kind for event in events] == [NORMALIZED_KIND_REASONING_DELTA]
    assert events[0].text == "thinking..."
    assert normalizer.counters.reasoning_delta_count == 1


def test_vllm_reasoning_only_guard_arms_on_bare_reasoning_key() -> None:
    """The fail-closed guard must not be disarmed by the field spelling (F13a).

    This is the consequential half: the reasoning-only verdict keys off the
    reasoning-delta counter, so an unread spelling left the counter at 0 and
    a reasoning-only completion sailed through as a normal empty answer.
    """
    normalizer = ProviderStreamNormalizer(provider="vllm")
    _drain_chunk(
        normalizer,
        {"choices": [{"delta": {"reasoning": "thinking..."}}]},
    )
    finalize_events = _drain_finalize(normalizer)
    kinds = [event.kind for event in finalize_events]
    assert NORMALIZED_KIND_FAILED in kinds
    assert kinds[-1] == NORMALIZED_KIND_DONE
    assert normalizer.reasoning_only_detected is True


def test_vllm_reasoning_content_wins_over_bare_reasoning() -> None:
    """Precedence keeps every currently-observed vLLM stream byte-identical."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {"delta": {"reasoning_content": "canonical", "reasoning": "fallback"}}
            ]
        },
    )
    assert [event.kind for event in events] == [NORMALIZED_KIND_REASONING_DELTA]
    assert events[0].text == "canonical"
    assert normalizer.counters.reasoning_delta_count == 1


def test_reasoning_only_not_detected_when_visible_text_present() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    _drain_chunk(
        normalizer,
        {"choices": [{"delta": {"reasoning_content": "thinking..."}}]},
    )
    _drain_chunk(
        normalizer,
        {"choices": [{"delta": {"content": "Here is the answer."}}]},
    )
    finalize_events = _drain_finalize(normalizer)
    kinds = [event.kind for event in finalize_events]
    assert NORMALIZED_KIND_FAILED not in kinds
    assert normalizer.reasoning_only_detected is False


def test_reasoning_only_not_detected_when_tool_call_present() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    _drain_chunk(
        normalizer,
        {"choices": [{"delta": {"reasoning_content": "I should call a tool."}}]},
    )
    _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_a",
                                "function": {
                                    "name": "read_file",
                                    "arguments": "{\"path\": \"a.py\"}",
                                },
                            }
                        ]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        },
    )
    finalize_events = _drain_finalize(normalizer)
    kinds = [event.kind for event in finalize_events]
    assert NORMALIZED_KIND_FAILED not in kinds
    assert normalizer.reasoning_only_detected is False


def test_counters_increment_per_event() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")
    _drain_chunk(normalizer, {"message": {"content": "one"}})
    _drain_chunk(normalizer, {"message": {"content": "two"}})
    _drain_chunk(normalizer, {"message": {"thinking": "thought"}})
    _drain_chunk(normalizer, {"message": {"content": "", "thinking": ""}})
    counters = normalizer.counters
    assert counters.visible_text_delta_count == 2
    assert counters.reasoning_delta_count == 1
    assert counters.empty_chunk_count == 1
    assert counters.total_chunk_count == 4
    assert counters.provider == "ollama"


def test_done_emitted_at_finalize() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")
    _drain_chunk(normalizer, {"message": {"content": "hi"}})
    finalize_events = _drain_finalize(normalizer)
    assert finalize_events[-1].kind == NORMALIZED_KIND_DONE
    # Idempotent — a second finalize yields nothing.
    assert _drain_finalize(normalizer) == []


def test_sequence_is_monotonic() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")
    events_a = _drain_chunk(normalizer, {"message": {"content": "a"}})
    events_b = _drain_chunk(normalizer, {"message": {"content": "b"}})
    finalize_events = _drain_finalize(normalizer)
    sequences = [event.sequence for event in events_a + events_b + finalize_events]
    assert sequences == sorted(sequences)
    assert sequences == list(range(len(sequences)))


def test_provider_neutral_field_names_no_codex_or_openai_terms() -> None:
    """The new module must contain zero provider-branded identifiers.

    Forbidden per master plan invariant 2: ``codex_*``, ``openai_*``,
    ``responses_*``, ``claude_*``, ``gemini_*``, ``chatgpt_*``.
    """
    module_file = provider_stream_normalizer.__file__
    assert module_file is not None
    source = Path(module_file).read_text(encoding="utf-8")
    forbidden = (
        r"codex_[a-zA-Z0-9_]+",
        r"openai_[a-zA-Z0-9_]+",
        r"responses_[a-zA-Z0-9_]+",
        r"claude_[a-zA-Z0-9_]+",
        r"gemini_[a-zA-Z0-9_]+",
        r"chatgpt_[a-zA-Z0-9_]+",
    )
    matches: list[tuple[str, str]] = []
    for pattern in forbidden:
        for match in re.finditer(pattern, source):
            matches.append((pattern, match.group(0)))
    assert matches == [], (
        f"provider_stream_normalizer.py contains provider-branded identifiers: "
        f"{matches}"
    )


# ---------------------------------------------------------------------------
# StreamCounters.to_payload (line 146)
# ---------------------------------------------------------------------------


def test_stream_counters_to_payload_returns_all_fields() -> None:
    """StreamCounters.to_payload must include every field with correct values."""
    sc = StreamCounters(
        visible_text_delta_count=3,
        reasoning_delta_count=2,
        tool_call_delta_count=1,
        tool_call_completed_count=1,
        empty_chunk_count=0,
        malformed_tool_arguments_count=1,
        failed_count=0,
        total_chunk_count=8,
        provider="ollama",
    )
    payload = sc.to_payload()
    assert payload["visible_text_delta_count"] == 3
    assert payload["reasoning_delta_count"] == 2
    assert payload["tool_call_delta_count"] == 1
    assert payload["tool_call_completed_count"] == 1
    assert payload["empty_chunk_count"] == 0
    assert payload["malformed_tool_arguments_count"] == 1
    assert payload["failed_count"] == 0
    assert payload["total_chunk_count"] == 8
    assert payload["provider"] == "ollama"


# ---------------------------------------------------------------------------
# record_counters_to_diagnostics (lines 262-273)
# ---------------------------------------------------------------------------


def test_record_counters_to_diagnostics_calls_store() -> None:
    """record_counters_to_diagnostics writes counters to the diagnostics store."""
    recorded: list[dict] = []

    class FakeStore:
        def record_stream_counters(self, *, request_id: str, counters: dict) -> None:
            recorded.append({"request_id": request_id, "counters": counters})

    class FakeEngine:
        _turn_diagnostics_store = FakeStore()

    normalizer = ProviderStreamNormalizer(provider="ollama")
    list(normalizer.process_chunk({"message": {"content": "hello"}}))

    engine = FakeEngine()
    install_request_context(engine, request_id="req-abc-123")
    record_counters_to_diagnostics(engine, normalizer)
    clear_request_context(engine)

    assert len(recorded) == 1
    assert recorded[0]["request_id"] == "req-abc-123"
    assert recorded[0]["counters"]["visible_text_delta_count"] == 1
    assert recorded[0]["counters"]["provider"] == "ollama"


def test_record_counters_to_diagnostics_no_store_is_silent() -> None:
    """record_counters_to_diagnostics is a no-op when store is absent."""

    class FakeEngineNoStore:
        pass

    # Must not raise; nothing recorded.
    engine = FakeEngineNoStore()
    install_request_context(engine, request_id="req-xyz")
    record_counters_to_diagnostics(engine, ProviderStreamNormalizer(provider="vllm"))
    clear_request_context(engine)


def test_record_counters_to_diagnostics_empty_request_id_is_silent() -> None:
    """Skips emit when request_id resolves to empty string."""
    recorded: list[dict] = []

    class FakeStore:
        def record_stream_counters(self, *, request_id: str, counters: dict) -> None:
            recorded.append({"request_id": request_id})

    class FakeEngine:
        _turn_diagnostics_store = FakeStore()

    engine = FakeEngine()
    install_request_context(engine, request_id="")
    record_counters_to_diagnostics(engine, ProviderStreamNormalizer(provider="vllm"))
    clear_request_context(engine)
    assert recorded == []


# ---------------------------------------------------------------------------
# process_chunk with non-Mapping raw_chunk (lines 395,398-400)
# ---------------------------------------------------------------------------


def test_process_chunk_non_mapping_yields_empty_chunk() -> None:
    """A non-Mapping raw_chunk (e.g. a string) still yields exactly one empty_chunk."""
    normalizer = ProviderStreamNormalizer(provider="ollama")
    # Pass a plain string which is not a Mapping
    events = list(normalizer.process_chunk("not-a-dict"))  # type: ignore[arg-type]
    assert len(events) == 1
    assert events[0].kind == NORMALIZED_KIND_EMPTY_CHUNK
    assert normalizer.counters.empty_chunk_count == 1
    assert normalizer.counters.total_chunk_count == 1


def test_process_chunk_after_finalize_yields_nothing() -> None:
    """process_chunk is a no-op after finalize() is called."""
    normalizer = ProviderStreamNormalizer(provider="ollama")
    list(normalizer.finalize())
    events = list(normalizer.process_chunk({"message": {"content": "late"}}))
    assert events == []
    # total_chunk_count must not increase after finalize
    assert normalizer.counters.total_chunk_count == 0


# ---------------------------------------------------------------------------
# Ollama path: non-Mapping message (lines 475-477)
# ---------------------------------------------------------------------------


def test_ollama_non_mapping_message_yields_empty_chunk() -> None:
    """A chunk whose 'message' field is not a Mapping yields empty_chunk."""
    normalizer = ProviderStreamNormalizer(provider="ollama")
    events = _drain_chunk(normalizer, {"message": "just a string"})
    assert len(events) == 1
    assert events[0].kind == NORMALIZED_KIND_EMPTY_CHUNK
    assert normalizer.counters.empty_chunk_count == 1


def test_ollama_missing_message_yields_empty_chunk() -> None:
    """A chunk with no 'message' key at all yields empty_chunk."""
    normalizer = ProviderStreamNormalizer(provider="ollama")
    events = _drain_chunk(normalizer, {"done": True})
    assert len(events) == 1
    assert events[0].kind == NORMALIZED_KIND_EMPTY_CHUNK


# ---------------------------------------------------------------------------
# Ollama: tool_call with non-Mapping function (line 496)
# ---------------------------------------------------------------------------


def test_ollama_tool_call_non_mapping_function_is_skipped() -> None:
    """A tool_call where 'function' is not a Mapping is skipped without crashing."""
    normalizer = ProviderStreamNormalizer(provider="ollama")
    events = _drain_chunk(
        normalizer,
        {
            "message": {
                "content": "",
                "tool_calls": [{"id": "call_bad", "function": "not-a-dict"}],
            }
        },
    )
    # The tool_call is skipped; nothing else emitted → empty_chunk
    assert all(e.kind == NORMALIZED_KIND_EMPTY_CHUNK for e in events)
    assert normalizer.counters.tool_call_completed_count == 0


# ---------------------------------------------------------------------------
# Ollama: malformed tool arguments (lines 515, 520-527)
# ---------------------------------------------------------------------------


def test_ollama_malformed_tool_arguments_emitted() -> None:
    """Ollama tool_call with bad JSON string arguments emits malformed_tool_arguments."""
    normalizer = ProviderStreamNormalizer(provider="ollama")
    events = _drain_chunk(
        normalizer,
        {
            "message": {
                "tool_calls": [
                    {
                        "id": "call_broken",
                        "function": {
                            "name": "do_thing",
                            "arguments": "{bad json",
                        },
                    }
                ]
            }
        },
    )
    malformed = [e for e in events if e.kind == NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS]
    assert len(malformed) == 1
    assert malformed[0].tool_call_id == "call_broken"
    assert malformed[0].tool_name == "do_thing"
    assert malformed[0].arguments_delta == "{bad json"
    assert normalizer.counters.malformed_tool_arguments_count == 1
    assert normalizer.counters.tool_call_completed_count == 0


# ---------------------------------------------------------------------------
# vLLM: empty choices list (lines 552-554)
# ---------------------------------------------------------------------------


def test_vllm_empty_choices_list_yields_empty_chunk() -> None:
    """vLLM chunk with choices=[] yields empty_chunk."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(normalizer, {"choices": []})
    assert len(events) == 1
    assert events[0].kind == NORMALIZED_KIND_EMPTY_CHUNK
    assert normalizer.counters.empty_chunk_count == 1


def test_vllm_non_list_choices_yields_empty_chunk() -> None:
    """vLLM chunk where 'choices' is not a list yields empty_chunk."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(normalizer, {"choices": "bad"})
    assert len(events) == 1
    assert events[0].kind == NORMALIZED_KIND_EMPTY_CHUNK


# ---------------------------------------------------------------------------
# vLLM: no delta with finish_reason flushes pending (lines 566-571)
# ---------------------------------------------------------------------------


def test_vllm_no_delta_with_finish_reason_flushes_pending_tool_calls() -> None:
    """When delta is absent but finish_reason is present, pending tool calls are flushed."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    # First chunk accumulates a tool-call fragment
    _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_flush",
                                "function": {"name": "list_dir", "arguments": '{"p": "/"}'},
                            }
                        ]
                    }
                }
            ]
        },
    )
    # Second chunk has no delta but has finish_reason → should flush
    flush_events = _drain_chunk(
        normalizer,
        {"choices": [{"finish_reason": "tool_calls"}]},
    )
    completed = [e for e in flush_events if e.kind == NORMALIZED_KIND_TOOL_CALL_COMPLETED]
    assert len(completed) == 1
    assert completed[0].tool_name == "list_dir"
    assert completed[0].arguments_delta == {"p": "/"}


def test_vllm_no_delta_no_finish_reason_yields_empty_chunk() -> None:
    """vLLM chunk with non-Mapping delta and no finish_reason yields empty_chunk."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    # choices[0].delta is not a Mapping and finish_reason is absent
    events = _drain_chunk(
        normalizer,
        {"choices": [{"delta": "not-a-dict"}]},
    )
    assert len(events) == 1
    assert events[0].kind == NORMALIZED_KIND_EMPTY_CHUNK
    # The empty_chunk must also be counted — pins the counter increment on
    # this branch, not just the emitted event.
    assert normalizer.counters.empty_chunk_count == 1


# ---------------------------------------------------------------------------
# vLLM: non-Mapping tool_call entry is skipped (line 591)
# ---------------------------------------------------------------------------


def test_vllm_non_mapping_tool_call_entry_is_skipped() -> None:
    """A tool_calls list entry that is not a Mapping is silently ignored."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": ["not-a-dict", None],
                    }
                }
            ]
        },
    )
    # None of the bad entries produce events; no content → empty_chunk
    assert all(e.kind == NORMALIZED_KIND_EMPTY_CHUNK for e in events)
    assert normalizer.counters.tool_call_delta_count == 0


# ---------------------------------------------------------------------------
# vLLM: empty_chunk when no content and no finish_reason (lines 599-600)
# ---------------------------------------------------------------------------


def test_vllm_chunk_with_no_content_no_finish_reason_yields_empty_chunk() -> None:
    """vLLM delta with no content/reasoning/tool_calls and no finish_reason → empty_chunk."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {"choices": [{"delta": {"role": "assistant"}}]},
    )
    assert len(events) == 1
    assert events[0].kind == NORMALIZED_KIND_EMPTY_CHUNK


# ---------------------------------------------------------------------------
# vLLM: synthetic call_id when both id and known index are absent (line 626)
# ---------------------------------------------------------------------------


def test_vllm_synthetic_call_id_no_id_no_prior_index() -> None:
    """When tool_call has no 'id' and no known index, a synthetic call_id is generated."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 99,
                                # no 'id' — first time we see index 99
                                "function": {"name": "mystery_fn", "arguments": '{"x":1}'},
                            }
                        ]
                    }
                }
            ]
        },
    )
    delta_events = [e for e in events if e.kind == NORMALIZED_KIND_TOOL_CALL_DELTA]
    assert len(delta_events) == 1
    # Synthetic ids are generation ordinals, independent of hostile/sparse indexes.
    assert delta_events[0].tool_call_id == "call_1"
    assert delta_events[0].tool_name == "mystery_fn"


def test_vllm_index_none_produces_ordinal_synthetic_id() -> None:
    """When index is absent, a deterministic generation ordinal is assigned."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                # no 'id', no 'index'
                                "function": {"name": "fn_noindex", "arguments": '{"y":2}'},
                            }
                        ]
                    }
                }
            ]
        },
    )
    delta_events = [e for e in events if e.kind == NORMALIZED_KIND_TOOL_CALL_DELTA]
    assert len(delta_events) == 1
    assert delta_events[0].tool_call_id == "call_1"


# ---------------------------------------------------------------------------
# vLLM: non-Mapping function field in tool_call (line 631)
# ---------------------------------------------------------------------------


def test_vllm_non_mapping_function_field_is_treated_as_empty() -> None:
    """A tool_call where function is not a Mapping is treated as empty function."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_nofn",
                                "function": "bad_function_value",
                            }
                        ]
                    }
                }
            ]
        },
    )
    # No argument fragment → no tool_call_delta emitted
    delta_events = [e for e in events if e.kind == NORMALIZED_KIND_TOOL_CALL_DELTA]
    assert len(delta_events) == 0


# ---------------------------------------------------------------------------
# vLLM: already-finalized accumulator is skipped (line 640)
# ---------------------------------------------------------------------------


def test_vllm_finalized_accumulator_ignores_subsequent_fragments() -> None:
    """After a tool call accumulator is finalized, further fragments for it are ignored."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    # First chunk: valid complete fragment (dict arguments triggers immediate finalize)
    first_events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_once",
                                "function": {
                                    "name": "read_file",
                                    "arguments": {"path": "a.py"},
                                },
                            }
                        ]
                    }
                }
            ]
        },
    )
    # Should have completed immediately since arguments is already a dict
    completed_first = [e for e in first_events if e.kind == NORMALIZED_KIND_TOOL_CALL_COMPLETED]
    assert len(completed_first) == 1
    assert completed_first[0].arguments_delta == {"path": "a.py"}

    # Second chunk: another fragment for the same call_id (index 0 → call_once)
    second_events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "function": {"arguments": '{"extra": true}'},
                            }
                        ]
                    }
                }
            ]
        },
    )
    # The accumulator is finalized — nothing more should be emitted for it
    completed_second = [e for e in second_events if e.kind == NORMALIZED_KIND_TOOL_CALL_COMPLETED]
    delta_second = [e for e in second_events if e.kind == NORMALIZED_KIND_TOOL_CALL_DELTA]
    assert completed_second == []
    assert delta_second == []


# ---------------------------------------------------------------------------
# vLLM: dict arguments triggers immediate tool_call_completed (lines 646-659)
# ---------------------------------------------------------------------------


def test_vllm_dict_arguments_triggers_immediate_completed() -> None:
    """When vLLM sends arguments as a dict, tool_call_completed is emitted immediately."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_dict",
                                "function": {
                                    "name": "create_file",
                                    "arguments": {"filename": "test.py", "mode": "w"},
                                },
                            }
                        ]
                    }
                }
            ]
        },
    )
    completed = [e for e in events if e.kind == NORMALIZED_KIND_TOOL_CALL_COMPLETED]
    assert len(completed) == 1
    assert completed[0].tool_call_id == "call_dict"
    assert completed[0].tool_name == "create_file"
    assert completed[0].arguments_delta == {"filename": "test.py", "mode": "w"}
    assert normalizer.counters.tool_call_completed_count == 1
    # No delta events should be emitted since we completed immediately
    assert normalizer.counters.tool_call_delta_count == 0


# ---------------------------------------------------------------------------
# _finalize_pending_tool_calls: skip already-finalized (line 680)
# ---------------------------------------------------------------------------


def test_finalize_skips_already_finalized_accumulators() -> None:
    """finalize() does not re-emit events for already-finalized tool calls."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    # Build a complete tool call with finish_reason (finalizes the accumulator)
    _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_pre",
                                "function": {"name": "fn", "arguments": '{"ok": true}'},
                            }
                        ]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        },
    )
    # At this point the accumulator should have been finalized by finish_reason flush
    finalize_events = _drain_finalize(normalizer)
    # Only done (and maybe failed) should appear; no second tool_call_completed
    completed = [e for e in finalize_events if e.kind == NORMALIZED_KIND_TOOL_CALL_COMPLETED]
    assert completed == []
    assert finalize_events[-1].kind == NORMALIZED_KIND_DONE


# ---------------------------------------------------------------------------
# _complete_or_mark_malformed: empty buffer → {} (lines 695-702)
# ---------------------------------------------------------------------------


def test_finalize_empty_buffer_accumulator_yields_completed_with_empty_dict() -> None:
    """An accumulator with no argument fragments finalizes as tool_call_completed with {}."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    # Emit a tool_call with only a name and no arguments string
    _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_noargs",
                                "function": {
                                    "name": "no_args_fn",
                                    # no 'arguments' field → empty buffer
                                },
                            }
                        ]
                    }
                }
            ]
        },
    )
    finalize_events = _drain_finalize(normalizer)
    completed = [e for e in finalize_events if e.kind == NORMALIZED_KIND_TOOL_CALL_COMPLETED]
    assert len(completed) == 1
    assert completed[0].tool_call_id == "call_noargs"
    assert completed[0].tool_name == "no_args_fn"
    assert completed[0].arguments_delta == {}
    assert normalizer.counters.tool_call_completed_count == 1


# ---------------------------------------------------------------------------
# feed() and finalize_for_counters() non-yielding paths
# ---------------------------------------------------------------------------


def test_feed_drives_normalizer_without_yielding() -> None:
    """feed() accumulates counters but does not return events."""
    normalizer = ProviderStreamNormalizer(provider="ollama")
    result = normalizer.feed({"message": {"content": "silent"}})
    assert result is None
    assert normalizer.counters.visible_text_delta_count == 1
    assert normalizer.counters.total_chunk_count == 1


def test_finalize_for_counters_drives_finalize_without_yielding() -> None:
    """finalize_for_counters() resolves the stream state but does not return events."""
    normalizer = ProviderStreamNormalizer(provider="ollama")
    normalizer.feed({"message": {"content": "x"}})
    result = normalizer.finalize_for_counters()
    assert result is None
    # After finalize, a second call to process_chunk must be no-op
    events = list(normalizer.process_chunk({"message": {"content": "late"}}))
    assert events == []


# ---------------------------------------------------------------------------
# Unknown provider falls through to Ollama path
# ---------------------------------------------------------------------------


def test_unknown_provider_falls_through_to_ollama_path() -> None:
    """Chunks from an unknown provider are classified via the Ollama envelope."""
    normalizer = ProviderStreamNormalizer(provider="unknown_provider")
    events = _drain_chunk(
        normalizer,
        {"message": {"content": "from unknown provider"}},
    )
    assert len(events) == 1
    assert events[0].kind == NORMALIZED_KIND_VISIBLE_TEXT_DELTA
    assert events[0].text == "from unknown provider"


# ---------------------------------------------------------------------------
# vLLM: index-based call_id reuse across fragments (no 'id' on follow-up)
# ---------------------------------------------------------------------------


def test_vllm_index_routes_fragments_to_same_accumulator() -> None:
    """Fragments with same index but no 'id' on follow-up reuse the first call_id."""
    normalizer = ProviderStreamNormalizer(provider="vllm")
    # First fragment establishes call_id for index 0
    _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_real",
                                "function": {"name": "grep", "arguments": '{"q":'},
                            }
                        ]
                    }
                }
            ]
        },
    )
    # Second fragment: same index, no id
    second_events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "function": {"arguments": '"hello"}'},
                            }
                        ]
                    }
                }
            ]
        },
    )
    delta_second = [e for e in second_events if e.kind == NORMALIZED_KIND_TOOL_CALL_DELTA]
    assert len(delta_second) == 1
    # Should use the same call_id registered for index 0
    assert delta_second[0].tool_call_id == "call_real"

    # On finalize, the combined buffer should parse correctly
    finalize_events = _drain_finalize(normalizer)
    completed = [e for e in finalize_events if e.kind == NORMALIZED_KIND_TOOL_CALL_COMPLETED]
    assert len(completed) == 1
    assert completed[0].tool_call_id == "call_real"
    assert completed[0].tool_name == "grep"
    assert completed[0].arguments_delta == {"q": "hello"}


def test_provider_calls_with_anonymous_duplicate_and_unsafe_ids_remain_distinct() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")
    events = _drain_chunk(
        normalizer,
        {
            "message": {
                "tool_calls": [
                    {"id": "", "function": {"name": "read_file", "arguments": {}}},
                    {"id": "dup", "function": {"name": "read_file", "arguments": {}}},
                    {"id": "dup", "function": {"name": "read_file", "arguments": {}}},
                    {"id": "bad\nvalue", "function": {"name": "read_file", "arguments": {}}},
                    {"id": "x" * 1000, "function": {"name": "read_file", "arguments": {}}},
                ]
            }
        },
    )
    completed_ids = [
        event.tool_call_id
        for event in events
        if event.kind == NORMALIZED_KIND_TOOL_CALL_COMPLETED
    ]
    assert completed_ids == ["call_1", "dup", "call_3", "call_4", "call_5"]
    assert len(set(completed_ids)) == len(completed_ids)
    assert all("\n" not in str(call_id) and len(str(call_id)) <= 128 for call_id in completed_ids)


def test_two_idless_indexless_provider_calls_do_not_merge() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"function": {"name": "first", "arguments": {"x": 1}}},
                            {"function": {"name": "second", "arguments": {"y": 2}}},
                        ]
                    }
                }
            ]
        },
    )
    completed = [
        event for event in events if event.kind == NORMALIZED_KIND_TOOL_CALL_COMPLETED
    ]
    assert [(event.tool_call_id, event.tool_name) for event in completed] == [
        ("call_1", "first"),
        ("call_2", "second"),
    ]


def test_provider_argument_per_call_limit_fails_closed() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "oversized",
                                "function": {
                                    "name": "read_file",
                                    "arguments": "x" * (MAX_TOOL_CALL_ARGUMENT_BYTES + 1),
                                },
                            }
                        ]
                    }
                }
            ]
        },
    )
    assert [event.kind for event in events] == [NORMALIZED_KIND_FAILED]
    assert events[0].text.startswith("CMP-LOOP-0002:")
    assert all(
        event.kind != NORMALIZED_KIND_TOOL_CALL_COMPLETED
        for event in _drain_finalize(normalizer)
    )


def test_provider_argument_aggregate_limit_fails_closed() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    all_events = []
    for index in range(5):
        all_events.extend(
            _drain_chunk(
                normalizer,
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": index,
                                        "id": f"call-{index}",
                                        "function": {
                                            "name": "read_file",
                                            "arguments": "x" * MAX_TOOL_CALL_ARGUMENT_BYTES,
                                        },
                                    }
                                ]
                            }
                        }
                    ]
                },
            )
        )
    assert sum(event.kind == NORMALIZED_KIND_FAILED for event in all_events) == 1
    assert all(
        event.kind != NORMALIZED_KIND_TOOL_CALL_COMPLETED
        for event in _drain_finalize(normalizer)
    )


def test_provider_tool_call_count_limit_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(provider_stream_normalizer, "MAX_PROVIDER_TOOL_CALLS", 2)
    normalizer = ProviderStreamNormalizer(provider="ollama")
    events = _drain_chunk(
        normalizer,
        {
            "message": {
                "tool_calls": [
                    {"function": {"name": "one", "arguments": {}}},
                    {"function": {"name": "two", "arguments": {}}},
                    {"function": {"name": "three", "arguments": {}}},
                ]
            }
        },
    )
    assert sum(event.kind == NORMALIZED_KIND_FAILED for event in events) == 1
# ---------------------------------------------------------------------------
# F10 -- terminal evidence and in-band error frames
#
# Both engines used to break out of their read loop on ONE signal (Ollama's
# ``done`` chunk, vLLM's ``[DONE]`` sentinel) and then synthesize
# ``finish_reason="stop"`` UNCONDITIONALLY afterwards. A stream that EOF'd with
# no terminal chunk produced the IDENTICAL success event, so a truncated answer
# was indistinguishable from a complete one, and an in-band error frame was not
# classified at all. The normalizer now records what the provider actually said.
# ---------------------------------------------------------------------------


def test_ollama_stream_without_a_done_chunk_records_no_terminal_evidence() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")
    _drain_chunk(normalizer, {"message": {"content": "half an ans"}})

    assert normalizer.terminal_finish_reason == ""
    assert normalizer.saw_terminal_evidence is False


def test_ollama_done_chunk_records_its_done_reason() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")
    _drain_chunk(normalizer, {"message": {"content": "hi"}})
    _drain_chunk(normalizer, {"message": {}, "done": True, "done_reason": "length"})

    assert normalizer.terminal_finish_reason == "length"
    assert normalizer.saw_terminal_evidence is True


def test_ollama_done_chunk_without_done_reason_defaults_to_stop() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")
    _drain_chunk(normalizer, {"message": {}, "done": True})

    assert normalizer.terminal_finish_reason == "stop"


def test_ollama_done_chunk_without_a_message_envelope_still_counts_as_terminal() -> None:
    # A done frame may omit ``message`` entirely; the shape guard must not eat
    # the terminal evidence.
    normalizer = ProviderStreamNormalizer(provider="ollama")
    _drain_chunk(normalizer, {"done": True, "done_reason": "stop"})

    assert normalizer.saw_terminal_evidence is True


def test_ollama_inband_error_frame_is_classified_as_failed() -> None:
    normalizer = ProviderStreamNormalizer(provider="ollama")
    events = _drain_chunk(normalizer, {"error": "model runner exited unexpectedly"})

    assert [event.kind for event in events] == [NORMALIZED_KIND_FAILED]
    assert "model runner exited" in events[0].text
    assert normalizer.terminal_finish_reason == FINISH_REASON_PROVIDER_ERROR
    assert normalizer.counters.failed_count == 1


def test_ollama_inband_error_suppresses_the_reasoning_only_verdict() -> None:
    # An errored stream is not a reasoning-only completion; the more accurate
    # provider-error verdict must win.
    normalizer = ProviderStreamNormalizer(provider="ollama")
    _drain_chunk(normalizer, {"message": {"thinking": "pondering"}})
    _drain_chunk(normalizer, {"error": "runner crashed"})

    _drain_finalize(normalizer)

    assert normalizer.reasoning_only_detected is False


def test_vllm_finish_reason_is_recorded_as_terminal_evidence() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    _drain_chunk(
        normalizer,
        {"choices": [{"delta": {"content": "done"}, "finish_reason": "stop"}]},
    )

    assert normalizer.terminal_finish_reason == "stop"
    assert normalizer.saw_terminal_evidence is True


def test_vllm_stream_without_finish_reason_records_no_terminal_evidence() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    _drain_chunk(normalizer, {"choices": [{"delta": {"content": "half"}}]})

    assert normalizer.saw_terminal_evidence is False


def test_vllm_error_object_frame_is_classified_as_failed() -> None:
    normalizer = ProviderStreamNormalizer(provider="vllm")
    events = _drain_chunk(
        normalizer,
        {"object": "error", "message": "engine died", "type": "internal_error"},
    )

    assert [event.kind for event in events] == [NORMALIZED_KIND_FAILED]
    assert "engine died" in events[0].text
    assert normalizer.terminal_finish_reason == FINISH_REASON_PROVIDER_ERROR


def test_duplicate_terminal_chunks_keep_the_latest_provider_verdict() -> None:
    # A provider that repeats its terminal frame must not flip the stream back
    # to "no evidence"; the last verdict stands and the stream stays terminal.
    normalizer = ProviderStreamNormalizer(provider="ollama")
    _drain_chunk(normalizer, {"message": {}, "done": True, "done_reason": "stop"})
    _drain_chunk(normalizer, {"message": {}, "done": True, "done_reason": "stop"})

    assert normalizer.terminal_finish_reason == "stop"


def test_new_finish_reason_constants_are_exported() -> None:
    # __all__ holds NAMES, not values -- assert the export name is listed and
    # the constant's wire value separately.
    assert "FINISH_REASON_INCOMPLETE" in provider_stream_normalizer.__all__
    assert "FINISH_REASON_PROVIDER_ERROR" in provider_stream_normalizer.__all__
    assert FINISH_REASON_INCOMPLETE == "incomplete"
