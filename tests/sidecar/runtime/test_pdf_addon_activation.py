from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.mcp import process_containment
from sidecar.runtime import media_site


@pytest.fixture(autouse=True)
def _isolated_activation_state(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setitem(media_site._PDF_ADDON_STATE, "directory", None)
    yield


def _write_manifest(directory: Path, payload: dict[str, object]) -> None:
    (directory / "manifest.json").write_text(json.dumps(payload), encoding="utf-8")


def _capture_events(
    monkeypatch: pytest.MonkeyPatch,
) -> list[tuple[int, dict[str, object]]]:
    events: list[tuple[int, dict[str, object]]] = []
    monkeypatch.setattr(
        media_site,
        "log_event",
        lambda *_args, **kwargs: events.append((_args[1], kwargs)),
    )
    return events


def test_unset_environment_is_inactive_and_silent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(media_site.PDF_ADDON_ENV, raising=False)
    events = _capture_events(monkeypatch)
    original = list(sys.path)

    assert media_site.activate_pdf_addon() is None
    assert media_site.pdf_addon_activated_dir() is None
    assert sys.path == original
    assert events == []


def test_missing_directory_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    missing = tmp_path / "missing"
    monkeypatch.setenv(media_site.PDF_ADDON_ENV, str(missing))
    events = _capture_events(monkeypatch)

    assert media_site.activate_pdf_addon() is None
    assert events[0][0] == logging.ERROR
    assert events[0][1]["event"] == "runtime.pdf_addon.rejected"
    assert events[0][1]["data"] == {
        "directory": str(missing),
        "reason": "directory_missing",
    }


def test_wrong_package_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_manifest(
        tmp_path,
        {"package": "OtherPackage", "minimum_python_version": "3.10"},
    )
    monkeypatch.setenv(media_site.PDF_ADDON_ENV, str(tmp_path))
    events = _capture_events(monkeypatch)

    assert media_site.activate_pdf_addon() is None
    assert events[0][1]["data"]["reason"] == "package_mismatch"


def test_too_new_minimum_python_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    minimum = f"{sys.version_info.major + 1}.0"
    _write_manifest(
        tmp_path,
        {"package": "PyMuPDF", "minimum_python_version": minimum},
    )
    monkeypatch.setenv(media_site.PDF_ADDON_ENV, str(tmp_path))
    events = _capture_events(monkeypatch)

    assert media_site.activate_pdf_addon() is None
    assert events[0][1]["data"]["reason"] == "minimum_python_version_too_new"


def test_missing_minimum_python_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_manifest(tmp_path, {"package": "PyMuPDF"})
    monkeypatch.setenv(media_site.PDF_ADDON_ENV, str(tmp_path))
    events = _capture_events(monkeypatch)

    assert media_site.activate_pdf_addon() is None
    assert events[0][1]["data"]["reason"] == "minimum_python_version_missing_or_invalid"


def test_success_appends_path_logs_and_records_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_manifest(
        tmp_path,
        {"package": "PyMuPDF", "minimum_python_version": "3.10"},
    )
    monkeypatch.setenv(media_site.PDF_ADDON_ENV, str(tmp_path))
    events = _capture_events(monkeypatch)

    assert media_site.activate_pdf_addon() == tmp_path
    assert sys.path[-1] == str(tmp_path)
    assert media_site.pdf_addon_activated_dir() == tmp_path
    assert events[0][0] == logging.INFO
    assert events[0][1]["component"] == "runtime.pdf_addon"
    assert events[0][1]["event"] == "runtime.pdf_addon.activated"
    assert events[0][1]["status"] == "success"
    assert events[0][1]["data"] == {"directory": str(tmp_path)}
    assert events[0][1]["message"] == "PDF reading add-on activated"


def test_second_activation_is_no_op(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_manifest(
        tmp_path,
        {"package": "PyMuPDF", "minimum_python_version": "3.10"},
    )
    monkeypatch.setenv(media_site.PDF_ADDON_ENV, str(tmp_path))
    events = _capture_events(monkeypatch)

    assert media_site.activate_pdf_addon() == tmp_path
    assert media_site.activate_pdf_addon() is None
    assert sys.path.count(str(tmp_path)) == 1
    assert len(events) == 1


def test_minimal_env_passes_pdf_addon_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    addon_dir = tmp_path / "pdf-addon"
    monkeypatch.setenv(media_site.PDF_ADDON_ENV, str(addon_dir))

    env = process_containment._minimal_env(  # noqa: SLF001
        MCPServerConfig(name="builtin", transport="stdio", command="builtin-mcp"),
        command_path=None,
    )

    assert env[media_site.PDF_ADDON_ENV] == str(addon_dir)
