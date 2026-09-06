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
simply gone from the fresh report (source deleted/renamed) is NOT a smell.

Also compares a hash of the effective .c8rc.json `exclude` set against the
baseline's recorded hash: if it drifted, the JS denominator changed and the
baseline may be stale -> WARN.

Baseline RAISES are deliberately manual (a reviewed, human-committed bump); this
read-only gate never rewrites the baseline. Coverage artifacts are git-ignored
and only exist after a coverage run, so when an artifact is absent the scope is
skipped with a NOTE (never a failure). The ratchet runs in the coverage CI lanes
(after coverage:js:stable / test:sidecar:cov), not the fast policy step.

Feed it FULL-suite artifacts (npm run coverage:js / test:sidecar:cov). A partial
run will correctly trip the deleted-test smell, since baselined files legitimately
read 0 when their tests did not run.

Paths are overridable for testing:
  --baseline=PATH --js-summary=PATH --py-summary=PATH --c8rc=PATH
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BASELINE = ROOT / "scripts" / "checks" / "coverage_baseline.json"
DEFAULT_JS_SUMMARY = ROOT / "coverage" / "coverage-summary.json"
DEFAULT_PY_SUMMARY = ROOT / "coverage.json"
DEFAULT_C8RC = ROOT / ".c8rc.json"

ADVISORY_BUMP_PP = 1.0


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


def _load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def c8_exclude_hash(c8rc_path: Path) -> str | None:
    """Stable hash of the effective .c8rc.json `exclude` set (order-insensitive).

    Shared with the baseline recorder so a drift in the JS denominator surfaces.
    """
    data = _load_json(c8rc_path)
    if not isinstance(data, dict):
        return None
    excludes = sorted(str(item) for item in data.get("exclude", []))
    payload = json.dumps(excludes, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _norm(path_str: str) -> str:
    return str(path_str).replace("\\", "/")


def _js_measured(summary) -> float | None:
    if not isinstance(summary, dict):
        return None
    pct = summary.get("total", {}).get("lines", {}).get("pct")
    return float(pct) if isinstance(pct, (int, float)) else None


def _py_measured(summary) -> float | None:
    if not isinstance(summary, dict):
        return None
    pct = summary.get("totals", {}).get("percent_covered")
    return float(pct) if isinstance(pct, (int, float)) else None


def _classify(measured, baseline, epsilon, enforced) -> tuple[str, str]:
    if measured is None or baseline is None:
        return "skip", "no fresh coverage artifact (run the coverage suite first)"
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
        return "pass", (
            f"within tolerance {measured:.2f}% vs baseline {baseline:.2f}% "
            f"(delta {delta:+.2f}pp, inside epsilon {epsilon})"
        )
    return "pass", f"OK {measured:.2f}% >= baseline {baseline:.2f}% (delta {delta:+.2f}pp)"


# Per-tool fresh-coverage readers, normalized to a single shape so the smell
# check is codec-agnostic: {repo-relative POSIX path: (covered_lines, statements)}.

def _py_file_lookup(summary) -> dict[str, tuple[float, float]]:
    files = summary.get("files", {}) if isinstance(summary, dict) else {}
    out: dict[str, tuple[float, float]] = {}
    for key, value in files.items():
        stats = value.get("summary", {})
        out[_norm(key)] = (stats.get("covered_lines", 0), stats.get("num_statements", 0))
    return out


def _js_file_lookup(summary) -> dict[str, tuple[float, float]]:
    out: dict[str, tuple[float, float]] = {}
    if not isinstance(summary, dict):
        return out
    for key, value in summary.items():
        if key == "total" or not isinstance(value, dict):
            continue
        lines = value.get("lines", {})
        out[_norm(key)] = (lines.get("covered", 0), lines.get("total", 0))
    return out


def _deleted_test_smells(baseline_per_file: dict, fresh_lookup: dict[str, tuple[float, float]]) -> list[str]:
    """A baselined file with >0 coverage that now reports statements but 0 covered."""
    smells: list[str] = []
    for raw_path, baseline_pct in baseline_per_file.items():
        if not isinstance(baseline_pct, (int, float)) or baseline_pct <= 0:
            continue
        target = _norm(raw_path)
        # Exact key first; fall back to a suffix match for absolute-path reports.
        fresh = fresh_lookup.get(target) or next(
            (stats for path, stats in fresh_lookup.items() if path.endswith("/" + target)), None
        )
        if fresh is None:
            continue  # file gone from fresh report = source deletion/rename, not a smell
        covered, statements = fresh
        if statements > 0 and covered == 0:
            smells.append(
                f"{target}: baseline {baseline_pct:.1f}% -> 0 covered ({int(statements)} statements). "
                f"Deleted-test smell: a test that exercised this file was removed or broke."
            )
    return smells


def main(argv: list[str] | None = None) -> int:
    overrides = _parse_overrides(argv if argv is not None else sys.argv[1:])
    baseline_path = overrides.get("baseline", DEFAULT_BASELINE)
    js_summary_path = overrides.get("js_summary", DEFAULT_JS_SUMMARY)
    py_summary_path = overrides.get("py_summary", DEFAULT_PY_SUMMARY)
    c8rc_path = overrides.get("c8rc", DEFAULT_C8RC)

    baseline = _load_json(baseline_path)
    if not isinstance(baseline, dict):
        print(f"FAIL: cannot read coverage baseline {baseline_path}")
        return 1

    epsilon = float(baseline.get("epsilon", 0.5))
    js_base = baseline.get("js", {})
    py_base = baseline.get("sidecar", {})

    js_summary = _load_json(js_summary_path)
    py_summary = _load_json(py_summary_path)

    js_measured = _js_measured(js_summary)
    py_measured = _py_measured(py_summary)

    fail_lines: list[str] = []
    warn_lines: list[str] = []
    pass_lines: list[str] = []
    note_lines: list[str] = []

    def record(scope: str, status: str, message: str) -> None:
        tagged = f"{scope}: {message}"
        if status == "fail":
            fail_lines.append(tagged)
        elif status == "warn":
            warn_lines.append(tagged)
        elif status == "advisory":
            warn_lines.append(f"ADVISORY {tagged}")
        elif status == "skip":
            note_lines.append(tagged)
        else:
            pass_lines.append(tagged)

    js_status, js_msg = _classify(js_measured, js_base.get("overall_lines_pct"), epsilon, bool(js_base.get("ratchet_enforced")))
    record("js", js_status, js_msg)
    py_status, py_msg = _classify(py_measured, py_base.get("overall_lines_pct"), epsilon, bool(py_base.get("ratchet_enforced")))
    record("sidecar", py_status, py_msg)

    # Deleted-test smell (always a hard fail, independent of ratchet_enforced).
    smells: list[str] = []
    if py_summary is not None:
        smells += _deleted_test_smells(py_base.get("per_module", {}), _py_file_lookup(py_summary))
    if js_summary is not None and isinstance(js_base.get("per_file"), dict):
        smells += _deleted_test_smells(js_base.get("per_file", {}), _js_file_lookup(js_summary))

    # c8 exclude-set drift (JS denominator integrity).
    recorded_hash = js_base.get("c8_exclude_hash")
    current_hash = c8_exclude_hash(c8rc_path)
    if recorded_hash and current_hash and recorded_hash != current_hash:
        warn_lines.append(
            f"js: .c8rc.json exclude set drifted (baseline {recorded_hash} != current {current_hash}); "
            f"the JS coverage denominator changed -- re-measure and re-record the baseline."
        )
    elif not recorded_hash:
        note_lines.append("js: no c8_exclude_hash recorded in the baseline yet (record one to detect denominator drift)")

    failed = bool(fail_lines) or bool(smells)

    if smells:
        print("FAIL: deleted-test smell (file dropped from >0 coverage to 0)")
        for line in smells:
            print(f"  - {line}")
    if fail_lines:
        print("FAIL: coverage regression below the enforced baseline")
        for line in fail_lines:
            print(f"  - {line}")
    if warn_lines:
        print("WARN: coverage ratchet advisories")
        for line in warn_lines:
            print(f"  - {line}")
    for line in pass_lines:
        print(f"PASS: {line}")
    for line in note_lines:
        print(f"NOTE: {line}")

    if failed:
        return 1
    print("PASS: coverage ratchet (no enforced regression, no deleted-test smell)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
