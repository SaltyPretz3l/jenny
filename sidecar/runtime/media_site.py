"""Activate the packaged sidecar media dependency directory."""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any

from sidecar.ai.config import read_environment_value
from sidecar.runtime.diagnostics import log_event

MEDIA_SITE_DIRNAME = "sidecar-media-site"
MEDIA_SITE_ENV = "JENNY_SIDECAR_MEDIA_SITE_DIR"
PDF_ADDON_ENV = "JENNY_SIDECAR_PDF_ADDON_DIR"
PYTHON_VERSION_PARTS = 2

logger = logging.getLogger(__name__)
# The add-on directory this process activated (reported by --probe-pdf-addon).
_PDF_ADDON_STATE: dict[str, Path | None] = {"directory": None}


def resolve_media_site_dir() -> Path | None:
    """Resolve the explicit or packaged media site location."""
    configured = read_environment_value(MEDIA_SITE_ENV)
    if configured:
        return Path(configured)
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent.parent / MEDIA_SITE_DIRNAME
    return None


def _read_manifest(directory: Path) -> dict[str, Any] | None:
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _major_minor(value: object) -> str | None:
    token = str(value or "").strip()
    parts = token.split(".")
    if len(parts) < PYTHON_VERSION_PARTS or not all(
        part.isdigit() for part in parts[:PYTHON_VERSION_PARTS]
    ):
        return None
    return ".".join(parts[:PYTHON_VERSION_PARTS])


def activate_media_site() -> Path | None:
    """Append a compatible media site to ``sys.path`` without raising."""
    try:
        directory = resolve_media_site_dir()
        if directory is None or not directory.is_dir():
            return None
        directory_text = str(directory)
        if directory_text in sys.path:
            return None

        manifest = _read_manifest(directory)
        manifest_version = _major_minor(manifest.get("python_version")) if manifest else None
        running_version = f"{sys.version_info.major}.{sys.version_info.minor}"
        if manifest_version is not None and manifest_version != running_version:
            log_event(
                logger,
                logging.ERROR,
                component="runtime.media_site",
                event="runtime.media_site.rejected",
                message="Sidecar media site targets a different Python version",
                status="failure",
                data={
                    "directory": directory_text,
                    "expected_python_version": running_version,
                    "manifest_python_version": manifest_version,
                },
            )
            return None

        sys.path.append(directory_text)
        log_event(
            logger,
            logging.INFO,
            component="runtime.media_site",
            event="runtime.media_site.activated",
            message="Sidecar media site activated",
            status="success",
            data={"directory": directory_text},
        )
        return directory
    except Exception:
        return None


def _pdf_addon_rejection(directory: Path) -> str | None:
    """Return why ``directory`` is not a loadable PDF reading add-on, or None."""
    if not directory.is_dir():
        return "directory_missing"
    manifest = _read_manifest(directory)
    if manifest is None:
        return "manifest_missing_or_invalid"
    if manifest.get("package") != "PyMuPDF":
        return "package_mismatch"
    minimum_value = manifest.get("minimum_python_version")
    minimum = _major_minor(minimum_value) if isinstance(minimum_value, str) else None
    if minimum is None or str(minimum_value).strip() != minimum:
        return "minimum_python_version_missing_or_invalid"
    required = tuple(int(part) for part in minimum.split("."))
    if required > (sys.version_info.major, sys.version_info.minor):
        return "minimum_python_version_too_new"
    return None


def activate_pdf_addon() -> Path | None:
    """Append a compatible PDF reading add-on directory without raising."""
    try:
        configured = read_environment_value(PDF_ADDON_ENV)
        if _PDF_ADDON_STATE["directory"] is not None or not configured:
            return None
        directory = Path(configured)
        directory_text = str(directory)
        reason = _pdf_addon_rejection(directory)
        if reason is not None:
            log_event(
                logger,
                logging.ERROR,
                component="runtime.pdf_addon",
                event="runtime.pdf_addon.rejected",
                message="PDF reading add-on rejected",
                status="failure",
                data={"directory": directory_text, "reason": reason},
            )
            return None
        if directory_text not in sys.path:
            sys.path.append(directory_text)
        _PDF_ADDON_STATE["directory"] = directory
        log_event(
            logger,
            logging.INFO,
            component="runtime.pdf_addon",
            event="runtime.pdf_addon.activated",
            message="PDF reading add-on activated",
            status="success",
            data={"directory": directory_text},
        )
        return directory
    except Exception:
        return None


def pdf_addon_activated_dir() -> Path | None:
    """Return the successfully activated PDF reading add-on directory."""
    return _PDF_ADDON_STATE["directory"]


def pdf_addon_configured() -> bool:
    """Return whether Electron main says the add-on is installed, even if it was rejected."""
    return bool(read_environment_value(PDF_ADDON_ENV))


def activate_optional_sites() -> None:
    """Activate optional dependency directories in their required order."""
    activate_media_site()
    activate_pdf_addon()
