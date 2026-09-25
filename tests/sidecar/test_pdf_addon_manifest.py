from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "config" / "pdf-addon-manifest.json"
ADDON_LOCK_PATH = ROOT / "requirements-pdf-addon-lock.txt"
EXPECTED_PLATFORMS = {"win32-x64", "linux-x64", "darwin-arm64"}


def _manifest() -> dict[str, object]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def test_platform_artifacts_are_pinned_and_well_formed() -> None:
    manifest = _manifest()
    platforms = manifest["platforms"]

    assert isinstance(platforms, dict)
    assert set(platforms) == EXPECTED_PLATFORMS
    for artifact in platforms.values():
        assert isinstance(artifact, dict)
        filename = artifact["filename"]
        assert artifact["url"].startswith("https://files.pythonhosted.org/")
        assert artifact["url"].endswith(filename)
        assert isinstance(artifact["sizeBytes"], int)
        assert not isinstance(artifact["sizeBytes"], bool)
        assert artifact["sizeBytes"] > 0
        assert re.fullmatch(r"[0-9a-f]{64}", artifact["sha256"])


def test_manifest_hashes_match_the_exact_locked_pymupdf_version() -> None:
    manifest = _manifest()
    lock_text = ADDON_LOCK_PATH.read_text(encoding="utf-8")
    pins = re.findall(r"(?im)^pymupdf==([^\s\\]+)", lock_text)

    assert pins == [manifest["version"]]
    package_match = re.search(r"(?im)^pymupdf==[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*", lock_text)
    assert package_match is not None
    locked_hashes = set(re.findall(r"--hash=sha256:([0-9a-f]{64})", package_match.group()))
    platforms = manifest["platforms"]
    assert isinstance(platforms, dict)
    for artifact in platforms.values():
        assert isinstance(artifact, dict)
        assert artifact["sha256"] in locked_hashes


def test_media_requirements_do_not_include_pymupdf() -> None:
    for filename in ("requirements-media-site.in", "requirements-media-site-lock.txt"):
        assert "pymupdf" not in (ROOT / filename).read_text(encoding="utf-8").casefold()


def test_frozen_sidecar_build_excludes_pymupdf() -> None:
    spec = importlib.util.spec_from_file_location(
        "build_sidecar_artifact_for_pdf_addon",
        ROOT / "scripts" / "packaging" / "build_sidecar_artifact.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert {"fitz", "pymupdf"} <= set(module.PYINSTALLER_EXCLUDED_MODULES)
