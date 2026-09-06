"""CLI entrypoint for detached background automation workers."""

from __future__ import annotations

import json
import logging
import os
import stat
import sys
import threading
from pathlib import Path
from typing import Any, Callable

from sidecar.ai.config import read_environment_value
from sidecar.runtime.automation_runner import run_automation_worker
from sidecar.runtime.bounded_io import read_bounded_bytes
from sidecar.runtime.diagnostics import configure_sidecar_logging, shutdown_sidecar_logging
from sidecar.runtime.subprocess_manager import process_exists
from sidecar.runtime.worker_secrets import read_secrets_frame

logger = logging.getLogger(__name__)

PARENT_POLL_INTERVAL_SECONDS = 2.0
MAX_BACKGROUND_PAYLOAD_BYTES = 4 * 1024 * 1024

TASK_HANDLERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "automation_run": run_automation_worker,
}


def start_parent_watchdog(
    parent_pid: int | None,
    *,
    check_process_exists: Callable[[int], bool] = process_exists,
    exit_fn: Callable[[int], None] = os._exit,
    interval_seconds: float = PARENT_POLL_INTERVAL_SECONDS,
) -> threading.Event | None:
    if parent_pid is None or parent_pid <= 0:
        return None
    stop_event = threading.Event()

    def _watch() -> None:
        while not stop_event.wait(max(float(interval_seconds), 0.1)):
            if check_process_exists(parent_pid):
                continue
            logger.warning("background worker parent disappeared; exiting")
            exit_fn(0)
            return

    thread = threading.Thread(
        target=_watch,
        daemon=True,
        name=f"background-parent-watch:{parent_pid}",
    )
    thread.start()
    return stop_event


def main(argv: list[str] | None = None) -> int:
    args = list(argv or sys.argv[1:])
    if len(args) != 2:
        raise SystemExit("usage: python -m sidecar.runtime.background_worker <task> <payload.json>")

    task_name = str(args[0] or "").strip()
    payload_path = Path(args[1]).expanduser()
    handler = TASK_HANDLERS.get(task_name)
    if handler is None:
        raise SystemExit(f"unknown background task: {task_name}")

    # Read the control pipe BEFORE the payload file. argv/handler validation
    # above is pure, so it cannot block, but the payload read can raise (missing
    # file, bad JSON) -- and if it raised first, the parent's frame write would
    # block until this process exits. Draining stdin first frees the parent on
    # every path. The frame is in-memory only and is never re-serialized.
    secrets = read_secrets_frame(getattr(sys.stdin, "buffer", None))
    payload = _read_worker_payload(payload_path)
    if secrets:
        payload["secrets"] = secrets

    raw_config = payload.get("config")
    log_level = "info"
    capture_mode = "redacted"
    if isinstance(raw_config, dict):
        log_level = str(raw_config.get("diagnostics_log_level") or "info")
        capture_mode = str(raw_config.get("diagnostics_capture_mode") or "redacted")
    configure_sidecar_logging(_log_path(), log_level=log_level, capture_mode=capture_mode)
    stop_watchdog = start_parent_watchdog(_background_parent_pid())
    try:
        result = handler(payload)
        result_keys = sorted(str(key) for key in result)[:20] if isinstance(result, dict) else []
        logger.info(
            "background task completed",
            extra={
                "event": "sidecar.runtime.background_worker.completed",
                "task_name": task_name,
                "result_key_count": len(result) if isinstance(result, dict) else 0,
                "result_keys": result_keys,
            },
        )
        return 0
    finally:
        if stop_watchdog is not None:
            stop_watchdog.set()
        shutdown_sidecar_logging()


def _background_parent_pid() -> int | None:
    raw_value = read_environment_value("JENNY_BACKGROUND_PARENT_PID")
    if not raw_value:
        return None
    try:
        parsed = int(raw_value)
    except ValueError:
        return None
    return parsed if parsed > 0 else None


def _read_worker_payload(payload_path: Path) -> dict[str, Any]:
    try:
        initial = payload_path.lstat()
    except OSError as error:
        raise SystemExit("background payload is unavailable") from error
    if not stat.S_ISREG(initial.st_mode) or payload_path.is_symlink():
        raise SystemExit("background payload must be a regular file")
    if initial.st_size > MAX_BACKGROUND_PAYLOAD_BYTES:
        raise SystemExit("background payload exceeds its byte limit")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(payload_path), flags)
    except OSError as error:
        raise SystemExit("background payload could not be opened") from error
    try:
        opened = os.fstat(fd)
        if (initial.st_dev, initial.st_ino) != (opened.st_dev, opened.st_ino):
            raise SystemExit("background payload identity changed before read")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw_payload = read_bounded_bytes(
                stream,
                max_bytes=MAX_BACKGROUND_PAYLOAD_BYTES,
            )
    finally:
        os.close(fd)
    try:
        payload = json.loads(raw_payload.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise SystemExit("background payload must be valid JSON") from error
    if not isinstance(payload, dict):
        raise SystemExit("background payload must be a JSON object")
    return payload


def _log_path() -> Path:
    return Path.home() / ".companion" / "logs" / "sidecar.log"


if __name__ == "__main__":
    raise SystemExit(main())
