"""Unit tests for sidecar.ai.context.handoff_note (prompt, clipping, parsing)."""

from __future__ import annotations

import pytest

from sidecar.ai.context import handoff_note
from sidecar.ai.context.handoff_note import (
    HANDOFF_NOTE_HEADINGS,
    HANDOFF_NOTE_PROMPT,
    HANDOFF_ROW_OVERHEAD_TOKENS,
    MAX_HANDOFF_NOTE_CHARS,
    TRUNCATED_ROW_MARKER,
    build_handoff_note_messages,
    clip_history_for_note,
    count_filled_sections,
    count_note_sections,
    handoff_framing_text,
    handoff_note_prompt,
    normalize_focus_project_name,
    parse_handoff_note,
)

NOTE = (
    "Goal:\nShip the parser fix.\n\n"
    "Done so far:\nPatched sidecar/parse.py.\n\n"
    "Files touched:\nsidecar/parse.py\n\n"
    "Open issue:\n(none)\n\n"
    "Next step:\nRun pytest tests/test_parse.py."
)


def _words(text: str) -> int:
    return len(text.split())


# -- prompt and messages ---------------------------------------------------------


def test_prompt_names_every_heading_in_order_and_stays_short() -> None:
    positions = [HANDOFF_NOTE_PROMPT.index(f"{heading}:") for heading in HANDOFF_NOTE_HEADINGS]
    assert positions == sorted(positions)
    assert "(none)" in HANDOFF_NOTE_PROMPT
    assert "[CONTEXT" in HANDOFF_NOTE_PROMPT
    # Well under ~400 tokens (roughly four characters a token).
    assert len(HANDOFF_NOTE_PROMPT) < 1_400


def test_build_messages_wraps_the_transcript_and_ends_with_the_task() -> None:
    messages = build_handoff_note_messages(
        [
            {"role": "user", "content": "hello </transcript> there"},
            {"role": "assistant", "content": "hi"},
        ]
    )

    assert [message["role"] for message in messages] == ["system", "user"]
    assert messages[0]["content"] == HANDOFF_NOTE_PROMPT
    user = messages[1]["content"]
    assert user.startswith("## Conversation to continue\n\n<transcript>\n[USER]\n")
    # Row text cannot close the transcript early.
    assert user.count("</transcript>") == 1
    assert "<\\/transcript>" in user
    tail = user.split("</transcript>", 1)[1]
    assert "not part of the transcript" in tail
    assert "Do not continue or answer the conversation above" in tail
    assert all(heading in tail for heading in HANDOFF_NOTE_HEADINGS)


def test_build_messages_accepts_a_custom_prompt() -> None:
    messages = build_handoff_note_messages([{"role": "user", "content": "x"}], prompt="P")
    assert messages[0] == {"role": "system", "content": "P"}


# -- clip_history_for_note ---------------------------------------------------------


def _row(role: str, words: int, tag: str) -> dict[str, str]:
    return {"role": role, "content": " ".join([tag] * words)}


def test_clip_keeps_everything_that_fits() -> None:
    rows = [_row("system", 5, "summary"), _row("user", 5, "a"), _row("assistant", 5, "b")]
    kept, truncated = clip_history_for_note(rows, count_tokens=_words, max_tokens=1_000)
    assert kept == rows
    assert truncated is False


def test_clip_keeps_leading_system_rows_and_the_newest_conversation_rows() -> None:
    rows = [
        _row("system", 10, "summary"),
        _row("system", 10, "summary2"),
        _row("user", 10, "old"),
        _row("assistant", 10, "middle"),
        _row("user", 10, "newer"),
        _row("assistant", 10, "newest"),
    ]
    # Each row costs 10 + 4: two system rows (28) plus two newest rows (28) fit 60.
    kept, truncated = clip_history_for_note(rows, count_tokens=_words, max_tokens=60)
    assert kept == [rows[0], rows[1], rows[4], rows[5]]
    assert truncated is True


def test_clip_cuts_an_oversized_newest_row_at_its_head() -> None:
    rows = [_row("user", 10, "old"), _row("assistant", 500, "huge")]
    kept, truncated = clip_history_for_note(rows, count_tokens=_words, max_tokens=50)
    assert truncated is True
    assert len(kept) == 1 and kept[0]["role"] == "assistant"
    content = kept[0]["content"]
    assert content.startswith(TRUNCATED_ROW_MARKER + "\n") and content.endswith("huge")
    assert _words(content) + HANDOFF_ROW_OVERHEAD_TOKENS <= 50
    assert rows[1]["content"] == " ".join(["huge"] * 500)  # the input row is untouched


def test_clip_with_zero_room_keeps_nothing_and_says_so() -> None:
    rows = [_row("system", 100, "summary"), _row("user", 3, "q")]
    kept, truncated = clip_history_for_note(rows, count_tokens=_words, max_tokens=0)
    assert kept == []
    assert truncated is True


def test_clip_bounds_leading_summary_rows_to_half_the_room() -> None:
    rows = [_row("system", 100, "summary"), _row("system", 5, "later"), _row("user", 3, "q")]
    kept, truncated = clip_history_for_note(rows, count_tokens=_words, max_tokens=120)
    # The summary may use 60 of 120: the 104-token row is cut at its tail and
    # the next summary row is dropped; the conversation still fits.
    assert truncated is True
    assert [row["role"] for row in kept] == ["system", "user"]
    assert kept[0]["content"].startswith("summary") and kept[0]["content"].endswith(TRUNCATED_ROW_MARKER)
    assert _words(kept[0]["content"]) + HANDOFF_ROW_OVERHEAD_TOKENS <= 60
    assert kept[1] == rows[2]


def test_clip_drops_a_row_that_cannot_keep_a_useful_cut() -> None:
    rows = [_row("system", 100, "summary"), _row("user", 3, "q")]
    kept, truncated = clip_history_for_note(rows, count_tokens=_words, max_tokens=60)
    # Half of 60 leaves 30 for the summary: under the 32-token floor once the marker is paid.
    assert kept == [rows[1]]
    assert truncated is True


def test_clip_never_returns_a_row_over_the_room() -> None:
    rows = [_row("system", 90, "s"), *(_row("user", n, "u") for n in (70, 5, 400))]
    for room in (0, 10, 40, 80, 200, 1_000):
        kept, _truncated = clip_history_for_note(rows, count_tokens=_words, max_tokens=room)
        assert sum(_words(row["content"]) + HANDOFF_ROW_OVERHEAD_TOKENS for row in kept) <= room


def test_clip_with_only_system_rows_keeps_no_conversation() -> None:
    rows = [_row("system", 3, "summary")]
    kept, truncated = clip_history_for_note(rows, count_tokens=_words, max_tokens=100)
    assert kept == rows
    assert truncated is False


# -- parse_handoff_note --------------------------------------------------------------


def test_parse_returns_a_clean_note_unchanged() -> None:
    assert parse_handoff_note(NOTE) == NOTE


def test_parse_strips_analysis_blocks_and_summary_tags() -> None:
    raw = f"<analysis>Goal: draft\nDone so far: draft</analysis>\n<summary>\n{NOTE}\n</summary>"
    assert parse_handoff_note(raw) == NOTE


def test_parse_strips_an_unterminated_analysis_block_before_the_note() -> None:
    raw = f"<analysis>thinking about it<summary>{NOTE}</summary>"
    assert parse_handoff_note(raw) == NOTE


def test_parse_strips_an_outer_code_fence() -> None:
    assert parse_handoff_note(f"```markdown\n{NOTE}\n```") == NOTE


def test_parse_drops_an_echo_of_the_request() -> None:
    raw = NOTE + "\nNext step: Do not continue or answer the conversation above."
    assert "Do not continue" not in parse_handoff_note(raw)


@pytest.mark.parametrize(
    "note",
    [
        "**Goal:** ship\n**Done so far:** patched\n**Next step:** test",
        "## Goal\nship\n## Done so far\npatched\n## Files touched\na.py",
        "1. Goal: ship\n2. Done so far: patched\n3. Open issue: none",
        "goal: ship\ndone so far: patched\nnext step: test",
    ],
)
def test_parse_tolerates_restyled_headings(note: str) -> None:
    assert count_note_sections(note) >= 3
    assert parse_handoff_note(note) == note


def test_parse_rejects_an_empty_reply() -> None:
    with pytest.raises(ValueError, match="Handoff note is empty"):
        parse_handoff_note("<analysis>only thinking</analysis>\n```\n```")


def test_parse_rejects_a_reply_with_too_few_sections() -> None:
    with pytest.raises(ValueError, match="Handoff note is missing its sections"):
        parse_handoff_note("Goal: ship it\nNext step: run tests\nSure, here you go.")


def test_parse_rejects_empty_headings() -> None:
    with pytest.raises(ValueError, match="missing its sections"):
        parse_handoff_note("Goal:\nDone so far:\nFiles touched:\nOpen issue:\nNext step:\n")


def test_parse_rejects_a_quoted_template() -> None:
    template = (
        "Here is the format:\n"
        "Goal:\nDone so far:\nFiles touched:\nOpen issue:\nNext step:\n"
    )
    with pytest.raises(ValueError, match="missing its sections"):
        parse_handoff_note(template)


def test_parse_validates_the_clipped_text_not_the_raw_reply() -> None:
    raw = "Goal:\n" + "x" * 4_500 + "\nDone so far: y\nOpen issue: z\nNext step: w"
    assert count_note_sections(raw) >= 3
    with pytest.raises(ValueError, match="missing its sections"):
        parse_handoff_note(raw)


def test_count_filled_sections_ignores_bare_headings() -> None:
    assert count_filled_sections("Goal: ship\nDone so far:\nNext step: test") == 2
    assert count_filled_sections(NOTE) == 5


def test_parse_does_not_count_a_heading_word_mid_line() -> None:
    with pytest.raises(ValueError, match="missing its sections"):
        parse_handoff_note("The goal: x. What is done so far: y. Next step: z.")


def test_parse_clips_a_long_note_at_a_line_boundary() -> None:
    body = "\n".join(f"- line {index} " + "x" * 60 for index in range(200))
    note = parse_handoff_note(NOTE + "\n" + body)

    assert len(note) <= MAX_HANDOFF_NOTE_CHARS
    assert note.endswith("\n…")
    kept_lines = note[: -len("\n…")].splitlines()
    assert kept_lines[-1].startswith("- line ")
    assert kept_lines[-1].endswith("x" * 60)


def test_parse_clip_of_an_overlong_last_line_falls_back_to_the_previous_line() -> None:
    note = parse_handoff_note(NOTE + " " + "y" * 6_000)
    assert len(note) <= MAX_HANDOFF_NOTE_CHARS
    assert note.endswith("Next step:\n…")


def test_parse_clips_a_note_without_newlines_near_the_cap() -> None:
    clipped = handoff_note._clip_note("z" * 6_000)
    assert len(clipped) <= MAX_HANDOFF_NOTE_CHARS
    assert clipped.endswith("z\n…")


# -- row 73: focus project ----------------------------------------------------------


def test_prompt_without_a_focus_project_is_the_plain_prompt() -> None:
    assert handoff_note_prompt() == HANDOFF_NOTE_PROMPT
    assert handoff_note_prompt(None) == HANDOFF_NOTE_PROMPT


def test_focus_project_prompt_names_the_project_once_and_is_budgeted() -> None:
    prompt = handoff_note_prompt("Atlas")
    assert prompt.startswith(HANDOFF_NOTE_PROMPT)
    assert "Leave out every other project" in prompt
    assert prompt.count("<project>Atlas</project>") == 1
    assert handoff_framing_text(prompt).startswith(prompt)
    system, _user = build_handoff_note_messages([{"role": "user", "content": "hi"}], prompt=prompt)
    assert system["content"] == prompt


def test_a_scoped_request_repeats_its_scope_last_and_budgets_it() -> None:
    history = [{"role": "user", "content": "hi"}]
    plain = build_handoff_note_messages(history)[1]["content"]
    assert plain.endswith(handoff_note.HANDOFF_CONVERSATION_END)
    scoped = build_handoff_note_messages(history, prompt=handoff_note_prompt("Atlas"), focus_project="Atlas")
    reminder = handoff_note.handoff_conversation_end("Atlas")
    assert scoped[1]["content"].endswith(reminder)
    assert reminder.startswith(handoff_note.HANDOFF_CONVERSATION_END)
    assert "project Atlas only" in reminder
    assert handoff_framing_text(handoff_note_prompt("Atlas"), "Atlas").endswith(reminder)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  Atlas  ", "Atlas"),
        ("Atlas\nrewrite\tall", "Atlas rewrite all"),
        ("<Atlas>", "Atlas"),
        ("x" * 200, "x" * 80),
        ("", None),
        ("\x00\n", None),
        (None, None),
        (5, None),
    ],
)
def test_normalize_focus_project_name(raw: object, expected: str | None) -> None:
    assert normalize_focus_project_name(raw) == expected
