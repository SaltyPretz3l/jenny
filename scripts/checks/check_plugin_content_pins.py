"""Verify checked-in official plugin content pins against their view assets."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]


def _relative(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def _is_upstream(path: Path) -> bool:
    parts = path.parts
    return any(
        parts[index : index + 2] == ("runtime", "upstream")
        for index in range(len(parts) - 1)
    )


def _discover_documents() -> list[Path]:
    return sorted(
        path
        for path in ROOT.glob("plugins/official/*/content/*.json")
        if not _is_upstream(path)
    )


def _shape_violation(
    violations: list[str], document_path: Path, asset_path: object, expected: str, actual: object
) -> None:
    violations.append(
        f"{_relative(document_path)}: asset {asset_path!r}: "
        f"expected {expected}; actual {actual!r}"
    )


def _asset_bytes(
    violations: list[str], document_path: Path, plugin_root: Path, asset_path: str
) -> tuple[Path, bytes] | None:
    candidate = plugin_root / asset_path
    try:
        resolved = candidate.resolve()
        resolved.relative_to(plugin_root.resolve())
    except (OSError, RuntimeError, ValueError) as error:
        violations.append(
            f"{_relative(document_path)}: asset {asset_path!r}: "
            f"expected path within {_relative(plugin_root)}; actual {error}"
        )
        return None
    try:
        return resolved, resolved.read_bytes()
    except OSError as error:
        violations.append(
            f"{_relative(document_path)}: asset {asset_path!r}: "
            f"expected existing readable file; actual {error}"
        )
        return None


def _validate_pin(
    violations: list[str],
    document_path: Path,
    plugin_root: Path,
    *,
    asset_path: object,
    expected_sha256: object,
    expected_bytes: object = None,
    check_bytes: bool = False,
) -> None:
    if not isinstance(asset_path, str) or not asset_path:
        _shape_violation(
            violations, document_path, asset_path, "non-empty string path", asset_path
        )
        return
    if not isinstance(expected_sha256, str) or not expected_sha256:
        _shape_violation(
            violations,
            document_path,
            asset_path,
            "non-empty string sha256",
            expected_sha256,
        )
        return
    valid_byte_count = isinstance(expected_bytes, int) and not isinstance(
        expected_bytes, bool
    ) and expected_bytes >= 0
    if check_bytes and not valid_byte_count:
        _shape_violation(
            violations,
            document_path,
            asset_path,
            "non-negative integer bytes",
            expected_bytes,
        )

    loaded = _asset_bytes(violations, document_path, plugin_root, asset_path)
    if loaded is None:
        return
    resolved, contents = loaded
    actual_sha256 = hashlib.sha256(contents).hexdigest()
    if actual_sha256.lower() != expected_sha256.lower():
        violations.append(
            f"{_relative(document_path)}: asset {_relative(resolved)}: "
            f"expected sha256={expected_sha256}; actual sha256={actual_sha256}"
        )
    if check_bytes and valid_byte_count and len(contents) != expected_bytes:
        violations.append(
            f"{_relative(document_path)}: asset {_relative(resolved)}: "
            f"expected bytes={expected_bytes}; actual bytes={len(contents)}"
        )


def _validate_assets(
    violations: list[str], document_path: Path, plugin_root: Path, assets: Any
) -> None:
    if not isinstance(assets, list):
        _shape_violation(
            violations, document_path, "assets", "JSON array", type(assets).__name__
        )
        return
    for index, asset in enumerate(assets):
        if not isinstance(asset, dict):
            _shape_violation(
                violations,
                document_path,
                f"assets[{index}]",
                "JSON object",
                type(asset).__name__,
            )
            continue
        _validate_pin(
            violations,
            document_path,
            plugin_root,
            asset_path=asset.get("path"),
            expected_sha256=asset.get("sha256"),
            expected_bytes=asset.get("bytes"),
            check_bytes="bytes" in asset,
        )


def _validate_entry(
    violations: list[str], document_path: Path, plugin_root: Path, document: dict[str, Any]
) -> None:
    has_path = "entry_path" in document
    has_sha256 = "entry_sha256" in document
    if not has_path and not has_sha256:
        return
    if has_path != has_sha256:
        missing = "entry_sha256" if has_path else "entry_path"
        _shape_violation(
            violations,
            document_path,
            document.get("entry_path", "<missing>"),
            f"paired entry_path and entry_sha256 ({missing} is missing)",
            document.get(missing),
        )
        return
    _validate_pin(
        violations,
        document_path,
        plugin_root,
        asset_path=document.get("entry_path"),
        expected_sha256=document.get("entry_sha256"),
    )


def main() -> int:
    violations: list[str] = []
    pinned_document_count = 0
    asset_count = 0
    for document_path in _discover_documents():
        try:
            document = json.loads(document_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            violations.append(
                f"{_relative(document_path)}: expected readable JSON object; actual {error}"
            )
            continue
        if not isinstance(document, dict):
            violations.append(
                f"{_relative(document_path)}: expected JSON object; "
                f"actual {type(document).__name__}"
            )
            continue
        if "assets" not in document:
            continue

        pinned_document_count += 1
        assets = document["assets"]
        if isinstance(assets, list):
            asset_count += len(assets)
        plugin_root = document_path.parents[1]
        _validate_assets(violations, document_path, plugin_root, assets)
        _validate_entry(violations, document_path, plugin_root, document)

    if pinned_document_count == 0:
        violations.append(
            "plugins/official/*/content/*.json: expected at least one document "
            "declaring assets; actual 0"
        )
    if violations:
        print("FAIL: official plugin content pin check")
        for violation in violations:
            print(f"  - {violation}")
        return 1

    print(
        "PASS: official plugin content pin check "
        f"({pinned_document_count} documents, {asset_count} assets)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
