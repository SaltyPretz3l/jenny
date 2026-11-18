"""Spill a python run's cut stdout to a workspace file the model can read (T1).

Follows the long-command-output convention (``.jenny/tool-results/``, written
through the guarded store, swept by the workspace tool-result cleanup). The
spill is bounded; a cut says so at the end of the file.
"""

from __future__ import annotations

import logging
import uuid

from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore, WorkspaceStoreKind

MAX_SPILL_BYTES = 2 * 1024 * 1024
_CUT_MARKER = "\n...[full stdout cut at 2 MB]\n".encode()

logger = logging.getLogger(__name__)


def spill_stdout(store: GuardedWorkspaceStore, text: str) -> str | None:
    """Write ``text`` and return its workspace-relative path, or None if it was refused."""
    data = text.encode("utf-8", errors="replace")
    if len(data) > MAX_SPILL_BYTES:
        # Cut on a character boundary so the file stays valid UTF-8.
        data = data[:MAX_SPILL_BYTES].decode("utf-8", errors="ignore").encode("utf-8") + _CUT_MARKER
    try:
        ref = store.resolve(WorkspaceStoreKind.TOOL_RESULTS, f"python-{uuid.uuid4().hex[:16]}.txt")
        store.write_bytes_atomic(ref, data, max_bytes=MAX_SPILL_BYTES + len(_CUT_MARKER))
    except (ToolExecutionFailure, OSError):
        # Best effort, like the command-output spill: the truncated result still stands.
        logger.warning("guarded store refused python stdout persistence", exc_info=True)
        return None
    return store.display_path(ref)


def spill_note(path: str) -> str:
    return f"full stdout saved to {path} (read it with read_file)"
