"""Builtin MCP server argv assembly, extracted from container.py.

The builtin-tools subprocess rebuilds its config entirely from argv, so this
module is the single place the parent process serializes tool config -- every
value here must be resolved in the PARENT (config, feature flags, the
sanctioned env overrides in sidecar.ai.config) because the subprocess spawns
with a scrubbed minimal environment.
"""

from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from sidecar.ai.config import (
    MCPServerConfig,
    RuntimeConfig,
    resolve_operation_ledger_root,
)
from sidecar.ai.feature_flags import (
    FEATURE_GIT_TRACKING,
    FEATURE_SHELL_SECURITY,
    is_feature_flag_enabled,
)


def _argv_safe_url(raw_url: str | None) -> str:
    """Strip userinfo from argv URLs; malformed credentialed URLs become empty."""
    if not raw_url:
        return ""
    try:
        parts = urlsplit(raw_url)
        username, password = parts.username, parts.password
        if username is None and password is None:
            return raw_url
        hostname, port = parts.hostname, parts.port
    except ValueError:
        return ""
    authority = f"[{hostname}]" if hostname and ":" in hostname else hostname or ""
    if port is not None:
        authority = f"{authority}:{port}"
    return urlunsplit((parts.scheme, authority, parts.path, parts.query, parts.fragment))


def _fail_soft_hostname(raw_url: str | None) -> str:
    try:
        return urlsplit(raw_url or "").hostname or ""
    except ValueError:
        return ""


def _workspace_recovery_version_root(electron_state_root: str | None) -> str:
    return (
        str(Path(electron_state_root) / "workspace-recovery" / "v1")
        if electron_state_root
        else ""
    )


def _skill_scope_mcp_args(config: RuntimeConfig) -> list[str]:
    """Forward the skill scope roots load_skill needs to reach outside the workspace.

    load_skill is the only tool that can reach the bundled/user/project skill
    scope roots the context builder advertises (see
    sidecar/ai/tools/builtins/skills.py) -- WorkspaceGuard confines every other
    tool to the tools workspace root, which those scope roots live outside of.
    Roots are paths, not secrets, so argv delivery matches --knowledge-root;
    forwarding is unconditional (unlike knowledge roots) because the tool
    itself is default-on.
    """
    args = [
        "--load-skill-enabled",
        "1" if config.tools_load_skill_enabled else "0",
        "--skill-bundled-root",
        config.skills_bundled_root or "",
        "--skill-bundled-enabled",
        "1" if config.skills_bundled_enabled else "0",
        "--skill-user-root",
        config.skills_user_root or "",
        "--skill-user-enabled",
        "1" if config.skills_user_enabled else "0",
        "--skill-project-root",
        config.skills_project_root or "",
        "--skill-project-enabled",
        "1" if config.skills_project_enabled else "0",
    ]
    for skill_id in config.skills_disabled_ids:
        args.extend(["--skill-disabled-id", skill_id])
    args.extend(["--skill-auto-index", config.skills_auto_index])
    return args


def _default_mcp_servers(
    config: RuntimeConfig,
    workspace_root: Path | None,
) -> tuple[MCPServerConfig, ...]:
    args = ["--workspace-root"]
    if workspace_root is None:
        args.append("")
    else:
        args.append(str(workspace_root))
    state_root = config.electron_state_root
    snapshot_root = str(Path(state_root) / "workspace-snapshots") if state_root else ""
    args.extend(
        [
            "--pre-change-snapshot-root",
            snapshot_root,
            "--workspace-recovery-root",
            _workspace_recovery_version_root(state_root),
            # Resolved in THIS process so config (and the sanctioned env
            # override) reach the builtin server despite its scrubbed
            # subprocess environment.
            "--operation-ledger-root",
            str(resolve_operation_ledger_root(config)),
        ]
    )
    args.extend(["--shell-enabled", "1" if config.tools_shell_enabled else "0"])
    args.extend(["--glob-enabled", "1" if config.tools_glob_enabled else "0"])
    args.extend(["--grep-enabled", "1" if config.tools_grep_enabled else "0"])
    args.extend(["--edit-enabled", "1" if config.tools_edit_file_enabled else "0"])
    args.extend(["--delete-file-enabled", "1" if config.tools_delete_file_enabled else "0"])
    args.extend(["--move-file-enabled", "1" if config.tools_move_file_enabled else "0"])
    # Tool-output distillation lives in the builtin-tools subprocess. It must be
    # threaded explicitly because the subprocess rebuilds its config from argv.
    args.extend(["--distill-enabled", "1" if config.tools_distill_enabled else "0"])
    args.extend(["--lsp-enabled", "1" if config.tools_lsp_enabled else "0"])
    args.extend(["--lsp-command-typescript", config.tools_lsp_command_typescript or ""])
    args.extend(["--lsp-command-python", config.tools_lsp_command_python or ""])
    args.extend(_skill_scope_mcp_args(config))
    args.extend(["--web-enabled", "1" if config.tools_web_enabled else "0"])
    args.extend(["--web-rate-limit-per-min", str(config.tools_web_rate_limit_per_min)])
    args.extend(["--web-max-fetch-bytes", str(config.tools_web_max_fetch_bytes)])
    args.extend(
        [
            "--web-allow-private-addresses",
            "1" if config.tools_web_allow_private_addresses else "0",
        ]
    )
    args.extend(["--web-search-provider", config.tools_web_search_provider])
    # Forward the searxng endpoint so the subprocess provider can reach it, but
    # strip any embedded basic-auth userinfo first: argv is world-readable, so a
    # credential-bearing self-hosted URL must not leak there (same rule as the
    # provider API keys, which are never placed on argv at all).
    args.extend(["--web-searxng-url", _argv_safe_url(config.tools_web_searxng_url)])
    args.extend(["--image-read-enabled", "1" if config.tools_image_read_enabled else "0"])
    args.extend(["--max-search-file-bytes", str(config.tools_max_search_file_bytes)])
    args.extend(["--max-edit-file-bytes", str(config.tools_max_edit_file_bytes)])
    args.extend(
        [
            "--workspace-manifest-enabled",
            "1" if config.tools_workspace_manifest_enabled else "0",
        ]
    )
    args.extend(["--rich-files-enabled", "1" if config.tools_rich_files_enabled else "0"])
    args.extend(["--knowledge-enabled", "1" if config.tools_knowledge_enabled else "0"])
    if config.tools_knowledge_enabled:
        # Flag-off must not advertise the user's folder paths in argv.
        for knowledge_root in config.knowledge_roots:
            args.extend(["--knowledge-root", knowledge_root])
    args.extend(
        [
            "--python-runtime-enabled", "1" if config.tools_python_runtime_enabled else "0",
            "--mermaid-enabled", "1" if config.tools_mermaid_enabled else "0",
            "--todo-enabled", "1" if config.tools_todo_enabled else "0",
            "--connections-enabled", "1" if config.tools_connections_enabled else "0",
            "--connections-engine-type", config.engine_type,
            "--connections-engine-host", _fail_soft_hostname(config.api_url),
            *[token for server in config.mcp_servers if server.transport != "stdio"
              for token in ("--connections-mcp-server", server.name, server.transport,
                            _fail_soft_hostname(server.url))],
        ]
    )
    args.extend(
        [
            "--python-runtime-timeout-seconds",
            str(config.tools_python_runtime_timeout_seconds),
        ]
    )
    args.extend(
        [
            "--python-runtime-max-memory-mb",
            str(config.tools_python_runtime_max_memory_mb),
        ]
    )
    args.extend(["--python-runtime-interpreter", config.tools_python_runtime_interpreter or ""])
    args.extend(["--python-runtime-root", config.tools_python_runtime_root or ""])
    args.extend(
        [
            "--python-runtime-bundled-python",
            config.tools_python_runtime_bundled_python or "",
        ]
    )
    args.extend(
        [
            "--python-runtime-wheelhouse-dir",
            config.tools_python_runtime_wheelhouse_dir or "",
        ]
    )
    # SECURITY: run_command runs *inside* this subprocess, so the shell-security
    # command classifier and git-operation telemetry are inert unless their
    # feature flags cross the boundary. Forward the two flags the subprocess
    # consumes as booleans (flag names, not secrets — argv-safe); anything else
    # stays behind the managed-config channel.
    feature_flags = config.feature_flags or {}
    args.extend(
        [
            "--shell-security-enabled",
            "1" if is_feature_flag_enabled(feature_flags, FEATURE_SHELL_SECURITY) else "0",
        ]
    )
    args.extend(
        [
            "--git-tracking-enabled",
            "1" if is_feature_flag_enabled(feature_flags, FEATURE_GIT_TRACKING) else "0",
        ]
    )
    if getattr(sys, "frozen", False):
        command_args = ["--mcp-builtin-server", *args]
    else:
        command_args = ["-m", "sidecar.ai.mcp.builtin_server", *args]
    builtin_servers = (
        MCPServerConfig(
            name="jenny_local_tools",
            transport="stdio",
            command=sys.executable,
            args=tuple(command_args),
            url=None,
            # The builtin server owns up to four concurrent tool subprocesses.
            # On Windows each one uses a bootstrap process before launching the
            # target, and Git for Windows may add a helper process.  The generic
            # five-process MCP ceiling therefore rejects valid Git calls with
            # ERROR_NOT_ENOUGH_QUOTA.  Keep the server bounded while accounting
            # for its documented nested-process topology.
            max_processes=16,
            # First-party server honors notifications/cancelled by aborting the
            # in-flight tool's owned subprocess tree, so Stop cancels the
            # running command instead of terminating the whole tool server.
            cooperative_cancel=True,
        ),
    )
    if config.mcp_servers:
        if any(server.name == "jenny_local_tools" for server in config.mcp_servers):
            return config.mcp_servers
        return (*builtin_servers, *config.mcp_servers)
    return builtin_servers
