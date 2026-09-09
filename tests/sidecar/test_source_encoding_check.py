"""Regression coverage for the pre-commit source encoding sweep."""
import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/checks/check_no_mojibake.py"
SPEC = importlib.util.spec_from_file_location("source_encoding_check", SCRIPT)
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


@pytest.mark.parametrize("marker", checker.SOURCE_MARKERS)
def test_source_sweep_rejects_corrupted_punctuation(tmp_path, monkeypatch, marker):
    monkeypatch.setattr(checker, "ROOT", tmp_path)
    path = tmp_path / "example.js"
    path.write_text(f"// broken {marker} punctuation", encoding="utf-8")
    assert checker.find_violations(path, source=True)


def test_source_sweep_accepts_unicode_and_escaped_fixtures(tmp_path, monkeypatch):
    monkeypatch.setattr(checker, "ROOT", tmp_path)
    path = tmp_path / "example.py"
    path.write_text("# \u2014 \u00c3 \u00e9\nfixture = '\\u00e2\\u20ac\\u201d'", encoding="utf-8")
    assert checker.find_violations(path, source=True) == []


def test_source_sweep_rejects_invalid_utf8(tmp_path, monkeypatch):
    monkeypatch.setattr(checker, "ROOT", tmp_path)
    path = tmp_path / "example.js"
    path.write_bytes(b"// broken \xff")
    assert checker.find_violations(path, source=True) == ["example.js: invalid UTF-8"]
