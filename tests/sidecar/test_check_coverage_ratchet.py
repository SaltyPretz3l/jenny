from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load_check():
    spec = importlib.util.spec_from_file_location(
        "ratchet_test", ROOT / "scripts/checks/check_coverage_ratchet.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixture(module, tmp_path, monkeypatch, scope):
    monkeypatch.setattr(module, "ROOT", tmp_path)
    baseline = {scope: {
        "overall_lines_pct": 80.0, "ratchet_enforced": False,
        "per_file" if scope == "js" else "per_module": {"subject.js" if scope == "js" else "subject.py": 80.0},
    }}
    report = ({"total": {"lines": {"pct": 80.0}},
               "subject.js": {"lines": {"covered": 8, "total": 10}}} if scope == "js" else {
                   "totals": {"percent_covered": 80.0},
                   "files": {"subject.py": {"summary": {"covered_lines": 8, "num_statements": 10}}},
               })
    baseline_path = tmp_path / "baseline.json"
    report_path = tmp_path / "report.json"
    baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
    report_path.write_text(json.dumps(report), encoding="utf-8")
    c8rc = tmp_path / "c8rc.json"
    c8rc.write_text('{"exclude": []}', encoding="utf-8")
    args = [f"--scope={scope}", f"--baseline={baseline_path}",
            f"--{'js' if scope == 'js' else 'py'}-summary={report_path}", f"--c8rc={c8rc}"]
    return args, baseline_path, report_path, baseline, report, c8rc


@pytest.mark.parametrize("scope", ["js", "sidecar"])
@pytest.mark.parametrize("invalid", ["missing", "json", "schema", "nested", "nan", "baseline", "enforcement", "counts", "baseline_files"])
def test_chk02_selected_invalid_artifact_fails(scope, invalid, tmp_path, monkeypatch, capsys):
    module = load_check()
    args, baseline_path, report_path, baseline, report, _ = fixture(module, tmp_path, monkeypatch, scope)
    if invalid == "missing":
        report_path.unlink()
    elif invalid == "json":
        report_path.write_text("{", encoding="utf-8")
    elif invalid in {"baseline", "enforcement", "baseline_files"}:
        field = {
            "baseline": "overall_lines_pct", "enforcement": "ratchet_enforced",
            "baseline_files": "per_file" if scope == "js" else "per_module",
        }[invalid]
        del baseline[scope][field]
        baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
    else:
        if invalid == "counts":
            if scope == "js":
                report["subject.js"]["lines"] = {}
            else:
                report["files"]["subject.py"]["summary"] = {}
        elif invalid == "schema":
            report = {}
        elif invalid == "nested":
            report["total" if scope == "js" else "totals"] = []
        elif scope == "js":
            report["total"]["lines"]["pct"] = float("nan")
        else:
            report["totals"]["percent_covered"] = float("nan")
        report_path.write_text(json.dumps(report), encoding="utf-8")
    assert module.main(args) == 1
    output = capsys.readouterr().out
    assert "FAIL:" in output
    assert "PASS: coverage ratchet" not in output


@pytest.mark.parametrize("scope", ["js", "sidecar"])
def test_chk08_existing_baselined_source_cannot_disappear(scope, tmp_path, monkeypatch, capsys):
    module = load_check()
    args, _, report_path, _, report, _ = fixture(module, tmp_path, monkeypatch, scope)
    source = tmp_path / ("subject.js" if scope == "js" else "subject.py")
    source.write_text("pass\n", encoding="utf-8")
    if scope == "js":
        del report["subject.js"]
    else:
        report["files"] = {}
    report_path.write_text(json.dumps(report), encoding="utf-8")
    assert module.main(args) == 1
    assert "missing from coverage" in capsys.readouterr().out
    source.unlink()
    assert module.main(args) == 0


def test_chk08_exclude_drift_requires_rebaseline(tmp_path, monkeypatch, capsys):
    module = load_check()
    args, baseline_path, _, baseline, _, c8rc = fixture(module, tmp_path, monkeypatch, "js")
    baseline["js"]["c8_exclude_hash"] = module.c8_exclude_hash(c8rc)
    baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
    assert module.main(args) == 0
    c8rc.write_text('{"exclude": ["subject.js"]}', encoding="utf-8")
    assert module.main(args) == 1
    assert "denominator changed" in capsys.readouterr().out


def test_unselected_malformed_baseline_cannot_suppress_selected_smells(tmp_path, monkeypatch):
    module = load_check()
    args, baseline_path, report_path, baseline, report, _ = fixture(
        module, tmp_path, monkeypatch, "sidecar"
    )
    baseline["js"] = None
    baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
    report["files"]["subject.py"]["summary"]["covered_lines"] = 0
    report_path.write_text(json.dumps(report), encoding="utf-8")
    assert module.main(args) == 1
