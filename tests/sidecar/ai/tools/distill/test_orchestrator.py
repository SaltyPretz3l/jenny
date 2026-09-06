"""Tests for the distill orchestrator (distill_command_output).

RED-FIRST: authored before the orchestrator exists in
``sidecar/ai/tools/distill/__init__.py``.

Pins the four guarantees + the redaction contract:
  (a) errors-first  — every raw error line survives + a marker appears
  (b) net-positive  — small/clean output passes through unchanged, nothing stored
  (c) fallback-raw  — a filter that raises → raw returned, nothing lost
  (d) recoverable   — the marker points at the persisted complete output placeholder
  (e) redaction     — the orchestrator operates on already-redacted bytes and
                      never re-introduces content (store holds only what it was fed)
"""

from __future__ import annotations

import hashlib
import sqlite3
import zlib
from pathlib import Path

from sidecar.ai.tools import distill
from sidecar.ai.tools.distill import distill_command_output
from sidecar.ai.tools.distill.filters.base import DistillOutput
from sidecar.ai.tools.distill.omission_store import OmissionStore


def _store(tmp_path: Path) -> OmissionStore:
    return OmissionStore(tmp_path / "omissions" / "omissions.db")


def _row_count(store: OmissionStore) -> int:
    conn = sqlite3.connect(str(store.db_path))
    try:
        return int(conn.execute("SELECT COUNT(*) FROM omissions").fetchone()[0])
    finally:
        conn.close()


def _stored_refs(store: OmissionStore) -> list[str]:
    conn = sqlite3.connect(str(store.db_path))
    try:
        return [str(row[0]) for row in conn.execute("SELECT ref FROM omissions ORDER BY ref")]
    finally:
        conn.close()


def _stored_content(store: OmissionStore, ref: str) -> str | None:
    conn = sqlite3.connect(str(store.db_path))
    try:
        row = conn.execute("SELECT content FROM omissions WHERE ref=?", (ref,)).fetchone()
        return None if row is None else zlib.decompress(row[0]).decode("utf-8")
    finally:
        conn.close()


PYTEST_LOG = (
    "============================= test session starts =============================\n"
    "platform win32 -- Python 3.11.7\n"
    "rootdir: /repo\n"
    "collected 40 items\n"
    "\n"
    + "\n".join(f"tests/test_{i}.py .....                    [ {i}%]" for i in range(30))
    + "\n"
    "================================== FAILURES ===================================\n"
    "________________________________ test_broken _________________________________\n"
    ">       assert compute() == 42\n"
    "E       assert 0 == 42\n"
    "tests/test_x.py:9: AssertionError\n"
    "=========================== short test summary info ===========================\n"
    "FAILED tests/test_x.py::test_broken - assert 0 == 42\n"
    "========================= 1 failed, 39 passed in 0.42s =========================\n"
)


def test_errors_first_keeps_every_error_and_adds_marker(tmp_path: Path) -> None:
    store = _store(tmp_path)
    result = distill_command_output(
        stdout=PYTEST_LOG, stderr="", command="pytest", store=store, source="run_command"
    )
    assert ">       assert compute() == 42" in result.stdout
    assert "E       assert 0 == 42" in result.stdout
    assert "FAILED tests/test_x.py::test_broken - assert 0 == 42" in result.stdout
    assert "1 failed, 39 passed in 0.42s" in result.stdout
    assert "lines omitted" in result.stdout
    assert distill.FULL_OUTPUT_PATH_PLACEHOLDER in result.stdout
    # The collapsed progress parade is no longer inline.
    assert "tests/test_15.py ....." not in result.stdout


def test_net_positive_only_small_clean_output_unchanged(tmp_path: Path) -> None:
    store = _store(tmp_path)
    raw = "ok\nok\nok\nok\nok"
    result = distill_command_output(
        stdout=raw, stderr="", command="pytest", store=store, source="run_command"
    )
    assert result.stdout == raw  # marker would be bigger than the raw → no distill
    assert "[jenny#" not in result.stdout
    assert _row_count(store) == 0  # nothing stored when not net-positive


def test_unrecognized_command_passes_through(tmp_path: Path) -> None:
    store = _store(tmp_path)
    raw = "some arbitrary output\n" * 50
    result = distill_command_output(
        stdout=raw, stderr="", command="ls -la", store=store, source="run_command"
    )
    assert result.stdout == raw
    assert _row_count(store) == 0


def test_fallback_to_raw_when_filter_raises(tmp_path: Path, monkeypatch) -> None:
    class _Boom:
        name = "boom"

        def matches(self, *, command: str, content: str) -> bool:
            return True

        def distill(self, raw: str) -> DistillOutput:
            raise RuntimeError("filter blew up")

    monkeypatch.setattr(distill, "select_filter", lambda **_: _Boom())
    store = _store(tmp_path)
    result = distill_command_output(
        stdout=PYTEST_LOG, stderr="err text", command="pytest", store=store, source="x"
    )
    assert result.stdout == PYTEST_LOG  # raw, nothing lost
    assert result.stderr == "err text"
    assert _row_count(store) == 0


def test_internal_omission_record_preserves_exact_bytes(tmp_path: Path) -> None:
    store = _store(tmp_path)
    result = distill_command_output(
        stdout=PYTEST_LOG, stderr="", command="pytest", store=store, source="run_command"
    )
    refs = _stored_refs(store)
    assert len(refs) == 1
    ref = refs[0]
    restored = _stored_content(store, ref)
    assert restored is not None
    # The omitted parade is recoverable byte-for-byte...
    assert "tests/test_15.py ....." in restored
    # ...and was genuinely removed from the model-visible view.
    assert "tests/test_15.py ....." not in result.stdout


def test_same_command_segments_survive_tiny_size_cap(tmp_path: Path) -> None:
    # Regression pin (review C2): with per-segment opportunistic pruning, the
    # SECOND segment's put could size-evict the FIRST segment of the same
    # command, dangling its just-spliced marker. The orchestrator now stores
    # all segments then prunes once with the batch protected.
    store = OmissionStore(tmp_path / "omissions" / "omissions.db", max_mb=0.0002)
    parade_a = "\n".join(
        f"tests/a_{i} {hashlib.sha256(str(i).encode()).hexdigest()} ....." for i in range(30)
    )
    parade_b = "\n".join(
        f"tests/b_{i} {hashlib.sha256(str(i + 500).encode()).hexdigest()} ....." for i in range(30)
    )
    raw = (
        parade_a
        + "\nFAILED tests/a.py::t1 - boom\n"
        + parade_b
        + "\n1 failed, 59 passed in 1.00s\n"
    )
    distill_command_output(
        stdout=raw, stderr="", command="pytest", store=store, source="run_command"
    )
    refs = _stored_refs(store)
    assert len(refs) == 2  # both parades collapsed
    for ref in refs:
        assert _stored_content(store, ref) is not None  # NEITHER marker dangles


def test_stderr_only_distillation(tmp_path: Path) -> None:
    store = _store(tmp_path)
    result = distill_command_output(
        stdout="", stderr=PYTEST_LOG, command="./run.sh", store=store, source="run_command"
    )
    assert result.stdout == ""
    assert distill.FULL_OUTPUT_PATH_PLACEHOLDER in result.stderr
    refs = _stored_refs(store)
    assert len(refs) == 1
    assert _stored_content(store, refs[0]) is not None
    assert "FAILED tests/test_x.py::test_broken - assert 0 == 42" in result.stderr


def test_redaction_contract_no_reintroduction(tmp_path: Path) -> None:
    # The orchestrator receives ALREADY-redacted bytes; it must never synthesize
    # or un-redact content. Feed a redacted parade and confirm the store holds
    # only the redacted form and the pipeline is byte-conservative.
    store = _store(tmp_path)
    redacted_line = "config loaded token=[REDACTED] ok"
    raw = (
        "\n".join([redacted_line] * 40)
        + "\nFAILED tests/test_x.py::t - boom\n1 failed, 39 passed in 0.1s\n"
    )
    result = distill_command_output(
        stdout=raw, stderr="", command="pytest", store=store, source="run_command"
    )
    refs = _stored_refs(store)
    assert len(refs) == 1
    restored = _stored_content(store, refs[0])
    assert restored is not None
    # Only the redacted token form is present — nothing un-redacted appears.
    assert "[REDACTED]" in restored
    assert "sk-" not in restored and "sk-" not in result.stdout
