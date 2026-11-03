from __future__ import annotations

import importlib.util
import io
import subprocess
import sys
import tarfile
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _load_module() -> ModuleType:
    script = ROOT / "scripts" / "packaging" / "smoke_packaged_linux_docker.py"
    name = "smoke_packaged_linux_docker_test"
    spec = importlib.util.spec_from_file_location(name, script)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive guard
        raise RuntimeError("unable to load smoke_packaged_linux_docker.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


driver = _load_module()


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q")
    (tmp_path / ".gitignore").write_text("ignored.txt\nnode_modules/\n", encoding="utf-8")
    (tmp_path / "tracked.py").write_text("print('v1')\n", encoding="utf-8")
    (tmp_path / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    (tmp_path / "gone.txt").write_text("x\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "update-index", "--chmod=+x", "run.sh")
    _git(tmp_path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    (tmp_path / "tracked.py").write_bytes(b"print('edited')\n")
    (tmp_path / "gone.txt").unlink()
    (tmp_path / "new.txt").write_text("untracked\n", encoding="utf-8")
    (tmp_path / "ignored.txt").write_text("secret\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "dep.js").write_text("x\n", encoding="utf-8")
    return tmp_path


def test_source_entries_take_tracked_and_untracked_files_as_on_disk(repo: Path) -> None:
    entries = dict(driver.source_entries(repo))
    assert entries == {
        ".gitignore": 0o644,
        "new.txt": 0o644,
        "run.sh": 0o755,
        "tracked.py": 0o644,
    }, "ignored files, node_modules and a tracked file deleted on disk are left out"


def test_source_tar_carries_working_tree_bytes_and_index_modes(repo: Path) -> None:
    buffer = io.BytesIO()
    driver.write_source_tar(driver.source_entries(repo), buffer, root=repo)
    buffer.seek(0)
    with tarfile.open(fileobj=buffer, mode="r") as archive:
        members = {member.name: member for member in archive.getmembers()}
        assert set(members) == {".gitignore", "new.txt", "run.sh", "tracked.py"}
        assert members["run.sh"].mode == 0o755
        assert members["tracked.py"].mode == 0o644
        assert members["tracked.py"].uid == 0
        extracted = archive.extractfile(members["tracked.py"])
        assert extracted is not None
        assert extracted.read() == b"print('edited')\n", "uncommitted edits are what ships"


def test_image_tag_follows_the_image_inputs(tmp_path: Path) -> None:
    context = tmp_path / "scripts" / "packaging" / "linux-smoke"
    context.mkdir(parents=True)
    (context / "Dockerfile").write_text("FROM ubuntu:22.04\n", encoding="utf-8")
    (context / "run-in-container.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    (tmp_path / ".nvmrc").write_text("v22.23.2\n", encoding="utf-8")
    first = driver.image_tag(tmp_path)
    assert first.startswith("jenny-linux-smoke:")
    assert driver.node_version(tmp_path) == "22.23.2"
    (context / "run-in-container.sh").write_text("#!/bin/sh\necho changed\n", encoding="utf-8")
    assert driver.image_tag(tmp_path) != first
    assert driver.image_tag(ROOT) == driver.image_tag(ROOT), "stable for unchanged inputs"


def test_run_command_mirrors_the_ci_container_options(tmp_path: Path) -> None:
    command = driver.run_command("jenny-linux-smoke:abc", "jenny-linux-smoke-42", tmp_path)
    assert command[:4] == ["docker", "run", "--rm", "-i"]
    assert command[command.index("--name") + 1] == "jenny-linux-smoke-42"
    assert command[command.index("--security-opt") + 1] == "seccomp=unconfined"
    assert "--shm-size=1g" in command
    assert f"type=bind,source={tmp_path},target=/out" in command
    assert "type=volume,source=jenny-linux-smoke-npm,target=/root/.npm" in command
    assert command[-1] == "jenny-linux-smoke:abc"
    assert "--privileged" not in command


def test_docker_ready_names_the_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing(*_args: object, **_kwargs: object) -> None:
        raise FileNotFoundError("docker")

    monkeypatch.setattr(driver.subprocess, "run", missing)
    assert "not on PATH" in driver.docker_ready()

    def answer(returncode: int, stdout: str):
        return lambda *_a, **_k: subprocess.CompletedProcess([], returncode, stdout, "")

    monkeypatch.setattr(driver.subprocess, "run", answer(1, ""))
    assert "start Docker Desktop" in driver.docker_ready()
    monkeypatch.setattr(driver.subprocess, "run", answer(0, "windows\n"))
    assert "Linux containers" in driver.docker_ready()
    monkeypatch.setattr(driver.subprocess, "run", answer(0, "linux\n"))
    assert driver.docker_ready() == ""


def test_main_fails_cleanly_without_a_daemon(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(driver, "docker_ready", lambda: "the Docker daemon is not reachable")
    monkeypatch.setattr(sys, "argv", ["smoke_packaged_linux_docker.py"])
    assert driver.main() == 1
    assert "FAIL: Linux packaged smoke in Docker: the Docker daemon is not reachable" in capsys.readouterr().out


def test_container_script_mirrors_the_ci_smoke_step() -> None:
    script = (ROOT / "scripts" / "packaging" / "linux-smoke" / "run-in-container.sh").read_text(
        encoding="utf-8"
    )
    workflow = (ROOT / ".github" / "workflows" / "ci-linux-package.yml").read_text(encoding="utf-8")
    for command in (
        "python -m pip install --require-hashes --only-binary=:all: -r requirements-build-lock.txt",
        "python scripts/build-python-runtime-bundle.py --contract config/python-runtime-bundle-lock.linux-x64.json",
        "python scripts/packaging/build_sidecar_artifact.py",
        "npm exec -- electron-builder --linux --dir --config electron-builder.yml --publish never",
        "--existing-artifacts --composition release",
        "chmod 4755 dist/linux-unpacked/chrome-sandbox",
    ):
        assert command in script, command
        assert command in workflow, f"the CI workflow changed: {command}"
    assert b"\r\n" not in (ROOT / "scripts" / "packaging" / "linux-smoke" / "run-in-container.sh").read_bytes()
