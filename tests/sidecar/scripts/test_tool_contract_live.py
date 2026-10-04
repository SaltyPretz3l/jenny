import pytest

from scripts.eval.tool_contract_live import _write_generated_fixture, _write_workspace_fixture


@pytest.mark.parametrize("generated", [False, True])
@pytest.mark.parametrize("unsafe", ["../outside.txt", "absolute", "..\\outside.txt"])
def test_fixture_rejects_escape(tmp_path, generated, unsafe):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    if unsafe == "absolute":
        unsafe = str(tmp_path / "outside.txt")
    with pytest.raises(ValueError, match="fixture path"):
        if generated:
            _write_generated_fixture({"generated_fixture": {"path": unsafe, "line": "bad", "repeat": 1}}, workspace)
        else:
            _write_workspace_fixture({"workspace_fixture": {unsafe: "bad"}}, workspace)
    assert not (tmp_path / "outside.txt").exists()


@pytest.mark.parametrize("generated", [False, True])
def test_fixture_rejects_link_escape(tmp_path, generated):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        (workspace / "link").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("creating symlinks requires Windows permission")
    with pytest.raises(ValueError, match="fixture path"):
        if generated:
            _write_generated_fixture({"generated_fixture": {"path": "link/file", "line": "bad", "repeat": 1}}, workspace)
        else:
            _write_workspace_fixture({"workspace_fixture": {"link/file": "bad"}}, workspace)
    assert not (outside / "file").exists()


def test_fixture_writes_contained_paths(tmp_path):
    _write_workspace_fixture({"workspace_fixture": {"a/b.txt": "ok"}}, tmp_path)
    _write_generated_fixture({"generated_fixture": {"path": "a/c.txt", "line": "x", "repeat": 2}}, tmp_path)
    assert (tmp_path / "a/b.txt").read_text() == "ok"
    assert (tmp_path / "a/c.txt").read_text() == "xx"
