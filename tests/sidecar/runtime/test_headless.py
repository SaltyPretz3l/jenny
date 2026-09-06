from __future__ import annotations

import io
import json
from types import SimpleNamespace

import pytest

from sidecar.runtime import headless
from sidecar.runtime.chat_models import ChatResponse


class _TtyInput(io.StringIO):
    def isatty(self) -> bool:  # noqa: D401
        return True


class _FakeBrainContainer:
    instances: list["_FakeBrainContainer"] = []

    def __init__(self) -> None:
        self.configured: list[dict[str, object]] = []
        self.closed = False
        self.stack = SimpleNamespace()
        self.__class__.instances.append(self)

    def configure(self, raw_config: object):
        normalized = raw_config if isinstance(raw_config, dict) else {}
        self.configured.append({str(key): value for key, value in normalized.items()})
        return self.stack

    def close(self) -> None:
        self.closed = True


def _patch_runtime_plumbing(monkeypatch: pytest.MonkeyPatch) -> None:
    _FakeBrainContainer.instances = []
    monkeypatch.setattr(headless, "BrainContainer", _FakeBrainContainer)
    monkeypatch.setattr(headless, "configure_sidecar_logging", lambda *args, **kwargs: None)
    monkeypatch.setattr(headless, "shutdown_sidecar_logging", lambda: None)


def _completed_response() -> ChatResponse:
    return ChatResponse(
        request_id="req_test",
        result={"request_id": "req_test", "status": "completed"},
        notifications=[
            {
                "jsonrpc": "2.0",
                "method": "chat.token",
                "params": {"request_id": "req_test", "delta": "Hello "},
            },
            {
                "jsonrpc": "2.0",
                "method": "chat.token",
                "params": {"request_id": "req_test", "delta": "world"},
            },
            {
                "jsonrpc": "2.0",
                "method": "chat.done",
                "params": {"request_id": "req_test"},
            },
        ],
        approval_request=None,
    )


def test_headless_config_precedence_prefers_cwd_then_home(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cwd_dir = tmp_path / "cwd"
    home_dir = tmp_path / "home"
    cwd_dir.mkdir()
    home_dir.mkdir()
    (cwd_dir / "config.json").write_text('{"model":"cwd-model"}', encoding="utf-8")
    companion_dir = home_dir / ".companion"
    companion_dir.mkdir()
    (companion_dir / "config.json").write_text('{"model":"home-model"}', encoding="utf-8")

    _patch_runtime_plumbing(monkeypatch)
    monkeypatch.chdir(cwd_dir)
    monkeypatch.setattr(headless, "_home_dir", lambda: home_dir)
    monkeypatch.setattr(
        headless, "build_chat_send_response", lambda *args, **kwargs: _completed_response()
    )

    exit_code = headless.run_headless(["--prompt", "hello", "--output-format", "json"])

    assert exit_code == 0
    assert _FakeBrainContainer.instances
    assert _FakeBrainContainer.instances[0].configured[-1]["model"] == "cwd-model"


def test_headless_config_explicit_path_overrides_defaults(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cwd_dir = tmp_path / "cwd"
    home_dir = tmp_path / "home"
    explicit_path = tmp_path / "explicit.json"
    cwd_dir.mkdir()
    home_dir.mkdir()
    companion_dir = home_dir / ".companion"
    companion_dir.mkdir()
    (cwd_dir / "config.json").write_text('{"model":"cwd-model"}', encoding="utf-8")
    (companion_dir / "config.json").write_text('{"model":"home-model"}', encoding="utf-8")
    explicit_path.write_text('{"model":"explicit-model"}', encoding="utf-8")

    _patch_runtime_plumbing(monkeypatch)
    monkeypatch.chdir(cwd_dir)
    monkeypatch.setattr(headless, "_home_dir", lambda: home_dir)
    monkeypatch.setattr(
        headless, "build_chat_send_response", lambda *args, **kwargs: _completed_response()
    )

    exit_code = headless.run_headless(
        [
            "--prompt",
            "hello",
            "--config",
            str(explicit_path),
            "--output-format",
            "json",
        ]
    )

    assert exit_code == 0
    assert _FakeBrainContainer.instances[0].configured[-1]["model"] == "explicit-model"


def test_headless_text_output_emits_response_text_only(
    monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    _patch_runtime_plumbing(monkeypatch)
    monkeypatch.setattr(
        headless, "build_chat_send_response", lambda *args, **kwargs: _completed_response()
    )

    exit_code = headless.run_headless(["--prompt", "hello", "--output-format", "text"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert captured.out == "Hello world\n"


def test_headless_json_output_emits_single_result_envelope(
    monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    _patch_runtime_plumbing(monkeypatch)
    monkeypatch.setattr(
        headless, "build_chat_send_response", lambda *args, **kwargs: _completed_response()
    )

    exit_code = headless.run_headless(["--prompt", "hello", "--output-format", "json"])
    captured = capsys.readouterr()

    payload = json.loads(captured.out.strip())
    assert exit_code == 0
    assert payload["status"] == "completed"
    assert payload["response_text"] == "Hello world"
    assert isinstance(payload["notifications"], list)


def test_headless_stream_json_keeps_stdout_ndjson(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    _patch_runtime_plumbing(monkeypatch)

    def _fake_build(*args, **kwargs):
        writer = kwargs["notification_writer"]
        writer(
            {
                "jsonrpc": "2.0",
                "method": "chat.token",
                "params": {"request_id": "req_test", "delta": "Hello "},
            }
        )
        writer(
            {
                "jsonrpc": "2.0",
                "method": "chat.token",
                "params": {"request_id": "req_test", "delta": "world"},
            }
        )
        return ChatResponse(
            request_id="req_test",
            result={"request_id": "req_test", "status": "completed"},
            notifications=[
                {
                    "jsonrpc": "2.0",
                    "method": "chat.done",
                    "params": {"request_id": "req_test"},
                }
            ],
            approval_request=None,
        )

    monkeypatch.setattr(headless, "build_chat_send_response", _fake_build)

    exit_code = headless.run_headless(["--prompt", "hello", "--output-format", "stream-json"])
    captured = capsys.readouterr()
    lines = [line for line in captured.out.splitlines() if line.strip()]

    assert exit_code == 0
    parsed = [json.loads(line) for line in lines]
    assert all(isinstance(item, dict) for item in parsed)
    assert parsed[-1]["status"] == "completed"
    assert parsed[-1]["response_text"] == "Hello world"


def test_headless_prompt_mode_denies_when_user_rejects_approval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_runtime_plumbing(monkeypatch)
    monkeypatch.setattr(headless.sys, "stdin", _TtyInput("n\n"))
    call_count = {"value": 0}

    def _fake_build(*args, **kwargs):
        call_count["value"] += 1
        assert kwargs["approvals_pre_granted"] is False
        return ChatResponse(
            request_id="req_test",
            result={"request_id": "req_test", "status": "awaiting_approval"},
            notifications=[],
            approval_request={
                "request_id": "req_test",
                "tool_name": "write_file",
                "reason": "Needs approval",
                "tool_input": {"path": "notes.txt"},
                "mode": "assist",
            },
        )

    monkeypatch.setattr(headless, "build_chat_send_response", _fake_build)

    exit_code = headless.run_headless(["--prompt", "hello", "--output-format", "json"])

    assert exit_code == 1
    assert call_count["value"] == 1


def test_headless_auto_readonly_denies_side_effecting_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_runtime_plumbing(monkeypatch)
    call_count = {"value": 0}

    def _fake_build(*args, **kwargs):
        call_count["value"] += 1
        assert kwargs["approvals_pre_granted"] is False
        return ChatResponse(
            request_id="req_test",
            result={"request_id": "req_test", "status": "awaiting_approval"},
            notifications=[],
            approval_request={
                "request_id": "req_test",
                "tool_name": "write_file",
                "reason": "Needs approval",
                "tool_input": {"path": "notes.txt"},
                "mode": "assist",
            },
        )

    monkeypatch.setattr(headless, "build_chat_send_response", _fake_build)

    exit_code = headless.run_headless(
        ["--prompt", "hello", "--output-format", "json", "--permission-mode", "auto-readonly"]
    )

    assert exit_code == 1
    assert call_count["value"] == 1


def test_headless_auto_tools_regex_allows_matching_tool(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_runtime_plumbing(monkeypatch)
    call_count = {"value": 0}

    def _fake_build(*args, **kwargs):
        call_count["value"] += 1
        if call_count["value"] == 1:
            assert kwargs["approvals_pre_granted"] is False
            return ChatResponse(
                request_id="req_test",
                result={"request_id": "req_test", "status": "awaiting_approval"},
                notifications=[],
                approval_request={
                    "request_id": "req_test",
                    "tool_name": "write_file",
                    "reason": "Needs approval",
                    "tool_input": {"path": "notes.txt"},
                    "mode": "assist",
                },
            )
        assert kwargs["approvals_pre_granted"] is True
        return _completed_response()

    monkeypatch.setattr(headless, "build_chat_send_response", _fake_build)

    exit_code = headless.run_headless(
        [
            "--prompt",
            "hello",
            "--output-format",
            "json",
            "--auto-approve-tools",
            "^write_file$",
        ]
    )

    assert exit_code == 0
    assert call_count["value"] == 2


def test_headless_dangerous_mode_requires_confirmation(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_runtime_plumbing(monkeypatch)
    monkeypatch.setattr(headless.sys, "stdin", _TtyInput("n\n"))
    call_count = {"value": 0}

    def _fake_build(*args, **kwargs):
        call_count["value"] += 1
        return _completed_response()

    monkeypatch.setattr(headless, "build_chat_send_response", _fake_build)

    exit_code = headless.run_headless(
        ["--prompt", "hello", "--output-format", "json", "--dangerously-skip-permissions"]
    )

    assert exit_code == 1
    assert call_count["value"] == 0


def test_headless_approval_bridge_round_trip(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_runtime_plumbing(monkeypatch)

    def _fake_build(*args, **kwargs):
        approval_writer = kwargs["approval_writer"]
        approval_reader = kwargs["approval_reader"]
        approval_writer(
            {
                "jsonrpc": "2.0",
                "id": 321,
                "method": "tool.request_approval",
                "params": {
                    "tool_name": "read_file",
                    "reason": "Read request",
                    "tool_input": {"path": "README.md"},
                },
            }
        )
        approval_response = approval_reader(0.1)
        assert approval_response["id"] == 321
        assert approval_response["result"]["approved"] is True
        return _completed_response()

    monkeypatch.setattr(headless, "build_chat_send_response", _fake_build)

    exit_code = headless.run_headless(
        ["--prompt", "hello", "--output-format", "json", "--permission-mode", "auto-readonly"]
    )

    assert exit_code == 0
