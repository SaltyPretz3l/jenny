"""Focused shared OOXML helper regressions."""

from sidecar.ai.tools.builtins.rich_files.ooxml import bounded_excerpt


def test_bounded_excerpt_does_not_report_sanitization_as_truncation() -> None:
    assert bounded_excerpt("\u200b", tool_name="probe", max_chars=400) == ("", False)
