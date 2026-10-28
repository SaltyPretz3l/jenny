"""A mixed-ending file keeps every untouched line's ending through an edit.

``edit_file`` folds edits on LF-normalised text and rendered the result with
the file's dominant ending everywhere, so one edit silently rewrote the
endings of every other line in a file that mixed CRLF and LF (tool review,
2026-10-19). The renderer now re-attaches the original ending per untouched
line; a uniform file is unchanged from the legacy path.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import edit_file as edit_module
from sidecar.ai.tools.builtins import propose_suggestion
from sidecar.ai.tools.builtins.edit_matching import render_preserving_newlines
from sidecar.ai.tools.workspace import WorkspaceGuard


@pytest.mark.parametrize(
    ("original", "updated", "style", "expected"),
    [
        # untouched lines keep their own endings; the edited line keeps its too
        ("one\ntwo\nthree\r\nfour\nfive\n", "ONE\ntwo\nthree\r\nfour\nfive\n".replace("\r\n", "\n"), "\n", "ONE\ntwo\nthree\r\nfour\nfive\n"),
        # a lone CR inside the file survives
        ("a\rb\r\nc\n", "a\nb\nC\n", "\n", "a\rb\r\nC\n"),
        # inserted lines take the dominant style; a deleted line is gone
        ("x\r\ny\r\nz\n", "x\nNEW1\nNEW2\nz\n", "\r\n", "x\r\nNEW1\r\nNEW2\r\nz\n"),
        # no trailing newline, last line edited
        ("p\r\nq\nr", "p\nq\nR", "\r\n", "p\r\nq\nR"),
        # the former tail gains the dominant ending when a line is appended
        ("p\r\nq\nr", "p\nq\nr\nnew", "\r\n", "p\r\nq\nr\r\nnew"),
        # uniform files render exactly as before
        ("a\r\nb\r\n", "a\nB\n", "\r\n", "a\r\nB\r\n"),
        ("a\nb\n", "a\nB\n", "\n", "a\nB\n"),
        # a whole-file replacement of a mixed file takes the dominant style
        ("a\r\nb\nc\r\n", "q\nw\n", "\r\n", "q\r\nw\r\n"),
    ],
)
def test_render_preserving_newlines(original: str, updated: str, style: str, expected: str) -> None:
    assert render_preserving_newlines(original, updated, style) == expected


def test_render_preserving_newlines_stays_fast_on_a_large_repetitive_file() -> None:
    # 20k lines of three repeated contents took 14 s through SequenceMatcher
    # alone (tool review perf pass, 2026-10-19); every untouched line keeps
    # its ending and the changed line gets the dominant one.
    contents = ["", "}", "x = 1"]
    count, changed = 20_000, 10_000
    original = "".join(contents[i % 3] + ("\r\n" if i % 2 else "\n") for i in range(count))
    updated = "\n".join("changed" if i == changed else contents[i % 3] for i in range(count)) + "\n"
    expected = "".join(
        ("changed" if i == changed else contents[i % 3]) + ("\r\n" if i % 2 or i == changed else "\n")
        for i in range(count)
    )

    started = time.perf_counter()
    rendered = render_preserving_newlines(original, updated, "\r\n")

    assert time.perf_counter() - started < 2.0
    assert rendered == expected


def test_edit_file_keeps_untouched_line_endings_in_a_mixed_file(tmp_path: Path) -> None:
    target = tmp_path / "mixed.txt"
    target.write_bytes(b"one\ntwo\nthree\r\nfour\nfive\n")

    result = edit_module.edit_file_tool(
        {"file_path": "mixed.txt", "old_string": "one", "new_string": "ONE"},
        WorkspaceGuard(str(tmp_path)),
    )

    assert result.success is True, result.output
    assert target.read_bytes() == b"ONE\ntwo\nthree\r\nfour\nfive\n"


def test_propose_suggestion_renders_a_mixed_file_the_same_way() -> None:
    matched = propose_suggestion.match_replace(
        "one\ntwo\nthree\r\nfour\nfive\n",
        "one",
        "ONE",
        relative_path="mixed.txt",
        max_bytes=10_000,
    )
    assert not hasattr(matched, "success"), matched
    assert matched.new_text == "ONE\ntwo\nthree\r\nfour\nfive\n"
