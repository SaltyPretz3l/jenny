from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.filesystem import read_file_tool
from sidecar.ai.tools.builtins.markdown_sections import MAX_MARKDOWN_SECTION_OUTPUT_CHARS
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(path))


def test_read_markdown_headings_supports_atx_setext_duplicates_and_fences(tmp_path: Path) -> None:
    content = """# Intro
intro
## Child
child
```md
# Fake
```
Target
------
first
# Other
other
## Child
second
"""
    (tmp_path / "plan.md").write_text(content, encoding="utf-8", newline="")
    result = read_file_tool(
        {"path": "plan.md", "headings": ["Child", "Target"]}, _guard(tmp_path)
    )
    assert "## Child\nchild" in result.output
    assert "Target\n------\nfirst" in result.output
    assert "## Child\nsecond" in result.output
    assert "Fake" not in result.metadata["headings"]
    assert result.metadata["read_snapshot"]["scope"] == "partial"
    assert result.metadata["missing_headings"] == []


def test_parent_and_nested_heading_requests_are_deduplicated_in_document_order(tmp_path: Path) -> None:
    (tmp_path / "plan.md").write_text(
        "# Parent\nlead\n## Child\nbody\n# Next\nend\n", encoding="utf-8", newline=""
    )
    result = read_file_tool(
        {"path": "plan.md", "headings": ["Child", "Parent"]}, _guard(tmp_path)
    )
    assert result.output == "# Parent\nlead\n## Child\nbody\n"


def test_fence_prefix_with_trailing_text_does_not_close_code_block(tmp_path: Path) -> None:
    (tmp_path / "plan.md").write_text(
        "# Real\n```md\n```still code\n# Fake\n```\nbody\n", encoding="utf-8", newline=""
    )
    result = read_file_tool(
        {"path": "plan.md", "headings": ["Real", "Fake"]}, _guard(tmp_path)
    )
    assert result.metadata["missing_headings"] == ["Fake"]


def test_atx_heading_preserves_content_hash_without_preceding_space(tmp_path: Path) -> None:
    (tmp_path / "plan.md").write_text("# C#\nbody\n", encoding="utf-8", newline="")

    result = read_file_tool({"path": "plan.md", "headings": ["C#"]}, _guard(tmp_path))

    assert result.output == "# C#\nbody\n"
    assert result.metadata["headings"] == ["C#"]


def test_setext_heading_rejects_four_space_indented_code_title(tmp_path: Path) -> None:
    (tmp_path / "plan.md").write_text(
        "    Not a heading\n---\n# Real heading\nbody\n",
        encoding="utf-8",
        newline="",
    )

    with pytest.raises(ToolExecutionFailure, match="none of the requested"):
        read_file_tool(
            {"path": "plan.md", "headings": ["Not a heading"]},
            _guard(tmp_path),
        )


def test_heading_partial_match_reports_missing_and_zero_matches_fails(tmp_path: Path) -> None:
    (tmp_path / "plan.md").write_text("# Present\nbody\n", encoding="utf-8")
    result = read_file_tool(
        {"path": "plan.md", "headings": ["Missing", "Present"]}, _guard(tmp_path)
    )
    assert result.metadata["missing_headings"] == ["Missing"]
    with pytest.raises(ToolExecutionFailure):
        read_file_tool({"path": "plan.md", "headings": ["Missing"]}, _guard(tmp_path))


def test_heading_reads_reject_pagination_and_bound_aggregate_output(tmp_path: Path) -> None:
    (tmp_path / "plan.md").write_text(
        "# Large\n" + ("x" * (MAX_MARKDOWN_SECTION_OUTPUT_CHARS + 100)), encoding="utf-8"
    )
    result = read_file_tool({"path": "plan.md", "headings": ["Large"]}, _guard(tmp_path))
    assert len(result.output) == MAX_MARKDOWN_SECTION_OUTPUT_CHARS
    assert result.metadata["truncated"] is True
    with pytest.raises(ToolExecutionFailure):
        read_file_tool(
            {"path": "plan.md", "headings": ["Large"], "offset": 0}, _guard(tmp_path)
        )


def test_empty_bom_markdown_read_is_marker_free(tmp_path: Path) -> None:
    (tmp_path / "empty.md").write_bytes(b"\xef\xbb\xbf")
    result = read_file_tool({"path": "empty.md"}, _guard(tmp_path))
    assert result.output == ""
    assert result.metadata["encoding"] == "utf-8-sig"
