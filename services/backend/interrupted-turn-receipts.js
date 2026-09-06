// Interrupted-turn receipts.
//
// When a turn dies hard -- crash, kill, or dropped stream, NOT an approval
// pause -- the turn-event journal partition for that turn is never cleared (a
// clean or properly-handled terminal settle clears it via the terminal
// coordinator's `_clearJournal`). A surviving, non-empty partition for a prior
// turn is therefore the hard-interruption signature.
//
// This module turns that surviving partition into a compact, truthful per-tool
// ledger that Electron forwards on the next `chat.send` so the sidecar overlay
// can hand the model ground truth about what its prior tool calls actually did,
// instead of letting it trust its own last "working on it..." narration.
//
// The journal stores persisted turn-event *kinds* (bare snake: `tool_use`,
// `tool_executing`, `tool_result`, `approval_requested`, `approval_resolved`,
// `assistant_error`), not canonical `type` events, so detection keys on `kind`.

const { buildCommitResult } = require('./conversation-store-port');
const { normalizeString } = require('../shared/normalize');

// Keep these three bounds in sync with sidecar/ai/context/runtime_overlays.py's
// INTERRUPTED_TURN_MAX_ENTRIES_PER_SECTION / _INTERRUPTED_TURN_MAX_TOOL_NAME /
// _INTERRUPTED_TURN_MAX_SUMMARY -- both sides bound the same Electron-computed
// receipts payload as it crosses the process boundary, and the sidecar side
// re-bounds it again defensively (AGENTS.md 4/9) rather than trusting this cap.
const DEFAULT_RECEIPTS_CAP = 20;
const MAX_TOOL_NAME = 80;
const MAX_SUMMARY = 200;

// A turn-level terminal marker in the surviving partition means the outcome was
// durably recorded (turn_failed/turn_cancelled reduce to `assistant_error`); a
// truly hard-interrupted turn never wrote one. Defense-in-depth on top of the
// clear-on-terminal invariant.
const TERMINAL_TURN_KINDS = new Set(['assistant_error']);
const TOOL_KINDS = new Set(['tool_use', 'tool_executing', 'tool_result']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Single unpack of the nested event shape every field helper below reads.
function eventSources(event) {
  const payload = isPlainObject(event.payload) ? event.payload : {};
  return {
    payload,
    toolCall: isPlainObject(payload.tool_call) ? payload.tool_call : {},
    toolResult: isPlainObject(payload.tool_result) ? payload.tool_result : {},
  };
}

// Tool-controlled strings (tool names, output summaries) reach this module
// with internal newlines/whitespace runs intact. Left unflattened, an
// embedded '\n' could forge directive-looking lines (e.g. a fake markdown
// heading) inside the system-role overlay this ledger renders into
// (runtime_overlays.py's `_render_interrupted_turn_receipts_block`). Collapse
// every whitespace run to a single space BEFORE any length cap is applied, so
// the cap counts rendered characters, not pre-injection ones.
function flattenWhitespace(value) {
  return String(value == null ? '' : value).split(/\s+/).filter(Boolean).join(' ');
}

function toolNameFromEvent(event) {
  const { payload, toolCall, toolResult } = eventSources(event);
  return flattenWhitespace(
    payload.tool_name
    || toolCall.tool_name
    || toolResult.tool_name
    || event.tool_name
    || ''
  );
}

function callIdFromEvent(event) {
  const { payload, toolCall, toolResult } = eventSources(event);
  return normalizeString(
    event.tool_call_id
    || toolCall.call_id
    || toolResult.call_id
    || payload.call_id
  );
}

function isErrorResult(event) {
  const { payload, toolResult } = eventSources(event);
  return (
    toolResult.is_error === true
    || payload.is_error === true
    || Boolean(toolResult.error_code)
    || Boolean(payload.error_code)
    || normalizeString(event.status) === 'error'
  );
}

function summaryFromEvent(event) {
  const { payload, toolResult } = eventSources(event);
  return flattenWhitespace(
    payload.output_summary
    || payload.summary
    || toolResult.summary
    || toolResult.output_summary
    || ''
  ).slice(0, MAX_SUMMARY);
}

// Pure core: given a single turn's surviving journal events, produce the ledger,
// or null when the turn is not a renderable hard interruption (a terminal marker
// is present, an approval is still pending -- the approval-pause signature -- or
// there was no tool activity at all).
function summarizeInterruptedTurnEvents(events, { cap = DEFAULT_RECEIPTS_CAP } = {}) {
  const list = Array.isArray(events) ? events.filter(isPlainObject) : [];
  if (!list.length) {
    return null;
  }
  if (list.some((event) => TERMINAL_TURN_KINDS.has(String(event.kind || '').trim()))) {
    return null;
  }

  const byCall = new Map();
  const order = [];
  const requestedApprovals = new Set();
  const resolvedApprovals = new Set();
  let syntheticCounter = 0;

  for (const event of list) {
    const kind = String(event.kind || '').trim();
    if (kind === 'approval_requested') {
      requestedApprovals.add(callIdFromEvent(event) || `approval-${syntheticCounter += 1}`);
      continue;
    }
    if (kind === 'approval_resolved') {
      resolvedApprovals.add(callIdFromEvent(event));
      continue;
    }
    if (!TOOL_KINDS.has(kind)) {
      continue;
    }
    const callId = callIdFromEvent(event) || `tool-${syntheticCounter += 1}`;
    let state = byCall.get(callId);
    if (!state) {
      state = { toolName: '', summary: '', status: 'unfinished' };
      byCall.set(callId, state);
      order.push(callId);
    }
    const name = toolNameFromEvent(event);
    if (name) {
      state.toolName = name;
    }
    if (kind === 'tool_result') {
      state.status = isErrorResult(event) ? 'failed' : 'completed';
      const summary = summaryFromEvent(event);
      if (summary) {
        state.summary = summary;
      }
    }
  }

  // Approval-pause exclusion: an unresolved approval request that never produced
  // a completed/failed result is a deliberate pause the chat_resume path owns,
  // not a hard interruption.
  const hasPendingApproval = [...requestedApprovals].some((id) => {
    if (resolvedApprovals.has(id)) {
      return false;
    }
    const state = byCall.get(id);
    return !state || state.status === 'unfinished';
  });
  if (hasPendingApproval) {
    return null;
  }
  if (!order.length) {
    return null;
  }

  const cappedLimit = Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_RECEIPTS_CAP;
  const truncated = order.length > cappedLimit;
  const keptIds = truncated ? order.slice(order.length - cappedLimit) : order;

  const completed = [];
  const failed = [];
  const unfinished = [];
  for (const callId of keptIds) {
    const state = byCall.get(callId);
    const toolName = String(state.toolName || '').slice(0, MAX_TOOL_NAME);
    if (state.status === 'completed') {
      completed.push({ tool_name: toolName, summary: state.summary });
    } else if (state.status === 'failed') {
      failed.push({ tool_name: toolName, summary: state.summary });
    } else {
      unfinished.push({ tool_name: toolName });
    }
  }

  return {
    completed,
    failed,
    unfinished,
    truncated,
    total: order.length,
  };
}

// Discard the surviving journal partition once its receipts have been read
// and forwarded, so the same "Previous Turn Interruption" ledger does not
// re-render on every subsequent chat.send until the session is edited,
// deleted, or the app relaunches (the bug this fixes).
//
// journal.clear() unconditionally requires a durable commit proof
// (hasDurableProof in conversation-store-port.js) as its crash-recovery
// safety gate -- every OTHER caller (session-turn-events.js,
// chat-stream-terminal-coordinator.js's `_clearJournal`) only clears after a
// real canonical-store commit succeeded durably. An interrupted turn's raw
// events, by definition, never completed that normal persist-then-clear path
// (the terminal commit never ran -- that is exactly why the partition still
// exists), so there is no real store commit here to attach a proof to. We
// deliberately construct a self-consistent commit-result stand-in to satisfy
// the gate, accepting an AT-MOST-ONCE delivery tradeoff: if the process
// crashes between this clear and the model actually receiving the forwarded
// receipts (still in-flight as part of THIS chat.send), the ledger is lost
// for good and the next turn sees a clean journal with no receipts. That is
// strictly better than the alternative this fix replaces -- the same
// receipts repeating forever. Failures (thrown or non-durable) are fail-soft:
// one WARNING, and the already-built summary is still returned.
function _clearInterruptedTurnPartition({ journal, sessionId, turnId, logger }) {
  if (!journal || typeof journal.clear !== 'function') {
    return;
  }
  try {
    const commitResult = buildCommitResult({
      ok: true,
      applied: false,
      durable: true,
      reason: 'interrupted_turn_receipts_consumed',
      commitEpoch: 1,
      dirtyEpoch: 1,
      durableEpoch: 1,
    });
    const result = journal.clear(sessionId, turnId, { commitResult });
    if (!result || result.ok !== true || result.durable !== true) {
      if (typeof logger === 'function') {
        logger('WARN', 'chat.interrupted_turn_receipts_clear_failed', {
          reason: (result && result.reason) || 'unknown',
        });
      }
    }
  } catch (error) {
    if (typeof logger === 'function') {
      logger('WARN', 'chat.interrupted_turn_receipts_clear_failed', {
        errorType: (error && error.constructor && error.constructor.name) || 'Error',
      });
    }
  }
}

// Orchestration: locate the session's single lingering interrupted prior turn in
// the journal and return its ledger (with `turn_id`), or null. Fail-closed --
// any error degrades to no receipts plus one counts-only WARNING, never a throw
// into the chat-send path.
function computeInterruptedTurnReceipts({ journal, sessionId, currentTurnId, cap, logger } = {}) {
  try {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId || !journal || typeof journal.listSession !== 'function') {
      return null;
    }
    // Scoped to this session only -- listAll() would deep-clone every session's
    // partitions on every chat.send even though only one is ever kept here.
    const session = journal.listSession(normalizedSessionId);
    const turns = isPlainObject(session) && isPlainObject(session.turns) ? session.turns : null;
    if (!turns) {
      return null;
    }
    const current = String(currentTurnId || '').trim();
    const candidates = [];
    for (const [turnId, events] of Object.entries(turns)) {
      if (current && String(turnId) === current) {
        continue;
      }
      const receipts = summarizeInterruptedTurnEvents(events, { cap });
      if (receipts) {
        candidates.push({
          turnId: String(turnId),
          eventCount: Array.isArray(events) ? events.length : 0,
          receipts,
        });
      }
    }
    if (!candidates.length) {
      return null;
    }
    // At most one interrupted partition normally lingers (clean turns are
    // cleared). If several somehow survive, pick the richest, deterministically.
    candidates.sort((a, b) => {
      if (b.eventCount !== a.eventCount) {
        return b.eventCount - a.eventCount;
      }
      if (a.turnId === b.turnId) {
        return 0;
      }
      return a.turnId < b.turnId ? 1 : -1;
    });
    const best = candidates[0];
    const summary = { ...best.receipts, turn_id: best.turnId };
    _clearInterruptedTurnPartition({
      journal,
      sessionId: normalizedSessionId,
      turnId: best.turnId,
      logger,
    });
    return summary;
  } catch (error) {
    if (typeof logger === 'function') {
      try {
        logger('WARN', 'chat.interrupted_turn_receipts_failed', {
          errorType: (error && error.constructor && error.constructor.name) || 'Error',
        });
      } catch (_loggingError) {
        // Logging must never break the send path.
      }
    }
    return null;
  }
}

module.exports = {
  DEFAULT_RECEIPTS_CAP,
  computeInterruptedTurnReceipts,
  summarizeInterruptedTurnEvents,
};
