"""Keep selected repository complexity metrics from increasing silently."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[2]
BASELINES_RELATIVE_PATH = Path("scripts/checks/complexity_ratchet_baselines.json")
METRIC_NAMES = (
    "index_html_lines",
    "index_html_scripts",
    "raw_primitive_allowlist_budget",
    "production_files_over_600",
    "test_files_over_600",
)
SCRIPT_SRC_RE = re.compile(
    r"<script\b[^>]*\bsrc\s*=\s*(['\"])(.*?)\1",
    flags=re.IGNORECASE | re.DOTALL,
)
HTTP_URL_RE = re.compile(r"https?://", flags=re.IGNORECASE)
RATCHET_RULE = (
    "reductions may lower the baseline in the same commit; raising a baseline "
    "requires an explicit justification in the note field and review"
)


def _load_sibling(script_name: str) -> ModuleType:
    script_path = Path(__file__).resolve().with_name(script_name)
    module_name = f"_complexity_ratchet_{script_path.stem}"
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load policy module: {script_name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _count_lines(path: Path) -> int:
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for _ in handle)


def _count_local_scripts(index_html: str) -> int:
    return sum(
        1
        for match in SCRIPT_SRC_RE.finditer(index_html)
        if not HTTP_URL_RE.match(match.group(2).strip())
    )


def _raw_primitive_allowlist_budget() -> int:
    raw_check = _load_sibling("check_no_raw_html_primitives.py")
    allowlist = raw_check.LEGACY_RAW_PRIMITIVE_ALLOWLIST
    if not isinstance(allowlist, Mapping):
        raise ValueError("LEGACY_RAW_PRIMITIVE_ALLOWLIST must be a mapping")

    total = 0
    for relative_path, allowances in allowlist.items():
        if not isinstance(allowances, Mapping):
            raise ValueError(f"allowlist entry for {relative_path} must be a mapping")
        for kind, allowance in allowances.items():
            if isinstance(allowance, bool) or not isinstance(allowance, int) or allowance < 0:
                raise ValueError(
                    f"allowlist entry for {relative_path}:{kind} must be a non-negative integer"
                )
            total += allowance
    return total


def _files_over_600() -> tuple[int, int]:
    size_check = _load_sibling("check_file_size.py")
    size_check.ROOT = ROOT
    production_count = 0
    test_count = 0

    for directory, dir_names, file_names in os.walk(ROOT):
        directory_path = Path(directory)
        dir_names[:] = [
            name
            for name in dir_names
            if not size_check.should_skip(directory_path / name)
        ]
        for file_name in file_names:
            path = directory_path / file_name
            if path.suffix not in size_check.CODE_SUFFIXES:
                continue
            if size_check.should_skip(path):
                continue
            if _count_lines(path) <= 600:
                continue

            relative_path = path.relative_to(ROOT)
            if relative_path.parts[0] == "tests":
                test_count += 1
            else:
                production_count += 1

    return production_count, test_count


def measure_metrics() -> dict[str, int]:
    index_path = ROOT / "index.html"
    index_html = index_path.read_text(encoding="utf-8")
    production_count, test_count = _files_over_600()
    return {
        "index_html_lines": _count_lines(index_path),
        "index_html_scripts": _count_local_scripts(index_html),
        "raw_primitive_allowlist_budget": _raw_primitive_allowlist_budget(),
        "production_files_over_600": production_count,
        "test_files_over_600": test_count,
    }


def load_baselines(path: Path) -> tuple[dict[str, int], list[str]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}, [f"missing baselines file: {path}"]
    except (OSError, json.JSONDecodeError) as error:
        return {}, [f"malformed baselines file {path}: {error}"]

    if not isinstance(payload, dict):
        return {}, [f"malformed baselines file {path}: top level must be an object"]

    errors: list[str] = []
    baselines: dict[str, int] = {}
    unexpected = sorted(set(payload) - set(METRIC_NAMES))
    if unexpected:
        errors.append(f"unexpected metric key(s): {', '.join(unexpected)}")

    for metric in METRIC_NAMES:
        if metric not in payload:
            errors.append(f"missing metric key: {metric}")
            continue
        entry = payload[metric]
        if not isinstance(entry, dict):
            errors.append(f"{metric}: entry must be an object")
            continue
        baseline = entry.get("baseline")
        note = entry.get("note")
        if isinstance(baseline, bool) or not isinstance(baseline, int) or baseline < 0:
            errors.append(f"{metric}: baseline must be a non-negative integer")
        else:
            baselines[metric] = baseline
        if not isinstance(note, str) or not note.strip() or "\n" in note or "\r" in note:
            errors.append(f"{metric}: note must be a non-empty single line")

    return baselines, errors


def main() -> int:
    baseline_path = ROOT / BASELINES_RELATIVE_PATH
    baselines, baseline_errors = load_baselines(baseline_path)
    if baseline_errors:
        print("FAIL: complexity ratchet baselines are missing or malformed")
        for error in baseline_errors:
            print(f"  - {error}")
        return 1

    try:
        current_metrics = measure_metrics()
    except (OSError, RuntimeError, ValueError) as error:
        print(f"FAIL: unable to measure complexity ratchets: {error}")
        return 1

    failures: list[str] = []
    for metric in METRIC_NAMES:
        current = current_metrics[metric]
        baseline = baselines[metric]
        if current > baseline:
            failures.append(
                f"{metric}: current {current}, baseline {baseline}; {RATCHET_RULE}"
            )
        elif current < baseline:
            print(
                f"INFO: {metric}: current {current} is below baseline {baseline}; "
                "lower the baseline in the same commit"
            )

    if failures:
        print("FAIL: complexity ratchet increased")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("PASS: complexity ratchets are at or below their baselines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
