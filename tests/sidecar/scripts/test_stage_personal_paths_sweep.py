from pathlib import Path

from scripts.release.stage_personal_paths_sweep import main, sweep_files


def test_sweep_missing_root_fails(tmp_path, capsys):
    assert main(["--stage", str(tmp_path / "missing")]) == 1
    assert "FAIL" in capsys.readouterr().out


def test_sweep_unreadable_file_fails(tmp_path, monkeypatch):
    def denied(_path):
        raise PermissionError("denied")
    monkeypatch.setattr(Path, "read_bytes", denied)
    hits, _ = sweep_files(tmp_path, ["selected.txt"])
    assert any("read failed" in hit for hit in hits)


def test_sweep_empty_stage_fails(tmp_path):
    assert main(["--stage", str(tmp_path)]) == 1
