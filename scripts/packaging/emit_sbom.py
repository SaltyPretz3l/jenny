"""Emit a minimal CycloneDX SBOM for the locked sidecar artifact dependencies."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Sequence

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REQUIREMENTS_LOCK = ROOT / "requirements-lock.txt"
DEFAULT_BUILD_REQUIREMENTS_LOCK = ROOT / "requirements-build-lock.txt"
DEFAULT_MANAGED_RUNTIME_LOCK = ROOT / "requirements-python-runtime-lock.txt"
DEFAULT_RUNTIME_BUNDLE_CONTRACT = ROOT / "config" / "python-runtime-bundle-lock.json"
DEFAULT_EMBED_MANIFEST = ROOT / "vendor" / "python-embed" / "python-embed-manifest.json"
DEFAULT_WHEELHOUSE_MANIFEST = (
    ROOT / "vendor" / "python-runtime-wheels" / "wheelhouse-manifest.json"
)
DEFAULT_OUTPUT_PATH = ROOT / "dist" / "sidecar-sbom.json"
_PINNED_REQUIREMENT_RE = re.compile(
    r"^(?P<name>[A-Za-z0-9_.-]+)==(?P<version>[A-Za-z0-9_.!+*-]+)"
)
SHA256_HEX_LENGTH = 64


def _normalize_purl_name(name: str) -> str:
    return str(name or "").strip().lower().replace("_", "-")


def _dependency_scope_property(scope: str) -> list[dict[str, str]]:
    return [{"name": "jenny:dependency-scope", "value": scope}]


def parse_locked_components(
    lock_path: Path,
    *,
    scope: str | None = None,
) -> list[dict[str, object]]:
    components: list[dict[str, object]] = []
    if not lock_path.is_file():
        # The lean friend distribution intentionally ships without requirements-lock.txt.
        # Emit a valid SBOM with no pinned components instead of crashing the pack/release
        # path (npm run pack:* and the release CI) with FileNotFoundError.
        return components
    for raw_line in lock_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = _PINNED_REQUIREMENT_RE.match(line)
        if match is None:
            continue
        name = match.group("name")
        version = match.group("version")
        purl_name = _normalize_purl_name(name)
        component: dict[str, object] = {
            "type": "library",
            "name": name,
            "version": version,
            "purl": f"pkg:pypi/{purl_name}@{version}",
        }
        if scope:
            component["properties"] = _dependency_scope_property(scope)
        components.append(component)
    return sorted(components, key=lambda component: str(component["name"]).lower())


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json_object(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _managed_python_component(contract_path: Path) -> dict[str, object] | None:
    contract = _read_json_object(contract_path)
    python = contract.get("python")
    if not isinstance(python, dict):
        return None
    version = str(python.get("version", "")).strip()
    digest = str(python.get("embed_sha256", "")).strip().lower()
    source_url = str(python.get("embed_url", "")).strip()
    if not version or len(digest) != SHA256_HEX_LENGTH:
        return None
    return {
        "type": "application",
        "name": "CPython embeddable runtime",
        "version": version,
        "purl": f"pkg:generic/cpython@{version}",
        "hashes": [{"alg": "SHA-256", "content": digest}],
        "properties": [
            *_dependency_scope_property("managed-python-interpreter"),
            {"name": "jenny:source-url", "value": source_url},
        ],
    }


def _release_lock_specs(
    lock_path: Path,
    *,
    include_managed_runtime: bool,
) -> list[tuple[Path, str]]:
    specs = [(lock_path, "sidecar-runtime")]
    if lock_path.resolve() == DEFAULT_REQUIREMENTS_LOCK.resolve():
        specs.append((DEFAULT_BUILD_REQUIREMENTS_LOCK, "sidecar-build"))
        if include_managed_runtime:
            specs.append((DEFAULT_MANAGED_RUNTIME_LOCK, "managed-python-runtime"))
    return specs


def _provenance_properties(lock_specs: list[tuple[Path, str]]) -> list[dict[str, str]]:
    properties: list[dict[str, str]] = []
    for path, scope in lock_specs:
        if path.is_file():
            properties.append(
                {
                    "name": f"jenny:lock-sha256:{scope}",
                    "value": _sha256_file(path),
                }
            )
    for path, name in (
        (DEFAULT_RUNTIME_BUNDLE_CONTRACT, "runtime-bundle-contract"),
        (DEFAULT_EMBED_MANIFEST, "python-embed-manifest"),
        (DEFAULT_WHEELHOUSE_MANIFEST, "python-wheelhouse-manifest"),
    ):
        if path.is_file():
            properties.append({"name": f"jenny:sha256:{name}", "value": _sha256_file(path)})
    return properties


def read_package_version(root: Path = ROOT) -> str:
    package_path = root / "package.json"
    try:
        payload = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    return str(payload.get("version", "")).strip()


def build_sbom(
    *,
    lock_path: Path = DEFAULT_REQUIREMENTS_LOCK,
    package_version: str | None = None,
    include_managed_runtime: bool | None = None,
) -> dict[str, object]:
    include_managed = (
        sys.platform.startswith("win")
        if include_managed_runtime is None
        else include_managed_runtime
    )
    lock_specs = _release_lock_specs(
        lock_path,
        include_managed_runtime=include_managed,
    )
    components: list[dict[str, object]] = []
    for current_lock, scope in lock_specs:
        components.extend(parse_locked_components(current_lock, scope=scope))
    if include_managed and lock_path.resolve() == DEFAULT_REQUIREMENTS_LOCK.resolve():
        managed_python = _managed_python_component(DEFAULT_RUNTIME_BUNDLE_CONTRACT)
        if managed_python is not None:
            components.append(managed_python)
    components.sort(
        key=lambda component: (
            str(component.get("name", "")).lower(),
            str(component.get("version", "")),
            str(component.get("properties", "")),
        )
    )
    version_source = package_version if package_version is not None else read_package_version()
    version = str(version_source).strip()
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "serialNumber": f"urn:uuid:{uuid.uuid4()}",
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(UTC).isoformat(),
            "component": {
                "type": "application",
                "name": "jenny-sidecar",
                "version": version,
            },
            "properties": _provenance_properties(lock_specs),
        },
        "components": components,
    }


def emit_sbom(
    *,
    lock_path: Path = DEFAULT_REQUIREMENTS_LOCK,
    output_path: Path = DEFAULT_OUTPUT_PATH,
    package_version: str | None = None,
) -> Path:
    sbom = build_sbom(lock_path=lock_path, package_version=package_version)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(sbom, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return output_path


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", default=str(DEFAULT_REQUIREMENTS_LOCK))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_PATH))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)
    lock_path = Path(args.lock)
    output_path = emit_sbom(lock_path=lock_path, output_path=Path(args.output))
    if not lock_path.is_file():
        print(
            f"NOTE: requirements lock not found ({lock_path}); "
            "emitted SBOM with no pinned components."
        )
    print(f"PASS: sidecar SBOM emitted: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
