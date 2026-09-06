"""Entry point: python -m sidecar.

IMPORT-COST NOTE: the `--owned-process-bootstrap` path is re-entered as a fresh
interpreter once per owned-process spawn, so it is dispatched before anything
heavier than `sys` is imported. `argparse` and `multiprocessing` are therefore
imported lazily rather than at module scope -- together they cost ~110ms, which
is pure overhead on every git subprocess the sidecar runs. See
`sidecar/_owned_process_bootstrap.py` for the budgets this protects.
"""

from __future__ import annotations

import sys
import typing
from typing import Sequence

# Stdlib-only by contract, and imported at module scope so the packaging analysis
# (PyInstaller walks `sidecar/__main__.py`) always collects the bootstrap child
# entry point. Bound as a MODULE, not as its members, so tests can monkeypatch
# `_owned_process_bootstrap.run_windows_owned_process_bootstrap` and have the
# dispatch below resolve the patched attribute at call time.
from sidecar import _owned_process_bootstrap

if typing.TYPE_CHECKING:
    import argparse

_GREP_SEARCH_WORKER_FLAG = "--grep-search-worker"


def _build_parser() -> argparse.ArgumentParser:
    import argparse

    parser = argparse.ArgumentParser(description="Companion sidecar module entrypoint.")
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="Run an import/bootstrap self-check and exit.",
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="Print sidecar API version and exit.",
    )
    parser.add_argument(
        "--prompt",
        default=None,
        help="Run one headless chat turn with the provided user prompt.",
    )
    parser.add_argument(
        "--config",
        default=None,
        help="Optional path to config JSON for headless mode.",
    )
    parser.add_argument(
        "--output-format",
        choices=("text", "json", "stream-json"),
        default="text",
        help="Headless output mode (only used with --prompt).",
    )
    parser.add_argument(
        "--permission-mode",
        choices=("prompt", "auto-readonly", "auto-tools", "dangerously-skip"),
        default="prompt",
        help="Headless approval handling policy.",
    )
    parser.add_argument(
        "--auto-approve-readonly",
        action="store_true",
        help="Alias for --permission-mode auto-readonly.",
    )
    parser.add_argument(
        "--auto-approve-tools",
        default=None,
        help="Alias for --permission-mode auto-tools with a regex allowlist.",
    )
    parser.add_argument(
        "--dangerously-skip-permissions",
        action="store_true",
        help="Alias for --permission-mode dangerously-skip.",
    )
    return parser


def _run_self_check() -> int:
    # Import core runtime modules used by packaged startup to verify module wiring.
    from sidecar.ai.container import BrainContainer
    from sidecar.protocol import API_VERSION
    from sidecar.runtime.request_dispatch import process_message

    _ = BrainContainer
    _ = process_message
    _ = API_VERSION
    return 0


def _run_server() -> None:
    from sidecar.server import main as run_server

    run_server()


def _run_builtin_mcp_server(argv: Sequence[str]) -> int:
    from sidecar.ai.mcp.builtin_server import main as run_builtin_server

    run_builtin_server(argv)
    return 0


def _run_owned_process_bootstrap() -> int:
    return _owned_process_bootstrap.run_windows_owned_process_bootstrap()


def _run_grep_search_worker() -> int:
    from sidecar.ai.tools.builtins.grep_search import _grep_search_worker_main

    return _grep_search_worker_main()


def run(argv: Sequence[str] | None = None) -> int:
    raw_args = list(argv) if argv is not None else list(sys.argv[1:])
    if raw_args == [_owned_process_bootstrap.BOOTSTRAP_FLAG]:
        return _run_owned_process_bootstrap()
    if raw_args and raw_args[0] == "--mcp-builtin-server":
        return _run_builtin_mcp_server(raw_args[1:])

    parser = _build_parser()
    arguments = parser.parse_args(raw_args)

    if arguments.self_check:
        return _run_self_check()

    if arguments.version:
        from sidecar.protocol import API_VERSION

        sys.stderr.write(f"{API_VERSION}\n")
        return 0

    if isinstance(arguments.prompt, str) and arguments.prompt.strip():
        from sidecar.runtime.headless import (
            permission_mode_flag_present,
            resolve_permission_mode,
            run_headless_from_args,
        )

        permission_mode_explicit = permission_mode_flag_present(raw_args)
        try:
            resolved_mode, resolved_pattern = resolve_permission_mode(
                permission_mode=str(arguments.permission_mode),
                permission_mode_explicit=permission_mode_explicit,
                auto_approve_readonly=bool(arguments.auto_approve_readonly),
                auto_approve_tools=(
                    str(arguments.auto_approve_tools).strip()
                    if isinstance(arguments.auto_approve_tools, str)
                    else None
                ),
                dangerously_skip_permissions=bool(arguments.dangerously_skip_permissions),
            )
        except ValueError as error:
            parser.error(str(error))
        arguments.resolved_permission_mode = resolved_mode
        arguments.resolved_auto_tools_pattern = resolved_pattern
        return run_headless_from_args(arguments)

    _run_server()
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Prepare frozen multiprocessing children before normal CLI dispatch.

    The owned-process bootstrap short-circuits ahead of `freeze_support()` so a
    spawn never pays the ~90ms `multiprocessing` import. That is safe because
    `freeze_support()` only acts when a frozen executable is re-launched as a
    multiprocessing spawn child, which it detects from that child's own argv
    markers -- argv here is exactly `[BOOTSTRAP_FLAG]`, never those markers -- and
    because the bootstrap child only waits on one `subprocess.Popen` of its
    target and never itself uses multiprocessing.
    """
    raw_args = list(argv) if argv is not None else list(sys.argv[1:])
    if raw_args == [_owned_process_bootstrap.BOOTSTRAP_FLAG]:
        return _run_owned_process_bootstrap()
    if raw_args == [_GREP_SEARCH_WORKER_FLAG]:
        return _run_grep_search_worker()

    import multiprocessing

    multiprocessing.freeze_support()
    return run(argv)


if __name__ == "__main__":
    raise SystemExit(main())
