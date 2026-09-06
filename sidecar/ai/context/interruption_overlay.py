"""The ``## Previous Turn Interruption`` overlay: render, ledger merge, append.

Extracted from runtime_overlays.py when the W8-S3 ledger-merge wiring pushed
that module over the 600-line ratchet (extract, never cram). runtime_overlays
re-exports every public name here, so import sites are unchanged.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from sidecar.ai.context import runtime_message_markers
from sidecar.runtime.diagnostics import log_event

if TYPE_CHECKING:
    from sidecar.ai.context.runtime_overlays import RuntimeOverlayLogContext

# Defensive bounds on the Electron-supplied receipts payload -- it is our own
# process's data, but AGENTS.md 4/9 still require this render to survive a
# malformed or oversized payload without crashing or bloating the prompt.
# Keep these three in sync with services/backend/interrupted-turn-receipts.js's
# DEFAULT_RECEIPTS_CAP / MAX_TOOL_NAME / MAX_SUMMARY -- both sides intentionally
# duplicate the same bound across the process boundary rather than sharing a
# constant across the Electron/sidecar seam.
INTERRUPTED_TURN_MAX_ENTRIES_PER_SECTION = 20
_INTERRUPTED_TURN_MAX_TOOL_NAME = 80
_INTERRUPTED_TURN_MAX_SUMMARY = 200
_INTERRUPTED_TURN_MAX_PATH = 120
_INTERRUPTED_TURN_MAX_VERIFY_HINT = 120


def _flatten_interrupted_field(value: object, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _interrupted_receipt_lines(entries: Any, *, include_summary: bool) -> list[str]:
    """Render one receipts section, bounded and defensive against malformed rows.

    Electron-supplied fields (tool names, output summaries) can carry internal
    newlines/whitespace runs. Left unflattened, an embedded ``\\n`` could forge
    directive-looking lines (e.g. a fake markdown heading) inside this
    system-role block. Collapse every whitespace run to a single space with
    ``" ".join(value.split())`` BEFORE the length cap, so the cap counts
    rendered characters, not pre-injection ones. Mirrors the JS-side
    ``flattenWhitespace`` in services/backend/interrupted-turn-receipts.js.
    """
    if not isinstance(entries, list):
        return []
    lines: list[str] = []
    for entry in entries[:INTERRUPTED_TURN_MAX_ENTRIES_PER_SECTION]:
        if not isinstance(entry, dict):
            continue
        name = _flatten_interrupted_field(entry.get("tool_name"), _INTERRUPTED_TURN_MAX_TOOL_NAME)
        if not name:
            name = "(unknown tool)"
        if include_summary:
            summary = _flatten_interrupted_field(
                entry.get("summary"), _INTERRUPTED_TURN_MAX_SUMMARY
            )
            lines.append(f"- {name} -- {summary}" if summary else f"- {name}")
        else:
            operation_key = _flatten_interrupted_field(entry.get("operation_key"), 15)
            affected_path = _flatten_interrupted_field(
                entry.get("affected_path"), _INTERRUPTED_TURN_MAX_PATH
            )
            verify_hint = _flatten_interrupted_field(
                entry.get("verify_hint"), _INTERRUPTED_TURN_MAX_VERIFY_HINT
            )
            if not (operation_key or affected_path or verify_hint):
                lines.append(f"- {name}")
                continue
            details = [f"- {name}"]
            if operation_key:
                details.append(f"op {operation_key}")
            if affected_path:
                details.append(affected_path)
            if verify_hint:
                details.append(f"verify with: {verify_hint}")
            lines.append(" — ".join(details))
    return lines


def merge_ledger_interruptions(receipts: Any, ledger_entries: Any) -> dict[str, object]:
    """Merge durable pending receipts into the Electron interruption registry."""
    merged = dict(receipts) if isinstance(receipts, dict) else {}
    for section in ("completed", "failed", "unfinished"):
        value = merged.get(section)
        merged[section] = list(value) if isinstance(value, list) else []
    unfinished = merged["unfinished"]
    assert isinstance(unfinished, list)
    operation_keys = {
        str(entry.get("operation_key") or "")
        for entry in unfinished
        if isinstance(entry, dict) and entry.get("operation_key")
    }
    if not isinstance(ledger_entries, list):
        return merged
    for receipt in ledger_entries:
        if not isinstance(receipt, dict):
            continue
        operation_id = str(receipt.get("operation_id") or "").strip()
        if not operation_id or operation_id in operation_keys:
            continue
        evidence = receipt.get("evidence")
        evidence = evidence if isinstance(evidence, dict) else {}
        path = str(evidence.get("relative_path") or "").strip()
        row = {
            "tool_name": str(evidence.get("tool") or "operation_status"),
            "operation_key": operation_id,
            "affected_path": path,
            "verify_hint": f"read_file {path}" if path else "operation_status again later",
        }
        unfinished.append(row)
        operation_keys.add(operation_id)
    return merged


def _merge_dead_generation_ledger_receipts(
    receipts: Any, *, config: Any, mcp_client: Any
) -> Any:
    """Fold dead-generation ledger pendings into ``receipts``; fail closed.

    Liveness gate: the live builtin generation id (initialize handshake, via
    the public MCPClient accessor) separates in-flight work from interrupted
    work. Unknown liveness or ANY ledger error returns ``receipts`` unchanged
    -- exact legacy behavior, never a broken turn.
    """
    try:
        if mcp_client is None:
            return receipts
        # Local imports: config and the tool catalog both sit above this
        # module in the import graph on some paths; resolving them at call
        # time keeps the overlay import-cycle-free.
        from sidecar.ai.config import resolve_operation_ledger_root  # noqa: PLC0415
        from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME  # noqa: PLC0415
        from sidecar.runtime.operation_ledger import OperationLedger  # noqa: PLC0415

        live_gen = mcp_client.server_generation_id(BUILTIN_MCP_SERVER_NAME)
        if not live_gen:
            return receipts
        cfg = config if hasattr(config, "operation_ledger_root") else None
        root = resolve_operation_ledger_root(cfg)
        if not root.is_dir():
            return receipts
        ledger = OperationLedger(root)
        entries = ledger.pending_from_other_generations(live_gen)
        if not entries:
            return receipts
        merged = merge_ledger_interruptions(receipts, entries)
        if not isinstance(receipts, dict):
            merged["ledger_only"] = True
        return merged
    except Exception:  # noqa: BLE001
        return receipts


def _render_interrupted_turn_receipts_block(receipts: Any) -> str:
    """Render the ``## Previous Turn Interruption`` block, or ``""`` when empty.

    ``receipts`` is the Electron-computed ledger: ``completed``/``failed``/
    ``unfinished`` lists plus a ``truncated`` flag and ``total`` count. Returns
    ``""`` (no block) when the payload is not a dict or carries no renderable
    tool entries -- an interruption with nothing to attest is not worth a block.
    """
    if not isinstance(receipts, dict):
        return ""
    completed = _interrupted_receipt_lines(receipts.get("completed"), include_summary=True)
    failed = _interrupted_receipt_lines(receipts.get("failed"), include_summary=True)
    unfinished = _interrupted_receipt_lines(receipts.get("unfinished"), include_summary=False)
    if not (completed or failed or unfinished):
        return ""
    if receipts.get("ledger_only") is True:
        preamble = (
            "A durable operation ledger records side-effecting tool calls from another "
            "process -- an earlier interrupted run, or another live instance -- that "
            "started but were never confirmed complete. The ledger below is the truthful "
            "record of what those calls are known to have done."
        )
    else:
        preamble = (
            "The previous turn in this session was interrupted before it finished "
            "(a crash, kill, or dropped stream -- not a normal pause). The ledger "
            "below is the truthful record of what its tool calls actually did."
        )
    sections: list[str] = [
        runtime_message_markers.INTERRUPTED_TURN_HEADING,
        preamble,
    ]
    if completed:
        sections.append("Completed:\n" + "\n".join(completed))
    if failed:
        sections.append("Failed:\n" + "\n".join(failed))
    if unfinished:
        sections.append(
            "Unknown outcome (started but never confirmed complete):\n"
            + "\n".join(unfinished)
        )
    if receipts.get("truncated") is True:
        total = receipts.get("total")
        total_text = f" of {total}" if isinstance(total, int) and total > 0 else ""
        sections.append(
            f"(Only the most recent tool calls are shown{total_text}; "
            "earlier entries were truncated -- absent does not mean it did not run.)"
        )
    sections.append(
        "Treat this ledger as ground truth over any earlier narration. Verify the "
        "current state before repeating side-effectful work, and do not claim prior "
        "work succeeded unless it is listed under Completed."
    )
    return "\n\n".join(sections)


def append_interrupted_turn_receipts_runtime_system_message(
    runtime_system_messages: list[str],
    *,
    config: Any,
    receipts: Any,
    log_context: RuntimeOverlayLogContext,
    mcp_client: Any = None,
) -> None:
    """Append the ``## Previous Turn Interruption`` overlay when receipts exist.

    Flag-gated (``config.interrupted_turn_receipts_overlay_enabled``, default on)
    and fail-closed: a missing/malformed payload or any render failure degrades
    to a no-op (one counts-only WARNING), never a broken turn. ``receipts`` is
    ``None`` on every clean or approval-paused turn, so the common path returns
    before rendering anything.
    """
    if not getattr(config, "interrupted_turn_receipts_overlay_enabled", True):
        return
    receipts = _merge_dead_generation_ledger_receipts(
        receipts, config=config, mcp_client=mcp_client
    )
    if receipts is None:
        return
    try:
        block = _render_interrupted_turn_receipts_block(receipts)
    except Exception as error:  # noqa: BLE001
        log_event(
            log_context.logger,
            logging.WARNING,
            component=log_context.component,
            event=log_context.event,
            message="Interrupted-turn receipts overlay failed closed.",
            status="error",
            request_id=log_context.request_id,
            session_id=log_context.session_id,
            data={"error_type": error.__class__.__name__},
        )
        return
    if block:
        runtime_system_messages.append(block)
