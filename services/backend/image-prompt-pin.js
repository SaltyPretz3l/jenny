'use strict';

/* services/backend/image-prompt-pin.js — row 91: a user message sent with
 * /image carries `image_prompt_pin`. The message's own text is the image prompt
 * and the pin holds the user's options (size, seed, an edit source and region);
 * an empty pin still marks the message. The image tool reads the pin from the
 * turn's canonical user message, never from the model or the renderer at call
 * time, and uses only the model's title. Pure, except the bounded per-service
 * ledger of turns whose pinned image was drawn. */

const ID = /^[a-zA-Z0-9_-]{1,240}$/;
const REGION_KINDS = new Set(['box', 'ellipse', 'freehand']);
const MAX_EDGE = 4096;
const MAX_SEED = 4294967295;
const LEDGER_LIMIT = 64;

function positiveEdge(value) {
  return Number.isInteger(value) && value >= 64 && value <= MAX_EDGE;
}

function normalizeRegion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !REGION_KINDS.has(value.kind)
    || !Array.isArray(value.points)) return null;
  const freehand = value.kind === 'freehand';
  const { points } = value;
  if (points.length < (freehand ? 3 : 2) || points.length > (freehand ? 128 : 2)) return null;
  if (!points.every((point) => Array.isArray(point) && point.length === 2
    && point.every((n) => Number.isFinite(n) && n >= 0 && n <= MAX_EDGE))) return null;
  return { kind: value.kind, points: points.map((point) => [point[0], point[1]]) };
}

/** The stored pin, or null when the value is not a well-formed pin. */
function normalizeImagePromptPin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pin = {};
  if (value.width !== undefined || value.height !== undefined) {
    if (!positiveEdge(value.width) || !positiveEdge(value.height)) return null;
    pin.width = value.width;
    pin.height = value.height;
  }
  if (value.seed !== undefined) {
    if (!Number.isInteger(value.seed) || value.seed < 0 || value.seed > MAX_SEED) return null;
    pin.seed = value.seed;
  }
  if (value.source_artifact_id !== undefined) {
    if (typeof value.source_artifact_id !== 'string' || !ID.test(value.source_artifact_id)) return null;
    pin.source_artifact_id = value.source_artifact_id;
  }
  if (value.region !== undefined && value.region !== null) {
    const region = normalizeRegion(value.region);
    if (!region || !pin.source_artifact_id) return null;
    pin.region = region;
  }
  return pin;
}

const PIN_NOTE = '[Image request: the user wrote the message above as the image prompt. Call image_generate once, '
  + 'passing that text as the prompt. The app draws the user\'s text exactly as written, so do not rewrite or expand it. '
  + 'Give the image a short descriptive title, then briefly acknowledge it.]';

/** How a pinned user message reads to the model. The live turn and its history
 * replay go through this, so turn N sends what turn N+1 replays. */
function withImagePromptPin(content, pin) {
  if (!pin || typeof pin !== 'object') return content;
  return content ? `${content}\n\n${PIN_NOTE}` : PIN_NOTE;
}

function projectUserImagePromptPin(message, content) {
  if (message?.role !== 'user' || String(message.kind || '').trim()) return content;
  return withImagePromptPin(content, message.image_prompt_pin);
}

// Read-only lookup: peekSessionMessages skips getSession's whole-session normalize, which
// would otherwise run at every turn end (undrawnImagePromptFields) for every chat.
function storedMessages(sessionStore, sessionId) {
  if (typeof sessionStore?.peekSessionMessages === 'function') return sessionStore.peekSessionMessages(sessionId);
  return typeof sessionStore?.getSession === 'function' ? sessionStore.getSession(sessionId)?.messages || [] : [];
}

function findStoredMessage(sessionStore, sessionId, messageId) {
  const id = String(messageId || '').trim();
  if (!id) return null;
  try {
    return storedMessages(sessionStore, sessionId).find((row) => row?.id === id) || null;
  } catch (_error) { return null; }
}

function pinnedUserRow(message) {
  return message?.role === 'user' && normalizeImagePromptPin(message.image_prompt_pin) ? message : null;
}

/**
 * The pinned request of one turn: the pin plus the message's text as `prompt`, or null.
 * The turn's own user row first; a continuation of the same logical turn (an answered
 * ask_user persists the answer as a new user row) falls back to that turn's pinned row.
 */
function resolveTurnImagePrompt(sessionStore, sessionId, turnIdentity) {
  const userMessageId = String(turnIdentity?.userMessageId || '').trim();
  const turnId = String(turnIdentity?.turnId || '').trim();
  if (!userMessageId && !turnId) return null;
  let message;
  try {
    const rows = storedMessages(sessionStore, sessionId);
    message = pinnedUserRow(userMessageId ? rows.find((row) => row?.id === userMessageId) : null)
      || (turnId ? rows.find((row) => row?.turn_id === turnId && pinnedUserRow(row)) : null);
  } catch (_error) { return null; }
  if (!message) return null;
  return { ...normalizeImagePromptPin(message.image_prompt_pin), prompt: typeof message.content === 'string' ? message.content : '' };
}

// One drawn image per pinned turn: a second render would cost minutes of GPU for a
// picture the user did not ask for. Keyed by the turn; bounded per service.
const ledgers = new WeakMap();

function ledgerFor(service) {
  if (!service || typeof service !== 'object') return null;
  let ledger = ledgers.get(service);
  if (!ledger) { ledger = new Set(); ledgers.set(service, ledger); }
  return ledger;
}

// The logical turn, so a continuation after ask_user shares the turn's one image.
function pinnedRenderKey(sessionId, turnIdentity) {
  const turnId = String(turnIdentity?.turnId || '').trim();
  return turnId ? `${sessionId}\u0000${turnId}` : '';
}

function hasPinnedRender(service, sessionId, turnIdentity) {
  const key = pinnedRenderKey(sessionId, turnIdentity);
  return Boolean(key) && Boolean(ledgerFor(service)?.has(key));
}

/** Claimed before the render starts, so two image calls in one turn cannot both draw;
 * false when the turn already drew (or is drawing), or has no turn identity. */
function claimPinnedRender(service, sessionId, turnIdentity) {
  const key = pinnedRenderKey(sessionId, turnIdentity);
  const ledger = ledgerFor(service);
  if (!key || !ledger || ledger.has(key)) return false;
  ledger.add(key);
  while (ledger.size > LEDGER_LIMIT) ledger.delete(ledger.values().next().value);
  return true;
}

/** A failed or cancelled render gives the turn its one image back. */
function releasePinnedRender(service, sessionId, turnIdentity) {
  ledgerFor(service)?.delete(pinnedRenderKey(sessionId, turnIdentity));
}

/** The `complete` event field of a /image turn that drew nothing, so the composer can
 * put the prompt back; {} for any other turn. Reads the same ledger the bridge writes. */
function undrawnImagePromptFields(service, sessionId, turnIdentity) {
  if (!pinnedRenderKey(sessionId, turnIdentity) || hasPinnedRender(service, sessionId, turnIdentity)) return {};
  return resolveTurnImagePrompt(service?.sessionStore, sessionId, turnIdentity) ? { imagePromptUndrawn: true } : {};
}

/** The stored pin of a user message (an edit or regenerate inherits it), or undefined. */
function storedImagePromptPin(sessionStore, sessionId, messageId) {
  const message = findStoredMessage(sessionStore, sessionId, messageId);
  return message?.role === 'user' ? normalizeImagePromptPin(message.image_prompt_pin) || undefined : undefined;
}

module.exports = {
  normalizeImagePromptPin,
  undrawnImagePromptFields,
  withImagePromptPin,
  projectUserImagePromptPin,
  resolveTurnImagePrompt,
  storedImagePromptPin,
  hasPinnedRender,
  claimPinnedRender,
  releasePinnedRender,
};
