from scripts.checks import check_sidecar_reachability as checker


def test_deleted_dynamic_target_fails_even_when_parent_survives(tmp_path, monkeypatch, capsys):
    path = tmp_path / "__init__.py"
    path.write_text("", encoding="utf-8")
    monkeypatch.setattr(checker, "discover_modules", lambda: {"sidecar.ai": path})
    monkeypatch.setattr(checker, "KNOWN_DYNAMIC_ENTRYPOINT_IMPORTS", {
        "sidecar.ai": {"sidecar.ai.deleted"},
    })
    assert checker.main() == 1
    assert "sidecar.ai.deleted" in capsys.readouterr().out


def test_existing_dynamic_target_is_an_exact_edge(tmp_path, monkeypatch):
    path = tmp_path / "entry.py"
    path.write_text("", encoding="utf-8")
    modules = {"sidecar.ai.entry": path, "sidecar.ai.target": path}
    monkeypatch.setattr(checker, "KNOWN_DYNAMIC_ENTRYPOINT_IMPORTS", {
        "sidecar.ai.entry": {"sidecar.ai.target"},
    })
    assert checker.read_edges(modules, set(modules))["sidecar.ai.entry"] == {"sidecar.ai.target"}
