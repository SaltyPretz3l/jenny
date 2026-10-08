"""Tests for sidecar.ai.routing.auto_checkpoint.

Covers the pure decision function (``should_create_checkpoint``) and the
stateful entry point (``maybe_create_auto_checkpoint``): fires at most once
per run, is best-effort (never raises, never blocks the turn), and skips
silently when there is no session or no electron tool bridge wired up.
"""
from __future__ import annotations

import logging
import time
from types import SimpleNamespace

import pytest

from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.routing import auto_checkpoint as _auto_ckpt
from sidecar.ai.routing.auto_checkpoint import (
    AUTO_CHECKPOINT_POLICY_KEY,
    maybe_create_auto_checkpoint,
    should_create_checkpoint,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle


def _make_loop_run(
    *,
    policy_allows: bool = True,
    has_writer: bool = True,
    session_id="sess1",
    cancel_handle: TurnCancellationHandle | None = None,
    wall_clock_deadline: float | None = None,
):
    runtime = LoopRuntime(
        electron_tool_writer=(lambda message: None) if has_writer else None,
        electron_tool_reader=None,
        electron_tool_reader_factory=None,
        trace_id=None,
        cancel_handle=cancel_handle,
        wall_clock_deadline=wall_clock_deadline,
    )
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            feature_flags={} if policy_allows else {AUTO_CHECKPOINT_POLICY_KEY: False}
        ),
    )
    return SimpleNamespace(
        kernel=kernel,
        runtime=runtime,
        request_id="req1",
        session_id=session_id,
        checkpoint_created=False,
    )


def _mutating_remaining():
    return [(SimpleNamespace(tool_id="write_file"), 1)]


def _readonly_remaining():
    return [(SimpleNamespace(tool_id="read_file"), 1)]


# ---------------------------------------------------------------------------
# should_create_checkpoint (pure truth table)
# ---------------------------------------------------------------------------


def test_should_create_checkpoint_true_when_the_policy_key_is_absent():
    # The retired auto_checkpoint feature flag no longer ships from Electron.
    assert should_create_checkpoint(
        feature_flags={},
        already_created=False,
        tool_ids=["write_file"],
    ) is True


def test_should_create_checkpoint_false_when_an_execution_policy_disables_it():
    assert should_create_checkpoint(
        feature_flags={AUTO_CHECKPOINT_POLICY_KEY: False},
        already_created=False,
        tool_ids=["write_file"],
    ) is False


def test_should_create_checkpoint_false_when_no_mutating_tool():
    assert should_create_checkpoint(
        feature_flags={AUTO_CHECKPOINT_POLICY_KEY: True},
        already_created=False,
        tool_ids=["read_file"],
    ) is False


def test_should_create_checkpoint_true_when_flag_on_and_mutating_tool_present():
    assert should_create_checkpoint(
        feature_flags={AUTO_CHECKPOINT_POLICY_KEY: True},
        already_created=False,
        tool_ids=["write_file"],
    ) is True


def test_should_create_checkpoint_true_for_move_file():
    assert should_create_checkpoint(
        feature_flags={AUTO_CHECKPOINT_POLICY_KEY: True},
        already_created=False,
        tool_ids=["move_file"],
    ) is True


@pytest.mark.parametrize("tool_id", ["run_command", "run_temp_script", "python_execute"])
def test_should_create_checkpoint_true_before_every_scripted_mutation_tool(tool_id):
    # A temp script or python_execute can rewrite source just like run_command,
    # so each one gets the once-per-run restore point before it runs.
    assert should_create_checkpoint(
        feature_flags={},
        already_created=False,
        tool_ids=[tool_id],
    ) is True


def test_checkpoint_before_set_is_typed_plus_scripted_mutation_tools():
    from sidecar.ai.routing.auto_checkpoint import CHECKPOINT_BEFORE_TOOL_NAMES
    from sidecar.ai.routing.mutation_change_set_lifecycle import (
        SCRIPTED_MUTATION_TOOLS,
        TYPED_MUTATION_TOOLS,
    )

    assert CHECKPOINT_BEFORE_TOOL_NAMES == TYPED_MUTATION_TOOLS | SCRIPTED_MUTATION_TOOLS
    assert not hasattr(_auto_ckpt, "REPO_MUTATING_TOOL_NAMES")


def test_should_create_checkpoint_false_when_already_created():
    assert should_create_checkpoint(
        feature_flags={AUTO_CHECKPOINT_POLICY_KEY: True},
        already_created=True,
        tool_ids=["write_file"],
    ) is False


# ---------------------------------------------------------------------------
# maybe_create_auto_checkpoint -- fires at most once
# ---------------------------------------------------------------------------


def test_maybe_create_auto_checkpoint_fires_exactly_once_across_two_batches(monkeypatch):
    calls = []

    def _fake_execute(request):
        calls.append(request)
        return SimpleNamespace(success=True, metadata={"ref": "checkpoint/1"})

    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", _fake_execute)
    loop_run = _make_loop_run()

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())
    assert loop_run.checkpoint_created is True
    assert len(calls) == 1

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())
    assert len(calls) == 1


def test_maybe_create_auto_checkpoint_uses_the_turns_request_id(monkeypatch):
    calls = []
    monkeypatch.setattr(
        _auto_ckpt,
        "execute_electron_tool",
        lambda request: calls.append(request) or SimpleNamespace(success=True, metadata={}),
    )
    loop_run = _make_loop_run()
    loop_run.request_id = "turn-req-42"

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())

    assert len(calls) == 1
    assert calls[0].request_id == "turn-req-42"
    assert calls[0].tool_name == "__jenny_git_checkpoint"


# ---------------------------------------------------------------------------
# maybe_create_auto_checkpoint -- does NOT fire
# ---------------------------------------------------------------------------


def test_maybe_create_auto_checkpoint_does_not_fire_when_policy_disables_it(monkeypatch):
    calls = []
    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", calls.append)
    loop_run = _make_loop_run(policy_allows=False)

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())

    assert calls == []
    assert loop_run.checkpoint_created is False


def test_maybe_create_auto_checkpoint_does_not_fire_when_no_mutating_tool(monkeypatch):
    calls = []
    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", calls.append)
    loop_run = _make_loop_run()

    maybe_create_auto_checkpoint(loop_run, _readonly_remaining())

    assert calls == []
    assert loop_run.checkpoint_created is False


def test_maybe_create_auto_checkpoint_skips_silently_when_no_session_id(monkeypatch):
    calls = []
    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", calls.append)
    loop_run = _make_loop_run(session_id=None)

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())  # must not raise

    assert calls == []


def test_maybe_create_auto_checkpoint_returns_without_error_when_no_electron_writer(monkeypatch):
    calls = []
    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", calls.append)
    loop_run = _make_loop_run(has_writer=False)

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())  # must not raise

    assert calls == []


# ---------------------------------------------------------------------------
# maybe_create_auto_checkpoint -- best-effort (never propagates failures)
# ---------------------------------------------------------------------------


def test_maybe_create_auto_checkpoint_logs_skipped_when_bridge_fails(monkeypatch, caplog):
    monkeypatch.setattr(
        _auto_ckpt,
        "_request_checkpoint",
        lambda loop_run: SimpleNamespace(
            success=False,
            metadata={},
            output="Auto-checkpoint git service unavailable.",
        ),
    )
    caplog.set_level(logging.INFO, logger=_auto_ckpt.__name__)

    maybe_create_auto_checkpoint(_make_loop_run(), _mutating_remaining())

    events = [getattr(record, "event", "") for record in caplog.records]
    assert "ai.router.auto_checkpoint_skipped" in events
    assert "ai.router.auto_checkpoint_created" not in events


def test_maybe_create_auto_checkpoint_logs_skipped_when_no_checkpoint_created(monkeypatch, caplog):
    monkeypatch.setattr(
        _auto_ckpt,
        "_request_checkpoint",
        lambda loop_run: SimpleNamespace(
            success=True,
            metadata={"created": False, "reason": "not_a_repo"},
            output="no checkpoint (not_a_repo)",
        ),
    )
    caplog.set_level(logging.INFO, logger=_auto_ckpt.__name__)

    maybe_create_auto_checkpoint(_make_loop_run(), _mutating_remaining())

    events = [getattr(record, "event", "") for record in caplog.records]
    assert "ai.router.auto_checkpoint_skipped" in events
    assert "ai.router.auto_checkpoint_created" not in events


def test_maybe_create_auto_checkpoint_swallows_mcp_error_and_keeps_checkpoint_created(monkeypatch):
    def _raise(request):
        raise MCPError(code="CMP-TOOL-0008", message="bridge unavailable", retryable=False)

    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", _raise)
    loop_run = _make_loop_run()

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())  # must not raise

    assert loop_run.checkpoint_created is True


def test_maybe_create_auto_checkpoint_swallows_arbitrary_exception(monkeypatch):
    monkeypatch.setattr(
        _auto_ckpt,
        "execute_electron_tool",
        lambda request: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    loop_run = _make_loop_run()

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())  # must not raise

    assert loop_run.checkpoint_created is True


def test_maybe_create_auto_checkpoint_uses_request_cancel_and_deadline(monkeypatch):
    calls = []
    handle = TurnCancellationHandle(request_id="req1")
    monkeypatch.setattr(
        _auto_ckpt,
        "execute_electron_tool",
        lambda request: calls.append(request) or SimpleNamespace(success=True, metadata={}),
    )
    loop_run = _make_loop_run(
        cancel_handle=handle,
        wall_clock_deadline=time.monotonic() + 0.5,
    )

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())

    assert calls[0].cancel_handle is handle
    assert 0 < calls[0].timeout_seconds <= 0.5


def test_maybe_create_auto_checkpoint_does_not_swallow_terminal_cancel(monkeypatch):
    handle = TurnCancellationHandle(request_id="req1")
    handle.cancel(reason="sidecar_cancel")
    loop_run = _make_loop_run(cancel_handle=handle)
    monkeypatch.setattr(
        _auto_ckpt,
        "execute_electron_tool",
        lambda _request: pytest.fail("cancelled checkpoint must not dispatch"),
    )

    with pytest.raises(TerminalChatStateError):
        maybe_create_auto_checkpoint(loop_run, _mutating_remaining())


# ---------------------------------------------------------------------------
# Restore point (row 34 S5 step 4): the checkpoint outcome is recorded on the
# run and handed to scripted calls, never to the model.
# ---------------------------------------------------------------------------

_ISO_Z = r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"


def _bridge_result(*, success: bool, error_code=None, output="", **metadata):
    return SimpleNamespace(
        success=success, metadata=metadata, output=output, error_code=error_code
    )


def _electron_checkpoint(*, ok: bool, created: bool = False, ref: str = "", reason: str = ""):
    # The exact shape electron-tool-bridge.js returns for __jenny_git_checkpoint.
    return _bridge_result(
        success=ok,
        output=f"checkpoint {ref}" if created else f"no checkpoint ({reason or 'skipped'})",
        result_kind="auto_checkpoint",
        created=created,
        ref=ref,
        sequence=3 if created else 0,
        reason=reason,
    )


def _point_after(monkeypatch, result, *, loop_run=None, remaining=None):
    monkeypatch.setattr(_auto_ckpt, "_request_checkpoint", lambda _loop_run: result)
    loop_run = loop_run or _make_loop_run()
    maybe_create_auto_checkpoint(loop_run, remaining or _mutating_remaining())
    return getattr(loop_run, "restore_point", None)


def test_a_created_checkpoint_records_its_ref_and_time(monkeypatch):
    import re

    point = _point_after(monkeypatch, _electron_checkpoint(
        ok=True, created=True, ref="refs/jenny/checkpoints/sess1/3"
    ))

    assert set(point) == {"kind", "ref", "created_at"}
    assert point["kind"] == "git_checkpoint"
    assert point["ref"] == "refs/jenny/checkpoints/sess1/3"
    assert re.fullmatch(_ISO_Z, point["created_at"])


def test_a_clean_tree_records_head_as_the_restore_point(monkeypatch):
    point = _point_after(
        monkeypatch, _electron_checkpoint(ok=True, reason="nothing_to_checkpoint")
    )

    assert set(point) == {"kind", "created_at"}
    assert point["kind"] == "head"


def test_a_folder_that_is_not_a_repo_records_not_git(monkeypatch):
    # WorkspaceGitService._notARepo: ok:false with no reason at all.
    point = _point_after(monkeypatch, _electron_checkpoint(ok=False))

    assert point == {"kind": "none", "reason": "not_git"}


@pytest.mark.parametrize(
    ("ok", "reason"),
    [
        (True, "no_head"),
        (False, "not_repo_toplevel"),
        (False, "feature_disabled"),
        (False, "root_changed"),
        (False, "no_root"),
        (False, "git_failed"),
        (True, "something_new"),
    ],
)
def test_every_other_electron_outcome_records_failed(monkeypatch, ok, reason):
    point = _point_after(monkeypatch, _electron_checkpoint(ok=ok, reason=reason))

    assert point == {"kind": "none", "reason": "failed"}


def test_a_created_checkpoint_with_an_unsafe_ref_records_failed(monkeypatch):
    point = _point_after(monkeypatch, _electron_checkpoint(
        ok=True, created=True, ref="refs/heads/main"
    ))

    assert point == {"kind": "none", "reason": "failed"}


def test_a_bridge_failure_records_failed(monkeypatch):
    point = _point_after(monkeypatch, _bridge_result(
        success=False, error_code="CMP-TOOL-0008",
        output="Auto-checkpoint git service unavailable.", result_kind="electron_tool_bridge",
    ))

    assert point == {"kind": "none", "reason": "failed"}


def test_a_bridge_exception_records_failed(monkeypatch):
    def _raise(request):
        raise MCPError(code="CMP-TOOL-0008", message="bridge unavailable", retryable=False)

    monkeypatch.setattr(_auto_ckpt, "execute_electron_tool", _raise)
    loop_run = _make_loop_run()

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())

    assert loop_run.restore_point == {"kind": "none", "reason": "failed"}


def test_an_electron_policy_refusal_records_disabled(monkeypatch):
    point = _point_after(monkeypatch, _bridge_result(
        success=False, error_code="CMP-TOOL-0002",
        output="This execution path is unavailable in Docker sandbox mode.",
        result_kind="electron_tool_bridge",
    ))

    assert point == {"kind": "none", "reason": "disabled"}


def test_no_bridge_records_unavailable():
    loop_run = _make_loop_run(has_writer=False)

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())

    assert loop_run.restore_point == {"kind": "none", "reason": "unavailable"}


def test_no_session_records_unavailable(monkeypatch):
    monkeypatch.setattr(
        _auto_ckpt, "_request_checkpoint", lambda _run: pytest.fail("must not dispatch")
    )
    loop_run = _make_loop_run(session_id=None)

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())

    assert loop_run.restore_point == {"kind": "none", "reason": "unavailable"}


def test_the_policy_key_records_disabled_without_marking_a_checkpoint(monkeypatch):
    monkeypatch.setattr(
        _auto_ckpt, "_request_checkpoint", lambda _run: pytest.fail("must not dispatch")
    )
    loop_run = _make_loop_run(policy_allows=False)

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())

    assert loop_run.restore_point == {"kind": "none", "reason": "disabled"}
    assert loop_run.checkpoint_created is False


def test_host_policy_records_disabled(monkeypatch):
    monkeypatch.setattr(_auto_ckpt, "host_policy_is_enforced", lambda _config: True)
    monkeypatch.setattr(
        _auto_ckpt, "_request_checkpoint", lambda _run: pytest.fail("must not dispatch")
    )
    loop_run = _make_loop_run()

    maybe_create_auto_checkpoint(loop_run, _mutating_remaining())

    assert loop_run.restore_point == {"kind": "none", "reason": "disabled"}
    assert loop_run.checkpoint_created is False


def test_a_batch_without_a_mutating_tool_records_nothing():
    disabled = _make_loop_run(policy_allows=False)
    enabled = _make_loop_run()

    maybe_create_auto_checkpoint(disabled, _readonly_remaining())
    maybe_create_auto_checkpoint(enabled, _readonly_remaining())

    assert getattr(disabled, "restore_point", None) is None
    assert getattr(enabled, "restore_point", None) is None


def _outcome_with_point(point):
    return SimpleNamespace(metadata={"scripted_change_review": {
        "schema_version": 1, "state": "observed", "restore_point": point,
    }})


def test_a_resumed_run_keeps_the_turns_earlier_checkpoint(monkeypatch):
    earlier = {
        "kind": "git_checkpoint",
        "ref": "refs/jenny/checkpoints/sess1/1",
        "created_at": "2026-10-05T12:00:00.000Z",
    }
    loop_run = _make_loop_run()
    # Approval-resume rebuilds the run but seeds it with the turn's earlier outcomes.
    loop_run.outcomes = [SimpleNamespace(metadata={}), _outcome_with_point(earlier)]

    point = _point_after(monkeypatch, _electron_checkpoint(
        ok=True, created=True, ref="refs/jenny/checkpoints/sess1/2"
    ), loop_run=loop_run)

    assert point == earlier


def test_a_resumed_run_keeps_an_earlier_head_over_a_later_failure(monkeypatch):
    earlier = {"kind": "head", "created_at": "2026-10-05T12:00:00.000Z"}
    loop_run = _make_loop_run()
    loop_run.outcomes = [_outcome_with_point(earlier)]

    point = _point_after(monkeypatch, _electron_checkpoint(ok=False), loop_run=loop_run)

    assert point == earlier


def test_an_earlier_none_outcome_does_not_block_a_later_checkpoint(monkeypatch):
    loop_run = _make_loop_run()
    loop_run.outcomes = [_outcome_with_point({"kind": "none", "reason": "failed"})]

    point = _point_after(monkeypatch, _electron_checkpoint(
        ok=True, created=True, ref="refs/jenny/checkpoints/sess1/2"
    ), loop_run=loop_run)

    assert point["ref"] == "refs/jenny/checkpoints/sess1/2"


# -- dispatch: the bound run's restore point reaches builtin scripted calls --


def _descriptor(server_name=None):
    from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME

    return SimpleNamespace(server_name=server_name or BUILTIN_MCP_SERVER_NAME)


def _injected(loop_run, tool_id, descriptor):
    from sidecar.ai.routing import mutation_change_set_lifecycle as lifecycle

    arguments: dict[str, object] = {"command": "echo hi"}
    lifecycle.bind_run_context(loop_run)
    try:
        _auto_ckpt.inject_restore_point(
            arguments, call=SimpleNamespace(tool_id=tool_id), descriptor=descriptor
        )
    finally:
        lifecycle.release_run_context(loop_run)
    return arguments


@pytest.mark.parametrize("tool_id", ["run_command", "run_temp_script", "python_execute"])
def test_a_builtin_scripted_call_receives_the_runs_restore_point(tool_id):
    loop_run = _make_loop_run()
    loop_run.restore_point = {"kind": "none", "reason": "not_git"}

    arguments = _injected(loop_run, tool_id, _descriptor())

    assert arguments["_jenny_restore_point"] == {"kind": "none", "reason": "not_git"}
    assert arguments["_jenny_restore_point"] is not loop_run.restore_point


def test_only_builtin_scripted_calls_after_the_decision_receive_it():
    decided = _make_loop_run()
    decided.restore_point = {"kind": "head", "created_at": "2026-10-05T12:00:00.000Z"}
    undecided = _make_loop_run()

    assert "_jenny_restore_point" not in _injected(decided, "write_file", _descriptor())
    assert "_jenny_restore_point" not in _injected(
        decided, "run_command", _descriptor("third_party")
    )
    assert "_jenny_restore_point" not in _injected(undecided, "run_command", _descriptor())
    unbound: dict[str, object] = {}
    _auto_ckpt.inject_restore_point(
        unbound, call=SimpleNamespace(tool_id="run_command"), descriptor=_descriptor()
    )
    assert unbound == {}


def test_the_tool_loop_hands_the_checkpoint_to_a_scripted_call_but_not_the_model(monkeypatch):
    import sys
    from dataclasses import replace
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from test_tool_loop import _build_router, _StubMCPClient, _ToolLoopEngine, _ToolPlan

    from sidecar.ai.mcp.models import MCPToolDescriptor
    from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME
    from sidecar.ai.tools.models import GenerationResult, ToolCallRequest

    ref = "refs/jenny/checkpoints/sess-loop/5"
    monkeypatch.setattr(
        _auto_ckpt, "_request_checkpoint",
        lambda _run: _electron_checkpoint(ok=True, created=True, ref=ref),
    )
    class _ShellClient(_StubMCPClient):
        def execute_tool(self, tool_name, arguments, **_kwargs):
            self.executions.append((tool_name, dict(arguments)))
            return SimpleNamespace(
                tool_name=tool_name, output="hi", success=True, content_type="text/plain",
                ui_payload=None, generated_artifacts=(), error_code=None, metadata={},
            )

    client = _ShellClient((MCPToolDescriptor(
        name="run_command", description="Run a command",
        input_schema={"type": "object"}, side_effecting=True,
        server_name=BUILTIN_MCP_SERVER_NAME,
    ),))
    engine = _ToolLoopEngine(plans=[
        _ToolPlan(result=GenerationResult(
            content="", finish_reason="tool_calls",
            tool_calls=(ToolCallRequest(
                tool_id="run_command", arguments={"command": "echo hi"}, call_id="call_rp"
            ),),
        )),
        _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
    ])
    events: list = []
    router = _build_router(
        engine=engine, mcp_client=client, extra_snapshot_tools=("run_command",)
    )
    router._config = replace(router._config, tools_shell_enabled=True)
    router.build_chat_decision(
        request_id="req_rp",
        session_id="sess-loop",
        messages=[{"role": "user", "content": "Run it."}],
        latest_user_content="Run it.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(emit=events.append, request_id="req_rp", session_id="sess-loop"),
    )

    [(tool_name, arguments)] = client.executions
    assert tool_name == "run_command"
    assert arguments["_jenny_restore_point"]["ref"] == ref
    model_text = str(engine.requests[-1]["messages"])
    assert ref not in model_text
    results = [event for event in events if type(event).__name__ == "ToolResultEvent"]
    assert results and all(ref not in str(event.tool_input) for event in results)


# ---- Approval resume (row 34 S5) -------------------------------------------


def test_an_approved_batch_takes_its_own_restore_point_and_binds_it(monkeypatch):
    seen = []

    def _request(resumed):
        seen.append((resumed.request_id, resumed.session_id))
        return _electron_checkpoint(ok=True, created=True, ref="refs/jenny/checkpoints/sess1/4")

    monkeypatch.setattr(_auto_ckpt, "_request_checkpoint", _request)
    loop_run = _make_loop_run()
    runtime = loop_run.runtime

    _auto_ckpt.prepare_resume_restore_point(
        runtime, [(SimpleNamespace(tool_id="run_command"), 0)], kernel=loop_run.kernel,
        request_id="req1", session_id="sess1", outcomes=[],
    )

    assert seen == [("req1", "sess1")]
    assert runtime.restore_point["ref"] == "refs/jenny/checkpoints/sess1/4"
    arguments = _injected(runtime, "run_command", _descriptor())
    assert arguments["_jenny_restore_point"]["ref"] == "refs/jenny/checkpoints/sess1/4"


def test_an_approved_batch_keeps_the_turns_earlier_checkpoint(monkeypatch):
    earlier = {"kind": "git_checkpoint", "ref": "refs/jenny/checkpoints/sess1/1",
               "created_at": "2026-10-05T12:00:00.000Z"}
    monkeypatch.setattr(
        _auto_ckpt, "_request_checkpoint",
        lambda _r: _electron_checkpoint(ok=True, created=True, ref="refs/jenny/checkpoints/sess1/2"),
    )
    loop_run = _make_loop_run()

    _auto_ckpt.prepare_resume_restore_point(
        loop_run.runtime, [(SimpleNamespace(tool_id="run_command"), 0)], kernel=loop_run.kernel,
        request_id="req1", session_id="sess1", outcomes=[_outcome_with_point(earlier)],
    )

    assert loop_run.runtime.restore_point == earlier


def test_an_approved_read_only_batch_binds_nothing(monkeypatch):
    monkeypatch.setattr(_auto_ckpt, "_request_checkpoint", lambda _r: pytest.fail("no checkpoint"))
    loop_run = _make_loop_run()

    _auto_ckpt.prepare_resume_restore_point(
        loop_run.runtime, _readonly_remaining(), kernel=loop_run.kernel,
        request_id="req1", session_id="sess1", outcomes=[],
    )

    assert "restore_point" not in loop_run.runtime.__dict__
