"""Checksum-manifest verification for the managed runtime's offline wheelhouse.

Nothing is installed from a wheelhouse until every wheel on disk matches the
manifest exactly. Split out of ``interpreter`` to keep that module under the
repository file-size ceiling; ``interpreter`` re-exports the names its callers
and tests already use.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from sidecar.ai.tools.builtins.python_runtime.errors import (
    PythonRuntimeWheelhouseIntegrityError,
)

WHEELHOUSE_MANIFEST_FILENAME = "wheelhouse-manifest.json"


def _wheelhouse_manifest_path(wheelhouse: Path) -> Path:
    return wheelhouse / WHEELHOUSE_MANIFEST_FILENAME


def _load_wheelhouse_manifest(wheelhouse: Path) -> dict[str, str]:
    manifest_path = _wheelhouse_manifest_path(wheelhouse)
    try:
        raw = manifest_path.read_text(encoding="utf-8")
    except OSError as error:
        raise PythonRuntimeWheelhouseIntegrityError(
            f"Python runtime wheelhouse is missing its checksum manifest: {manifest_path}"
        ) from error
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise PythonRuntimeWheelhouseIntegrityError(
            f"Python runtime wheelhouse checksum manifest is not valid JSON: {manifest_path}"
        ) from error
    files = payload.get("files") if isinstance(payload, dict) else None
    if not isinstance(files, dict) or not files:
        raise PythonRuntimeWheelhouseIntegrityError(
            f"Python runtime wheelhouse checksum manifest has no file entries: {manifest_path}"
        )
    normalized: dict[str, str] = {}
    for name, digest in files.items():
        if isinstance(name, str) and name and isinstance(digest, str) and digest:
            normalized[name] = digest.lower()
    if not normalized:
        raise PythonRuntimeWheelhouseIntegrityError(
            f"Python runtime wheelhouse checksum manifest has no valid entries: {manifest_path}"
        )
    return normalized


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_wheelhouse_integrity(wheelhouse: Path) -> None:
    """Verify the wheelhouse's wheel files exactly match a checksum manifest
    before anything is installed from it. Any mismatch — missing manifest,
    missing wheel, unexpected extra wheel, or a bad checksum — raises
    PythonRuntimeWheelhouseIntegrityError. Callers must not catch this to
    fall back to a network install: an untrustworthy wheelhouse fails closed.
    """
    manifest = _load_wheelhouse_manifest(wheelhouse)
    on_disk = sorted(path.name for path in wheelhouse.glob("*.whl"))
    manifest_names = sorted(manifest)
    if on_disk != manifest_names:
        missing = sorted(set(manifest_names) - set(on_disk))
        unexpected = sorted(set(on_disk) - set(manifest_names))
        raise PythonRuntimeWheelhouseIntegrityError(
            "Python runtime wheelhouse contents do not match its checksum manifest "
            f"(missing={missing}, unexpected={unexpected})"
        )
    for name, expected_digest in manifest.items():
        actual_digest = _sha256_file(wheelhouse / name)
        if actual_digest != expected_digest:
            raise PythonRuntimeWheelhouseIntegrityError(
                f"Python runtime wheelhouse file failed checksum verification: {name}"
            )
