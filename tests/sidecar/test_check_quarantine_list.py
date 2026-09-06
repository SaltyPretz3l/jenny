from __future__ import annotations

import importlib.util
import json
import sys
from datetime import date
from pathlib import Path
from types import ModuleType


def _load_module() -> ModuleType:
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "checks" / "check_quarantine_list.py"
    spec = importlib.util.spec_from_file_location("check_quarantine_list_for_tests", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive load guard
        raise RuntimeError("failed to load check_quarantine_list.py module spec")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _run(module, monkeypatch, capsys, repo_root: Path, quarantine, *, test_files=()):
    (repo_root / "tests").mkdir(parents=True, exist_ok=True)
    for rel in test_files:
        target = repo_root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("// fixture\n", encoding="utf-8")
    if quarantine is not None:
        body = quarantine if isinstance(quarantine, str) else json.dumps(quarantine)
        (repo_root / "tests" / ".quarantine.json").write_text(body, encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)
    exit_code = module.main()
    return exit_code, capsys.readouterr().out.replace("\\", "/")


def _entry(expires_on: str = "2099-01-01", **overrides):
    entry = {"retries": 1, "reason": "flaky on windows-latest", "ticket": "JENNY-1", "expires_on": expires_on}
    entry.update(overrides)
    return entry


# --- clean states ------------------------------------------------------------

def test_missing_file_is_clean(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(module, monkeypatch, capsys, repo, None)
    assert code == 0
    assert "PASS: test quarantine list clean (0 quarantined file(s))" in out


def test_empty_object_is_clean(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(module, monkeypatch, capsys, repo, {})
    assert code == 0
    assert "PASS: test quarantine list clean" in out


def test_valid_entry_passes(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/flaky.test.js": _entry()},
        test_files=["tests/flaky.test.js"],
    )
    assert code == 0
    assert "1 quarantined file(s)" in out


# --- field validation --------------------------------------------------------

def test_missing_fields_fail(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/flaky.test.js": {"retries": 1}},
        test_files=["tests/flaky.test.js"],
    )
    assert code == 1
    assert "missing field(s): reason, ticket, expires_on" in out


def test_retries_below_one_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/flaky.test.js": _entry(retries=0)},
        test_files=["tests/flaky.test.js"],
    )
    assert code == 1
    assert "'retries' must be an integer >= 1" in out


def test_retries_boolean_is_rejected(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/flaky.test.js": _entry(retries=True)},
        test_files=["tests/flaky.test.js"],
    )
    assert code == 1
    assert "'retries' must be an integer >= 1" in out


def test_retries_over_cap_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/flaky.test.js": _entry(retries=99)},
        test_files=["tests/flaky.test.js"],
    )
    assert code == 1
    assert f"exceeds the cap of {module.MAX_RETRIES}" in out


def test_blank_reason_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/flaky.test.js": _entry(reason="   ")},
        test_files=["tests/flaky.test.js"],
    )
    assert code == 1
    assert "'reason' must be a non-empty string" in out


def test_expired_entry_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/flaky.test.js": _entry(expires_on="2000-01-01")},
        test_files=["tests/flaky.test.js"],
    )
    assert code == 1
    assert "quarantine expired on 2000-01-01" in out


def test_bad_date_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/flaky.test.js": _entry(expires_on="soon")},
        test_files=["tests/flaky.test.js"],
    )
    assert code == 1
    assert "is not an ISO date" in out


# --- structural / dangling validation ---------------------------------------

def test_dangling_path_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/gone.test.js": _entry()},  # no fixture file written
    )
    assert code == 1
    assert "targets a file that does not exist" in out


def test_parent_traversal_key_is_rejected_even_when_target_exists(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"../outside.test.js": _entry()},
        test_files=["../outside.test.js"],
    )
    assert code == 1
    assert "quarantine key must be a repository-relative tests/ path" in out


def test_non_test_key_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/notatest.js": _entry()},
        test_files=["tests/notatest.js"],
    )
    assert code == 1
    assert "quarantine key must be a *.test.js path" in out


def test_non_object_entry_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/flaky.test.js": "retry-me"},
        test_files=["tests/flaky.test.js"],
    )
    assert code == 1
    assert "quarantine entry must be a JSON object" in out


def test_malformed_json_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(module, monkeypatch, capsys, repo, "{ not json ")
    assert code == 1
    assert "is not valid JSON" in out


def test_array_payload_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(module, monkeypatch, capsys, repo, "[]")
    assert code == 1
    assert "must be a JSON object" in out


# --- live tree ---------------------------------------------------------------

def test_live_quarantine_file_is_clean() -> None:
    """The committed tests/.quarantine.json must validate against the real tree."""
    module = _load_module()
    entries, load_error = module.load_quarantine(module._quarantine_path())
    assert load_error is None
    violations = module.find_violations(entries, module.ROOT, date.today())
    assert violations == []
