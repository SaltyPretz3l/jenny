"""HB-029 / MQ-013: a budget-deferred tool reads as loadable, never as a blocker.

The assembler knows a tool is deferred-but-loadable, but the runtime status used
to drop the flag, so every prompt renderer told the model the tool was
"unavailable ... state the exact blocker". A status is loadable only when it is
deferred and a usable ``tool_search`` is in the same contract; everything else
keeps today's blocker copy.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.builder_shared import RuntimeToolStatus
from sidecar.ai.mode_policy import MODE_ASSIST
from sidecar.ai.tools.assembly import (
    CONFIG_DISABLED_REASON,
    TOOL_NOT_EXPOSED_REASON,
    ToolAssemblyContext,
    assemble_tool_contract,
)
from sidecar.ai.tools.catalog import MANAGED_SIDECAR_SURFACE, CanonicalToolDescriptor
from sidecar.ai.tools.tool_search import ToolResolutionContext, build_search_index

_NOT_A_BLOCKER = (
    "A tool marked not loaded is not a blocker: load it with `tool_search`; "
    "do not work around it with `run_command` or `run_temp_script`."
)
_CONDITIONAL_BLOCKER = (
    "If a requested tool is unavailable (not merely not loaded), "
    "state the exact blocker from this block."
)


def _descriptor(name: str, tool_family: str) -> CanonicalToolDescriptor:
    return CanonicalToolDescriptor(
        name=name,
        description=f"{name} description",
        input_schema={"type": "object", "properties": {}},
        side_effecting=False,
        read_only=True,
        source_kind="synthetic" if name == "tool_search" else "builtin",
        tool_family=tool_family,
        server_name="runtime",
        runtime_registered=True,
    )


def _assembled_statuses(budget_filtered: frozenset[str]) -> dict[str, RuntimeToolStatus]:
    descriptors = (
        _descriptor("read_file", "filesystem"),
        _descriptor("web_search", "web"),
        _descriptor("tool_search", "discovery"),
    )
    resolution = ToolResolutionContext(
        deferred_names=frozenset(),
        budget_filtered_names=budget_filtered,
        search_index=build_search_index(budget_filtered, descriptors) if budget_filtered else None,
    )
    contract = assemble_tool_contract(
        descriptors,
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={},
            mode=MODE_ASSIST,
            workspace_root_present=True,
            resolution_context=resolution,
        ),
    )
    return {status.name: status for status in contract.status_entries}


def test_runtime_status_carries_deferred_flag() -> None:
    statuses = _assembled_statuses(frozenset({"web_search"}))

    assert statuses["web_search"].deferred is True
    assert statuses["web_search"].available is False
    assert statuses["web_search"].reason == TOOL_NOT_EXPOSED_REASON
    assert statuses["read_file"].deferred is False
    assert statuses["tool_search"].available is True
    assert statuses["tool_search"].deferred is False
    assert RuntimeToolStatus(name="x", display_name="X", available=True).deferred is False


def test_unusable_tool_search_is_not_marked_deferred() -> None:
    statuses = _assembled_statuses(frozenset())
    tool_search = statuses["tool_search"]

    # Same reason string as a deferred tool, but nothing is loadable through it.
    assert tool_search.available is False
    assert tool_search.reason == TOOL_NOT_EXPOSED_REASON
    assert tool_search.deferred is False
    digest = ContextBuilder._render_executable_tools(list(statuses.values()))
    assert "Not loaded this turn" not in digest


def _status(name: str, *, family: str = "filesystem", **overrides: Any) -> RuntimeToolStatus:
    fields: dict[str, Any] = {
        "name": name,
        "display_name": name,
        "available": False,
        "reason": TOOL_NOT_EXPOSED_REASON,
        "deferred": True,
        "tool_family": family,
    }
    fields.update(overrides)
    return RuntimeToolStatus(**fields)


_TOOL_SEARCH = RuntimeToolStatus(
    name="tool_search",
    display_name="Tool Search",
    available=True,
    tool_family="discovery",
)


def _prompt(tmp_path: Path, statuses: list[RuntimeToolStatus], content: str) -> str:
    return str(
        ContextBuilder(tmp_path).build_system_prompt(
            "Base system prompt.",
            latest_user_content=content,
            tool_statuses=statuses,
            include_skills=False,
            include_bootstrap=False,
        )
    )


def test_requested_availability_renders_deferred_tool_as_loadable(tmp_path: Path) -> None:
    prompt = _prompt(
        tmp_path,
        [_status("edit_file"), _TOOL_SEARCH],
        "Edit the matcher file to fix the rounding.",
    )

    assert "## Requested Tool Availability" in prompt
    assert (
        "- `edit_file` is not loaded this turn, but it is available: call `tool_search` "
        "with `select:edit_file` to load it, then call it directly."
    ) in prompt
    assert "`edit_file` is unavailable for this request" not in prompt
    assert f"{_NOT_A_BLOCKER}\n{_CONDITIONAL_BLOCKER}" in prompt
    assert "If the requested tool is unavailable, state the exact blocker" not in prompt


def test_deferred_tools_without_tool_search_keep_blocker_copy(tmp_path: Path) -> None:
    unusable_search = RuntimeToolStatus(
        name="tool_search",
        display_name="Tool Search",
        available=False,
        reason=TOOL_NOT_EXPOSED_REASON,
        tool_family="discovery",
    )
    for statuses in ([_status("edit_file")], [_status("edit_file"), unusable_search]):
        prompt = _prompt(tmp_path, statuses, "Edit the matcher file to fix the rounding.")

        assert (
            "- `edit_file` is unavailable for this request: "
            "model/runtime does not expose this turn."
        ) in prompt
        assert "not loaded this turn" not in prompt
        assert _NOT_A_BLOCKER not in prompt
        assert "If the requested tool is unavailable, state the exact blocker" in prompt


def test_mixed_deferred_and_config_disabled_keep_the_blocker_for_the_disabled_one(
    tmp_path: Path,
) -> None:
    prompt = _prompt(
        tmp_path,
        [
            _status("edit_file"),
            _status("write_file", reason=CONFIG_DISABLED_REASON, deferred=False),
            _TOOL_SEARCH,
        ],
        "Edit the matcher file and write a new file.",
    )

    assert "`edit_file` is not loaded this turn" in prompt
    assert "- `write_file` is unavailable for this request: config disabled." in prompt
    assert "select:write_file" not in prompt
    assert _CONDITIONAL_BLOCKER in prompt


def test_workspace_source_guidance_points_deferred_filesystem_tools_at_tool_search(
    tmp_path: Path,
) -> None:
    statuses = [_status(name) for name in ("read_file", "grep_search", "glob_files", "list_dir")]
    content = "Trace the source files for the reconciliation pipeline."

    prompt = _prompt(tmp_path, [*statuses, _TOOL_SEARCH], content)

    assert (
        "## Workspace Source Access\n"
        "Filesystem source tools are not loaded this turn: call `tool_search` with "
        "`select:read_file,grep_search,glob_files,list_dir` to load them, then inspect "
        "the workspace. Do not substitute `jenny_status` for source-code inspection."
    ) in prompt
    assert "Filesystem source tools are unavailable" not in prompt

    blocked = _prompt(tmp_path, statuses, content)
    assert (
        "Filesystem source tools are unavailable for this request: "
        "model/runtime does not expose this turn."
    ) in blocked
    assert "state this exact blocker" in blocked
