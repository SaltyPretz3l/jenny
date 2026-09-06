"""Tests for two-tier context compaction."""

from __future__ import annotations

import pytest

from sidecar.ai.context.compaction import (
    COMPACTED_SUMMARY_HEADING,
    CompactionCircuitBreaker,
    CompactionCircuitBreakerRegistry,
    compact_context,
    is_compaction_summary_content,
    microcompact,
    parse_compaction_response,
)
from sidecar.ai.context.compaction_prompts import build_full_compaction_messages
from sidecar.ai.context.compaction_window import (
    MID_TURN_NUDGE,
    MID_TURN_NUDGE_PREFIX,
    MID_TURN_TASK_STUB,
    summary_input_limit,
)
from sidecar.ai.context.token_budget import (
    CharEstimationBackend,
    TokenBudget,
    estimate_messages_tokens,
)

# -- helpers -----------------------------------------------------------------


def _big_tool_messages(n: int, content_len: int = 2000) -> list[dict[str, object]]:
    """Build a message list with n tool-result messages with large content."""
    messages: list[dict[str, object]] = []
    messages.append({"role": "user", "content": "Do something."})
    for i in range(n):
        messages.append(
            {
                "role": "assistant",
                "content": f"Calling tool_{i}.",
                "tool_calls": [{"name": f"tool_{i}", "arguments": {}}],
            }
        )
        messages.append(
            {
                "role": "tool",
                "tool_call_id": f"call_{i}",
                "name": f"tool_{i}",
                "content": "x" * content_len,
            }
        )
    messages.append({"role": "assistant", "content": "Done."})
    return messages


def _two_round_big_tool_messages(
    n: int, content_len: int = 2000
) -> list[dict[str, object]]:
    """Build an older oversized round plus the current user round."""
    return [*_big_tool_messages(n, content_len), {"role": "user", "content": "Continue."}]


def _mid_turn_big_tool_messages(
    n: int,
    *,
    task: str = "Inspect the workspace and finish the task.",
    content_len: int = 800,
) -> list[dict[str, object]]:
    messages: list[dict[str, object]] = [{"role": "user", "content": task}]
    for index in range(1, n + 1):
        call_id = f"call_{index}"
        messages.extend(
            [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": call_id,
                            "name": "read_file",
                            "arguments": {"path": f"file_{index}.txt"},
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": "x" * content_len,
                },
            ]
        )
    return messages


def _small_budget() -> TokenBudget:
    """Budget where typical tool messages will exceed auto_compact.

    effective_context = 2000 - 200 - 200 = 1600
    auto_compact_threshold (90%) = 1440
    error_threshold (95%) = 1520
    10 tool messages at 500 chars ≈ 1382 tokens ... use content_len=800
    to reliably push over the threshold.
    """
    return TokenBudget(
        context_window=2_000,
        max_output_tokens=200,
        reserved_for_summary=200,
    )


# -- microcompact ------------------------------------------------------------


class TestMicrocompact:
    def test_strips_old_tool_results(self) -> None:
        messages = _big_tool_messages(10, content_len=800)
        budget = _small_budget()
        result = microcompact(messages, budget)
        assert result.messages_stripped > 0
        # Oldest tool messages should have placeholder content
        for msg in result.messages[:6]:
            if str(msg.get("role", "")).lower() == "tool":
                assert msg["content"] == "[tool output omitted for context space]"

    def test_preserves_recent_messages(self) -> None:
        messages = _big_tool_messages(10, content_len=800)
        budget = _small_budget()
        result = microcompact(messages, budget)
        # The last 6 messages should be unchanged
        for i in range(-6, 0):
            original = messages[i]
            compacted = result.messages[i]
            assert original.get("content") == compacted.get("content")

    def test_tokens_freed_positive(self) -> None:
        messages = _big_tool_messages(10, content_len=800)
        budget = _small_budget()
        result = microcompact(messages, budget)
        assert result.tokens_freed > 0

    def test_noop_when_under_threshold(self) -> None:
        messages = [{"role": "user", "content": "hello"}]
        budget = TokenBudget(context_window=200_000, max_output_tokens=16_384)
        result = microcompact(messages, budget)
        assert result.messages_stripped == 0
        assert result.tokens_freed == 0

    def test_strips_verbose_assistant_content(self) -> None:
        messages = [
            {"role": "user", "content": "test"},
            {
                "role": "assistant",
                "content": "y" * 200,
                "tool_calls": [{"name": "read_file", "arguments": {}}],
            },
            {"role": "tool", "content": "z" * 500},
            {"role": "user", "content": "next"},
            {"role": "assistant", "content": "final answer"},
        ]
        budget = _small_budget()
        result = microcompact(messages, budget)
        # If the verbose assistant message was stripped, the placeholder must
        # be bracketed metadata naming the invoked tool(s) -- never a
        # first-person "Calling tool(s): ..." sentence a local model could
        # imitate as real narration.
        stripped_assistant = [
            m
            for m in result.messages
            if str(m.get("role", "")).lower() == "assistant"
            and "[compacted: invoked tools" in str(m.get("content", ""))
        ]
        for m in stripped_assistant:
            content = str(m.get("content", ""))
            assert content == "[compacted: invoked tools read_file]"
            assert "calling" not in content.lower()

    def test_strips_matching_tool_call_arguments_with_old_tool_result(self) -> None:
        messages = [
            {"role": "user", "content": "inspect repo"},
            {
                "role": "assistant",
                "content": "I will inspect a file.",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "name": "read_file",
                        "arguments": {"path": "C:/dev/jenny/secrets.txt"},
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "name": "read_file",
                "content": "secret-ish content " * 500,
            },
            *[{"role": "user", "content": f"tail {index}"} for index in range(8)],
        ]

        result = microcompact(messages, _small_budget())

        tool_call = result.messages[1]["tool_calls"][0]
        assert tool_call["arguments"] == {"compacted": True}
        assert result.messages[2]["content"] == "[tool output omitted for context space]"

    def test_verbose_assistant_tool_call_content_gets_bracketed_placeholder(self) -> None:
        """Deterministically force the assistant-content strip branch and

        assert the exact non-imitable, bracketed placeholder text (see
        BUG: planted first-person "Calling tool(s): ..." narration that
        local models imitated as visible response text).
        """
        messages = [
            {"role": "user", "content": "inspect repo"},
            {
                "role": "assistant",
                "content": "I will inspect several files to answer this. " * 5,
                "tool_calls": [
                    {"id": "call_1", "name": "read_file", "arguments": {}},
                    {"id": "call_2", "name": "grep_search", "arguments": {}},
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "name": "read_file",
                "content": "file body content " * 500,
            },
            *[{"role": "user", "content": f"tail {index}"} for index in range(8)],
        ]

        result = microcompact(messages, _small_budget())

        assert result.messages[1]["content"] == "[compacted: invoked tools read_file, grep_search]"
        assert "Calling tool" not in result.messages[1]["content"]

    def test_stripping_tool_call_arguments_does_not_mutate_input_function(self) -> None:
        messages = [
            {"role": "user", "content": "inspect repo"},
            {
                "role": "assistant",
                "content": "I will inspect a file.",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": '{"path":"C:/dev/jenny/secrets.txt"}',
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "name": "read_file",
                "content": "secret-ish content " * 500,
            },
            *[{"role": "user", "content": f"tail {index}"} for index in range(8)],
        ]

        result = microcompact(messages, _small_budget())

        tool_call = result.messages[1]["tool_calls"][0]
        assert tool_call["function"]["arguments"] == {"compacted": True}
        original_tool_call = messages[1]["tool_calls"][0]
        assert original_tool_call["function"]["arguments"] == (
            '{"path":"C:/dev/jenny/secrets.txt"}'
        )


# -- CompactionCircuitBreaker ------------------------------------------------


class TestCompactionCircuitBreaker:
    def test_initially_closed(self) -> None:
        cb = CompactionCircuitBreaker()
        assert not cb.is_open()

    def test_opens_after_max_failures(self) -> None:
        cb = CompactionCircuitBreaker(max_failures=3)
        cb.record_failure()
        cb.record_failure()
        assert not cb.is_open()
        cb.record_failure()
        assert cb.is_open()

    def test_resets_on_success(self) -> None:
        cb = CompactionCircuitBreaker(max_failures=3)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        assert not cb.is_open()
        assert cb.failure_count == 0

    def test_custom_max_failures(self) -> None:
        cb = CompactionCircuitBreaker(max_failures=1)
        cb.record_failure()
        assert cb.is_open()

    def test_open_circuit_closes_after_reset_window(self) -> None:
        clock_value = {"now": 100.0}

        def _clock() -> float:
            return clock_value["now"]

        cb = CompactionCircuitBreaker(max_failures=1, reset_after_seconds=30.0, clock=_clock)
        cb.record_failure()
        assert cb.is_open()

        clock_value["now"] = 131.0

        assert not cb.is_open()


def test_compaction_breaker_registry_accumulates_caps_and_expires() -> None:
    now = {"value": 100.0}
    registry = CompactionCircuitBreakerRegistry(
        max_entries=64,
        expiry_seconds=3600.0,
        clock=lambda: now["value"],
    )
    breaker = registry.for_key("session-a")
    for _ in range(3):
        breaker.record_failure()

    assert registry.for_key("session-a") is breaker
    assert registry.for_key("session-a").is_open()

    for index in range(64):
        registry.for_key(f"session-{index}")
    assert registry.size == 64

    now["value"] += 3601.0
    replacement = registry.for_key("session-a")
    assert replacement is not breaker
    assert not replacement.is_open()
    assert registry.size == 1


# -- parse_compaction_response -----------------------------------------------


class TestParseCompactionResponse:
    def test_valid_response(self) -> None:
        response = (
            "<analysis>\nThis conversation is about X.\n</analysis>\n\n"
            "<summary>\n## Intent Summary\nUser wants to do X.\n</summary>"
        )
        summary = parse_compaction_response(response)
        assert "Intent Summary" in summary

    def test_missing_analysis_is_accepted(self) -> None:
        # 2026-09-01: Deliberately reverse the pinned analysis-tag requirement.
        response = "<summary>\nSome summary.\n</summary>"
        assert parse_compaction_response(response) == "Some summary."

    def test_missing_summary_raises(self) -> None:
        response = "<analysis>\nSome analysis.\n</analysis>"
        with pytest.raises(ValueError, match="Missing <summary>"):
            parse_compaction_response(response)

    def test_empty_summary_raises(self) -> None:
        response = "<analysis>\nAnalysis.\n</analysis>\n<summary>\n  \n</summary>"
        with pytest.raises(ValueError, match="Empty <summary>"):
            parse_compaction_response(response)

    def test_empty_response_raises(self) -> None:
        with pytest.raises(ValueError, match="Empty compaction"):
            parse_compaction_response("")

    def test_untagged_response_with_three_section_headings_is_accepted(self) -> None:
        from sidecar.ai.context.compaction_prompts import (
            COMPACTION_SUMMARY_SECTION_HEADINGS,
        )

        response = "\n".join(
            f"{heading}\nSection content."
            for heading in COMPACTION_SUMMARY_SECTION_HEADINGS[:3]
        )

        assert parse_compaction_response(f"\n{response}\n") == response

    def test_untagged_response_with_two_section_headings_still_raises(self) -> None:
        from sidecar.ai.context.compaction_prompts import (
            COMPACTION_SUMMARY_SECTION_HEADINGS,
        )

        response = "\n".join(COMPACTION_SUMMARY_SECTION_HEADINGS[:2])

        with pytest.raises(ValueError, match="Missing <summary>"):
            parse_compaction_response(response)

    def test_untagged_acceptance_strips_the_analysis_block(self) -> None:
        from sidecar.ai.context.compaction_prompts import (
            COMPACTION_SUMMARY_SECTION_HEADINGS,
        )

        response = "<analysis>SECRET</analysis>\n" + "\n".join(
            COMPACTION_SUMMARY_SECTION_HEADINGS[:3]
        )
        summary = parse_compaction_response(response)

        assert all(
            heading in summary for heading in COMPACTION_SUMMARY_SECTION_HEADINGS[:3]
        )
        assert "SECRET" not in summary

    def test_untagged_acceptance_strips_an_unterminated_analysis_block(self) -> None:
        from sidecar.ai.context.compaction_prompts import (
            COMPACTION_SUMMARY_SECTION_HEADINGS,
        )

        headings = "\n".join(COMPACTION_SUMMARY_SECTION_HEADINGS[:3])
        summary = parse_compaction_response(headings + "\n<analysis>SECRET truncated")

        assert "SECRET" not in summary
        assert all(
            heading in summary for heading in COMPACTION_SUMMARY_SECTION_HEADINGS[:3]
        )
        with pytest.raises(ValueError, match="Missing <summary>"):
            parse_compaction_response("<analysis>SECRET\n" + headings)

    def test_empty_untagged_response_still_raises(self) -> None:
        with pytest.raises(ValueError, match="Empty compaction response"):
            parse_compaction_response("  \n\t")


# -- compact_context (orchestrator) ------------------------------------------


_CANNED_RESPONSE = (
    "<analysis>\nThe user discussed testing.\n</analysis>\n\n"
    "<summary>\n"
    "## 1. Intent Summary\nUser is building tests.\n"
    "## 2. Key Technical Concepts\nPytest, mocking.\n"
    "## 3. Relevant Files & Code\ntest_foo.py\n"
    "## 4. Errors & Debugging\n(none)\n"
    "## 5. Problem-Solving Approaches\nInline stubs.\n"
    '## 6. User Messages\n"Write tests for the budget module."\n'
    "## 7. Pending Tasks\nFinish compaction tests.\n"
    "## 8. Current Work\nWriting compaction.py.\n"
    '## 9. Next Step\n"Run the full test suite."\n'
    "</summary>"
)


class TestCompactContext:
    def test_returns_unchanged_when_under_threshold(self) -> None:
        messages = [{"role": "user", "content": "hello"}]
        budget = TokenBudget(context_window=200_000, max_output_tokens=16_384)
        result = compact_context(messages, budget)
        assert result.strategy == "none"
        assert not result.compacted
        assert result.error is None
        assert result.summary_status == "not_created"

    def test_microcompact_when_no_generate_fn(self) -> None:
        messages = _big_tool_messages(10, content_len=800)
        budget = _small_budget()
        result = compact_context(messages, budget, generate_fn=None)
        assert result.strategy == "micro"
        assert result.compacted
        assert result.tokens_after <= result.tokens_before
        assert result.summary_status == "not_applicable"
        assert result.summary_failure_code == "summary_generator_unavailable"

    def test_mid_turn_shape_is_not_applicable_without_calling_generator(self) -> None:
        messages = [
            {"role": "system", "content": "Primary instructions."},
            {"role": "user", "content": "Inspect the workspace."},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "call_1", "name": "read_file", "arguments": {}}
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "x" * 8_000,
            },
        ]
        generate_calls = 0

        def _must_not_run(_msgs: list[dict[str, str]]) -> str:
            nonlocal generate_calls
            generate_calls += 1
            return _CANNED_RESPONSE

        result = compact_context(
            messages,
            _small_budget(),
            generate_fn=_must_not_run,
            circuit_breaker=CompactionCircuitBreaker(),
        )

        assert result.strategy == "micro"
        assert result.tokens_after == result.tokens_before
        assert result.summary_status == "not_applicable"
        assert result.summary_failure_code == "summary_prefix_unavailable"
        assert generate_calls == 0

    def test_history_inside_preserve_tail_cannot_free_tokens(self) -> None:
        messages = [
            {"role": "user", "content": "Inspect the workspace."},
            {
                "role": "assistant",
                "content": "Calling read_file.",
                "tool_calls": [
                    {"id": "call_1", "name": "read_file", "arguments": {}}
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "x" * 8_000,
            },
        ]

        result = compact_context(messages, _small_budget(), generate_fn=None)

        assert result.strategy == "micro"
        assert result.tokens_after == result.tokens_before
        assert result.messages == messages

    def test_falls_back_to_micro_when_circuit_open(self) -> None:
        messages = _big_tool_messages(10, content_len=800)
        budget = _small_budget()
        breaker = CompactionCircuitBreaker(max_failures=1)
        breaker.record_failure()
        assert breaker.is_open()

        def _should_not_be_called(_msgs: list[dict[str, str]]) -> str:
            raise AssertionError("generate_fn called with open circuit")

        result = compact_context(
            messages,
            budget,
            generate_fn=_should_not_be_called,
            circuit_breaker=breaker,
        )
        assert result.strategy == "micro"
        assert breaker.is_open()
        assert result.summary_status == "not_applicable"
        assert result.summary_failure_code == "summary_circuit_open"

    def test_full_compaction_with_stub_generate_fn(self) -> None:
        messages = _two_round_big_tool_messages(10, content_len=800)
        budget = _small_budget()

        def stub_generate(_msgs: list[dict[str, str]]) -> str:
            return _CANNED_RESPONSE

        result = compact_context(
            messages,
            budget,
            generate_fn=stub_generate,
            circuit_breaker=CompactionCircuitBreaker(),
        )
        assert result.strategy == "full"
        assert result.compacted
        assert result.tokens_after < result.tokens_before
        # Should contain the compacted system message + last user message
        roles = [str(m.get("role", "")) for m in result.messages]
        assert "system" in roles
        assert "user" in roles

    def test_oversized_summary_source_is_admitted_before_the_summariser_call(
        self,
    ) -> None:
        backend = CharEstimationBackend()
        budget = TokenBudget(
            context_window=4_000,
            max_output_tokens=400,
            reserved_for_summary=400,
        )
        messages = _two_round_big_tool_messages(4, content_len=4_000)
        captured: list[list[dict[str, str]]] = []

        result = compact_context(
            messages,
            budget,
            backend=backend,
            generate_fn=lambda request: captured.append(request) or _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
        )

        prompt_tokens = estimate_messages_tokens(
            build_full_compaction_messages([]), backend
        )
        limit = summary_input_limit(budget, prompt_tokens=prompt_tokens)
        assert result.strategy == "full"
        assert len(captured) == 1
        assert estimate_messages_tokens([captured[0][1]], backend) <= limit
        assert estimate_messages_tokens(messages[:-1], backend) > limit

    def test_summary_input_truncation_is_reported_on_the_result(self) -> None:
        result = compact_context(
            _two_round_big_tool_messages(4, content_len=4_000),
            TokenBudget(
                context_window=4_000,
                max_output_tokens=400,
                reserved_for_summary=400,
            ),
            generate_fn=lambda _messages: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
        )

        assert result.summary_input_truncated is True
        assert result.summary_status == "created"
        assert result.strategy == "full"

    def test_small_summary_source_is_not_reported_as_truncated(self) -> None:
        result = compact_context(
            [
                {"role": "user", "content": "x" * 8_000},
                {"role": "assistant", "content": "Acknowledged."},
                {"role": "user", "content": "Continue."},
            ],
            TokenBudget(context_window=200_000, max_output_tokens=16_384),
            generate_fn=lambda _messages: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
            force=True,
        )

        assert result.strategy == "full"
        assert result.summary_input_truncated is False
        assert result.summary_input_dropped_messages == 0

    def test_full_compaction_provider_payload_contains_primary_system_once(self) -> None:
        from sidecar.ai.routing.engine_messages import engine_messages

        sentinel = "PRIMARY-SYSTEM-SENTINEL-7f91"
        messages = _two_round_big_tool_messages(10, content_len=800)
        result = compact_context(
            messages,
            _small_budget(),
            system_context=sentinel,
            generate_fn=lambda _messages: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
        )

        provider_messages = [
            {"role": "system", "content": sentinel},
            *engine_messages(result.messages, primary_system_text=sentinel),
        ]
        rendered = "\n".join(str(message.get("content") or "") for message in provider_messages)

        assert result.strategy == "full"
        assert rendered.count(sentinel) == 1
        assert "## Compacted Conversation Summary" in rendered

    def test_falls_back_to_micro_on_generate_failure(self) -> None:
        messages = _two_round_big_tool_messages(10, content_len=800)
        budget = _small_budget()

        def failing_generate(_msgs: list[dict[str, str]]) -> str:
            raise RuntimeError("LLM unavailable")

        breaker = CompactionCircuitBreaker()
        result = compact_context(
            messages,
            budget,
            generate_fn=failing_generate,
            circuit_breaker=breaker,
        )
        assert result.strategy == "micro"
        assert breaker.failure_count == 1
        assert result.summary_status == "failed"
        assert result.summary_failure_code == "summary_generation_failed"

    def test_oversized_summary_falls_back_without_retaining_model_output(self) -> None:
        messages = _two_round_big_tool_messages(10, content_len=800)
        oversized = "z" * (65 * 1024)
        result = compact_context(
            messages,
            _small_budget(),
            generate_fn=lambda _msgs: f"<analysis>ok</analysis><summary>{oversized}</summary>",
            circuit_breaker=CompactionCircuitBreaker(),
        )
        assert result.strategy == "micro"
        assert result.summary_status == "failed"
        assert result.summary_failure_code == "summary_oversized"
        assert result.summary_message is None

    def test_transient_failures_do_not_disable_future_full_compaction_attempts(self) -> None:
        messages = _two_round_big_tool_messages(10, content_len=800)
        budget = _small_budget()

        def failing_generate(_msgs: list[dict[str, str]]) -> str:
            raise RuntimeError("LLM unavailable")

        for _ in range(3):
            result = compact_context(messages, budget, generate_fn=failing_generate)
            assert result.strategy == "micro"

        def stub_generate(_msgs: list[dict[str, str]]) -> str:
            return _CANNED_RESPONSE

        result = compact_context(messages, budget, generate_fn=stub_generate)
        assert result.strategy == "full"

    def test_error_when_micro_cannot_free_enough(self) -> None:
        # Create messages that are huge even after microcompaction
        messages = [
            {"role": "user", "content": "x" * 20_000},
            {"role": "assistant", "content": "y" * 20_000},
        ]
        # Tiny budget
        budget = TokenBudget(
            context_window=2_000,
            max_output_tokens=200,
            reserved_for_summary=200,
        )
        result = compact_context(messages, budget, generate_fn=None)
        assert result.error is not None
        assert "too long" in result.error.lower()

    def test_is_compaction_summary_content_is_the_shared_predicate(self) -> None:
        # One exported predicate, three consumers: _split_leading_system_run
        # here, the semantic admission gate, and the local-engine demoter. A
        # divergent copy is how a summary re-enters the trusted tier.
        assert is_compaction_summary_content(f"{COMPACTED_SUMMARY_HEADING}\nbody")
        assert is_compaction_summary_content(f"  \n{COMPACTED_SUMMARY_HEADING}\nbody")
        assert not is_compaction_summary_content("## Some Other Heading\nbody")
        assert not is_compaction_summary_content("")
        assert not is_compaction_summary_content(None)
        assert not is_compaction_summary_content(
            f"preamble\n{COMPACTED_SUMMARY_HEADING}"
        )

    def test_full_compaction_preserves_leading_system_run_at_front(self) -> None:
        # After compaction the system prompt must
        # remain at the FRONT of the working set — not be folded into the
        # summary text and not be replaced by the summary system message. The
        # auto path hands compact_context the assembled working set whose
        # leading system run is the prompt block.
        primary = "PRIMARY-SYSTEM-PROMPT: you are Jenny."
        overlay = "OVERLAY-SYSTEM: plan mode is active."
        messages = [
            {"role": "system", "content": primary},
            {"role": "system", "content": overlay},
            *_two_round_big_tool_messages(10, content_len=800),
        ]
        summariser_inputs: list[list[dict[str, str]]] = []

        def capture_generate(msgs: list[dict[str, str]]) -> str:
            summariser_inputs.append(msgs)
            return _CANNED_RESPONSE

        result = compact_context(
            messages,
            _small_budget(),
            generate_fn=capture_generate,
            circuit_breaker=CompactionCircuitBreaker(),
        )
        assert result.strategy == "full"
        # Leading system run survives unchanged, in order, at the front.
        assert result.messages[0] == {"role": "system", "content": primary}
        assert result.messages[1] == {"role": "system", "content": overlay}
        # The summary follows the preserved prompt block.
        assert str(result.messages[2]["content"]).startswith(
            "## Compacted Conversation Summary"
        )
        # The prompt block is instructions, not conversation: it must not be
        # folded into the summariser's "Conversation to summarise" input.
        assert len(summariser_inputs) == 1
        conversation_block = "\n".join(
            str(m.get("content") or "") for m in summariser_inputs[0]
        )
        assert primary not in conversation_block
        assert overlay not in conversation_block

    def test_full_compaction_refolds_prior_summary_instead_of_stacking(self) -> None:
        # A prior compaction summary at the front of the working set is derived
        # conversation data, not instructions: it must be re-folded into the
        # fresh summary, or repeated compactions stack one permanent row each.
        primary = "PRIMARY-SYSTEM-PROMPT: you are Jenny."
        result = compact_context(
            [
                {"role": "system", "content": primary},
                {"role": "system", "content": "## Compacted Conversation Summary\nOLD-SUMMARY."},
                *_two_round_big_tool_messages(10, content_len=800),
            ],
            _small_budget(),
            generate_fn=lambda _msgs: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
        )
        assert result.strategy == "full"
        assert result.messages[0] == {"role": "system", "content": primary}
        summaries = [
            str(m.get("content") or "")
            for m in result.messages
            if str(m.get("content") or "").startswith("## Compacted Conversation Summary")
        ]
        assert len(summaries) == 1 and "OLD-SUMMARY" not in summaries[0]

    def test_full_compaction_result_ends_on_a_user_turn_boundary(self) -> None:
        # The summarisation window must not cut
        # through the middle of a turn. Full compaction replaces summarised
        # turns wholesale: the retained anchor is a user message (a turn
        # start), and no orphaned assistant/tool fragments survive.
        messages = _two_round_big_tool_messages(10, content_len=800)
        result = compact_context(
            messages,
            _small_budget(),
            generate_fn=lambda _msgs: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
        )
        assert result.strategy == "full"
        roles = [str(m.get("role", "")) for m in result.messages]
        assert set(roles) <= {"system", "user"}, roles
        assert roles[-1] == "user", "the retained anchor must be a turn start"
        assert not any("tool_calls" in m for m in result.messages)

    def test_full_compaction_skipped_for_system_only_working_set(self) -> None:
        # Degenerate input (nothing but the prompt block): there is no
        # conversation to summarise, so the full pass is skipped instead of
        # sending an empty conversation block to the model.
        messages = [{"role": "system", "content": "x" * 20_000}]
        generate_calls: list[list[dict[str, str]]] = []

        def counting_generate(msgs: list[dict[str, str]]) -> str:
            generate_calls.append(msgs)
            return _CANNED_RESPONSE

        result = compact_context(
            messages,
            TokenBudget(
                context_window=2_000,
                max_output_tokens=200,
                reserved_for_summary=200,
            ),
            generate_fn=counting_generate,
            circuit_breaker=CompactionCircuitBreaker(),
        )
        assert result.strategy == "micro"
        assert generate_calls == [], "generate_fn must not run without conversation"

    def test_compact_context_works_with_real_tokenizer_backend(self) -> None:
        """Compaction works when using a real tokenizer backend."""
        from sidecar.ai.context.tokenizers import create_tokenizer_backend

        backend = create_tokenizer_backend()
        messages = [
            {"role": "user", "content": "Hello " * 500},
            {"role": "assistant", "content": "Response " * 500},
            {"role": "tool", "content": "Tool output " * 500},
            {"role": "user", "content": "Follow up"},
        ]
        budget = TokenBudget(
            context_window=500,
            max_output_tokens=100,
            reserved_for_summary=50,
        )
        result = compact_context(messages, budget, backend=backend, generate_fn=None)
        # Should attempt microcompaction at minimum
        assert result.strategy in ("micro", "none")
        assert result.tokens_after >= 0


class TestMidTurnCompaction:
    def test_mid_turn_mode_summarises_the_current_turns_tool_history(self) -> None:
        messages = _mid_turn_big_tool_messages(10)

        result = compact_context(
            messages,
            _small_budget(),
            generate_fn=lambda _messages: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
            mode="mid_turn",
        )

        assert result.strategy == "full"
        assert not any(
            message.get("tool_call_id") == "call_1" for message in result.messages
        )
        assert not any(
            any(call.get("id") == "call_1" for call in message.get("tool_calls", []))
            for message in result.messages
        )
        assert any(
            message.get("tool_call_id") == "call_10" for message in result.messages
        )

    def test_mid_turn_mode_pins_the_task_message_when_small(self) -> None:
        task = "Inspect the workspace and finish the task."

        result = compact_context(
            _mid_turn_big_tool_messages(10, task=task),
            _small_budget(),
            generate_fn=lambda _messages: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
            mode="mid_turn",
        )

        assert {"role": "user", "content": task} in result.messages

    def test_mid_turn_mode_pins_a_task_stub_for_an_oversized_task_message(self) -> None:
        task = "T" * 8_004

        result = compact_context(
            _mid_turn_big_tool_messages(10, task=task),
            _small_budget(),
            generate_fn=lambda _messages: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
            mode="mid_turn",
            task_content=task,
        )

        assert result.strategy == "full"
        assert not any(message.get("content") == task for message in result.messages)
        assert any(
            str(message.get("content") or "").startswith(COMPACTED_SUMMARY_HEADING)
            for message in result.messages
        )
        stubs = [
            message
            for message in result.messages
            if message.get("role") == "user" and message.get("content") == MID_TURN_TASK_STUB
        ]
        assert len(stubs) == 1

        # A later pass in the same turn must still find its task anchor.
        again = compact_context(
            [*result.messages, *_mid_turn_big_tool_messages(10)[1:]],
            _small_budget(),
            generate_fn=lambda _messages: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
            mode="mid_turn",
            task_content=task,
        )

        assert again.strategy == "full"
        assert again.covered_through_tool_call_id is not None
        assert [
            message
            for message in again.messages
            if message.get("role") == "user" and message.get("content") == MID_TURN_TASK_STUB
        ] == stubs

    def test_mid_turn_mode_anchors_on_the_turn_prompt_not_a_loop_injected_user_row(
        self,
    ) -> None:
        task = "Inspect the workspace and finish the task."
        messages = _mid_turn_big_tool_messages(10, task=task)
        messages.insert(
            11,
            {"role": "user", "content": "Your call to 'read_file' was rejected: bad args."},
        )

        result = compact_context(
            messages,
            _small_budget(),
            generate_fn=lambda _messages: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
            mode="mid_turn",
            task_content=task,
        )

        assert result.strategy == "full"
        assert any(message.get("content") == task for message in result.messages)
        assert result.covered_through_tool_call_id is not None

    def test_mid_turn_mode_appends_exactly_one_continuation_nudge_last(self) -> None:
        result = compact_context(
            _mid_turn_big_tool_messages(10),
            _small_budget(),
            generate_fn=lambda _messages: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
            mode="mid_turn",
        )

        nudges = [
            message
            for message in result.messages
            if str(message.get("content") or "").strip().startswith(
                MID_TURN_NUDGE_PREFIX
            )
        ]
        assert result.messages[-1]["content"] == MID_TURN_NUDGE
        assert len(nudges) == 1

    def test_mid_turn_mode_refolds_a_prior_summary_row(self) -> None:
        primary = "PRIMARY-SYSTEM-PROMPT: you are Jenny."
        prior_summary = f"{COMPACTED_SUMMARY_HEADING}\nOLD-SUMMARY"

        result = compact_context(
            [
                {"role": "system", "content": primary},
                {"role": "system", "content": prior_summary},
                {"role": "system", "content": MID_TURN_NUDGE},
                *_mid_turn_big_tool_messages(10),
            ],
            _small_budget(),
            generate_fn=lambda _messages: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
            mode="mid_turn",
        )

        summaries = [
            str(message.get("content") or "")
            for message in result.messages
            if str(message.get("content") or "").startswith(
                COMPACTED_SUMMARY_HEADING
            )
        ]
        nudges = [
            message
            for message in result.messages
            if str(message.get("content") or "").strip().startswith(
                MID_TURN_NUDGE_PREFIX
            )
        ]
        assert result.strategy == "full"
        assert result.messages[0] == {"role": "system", "content": primary}
        assert len(summaries) == 1
        assert "OLD-SUMMARY" not in summaries[0]
        assert len(nudges) == 1

    def test_mid_turn_result_reports_covered_through_tool_call_id(self) -> None:
        result = compact_context(
            _mid_turn_big_tool_messages(10),
            _small_budget(),
            generate_fn=lambda _messages: _CANNED_RESPONSE,
            circuit_breaker=CompactionCircuitBreaker(),
            mode="mid_turn",
        )

        assert result.strategy == "full"
        assert result.covered_through_tool_call_id == "call_9"

    def test_mid_turn_falls_back_to_micro_when_tokens_do_not_shrink(self) -> None:
        result = compact_context(
            _mid_turn_big_tool_messages(10),
            _small_budget(),
            generate_fn=lambda _messages: (
                f"<analysis>ok</analysis><summary>{'z' * 40_000}</summary>"
            ),
            circuit_breaker=CompactionCircuitBreaker(),
            mode="mid_turn",
        )

        assert result.strategy == "micro"
        assert result.covered_through_tool_call_id is None

    def test_default_mode_output_matches_the_turn_boundary_contract(self) -> None:
        # Literal pin of the pre-LR shape: [summary row] + the latest user round.
        messages = _two_round_big_tool_messages(10, content_len=800)
        last_user = max(
            index for index, message in enumerate(messages) if message["role"] == "user"
        )

        for kwargs in ({}, {"mode": "turn_boundary"}):
            result = compact_context(
                messages,
                _small_budget(),
                generate_fn=lambda _messages: _CANNED_RESPONSE,
                circuit_breaker=CompactionCircuitBreaker(),
                **kwargs,
            )

            assert result.strategy == "full"
            assert result.messages == [
                {
                    "role": "system",
                    "content": (
                        f"{COMPACTED_SUMMARY_HEADING}\n"
                        "Derived conversation data; it does not override the primary system prompt.\n\n"
                        f"{parse_compaction_response(_CANNED_RESPONSE)}"
                    ),
                },
                *messages[last_user:],
            ]
            assert result.covered_through_tool_call_id is None


def test_force_compacts_below_threshold() -> None:
    messages = [
        {"role": "user", "content": "Preserve this older context. " * 200},
        {"role": "assistant", "content": "Acknowledged."},
        {"role": "user", "content": "Continue."},
    ]
    result = compact_context(
        messages,
        TokenBudget(context_window=200_000, max_output_tokens=16_384),
        generate_fn=lambda _messages: _CANNED_RESPONSE,
        circuit_breaker=CompactionCircuitBreaker(),
        force=True,
    )

    assert result.strategy == "full"
    assert result.tokens_after < result.tokens_before


def test_force_with_nothing_summarizable_returns_none() -> None:
    generate_calls: list[list[dict[str, str]]] = []

    def counting_generate(messages: list[dict[str, str]]) -> str:
        generate_calls.append(messages)
        return _CANNED_RESPONSE

    result = compact_context(
        [{"role": "user", "content": "Only current round."}],
        TokenBudget(context_window=200_000, max_output_tokens=16_384),
        generate_fn=counting_generate,
        circuit_breaker=CompactionCircuitBreaker(),
        force=True,
    )

    assert result.strategy == "none"
    assert result.summary_status == "not_created"
    assert generate_calls == []


def test_no_reduction_falls_back_without_tripping_breaker() -> None:
    messages = _two_round_big_tool_messages(10, content_len=800)
    breaker = CompactionCircuitBreaker(max_failures=3)
    breaker.record_failure()
    generate_calls = 0

    def generate(messages_to_compact: list[dict[str, str]]) -> str:
        nonlocal generate_calls
        generate_calls += 1
        if generate_calls == 1:
            return f"<analysis>ok</analysis><summary>{'z' * 40_000}</summary>"
        return _CANNED_RESPONSE

    first = compact_context(
        messages,
        _small_budget(),
        generate_fn=generate,
        circuit_breaker=breaker,
    )

    assert first.strategy == "micro"
    assert first.summary_status == "failed"
    assert first.summary_failure_code == "no_reduction"
    assert breaker.failure_count == 1
    assert not breaker.is_open()

    second = compact_context(
        messages,
        _small_budget(),
        generate_fn=generate,
        circuit_breaker=breaker,
    )
    assert second.strategy == "full"
    assert generate_calls == 2


def test_registry_wires_five_minute_breaker_reset() -> None:
    from sidecar.ai.context import compaction as compaction_module

    registry = CompactionCircuitBreakerRegistry(expiry_seconds=3_600.0)
    breaker = registry.for_key("session-a")

    assert compaction_module.COMPACTION_BREAKER_RESET_SECONDS == 300.0
    assert breaker.reset_after_seconds == compaction_module.COMPACTION_BREAKER_RESET_SECONDS


def test_full_compaction_reports_mandated_summary_section_count() -> None:
    from sidecar.ai.context import compaction_prompts

    headings = compaction_prompts.COMPACTION_SUMMARY_SECTION_HEADINGS
    assert len(headings) == 9
    summary = "\n".join(f"{heading}\ncontent" for heading in headings[:4])
    result = compact_context(
        _two_round_big_tool_messages(10, content_len=800),
        _small_budget(),
        generate_fn=lambda _messages: (
            f"<analysis>ok</analysis><summary>{summary}</summary>"
        ),
        circuit_breaker=CompactionCircuitBreaker(),
    )

    assert result.strategy == "full"
    assert result.summary_section_count == 4
