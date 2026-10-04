from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from scripts.observe import prefix_reuse_report as report
from sidecar.ai.context import prefix_stability as ps
from sidecar.ai.routing import generation_diagnostics as gd
from sidecar.runtime.diagnostics import StructuredLogFormatter
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore

_START = datetime(2026, 9, 29, 12, tzinfo=UTC)


def _emit(
    store: TurnDiagnosticsStore,
    request_id: str,
    split: tuple[int, int],
    observation: ps.PrefixObservation,
    iteration: int,
) -> None:
    cached, evaluated = split
    store.record_provider_request(
        request_id=request_id,
        think_enabled=False,
        num_predict=None,
        temperature=0.0,
        message_count=2,
        tool_count=1,
        tool_capable=True,
    )
    store.record_provider_usage(
        request_id=request_id,
        prompt_eval_count=cached + evaluated,
        eval_count=5,
        cached_tokens=cached,
        prompt_tokens_evaluated=evaluated,
        prompt_eval_duration_ns=evaluated * 1_000_000,
        provider_label="openai-compatible",
    )
    gd.record_prefix_reuse(
        store,
        gd.PrefixReuseRecord(
            request_id=request_id,
            observation=observation,
            engine_type="openai-compatible",
            model="bonsai",
            iteration=iteration,
        ),
    )


@pytest.fixture
def log_file(tmp_path: Path):
    """Write real ``ai.router.prefix_reuse`` lines through the production formatter."""
    path = tmp_path / "sidecar.log"
    handler = logging.FileHandler(path, encoding="utf-8")
    handler.setFormatter(StructuredLogFormatter())
    gd.logger.addHandler(handler)
    previous_level = gd.logger.level
    gd.logger.setLevel(logging.INFO)
    meter = ps.PrefixStabilityMeter()
    tools = [{"name": "read_file"}]
    rows = [{"role": "user", "content": "build it"}]
    try:
        store = TurnDiagnosticsStore()
        store.begin_turn(request_id="req-turn-1", session_id="s", mode="assist")
        first = meter.observe("s", system_prompt="sys", tool_schemas=tools, messages=rows)
        _emit(store, "req-turn-1", (0, 4000), first, 0)
        rows = [
            *rows,
            {"role": "assistant", "content": "", "tool_calls": [{"id": "1"}]},
            {"role": "tool", "content": "file body", "tool_call_id": "1"},
        ]
        second = meter.observe("s", system_prompt="sys", tool_schemas=tools, messages=rows)
        _emit(store, "req-turn-1", (3900, 300), second, 1)
        store.begin_turn(request_id="req-turn-2", session_id="s", mode="assist")
        third = meter.observe(
            "s",
            system_prompt="sys v2",
            tool_schemas=tools,
            messages=[*rows, {"role": "user", "content": "next"}],
        )
        _emit(store, "req-turn-2", (10, 4400), third, 0)
    finally:
        gd.logger.removeHandler(handler)
        gd.logger.setLevel(previous_level)
        handler.close()
    return path


def test_rows_pair_client_and_server_per_call(log_file: Path) -> None:
    rows = report.call_rows(report.load_events(report.iter_log_files(log_file)))

    assert [row["phase"] for row in rows] == ["turn_start", "continuation", "turn_start"]
    assert [row["divergence"] for row in rows] == ["first", "append", "break"]
    assert rows[2]["first_changed"] == "system"
    assert rows[1]["reused"] == 3900
    assert rows[1]["prompt_tokens"] == 4200
    assert rows[1]["ratio"] == pytest.approx(0.9286, abs=1e-4)
    assert rows[1]["prefill_ms"] == 300


def test_summary_splits_turn_starts_from_continuations(log_file: Path) -> None:
    rows = report.call_rows(report.load_events(report.iter_log_files(log_file)))
    summary = report.summarize(rows)

    engine = summary["by_engine"]["openai-compatible"]
    assert engine["all"]["calls"] == 3
    assert engine["continuation"]["calls"] == 1
    assert engine["turn_start"]["prefill_ms"]["total"] == 4000 + 4400
    assert summary["divergence"] == {"first": 1, "append": 1, "break": 1}
    assert summary["first_changed"] == {"system": 1}


def test_main_prints_table_and_json(log_file: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert report.main(["--log", str(log_file), "--json"]) == 0
    assert '"by_engine"' in capsys.readouterr().out
    assert report.main(["--log", str(log_file)]) == 0
    assert capsys.readouterr().out.startswith("ts\trequest_id\tphase")


def _log_line(event: str, *, second: int) -> str:
    record = logging.LogRecord("sidecar.test", logging.INFO, "", 0, "test", (), None)
    record.created = (_START + timedelta(seconds=second)).timestamp()
    record.event = event
    record.data = {}
    return StructuredLogFormatter().format(record) + "\n"


def test_rotations_read_oldest_first_and_since_filters(tmp_path: Path) -> None:
    active = tmp_path / "sidecar.log"
    rotated = tmp_path / "sidecar.log.1"
    older = tmp_path / "sidecar.log.12"
    staged = tmp_path / "sidecar.log.rotating-123"
    older.write_text(_log_line("oldest", second=-10))
    rotated.write_text(_log_line("rotated", second=1) + 'junk\n[]\n{"event":"x","ts":"bad","data":{}}\n')
    staged.write_text(_log_line("staged", second=2))
    active.write_text(_log_line("active", second=4) + '{"event":"partial"')
    for name in ("sidecar.log.old", "sidecar.log.1.bak", "other.log.2"):
        (tmp_path / name).write_text("junk")

    files = report.iter_log_files(active)
    assert files == [older, rotated, staged, active]
    assert [event["event"] for event in report.load_events(files)] == [
        "oldest", "rotated", "staged", "active",
    ]
    since = report.load_events(files, since=_START + timedelta(seconds=2))
    assert [event["event"] for event in since] == ["staged", "active"]
    # A naive bound means UTC.
    assert len(report.load_events(files, since=datetime(2026, 9, 29, 12, 0, 4))) == 1


def test_percentiles_and_number_guard() -> None:
    assert report._percentiles([]) == {"p50": None, "p95": None}
    assert report._percentiles([10.0, 20.0, 30.0])["p50"] == 20.0
    assert report._number(3) and report._number(2.5)
    assert not report._number(float("nan")) and not report._number(True) and not report._number("3")
