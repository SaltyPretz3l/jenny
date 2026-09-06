from __future__ import annotations

import base64
from types import SimpleNamespace

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing.tool_execution import _descriptor_validation_outcome, approval_if_needed
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.policy import ToolPolicyDecision


def test_closed_schema_validation_uses_visible_arguments_without_private_attribution() -> None:
    descriptor = SimpleNamespace(
        input_schema={
            "type": "object",
            "properties": {
                "source": {"type": "string"},
                "destination": {"type": "string"},
            },
            "required": ["source", "destination"],
            "additionalProperties": False,
        }
    )
    visible = {"source": "old.txt", "destination": "new.txt"}
    call = ToolCallRequest(
        tool_id="move_file",
        arguments={
            **visible,
            "_jenny_turn_id": "turn-one",
            "_jenny_tool_call_id": "call-one",
            "_jenny_change_set_id": "01990f9a-8c51-7ad2-a8be-41190e0e1f21",
        },
        call_id="call-one",
    )

    outcome = _descriptor_validation_outcome(
        kernel=SimpleNamespace(),
        call=call,
        descriptor=descriptor,
        visible_tool_arguments=visible,
        request_id="turn-one",
        outcome_type=object,
    )

    assert outcome is None


@pytest.mark.parametrize(
    ("tool_name", "approvals_pre_granted", "expected_reason"),
    [
        pytest.param(
            "delete_file",
            False,
            "Moves this path into the workspace's .jenny/trash folder; "
            "move_file can restore it. Approve to continue.",
            id="delete-requires-approval",
        ),
        pytest.param("delete_file", True, None, id="delete-pre-granted"),
        pytest.param(
            "move_file",
            False,
            "Renames or moves workspace files. Approve to continue.",
            id="move-requires-approval",
        ),
        pytest.param("move_file", True, None, id="move-pre-granted"),
        pytest.param("write_file", False, None, id="ordinary-write-auto-runs"),
    ],
)
def test_auto_run_requires_approval_for_typed_destructive_tools(
    tool_name: str,
    approvals_pre_granted: bool,
    expected_reason: str | None,
) -> None:
    descriptor = SimpleNamespace(
        name=tool_name,
        side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        source_kind="mcp",
        tool_family="filesystem",
        server_name="tools",
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal"),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    contract = SimpleNamespace(
        entry=lambda name: SimpleNamespace(available=True, descriptor=descriptor)
    )
    call = ToolCallRequest(tool_id=tool_name, arguments={}, call_id="typed-tool")
    policy_decision = ToolPolicyDecision(
        decision="ask",
        stage="default",
        matched_rule_id=None,
        reason="side-effecting tool defaults to ask",
        snapshot_version=1,
        tool_name=tool_name,
        tool_family="filesystem",
        source_kind="mcp",
        mode="assist",
    )

    approval = approval_if_needed(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=approvals_pre_granted,
        resolution_context=None,
        tool_contract=contract,
        policy_decisions_by_call={"typed-tool": policy_decision},
        approval_mode="auto_run",
    )

    if expected_reason is None:
        assert approval is None
    else:
        assert approval is not None
        assert approval.reason == expected_reason


def test_auto_run_destructive_command_approval_carve_out() -> None:
    descriptor = SimpleNamespace(
        name="run_command",
        side_effecting=True,
        input_schema={"type": "object", "properties": {"command": {"type": "string"}}},
        source_kind="mcp",
        tool_family="shell",
        server_name="tools",
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            feature_flags={"shell_security": True},
            safety_mode="normal",
        ),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    contract = SimpleNamespace(
        entry=lambda name: SimpleNamespace(available=True, descriptor=descriptor)
    )
    destructive = ToolCallRequest(
        tool_id="run_command",
        arguments={"command": 'cd X && rmdir /s /q "old" & echo cleaned'},
        call_id="destructive",
    )
    safe = ToolCallRequest(
        tool_id="run_command",
        arguments={"command": "npm run build && node script.js"},
        call_id="safe",
    )

    approval = approval_if_needed(
        kernel,
        (destructive,),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=contract,
        approval_mode="auto_run",
    )
    safe_approval = approval_if_needed(
        kernel,
        (safe,),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=contract,
        approval_mode="auto_run",
    )
    pre_granted_approval = approval_if_needed(
        kernel,
        (destructive,),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=True,
        resolution_context=None,
        tool_contract=contract,
        approval_mode="auto_run",
    )

    assert approval is not None
    assert approval.reason == (
        "This command can delete or overwrite files (rmdir). Approve to continue."
    )
    assert safe_approval is None
    assert pre_granted_approval is None


def _auto_run_approval(  # noqa: PLR0913 - approval scenario fixture.
    tool_name: str,
    arguments: dict[str, object],
    *,
    shell_security: bool,
    strict_auto_run: bool = False,
    approvals_pre_granted: bool = False,
    policy_decision: ToolPolicyDecision | None = None,
) -> object | None:
    descriptor = SimpleNamespace(
        name=tool_name,
        side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        source_kind="mcp",
        tool_family="shell",
        server_name="tools",
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            feature_flags={
                "shell_security": shell_security,
                "strict_auto_run": strict_auto_run,
            },
            safety_mode="normal",
        ),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    contract = SimpleNamespace(
        entry=lambda name: SimpleNamespace(available=True, descriptor=descriptor)
    )
    return approval_if_needed(
        kernel,
        (ToolCallRequest(tool_id=tool_name, arguments=arguments, call_id="call"),),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=approvals_pre_granted,
        resolution_context=None,
        tool_contract=contract,
        policy_decisions_by_call={"call": policy_decision} if policy_decision else None,
        approval_mode="auto_run",
    )


@pytest.mark.parametrize(
    ("tool_name", "arguments", "expected_reason"),
    [
        ("delete_file", {"path": " old ", "recursive": True},
         "Moves old into the workspace's .jenny/trash folder, with everything under it; "
         "move_file can restore it. Approve to continue."),
        ("delete_file", {"file_path": "old"},
         "Moves old into the workspace's .jenny/trash folder; "
         "move_file can restore it. Approve to continue."),
        ("move_file", {"overwrite": True},
         "Renames or moves workspace files and overwrites any existing destination. "
         "Approve to continue."),
        ("move_file", {}, "Renames or moves workspace files. Approve to continue."),
    ],
    ids=["recursive-delete", "plain-delete", "overwrite-move", "plain-move"],
)
def test_destructive_approval_copy_matches_arguments(tool_name, arguments, expected_reason) -> None:
    approval = _auto_run_approval(tool_name, arguments, shell_security=False)
    assert approval is not None
    assert approval.reason == expected_reason


def test_delete_auto_policy_does_not_offer_always_allow() -> None:
    decision = ToolPolicyDecision(
        decision="auto", stage="rule", matched_rule_id="allow-delete",
        reason="explicit always allow", snapshot_version=1, tool_name="delete_file",
        tool_family="filesystem", source_kind="mcp", mode="assist",
    )
    approval = _auto_run_approval(
        "delete_file", {"path": "old"}, shell_security=False, policy_decision=decision,
    )
    assert approval is not None
    assert approval.policy_decision_id is None


def test_worktree_delete_requires_auto_run_approval() -> None:
    approval = _auto_run_approval(
        "worktree_delete", {"worktree_id": "registered-tree"}, shell_security=False,
    )
    assert approval is not None
    assert approval.reason == "Deletes the registered git worktree directory. Approve to continue."
    assert _auto_run_approval(
        "worktree_delete", {"worktree_id": "registered-tree"}, shell_security=False,
        approvals_pre_granted=True,
    ) is None


_ENCODED_REMOVE_ITEM = base64.b64encode(
    "Remove-Item -Recurse -Force x".encode("utf-16-le")
).decode("ascii")


@pytest.mark.parametrize("shell_security", [False, True])
@pytest.mark.parametrize(
    "command",
    [
        'bash -c "rm -rf x"',
        'bash -lc "rm -rf x"',
        'sh -c "rm -rf x"',
        "sh organize.sh",
        "wsl -- rm -rf old",
        'powershell -com "Remove-Item -Recurse -Force x"',
        'pwsh -Comman "Remove-Item -Recurse -Force x"',
        f"powershell -e {_ENCODED_REMOVE_ITEM}",
        "powershell -EncodedCommand not-valid!",
        r"%COMSPEC% /c rmdir /s /q a",
    ],
)
def test_interpreter_bypasses_prompt_under_auto_run(
    command: str,
    shell_security: bool,
) -> None:
    approval = _auto_run_approval(
        "run_command",
        {"command": command},
        shell_security=shell_security,
    )

    assert approval is not None


@pytest.mark.parametrize("shell_security", [False, True])
@pytest.mark.parametrize(
    "script",
    [
        r"Remove-Item -Recurse -Force C:\Users\me\Docs",
        "ri -Recurse -Force x",
        "Get-ChildItem . | Remove-Item -Recurse -Force",
        "`\nRemove-Item -Recurse -Force x",
    ],
)
def test_powershell_temp_script_prompts_under_auto_run(
    script: str,
    shell_security: bool,
) -> None:
    approval = _auto_run_approval(
        "run_temp_script",
        {"language": "powershell", "script": script},
        shell_security=shell_security,
    )

    assert approval is not None


@pytest.mark.parametrize("shell_security", [False, True])
def test_null_temp_script_language_falls_through_to_shell_detection(
    shell_security: bool,
) -> None:
    approval = _auto_run_approval(
        "run_temp_script",
        {"language": None, "script": "rmdir /s /q old"},
        shell_security=shell_security,
    )

    assert approval is not None


def test_destructive_approval_is_active_when_shell_security_is_disabled() -> None:
    approval = _auto_run_approval(
        "run_command",
        {
            "command": (
                'rmdir /s /q "a" & rmdir /s /q "b" & '
                "del /f /q organize.bat"
            )
        },
        shell_security=False,
    )

    assert approval is not None
    assert approval.reason == (
        "This command can delete or overwrite files (rmdir). Approve to continue."
    )


@pytest.mark.parametrize(
    ("command", "token"),
    [
        ('cmd /c rmdir /s /q "a"', "rmdir"),
        ('powershell -Command "Remove-Item -Recurse -Force x"', "Remove-Item"),
        ('find . -name "*.js" -delete', "find -delete"),
        ('sed -i "s/.*//" src/a.js', "sed -i"),
        ("type nul > important.js", ">"),
        ("git clean -xdff", "git clean"),
        (r".\organize.bat", "script:organize.bat"),
    ],
)
def test_destructive_command_shapes_prompt_under_auto_run(
    command: str,
    token: str,
) -> None:
    approval = _auto_run_approval(
        "run_command",
        {"command": command},
        shell_security=False,
    )

    assert approval is not None
    assert f"({token})" in approval.reason


def test_monitor_uses_the_same_always_active_shell_command_extractor() -> None:
    approval = _auto_run_approval(
        "monitor",
        {"command": 'rmdir /s /q "a" & del /f /q organize.bat'},
        shell_security=False,
    )

    assert approval is not None
    assert "(rmdir)" in approval.reason


@pytest.mark.parametrize(
    ("strict_auto_run", "approval_expected"),
    [(False, False), (True, True)],
)
def test_strict_auto_run_controls_non_destructive_classifier_approval(
    strict_auto_run: bool,
    approval_expected: bool,
) -> None:
    approval = _auto_run_approval(
        "run_command",
        {"command": "npm run build"},
        shell_security=True,
        strict_auto_run=strict_auto_run,
    )

    assert (approval is not None) is approval_expected
    if approval is not None:
        assert approval.reason == (
            "The requested shell command needs approval: "
            "executable requires approval: npm"
        )


@pytest.mark.parametrize("strict_auto_run", [False, True])
def test_strict_auto_run_allows_classifier_allowed_commands(
    strict_auto_run: bool,
) -> None:
    approval = _auto_run_approval(
        "run_command",
        {"command": "git status"},
        shell_security=True,
        strict_auto_run=strict_auto_run,
    )

    assert approval is None


@pytest.mark.parametrize(
    "command",
    [
        "npm run build > build.log",
        "npm test > test.log",
        "git log --oneline > /tmp/log",
        'echo "done" > status.txt',
        "npm run build 2>&1",
        "pytest -q 2>&1 | tee log.txt",
        "git clean -n",
        "git clean --dry-run",
    ],
)
def test_auto_run_allows_non_destructive_output_redirects(command: str) -> None:
    approval = _auto_run_approval(
        "run_command",
        {"command": command},
        shell_security=True,
    )

    assert approval is None


def test_strict_auto_run_prompts_for_log_capture_redirect() -> None:
    approval = _auto_run_approval(
        "run_command",
        {"command": "npm run build > build.log"},
        shell_security=True,
        strict_auto_run=True,
    )

    assert approval is not None
    assert "output overwrite redirect" in approval.reason


@pytest.mark.parametrize("strict_auto_run", [False, True])
def test_pre_granted_approval_suppresses_strict_auto_run_prompt(
    strict_auto_run: bool,
) -> None:
    approval = _auto_run_approval(
        "run_command",
        {"command": "npm run build"},
        shell_security=True,
        strict_auto_run=strict_auto_run,
        approvals_pre_granted=True,
    )

    assert approval is None


def test_python_temp_script_is_not_shell_classified() -> None:
    approval = _auto_run_approval(
        "run_temp_script",
        {"language": "python", "script": "d = {'a': 1}; del d['a']"},
        shell_security=True,
    )

    assert approval is None


def test_cmd_temp_script_requires_destructive_approval() -> None:
    approval = _auto_run_approval(
        "run_temp_script",
        {"language": "cmd", "script": 'rmdir /s /q "old"'},
        shell_security=False,
    )

    assert approval is not None
    assert "(rmdir)" in approval.reason
