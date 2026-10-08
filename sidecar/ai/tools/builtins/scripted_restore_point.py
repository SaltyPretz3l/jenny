"""The restore point a ``scripted_change_review`` names (row 34 S5).

Routing records the run's auto-checkpoint outcome and hands it to builtin
scripted calls as the private ``_jenny_restore_point`` argument; the review
carries it for the user-only Changes UI, never for the model. Only three
shapes are admitted: ``git_checkpoint`` (a bounded
``refs/jenny/checkpoints/<session>/<n>`` ref plus the UTC time the sidecar saw
it created), ``head`` (the tree was clean, so HEAD is the restore point) and
``none`` with a reason from a fixed set.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

RESTORE_POINT_ARGUMENT_KEY = "_jenny_restore_point"
RESTORE_POINT_REASONS = frozenset({"not_git", "disabled", "failed", "unavailable"})
MAX_RESTORE_POINT_REF_CHARS = 200
_REF = re.compile(r"refs/jenny/checkpoints/[A-Za-z0-9._-]+/[0-9]+")
_UTC_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z")


def bounded_restore_point(value: object) -> dict[str, str] | None:
    """The record in one of its three shapes with only its own keys, else ``None``."""
    if not isinstance(value, Mapping):
        return None
    kind, ref, created_at = value.get("kind"), value.get("ref"), value.get("created_at")
    if not isinstance(created_at, str) or not _UTC_TIME.fullmatch(created_at):
        created_at = None
    if kind == "git_checkpoint" and created_at and isinstance(ref, str) and (
        len(ref) <= MAX_RESTORE_POINT_REF_CHARS and _REF.fullmatch(ref)
    ):
        return {"kind": kind, "ref": ref, "created_at": created_at}
    if kind == "head" and created_at:
        return {"kind": kind, "created_at": created_at}
    reason = value.get("reason")
    if kind == "none" and isinstance(reason, str) and reason in RESTORE_POINT_REASONS:
        return {"kind": kind, "reason": reason}
    return None


def restore_point_argument(arguments: Mapping[str, object]) -> dict[str, str] | None:
    """The bounded restore point routing passed a scripted call, if any."""
    return bounded_restore_point(arguments.get(RESTORE_POINT_ARGUMENT_KEY))
