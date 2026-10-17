"""Conservative recovery shared with Electron by versioned decision fixtures."""

from __future__ import annotations

import logging
import os
import signal
import time
from typing import Any, Callable

from sidecar.runtime.owned_process_identity import read_identity
from sidecar.runtime.owned_process_ledger import OwnedProcessLedger, valid_identity

logger = logging.getLogger(__name__)
TERM_GRACE_SECONDS = 2.0
SWEEP_BUDGET_SECONDS = 8.0


def decide(entry: dict[str, Any], owner: dict[str, Any], process: dict[str, Any], uid: int) -> str:
    if not valid_identity(entry.get("owner")) or not valid_identity(entry.get("process")):
        return "retain"
    if owner.get("state") == "alive" and owner.get("identity") == entry["owner"]:
        return "preserve"
    if (
        owner.get("state") not in {"alive", "missing"}
        or (owner.get("state") == "alive" and not valid_identity(owner.get("identity")))
        or process.get("state") != "alive"
        or not valid_identity(process.get("identity"))
    ):
        return "retain"
    if process["identity"] != entry["process"]:
        return "drop"
    identity = process["identity"]
    if identity["uid"] != uid or identity["pgid"] != identity["pid"]:
        return "retain"
    return "reap"


def recover(
    ledger: OwnedProcessLedger,
    *,
    read: Callable[[int], dict[str, Any]] = read_identity,
    send: Callable[[int, int], None] | None = None,
    uid: int | None = None,
    wait: Callable[[float], None] = time.sleep,
) -> dict[str, int]:
    """Never hold a file lock across TERM grace or promote absence into proof."""
    if send is None:
        send = getattr(os, "killpg", None)
    if uid is None:
        uid = getattr(os, "getuid", lambda: -1)()
    counts = {"preserve": 0, "retain": 0, "drop": 0, "reap": 0}
    deadline = time.monotonic() + SWEEP_BUDGET_SECONDS
    for key, entry in ledger.snapshot().items():
        if time.monotonic() >= deadline:
            break
        action = decide(entry, read(entry["owner"]["pid"]), read(entry["process"]["pid"]), uid)
        if time.monotonic() >= deadline:
            break
        if action == "reap" and not callable(send):
            action = "retain"
        counts[action] += 1
        if action == "drop":
            ledger.forget(key, entry, deadline=deadline)
            logger.warning("owned_ledger.identity_unconfirmed entry=%s", key)
        elif action == "retain" and entry.get("state") != "unconfirmed":
            ledger.mark_unconfirmed(key, entry, deadline=deadline)
        elif action == "reap" and callable(send):
            _reap_entry(
                ledger, key, entry, read=read, send=send, uid=uid, wait=wait, deadline=deadline
            )
    return counts


def _reap_entry(  # noqa: PLR0913 -- injected OS boundaries keep signal decisions testable.
    ledger: OwnedProcessLedger,
    key: str,
    entry: dict[str, Any],
    *,
    read: Callable[[int], dict[str, Any]],
    send: Callable[[int, int], None],
    uid: int,
    wait: Callable[[float], None],
    deadline: float,
) -> None:
    for sig in (signal.SIGTERM, getattr(signal, "SIGKILL", signal.SIGTERM)):
        if time.monotonic() >= deadline or ledger.snapshot().get(key) != entry:
            return
        action = decide(entry, read(entry["owner"]["pid"]), read(entry["process"]["pid"]), uid)
        if action != "reap":
            if action == "drop":
                ledger.forget(key, entry, deadline=deadline)
            elif action != "preserve":
                ledger.mark_unconfirmed(key, entry, deadline=deadline)
            return
        if time.monotonic() >= deadline:
            return
        try:
            send(entry["process"]["pgid"], sig)
        except OSError:
            break
        if sig == signal.SIGTERM:
            wait(min(TERM_GRACE_SECONDS, max(0.0, deadline - time.monotonic())))
    # Recovery has no access to the original supervisor proof pipe. Even a
    # successful signal and a missing group must retain the uncertain receipt.
    ledger.mark_unconfirmed(key, entry, deadline=deadline)
    logger.warning("owned_ledger.retained entry=%s cleanup=unconfirmed", key)
