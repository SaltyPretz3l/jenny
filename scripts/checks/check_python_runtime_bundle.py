"""Fail closed unless the packaged managed-Python runtime bundle is complete."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tomllib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[2]
HEX_DIGITS = frozenset("0123456789abcdef")
PIN_RE = re.compile(r"^(?P<name>[A-Za-z0-9_.-]+)==(?P<version>[^\s\\]+)")
EXPECTED_BUILD_TOOLS = {
    "packaging": "25.0",
    "pip": "26.2",
    "setuptools": "83.0.0",
    "wheel": "0.47.0",
}
PROBE_TIMEOUT_SECONDS = 10
SHA256_HEX_LENGTH = 64
MIN_WHEEL_PARTS = 5
_IGNORED_TREE_FILES = {".gitignore"}


@dataclass(frozen=True)
class BundleContext:
    root: Path
    contract: dict[str, Any]
    python: dict[str, Any]
    build_lock: Path
    runtime_lock: Path
    common_manifest_fields: dict[str, object]
    embed_manifest_name: str
    wheelhouse_manifest_name: str


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == SHA256_HEX_LENGTH
        and all(character in HEX_DIGITS for character in value.lower())
    )


def _load_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("expected a JSON object")
    return payload


def _safe_relative_path(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        return None
    return path.as_posix()


def _is_reparse(path: Path) -> bool:
    try:
        stat_result = path.lstat()
    except OSError:
        return True
    attributes = getattr(stat_result, "st_file_attributes", 0)
    return path.is_symlink() or bool(attributes & 0x400)


def _tree_files(directory: Path, manifest_name: str) -> tuple[dict[str, Path], list[str]]:
    files: dict[str, Path] = {}
    errors: list[str] = []
    for current_root, dir_names, file_names in os.walk(directory, followlinks=False):
        current = Path(current_root)
        for name in list(dir_names):
            candidate = current / name
            if _is_reparse(candidate):
                errors.append(f"runtime bundle contains a linked directory: {candidate}")
                dir_names.remove(name)
        for name in file_names:
            candidate = current / name
            if _is_reparse(candidate):
                errors.append(f"runtime bundle contains a linked file: {candidate}")
                continue
            if name in _IGNORED_TREE_FILES or name == manifest_name:
                continue
            files[candidate.relative_to(directory).as_posix()] = candidate
    return files, errors


def _parse_hashed_lock(path: Path) -> tuple[dict[str, str], list[str]]:
    errors: list[str] = []
    pins: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        return {}, [f"requirements lock is missing or unreadable: {path} ({error})"]
    for index, raw_line in enumerate(lines):
        match = PIN_RE.match(raw_line.strip())
        if match is None:
            continue
        name = match.group("name").lower().replace("_", "-")
        version = match.group("version")
        if name in pins:
            errors.append(f"requirements lock contains duplicate pin: {name}")
        pins[name] = version
        if not raw_line.strip().endswith("\\") or index + 1 >= len(lines):
            errors.append(f"requirements lock pin has no SHA-256 hash: {name}=={version}")
            continue
        hash_line = lines[index + 1].strip()
        prefix = "--hash=sha256:"
        if not hash_line.startswith(prefix) or not _is_sha256(hash_line[len(prefix) :]):
            errors.append(f"requirements lock pin has an invalid SHA-256 hash: {name}=={version}")
    if not pins:
        errors.append(f"requirements lock contains no exact pins: {path}")
    return pins, errors


def _wheel_pin(filename: str) -> tuple[str, str, tuple[str, str, str]] | None:
    if not filename.lower().endswith(".whl"):
        return None
    parts = filename[:-4].split("-")
    if len(parts) < MIN_WHEEL_PARTS:
        return None
    name = parts[0].lower().replace("_", "-")
    return name, parts[1], (parts[-3], parts[-2], parts[-1])


def _normalize_manifest_entries(
    entries: object,
    manifest_path: Path,
) -> tuple[dict[str, str], list[str]]:
    if not isinstance(entries, dict) or not entries:
        return {}, [f"runtime bundle manifest has no file hashes: {manifest_path}"]
    normalized: dict[str, str] = {}
    errors: list[str] = []
    for raw_name, raw_digest in entries.items():
        name = _safe_relative_path(raw_name)
        if name is None or not _is_sha256(raw_digest):
            errors.append(f"runtime bundle manifest has an unsafe file entry: {raw_name!r}")
            continue
        normalized[name] = str(raw_digest).lower()
    return normalized, errors


def _validate_manifest_tree(
    *,
    directory: Path,
    manifest_name: str,
    expected_common: dict[str, object],
    required_files: Iterable[str],
) -> tuple[dict[str, Any] | None, dict[str, str], list[str]]:
    errors: list[str] = []
    manifest_path = directory / manifest_name
    try:
        manifest = _load_json_object(manifest_path)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        message = f"runtime bundle manifest is missing or invalid: {manifest_path} ({error})"
        return None, {}, [message]
    if manifest.get("schema_version") != 1:
        errors.append(f"runtime bundle manifest has unsupported schema: {manifest_path}")
    errors.extend(
        f"runtime bundle manifest field {field!r} drifted: {manifest_path}"
        for field, expected in expected_common.items()
        if manifest.get(field) != expected
    )
    normalized, entry_errors = _normalize_manifest_entries(manifest.get("files"), manifest_path)
    errors.extend(entry_errors)
    on_disk, tree_errors = _tree_files(directory, manifest_name)
    errors.extend(tree_errors)
    if set(on_disk) != set(normalized):
        errors.append(
            f"runtime bundle contents differ from {manifest_path.name} "
            f"(missing={sorted(set(normalized) - set(on_disk))}, "
            f"unexpected={sorted(set(on_disk) - set(normalized))})"
        )
    errors.extend(
        f"runtime bundle checksum mismatch: {directory / name}"
        for name in sorted(set(on_disk) & set(normalized))
        if _sha256_file(on_disk[name]) != normalized[name]
    )
    errors.extend(
        f"runtime bundle required file is missing: {directory / required}"
        for required in required_files
        if required not in normalized
    )
    return manifest, normalized, errors


def _contract_path(root: Path, contract: dict[str, Any], field: str) -> Path:
    value = contract.get(field)
    if not isinstance(value, str) or not value:
        raise ValueError(f"contract field {field!r} must be a path")
    path = (root / value).resolve()
    path.relative_to(root.resolve())
    return path


def _expected_runtime_pins(contract: dict[str, Any]) -> tuple[dict[str, str], list[str]]:
    expected: dict[str, str] = {}
    errors: list[str] = []
    values = [
        *(contract.get("runtime_packages") or []),
        *(contract.get("bootstrap_packages") or []),
    ]
    for value in values:
        match = PIN_RE.fullmatch(str(value).strip())
        if match is None:
            errors.append(f"bundle contract contains a non-exact runtime pin: {value!r}")
            continue
        name = match.group("name").lower().replace("_", "-")
        expected[name] = match.group("version")
    return expected, errors


def _validate_build_contract(
    root: Path,
    contract: dict[str, Any],
) -> tuple[Path | None, Path | None, list[str]]:
    errors: list[str] = []
    try:
        build_lock = _contract_path(root, contract, "build_lock")
        runtime_lock = _contract_path(root, contract, "runtime_lock")
    except (ValueError, OSError) as error:
        return None, None, [f"python runtime bundle contract has an unsafe lock path: {error}"]
    build_pins, build_errors = _parse_hashed_lock(build_lock)
    runtime_pins, runtime_errors = _parse_hashed_lock(runtime_lock)
    errors.extend(build_errors)
    errors.extend(runtime_errors)
    if build_pins != EXPECTED_BUILD_TOOLS:
        errors.append(
            f"build-tool lock drifted (expected={EXPECTED_BUILD_TOOLS}, actual={build_pins})"
        )
    expected_runtime, expected_errors = _expected_runtime_pins(contract)
    errors.extend(expected_errors)
    errors.extend(
        f"runtime lock is missing contract pin: {name}=={version}"
        for name, version in expected_runtime.items()
        if runtime_pins.get(name) != version
    )
    errors.extend(_validate_pyproject_build_system(root))
    errors.extend(_validate_sidecar_lock(root))
    return build_lock, runtime_lock, errors


def _validate_pyproject_build_system(root: Path) -> list[str]:
    try:
        pyproject = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
        build_requires = set(pyproject["build-system"]["requires"])
    except (OSError, KeyError, TypeError, tomllib.TOMLDecodeError) as error:
        return [f"unable to validate pyproject build-system requirements: {error}"]
    expected = {"setuptools==83.0.0", "wheel==0.47.0"}
    if build_requires != expected:
        return [f"pyproject build-system must match the build lock: {sorted(expected)}"]
    return []


def _validate_sidecar_lock(root: Path) -> list[str]:
    pins, errors = _parse_hashed_lock(root / "requirements-lock.txt")
    errors.extend(
        f"requirements-lock.txt must not repin build-only package {name!r}"
        for name in ("pip", "setuptools", "wheel")
        if name in pins
    )
    return errors


def _load_context(root: Path) -> tuple[BundleContext | None, list[str]]:
    errors: list[str] = []
    contract_path = root / "config" / "python-runtime-bundle-lock.json"
    try:
        contract = _load_json_object(contract_path)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        return None, [f"python runtime bundle contract is missing or invalid: {error}"]
    if contract.get("schema_version") != 1:
        errors.append("python runtime bundle contract has unsupported schema")
    python = contract.get("python")
    if not isinstance(python, dict):
        return None, [*errors, "python runtime bundle contract python field must be an object"]
    if not _is_sha256(python.get("embed_sha256")):
        errors.append("python runtime bundle contract has an invalid CPython SHA-256")
    build_lock, runtime_lock, lock_errors = _validate_build_contract(root, contract)
    errors.extend(lock_errors)
    if build_lock is None or runtime_lock is None:
        return None, errors
    common = {
        "contract_sha256": _sha256_file(contract_path),
        "build_lock_sha256": _sha256_file(build_lock),
        "runtime_lock_sha256": _sha256_file(runtime_lock),
        "python_version": python.get("version"),
        "platform": python.get("platform"),
        "abi": python.get("abi"),
    }
    return (
        BundleContext(
            root=root,
            contract=contract,
            python=python,
            build_lock=build_lock,
            runtime_lock=runtime_lock,
            common_manifest_fields=common,
            embed_manifest_name=str(contract.get("embed_manifest") or ""),
            wheelhouse_manifest_name=str(contract.get("wheelhouse_manifest") or ""),
        ),
        errors,
    )


def _validate_embed_bundle(context: BundleContext, embed: Path) -> list[str]:
    python = context.python
    required_files = [
        str(python.get("executable") or ""),
        str(python.get("stdlib_archive") or ""),
        str(python.get("path_file") or ""),
    ]
    manifest, _entries, errors = _validate_manifest_tree(
        directory=embed,
        manifest_name=context.embed_manifest_name,
        expected_common=context.common_manifest_fields,
        required_files=required_files,
    )
    if manifest is None:
        return errors
    if manifest.get("distribution") != "cpython-embeddable":
        errors.append("python embed manifest distribution is not cpython-embeddable")
    if manifest.get("source_url") != python.get("embed_url"):
        errors.append("python embed manifest source URL drifted")
    if manifest.get("source_sha256") != python.get("embed_sha256"):
        errors.append("python embed manifest source checksum drifted")
    return errors


def _validate_wheel_entries(
    entries: dict[str, str],
    runtime_lock: Path,
    python: dict[str, Any],
) -> list[str]:
    errors: list[str] = []
    wheel_pins: dict[str, str] = {}
    for filename in entries:
        parsed = _wheel_pin(filename)
        if parsed is None:
            errors.append(f"python runtime wheel has an invalid filename: {filename}")
            continue
        name, version, (python_tag, abi_tag, platform_tag) = parsed
        if name in wheel_pins:
            errors.append(f"python runtime wheelhouse duplicates distribution: {name}")
        wheel_pins[name] = version
        is_pure = abi_tag == "none" and platform_tag == "any"
        is_target = (
            python_tag == python.get("abi")
            and abi_tag == python.get("abi")
            and platform_tag == python.get("platform")
        )
        if not is_pure and not is_target:
            errors.append(f"python runtime wheel targets the wrong platform: {filename}")
    runtime_pins, lock_errors = _parse_hashed_lock(runtime_lock)
    errors.extend(lock_errors)
    if wheel_pins != runtime_pins:
        errors.append(
            "python runtime wheelhouse does not exactly match its hashed lock "
            f"(expected={runtime_pins}, actual={wheel_pins})"
        )
    return errors


def _validate_wheelhouse_bundle(context: BundleContext, wheelhouse: Path) -> list[str]:
    manifest, entries, errors = _validate_manifest_tree(
        directory=wheelhouse,
        manifest_name=context.wheelhouse_manifest_name,
        expected_common=context.common_manifest_fields,
        required_files=(),
    )
    if manifest is None:
        return errors
    if any(not name.lower().endswith(".whl") for name in entries):
        errors.append("python runtime wheelhouse manifest contains a non-wheel artifact")
    if manifest.get("runtime_packages") != context.contract.get("runtime_packages"):
        errors.append("python runtime wheelhouse top-level package pins drifted")
    if manifest.get("bootstrap_packages") != context.contract.get("bootstrap_packages"):
        errors.append("python runtime wheelhouse bootstrap pins drifted")
    errors.extend(_validate_wheel_entries(entries, context.runtime_lock, context.python))
    return errors


def _validate_path_file(context: BundleContext, embed: Path) -> list[str]:
    path_file = embed / str(context.python.get("path_file") or "")
    try:
        lines = {
            line.strip()
            for line in path_file.read_text(encoding="utf-8-sig").splitlines()
            if line.strip()
        }
    except OSError:
        lines = set()
    if "Lib/site-packages" in lines and "import site" in lines:
        return []
    return ["CPython embeddable path file does not enable managed site-packages"]


def _probe_python(context: BundleContext, embed: Path) -> list[str]:
    executable = embed / str(context.python.get("executable") or "")
    if not executable.is_file():
        return []
    try:
        completed = subprocess.run(
            [str(executable), "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return [f"packaged CPython probe failed to start: {error}"]
    output = f"{completed.stdout}\n{completed.stderr}"
    if completed.returncode == 0 and str(context.python.get("version")) in output:
        return []
    return ["packaged CPython --version probe failed or returned the wrong version"]


def validate_python_runtime_bundle(
    root: Path = ROOT,
    *,
    embed_dir: Path | None = None,
    wheelhouse_dir: Path | None = None,
    probe_python: bool = True,
) -> list[str]:
    context, errors = _load_context(root)
    if context is None:
        return errors
    embed = embed_dir or root / "vendor" / "python-embed"
    wheelhouse = wheelhouse_dir or root / "vendor" / "python-runtime-wheels"
    errors.extend(_validate_embed_bundle(context, embed))
    errors.extend(_validate_wheelhouse_bundle(context, wheelhouse))
    errors.extend(_validate_path_file(context, embed))
    if probe_python and not errors:
        errors.extend(_probe_python(context, embed))
    return errors


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--no-probe",
        action="store_true",
        help="Validate files and hashes without executing the bundled interpreter.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)
    if os.name != "nt":
        print("PASS: Windows managed Python runtime bundle is not required on this host")
        return 0
    violations = validate_python_runtime_bundle(ROOT, probe_python=not args.no_probe)
    if violations:
        print("FAIL: managed Python runtime bundle is not package-ready")
        for violation in violations:
            print(f"  - {violation}")
        print("  - rebuild with: python scripts/build-python-runtime-bundle.py")
        return 1
    print("PASS: managed Python runtime bundle is package-ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
