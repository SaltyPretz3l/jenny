"""Trusted worker healthcheck: authenticate as the application UID."""

from __future__ import annotations

import os
import socket
import uuid
from pathlib import Path

from .protocol import MAX_RESPONSE_BYTES, UUID_RE, decode_envelope, encode_envelope
from .supervisor import _read_private, _record_valid

CONTROL_DIR = "/run/jenny-worker"
APP_UID = 10001
APP_GROUP = 10003
KEY_BYTES = 32


def _read_key(path: Path) -> bytes:
    key = _read_private(path, KEY_BYTES)
    if key is None or len(key) != KEY_BYTES:
        raise RuntimeError("invalid controller key")
    return key


def _drop_to_app() -> None:
    os.setgroups([APP_GROUP])
    if hasattr(os, "setresgid"):
        os.setresgid(APP_UID, APP_UID, APP_UID)
        os.setresuid(APP_UID, APP_UID, APP_UID)
    else:  # pragma: no cover - old Unix fallback
        os.setgid(APP_UID)
        os.setuid(APP_UID)
    if os.geteuid() != APP_UID or os.getegid() != APP_UID or os.getgroups() != [APP_GROUP]:
        raise RuntimeError("health identity transition failed")


def _valid_status(value: object, request_id: str) -> bool:  # noqa: PLR0911 - fail-closed field gates
    if not isinstance(value, dict) or set(value) != {
        "schema_version",
        "request_id",
        "ok",
        "incarnation",
        "phase",
        "job_id",
        "previous_result",
    }:
        return False
    if (
        type(value["schema_version"]) is not int
        or value["schema_version"] != 1
        or value["request_id"] != request_id
        or value["ok"] is not True
    ):
        return False
    if value["phase"] not in {"ready", "running"}:
        return False
    if not isinstance(value["incarnation"], str) or not UUID_RE.fullmatch(value["incarnation"]):
        return False
    if value["phase"] == "ready" and value["job_id"] is not None:
        return False
    if value["phase"] == "running" and (
        not isinstance(value["job_id"], str) or not UUID_RE.fullmatch(value["job_id"])
    ):
        return False
    previous = value["previous_result"]
    return _record_valid(previous) and (
        previous is None or previous["incarnation"] != value["incarnation"]
    )


def main() -> None:
    key = _read_key(Path(CONTROL_DIR) / "controller.key")
    _drop_to_app()
    request_id = str(uuid.uuid4())
    frame = encode_envelope(
        {"schema_version": 1, "request_id": request_id, "operation": "status"}, key
    )
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(5.0)
        conn.connect(str(Path(CONTROL_DIR) / "control.sock"))
        conn.sendall(frame)
        data = bytearray()
        while len(data) <= MAX_RESPONSE_BYTES:
            chunk = conn.recv(min(65536, MAX_RESPONSE_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if b"\n" in chunk:
                break
    response = decode_envelope(bytes(data), key, response=True)
    if not _valid_status(response, request_id):
        raise RuntimeError("worker is not ready")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as exc:
        raise SystemExit(1) from exc
