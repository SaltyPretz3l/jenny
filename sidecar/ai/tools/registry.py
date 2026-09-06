"""Tool registry definitions."""

from __future__ import annotations

import importlib
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, cast

from sidecar.ai.tools.assembly import ToolAssemblyContext, assemble_tool_contract
from sidecar.ai.tools.builtins.filesystem_settings import configure_filesystem_tools
from sidecar.ai.tools.builtins.git_ops_settings import configure_git_tools
from sidecar.ai.tools.builtins.grep_search_settings import configure_grep_search
from sidecar.ai.tools.builtins.lsp_settings import configure_lsp_tools
from sidecar.ai.tools.builtins.shell_settings import configure_shell_security
from sidecar.ai.tools.builtins.skills import configure_skill_tool, load_skill_tool
from sidecar.ai.tools.catalog import (
    BUILTIN_MCP_SERVER_NAME,
    BUILTIN_MCP_SURFACE,
    build_tool_catalog,
)
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.distill import configure_distill
from sidecar.ai.tools.tool_call_healing import configure_tool_call_healing
from sidecar.ai.tools.workspace import WorkspaceGuard

ToolHandler = Callable[[dict[str, object], WorkspaceGuard], str | ToolHandlerResult]


def _lazy_tool_handler(module_name: str, handler_name: str) -> ToolHandler:
    resolved: ToolHandler | None = None

    def resolve() -> ToolHandler:
        nonlocal resolved
        if resolved is None:
            module = importlib.import_module(module_name)
            resolved = cast(ToolHandler, getattr(module, handler_name))
        return resolved

    def invoke(
        arguments: dict[str, object],
        workspace: WorkspaceGuard,
    ) -> str | ToolHandlerResult:
        return resolve()(arguments, workspace)

    # The target is now a STRING pair, so a typo in either half would surface as a
    # failure on first tool use rather than an ImportError at startup -- and these
    # handler modules are documented as deferred in check_sidecar_reachability.py,
    # which silences the gate that used to catch exactly that. `resolve` is exposed
    # so a test can force every binding to resolve without executing a handler.
    invoke.resolve = resolve  # type: ignore[attr-defined]
    invoke.lazy_target = (module_name, handler_name)  # type: ignore[attr-defined]
    return invoke


create_artifact_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.artifacts", "create_artifact_tool"
)
delete_file_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.delete_file", "delete_file_tool"
)
move_file_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.move_file", "move_file_tool"
)
edit_file_tool = _lazy_tool_handler("sidecar.ai.tools.builtins.edit_file", "edit_file_tool")
read_file_tool = _lazy_tool_handler("sidecar.ai.tools.builtins.filesystem", "read_file_tool")
list_dir_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.filesystem_listing", "list_dir_tool"
)
write_file_tool = _lazy_tool_handler("sidecar.ai.tools.builtins.filesystem", "write_file_tool")
git_status_tool = _lazy_tool_handler("sidecar.ai.tools.builtins.git_ops", "git_status_tool")
git_log_tool = _lazy_tool_handler("sidecar.ai.tools.builtins.git_ops", "git_log_tool")
git_diff_tool = _lazy_tool_handler("sidecar.ai.tools.builtins.git_ops", "git_diff_tool")
git_show_tool = _lazy_tool_handler("sidecar.ai.tools.builtins.git_ops", "git_show_tool")
glob_files_tool = _lazy_tool_handler("sidecar.ai.tools.builtins.glob_files", "glob_files_tool")
grep_search_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.grep_search", "grep_search_tool"
)
lsp_tool = _lazy_tool_handler("sidecar.ai.tools.builtins.lsp.tools", "lsp_tool")
run_command_tool = _lazy_tool_handler("sidecar.ai.tools.builtins.shell", "run_command_tool")
check_background_job_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.shell", "check_background_job_tool"
)
stop_background_job_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.shell", "stop_background_job_tool"
)
run_temp_script_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.temp_script", "run_temp_script_tool"
)
workspace_change_baseline_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.worktree_change_tracking",
    "workspace_change_baseline_tool",
)
workspace_change_delta_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.worktree_change_tracking",
    "workspace_change_delta_tool",
)
knowledge_search_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.knowledge.search", "knowledge_search_tool"
)
knowledge_view_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.knowledge.view", "knowledge_view_tool"
)
knowledge_exec_tool = _lazy_tool_handler(
    "sidecar.ai.tools.builtins.knowledge.exec_ops", "knowledge_exec_tool"
)


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    side_effecting: bool
    handler: ToolHandler
    input_schema: dict[str, Any] = field(default_factory=dict)


def _extract_flag_enabled(
    config: Any | None,
    key: str,
    *,
    default: bool = True,
) -> bool:
    value = config.get(key) if isinstance(config, dict) else getattr(config, key, None)
    return value if isinstance(value, bool) else default


def build_tool_bindings(
    *,
    config: Any | None = None,
    include_shell: bool | None = None,
) -> dict[str, ToolHandler]:
    shell_enabled = (
        include_shell
        if include_shell is not None
        else _extract_flag_enabled(config, "tools_shell_enabled", default=False)
    )
    configure_grep_search(config)
    configure_filesystem_tools(config)
    configure_git_tools(config)
    configure_distill(config)
    configure_tool_call_healing(config)
    configure_skill_tool(config)
    lsp_enabled = _extract_flag_enabled(config, "tools_lsp_enabled", default=False)
    _configure_lsp_bindings(config, enabled=lsp_enabled)
    from sidecar.ai.feature_flags import normalize_feature_flags

    raw_flags = (
        config.get("feature_flags", {})
        if isinstance(config, dict)
        else getattr(config, "feature_flags", {})
    )
    configure_shell_security(normalize_feature_flags(raw_flags or {}))

    bindings: dict[str, ToolHandler] = {
        "read_file": read_file_tool,
        "list_dir": list_dir_tool,
        "git_status": git_status_tool,
        "git_log": git_log_tool,
        "git_diff": git_diff_tool,
        "git_show": git_show_tool,
        "workspace_change_baseline": workspace_change_baseline_tool,
        "workspace_change_delta": workspace_change_delta_tool,
        "write_file": write_file_tool,
        "create_artifact": create_artifact_tool,
    }
    _add_file_operation_bindings(bindings, config=config)
    _add_runtime_feature_bindings(
        bindings,
        config=config,
        lsp_enabled=lsp_enabled,
        shell_enabled=shell_enabled,
    )
    _add_knowledge_bindings(
        bindings,
        config=config,
        enabled=_extract_flag_enabled(config, "tools_knowledge_enabled", default=False),
    )
    return bindings


def _add_file_operation_bindings(
    bindings: dict[str, ToolHandler],
    *,
    config: Any | None,
) -> None:
    if _extract_flag_enabled(config, "tools_glob_enabled", default=True):
        bindings["glob_files"] = glob_files_tool
    if _extract_flag_enabled(config, "tools_grep_enabled", default=True):
        bindings["grep_search"] = grep_search_tool
    if _extract_flag_enabled(config, "tools_edit_file_enabled", default=True):
        bindings["edit_file"] = edit_file_tool
    if _extract_flag_enabled(config, "tools_delete_file_enabled", default=True):
        bindings["delete_file"] = delete_file_tool
    if _extract_flag_enabled(config, "tools_move_file_enabled", default=True):
        bindings["move_file"] = move_file_tool


def _add_runtime_feature_bindings(
    bindings: dict[str, ToolHandler],
    *,
    config: Any | None,
    lsp_enabled: bool,
    shell_enabled: bool,
) -> None:
    if lsp_enabled:
        bindings["lsp"] = lsp_tool
    if shell_enabled:
        bindings["run_command"] = run_command_tool
        bindings["run_temp_script"] = run_temp_script_tool
        bindings["check_background_job"] = check_background_job_tool
        bindings["stop_background_job"] = stop_background_job_tool
    if _extract_flag_enabled(config, "tools_web_enabled", default=False):
        from sidecar.ai.tools.builtins.web import (  # noqa: PLC0415
            configure_web_tools,
            fetch_url_tool,
            web_search_tool,
        )

        configure_web_tools(config)
        bindings["web_search"] = web_search_tool
        bindings["fetch_url"] = fetch_url_tool
    if sys.platform == "win32" and _extract_flag_enabled(
        config,
        "tools_python_runtime_enabled",
        default=False,
    ):
        from sidecar.ai.tools.builtins.python_runtime import (  # noqa: PLC0415
            configure_python_runtime,
            python_execute_tool,
        )

        configure_python_runtime(config)
        bindings["python_execute"] = python_execute_tool
    if _extract_flag_enabled(config, "tools_todo_enabled", default=False):
        from sidecar.ai.tools.builtins.todo import todo_read_tool, todo_write_tool  # noqa: PLC0415

        bindings["todo_write"] = todo_write_tool
        bindings["todo_read"] = todo_read_tool
    if _extract_flag_enabled(config, "tools_connections_enabled", default=True):
        from sidecar.ai.tools.builtins.connections import (  # noqa: PLC0415
            build_connections_tool,
        )

        bindings["connections_list"] = build_connections_tool(config)
    if _extract_flag_enabled(config, "tools_mermaid_enabled", default=False):
        from sidecar.ai.tools.builtins.mermaid import mermaid_generate_tool  # noqa: PLC0415

        bindings["mermaid_generate"] = mermaid_generate_tool
    if _extract_flag_enabled(config, "tools_workspace_manifest_enabled", default=False):
        from sidecar.ai.tools.builtins.workspace_manifest_tool import (  # noqa: PLC0415
            workspace_manifest_read_tool,
        )

        bindings["workspace_manifest_read"] = workspace_manifest_read_tool
    if _extract_flag_enabled(config, "tools_load_skill_enabled", default=True):
        bindings["load_skill"] = load_skill_tool


def _add_knowledge_bindings(
    bindings: dict[str, ToolHandler],
    *,
    config: Any | None,
    enabled: bool,
) -> None:
    from sidecar.ai.tools.builtins.knowledge.roots import (  # noqa: PLC0415
        configure_knowledge_tools,
    )

    if not enabled:
        # Reset module state so a flag flip never leaves stale roots behind.
        configure_knowledge_tools(None)
        return
    # knowledge_view reuses the rich-file inspectors through injection; the
    # adapters return structured dependency-missing results themselves, so no
    # importability gating is needed here (unlike _add_rich_file_bindings,
    # which would otherwise advertise standalone tools that cannot run).
    from sidecar.ai.tools.builtins.rich_files.document import (  # noqa: PLC0415
        document_inspect_tool,
    )
    from sidecar.ai.tools.builtins.rich_files.notebook import (  # noqa: PLC0415
        notebook_inspect_tool,
    )
    from sidecar.ai.tools.builtins.rich_files.pdf import pdf_inspect_tool  # noqa: PLC0415
    from sidecar.ai.tools.builtins.rich_files.presentation import (  # noqa: PLC0415
        presentation_inspect_tool,
    )
    from sidecar.ai.tools.builtins.rich_files.spreadsheet import (  # noqa: PLC0415
        spreadsheet_inspect_tool,
    )

    configure_knowledge_tools(
        config,
        rich_adapters={
            "pdf": pdf_inspect_tool,
            "document": document_inspect_tool,
            "spreadsheet": spreadsheet_inspect_tool,
            "presentation": presentation_inspect_tool,
            "notebook": notebook_inspect_tool,
        },
    )
    bindings["knowledge_search"] = knowledge_search_tool
    bindings["knowledge_view"] = knowledge_view_tool
    bindings["knowledge_exec"] = knowledge_exec_tool


def _configure_lsp_bindings(config: Any | None, *, enabled: bool) -> None:
    if enabled:
        configure_lsp_tools(config)
        return
    configure_lsp_tools(config, detected_servers={})


def build_default_registry(
    *,
    config: Any | None = None,
    include_shell: bool | None = None,
) -> dict[str, ToolDefinition]:
    bindings = build_tool_bindings(config=config, include_shell=include_shell)
    descriptors = build_tool_catalog(
        config=config,
        bound_names=bindings.keys(),
        bound_server_name=BUILTIN_MCP_SERVER_NAME,
    )
    contract = assemble_tool_contract(
        descriptors,
        ToolAssemblyContext(
            surface=BUILTIN_MCP_SURFACE,
            config=config,
            engine_supports_tool_calling=True,
            mode="assist",
            plan_mode=False,
            tool_preferences=None,
            resolution_context=None,
            workspace_root_present=True,
            enforce_mode_policy=False,
            enforce_request_preferences=False,
            include_deferred_tools=False,
        ),
    )
    registry: dict[str, ToolDefinition] = {}
    for entry in contract.entries:
        handler = bindings.get(entry.descriptor.name)
        if handler is None or not entry.descriptor.runtime_registered:
            continue
        registry[entry.descriptor.name] = ToolDefinition(
            name=entry.descriptor.name,
            side_effecting=entry.descriptor.side_effecting,
            handler=handler,
            input_schema=dict(entry.descriptor.input_schema),
        )
    return registry
