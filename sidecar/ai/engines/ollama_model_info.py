"""Bounded Ollama model-info inspection shared by runtime consumers."""

from __future__ import annotations

import os
import re
import sys
from typing import Any

from sidecar.ai.engines.ollama_metadata import extract_context_length
from sidecar.ai.engines.provider_http import ProviderHttpError, ProviderHttpService

MAX_OLLAMA_MODEL_ID_CHARS = 240
OLLAMA_MODEL_INFO_TIMEOUT_SECONDS = 2.0
MAX_OLLAMA_MODELFILE_LINES = 64
MAX_OLLAMA_BLOB_PATH_CHARS = 1024
MAX_OLLAMA_BLOB_PATHS = 2
_HTTP_STATUS_NOT_FOUND = 404
_WINDOWS_DRIVE_PATH = re.compile(r"^[A-Za-z]:[\\/]")
_PATH_CONTROL_CHARACTERS = re.compile(r"[\r\n\0]")


def _normalize_model_id(value: Any) -> str:
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > MAX_OLLAMA_MODEL_ID_CHARS:
        return ""
    return normalized


def fetch_ollama_model_info(
    *,
    host: str,
    model_id: str,
    timeout_seconds: float = OLLAMA_MODEL_INFO_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Return one model's ``/api/show`` payload through the shared HTTP policy."""
    normalized_model_id = _normalize_model_id(model_id)
    if not normalized_model_id:
        raise ValueError("invalid_model_id")
    service = ProviderHttpService(
        provider="ollama",
        base_url=str(host or "").strip().rstrip("/"),
        headers={"Accept": "application/json"},
        timeout_seconds=max(float(timeout_seconds), 0.05),
    )
    try:
        return service.post_json("/api/show", {"name": normalized_model_id})
    finally:
        service.close()


def inspect_ollama_model(
    *,
    host: str,
    model_id: Any,
    timeout_seconds: float = OLLAMA_MODEL_INFO_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Return bounded native-context metadata without exposing provider payloads."""
    normalized_model_id = _normalize_model_id(model_id)
    if not normalized_model_id:
        return {
            "model_id": "",
            "available": False,
            "native_context_length": None,
            "reason": "invalid_model_id",
        }
    try:
        info = fetch_ollama_model_info(
            host=host,
            model_id=normalized_model_id,
            timeout_seconds=timeout_seconds,
        )
    except ProviderHttpError as error:
        reason = (
            "model_not_found"
            if error.status_code == _HTTP_STATUS_NOT_FOUND
            else "provider_unavailable"
        )
        return {
            "model_id": normalized_model_id,
            "available": False,
            "native_context_length": None,
            "reason": reason,
        }
    except Exception:  # noqa: BLE001 -- inspection must degrade without crossing RPC
        return {
            "model_id": normalized_model_id,
            "available": False,
            "native_context_length": None,
            "reason": "provider_unavailable",
        }

    native_context_length = extract_context_length(info)
    if native_context_length is None or native_context_length <= 0:
        return {
            "model_id": normalized_model_id,
            "available": False,
            "native_context_length": None,
            "reason": "native_context_unavailable",
        }
    return {
        "model_id": normalized_model_id,
        "available": True,
        "native_context_length": native_context_length,
        "reason": "",
    }


def _is_local_absolute_path(candidate: str, *, platform: str) -> bool:
    """Mirror Electron's ``isLocalAbsolutePath``: on Windows, a drive path only.

    A stat or open of a UNC or device path connects to the host it names and
    sends that host the user's Windows credentials, so one is refused before any
    filesystem call. A share mapped to a drive letter is a drive path.
    """
    if not candidate or _PATH_CONTROL_CHARACTERS.search(candidate):
        return False
    if platform == "win32":
        return _WINDOWS_DRIVE_PATH.match(candidate) is not None
    return candidate.startswith("/")


def _ollama_from_paths(modelfile: str) -> list[str]:
    """Return the paths on the FROM lines Ollama itself writes, in order.

    ``/api/show`` renders the model's FROM lines (the model, then any projectors,
    with adapters between) before every command whose text the model's publisher
    wrote. The scan stops at the first other command, so a FROM line inside a
    template, system prompt or license is text, never a path to read.
    """
    candidates: list[str] = []
    for raw_line in modelfile.splitlines()[:MAX_OLLAMA_MODELFILE_LINES]:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        keyword = line.split(maxsplit=1)[0].lower()
        if keyword == "adapter":
            continue
        if keyword != "from":
            break
        candidate = line[5:].strip()
        if candidate[:1] in {'"', "'"} and candidate[-1:] == candidate[:1]:
            candidate = candidate[1:-1]
        candidates.append(candidate)
    return candidates


def resolve_ollama_model_blob(
    *,
    host: str,
    model_id: Any,
    timeout_seconds: float = OLLAMA_MODEL_INFO_TIMEOUT_SECONDS,
    platform: str | None = None,
) -> dict[str, Any]:
    """Resolve up to two local GGUF paths without exposing provider payloads."""
    normalized_model_id = _normalize_model_id(model_id)
    unavailable = {
        "model_id": normalized_model_id,
        "available": False,
        "blob_path": "",
        "mmproj_path": "",
        "reason": "invalid_model_id" if not normalized_model_id else "provider_unavailable",
    }
    if not normalized_model_id:
        return unavailable
    try:
        info = fetch_ollama_model_info(
            host=host,
            model_id=normalized_model_id,
            timeout_seconds=timeout_seconds,
        )
    except ProviderHttpError as error:
        unavailable["reason"] = (
            "model_not_found"
            if error.status_code == _HTTP_STATUS_NOT_FOUND
            else "provider_unavailable"
        )
        return unavailable
    except Exception:  # noqa: BLE001 -- inspection must degrade without crossing RPC
        return unavailable

    paths: list[str] = []
    modelfile = info.get("modelfile")
    host_platform = platform or sys.platform
    for candidate in _ollama_from_paths(modelfile) if isinstance(modelfile, str) else []:
        if (
            len(candidate) > MAX_OLLAMA_BLOB_PATH_CHARS
            or not _is_local_absolute_path(candidate, platform=host_platform)
            or not os.path.isfile(candidate)
        ):
            continue
        try:
            with open(candidate, "rb") as blob_file:  # noqa: PTH123
                if blob_file.read(4) != b"GGUF":
                    continue
        except OSError:
            continue
        paths.append(candidate)
        if len(paths) == MAX_OLLAMA_BLOB_PATHS:
            break

    blob_path = paths[0] if paths else ""
    return {
        "model_id": normalized_model_id,
        "available": bool(blob_path),
        "blob_path": blob_path,
        "mmproj_path": paths[1] if len(paths) > 1 else "",
        "reason": "" if blob_path else "no_local_blob",
    }
