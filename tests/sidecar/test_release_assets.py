from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("release_assets", ROOT / "scripts/packaging/release_assets.py")
release_assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_assets)


def candidate(root, platform="windows"):
    (root / "package.json").write_text('{"version":"1.0.2"}')
    dist = root / "dist"
    dist.mkdir()
    metadata, primary, packages = release_assets.TARGETS[platform]
    for name in packages:
        (dist / name).write_bytes(b"verified candidate")
    data = {
        "version": "1.0.2",
        "files": [{
            "url": primary, "size": len(b"verified candidate"),
            "sha512": base64.b64encode(hashlib.sha512(b"verified candidate").digest()).decode(),
        }],
    }
    (dist / metadata).write_text(yaml.safe_dump(data))
    return dist / metadata, data


@pytest.mark.parametrize("platform", ["windows", "mac", "linux"])
def test_verified_assets_include_exact_byte_sha256_manifest(tmp_path, platform):
    candidate(tmp_path, platform)
    files = release_assets.verify_assets(tmp_path, "v1.0.2", platform)
    manifest = files[-1]
    for file in files[:-1]:
        assert f"{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}" in manifest.read_text()


@pytest.mark.parametrize("failure", ["tag", "metadata-version", "hash", "size", "path", "duplicate", "missing"])
def test_asset_verification_refuses_inconsistent_candidates(tmp_path, failure):
    file, data = candidate(tmp_path)
    tag = "v1.0.2"
    if failure == "tag":
        tag = "v1.0.3"
    elif failure == "metadata-version":
        data["version"] = "1.0.3"
    elif failure == "hash":
        data["files"][0]["sha512"] = "wrong"
    elif failure == "size":
        data["files"][0]["size"] = 1
    elif failure == "path":
        data["files"][0]["url"] = "../outside.exe"
    elif failure == "duplicate":
        data["files"].append(data["files"][0])
    else:
        (tmp_path / "dist/Jenny-Setup-x64.exe").unlink()
    file.write_text(yaml.safe_dump(data))
    with pytest.raises(ValueError):
        release_assets.verify_assets(tmp_path, tag, "windows")


def result(payload=None, code=0, stderr=""):
    return subprocess.CompletedProcess([], code, json.dumps(payload), stderr)


def draft():
    return {"tagName": "v1.0.2", "isDraft": True, "isPrerelease": False}


def test_published_release_refuses_prepare_and_upload(tmp_path):
    calls = []

    def run(*args):
        calls.append(args)
        return result({**draft(), "isDraft": False})

    with pytest.raises(RuntimeError, match="Published"):
        release_assets.prepare("v1.0.2", run)
    with pytest.raises(RuntimeError, match="Published"):
        release_assets.upload("v1.0.2", [tmp_path / "asset"], run)
    assert all(args[:2] == ("release", "view") for args in calls)


def test_upload_rechecks_before_every_asset_and_stops_if_owner_publishes(tmp_path):
    calls = []
    reads = 0

    def run(*args):
        nonlocal reads
        calls.append(args)
        if args[:2] == ("release", "view"):
            reads += 1
            return result({**draft(), "isDraft": reads == 1})
        return result()

    with pytest.raises(RuntimeError, match="Published"):
        release_assets.upload("v1.0.2", [tmp_path / "one", tmp_path / "two"], run)
    assert len([args for args in calls if args[:2] == ("release", "upload")]) == 1


def test_prepare_creates_only_after_confirmed_missing_release_and_rechecks_draft():
    calls = []

    def run(*args):
        calls.append(args)
        if len(calls) == 1:
            return result(code=1, stderr="release not found\n")
        return result(draft())

    release_assets.prepare("v1.0.2", run)
    assert calls[1][:2] == ("release", "create")
    assert "--verify-tag" in calls[1]
    assert calls[0][-2:] == ("--json", "tagName,isDraft,isPrerelease")
    assert calls[2][:2] == ("release", "view")
    with pytest.raises(RuntimeError, match="refusing"):
        release_assets.prepare("v1.0.2", lambda *args: result(code=1, stderr="HTTP 403"))


def test_release_workflow_uses_serialized_draft_helper_and_public_export_ships_it():
    workflow = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text())
    assert "github.ref" in workflow["concurrency"]["group"]
    assert workflow["concurrency"]["cancel-in-progress"] is False
    text = json.dumps(workflow)
    assert "--publish always" not in text
    assert "gh release upload" not in text
    assert "scripts/packaging/release_assets.py upload" in text
    assert not (ROOT / ".github/workflows/release-attestation.yml").exists()
    linux = workflow["jobs"]["build-linux"]
    dependency_step = next(step for step in linux["steps"] if step.get("name") == "Install Linux build and runtime dependencies")
    assert " gh " in dependency_step["run"]
    # The helper must survive the public source export's scripts/release exclusion.
    if (ROOT / "scripts/packaging/create_github_stage.py").exists():
        stage = importlib.import_module("scripts.packaging.create_github_stage")
        manifest = stage._load_stage_manifest(ROOT / "scripts/packaging/dist_manifest.json")
        files = stage.build_stage_file_list(ROOT, manifest)
        assert "scripts/packaging/release_assets.py" in files
