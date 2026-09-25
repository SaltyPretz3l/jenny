"""Build Jenny's platform-specific sidecar media dependency site."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Sequence

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LOCK = ROOT / "requirements-media-site-lock.txt"
DEFAULT_DESTINATION = ROOT / "vendor" / "sidecar-media-site"
DEFAULT_PYTHON_VERSION = "3.11"
DEFAULT_TIMEOUT_SECONDS = 900
MANIFEST_NAME = "manifest.json"
KEEP_FILE = ".gitignore"
COPY_CHUNK_BYTES = 1024 * 1024
PYTHON_VERSION_PARTS = 2
# Pure-Python packages that PyPI publishes only as a source archive. Their
# sdist is hash-verified against the lock like every wheel, then built into a
# wheel locally so the install step can stay wheel-only.
SDIST_ONLY_PACKAGES: tuple[str, ...] = ("antlr4-python3-runtime",)
SDIST_SUFFIXES: tuple[str, ...] = (".tar.gz", ".zip")


@dataclass(frozen=True)
class MediaSiteTarget:
    platform: str
    python_version: str


def _default_platform(sys_platform: str = sys.platform) -> str:
    if sys_platform.startswith("win"):
        return "win_amd64"
    if sys_platform.startswith("linux"):
        return "manylinux_2_28_x86_64"
    if sys_platform == "darwin":
        return "macosx_11_0_arm64"
    raise ValueError(f"unsupported host platform: {sys_platform}")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(COPY_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _timestamp() -> str:
    source_date_epoch = os.environ.get("SOURCE_DATE_EPOCH", "").strip()
    if source_date_epoch.isdigit():
        value = datetime.fromtimestamp(int(source_date_epoch), tz=UTC)
    else:
        value = datetime.now(UTC)
    return value.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _generated_files(directory: Path) -> dict[str, str]:
    return {
        path.relative_to(directory).as_posix(): _sha256_file(path)
        for path in sorted(directory.rglob("*"))
        if path.is_file() and path.name != MANIFEST_NAME
    }


def _assemble_manifest(
    site_directory: Path,
    *,
    lock_path: Path,
    python_version: str,
    platform: str,
    generated_at: str | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "python_version": python_version,
        "platform": platform,
        "lock": lock_path.name,
        "lock_sha256": _sha256_file(lock_path),
        "generated_at": generated_at or _timestamp(),
        "files": _generated_files(site_directory),
    }


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _prune_site(site_directory: Path) -> tuple[str, ...]:
    candidates = [site_directory / "bin", site_directory / "Scripts"]
    candidates.extend(path for path in site_directory.rglob("__pycache__") if path.is_dir())
    removed: list[str] = []
    for path in sorted(set(candidates), key=lambda item: len(item.parts), reverse=True):
        if not path.exists():
            continue
        removed.append(path.relative_to(site_directory).as_posix())
        shutil.rmtree(path)
    return tuple(sorted(removed))


def _abi_tag(python_version: str) -> str:
    parts = python_version.split(".")
    if len(parts) != PYTHON_VERSION_PARTS or not all(part.isdigit() for part in parts):
        raise ValueError("python version must use major.minor form")
    return f"cp{parts[0]}{parts[1]}"


def _download_command(
    *,
    python_executable: str,
    lock_path: Path,
    wheels_directory: Path,
    target: MediaSiteTarget,
) -> list[str]:
    command = [
        python_executable,
        "-m",
        "pip",
        "download",
        "--require-hashes",
        "--only-binary=:all:",
    ]
    for name in SDIST_ONLY_PACKAGES:
        command.extend(("--no-binary", name))
    command.extend(
        (
            "--no-deps",
            "--platform",
            target.platform,
            "--python-version",
            target.python_version,
            "--implementation",
            "cp",
            "--abi",
            _abi_tag(target.python_version),
            "-r",
            str(lock_path),
            "-d",
            str(wheels_directory),
        )
    )
    return command


def _wheel_command(*, python_executable: str, sdist: Path, wheels_directory: Path) -> list[str]:
    return [
        python_executable,
        "-m",
        "pip",
        "wheel",
        "--no-deps",
        "--no-build-isolation",
        "--no-index",
        "--wheel-dir",
        str(wheels_directory),
        str(sdist),
    ]


def _install_command(
    *,
    python_executable: str,
    wheel_paths: Sequence[Path],
    site_directory: Path,
) -> list[str]:
    # Not ``--require-hashes``: pip's hash-checking mode cannot accept the wheel
    # built locally from a verified sdist. Every file in the wheelhouse was
    # either hash-verified by the download step or built from one that was.
    return [
        python_executable,
        "-m",
        "pip",
        "install",
        "--no-deps",
        "--no-index",
        "--no-compile",
        "--target",
        str(site_directory),
        *[str(path) for path in wheel_paths],
    ]


def _sdists(wheels_directory: Path) -> list[Path]:
    return sorted(
        path
        for path in wheels_directory.iterdir()
        if path.is_file() and path.name.endswith(SDIST_SUFFIXES)
    )


def _stderr_tail(stderr: str, *, line_count: int = 20) -> str:
    lines = stderr.strip().splitlines()
    return "\n".join(lines[-line_count:])


def _run_pip(command: Sequence[str], *, timeout_seconds: float) -> None:
    try:
        completed = subprocess.run(
            list(command),
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        tail = _stderr_tail(str(error.stderr or ""))
        detail = f"\n{tail}" if tail else ""
        raise RuntimeError(f"pip command timed out after {timeout_seconds:g}s{detail}") from error
    if completed.returncode != 0:
        tail = _stderr_tail(completed.stderr)
        detail = f"\n{tail}" if tail else ""
        raise RuntimeError(f"pip command failed with exit code {completed.returncode}{detail}")


def _staging_directory(destination: Path) -> Path:
    return Path(tempfile.mkdtemp(prefix=f".{destination.name}.staging-", dir=destination.parent))


def _remove_directory_if_present(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)


def _publish_directory(staging: Path, destination: Path) -> None:
    backup = destination.with_name(f".{destination.name}.previous")
    if backup.exists() and not destination.exists():
        backup.replace(destination)
    _remove_directory_if_present(backup)
    if destination.exists():
        destination.replace(backup)
    try:
        staging.replace(destination)
    except BaseException:
        if backup.exists() and not destination.exists():
            backup.replace(destination)
        raise
    _remove_directory_if_present(backup)


def build_media_site(
    *,
    lock_path: Path,
    destination: Path,
    target: MediaSiteTarget,
    python_executable: str,
    timeout_seconds: float,
) -> tuple[int, int]:
    lock_path = lock_path.resolve()
    destination = destination.resolve()
    if not lock_path.is_file():
        raise RuntimeError(f"requirements lock does not exist: {lock_path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging_root = _staging_directory(destination)
    wheels_directory = staging_root / "wheels"
    site_directory = staging_root / "site"
    wheels_directory.mkdir()
    site_directory.mkdir()
    keep_source = destination / KEEP_FILE
    if keep_source.is_file():
        shutil.copy2(keep_source, site_directory / KEEP_FILE)
    else:
        (site_directory / KEEP_FILE).write_text("*\n!.gitignore\n", encoding="utf-8")
    try:
        _run_pip(
            _download_command(
                python_executable=python_executable,
                lock_path=lock_path,
                wheels_directory=wheels_directory,
                target=target,
            ),
            timeout_seconds=timeout_seconds,
        )
        for sdist in _sdists(wheels_directory):
            _run_pip(
                _wheel_command(
                    python_executable=python_executable,
                    sdist=sdist,
                    wheels_directory=wheels_directory,
                ),
                timeout_seconds=timeout_seconds,
            )
        _run_pip(
            _install_command(
                python_executable=python_executable,
                wheel_paths=sorted(wheels_directory.glob("*.whl")),
                site_directory=site_directory,
            ),
            timeout_seconds=timeout_seconds,
        )
        _prune_site(site_directory)
        manifest = _assemble_manifest(
            site_directory,
            lock_path=lock_path,
            python_version=target.python_version,
            platform=target.platform,
        )
        _write_json(site_directory / MANIFEST_NAME, manifest)
        file_count = len(manifest["files"])
        size_bytes = sum(
            path.stat().st_size for path in site_directory.rglob("*") if path.is_file()
        )
        _publish_directory(site_directory, destination)
        return file_count, size_bytes
    finally:
        _remove_directory_if_present(staging_root)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    parser.add_argument("--platform", default=_default_platform())
    parser.add_argument("--python-version", default=DEFAULT_PYTHON_VERSION)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)
    try:
        file_count, size_bytes = build_media_site(
            lock_path=args.lock,
            destination=args.destination,
            target=MediaSiteTarget(
                platform=str(args.platform),
                python_version=str(args.python_version),
            ),
            python_executable=str(args.python),
            timeout_seconds=float(args.timeout_seconds),
        )
    except Exception as error:
        print(f"FAIL: {error}")
        return 1
    size_mb = size_bytes / (1024 * 1024)
    print(f"PASS: media site built ({file_count} files, {size_mb:.1f} MB) -> {args.destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
