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
from sidecar.ai.routing.delegate_child_steps import (
    MAX_CHILD_ANSWER_CHARS,
    build_child_steps,
    child_answer,
    scrub_failed_paths,
)
from sidecar.ai.routing.delegate_contracts import (
    DelegateTask,
    build_compact_delegate_settlement,
    delegate_task_label,
    delegate_task_prompt,
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
        {
            "tool": "read_file",
            "display": "Read File",
            "ok": True,
            "target": "docs/plan.md",
            "path": "docs/plan.md",
        }
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
    assert steps[3]["target"] == "docs/manual.pdf"
    assert steps[3]["range"] == "p7"
    assert steps[4]["target"] == "docs/manual.pdf"
    assert steps[4]["range"] == "p3"
    assert "target" not in steps[5]
    assert "range" not in steps[5]


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


_EN = "\u2013"


@pytest.mark.parametrize(
    ("tool_input", "expected"),
    [
        ({"pages": "1-3"}, f"p1{_EN}3"),
        ({"pages": "2,5"}, "p2,5"),
        ({"pages": " 1 - 3 , 7 <b>x</b>"}, f"p1 {_EN} 3 , 7"),
        ({"page": 3}, "p3"),
        ({"offset": 0, "limit": 50}, f"lines 1{_EN}50"),
        ({"offset": 99, "limit": 10}, f"lines 100{_EN}109"),
        ({"offset": 10}, "from line 11"),
        ({"limit": 25}, f"lines 1{_EN}25"),
        ({"cursor": "opaque-token"}, "cont."),
        ({"headings": ["Install steps", "Other"]}, "\u00a7 Install steps"),
        # precedence: pages > page > offset/limit > cursor > headings
        ({"pages": "4", "page": 9, "offset": 1, "limit": 2, "cursor": "c"}, "p4"),
        ({"page": 9, "offset": 1, "limit": 2, "cursor": "c"}, "p9"),
        ({"offset": 1, "limit": 2, "cursor": "c", "headings": ["H"]}, f"lines 2{_EN}3"),
        ({"cursor": "c", "headings": ["H"]}, "cont."),
        # bool is never an int; invalid values yield nothing
        ({"page": True}, None),
        ({"offset": True, "limit": True}, None),
        ({"pages": "abc"}, None),
        ({"page": 0, "offset": -1, "limit": 0}, None),
        ({"cursor": "   "}, None),
        ({"headings": [""]}, None),
        ({"headings": []}, None),
        ({"headings": [5]}, None),
    ],
)
def test_step_range_forms_and_precedence(
    tool_input: dict[str, object], expected: str | None
) -> None:
    steps = build_child_steps(_decision(_outcome("read_pdf", tool_input=tool_input)))

    if expected is None:
        assert "range" not in steps[0]
    else:
        assert steps[0]["range"] == expected
        assert len(steps[0]["range"]) <= 40


def test_step_range_page_falls_back_to_metadata_and_cursor_is_never_echoed() -> None:
    steps = build_child_steps(
        _decision(
            _outcome("read_pdf", tool_input={"path": "a.pdf"}, metadata={"page": 4}),
            _outcome("read_file", tool_input={"path": "a.md", "cursor": "SECRET-CURSOR-VALUE"}),
        )
    )

    assert steps[0]["range"] == "p4"
    assert steps[1]["range"] == "cont."
    assert "SECRET-CURSOR-VALUE" not in json.dumps(steps)


def test_step_range_heading_and_pages_are_bounded_and_failed_steps_have_no_range() -> None:
    steps = build_child_steps(
        _decision(
            _outcome("read_file", tool_input={"headings": ["H" * 100]}),
            _outcome("read_pdf", tool_input={"pages": "1-2," * 40}),
            _outcome("read_pdf", success=False, tool_input={"pages": "1-3"}, output="Denied"),
        )
    )

    assert steps[0]["range"] == "\u00a7 " + "H" * 29 + "\u2026"
    assert len(steps[1]["range"]) == 40
    assert steps[1]["range"].endswith("\u2026")
    assert "range" not in steps[2]


def test_step_path_only_for_ok_steps_with_a_safe_relative_path() -> None:
    steps = build_child_steps(
        _decision(
            _outcome("read_file", tool_input={"path": "./src/app.py"}),
            _outcome("read_file", success=False, tool_input={"path": "src/app.py"}, output="no"),
            _outcome("read_file", tool_input={"path": "/home/me/repo/notes.md"}),
            _outcome("read_file", tool_input={"path": "../outside.md"}),
            _outcome("grep_search", tool_input={"pattern": "needle"}),
            _outcome("grep_search", tool_input={"pattern": "needle", "path": "src"}),
            _outcome("read_file", tool_input={"path": "~/notes.md"}),
            _outcome("edit_file", tool_input={"path": "src/app.py"}),
        )
    )

    assert steps[0]["path"] == "src/app.py"
    assert "path" not in steps[1]
    assert steps[2]["target"] == "notes.md"
    assert "path" not in steps[2]
    assert "path" not in steps[3]
    assert "path" not in steps[4]
    assert "path" not in steps[5], "a directory root is not a file link"
    assert "path" not in steps[6], "a home-relative path is not a workspace file"
    assert steps[7]["path"] == "src/app.py"


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


def test_label_cuts_at_the_first_sentence_end_without_an_ellipsis() -> None:
    def label(prompt: str) -> str:
        return delegate_task_label(DelegateTask(ordinal=1, prompt=prompt))

    assert label("Find the test command. Then report it back.") == "Find the test command."
    assert label("Is the build green? Check CI.") == "Is the build green?"
    assert label("Stop the build now! Really.") == "Stop the build now!"
    assert label("Stop now! Really.") == "Stop now! Really.", "too short to be a sentence"
    assert label("Read these files: a.py and b.py") == "Read these files: a.py and b.py"
    assert label("Read these files:") == "Read these files"
    assert label("No terminal punctuation here") == "No terminal punctuation here"


def test_label_cuts_long_text_at_a_word_boundary_with_an_ellipsis() -> None:
    prompt = "Investigate how the scheduler hands queued work to the sidecar worker pool today"

    result = delegate_task_label(DelegateTask(ordinal=1, prompt=prompt))

    assert result == "Investigate how the scheduler hands queued work to the\u2026"
    assert len(result) <= 60
    exact = "a" * 29 + " " + "b" * 30
    assert delegate_task_label(DelegateTask(ordinal=1, prompt=exact)) == exact
    # A sentence cut that still exceeds the bound is then cut by length.
    long_sentence = "Investigate how the scheduler hands queued work to the sidecar worker. Stop."
    cut = delegate_task_label(DelegateTask(ordinal=1, prompt=long_sentence))
    assert cut.endswith("\u2026")
    assert len(cut) <= 60


def test_label_hard_cuts_an_unbroken_token_to_sixty_chars() -> None:
    result = delegate_task_label(DelegateTask(ordinal=1, prompt="w" * 200))

    assert result == "w" * 59 + "\u2026"


# ---- delegate_task_prompt --------------------------------------------------


def test_prompt_keeps_lines_collapses_spaces_and_blank_runs_and_trims() -> None:
    prompt = "  Read   the  file\t\tnow  \n\n\n\n\n  - item one\n\n\nSecond   para  \n"

    result = delegate_task_prompt(DelegateTask(ordinal=1, prompt=prompt))

    assert result == "Read the file now\n\n- item one\n\nSecond para"
    assert delegate_task_prompt(DelegateTask(ordinal=2, prompt=None, error={"code": "x"})) == ""
    assert delegate_task_prompt(DelegateTask(ordinal=3, prompt="  \n ")) == ""


def test_prompt_is_bounded_to_two_thousand_chars_with_an_ellipsis() -> None:
    result = delegate_task_prompt(DelegateTask(ordinal=1, prompt="word " * 1_000))

    assert len(result) <= 2_000
    assert result.endswith("\u2026")
    short = "x" * 1_999
    assert delegate_task_prompt(DelegateTask(ordinal=1, prompt=short)) == short


def test_prompt_redacts_secrets_and_strips_format_controls() -> None:
    result = delegate_task_prompt(
        DelegateTask(ordinal=1, prompt="Use api_key=prompt-secret-value\u202e and report")
    )

    assert "prompt-secret-value" not in result
    assert "\u202e" not in result


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
    # No live activity reached the settled child; the rejected one has no transcript.
    assert tasks[0]["transcript"] == []
    assert "transcript" not in tasks[1] and "transcript_dropped" not in tasks[0]
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


def test_delegate_report_carries_prompt_range_path_and_truncation_but_parent_output_does_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = "tail " * 1_200
    decision = _decision(
        _outcome("read_pdf", tool_input={"path": "docs/manual.pdf", "pages": "1-3"}),
        text=text,
    )
    result = SubAgentInvocationResult(
        status="completed", response_text=text, decision=decision, iterations_used=1
    )
    prompt = "Summarise the manual.\nInclude the install steps."

    outcome, _progress = _run_delegate(monkeypatch, {"tasks": [prompt]}, {1: result})

    task_report = outcome.metadata["subagent_batch_report"]["tasks"][0]
    assert task_report["label"] == "Summarise the manual."
    assert task_report["prompt"] == prompt
    assert task_report["answer_truncated"] is True
    assert len(task_report["answer"]) <= 4_000
    assert task_report["steps"][0]["range"] == "p1\u20133"
    assert task_report["steps"][0]["path"] == "docs/manual.pdf"
    payload = json.loads(outcome.output)
    assert set(payload["results"][0]) <= {"answer", "evidence", "ordinal", "status"}
    for ui_only in (
        "prompt",
        "answer_truncated",
        "range",
        '"path"',
        "Summarise the manual.",
        "Include the install steps.",
    ):
        assert ui_only not in outcome.output


def test_delegate_answer_truncated_is_false_for_short_answers_and_rejected_tasks_get_a_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result = SubAgentInvocationResult(
        status="completed", response_text="ok", decision=_decision(text="ok"), iterations_used=1
    )
    arguments = {"tasks": ["Inspect the schema", {"prompt": "  bad   task ", "task": "ambiguous"}]}

    outcome, _progress = _run_delegate(monkeypatch, arguments, {1: result})

    tasks = outcome.metadata["subagent_batch_report"]["tasks"]
    assert tasks[0]["answer_truncated"] is False
    assert tasks[0]["prompt"] == "Inspect the schema"
    assert "prompt" in tasks[1]
    assert "answer_truncated" not in tasks[1]


def test_compact_parent_settlement_never_contains_the_label_or_prompt() -> None:
    report = {
        "ordinal": 1,
        "status": "completed",
        "answer": "done",
        "evidence": [],
        "label": "UNIQUE-LABEL-TEXT",
        "prompt": "UNIQUE-PROMPT-TEXT",
        "answer_truncated": True,
        "steps": [{"tool": "read_file", "ok": True, "range": "p1", "path": "a.md"}],
    }

    settlement = build_compact_delegate_settlement(execution="single", task_reports=[report])

    for needle in ("UNIQUE-LABEL-TEXT", "UNIQUE-PROMPT-TEXT", "answer_truncated", "range", "a.md"):
        assert needle not in settlement.output


def test_label_skips_list_markers_and_abbreviations() -> None:
    def label(prompt: str) -> str:
        return delegate_task_label(DelegateTask(ordinal=1, prompt=prompt))

    assert label("1. Find the entry point of the app") == "1. Find the entry point of the app"
    assert label("Check e.g. the config loader first") == "Check e.g. the config loader first"
    assert label("Dr. Smith's notes need a summary") == "Dr. Smith's notes need a summary"
    assert label("Investigate: why does the build fail") == "Investigate: why does the build fail"
    assert label("Summarize the release notes. Then stop.") == "Summarize the release notes."


def test_child_answer_flags_a_cut_even_when_the_overflow_is_whitespace() -> None:
    _summary, answer, cut = child_answer("a" * MAX_CHILD_ANSWER_CHARS + "   ", summary_chars=1_000)

    assert cut is True
    assert answer.endswith("[truncated]")
    assert child_answer("a" * MAX_CHILD_ANSWER_CHARS, summary_chars=1_000)[2] is False


def test_scrub_failed_paths_scrubs_every_line_within_the_caller_cap() -> None:
    text = (
        "Denied 'C:\\Users\\me\\My Docs\\a.txt'\n"
        "second line names /etc/shadow and secret.txt\n"
        "tail beyond the cap /var/log/x"
    )
    scrubbed = scrub_failed_paths(text, {"path": "../secret.txt"}, max_chars=80)
    assert "Users" not in scrubbed and "shadow" not in scrubbed and "secret.txt" not in scrubbed
    assert scrubbed.count("<path>") == 3
    assert "tail beyond" not in scrubbed
    assert scrub_failed_paths("ok /etc/x", "not a dict", max_chars=100) == "ok <path>"
