"""UI-only child step log, answer, and task-label contracts for subagent reports."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.routing import delegate as delegate_module
from sidecar.ai.routing import subagent_scheduler as scheduler_module
from sidecar.ai.routing.delegate import execute_delegate_tool
from sidecar.ai.routing.delegate_child_steps import build_child_steps
from sidecar.ai.routing.delegate_contracts import (
    DelegateTask,
    delegate_task_label,
    validate_delegate_arguments,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatDecision, ToolExecutionOutcome
from sidecar.ai.routing.sub_agent_invocation import SubAgentInvocationResult
from sidecar.ai.routing.subagent_scheduler import DelegateSchedule, ScheduledInvocation
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.multiplexer import SubAgentSlotAllocator


def _outcome(  # noqa: PLR0913 - fixture builder mirrors the outcome fields.
    tool: str = "read_file",
    *,
    success: bool = True,
    tool_input: dict[str, object] | None = None,
    output: str = "file body that must never be copied",
    error_code: str | None = None,
    metadata: dict[str, object] | None = None,
) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(
        tool_name=tool,
        output=output,
        success=success,
        tool_input=tool_input or {},
        error_code=error_code,
        metadata=metadata or {},
    )


def _decision(*outcomes: ToolExecutionOutcome, text: str = "answer") -> ChatDecision:
    return ChatDecision(
        thinking_text=None,
        response_text=text,
        approval_request=None,
        tool_results=tuple(outcomes),
    )


# ---- build_child_steps -----------------------------------------------------


def test_steps_are_capped_at_forty_and_keep_the_first_entries() -> None:
    outcomes = [_outcome(tool_input={"path": f"src/f{index}.py"}) for index in range(55)]

    steps = build_child_steps(_decision(*outcomes))

    assert len(steps) == 40
    assert steps[0]["target"] == "src/f0.py"
    assert steps[-1]["target"] == "src/f39.py"


def test_step_shape_uses_display_name_and_relative_target() -> None:
    steps = build_child_steps(
        _decision(_outcome(tool_input={"path": "./docs/plan.md"}, metadata={"path": "x"}))
    )

    assert steps == [
        {"tool": "read_file", "display": "Read File", "ok": True, "target": "docs/plan.md"}
    ]


def test_successful_step_with_absolute_path_falls_back_to_basename_only() -> None:
    windows = build_child_steps(
        _decision(_outcome(tool_input={"file_path": "C:\\Users\\me\\repo\\src\\app.py"}))
    )
    posix = build_child_steps(_decision(_outcome(tool_input={"path": "/home/me/repo/notes.md"})))

    assert windows[0]["target"] == "app.py"
    assert posix[0]["target"] == "notes.md"


def test_failed_step_with_unsafe_path_leaks_no_file_name() -> None:
    steps = build_child_steps(
        _decision(
            _outcome(
                success=False,
                tool_input={"path": "C:\\Users\\me\\secrets\\passwords.txt"},
                output="Path is outside the workspace: C:\\Users\\me\\secrets\\passwords.txt",
                error_code="CMP-TOOL-0042",
            ),
            _outcome(
                success=False,
                tool_input={"path": "../../etc/shadow"},
                output="Denied\nsecond line stays out",
            ),
        )
    )

    assert "target" not in steps[0]
    assert "target" not in steps[1]
    assert steps[0]["ok"] is False
    assert steps[0]["error_code"] == "CMP-TOOL-0042"
    assert steps[1]["detail"] == "Denied"
    serialized = json.dumps(steps)
    assert "passwords" not in serialized
    assert "shadow" not in serialized
    assert "C:\\" not in serialized


def test_failed_step_never_gets_a_target_and_its_error_path_is_scrubbed() -> None:
    # A lexically relative path can still leave the workspace through a
    # symlink or junction; the refusal must not echo it in any spelling.
    steps = build_child_steps(
        _decision(
            _outcome(
                success=False,
                tool_input={"path": "linked-secrets/passwords.txt"},
                output="Refused: linked-secrets/passwords.txt resolves outside the workspace",
                error_code="CMP-TOOL-0003",
            ),
            _outcome(
                success=False,
                tool_input={"path": "\\\\server\\share\\private\\payroll.xlsx"},
                output="Cannot open \\\\server\\share\\private\\payroll.xlsx and //nas/backup/keys.pem",
            ),
            _outcome(
                success=False,
                tool_input={"path": "notes/My Tax Return 2025.pdf"},
                output="Not found: notes\\My Tax Return 2025.pdf (also tried ../../outside/ledger.csv)",
            ),
        )
    )

    serialized = json.dumps(steps)
    for step in steps:
        assert "target" not in step
    for leaked in (
        "passwords",
        "linked-secrets",
        "server",
        "payroll",
        "nas",
        "keys.pem",
        "Tax Return",
        "ledger.csv",
    ):
        assert leaked not in serialized, leaked
    assert steps[0]["detail"].startswith("Refused: <path>")


def test_error_line_scrubs_absolute_paths_that_are_not_the_input_path() -> None:
    # An OS error echoes the resolved path, never the input spelling: the
    # pattern scrubs must hold on their own, through spaces, quotes, a repr
    # with doubled backslashes, a home-relative path and a case change.
    steps = build_child_steps(
        _decision(
            _outcome(
                success=False,
                tool_input={"path": "linked/notes.txt"},
                output="linked/notes.txt resolves to /home/me/vault/keys.pem",
            ),
            _outcome(
                success=False,
                tool_input={"path": "linked/notes.txt"},
                output=r"link target D:\finance\q3.xlsx is outside the workspace",
            ),
            _outcome(
                success=False,
                tool_input={"path": "secret notes.txt"},
                output=(
                    "failed to read file: [Errno 13] Permission denied: "
                    r"'C:\\Users\\me\\OneDrive - Acme Corp\\proj\\secret notes.txt'"
                ),
            ),
            _outcome(
                success=False,
                tool_input={"path": "x.txt"},
                output="no such file /home/me/My Files/key.pem",
            ),
            _outcome(success=False, tool_input={"path": "x.txt"}, output="cannot open ~/.ssh/id_rsa"),
            _outcome(
                success=False,
                tool_input={"path": "./sub/Secret.TXT"},
                output="path does not exist: sub/secret.txt",
            ),
        )
    )

    blob = json.dumps(steps)
    for leaked in (
        "vault",
        "keys.pem",
        "finance",
        "q3.xlsx",
        "/home",
        "D:",
        "Acme",
        "secret notes",
        "My Files",
        "key.pem",
        ".ssh",
        "id_rsa",
        "secret.txt",
    ):
        assert leaked not in blob, leaked
    assert all("<path>" in step["detail"] for step in steps)
    assert steps[5]["detail"] == "path does not exist: <path>"


def test_basename_fallback_is_only_for_read_tools() -> None:
    steps = build_child_steps(
        _decision(
            _outcome("read_file", tool_input={"path": "C:\\Users\\me\\repo\\app.py"}),
            _outcome("list_dir", tool_input={"path": "C:\\Users\\me"}),
            _outcome("grep_search", tool_input={"pattern": "todo", "path": "/home/me"}),
        )
    )

    assert steps[0]["target"] == "app.py"
    assert "target" not in steps[1], "a listing target could name the user's home"
    assert steps[2]["target"] == '"todo"'


def test_labels_and_steps_drop_bidi_and_zero_width_controls_and_non_bool_success() -> None:
    label = delegate_task_label(DelegateTask(ordinal=1, prompt="\u202eReview\u200b the ledger"))
    assert label == "Review the ledger"

    steps = build_child_steps(
        _decision(
            _outcome(success=False, tool_input={"path": "a.txt"}, output="\u202edenied\u2066 here"),
            _outcome(success="yes", tool_input={"path": "b.txt"}),
        )
    )
    assert steps[0]["detail"] == "denied here"
    assert steps[1]["ok"] is False, "only a real True admits a call"
    assert "target" not in steps[1]


def test_successful_output_content_never_reaches_steps() -> None:
    steps = build_child_steps(
        _decision(
            _outcome(
                tool_input={"path": "src/a.py"},
                output="SUPER-UNIQUE-BODY-TOKEN and more content",
            ),
            _outcome("grep_search", tool_input={"pattern": "needle", "path": "src"}),
        )
    )

    assert "SUPER-UNIQUE-BODY-TOKEN" not in json.dumps(steps)
    for step in steps:
        assert "detail" not in step
        assert "error_code" not in step


def test_pattern_and_page_render_into_target() -> None:
    long_pattern = "p" * 100
    steps = build_child_steps(
        _decision(
            _outcome("grep_search", tool_input={"pattern": "needle", "path": "src/core"}),
            _outcome("grep_search", tool_input={"pattern": "needle"}),
            _outcome("grep_search", tool_input={"pattern": long_pattern, "path": "src"}),
            _outcome("read_pdf", tool_input={"path": "docs/manual.pdf", "page": 7}),
            _outcome("read_pdf", tool_input={"path": "docs/manual.pdf"}, metadata={"page": 3}),
            _outcome("list_dir", tool_input={"unknown": "shape"}),
        )
    )

    assert steps[0]["target"] == '"needle" in src/core'
    assert steps[1]["target"] == '"needle"'
    assert steps[2]["target"].startswith('"' + "p" * 59 + '\u2026" in src')
    assert steps[3]["target"] == "docs/manual.pdf \u00b7 p7"
    assert steps[4]["target"] == "docs/manual.pdf \u00b7 p3"
    assert "target" not in steps[5]


def test_error_detail_redacts_secrets_and_is_bounded() -> None:
    steps = build_child_steps(
        _decision(
            _outcome(
                success=False,
                output="request failed api_key=step-secret-value " + "x" * 400,
                error_code="CMP-TOOL-0001",
            )
        )
    )

    assert "step-secret-value" not in json.dumps(steps)
    assert len(steps[0]["detail"]) <= 160


def test_no_decision_yields_no_steps() -> None:
    assert build_child_steps(None) == []


# ---- delegate_task_label ---------------------------------------------------


def test_label_uses_first_non_empty_prompt_line_collapsed_and_bounded() -> None:
    assert (
        delegate_task_label(DelegateTask(ordinal=1, prompt="\n  Find   the   test\tcommand\nmore"))
        == "Find the test command"
    )
    long_label = delegate_task_label(DelegateTask(ordinal=2, prompt="w" * 200))
    assert len(long_label) == 60
    assert long_label.endswith("\u2026")


def test_label_falls_back_to_task_ordinal() -> None:
    assert (
        delegate_task_label(DelegateTask(ordinal=3, prompt=None, error={"code": "x"})) == "Task 3"
    )
    assert delegate_task_label(DelegateTask(ordinal=2, prompt="   ")) == "Task 2"


def test_label_redacts_secret_looking_prompt_text() -> None:
    label = delegate_task_label(DelegateTask(ordinal=1, prompt="Use api_key=label-secret-value"))

    assert "label-secret-value" not in label


# ---- delegate tool ---------------------------------------------------------


def _context() -> ChatRequestContext:
    return ChatRequestContext(
        request_id="parent-request",
        trace_id="trace",
        session_id="session",
        mode="assist",
        approvals_pre_granted=True,
        agent_id="main@parent-request",
        workspace_root_present=True,
    )


def _delegate_runtime() -> LoopRuntime:
    return LoopRuntime(
        request_id="parent-request",
        trace_id="trace",
        session_id="session",
        request_context=_context(),
        sub_agent_slot_allocator=SubAgentSlotAllocator(),
    )


def _schedule_for(request: Any, results: dict[int, SubAgentInvocationResult]) -> DelegateSchedule:
    invocations = []
    for task in request.tasks:
        result = results.get(task.ordinal)
        if result is None:
            continue
        identity = scheduler_module.build_sub_agent_identity(
            parent_request_id="parent-request",
            canonical_call_id="call",
            parent_agent_id="main@parent-request",
            ordinal=task.ordinal,
            operation="delegate",
        )
        invocations.append(ScheduledInvocation(task, identity, result, 10, 8, 120_000, True))
    return DelegateSchedule(
        execution="single" if len(request.tasks) == 1 else "sequential",
        invocations=tuple(invocations),
        effective_max_total_runtime_ms=120_000,
        parent_synthesis_reserve_ms=0,
    )


def _run_delegate(
    monkeypatch: pytest.MonkeyPatch,
    arguments: dict[str, Any],
    results: dict[int, SubAgentInvocationResult],
) -> tuple[Any, list[dict[str, Any]]]:
    request = validate_delegate_arguments(arguments)
    monkeypatch.setattr(
        delegate_module,
        "schedule_delegate_tasks",
        lambda **_kwargs: _schedule_for(request, results),
    )
    runtime = _delegate_runtime()
    notifications: list[dict[str, Any]] = []
    runtime.notification_writer = notifications.append
    outcome = execute_delegate_tool(
        router=SimpleNamespace(_config=parse_runtime_config({})),
        arguments=arguments,
        runtime=runtime,
        outcome_type=ToolExecutionOutcome,
        call_id="call",
    )
    progress = [item["params"] for item in notifications if item["method"] == "agent.progress"]
    return outcome, progress


def test_delegate_parent_output_has_no_steps_or_answer_but_metadata_does(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = "The test command is npm test."
    decision = _decision(
        _outcome(tool_input={"path": "package.json"}),
        _outcome(success=False, tool_input={"path": "/abs/secret.txt"}, output="Denied"),
        text=text,
    )
    result = SubAgentInvocationResult(
        status="completed", response_text=text, decision=decision, iterations_used=2
    )

    outcome, _progress = _run_delegate(
        monkeypatch, {"tasks": ["Find the test command"]}, {1: result}
    )

    payload = json.loads(outcome.output)
    assert outcome.output == (
        '{"execution":"single","results":[{"answer":"The test command is npm test.",'
        '"evidence":[],"ordinal":1,"status":"completed"}],"status":"completed"}'
    )
    assert "steps" not in outcome.output
    assert "answer" in payload["results"][0]
    assert set(payload["results"][0]) == {"answer", "evidence", "ordinal", "status"}
    task_report = outcome.metadata["subagent_batch_report"]["tasks"][0]
    assert [step["tool"] for step in task_report["steps"]] == ["read_file", "read_file"]
    assert task_report["steps"][0]["target"] == "package.json"
    assert "target" not in task_report["steps"][1]
    assert task_report["answer"] == text
    assert task_report["label"] == "Find the test command"


def test_delegate_answer_exceeds_summary_cap_but_stays_within_answer_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = "a" * 6_000
    result = SubAgentInvocationResult(
        status="completed", response_text=text, decision=_decision(text=text), iterations_used=1
    )

    outcome, _progress = _run_delegate(monkeypatch, {"tasks": ["long"]}, {1: result})

    task_report = outcome.metadata["subagent_batch_report"]["tasks"][0]
    assert len(task_report["summary"]) <= 1_000
    assert 1_000 < len(task_report["answer"]) <= 4_000


def test_delegate_rejected_task_has_empty_steps_and_falls_back_to_ordinal_label(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result = SubAgentInvocationResult(
        status="completed", response_text="ok", decision=_decision(text="ok"), iterations_used=1
    )
    arguments = {"tasks": ["Inspect the schema", {"prompt": "", "task": "ambiguous"}]}

    outcome, progress = _run_delegate(monkeypatch, arguments, {1: result})

    tasks = outcome.metadata["subagent_batch_report"]["tasks"]
    assert tasks[0]["label"] == "Inspect the schema"
    assert tasks[1]["label"] == "Task 2"
    assert tasks[1]["steps"] == []
    assert "answer" not in tasks[1]
    child_labels = {
        (item["child_ordinal"], item["child_label"]) for item in progress if item.get("child_label")
    }
    assert child_labels == {(1, "Inspect the schema"), (2, "Task 2")}


def test_delegate_progress_labels_derive_from_prompt_for_every_emitter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        scheduler_module,
        "invoke_sub_agent",
        lambda **kwargs: SubAgentInvocationResult(
            status="completed",
            response_text="done",
            decision=_decision(text="done"),
            iterations_used=1,
        ),
    )
    runtime = _delegate_runtime()
    notifications: list[dict[str, Any]] = []
    runtime.notification_writer = notifications.append

    execute_delegate_tool(
        router=SimpleNamespace(_config=parse_runtime_config({"engine_type": "mock"})),
        arguments={"tasks": ["Map the sidecar seams\nextra detail", "Check the release notes"]},
        runtime=runtime,
        outcome_type=ToolExecutionOutcome,
        call_id="call",
    )

    child = [
        item["params"]
        for item in notifications
        if item["method"] == "agent.progress" and item["params"].get("child_task_id")
    ]
    by_status: dict[str, set[str]] = {}
    for item in child:
        by_status.setdefault(item["status"], set()).add(item["child_label"])
    assert by_status["queued"] == {"Map the sidecar seams", "Check the release notes"}
    assert by_status["running"] == by_status["queued"]
    assert by_status["completed"] == by_status["queued"]
