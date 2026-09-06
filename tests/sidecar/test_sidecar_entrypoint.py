from __future__ import annotations

import sys

import pytest

import sidecar.__main__ as sidecar_main
import sidecar.runtime.headless as headless_runtime
from sidecar.protocol import API_VERSION


def test_sidecar_entrypoint_self_check_exits_successfully() -> None:
    assert sidecar_main.run(["--self-check"]) == 0


def test_main_prepares_frozen_multiprocessing_before_cli_dispatch(monkeypatch) -> None:
    calls: list[object] = []

    # `multiprocessing` is imported lazily inside `main()` (module scope would cost
    # ~90ms on every owned-process spawn), so patch the canonical module object
    # rather than an attribute of the entrypoint. `main()` still resolves
    # `freeze_support` through it, so the ordering contract below is unchanged.
    import multiprocessing

    monkeypatch.setattr(
        multiprocessing,
        "freeze_support",
        lambda: calls.append("freeze_support"),
    )
    monkeypatch.setattr(
        sidecar_main,
        "run",
        lambda argv=None: calls.append(tuple(argv or ())) or 17,
    )

    assert sidecar_main.main(["--self-check"]) == 17
    assert calls == ["freeze_support", ("--self-check",)]


def test_sidecar_entrypoint_version_probe_outputs_api_version(capsys) -> None:
    exit_code = sidecar_main.run(["--version"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert API_VERSION in captured.err


def test_sidecar_entrypoint_default_executes_server(monkeypatch) -> None:
    called = {"count": 0}

    def _fake_run_server() -> None:
        called["count"] += 1

    monkeypatch.setattr(sidecar_main, "_run_server", _fake_run_server)

    assert sidecar_main.run([]) == 0
    assert called["count"] == 1


def test_sidecar_entrypoint_dispatches_packaged_builtin_mcp_server(monkeypatch) -> None:
    from sidecar.ai.mcp import builtin_server

    called: dict[str, object] = {}

    def _fake_run_builtin_server(argv=None) -> None:
        called["argv"] = list(argv or [])

    monkeypatch.setattr(builtin_server, "main", _fake_run_builtin_server)

    exit_code = sidecar_main.run(
        ["--mcp-builtin-server", "--workspace-root", "C:/repo", "--shell-enabled", "1"]
    )

    assert exit_code == 0
    assert called["argv"] == ["--workspace-root", "C:/repo", "--shell-enabled", "1"]


def test_sidecar_entrypoint_dispatches_owned_process_bootstrap(monkeypatch) -> None:
    from sidecar import _owned_process_bootstrap

    monkeypatch.setattr(
        _owned_process_bootstrap,
        "run_windows_owned_process_bootstrap",
        lambda: 23,
    )

    assert sidecar_main.run(["--owned-process-bootstrap"]) == 23


def test_sidecar_entrypoint_main_dispatches_bootstrap_before_multiprocessing(
    monkeypatch,
) -> None:
    """`main()` must short-circuit the bootstrap ahead of `freeze_support()`.

    Every owned-process spawn re-enters this entrypoint in a fresh interpreter,
    so importing `multiprocessing` on that path costs ~90ms per git subprocess.
    Asserting on `main()` (not `run()`) is the point: `run()` never touched
    `multiprocessing`, so only the `main()` path can regress this.
    """
    from sidecar import _owned_process_bootstrap

    monkeypatch.setattr(
        _owned_process_bootstrap,
        "run_windows_owned_process_bootstrap",
        lambda: 31,
    )
    monkeypatch.delitem(sys.modules, "multiprocessing", raising=False)

    assert sidecar_main.main(["--owned-process-bootstrap"]) == 31
    assert "multiprocessing" not in sys.modules, (
        "the bootstrap fast path imported multiprocessing; it must dispatch first"
    )


def test_sidecar_entrypoint_main_dispatches_grep_worker_before_multiprocessing(
    monkeypatch,
) -> None:
    monkeypatch.setattr(sidecar_main, "_run_grep_search_worker", lambda: 37)
    monkeypatch.delitem(sys.modules, "multiprocessing", raising=False)

    assert sidecar_main.main(["--grep-search-worker"]) == 37
    assert "multiprocessing" not in sys.modules


def test_sidecar_entrypoint_prompt_dispatches_headless_runner(monkeypatch) -> None:
    called: dict[str, object] = {}

    def _fake_run_headless_from_args(arguments) -> int:
        called["prompt"] = arguments.prompt
        called["permission_mode"] = arguments.resolved_permission_mode
        return 7

    monkeypatch.setattr(
        headless_runtime,
        "run_headless_from_args",
        _fake_run_headless_from_args,
    )

    exit_code = sidecar_main.run(["--prompt", "run headless"])

    assert exit_code == 7
    assert called["prompt"] == "run headless"
    assert called["permission_mode"] == "prompt"


def test_sidecar_entrypoint_rejects_conflicting_permission_flags() -> None:
    with pytest.raises(SystemExit) as error:
        sidecar_main.run(
            [
                "--prompt",
                "hello",
                "--permission-mode",
                "prompt",
                "--auto-approve-readonly",
            ]
        )
    assert error.value.code == 2
