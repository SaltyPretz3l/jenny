"""Bounded, UI-only per-child transcript recorder (row 67, Slice S)."""

from __future__ import annotations

import json

from sidecar.ai.routing.subagent_transcript import (
    MAX_TRANSCRIPT_CHARS,
    MAX_TRANSCRIPT_ENTRIES,
    MAX_TRANSCRIPT_INPUT_CHARS,
    MAX_TRANSCRIPT_OUTPUT_CHARS,
    MAX_TRANSCRIPT_TEXT_CHARS,
    ChildTranscript,
)

SECRET = "sk-" + "A" * 48


class _Clock:
    def __init__(self) -> None:
        self.now = 10.0

    def __call__(self) -> float:
        return self.now


def _finished(transcript: ChildTranscript, call_id: str = "c1", **overrides: object) -> None:
    fields: dict[str, object] = {
        "tool_name": "read_file",
        "success": True,
        "content": "body",
        "tool_input": {"path": "README.md"},
    }
    fields.update(overrides)
    transcript.tool_finished(call_id, **fields)  # type: ignore[arg-type]


def test_note_before_a_tool_is_committed_and_the_final_answer_is_not() -> None:
    transcript = ChildTranscript()
    transcript.text_delta("Let me ")
    transcript.text_delta("look.")
    transcript.tool_started("c1", "read_file", {"path": "README.md"})
    _finished(transcript, duration_ms=12.6)
    transcript.text_delta("The final answer.")
    transcript.finish()

    entries = transcript.entries()
    assert entries == [
        {"kind": "text", "text": "Let me look."},
        {
            "kind": "tool",
            "call_id": "c1",
            "tool": "read_file",
            "display": "Read File",
            "status": "completed",
            "input": '{"path":"README.md"}',
            "output": "body",
            "ms": 13,
        },
    ]
    assert "The final answer." not in json.dumps(entries)
    assert transcript.dropped == 0


def test_tool_continuation_reset_commits_and_a_retry_reset_discards() -> None:
    transcript = ChildTranscript()
    transcript.text_delta("kept preamble")
    transcript.reset(keep_text=True)
    transcript.text_delta("garbage from a failed attempt")
    transcript.reset(keep_text=False)
    transcript.text_delta("   \n ")
    transcript.tool_started("c1", "read_file", {})

    assert [entry["kind"] for entry in transcript.entries()] == ["text", "tool"]
    assert transcript.entries()[0]["text"] == "kept preamble"
    assert "garbage" not in json.dumps(transcript.entries())


def test_reasoning_opens_one_live_thought_closed_by_the_next_event() -> None:
    clock = _Clock()
    transcript = ChildTranscript(clock=clock)
    transcript.reasoning("t1", "I should ")
    version_after_start = transcript.version
    transcript.reasoning("t1", "read the README.")
    assert transcript.version == version_after_start
    assert transcript.entries() == [{"kind": "thought", "text": "", "live": True}]

    clock.now = 11.25
    transcript.tool_started("c1", "read_file", {"path": "README.md"})

    thought, tool = transcript.entries()
    assert thought == {"kind": "thought", "text": "I should read the README.", "ms": 1250}
    assert tool["status"] == "running"
    assert transcript.version > version_after_start


def test_a_new_thinking_id_starts_a_new_thought_and_text_ends_one() -> None:
    transcript = ChildTranscript()
    transcript.reasoning("t1", "first")
    transcript.reasoning("t2", "second")
    transcript.text_delta("note")
    transcript.reset(keep_text=True)

    kinds = [(entry["kind"], entry["text"]) for entry in transcript.entries()]
    assert kinds == [("thought", "first"), ("thought", "second"), ("text", "note")]


def test_finish_closes_a_live_thought_and_interrupts_running_tools() -> None:
    transcript = ChildTranscript(clock=_Clock())
    transcript.tool_started("c1", "grep_search", {"pattern": "x"})
    transcript.reasoning("t1", "still thinking")
    before = transcript.version
    transcript.text_delta("unfinished answer")
    transcript.finish()

    tool, thought = transcript.entries()
    assert tool["status"] == "interrupted"
    assert thought == {"kind": "thought", "text": "still thinking", "ms": 0}
    assert transcript.version > before
    assert "unfinished answer" not in json.dumps(transcript.entries())


def test_result_without_a_start_appends_a_completed_entry_with_tool_input() -> None:
    transcript = ChildTranscript()
    _finished(transcript, "c9", tool_input={"path": "docs/ä.md", "b": 1})

    (entry,) = transcript.entries()
    assert entry["status"] == "completed"
    # Compact JSON, non-ASCII kept, key order preserved.
    assert entry["input"] == '{"path":"docs/ä.md","b":1}'
    assert "ms" not in entry and "error_code" not in entry and "input_truncated" not in entry


def test_empty_arguments_and_empty_output_are_omitted() -> None:
    transcript = ChildTranscript()
    transcript.tool_started("c1", "list_files", {})
    _finished(transcript, tool_name="list_files", content="", tool_input={})

    (entry,) = transcript.entries()
    assert "input" not in entry and "output" not in entry and "output_chars" not in entry


def test_a_duplicate_result_does_not_add_or_rewrite_an_entry() -> None:
    transcript = ChildTranscript()
    _finished(transcript, content="first")
    version = transcript.version
    _finished(transcript, content="second", success=False)

    (entry,) = transcript.entries()
    assert entry["output"] == "first" and entry["status"] == "completed"
    assert transcript.version == version


def test_failed_call_scrubs_paths_from_input_and_output_but_ok_calls_keep_them() -> None:
    transcript = ChildTranscript()
    transcript.tool_started("ok", "read_file", {"path": "C:\\work\\repo\\a.txt"})
    _finished(
        transcript, "ok", content="read C:\\work\\repo\\a.txt", tool_input={"path": "C:\\work\\repo\\a.txt"}
    )
    transcript.tool_started("bad", "read_file", {"path": "C:\\Users\\me\\secret notes.txt"})
    _finished(
        transcript,
        "bad",
        success=False,
        content="Refused: 'C:\\Users\\me\\secret notes.txt' is outside the workspace; also /etc/passwd",
        tool_input={"path": "C:\\Users\\me\\secret notes.txt"},
        error_code="CMP-TOOL-0001",
    )

    ok, bad = transcript.entries()
    assert "C:\\\\work\\\\repo\\\\a.txt" in ok["input"]
    assert "C:\\work\\repo\\a.txt" in ok["output"]
    assert bad["status"] == "failed"
    assert bad["error_code"] == "CMP-TOOL-0001"
    dumped = json.dumps(bad)
    assert "Users" not in dumped and "secret notes" not in dumped and "passwd" not in dumped
    assert "<path>" in bad["input"] and "<path>" in bad["output"]


def test_every_text_field_is_redacted_and_loses_format_controls() -> None:
    transcript = ChildTranscript()
    transcript.reasoning("t1", f"token {SECRET}\u202e")
    transcript.text_delta(f"note {SECRET}\u200b")
    transcript.tool_started("c1", "web_fetch", {"header": SECRET})
    _finished(transcript, tool_name="web_fetch", content=f"got {SECRET}\u202e", tool_input={})

    dumped = json.dumps(transcript.entries(), ensure_ascii=False)
    assert "sk-" not in dumped
    assert "\u202e" not in dumped and "\u200b" not in dumped
    assert "[REDACTED]" in dumped


def test_a_secret_split_across_deltas_is_still_redacted() -> None:
    transcript = ChildTranscript()
    for chunk in (SECRET[:10], SECRET[10:30], SECRET[30:]):
        transcript.text_delta(chunk)
    transcript.reset(keep_text=True)

    assert "sk-" not in json.dumps(transcript.entries())


def test_per_field_caps_flag_the_cut() -> None:
    transcript = ChildTranscript()
    transcript.reasoning("t1", "r" * 5_000)
    transcript.text_delta("w" * 5_000)
    transcript.tool_started("c1", "read_file", {"path": "p" * 5_000})
    _finished(transcript, content="o" * 5_000)

    thought, text, tool = transcript.entries()
    assert len(thought["text"]) == MAX_TRANSCRIPT_TEXT_CHARS and thought["truncated"] is True
    assert len(text["text"]) == MAX_TRANSCRIPT_TEXT_CHARS and text["truncated"] is True
    assert len(tool["input"]) == MAX_TRANSCRIPT_INPUT_CHARS and tool["input_truncated"] is True
    assert len(tool["output"]) == MAX_TRANSCRIPT_OUTPUT_CHARS
    assert tool["output_chars"] == 5_000


def test_short_fields_are_bounded() -> None:
    transcript = ChildTranscript()
    transcript.tool_started("c" * 500, "t" * 500, {})
    _finished(transcript, "c" * 500, tool_name="t" * 500, success=False, error_code="E" * 500)

    (entry,) = transcript.entries()
    assert len(entry["call_id"]) <= 200
    assert len(entry["tool"]) <= 64 and len(entry["display"]) <= 64
    assert len(entry["error_code"]) <= 64


def test_shared_budget_cuts_later_fields_to_what_remains() -> None:
    transcript = ChildTranscript()
    calls = MAX_TRANSCRIPT_CHARS // MAX_TRANSCRIPT_OUTPUT_CHARS + 2
    for index in range(calls):
        _finished(transcript, f"c{index}", content="o" * 3_000, tool_input={})

    entries = transcript.entries()
    spent = sum(len(entry.get("output", "")) for entry in entries)
    assert spent == MAX_TRANSCRIPT_CHARS
    last = entries[-1]
    assert "output" not in last or last["output"] == ""
    assert last["output_chars"] == 3_000
    transcript.text_delta("late note")
    transcript.reset(keep_text=True)
    note = transcript.entries()[-1]
    assert note == {"kind": "text", "text": "", "truncated": True}


def test_entry_cap_counts_dropped_entries_once_per_call() -> None:
    transcript = ChildTranscript()
    for index in range(MAX_TRANSCRIPT_ENTRIES):
        _finished(transcript, f"c{index}", content="x", tool_input={})
    transcript.tool_started("late", "read_file", {})
    _finished(transcript, "late", content="x", tool_input={})
    transcript.reasoning("t1", "a")
    transcript.reasoning("t1", "b")
    transcript.text_delta("note")
    transcript.reset(keep_text=True)
    transcript.finish()

    assert len(transcript.entries()) == MAX_TRANSCRIPT_ENTRIES
    assert transcript.dropped == 3


def test_entries_are_copies() -> None:
    transcript = ChildTranscript()
    _finished(transcript)
    transcript.entries()[0]["status"] = "mutated"
    assert transcript.entries()[0]["status"] == "completed"


def test_running_input_is_scrubbed_until_the_call_is_admitted() -> None:
    transcript = ChildTranscript()
    transcript.tool_started("ok", "read_file", {"path": "/home/me/notes.txt"})
    transcript.tool_started("cut", "read_file", {"path": "/home/me/other.txt"})
    running, _other = transcript.entries()
    assert running["input"] == '{"path":"<path>"}'

    _finished(transcript, "ok", tool_input={"path": "/home/me/notes.txt"})
    transcript.finish()

    admitted, interrupted = transcript.entries()
    assert admitted["input"] == '{"path":"/home/me/notes.txt"}'
    assert interrupted["status"] == "interrupted"
    assert "other.txt" not in interrupted["input"]


def test_a_secret_split_by_the_raw_cap_is_dropped_with_its_word() -> None:
    transcript = ChildTranscript()
    # Redaction shrinks each secret, so the raw cap lands inside the kept window.
    # 5,992 raw characters: the 6,000 cap keeps only "sk-AAAAA" of the last
    # secret, too short for the redactor to recognise.
    prefix = " ".join([SECRET] * 115) + " " + "x" * 11 + " "
    transcript.text_delta(prefix + SECRET)
    transcript.reset(keep_text=True)

    (entry,) = transcript.entries()
    assert "sk-" not in entry["text"] and "AAAA" not in entry["text"]
    assert entry["truncated"] is True


# Built in parts so the repository's secret scan does not flag the fixture.
_KEY_KIND = "RSA " + "PRIVATE KEY"
PEM = (
    f"-----BEGIN {_KEY_KIND}-----\n"
    + "\n".join(["MIIEowIBAAKCAQEA" + "q" * 48] * 120)
    + f"\n-----END {_KEY_KIND}-----"
)


def test_a_private_key_cut_before_its_end_marker_does_not_survive() -> None:
    transcript = ChildTranscript()
    transcript.text_delta("Here is the key:\n" + PEM)
    transcript.reset(keep_text=True)

    (entry,) = transcript.entries()
    assert "BEGIN RSA" not in entry["text"] and "MIIEow" not in entry["text"]
    assert entry["text"].startswith("Here is the key:")
    assert entry["truncated"] is True


def test_a_huge_output_is_cut_before_sanitizing_and_reports_its_raw_length() -> None:
    transcript = ChildTranscript()
    transcript.tool_started("c1", "read_file", {"path": "big.txt"})
    content = "row " * 250_000 + SECRET
    _finished(transcript, content=content, tool_input={"path": "big.txt"})

    (entry,) = transcript.entries()
    assert entry["output_chars"] == len(content)
    assert len(entry["output"]) == MAX_TRANSCRIPT_OUTPUT_CHARS
    assert "sk-" not in entry["output"]
