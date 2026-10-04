from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("selector", ["services/a.js", "services/nested/"])
def test_chk09_partial_mapping_cannot_cover_directory(selector, tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location(
        "map_test", ROOT / "scripts/checks/check_changed_target_test_map.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    for name in ["services/a.js", "services/b.js", "services/nested/c.js", "tests/a.test.js"]:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")
    mapping = {
        "required_target_prefixes": ["services/", "renderer-"],
        "rules": [{"target_prefixes": [selector, "renderer-"], "required_tests": ["tests/a.test.js"]}],
    }
    violations = module._validate_mapping(mapping)
    assert any("services/b.js" in violation for violation in violations)
    mapping["rules"][0]["target_prefixes"] = ["services/a.js", "services/b.js", "services/nested/", "renderer-"]
    assert module._validate_mapping(mapping) == []
