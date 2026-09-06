from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType


def _load_script_module() -> ModuleType:
    script_path = (
        Path(__file__).resolve().parents[2]
        / "scripts"
        / "checks"
        / "check_complexity_ratchets.py"
    )
    spec = importlib.util.spec_from_file_location("test_complexity_ratchets", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive guard
        raise RuntimeError("unable to load complexity ratchet checker")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    (repo / "scripts" / "checks").mkdir(parents=True)
    (repo / "renderer").mkdir()
    (repo / "tests").mkdir()
    (repo / "index.html").write_text(
        '<script src="renderer/local.js"></script>\n', encoding="utf-8"
    )
    (repo / "renderer" / "local.js").write_text("'use strict';\n", encoding="utf-8")
    return repo


def _write_baselines(module: ModuleType, repo: Path, metrics: dict[str, int]) -> None:
    payload = {
        metric: {"baseline": value, "note": f"Fixture baseline for {metric}."}
        for metric, value in metrics.items()
    }
    path = repo / module.BASELINES_RELATIVE_PATH
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_over_baseline_fails_and_names_metric(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module()
    repo = _make_repo(tmp_path)
    monkeypatch.setattr(module, "ROOT", repo)
    metrics = module.measure_metrics()
    metrics["index_html_lines"] -= 1
    _write_baselines(module, repo, metrics)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "index_html_lines" in output
    assert "current 1, baseline 0" in output


def test_at_baseline_passes(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module()
    repo = _make_repo(tmp_path)
    monkeypatch.setattr(module, "ROOT", repo)
    _write_baselines(module, repo, module.measure_metrics())

    assert module.main() == 0
    assert "PASS: complexity ratchets" in capsys.readouterr().out


def test_under_baseline_passes_with_info(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module()
    repo = _make_repo(tmp_path)
    monkeypatch.setattr(module, "ROOT", repo)
    metrics = module.measure_metrics()
    metrics["index_html_lines"] += 1
    _write_baselines(module, repo, metrics)

    assert module.main() == 0
    output = capsys.readouterr().out
    assert "INFO: index_html_lines" in output
    assert "lower the baseline" in output


def test_missing_baselines_file_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module()
    repo = _make_repo(tmp_path)
    monkeypatch.setattr(module, "ROOT", repo)

    assert module.main() == 1
    assert "missing baselines file" in capsys.readouterr().out


def test_missing_metric_key_fails(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module()
    repo = _make_repo(tmp_path)
    monkeypatch.setattr(module, "ROOT", repo)
    metrics = module.measure_metrics()
    del metrics["test_files_over_600"]
    _write_baselines(module, repo, metrics)

    assert module.main() == 1
    assert "missing metric key: test_files_over_600" in capsys.readouterr().out


def test_script_count_ignores_https_sources(tmp_path, monkeypatch) -> None:
    module = _load_script_module()
    repo = _make_repo(tmp_path)
    (repo / "index.html").write_text(
        '<script src="https://cdn.example.test/vendor.js"></script>\n'
        '<script src="renderer/local.js"></script>\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "ROOT", repo)

    assert module.measure_metrics()["index_html_scripts"] == 1


def test_real_repo_matches_committed_baselines(capsys) -> None:
    module = _load_script_module()

    assert module.main() == 0
    assert "PASS: complexity ratchets" in capsys.readouterr().out
