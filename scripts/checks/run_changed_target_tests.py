"""Run mapped tests for changed targets with a safe non-git fallback."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

ROOT = Path(__file__).resolve().parents[2]
MAP_PATH = ROOT / "scripts" / "checks" / "changed_target_test_map.json"
PYTHON_TEST_ROOT_PREFIX = "tests/sidecar/"
NODE_TEST_ROOT_PREFIX = "tests/"
FALLBACK_ALL_MAPPED = "all-mapped"
FALLBACK_SKIP = "skip"
# origin/main first: merge-base against local main is HEAD when running on
# main itself, which yields an empty changed set and a vacuous pass.
DEFAULT_MERGE_BASE_REFS = ("origin/main", "main")
DEFAULT_MERGE_BASE_REF_ENV = "JENNYGC3_CHANGED_TARGET_DEFAULT_BASE_REF"


@dataclass(frozen=True)
class MappingRule:
    target_prefixes: tuple[str, ...]
    required_tests: tuple[str, ...]


@dataclass(frozen=True)
class SelectionResult:
    source: str
    changed_files: tuple[str, ...]
    matched_prefixes: tuple[str, ...]
    selected_tests: tuple[str, ...]
    fallback_reason: str | None


def _normalize_repo_path(raw_path: str) -> str:
    token = str(raw_path or "").strip()
    if not token:
        return ""

    path = Path(token)
    if path.is_absolute():
        try:
            token = path.resolve().relative_to(ROOT).as_posix()
        except (OSError, ValueError):
            token = path.as_posix()
    else:
        token = token.replace("\\", "/")

    while token.startswith("./"):
        token = token[2:]
    return token


def _normalize_selector(raw_selector: str) -> str:
    return _normalize_repo_path(raw_selector)


def _selector_matches_path(*, selector: str, path: str) -> bool:
    return path.startswith(selector) if selector.endswith(("/", "-")) else path == selector


def _is_valid_test_path(test_path: str) -> bool:
    normalized = _normalize_repo_path(test_path)
    return (
        normalized.startswith(PYTHON_TEST_ROOT_PREFIX)
        and normalized.endswith(".py")
    ) or (
        normalized.startswith(NODE_TEST_ROOT_PREFIX)
        and normalized.endswith(".test.js")
    )


def _is_python_test_path(test_path: str) -> bool:
    normalized = _normalize_repo_path(test_path)
    return normalized.startswith(PYTHON_TEST_ROOT_PREFIX) and normalized.endswith(".py")


def _is_node_test_path(test_path: str) -> bool:
    normalized = _normalize_repo_path(test_path)
    return normalized.startswith(NODE_TEST_ROOT_PREFIX) and normalized.endswith(".test.js")


def _dedupe_preserve_order(values: Sequence[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for value in values:
        token = str(value or "").strip()
        if not token or token in seen:
            continue
        deduped.append(token)
        seen.add(token)
    return deduped


def _run_git_command(arguments: Sequence[str]) -> tuple[int, str, str]:
    try:
        completed = subprocess.run(
            ["git", *arguments],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except OSError as error:
        return 1, "", str(error)
    return completed.returncode, completed.stdout, completed.stderr


def _load_mapping_rules() -> tuple[list[MappingRule], list[str]]:
    if not MAP_PATH.exists():
        return [], [f"missing mapping file: {_normalize_repo_path(str(MAP_PATH))}"]

    try:
        payload = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return [], [f"invalid mapping JSON: {error}"]
    except OSError as error:
        return [], [f"failed to read mapping file: {error}"]

    if not isinstance(payload, dict):
        return [], ["mapping file root must be a JSON object"]

    rules_value = payload.get("rules")
    if not isinstance(rules_value, list) or not rules_value:
        return [], ["mapping file must declare at least one rule"]

    violations: list[str] = []
    rules: list[MappingRule] = []
    for index, rule in enumerate(rules_value, start=1):
        if not isinstance(rule, dict):
            violations.append(f"rule {index} must be an object")
            continue

        raw_prefixes = rule.get("target_prefixes")
        raw_tests = rule.get("required_tests")
        selectors = []
        tests = []

        if isinstance(raw_prefixes, list):
            for item in raw_prefixes:
                if isinstance(item, str):
                    selector = _normalize_selector(item)
                    if selector:
                        selectors.append(selector)

        if isinstance(raw_tests, list):
            for item in raw_tests:
                if isinstance(item, str):
                    test_path = _normalize_repo_path(item)
                    if test_path:
                        tests.append(test_path)

        if not selectors:
            violations.append(f"rule {index} must include at least one target_prefixes entry")
            continue
        if not tests:
            violations.append(f"rule {index} must include at least one required_tests entry")
            continue

        for test_path in tests:
            if not _is_valid_test_path(test_path):
                violations.append(
                    "rule "
                    f"{index} test path must be a pytest under tests/sidecar/ "
                    f"or node test under tests/: {test_path}"
                )
                continue
            candidate = ROOT / test_path
            if not candidate.exists() or not candidate.is_file():
                violations.append(f"rule {index} references missing test path: {test_path}")

        rules.append(
            MappingRule(
                target_prefixes=tuple(_dedupe_preserve_order(selectors)),
                required_tests=tuple(_dedupe_preserve_order(tests)),
            )
        )

    if violations:
        return [], violations

    return rules, []


def _parse_diff_paths(stdout_text: str) -> list[str]:
    changed: list[str] = []
    for line in stdout_text.splitlines():
        normalized = _normalize_repo_path(line)
        if normalized:
            changed.append(normalized)
    return _dedupe_preserve_order(changed)


def _parse_porcelain_status(stdout_text: str) -> list[str]:
    changed: list[str] = []
    for raw_line in stdout_text.splitlines():
        line = raw_line.rstrip("\n")
        if len(line) < 4:
            continue
        path_text = line[3:].strip()
        if not path_text:
            continue
        if " -> " in path_text:
            path_text = path_text.split(" -> ", maxsplit=1)[1]
        normalized = _normalize_repo_path(path_text)
        if normalized:
            changed.append(normalized)
    return _dedupe_preserve_order(changed)


def _collect_git_changed_files(*, base_ref: str | None, head_ref: str | None) -> tuple[list[str], str | None]:
    if not (ROOT / ".git").exists():
        return [], f"no .git metadata under {_normalize_repo_path(str(ROOT))}"

    return_code, stdout, stderr = _run_git_command(["rev-parse", "--is-inside-work-tree"])
    if return_code != 0 or stdout.strip().lower() != "true":
        detail = stderr.strip() or stdout.strip() or "not a git work tree"
        return [], f"git repository check failed: {detail}"

    if base_ref or head_ref:
        base = str(base_ref or "HEAD~1").strip()
        head = str(head_ref or "HEAD").strip()
        if not base:
            base = "HEAD~1"
        if not head:
            head = "HEAD"
        return_code, stdout, stderr = _run_git_command(
            ["diff", "--name-only", "--diff-filter=ACDMR", f"{base}...{head}"]
        )
        if return_code != 0:
            detail = stderr.strip() or stdout.strip() or "git diff failed"
            return [], f"git diff failed for range {base}...{head}: {detail}"
        return _parse_diff_paths(stdout), None

    configured_ref = os.environ.get(DEFAULT_MERGE_BASE_REF_ENV, "").strip()
    merge_base_refs = (configured_ref,) if configured_ref else DEFAULT_MERGE_BASE_REFS
    merge_base_changed_files: list[str] = []
    merge_base_errors: list[str] = []
    for merge_base_ref in merge_base_refs:
        merge_base_code, merge_base_stdout, merge_base_stderr = _run_git_command(
            ["merge-base", merge_base_ref, "HEAD"]
        )
        if merge_base_code == 0 and merge_base_stdout.strip():
            merge_base_commit = merge_base_stdout.strip()
            diff_code, diff_stdout, diff_stderr = _run_git_command(
                ["diff", "--name-only", "--diff-filter=ACDMR", f"{merge_base_commit}...HEAD"]
            )
            if diff_code == 0:
                merge_base_changed_files = _parse_diff_paths(diff_stdout)
                merge_base_errors = []
                break
            detail = diff_stderr.strip() or diff_stdout.strip() or "git diff failed"
            merge_base_errors.append(
                f"git diff from merge-base {merge_base_commit}...HEAD failed: {detail}"
            )
            continue
        detail = merge_base_stderr.strip() or merge_base_stdout.strip() or "git merge-base failed"
        merge_base_errors.append(
            f"git merge-base failed for {merge_base_ref} and HEAD: {detail}"
        )
    merge_base_error = "; ".join(merge_base_errors) or None

    return_code, stdout, stderr = _run_git_command(
        ["status", "--porcelain", "--untracked-files=normal"]
    )
    if return_code != 0:
        if merge_base_changed_files:
            return merge_base_changed_files, None
        detail = stderr.strip() or stdout.strip() or "git status failed"
        if merge_base_error:
            return [], f"{merge_base_error}; git status failed: {detail}"
        return [], f"git status failed: {detail}"

    status_changed_files = _parse_porcelain_status(stdout)
    if merge_base_changed_files:
        return _dedupe_preserve_order([*merge_base_changed_files, *status_changed_files]), None
    if merge_base_error:
        return status_changed_files, merge_base_error
    return status_changed_files, None


def _collect_changed_files(
    *,
    explicit_changed_files: Sequence[str],
    base_ref: str | None,
    head_ref: str | None,
) -> tuple[str, list[str], str | None]:
    normalized_explicit = _dedupe_preserve_order(
        [_normalize_repo_path(path) for path in explicit_changed_files]
    )
    normalized_explicit = [path for path in normalized_explicit if path]
    if normalized_explicit:
        return "explicit", normalized_explicit, None

    changed_files, fallback_reason = _collect_git_changed_files(base_ref=base_ref, head_ref=head_ref)
    if fallback_reason is not None:
        return "fallback", changed_files, fallback_reason
    return "git", changed_files, None


def _all_mapped_tests(rules: Sequence[MappingRule]) -> list[str]:
    mapped: list[str] = []
    for rule in rules:
        mapped.extend(rule.required_tests)
    return _dedupe_preserve_order(mapped)


def _select_mapped_tests(
    *,
    changed_files: Sequence[str],
    rules: Sequence[MappingRule],
) -> tuple[list[str], list[str]]:
    selected_tests: list[str] = []
    matched_prefixes: list[str] = []
    for changed_file in changed_files:
        normalized_changed = _normalize_repo_path(changed_file)
        if _is_valid_test_path(normalized_changed) and (ROOT / normalized_changed).is_file():
            selected_tests.append(normalized_changed)
        for rule in rules:
            matched = False
            for selector in rule.target_prefixes:
                if _selector_matches_path(selector=selector, path=normalized_changed):
                    matched = True
                    matched_prefixes.append(selector)
            if matched:
                selected_tests.extend(rule.required_tests)
    return _dedupe_preserve_order(selected_tests), _dedupe_preserve_order(matched_prefixes)


def resolve_selection(
    *,
    rules: Sequence[MappingRule],
    explicit_changed_files: Sequence[str],
    base_ref: str | None,
    head_ref: str | None,
    fallback_mode: str,
) -> SelectionResult:
    source, changed_files, fallback_reason = _collect_changed_files(
        explicit_changed_files=explicit_changed_files,
        base_ref=base_ref,
        head_ref=head_ref,
    )

    if fallback_reason is not None:
        if fallback_mode == FALLBACK_SKIP:
            return SelectionResult(
                source=source,
                changed_files=tuple(changed_files),
                matched_prefixes=tuple(),
                selected_tests=tuple(),
                fallback_reason=fallback_reason,
            )
        return SelectionResult(
            source=source,
            changed_files=tuple(changed_files),
            matched_prefixes=tuple(),
            selected_tests=tuple(_all_mapped_tests(rules)),
            fallback_reason=fallback_reason,
        )

    selected_tests, matched_prefixes = _select_mapped_tests(
        changed_files=changed_files,
        rules=rules,
    )
    return SelectionResult(
        source=source,
        changed_files=tuple(changed_files),
        matched_prefixes=tuple(matched_prefixes),
        selected_tests=tuple(selected_tests),
        fallback_reason=None,
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run changed-target mapped tests from mapping contract. "
            "Without explicit refs, git-backed repos use merge-base diff plus working-tree status."
        ),
    )
    parser.add_argument(
        "--changed-file",
        dest="changed_files",
        action="append",
        default=[],
        help="Explicit changed file path (repeatable). When provided, git is not required.",
    )
    parser.add_argument(
        "--base-ref",
        dest="base_ref",
        default=None,
        help="Optional git base ref used for explicit git diff range mode.",
    )
    parser.add_argument(
        "--head-ref",
        dest="head_ref",
        default=None,
        help="Optional git head ref used for explicit git diff range mode.",
    )
    parser.add_argument(
        "--fallback-mode",
        choices=(FALLBACK_ALL_MAPPED, FALLBACK_SKIP),
        default=FALLBACK_ALL_MAPPED,
        help="Behavior when changed files cannot be resolved from git.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Resolve and print selected tests without running pytest.",
    )
    return parser


def _print_selection(selection: SelectionResult) -> None:
    print(
        "INFO: changed-target selection "
        f"source={selection.source} "
        f"changed_files={len(selection.changed_files)} "
        f"matched_prefixes={len(selection.matched_prefixes)} "
        f"selected_tests={len(selection.selected_tests)}"
    )
    if selection.fallback_reason:
        print(f"INFO: changed-target fallback reason: {selection.fallback_reason}")
    if selection.selected_tests:
        print("INFO: changed-target selected tests:")
        for test_path in selection.selected_tests:
            print(f"  - {test_path}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    arguments = parser.parse_args(list(argv) if argv is not None else None)

    rules, load_errors = _load_mapping_rules()
    if load_errors:
        print("FAIL: changed-target mapped test selection")
        for error in load_errors:
            print(f"  - {error}")
        return 1

    selection = resolve_selection(
        rules=rules,
        explicit_changed_files=arguments.changed_files,
        base_ref=arguments.base_ref,
        head_ref=arguments.head_ref,
        fallback_mode=arguments.fallback_mode,
    )
    _print_selection(selection)

    if arguments.dry_run:
        print("PASS: changed-target mapped test selection dry-run complete")
        return 0

    if not selection.selected_tests:
        print("PASS: changed-target selection matched no mapped tests")
        return 0

    python_tests = [path for path in selection.selected_tests if _is_python_test_path(path)]
    node_tests = [path for path in selection.selected_tests if _is_node_test_path(path)]

    if python_tests:
        command = [sys.executable, "-m", "pytest", *python_tests, "-q"]
        result = subprocess.run(command, cwd=ROOT, check=False)
        if result.returncode != 0:
            print(f"FAIL: {' '.join(command)}")
            return result.returncode

    if node_tests:
        command = ["node", "scripts/run-node-tests-safe.js", *node_tests]
        result = subprocess.run(command, cwd=ROOT, check=False)
        if result.returncode != 0:
            print(f"FAIL: {' '.join(command)}")
            return result.returncode

    print("PASS: changed-target mapped tests")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
