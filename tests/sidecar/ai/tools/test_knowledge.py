"""Knowledge tools: root-scoped search/view/exec over registered folders.

Security posture under test: every result path must resolve inside a
registered knowledge root; traversal and symlink escapes are rejected; all
outputs are bounded. See docs/TOOLS.md#knowledge.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_DISABLED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_OUTSIDE_WORKSPACE,
)
from sidecar.ai.tools.builtins.knowledge import (
    configure_knowledge_tools,
    knowledge_exec_tool,
    knowledge_search_tool,
    knowledge_view_tool,
)
from sidecar.ai.tools.builtins.knowledge import exec_ops as exec_ops_module
from sidecar.ai.tools.builtins.rich_files.notebook import notebook_inspect_tool
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

_PATH_VIOLATION_CODES = {CMP_TOOL_INVALID_PATH, CMP_TOOL_OUTSIDE_WORKSPACE}

_WORKSPACE = WorkspaceGuard(None)


@pytest.fixture(autouse=True)
def _reset_knowledge_state():
    yield
    configure_knowledge_tools(None)


@pytest.fixture
def corpus(tmp_path: Path) -> dict[str, Path]:
    root_a = tmp_path / "project-x"
    (root_a / "sub").mkdir(parents=True)
    (root_a / "spec.md").write_text("alpha needle one\nplain line\n", encoding="utf-8")
    (root_a / "sub" / "notes.txt").write_text("needle two\n", encoding="utf-8")
    root_b = tmp_path / "handbook"
    root_b.mkdir()
    (root_b / "guide.md").write_text("needle three\n", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.md").write_text("needle outside\n", encoding="utf-8")
    configure_knowledge_tools(
        {
            "tools_knowledge_enabled": True,
            "knowledge_roots": [str(root_a), str(root_b)],
        }
    )
    return {"root_a": root_a, "root_b": root_b, "outside": outside, "tmp": tmp_path}


def _payload(result: ToolHandlerResult) -> dict[str, object]:
    parsed = json.loads(result.output)
    assert isinstance(parsed, dict)
    return parsed


def _can_create_symlink(tmp_path: Path) -> bool:
    src = tmp_path / "_probe_src"
    dst = tmp_path / "_probe_dst"
    src.write_text("x", encoding="utf-8")
    try:
        os.symlink(src, dst)
    except (OSError, NotImplementedError):
        return False
    finally:
        if dst.exists() or dst.is_symlink():
            try:
                dst.unlink()
            except OSError:
                pass
        if src.exists():
            src.unlink()
    return True


# ── knowledge_search ─────────────────────────────────────────────────


def test_search_finds_hits_only_within_roots(corpus: dict[str, Path]) -> None:
    result = knowledge_search_tool({"pattern": "needle"}, _WORKSPACE)

    assert result.success is True
    payload = _payload(result)
    text = str(payload["result"])
    assert "project-x/spec.md" in text
    assert "project-x/sub/notes.txt" in text
    assert "handbook/guide.md" in text
    assert "outside" not in text
    assert "secret.md" not in text

    sources = payload["sources"]
    assert isinstance(sources, list) and sources
    paths = {source["path"] for source in sources}
    assert paths == {"project-x/spec.md", "project-x/sub/notes.txt", "handbook/guide.md"}
    for index, source in enumerate(sources, start=1):
        assert source["id"] == f"kb:{index}"
        assert source["source_type"] == "knowledge"
        assert source["title"]
        assert len(str(source["snippet"])) <= 280
    assert payload["missing_source_metadata"] is False


def test_search_root_filter_restricts_scope(corpus: dict[str, Path]) -> None:
    result = knowledge_search_tool({"pattern": "needle", "root": "handbook"}, _WORKSPACE)

    payload = _payload(result)
    assert "handbook/guide.md" in str(payload["result"])
    assert "project-x" not in str(payload["result"])


def test_search_unknown_root_lists_registered_labels(corpus: dict[str, Path]) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        knowledge_search_tool({"pattern": "needle", "root": "nope"}, _WORKSPACE)
    assert excinfo.value.code == CMP_TOOL_INVALID_PATH
    assert "project-x" in excinfo.value.message
    assert "handbook" in excinfo.value.message


def test_search_path_argument_scopes_to_a_subdirectory(corpus: dict[str, Path]) -> None:
    result = knowledge_search_tool(
        {"pattern": "needle", "path": "project-x/sub"},
        _WORKSPACE,
    )

    payload = _payload(result)
    assert "project-x/sub/notes.txt" in str(payload["result"])
    assert "spec.md" not in str(payload["result"])
    assert "handbook" not in str(payload["result"])


def test_search_rejects_root_and_path_together(corpus: dict[str, Path]) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        knowledge_search_tool(
            {"pattern": "needle", "root": "project-x", "path": "project-x/sub"},
            _WORKSPACE,
        )
    assert excinfo.value.code == CMP_TOOL_INVALID_PATH


def test_search_path_traversal_rejected(corpus: dict[str, Path]) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        knowledge_search_tool(
            {"pattern": "needle", "path": "project-x/../outside"},
            _WORKSPACE,
        )
    assert excinfo.value.code in _PATH_VIOLATION_CODES


def test_view_rejects_ntfs_alternate_data_stream_paths(corpus: dict[str, Path]) -> None:
    if os.name == "nt":
        # Materialize the stream so the rejection is a real guard, not a
        # file-not-found accident.
        try:
            with open(str(corpus["root_a"] / "spec.md") + ":hidden", "w", encoding="utf-8") as handle:
                handle.write("SECRET STREAM")
        except OSError:
            pass
    with pytest.raises(ToolExecutionFailure) as excinfo:
        knowledge_view_tool({"path": "project-x/spec.md:hidden"}, _WORKSPACE)
    assert excinfo.value.code == CMP_TOOL_INVALID_PATH


def test_search_without_roots_is_a_structured_failure() -> None:
    configure_knowledge_tools({"tools_knowledge_enabled": True, "knowledge_roots": []})
    with pytest.raises(ToolExecutionFailure) as excinfo:
        knowledge_search_tool({"pattern": "needle"}, _WORKSPACE)
    assert excinfo.value.code == CMP_TOOL_DISABLED


def test_search_nonexistent_root_is_skipped_not_fatal(corpus: dict[str, Path]) -> None:
    configure_knowledge_tools(
        {
            "knowledge_roots": [
                str(corpus["root_a"]),
                str(corpus["tmp"] / "missing-root"),
            ],
        }
    )
    result = knowledge_search_tool({"pattern": "needle"}, _WORKSPACE)

    payload = _payload(result)
    assert "project-x/spec.md" in str(payload["result"])
    assert "missing-root" in payload.get("skipped_roots", [])


def test_search_truncates_over_cap_matches(corpus: dict[str, Path]) -> None:
    bulk = corpus["root_a"] / "bulk.txt"
    bulk.write_text("".join(f"needle line {n}\n" for n in range(50)), encoding="utf-8")

    result = knowledge_search_tool({"pattern": "needle", "max_results": 5}, _WORKSPACE)

    assert result.success is True
    assert result.metadata["truncated"] is True
    assert result.metadata["returned_match_count"] <= 5


def test_search_sources_are_bounded(corpus: dict[str, Path]) -> None:
    for index in range(30):
        (corpus["root_a"] / f"many-{index:02d}.txt").write_text(
            "needle bulk\n", encoding="utf-8"
        )

    result = knowledge_search_tool({"pattern": "needle"}, _WORKSPACE)

    payload = _payload(result)
    assert len(payload["sources"]) <= 20


# ── knowledge_view (text) ────────────────────────────────────────────


def test_view_text_returns_content_and_kb_source(corpus: dict[str, Path]) -> None:
    result = knowledge_view_tool({"path": "project-x/spec.md"}, _WORKSPACE)

    assert result.success is True
    payload = _payload(result)
    assert payload["path"] == "project-x/spec.md"
    assert "alpha needle one" in str(payload["content"])
    assert payload["total_lines"] == 2
    assert payload["has_more"] is False
    sources = payload["sources"]
    assert sources[0]["id"] == "kb:1"
    assert sources[0]["path"] == "project-x/spec.md"
    assert sources[0]["title"] == "spec.md"
    assert sources[0]["source_type"] == "knowledge"
    assert payload["missing_source_metadata"] is False


def test_view_text_pagination_bounds(corpus: dict[str, Path]) -> None:
    pages = corpus["root_a"] / "pages.txt"
    pages.write_text("".join(f"line {n}\n" for n in range(1, 11)), encoding="utf-8")

    result = knowledge_view_tool(
        {"path": "project-x/pages.txt", "offset": 3, "limit": 2},
        _WORKSPACE,
    )

    payload = _payload(result)
    assert payload["content"] == "line 4\nline 5"
    assert payload["returned_lines"] == 2
    assert payload["has_more"] is True


def test_view_single_root_allows_bare_relative_paths(corpus: dict[str, Path]) -> None:
    configure_knowledge_tools({"knowledge_roots": [str(corpus["root_a"])]})

    result = knowledge_view_tool({"path": "spec.md"}, _WORKSPACE)

    assert _payload(result)["path"] == "project-x/spec.md"


def test_view_rejects_traversal_escape(corpus: dict[str, Path]) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        knowledge_view_tool({"path": "project-x/../outside/secret.md"}, _WORKSPACE)
    assert excinfo.value.code in _PATH_VIOLATION_CODES


def test_view_rejects_absolute_path_outside_roots(corpus: dict[str, Path]) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        knowledge_view_tool({"path": str(corpus["outside"] / "secret.md")}, _WORKSPACE)
    assert excinfo.value.code in _PATH_VIOLATION_CODES | {CMP_TOOL_DISABLED}


def test_view_accepts_absolute_path_inside_a_root(corpus: dict[str, Path]) -> None:
    result = knowledge_view_tool(
        {"path": str(corpus["root_a"] / "spec.md")},
        _WORKSPACE,
    )
    assert _payload(result)["path"] == "project-x/spec.md"


def test_view_rejects_symlink_escape(corpus: dict[str, Path], tmp_path: Path) -> None:
    if not _can_create_symlink(tmp_path):
        pytest.skip("symlink creation not permitted in this environment")
    link = corpus["root_a"] / "escape.md"
    os.symlink(corpus["outside"] / "secret.md", link)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        knowledge_view_tool({"path": "project-x/escape.md"}, _WORKSPACE)
    assert excinfo.value.code in _PATH_VIOLATION_CODES


def test_search_does_not_follow_symlinked_dirs(
    corpus: dict[str, Path], tmp_path: Path
) -> None:
    if not _can_create_symlink(tmp_path):
        pytest.skip("symlink creation not permitted in this environment")
    os.symlink(
        corpus["outside"],
        corpus["root_a"] / "linked",
        target_is_directory=True,
    )

    result = knowledge_search_tool({"pattern": "needle"}, _WORKSPACE)

    assert "secret.md" not in str(_payload(result)["result"])


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_view_rejects_windows_junction_escape(corpus: dict[str, Path]) -> None:
    link = corpus["root_a"] / "junction"
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(corpus["outside"])],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"mklink /J not permitted: {result.stderr.strip()}")

    with pytest.raises(ToolExecutionFailure) as excinfo:
        knowledge_view_tool({"path": "project-x/junction/secret.md"}, _WORKSPACE)
    assert excinfo.value.code in _PATH_VIOLATION_CODES


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_search_does_not_follow_junctioned_dirs(corpus: dict[str, Path]) -> None:
    link = corpus["root_a"] / "junction"
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(corpus["outside"])],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"mklink /J not permitted: {result.stderr.strip()}")

    search = knowledge_search_tool({"pattern": "needle"}, _WORKSPACE)

    assert "secret.md" not in str(_payload(search)["result"])


# ── knowledge_view (rich adapters) ───────────────────────────────────


def test_view_rich_type_dispatches_injected_adapter(corpus: dict[str, Path]) -> None:
    (corpus["root_a"] / "report.docx").write_bytes(b"fake-docx-bytes")
    calls: list[tuple[str, object]] = []

    def fake_document_adapter(
        arguments: dict[str, object], guard: WorkspaceGuard
    ) -> ToolHandlerResult:
        calls.append((str(arguments.get("path")), guard.root))
        return ToolHandlerResult(
            output=json.dumps(
                {"status": "inspected", "adapter": "document", "summary": {"text": "extracted"}}
            ),
            success=True,
        )

    configure_knowledge_tools(
        {"knowledge_roots": [str(corpus["root_a"]), str(corpus["root_b"])]},
        rich_adapters={"document": fake_document_adapter},
    )

    result = knowledge_view_tool({"path": "project-x/report.docx"}, _WORKSPACE)

    assert calls == [("report.docx", corpus["root_a"].resolve())]
    payload = _payload(result)
    assert payload["status"] == "inspected"
    assert payload["sources"][0]["path"] == "project-x/report.docx"
    assert payload["sources"][0]["source_type"] == "knowledge"
    assert payload["missing_source_metadata"] is False


def test_view_rich_forwards_only_its_read_only_path_contract(corpus: dict[str, Path]) -> None:
    (corpus["root_a"] / "report.pdf").write_bytes(b"fake-pdf-bytes")
    calls: list[dict[str, object]] = []

    def fake_pdf_adapter(
        arguments: dict[str, object], _guard: WorkspaceGuard
    ) -> ToolHandlerResult:
        calls.append(dict(arguments))
        return ToolHandlerResult(output=json.dumps({"summary": {"text": "extracted"}}))

    configure_knowledge_tools(
        {"knowledge_roots": [str(corpus["root_a"])]},
        rich_adapters={"pdf": fake_pdf_adapter},
    )

    result = knowledge_view_tool(
        {
            "path": "project-x/report.pdf",
            "create_preview": True,
            "_jenny_session_id": "unexpected",
        },
        _WORKSPACE,
    )

    assert result.success is True
    assert calls == [{"path": "report.pdf"}]


def test_view_rich_adapter_missing_is_structured_failure(corpus: dict[str, Path]) -> None:
    (corpus["root_a"] / "deck.pptx").write_bytes(b"fake-pptx-bytes")

    result = knowledge_view_tool({"path": "project-x/deck.pptx"}, _WORKSPACE)

    assert result.success is False
    payload = _payload(result)
    assert payload["sources"] == []
    assert payload["missing_source_metadata"] is True
    assert "presentation" in str(payload["error"])


def test_view_real_notebook_adapter_round_trip(corpus: dict[str, Path]) -> None:
    notebook = {
        "cells": [
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": ["# Corpus Notebook\n", "needle in a notebook"],
            }
        ],
        "metadata": {},
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    (corpus["root_a"] / "analysis.ipynb").write_text(
        json.dumps(notebook), encoding="utf-8"
    )
    configure_knowledge_tools(
        {"knowledge_roots": [str(corpus["root_a"])]},
        rich_adapters={"notebook": notebook_inspect_tool},
    )

    result = knowledge_view_tool({"path": "project-x/analysis.ipynb"}, _WORKSPACE)

    assert result.success is True
    payload = _payload(result)
    assert payload["sources"][0]["path"] == "project-x/analysis.ipynb"
    assert payload["missing_source_metadata"] is False


# ── knowledge_exec ───────────────────────────────────────────────────


def test_exec_ls_lists_roots_when_no_path(corpus: dict[str, Path]) -> None:
    result = knowledge_exec_tool({"op": "ls"}, _WORKSPACE)

    payload = _payload(result)
    paths = {entry["path"] for entry in payload["entries"]}
    assert "project-x/spec.md" in paths
    assert "handbook/guide.md" in paths
    assert not any("outside" in str(path) for path in paths)


def test_exec_tree_respects_depth_and_entry_bounds(corpus: dict[str, Path]) -> None:
    deep = corpus["root_a"] / "a" / "b" / "c"
    deep.mkdir(parents=True)
    (deep / "deep.txt").write_text("deep\n", encoding="utf-8")

    shallow = knowledge_exec_tool(
        {"op": "tree", "path": "project-x", "max_depth": 1},
        _WORKSPACE,
    )
    payload = _payload(shallow)
    paths = {entry["path"] for entry in payload["entries"]}
    assert "project-x/a" in paths
    assert not any("deep.txt" in str(path) for path in paths)

    bounded = knowledge_exec_tool(
        {"op": "tree", "path": "project-x", "max_entries": 2},
        _WORKSPACE,
    )
    bounded_payload = _payload(bounded)
    assert len(bounded_payload["entries"]) <= 2
    assert bounded_payload["truncated"] is True


def test_exec_find_matches_file_name_glob(corpus: dict[str, Path]) -> None:
    result = knowledge_exec_tool({"op": "find", "pattern": "*.md"}, _WORKSPACE)

    payload = _payload(result)
    paths = {entry["path"] for entry in payload["entries"]}
    assert "project-x/spec.md" in paths
    assert "handbook/guide.md" in paths
    assert "project-x/sub/notes.txt" not in paths


def test_exec_find_applies_glob_to_file_scope(corpus: dict[str, Path]) -> None:
    result = knowledge_exec_tool(
        {"op": "find", "path": "project-x/spec.md", "pattern": "*.py"},
        _WORKSPACE,
    )

    assert _payload(result)["entries"] == []


def test_exec_find_stops_after_visited_path_budget_without_matches(
    corpus: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0

    def never_matches(_name: str, _pattern: str) -> bool:
        nonlocal calls
        calls += 1
        return False

    collector = exec_ops_module._EntryCollector(  # noqa: SLF001
        [], 1, 1, "*.md", True, max_visited_paths=3
    )
    root = SimpleNamespace(label="kb", path=corpus["root_a"], guard=SimpleNamespace())
    monkeypatch.setattr(
        exec_ops_module.os,
        "walk",
        lambda *_args, **_kwargs: [
            (str(corpus["root_a"]), [], [f"file-{index}.txt" for index in range(4)])
        ],
    )
    monkeypatch.setattr(exec_ops_module.fnmatch, "fnmatch", never_matches)

    truncated = exec_ops_module._collect_entries(  # noqa: SLF001
        root, corpus["root_a"], collector=collector
    )

    assert collector.entries == []
    assert calls == 3
    assert truncated is True


@pytest.mark.parametrize("op", ["grep", "cat", "rm"])
def test_exec_rejects_removed_or_unknown_op(corpus: dict[str, Path], op: str) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        knowledge_exec_tool({"op": op}, _WORKSPACE)
    assert excinfo.value.code == CMP_TOOL_INVALID_PATH


def test_exec_tree_rejects_path_outside_roots(corpus: dict[str, Path]) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        knowledge_exec_tool(
            {"op": "tree", "path": "project-x/../outside"},
            _WORKSPACE,
        )
    assert excinfo.value.code in _PATH_VIOLATION_CODES


# ── root labeling ────────────────────────────────────────────────────


def test_duplicate_basename_roots_get_distinct_labels(tmp_path: Path) -> None:
    first = tmp_path / "team-a" / "docs"
    second = tmp_path / "team-b" / "docs"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    (first / "one.md").write_text("needle alpha\n", encoding="utf-8")
    (second / "two.md").write_text("needle beta\n", encoding="utf-8")
    configure_knowledge_tools({"knowledge_roots": [str(first), str(second)]})

    result = knowledge_search_tool({"pattern": "needle"}, _WORKSPACE)

    payload = _payload(result)
    paths = {source["path"] for source in payload["sources"]}
    assert paths == {"docs/one.md", "docs-2/two.md"}

    viewed = knowledge_view_tool({"path": "docs-2/two.md"}, _WORKSPACE)
    assert "needle beta" in str(_payload(viewed)["content"])
