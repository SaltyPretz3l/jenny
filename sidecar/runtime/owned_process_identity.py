"""Fresh Linux process identity; inaccessible and missing are distinct states."""
from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path
from typing import Any


def read_identity(pid: int, *, proc_root: Path = Path("/proc")) -> dict[str, Any]:
    if type(pid) is not int or pid <= 0 or not sys.platform.startswith("linux"):
        return {"state": "unknown"}
    root = proc_root / str(pid)
    try:
        before = (root / "stat").read_text(encoding="utf-8")
        fields = before[before.rindex(")") + 2:].split()
        with (root / "cmdline").open("rb") as stream:
            command = stream.read(1024 * 1024 + 1)
        if not command or len(command) > 1024 * 1024:
            return {"state": "unknown"}
        boot = (proc_root / "sys/kernel/random/boot_id").read_text().strip()
        identity = {"pid": pid, "pgid": int(fields[2]), "uid": root.stat().st_uid,
                    "start": boot + ":" + fields[19],
                    "exe": os.readlink(root / "exe"),
                    "command_hash": hashlib.sha256(command).hexdigest()}
        after = (root / "stat").read_text(encoding="utf-8")
        if before[before.rindex(")") + 2:].split()[19] != after[after.rindex(")") + 2:].split()[19]:
            return {"state": "unknown"}
        return {"state": "alive", "identity": identity}
    except FileNotFoundError:
        # A vanished exe/cmdline can mean a zombie or a racing exec. Only an
        # absent process directory establishes missing, never cleanup proof.
        return {"state": "unknown" if root.exists() else "missing"}
    except (OSError, ValueError, IndexError):
        return {"state": "unknown"}
