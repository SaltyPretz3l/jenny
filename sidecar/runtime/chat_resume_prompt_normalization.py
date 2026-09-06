"""Volatile-prompt normalization for approval-plan drift validation.

Split out of ``chat_resume`` on line-cap pressure. It is a self-contained unit
-- one function, its constants, and the workspace-manifest line prefixes it
keys on -- with no dependency on the rest of the resume path, so it moves whole
rather than being trimmed.
"""

from __future__ import annotations

import re

from sidecar.ai.tools.workspace_manifest import (
    MANIFEST_ENTRY_POINTS_LINE_PREFIX,
    MANIFEST_GENERATED_LINE_PREFIX,
    MANIFEST_GIT_LINE_PREFIX,
    MANIFEST_PROJECT_TYPE_LINE_PREFIX,
    MANIFEST_TOP_DIRS_LINE_PREFIX,
    WORKSPACE_MANIFEST_PROMPT_HEADING,
)

_MANIFEST_VOLATILE_BLOCK_PLACEHOLDER = "<workspace-manifest-volatile>"

# The value lines the manifest renderer emits after ``Generated:``. Each is
# rebuilt from the live filesystem, so each moves for the same reason the
# timestamp does -- only slower, and usually because of the turn itself.
_MANIFEST_VOLATILE_LINE_PREFIXES = (
    MANIFEST_PROJECT_TYPE_LINE_PREFIX,
    MANIFEST_TOP_DIRS_LINE_PREFIX,
    MANIFEST_ENTRY_POINTS_LINE_PREFIX,
    MANIFEST_GIT_LINE_PREFIX,
)

# The rendered value is a single timestamp token (or ``unknown``) plus an
# optional `` (partial)`` truncation suffix. Anything else after the prefix --
# e.g. instruction prose inside a heading-shaped block echoed from project
# content -- is NOT forgiven: fail closed to the strict comparison so material
# text can never hide behind the volatile-line normalization.
_MANIFEST_GENERATED_LINE_PATTERN = re.compile(
    rf"^{re.escape(MANIFEST_GENERATED_LINE_PREFIX)}\S+( \(partial\))?$"
)


def normalize_volatile_system_prompt_text(text: str) -> str:
    """Neutralize the workspace-manifest block while a turn is paused.

    The block is regenerated from the live filesystem on the manifest cache's
    30s soft TTL, including while a turn sits at a manual tool approval. Its
    ``Generated:`` timestamp was already forgiven here; the rest of the block
    was not, and that was wrong for the case that dominates -- a turn whose OWN
    approved ``write_file`` calls create a directory changes ``Top
    directories:`` a few rounds later, and is then preempted for drifting away
    from a plan it was faithfully executing. The longer and more productive the
    turn, the more certain it was to kill itself.

    So the whole rendered block collapses to one placeholder on BOTH sides. It
    is orientation, not authorization: nothing the user approved depends on it,
    and the model still receives the live block plus ``workspace_manifest_read``
    for current detail.

    Fail closed, unchanged in spirit: only the FIRST block is collapsed, only
    lines the renderer itself emits are consumed, and the run stops at the first
    line that is not one of them -- so a ``## Workspace Manifest`` heading
    echoed out of project content cannot hide material prose behind the
    normalization. What this gives up is narrow and worth stating: a directory
    created DURING the approval pause whose NAME carries prose is no longer
    compared. Content present on both sides was never drift to begin with.
    """
    normalized = str(text or "")
    if WORKSPACE_MANIFEST_PROMPT_HEADING not in normalized:
        return normalized
    lines = normalized.split("\n")
    out: list[str] = []
    index = 0
    total = len(lines)
    collapsed = False
    while index < total:
        line = lines[index]
        out.append(line)
        index += 1
        if collapsed or line != WORKSPACE_MANIFEST_PROMPT_HEADING:
            continue
        # The timestamp keeps its strict single-token shape. A ``Generated:``
        # line carrying prose is not the renderer's, so nothing after it is
        # treated as the renderer's either and the block is left alone.
        start = index
        if index < total and _MANIFEST_GENERATED_LINE_PATTERN.match(lines[index]):
            index += 1
            while index < total and lines[index].startswith(
                _MANIFEST_VOLATILE_LINE_PREFIXES
            ):
                index += 1
        if index > start:
            out.append(_MANIFEST_VOLATILE_BLOCK_PLACEHOLDER)
            collapsed = True
    return "\n".join(out)
