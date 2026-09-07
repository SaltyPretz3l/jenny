from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path
from types import ModuleType

import pytest


def _load_module() -> ModuleType:
    script = Path(__file__).resolve().parents[2] / "scripts" / "packaging" / "smoke_packaged_flow.py"
    name = "test_loader_smoke_packaged_flow_hygiene"
    spec = importlib.util.spec_from_file_location(name, script)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load smoke_packaged_flow.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_failed_command_reports_external_log_path(tmp_path: Path, monkeypatch) -> None:
    module = _load_module()
    log_path = tmp_path / "external" / "smoke.log"
    log_path.parent.mkdir()

    class _FakeProcess:
        returncode = 7

        def communicate(self, timeout: int):
            del timeout
            return "", "failed"

    monkeypatch.setattr(module.subprocess, "Popen", lambda *_args, **_kwargs: _FakeProcess())

    with pytest.raises(RuntimeError, match=re.escape(str(log_path.resolve()))):
        module._run_command(["failing-command"], log_path=log_path, timeout_seconds=5)


def test_packaged_paths_are_selected_for_the_host_platform(tmp_path: Path, monkeypatch) -> None:
    module = _load_module()
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module.sys, "platform", "linux")
    windows_resources = tmp_path / "dist" / "win-unpacked" / "resources"
    linux_resources = tmp_path / "dist" / "linux-unpacked" / "resources"
    windows_resources.mkdir(parents=True)
    linux_resources.mkdir(parents=True)

    assert module._resolve_resources_dir() == linux_resources


def test_macos_arch_specific_bundle_uses_jenny_name(tmp_path: Path, monkeypatch) -> None:
    module = _load_module()
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module.sys, "platform", "darwin")
    bundle = tmp_path / "dist" / "mac-arm64" / "Jenny.app" / "Contents"
    resources = bundle / "Resources"
    executable = bundle / "MacOS" / "Jenny"
    resources.mkdir(parents=True)
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"app")

    assert module._resolve_resources_dir() == resources
    assert module._resolve_packaged_app_path() == executable


def test_packaged_app_resolution_rejects_same_platform_ambiguity(
    tmp_path: Path, monkeypatch
) -> None:
    module = _load_module()
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module.sys, "platform", "linux")
    # Two host-platform layouts both carrying the app: "Jenny" vs "jenny" in one
    # directory would fold into a single path on a case-insensitive filesystem.
    for layout, payload in (("linux-unpacked", b"first"), ("linux-arm64-unpacked", b"second")):
        unpacked = tmp_path / "dist" / layout
        unpacked.mkdir(parents=True)
        (unpacked / "Jenny").write_bytes(payload)

    with pytest.raises(RuntimeError, match="ambiguous packaged app executable"):
        module._resolve_packaged_app_path()


def test_posix_packaged_timeout_terminates_owned_process_group(
    tmp_path: Path, monkeypatch
) -> None:
    module = _load_module()
    monkeypatch.setattr(module.sys, "platform", "linux")
    app_path = tmp_path / "Jenny"
    app_path.write_bytes(b"app")
    log_path = tmp_path / "smoke.log"
    output_path = tmp_path / "result.json"
    observed: dict[str, object] = {"descendant_alive": True}

    class _FakeProcess:
        pid = 4242

        def __init__(self, grouped: bool) -> None:
            self.grouped = grouped

        def poll(self):
            return None if observed["descendant_alive"] else 0

        def wait(self, timeout: int):
            del timeout
            return 0

        def kill(self) -> None:
            observed["descendant_alive"] = False

    def _fake_popen(_command, *, cwd, env, start_new_session=False):
        del cwd, env
        process = _FakeProcess(start_new_session)
        observed["process"] = process
        return process

    def _fake_killpg(pid: int, _signal: int) -> None:
        process = observed["process"]
        assert pid == process.pid
        if process.grouped:
            observed["descendant_alive"] = False

    ticks = iter((0.0, 2.0))
    monkeypatch.setattr(module.subprocess, "Popen", _fake_popen)
    monkeypatch.setattr(module.os, "killpg", _fake_killpg, raising=False)
    monkeypatch.setattr(module.time, "monotonic", lambda: next(ticks))

    with pytest.raises(RuntimeError, match="did not produce output"):
        module._run_packaged_app_smoke(
            app_path,
            log_path=log_path,
            timeout_seconds=1,
            output_path=output_path,
        )

    assert observed["process"].grouped is True
    assert observed["descendant_alive"] is False
