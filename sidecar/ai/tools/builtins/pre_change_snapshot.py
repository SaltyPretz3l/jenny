"""Bounded content-addressed storage for pre-change text snapshots."""

from __future__ import annotations

import hashlib
import os
import stat as stat_module
import tempfile
from pathlib import Path

from sidecar.ai.tools.builtins.structured_diff import normalize_diff_input_text, sha256_text
from sidecar.ai.tools.workspace_path_identity import NodeIdentity, is_link_object

MAX_ENTRIES = 200
MAX_TOTAL_BYTES = 50 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024
SNAPSHOT_SUFFIX = ".snap"


def capture(root: str | None, path_hint: str, content: object) -> dict[str, object]:
    """Store normalized text by its structured-diff hash without raising."""

    del path_hint  # Reserved for bounded diagnostics; file content is never logged.
    if not isinstance(root, str) or not root.strip():
        return {"stored": False, "reason": "unconfigured", "hash": ""}
    if not isinstance(content, str):
        return {"stored": False, "reason": "not_text", "hash": ""}

    hash_value = ""
    temp_path: Path | None = None
    try:
        normalized = normalize_diff_input_text(content)
        hash_value = sha256_text(normalized)
        if len(normalized.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
            return {"stored": False, "reason": "too_large", "hash": hash_value}

        root_path = Path(root.strip())
        root_path.mkdir(parents=True, exist_ok=True)
        snapshot_path = root_path / f"{hash_value.removeprefix('sha256:')}{SNAPSHOT_SUFFIX}"
        existing_identity = _matching_snapshot_identity(snapshot_path, hash_value)
        if existing_identity is not None and _touch_snapshot(
            snapshot_path, existing_identity,
        ):
            return {"stored": True, "hash": hash_value, "deduped": True}

        descriptor, raw_temp_path = tempfile.mkstemp(
            prefix=f".{snapshot_path.stem}.",
            suffix=".tmp",
            dir=root_path,
        )
        temp_path = Path(raw_temp_path)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(normalized)
        os.replace(temp_path, snapshot_path)
        temp_path = None
        try:
            _prune(root_path)
        except Exception:  # noqa: BLE001 - retention is best-effort.
            pass
        return {"stored": True, "hash": hash_value, "deduped": False}
    except Exception:  # noqa: BLE001 - snapshots must never affect edits.
        return {"stored": False, "reason": "error", "hash": hash_value}
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001 - cleanup is best-effort.
                pass


def _matching_snapshot_identity(path: Path, expected_hash: str) -> NodeIdentity | None:
    try:
        captured = NodeIdentity.from_stat(path.lstat())
        if (
            is_link_object(path)
            or not stat_module.S_ISREG(captured.mode)
            or captured.size > MAX_SNAPSHOT_BYTES
        ):
            return None
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(str(path), flags)
    except Exception:  # noqa: BLE001 - invalid snapshot objects are cache misses.
        return None

    try:
        opened_stat = os.fstat(descriptor)
        if (
            not stat_module.S_ISREG(opened_stat.st_mode)
            or not captured.matches_open_stat(opened_stat)
        ):
            return None
        digest = hashlib.sha256()
        remaining = MAX_SNAPSHOT_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            digest.update(chunk)
            remaining -= len(chunk)
        opened_identity = NodeIdentity.from_stat(opened_stat)
        if (
            remaining == 0
            or NodeIdentity.from_stat(os.fstat(descriptor)) != opened_identity
        ):
            return None
        actual_hash = f"sha256:{digest.hexdigest()}"
        return captured if actual_hash == expected_hash else None
    except OSError:
        return None
    finally:
        os.close(descriptor)


def _touch_snapshot(path: Path, expected: NodeIdentity) -> bool:
    try:
        current = NodeIdentity.from_stat(path.lstat())
        if (
            current != expected
            or is_link_object(path)
            or not stat_module.S_ISREG(current.mode)
        ):
            return False
        os.utime(path, None)
    except Exception:  # noqa: BLE001 - a failed touch falls back to replacement.
        return False
    return True


def _prune(root: Path) -> None:
    entries: list[tuple[Path, int, float]] = []
    for path in root.iterdir():
        if path.suffix != SNAPSHOT_SUFFIX or not path.is_file():
            continue
        try:
            stat_result = path.stat()
        except OSError:
            continue
        entries.append((path, stat_result.st_size, stat_result.st_mtime))

    entries.sort(key=lambda entry: entry[2], reverse=True)
    kept = 0
    kept_bytes = 0
    for path, size, _mtime in entries:
        if kept + 1 <= MAX_ENTRIES and kept_bytes + size <= MAX_TOTAL_BYTES:
            kept += 1
            kept_bytes += size
            continue
        try:
            path.unlink()
        except OSError:
            pass
