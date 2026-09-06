"""Validate complexity/method limits are wired in pyproject.toml."""
from __future__ import annotations

import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PYPROJECT = ROOT / "pyproject.toml"


EXPECTED = {
    "tool.ruff.lint.mccabe.max-complexity": 12,
    "tool.ruff.lint.pylint.max-statements": 50,
    "tool.ruff.lint.pylint.max-public-methods": 15,
}


def get_nested(config: dict, dotted_key: str):
    current = config
    for key in dotted_key.split("."):
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def main() -> int:
    config = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    violations: list[str] = []

    for dotted_key, expected_value in EXPECTED.items():
        actual = get_nested(config, dotted_key)
        if actual != expected_value:
            violations.append(f"{dotted_key}: expected {expected_value}, got {actual!r}")

    if violations:
        print("FAIL: complexity contract is not fully configured")
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: complexity contract check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
