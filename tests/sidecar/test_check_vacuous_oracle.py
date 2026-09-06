from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType


def _load_module() -> ModuleType:
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "checks" / "check_vacuous_oracle.py"
    spec = importlib.util.spec_from_file_location("check_vacuous_oracle_for_tests", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive load guard
        raise RuntimeError("failed to load check_vacuous_oracle.py module spec")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _run(module, monkeypatch, capsys, repo_root: Path, files: dict[str, str], allowlist=None):
    for rel, body in files.items():
        path = repo_root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "TESTS_DIR", repo_root / "tests")
    monkeypatch.setattr(module, "VACUOUS_ORACLE_ALLOWLIST", allowlist or {})
    exit_code = module.main()
    return exit_code, capsys.readouterr().out.replace("\\", "/")


def _entry(module, count: int, expires_on: str = "2099-01-01"):
    return module.VacuousOracleException(
        label=f"test-{count}-{expires_on}",
        reason="unit test",
        expires_on=expires_on,
        count=count,
    )


# --- detector: weak patterns are flagged ------------------------------------

def test_flags_does_not_throw_only_block(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(module, monkeypatch, capsys, repo, {
        "tests/sample.test.js": "test('a', () => { assert.doesNotThrow(() => fn()); });\n",
    })
    assert code == 1
    assert "FAIL: test blocks whose only assertions are vacuous" in out
    assert "tests/sample.test.js: 1 weak-only test block" in out


def test_flags_bare_truthy_only_block(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(module, monkeypatch, capsys, repo, {
        "tests/sample.test.js": "test('a', () => { assert.ok(result); });\n",
    })
    assert code == 1
    assert "tests/sample.test.js: 1 weak-only test block" in out


def test_flags_bare_assert_call(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(module, monkeypatch, capsys, repo, {
        "tests/sample.test.js": "test('a', () => { assert(value); });\n",
    })
    assert code == 1
    assert "tests/sample.test.js" in out


# --- detector: strong patterns are cleared ----------------------------------

def test_clears_predicate_ok(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(module, monkeypatch, capsys, repo, {
        "tests/sample.test.js": "test('a', () => { assert.ok(html.includes('<b>')); });\n",
    })
    assert code == 0
    assert "PASS: no new vacuous-oracle test blocks" in out


def test_clears_comparison_ok(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, _ = _run(module, monkeypatch, capsys, repo, {
        "tests/sample.test.js": "test('a', () => { assert.ok(arr.length > 0); });\n",
    })
    assert code == 0


def test_clears_strong_assertion(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, _ = _run(module, monkeypatch, capsys, repo, {
        "tests/sample.test.js": "test('a', () => { assert.deepEqual(got, expected); });\n",
    })
    assert code == 0


def test_clears_mixed_weak_and_strong(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, _ = _run(module, monkeypatch, capsys, repo, {
        "tests/sample.test.js":
            "test('a', () => { assert.doesNotThrow(() => fn()); assert.equal(fn(), 1); });\n",
    })
    assert code == 0


# --- skeleton: comments and strings do not create or rescue findings --------

def test_ignores_assertions_in_comments_and_strings(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    # The only REAL assertion is a weak ok(); the strong-looking deepEqual lives
    # in a comment and the equal() in a string literal. A naive regex scan would
    # see them and clear the block; a skeleton-aware scan must still FAIL.
    body = (
        "test('a', () => {\n"
        "  // assert.deepEqual(real, strong)\n"
        "  const note = 'assert.equal(a, b)';\n"
        "  assert.ok(value);\n"
        "});\n"
    )
    code, out = _run(module, monkeypatch, capsys, repo, {"tests/sample.test.js": body})
    assert code == 1
    assert "tests/sample.test.js: 1 weak-only test block" in out


def test_block_with_no_real_assertions_is_not_flagged(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    # A commented-out assertion is the only assert text -> 0 real assertions.
    code, out = _run(module, monkeypatch, capsys, repo, {
        "tests/sample.test.js": "test('a', () => {\n  // assert.doesNotThrow(() => fn());\n});\n",
    })
    assert code == 0
    assert "PASS" in out


# --- allowlist lifecycle -----------------------------------------------------

def test_allowlisted_weak_block_passes_as_warning(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/sample.test.js": "test('a', () => { assert.doesNotThrow(() => fn()); });\n"},
        allowlist={"tests/sample.test.js": _entry(module, 1)},
    )
    assert code == 0
    assert "WARN: temporary vacuous-oracle exceptions" in out


def test_over_allowed_count_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    body = (
        "test('a', () => { assert.ok(a); });\n"
        "test('b', () => { assert.ok(b); });\n"
    )
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/sample.test.js": body},
        allowlist={"tests/sample.test.js": _entry(module, 1)},
    )
    assert code == 1
    assert "2 weak-only test block(s) (allowed 1) -- 1 over the limit" in out


def test_stale_count_too_high_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/sample.test.js": "test('a', () => { assert.ok(a); });\n"},
        allowlist={"tests/sample.test.js": _entry(module, 2)},
    )
    assert code == 1
    assert "lower the count to 1" in out


def test_stale_entry_for_clean_file_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/sample.test.js": "test('a', () => { assert.deepEqual(a, b); });\n"},
        allowlist={"tests/sample.test.js": _entry(module, 1)},
    )
    assert code == 1
    assert "remove vacuous-oracle exception" in out


def test_expired_entry_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_module()
    repo = tmp_path / "repo"
    code, out = _run(
        module, monkeypatch, capsys, repo,
        {"tests/sample.test.js": "test('a', () => { assert.doesNotThrow(() => fn()); });\n"},
        allowlist={"tests/sample.test.js": _entry(module, 1, expires_on="2000-01-01")},
    )
    assert code == 1
    assert "expired on 2000-01-01" in out


def test_real_allowlist_is_clean_against_the_live_tree() -> None:
    """The committed allowlist must be exactly green against the real tests/
    tree on seed day: no live violation, no stale/over-allocated entry."""
    module = _load_module()
    counts = module.scan_counts()
    violations, stale, _ = module.find_violations(counts)
    assert violations == []
    assert stale == []
