from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import zlib
from contextlib import closing
from pathlib import Path

import pytest

from scripts.observe import session_log_export as exporter

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "tests/release-compat/fixtures"
TABLES = {"sessions", "turns", "tool_calls", "heuristic_fires", "compactions"}


def write_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8", newline="\n")


def frame(value):
    body = json.dumps(value, ensure_ascii=False).encode()
    return f"J1 {len(body)} {zlib.crc32(body):08x} ".encode() + body + b"\n"


def copy_profile(tmp_path, name="userdata-v24-current"):
    return Path(shutil.copytree(FIXTURES / name, tmp_path / name))


def test_release_journals(tmp_path):
    profile = copy_profile(tmp_path)
    loaded = exporter.load_session(profile / "sessions/sess_v23_journaled.json")
    session = loaded["session"]
    assert loaded["journal_status"] == "ok"
    assert len(session["messages"]) == 6
    assert len(session["turn_events"]) == 2
    assert session["suggested_changes"]
    second = exporter.load_session(profile / "sessions/sess_v23_second.json")
    assert second["journal_status"] == "ok"
    assert len(second["session"]["messages"]) == 2
    assert second["session"]["messages"][0]["content"] == "Hello second chat"


def test_recovery_continuation(tmp_path):
    profile = copy_profile(tmp_path, "userdata-v24-journal-recovery")
    loaded = exporter.load_session(profile / "sessions/sess_v23_lost_rename.json")
    assert loaded["journal_status"] == "ok"
    assert len(loaded["session"]["messages"]) == 6
    assert any(m["content"] == "After the rename 1" for m in loaded["session"]["messages"])
    journal = profile / "sessions/sess_v23_lost_rename.1.journal"
    journal.write_bytes(journal.read_bytes() + b"J1 40 00000000 {\"t\":")
    stopped = exporter.load_session(profile / "sessions/sess_v23_lost_rename.json")
    assert stopped["journal_status"] == "torn_tail"
    assert len(stopped["session"]["messages"]) == 3


def test_torn_tail_and_crc_stop(tmp_path):
    profile = copy_profile(tmp_path)
    path = profile / "sessions/sess_v23_second.json"
    journal = path.with_suffix(".1.journal")
    original = journal.read_bytes()
    journal.write_bytes(original + frame({"t": "delta", "ops": []})[:12])
    loaded = exporter.load_session(path)
    assert loaded["journal_status"] == "torn_tail"
    assert len(loaded["session"]["messages"]) == 2
    bad = frame({"t": "delta", "ops": [{"o": "set", "k": "title", "v": "bad"}]})
    bad = bad.replace(b'"bad"', b'"BAD"')
    later = frame({"t": "delta", "ops": [{"o": "set", "k": "title", "v": "later"}]})
    journal.write_bytes(original + bad + later)
    loaded = exporter.load_session(path)
    assert loaded["journal_status"] == "corrupt"
    assert loaded["session"]["title"] == "Second chat"
    assert len(loaded["session"]["messages"]) == 2


def test_all_journal_ops_and_atomic_delta(tmp_path):
    path = tmp_path / "s.json"
    session = {"id": "s", "messages": [{"id": "old"}], "turn_events": [], "remove": True}
    write_json(path, {"journal_epoch": 1, "session": session})
    header = frame({"t": "header", "v": 1, "session_id": "s", "epoch": 1})
    ops = [
        {"o": "unset", "k": "remove"}, {"o": "mt", "n": 0},
        {"o": "m", "i": 0, "v": {"id": "new", "content": "café"}},
        {"o": "e", "i": 0, "v": {"kind": "system_notice"}}, {"o": "et", "n": 0},
    ]
    valid = header + frame({"t": "delta", "ops": ops})
    invalid = [{"o": "set", "k": "title", "v": "partial"}, {"o": "m", "i": 8, "v": {}}]
    path.with_suffix(".1.journal").write_bytes(valid + frame({"t": "delta", "ops": invalid}))
    loaded = exporter.load_session(path)
    assert loaded["journal_status"] == "torn_tail"
    assert loaded["session"] == {
        "id": "s", "messages": [{"id": "new", "content": "café"}], "turn_events": [],
    }
    write_json(path, session)
    assert exporter.load_session(path)["session"] == session
    assert exporter.load_session(path)["journal_status"] == "none"


def test_resumed_tool_deduplication(tmp_path):
    session = json.loads((ROOT / "tests/fixtures/resumed-paused-turn-session.json").read_bytes())
    path = tmp_path / "resumed.json"
    write_json(path, {"schema_version": 24, "session": session})
    session = exporter.load_session(path)["session"]
    rows = exporter.tool_call_rows(session)
    assert len(rows) == 1
    row = rows[0]
    result = next(m["tool_result"] for m in session["messages"] if m.get("tool_result"))
    assert row["turn_id"] == session["turn_id"]
    assert row["tool_name"] == "write_file"
    assert row["result_chars"] == len(result["output_text"])
    assert row["duration_ms"] == result["duration_ms"]
    assert row["is_error"] == 0
    assert exporter.turn_rows(session)[0]["n_tool_calls"] == 1
    latest = next(m for m in session["messages"] if m.get("tool_result"))
    session["messages"].append({**latest, "tool_result": {**result, "output_text": "latest"}})
    assert exporter.tool_call_rows(session)[0]["result_chars"] == len("latest")


@pytest.fixture
def synthetic():
    messages = [{"id": "u", "role": "user", "turn_id": "t", "timestamp": "01"}]
    for call_id, metadata in [
        ("a", {"output_truncated": True, "full_output_path": "scratch/full.txt"}),
        ("b", {"router_output_truncated": True}),
        ("c", {"failure_class": "timeout"}),
    ]:
        messages.extend([
            {"id": f"tool_use_stream_1_{call_id}", "role": "assistant", "kind": "tool_use",
             "turn_id": "t", "tool_call": {"call_id": call_id, "tool_name": "run_command",
                                           "input_json": '{"truncated":true}'}},
            {"id": f"result_{call_id}", "role": "tool", "kind": "tool_result", "turn_id": "t",
             "tool_result": {"call_id": call_id, "tool_name": "run_command", "metadata": metadata,
                             "output_text": "result", "is_error": call_id == "c",
                             "error_code": "CMP-TOOL-0001" if call_id == "c" else "",
                             "exit_code": 1 if call_id == "c" else 0, "duration_ms": 12}},
        ])
    messages.append({
        "id": "assistant_stream_1", "role": "assistant", "turn_id": "t", "timestamp": "02",
        "finalizedAt": "03", "status": "failed", "terminal_subcode": "loop_stop",
        "model_used": "local", "payload": {"heuristic_fire": {"name": "message_fire"}},
        "context_compactions": [{"strategy": "micro", "tokensBefore": 100, "tokensAfter": 40,
                                 "phase": "pre", "summaryStatus": "ok", "reasonCode": "budget",
                                 "droppedMessages": 2, "droppedBytes": 80, "summaryPersisted": True,
                                 "occurredAt": "02"}],
    })
    return {
        "id": "s", "title": "Synthetic", "created_at": "00", "updated_at": "03",
        "last_model_used": "local", "run_mode": "act", "messages": messages,
        "compaction_snapshot": {"origin": "manual", "strategy": "full", "tokens_before": 120,
                                "tokens_after": 30, "created_at": "04"},
        "turn_events": [
            {"event_id": "e", "turn_id": "t", "kind": "system_notice", "started_at": "03",
             "payload": {"heuristic_fire": {"name": "budget_guard"}}},
            {"event_id": "err", "turn_id": "t", "kind": "assistant_error"},
        ],
    }


def test_every_session_table(synthetic):
    session = exporter.session_rows(synthetic, schema_version=24)[0]
    assert session == {"session_id": "s", "source": "session", "schema_version": 24,
                       "title_chars": 9, "created_at": "00", "updated_at": "03",
                       "last_model_used": "local", "run_mode": "act", "journal_epoch": None,
                       "journal_status": "none", "message_count": 8}
    calls = exporter.tool_call_rows(synthetic)
    assert len(calls) == 3
    assert calls[0]["args_fingerprint"] == hashlib.sha256(b'{"truncated":true}').hexdigest()[:16]
    assert calls[0]["args_bytes"] == len(b'{"truncated":true}')
    assert [r["args_truncated"] for r in calls] == [1, 1, 1]
    assert [r["result_truncated"] for r in calls] == [1, 1, 0]
    assert calls[0]["full_output_path"] == "full.txt"
    assert calls[2]["error_code"] == "CMP-TOOL-0001"
    assert calls[2]["exit_code"] == calls[2]["is_error"] == 1
    fires = exporter.heuristic_fire_rows(synthetic)
    assert {r["signal"] for r in fires} == {
        "output_truncated", "router_output_truncated", "failure_class:timeout", "terminal:loop_stop",
        "system_notice", "assistant_error", "budget_guard", "message_fire",
    }
    fire = next(r for r in fires if r["signal"] == "budget_guard")
    assert fire == {"session_id": "s", "turn_id": "t", "source": "session",
                    "signal": "budget_guard", "ref_id": "e", "at": "03"}
    compact, snapshot = exporter.compaction_rows(synthetic)
    assert compact == {
        "session_id": "s", "turn_id": "t", "source": "session", "strategy": "micro",
        "origin": None, "phase": "pre", "summary_status": "ok", "reason_code": "budget",
        "tokens_before": 100, "tokens_after": 40, "dropped_messages": 2, "dropped_bytes": 80,
        "summary_persisted": 1, "occurred_at": "02",
    }
    assert snapshot["origin"] == "manual"
    assert snapshot["turn_id"] is None
    assert (snapshot["tokens_before"], snapshot["tokens_after"], snapshot["occurred_at"]) == (
        120, 30, "04",
    )
    assert exporter.turn_rows(synthetic) == [{
        "session_id": "s", "turn_id": "t", "source": "session", "started_at": "01",
        "finished_at": "03", "model_used": "local", "assistant_status": "failed",
        "terminal_subcode": "loop_stop", "n_tool_calls": 3, "n_compactions": 1,
        "passed": None, "total_tokens": None, "wall_s": None,
    }]


@pytest.mark.parametrize("signal", ["output_truncated", "router_output_truncated",
                                         "content_display_truncated", "full_output_path"])
def test_result_truncation_signals(signal):
    session = {"id": "s", "messages": [
        {"role": "assistant", "kind": "tool_use", "id": "tool_use_stream_with_under_call_id",
         "tool_call": {"call_id": "call_id", "input": {"b": 2, "a": "é"}}},
        {"role": "tool", "kind": "tool_result", "parent_stream_id": "stream_with_under",
         "tool_result": {"call_id": "call_id", "output_text": "abc", "metadata": {signal: True}}},
    ]}
    row = exporter.tool_call_rows(session)[0]
    assert row["turn_id"] == "stream_with_under"
    assert row["result_chars"] == 3
    assert row["result_truncated"] == 1
    canonical = json.dumps({"b": 2, "a": "é"}, sort_keys=True, separators=(",", ":")).encode()
    assert row["args_fingerprint"] == hashlib.sha256(canonical).hexdigest()[:16]
    assert row["args_bytes"] == len(canonical)


@pytest.mark.parametrize("output,external", [
    ('{"truncated":true,"full_output_path":"full"}', {}),
    ("short", {"output_text": {"path": "payload"}}),
])
def test_json_and_external_truncation(output, external):
    session = {"id": "s", "messages": [
        {"role": "tool", "kind": "tool_result", "turn_id": "t", "tool_result": {
            "call_id": "c", "output_text": output, "external_payloads": external,
        }},
    ]}
    row = exporter.tool_call_rows(session)[0]
    assert row["result_truncated"] == 1
    assert row["result_chars"] == len(output)
    assert row["full_output_path"] == ("full" if not external else None)


def test_bench_ndjson(tmp_path):
    bench = tmp_path / "bench.ndjson"
    run = {"kind": "run", "label": "base", "run_index": 2, "started_at": "now", "model": "local"}
    task = {"kind": "task", "run_label": "base", "run_index": 2, "task_id": "edit",
            "passed": True, "total_tokens": 90, "wall_s": 1.5, "tool_calls": 3,
            "tool_calls_by_name": {"read_file": 2, "edit_file": 1}, "heuristic_fires": {"guard": 2},
            "compactions": [{"strategy": "micro", "phase": "pre", "tokens_before": 100,
                             "tokens_after": 20, "summary_status": "ok", "reason_code": "budget"}],
            "truncations": 1}
    bench.write_text(json.dumps(run) + "\n" + json.dumps(task) + "\n", encoding="utf-8")
    rows = exporter.bench_rows(run, task)
    assert rows["sessions"][0]["session_id"] == "bench:base:r2:edit"
    assert rows["turns"][0]["passed"] == 1
    assert rows["turns"][0]["n_tool_calls"] == 3
    assert rows["turns"][0]["n_compactions"] == 1
    assert rows["turns"][0]["total_tokens"] == 90
    assert rows["turns"][0]["wall_s"] == 1.5
    assert {r["call_id"] for r in rows["tool_calls"]} == {"read_file#1", "read_file#2", "edit_file#1"}
    assert len(rows["heuristic_fires"]) == 2
    assert rows["compactions"][0]["origin"] == "bench"
    assert all(r["source"] == "bench" for t in TABLES - {"tool_calls"} for r in rows[t])
    for index, pattern in enumerate([str(bench), str(tmp_path), str(tmp_path / "*.ndjson")]):
        out = tmp_path / f"bench{index}.sqlite"
        counts = exporter.export_profile(tmp_path / "missing", out, bench_paths=[pattern],
                                         no_sessions=True)
        assert counts == {"sessions": 1, "turns": 1, "tool_calls": 3,
                          "heuristic_fires": 2, "compactions": 1}
        with closing(sqlite3.connect(out)) as db:
            assert db.execute("SELECT source FROM turns").fetchone() == ("bench",)


def snapshot_files(root):
    return {p.relative_to(root): (p.read_bytes(), p.stat().st_mtime_ns)
            for p in root.rglob("*") if p.is_file()}


def cli(*args):
    return subprocess.run([sys.executable, str(ROOT / "scripts/observe/session_log_export.py"),
                           *map(str, args)], capture_output=True, text=True, check=False)


def test_cli_read_only_and_output_policy(tmp_path, synthetic):
    profile = copy_profile(tmp_path)
    sessions = profile / "sessions"
    write_json(sessions / "synthetic.json", {"schema_version": 24, "session": synthetic})
    (sessions / "broken.json").write_bytes(b"{broken")
    (sessions / "ignored.txt").write_bytes(b"ignored")
    (sessions / "corrupt").mkdir()
    write_json(sessions / "corrupt/hidden.json", synthetic)
    before = snapshot_files(profile)
    out = tmp_path / "export.sqlite"
    result = cli("--user-data", profile, "--out", out)
    assert result.returncode == 0, result.stderr
    assert "broken" in result.stderr
    assert all(f"{table}:" in result.stdout for table in TABLES)
    assert snapshot_files(profile) == before
    with closing(sqlite3.connect(out)) as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert tables == TABLES
        assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 4
        assert db.execute("SELECT journal_status FROM sessions WHERE session_id='broken'").fetchone() == (
            "corrupt",
        )
        assert db.execute("SELECT COUNT(*) FROM tool_calls WHERE session_id='s'").fetchone() == (3,)
        for table in TABLES - {"sessions"}:
            indexes = list(db.execute(f"PRAGMA index_list({table})"))
            assert any([r[2] for r in db.execute(f"PRAGMA index_info('{i[1]}')")][:2]
                       == ["session_id", "turn_id"] for i in indexes)
    original = out.read_bytes()
    assert cli("--user-data", profile, "--out", out).returncode == 2
    assert out.read_bytes() == original
    assert cli("--user-data", profile, "--out", out, "--force").returncode == 0
    denied = cli("--user-data", profile, "--out", profile / "forbidden.sqlite", "--force")
    assert denied.returncode == 2
    assert "user-data" in denied.stderr
    assert snapshot_files(profile) == before


def test_out_resolves_inside_profile(tmp_path):
    profile = tmp_path / "profile"
    profile.mkdir()
    with pytest.raises(ValueError, match="user-data"):
        exporter.export_profile(profile, profile / "new" / ".." / "out.sqlite", no_sessions=True)
    assert list(profile.iterdir()) == []


def test_free_text_and_paths_stay_in_the_profile():
    session = {"id": "s", "title": "deploy with api_key=sk-secret", "messages": []}
    assert "sk-secret" not in json.dumps(exporter.session_rows(session))
    row = exporter._tool_row("s", "t", {}, {"output_text": "", "metadata": {
        "full_output_path": r"C:\Users\me\proj\.jenny\tool-results\run.txt"}})
    assert row["full_output_path"] == "run.txt"
