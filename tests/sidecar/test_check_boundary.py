from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("source", [
    "import renderer as ui", "import renderer, os", "import os, renderer",
    "from services.backend import client", "import main as entry",
    "import Electron as shell", "from electron import app",
    "from ....renderer import view", "from ... import services",
    "def nested():\n    import os, services as backend",
])
def test_chk11_import_forms_fail(source, tmp_path, monkeypatch, capsys):
    spec = importlib.util.spec_from_file_location("boundary_test", ROOT / "scripts/checks/check_boundary.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    target = tmp_path / "sidecar/ai"
    target.mkdir(parents=True)
    (target / "subject.py").write_text(source + "\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "TARGET", target)
    assert module.main() == 1
    assert "subject.py:" in capsys.readouterr().out


def test_boundary_allows_sidecar_imports_and_ignores_comments(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("boundary_test", ROOT / "scripts/checks/check_boundary.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    target = tmp_path / "sidecar/ai"
    target.mkdir(parents=True)
    (target / "subject.py").write_text(
        "from ..protocol import API_VERSION\nfrom . import config\n"
        "# import renderer\ntext = 'from services import backend'\n", encoding="utf-8"
    )
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "TARGET", target)
    assert module.main() == 0
