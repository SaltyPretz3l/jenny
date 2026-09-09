"""Fixed root-only desktop relay; never a shell or Docker proxy."""
from __future__ import annotations

import os
import socket
import sys
from pathlib import Path

from .protocol import MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, decode_envelope
from .supervisor import CONTROL_DIR, CONTROLLER_KEY_BYTES, WORKER_GID, _read_private, _strict_dir


def controller_key() -> bytes:
    if os.geteuid() != 0:
        raise ValueError("root_relay_required")
    directory = Path(CONTROL_DIR)
    _strict_dir(directory, 0o770, gid=WORKER_GID)
    key = _read_private(directory / "controller.key", CONTROLLER_KEY_BYTES)
    if key is None or len(key) != CONTROLLER_KEY_BYTES:
        raise ValueError("controller_key_invalid")
    return key


def relay_frame(frame: bytes, key: bytes) -> bytes:
    if not frame.endswith(b"\n") or len(frame) > MAX_REQUEST_BYTES:
        raise ValueError("request_frame_invalid")
    # Reject malformed, unsigned, or unexpected operations before connecting.
    decode_envelope(frame, key)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(5.0)
        connection.connect(str(Path(CONTROL_DIR) / "control.sock"))
        connection.sendall(frame)
        data = bytearray()
        while len(data) <= MAX_RESPONSE_BYTES:
            chunk = connection.recv(min(65536, MAX_RESPONSE_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if b"\n" in data:
                break
    result = bytes(data)
    if not result.endswith(b"\n") or b"\n" in result[:-1] or len(result) > MAX_RESPONSE_BYTES:
        raise ValueError("response_frame_invalid")
    decode_envelope(result, key, response=True)
    return result


RELAY_ARG_COUNT = 2


def main() -> None:
    try:
        if len(sys.argv) != RELAY_ARG_COUNT or sys.argv[1] not in {"bootstrap", "request"}:
            raise ValueError("relay_operation_invalid")
        key = controller_key()
        if sys.argv[1] == "bootstrap":
            sys.stdout.buffer.write(key)
        else:
            frame = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
            if sys.stdin.buffer.read(1):
                raise ValueError("request_frame_invalid")
            sys.stdout.buffer.write(relay_frame(frame, key))
        sys.stdout.buffer.flush()
    except (OSError, ValueError):
        sys.stderr.write("worker_relay_failed\n")
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
