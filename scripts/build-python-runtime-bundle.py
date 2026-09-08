"""Owner-run builder for Jenny's offline managed-Python runtime bundle.

Downloads and verifies a pinned CPython distribution and hash-locked platform
wheels, then publishes both generated directories through staging.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
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
TarIndex = dict[str, tarfile.TarInfo]


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


def _positive_integer(payload: dict[str, Any], field: str, default: int | None = None) -> int:
    value = payload.get(field, default)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise RuntimeError(f"bundle contract {field} must be a positive integer")
    return value


def _normalize_platform_tags(python: dict[str, Any]) -> None:
    platform_tags = python.get("platform_tags", [python["platform"]])
    valid_tags = isinstance(platform_tags, list) and bool(platform_tags)
    if not valid_tags or not all(isinstance(item, str) and item.strip() for item in platform_tags):
        raise RuntimeError("bundle contract platform_tags must contain non-empty strings")
    if "platform_tags" in python:
        python["platform_tags"] = [item.strip() for item in platform_tags]


def _normalize_excludes(python: dict[str, Any]) -> None:
    # Relative paths (after strip_prefix) left out of the bundle. python-build-standalone ships
    # its 31 MB interpreter under three names (python, python3, python3.13) and libpython under
    # two; materialising those symlinks would copy each one, so the contract names the aliases.
    excludes = python.get("exclude", [])
    if not isinstance(excludes, list) or not all(
        isinstance(item, str) and item for item in excludes
    ):
        raise RuntimeError("bundle contract exclude must be a list of relative paths")
    python["exclude"] = [_safe_member_path(item).as_posix() for item in excludes]


def _validate_distribution_fields(python: dict[str, Any], distribution: str) -> None:
    if distribution == "cpython-embeddable":
        for field in ("stdlib_archive", "path_file"):
            _require_string(python, field)
        return
    strip_prefix = _require_string(python, "strip_prefix")
    if strip_prefix in {".", ".."} or "/" in strip_prefix or "\\" in strip_prefix:
        raise RuntimeError("bundle contract strip_prefix must be one path component")
    python["strip_prefix"] = strip_prefix
    _safe_member_path(_require_string(python, "stdlib_marker"))
    if python["platform"] not in python.get("platform_tags", [python["platform"]]):
        raise RuntimeError("bundle contract platform_tags must contain platform")
    if _require_string(python, "sys_platform") not in {"linux", "win32", "darwin"}:
        raise RuntimeError("bundle contract sys_platform is unsupported")


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
    ):
        _require_string(python, field)
    python["embed_sha256"] = _require_sha256(python, "embed_sha256")
    distribution = python.get("distribution", "cpython-embeddable")
    supported_distributions = {"cpython-embeddable", "python-build-standalone"}
    if distribution not in supported_distributions:
        raise RuntimeError("bundle contract has an unsupported Python distribution")
    python["distribution"] = distribution
    archive_format = python.get("archive_format", "zip")
    expected_format = "tar.gz" if distribution == "python-build-standalone" else "zip"
    if archive_format != expected_format:
        raise RuntimeError(
            f"bundle contract archive_format must be {expected_format!r} for {distribution}"
        )
    python["archive_format"] = archive_format
    _normalize_platform_tags(python)
    _normalize_excludes(python)
    _validate_distribution_fields(python, distribution)
    max_extracted_bytes = _positive_integer(python, "max_extracted_bytes", MAX_EXTRACTED_BYTES)
    python["max_extracted_bytes"] = max_extracted_bytes
    python["max_members"] = _positive_integer(python, "max_members", MAX_ARCHIVE_MEMBERS)
    max_archive_bytes = _positive_integer(python, "max_archive_bytes")
    if max_archive_bytes > max_extracted_bytes:
        raise RuntimeError("bundle contract max_archive_bytes is outside the safe range")
    for field in ("build_lock", "runtime_lock"):
        lock_path = _contract_path(ROOT, contract.get(field), field)
        if not lock_path.is_file():
            raise RuntimeError(f"bundle contract lock is missing: {lock_path}")
    for field in ("runtime_packages", "bootstrap_packages"):
        values = contract.get(field)
        if (
            not isinstance(values, list)
            or not values
            or not all(isinstance(item, str) and "==" in item for item in values)
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
    contract: dict[str, Any], destination: Path, supplied_archive: Path | None
) -> Path:
    python = contract["python"]
    if supplied_archive is not None:
        source = supplied_archive.resolve()
        if not source.is_file():
            raise RuntimeError(f"supplied CPython archive is missing: {source}")
        if source.stat().st_size > python["max_archive_bytes"]:
            raise RuntimeError(f"supplied CPython archive exceeds configured byte limit: {source}")
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
    if normalized.is_absolute() or not normalized.parts or "\\" in name:
        raise RuntimeError(f"unsafe path in CPython archive: {name!r}")
    if any(part in {"", ".", ".."} for part in normalized.parts):
        raise RuntimeError(f"unsafe path in CPython archive: {name!r}")
    return Path(*normalized.parts)


def _is_excluded(relative: str, excludes: Sequence[str]) -> bool:
    return any(relative == item or relative.startswith(f"{item}/") for item in excludes)


class _BoundedArchiveWriter:
    def __init__(self, output: Any, extracted_bytes: int, maximum_bytes: int) -> None:
        self.output, self.extracted_bytes = output, extracted_bytes
        self.maximum_bytes = maximum_bytes

    def write(self, data: bytes) -> int:
        next_total = self.extracted_bytes + len(data)
        if next_total > self.maximum_bytes:
            raise RuntimeError("CPython archive expands beyond the configured limit")
        written = self.output.write(data)
        self.extracted_bytes += written
        return written


def _copy_archive_member(source: Any, output: Any, extracted_bytes: int, maximum_bytes: int) -> int:
    writer = _BoundedArchiveWriter(output, extracted_bytes, maximum_bytes)
    shutil.copyfileobj(source, writer, length=COPY_CHUNK_BYTES)
    return writer.extracted_bytes


def _normalized_tar_link(member_path: str, linkname: str) -> str:
    link = PurePosixPath(linkname)
    if link.is_absolute() or "\\" in linkname:
        raise RuntimeError(f"unsafe symlink target in archive: {linkname!r}")
    parts: list[str] = []
    for part in (PurePosixPath(member_path).parent / link).parts:
        if part in {"", "."}:
            continue
        if part == "..":
            if not parts:
                raise RuntimeError(f"symlink escapes archive prefix: {linkname!r}")
            parts.pop()
        else:
            parts.append(part)
    if not parts:
        raise RuntimeError(f"unsafe symlink target in archive: {linkname!r}")
    resolved = PurePosixPath(*parts).as_posix()
    _safe_member_path(resolved)
    return resolved


def _tar_member_paths(members: list[tarfile.TarInfo], strip_prefix: str) -> TarIndex:
    indexed: TarIndex = {}
    prefix = f"{strip_prefix}/"
    for member in members:
        if member.name == strip_prefix:
            if not member.isdir():
                raise RuntimeError("CPython archive prefix entry must be a directory")
            continue
        if not member.name.startswith(prefix):
            raise RuntimeError(f"member outside the archive prefix: {member.name!r}")
        relative = _safe_member_path(member.name[len(prefix) :]).as_posix()
        if member.isdev() or member.isfifo() or member.ischr() or member.isblk():
            raise RuntimeError(f"unsupported special archive member: {member.name!r}")
        if member.islnk():
            raise RuntimeError(f"hard link in CPython archive: {member.name!r}")
        if not (member.isdir() or member.isreg() or member.issym()):
            raise RuntimeError(f"unsupported archive member: {member.name!r}")
        indexed[relative] = member
    return indexed


def _resolve_tar_regular(member_path: str, indexed: TarIndex) -> tarfile.TarInfo:
    current = member_path
    visited: set[str] = set()
    while current not in visited:
        visited.add(current)
        member = indexed.get(current)
        if member is None:
            raise RuntimeError(f"symlink target is missing from CPython archive: {current!r}")
        if member.isreg():
            return member
        if not member.issym():
            raise RuntimeError(f"symlink target is not a regular file: {current!r}")
        current = _normalized_tar_link(current, member.linkname)
    raise RuntimeError(f"symlink cycle in CPython archive: {member_path!r}")


def _extract_embed_archive(  # noqa: PLR0913 - signature is the archive safety contract
    archive: Path,
    destination: Path,
    *,
    archive_format: str,
    strip_prefix: str | None,
    max_members: int,
    max_extracted_bytes: int,
    excludes: Sequence[str] = (),
) -> None:
    if archive_format == "tar.gz":
        if not strip_prefix:
            raise RuntimeError("tar.gz CPython archive requires a strip prefix")
        _extract_tar_archive(
            archive, destination, strip_prefix, max_members, max_extracted_bytes, excludes
        )
        return
    if archive_format != "zip" or strip_prefix is not None:
        raise RuntimeError("zip CPython archive cannot use a strip prefix")
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        if len(members) > max_members:
            raise RuntimeError("CPython archive contains too many members")
        total = sum(member.file_size for member in members)
        if total > max_extracted_bytes:
            raise RuntimeError("CPython archive expands beyond the configured limit")
        extracted_bytes = 0
        for member in members:
            relative = _safe_member_path(member.filename)
            if _is_excluded(relative.as_posix(), excludes):
                continue
            target = destination / relative
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, target.open("wb") as output:
                extracted_bytes = _copy_archive_member(
                    source, output, extracted_bytes, max_extracted_bytes
                )


def _extract_tar_archive(  # noqa: PLR0913 - mirrors the _extract_embed_archive safety contract
    archive: Path,
    destination: Path,
    strip_prefix: str,
    max_members: int,
    max_extracted_bytes: int,
    excludes: Sequence[str] = (),
) -> None:
    with tarfile.open(archive, mode="r:gz") as bundle:
        members = bundle.getmembers()
        if len(members) > max_members:
            raise RuntimeError("CPython archive contains too many members")
        if sum(member.size for member in members if member.isreg()) > max_extracted_bytes:
            raise RuntimeError("CPython archive expands beyond the configured limit")
        indexed = _tar_member_paths(members, strip_prefix)
        extracted_bytes = 0
        for relative, member in indexed.items():
            if _is_excluded(relative, excludes):
                continue
            target = destination / _safe_member_path(relative)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            source_member = _resolve_tar_regular(relative, indexed) if member.issym() else member
            source = bundle.extractfile(source_member)
            if source is None:
                raise RuntimeError(f"unable to read CPython archive member: {member.name!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with source, target.open("wb") as output:
                extracted_bytes = _copy_archive_member(
                    source, output, extracted_bytes, max_extracted_bytes
                )
            target.chmod(0o755 if source_member.mode & 0o111 else 0o644)


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
    ]
    for platform in python_contract.get("platform_tags", [python_contract["platform"]]):
        command.extend(("--platform", platform))
    command.extend(
        [
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
    )
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


def _staging_directory(destination: Path) -> Path:
    return Path(tempfile.mkdtemp(prefix=f".{destination.name}.staging-", dir=destination.parent))


def _remove_directory_if_present(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)


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
            _remove_directory_if_present(backup)
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
        _remove_directory_if_present(backup)


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

    embed_destination, wheelhouse_destination = (
        embed_destination.resolve(),
        wheelhouse_destination.resolve(),
    )
    embed_destination.parent.mkdir(parents=True, exist_ok=True)
    wheelhouse_destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_directories: list[Path] = []
    try:
        temp_root = Path(
            tempfile.mkdtemp(prefix=".python-runtime-bundle-", dir=embed_destination.parent)
        )
        temporary_directories.append(temp_root)
        embed_staging = _staging_directory(embed_destination)
        temporary_directories.append(embed_staging)
        wheelhouse_staging = _staging_directory(wheelhouse_destination)
        temporary_directories.append(wheelhouse_staging)
        _copy_keep_file(embed_staging)
        _copy_keep_file(wheelhouse_staging)

        archive = _obtain_embed_archive(
            contract,
            temp_root / f"python-embed.{python_contract['archive_format']}",
            embed_archive,
        )
        _extract_embed_archive(
            archive,
            embed_staging,
            archive_format=python_contract["archive_format"],
            strip_prefix=python_contract.get("strip_prefix"),
            max_members=python_contract["max_members"],
            max_extracted_bytes=python_contract["max_extracted_bytes"],
            excludes=python_contract["exclude"],
        )

        executable = embed_staging / python_contract["executable"]
        if python_contract["distribution"] == "cpython-embeddable":
            _enable_embedded_site_packages(embed_staging / python_contract["path_file"])
            stdlib_archive = embed_staging / python_contract["stdlib_archive"]
            if not executable.is_file() or not stdlib_archive.is_file():
                raise RuntimeError(
                    "CPython bundle is missing its executable or standard-library archive"
                )
        else:
            stdlib_marker = embed_staging / python_contract["stdlib_marker"]
            if not executable.is_file() or not os.access(executable, os.X_OK):
                raise RuntimeError("CPython bundle executable is missing or not executable")
            if not stdlib_marker.is_file():
                raise RuntimeError("CPython bundle is missing its standard-library marker")

        _run_pip_download(python_executable, runtime_lock, wheelhouse_staging, python_contract)
        if not any(wheelhouse_staging.glob("*.whl")):
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
        for field in ("sys_platform", "platform_tags"):
            if field in python_contract:
                common[field] = python_contract[field]
        embed_manifest = {
            **common,
            "distribution": python_contract["distribution"],
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
        help=("Optional local copy of the pinned CPython archive; still checksum-verified."),
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
    except (
        OSError,
        RuntimeError,
        subprocess.SubprocessError,
        tarfile.TarError,
        zipfile.BadZipFile,
    ) as error:
        print("FAIL: managed Python runtime bundle")
        print(f"  - {error}")
        return 1
    print("PASS: managed Python runtime bundle")
    print(f"  - interpreter: {Path(args.embed_dest)}")
    print(f"  - wheelhouse: {Path(args.wheelhouse_dest)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
