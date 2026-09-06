"""Background-worker launch environment and on-disk payload construction.

This module owns what a worker receives; ``subprocess_manager`` owns subprocess
lifecycle. The manager re-exports both helpers under their original private
names for compatibility.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any

from sidecar.runtime.worker_secrets import guard_no_secret_keys

logger = logging.getLogger(__name__)

PAYLOAD_CREATE_ATTEMPTS = 4
MAX_BACKGROUND_PAYLOAD_BYTES = 4 * 1024 * 1024
BACKGROUND_ENV_ALLOWLIST = {
    "APPDATA",
    "HOME",
    "LANG",
    "LOCALAPPDATA",
    "PATH",
    "PYTHONHOME",
    "PYTHONPATH",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "VIRTUAL_ENV",
    # Standard Windows identity/system vars native ML stacks read at import
    # (first smoke 2026-07-31): torch._inductor calls getpass.getuser(),
    # which without USERNAME falls back to the POSIX-only `pwd` module and
    # kills the whole transformers import; OpenBLAS/torch size thread pools
    # from NUMBER_OF_PROCESSORS; driver/config discovery walks the Program*
    # roots. All are non-secret machine facts.
    "COMSPEC",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "USERDOMAIN",
    "USERNAME",
    "WINDIR",
}


def build_background_env(parent_env: dict[str, str] | None = None) -> dict[str, str]:
    source = parent_env if parent_env is not None else dict(os.environ)
    env: dict[str, str] = {}
    for key, value in source.items():
        normalized_key = str(key)
        upper_key = normalized_key.upper()
        if (
            upper_key in BACKGROUND_ENV_ALLOWLIST
            or upper_key.startswith("JENNY_")
            or upper_key.startswith("LC_")
        ):
            env[normalized_key] = str(value)
    env["PYTHONUNBUFFERED"] = "1"
    env["JENNY_BACKGROUND_PARENT_PID"] = str(os.getpid())
    return env


def write_worker_payload(payload_dir: Path, payload: dict[str, Any]) -> Path:
    """Write a UUID-only payload name with exclusive creation."""

    # Fail closed BEFORE the file exists: this payload is plaintext on disk and
    # survives a crash, so a secret-bearing key must abort the spawn instead.
    guard_no_secret_keys(payload, context="background worker payload")
    payload_dir.mkdir(parents=True, exist_ok=True)
    resolved_dir = payload_dir.resolve(strict=True)
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        indent=2,
    ).encode("utf-8", errors="strict")
    if len(encoded) > MAX_BACKGROUND_PAYLOAD_BYTES:
        raise ValueError("background worker payload exceeds its byte limit")
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_BINARY", 0)
    )
    for _attempt in range(PAYLOAD_CREATE_ATTEMPTS):
        payload_path = resolved_dir / f"{uuid.uuid4().hex}.json"
        if payload_path.parent != resolved_dir:
            raise OSError("background worker payload path escaped its directory")
        fd: int | None = None
        try:
            fd = os.open(str(payload_path), flags, 0o600)
            view = memoryview(encoded)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("background worker payload write made no progress")
                view = view[written:]
            os.fsync(fd)
            return payload_path
        except FileExistsError:
            continue
        except Exception:
            if fd is not None:
                os.close(fd)
                fd = None
            try:
                payload_path.unlink(missing_ok=True)
            except OSError:
                logger.debug("failed to remove incomplete worker payload", exc_info=True)
            raise
        finally:
            if fd is not None:
                os.close(fd)
    raise FileExistsError("could not allocate a unique background worker payload")
