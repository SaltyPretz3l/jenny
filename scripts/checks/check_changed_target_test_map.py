"""Fail if changed-target test mapping drifts for high-risk active paths."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
MAP_PATH = ROOT / "scripts" / "checks" / "changed_target_test_map.json"
PYTHON_TEST_ROOT_PREFIX = "tests/sidecar/"
NODE_TEST_ROOT_PREFIX = "tests/"


def _normalize_path(raw_path: str) -> str:
    normalized = str(raw_path or "").replace("\\", "/").strip()
    if normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def _normalize_prefix(raw_prefix: str) -> str:
    normalized = _normalize_path(raw_prefix)
    if not normalized:
        return ""
    if not normalized.endswith("/") and not normalized.endswith("-"):
        normalized = f"{normalized}/"
    return normalized


def _normalize_selector(raw_selector: str) -> str:
    return _normalize_path(raw_selector)


def _selector_is_prefix(selector: str) -> bool:
    return selector.endswith("/") or selector.endswith("-")


def _selector_matches_path(*, selector: str, path: str) -> bool:
    return path.startswith(selector) if _selector_is_prefix(selector) else path == selector


def _as_non_empty_path_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []

    normalized: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        path = _normalize_path(item)
        if path:
            normalized.append(path)
    return normalized


def _as_non_empty_prefix_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []

    normalized: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        prefix = _normalize_prefix(item)
        if prefix:
            normalized.append(prefix)
    return normalized


def _as_non_empty_selector_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []

    normalized: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        selector = _normalize_selector(item)
        if selector:
            normalized.append(selector)
    return normalized


def _load_mapping() -> tuple[dict[str, Any] | None, list[str]]:
    if not MAP_PATH.exists():
        try:
            display_path = _normalize_path(str(MAP_PATH.relative_to(ROOT)))
        except ValueError:
            display_path = _normalize_path(str(MAP_PATH))
        return None, [f"missing mapping file: {display_path}"]

    try:
        payload = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return None, [f"invalid JSON in mapping file: {error}"]
    except OSError as error:
        return None, [f"failed to read mapping file: {error}"]

    if not isinstance(payload, dict):
        return None, ["mapping file root must be a JSON object"]

    return payload, []


def _covers_required_prefix(*, required_prefix: str, rule_selectors: list[str]) -> bool:
    for selector in rule_selectors:
        if _selector_is_prefix(selector) and (
            required_prefix.startswith(selector) or selector.startswith(required_prefix)
        ):
            return True
        if not _selector_is_prefix(selector) and selector.startswith(required_prefix):
            return True
    return False


def _is_valid_mapped_test_path(test_path: str) -> bool:
    normalized = _normalize_path(test_path)
    return (
        normalized.startswith(PYTHON_TEST_ROOT_PREFIX)
        and normalized.endswith(".py")
    ) or (
        normalized.startswith(NODE_TEST_ROOT_PREFIX)
        and normalized.endswith(".test.js")
    )


def _validate_mapping(mapping: dict[str, Any]) -> list[str]:
    violations: list[str] = []
    required_prefixes = _as_non_empty_prefix_list(mapping.get("required_target_prefixes"))
    rules = mapping.get("rules")

    if not required_prefixes:
        violations.append("required_target_prefixes must contain at least one path prefix")
    if not isinstance(rules, list) or not rules:
        violations.append("rules must contain at least one mapping rule")
        return violations

    discovered_selectors: list[str] = []

    for index, rule in enumerate(rules, start=1):
        if not isinstance(rule, dict):
            violations.append(f"rule {index} must be an object")
            continue

        target_selectors = _as_non_empty_selector_list(rule.get("target_prefixes"))
        required_tests = _as_non_empty_path_list(rule.get("required_tests"))

        if not target_selectors:
            violations.append(f"rule {index} must declare at least one target_prefixes entry")
        if not required_tests:
            violations.append(f"rule {index} must declare at least one required_tests entry")

        discovered_selectors.extend(target_selectors)

        for test_path in required_tests:
            if not _is_valid_mapped_test_path(test_path):
                violations.append(
                    "rule "
                    f"{index} test path must be a pytest under tests/sidecar/ "
                    f"or node test under tests/: {test_path}"
                )
                continue
            candidate = ROOT / Path(test_path)
            if not candidate.exists() or not candidate.is_file():
                violations.append(f"rule {index} references missing test path: {test_path}")

    for required_prefix in required_prefixes:
        if not _covers_required_prefix(
            required_prefix=required_prefix,
            rule_selectors=discovered_selectors,
        ):
            violations.append(f"no rule covers required target prefix: {required_prefix}")

    return violations


def main() -> int:
    mapping, load_errors = _load_mapping()
    if mapping is None:
        print("FAIL: changed-target test mapping contract")
        for error in load_errors:
            print(f"  - {error}")
        return 1

    violations = _validate_mapping(mapping)
    if violations:
        print("FAIL: changed-target test mapping contract")
        for violation in violations:
            print(f"  - {violation}")
        return 1

    print("PASS: changed-target test mapping contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
