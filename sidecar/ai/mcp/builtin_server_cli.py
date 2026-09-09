"""First-party tool subprocess command-line configuration."""

import argparse


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
    parser.add_argument("--web-enabled", dest="web_enabled", default="0")
    parser.add_argument("--web-rate-limit-per-min", dest="web_rate_limit_per_min", default="30")
    parser.add_argument("--web-max-fetch-bytes", dest="web_max_fetch_bytes", default="1048576")
    parser.add_argument(
        "--web-allow-private-addresses",
        dest="web_allow_private_addresses",
        default="0",
    )
    parser.add_argument(
        "--web-search-provider",
        dest="web_search_provider",
        default="duckduckgo",
    )
    # No CLI arg for provider API keys: argv is visible in process listings,
    # so key-based providers are configurable only through the managed sidecar
    # config channel (RuntimeConfig.tools_web_search_provider_keys).
    parser.add_argument("--web-searxng-url", dest="web_searxng_url", default="")
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
    parser.add_argument("--mermaid-enabled", dest="mermaid_enabled", default="0")
    parser.add_argument(
        "--workspace-manifest-enabled",
        dest="workspace_manifest_enabled",
        default="0",
    )
    parser.add_argument("--rich-files-enabled", dest="rich_files_enabled", default="0")
    parser.add_argument("--knowledge-enabled", dest="knowledge_enabled", default="0")
    # Repeatable: one flag per registered knowledge root. Roots are paths, not
    # secrets, so argv delivery matches --workspace-root.
    parser.add_argument(
        "--knowledge-root",
        dest="knowledge_roots",
        action="append",
        default=[],
    )
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
