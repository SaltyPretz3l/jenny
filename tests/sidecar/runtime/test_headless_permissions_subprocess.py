"""Real one-shot CLI permission boundary checks with isolated state."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def run_cli(tmp_path, *args, stdin=""):
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home),
           "PYTHONPATH": str(ROOT), "PYTHONIOENCODING": "utf-8"}
    return subprocess.run(
        [sys.executable, "-m", "sidecar", "--prompt", "Exercise the scripted tools.", *args],
        input=stdin, text=True, capture_output=True, cwd=tmp_path, env=env, timeout=45, check=False,
    )


@pytest.mark.parametrize("output_format", ["text", "json", "stream-json"])
@pytest.mark.parametrize("flag", ["--dangerously-skip-permissions", "--permission-mode=dangerously-skip"])
def test_piped_dangerous_mode_fails_before_config_or_runtime(tmp_path, output_format, flag):
    result = run_cli(tmp_path, flag, "--output-format", output_format,
                     "--config", str(tmp_path / "missing.json"), stdin="yes\n")
    assert result.returncode == 1
    output = result.stderr if output_format == "text" else result.stdout
    assert "requires interactive stdin" in output
    assert "missing.json" not in output
    assert not (tmp_path / "home" / ".companion").exists()
    if output_format != "text":
        assert len(result.stdout.splitlines()) == 1
        assert json.loads(result.stdout)["status"] == "error"


def replay_config(tmp_path, calls):
    script = tmp_path / "replay.json"
    script.write_text(json.dumps({"version": 1, "calls": calls}), encoding="utf-8")
    (tmp_path / "read.txt").write_text("read-sentinel-violet", encoding="utf-8")
    config = tmp_path / "config.json"
    config.write_text(json.dumps({
        "engine_type": "replay", "model": "replay-default", "mode": "assist",
        "replay_script_path": str(script), "replay_delay_ms": 0,
        "memory_db_path": str(tmp_path / "memory.db"),
        "tools_workspace_root": str(tmp_path), "tools_web_enabled": True,
        "tools_confirm_side_effects": True,
    }), encoding="utf-8")
    return config


def call(tool, arguments):
    return {"tool_calls": [{"tool_id": tool, "arguments": arguments}]}


def test_real_readonly_read_completes(tmp_path):
    config = replay_config(tmp_path, [call("read_file", {"path": "read.txt"}), {"text": "read complete"}])
    result = run_cli(tmp_path, "--config", str(config), "--auto-approve-readonly", "--output-format", "json")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "read-sentinel-violet" in result.stdout


@pytest.mark.parametrize("tool,arguments", [
    ("fetch_url", {"url": "http://127.0.0.1:1/permission-probe"}),
    ("web_search", {"query": "permission probe"}),
    ("write_file", {"path": "forbidden.txt", "content": "must not write"}),
])
def test_read_cannot_approve_later_network_or_write(tmp_path, tool, arguments):
    config = replay_config(tmp_path, [call("read_file", {"path": "read.txt"}),
                                      call(tool, arguments), {"text": "unexpected completion"}])
    result = run_cli(tmp_path, "--config", str(config), "--auto-approve-readonly", "--output-format", "json")
    assert result.returncode == 1, result.stdout + result.stderr
    envelope = json.loads(result.stdout)
    assert envelope["status"] == "denied", result.stdout
    executed = [row["tool_name"] for row in envelope["result"]["tool_observations"]
                if row["kind"] == "tool_execution_started"]
    assert executed == ["read_file"]
    assert not (tmp_path / "forbidden.txt").exists()


@pytest.mark.parametrize("answer,expected_status", [("yes", "completed"), ("no", "error")])
def test_real_tty_keeps_dangerous_confirmation(tmp_path, answer, expected_status):
    config = replay_config(tmp_path, [{"text": "tty confirmed"}])
    home = tmp_path / "home"
    home.mkdir()
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home), "PYTHONPATH": str(ROOT)}
    node = shutil.which("node")
    assert node, "TTY subprocess qualification needs the supported Node runtime"
    result = subprocess.run(
        [node, str(ROOT / "tests/helpers/headless-tty.cjs"), sys.executable,
         str(config), answer], capture_output=True, text=True, cwd=tmp_path, env=env, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    assert "Continue in dangerously-skip mode?" in output["output"]
    assert f'"status": "{expected_status}"' in output["output"]
    assert output["exitCode"] == (0 if answer == "yes" else 1)
    assert (home / ".companion" / "logs" / "sidecar.log").exists() == (answer == "yes")


@pytest.mark.parametrize("same_batch", [False, True])
@pytest.mark.parametrize("output_format", ["json", "stream-json"])
def test_regex_grant_does_not_leak_even_with_configured_blanket_auto(tmp_path, same_batch, output_format):
    read = call("read_file", {"path": "read.txt"})
    write = call("write_file", {"path": "forbidden.txt", "content": "must not write"})
    # Replay advances once per tool result, including the safely dropped tail.
    calls = ([{"tool_calls": read["tool_calls"] + write["tool_calls"]},
              {"text": "unused single-result slot"}, write] if same_batch else [read, write])
    config = replay_config(tmp_path, calls + [{"text": "unexpected completion"}])
    data = json.loads(config.read_text())
    data["tool_policy_snapshot"] = {"rules": [
        {"id": "blanket-auto", "decision": "auto", "match": {}}]}
    config.write_text(json.dumps(data), encoding="utf-8")
    result = run_cli(tmp_path, "--config", str(config), "--auto-approve-tools", "^read_file$",
                     "--output-format", output_format)
    envelope = json.loads(result.stdout.splitlines()[-1])
    assert result.returncode == 1, result.stdout + result.stderr
    assert envelope["status"] == "denied"
    executed = [row["tool_name"] for row in envelope["result"]["tool_observations"]
                if row["kind"] == "tool_execution_started"]
    assert executed == ["read_file"]
    assert not (tmp_path / "forbidden.txt").exists()
