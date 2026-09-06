"""Enforce the Monaco pin and AMD worker files required by the renderer."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MONACO_VERSION = "0.52.0"
PACKAGE_PIN_FAILURE = (
    "FAIL: WIDE-049: package.json must pin monaco-editor to exactly 0.52.0; "
    "the AMD worker build breaks past 0.52.x."
)
FIXED_AMD_PATHS = (
    "base/worker/workerMain.js",
    "loader.js",
    "editor/editor.main.js",
)
ALLOWED_MONACO_EXCLUSIONS = {
    "!node_modules/monaco-editor/esm/**",
    "!node_modules/monaco-editor/dev/**",
    "!node_modules/monaco-editor/min-maps/**",
}


def validate_package_json(source: str) -> list[str]:
    try:
        manifest = json.loads(source)
    except (json.JSONDecodeError, TypeError):
        return [PACKAGE_PIN_FAILURE]

    declared_versions = []
    if isinstance(manifest, dict):
        for section_name in ("dependencies", "devDependencies"):
            section = manifest.get(section_name)
            if isinstance(section, dict) and "monaco-editor" in section:
                declared_versions.append(section["monaco-editor"])

    if not declared_versions or any(
        not isinstance(version, str) or version != MONACO_VERSION
        for version in declared_versions
    ):
        return [PACKAGE_PIN_FAILURE]
    return []


def validate_package_lock(source: str) -> list[str]:
    try:
        lock = json.loads(source)
    except (json.JSONDecodeError, TypeError):
        lock = None

    entry = None
    if isinstance(lock, dict) and isinstance(lock.get("packages"), dict):
        entry = lock["packages"].get("node_modules/monaco-editor")
    version = entry.get("version") if isinstance(entry, dict) else None
    if version != MONACO_VERSION:
        return [
            "FAIL: WIDE-049: package-lock.json must resolve "
            "packages[\"node_modules/monaco-editor\"].version to exactly 0.52.0."
        ]
    return []


def validate_worker_bundles(source: str, vs_root: Path) -> list[str]:
    block = re.search(
        r"\bLANGUAGE_WORKER_BUNDLES\s*=\s*\{(?P<body>.*?)\};",
        source,
        re.DOTALL,
    )
    if block is None:
        return [
            "FAIL: WIDE-049: parsed zero LANGUAGE_WORKER_BUNDLES paths from "
            "renderer/frames/monaco-worker-bootstrap.js; update this gate for the rename."
        ]

    value_pattern = re.compile(
        r''':\s*(?P<quote>["'])(?P<path>[^"'\r\n]+)(?P=quote)\s*,?'''
    )
    parsed_paths = [match.group("path") for match in value_pattern.finditer(block.group("body"))]
    if not parsed_paths:
        return [
            "FAIL: WIDE-049: parsed zero LANGUAGE_WORKER_BUNDLES paths from "
            "renderer/frames/monaco-worker-bootstrap.js; update this gate for the rename."
        ]

    required_paths = list(dict.fromkeys([*parsed_paths, *FIXED_AMD_PATHS]))
    return [
        f"FAIL: WIDE-049: Monaco AMD worker input is missing: "
        f"node_modules/monaco-editor/min/vs/{relative_path}."
        for relative_path in required_paths
        if not (vs_root / relative_path).is_file()
    ]


def validate_builder_exclusions(source: str) -> list[str]:
    entry_pattern = re.compile(
        r'''^\s*-\s*(?P<quote>["']?)(?P<path>!node_modules/monaco-editor/[^\s"'#]+)'''
        r'''(?P=quote)\s*(?:#.*)?$'''
    )
    violations = []
    for line in source.splitlines():
        if "!node_modules/monaco-editor/" not in line:
            continue
        match = entry_pattern.fullmatch(line)
        exclusion = match.group("path") if match else line.strip()
        if match is None or exclusion not in ALLOWED_MONACO_EXCLUSIONS:
            violations.append(
                "FAIL: WIDE-049: electron-builder.yml has a disallowed Monaco exclusion "
                f"({exclusion}); the packaged AMD min/vs build must remain included."
            )
    return violations


def _read(path: Path, label: str) -> tuple[str | None, list[str]]:
    try:
        return path.read_text(encoding="utf-8"), []
    except OSError as error:
        return None, [f"FAIL: WIDE-049: could not read {label}: {error}."]


def main() -> int:
    messages: list[str] = []

    package_source, errors = _read(ROOT / "package.json", "package.json")
    messages.extend(errors)
    if package_source is not None:
        messages.extend(validate_package_json(package_source))

    lock_source, errors = _read(ROOT / "package-lock.json", "package-lock.json")
    messages.extend(errors)
    if lock_source is not None:
        messages.extend(validate_package_lock(lock_source))

    monaco_root = ROOT / "node_modules" / "monaco-editor"
    if not monaco_root.exists():
        messages.append(
            "SKIP: node_modules/monaco-editor is not installed; AMD worker file checks were skipped."
        )
    else:
        bootstrap_source, errors = _read(
            ROOT / "renderer" / "frames" / "monaco-worker-bootstrap.js",
            "renderer/frames/monaco-worker-bootstrap.js",
        )
        messages.extend(errors)
        if bootstrap_source is not None:
            messages.extend(
                validate_worker_bundles(bootstrap_source, monaco_root / "min" / "vs")
            )

    builder_source, errors = _read(ROOT / "electron-builder.yml", "electron-builder.yml")
    messages.extend(errors)
    if builder_source is not None:
        messages.extend(validate_builder_exclusions(builder_source))

    for message in messages:
        print(message)
    if any(message.startswith("FAIL:") for message in messages):
        return 1

    print("PASS: Monaco 0.52.0 pin and AMD package inputs are intact")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
