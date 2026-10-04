from scripts.checks import check_doc_as_code as checker


def test_merge_base_failure_is_preserved_with_status_paths(tmp_path, monkeypatch):
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(checker, "ROOT", tmp_path)

    def git(args):
        if args[0] == "rev-parse":
            return 0, "true", ""
        if args[0] == "status":
            return 0, " M sidecar/protocol.py\n", ""
        return 1, "", "missing base"

    monkeypatch.setattr(checker, "_run_git_command", git)
    paths, error = checker._collect_git_changed_files(None, None)
    assert paths == ["sidecar/protocol.py"]
    assert error is not None and "missing base" in error
