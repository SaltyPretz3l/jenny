"""command.execute_proposal: the exact-command Run adapter (row 59 checkpoint 3, batch B1).

No model is involved. The harness drives the REAL request decoder, policy filter,
approval gate, runtime-operation admission, resource lease and ``execute_tool``
dispatch against a scripted "Electron" that answers the reverse requests.
"""

from __future__ import annotations

import hashlib
import logging
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.error_codes import CMP_TOOL_COMMAND_ABORTED
from sidecar.ai.routing import tool_execution
from sidecar.ai.routing import tool_execution_results as te_results
from sidecar.ai.routing.tool_resolution import _electron_bridge_runtime_descriptors
from sidecar.ai.tools.assembly import ToolAssemblyContext, assemble_tool_contract
from sidecar.ai.tools.catalog import MANAGED_SIDECAR_SURFACE, build_tool_catalog
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.protocol import (
    API_VERSION,
    COMMAND_EXECUTE_PROPOSAL_METHOD,
    INBOUND_VERSIONED_REQUEST_METHODS,
    RUNTIME_OPERATION_METHOD,
    TOOL_REQUEST_APPROVAL_METHOD,
)
from sidecar.runtime.command_proposal import process_command_execute_proposal
from sidecar.runtime.multiplexer import TurnCancellationHandle

LOGGER = logging.getLogger("test.command_proposal")
COMMAND = "echo hello"
CALL_ID = "pcmd_" + "ab" * 16
POLICY = {"version": 3, "legacy_policies": {}}


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _shell() -> str:
    from sidecar.ai.tools.builtins.shell import _shell_name

    return _shell_name()


def make_params(root: Path, **overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "accept_version": API_VERSION,
        "api_version": API_VERSION,
        "schema_version": 1,
        "request_id": "req_cmd_1",
        "trace_id": "trace_1",
        "session_id": "session_1",
        "approval_mode": "prompt",
        "turn_id": "turn_1",
        "operation_id": "11111111-1111-4111-8111-111111111111",
        "proposal_id": "proposal_abc",
        "accepted_revision": 2,
        "decision_id": "22222222-2222-4222-8222-222222222222",
        "command_sha256": _sha(COMMAND),
        "tool_call_id": CALL_ID,
        "execution_context": {
            "schema_version": 1,
            "authority_revision": "authority_1",
            "project_id": "project_alpha",
            "root_path": str(root),
            "root_id": "root_1234567890abcdef12345678",
            "root_revision": 4,
            "device_id": "11",
            "inode": "101",
            "tool_policy_snapshot": POLICY,
            "knowledge_roots": [],
        },
        "binding": {"backend": "native", "shell": _shell(), "cwd": ".", "root_revision": 4},
        "input": {
            "command": COMMAND,
            "cwd": ".",
            "timeout_seconds": 30,
            "expected_exit_codes": [0],
            "purpose": "Say hello",
        },
    }
    params.update(overrides)
    return params


class ScriptedElectron:
    """Answers reverse requests the way the application would."""

    def __init__(
        self, *, approve: bool | None = True, electron_result: dict[str, Any] | None = None
    ):
        self.frames: list[dict[str, Any]] = []
        self.approve = approve
        self.electron_result = electron_result
        self.settles: list[tuple[str, str]] = []
        self.on_execute: Any = None

    def write(self, frame: dict[str, Any]) -> None:
        self.frames.append(frame)

    def factory(self, rpc_id: int, cancel_handle: Any = None) -> Any:
        def reader(_timeout: float) -> dict[str, Any]:
            frame = next(item for item in self.frames if item.get("id") == rpc_id)
            return {"jsonrpc": "2.0", "id": rpc_id, "result": self._answer(frame)}

        return reader

    def _answer(self, frame: dict[str, Any]) -> dict[str, Any]:
        method, params = frame["method"], frame["params"]
        if method == TOOL_REQUEST_APPROVAL_METHOD:
            return {"approved": bool(self.approve)}
        if method == RUNTIME_OPERATION_METHOD:
            phase = params.get("phase")
            status = {"settle": "settled"}.get(phase, "granted")
            if phase == "settle":
                self.settles.append((params["status"], params["cleanup"]))
            return {"schema_version": 1, "status": status, "operation_id": params["operation_id"]}
        if method == "tool.execute_electron":
            return self.electron_result or {"success": True, "output": "ok"}
        raise AssertionError(f"unexpected reverse request {method}")

    def methods(self) -> list[str]:
        return [str(item.get("method")) for item in self.frames if item.get("method")]

    def tool_events(self, method: str) -> list[dict[str, Any]]:
        return [item for item in self.frames if item.get("method") == method]


class FakeKernel:
    def __init__(self, config: Any, contract: Any, mcp_exec: Any) -> None:
        self._config, self._engine = (
            config,
            SimpleNamespace(get_model_context_length=lambda: 0, model="m"),
        )
        self._contract = contract
        self.mcp_exec = mcp_exec
        self._mcp_client = SimpleNamespace(
            tool_descriptor=contract.descriptor,
            execute_tool=mcp_exec,
        )

    def _assemble_tool_contract(self, **_kwargs: Any) -> Any:
        return self._contract

    @staticmethod
    def _request_tool_set(_prefs: Any, _key: str) -> frozenset[str]:
        return frozenset()

    def _filter_tool_calls_by_policy(self, calls: Any, **kwargs: Any) -> Any:
        return tool_execution.filter_tool_calls_by_policy(self, calls, **kwargs)

    def _approval_if_needed(self, calls: Any, **kwargs: Any) -> Any:
        return tool_execution.approval_if_needed(self, calls, **kwargs)

    def _execute_tool(self, call: Any, **kwargs: Any) -> Any:
        return tool_execution.execute_tool(self, call, **kwargs)

    _assert_valid_tool_call = staticmethod(tool_execution.assert_valid_tool_call)
    _is_direct_deferred_tool_call = staticmethod(lambda *_a, **_k: False)
    _update_read_snapshot_cache = staticmethod(lambda *_a, **_k: None)
    _assistant_tool_call_message = staticmethod(te_results.assistant_tool_call_message)

    def _tool_result_message(self, call: Any, outcome: Any) -> dict[str, object]:
        return te_results.tool_result_message(call, outcome, config=self._config)


def build_kernel(config_raw: dict[str, Any] | None = None, mcp_exec: Any = None) -> FakeKernel:
    config = parse_runtime_config(
        {
            "engine_type": "mock",
            "tools_shell_enabled": True,
            **(config_raw or {}),
            "feature_flags": {"auto_checkpoint": False, "shell_security": True},
        }
    )
    runtime_descriptors = (
        _electron_bridge_runtime_descriptors(config)
        if config.desktop_execution_policy_version
        else ()
    )
    descriptors = build_tool_catalog(
        config=config,
        runtime_descriptors=runtime_descriptors,
        bound_names=() if runtime_descriptors else ("run_command",),
    )
    contract = assemble_tool_contract(
        descriptors,
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config=config,
            engine_supports_tool_calling=True,
            mode="assist",
            resolution_context=None,
            workspace_root_present=True,
            include_deferred_tools=True,
        ),
    )
    return FakeKernel(config, contract, mcp_exec or (lambda *a, **k: pytest.fail("builtin ran")))


def make_container(kernel: FakeKernel, *, hosted: bool = False) -> SimpleNamespace:
    boundaries: list[str] = []

    @contextmanager
    def request_boundary(marker: str, **_kwargs: Any):
        boundaries.append(marker)
        yield

    @contextmanager
    def stack_lease():
        yield None

    stack = SimpleNamespace(config=kernel._config, router=kernel, tool_observations=None)
    return SimpleNamespace(
        stack=stack,
        request_boundary=request_boundary,
        stack_lease=stack_lease,
        host_policy_enforced=hosted,
        boundaries=boundaries,
    )


def run(  # noqa: PLR0913
    params: dict[str, Any],
    kernel: FakeKernel,
    electron: ScriptedElectron,
    *,
    cancel_handle: Any = None,
    hosted: bool = False,
    message_id: Any = 7,
) -> Any:
    container = make_container(kernel, hosted=hosted)
    outcome = process_command_execute_proposal(
        {
            "jsonrpc": "2.0",
            "id": message_id,
            "method": COMMAND_EXECUTE_PROPOSAL_METHOD,
            "params": params,
        },
        brain_container=container,
        logger=LOGGER,
        write_frame=electron.write,
        approval_response_waiter_factory=electron.factory,
        cancel_handle=cancel_handle,
    )
    return outcome


def native_result(exit_code: int = 0, **extra: Any) -> Any:
    metadata = {
        "shell": _shell(),
        "exit_code": exit_code,
        "resource_cleanup": {
            "cleanup": "confirmed",
            "process_tree_terminated": True,
            "output_readers_terminated": True,
            "reason": None,
        },
    }
    metadata.update(extra)
    return SimpleNamespace(
        tool_name="run_command",
        output="hello",
        success=exit_code == 0,
        content_type="text",
        ui_payload=None,
        generated_artifacts=(),
        error_code=None,
        metadata=metadata,
        trusted_attachments=(),
    )


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    return tmp_path.resolve()


def command_outcome(outcome: Any) -> dict[str, Any]:
    return outcome.response["result"]["command_outcome"]


def auto_params(root: Path, **overrides: Any) -> dict[str, Any]:
    params = make_params(root, approval_mode="auto_run", **overrides)
    params["execution_context"]["tool_policy_snapshot"] = {
        "version": 3,
        "legacy_policies": {"run_command": "auto"},
    }
    return params


# ---- happy paths ---------------------------------------------------------------------


def test_native_run_under_auto_policy_executes_without_asking(root: Path) -> None:
    calls: list[tuple[Any, ...]] = []
    kernel = build_kernel(mcp_exec=lambda *a, **k: calls.append((a, k)) or native_result(0))
    electron = ScriptedElectron()
    outcome = run(auto_params(root), kernel, electron)
    result = outcome.response["result"]
    assert result["status"] == "completed"
    assert result["completion_source"] == "command_proposal"
    assert result["response_text"] == "Command finished (exit 0)."
    assert command_outcome(outcome) == {
        "schema_version": 1,
        "status": "succeeded",
        "exit_code": 0,
        "cleanup": "confirmed",
    }
    assert TOOL_REQUEST_APPROVAL_METHOD not in electron.methods()
    assert len(calls) == 1
    assert calls[0][0][0] == "run_command"
    sent = calls[0][0][1]
    assert sent["command"] == COMMAND and sent["purpose"] == "Say hello"
    assert "run_in_background" not in sent
    assert electron.settles == [("succeeded", "confirmed")]
    methods = [item["method"] for item in outcome.notifications]
    assert "chat.done" in methods
    assert electron.tool_events("tool.executing")[0]["params"]["tool_call_id"] == CALL_ID
    assert electron.tool_events("tool.result")[0]["params"]["tool_call_id"] == CALL_ID


def test_expected_exit_code_maps_status_from_the_code_not_the_tool(root: Path) -> None:
    params = auto_params(root)
    params["input"]["expected_exit_codes"] = [0, 3]
    kernel = build_kernel(mcp_exec=lambda *a, **k: native_result(3))
    assert command_outcome(run(params, kernel, ScriptedElectron()))["status"] == "succeeded"
    params["input"]["expected_exit_codes"] = [0]
    kernel = build_kernel(mcp_exec=lambda *a, **k: native_result(3))
    outcome = run(params, kernel, ScriptedElectron())
    assert command_outcome(outcome) == {
        "schema_version": 1,
        "status": "failed",
        "exit_code": 3,
        "cleanup": "confirmed",
    }
    assert outcome.response["result"]["response_text"] == "Command failed (exit 3)."


# ---- approval parity -----------------------------------------------------------------


def test_policy_ask_sends_the_ordinary_blocking_approval_and_runs_on_approve(root: Path) -> None:
    calls: list[Any] = []
    kernel = build_kernel(mcp_exec=lambda *a, **k: calls.append(a) or native_result(0))
    electron = ScriptedElectron(approve=True)
    outcome = run(make_params(root), kernel, electron)  # prompt mode, no auto rule: policy asks
    asks = electron.tool_events(TOOL_REQUEST_APPROVAL_METHOD)
    assert len(asks) == 1
    assert asks[0]["params"]["tool_name"] == "run_command"
    assert asks[0]["params"]["tool_call_id"] == CALL_ID
    assert asks[0]["params"]["request_id"] == "req_cmd_1"
    assert command_outcome(outcome)["status"] == "succeeded"
    assert len(calls) == 1


def test_approval_denied_runs_nothing_and_is_denied_not_failed(root: Path) -> None:
    kernel = build_kernel(mcp_exec=lambda *a, **k: pytest.fail("executed after denial"))
    electron = ScriptedElectron(approve=False)
    outcome = run(make_params(root), kernel, electron)
    assert outcome.response["result"]["status"] == "denied"
    assert command_outcome(outcome) == {
        "schema_version": 1,
        "status": "denied",
        "exit_code": None,
        "cleanup": None,
    }
    assert not electron.tool_events("tool.executing")
    assert electron.settles == []


def test_approval_timeout_is_denied(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from sidecar.runtime import command_proposal_approval as approval_mod
    from sidecar.runtime.approval import ApprovalResolution

    monkeypatch.setattr(
        approval_mod,
        "request_tool_approval",
        lambda *a, **k: ApprovalResolution(approved=False, status="timeout"),
    )
    kernel = build_kernel(mcp_exec=lambda *a, **k: pytest.fail("executed after timeout"))
    outcome = run(make_params(root), kernel, ScriptedElectron())
    assert outcome.response["result"]["status"] == "timeout"
    assert command_outcome(outcome)["status"] == "denied"


def test_blocked_command_is_denied_without_any_subprocess(root: Path) -> None:
    params = auto_params(root)
    blocked = "rm -rf /"
    params["input"]["command"] = blocked
    params["command_sha256"] = _sha(blocked)
    kernel = build_kernel(mcp_exec=lambda *a, **k: pytest.fail("executed a blocked command"))
    electron = ScriptedElectron()
    outcome = run(params, kernel, electron)
    assert command_outcome(outcome)["status"] == "denied"
    assert TOOL_REQUEST_APPROVAL_METHOD not in electron.methods()
    result = electron.tool_events("tool.result")[0]["params"]
    assert result["tool_call_id"] == CALL_ID


def test_shell_disabled_by_configuration_is_denied(root: Path) -> None:
    kernel = build_kernel(
        {"tools_shell_enabled": False},
        mcp_exec=lambda *a, **k: pytest.fail("executed with the shell disabled"),
    )
    assert command_outcome(run(auto_params(root), kernel, ScriptedElectron()))["status"] == "denied"


def test_policy_deny_rule_is_denied(root: Path) -> None:
    params = make_params(root)
    params["execution_context"]["tool_policy_snapshot"] = {
        "version": 3,
        "legacy_policies": {"run_command": "deny"},
    }
    kernel = build_kernel(mcp_exec=lambda *a, **k: pytest.fail("executed a denied command"))
    outcome = run(params, kernel, ScriptedElectron())
    assert command_outcome(outcome)["status"] == "denied"


# ---- refusal before any effect ------------------------------------------------------------


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (lambda p: p["input"].update(command="echo tampered"), "hash_mismatch"),
        (lambda p: p["binding"].update(cwd="sub"), "cwd_mismatch"),
        (
            lambda p: p["binding"].update(shell="/bin/sh" if _shell() == "cmd.exe" else "cmd.exe"),
            "shell_mismatch_or_backend",
        ),
        (lambda p: p.update(surprise=True), "unknown_key"),
        (lambda p: p["input"].update(run_in_background=True), "unknown_key"),
        (lambda p: p["binding"].update(root_revision=9), "root_revision_mismatch"),
        (lambda p: p["input"].update(timeout_seconds=301), "field_timeout_seconds"),
        (lambda p: p["input"].update(timeout_seconds=0), "field_timeout_seconds"),
        (lambda p: p["input"].update(expected_exit_codes=[0, 0]), "field_expected_exit_codes"),
        (lambda p: p.update(plan_mode=True), "read_only_or_plan_mode"),
        (lambda p: p.update(read_only=True), "read_only_or_plan_mode"),
        (lambda p: p.update(schema_version=2), "field_schema_version"),
        (lambda p: p.update(command_sha256="nothex"), "field_command_sha256"),
        (lambda p: p.pop("execution_context"), "missing_key"),
        (
            lambda p: p["execution_context"].update(
                root_path=None, root_id=None, device_id=None, inode=None
            ),
            "execution_context_unrooted",
        ),
    ],
)
def test_refused_before_any_effect(root: Path, mutate: Any, reason: str) -> None:
    params = auto_params(root)
    mutate(params)
    kernel = build_kernel(mcp_exec=lambda *a, **k: pytest.fail("executed a refused request"))
    electron = ScriptedElectron()
    outcome = run(params, kernel, electron)
    error = outcome.response["error"]
    assert error["code"] == -32602
    assert error["data"]["code"] == "CMP-CHAT-0001"
    assert error["data"]["retryable"] is False
    if reason == "shell_mismatch_or_backend":
        assert error["data"]["reason"] == "backend_or_shell_mismatch"
    else:
        assert error["data"]["reason"] == reason
    assert electron.frames == []  # nothing was written: no admission, no approval, no events
    assert COMMAND not in str(error)


@pytest.mark.parametrize(
    "code", [0x1B, 0x0B, 0x7F, 0x85, 0xAD, 0x061C, 0x200B, 0x200E, 0x202E, 0x2066, 0xFEFF]
)
def test_invisible_or_bidi_characters_are_refused(root: Path, code: int) -> None:
    # Mirrors Electron's validator: the inspected command must display exactly what runs.
    params = auto_params(root)
    command = f"echo a{chr(code)}b"
    params["input"]["command"] = command
    params["command_sha256"] = _sha(command)
    kernel = build_kernel(mcp_exec=lambda *a, **k: pytest.fail("executed a refused request"))
    electron = ScriptedElectron()
    error = run(params, kernel, electron).response["error"]
    assert error["data"]["reason"] == "field_command"
    assert electron.frames == []
    cwd_params = auto_params(root)
    cwd_params["input"]["cwd"] = f"sub{chr(code)}"
    cwd_error = run(cwd_params, build_kernel(), ScriptedElectron()).response["error"]
    assert cwd_error["data"]["reason"] == "field_cwd"


def test_tab_newline_and_carriage_return_are_allowed_in_the_command() -> None:
    from sidecar.runtime.command_proposal_request import _INVISIBLE_RE

    for text in (
        "a" + chr(9) + "b",
        "a" + chr(10) + "b",
        "a" + chr(13) + chr(10) + "b",
        "caf" + chr(0xE9),
        chr(0x4E2D),
    ):
        assert _INVISIBLE_RE.search(text) is None


def test_refusal_never_echoes_the_command(root: Path) -> None:
    params = auto_params(root)
    params["input"]["command"] = "echo SECRET-TOKEN"
    outcome = run(params, build_kernel(), ScriptedElectron())
    assert "SECRET-TOKEN" not in str(outcome.response) + str(outcome.notifications)


def test_accept_version_mismatch_is_refused(root: Path) -> None:
    outcome = run(
        auto_params(root, accept_version="1999-01-01"), build_kernel(), ScriptedElectron()
    )
    assert outcome.response["error"]["data"]["code"] == "CMP-PROTO-0001"


def test_docker_binding_over_120_seconds_is_refused(root: Path) -> None:
    params = auto_params(root)
    params["binding"].update(backend="docker", shell="/bin/sh")
    params["input"]["timeout_seconds"] = 121
    outcome = run(params, build_kernel(), ScriptedElectron())
    assert outcome.response["error"]["data"]["reason"] == "docker_binding_limits"


def test_native_binding_against_a_docker_sidecar_is_refused(root: Path) -> None:
    kernel = build_kernel({"desktop_execution_policy_version": 1})
    electron = ScriptedElectron()
    outcome = run(auto_params(root), kernel, electron)
    assert outcome.response["error"]["data"]["reason"] == "backend_or_shell_mismatch"
    assert electron.frames == []


def test_docker_binding_against_a_native_sidecar_is_refused(root: Path) -> None:
    params = auto_params(root)
    params["binding"].update(backend="docker", shell="/bin/sh")
    electron = ScriptedElectron()
    outcome = run(params, build_kernel(), electron)
    assert outcome.response["error"]["data"]["reason"] == "backend_or_shell_mismatch"
    assert electron.frames == []


def test_hosted_mode_denies_the_method(root: Path) -> None:
    electron = ScriptedElectron()
    outcome = run(auto_params(root), build_kernel(), electron, hosted=True)
    assert outcome.response["error"]["data"]["reason"] == "host_method_not_allowed"
    assert electron.frames == []


def test_notification_without_id_is_ignored(root: Path) -> None:
    electron = ScriptedElectron()
    outcome = run(auto_params(root), build_kernel(), electron, message_id=None)
    assert outcome.response is None and electron.frames == []


# ---- docker / Electron bridge ---------------------------------------------------------------


def test_docker_descriptor_path_calls_the_electron_bridge_never_the_builtin_executor(
    root: Path,
) -> None:
    params = auto_params(root)
    params["binding"].update(backend="docker", shell="/bin/sh")
    kernel = build_kernel(
        {"desktop_execution_policy_version": 1},
        mcp_exec=lambda *a, **k: pytest.fail("builtin executor used for docker"),
    )
    electron = ScriptedElectron(
        electron_result={
            "success": True,
            "output": "ok",
            "tool_name": "run_command",
            "metadata": {
                "execution": {
                    "backend": "docker",
                    "status": "succeeded",
                    "exit_code": 0,
                    "cleanup_confirmed": True,
                    "job_id": "job_1",
                }
            },
        }
    )
    outcome = run(params, kernel, electron)
    bridge = electron.tool_events("tool.execute_electron")
    assert len(bridge) == 1
    assert bridge[0]["params"]["tool_name"] == "run_command"
    assert bridge[0]["params"]["tool_call_id"] == CALL_ID
    assert TOOL_REQUEST_APPROVAL_METHOD not in electron.methods()  # Electron owns docker approval
    assert command_outcome(outcome) == {
        "schema_version": 1,
        "status": "succeeded",
        "exit_code": 0,
        "cleanup": "confirmed",
    }


def test_docker_sandbox_approval_denial_is_denied(root: Path) -> None:
    params = auto_params(root)
    params["binding"].update(backend="docker", shell="/bin/sh")
    kernel = build_kernel({"desktop_execution_policy_version": 1})
    electron = ScriptedElectron(
        electron_result={
            "success": False,
            "output": "Docker sandbox: sandbox approval denied.",
            "error_code": "CMP-TOOL-0008",
            "tool_name": "run_command",
            "metadata": {
                "execution": {
                    "backend": "docker",
                    "status": "failed",
                    "reason": "sandbox_approval_denied",
                    "cleanup_confirmed": True,
                }
            },
        }
    )
    assert command_outcome(run(params, kernel, electron))["status"] == "denied"


# ---- cancellation -----------------------------------------------------------------------------


def _cancel_handle() -> TurnCancellationHandle:
    return TurnCancellationHandle(request_id="req_cmd_1", session_id="session_1")


def test_cancel_mid_run_without_cleanup_proof_is_interrupted_unknown(root: Path) -> None:
    handle = _cancel_handle()

    def exec_then_cancel(*_a: Any, **_k: Any) -> Any:
        handle.cancel(reason="chat_cancelled")
        raise ToolExecutionFailure(
            code=CMP_TOOL_COMMAND_ABORTED, message="aborted", retryable=False
        )

    electron = ScriptedElectron()
    outcome = run(
        auto_params(root), build_kernel(mcp_exec=exec_then_cancel), electron, cancel_handle=handle
    )
    assert outcome.response["result"]["status"] == "cancelled"
    assert command_outcome(outcome) == {
        "schema_version": 1,
        "status": "interrupted_unknown",
        "exit_code": None,
        "cleanup": "uncertain",
    }
    assert electron.settles == [("cancelled", "uncertain")]
    assert electron.tool_events("tool.result")[0]["params"]["tool_call_id"] == CALL_ID


def test_a_turn_boundary_from_the_batch_fails_closed_as_unknown(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sidecar.ai.routing import tool_call_execution as tce
    from sidecar.ai.routing.turn_boundary import TurnBoundary

    real = tce.execute_tool_calls_sequentially

    def _with_boundary(**kwargs: Any) -> TurnBoundary:
        real(**kwargs)  # the command really dispatched
        return TurnBoundary("awaiting_proposal", "proposal_" + "ab" * 32)

    monkeypatch.setattr(tce, "execute_tool_calls_sequentially", _with_boundary)
    electron = ScriptedElectron()
    outcome = run(auto_params(root), build_kernel(mcp_exec=lambda *a, **k: native_result(0)), electron)
    assert outcome.response["result"]["status"] != "completed"
    assert command_outcome(outcome)["status"] == "interrupted_unknown"


def test_cancel_mid_run_with_proven_cleanup_is_cancelled(root: Path) -> None:
    handle = _cancel_handle()

    def exec_then_cancel(*_a: Any, **_k: Any) -> Any:
        handle.cancel(reason="chat_cancelled")
        result = native_result(1)
        result.error_code, result.success = CMP_TOOL_COMMAND_ABORTED, False
        result.metadata["exit_code"] = None
        return result

    electron = ScriptedElectron()
    outcome = run(
        auto_params(root), build_kernel(mcp_exec=exec_then_cancel), electron, cancel_handle=handle
    )
    assert outcome.response["result"]["status"] == "cancelled"
    assert command_outcome(outcome) == {
        "schema_version": 1,
        "status": "cancelled",
        "exit_code": None,
        "cleanup": "confirmed",
    }


def test_cancelled_before_start_runs_nothing(root: Path) -> None:
    handle = _cancel_handle()
    handle.cancel(reason="chat_cancelled")
    electron = ScriptedElectron()
    outcome = run(auto_params(root), build_kernel(), electron, cancel_handle=handle)
    assert outcome.response["result"]["status"] == "cancelled"
    assert command_outcome(outcome) == {
        "schema_version": 1,
        "status": "cancelled",
        "exit_code": None,
        "cleanup": None,
    }
    assert electron.frames == []


# ---- pinned constants ---------------------------------------------------------------------------


def test_protocol_constant_and_versioned_membership() -> None:
    assert COMMAND_EXECUTE_PROPOSAL_METHOD == "command.execute_proposal"
    assert COMMAND_EXECUTE_PROPOSAL_METHOD in INBOUND_VERSIONED_REQUEST_METHODS


def test_cancel_is_the_existing_chat_cancel_not_a_new_method() -> None:
    from sidecar import protocol

    assert not hasattr(protocol, "COMMAND_CANCEL_PROPOSAL_METHOD")
    assert "command.cancel_proposal" not in protocol.INBOUND_VERSIONED_REQUEST_METHODS
