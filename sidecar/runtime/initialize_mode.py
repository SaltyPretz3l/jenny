"""Fail-closed discriminator for the ``initialize`` RPC's ``mode`` field.

Normative source: ``PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md``, PLUG-D16 --
"Repeated `initialize` remains the fixed sidecar reconfiguration seam, but an
explicit plugin-only mode updates a nested plugin-runtime generation without
rebuilding unrelated `BrainStack` resources or rerunning startup side effects;
rejection preserves the prior initialized runtime and plugin generation."

Stage 4A accepts a second exact mode that reconfigures only the nested plugin
runtime generation without touching the BrainStack. A malformed or hostile
``mode`` can never be silently treated as a request for full-runtime
reconfiguration: an ``initialize`` with no ``mode`` field keeps behaving
exactly as it does today (``FULL_RUNTIME_MODE``, accepted), the exact
``plugin_runtime`` token selects the plugin-only branch, and anything else is
rejected outright. None of these rejection paths may cause any runtime
mutation -- see the call site in
``sidecar/runtime/request_dispatch.py``, which invokes
``resolve_initialize_mode`` before any secret merge, logging-preference
application, or version validation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

# Default mode for initialize requests that omit mode; omission preserves
# full-runtime initialization behavior.
FULL_RUNTIME_MODE: Final[str] = "full_runtime"

# Exact Stage-4A plugin-only reconfiguration discriminator (PLUG-D16).
PLUGIN_RUNTIME_MODE: Final[str] = "plugin_runtime"

REASON_UNKNOWN_INITIALIZE_MODE: Final[str] = "unknown_initialize_mode"

# Bound on the redacted mode value echoed back in a rejection. This is a
# diagnostic breadcrumb, not a place to reflect attacker-controlled payload
# content back into logs or wire responses.
_MAX_MODE_DISPLAY_CHARS: Final[int] = 32
_TRUNCATION_SUFFIX: Final[str] = "...<truncated>"


def _bounded_mode_display(raw_mode: object) -> str:
    """Render ``raw_mode`` as a short, log-safe token for a rejection reason.

    Never echoes ``repr()`` of a non-string value: a repr is unbounded
    (nested containers, huge numbers) and can round-trip attacker-controlled
    structure back into a log line or wire response. Non-string modes are
    represented only by their type name; strings are capped to a short length.
    """
    if not isinstance(raw_mode, str):
        return f"<{type(raw_mode).__name__}>"
    if len(raw_mode) <= _MAX_MODE_DISPLAY_CHARS:
        return raw_mode
    keep = max(0, _MAX_MODE_DISPLAY_CHARS - len(_TRUNCATION_SUFFIX))
    return f"{raw_mode[:keep]}{_TRUNCATION_SUFFIX}"


@dataclass(frozen=True)
class InitializeModeResolution:
    """Result of resolving an ``initialize`` request's ``mode`` field.

    ``mode`` is only meaningful when ``ok`` is True -- callers MUST branch on
    ``ok`` first. A rejected resolution never carries a mode a caller should
    act on; it exists to be turned into an error response, not consulted for
    behavior. ``rejected_mode`` is a bounded, redacted display string for the
    offending raw value (``None`` when ``ok`` is True).
    """

    mode: str
    ok: bool
    reason: str | None
    rejected_mode: str | None = None


def resolve_initialize_mode(params: Any) -> InitializeModeResolution:
    """Fail-closed resolution of the ``mode`` field of an ``initialize`` call.

    PLUG-D16: a malformed or hostile ``mode`` must never be silently treated
    as a full-runtime initialize. Absence of ``mode`` is the one case that
    must reproduce today's behavior exactly, since every existing caller
    omits it.
    """
    if not isinstance(params, dict) or "mode" not in params:
        return InitializeModeResolution(mode=FULL_RUNTIME_MODE, ok=True, reason=None)

    raw_mode = params["mode"]

    # Exact, un-normalized string comparison only. Case differences,
    # surrounding whitespace, or any other near-miss must NOT be coerced into
    # a match -- coercing would let an attacker-supplied variant such as
    # "Full_Runtime" or " full_runtime " slip through as if canonical.
    if isinstance(raw_mode, str) and raw_mode == FULL_RUNTIME_MODE:
        return InitializeModeResolution(mode=FULL_RUNTIME_MODE, ok=True, reason=None)

    if isinstance(raw_mode, str) and raw_mode == PLUGIN_RUNTIME_MODE:
        return InitializeModeResolution(mode=PLUGIN_RUNTIME_MODE, ok=True, reason=None)

    return InitializeModeResolution(
        mode=FULL_RUNTIME_MODE,
        ok=False,
        reason=REASON_UNKNOWN_INITIALIZE_MODE,
        rejected_mode=_bounded_mode_display(raw_mode),
    )
