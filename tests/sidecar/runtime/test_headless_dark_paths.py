"""Dark-path coverage for sidecar/runtime/headless.py.

Targets uncovered lines:
  94, 104, 115, 123, 134, 173, 261, 266, 282-283, 293, 306, 309,
  332-333, 336-337, 364, 369, 525-526, 535, 600, 613-618, 623,
  677-681, 687-689, 719-720
"""

from __future__ import annotations

import io
import json
import queue
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.runtime import headless
from sidecar.runtime.chat_models import ChatRequestError, ChatResponse


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


class _NonTtyInput(io.StringIO):
    """stdin stub that reports isatty() == False."""

    def isatty(self) -> bool:
        return False


class _TtyInput(io.StringIO):
    """stdin stub that reports isatty() == True."""

    def isatty(self) -> bool:
        return True


class _NoReadlineInput:
    """stdin stub where readline() returns a non-str (bytes), isatty True."""

    def isatty(self) -> bool:
        return True

    def readline(self) -> bytes:
        return b"y"


def _make_chat_error(
    code: str = "CMP-CHAT-0002",
    message: str = "something failed",
    request_id: str = "req_err",
) -> ChatRequestError:
    return ChatRequestError(
        request_id=request_id,
        trace_id=None,
        session_id=None,
        code=code,
        message=message,
        rpc_code=-32603,
        retryable=False,
    )


def _completed_response(request_id: str = "req_test") -> ChatResponse:
    return ChatResponse(
        request_id=request_id,
        result={"request_id": request_id, "status": "completed"},
        notifications=[
            {
                "jsonrpc": "2.0",
                "method": "chat.token",
                "params": {"request_id": request_id, "delta": "hi"},
            }
        ],
        approval_request=None,
    )


def _non_completed_response(status: str = "denied") -> ChatResponse:
    return ChatResponse(
        request_id="req_test",
        result={"request_id": "req_test", "status": status},
        notifications=[],
        approval_request=None,
    )


def _patch_runtime_plumbing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patch BrainContainer + logging so no real services are touched."""
    monkeypatch.setattr(headless, "configure_sidecar_logging", lambda *a, **kw: None)
    monkeypatch.setattr(headless, "shutdown_sidecar_logging", lambda: None)

    class _FakeBrain:
        calls: list[Any] = []

        def __init__(self) -> None:
            self.configured: list[dict] = []
            self.closed = False
            self.stack = SimpleNamespace()
            _FakeBrain.calls.append(self)

        def configure(self, raw_config: object) -> SimpleNamespace:
            self.configured.append(raw_config if isinstance(raw_config, dict) else {})
            return self.stack

        def close(self) -> None:
            self.closed = True

    _FakeBrain.calls = []
    monkeypatch.setattr(headless, "BrainContainer", _FakeBrain)


# ---------------------------------------------------------------------------
# Line 94 – _json_preview truncation branch
# ---------------------------------------------------------------------------


def test_json_preview_truncates_when_over_max_chars() -> None:
    """Line 94: the truncation branch of _json_preview is exercised."""
    payload = {"key": "x" * 400}
    result = headless._json_preview(payload, max_chars=50)
    # Must end with "..." (the truncation marker)
    assert result.endswith("...")
    # Must be exactly max_chars chars long
    assert len(result) == 50


def test_json_preview_does_not_truncate_when_within_max_chars() -> None:
    """Baseline: short payload is returned verbatim (no truncation)."""
    payload = {"k": "v"}
    result = headless._json_preview(payload, max_chars=300)
    assert "..." not in result
    assert json.loads(result) == payload


# ---------------------------------------------------------------------------
# Line 104 – _notification_token_text non-dict params branch
# ---------------------------------------------------------------------------


def test_notification_token_text_skips_non_dict_params() -> None:
    """Line 104: a notification whose params is not a dict must be skipped."""
    notifications = [
        {"method": "chat.token", "params": "not-a-dict"},  # non-dict params → line 104
        {"method": "chat.token", "params": {"delta": "hello"}},
    ]
    result = headless._notification_token_text(notifications)
    # Only the second notification contributes; the first is skipped
    assert result == "hello"


# ---------------------------------------------------------------------------
# Line 115 – _load_config_file non-dict payload → ValueError
# ---------------------------------------------------------------------------


def test_load_config_file_raises_value_error_on_non_dict(tmp_path: Path) -> None:
    """Line 115: a config file containing a JSON array triggers ValueError."""
    cfg = tmp_path / "list_config.json"
    cfg.write_text("[1, 2, 3]", encoding="utf-8")
    with pytest.raises(ValueError, match="config must be a JSON object"):
        headless._load_config_file(cfg)


# ---------------------------------------------------------------------------
# Line 123 – _load_raw_config explicit path missing → FileNotFoundError
# ---------------------------------------------------------------------------


def test_load_raw_config_explicit_path_missing_raises(tmp_path: Path) -> None:
    """Line 123: an explicit config path that doesn't exist raises FileNotFoundError."""
    missing = tmp_path / "no_such_config.json"
    with pytest.raises(FileNotFoundError, match="config file not found"):
        headless._load_raw_config(str(missing))


# ---------------------------------------------------------------------------
# Line 134 – _load_raw_config no candidates found → empty dict
# ---------------------------------------------------------------------------


def test_load_raw_config_returns_empty_dict_when_no_candidates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Line 134: when no default config files exist the function returns ({}, None)."""
    empty_cwd = tmp_path / "nocwd"
    empty_home = tmp_path / "nohome"
    empty_cwd.mkdir()
    empty_home.mkdir()

    monkeypatch.setattr(headless, "_cwd", lambda: empty_cwd)
    monkeypatch.setattr(headless, "_home_dir", lambda: empty_home)

    raw, source = headless._load_raw_config(None)
    assert raw == {}
    assert source is None


# ---------------------------------------------------------------------------
# Line 173 – resolve_permission_mode alias_count > 1 → ValueError
# ---------------------------------------------------------------------------


def test_resolve_permission_mode_raises_when_multiple_aliases_set() -> None:
    """Line 173: more than one alias flag raises ValueError."""
    with pytest.raises(ValueError, match="at most one permission alias"):
        headless.resolve_permission_mode(
            permission_mode="prompt",
            permission_mode_explicit=False,
            auto_approve_readonly=True,
            auto_approve_tools="^read_",
            dangerously_skip_permissions=False,
        )


# ---------------------------------------------------------------------------
# Line 261 – ApprovalPolicyEngine.decide DANGEROUS → True
# ---------------------------------------------------------------------------


def test_approval_policy_engine_dangerous_mode_always_approves() -> None:
    """Line 261: DANGEROUS mode returns True regardless of tool_name."""
    engine = headless.ApprovalPolicyEngine(
        mode="dangerously-skip",
        auto_tools_pattern=None,
        stdin=_NonTtyInput(),
    )
    result = engine.decide(
        tool_name="delete_everything",
        tool_input={"path": "/"},
        reason="test-example",
    )
    assert result is True


# ---------------------------------------------------------------------------
# Line 266 – ApprovalPolicyEngine.decide AUTO_READONLY allowlist miss → False
# ---------------------------------------------------------------------------


def test_approval_policy_engine_auto_readonly_denies_non_allowlisted_tool() -> None:
    """Line 266: auto-readonly mode returns False for tools not in the allowlist."""
    engine = headless.ApprovalPolicyEngine(
        mode="auto-readonly",
        auto_tools_pattern=None,
        stdin=_NonTtyInput(),
    )
    result = engine.decide(
        tool_name="write_file",
        tool_input={"path": "out.txt"},
        reason="",
    )
    assert result is False


def test_approval_policy_engine_auto_readonly_allows_allowlisted_tool() -> None:
    """Complementary: auto-readonly approves an allowlisted tool (read_file)."""
    engine = headless.ApprovalPolicyEngine(
        mode="auto-readonly",
        auto_tools_pattern=None,
        stdin=_NonTtyInput(),
    )
    result = engine.decide(tool_name="read_file", tool_input={}, reason="")
    assert result is True


# ---------------------------------------------------------------------------
# Lines 282-283 – _prompt_user non-tty stdin → deny
# ---------------------------------------------------------------------------


def test_prompt_user_denies_and_writes_stderr_when_non_tty(capsys) -> None:
    """Lines 282-283: non-interactive stdin causes _prompt_user to log and deny."""
    engine = headless.ApprovalPolicyEngine(
        mode="prompt",
        auto_tools_pattern=None,
        stdin=_NonTtyInput(""),
    )
    result = engine._prompt_user(
        tool_name="write_file",
        tool_input={"path": "x.txt"},
        reason="sample reason",
    )
    assert result is False
    captured = capsys.readouterr()
    assert "non-interactive" in captured.err


# ---------------------------------------------------------------------------
# Line 293 – _prompt_user readline returns non-str → False
# ---------------------------------------------------------------------------


def test_prompt_user_returns_false_when_readline_returns_bytes(capsys) -> None:
    """Line 293: when readline() returns non-str, _prompt_user returns False."""
    engine = headless.ApprovalPolicyEngine(
        mode="prompt",
        auto_tools_pattern=None,
        stdin=_NoReadlineInput(),
    )
    result = engine._prompt_user(
        tool_name="delete_file",
        tool_input={"path": "dummy.txt"},
        reason="",
    )
    assert result is False


# ---------------------------------------------------------------------------
# Lines 306, 309 – _prompt_user tty with 'y' / 'n' parse
# ---------------------------------------------------------------------------


def test_prompt_user_approves_when_user_types_y(capsys) -> None:
    """Lines 306/309: 'y' answer via tty stdin results in approval (True)."""
    engine = headless.ApprovalPolicyEngine(
        mode="prompt",
        auto_tools_pattern=None,
        stdin=_TtyInput("y\n"),
    )
    result = engine._prompt_user(
        tool_name="read_file",
        tool_input={},
        reason="",
    )
    assert result is True


def test_prompt_user_denies_when_user_types_n(capsys) -> None:
    """Line 309 (deny path): 'n' answer via tty stdin results in denial (False)."""
    engine = headless.ApprovalPolicyEngine(
        mode="prompt",
        auto_tools_pattern=None,
        stdin=_TtyInput("n\n"),
    )
    result = engine._prompt_user(
        tool_name="write_file",
        tool_input={"path": "sample.txt"},
        reason="",
    )
    assert result is False


# ---------------------------------------------------------------------------
# Lines 332-333 – ApprovalResponseBridge.read_message bad timeout → 0.0
# ---------------------------------------------------------------------------


def test_approval_response_bridge_bad_timeout_uses_zero() -> None:
    """Lines 332-333: non-numeric timeout falls back to 0.0 wait, raising TimeoutError."""
    policy = headless.ApprovalPolicyEngine(
        mode="auto-readonly",
        auto_tools_pattern=None,
        stdin=_NonTtyInput(),
    )
    bridge = headless.ApprovalResponseBridge(policy)
    # Pass a non-numeric timeout so the except branch (line 332-333) fires
    with pytest.raises(TimeoutError, match="timed out"):
        bridge.read_message("not-a-number")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Lines 336-337 – ApprovalResponseBridge.read_message queue.Empty → TimeoutError
# ---------------------------------------------------------------------------


def test_approval_response_bridge_empty_queue_raises_timeout_error() -> None:
    """Lines 336-337: an empty response queue raises TimeoutError."""
    policy = headless.ApprovalPolicyEngine(
        mode="auto-readonly",
        auto_tools_pattern=None,
        stdin=_NonTtyInput(),
    )
    bridge = headless.ApprovalResponseBridge(policy)
    with pytest.raises(TimeoutError, match="approval response timed out"):
        bridge.read_message(0.001)


# ---------------------------------------------------------------------------
# Line 364 – _confirm_dangerous_mode non-tty → True (no prompt)
# ---------------------------------------------------------------------------


def test_confirm_dangerous_mode_non_tty_returns_true(
    monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """Line 364: non-interactive stdin skips the prompt and returns True."""
    monkeypatch.setattr(headless.sys, "stdin", _NonTtyInput())
    result = headless._confirm_dangerous_mode(_NonTtyInput())
    assert result is True
    captured = capsys.readouterr()
    # Warning must still be emitted
    assert "WARNING" in captured.err


# ---------------------------------------------------------------------------
# Line 369 – _confirm_dangerous_mode readline returns non-str → False
# ---------------------------------------------------------------------------


def test_confirm_dangerous_mode_non_str_readline_returns_false() -> None:
    """Line 369: when readline() is non-str, _confirm_dangerous_mode returns False."""
    result = headless._confirm_dangerous_mode(_NoReadlineInput())
    assert result is False


# ---------------------------------------------------------------------------
# Lines 525-526 – _emit_runtime_error text branch → stderr + return 1
# ---------------------------------------------------------------------------


def test_emit_runtime_error_text_format_writes_stderr_and_returns_1(capsys) -> None:
    """Lines 525-526: text output format writes message to stderr and returns 1."""
    code = headless._emit_runtime_error(
        output_format="text",
        request_id="req_sample",
        code="CMP-CHAT-0002",
        message="sample error message",
    )
    captured = capsys.readouterr()
    assert code == 1
    assert "sample error message" in captured.err


# ---------------------------------------------------------------------------
# Line 535 – _preflight_permissions decline → non-None exit code
# ---------------------------------------------------------------------------


def test_preflight_permissions_returns_exit_code_on_decline(
    monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """Line 535: when dangerous mode confirmation is declined, returns non-None int."""
    monkeypatch.setattr(headless, "_confirm_dangerous_mode", lambda stdin: False)
    options = headless.HeadlessRunOptions(
        mode="dangerously-skip",
        auto_tools_pattern=None,
        output_format="json",
        prompt="hello",
        config_arg=None,
        request_id="req_example",
    )
    exit_code = headless._preflight_permissions(options)
    assert exit_code == 1


# ---------------------------------------------------------------------------
# Line 600 – _emit_success text format with non-"completed" status
# ---------------------------------------------------------------------------


def test_emit_success_text_format_non_completed_status_returns_1(capsys) -> None:
    """Line 600: text output format with non-'completed' status emits stderr and returns 1."""
    options = headless.HeadlessRunOptions(
        mode="prompt",
        auto_tools_pattern=None,
        output_format="text",
        prompt="hello",
        config_arg=None,
        request_id="req_test",
    )
    response = _non_completed_response(status="denied")
    code = headless._emit_success(
        options=options,
        response=response,
        response_text="",
        config_source=None,
    )
    captured = capsys.readouterr()
    assert code == 1
    assert "denied" in captured.err


# ---------------------------------------------------------------------------
# Lines 613-618 – _handle_chat_request_error: stream-json branch + text branch
# ---------------------------------------------------------------------------


def test_handle_chat_request_error_stream_json_emits_notification_and_returns_1(
    capsys,
) -> None:
    """Lines 613-615: stream-json emits an NDJSON notification AND falls through to json error."""
    error = _make_chat_error(code="CMP-CHAT-0002", message="stream failed")
    code = headless._handle_chat_request_error(
        output_format="stream-json",
        error=error,
    )
    captured = capsys.readouterr()
    lines = [l for l in captured.out.splitlines() if l.strip()]
    # stream-json emits the chat.error NDJSON notification AND falls through to
    # the json error envelope: exactly two stdout lines, in that order.
    assert len(lines) == 2

    notification = json.loads(lines[0])
    # First line is the chat.error notification (NOT the error envelope).
    assert notification["method"] == "chat.error"
    assert notification["params"]["code"] == "CMP-CHAT-0002"
    assert notification["params"]["message"] == "stream failed"
    assert "status" not in notification  # it is a notification, not an envelope

    envelope = json.loads(lines[1])
    # Second line is the json error envelope.
    assert envelope["status"] == "error"
    assert envelope["error"]["code"] == "CMP-CHAT-0002"
    assert envelope["error"]["message"] == "stream failed"
    assert envelope["request_id"] == "req_err"

    assert code == 1


def test_handle_chat_request_error_text_format_writes_stderr_and_returns_1(capsys) -> None:
    """Lines 615-617: text format writes 'code: message' to stderr, returns 1."""
    error = _make_chat_error(code="CMP-CHAT-0002", message="dummy text error")
    code = headless._handle_chat_request_error(
        output_format="text",
        error=error,
    )
    captured = capsys.readouterr()
    assert code == 1
    assert "CMP-CHAT-0002" in captured.err
    assert "dummy text error" in captured.err


# ---------------------------------------------------------------------------
# Line 623 – _handle_chat_request_error json branch
# ---------------------------------------------------------------------------


def test_handle_chat_request_error_json_format_emits_error_envelope_and_returns_1(
    capsys,
) -> None:
    """Line 623: json format emits _error_envelope to stdout and returns 1."""
    error = _make_chat_error(
        code="CMP-CHAT-0002", message="sample json error", request_id="req_json"
    )
    code = headless._handle_chat_request_error(
        output_format="json",
        error=error,
    )
    captured = capsys.readouterr()
    assert code == 1
    payload = json.loads(captured.out.strip())
    assert payload["status"] == "error"
    assert payload["error"]["code"] == "CMP-CHAT-0002"
    assert payload["error"]["message"] == "sample json error"
    assert payload["request_id"] == "req_json"


# ---------------------------------------------------------------------------
# Lines 677-681 – run_headless_from_args ChatRequestError handler
# ---------------------------------------------------------------------------


def test_run_headless_from_args_handles_chat_request_error(
    monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """Lines 677-681: ChatRequestError propagated from _run_chat_turn is caught."""
    _patch_runtime_plumbing(monkeypatch)

    def _raise(*args, **kwargs):
        raise ChatRequestError(
            request_id="req_err",
            trace_id=None,
            session_id=None,
            code="CMP-CHAT-0002",
            message="example chat error",
            rpc_code=-32603,
            retryable=False,
        )

    monkeypatch.setattr(headless, "build_chat_send_response", _raise)

    args = SimpleNamespace(
        resolved_permission_mode="prompt",
        resolved_auto_tools_pattern=None,
        output_format="json",
        prompt="hello",
        config=None,
    )
    exit_code = headless.run_headless_from_args(args)
    captured = capsys.readouterr()
    assert exit_code == 1
    payload = json.loads(captured.out.strip())
    assert payload["status"] == "error"
    assert payload["error"]["message"] == "example chat error"


# ---------------------------------------------------------------------------
# Lines 679-685 – run_headless_from_args FileNotFoundError / ValueError handler
# ---------------------------------------------------------------------------


def test_run_headless_from_args_handles_file_not_found_error(
    monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """Lines 679-685: FileNotFoundError from _load_raw_config is caught and emits error."""
    _patch_runtime_plumbing(monkeypatch)

    def _raise_fnf(explicit_config_path):
        raise FileNotFoundError("config file not found: /dummy/sample.json")

    monkeypatch.setattr(headless, "_load_raw_config", _raise_fnf)

    args = SimpleNamespace(
        resolved_permission_mode="prompt",
        resolved_auto_tools_pattern=None,
        output_format="json",
        prompt="hello",
        config="/dummy/sample.json",
    )
    exit_code = headless.run_headless_from_args(args)
    captured = capsys.readouterr()
    assert exit_code == 1
    payload = json.loads(captured.out.strip())
    assert payload["status"] == "error"
    assert "sample.json" in payload["error"]["message"]


def test_run_headless_from_args_handles_value_error(
    monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """Lines 679-685: ValueError from _load_config_file is caught and emits error."""
    _patch_runtime_plumbing(monkeypatch)

    def _raise_ve(explicit_config_path):
        raise ValueError("config must be a JSON object")

    monkeypatch.setattr(headless, "_load_raw_config", _raise_ve)

    args = SimpleNamespace(
        resolved_permission_mode="prompt",
        resolved_auto_tools_pattern=None,
        output_format="text",
        prompt="hello",
        config=None,
    )
    exit_code = headless.run_headless_from_args(args)
    captured = capsys.readouterr()
    assert exit_code == 1
    assert "config must be a JSON object" in captured.err


# ---------------------------------------------------------------------------
# Lines 687-689 – run_headless_from_args generic Exception handler
# ---------------------------------------------------------------------------


def test_run_headless_from_args_handles_generic_exception(
    monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """Lines 687-689: an unexpected Exception is caught and message is emitted."""
    _patch_runtime_plumbing(monkeypatch)

    def _raise_generic(explicit_config_path):
        raise RuntimeError("unexpected internal error")

    monkeypatch.setattr(headless, "_load_raw_config", _raise_generic)

    args = SimpleNamespace(
        resolved_permission_mode="prompt",
        resolved_auto_tools_pattern=None,
        output_format="json",
        prompt="hello",
        config=None,
    )
    exit_code = headless.run_headless_from_args(args)
    captured = capsys.readouterr()
    assert exit_code == 1
    payload = json.loads(captured.out.strip())
    assert payload["status"] == "error"
    assert "unexpected internal error" in payload["error"]["message"]


def test_run_headless_from_args_generic_exception_empty_message_uses_type_name(
    monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """Lines 688-689: when str(error) is empty the type name is used instead."""
    _patch_runtime_plumbing(monkeypatch)

    class _BlankError(Exception):
        def __str__(self) -> str:
            return ""

    def _raise_blank(explicit_config_path):
        raise _BlankError()

    monkeypatch.setattr(headless, "_load_raw_config", _raise_blank)

    args = SimpleNamespace(
        resolved_permission_mode="prompt",
        resolved_auto_tools_pattern=None,
        output_format="json",
        prompt="hello",
        config=None,
    )
    exit_code = headless.run_headless_from_args(args)
    captured = capsys.readouterr()
    assert exit_code == 1
    payload = json.loads(captured.out.strip())
    # Message should be the class name since str(error) == ""
    assert "_BlankError" in payload["error"]["message"]


# ---------------------------------------------------------------------------
# Lines 719-720 – run_headless resolve_permission_mode ValueError → parser.error
# ---------------------------------------------------------------------------


def test_run_headless_calls_parser_error_on_conflicting_alias_flags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Lines 719-720: multiple alias flags cause parser.error (SystemExit)."""
    _patch_runtime_plumbing(monkeypatch)
    # Two aliases set → resolve_permission_mode raises ValueError → parser.error → SystemExit(2)
    with pytest.raises(SystemExit) as exc_info:
        headless.run_headless(
            [
                "--prompt",
                "hello",
                "--auto-approve-readonly",
                "--dangerously-skip-permissions",
            ]
        )
    assert exc_info.value.code == 2
