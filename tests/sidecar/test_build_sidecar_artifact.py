from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest


def _load_module() -> ModuleType:
    script = Path(__file__).resolve().parents[2] / "scripts" / "packaging" / "build_sidecar_artifact.py"
    name = "test_loader_build_sidecar_artifact_hygiene"
    spec = importlib.util.spec_from_file_location(name, script)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load build_sidecar_artifact.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("status_failure", ("nonzero", "timeout"))
def test_git_metadata_never_records_failed_status_as_clean(monkeypatch, status_failure: str) -> None:
    module = _load_module()

    def _fake_run(command: list[str], **_kwargs: object):
        if command[1:3] == ["rev-parse", "HEAD"]:
            return subprocess.CompletedProcess(command, 0, "a" * 40 + "\n", "")
        if status_failure == "timeout":
            raise subprocess.TimeoutExpired(command, 10)
        return subprocess.CompletedProcess(command, 1, "", "status unavailable")

    monkeypatch.setattr(module.subprocess, "run", _fake_run)

    assert module._git_metadata() == {"git_commit": "a" * 40, "git_dirty": None}


def test_run_command_bounds_the_drain_after_a_timeout(monkeypatch) -> None:
    """The post-kill drain must not be able to hang the packaging build.

    _run_command kills the tree when a build step overruns, then drains the
    pipes. That drain used to be unbounded, so a kill that did not take (a
    denied taskkill, a descendant that outlived its group) hung the build
    forever on the exact branch that exists to stop a runaway one.
    """
    module = _load_module()
    drain_timeouts: list[object] = []

    class _StuckProcess:
        pid = -1  # never a real pid; the tree kill is stubbed out below
        returncode = None

        def poll(self) -> None:
            return None

        def communicate(self, timeout=None):
            drain_timeouts.append(timeout)
            raise subprocess.TimeoutExpired(["probe"], timeout or 0)

    monkeypatch.setattr(module.subprocess, "Popen", lambda *_a, **_k: _StuckProcess())
    # Stubbed so the test never signals a real process.
    monkeypatch.setattr(module, "_terminate_process_tree", lambda _process: None)

    with pytest.raises(subprocess.TimeoutExpired):
        module._run_command(["probe"], timeout_seconds=1, env={})

    assert len(drain_timeouts) == 2, drain_timeouts
    assert drain_timeouts[0] == 1
    assert drain_timeouts[1] == module.DRAIN_TIMEOUT_SECONDS
    assert module.DRAIN_TIMEOUT_SECONDS > 0
