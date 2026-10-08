"""edit_matching owns the pure edit helpers; edit_file keeps using the same objects."""

from __future__ import annotations

from sidecar.ai.tools.builtins import edit_file as edit_module
from sidecar.ai.tools.builtins import edit_matching


def test_edit_file_uses_the_extracted_matching_helpers() -> None:
    for name in (
        "_FoldContext",
        "_fold_edits",
        "_edit_failure",
        "_apply_edit",
        "_normalize_newlines",
        "_dominant_newline",
        "_render_with_newlines",
        "_projected_rendered_chars",
    ):
        assert getattr(edit_module, name) is getattr(edit_matching, name)


def test_suggestion_mode_changes_only_the_failure_wording() -> None:
    content = "alpha\nbeta\nbeta\n"
    plain = edit_matching._FoldContext(
        relative_path="a.txt", newline_style="\n", max_final_bytes=1_000, name_failures=False
    )
    suggesting = edit_matching._FoldContext(
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
