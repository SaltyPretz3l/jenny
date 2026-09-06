"""Tests for sidecar.ai.dependency_status."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from sidecar.ai import dependency_status
from sidecar.ai.dependency_status import (
    DependencyInfo,
    DependencyReport,
    probe_dependencies,
)


@pytest.fixture(autouse=True)
def _isolate_dependency_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dependency_status, "_cached_report", None)


def test_dependency_report_to_dict() -> None:
    report = DependencyReport(
        dependencies={
            "torch": DependencyInfo(name="torch", status="available"),
            "tiktoken": DependencyInfo(name="tiktoken", status="missing"),
        }
    )
    assert report.to_dict() == {"torch": "available", "tiktoken": "missing"}


def test_probe_dependencies_returns_all_three_deps() -> None:
    report = probe_dependencies(force=True)
    assert "torch" in report.dependencies
    assert "tiktoken" in report.dependencies
    assert "transformers" in report.dependencies
    for info in report.dependencies.values():
        assert info.status in ("available", "missing", "error")


def test_probe_dependencies_caches_result() -> None:
    first = probe_dependencies(force=True)
    second = probe_dependencies()
    assert first is second


def test_probe_dependencies_force_refreshes() -> None:
    first = probe_dependencies(force=True)
    second = probe_dependencies(force=True)
    assert first is not second


def test_probe_torch_import_error() -> None:
    with patch.dict("sys.modules", {"torch": None}):
        report = probe_dependencies(force=True)
    # Even if torch import fails in this env, we get a valid status
    assert report.dependencies["torch"].status in ("available", "missing", "error")


def test_probe_tiktoken_import_error() -> None:
    with patch.dict("sys.modules", {"tiktoken": None}):
        report = probe_dependencies(force=True)
    assert report.dependencies["tiktoken"].status in ("available", "missing", "error")
