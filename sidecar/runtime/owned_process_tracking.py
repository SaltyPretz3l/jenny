"""Configured launch hooks shared by the sidecar and its builtin tool host."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from sidecar.runtime.owned_process_ledger import OwnedProcessLedger

logger = logging.getLogger(__name__)
_ledger: OwnedProcessLedger | None = None
_owner: dict[str, Any] | None = None


def read_identity(pid: int) -> dict[str, Any]:
    from sidecar.runtime.owned_process_identity import read_identity as read

    return read(pid)


def configure(path: object, *, owner_pid: int | None = None, sweep: bool = False) -> None:
    global _ledger, _owner  # noqa: PLW0603 -- explicit configured process-global owner.
    if os.name == "nt" or not isinstance(path, str) or not path:
        _ledger, _owner = None, None
        return
    _ledger, _owner = None, None
    candidate = Path(path)
    if not candidate.is_absolute():
        logger.warning("runtime.owned_ledger.invalid_path")
        return
    from sidecar.runtime.owned_process_ledger import OwnedProcessLedger

    _ledger = OwnedProcessLedger(candidate)
    _owner = read_identity(owner_pid or os.getpid()).get("identity")
    if sweep:
        from sidecar.runtime.owned_process_recovery import recover

        recover(_ledger)


Ticket = tuple["OwnedProcessLedger", str, dict[str, Any]]


def record(pid: int, kind: str = "owned_process", *, handoff_host: bool = False) -> Ticket | None:
    if _ledger is None or _owner is None:
        return None
    identity = read_identity(pid).get("identity")
    if not identity or identity["pgid"] != pid or identity["uid"] != _owner["uid"]:
        logger.warning("runtime.owned_ledger.identity_unavailable pid=%s", pid)
        return None
    key = _ledger.record(
        _owner,
        identity,
        kind,
        host=read_identity(os.getpid()).get("identity"),
        handoff_host=handoff_host,
    )
    if not key:
        return None
    entry = _ledger.snapshot().get(key)
    return (_ledger, key, {**entry, "owner": _owner}) if entry else None


def settle(ticket: Ticket | None, *, confirmed: bool) -> None:
    if ticket is None:
        return
    ledger, key, entry = ticket
    current = ledger.snapshot().get(key)
    original = current in (entry, {**entry, "state": "unconfirmed"})
    transferred = bool(
        current
        and current.get("handoff", {}).get("origin_owner") == entry["owner"]
        and current.get("process") == entry["process"]
    )
    if not isinstance(current, dict) or (not original and not transferred):
        return
    entry = current
    if confirmed:
        ledger.forget(key, entry)
    else:
        ledger.mark_unconfirmed(key, entry)


def preserve_transport(ticket: Ticket | None) -> bool:
    if ticket is None:
        return False
    from sidecar.runtime.owned_process_handoff import preserved

    return preserved(ticket[0], ticket[2])


def drain_handoff(active: Any) -> None:
    if _ledger is not None:
        from sidecar.runtime.owned_process_handoff import drain_handed_off_host

        # A onefile host was launched (and recorded) as its bootloader parent.
        frozen = getattr(sys, "frozen", False)
        drain_handed_off_host(_ledger, {os.getpid(), *([os.getppid()] if frozen else [])}, active)


def configure_managed(raw: dict[str, Any]) -> None:
    configure(raw.get("owned_process_ledger_path"))
    if _ledger is None or _owner is None:
        return
    transfer = raw.get("owned_process_handoff")
    if isinstance(transfer, dict):
        from sidecar.runtime.owned_process_handoff import adopt

        adopt(_ledger, _owner, transfer.get("guardian", {}), str(transfer.get("token", "")))
    from sidecar.runtime.owned_process_recovery import recover

    recover(_ledger)


def close_transport(ticket: Ticket | None, terminate: Any) -> bool:
    if preserve_transport(ticket):
        return True
    terminate()
    settle(ticket, confirmed=False)
    return False
