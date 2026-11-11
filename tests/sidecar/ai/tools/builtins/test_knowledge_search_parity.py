"""knowledge_search output parity across the batched worker scan (row 124 P1b acceptance).

knowledge_search sends candidates to grep's worker in batches and asks for each
matched file's summary once the batch's answers are in. The payload text and
every metadata field must stay what the one-request-per-file loop gave: the
golden was recorded by running this module as a script against ``f8a87412e``
(the row 124 P1 commit, before knowledge_search batched), on Windows desktop.

Regenerate the golden only from the pre-change code:
``python tests/sidecar/ai/tools/builtins/test_knowledge_search_parity.py --write-golden PATH``.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.tools.builtins import grep_search as gs
from sidecar.ai.tools.builtins.knowledge import search as search_module
from sidecar.ai.tools.builtins.knowledge.roots import scoped_knowledge_tools
from sidecar.ai.tools.contracts import ToolExecutionFailure
from tests.sidecar.ai.tools.builtins.test_grep_search_parity import SIZE_CAP, build_corpus

GOLDEN = Path(__file__).with_name("knowledge_search_parity_golden.json")
CASES: list[dict[str, object]] = [
    {"pattern": "needle"},
    {"pattern": "needle", "context_lines": 2},
    {"pattern": "needle|haystack|cafe|line"},
    {"pattern": "NEEDLE", "ignore_case": True},
    {"pattern": "^needle"},
    {"pattern": "needle", "max_results": 5},
    {"pattern": "zzqx_no_match"},
    {"pattern": "needle", "include_glob": "*.py"},
    {"pattern": "needle", "path": "workspace/sub"},
    {"pattern": "needle", "root": "extra"},
    {"pattern": "line", "max_results": 500},
    {"pattern": "binarytext"},
    {"pattern": "deepneedle"},
    {"query": "needle haystack"},
    # "_max_files" lowers MAX_TOTAL_FILES_VISITED so the file budget stops mid-batch.
    {"pattern": "needle", "_max_files": 4},
    {"pattern": "needle|haystack", "_max_files": 30},
    {"pattern": "line", "max_results": 500, "_max_files": 40},
]


def build_roots(base: Path) -> tuple[Path, Path]:
    workspace = base / "workspace"
    build_corpus(workspace)
    extra = base / "extra"
    extra.mkdir()
    for index in range(7):
        (extra / f"e{index}.md").write_text(
            "".join(f"extra {index} needle {n} haystack\n" for n in range(index + 1)),
            encoding="utf-8",
        )
    return workspace, extra


def _snapshot(run: Callable[[], Any]) -> dict[str, object]:
    try:
        result = run()
    except ToolExecutionFailure as error:
        return {"raised": error.code, "message": error.message}
    return json.loads(json.dumps({
        "output": result.output,
        "success": result.success,
        "error_code": result.error_code,
        "metadata": result.metadata,
    }))


def _run_case(case: dict[str, object]) -> dict[str, object]:
    arguments = dict(case)
    max_files = arguments.pop("_max_files", None)
    saved = search_module.MAX_TOTAL_FILES_VISITED
    if isinstance(max_files, int):
        search_module.MAX_TOTAL_FILES_VISITED = max_files
    try:
        return _snapshot(lambda: search_module.knowledge_search_tool(arguments, None))
    finally:
        search_module.MAX_TOTAL_FILES_VISITED = saved


def run_cases(roots: tuple[Path, Path]) -> list[dict]:
    with scoped_knowledge_tools(tuple(str(root) for root in roots)):
        return [_run_case(case) for case in CASES]


@pytest.fixture
def roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    monkeypatch.setitem(gs._SEARCH_SETTINGS, "max_search_file_bytes", SIZE_CAP)
    return build_roots(tmp_path.resolve())


def _force_batch_size(monkeypatch: pytest.MonkeyPatch, size: int) -> None:
    from sidecar.ai.tools.builtins import grep_search_worker

    monkeypatch.setattr(search_module, "MAX_BATCH_FILES", size)
    monkeypatch.setattr(grep_search_worker, "MAX_BATCH_FILES", size)


@pytest.mark.skipif(os.name != "nt", reason="the golden was recorded on Windows desktop")
@pytest.mark.parametrize("batch_size", [1, 3, 128])
def test_batched_knowledge_search_matches_the_pre_change_golden(
    roots: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch, batch_size: int
) -> None:
    _force_batch_size(monkeypatch, batch_size)
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))

    actual = run_cases(roots)

    assert len(golden) == len(CASES)
    for case, expected, got in zip(CASES, golden, actual, strict=True):
        assert got == expected, case


def test_summaries_after_an_abandoned_batch_read_their_own_answers(
    roots: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    # The scan stops on the timeout cap with answers still owed: the summaries of
    # the files matched before that must not read those stale answers.
    real_scan = search_module._scan_text_batches

    def two_answers_then_timeouts(*args: Any, **kwargs: Any) -> Iterator[Any]:
        outcomes = real_scan(*args, **kwargs)
        try:
            yield next(outcomes)
            yield next(outcomes)
            for _ in range(gs.MAX_TIMED_OUT_FILES):
                yield gs.ScanOutcome("timeout")
        finally:
            outcomes.close()

    real_summary = search_module._match_summary
    summaries: list[tuple[str, int]] = []

    def recording_summary(texts: list[str], context: Any) -> tuple[str, int]:
        summaries.append(real_summary(texts, context))
        return summaries[-1]

    monkeypatch.setattr(search_module, "_scan_text_batches", two_answers_then_timeouts)
    monkeypatch.setattr(search_module, "_match_summary", recording_summary)
    _, extra = roots
    with scoped_knowledge_tools((str(extra),)):
        result = search_module.knowledge_search_tool({"pattern": "needle|haystack"}, None)

    assert result.metadata["aborted_by_timeout_cap"] is True
    # A stale scan answer read as a summary carries no distinct-term count.
    assert summaries == [("extra 0 needle 0 haystack", 2), ("extra 1 needle 0 haystack", 2)]
    sources = json.loads(result.output)["sources"]
    assert sorted(source["path"] for source in sources) == ["extra/e0.md", "extra/e1.md"]


if __name__ == "__main__":
    # Golden recording: run against the code the golden must describe.
    import tempfile

    target = Path(sys.argv[sys.argv.index("--write-golden") + 1])
    with tempfile.TemporaryDirectory() as scratch:
        gs._SEARCH_SETTINGS["max_search_file_bytes"] = SIZE_CAP
        snapshots = run_cases(build_roots(Path(scratch).resolve()))
    target.write_text(json.dumps(snapshots, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(snapshots)} snapshots to {target}")
