"""First-party tool subprocess command-line configuration."""

import argparse
from typing import Any

from sidecar.ai.feature_flags import BUILTIN_DEFAULT_ON_FLAGS

# Subprocess defaults when no launcher argv is parsed (tests, in-process use).
DEFAULT_BUILTIN_FEATURE_FLAGS: dict[str, bool] = {
    "shell_security": False,
    "git_tracking": False,
    **{flag: True for flag in BUILTIN_DEFAULT_ON_FLAGS},
}
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})


def default_builtin_tool_config() -> dict[str, Any]:
    """``_default_tools`` config before any caller override (a fresh dict per call)."""
    return {
        "host_mode": "desktop",
        "host_execution_policy_version": None,
        "desktop_execution_policy_version": None,
        "pre_change_snapshot_root": None,
        "tools_glob_enabled": True,
        "tools_grep_enabled": True,
        "tools_edit_file_enabled": True,
        "tools_delete_file_enabled": True,
        "tools_move_file_enabled": True,
        "tools_distill_enabled": True,
        "tools_shell_enabled": False,
        "tools_web_enabled": False,
        "tools_web_rate_limit_per_min": 30,
        "tools_web_max_fetch_bytes": 1048576,
        "tools_web_allow_private_addresses": False,
        "tools_web_allow_loopback": False,
        "tools_web_search_provider": "duckduckgo",
        "tools_web_searxng_url": None,
        "tools_web_search_provider_keys": None,
        "tools_image_read_enabled": False,
        "tools_max_search_file_bytes": 2097152,
        "tools_max_edit_file_bytes": 2097152,
        "tools_python_runtime_enabled": False,
        "tools_python_runtime_timeout_seconds": 30,
        "tools_python_runtime_max_memory_mb": 512,
        "tools_python_runtime_interpreter": None,
        "tools_python_runtime_root": None,
        "tools_python_runtime_bundled_python": None,
        "tools_python_runtime_wheelhouse_dir": None,
        "tools_todo_enabled": False,
        "tools_connections_enabled": True,
        "connections_engine_type": "mock",
        "connections_engine_host": None,
        "connections_mcp_servers": (),
        "tools_workspace_manifest_enabled": False,
        "tools_rich_files_enabled": False,
        "tools_knowledge_enabled": False,
        "knowledge_roots": (),
        "tools_lsp_enabled": False,
        "tools_lsp_command_typescript": None,
        "tools_lsp_command_python": None,
        "tools_load_skill_enabled": True,
        "skills_bundled_root": None,
        "skills_bundled_enabled": True,
        "skills_user_root": None,
        "skills_user_enabled": True,
        "skills_project_root": None,
        "skills_project_enabled": True,
        "skills_disabled_ids": (),
        "skills_auto_index": "auto",
        "feature_flags": dict(DEFAULT_BUILTIN_FEATURE_FLAGS),
    }


def builtin_tool_config(
    args: argparse.Namespace,
    *,
    host_mode: str,
    host_execution_policy_version: int | None,
    desktop_execution_policy_version: int | None,
) -> dict[str, Any]:
    """``_default_tools`` config from the parsed launcher argv."""
    knowledge_roots = tuple(
        token
        for token in (str(item or "").strip() for item in (args.knowledge_roots or []))
        if token
    )
    skills_disabled_ids = tuple(
        token
        for token in (str(item or "").strip() for item in args.skills_disabled_ids)
        if token
    )[:256]
    return {
        "host_mode": host_mode,
        "host_execution_policy_version": host_execution_policy_version,
        "desktop_execution_policy_version": desktop_execution_policy_version,
        "pre_change_snapshot_root": str(args.pre_change_snapshot_root).strip() or None,
        "tools_glob_enabled": _parse_bool_arg(args.glob_enabled),
        "tools_grep_enabled": _parse_bool_arg(args.grep_enabled),
        "tools_edit_file_enabled": _parse_bool_arg(args.edit_enabled),
        "tools_delete_file_enabled": _parse_bool_arg(args.delete_file_enabled),
        "tools_move_file_enabled": _parse_bool_arg(args.move_file_enabled),
        "tools_distill_enabled": _parse_bool_arg(args.distill_enabled),
        "tools_shell_enabled": _parse_bool_arg(args.shell_enabled),
        "tools_web_enabled": _parse_bool_arg(args.web_enabled),
        "tools_web_rate_limit_per_min": int(str(args.web_rate_limit_per_min).strip() or "30"),
        "tools_web_max_fetch_bytes": int(str(args.web_max_fetch_bytes).strip() or "1048576"),
        "tools_web_allow_private_addresses": _parse_bool_arg(args.web_allow_private_addresses),
        "tools_web_allow_loopback": _parse_bool_arg(args.web_allow_loopback),
        "tools_web_search_provider": str(args.web_search_provider).strip() or "duckduckgo",
        "tools_web_searxng_url": str(args.web_searxng_url).strip() or None,
        "tools_image_read_enabled": _parse_bool_arg(args.image_read_enabled),
        "tools_max_search_file_bytes": int(
            str(args.max_search_file_bytes).strip() or "2097152"
        ),
        "tools_max_edit_file_bytes": int(str(args.max_edit_file_bytes).strip() or "2097152"),
        "tools_python_runtime_enabled": _parse_bool_arg(args.python_runtime_enabled),
        "tools_python_runtime_timeout_seconds": int(
            str(args.python_runtime_timeout_seconds).strip() or "30"
        ),
        "tools_python_runtime_max_memory_mb": int(
            str(args.python_runtime_max_memory_mb).strip() or "512"
        ),
        "tools_python_runtime_interpreter": str(args.python_runtime_interpreter).strip()
        or None,
        "tools_python_runtime_root": str(args.python_runtime_root).strip() or None,
        "tools_python_runtime_bundled_python": str(args.python_runtime_bundled_python).strip()
        or None,
        "tools_python_runtime_wheelhouse_dir": str(args.python_runtime_wheelhouse_dir).strip()
        or None,
        "tools_todo_enabled": _parse_bool_arg(args.todo_enabled),
        "tools_connections_enabled": _parse_bool_arg(args.connections_enabled),
        "connections_engine_type": str(args.connections_engine_type).strip() or "mock",
        "connections_engine_host": str(args.connections_engine_host).strip() or None,
        "connections_mcp_servers": tuple(
            (str(server[0]).strip(), str(server[1]).strip(), str(server[2]).strip())
            for server in args.connections_mcp_servers
        ),
        "tools_workspace_manifest_enabled": _parse_bool_arg(args.workspace_manifest_enabled),
        "tools_rich_files_enabled": _parse_bool_arg(args.rich_files_enabled),
        "tools_knowledge_enabled": _parse_bool_arg(args.knowledge_enabled),
        "knowledge_roots": knowledge_roots,
        "tools_lsp_enabled": _parse_bool_arg(args.lsp_enabled),
        "tools_lsp_command_typescript": str(args.lsp_command_typescript).strip() or None,
        "tools_lsp_command_python": str(args.lsp_command_python).strip() or None,
        "tools_load_skill_enabled": _parse_bool_arg(args.load_skill_enabled),
        "skills_bundled_root": str(args.skills_bundled_root).strip() or None,
        "skills_bundled_enabled": _parse_bool_arg(args.skills_bundled_enabled),
        "skills_user_root": str(args.skills_user_root).strip() or None,
        "skills_user_enabled": _parse_bool_arg(args.skills_user_enabled),
        "skills_project_root": str(args.skills_project_root).strip() or None,
        "skills_project_enabled": _parse_bool_arg(args.skills_project_enabled),
        "skills_disabled_ids": skills_disabled_ids,
        "skills_auto_index": args.skills_auto_index,
        "feature_flags": builtin_feature_flags(args),
    }


def _parse_bool_arg(value: object) -> bool:
    return str(value).strip().lower() in _TRUE_VALUES


def builtin_feature_flags(args: argparse.Namespace) -> dict[str, bool]:
    """Feature flags the subprocess handlers read, from the parsed argv."""
    flags = {
        "shell_security": args.shell_security_enabled,
        "git_tracking": args.git_tracking_enabled,
        **{flag: getattr(args, f"{flag}_enabled") for flag in BUILTIN_DEFAULT_ON_FLAGS},
    }
    return {key: str(value).strip().lower() in _TRUE_VALUES for key, value in flags.items()}


def _add_knowledge_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--knowledge-enabled", dest="knowledge_enabled", default="0")
    # Repeatable: one flag per registered knowledge root. Roots are paths, not
    # secrets, so argv delivery matches --workspace-root.
    parser.add_argument(
        "--knowledge-root",
        dest="knowledge_roots",
        action="append",
        default=[],
    )
    _add_semantic_catalog_arguments(parser)


def _add_semantic_catalog_arguments(parser: argparse.ArgumentParser) -> None:
    """Semantic catalog reader for knowledge_search (row 41).

    Paths, a loopback URL and a prompt template only: the embedder takes no
    key, and the index is opened read-only (the main sidecar owns the writer).
    """
    parser.add_argument("--semantic-catalog-db", dest="semantic_catalog_db", default="")
    parser.add_argument("--semantic-catalog-url", dest="semantic_catalog_url", default="")
    parser.add_argument(
        "--semantic-catalog-model-key", dest="semantic_catalog_model_key", default=""
    )
    parser.add_argument(
        "--semantic-catalog-query-template", dest="semantic_catalog_query_template", default=""
    )
    parser.add_argument("--semantic-catalog-dims", dest="semantic_catalog_dims", default="0")


def _add_web_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--web-enabled", dest="web_enabled", default="0")
    parser.add_argument("--web-rate-limit-per-min", dest="web_rate_limit_per_min", default="30")
    parser.add_argument("--web-max-fetch-bytes", dest="web_max_fetch_bytes", default="1048576")
    parser.add_argument(
        "--web-allow-private-addresses",
        dest="web_allow_private_addresses",
        default="0",
    )
    parser.add_argument("--web-allow-loopback", dest="web_allow_loopback", default="0")
    parser.add_argument(
        "--web-search-provider",
        dest="web_search_provider",
        default="duckduckgo",
    )
    # No CLI arg for provider API keys: argv is visible in process listings,
    # so key-based providers are configurable only through the managed sidecar
    # config channel (RuntimeConfig.tools_web_search_provider_keys).
    parser.add_argument("--web-searxng-url", dest="web_searxng_url", default="")


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    _add_host_arguments(parser)
    _add_workspace_arguments(parser)
    parser.add_argument("--glob-enabled", dest="glob_enabled", default="1")
    parser.add_argument("--grep-enabled", dest="grep_enabled", default="1")
    parser.add_argument("--edit-enabled", dest="edit_enabled", default="1")
    parser.add_argument("--delete-file-enabled", dest="delete_file_enabled", default="1")
    parser.add_argument("--move-file-enabled", dest="move_file_enabled", default="1")
    parser.add_argument("--shell-enabled", dest="shell_enabled", default="0")
    # SECURITY: gate the shell-security classifier and git-operation telemetry
    # that live in run_command's subprocess handler. Default off so a stale
    # launcher never silently claims guardrails it did not forward.
    parser.add_argument("--shell-security-enabled", dest="shell_security_enabled", default="0")
    parser.add_argument("--git-tracking-enabled", dest="git_tracking_enabled", default="0")
    # Row 60 behaviour kill switches: default on, so a stale launcher keeps them.
    for flag in BUILTIN_DEFAULT_ON_FLAGS:
        parser.add_argument(
            f"--{flag.replace('_', '-')}-enabled", dest=f"{flag}_enabled", default="1"
        )
    _add_web_arguments(parser)
    parser.add_argument("--image-read-enabled", dest="image_read_enabled", default="0")
    parser.add_argument("--max-search-file-bytes", dest="max_search_file_bytes", default="2097152")
    parser.add_argument("--max-edit-file-bytes", dest="max_edit_file_bytes", default="2097152")
    parser.add_argument("--python-runtime-enabled", dest="python_runtime_enabled", default="0")
    parser.add_argument(
        "--python-runtime-timeout-seconds",
        dest="python_runtime_timeout_seconds",
        default="30",
    )
    parser.add_argument(
        "--python-runtime-max-memory-mb",
        dest="python_runtime_max_memory_mb",
        default="512",
    )
    parser.add_argument(
        "--python-runtime-interpreter",
        dest="python_runtime_interpreter",
        default="",
    )
    parser.add_argument("--python-runtime-root", dest="python_runtime_root", default="")
    parser.add_argument(
        "--python-runtime-bundled-python",
        dest="python_runtime_bundled_python",
        default="",
    )
    parser.add_argument(
        "--python-runtime-wheelhouse-dir",
        dest="python_runtime_wheelhouse_dir",
        default="",
    )
    parser.add_argument("--todo-enabled", dest="todo_enabled", default="0")
    parser.add_argument("--connections-enabled", dest="connections_enabled", default="1")
    parser.add_argument(
        "--connections-engine-type", dest="connections_engine_type", default="mock"
    )
    parser.add_argument(
        "--connections-engine-host", dest="connections_engine_host", default=""
    )
    parser.add_argument(
        "--connections-mcp-server",
        dest="connections_mcp_servers",
        action="append",
        nargs=3,
        default=[],
    )
    parser.add_argument(
        "--workspace-manifest-enabled",
        dest="workspace_manifest_enabled",
        default="0",
    )
    parser.add_argument("--rich-files-enabled", dest="rich_files_enabled", default="0")
    _add_knowledge_arguments(parser)
    parser.add_argument("--distill-enabled", dest="distill_enabled", default="1")
    parser.add_argument("--lsp-enabled", dest="lsp_enabled", default="0")
    parser.add_argument(
        "--lsp-command-typescript",
        dest="lsp_command_typescript",
        default="",
    )
    parser.add_argument("--lsp-command-python", dest="lsp_command_python", default="")
    parser.add_argument("--load-skill-enabled", dest="load_skill_enabled", default="1")
    # Skill scope roots are paths, not secrets, so argv delivery matches
    # --workspace-root / --knowledge-root; the tool re-validates every read
    # against these roots regardless of what a caller requests.
    parser.add_argument("--skill-bundled-root", dest="skills_bundled_root", default="")
    parser.add_argument("--skill-bundled-enabled", dest="skills_bundled_enabled", default="1")
    parser.add_argument("--skill-user-root", dest="skills_user_root", default="")
    parser.add_argument("--skill-user-enabled", dest="skills_user_enabled", default="1")
    parser.add_argument("--skill-project-root", dest="skills_project_root", default="")
    parser.add_argument("--skill-project-enabled", dest="skills_project_enabled", default="1")
    parser.add_argument(
        "--skill-disabled-id", dest="skills_disabled_ids", action="append", default=[]
    )
    parser.add_argument(
        "--skill-auto-index",
        dest="skills_auto_index",
        choices=("auto", "on", "off"),
        default="auto",
    )
    return parser


def _add_host_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--host-mode", dest="host_mode", default="desktop")
    parser.add_argument(
        "--host-execution-policy-version",
        dest="host_execution_policy_version",
        default="",
    )
    parser.add_argument(
        "--desktop-execution-policy-version",
        dest="desktop_execution_policy_version",
        default="",
    )


def _add_workspace_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace-root", dest="workspace_root", default=None)
    parser.add_argument("--owned-process-ledger-path", default="")
    parser.add_argument("--owned-process-owner-pid", type=int, default=0)
    parser.add_argument(
        "--operation-ledger-root", dest="operation_ledger_root", default=""
    )
    parser.add_argument(
        "--pre-change-snapshot-root",
        dest="pre_change_snapshot_root",
        default="",
    )
    parser.add_argument(
        "--workspace-recovery-root", dest="workspace_recovery_root", default=""
    )
