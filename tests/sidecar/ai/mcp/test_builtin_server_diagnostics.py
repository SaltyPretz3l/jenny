"""Builtin MCP logging persists structured tool metadata without argument content."""

import hashlib
import json
import logging
from pathlib import Path
from queue import Queue

import pytest

from sidecar.ai.mcp import builtin_server
from sidecar.runtime import diagnostics


@pytest.fixture(autouse=True)
def restore_logging():
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level
    child_levels = {name: logging.getLogger(name).level for name in ("httpx", "httpcore")}
    try:
        yield
    finally:
        diagnostics.shutdown_sidecar_logging()
        diagnostics.apply_logging_preferences({})
        root.handlers[:] = handlers
        root.setLevel(level)
        for name, child_level in child_levels.items():
            logging.getLogger(name).setLevel(child_level)


def _assert_tool_record(tmp_path: Path, mode: str) -> None:
    logs = tmp_path / ".companion" / "logs"
    # A separate file: a long-lived second handle on sidecar.log would block its rotation.
    assert not (logs / "sidecar.log").exists()
    text = (logs / "builtin-tools.log").read_text(encoding="utf-8")
    assert "SENTINEL_PRIVATE" not in text
    records = [json.loads(line) for line in text.splitlines()]
    record = next(item for item in records if item["event"] == "ai.tools.execution")
    assert record["schema_version"] == 1
    assert record["component"] == "ai.tools"
    assert record["redaction_mode"] == mode
    assert record["data"]["arguments"]["command"] == {
        "type": "string",
        "size": len("SENTINEL_PRIVATE"),
        "hash": hashlib.sha256(b"SENTINEL_PRIVATE").hexdigest()[:16],
    }


@pytest.mark.parametrize("mode", ["redacted", "sanitized_snippets"])
def test_logging_setup_writes_private_argument_projection(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys, mode: str,
) -> None:
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))

    assert builtin_server._configure_logging(log_level="debug", capture_mode=mode)
    diagnostics.log_tool_execution(
        builtin_server.logger, tool_name="run_command", arguments={"command": "SENTINEL_PRIVATE"},
        tool_output="safe output",
    )
    diagnostics.shutdown_sidecar_logging()

    _assert_tool_record(tmp_path, mode)
    assert capsys.readouterr() == ("", "")


@pytest.mark.parametrize("error_type", [RuntimeError, OSError])
def test_logging_setup_leaves_logging_unchanged_when_home_is_unavailable(
    monkeypatch: pytest.MonkeyPatch, error_type: type[Exception],
) -> None:
    def unavailable_home(cls):
        raise error_type("home unavailable")

    monkeypatch.setattr(Path, "home", classmethod(unavailable_home))
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level

    assert not builtin_server._configure_logging()

    assert root.handlers == handlers
    assert root.level == level


@pytest.mark.parametrize("use_flags", [False, True])
def test_main_configures_and_drains_logging_on_exit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys, use_flags: bool,
) -> None:
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(builtin_server, "configure_stdio", lambda: None)
    monkeypatch.setattr(builtin_server, "install_termination_handler", lambda: None)
    monkeypatch.setattr(builtin_server, "_default_tools", lambda **kwargs: {})
    inbox: Queue[str | None] = Queue()
    inbox.put('{"id": 1, "method": "ping"}')
    inbox.put(None)
    monkeypatch.setattr(builtin_server, "start_stdin_pump", lambda: inbox)

    def dispatch(*args):
        diagnostics.log_tool_execution(
            builtin_server.logger, tool_name="run_command",
            arguments={"command": "SENTINEL_PRIVATE"}, success=use_flags,
        )
        return {"id": 1, "result": {}}

    monkeypatch.setattr(builtin_server, "_dispatch_message", dispatch)
    argv = ["--workspace-root", str(tmp_path)]
    if use_flags:
        argv.extend([
            "--diagnostics-log-level", "debug",
            "--diagnostics-capture-mode", "sanitized_snippets",
        ])

    builtin_server.main(argv)

    _assert_tool_record(tmp_path, "sanitized_snippets" if use_flags else "redacted")
    assert diagnostics.shutdown_sidecar_logging()["drained"] is True
    stdout, stderr = capsys.readouterr()
    assert json.loads(stdout) == {"id": 1, "result": {}}
    assert stderr == ""
