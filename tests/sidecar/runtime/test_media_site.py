from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

from sidecar.runtime.media_site import MEDIA_SITE_ENV, activate_media_site


def _isolated_sys_path(monkeypatch) -> list[str]:
    isolated = list(sys.path)
    monkeypatch.setattr(sys, "path", isolated)
    return list(isolated)


def test_unfrozen_without_override_is_inactive(monkeypatch, capsys) -> None:
    monkeypatch.delenv(MEDIA_SITE_ENV, raising=False)
    monkeypatch.delattr(sys, "frozen", raising=False)
    original = _isolated_sys_path(monkeypatch)

    assert activate_media_site() is None
    assert sys.path == original
    assert capsys.readouterr().out == ""


def test_environment_override_appends_existing_directory_once(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    monkeypatch.setenv(MEDIA_SITE_ENV, str(tmp_path))
    original = _isolated_sys_path(monkeypatch)
    events: list[tuple[tuple[object, ...], dict[str, object]]] = []
    monkeypatch.setattr(
        "sidecar.runtime.media_site.log_event",
        lambda *args, **kwargs: events.append((args, kwargs)),
    )

    assert activate_media_site() == tmp_path
    assert sys.path == [*original, str(tmp_path)]
    assert activate_media_site() is None
    assert sys.path.count(str(tmp_path)) == 1
    assert events[0][0][1] == logging.INFO
    assert events[0][1]["event"] == "runtime.media_site.activated"
    assert events[0][1]["data"] == {"directory": str(tmp_path)}
    assert capsys.readouterr().out == ""


def test_frozen_layout_resolves_sibling_resources_directory(tmp_path: Path, monkeypatch) -> None:
    executable = tmp_path / "resources" / "sidecar" / "sidecar.exe"
    media_site = tmp_path / "resources" / "sidecar-media-site"
    media_site.mkdir(parents=True)
    monkeypatch.delenv(MEDIA_SITE_ENV, raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(executable))
    _isolated_sys_path(monkeypatch)

    assert activate_media_site() == media_site
    assert sys.path[-1] == str(media_site)


def test_incompatible_manifest_is_rejected(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "manifest.json").write_text(json.dumps({"python_version": "3.9"}), encoding="utf-8")
    monkeypatch.setenv(MEDIA_SITE_ENV, str(tmp_path))
    original = _isolated_sys_path(monkeypatch)
    events: list[tuple[tuple[object, ...], dict[str, object]]] = []
    monkeypatch.setattr(
        "sidecar.runtime.media_site.log_event",
        lambda *args, **kwargs: events.append((args, kwargs)),
    )

    assert activate_media_site() is None
    assert sys.path == original
    assert events[0][0][1] == logging.ERROR
    assert events[0][1]["event"] == "runtime.media_site.rejected"
    assert events[0][1]["status"] == "failure"


def test_missing_directory_is_inactive(tmp_path: Path, monkeypatch, capsys) -> None:
    missing = tmp_path / "missing"
    monkeypatch.setenv(MEDIA_SITE_ENV, str(missing))
    original = _isolated_sys_path(monkeypatch)

    assert activate_media_site() is None
    assert sys.path == original
    assert capsys.readouterr().out == ""
