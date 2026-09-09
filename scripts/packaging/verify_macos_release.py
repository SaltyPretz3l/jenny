"""Verify the built Apple Silicon app and its release archives before upload."""
from __future__ import annotations

import base64
import hashlib
import json
import platform
import subprocess
import sys
import zipfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import smoke_packaged_flow as smoke  # noqa: E402

VERIFIED_APP_FILES = (
    "Contents/MacOS/Jenny",
    "Contents/Resources/app.asar",
    "Contents/Resources/sidecar/sidecar",
    "Contents/Resources/sidecar/manifest.json",
    "Contents/Resources/restricted-host/jenny-plugin-host",
    "Contents/Resources/restricted-host/jenny-plugin-host.manifest.json",
    "Contents/Resources/restricted-host/jenny-plugin-host.sbom.json",
    "Contents/Resources/native/plugin-full-host-supervisor",
    "Contents/Resources/native/manifest.json",
)


def require_file(path: Path) -> None:
    if not path.is_file() or path.stat().st_size == 0:
        raise RuntimeError(f"Missing or empty release file: {path.name}")


def verify_zip(archive: Path, app: Path) -> None:
    """Check CRCs and bind the distributed ZIP to the app that was probed."""
    with zipfile.ZipFile(archive) as bundle:
        if bundle.testzip() is not None:
            raise RuntimeError("Mac ZIP contains a corrupt entry")
        for relative in VERIFIED_APP_FILES:
            name = f"Jenny.app/{relative}"
            with bundle.open(name) as source, (app / relative).open("rb") as built:
                if (hashlib.file_digest(source, "sha256").digest()
                        != hashlib.file_digest(built, "sha256").digest()):
                    raise RuntimeError(f"Mac ZIP differs from verified app: {relative}")


def verify_native_hosts(resources: Path, log_path: Path) -> list[Path]:
    hosts = (
        ("restricted-host", "jenny-plugin-host.manifest.json", "jenny-plugin-host",
         smoke._validate_packaged_restricted_host),
        ("native", "manifest.json", "plugin-full-host-supervisor",
         smoke._validate_packaged_full_host_supervisor),
    )
    binaries = []
    for directory, manifest_name, binary_name, validate in hosts:
        manifest_path = resources / directory / manifest_name
        require_file(manifest_path)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (not isinstance(manifest, dict)
                or manifest.get("binary_filename") != binary_name
                or manifest.get("target") != "aarch64-apple-darwin"
                or manifest.get("source_state") != "clean"
                or manifest.get("release_eligible") is not True):
            raise RuntimeError(f"Mac {directory} is not a clean ARM64 release artifact")
        if (directory == "restricted-host"
                and manifest.get("sbom_filename") != "jenny-plugin-host.sbom.json"):
            raise RuntimeError("Mac restricted-host SBOM filename is invalid")
        binary, _ = validate(resources, log_path=log_path, allow_stale_source=False)
        binaries.append(binary)
    return binaries


def verify_update_metadata(dist: Path) -> None:
    metadata = yaml.safe_load((dist / "latest-mac.yml").read_text(encoding="utf-8"))
    rows = metadata.get("files", []) if isinstance(metadata, dict) else []
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("Mac update metadata has no files")
    names = set()
    for row in rows:
        name = row.get("url") if isinstance(row, dict) else None
        if name not in {"Jenny-arm64.zip", "Jenny-arm64.dmg"}:
            raise RuntimeError("Mac update metadata references an unexpected file")
        names.add(name)
        with (dist / name).open("rb") as source:
            digest = base64.b64encode(hashlib.file_digest(source, "sha512").digest()).decode()
        if row.get("sha512") != digest:
            raise RuntimeError("Mac update metadata SHA512 mismatch")
        # electron-builder guarantees SHA512; size is target-dependent metadata.
        if "size" in row and row["size"] != (dist / name).stat().st_size:
            raise RuntimeError("Mac update metadata size mismatch")
    if "Jenny-arm64.zip" not in names:
        raise RuntimeError("Mac update metadata is missing the ZIP")


def verify_release(root: Path = ROOT) -> None:
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise RuntimeError("Mac release verification requires a native arm64 macOS host")
    dist = root / "dist"
    app = dist / "mac-arm64" / "Jenny.app"
    resources = app / "Contents" / "Resources"
    log_path = dist / "macos-verification.log"
    archives = [dist / "Jenny-arm64.dmg", dist / "Jenny-arm64.zip", dist / "latest-mac.yml"]
    for path in [*archives, resources / "app.asar", app / "Contents/MacOS/Jenny"]:
        require_file(path)
    artifact, _ = smoke._validate_packaged_artifact(resources, log_path=log_path)
    native_hosts = verify_native_hosts(resources, log_path)
    for binary in [app / "Contents/MacOS/Jenny", artifact, *native_hosts]:
        subprocess.run(["lipo", "-verify_arch", "arm64", str(binary)], check=True, timeout=30)
    subprocess.run([
        "node", "-e",
        "const a=require('@electron/asar'); for(const p of ['preload.bundle.js','index.html']) "
        "{if(!a.extractFile(process.argv[1],p).length) throw Error('Empty '+p);}",
        str(resources / "app.asar"),
    ], check=True, timeout=60)
    smoke._run_packaged_launch_probe(resources, artifact, log_path=log_path, timeout_seconds=60)
    smoke._run_packaged_sidecar_initialize_probe(artifact, log_path=log_path, timeout_seconds=90)
    verify_zip(archives[1], app)
    verify_update_metadata(dist)
    subprocess.run(["hdiutil", "verify", str(archives[0])], check=True, timeout=120)


def main() -> int:
    try:
        verify_release()
    except (OSError, RuntimeError, KeyError, json.JSONDecodeError, zipfile.BadZipFile,
            yaml.YAMLError, subprocess.SubprocessError) as error:
        print(f"FAIL: macOS release verification: {error}")
        return 1
    print("PASS: Apple Silicon release archives, preload, provenance, and sidecar initialize")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
