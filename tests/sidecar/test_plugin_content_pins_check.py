from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
from types import ModuleType


def _load_script_module() -> ModuleType:
    script_path = (
        Path(__file__).resolve().parents[2]
        / "scripts"
        / "checks"
        / "check_plugin_content_pins.py"
    )
    spec = importlib.util.spec_from_file_location(
        "test_loader_check_plugin_content_pins", script_path
    )
    if spec is None or spec.loader is None:  # pragma: no cover - defensive guard
        raise RuntimeError("unable to load check_plugin_content_pins.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_pinned_document(
    repo_root: Path,
    *,
    asset_bytes: bytes = b"const value = 1;\n",
    asset_exists: bool = True,
    document_override: dict[str, object] | None = None,
) -> Path:
    plugin_root = repo_root / "plugins" / "official" / "sample-plugin"
    asset_path = plugin_root / "view" / "app.js"
    content_path = plugin_root / "content" / "sample.json"
    content_path.parent.mkdir(parents=True)
    asset_path.parent.mkdir(parents=True)
    if asset_exists:
        asset_path.write_bytes(asset_bytes)
    digest = hashlib.sha256(asset_bytes).hexdigest()
    document: dict[str, object] = {
        "entry_path": "view/app.js",
        "entry_sha256": digest,
        "assets": [
            {
                "path": "view/app.js",
                "sha256": digest,
                "bytes": len(asset_bytes),
            }
        ],
    }
    if document_override is not None:
        document = document_override
    content_path.write_text(json.dumps(document), encoding="utf-8")
    return asset_path


def test_matching_pins_pass(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module()
    repo_root = tmp_path / "repo"
    _write_pinned_document(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert output.startswith("PASS: official plugin content pin check")


def test_digest_mismatch_fails_and_names_asset(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module()
    repo_root = tmp_path / "repo"
    asset_path = _write_pinned_document(repo_root)
    asset_path.write_bytes(b"const value = 2;\n")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "plugins/official/sample-plugin/view/app.js" in output
    assert "expected sha256=" in output
    assert "actual sha256=" in output


def test_missing_declared_asset_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module()
    repo_root = tmp_path / "repo"
    _write_pinned_document(repo_root, asset_exists=False)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "view/app.js" in output
    assert "expected existing readable file" in output


def test_malformed_document_is_reported(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module()
    repo_root = tmp_path / "repo"
    _write_pinned_document(repo_root, document_override={"assets": "view/app.js"})
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "expected JSON array" in output
    assert "actual 'str'" in output


def test_zero_pinned_documents_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module()
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "expected at least one document declaring assets; actual 0" in output
