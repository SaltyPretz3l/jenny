"""Private stdlib-only ledger mutation helper for the Electron host.

Uses the same native advisory lock as Python writers. The application passes the
profile path and a bounded operation on stdin; there is no shell command or tool
surface. Packaged and source sidecars expose this before server initialization.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from sidecar.runtime.owned_process_handoff import frozen_owner, prepare
from sidecar.runtime.owned_process_identity import read_identity
from sidecar.runtime.owned_process_ledger import MAX_LEDGER_BYTES, OwnedProcessLedger


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    path = Path(request["path"])
    if not path.is_absolute():
        raise ValueError("ledger path must be absolute")
    ledger = OwnedProcessLedger(path)
    operation = request.get("operation")
    if operation == "prepare":
        # Electron knows a packaged onefile sidecar only by its bootloader pid.
        frozen = getattr(sys, "frozen", False)
        owner_pid = request["owner_pid"]
        old = frozen_owner(owner_pid) if frozen else read_identity(owner_pid).get("identity", {})
        guardian = read_identity(request["guardian_pid"]).get("identity", {})
        count = prepare(ledger, old, guardian, request["token"])
        return {"ok": count >= 0, "count": count, "guardian": guardian}
    if operation == "forget":
        return {"ok": ledger.forget(request["key"], request["expected"])}
    if operation == "retain":
        return {"ok": ledger.mark_unconfirmed(request["key"], request["expected"])}
    raise ValueError("unknown ledger operation")


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_LEDGER_BYTES + 1)
        if len(raw) > MAX_LEDGER_BYTES:
            raise ValueError("ledger operation too large")
        request = json.loads(raw)
        result = dispatch(request)
    except (OSError, ValueError, TypeError, KeyError):
        result = {"ok": False, "reason": "ledger_operation_failed"}
    sys.stdout.write(json.dumps(result) + "\n")
    return 0 if result.get("ok") else 1
