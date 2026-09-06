"""Build and freeze the Jenny-owned restricted plugin host artifact."""

from __future__ import annotations

import hashlib
import json
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CRATE = ROOT / "restricted-host"
OUTPUT = ROOT / "build" / "restricted-host"
MANIFEST_NAME = "jenny-plugin-host.manifest.json"
SBOM_NAME = "jenny-plugin-host.sbom.json"
ABI_PATH = ROOT / "config" / "plugins" / "capability-abi" / "v1" / "jenny-restricted-host.wit"
PROTOCOL_PATH = ROOT / "config" / "plugins" / "contract-lock-v4.json"
WASMTIME_VERSION = "47.0.3"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _run(args: list[str]) -> str:
    completed = subprocess.run(
        args, cwd=ROOT, check=True, capture_output=True, text=True, timeout=1800
    )
    return completed.stdout


def _target() -> tuple[str, str]:
    machine = platform.machine().lower()
    if sys.platform.startswith("win") and machine in {"amd64", "x86_64"}:
        return "x86_64-pc-windows-msvc", "jenny-plugin-host.exe"
    if sys.platform == "darwin" and machine in {"arm64", "aarch64"}:
        return "aarch64-apple-darwin", "jenny-plugin-host"
    raise RuntimeError(f"unsupported restricted-host build target: {sys.platform}/{machine}")


def _metadata_components() -> tuple[list[dict[str, object]], list[str]]:
    payload = json.loads(_run([
        "cargo", "metadata", "--locked", "--format-version", "1",
        "--manifest-path", str(CRATE / "Cargo.toml"),
    ]))
    components: list[dict[str, object]] = []
    licenses: set[str] = set()
    for package in payload.get("packages", []):
        name = str(package.get("name", ""))
        version = str(package.get("version", ""))
        license_name = str(package.get("license") or "NOASSERTION")
        if license_name != "NOASSERTION":
            licenses.add(license_name)
        components.append({
            "type": "library" if name != "jenny-plugin-host" else "application",
            "name": name,
            "version": version,
            "purl": f"pkg:cargo/{name}@{version}",
            "licenses": [{"license": {"id": license_name}}],
        })
    components.sort(key=lambda item: (str(item["name"]), str(item["version"])))
    return components, sorted(licenses)


def main() -> int:
    target, binary_name = _target()
    source_state = "clean" if not _run([
        "git", "status", "--porcelain", "--",
        CRATE.relative_to(ROOT).as_posix(),
        ABI_PATH.relative_to(ROOT).as_posix(),
        PROTOCOL_PATH.relative_to(ROOT).as_posix(),
    ]).strip() else "dirty"
    release_requested = "--release" in sys.argv[1:]
    if release_requested and source_state != "clean":
        raise RuntimeError("release restricted-host requires clean committed inputs")
    _run([
        "cargo", "build", "--release", "--locked", "--manifest-path",
        str(CRATE / "Cargo.toml"),
    ])
    source_binary = CRATE / "target" / "release" / binary_name
    if not source_binary.is_file():
        raise RuntimeError(f"restricted-host binary missing after build: {source_binary}")
    commit = _run(["git", "rev-parse", "HEAD"]).strip()
    if len(commit) != 40:
        raise RuntimeError("restricted-host build commit identity unavailable")
    components, licenses = _metadata_components()
    with tempfile.TemporaryDirectory(prefix="jenny-restricted-host-", dir=ROOT / "build") as temp:
        staging = Path(temp)
        staged_binary = staging / binary_name
        shutil.copy2(source_binary, staged_binary)
        sbom = {
            "bomFormat": "CycloneDX",
            "specVersion": "1.5",
            "version": 1,
            "metadata": {"component": {
                "type": "application", "name": "jenny-plugin-host", "version": "1.0.0",
            }},
            "components": components,
        }
        (staging / SBOM_NAME).write_text(
            json.dumps(sbom, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        manifest = {
            "api_version": 1,
            "target": target,
            "commit": commit,
            "source_state": source_state,
            "release_eligible": source_state == "clean",
            "wasmtime_version": WASMTIME_VERSION,
            "binary_filename": binary_name,
            "binary_sha256": _sha256(staged_binary),
            "abi_sha256": _sha256(ABI_PATH),
            "protocol_sha256": _sha256(PROTOCOL_PATH),
            "licenses": licenses,
            "sbom_filename": SBOM_NAME,
        }
        (staging / MANIFEST_NAME).write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        if OUTPUT.exists():
            shutil.rmtree(OUTPUT)
        shutil.copytree(staging, OUTPUT)
    print(f"restricted host artifact: {OUTPUT.relative_to(ROOT)}")
    print(f"target: {target}")
    print(f"sha256: {manifest['binary_sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
