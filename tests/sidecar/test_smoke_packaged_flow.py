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


def test_parser_defaults_and_rejects_unknown_composition() -> None:
    module = _load_module()

    args = module._parse_args([])

    assert args.existing_artifacts is False
    assert args.composition == "dev"
    with pytest.raises(SystemExit):
        module._parse_args(["--composition", "nope"])


def test_existing_artifacts_skips_build_and_logs_composition(
    tmp_path: Path, monkeypatch
) -> None:
    module = _load_module()
    log_path = tmp_path / "smoke.log"

    def _unexpected_build(**_kwargs):
        raise AssertionError("packaged artifacts must not be rebuilt")

    def _missing_resources():
        raise RuntimeError("missing packaged directory")

    monkeypatch.setattr(module, "_build_packaged_directory", _unexpected_build)
    monkeypatch.setattr(module, "_resolve_resources_dir", _missing_resources)

    assert module.main(
        [
            "--existing-artifacts",
            "--composition",
            "release",
            "--log-path",
            str(log_path),
        ]
    ) == 1
    assert log_path.read_text(encoding="utf-8").splitlines()[:3] == [
        "Packaging smoke log",
        "existing_artifacts=true",
        "composition=release",
    ]


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


def test_build_packaged_directory_without_hosts_runs_release_commands(
    tmp_path: Path, monkeypatch
) -> None:
    module = _load_module()
    commands: list[list[str]] = []
    monkeypatch.setattr(
        module,
        "_run_command",
        lambda command, **_kwargs: commands.append(command),
    )

    module._build_packaged_directory(
        log_path=tmp_path / "smoke.log",
        timeout_seconds=30,
        env={},
        build_hosts=False,
    )

    assert commands == [
        [module.NPM_COMMAND, "run", "build:preload"],
        [sys.executable, "scripts/packaging/build_sidecar_artifact.py"],
        [
            module.NPM_COMMAND,
            "exec",
            "--",
            "electron-builder",
            "--dir",
            "--config",
            "electron-builder.yml",
            "--publish",
            "never",
        ],
    ]
    assert not any(
        "restricted_host" in part or "full_host" in part
        for command in commands
        for part in command
    )


def test_build_packaged_directory_with_hosts_runs_dev_commands(
    tmp_path: Path, monkeypatch
) -> None:
    module = _load_module()
    commands: list[list[str]] = []
    monkeypatch.setattr(
        module,
        "_run_command",
        lambda command, **_kwargs: commands.append(command),
    )

    module._build_packaged_directory(
        log_path=tmp_path / "smoke.log",
        timeout_seconds=30,
        env={},
        build_hosts=True,
    )

    assert commands == [
        [module.NPM_COMMAND, "run", "build:preload"],
        [sys.executable, "scripts/packaging/build_sidecar_artifact.py"],
        [sys.executable, "scripts/packaging/build_restricted_host_artifact.py"],
        [sys.executable, "scripts/packaging/build_full_host_supervisor_artifact.py"],
        [
            module.NPM_COMMAND,
            "exec",
            "--",
            "electron-builder",
            "--dir",
            "--config",
            "electron-builder.yml",
            "--publish",
            "never",
        ],
    ]


def test_release_composition_skips_packaged_host_validation(
    tmp_path: Path, monkeypatch
) -> None:
    module = _load_module()

    def _unexpected_validation(*_args, **_kwargs):
        raise AssertionError("host validation must be skipped")

    monkeypatch.setattr(module, "_validate_packaged_restricted_host", _unexpected_validation)
    monkeypatch.setattr(module, "_validate_packaged_full_host_supervisor", _unexpected_validation)

    result = module._validate_packaged_hosts(
        tmp_path,
        log_path=tmp_path / "smoke.log",
        allow_stale_source=False,
        validate_hosts=False,
    )

    assert result is None


def _prepare_existing_artifacts_main_until_host_validation(
    module: ModuleType, tmp_path: Path, monkeypatch
) -> Path:
    log_path = tmp_path / "smoke.log"
    resources_dir = tmp_path / "resources"
    artifact_path = tmp_path / "sidecar"
    manifest_path = tmp_path / "sidecar.manifest.json"

    def _unexpected_build(**_kwargs):
        raise AssertionError("packaged artifacts must not be rebuilt")

    def _stop_after_host_validation(*_args, **_kwargs):
        raise RuntimeError("stop")

    monkeypatch.setattr(module, "_build_packaged_directory", _unexpected_build)
    monkeypatch.setattr(module, "_resolve_resources_dir", lambda: resources_dir)
    monkeypatch.setattr(
        module,
        "_wait_for_packaged_artifact_validation",
        lambda *_args, **_kwargs: (artifact_path, manifest_path),
    )
    monkeypatch.setattr(
        module,
        "_run_command",
        lambda *_args, **_kwargs: module.subprocess.CompletedProcess(
            args=[], returncode=0, stdout=module.API_VERSION, stderr=""
        ),
    )
    monkeypatch.setattr(module, "_run_packaged_launch_probe", _stop_after_host_validation)
    return log_path


def test_release_composition_main_never_validates_hosts(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    module = _load_module()
    log_path = _prepare_existing_artifacts_main_until_host_validation(
        module, tmp_path, monkeypatch
    )

    def _unexpected_validation(*_args, **_kwargs):
        raise AssertionError("host validation must not run for the release composition")

    monkeypatch.setattr(module, "_validate_packaged_restricted_host", _unexpected_validation)
    monkeypatch.setattr(module, "_validate_packaged_full_host_supervisor", _unexpected_validation)

    assert module.main(
        [
            "--existing-artifacts",
            "--composition",
            "release",
            "--log-path",
            str(log_path),
        ]
    ) == 1
    assert "  - stop" in capsys.readouterr().out
    assert "composition=release" in log_path.read_text(encoding="utf-8")


def test_dev_composition_main_validates_both_hosts(tmp_path: Path, monkeypatch, capsys) -> None:
    module = _load_module()
    log_path = _prepare_existing_artifacts_main_until_host_validation(
        module, tmp_path, monkeypatch
    )
    calls: list[str] = []

    def _validate_restricted_host(*_args, **_kwargs):
        calls.append("restricted")
        return tmp_path / "restricted-host", tmp_path / "restricted-host.manifest.json"

    def _validate_full_host(*_args, **_kwargs):
        calls.append("full")
        return tmp_path / "full-host", tmp_path / "full-host.manifest.json"

    monkeypatch.setattr(module, "_validate_packaged_restricted_host", _validate_restricted_host)
    monkeypatch.setattr(module, "_validate_packaged_full_host_supervisor", _validate_full_host)

    assert module.main(
        [
            "--existing-artifacts",
            "--log-path",
            str(log_path),
        ]
    ) == 1
    assert "  - stop" in capsys.readouterr().out
    assert calls == ["restricted", "full"]
    assert "composition=dev" in log_path.read_text(encoding="utf-8")


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
