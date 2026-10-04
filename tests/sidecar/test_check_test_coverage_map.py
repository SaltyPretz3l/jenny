import pytest

from scripts.checks import check_test_coverage_map as checker


@pytest.mark.parametrize("assignment", [
    "policy = build()", "policy: object = build()", "policy = [build() for _ in range(2)]",
    "policy = imported.value", "policy: make_annotation() = build",
    "policy = missing", "__all__ = exports()",
])
def test_initialization_is_not_a_reexport_shim(tmp_path, assignment):
    path = tmp_path / "shim.py"
    path.write_text("from .factory import build, imported\n" + assignment + "\n", encoding="utf-8")
    assert not checker._is_py_shim(path)


@pytest.mark.parametrize("assignment", [
    "alias = build", "__all__ = ['build']", "alias: object = build",
])
def test_proven_reexports_remain_shims(tmp_path, assignment):
    path = tmp_path / "shim.py"
    path.write_text("from .factory import build\n" + assignment + "\n", encoding="utf-8")
    assert checker._is_py_shim(path)
