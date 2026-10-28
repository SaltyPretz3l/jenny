"""edit_matching owns the pure edit helpers shared by edit_file and propose_change."""

from __future__ import annotations

from sidecar.ai.tools.builtins import edit_matching


def test_suggestion_mode_changes_only_the_failure_wording() -> None:
    content = "alpha\nbeta\nbeta\n"
    plain = edit_matching.FoldContext(
        relative_path="a.txt", newline_style="\n", max_final_bytes=1_000, name_failures=False
    )
    suggesting = edit_matching.FoldContext(
        relative_path="a.txt", newline_style="\n", max_final_bytes=1_000, name_failures=False,
        suggestion_mode=True,
    )

    missing_plain = edit_matching._edit_failure(
        content, "gamma", "delta", occurrences=0, replace_all=False, replacement_count=1,
        context=plain,
    )
    missing_suggest = edit_matching._edit_failure(
        content, "gamma", "delta", occurrences=0, replace_all=False, replacement_count=1,
        context=suggesting,
    )
    many_suggest = edit_matching._edit_failure(
        content, "beta", "delta", occurrences=2, replace_all=False, replacement_count=1,
        context=suggesting,
    )

    assert missing_plain is not None and "already edited" in missing_plain[0]
    assert missing_suggest is not None and "already edited" not in missing_suggest[0]
    assert "the file on disk is unchanged" in missing_suggest[0]
    assert many_suggest is not None and "replace_all" not in many_suggest[0]


def test_fold_edits_reports_the_matched_span_for_exact_and_fallback_matches() -> None:
    context = edit_matching.FoldContext(
        relative_path="a.txt", newline_style="\n", max_final_bytes=1_000, name_failures=False
    )
    content = "alpha\nbeta   \ngamma\n"
    exact: list[tuple[int, int]] = []
    edit_matching.fold_edits(
        (("gamma", "delta", False),), content=content, context=context, matched_spans=exact
    )
    fallback: list[tuple[int, int]] = []
    edit_matching.fold_edits(
        (("beta\ngamma", "x", False),), content=content, context=context,
        matched_spans=fallback,
    )

    assert exact == [(content.index("gamma"), content.index("gamma") + len("gamma"))]
    assert fallback == [(content.index("beta"), content.index("gamma") + len("gamma"))]
    assert edit_matching.match_span(content, "beta\ngamma") == fallback[0]
    assert edit_matching.match_span(content, "missing") is None

