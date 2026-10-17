"""Versioned per-profile owned-process records; atomic, serialized, best effort.

The lock is an OS advisory lock on a stable sibling inode, never the replaced
JSON file. Mutations are compare-and-swap by full entry, so recovery never holds
the lock while waiting for a process and cannot erase a concurrent handoff.
"""

from __future__ import annotations

import contextlib
import errno
import json
import logging
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Iterator

logger = logging.getLogger(__name__)
MAX_LEDGER_BYTES = 4 * 1024 * 1024
MAX_UNCONFIRMED = 50
MAX_HANDOFFS = 50
MIN_TOKEN_CHARS = 32
MAX_TOKEN_CHARS = 128
MAX_ENTRIES = 4096
MAX_IDENTITY_CHARS = 4096
KINDS = {"owned_process", "background_job", "python_sandbox", "mcp_stdio"}
_LOCKS: dict[str, threading.RLock] = {}
_CONTENTION = {
    errno.EAGAIN,
    errno.EWOULDBLOCK,
    errno.EACCES,
    getattr(errno, "EDEADLOCK", errno.EDEADLK),
}
_LOCKS_GUARD = threading.Lock()


def valid_identity(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    return (
        all(type(value.get(k)) is int and value[k] > 0 for k in ("pid", "pgid"))
        and type(value.get("uid")) is int
        and value["uid"] >= 0
        and all(
            isinstance(value.get(k), str) and 0 < len(value[k]) <= MAX_IDENTITY_CHARS
            for k in ("start", "exe", "command_hash")
        )
    )


def _process_gone(process: dict[str, Any]) -> bool:
    from sidecar.runtime.owned_process_identity import read_identity

    observed = read_identity(process["pid"])
    return observed.get("state") == "missing" or (
        observed.get("state") == "alive" and observed.get("identity") != process
    )


@contextlib.contextmanager
def _file_lock(path: Path, deadline: float) -> Iterator[None]:
    """OS releases the lock even after SIGKILL; Windows only supports fixtures."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if os.name == "nt":
            import msvcrt

            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()

            def lock() -> None:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)

            def unlock() -> None:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            flock = getattr(fcntl, "flock", None)
            if not callable(flock):
                raise OSError("POSIX locking unavailable")
            exclusive = getattr(fcntl, "LOCK_EX", 0) | getattr(fcntl, "LOCK_NB", 0)

            def lock() -> None:
                flock(handle.fileno(), exclusive)

            def unlock() -> None:
                flock(handle.fileno(), getattr(fcntl, "LOCK_UN", 0))

        while True:
            try:
                lock()
                break
            except OSError as error:
                # Only contention is worth waiting for; an unsupported lock fails now.
                if error.errno not in _CONTENTION or time.monotonic() >= deadline:
                    raise TimeoutError("owned ledger lock unavailable") from None
                time.sleep(0.01)
        try:
            yield
        finally:
            unlock()


class OwnedProcessLedger:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        with _LOCKS_GUARD:
            self._lock = _LOCKS.setdefault(str(self.path.absolute()), threading.RLock())

    def _read(self) -> dict[str, Any]:
        try:
            with self.path.open("rb") as stream:
                raw = stream.read(MAX_LEDGER_BYTES + 1)
        except FileNotFoundError:
            return {"version": 1, "entries": {}}
        if len(raw) > MAX_LEDGER_BYTES:
            raise ValueError("owned ledger exceeds limit")
        value = json.loads(raw)
        if not isinstance(value, dict) or value.get("version") != 1:
            raise ValueError("unsupported owned ledger version")
        entries = value.get("entries")
        if not isinstance(entries, dict) or len(entries) > MAX_ENTRIES:
            raise ValueError("invalid owned ledger entries")
        handoffs = value.get("handoffs", [])
        if (
            not isinstance(handoffs, list)
            or len(handoffs) > MAX_HANDOFFS
            or any(
                not isinstance(h, dict)
                or not all(valid_identity(h.get(k)) for k in ("origin_owner", "owner", "guardian"))
                or not isinstance(h.get("token"), str)
                or not MIN_TOKEN_CHARS <= len(h["token"]) <= MAX_TOKEN_CHARS
                for h in handoffs
            )
        ):
            raise ValueError("invalid owned ledger handoffs")
        for key, entry in entries.items():
            if (
                not isinstance(key, str)
                or not isinstance(entry, dict)
                or entry.get("id") != key
                or not valid_identity(entry.get("owner"))
                or not valid_identity(entry.get("process"))
                or entry.get("kind") not in KINDS
                or type(entry.get("created_at")) not in {int, float}
                or entry.get("state") not in {"active", "unconfirmed"}
                or not isinstance(entry.get("handoff", {}), dict)
                or not valid_identity(entry.get("host", entry["owner"]))
            ):
                raise ValueError("invalid owned ledger identity")
        return value

    def snapshot(self) -> dict[str, Any]:
        try:
            # Atomic replacement permits readers without the writer lock.
            return self._read()["entries"]
        except (OSError, ValueError, TypeError, RecursionError):
            logger.warning("owned_ledger.read_failed", exc_info=True)
            return {}

    def _mutate(
        self, change: Callable[[dict[str, Any]], Any], *, deadline: float | None = None
    ) -> Any:
        return self.mutate_document(lambda value: change(value["entries"]), deadline=deadline)

    def mutate_document(
        self, change: Callable[[dict[str, Any]], Any], *, deadline: float | None = None
    ) -> Any:
        temp: str | None = None
        deadline = (
            min(deadline, time.monotonic() + 2.0)
            if deadline is not None
            else time.monotonic() + 2.0
        )
        acquired = False
        try:
            acquired = self._lock.acquire(timeout=max(0.0, deadline - time.monotonic()))
            if not acquired or time.monotonic() >= deadline:
                raise TimeoutError("owned ledger lock unavailable")
            with _file_lock(self.path.with_suffix(self.path.suffix + ".lock"), deadline):
                value = self._read()
                result = change(value)
                if len(value["entries"]) > MAX_ENTRIES:
                    raise ValueError("owned ledger entry limit")
                raw = json.dumps(value, ensure_ascii=True, allow_nan=False).encode("utf-8")
                if len(raw) > MAX_LEDGER_BYTES:
                    raise ValueError("owned ledger exceeds limit")
                fd, temp = tempfile.mkstemp(prefix=self.path.name + ".", dir=self.path.parent)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temp, self.path)
                temp = None
                return result
        except (OSError, ValueError, TypeError, RecursionError):
            logger.warning("runtime.owned_ledger.write_failed", exc_info=True)
            return None
        finally:
            if acquired:
                self._lock.release()
            if temp:
                with contextlib.suppress(OSError):
                    os.unlink(temp)

    def record(
        self,
        owner: dict[str, Any],
        process: dict[str, Any],
        kind: str,
        *,
        host: dict[str, Any] | None = None,
        handoff_host: bool = False,
    ) -> str | None:
        if kind not in KINDS or not valid_identity(owner) or not valid_identity(process):
            return None
        key = "op_" + uuid.uuid4().hex
        entry = {
            "id": key,
            "owner": owner,
            "process": process,
            "kind": kind,
            "created_at": time.time(),
            "state": "active",
            "host": host or owner,
            "handoff_host": handoff_host,
        }

        def insert(value: dict[str, Any]) -> str:
            from sidecar.runtime.owned_process_handoff import inherit_launch

            value["entries"][key] = inherit_launch(entry, value.get("handoffs", []))
            return key

        return self.mutate_document(insert)

    def forget(self, key: str, expected: dict[str, Any], *, deadline: float | None = None) -> bool:
        def remove(entries: dict[str, Any]) -> bool:
            if entries.get(key) != expected:
                return False
            del entries[key]
            return True

        return bool(self._mutate(remove, deadline=deadline))

    def mark_unconfirmed(
        self, key: str, expected: dict[str, Any], *, deadline: float | None = None
    ) -> bool:
        def mark(entries: dict[str, Any]) -> bool:
            if entries.get(key) != expected:
                return False
            entries[key] = {**expected, "state": "unconfirmed"}
            # Evict receipts whose process is provably gone before a possible live leak.
            retained = sorted(
                (v for v in entries.values() if v.get("state") == "unconfirmed"),
                key=lambda v: (not _process_gone(v["process"]), v["created_at"], v["id"]),
            )
            for entry in retained[:-MAX_UNCONFIRMED]:
                del entries[entry["id"]]
                logger.warning("owned_ledger.retention_dropped entry=%s", entry["id"])
            return True

        return bool(self._mutate(mark, deadline=deadline))
