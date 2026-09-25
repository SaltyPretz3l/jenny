from __future__ import annotations

import importlib
import json

import pytest

from sidecar import __main__ as sidecar_main
from sidecar.runtime import media_site


def test_probe_pdf_addon_reports_loadable_module(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv(media_site.PDF_ADDON_ENV, raising=False)
    monkeypatch.setitem(media_site._PDF_ADDON_STATE, "directory", None)

    assert sidecar_main.run(["--probe-pdf-addon"]) == 0

    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["ok"] is True
    assert isinstance(payload["version"], str)
    assert payload["version"]
    assert payload["addon_dir"] is None


def test_probe_pdf_addon_reports_import_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv(media_site.PDF_ADDON_ENV, raising=False)
    monkeypatch.setitem(media_site._PDF_ADDON_STATE, "directory", None)

    def _missing_fitz(name: str):
        assert name == "fitz"
        raise ImportError("fitz unavailable")

    monkeypatch.setattr(importlib, "import_module", _missing_fitz)

    assert sidecar_main.run(["--probe-pdf-addon"]) == 1

    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0]) == {
        "ok": False,
        "error": "ImportError",
        "addon_dir": None,
    }
