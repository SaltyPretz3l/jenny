"""Owner-run builder for Jenny's offline managed-Python runtime bundle.

The release owner runs this script with network access before packaging. It
downloads and verifies the pinned CPython embeddable distribution, resolves
only hash-locked CPython 3.13 Windows x64 wheels, and publishes both generated
directories through staging. Generated binaries stay gitignored.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Sequence

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONTRACT = ROOT / "config" / "python-runtime-bundle-lock.json"
DEFAULT_EMBED_DEST = ROOT / "vendor" / "python-embed"
DEFAULT_WHEELHOUSE_DEST = ROOT / "vendor" / "python-runtime-wheels"
COPY_CHUNK_BYTES = 1024 * 1024
MAX_ARCHIVE_MEMBERS = 512
MAX_EXTRACTED_BYTES = 128 * 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 60
PIP_TIMEOUT_SECONDS = 900
SHA256_HEX_LENGTH = 64
_KEEP_FILE = ".gitignore"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(COPY_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_json_object(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"unable to read JSON object {path}: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"expected JSON object in {path}")
    return payload


def _contract_path(root: Path, value: object, field: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"bundle contract field {field!r} must be a non-empty path")
    candidate = (root / value).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise RuntimeError(f"bundle contract field {field!r} escapes the repository") from error
    return candidate


def _require_string(payload: dict[str, Any], field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"bundle contract field {field!r} must be a non-empty string")
    return value.strip()


def _require_sha256(payload: dict[str, Any], field: str) -> str:
    value = _require_string(payload, field).lower()
    if len(value) != SHA256_HEX_LENGTH or any(
        character not in "0123456789abcdef" for character in value
    ):
        raise RuntimeError(f"bundle contract field {field!r} must be a SHA-256 digest")
    return value


def _load_contract(path: Path) -> dict[str, Any]:
    contract = _load_json_object(path)
    if contract.get("schema_version") != 1:
        raise RuntimeError("unsupported python runtime bundle contract schema")
    python = contract.get("python")
    if not isinstance(python, dict):
        raise RuntimeError("bundle contract python field must be an object")
    for field in (
        "version",
        "implementation",
        "architecture",
        "platform",
        "abi",
        "embed_url",
        "executable",
        "stdlib_archive",
        "path_file",
    ):
        _require_string(python, field)
    _require_sha256(python, "embed_sha256")
    max_archive_bytes = python.get("max_archive_bytes")
    if isinstance(max_archive_bytes, bool) or not isinstance(max_archive_bytes, int):
        raise RuntimeError("bundle contract max_archive_bytes must be an integer")
    if max_archive_bytes <= 0 or max_archive_bytes > MAX_EXTRACTED_BYTES:
        raise RuntimeError("bundle contract max_archive_bytes is outside the safe range")
    for field in ("build_lock", "runtime_lock"):
        lock_path = _contract_path(ROOT, contract.get(field), field)
        if not lock_path.is_file():
            raise RuntimeError(f"bundle contract lock is missing: {lock_path}")
    for field in ("runtime_packages", "bootstrap_packages"):
        values = contract.get(field)
        if not isinstance(values, list) or not values or not all(
            isinstance(item, str) and "==" in item for item in values
        ):
            raise RuntimeError(f"bundle contract field {field!r} must contain exact pins")
    return contract


def _download_file(url: str, destination: Path, *, max_bytes: int) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "Jenny-release-builder/1"})
    total = 0
    with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:  # noqa: S310
        declared = response.headers.get("Content-Length")
        if declared and int(declared) > max_bytes:
            raise RuntimeError(f"download exceeds configured byte limit: {url}")
        with destination.open("wb") as output:
            while True:
                chunk = response.read(COPY_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise RuntimeError(f"download exceeded configured byte limit: {url}")
                output.write(chunk)


def _obtain_embed_archive(
    contract: dict[str, Any],
    destination: Path,
    supplied_archive: Path | None,
) -> Path:
    python = contract["python"]
    if supplied_archive is not None:
        source = supplied_archive.resolve()
        if not source.is_file():
            raise RuntimeError(f"supplied CPython archive is missing: {source}")
        shutil.copyfile(source, destination)
    else:
        _download_file(
            python["embed_url"],
            destination,
            max_bytes=python["max_archive_bytes"],
        )
    actual = _sha256_file(destination)
    expected = python["embed_sha256"].lower()
    if actual != expected:
        raise RuntimeError(
            f"CPython archive checksum mismatch (expected {expected}, received {actual})"
        )
    return destination


def _safe_member_path(name: str) -> Path:
    normalized = PurePosixPath(name)
    if normalized.is_absolute() or not normalized.parts:
        raise RuntimeError(f"unsafe path in CPython archive: {name!r}")
    if any(part in {"", ".", ".."} for part in normalized.parts):
        raise RuntimeError(f"unsafe path in CPython archive: {name!r}")
    return Path(*normalized.parts)


def _extract_embed_archive(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        if len(members) > MAX_ARCHIVE_MEMBERS:
            raise RuntimeError("CPython archive contains too many members")
        total = sum(member.file_size for member in members)
        if total > MAX_EXTRACTED_BYTES:
            raise RuntimeError("CPython archive expands beyond the configured limit")
        for member in members:
            relative = _safe_member_path(member.filename)
            target = destination / relative
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output, length=COPY_CHUNK_BYTES)


def _enable_embedded_site_packages(path_file: Path) -> None:
    try:
        lines = [line.strip() for line in path_file.read_text(encoding="utf-8-sig").splitlines()]
    except OSError as error:
        raise RuntimeError(f"CPython embeddable path file is missing: {path_file}") from error
    active = [line for line in lines if line and line not in {"#import site", "import site"}]
    if "Lib/site-packages" not in active:
        active.append("Lib/site-packages")
    active.append("import site")
    path_file.write_text("\n".join(active) + "\n", encoding="utf-8")


def _run_pip_download(
    python_executable: str,
    runtime_lock: Path,
    destination: Path,
    python_contract: dict[str, Any],
) -> None:
    command = [
        python_executable,
        "-m",
        "pip",
        "download",
        "--disable-pip-version-check",
        "--no-input",
        "--require-hashes",
        "--only-binary=:all:",
        "--platform",
        python_contract["platform"],
        "--python-version",
        python_contract["version"],
        "--implementation",
        "cp",
        "--abi",
        python_contract["abi"],
        "--dest",
        str(destination),
        "--requirement",
        str(runtime_lock),
    ]
    subprocess.run(command, cwd=ROOT, check=True, timeout=PIP_TIMEOUT_SECONDS)


def _timestamp() -> str:
    source_date_epoch = os.environ.get("SOURCE_DATE_EPOCH", "").strip()
    if source_date_epoch.isdigit():
        value = datetime.fromtimestamp(int(source_date_epoch), tz=UTC)
    else:
        value = datetime.now(UTC)
    return value.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _generated_files(directory: Path, *, manifest_name: str) -> dict[str, str]:
    files: dict[str, str] = {}
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.name in {_KEEP_FILE, manifest_name}:
            continue
        relative = path.relative_to(directory).as_posix()
        files[relative] = _sha256_file(path)
    return files


def _copy_keep_file(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    (destination / _KEEP_FILE).write_text("*\n!.gitignore\n", encoding="utf-8")


def _publish_directories(pairs: Sequence[tuple[Path, Path]]) -> None:
    backups = [
        (destination, destination.with_name(f".{destination.name}.previous"))
        for _, destination in pairs
    ]
    published: list[Path] = []
    try:
        for destination, backup in backups:
            if backup.exists() and not destination.exists():
                backup.replace(destination)
            if backup.exists():
                shutil.rmtree(backup)
            if destination.exists():
                destination.replace(backup)
        for staging, destination in pairs:
            staging.replace(destination)
            published.append(destination)
    except BaseException:
        for destination in reversed(published):
            if destination.exists():
                shutil.rmtree(destination)
        for destination, backup in reversed(backups):
            if backup.exists() and not destination.exists():
                backup.replace(destination)
        raise
    for _, backup in backups:
        if backup.exists():
            shutil.rmtree(backup)


def build_runtime_bundle(
    *,
    contract_path: Path,
    python_executable: str,
    embed_destination: Path,
    wheelhouse_destination: Path,
    embed_archive: Path | None = None,
) -> None:
    contract_path = contract_path.resolve()
    contract = _load_contract(contract_path)
    python_contract = contract["python"]
    runtime_lock = _contract_path(ROOT, contract["runtime_lock"], "runtime_lock")
    build_lock = _contract_path(ROOT, contract["build_lock"], "build_lock")
    embed_manifest_name = _require_string(contract, "embed_manifest")
    wheelhouse_manifest_name = _require_string(contract, "wheelhouse_manifest")

    embed_destination = embed_destination.resolve()
    wheelhouse_destination = wheelhouse_destination.resolve()
    embed_destination.parent.mkdir(parents=True, exist_ok=True)
    wheelhouse_destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_directories: list[Path] = []
    try:
        temp_root = Path(
            tempfile.mkdtemp(prefix=".python-runtime-bundle-", dir=embed_destination.parent)
        )
        temporary_directories.append(temp_root)
        embed_staging = Path(
            tempfile.mkdtemp(prefix=f".{embed_destination.name}.staging-", dir=embed_destination.parent)
        )
        temporary_directories.append(embed_staging)
        wheelhouse_staging = Path(
            tempfile.mkdtemp(
                prefix=f".{wheelhouse_destination.name}.staging-",
                dir=wheelhouse_destination.parent,
            )
        )
        temporary_directories.append(wheelhouse_staging)
        _copy_keep_file(embed_staging)
        _copy_keep_file(wheelhouse_staging)

        archive = _obtain_embed_archive(
            contract,
            temp_root / "python-embed.zip",
            embed_archive,
        )
        _extract_embed_archive(archive, embed_staging)
        _enable_embedded_site_packages(embed_staging / python_contract["path_file"])

        executable = embed_staging / python_contract["executable"]
        stdlib_archive = embed_staging / python_contract["stdlib_archive"]
        if not executable.is_file() or not stdlib_archive.is_file():
            raise RuntimeError(
                "CPython bundle is missing its executable or standard-library archive"
            )

        _run_pip_download(
            python_executable,
            runtime_lock,
            wheelhouse_staging,
            python_contract,
        )
        wheels = sorted(wheelhouse_staging.glob("*.whl"))
        if not wheels:
            raise RuntimeError("runtime wheel download produced no wheel files")

        common = {
            "schema_version": 1,
            "generated_at_utc": _timestamp(),
            "contract_sha256": _sha256_file(contract_path),
            "build_lock_sha256": _sha256_file(build_lock),
            "runtime_lock_sha256": _sha256_file(runtime_lock),
            "python_version": python_contract["version"],
            "platform": python_contract["platform"],
            "abi": python_contract["abi"],
        }
        embed_manifest = {
            **common,
            "distribution": "cpython-embeddable",
            "source_url": python_contract["embed_url"],
            "source_sha256": python_contract["embed_sha256"],
            "files": _generated_files(embed_staging, manifest_name=embed_manifest_name),
        }
        wheelhouse_manifest = {
            **common,
            "algorithm": "sha256",
            "runtime_packages": contract["runtime_packages"],
            "bootstrap_packages": contract["bootstrap_packages"],
            "files": _generated_files(
                wheelhouse_staging,
                manifest_name=wheelhouse_manifest_name,
            ),
        }
        _write_json(embed_staging / embed_manifest_name, embed_manifest)
        _write_json(wheelhouse_staging / wheelhouse_manifest_name, wheelhouse_manifest)

        _publish_directories(
            (
                (embed_staging, embed_destination),
                (wheelhouse_staging, wheelhouse_destination),
            )
        )
    finally:
        for temporary_directory in temporary_directories:
            if temporary_directory.exists():
                shutil.rmtree(temporary_directory)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", default=str(DEFAULT_CONTRACT))
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--embed-dest", default=str(DEFAULT_EMBED_DEST))
    parser.add_argument("--wheelhouse-dest", default=str(DEFAULT_WHEELHOUSE_DEST))
    parser.add_argument(
        "--embed-archive",
        help="Optional local copy of the pinned CPython ZIP; it is still checksum-verified.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)
    try:
        build_runtime_bundle(
            contract_path=Path(args.contract),
            python_executable=args.python,
            embed_destination=Path(args.embed_dest),
            wheelhouse_destination=Path(args.wheelhouse_dest),
            embed_archive=Path(args.embed_archive) if args.embed_archive else None,
        )
    except (OSError, RuntimeError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print("FAIL: managed Python runtime bundle")
        print(f"  - {error}")
        return 1
    print("PASS: managed Python runtime bundle")
    print(f"  - interpreter: {Path(args.embed_dest)}")
    print(f"  - wheelhouse: {Path(args.wheelhouse_dest)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
