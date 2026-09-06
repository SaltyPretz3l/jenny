"""Build the Jenny full-host supervisor with a frozen provenance manifest."""

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
CRATE = ROOT / "native" / "plugin-full-host-supervisor"
OUTPUT = ROOT / "build" / "plugin-full-host-supervisor"
PROVENANCE = ROOT / "config" / "plugins" / "stage8-supervisor-build-provenance.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_inputs() -> list[Path]:
    return sorted(
        [CRATE / "Cargo.toml", CRATE / "Cargo.lock", *CRATE.glob("src/**/*.rs")],
        key=lambda item: item.relative_to(ROOT).as_posix(),
    )


def source_tree_digest(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        relative = path.relative_to(ROOT).as_posix().encode("utf-8")
        digest.update(relative + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()


def run(args: list[str]) -> str:
    result = subprocess.run(args, cwd=ROOT, check=True, capture_output=True,
                            text=True, timeout=840)
    return result.stdout


def target() -> tuple[str, str]:
    machine = platform.machine().lower()
    if sys.platform.startswith("win") and machine in {"amd64", "x86_64"}:
        return "x86_64-pc-windows-msvc", "plugin-full-host-supervisor.exe"
    if sys.platform == "darwin" and machine in {"arm64", "aarch64"}:
        return "aarch64-apple-darwin", "plugin-full-host-supervisor"
    raise RuntimeError(f"unsupported full-host supervisor target: {sys.platform}/{machine}")


def main() -> int:
    build_target, binary_name = target()
    inputs = source_inputs()
    source_state = "clean" if not run([
        "git", "status", "--porcelain", "--",
        "native/plugin-full-host-supervisor",
        "config/plugins/contract-lock-v6.json",
    ]).strip() else "dirty"
    release_requested = "--release" in sys.argv[1:]
    if release_requested and source_state != "clean":
        raise RuntimeError("release full-host supervisor requires clean committed inputs")
    tree_digest = source_tree_digest(inputs)
    run(["cargo", "build", "--release", "--locked", "--manifest-path", str(CRATE / "Cargo.toml")])
    if source_tree_digest(inputs) != tree_digest:
        raise RuntimeError("full-host supervisor source changed during build")
    source = CRATE / "target" / "release" / binary_name
    if not source.is_file():
        raise RuntimeError("full-host supervisor binary missing")
    commit = run(["git", "rev-parse", "HEAD"]).strip()
    manifest = {
        "provenance_schema_version": 1,
        "target": build_target,
        "source_commit": commit,
        "source_state": source_state,
        "source_tree_digest": tree_digest,
        "release_eligible": source_state == "clean",
        "binary_filename": binary_name,
        "binary_sha256": sha256(source),
        "contract_lock_v6_sha256": sha256(ROOT / "config" / "plugins" / "contract-lock-v6.json"),
        "authenticated_private_pipe": True,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="jenny-full-host-", dir=OUTPUT.parent) as temporary:
        staging = Path(temporary)
        shutil.copy2(source, staging / binary_name)
        manifest_text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
        (staging / "manifest.json").write_text(manifest_text, encoding="utf-8")
        if OUTPUT.exists():
            shutil.rmtree(OUTPUT)
        shutil.copytree(staging, OUTPUT)
    PROVENANCE.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"full-host supervisor artifact: {OUTPUT.relative_to(ROOT)}")
    print(f"sha256: {manifest['binary_sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
