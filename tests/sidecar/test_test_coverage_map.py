"""The project/runtime owners cannot disappear from discoverable-test gating."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _checker():
    name = "session_runtime_coverage_checker"
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "scripts/checks/check_test_coverage_map.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("owner", ["projects", "session-runtime"])
def test_new_owner_requires_a_runnable_test(tmp_path, monkeypatch, owner):
    checker = _checker()
    monkeypatch.setattr(checker, "ROOT", tmp_path)
    source = tmp_path / "services" / owner / "store.js"
    source.parent.mkdir(parents=True)
    source.write_text("module.exports = function store() { return 1; };\n", encoding="utf-8")
    tests = tmp_path / "tests"
    tests.mkdir()
    # An uncalled helper is not evidence that the default runner reaches code.
    (tests / "helper.js").write_text(
        f"require('../services/{owner}/store');\n", encoding="utf-8"
    )
    gaps, _ = checker._js_gaps()
    assert gaps == [f"services/{owner}/store.js"]
    (tests / "store.test.js").write_text("require('./helper');\n", encoding="utf-8")
    gaps, stats = checker._js_gaps()
    assert gaps == []
    assert stats["reached"] == 1
