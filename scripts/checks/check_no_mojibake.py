"""Fail if canonical repo docs contain obvious mojibake markers."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CANONICAL_DOCS = (
    "AGENTS.md",
    "README.md",
    "NEXT_STEPS.md",
    "WORKSPACE_MANIFEST.md",
)
CANONICAL_GLOBS = ("docs/manifests/*.md",)
MOJIBAKE_MARKERS = ("Ã¢â‚¬", "Ã", "\ufffd")


def iter_target_paths() -> list[Path]:
    targets: list[Path] = []
    for relative_path in CANONICAL_DOCS:
        path = ROOT / relative_path
        if path.is_file():
            targets.append(path)
    for pattern in CANONICAL_GLOBS:
        targets.extend(path for path in sorted(ROOT.glob(pattern)) if path.is_file())
    return targets


def find_violations(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []

    violations: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        markers = [repr(marker)[1:-1] for marker in MOJIBAKE_MARKERS if marker in line]
        if not markers:
            continue
        joined_markers = ", ".join(markers)
        violations.append(f"{path.relative_to(ROOT)}:{lineno} contains {joined_markers}")
    return violations


def main() -> int:
    violations: list[str] = []
    for path in iter_target_paths():
        violations.extend(find_violations(path))

    if violations:
        print("FAIL: mojibake markers detected in canonical docs")
        for violation in violations:
            print(f"  - {violation}")
        return 1

    print("PASS: no mojibake markers detected in canonical docs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
