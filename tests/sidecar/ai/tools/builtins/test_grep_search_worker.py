"""The grep worker's batched scan (row 124 P1): one answer per file, one open per file."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED, CMP_TOOL_OUTSIDE_WORKSPACE
from sidecar.ai.tools.builtins import grep_search as grep_module
from sidecar.ai.tools.builtins import grep_search_worker
from sidecar.ai.tools.builtins.grep_search_worker import (
    SCAN_BATCH_OP,
    literal_alternatives,
    run_scan_batch_request,
)
from tests.sidecar._platform_skips import make_dir_link

REPO_ROOT = Path(__file__).resolve().parents[5]


def _batch(root: Path, files: list[Path], pattern: str = "needle", **extra: object) -> list[dict]:
    responses: list[dict] = []
    request: dict[str, object] = {
        "op": SCAN_BATCH_OP,
        "files": [str(path) for path in files],
        "pattern": pattern,
        "flags": int(re.compile(pattern).flags),
        "workspace_root": str(root),
        "context_lines": 0,
        "max_output_matches": 100,
        "max_output_bytes": 20_000,
        "max_file_bytes": 1024,
        **extra,
    }
    run_scan_batch_request(request, responses.append)
    return responses


@pytest.mark.parametrize(
    ("pattern", "flags", "expected"),
    [
        ("needle", 0, (b"needle",)),
        ("a b#c:-=", 0, (b"a b#c:-=",)),
        ("café|naïve", re.UNICODE, ("café".encode(), "naïve".encode())),
        ("needle", re.IGNORECASE, None),
        ("needle|", 0, None),
        ("|needle", 0, None),
        ("", 0, None),
        ("need.e", 0, None),
        ("^needle", 0, None),
        ("needle$", 0, None),
        (r"needle\b", 0, None),
        ("(needle)", 0, None),
        ("needle+", 0, None),
        ("x{2}", 0, None),
        ("[ab]", 0, None),
        ("�", 0, None),
        ("a\nb", 0, None),
        ("a\ud800b", 0, None),
    ],
)
def test_literal_alternatives_accepts_only_plain_text(
    pattern: str, flags: int, expected: tuple[bytes, ...] | None
) -> None:
    assert literal_alternatives(pattern, flags) == expected


def test_literal_prefilter_never_hides_a_matching_line() -> None:
    samples = [
        "needle".encode(), b"nee\xffdle needle", b"\xef\xbb\xbfneedle", b"ne\r\nedle",
        "café".encode("latin-1"), "café".encode(), b"\xc3needle\xa9", b"",
    ]
    for pattern in ("needle", "café", "dle|caf", "edle"):
        literals = literal_alternatives(pattern, re.compile(pattern).flags)
        assert literals is not None
        compiled = re.compile(pattern)
        for raw in samples:
            text = raw.decode("utf-8", errors="replace")
            lines = re.split(r"(?<=\r\n)|(?<=\n)|(?<=\r)(?!\n)", text)
            any_line = any(compiled.search(line) for line in lines)
            if any_line:
                assert any(item in raw for item in literals), (pattern, raw)


def test_batch_answers_every_file_in_order(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    (root / "a.txt").write_bytes(b"one needle\r\ntwo\r\n")
    (root / "b.txt").write_bytes(b"\x00binary needle")
    (root / "c.txt").write_bytes(b"needle\n" * 300)  # over the 1024-byte cap
    (root / "d.txt").write_bytes(b"")
    (root / "e.txt").write_bytes(b"no match here\n")
    files = [root / name for name in ("a.txt", "b.txt", "c.txt", "missing.txt", "d.txt", "e.txt")]

    responses = _batch(root, files)

    assert [response["status"] for response in responses] == [
        "ok", "binary", "large", "error", "ok", "ok",
    ]
    assert responses[0]["lines"] == ["a.txt:1:one needle"]
    assert responses[3]["error_code"] == CMP_TOOL_IO_FAILED
    assert responses[3]["retryable"] is True
    assert responses[4]["total_match_count"] == 0
    assert responses[5]["total_match_count"] == 0


def test_batch_carries_the_output_caps_from_file_to_file(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    for name in ("a.txt", "b.txt", "c.txt"):
        (root / name).write_bytes(b"needle 1\nneedle 2\nneedle 3\n")

    responses = _batch(root, [root / "a.txt", root / "b.txt", root / "c.txt"], max_output_matches=4)

    assert [response["returned_match_count"] for response in responses] == [3, 1, 0]
    assert [response["total_match_count"] for response in responses] == [3, 3, 3]


def test_batch_refuses_a_handle_that_resolves_outside_the_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "workspace"
    sub = root / "sub"
    sub.mkdir(parents=True)
    target = sub / "file.txt"
    target.write_text("inside\n", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    marker = "outside-grep-marker"
    (outside / "file.txt").write_text(marker + "\n", encoding="utf-8")

    def swap_before_open(path: object, *args: object, **kwargs: object) -> object:
        target.unlink()
        sub.rmdir()
        make_dir_link(sub, outside)
        return open(path, *args, **kwargs)  # type: ignore[call-overload]

    monkeypatch.setattr(grep_search_worker, "open", swap_before_open, raising=False)

    responses = _batch(root.resolve(), [root.resolve() / "sub" / "file.txt"], pattern=marker)

    assert marker not in json.dumps(responses)
    assert responses == [{
        "status": "error",
        "error_code": CMP_TOOL_OUTSIDE_WORKSPACE,
        "message": "resolved path escapes tools workspace root",
        "retryable": False,
    }]


def test_an_invalid_batch_gets_one_error() -> None:
    responses: list[dict] = []
    run_scan_batch_request({"op": SCAN_BATCH_OP, "files": "not-a-list"}, responses.append)
    assert len(responses) == 1
    assert responses[0]["status"] == "error"


def test_a_worker_without_utf8_environment_still_speaks_utf8(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    (root / "bom.txt").write_bytes(b"\xef\xbb\xbfneedle \xe2\x9c\x93 \xff\n")
    env = {k: v for k, v in os.environ.items() if k not in {"PYTHONIOENCODING", "PYTHONUTF8"}}
    request = {
        "op": SCAN_BATCH_OP, "files": [str(root / "bom.txt")], "pattern": "needle", "flags": 32,
        "workspace_root": str(root), "context_lines": 0, "max_output_matches": 10,
        "max_output_bytes": 1000, "max_file_bytes": 1024,
    }
    done = subprocess.run(
        [sys.executable, "-m", "sidecar", "--grep-search-worker"],
        input=json.dumps(request, ensure_ascii=False) + "\nnull\n",
        capture_output=True, text=True, encoding="utf-8", env=env, cwd=REPO_ROOT,
        timeout=60, check=False,
    )
    assert done.returncode == 0, done.stderr
    ready, answer = (json.loads(line) for line in done.stdout.splitlines())
    assert ready == {"status": "ready"}
    assert answer["lines"] == ["bom.txt:1:﻿needle ✓ �"]


def test_closing_a_worker_mid_batch_does_not_wait_for_the_batch(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    files = []
    for index in range(50):
        path = root / f"f{index:02d}.txt"
        path.write_bytes(b"needle\n")
        files.append(path)
    worker = grep_module._RegexSearchWorker()
    outcomes = grep_module._scan_text_batches(
        worker, files, re.compile("needle"), workspace_root=root, context_lines=0,
        max_output_matches=100, max_output_bytes=20_000, max_file_bytes=1024,
        timeout_seconds=5.0,
    )
    first = next(outcomes)
    process = worker._process
    assert first.kind == "result"
    assert worker._outstanding == len(files) - 1
    outcomes.close()
    worker.close()
    assert worker._process is None
    assert worker._outstanding == 0
    assert process is not None
    assert process.poll() is not None


def test_any_read_failure_is_that_files_error_and_the_batch_goes_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The old per-file path counted any exception as one unreadable file.
    files = [tmp_path / "a.txt", tmp_path / "b.txt"]
    for path in files:
        path.write_text("needle\n", encoding="utf-8")
    real_open = open

    def open_or_fail(path: object, *args: object, **kwargs: object) -> object:
        if str(path).endswith("a.txt"):
            raise ValueError("odd handle")
        return real_open(path, *args, **kwargs)  # type: ignore[call-overload]

    monkeypatch.setattr(grep_search_worker, "open", open_or_fail, raising=False)

    responses = _batch(tmp_path, files)

    assert [response["status"] for response in responses] == ["error", "ok"]
    assert responses[0]["error_code"] == CMP_TOOL_IO_FAILED
    assert responses[0]["message"] == "grep worker failed: odd handle"
    assert responses[1]["total_match_count"] == 1


def test_a_chunk_budgets_the_encoded_path_length() -> None:
    # Windows separators double when JSON-encoded; the budget counts what is sent.
    path = Path("/".join(["a"] * 500))
    chunk = grep_search_worker._next_chunk([path] * 100, 0)
    sent = sum(len(json.dumps(str(item), ensure_ascii=False)) + 1 for item in chunk)
    assert 0 < len(chunk) < 100
    assert sent <= grep_search_worker.MAX_BATCH_PATH_CHARS


def test_a_batch_resolves_the_workspace_root_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    files = [tmp_path / f"f{index}.txt" for index in range(5)]
    for path in files:
        path.write_text("needle\n", encoding="utf-8")
    calls: list[Path] = []
    real_resolve = grep_search_worker.resolve_final_root

    def counting(root: Path) -> object:
        calls.append(root)
        return real_resolve(root)

    monkeypatch.setattr(grep_search_worker, "resolve_final_root", counting)

    responses = _batch(tmp_path.resolve(), files)

    assert [response["total_match_count"] for response in responses] == [1] * 5
    assert calls == [tmp_path.resolve()]


def test_a_prestarted_worker_answers_its_first_batch(tmp_path: Path) -> None:
    files = [tmp_path / "a.txt", tmp_path / "b.txt"]
    for path in files:
        path.write_text("needle\n", encoding="utf-8")
    worker = grep_module._RegexSearchWorker()
    worker.prestart()
    try:
        assert worker._process is not None
        outcomes = list(grep_module._scan_text_batches(
            worker, files, re.compile("needle"), workspace_root=tmp_path, context_lines=0,
            max_output_matches=100, max_output_bytes=20_000, max_file_bytes=1024,
            timeout_seconds=5.0,
        ))
    finally:
        worker.close()
    assert [outcome.kind for outcome in outcomes] == ["result", "result"]


def test_closing_an_unused_prestarted_worker_kills_it_at_once() -> None:
    worker = grep_module._RegexSearchWorker()
    worker.prestart()
    process = worker._process
    assert process is not None
    started = time.monotonic()
    worker.close()
    assert time.monotonic() - started < 1.0
    assert worker._process is None
    assert process.poll() is not None


def test_a_prestart_spawn_failure_is_reported_on_first_use() -> None:
    def refuse(*_args: object, **_kwargs: object) -> object:
        raise OSError("no such program")

    worker = grep_module._RegexSearchWorker(popen_factory=refuse)  # type: ignore[arg-type]
    worker.prestart()
    assert worker._process is None
    with pytest.raises(grep_module._WorkerUnavailable, match="failed to start: no such program"):
        worker.send({"op": SCAN_BATCH_OP, "files": []})
