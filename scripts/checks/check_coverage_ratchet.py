"""Coverage ratchet -- defends measured coverage against the recorded baseline.

Reads scripts/checks/coverage_baseline.json plus the fresh coverage artifacts:
  - JS:      coverage/coverage-summary.json   (c8 json-summary)
  - sidecar: coverage.json                     (pytest-cov / coverage.py json)

Per tracked scope (js, sidecar):
  measured < baseline - epsilon   -> regression. FAIL if scope.ratchet_enforced,
                                      else WARN (measure-before-enforce soak).
  within +/- epsilon of baseline  -> PASS (soft WARN if slightly under).
  measured >= baseline + 1.0pp    -> PASS + advisory "bump the baseline" (manual).

PLUS, independent of ratchet_enforced, a HARD FAIL on any baselined per-file
entry that drops from >0 coverage to 0 while the file still has statements -- the
deleted-test smell (someone removed the test, not the source). A file that is
deleted/renamed on disk is NOT a smell; an existing file missing from the
fresh report fails denominator integrity.

Also compares a hash of the effective .c8rc.json `exclude` set against the
baseline's recorded hash: if it drifted, the JS denominator changed and the
baseline must be re-recorded -> FAIL.

Baseline RAISES are deliberately manual (a reviewed, human-committed bump); this
read-only gate never rewrites the baseline. Coverage artifacts are git-ignored
and only exist after a coverage run. Every selected scope requires a valid
artifact; use --scope to explicitly omit a scope this lane did not measure.
The ratchet runs in the coverage CI lanes
(after coverage:js:stable / test:sidecar:cov), not the fast policy step.

Feed it FULL-suite artifacts (npm run coverage:js / test:sidecar:cov). A partial
run will correctly trip the deleted-test smell, since baselined files legitimately
read 0 when their tests did not run.

Paths are overridable for testing:
  --baseline=PATH --js-summary=PATH --py-summary=PATH --c8rc=PATH

--scope=sidecar (or --scope=js) restricts the gate to one scope, so a lane that
only produced one artifact never reads a stale leftover of the other.
scripts/checks/run_ci.py runs --scope=sidecar after its pytest stage writes
coverage.json; no local stage produces the c8 summary (the JS scope stays in the
ci.yml coverage-gate job).
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BASELINE = ROOT / "scripts" / "checks" / "coverage_baseline.json"
DEFAULT_JS_SUMMARY = ROOT / "coverage" / "coverage-summary.json"
DEFAULT_PY_SUMMARY = ROOT / "coverage.json"
DEFAULT_C8RC = ROOT / ".c8rc.json"

ADVISORY_BUMP_PP = 1.0
MAX_PERCENT = 100


def _parse_overrides(argv: list[str]) -> dict[str, Path]:
    overrides: dict[str, Path] = {}
    keys = {
        "--baseline": "baseline",
        "--js-summary": "js_summary",
        "--py-summary": "py_summary",
        "--c8rc": "c8rc",
    }
    for arg in argv:
        for flag, name in keys.items():
            if arg.startswith(flag + "="):
                overrides[name] = Path(arg[len(flag) + 1:])
    return overrides


SCOPES = ("js", "sidecar")


def _parse_scopes(argv: list[str]) -> set[str] | None:
    """Selected scopes (default: all). None when a --scope value is unknown."""
    selected: set[str] = set()
    for arg in argv:
        if arg.startswith("--scope="):
            value = arg[len("--scope="):].strip()
            if value not in SCOPES:
                return None
            selected.add(value)
    return selected or set(SCOPES)


def _load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def c8_exclude_hash(c8rc_path: Path) -> str | None:
    """Stable hash of the effective .c8rc.json `exclude` set (order-insensitive).

    Shared with the baseline recorder so a drift in the JS denominator surfaces.
    """
    data = _load_json(c8rc_path)
    if not isinstance(data, dict):
        return None
    if not isinstance(data.get("exclude"), list) or not all(
        isinstance(item, str) for item in data["exclude"]
    ):
        return None
    excludes = sorted(data["exclude"])
    payload = json.dumps(excludes, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _norm(path_str: str) -> str:
    return str(path_str).replace("\\", "/")


def _js_measured(summary) -> float | None:
    if not isinstance(summary, dict):
        return None
    total = summary.get("total")
    lines = total.get("lines") if isinstance(total, dict) else None
    pct = lines.get("pct") if isinstance(lines, dict) else None
    if type(pct) not in (int, float) or not math.isfinite(pct) or not 0 <= pct <= MAX_PERCENT:
        return None
    return float(pct)


def _py_measured(summary) -> float | None:
    if not isinstance(summary, dict):
        return None
    totals = summary.get("totals")
    pct = totals.get("percent_covered") if isinstance(totals, dict) else None
    if type(pct) not in (int, float) or not math.isfinite(pct) or not 0 <= pct <= MAX_PERCENT:
        return None
    return float(pct)


def _classify(measured, baseline, epsilon, enforced) -> tuple[str, str]:
    if measured is None:
        return "fail", "missing or malformed coverage report (run the coverage suite first)"
    if (type(baseline) not in (int, float) or not math.isfinite(baseline)
            or not 0 <= baseline <= MAX_PERCENT):
        return "fail", "missing or invalid baseline overall_lines_pct"
    if (type(epsilon) not in (int, float) or not math.isfinite(epsilon) or epsilon < 0
            or type(enforced) is not bool):
        return "fail", "invalid baseline epsilon or ratchet_enforced"
    delta = measured - baseline
    if measured < baseline - epsilon:
        soak = "" if enforced else " [soak: ratchet not enforced for this scope yet]"
        return ("fail" if enforced else "warn"), (
            f"REGRESSION {measured:.2f}% < baseline {baseline:.2f}% "
            f"(delta {delta:+.2f}pp, epsilon {epsilon}){soak}"
        )
    if measured >= baseline + ADVISORY_BUMP_PP:
        return "advisory", (
            f"{measured:.2f}% is >= baseline+{ADVISORY_BUMP_PP}pp ({baseline:.2f}%); "
            f"consider a reviewed baseline bump (delta {delta:+.2f}pp)"
        )
    if measured < baseline:
        message = (
            f"within tolerance {measured:.2f}% vs baseline {baseline:.2f}% "
            f"(delta {delta:+.2f}pp, inside epsilon {epsilon})"
        )
    else:
        message = f"OK {measured:.2f}% >= baseline {baseline:.2f}% (delta {delta:+.2f}pp)"
    return "pass", message


# Per-tool fresh-coverage readers, normalized to a single shape so the smell
# check is codec-agnostic: {repo-relative POSIX path: (covered_lines, statements)}.

def _py_file_lookup(summary) -> dict[str, tuple[float, float]]:
    files = summary.get("files") if isinstance(summary, dict) else None
    if not isinstance(files, dict):
        raise ValueError("sidecar: coverage report files must be an object")
    out: dict[str, tuple[float, float]] = {}
    for key, value in files.items():
        stats = value.get("summary") if isinstance(value, dict) else None
        if not isinstance(stats, dict):
            raise ValueError(f"sidecar: malformed file coverage: {key}")
        covered, statements = stats.get("covered_lines"), stats.get("num_statements")
        if any(type(item) not in (int, float) or not math.isfinite(item) or item < 0
               for item in (covered, statements)) or covered > statements:
            raise ValueError(f"sidecar: invalid file coverage counts: {key}")
        out[_norm(key)] = (covered, statements)
    return out


def _js_file_lookup(summary) -> dict[str, tuple[float, float]]:
    out: dict[str, tuple[float, float]] = {}
    if not isinstance(summary, dict):
        return out
    for key, value in summary.items():
        if key == "total":
            continue
        lines = value.get("lines") if isinstance(value, dict) else None
        if not isinstance(lines, dict):
            raise ValueError(f"js: malformed file coverage: {key}")
        covered, statements = lines.get("covered"), lines.get("total")
        if any(type(item) not in (int, float) or not math.isfinite(item) or item < 0
               for item in (covered, statements)) or covered > statements:
            raise ValueError(f"js: invalid file coverage counts: {key}")
        out[_norm(key)] = (covered, statements)
    return out


def _deleted_test_smells(
    baseline_per_file: dict, fresh_lookup: dict[str, tuple[float, float]]
) -> list[str]:
    """A baselined file with >0 coverage that now reports statements but 0 covered."""
    smells: list[str] = []
    if not isinstance(baseline_per_file, dict):
        raise ValueError("baseline per-file coverage must be an object")
    for raw_path, baseline_pct in baseline_per_file.items():
        if (type(baseline_pct) not in (int, float) or not math.isfinite(baseline_pct)
                or not 0 <= baseline_pct <= MAX_PERCENT):
            raise ValueError(f"invalid baseline per-file percentage: {raw_path}")
        target = _norm(raw_path)
        # Exact key first; fall back to a suffix match for absolute-path reports.
        fresh = fresh_lookup.get(target) or next(
            (stats for path, stats in fresh_lookup.items() if path.endswith("/" + target)), None
        )
        if fresh is None:
            if (ROOT / target).exists():
                smells.append(
                    f"{target}: existing baselined source missing from coverage; "
                    "re-record the baseline."
                )
            continue  # Only an actual source deletion/rename may leave the report.
        if baseline_pct <= 0:
            continue
        covered, statements = fresh
        if statements > 0 and covered == 0:
            smells.append(
                f"{target}: baseline {baseline_pct:.1f}% -> 0 covered "
                f"({int(statements)} statements). "
                f"Deleted-test smell: a test that exercised this file was removed or broke."
            )
    return smells


def _collect_smells(py_summary, py_base: dict, js_summary, js_base: dict) -> list[str]:
    smells: list[str] = []
    if py_summary is not None and isinstance(py_base, dict):
        smells += _deleted_test_smells(py_base.get("per_module"), _py_file_lookup(py_summary))
    if js_summary is not None and isinstance(js_base, dict):
        smells += _deleted_test_smells(js_base.get("per_file"), _js_file_lookup(js_summary))
    return smells


def _c8_drift(js_base: dict, c8rc_path: Path) -> tuple[list[str], list[str]]:
    """c8 exclude-set drift (JS denominator integrity) as (fail lines, note lines)."""
    recorded_hash = js_base.get("c8_exclude_hash")
    current_hash = c8_exclude_hash(c8rc_path)
    if recorded_hash and current_hash is None:
        return [f"js: cannot validate .c8rc.json exclude set: {c8rc_path}"], []
    if recorded_hash and current_hash and recorded_hash != current_hash:
        return [
            f"js: .c8rc.json exclude set drifted "
            f"(baseline {recorded_hash} != current {current_hash}); "
            f"the JS coverage denominator changed -- re-measure and re-record the baseline."
        ], []
    if not recorded_hash:
        return [], [
            "js: no c8_exclude_hash recorded in the baseline yet "
            "(record one to detect denominator drift)"
        ]
    return [], []


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    scopes = _parse_scopes(args)
    if scopes is None:
        print(f"FAIL: --scope must be one of: {', '.join(SCOPES)}")
        return 2
    overrides = _parse_overrides(args)
    baseline_path = overrides.get("baseline", DEFAULT_BASELINE)
    js_summary_path = overrides.get("js_summary", DEFAULT_JS_SUMMARY)
    py_summary_path = overrides.get("py_summary", DEFAULT_PY_SUMMARY)
    c8rc_path = overrides.get("c8rc", DEFAULT_C8RC)

    baseline = _load_json(baseline_path)
    if not isinstance(baseline, dict):
        print(f"FAIL: cannot read coverage baseline {baseline_path}")
        return 1

    epsilon = baseline.get("epsilon", 0.5)
    js_base = baseline.get("js", {})
    py_base = baseline.get("sidecar", {})

    # An unselected scope reads no artifact at all, so a stale leftover from an
    # older run can neither pass nor fail this lane.
    js_selected = "js" in scopes
    js_summary = _load_json(js_summary_path) if js_selected else None
    py_summary = _load_json(py_summary_path) if "sidecar" in scopes else None

    fail_lines: list[str] = []
    warn_lines: list[str] = []
    pass_lines: list[str] = []
    note_lines: list[str] = []

    def record(scope: str, status: str, message: str) -> None:
        buckets = {
            "fail": fail_lines, "warn": warn_lines, "advisory": warn_lines, "pass": pass_lines
        }
        tagged = f"{scope}: {message}"
        buckets[status].append(f"ADVISORY {tagged}" if status == "advisory" else tagged)

    for scope, measured, scope_base in (
        ("js", _js_measured(js_summary), js_base), ("sidecar", _py_measured(py_summary), py_base)
    ):
        if scope not in scopes:
            note_lines.append(f"{scope}: scope not selected (--scope); artifact not read")
            continue
        if not isinstance(scope_base, dict):
            record(scope, "fail", "baseline scope must be an object")
            continue
        status, message = _classify(
            measured, scope_base.get("overall_lines_pct"), epsilon,
            scope_base.get("ratchet_enforced")
        )
        record(scope, status, message)

    # Deleted-test smell (always a hard fail, independent of ratchet_enforced).
    smells: list[str] = []
    try:
        smells = _collect_smells(py_summary, py_base, js_summary, js_base)
    except ValueError as error:
        fail_lines.append(str(error))
    if js_selected and isinstance(js_base, dict):
        drift_fails, drift_notes = _c8_drift(js_base, c8rc_path)
        fail_lines.extend(drift_fails)
        note_lines.extend(drift_notes)

    failed = bool(fail_lines) or bool(smells)

    sections = (
        ("FAIL: deleted-test smell or missing baselined source coverage", smells),
        ("FAIL: coverage ratchet requirements", fail_lines),
        ("WARN: coverage ratchet advisories", warn_lines),
    )
    output = [
        *(title + "\n" + "\n".join(f"  - {line}" for line in lines)
          for title, lines in sections if lines),
        *(f"PASS: {line}" for line in pass_lines),
        *(f"NOTE: {line}" for line in note_lines),
    ]
    print("\n".join(output))

    if failed:
        return 1
    print("PASS: coverage ratchet (no enforced regression, no deleted-test smell)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
