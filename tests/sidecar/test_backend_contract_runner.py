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


def test_backend_contract_runner_fails_fast_with_clear_dependency_message(
    monkeypatch, capsys
) -> None:
    module = _load_script_module("run_backend_contract_tests.py")
    monkeypatch.setattr(module, "_missing_modules", lambda: ["fastapi"])

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: backend contract test dependencies are missing" in output
    assert 'pip install -e ".[dev,backend]"' in output
