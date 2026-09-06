"""Fail if designated hotspot modules exceed their line-count caps."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOTSPOT_CAPS = {
    "sidecar/server.py": 400,
    # Ratchet only moves down: extract into services/main/ and lower this, never
    # raise it.
    "main.js": 729,
}


def main() -> int:
    violations: list[str] = []
    missing: list[str] = []

    for relative_path, cap in HOTSPOT_CAPS.items():
        full_path = ROOT / relative_path
        if not full_path.exists():
            missing.append(relative_path)
            continue

        line_count = sum(1 for _ in full_path.open("r", encoding="utf-8"))
        if line_count > cap:
            violations.append(f"{relative_path} ({line_count} lines, cap {cap})")

    if missing or violations:
        print("FAIL: hotspot size check")
        for relative_path in missing:
            print(f"  - {relative_path} is missing; update HOTSPOT_CAPS")
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: hotspot size check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
