import pytest

from scripts.checks import check_import_fanout as checker


@pytest.mark.parametrize("statement", ["from . import a, b, c, d, e, f, g", "from sidecar.ai.pkg import a, b, c, d, e, f, g"])
def test_package_imports_count_concrete_module_edges(tmp_path, monkeypatch, statement):
    monkeypatch.setattr(checker, "ROOT", tmp_path)
    package = tmp_path / "sidecar/ai/pkg"
    package.mkdir(parents=True)
    for name in "abcdefg":
        (package / (name + ".py")).write_text("", encoding="utf-8")
    path = package / "leaf.py"
    path.write_text(statement, encoding="utf-8")
    assert checker.count_internal_imports(path) == 7


def test_symbols_and_repeated_module_edges_are_not_extra_dependencies(tmp_path, monkeypatch):
    monkeypatch.setattr(checker, "ROOT", tmp_path)
    package = tmp_path / "sidecar/ai/pkg"
    package.mkdir(parents=True)
    (package / "module.py").write_text("class A: pass\nclass B: pass", encoding="utf-8")
    path = package / "leaf.py"
    path.write_text("from .module import A, B\nfrom sidecar.ai.pkg.module import A\n", encoding="utf-8")
    assert checker.count_internal_imports(path) == 1


def test_a_pinned_module_below_its_pin_fails_so_it_cannot_regrow(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(checker, "ROOT", tmp_path)
    package = tmp_path / "sidecar/ai/pkg"
    package.mkdir(parents=True)
    for name in "abcdefg":
        (package / (name + ".py")).write_text("", encoding="utf-8")
    leaf = package / "leaf.py"
    leaf.write_text("from . import a, b, c, d, e, f, g", encoding="utf-8")
    monkeypatch.setattr(checker, "TARGET", tmp_path / "sidecar/ai")
    monkeypatch.setattr(checker, "EXEMPT", set())
    monkeypatch.setattr(checker, "WIRING_CAPS", {})
    monkeypatch.setattr(checker, "CONCRETE_EDGE_BASELINE", {leaf.resolve(): 7})
    assert checker.main() == 0
    leaf.write_text("from . import a, b, c, d, e, f", encoding="utf-8")
    assert checker.main() == 1
    assert "below its CONCRETE_EDGE_BASELINE pin of 7" in capsys.readouterr().out
