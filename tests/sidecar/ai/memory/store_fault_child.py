"""Child process for the memory-store crash rows (M1-M3).

Usage: ``python store_fault_child.py <mode> <db_path> <count>``. A crash is
``os._exit(137)`` at a marked step: no finaliser, no SQLite close, exactly the
state a killed process leaves. One ``ack <index>`` line is printed (and
flushed) only after the store call for that memory returned.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

CRASH_EXIT_CODE = 137


def memory_text(index: int) -> str:
    return f"Fault fixture memory {index} prefers oolong tea."


def _ack(index: int) -> None:
    print(f"ack {index}", flush=True)


def _save(store: object, index: int) -> None:
    from tests.sidecar.ai.memory.memory_v9_helpers import remember

    result = remember(store, memory_text(index))  # type: ignore[arg-type]
    assert result.status == "saved", result


def _crash() -> None:
    os._exit(CRASH_EXIT_CODE)


def _run_saves(db_path: Path, count: int) -> None:
    from sidecar.ai.memory.store import MemoryStore

    store = MemoryStore(db_path)
    for index in range(count):
        _save(store, index)
        _ack(index)
    _crash()


def _run_crash_before_commit(db_path: Path, count: int) -> None:
    """Save ``count`` memories, then die inside the next write, before its commit."""

    from sidecar.ai.memory.store import MemoryStore
    from sidecar.ai.memory.store_shared import _transaction

    @contextmanager
    def _crash_before_commit(self: MemoryStore) -> Iterator[None]:
        with _transaction(self._connection):
            yield
            # The insert has run inside the open transaction; commit has not.
            _crash()

    store = MemoryStore(db_path)
    for index in range(count):
        _save(store, index)
        _ack(index)
    MemoryStore._write_transaction = _crash_before_commit  # type: ignore[method-assign,assignment]
    _save(store, count)
    _crash()  # pragma: no cover - the patched transaction exits first.


def _run_crash_in_v10_migration(db_path: Path, _count: int) -> None:
    """Open a v9 database and die after the real v9 -> v10 step, before commit."""

    from sidecar.ai.memory import store_v10_migration
    from sidecar.ai.memory.store import MemoryStore

    real = store_v10_migration.migrate_v9_to_v10

    def _migrate_then_crash(*args: object, **kwargs: object) -> None:
        real(*args, **kwargs)  # type: ignore[arg-type]
        _crash()

    store_v10_migration.migrate_v9_to_v10 = _migrate_then_crash  # type: ignore[assignment]
    MemoryStore(db_path)
    _crash()  # pragma: no cover - the patched migration exits first.


MODES = {
    "saves": _run_saves,
    "crash_before_commit": _run_crash_before_commit,
    "crash_in_v10_migration": _run_crash_in_v10_migration,
}


def main(argv: list[str]) -> int:
    mode, db_path, count = argv[1], Path(argv[2]), int(argv[3])
    MODES[mode](db_path, count)
    return 2  # unreachable: every mode ends in os._exit


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
