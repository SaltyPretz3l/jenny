"""Dark-path coverage for sidecar.ai.routing.tool_execution.

All stubs are hand-built; no real subprocess, tool, or engine is spawned.
"""
from __future__ import annotations

import sys
from pathlib import Path as _Path
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.ai.routing.tool_execution as _te_mod
from sidecar.ai.error_codes import (
    CMP_LOOP_INVALID_TOOL_CALL,
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_COMMAND_BLOCKED,
    CMP_TOOL_DISABLED,
    CMP_TOOL_POLICY_DENIED,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_execution import (
    _descriptor_validation_outcome,
    _execute_delegate_synthetic_tool,
    _merge_result_metadata,
    approval_if_needed,
    classify_run_command_for_approval,
    inject_expected_read_snapshot,
    normalize_snapshot_lookup_path,
    rebuild_read_snapshot_cache,
    update_read_snapshot_cache,
)
from sidecar.ai.routing.tool_observation import (
    KIND_TOOL_EXECUTION_FAILED,
    KIND_TOOL_EXECUTION_OBSERVED,
    ToolObservationStore,
)
from sidecar.ai.tools.builtins.shell_security import ClassificationResult, CommandVerdict
from sidecar.ai.tools.contracts import ToolExecutionFailure, canonicalize_tool_arguments
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.policy import (
    POLICY_DECISION_DENY,
    ToolPolicyDecision,
    tool_policy_call_key,
)
from sidecar.runtime.tool_execution_support import CMP_LOOP_TOOL_INPUT_VALIDATION

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

REQUEST_ID = "req-dark-1"
SESSION_ID = "sess-dark-1"


def _outcome_type(*args: Any, **kwargs: Any) -> ToolExecutionOutcome:
    """Thin wrapper so tests can supply this as outcome_type."""
    return ToolExecutionOutcome(*args, **kwargs)


def _descriptor(
    name: str,
    *,
    side_effecting: bool = False,
    server_name: str = "tools",
    input_schema: dict[str, Any] | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        name=name,
        side_effecting=side_effecting,
        input_schema=input_schema or {"type": "object", "properties": {}},
        source_kind="mcp",
        tool_family="filesystem",
        server_name=server_name,
    )


def _make_policy_decision(
    decision: str,
    *,
    tool_name: str = "write_file",
    reason: str = "policy says so",
) -> ToolPolicyDecision:
    return ToolPolicyDecision(
        decision=decision,
        stage="rule",
        matched_rule_id="rule-1",
        reason=reason,
        snapshot_version=1,
        tool_name=tool_name,
        tool_family="filesystem",
        source_kind="mcp",
        mode="assist",
    )


def _runtime_with_store() -> tuple[LoopRuntime, ToolObservationStore]:
    store = ToolObservationStore()
    store.ensure_turn(request_id=REQUEST_ID)
    runtime = LoopRuntime(
        request_id=REQUEST_ID,
        trace_id="trace-dark-1",
        session_id=SESSION_ID,
        observation_store=store,
    )
    return runtime, store


def _audit_kinds(store: ToolObservationStore) -> list[str]:
    return [event.kind for event in store.recent_events(request_id=REQUEST_ID, limit=50)]


# ---------------------------------------------------------------------------
# Lines 373-374: approval_if_needed – descriptor is None, tool is run_command
#                with shell disabled → CMP_TOOL_DISABLED
# ---------------------------------------------------------------------------


def test_approval_if_needed_raises_disabled_when_unknown_run_command_shell_off() -> None:
    """Lines 373-374: descriptor is None AND call is run_command AND shell disabled."""
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            tools_shell_enabled=False,
            tools_confirm_side_effects=True,
            feature_flags={},
            safety_mode="normal",
        ),
        _is_direct_deferred_tool_call=lambda call, ctx: False,
        # tool_descriptor returns None → triggers the descriptor-is-None branch
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: None),
    )
    call = ToolCallRequest(tool_id="run_command", arguments={"command": "ls"}, call_id="c-rc-1")

    with pytest.raises(ToolExecutionFailure) as excinfo:
        approval_if_needed(
            kernel,
            (call,),
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=None,
        )

    assert excinfo.value.code == CMP_TOOL_DISABLED
    assert "shell tool is disabled" in excinfo.value.message
    assert excinfo.value.retryable is False


# ---------------------------------------------------------------------------
# Line 379: approval_if_needed – descriptor is None, not run_command
#           → CMP_LOOP_INVALID_TOOL_CALL
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("tool_id", ["ghost_tool", "subagent_run", "subagent_batch"])
def test_approval_if_needed_raises_invalid_tool_when_descriptor_none_unknown_tool(
    tool_id: str,
) -> None:
    """Line 379: descriptor is None for a non-run_command tool → invalid-tool-call."""
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            feature_flags={},
            safety_mode="normal",
        ),
        _is_direct_deferred_tool_call=lambda call, ctx: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: None),
    )
    call = ToolCallRequest(tool_id=tool_id, arguments={}, call_id="c-gt-1")

    with pytest.raises(ToolExecutionFailure) as excinfo:
        approval_if_needed(
            kernel,
            (call,),
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=None,
        )

    assert excinfo.value.code == CMP_LOOP_INVALID_TOOL_CALL
    assert "unknown tool" in excinfo.value.message
    assert tool_id in excinfo.value.message


# ---------------------------------------------------------------------------
# Line 385: approval_if_needed – descriptor found but name=="run_command" and
#           shell disabled → CMP_TOOL_DISABLED
# ---------------------------------------------------------------------------


def test_approval_if_needed_raises_disabled_when_run_command_descriptor_shell_off() -> None:
    """Line 385: descriptor present, name=run_command, shell disabled."""
    desc = _descriptor("run_command", side_effecting=True)
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            tools_shell_enabled=False,
            tools_confirm_side_effects=True,
            feature_flags={},
            safety_mode="normal",
        ),
        _is_direct_deferred_tool_call=lambda call, ctx: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: desc),
    )
    call = ToolCallRequest(tool_id="run_command", arguments={"command": "ls"}, call_id="c-rc-2")

    with pytest.raises(ToolExecutionFailure) as excinfo:
        approval_if_needed(
            kernel,
            (call,),
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=None,
        )

    assert excinfo.value.code == CMP_TOOL_DISABLED
    assert "shell tool is disabled" in excinfo.value.message


# ---------------------------------------------------------------------------
# Line 391: approval_if_needed – plan_mode + side_effecting → continue (no approval)
# ---------------------------------------------------------------------------


def test_approval_if_needed_plan_mode_skips_side_effecting_tool() -> None:
    """Line 391: plan_mode=True + side_effecting descriptor → loop continues, returns None."""
    desc = _descriptor("write_file", side_effecting=True)
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            feature_flags={},
            safety_mode="normal",
        ),
        _is_direct_deferred_tool_call=lambda call, ctx: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: desc),
    )
    call = ToolCallRequest(
        tool_id="write_file", arguments={"path": "x.txt", "content": "y"}, call_id="c-wf-pm"
    )

    result = approval_if_needed(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=None,
        read_only=True,
    )

    # The read-only boundary skips the side-effecting tool entirely.
    assert result is None


# ---------------------------------------------------------------------------
# Line 393: approval_if_needed – side_effecting + not mode_allows_side_effecting
#           → CMP_MODE_TOOL_BLOCKED
# ---------------------------------------------------------------------------


def test_approval_if_needed_raises_mode_blocked_when_side_effecting_and_mode_forbids() -> None:
    """Line 393: descriptor.side_effecting=True and mode_allows_side_effecting=False."""
    desc = _descriptor("write_file", side_effecting=True)
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            feature_flags={},
            safety_mode="normal",
        ),
        _is_direct_deferred_tool_call=lambda call, ctx: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: desc),
    )
    call = ToolCallRequest(
        tool_id="write_file", arguments={"path": "x.txt", "content": "y"}, call_id="c-wf-mb"
    )

    with pytest.raises(ToolExecutionFailure) as excinfo:
        approval_if_needed(
            kernel,
            (call,),
            mode="read_only",
            mode_allows_side_effecting=False,  # triggers line 392-397
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=None,
        )

    assert excinfo.value.code == CMP_MODE_TOOL_BLOCKED
    assert "read_only" in excinfo.value.message
    assert excinfo.value.retryable is False


# ---------------------------------------------------------------------------
# Line 406: approval_if_needed – shell_classification.verdict is BLOCKED
#           → CMP_TOOL_COMMAND_BLOCKED
# ---------------------------------------------------------------------------


def test_approval_if_needed_raises_blocked_when_shell_classification_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Line 406: classify_run_command_for_approval returns BLOCKED verdict."""
    desc = _descriptor("run_command", side_effecting=True)
    blocked_result = ClassificationResult(
        verdict=CommandVerdict.BLOCKED,
        reason="rm -rf is forbidden",
        executable="rm",
        raw_command="rm -rf /",
    )
    # Inject the shell-security feature flag as enabled and patch classify_command
    monkeypatch.setattr(
        _te_mod,
        "classify_command",
        lambda cmd, *, powershell=False: blocked_result,
    )
    monkeypatch.setattr(
        _te_mod,
        "is_feature_flag_enabled",
        lambda flags, feature: True,
    )

    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            feature_flags={"shell_security": True},
            safety_mode="normal",
        ),
        _is_direct_deferred_tool_call=lambda call, ctx: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: desc),
    )
    call = ToolCallRequest(
        tool_id="run_command",
        arguments={"command": "rm -rf /"},
        call_id="c-rc-blk",
    )

    with pytest.raises(ToolExecutionFailure) as excinfo:
        approval_if_needed(
            kernel,
            (call,),
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=None,
        )

    assert excinfo.value.code == CMP_TOOL_COMMAND_BLOCKED
    assert "rm -rf is forbidden" in excinfo.value.message


# ---------------------------------------------------------------------------
# Line 416: approval_if_needed – policy_decision.decision == POLICY_DECISION_DENY
#           → CMP_TOOL_POLICY_DENIED
# ---------------------------------------------------------------------------


def test_approval_if_needed_raises_denied_when_policy_decision_deny() -> None:
    """Line 416: policy decision is DENY → raises CMP_TOOL_POLICY_DENIED."""
    desc = _descriptor("write_file", side_effecting=True)
    policy_decision = _make_policy_decision(
        POLICY_DECISION_DENY, tool_name="write_file", reason="forbidden path"
    )
    call = ToolCallRequest(
        tool_id="write_file", arguments={"path": "x.txt", "content": "y"}, call_id="c-wf-deny"
    )
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            feature_flags={},
            safety_mode="normal",
        ),
        _is_direct_deferred_tool_call=lambda call, ctx: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: desc),
    )

    with pytest.raises(ToolExecutionFailure) as excinfo:
        approval_if_needed(
            kernel,
            (call,),
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=None,
            policy_decisions_by_call={tool_policy_call_key(call): policy_decision},
        )

    assert excinfo.value.code == CMP_TOOL_POLICY_DENIED
    assert "forbidden path" in excinfo.value.message
    assert excinfo.value.retryable is False


# ---------------------------------------------------------------------------
# Line 469: approval_if_needed – should_confirm + shell_classification is not
#           None (NEEDS_APPROVAL in paranoid mode) → reason uses shell reason
# ---------------------------------------------------------------------------


def test_approval_if_needed_should_confirm_uses_shell_reason_in_approval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Line 469: paranoid mode + NEEDS_APPROVAL shell classification → reason uses shell text."""
    desc = _descriptor("run_command", side_effecting=True)
    needs_approval_result = ClassificationResult(
        verdict=CommandVerdict.NEEDS_APPROVAL,
        reason="sudo detected",
        executable="sudo",
        raw_command="sudo apt-get install example-pkg",
    )
    monkeypatch.setattr(_te_mod, "classify_command", lambda cmd, *, powershell=False: needs_approval_result)
    monkeypatch.setattr(_te_mod, "is_feature_flag_enabled", lambda flags, feature: True)

    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            feature_flags={"shell_security": True},
            safety_mode="paranoid",  # paranoid → paranoid_mode=True
        ),
        _is_direct_deferred_tool_call=lambda call, ctx: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: desc),
    )
    call = ToolCallRequest(
        tool_id="run_command",
        arguments={"command": "sudo apt-get install example-pkg"},
        call_id="c-rc-paranoid",
    )

    # paranoid + NEEDS_APPROVAL → does NOT hit the early-continue at 448-449
    # (that path is gated on `not paranoid_mode`).
    # Falls through to should_confirm=True block. With shell_classification set,
    # the reason at line 469-471 overwrites the paranoid reason.
    approval = approval_if_needed(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=None,
    )

    assert approval is not None
    assert approval.tool_name == "run_command"
    # Line 469-471: reason must come from shell_classification, not the paranoid fallback
    assert "sudo detected" in approval.reason
    assert approval.tool_call_id == "c-rc-paranoid"
    assert approval.policy_scope == "Local command execution"
    assert approval.policy_consequence == "May run a local command and change local state."


# ---------------------------------------------------------------------------
# Line 527: classify_run_command_for_approval – feature flag NOT enabled → None
# ---------------------------------------------------------------------------


def test_classify_run_command_returns_none_when_shell_security_feature_disabled() -> None:
    """Line 527: descriptor_name is run_command but FEATURE_SHELL_SECURITY is off → None."""
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            feature_flags={},  # shell_security flag absent → disabled
        )
    )
    call = ToolCallRequest(
        tool_id="run_command",
        arguments={"command": "ls -la"},
        call_id="c-cls-1",
    )

    result = classify_run_command_for_approval(
        kernel,
        call,
        descriptor_name="run_command",
    )

    # Feature flag not set → returns None without calling classify_command
    assert result is None


# ---------------------------------------------------------------------------
# Lines 542-553: normalize_snapshot_lookup_path – absolute paths
# ---------------------------------------------------------------------------


def test_normalize_snapshot_lookup_path_absolute_with_workspace_root_returns_relative() -> None:
    """Lines 547-550: absolute path inside workspace root → posix relative path."""
    workspace = str(
        __import__("pathlib").Path(__file__).resolve().parent
    )
    target = str(__import__("pathlib").Path(workspace) / "sub" / "file.txt")

    kernel = SimpleNamespace(
        _config=SimpleNamespace(tools_workspace_root=workspace)
    )

    result = normalize_snapshot_lookup_path(kernel, target)

    assert result is not None
    assert result == "sub/file.txt"
    # Must be a POSIX path (forward slashes), not an absolute path
    assert not result.startswith("/")
    assert not result.startswith("C:")


def test_normalize_snapshot_lookup_path_absolute_outside_root_returns_posix_abs() -> None:
    """Lines 551-552: absolute path NOT relative to workspace root → absolute posix path."""
    if sys.platform == "win32":
        workspace = "C:/projects/sample-workspace"
        target = "D:/other/file.txt"
    else:
        workspace = "/projects/sample-workspace"
        target = "/other/file.txt"

    kernel = SimpleNamespace(
        _config=SimpleNamespace(tools_workspace_root=workspace)
    )

    result = normalize_snapshot_lookup_path(kernel, target)

    # The target is on a different drive / not under the workspace root, so
    # relative_to() raises ValueError and the function falls back to the
    # absolute posix form of the *target* (NOT the workspace root, NOT a
    # relative path). Pin the exact value so a wrong constant / wrong branch
    # (e.g. returning the relative path or the root) is caught.
    expected = _Path(target).resolve(strict=False).as_posix()
    assert result == expected
    # Must be the absolute target path, not a relative one and not the root.
    assert "other" in result
    assert "file.txt" in result
    assert "sample-workspace" not in result


def test_normalize_snapshot_lookup_path_absolute_no_workspace_root() -> None:
    """Line 553: absolute path with no workspace root → absolute posix string."""
    if sys.platform == "win32":
        target = "C:/some/path/to/file.txt"
    else:
        target = "/some/path/to/file.txt"

    kernel = SimpleNamespace(
        _config=SimpleNamespace(tools_workspace_root=None)
    )

    result = normalize_snapshot_lookup_path(kernel, target)

    # No workspace root → the absolute posix form of the target verbatim.
    expected = _Path(target).resolve(strict=False).as_posix()
    assert result == expected
    # Sanity: the full path segments survive and forward slashes are used.
    assert "some/path/to/file.txt" in result


# ---------------------------------------------------------------------------
# Line 579: update_read_snapshot_cache – partial scope snapshot with existing
#           full in cache and matching bytes/mtime → cache entry left intact
# Line 585: update_read_snapshot_cache – partial scope, no current_full in cache
#           → early return
# ---------------------------------------------------------------------------


def test_update_read_snapshot_cache_partial_scope_no_existing_full_noop() -> None:
    """Line 585: partial scope snapshot but no full entry in cache → cache unchanged."""
    kernel = SimpleNamespace(_config=SimpleNamespace(tools_workspace_root=None))
    cache: dict[str, Any] = {}
    metadata = {
        "read_snapshot": {
            "path": "src/example.py",
            "scope": "partial",  # NOT "full"
            "size_bytes": 100,
            "mtime_ns": 123456789,
        }
    }

    update_read_snapshot_cache(
        kernel,
        cache,
        tool_name="read_file",
        success=True,
        metadata=metadata,
    )

    # Partial scope + no existing full entry → cache stays empty
    assert cache == {}


def test_update_read_snapshot_cache_partial_scope_matching_full_leaves_cache_intact() -> None:
    """Line 579-591: partial scope snapshot; full entry in cache with matching bytes/mtime."""
    kernel = SimpleNamespace(_config=SimpleNamespace(tools_workspace_root=None))

    # Pre-populate cache with a full snapshot entry
    full_meta = {
        "path": "src/example.py",
        "scope": "full",
        "size_bytes": 200,
        "mtime_ns": 999000000,
        "sha256": "a" * 64,
    }
    cache: dict[str, Any] = {"src/example.py": full_meta}

    # Partial snapshot with SAME bytes+mtime → cache entry must NOT be evicted
    metadata = {
        "read_snapshot": {
            "path": "src/example.py",
            "scope": "partial",
            "size_bytes": 200,       # matches full_meta
            "mtime_ns": 999000000,   # matches full_meta
        }
    }

    update_read_snapshot_cache(
        kernel,
        cache,
        tool_name="read_file",
        success=True,
        metadata=metadata,
    )

    # Bytes+mtime match → cache NOT evicted
    assert "src/example.py" in cache
    assert cache["src/example.py"]["scope"] == "full"


def test_update_read_snapshot_cache_partial_scope_mismatched_bytes_evicts_cache() -> None:
    """Line 586-590: partial scope, mismatched size_bytes → cache entry popped."""
    kernel = SimpleNamespace(_config=SimpleNamespace(tools_workspace_root=None))

    full_meta = {
        "path": "src/example.py",
        "scope": "full",
        "size_bytes": 200,
        "mtime_ns": 999000000,
        "sha256": "b" * 64,
    }
    cache: dict[str, Any] = {"src/example.py": full_meta}

    metadata = {
        "read_snapshot": {
            "path": "src/example.py",
            "scope": "partial",
            "size_bytes": 999,       # DIFFERENT from full_meta → triggers eviction
            "mtime_ns": 999000000,
        }
    }

    update_read_snapshot_cache(
        kernel,
        cache,
        tool_name="read_file",
        success=True,
        metadata=metadata,
    )

    # Mismatch → entry evicted
    assert "src/example.py" not in cache


# ---------------------------------------------------------------------------
# Line 611: rebuild_read_snapshot_cache – non-dict message is skipped
# Line 618: rebuild_read_snapshot_cache – metadata not a dict → defaults to {}
# ---------------------------------------------------------------------------


def test_rebuild_read_snapshot_cache_skips_non_dict_messages() -> None:
    """Line 611: non-dict items in the message list are skipped."""
    kernel = SimpleNamespace(_config=SimpleNamespace(tools_workspace_root=None))

    messages: list[Any] = [
        "this is a string, not a dict",  # line 611 branch
        42,
        None,
    ]

    cache = rebuild_read_snapshot_cache(kernel, messages)

    # All non-dict messages skipped → empty cache
    assert cache == {}


def test_rebuild_read_snapshot_cache_missing_metadata_defaults_empty_dict() -> None:
    """Line 618: tool_result.metadata is not a dict (None) → metadata treated as {}."""
    kernel = SimpleNamespace(_config=SimpleNamespace(tools_workspace_root=None))

    # tool_result has metadata=None (non-dict) → line 617-618 sets metadata = {}
    messages: list[Any] = [
        {
            "tool_result": {
                "tool_name": "write_file",
                "is_error": False,
                "metadata": None,  # not a dict → triggers line 617-618
            }
        }
    ]

    cache = rebuild_read_snapshot_cache(kernel, messages)

    # No valid path in metadata → nothing cached but function must complete without error
    assert isinstance(cache, dict)
    assert cache == {}


# ---------------------------------------------------------------------------
# Line 644: inject_expected_read_snapshot – already has expected_read_snapshot
#           → early return with original dict unchanged
# ---------------------------------------------------------------------------


def test_inject_expected_read_snapshot_skips_when_snapshot_already_present() -> None:
    """Line 643-644: tool_arguments already has expected_read_snapshot → returned as-is."""
    kernel = SimpleNamespace(_config=SimpleNamespace(tools_workspace_root=None))

    existing_snapshot = {"path": "x.py", "scope": "full", "size_bytes": 0, "mtime_ns": 0}
    tool_arguments = {
        "file_path": "src/example.py",
        "content": "hello",
        "expected_read_snapshot": existing_snapshot,
    }
    cache: dict[str, Any] = {
        "src/example.py": {"path": "x.py", "scope": "full", "size_bytes": 999, "mtime_ns": 1}
    }

    result = inject_expected_read_snapshot(
        kernel,
        tool_name="edit_file",
        tool_arguments=tool_arguments,
        read_snapshot_cache=cache,
    )

    # Already has expected_read_snapshot → must return original dict unchanged
    assert result is tool_arguments
    # The snapshot from cache must NOT have overwritten the existing one
    assert result["expected_read_snapshot"] is existing_snapshot


def test_inject_expected_read_snapshot_resolves_write_file_legacy_alias() -> None:
    """write_file accepts the legacy file_path alias, which canonicalization remaps to
    path before the injector runs (freeze_effective_execution_inputs order). A small
    model that calls write_file(file_path=..., file_content=...) must still clear the
    read-before-write gate after it read the file — the exact loop seen with
    gpt-oss/gemma. The injector itself resolves only the canonical key."""
    kernel = SimpleNamespace(_config=SimpleNamespace(tools_workspace_root=None))

    cached = {
        "poem.md": {
            "path": "poem.md",
            "scope": "full",
            "size_bytes": 42,
            "mtime_ns": 7,
            "sha256": "c" * 64,
        }
    }
    tool_arguments = {"file_path": "poem.md", "file_content": "new"}

    canonical_arguments, _aliases = canonicalize_tool_arguments(
        tool_name="write_file",
        arguments=tool_arguments,
    )
    result = inject_expected_read_snapshot(
        kernel,
        tool_name="write_file",
        tool_arguments=dict(canonical_arguments),
        read_snapshot_cache=cached,
    )

    assert result["expected_read_snapshot"] == cached["poem.md"]
    # The canonical key path also resolves, and the original dict is not mutated.
    assert "expected_read_snapshot" not in tool_arguments
    assert (
        inject_expected_read_snapshot(
            kernel,
            tool_name="write_file",
            tool_arguments={"path": "poem.md", "content": "new"},
            read_snapshot_cache=cached,
        )["expected_read_snapshot"]
        == cached["poem.md"]
    )


# ---------------------------------------------------------------------------
# Lines 880, 884-885, 896: _execute_subagent_run_synthetic_tool
#   – calls _merge_result_metadata and audit when runtime is not None
#   – also tests the no-runtime path (line 884 branch False → line 896 directly)
# ---------------------------------------------------------------------------


def test_execute_delegate_synthetic_tool_merges_metadata_and_audits_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Lines 880, 884-885, 896: outcome returned and runtime.audit called on success."""
    canned_outcome = ToolExecutionOutcome(
        tool_name="delegate",
        output="subagent done",
        success=True,
        metadata={"from_subagent": "yes"},
        error_code=None,
        generated_artifacts=(),
    )

    monkeypatch.setattr(
        _te_mod,
        "execute_delegate_tool",
        lambda **kwargs: canned_outcome,
    )

    audit_calls: list[tuple[Any, ...]] = []

    class _AuditRuntime:
        def audit(self, kind: str, **kwargs: Any) -> None:
            audit_calls.append((kind,) + tuple(sorted(kwargs.items())))

    runtime = _AuditRuntime()
    kernel = SimpleNamespace()
    call = ToolCallRequest(tool_id="delegate", arguments={"tasks": ["research"]}, call_id="c-sa-1")

    result = _execute_delegate_synthetic_tool(
        kernel=kernel,
        call=call,
        tool_arguments={"tasks": ["research"]},
        visible_tool_arguments={"tasks": ["research"]},
        audit_metadata={"audit_run": "yes"},
        runtime=runtime,
        outcome_type=ToolExecutionOutcome,
    )

    # Line 880: metadata merged (from_subagent + audit_run both present)
    assert result.metadata.get("from_subagent") == "yes"
    assert result.metadata.get("audit_run") == "yes"

    # Line 884-885: audit was called once (success path)
    assert len(audit_calls) == 1
    audit_kind = audit_calls[0][0]
    assert audit_kind == KIND_TOOL_EXECUTION_OBSERVED

    # Line 896: outcome fields forwarded correctly
    assert result.success is True
    assert result.output == "subagent done"
    assert result.tool_name == "delegate"


def test_execute_delegate_synthetic_tool_audits_failure_kind(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Lines 884-885: failed outcome → audit with KIND_TOOL_EXECUTION_FAILED."""
    canned_outcome = ToolExecutionOutcome(
        tool_name="delegate",
        output="subagent crashed",
        success=False,
        metadata={},
        error_code="cmp.tool.failed",
        generated_artifacts=(),
    )

    monkeypatch.setattr(
        _te_mod,
        "execute_delegate_tool",
        lambda **kwargs: canned_outcome,
    )

    audit_calls: list[tuple[Any, ...]] = []

    class _AuditRuntime:
        def audit(self, kind: str, **kwargs: Any) -> None:
            audit_calls.append((kind, kwargs))

    runtime = _AuditRuntime()
    kernel = SimpleNamespace()
    call = ToolCallRequest(tool_id="delegate", arguments={}, call_id="c-sa-2")

    result = _execute_delegate_synthetic_tool(
        kernel=kernel,
        call=call,
        tool_arguments={},
        visible_tool_arguments={},
        audit_metadata=None,
        runtime=runtime,
        outcome_type=ToolExecutionOutcome,
    )

    # Failure path → audit must use FAILED kind
    assert len(audit_calls) == 1
    assert audit_calls[0][0] == KIND_TOOL_EXECUTION_FAILED

    # error_code propagated in audit
    audit_kwargs = audit_calls[0][1]
    assert audit_kwargs.get("error_code") == "cmp.tool.failed"

    # Line 896: outcome fields
    assert result.success is False
    assert result.error_code == "cmp.tool.failed"


def test_execute_delegate_synthetic_tool_no_runtime_skips_audit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Line 884 branch (runtime is None): audit is never called, line 896 reached directly."""
    canned_outcome = ToolExecutionOutcome(
        tool_name="delegate",
        output="silent success",
        success=True,
        metadata={"k": "v"},
        generated_artifacts=(),
    )

    monkeypatch.setattr(
        _te_mod,
        "execute_delegate_tool",
        lambda **kwargs: canned_outcome,
    )

    kernel = SimpleNamespace()
    call = ToolCallRequest(tool_id="delegate", arguments={}, call_id="c-sa-3")

    result = _execute_delegate_synthetic_tool(
        kernel=kernel,
        call=call,
        tool_arguments={},
        visible_tool_arguments={},
        audit_metadata={"extra": "data"},
        runtime=None,  # line 884 → False → skip audit
        outcome_type=ToolExecutionOutcome,
    )

    # Line 896: output still assembled correctly even without runtime
    assert result.output == "silent success"
    assert result.success is True
    # audit_metadata still merged (line 880)
    assert result.metadata.get("k") == "v"
    assert result.metadata.get("extra") == "data"


# ---------------------------------------------------------------------------
# _descriptor_validation_outcome: validation failure path
# (line 291 branch – raises ToolExecutionFailure from validate_tool_arguments)
# ---------------------------------------------------------------------------


def test_descriptor_validation_outcome_returns_failure_for_invalid_args() -> None:
    """Lines 291-324: validate_tool_arguments raises → outcome returned with validation error."""
    # Schema requires 'path' as a required property
    schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    }
    desc = _descriptor("write_file", side_effecting=True, input_schema=schema)
    call = ToolCallRequest(
        tool_id="write_file",
        arguments={},  # missing required "path" → fails validation
        call_id="c-dv-1",
        coerced=False,
    )

    counter_calls: list[str] = []

    class _Kernel:
        _route_counters: dict[str, int] = {}

        def _inc(self, kind: str) -> None:
            counter_calls.append(kind)

    kernel = SimpleNamespace(_route_counters={})

    # Patch increment_counter_for_kernel so we can verify it was called
    original = _te_mod.increment_counter_for_kernel

    def _fake_increment(k: Any, kind: str) -> None:
        counter_calls.append(kind)

    _te_mod.increment_counter_for_kernel = _fake_increment
    try:
        outcome = _descriptor_validation_outcome(
            kernel=kernel,
            call=call,
            descriptor=desc,
            visible_tool_arguments={},
            request_id=REQUEST_ID,
            outcome_type=ToolExecutionOutcome,
        )
    finally:
        _te_mod.increment_counter_for_kernel = original

    assert outcome is not None
    assert outcome.success is False
    assert outcome.error_code == CMP_LOOP_TOOL_INPUT_VALIDATION
    assert "write_file" in outcome.output
    assert "rejected malformed" in outcome.output
    # increment_counter_for_kernel must have been called with "validation_failure"
    assert "validation_failure" in counter_calls


# ---------------------------------------------------------------------------
# _merge_result_metadata: both branches (with and without audit_metadata)
# ---------------------------------------------------------------------------


def test_merge_result_metadata_with_audit_metadata_overwrites_base() -> None:
    """Lines 910-917: audit_metadata present → merged into result."""
    base = {"a": 1, "b": 2}
    audit = {"b": 99, "c": 3}

    result = _merge_result_metadata(base, audit)

    assert result["a"] == 1
    assert result["b"] == 99   # audit overwrites
    assert result["c"] == 3


def test_merge_result_metadata_without_audit_returns_copy_of_base() -> None:
    """Lines 910-917: no audit_metadata → returns a copy of base (not the same object)."""
    base = {"x": 10}

    result = _merge_result_metadata(base, None)

    assert result == {"x": 10}
    assert result is not base   # must be a copy
