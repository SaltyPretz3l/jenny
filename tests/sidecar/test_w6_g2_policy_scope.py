from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType


def _load_script_module(script_name: str) -> ModuleType:
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "checks" / script_name
    spec = importlib.util.spec_from_file_location(f"test_loader_{script_name}", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive guard
        raise RuntimeError(f"unable to load script module: {script_name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_check_no_utf8_bom_scans_services_javascript_and_root_entrypoints(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_utf8_bom.py")
    repo_root = tmp_path / "repo"
    service_file = repo_root / "services" / "backend" / "backend-service.js"
    root_file = repo_root / "main.js"
    service_file.parent.mkdir(parents=True, exist_ok=True)
    service_file.write_bytes(module.UTF8_BOM + b"module.exports = {};\n")
    root_file.write_bytes(module.UTF8_BOM + b"module.exports = {};\n")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "services/backend/backend-service.js" in output
    assert "main.js" in output


def test_check_no_utf8_bom_scans_styles_and_skips_vendored_upstream(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_utf8_bom.py")
    repo_root = tmp_path / "repo"
    style_file = repo_root / "styles" / "chat.css"
    vendored_file = (
        repo_root
        / "plugins"
        / "official"
        / "local-image-generation"
        / "runtime"
        / "upstream"
        / "models"
        / "utils.py"
    )
    style_file.parent.mkdir(parents=True, exist_ok=True)
    vendored_file.parent.mkdir(parents=True, exist_ok=True)
    style_file.write_bytes(module.UTF8_BOM + b".chat {}\n")
    vendored_file.write_bytes(module.UTF8_BOM + b"VALUE = 1\n")
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(
        module, "_git_visible_paths", lambda: [style_file, vendored_file]
    )

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "styles/chat.css" in output
    assert (
        "plugins/official/local-image-generation/runtime/upstream/models/utils.py"
        not in output
    )


def test_check_no_utf8_bom_only_scans_git_visible_files(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_utf8_bom.py")
    repo_root = tmp_path / "repo"
    listed_file = repo_root / "styles" / "listed.css"
    unlisted_file = repo_root / "styles" / "unlisted.css"
    listed_file.parent.mkdir(parents=True, exist_ok=True)
    listed_file.write_bytes(module.UTF8_BOM + b".listed {}\n")
    unlisted_file.write_bytes(module.UTF8_BOM + b".unlisted {}\n")
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_git_visible_paths", lambda: [listed_file])

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "styles/listed.css" in output
    assert "styles/unlisted.css" not in output


def test_check_no_port_bundle_runtime_imports_fails_in_services(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_port_bundle_runtime_imports.py")
    repo_root = tmp_path / "repo"
    sample = repo_root / "services" / "backend" / "example.js"
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_text("require('../../PORT_BUNDLES/example');\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "services/backend/example.js:1" in output


def test_check_no_port_bundle_runtime_imports_fails_in_root_entrypoint(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_port_bundle_runtime_imports.py")
    repo_root = tmp_path / "repo"
    sample = repo_root / "main.js"
    repo_root.mkdir()
    sample.write_text("require('./PORT_BUNDLES/example');\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "main.js:1" in output


def test_check_no_secrets_scans_git_visible_build_candidates(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_secrets.py")
    repo_root = tmp_path / "repo"
    tracked = repo_root / "build" / "afterPack.js"
    tracked.parent.mkdir(parents=True, exist_ok=True)
    tracked.write_text("const token = 'ghp_" + ("g" * 36) + "';\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_git_visible_paths", lambda: [tracked])

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "build/afterPack.js:1" in output
