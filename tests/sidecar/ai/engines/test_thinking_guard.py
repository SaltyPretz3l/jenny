from __future__ import annotations

import re

import pytest

from sidecar.ai.thinking_guard import (
    BUDGET_HIDDEN_STATUS_TEXT,
    REPETITION_HIDDEN_STATUS_TEXT,
    ThinkingRepetitionGuard,
    budget_trip_check,
    guard_log_data,
    take_hidden_reasoning_notice,
)

# A true spiral: one sentence looped past two full 512-char windows. Every
# feed below is 546 chars, so the first verdict can come on the second feed.
_SPIRAL = "Checking the request intent carefully. " * 14


def test_identical_text_trips_guard_after_third_repetitive_window() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)
    repeated = _SPIRAL

    assert guard.feed(repeated) is False
    assert guard.feed(repeated) is False
    assert guard.feed(repeated) is False
    assert guard.feed(repeated) is True
    assert guard.should_stop is True


def test_varied_text_does_not_false_positive() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)

    assert guard.feed("Checking the request intent carefully. ") is False
    assert guard.feed("Reviewing the current question and relevant context. ") is False
    assert guard.feed("Picking the clearest answer path for this reply. ") is False
    assert guard.feed("Finalizing a direct response for the user now. ") is False
    assert guard.should_stop is False


def test_near_identical_paraphrases_trigger_detection() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)

    assert guard.feed("Checking request intent and drafting a concise answer now. " * 9) is False
    assert (
        guard.feed("Checking request intent and drafting a concise answer carefully. " * 9) is False
    )
    assert guard.feed("Checking request intent and drafting a concise answer clearly. " * 9) is False
    assert (
        guard.feed("Checking request intent and drafting a concise answer directly. " * 9) is True
    )
    assert guard.should_stop is True


def test_hard_character_limit_trips_guard() -> None:
    guard = ThinkingRepetitionGuard(max_chars=10)

    assert guard.feed("12345678901") is True
    assert guard.should_stop is True


def test_guard_remains_latched_after_trigger() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)
    repeated = _SPIRAL

    guard.feed(repeated)
    guard.feed(repeated)
    guard.feed(repeated)

    assert guard.feed(repeated) is True
    assert guard.feed("Fresh content that would otherwise differ.") is True


def test_progressive_refinement_does_not_false_positive() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)

    assert guard.feed("Checking the request intent carefully. ") is False
    assert guard.feed("Checking the request intent carefully before drafting. ") is False
    assert guard.feed("Checking the request intent carefully before drafting a response. ") is False
    assert (
        guard.feed("Checking the request intent carefully before drafting a short response. ")
        is False
    )
    assert guard.should_stop is False


def test_large_repeated_chunks_trip_guard_despite_window_word_splits() -> None:
    guard = ThinkingRepetitionGuard(max_chars=65536)
    repeated = "Checking the request intent carefully. " * 50

    assert guard.feed(repeated) is False
    assert guard.feed(repeated) is False
    assert guard.feed(repeated) is True
    assert guard.stop_reason == "repetition"

# ---------------------------------------------------------------------------
# Loophole (owner turn 2026-09-20): once a repetition trip latched the guard,
# feed() returned before counting, so a later char-budget overrun could never
# become a ``char_limit`` trip and the engine kept generating hidden reasoning
# to the provider's hard cap.
# ---------------------------------------------------------------------------


def _trip_on_repetition(guard: ThinkingRepetitionGuard) -> int:
    repeated = _SPIRAL
    fed = 0
    for _ in range(4):
        guard.feed(repeated)
        fed += len(repeated)
    assert guard.stop_reason == "repetition"
    return fed


def test_repetition_trip_keeps_counting_and_escalates_to_char_limit() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)
    fed = _trip_on_repetition(guard)

    # Still suppressed, still short of the budget: repetition stays the reason.
    assert guard.feed("x" * 100) is True
    assert guard.stop_reason == "repetition"
    assert guard.tripped_on_budget() is False
    assert guard.total_chars == fed + 100

    # Crossing the budget while suppressed becomes a budget trip.
    assert guard.feed("y" * 4096) is True
    assert guard.stop_reason == "char_limit"
    assert guard.tripped_on_budget() is True
    assert guard.total_chars == fed + 100 + 4096


def test_char_limit_trip_is_never_downgraded_by_later_repetition() -> None:
    guard = ThinkingRepetitionGuard(max_chars=10)
    assert guard.feed("12345678901") is True
    assert guard.stop_reason == "char_limit"

    for _ in range(4):
        assert guard.feed(_SPIRAL) is True
    assert guard.stop_reason == "char_limit"
    assert guard.tripped_on_budget() is True


def test_total_chars_counts_every_fed_delta_before_and_after_a_trip() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)
    assert guard.total_chars == 0
    guard.feed("abc")
    guard.feed("")
    assert guard.total_chars == 3
    _trip_on_repetition(guard)
    guard.feed("after")
    assert guard.total_chars == 3 + 4 * len(_SPIRAL) + 5


# ---------------------------------------------------------------------------
# HB-004: a repetition trip must end the generation (abort on) or say so on the
# live row (abort off), and the verdict must carry where and when it tripped.
# ---------------------------------------------------------------------------


def test_budget_trip_check_reports_a_repetition_trip_for_the_abort() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)
    check = budget_trip_check(guard)
    assert check() is False
    _trip_on_repetition(guard)
    assert guard.tripped_on_budget() is False
    assert guard.tripped_for_abort() is True
    assert check() is True
    assert budget_trip_check(None)() is False


def test_verdict_data_records_the_first_trip_offset_and_every_dropped_delta() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)
    fed = _trip_on_repetition(guard)
    trip_offset = guard.verdict_data()["trip_offset_chars"]
    assert 0 < trip_offset <= fed
    dropped_before = guard.dropped_deltas
    assert dropped_before >= 1

    guard.feed("x" * 100)
    guard.feed("y" * 4096)  # escalates to char_limit
    data = guard.verdict_data()
    assert data["stop_reason"] == "char_limit"
    assert data["first_trip_reason"] == "repetition"
    assert data["trip_offset_chars"] == trip_offset
    assert isinstance(data["trip_elapsed_ms"], int) and data["trip_elapsed_ms"] >= 0
    assert data["counted_chars"] == fed + 100 + 4096
    assert data["max_chars"] == 4096
    assert data["dropped_deltas"] == dropped_before + 2
    assert data["dropped_chars"] >= 100 + 4096


def test_untripped_guard_verdict_has_no_trip_fields() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)
    guard.feed("plain reasoning")
    data = guard.verdict_data()
    assert data["stop_reason"] is None
    assert data["trip_offset_chars"] is None
    assert data["trip_elapsed_ms"] is None
    assert data["dropped_deltas"] == 0


def test_hidden_reasoning_notice_fires_once_only_with_the_abort_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", "0")
    guard = ThinkingRepetitionGuard(max_chars=4096)
    assert take_hidden_reasoning_notice(guard) is None  # not tripped yet
    _trip_on_repetition(guard)
    assert take_hidden_reasoning_notice(guard) == REPETITION_HIDDEN_STATUS_TEXT
    assert take_hidden_reasoning_notice(guard) is None
    assert take_hidden_reasoning_notice(None) is None


def test_hidden_reasoning_notice_is_withheld_when_the_abort_ends_the_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", raising=False)
    guard = ThinkingRepetitionGuard(max_chars=4096)
    _trip_on_repetition(guard)
    assert take_hidden_reasoning_notice(guard) is None


def test_hidden_reasoning_notice_names_a_budget_trip_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Abort off: a char-limit trip also hides the rest while generation runs on.
    monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", "0")
    guard = ThinkingRepetitionGuard(max_chars=10)
    assert guard.feed("12345678901") is True
    assert take_hidden_reasoning_notice(guard) == BUDGET_HIDDEN_STATUS_TEXT
    assert take_hidden_reasoning_notice(guard) is None


def test_guard_log_data_puts_the_verdict_beside_the_model() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)
    _trip_on_repetition(guard)
    data = guard_log_data(guard, model="bonsai")
    assert data["model"] == "bonsai"
    assert data["stop_reason"] == "repetition"
    assert guard_log_data(None, model="bonsai") == {"model": "bonsai"}


# ---------------------------------------------------------------------------
# HB-011 (dogfood 2026-09-28): the guard halved a short buffer into two tiny
# windows, so a think that opened with a self-correction tripped "repetition"
# at 81 chars / 1.6 s. Replays feed real reasoning in token-sized deltas.
# ---------------------------------------------------------------------------

# The live think, verbatim: the 76 chars that were shown plus the 5-char delta
# the trip dropped (llama-server, Bonsai 2 27B).
_HB011_THINK_START = (
    "The `anyOf` in models.py is missing — wait no, `anyOf` is in models.py — no, wait"
)

# A full reasoning segment from the same run (it never tripped live; the
# "(keep unchanged)" bullets are the near-repetition a guard must tolerate).
_REAL_REASONING = (
    "Now I need to update `test_cli.py` to replace the stale "
    "`test_stubs_exit_nonzero` test. The G0 tests that should remain:\n"
    "- `test_help_exits_0_and_lists_subcommands` (keep unchanged)\n"
    "- `test_subcommand_help_lists_flags` (keep unchanged)\n"
    "- `test_version_exits_0` (keep unchanged)\n"
    "- `test_stubs_exit_nonzero` (stale — must replace)\n"
    "\n"
    "According to the plan step 13: \"Update — reconcile still exits non-zero with "
    "gate pointer; ingest/synth exit 0 and emit valid JSONL on fixtures; help tests "
    "kept unchanged; use tmp_path for all scratch dirs.\"\n"
    "\n"
    "So I need to:\n"
    "1. Keep the first three tests exactly as they are.\n"
    "2. Replace `test_stubs_exit_nonzero` with tests for:\n"
    "   - reconcile still exits non-zero (argparse missing required flags → exit 2)\n"
    "   - ingest/synth exit 0 and emit valid JSONL on fixtures\n"
    "   - use tmp_path for all scratch dirs\n"
    "\n"
    "Let me write the updated test_cli.py.\n"
    "\n"
    "Now let me plan the full set of test files:\n"
    "\n"
    "1. `tests/test_normalize.py` — Decimal-only money parsing, 2-decimal string "
    "output, no `float(` in money modules (source scan), date formats, description "
    "normalization; check-number formats CHK, CHECK #, Scheck Nr. each extract the "
    "bare digits; ledger numeric Document Ref yields the same bare digits "
    "(cross-compare).\n"
    "\n"
    "2. `tests/test_profiles.py` — all three built-ins load; a custom --profile-file "
    "JSON expressing every R2 option parses equivalently.\n"
    "\n"
    "3. `tests/test_parse.py` — each bank dialect + ledger parsed from synth "
    "fixtures AND from small hand-written samples; ids assert exactly R4 "
    "(bank:<n>/ledger:<n>, non-data lines never counted).\n"
    "\n"
    "4. `tests/test_rheinbank_umlaut.py` — hand-written rheinbank sample with ä/ö/ü "
    "written cp1252; parse and assert umlauts round-trip correctly.\n"
    "\n"
    "5. `tests/test_synth.py` — synth run twice with same seed → byte-identical "
    "fixture files (R9 determinism).\n"
    "\n"
    "Now let me check the existing test files to understand the patterns used, and "
    "the source code to know exact function names/behaviors. Let me re-read the key "
    "source files to be precise about what to test.\n"
    "\n"
    "Actually, from the compacted summary I have detailed info. But let me verify "
    "the actual functions by reading a couple of files. Let me look at test_cli more "
    "— I already have it. Let me look at normalize.py and profiles.py to get exact "
    "function signatures, and parsers.py, models.py, synth.py.\n"
    "\n"
    "Let me read these files."
)


def _token_deltas(text: str, max_len: int) -> list[str]:
    """Split like a subword tokenizer: word pieces of at most ``max_len`` chars."""
    deltas: list[str] = []
    for word in re.findall(r"\s*\S+|\s+$", text):
        deltas.extend(word[start : start + max_len] for start in range(0, len(word), max_len))
    assert "".join(deltas) == text
    return deltas


def _first_trip_offset(guard: ThinkingRepetitionGuard, deltas: list[str]) -> int | None:
    for delta in deltas:
        if guard.feed(delta):
            return guard.verdict_data()["trip_offset_chars"]
    return None


@pytest.mark.parametrize("max_len", [2, 3, 4, 5])
def test_think_opening_with_a_self_correction_does_not_trip(max_len: int) -> None:
    guard = ThinkingRepetitionGuard(max_chars=34_076)

    assert _first_trip_offset(guard, _token_deltas(_HB011_THINK_START, max_len)) is None
    assert guard.should_stop is False


@pytest.mark.parametrize("max_len", [3, 5, 8])
def test_real_reasoning_in_token_sized_deltas_never_trips(max_len: int) -> None:
    guard = ThinkingRepetitionGuard(max_chars=34_076)
    text = _HB011_THINK_START + " " + _REAL_REASONING

    assert _first_trip_offset(guard, _token_deltas(text, max_len)) is None
    assert guard.total_chars == len(text)


@pytest.mark.parametrize("max_len", [3, 5, 8])
def test_true_spiral_in_token_sized_deltas_still_trips(max_len: int) -> None:
    guard = ThinkingRepetitionGuard(max_chars=34_076)
    spiral = "Checking the request intent carefully. " * 60

    offset = _first_trip_offset(guard, _token_deltas(spiral, max_len))

    assert guard.stop_reason == "repetition"
    # Only once two full windows are buffered, and well before the budget.
    assert offset is not None and 2 * guard.window_chars <= offset < 2 * guard.window_chars + 64


def test_no_repetition_verdict_before_two_full_windows() -> None:
    guard = ThinkingRepetitionGuard(
        max_chars=4096, window_chars=64, similarity_threshold=0.0, max_repetitive_windows=1
    )
    # Any comparison would trip at once (threshold 0, one window).
    assert guard.feed("a" * 127) is False
    assert guard.feed("b") is True
    assert guard.verdict_data()["trip_offset_chars"] == 128
