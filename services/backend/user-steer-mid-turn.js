'use strict';

// Agent steering (row 180): a message the person sends while a managed turn works reaches that turn's model
// at its next tool-loop step. offerUserSteer reserves the item on the live stream ctx and sends it
// (`session.user_steer_arrived`); the tool loop drains it before its next generation and acknowledges
// (`session.user_steer_consumed`, routed through MID_TURN_ACKS), and the ack appends the person's row LIVE,
// after the current text segment is closed as at a tool boundary, so the bubble sits where the model took
// it. Whatever was never taken is released to the renderer at the terminal settle or when a newer stream of
// the chat supersedes this one (`user_steer_released`), and the renderer sends it as the next turn.
// Mirrors session-mail-mid-turn.js. Logs carry ids, counts and reasons, never the message or a file name.

const { budgetAttachmentEntries } = require('../attachment-service');
const { normalizeAttachmentMetadataList } = require('../attachment-metadata');
const { supportsMidTurnSteer } = require('../session-runtime/inference-protocol');
const { buildPromptWithAttachments } = require('./chat-stream-reasoning');
const { validateImageAttachmentsForManagedSend } = require('./managed-sidecar-attachments');
const { liveManagedStream } = require('./session-mail-mid-turn');

const STEER_ITEM_ID_PATTERN = /^outbox_[a-z0-9_]{1,80}$/;
// The sidecar parks at most this many items, bytes of content and images per item per turn and drops the
// rest without telling Electron; the same bounds are kept here so an item it would drop is never sent.
const MAX_STEER_ITEMS = 8;
const MAX_STEER_BYTES = 32 * 1024;
const MAX_STEER_IMAGES = 4;
const MAX_STEER_TURN_IMAGES = 8; // decoded images ride every later generation of the turn
const STEERABLE_KINDS = new Set(['text', 'image']);
const IMAGE_ONLY_CONTENT = '(The person sent an image.)';
// service -> Map<sessionId, stream ctx>: the chat's latest stream, so a newer one releases an abandoned one.
const streamsByService = new WeakMap();

const refuse = (reason) => ({ ok: false, reason });

function log(service, level, event, details) {
  try {
    service?._emitServiceLog?.(level, event, details);
  } catch {
    // Diagnostics never change the turn.
  }
}

function createUserSteerState() {
  return {
    reserved: new Map(), consumed: new Set(), withdrawn: new Set(), settled: false, acceptedBytes: 0, acceptedImages: 0,
  };
}

function emitSteerEvent(ctx, payload) {
  try {
    if (typeof ctx.emitChatStream === 'function') ctx.emitChatStream(payload, { channel: 'control', phase: null });
    else ctx.service?.emit?.('chat-stream', payload);
  } catch {
    // The renderer notice is best effort; the durable row is already written.
  }
}

function detach(ctx) {
  const streams = ctx?.service && typeof ctx.service === 'object' ? streamsByService.get(ctx.service) : null;
  if (streams?.get(ctx.resolvedSessionId) === ctx) streams.delete(ctx.resolvedSessionId);
}

// Ends a stream's steering: the ids the sidecar never acknowledged go back to the renderer. Idempotent.
// Returns the released item ids (consumed ones are already in the transcript, withdrawn ones already gone).
function releaseUserSteers(ctx, reason = 'terminal') {
  const state = ctx?.userSteer;
  if (!state) return [];
  detach(ctx);
  if (state.settled) return [];
  state.settled = true;
  const itemIds = [...state.reserved.keys()].filter((id) => !state.consumed.has(id) && !state.withdrawn.has(id));
  if (!itemIds.length) return [];
  emitSteerEvent(ctx, { type: 'user_steer_released', streamId: ctx.streamId, sessionId: ctx.resolvedSessionId, itemIds, reason });
  log(ctx.service, 'INFO', 'chat.user_steer_released', {
    sessionId: ctx.resolvedSessionId, streamId: ctx.streamId, count: itemIds.length, reason,
  });
  return itemIds;
}

// Gives a managed stream ctx its steering state. A previous stream of the same chat that never settled
// hands its unconsumed items back first (call after attachMidTurnMail).
function attachUserSteer(ctx) {
  ctx.userSteer = createUserSteerState();
  const service = ctx.service;
  const sessionId = String(ctx.resolvedSessionId || '').trim();
  if (!service || typeof service !== 'object' || !sessionId) return ctx.userSteer;
  let streams = streamsByService.get(service);
  if (!streams) {
    streams = new Map();
    streamsByService.set(service, streams);
  }
  const previous = streams.get(sessionId);
  if (previous && previous !== ctx) releaseUserSteers(previous, 'abandoned');
  streams.set(sessionId, ctx);
  return ctx.userSteer;
}

function liveSteerStream(service, sessionId) {
  const ctx = liveManagedStream(service, sessionId);
  return ctx?.userSteer && !ctx.userSteer.settled ? ctx : null;
}

const validId = (value) => typeof value === 'string' && STEER_ITEM_ID_PATTERN.test(value);
const validSession = (value) => typeof value === 'string' && value.trim() !== '' && value === value.trim();

// The wire form of an image attachment is the one chat.send carries (managed-sidecar-chat-helpers.js).
function wireImages(images) {
  if (!images.length) return [];
  return require('./managed-sidecar-chat-helpers').buildImageAttachmentSendParams(images).attachments;
}

function offerChecked(service, { sessionId, itemId, prompt, attachments }) {
  if (service?.featureFlags?.mid_turn_steer === false) return refuse('disabled');
  if (!validSession(sessionId) || !validId(itemId) || typeof prompt !== 'string' || !Array.isArray(attachments)) return refuse('invalid');
  if (service.hostMode === 'server' || !supportsMidTurnSteer(service.sidecarClient)) return refuse('unsupported');
  const ctx = liveSteerStream(service, sessionId);
  if (!ctx) return refuse('no_live_stream');
  const state = ctx.userSteer;
  if (state.reserved.has(itemId)) return refuse('invalid');
  const list = [];
  for (const entry of attachments) {
    const kind = String(entry?.kind || 'text').trim().toLowerCase();
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !STEERABLE_KINDS.has(kind)) return refuse('invalid');
    list.push({ ...entry });
  }
  const images = list.filter((entry) => String(entry.kind || '').trim().toLowerCase() === 'image');
  if (images.length > MAX_STEER_IMAGES) return refuse('over_budget');
  // An image-only message still reaches the model as a user turn; the images ride beside this line.
  const content = buildPromptWithAttachments(prompt, list) || (images.length ? IMAGE_ONLY_CONTENT : '');
  if (!content) return refuse('invalid');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (state.reserved.size >= MAX_STEER_ITEMS || state.acceptedBytes + bytes > MAX_STEER_BYTES
    || state.acceptedImages + images.length > MAX_STEER_TURN_IMAGES) return refuse('over_budget');
  try {
    if (images.length) validateImageAttachmentsForManagedSend(service, images, { requestedSessionId: sessionId, resolvedSessionId: sessionId });
  } catch {
    return refuse('invalid');
  }
  state.reserved.set(itemId, {
    prompt: prompt.trim(), attachments: normalizeAttachmentMetadataList(budgetAttachmentEntries(list).accepted),
  });
  let sent;
  try {
    sent = service.sidecarClient.notifyUserSteerArrived?.({
      sessionId, requestId: ctx.streamId, items: [{ item_id: itemId, content, images: wireImages(images) }],
    }) === true;
  } catch {
    sent = false;
  }
  if (!sent) {
    state.reserved.delete(itemId);
    return refuse('transport_unavailable');
  }
  state.acceptedBytes += bytes; // charged only for items the sidecar will see (a failed send left `reserved`)
  state.acceptedImages += images.length;
  log(service, 'INFO', 'chat.user_steer_offered', { sessionId, streamId: ctx.streamId, itemId, bytes, images: images.length });
  return { ok: true };
}

// {ok:true} | {ok:false, reason}. Never throws: the renderer treats any refusal as "next turn".
function offerUserSteer(service, request) {
  try {
    return offerChecked(service, request && typeof request === 'object' ? request : {});
  } catch {
    return refuse('invalid');
  }
}

// {ok:true} | {ok:false, reason:'consumed'|'unknown'}. The item stays reserved: if the drain wins the race its
// bubble still appears (the model took it), and a withdrawn id is never reported as released.
function withdrawUserSteer(service, { sessionId, itemId } = {}) {
  try {
    if (!validSession(sessionId) || !validId(itemId)) return refuse('unknown');
    const ctx = liveSteerStream(service, sessionId);
    const state = ctx?.userSteer;
    if (!state || !state.reserved.has(itemId) || state.withdrawn.has(itemId)) return refuse('unknown');
    if (state.consumed.has(itemId)) return refuse('consumed');
    const sent = service.sidecarClient.notifyUserSteerWithdrawn?.({ sessionId, requestId: ctx.streamId, itemIds: [itemId] }) === true;
    if (!sent) return refuse('unknown');
    state.withdrawn.add(itemId);
    log(service, 'INFO', 'chat.user_steer_withdrawn', { sessionId, streamId: ctx.streamId, itemId });
    return { ok: true };
  } catch {
    return refuse('unknown');
  }
}

// Appends the person's row now. While the turn's own segments are deferred after a refused persist (or the
// store refuses this write) the row joins that missing suffix, so the terminal commits it in order.
function persistSteerRow(ctx, itemId, entry) {
  const row = {
    id: `steer_${itemId}`, role: 'user', kind: 'steer', turn_id: ctx.turnId, content: entry.prompt,
    attachments: entry.attachments, outbox_item_id: itemId, timestamp: new Date().toISOString(),
  };
  const deferred = ctx.segmentPersistRefused === true && typeof ctx.service?.terminalCoordinator?.settle === 'function';
  let persisted = null;
  if (!deferred) {
    try {
      persisted = ctx.adapter.appendMessage(row, { updatePreview: false });
    } catch {
      persisted = null;
    }
  }
  if (!persisted) {
    if (!deferred) {
      ctx.segmentPersistRefused = true;
      log(ctx.service, 'WARN', 'chat.user_steer_persist_refused', { sessionId: ctx.resolvedSessionId, streamId: ctx.streamId, itemId });
    }
    if (!Array.isArray(ctx.refusedTextSegments)) ctx.refusedTextSegments = [];
    ctx.refusedTextSegments.push(row);
  }
  return row;
}

function consumeIds(ctx, state, ids) {
  const fresh = [];
  for (const id of ids) {
    if (state.reserved.has(id) && !state.consumed.has(id) && !fresh.includes(id)) fresh.push(id);
  }
  if (!fresh.length) return 0;
  // The text the model wrote before this step is closed as at a tool boundary, so the person's row lands after it.
  ctx.persistCurrentTextSegment?.({ allowReasoningOnly: true, atToolBoundary: true });
  for (const id of fresh) {
    state.consumed.add(id);
    const row = persistSteerRow(ctx, id, state.reserved.get(id));
    emitSteerEvent(ctx, { type: 'user_steer', streamId: ctx.streamId, sessionId: ctx.resolvedSessionId, turnId: ctx.turnId, message: row });
  }
  log(ctx.service, 'INFO', 'chat.user_steer_consumed', { sessionId: ctx.resolvedSessionId, streamId: ctx.streamId, count: fresh.length });
  return fresh.length;
}

// Router entry for `session.user_steer_consumed` params: `item_ids` must be at most 8 strings. Ids not reserved
// on this stream, and ids already consumed, are ignored. Never throws. Returns the count newly consumed.
function acceptUserSteerConsumedNotification(ctx, params) {
  try {
    const state = ctx?.userSteer;
    if (!state || state.settled) return 0;
    const ids = params?.item_ids;
    if (!Array.isArray(ids) || ids.length > MAX_STEER_ITEMS || !ids.every((id) => typeof id === 'string')) {
      log(ctx.service, 'WARN', 'chat.user_steer_consumed_invalid', { sessionId: ctx.resolvedSessionId, streamId: ctx.streamId });
      return 0;
    }
    const taken = consumeIds(ctx, state, ids);
    if (taken < new Set(ids).size) {
      log(ctx.service, 'INFO', 'chat.user_steer_consumed_ignored', {
        sessionId: ctx.resolvedSessionId, streamId: ctx.streamId, count: new Set(ids).size - taken,
      });
    }
    return taken;
  } catch {
    log(ctx?.service, 'WARN', 'chat.user_steer_consumed_failed', { sessionId: ctx?.resolvedSessionId, streamId: ctx?.streamId });
    return 0;
  }
}

module.exports = {
  MAX_STEER_BYTES,
  MAX_STEER_IMAGES,
  MAX_STEER_ITEMS,
  STEER_ITEM_ID_PATTERN,
  acceptUserSteerConsumedNotification,
  attachUserSteer,
  createUserSteerState,
  offerUserSteer,
  releaseUserSteers,
  withdrawUserSteer,
};
