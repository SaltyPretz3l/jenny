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


def test_default_run_sweeps_source_trees(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(checker, "ROOT", tmp_path)
    (tmp_path / "sidecar" / "node_modules").mkdir(parents=True)
    (tmp_path / "sidecar" / "broken.py").write_text(
        "# footer \u00e2\u20ac\u201d partial\n", encoding="utf-8"
    )
    (tmp_path / "sidecar" / "node_modules" / "skipped.js").write_text(
        "// \u00e2\u20ac\u201d vendored\n", encoding="utf-8"
    )
    (tmp_path / "sidecar" / "clean.py").write_text("# \u2014 fine\n", encoding="utf-8")

    exit_code = checker.main([])
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "sidecar/broken.py:1 contains" in output
    assert "skipped.js" not in output
    assert "clean.py" not in output
