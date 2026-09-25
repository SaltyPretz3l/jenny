"""Verify Jenny's generated sidecar media dependency site."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path, PurePosixPath
from typing import Any, Sequence

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DESTINATION = ROOT / "vendor" / "sidecar-media-site"
DEFAULT_LOCK = ROOT / "requirements-media-site-lock.txt"
DEFAULT_PYTHON_VERSION = "3.11"
MANIFEST_NAME = "manifest.json"
COPY_CHUNK_BYTES = 1024 * 1024
REQUIRED_DIRECTORIES = ("rapidocr", "onnxruntime", "cv2")
FORBIDDEN_DIRECTORIES = ("pymupdf", "fitz")
REQUIRED_MODEL_FILES = (
    "rapidocr/models/PP-OCRv6_det_small.onnx",
    "rapidocr/models/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    "rapidocr/models/PP-OCRv6_rec_small.onnx",
)


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


def _load_manifest(path: Path) -> tuple[dict[str, Any] | None, list[str]]:
    if not path.is_file():
        return None, ["manifest is missing"]
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return None, [f"manifest is unreadable: {error}"]
    if not isinstance(payload, dict):
        return None, ["manifest root is not an object"]
    return payload, []


def _manifest_file_path(destination: Path, relative: str) -> Path | None:
    if "\\" in relative:
        return None
    pure_path = PurePosixPath(relative)
    if pure_path.is_absolute() or not pure_path.parts or ".." in pure_path.parts:
        return None
    candidate = destination.joinpath(*pure_path.parts)
    try:
        candidate.resolve().relative_to(destination.resolve())
    except (OSError, ValueError):
        return None
    return candidate


def _validate_manifest_files(destination: Path, raw_files: object) -> tuple[list[str], int]:
    if not isinstance(raw_files, dict):
        return ["manifest files field is not an object"], 0
    errors: list[str] = []
    listed_files: set[str] = set()
    for raw_relative, raw_digest in sorted(raw_files.items(), key=lambda item: str(item[0])):
        if not isinstance(raw_relative, str) or not isinstance(raw_digest, str):
            errors.append("manifest contains a non-string file entry")
            continue
        listed_files.add(raw_relative)
        path = _manifest_file_path(destination, raw_relative)
        if path is None:
            errors.append(f"manifest contains an unsafe file path: {raw_relative}")
        elif not path.is_file():
            errors.append(f"listed file is missing: {raw_relative}")
        elif _sha256_file(path) != raw_digest:
            errors.append(f"checksum mismatch: {raw_relative}")

    actual_files = {
        path.relative_to(destination).as_posix()
        for path in destination.rglob("*")
        if path.is_file() and path.name not in {MANIFEST_NAME, ".gitignore"}
    }
    for relative in sorted(actual_files - listed_files):
        errors.append(f"unlisted file: {relative}")
    return errors, len(raw_files)


def _validate_manifest_metadata(
    manifest: dict[str, Any], *, python_version: str, platform: str
) -> list[str]:
    errors: list[str] = []
    if manifest.get("schema_version") != 1:
        errors.append("schema_version mismatch: expected 1")
    if manifest.get("python_version") != python_version:
        errors.append(
            "python_version mismatch: "
            f"expected {python_version}, got {manifest.get('python_version')}"
        )
    if manifest.get("platform") != platform:
        errors.append(f"platform mismatch: expected {platform}, got {manifest.get('platform')}")
    return errors


def validate_media_site(
    destination: Path,
    *,
    lock_path: Path,
    python_version: str,
    platform: str,
) -> tuple[list[str], int]:
    if not destination.is_dir():
        return [f"media site directory is missing: {destination}"], 0
    manifest, errors = _load_manifest(destination / MANIFEST_NAME)
    if manifest is None:
        return errors, 0
    errors.extend(
        _validate_manifest_metadata(manifest, python_version=python_version, platform=platform)
    )
    try:
        lock_digest = _sha256_file(lock_path)
    except OSError as error:
        errors.append(f"requirements lock is unreadable: {error}")
    else:
        if manifest.get("lock_sha256") != lock_digest:
            errors.append("lock checksum mismatch")

    file_errors, file_count = _validate_manifest_files(destination, manifest.get("files"))
    errors.extend(file_errors)
    for relative in REQUIRED_DIRECTORIES:
        if not (destination / relative).is_dir():
            errors.append(f"required package directory missing: {relative}/")
    for relative in FORBIDDEN_DIRECTORIES:
        if (destination / relative).is_dir():
            errors.append(
                f"forbidden package directory present: {relative}/; "
                "PyMuPDF is an optional add-on and must not be bundled"
            )
    for relative in REQUIRED_MODEL_FILES:
        if not (destination / relative).is_file():
            errors.append(f"required model file missing: {relative}")
    return errors, file_count


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    parser.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--python-version", default=DEFAULT_PYTHON_VERSION)
    parser.add_argument("--platform", default=_default_platform())
    parser.add_argument("--json", action="store_true", help="Also print a JSON summary.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)
    errors, file_count = validate_media_site(
        args.destination,
        lock_path=args.lock,
        python_version=str(args.python_version),
        platform=str(args.platform),
    )
    if errors:
        for error in errors:
            print(f"FAIL: - {error}")
        status = "failure"
        exit_code = 1
    else:
        print(f"PASS: sidecar media site verified ({file_count} files)")
        status = "success"
        exit_code = 0
    if args.json:
        print(
            json.dumps(
                {"status": status, "file_count": file_count, "failures": errors},
                sort_keys=True,
            )
        )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
