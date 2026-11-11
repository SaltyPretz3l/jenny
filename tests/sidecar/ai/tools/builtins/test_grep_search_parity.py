"""grep_search output parity across the row 124 batched scan (row 124 P1 acceptance).

The batched worker scan must give the result text and every metadata field the
one-request-per-file loop gave. Two checks over one corpus (CRLF, LF and CR line
endings, UTF-8 with and without BOM, invalid bytes, very long lines, empty,
binary by content and by extension, over the size cap, a PDF) and one pattern set:

- the golden file, recorded by running this module as a script against the
  pre-row-124 code (``c2187c5fc``), on Windows desktop where it was recorded;
- an in-test oracle, the old per-file loop driven through the worker's
  one-file request path, on every platform and, on POSIX, in hosted mode too.

Each check runs with the batch size forced small so output caps and timeouts
cross batch boundaries.

Regenerate the golden only from the pre-change code:
``python tests/sidecar/ai/tools/builtins/test_grep_search_parity.py --write-golden PATH``.
"""

from __future__ import annotations

import json
import os
import sys
from concurrent.futures import TimeoutError as FutureTimeoutError
from pathlib import Path
from typing import Any, Callable

import pytest

from sidecar.ai.tools.builtins import grep_search as gs
from sidecar.ai.tools.builtins.filesystem import is_binary_file
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

GOLDEN = Path(__file__).with_name("grep_search_parity_golden.json")
SIZE_CAP = 4096
CASES: list[dict[str, object]] = [
    {"pattern": "needle"},
    {"pattern": "needle", "context_lines": 2},
    {"pattern": "needle|haystack"},
    {"pattern": "NEEDLE", "ignore_case": True},
    {"pattern": "^needle"},
    {"pattern": "needle$"},
    {"pattern": r"\s+needle\b"},
    {"pattern": "needle", "max_results": 5},
    {"pattern": "needle", "max_results": 1, "context_lines": 1},
    {"pattern": "zzqx_no_match"},
    {"pattern": "needle", "include_glob": "*.py"},
    {"pattern": "needle", "path": "sub"},
    {"pattern": "�"},
    {"pattern": "bad"},
    {"pattern": "deepneedle"},
    {"pattern": "café"},
    {"pattern": "#tag"},
    {"pattern": "needle|"},
    {"pattern": "line", "max_results": 500},
    {"pattern": "line", "max_results": 500, "context_lines": 3},
    {"pattern": "binarytext"},
    {"pattern": "pdfneedle"},
]


def build_corpus(root: Path) -> None:
    (root / "sub").mkdir(parents=True)
    (root / "bulk").mkdir()
    files: dict[str, bytes] = {
        "a_lf.txt": b"first line\nneedle here\nhaystack\n  needle\nlast needle",
        "b_crlf.txt": b"needle one\r\nplain\r\nneedle two\r\n",
        "c_cr.txt": b"needle cr\rplain cr\rend needle\r",
        "d_bom.txt": b"\xef\xbb\xbfneedle after bom\nneedle second\n",
        "e_invalid.txt": b"ok needle \xc3\x28 bad\n\xff\xfe raw bad bytes\nneedle tail \xe2\x82",
        "f_long.txt": (b"x" * 2000 + b" deepneedle " + b"y" * 1000 + b"\nshort needle\n"),
        "g_empty.txt": b"",
        "h_nul.txt": b"binarytext\x00needle\n",
        "h_control.txt": b"binarytext " + bytes(range(1, 9)) * 4 + b" needle\n",
        "i_big.txt": b"needle big\n" * 500,
        "i_big_binary.txt": b"\x00" + b"binarytext needle\n" * 400,
        "j_many.txt": b"".join(b"line %d needle\n" % index for index in range(200)),
        "k_unicode.txt": "naïve café NEEDLE ſ needle #tag\n".encode(),
        "n_ufffd.txt": "real � char needle\n".encode(),
        ".hidden.txt": b"hidden needle\n",
        "o_image.png": b"\x89PNG\r\n\x1a\nneedle",
    }
    for index in range(10):
        files[f"sub/f{index}.py"] = (
            b"def needle_%d():\n    return 'needle'\n" % index if index % 3 else b"pass\n"
        )
    for index in range(24):  # enough matching output to hit the 20 KB cap across files
        files[f"bulk/b{index:02d}.txt"] = b"".join(
            b"line %02d of bulk, padded so the output budget runs out before the match cap\n" % n
            for n in range(50)
        )
    for name, data in files.items():
        (root / name).write_bytes(data)
    _write_pdf(root / "m_doc.pdf")


def _write_pdf(path: Path) -> None:
    try:
        import fitz
    except ImportError:  # the PDF add-on is optional; the golden was recorded with it
        return
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((36, 60), "pdfneedle on a page", fontsize=11)
    document.save(path)
    document.close()


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


def run_cases(root: Path, search: Callable[[dict[str, object], WorkspaceGuard], Any]) -> list[dict]:
    guard = WorkspaceGuard(str(root))
    return [_snapshot(lambda case=case: search(dict(case), guard)) for case in CASES]


def per_file_reference(arguments: dict[str, object], workspace: WorkspaceGuard) -> Any:
    """The pre-row-124 loop: one worker request per file, no runtime budget."""
    compiled = gs._compile_pattern(arguments)
    search_root = gs._resolve_search_root(arguments, workspace)
    include = gs._bounded_include_patterns(gs._optional_string(arguments.get("include_glob")))
    context_lines = gs._bounded_int(
        arguments.get("context_lines"), default=0, maximum=gs.MAX_CONTEXT_LINES
    )
    state = gs._SearchState(
        max_results=gs._bounded_int(
            arguments.get("max_results"), default=gs.DEFAULT_MAX_RESULTS, maximum=gs.MAX_RESULTS
        ),
        searched_root=search_root.relative_to(workspace.require_root()).as_posix(),
    )
    started = gs._monotonic_seconds()
    ignore_filter = gs.load_search_ignore_filter(search_root)
    worker = gs._RegexSearchWorker()
    try:
        for candidate in gs._iter_candidate_files(
            search_root, workspace, include, ignore_filter=ignore_filter
        ):
            state.selected_files += 1
            try:
                keep_going = _reference_candidate(
                    candidate, compiled, workspace, context_lines, state, worker, started
                )
            except ToolExecutionFailure as error:
                gs._skip_unreadable(state, error)
                continue
            state.consecutive_unreadable_files = 0
            if not keep_going:
                break
    finally:
        worker.close()
    if ignore_filter is not None:
        state.ignored_directories_skipped = ignore_filter.skipped_directories
    return gs._build_result(pattern=compiled.pattern, state=state)


def _reference_candidate(  # noqa: PLR0913
    candidate: Path, compiled: Any, workspace: WorkspaceGuard, context_lines: int,
    state: Any, worker: Any, started: float,
) -> bool:
    if candidate.suffix.lower() == ".pdf":
        return gs._search_pdf_candidate(
            candidate, compiled, workspace=workspace, context_lines=context_lines,
            state=state, worker=worker, started_at=started,
        )
    if is_binary_file(candidate):
        state.skipped_binary_files += 1
        return True
    if gs._skip_if_oversized(
        state, candidate, workspace, gs._max_search_file_bytes(), gs.LARGE_FILE_HINT
    ):
        return True
    try:
        result = worker.search(
            path=candidate, compiled=compiled, workspace_root=workspace.root,
            context_lines=context_lines, max_output_matches=state.remaining_output_matches,
            max_output_bytes=state.remaining_output_bytes,
            timeout_seconds=gs.REGEX_SEARCH_TIMEOUT_SECONDS,
        )
    except FutureTimeoutError:
        result = None
    state.candidate_files += 1
    if result is None:
        return gs._record_timeout(state, candidate)
    state.consume(result)
    return True


@pytest.fixture
def corpus(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path.resolve() / "workspace"
    build_corpus(root)
    monkeypatch.setitem(gs._SEARCH_SETTINGS, "max_search_file_bytes", SIZE_CAP)
    return root


def _force_batch_size(monkeypatch: pytest.MonkeyPatch, size: int) -> None:
    from sidecar.ai.tools.builtins import grep_search_worker

    monkeypatch.setattr(gs, "MAX_BATCH_FILES", size)
    monkeypatch.setattr(grep_search_worker, "MAX_BATCH_FILES", size)


@pytest.mark.skipif(os.name != "nt", reason="the golden was recorded on Windows desktop")
@pytest.mark.parametrize("batch_size", [1, 128])
def test_batched_scan_matches_the_pre_change_golden(
    corpus: Path, monkeypatch: pytest.MonkeyPatch, batch_size: int
) -> None:
    pytest.importorskip("fitz")
    _force_batch_size(monkeypatch, batch_size)
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))

    actual = run_cases(corpus, gs.grep_search_tool)

    assert len(golden) == len(CASES)
    for case, expected, got in zip(CASES, golden, actual, strict=True):
        assert got == expected, case


def test_batched_scan_matches_the_per_file_loop(
    corpus: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _force_batch_size(monkeypatch, 3)

    expected = run_cases(corpus, per_file_reference)
    actual = run_cases(corpus, gs.grep_search_tool)

    for case, want, got in zip(CASES, expected, actual, strict=True):
        assert got == want, case


@pytest.mark.skipif(os.name == "nt", reason="hosted file IO is descriptor-relative POSIX only")
def test_hosted_batched_scan_matches_the_hosted_per_file_loop(
    corpus: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sidecar.ai.tools.hosted_file_io import scoped_hosted_file_io

    _force_batch_size(monkeypatch, 3)
    with scoped_hosted_file_io(str(corpus), enabled=True):
        expected = run_cases(corpus, per_file_reference)
        actual = run_cases(corpus, gs.grep_search_tool)

    for case, want, got in zip(CASES, expected, actual, strict=True):
        assert got == want, case


def test_a_timeout_mid_batch_resends_the_rest_to_a_fresh_worker(
    corpus: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _force_batch_size(monkeypatch, 4)
    original = gs._RegexSearchWorker.receive
    calls = {"count": 0}

    def flaky(self: Any, timeout_seconds: float) -> object:
        calls["count"] += 1
        if calls["count"] == 2:  # the second text file's answer
            self._reset(force=True)
            raise FutureTimeoutError
        return original(self, timeout_seconds)

    monkeypatch.setattr(gs._RegexSearchWorker, "receive", flaky)

    result = gs.grep_search_tool({"pattern": "needle"}, WorkspaceGuard(str(corpus)))

    # Walk order: .hidden.txt, a_lf.txt, b_crlf.txt, ...; the second answer timed out.
    assert result.metadata["timed_out_files"] == 1
    assert "a_lf.txt" not in result.output
    assert ".hidden.txt:1:hidden needle" in result.output
    assert "b_crlf.txt:1:needle one" in result.output  # same batch, after the restart
    # Every later file was still scanned: the golden's 229 less a_lf.txt's three.
    assert result.metadata["total_match_count"] == 226


if __name__ == "__main__":
    # Golden recording: run against the code the golden must describe.
    import tempfile

    target = Path(sys.argv[sys.argv.index("--write-golden") + 1])
    with tempfile.TemporaryDirectory() as scratch:
        workspace = Path(scratch).resolve() / "workspace"
        build_corpus(workspace)
        gs._SEARCH_SETTINGS["max_search_file_bytes"] = SIZE_CAP
        snapshots = run_cases(workspace, gs.grep_search_tool)
    target.write_text(json.dumps(snapshots, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(snapshots)} snapshots to {target}")
