"""SHA256 release-manifest block: build, validate, and replace.

Shared by the maintainer-only appender (scripts/release, not distributed) and
the shipped release check, so the distributed source tree can validate a
release-notes manifest block without the maintainer tooling.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Sequence

MANIFEST_START = "<!-- JENNY_RELEASE_SHA256_MANIFEST_START -->"
MANIFEST_END = "<!-- JENNY_RELEASE_SHA256_MANIFEST_END -->"
ROW_RE = re.compile(r"^\|\s*(?P<file>[^|]+?)\s*\|\s*(?P<sha>[a-fA-F0-9]{64})\s*\|$")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _relative_path(path: Path, *, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.name


def _resolve_asset_inside_root(path: Path, *, root: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise RuntimeError(f"release asset is outside the release root: {path}") from exc
    return resolved


def _resolve_manifest_asset(file_name: str, *, root: Path) -> tuple[Path | None, str | None]:
    row_path = Path(file_name)
    if row_path.is_absolute():
        return None, f"release asset path must be repo-relative: {file_name}"
    resolved = (root / row_path).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return None, f"release asset path escapes release root: {file_name}"
    return resolved, None


def build_manifest_block(asset_paths: Sequence[Path], *, root: Path) -> str:
    rows: list[str] = []
    for path in sorted((Path(asset) for asset in asset_paths), key=lambda item: item.as_posix()):
        if not path.exists() or not path.is_file():
            raise RuntimeError(f"release asset is missing or not a file: {path}")
        asset_path = _resolve_asset_inside_root(path, root=root)
        rows.append(f"| {_relative_path(asset_path, root=root)} | {_sha256(asset_path)} |")

    body = [
        MANIFEST_START,
        "| File | SHA256 |",
        "| --- | --- |",
        *rows,
        MANIFEST_END,
    ]
    return "\n".join(body) + "\n"


def _manifest_block_bounds(text: str) -> tuple[int, int] | None:
    start_count = text.count(MANIFEST_START)
    end_count = text.count(MANIFEST_END)
    if start_count == 0 and end_count == 0:
        return None
    if start_count != 1 or end_count != 1:
        raise ValueError(
            "SHA256 manifest block must contain exactly one start marker and one end marker"
        )
    start = text.find(MANIFEST_START)
    end = text.find(MANIFEST_END)
    if end < start:
        raise ValueError("SHA256 manifest block markers are misordered")
    return start, end + len(MANIFEST_END)


def _extract_manifest_block(text: str) -> str:
    bounds = _manifest_block_bounds(text)
    if bounds is None:
        return ""
    return text[bounds[0] : bounds[1]]


def validate_manifest_block(
    text: str,
    *,
    require_assets: bool = False,
    root: Path | None = None,
    verify_assets: bool = False,
) -> list[str]:
    violations: list[str] = []
    try:
        block = _extract_manifest_block(text)
    except ValueError as error:
        return [str(error)]
    if not block:
        return ["RELEASE_NOTES.md missing SHA256 manifest block"]

    rows = []
    for raw_line in block.splitlines():
        line = raw_line.strip()
        if not line.startswith("|") or "---" in line or "SHA256" in line:
            continue
        match = ROW_RE.match(line)
        if not match:
            violations.append(f"invalid SHA256 manifest row: {line}")
            continue
        file_name = match.group("file").strip()
        sha = match.group("sha").lower()
        if verify_assets:
            if root is None:
                violations.append("asset verification requires a release root")
                continue
            asset_path, asset_error = _resolve_manifest_asset(file_name, root=root)
            if asset_error is not None:
                violations.append(asset_error)
                continue
            if asset_path is None or not asset_path.exists() or not asset_path.is_file():
                violations.append(f"release asset is missing or not a file: {file_name}")
                continue
            if _sha256(asset_path) != sha:
                violations.append(f"SHA256 mismatch for release asset: {file_name}")
        rows.append(line)

    if require_assets and not rows:
        violations.append("SHA256 manifest block has no asset rows")
    return violations


def replace_manifest_block(text: str, block: str) -> str:
    bounds = _manifest_block_bounds(text)
    if bounds is not None:
        updated = text[: bounds[0]] + block.strip() + text[bounds[1] :]
        return updated.rstrip() + "\n"
    separator = "\n" if text.endswith("\n") else "\n\n"
    return text + separator + block
