'use strict';

// Mid-turn mail (row 70 W2a, decision D7): addressed session messages reach a WORKING chat
// inside its current managed turn. pushMidTurnMail reserves named queued inbox records for the
// live turn and sends their context rows to the sidecar (`session.mail_arrived`); the tool loop
// drains them before its next generation and acknowledges (`session.mail_consumed` ->
// markConsumed). At the turn's terminal settle the consumed rows ride the terminal mutation
// (settleMidTurnMail) and are finalized `included` once the settle is durable (finishMidTurnMail);
// everything unconsumed returns to queued. A path that ends a stream without that settle releases
// through releaseMidTurnMailForStream, and a newer stream of the same chat releases whatever an
// abandoned one still held. A crash leaves a reserved snapshot that reconcileAdmissionSnapshots
// heals at the next turn start. Logs carry ids, counts and reasons, never a body or a title.

const {
  finalizeMidTurnMail, releaseMidTurnMail, reserveMidTurnMail,
} = require('./session-mail-admission');
const { MAIL_LIMITS } = require('./session-mail-records');
const { supportsMidTurnMail } = require('../session-runtime/inference-protocol');

// The sidecar's PendingMailQueue accepts at most this many rows and this many bytes of compact wire
// JSON per turn and drops the rest without telling Electron. The same bound is kept per stream here, so
// an over-budget message is never reserved and sent for nothing: it waits for the settle wake.
const MAX_MESSAGE_IDS = MAIL_LIMITS.snapshot_entries;
const MAX_TURN_MAIL_BYTES = 32 * 1024;
// service -> Map<sessionId, stream ctx>: at most one live managed stream per chat.
const streamsByService = new WeakMap();

const refuse = (reason) => ({ ok: false, reason });

function log(service, level, event, details) {
  try {
    service?._emitServiceLog?.(level, event, details);
  } catch {
    // Diagnostics never change the turn.
  }
}

function notifyChanged(service, sessionId) {
  try {
    service?.chatMessages?.notify?.(sessionId);
  } catch {
    // A refresh hint is best effort.
  }
}

function createMidTurnMailState() {
  return { reserved: new Map(), consumed: new Set(), settled: false, pending: [], acceptedRows: 0, acceptedBytes: 0 };
}

const wireBytes = (rows) => rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row), 'utf8'), 0);

function normalizeMessageIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, MAX_MESSAGE_IDS);
}

function releaseReservations(ctx, snapshotIds, reason) {
  const state = ctx.midTurnMail;
  let released = 0;
  for (const snapshotId of snapshotIds) {
    const outcome = releaseMidTurnMail({ sessionStore: ctx.service?.sessionStore, sessionId: ctx.resolvedSessionId, snapshotId });
    released += outcome?.released || 0;
    state.reserved.delete(snapshotId);
  }
  if (snapshotIds.length) {
    log(ctx.service, 'INFO', 'chat.session_mail_mid_turn_released', {
      sessionId: ctx.resolvedSessionId, streamId: ctx.streamId, snapshots: snapshotIds.length, released, reason,
    });
    notifyChanged(ctx.service, ctx.resolvedSessionId);
  }
  return released;
}

function detach(ctx) {
  const streams = ctx?.service && typeof ctx.service === 'object' ? streamsByService.get(ctx.service) : null;
  if (streams?.get(ctx.resolvedSessionId) === ctx) streams.delete(ctx.resolvedSessionId);
}

// Ends a stream's mid-turn mail without persisting anything: every reservation (consumed or not)
// returns to queued so the mail is never lost. Idempotent. Returns the released record count.
function releaseMidTurnMailForStream(ctx, reason = 'stream_ended') {
  const state = ctx?.midTurnMail;
  if (!state) return 0;
  detach(ctx);
  if (state.settled) return 0;
  state.settled = true;
  state.consumed.clear();
  return releaseReservations(ctx, [...state.reserved.keys()], reason);
}

// Gives a managed stream ctx its mid-turn state and makes it the chat's live stream. A previous
// stream of the same chat that never settled hands its reservations back first.
function attachMidTurnMail(ctx) {
  ctx.midTurnMail = createMidTurnMailState();
  const service = ctx.service;
  const sessionId = String(ctx.resolvedSessionId || '').trim();
  if (!service || typeof service !== 'object' || !sessionId) return ctx.midTurnMail;
  let streams = streamsByService.get(service);
  if (!streams) {
    streams = new Map();
    streamsByService.set(service, streams);
  }
  const previous = streams.get(sessionId);
  if (previous && previous !== ctx) releaseMidTurnMailForStream(previous, 'superseded');
  streams.set(sessionId, ctx);
  return ctx.midTurnMail;
}

function liveManagedStream(service, sessionId) {
  const ctx = streamsByService.get(service)?.get(sessionId);
  if (!ctx?.midTurnMail || ctx.midTurnMail.settled) return null;
  let activeTurn;
  try {
    activeTurn = service.sessionStore?.getActiveTurn?.(sessionId) || null;
  } catch {
    return null;
  }
  const streamId = String(activeTurn?.stream_id || activeTurn?.request_id || '').trim();
  if (!streamId || streamId !== ctx.streamId) return null;
  if (activeTurn.turn_id && String(activeTurn.turn_id) !== String(ctx.turnId)) return null;
  if (typeof service.activeStreams?.get !== 'function' || !service.activeStreams.get(streamId)) return null;
  return ctx;
}

// The sidecar wire form of an included row: the chat.send context-history projection.
const wireRow = (row) => ({ role: 'context', kind: 'session_message', content: row.content, session_message: row.session_message });

// {ok, reason[, snapshot_id, message_ids]}. Requires the negotiated mid_turn_mail capability and a
// live managed turn of `sessionId`; reserves the named queued records and sends their rows.
function pushMidTurnMail(service, { sessionId, messageIds, now } = {}) {
  const id = String(sessionId || '').trim();
  if (!supportsMidTurnMail(service?.sidecarClient)) return refuse('unsupported');
  const ctx = id ? liveManagedStream(service, id) : null;
  if (!ctx) return refuse('no_active_managed_turn');
  const ids = normalizeMessageIds(messageIds);
  if (!ids.length) return refuse('nothing_queued');
  const budget = ctx.midTurnMail;
  if (budget.acceptedRows >= MAX_MESSAGE_IDS || budget.acceptedBytes >= MAX_TURN_MAIL_BYTES) return refuse('turn_mail_budget');
  const reserved = reserveMidTurnMail({ sessionStore: service.sessionStore, sessionId: id, turnId: ctx.turnId, messageIds: ids, now });
  if (!reserved.ok) {
    log(service, 'INFO', 'chat.session_mail_mid_turn_refused', { sessionId: id, streamId: ctx.streamId, reason: reserved.reason });
    return refuse(reserved.reason);
  }
  const snapshotId = reserved.snapshot_id;
  const reservedIds = reserved.rows.map((row) => row.session_message.message_id);
  ctx.midTurnMail.reserved.set(snapshotId, { rows: reserved.rows, messageIds: reservedIds });
  const wire = reserved.rows.map(wireRow);
  const bytes = wireBytes(wire);
  if (budget.acceptedRows + wire.length > MAX_MESSAGE_IDS || budget.acceptedBytes + bytes > MAX_TURN_MAIL_BYTES) {
    releaseReservations(ctx, [snapshotId], 'turn_mail_budget');
    return refuse('turn_mail_budget');
  }
  let sent;
  try {
    sent = service.sidecarClient.notifySessionMailArrived?.({ sessionId: id, requestId: ctx.streamId, rows: wire }) === true;
  } catch {
    sent = false;
  }
  if (!sent) {
    releaseReservations(ctx, [snapshotId], 'transport_unavailable');
    return refuse('transport_unavailable');
  }
  budget.acceptedRows += wire.length; // charged only for rows the sidecar will see
  budget.acceptedBytes += bytes;
  notifyChanged(service, id);
  log(service, 'INFO', 'chat.session_mail_mid_turn_pushed', {
    sessionId: id, streamId: ctx.streamId, snapshotId, count: reservedIds.length,
  });
  return { ok: true, reason: null, snapshot_id: snapshotId, message_ids: reservedIds };
}

// The `session.mail_consumed` acknowledgement: ids not reserved on this stream are ignored.
function markConsumed(ctx, messageIds) {
  const state = ctx?.midTurnMail;
  if (!state || state.settled) return 0;
  const reservedIds = new Set([...state.reserved.values()].flatMap((entry) => entry.messageIds));
  let marked = 0;
  let ignored = 0;
  for (const id of normalizeMessageIds(messageIds)) {
    if (reservedIds.has(id)) {
      if (!state.consumed.has(id)) marked += 1;
      state.consumed.add(id);
    } else {
      ignored += 1;
    }
  }
  if (ignored) {
    log(ctx.service, 'WARN', 'chat.session_mail_mid_turn_unknown_consumed', {
      sessionId: ctx.resolvedSessionId, streamId: ctx.streamId, count: ignored,
    });
  }
  return marked;
}

// Router entry for `session.mail_consumed` params: `message_ids` must be at most 16 strings.
function acceptMailConsumedNotification(ctx, params) {
  const ids = params?.message_ids;
  if (!Array.isArray(ids) || ids.length > MAX_MESSAGE_IDS || !ids.every((id) => typeof id === 'string')) {
    log(ctx?.service, 'WARN', 'chat.session_mail_mid_turn_consumed_invalid', {
      sessionId: ctx?.resolvedSessionId, streamId: ctx?.streamId,
    });
    return 0;
  }
  return markConsumed(ctx, ids);
}

// At the terminal settle, before the terminal mutation: {rows} = the consumed context rows in
// reservation order, to persist with the turn. Snapshots with nothing consumed are released now;
// the rest wait for finishMidTurnMail. Idempotent (a second call returns no rows).
function settleMidTurnMail(ctx) {
  const state = ctx?.midTurnMail;
  if (!state || state.settled) return { rows: [] };
  state.settled = true;
  detach(ctx);
  const rows = [];
  const unconsumed = [];
  for (const [snapshotId, entry] of state.reserved) {
    const consumedRows = entry.rows.filter((row) => state.consumed.has(row.session_message.message_id));
    if (!consumedRows.length) {
      unconsumed.push(snapshotId);
      continue;
    }
    rows.push(...consumedRows);
    state.pending.push({ snapshotId, rowsByMessageId: new Map(consumedRows.map((row) => [row.session_message.message_id, row])) });
  }
  releaseReservations(ctx, unconsumed, 'unconsumed');
  return { rows: rows.map((row) => ({ ...row })) };
}

// After the terminal mutation: a durable settle finalizes the consumed records `included` (and
// returns their unconsumed snapshot siblings to queued); a settle that never ran releases them; a
// settle that ran but is not proven durable leaves them reserved for reconcileAdmissionSnapshots,
// which finalizes or releases by whether the rows reached the transcript.
function finishMidTurnMail(ctx, settled, { now } = {}) {
  const state = ctx?.midTurnMail;
  if (!state || !state.pending.length) return;
  const pending = state.pending.splice(0);
  const snapshotIds = pending.map((entry) => entry.snapshotId);
  if (settled?.handled !== true) {
    releaseReservations(ctx, snapshotIds, 'settle_not_handled');
    return;
  }
  if (settled.result?.durableTerminal !== true) {
    for (const snapshotId of snapshotIds) state.reserved.delete(snapshotId);
    log(ctx.service, 'WARN', 'chat.session_mail_mid_turn_finalize_deferred', {
      sessionId: ctx.resolvedSessionId, streamId: ctx.streamId, snapshots: snapshotIds.length, reason: 'terminal_not_durable',
    });
    return;
  }
  let finalized = 0;
  for (const { snapshotId, rowsByMessageId } of pending) {
    const outcome = finalizeMidTurnMail({
      sessionStore: ctx.service?.sessionStore, sessionId: ctx.resolvedSessionId, snapshotId, rowsByMessageId, now,
    });
    state.reserved.delete(snapshotId);
    if (outcome.ok) finalized += outcome.finalized;
    else log(ctx.service, 'WARN', 'chat.session_mail_mid_turn_finalize_deferred', {
      sessionId: ctx.resolvedSessionId, streamId: ctx.streamId, snapshotId, reason: 'finalize_failed',
    });
  }
  log(ctx.service, 'INFO', 'chat.session_mail_mid_turn_included', {
    sessionId: ctx.resolvedSessionId, streamId: ctx.streamId, count: finalized,
  });
  notifyChanged(ctx.service, ctx.resolvedSessionId);
}

module.exports = {
  MAX_MESSAGE_IDS,
  acceptMailConsumedNotification,
  attachMidTurnMail,
  createMidTurnMailState,
  finishMidTurnMail,
  markConsumed,
  pushMidTurnMail,
  releaseMidTurnMailForStream,
  settleMidTurnMail,
};
