"""Fence the opt-in Codex CLI product-engine lane behind its single seam.

Opt-in ``codex-cli-*`` modules under ``services/backend/`` are reachable from
product code only through the ``services/backend/backend-service.js`` composition
seam, never by direct import. See ``docs/architecture/BACKEND_SEAM_LANE.md``.

They are composed in ``backend-service.js`` and reached only through that seam (the
IPC handlers in ``services/auxiliary-ipc-handlers.js`` call methods on the composed
``backendService`` and return ``*_unavailable`` when a method is absent). Product
runtime code must not take a hard import dependency outside the seam —
the codex engine is a product feature, but it is still injected through the composition
root, not direct-imported.

Allowed importers of a seam-lane module:
  - ``services/backend/backend-service.js``  -- the documented composition seam
  - other seam-lane modules                  -- internal cohesion
  - anything under ``tests/``                -- direct unit tests

Any other importer is a fencing violation. See
``docs/architecture/BACKEND_SEAM_LANE.md``.

Note: ``services/backend/turn-diagnostic-*.js`` are product canonical-turn-event
diagnostics, not part of this Codex CLI lane.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT / "services" / "backend"
SEAM_PREFIXES = ("codex-cli-",)

# The single product-path importer allowed to reach into the lane.
SEAM = (BACKEND_DIR / "backend-service.js").resolve()

IGNORE_DIRS = {
    ".git",
    ".venv",
    ".tmp",
    ".sidecar-packaging",
    "artifacts",
    "node_modules",
    "archive",
    "build",
    "vendor",
    "dist",
    "PORT_BUNDLES",
    "tests",
}
SCAN_SUFFIXES = {".js", ".cjs", ".mjs"}

# Relative module specifiers that name a seam-lane file. Restricting the regex to
# specifiers carrying a seam prefix keeps the scan cheap; final membership is decided
# by resolving the path, so 'turn-diagnostic-*' (which contains the substring
# 'diagnostic-') is matched here but excluded by the lane set below.
REF_RE = re.compile(r"""['"](\.[^'"]*codex-cli-[^'"]*)['"]""")


def seam_lane_modules() -> set[Path]:
    lane: set[Path] = set()
    if not BACKEND_DIR.is_dir():
        return lane
    for path in BACKEND_DIR.glob("*.js"):
        if path.name.startswith(SEAM_PREFIXES):
            lane.add(path.resolve())
    return lane


def resolve_ref(spec: str, importer: Path) -> Path | None:
    if not spec.startswith("."):
        return None
    raw = (importer.parent / spec).resolve()
    candidates = [raw, raw / "index.js"]
    for suffix in SCAN_SUFFIXES:
        candidates.append(Path(f"{raw}{suffix}"))
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def iter_scan_files() -> list[Path]:
    files: list[Path] = []
    for directory, dir_names, file_names in os.walk(ROOT):
        dir_names[:] = sorted(name for name in dir_names if name not in IGNORE_DIRS)
        directory_path = Path(directory)
        for file_name in sorted(file_names):
            path = directory_path / file_name
            if path.suffix in SCAN_SUFFIXES:
                files.append(path)
    return files


def main() -> int:
    lane = seam_lane_modules()
    if not lane:
        print(
            "FAIL: backend seam lane is empty "
            "(expected services/backend/codex-cli-* modules)"
        )
        return 1

    allowed = {SEAM} | lane
    violations: list[str] = []
    for path in iter_scan_files():
        if path.resolve() in allowed:
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if "codex-cli-" not in content:
            continue
        for lineno, line in enumerate(content.splitlines(), start=1):
            for match in REF_RE.finditer(line):
                target = resolve_ref(match.group(1), path)
                if target and target in lane:
                    violations.append(
                        f"{path.relative_to(ROOT).as_posix()}:{lineno}: imports seam-lane "
                        f"module {target.relative_to(ROOT).as_posix()}"
                    )

    if violations:
        print("FAIL: product runtime modules import the fenced backend seam lane")
        print(
            "      allowed importers: services/backend/backend-service.js "
            "(composition seam), the lane itself, tests/"
        )
        for item in violations:
            print(f"  - {item}")
        print("      see docs/architecture/BACKEND_SEAM_LANE.md")
        return 1

    print(
        f"PASS: backend seam lane fenced ({len(lane)} opt-in Codex CLI modules, "
        "single backend-service seam)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
