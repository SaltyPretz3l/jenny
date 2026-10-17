"""Trusted normal restart retains the builtin host that drains background jobs."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable, Iterable

from sidecar.runtime.owned_process_identity import read_identity
from sidecar.runtime.owned_process_ledger import (
    MAX_HANDOFFS,
    MAX_TOKEN_CHARS,
    MIN_TOKEN_CHARS,
    OwnedProcessLedger,
    valid_identity,
)


def _live(identity: dict[str, Any], read: Callable) -> bool:
    return valid_identity(identity) and read(identity["pid"]).get("identity") == identity


def _transfer(entry: dict[str, Any], intent: dict[str, Any]) -> dict[str, Any]:
    return {
        **entry,
        "owner": intent["owner"],
        "handoff": {
            "token": intent["token"],
            "guardian": intent["guardian"],
            "origin_owner": entry.get("handoff", {}).get("origin_owner", entry["owner"]),
        },
    }


def inherit_launch(entry: dict[str, Any], intents: list[dict[str, Any]]) -> dict[str, Any]:
    """Called under the writer lock, including launches after the restart snapshot."""
    if entry["kind"] != "background_job" and not entry.get("handoff_host"):
        return entry
    for intent in intents:
        if intent["origin_owner"] == entry["owner"] and _live(intent["owner"], read_identity):
            return _transfer(entry, intent)
    return entry


def frozen_owner(
    pid: int,
    *,
    read: Callable = read_identity,
    proc_root: Path = Path("/proc"),
) -> dict[str, Any]:
    """A PyInstaller onefile bootloader's single same-binary child owns the ledger."""
    parent = read(pid).get("identity", {})
    children = []
    try:
        names = [n.name for n in proc_root.iterdir() if n.name.isdigit()]
    except OSError:
        return parent
    for name in names[:65536]:
        try:
            stat = (proc_root / name / "stat").read_text(encoding="utf-8")
            if int(stat[stat.rindex(")") + 2 :].split()[1]) != pid:
                continue
        except (OSError, ValueError, IndexError):
            continue
        child = read(int(name)).get("identity", {})
        if (
            valid_identity(parent)
            and valid_identity(child)
            and (child["exe"], child["uid"])
            == (
                parent["exe"],
                parent["uid"],
            )
        ):
            children.append(child)
    return children[0] if len(children) == 1 else parent


def prepare(
    ledger: OwnedProcessLedger,
    old: dict[str, Any],
    guardian: dict[str, Any],
    token: str,
    *,
    read: Callable = read_identity,
) -> int:
    if (
        not MIN_TOKEN_CHARS <= len(token) <= MAX_TOKEN_CHARS
        or not _live(old, read)
        or not _live(guardian, read)
        or old["uid"] != guardian["uid"]
    ):
        return -1

    def arm(value: dict[str, Any]) -> int:
        entries = value["entries"]
        # Keep origins whose old host can still finish an already admitted call.
        intents = [
            h
            for h in value.get("handoffs", [])
            if _live(h["origin_owner"], read)
            or any(
                e.get("handoff", {}).get("origin_owner") == h["origin_owner"]
                and _live(e["process"], read)
                for e in entries.values()
            )
        ]
        for h in intents:
            if h["owner"] == old:
                h.update(owner=guardian, guardian=guardian, token=token)
        if not any(h["origin_owner"] == old for h in intents):
            intents.append(
                {"origin_owner": old, "owner": guardian, "guardian": guardian, "token": token}
            )
        if len(intents) > MAX_HANDOFFS:
            raise ValueError("owned handoff intent limit")
        value["handoffs"] = intents
        backgrounds = [
            e
            for e in entries.values()
            if e["owner"] == old
            and e["kind"] == "background_job"
            and e["state"] == "active"
            and _live(e["process"], read)
        ]
        hosts = [e.get("host") for e in backgrounds]
        selected = [
            e
            for e in entries.values()
            if e in backgrounds
            or (
                e["owner"] == old
                and e["kind"] == "mcp_stdio"
                and (e.get("handoff_host") or e["process"] in hosts)
                and _live(e["process"], read)
            )
        ]
        for e in selected:
            entries[e["id"]] = _transfer(
                e, {"owner": guardian, "guardian": guardian, "token": token}
            )
        return len(selected)

    result = ledger.mutate_document(arm)
    return result if isinstance(result, int) else -1


def adopt(
    ledger: OwnedProcessLedger,
    new: dict[str, Any],
    guardian: dict[str, Any],
    token: str,
    *,
    read: Callable = read_identity,
) -> int:
    if (
        not MIN_TOKEN_CHARS <= len(token) <= MAX_TOKEN_CHARS
        or not _live(new, read)
        or not _live(guardian, read)
        or new["uid"] != guardian["uid"]
    ):
        return 0

    def take(value: dict[str, Any]) -> int:
        for intent in value.get("handoffs", []):
            if intent["owner"] == guardian and intent["token"] == token:
                intent["owner"] = new
        selected = [
            e
            for e in value["entries"].values()
            if e["owner"] == guardian
            and e.get("handoff", {}).get("token") == token
            and e.get("handoff", {}).get("guardian") == guardian
        ]
        for entry in selected:
            entry["owner"] = new
        return len(selected)

    return int(ledger.mutate_document(take) or 0)


def preserved(ledger: OwnedProcessLedger, entry: dict[str, Any]) -> bool:
    current = ledger.snapshot().get(entry["id"], {})
    handoff = current.get("handoff", {})
    return bool(
        current.get("process") == entry["process"]
        and handoff
        and handoff.get("origin_owner") == entry["owner"]
        and _live(current.get("owner", {}), read_identity)
    )


def transferred_job_live(pid: int, entry_id: str) -> bool:
    """The job's own handed-off ledger entry still names live process, owner and host.

    ``entry_id`` is the ledger receipt the job's running status persisted, so a job on a
    recycled pid never vouches for another job's record. The full identity match (start
    time included) keeps pid-reuse protection, and the original host must be alive because
    it is the writer that still publishes the terminal status.
    """
    from sidecar.runtime import owned_process_tracking

    ledger = owned_process_tracking._ledger
    if ledger is None:
        return False
    e = ledger.snapshot().get(entry_id)
    return bool(
        e
        and e["kind"] == "background_job"
        and e["process"]["pid"] == pid
        and e.get("handoff")
        and _live(e["process"], read_identity)
        and _live(e["owner"], read_identity)
        and _live(e.get("host", {}), read_identity)
    )


def drain_handed_off_host(
    ledger: OwnedProcessLedger, host_pids: Iterable[int], active: Callable[[], bool]
) -> None:
    """EOF admits no more tools; keep only existing status/output writers alive."""
    pids = set(host_pids)
    entry = next(
        (
            e
            for e in ledger.snapshot().values()
            if e["kind"] == "mcp_stdio"
            and e["process"]["pid"] in pids
            and e.get("handoff")
            and _live(e["process"], read_identity)
        ),
        None,
    )
    if not entry:
        return
    while active():
        current = ledger.snapshot().get(entry["id"])
        if not current or not _live(current["owner"], read_identity):
            break
        time.sleep(0.1)
    current = ledger.snapshot().get(entry["id"])
    if current:
        ledger.mark_unconfirmed(entry["id"], current)
