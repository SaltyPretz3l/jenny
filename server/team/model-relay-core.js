'use strict';

// The pure pieces of the model relay (row 123, slice 6-2; TEAM_MODEL_SHARING_SPEC "The relay"): ids,
// refusals, the transfer state table, the limits check, views, the admission choice, and the call
// plumbing (clock reading, listener wake-ups and the events sink). No timer and no I/O; `model-relay.js`
// holds the state and `model-relay-window.js` the parts of one transfer.

const { hostFailure } = require('../api-contract');
const { isId } = require('./ids');
const { MODEL_TRANSFER_LIMITS } = require('./model-manifest');
const { createTransferWindow } = require('./model-relay-window');

const MODEL_RELAY_ID_PATTERNS = Object.freeze({
  offer: /^offer_[A-Za-z0-9_-]{22}$/u,
  transfer: /^mxfer_[A-Za-z0-9_-]{22}$/u,
});
const TRANSFER_STATES = Object.freeze(['accepted', 'flowing', 'paused', 'done', 'failed', 'cancelled']);
const LIVE = new Set(['accepted', 'flowing', 'paused']);
// The receiver's own failure words it may report with `complete({ ok: false, reason })`.
const COMPLETE_REASONS = Object.freeze([
  'model_no_space', 'model_destination_invalid', 'model_exists', 'model_hash_mismatch', 'model_not_gguf',
  'model_staging_failed', 'model_journal_invalid',
]);
const CANCEL_TRIGGERS = Object.freeze(['cancelled_by_sender', 'cancelled_by_receiver', 'withdrawn', 'declined',
  'expired', 'member_gone', 'role_changed', 'sender_offline', 'sharing_off', 'host_stopping']);
const ENDS = Object.freeze({ done: ['complete_ok'], failed: ['complete_failed'], cancelled: CANCEL_TRIGGERS });
const PAUSES = Object.freeze(['paused_by_sender', 'paused_by_receiver', 'sender_offline', 'idle']);
// 'from>to' -> the triggers that may cause it (the spec's state table; every change goes through move()).
const TRANSFER_TRANSITIONS = Object.freeze(Object.fromEntries([
  ['accepted>flowing', ['first_part']],
  ['accepted>paused', PAUSES],
  ['flowing>paused', PAUSES],
  ['paused>accepted', ['resumed', 'sender_back']],
  ...['accepted', 'flowing', 'paused'].flatMap((from) => Object.entries(ENDS).map(([to, why]) => [`${from}>${to}`, why])),
].map(([key, triggers]) => [key, Object.freeze([...triggers])])));

const RELAY_FAILURES = Object.freeze({
  notFound: () => hostFailure('forbidden', 'team_not_found'),
  stale: () => hostFailure('conflict', 'team_model_transfer_stale'),
  taken: () => hostFailure('conflict', 'team_model_offer_taken'),
  reused: () => hostFailure('conflict', 'team_model_request_reused'),
  sharingOff: () => hostFailure('unavailable', 'team_model_sharing_off'),
  senderOffline: () => hostFailure('unavailable', 'team_model_sender_offline', '', true),
  stopped: () => hostFailure('unavailable', 'host_unavailable'),
  offerLimit: () => hostFailure('limit', 'team_model_offer_limit'),
  sizeLimit: () => hostFailure('limit', 'team_model_size_limit'),
  busy: () => hostFailure('limit', 'team_model_relay_busy', '', true),
  requestInvalid: () => hostFailure('invalid', 'team_model_request_invalid'),
  manifestInvalid: () => hostFailure('invalid', 'team_model_manifest_invalid'),
  nameInvalid: () => hostFailure('invalid', 'team_model_name_invalid'),
});

// A file larger than the manifest allows; any other `size_invalid` (zero, fractional) is malformed.
function oversizedFile(body) {
  try {
    return body.files.some((file) => Number.isSafeInteger(file?.size) && file.size > MODEL_TRANSFER_LIMITS.maxFileBytes);
  } catch (_error) {
    return false;
  }
}

/** The relay's refusal for a manifest the 6-1 validator refused. */
function manifestFailure(reason, body) {
  if (reason === 'name_invalid' || reason === 'name_collision') return RELAY_FAILURES.nameInvalid();
  if (reason === 'total_too_large' || reason === 'manifest_too_large') return RELAY_FAILURES.sizeLimit();
  if (reason === 'size_invalid' && oversizedFile(body)) return RELAY_FAILURES.sizeLimit();
  return RELAY_FAILURES.manifestInvalid();
}

// Keys that bound the relay's memory: a caller may lower them, never raise them.
const MEMORY_KEYS = Object.freeze(['partBytes', 'windowParts', 'maxFlowingPerHost', 'maxTransferRecords']);

/** Every key of MODEL_TRANSFER_LIMITS, each a whole number of at least 1; throws RangeError otherwise. */
function checkLimits(limits) {
  const keys = Object.keys(MODEL_TRANSFER_LIMITS);
  const fail = () => { throw new RangeError('invalid_model_relay_limits'); };
  if (limits === null || typeof limits !== 'object' || Object.keys(limits).length !== keys.length) fail();
  for (const key of keys) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1) fail();
    if (MEMORY_KEYS.includes(key) && value > MODEL_TRANSFER_LIMITS[key]) fail();
  }
  if (limits.flowingPerHost > limits.maxFlowingPerHost) fail();
  return Object.freeze({ ...limits });
}

function newId(prefix, randomBytes) {
  const bytes = randomBytes(16);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) throw new TypeError('randomBytes must return 16 bytes.');
  return `${prefix}${bytes.toString('base64url')}`;
}

const validActor = (actor) => actor !== null && typeof actor === 'object'
  && isId('member', actor.memberId) && isId('device', actor.deviceId);

const isSender = (o, actor) => o.senderMemberId === actor.memberId && o.senderDeviceId === actor.deviceId;

// 'sender' (the offering device), 'receiver' (the accepting device) or null.
function partyRole(t, actor) {
  if (isSender(t, actor)) return 'sender';
  return t.receiverMemberId === actor.memberId && t.receiverDeviceId === actor.deviceId ? 'receiver' : null;
}

const holdsSlot = (t) => t.state === 'flowing' || (t.state === 'accepted' && t.admitted);
const sameStarts = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

// true for `{ ok: true }`, false for `{ ok: false, reason }` with a known reason, null otherwise.
function parseOutcome(outcome) {
  if (outcome?.ok === true && outcome.reason === undefined) return true;
  return outcome?.ok === false && COMPLETE_REASONS.includes(outcome.reason) ? false : null;
}

function newOffer({ id, actor, digest, manifest, receivers, now }) {
  const direct = manifest.audience.kind === 'member' ? manifest.audience.member_id : null;
  return {
    id, senderMemberId: actor.memberId, senderDeviceId: actor.deviceId, digest, manifest, direct,
    receivers: direct ? [] : receivers, declined: new Set(), openedAt: now, senderGoneAt: null, takenBy: null,
    transfers: new Set(), totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
  };
}

function newTransfer({ id, o, actor, starts, arrival, now, limits }) {
  return {
    id, offerId: o.id, senderMemberId: o.senderMemberId, senderDeviceId: o.senderDeviceId,
    receiverMemberId: actor.memberId, receiverDeviceId: actor.deviceId, displayName: o.manifest.display_name,
    state: 'accepted', admitted: false, pausedBy: null, reason: null, arrival, lastPartAt: now, endedAt: null,
    listeners: new Set(), starts,
    window: createTransferWindow({
      files: o.manifest.files, starts, partBytes: limits.partBytes, windowParts: limits.windowParts,
      lookahead: limits.partRequestsPerParty,
    }),
  };
}

// Visible to the actor as a possible receiver: never the sender; only a member the caller says may receive.
function receivable(o, actor, canReceive) {
  if (canReceive !== true || o.senderMemberId === actor.memberId) return false;
  return o.direct ? o.direct === actor.memberId : !o.declined.has(actor.memberId);
}

// The member ids the caller says may receive a team offer (its event audience), without the sender.
function receiverList(receivers, senderMemberId, max) {
  if (!Array.isArray(receivers) || receivers.length > max || !receivers.every((id) => isId('member', id))) return null;
  return [...new Set(receivers)].filter((id) => id !== senderMemberId);
}

// An exact-size buffer that owns its whole allocation, so the counted bytes are the real memory.
const ownsAllocation = (bytes) => Buffer.isBuffer(bytes) && bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.length;

function transferView(t) {
  return {
    transfer_id: t.id, offer_id: t.offerId, sender_member_id: t.senderMemberId,
    receiver_member_id: t.receiverMemberId, state: t.state, queued: t.state === 'accepted' && !t.admitted,
    reason: t.reason, display_name: t.displayName, bytes_done: t.window.bytesDone(),
    bytes_total: t.window.bytesTotal, next: LIVE.has(t.state) ? t.window.next() : null,
  };
}

function offerSummary(o) {
  return {
    offer_id: o.id, sender_member_id: o.senderMemberId, audience: o.direct ? 'member' : 'team',
    display_name: o.manifest.display_name, files: o.manifest.files.length, total_bytes: o.totalBytes,
    state: o.takenBy ? 'taken' : 'open',
  };
}

function putAnswer(word, extra = {}) {
  if (word === 'full') return { ok: true, ready: false, wait: 'window_full' };
  if (word === 'duplicate') return { ok: true, ready: true, duplicate: true };
  if (word === 'ok') return { ok: true, ready: true, ...extra };
  return word === 'size' ? RELAY_FAILURES.sizeLimit() : RELAY_FAILURES.stale();
}

// The queued transfers that get a flowing slot now, in arrival order: the host limit, then one outgoing
// and one incoming per member. An admitted `accepted` transfer holds its slot like a flowing one, and so does
// any transfer (paused or ended) whose parts a response is still streaming (R14-F03), so the parts alive on the
// host stay within the flowing limit x the window.
function chooseAdmissions(transfers, flowingLimit, limits) {
  let active = 0;
  const out = new Map();
  const inc = new Map();
  const count = (t) => {
    active += 1;
    out.set(t.senderMemberId, (out.get(t.senderMemberId) ?? 0) + 1);
    inc.set(t.receiverMemberId, (inc.get(t.receiverMemberId) ?? 0) + 1);
  };
  const queued = [];
  for (const t of transfers) {
    if (t.state === 'flowing' || (t.state === 'accepted' && t.admitted) || t.window.streamParts() > 0) count(t);
    else if (t.state === 'accepted') queued.push(t);
  }
  const chosen = [];
  for (const t of queued.sort((a, b) => a.arrival - b.arrival)) {
    if (active >= flowingLimit) break;
    if ((out.get(t.senderMemberId) ?? 0) >= limits.flowingOutgoingPerMember) continue;
    if ((inc.get(t.receiverMemberId) ?? 0) >= limits.flowingIncomingPerMember) continue;
    count(t);
    chosen.push(t);
  }
  return chosen;
}

function relayTotals(transfers) {
  const byState = Object.fromEntries(TRANSFER_STATES.map((state) => [state, 0]));
  const totals = { transfers: byState, windowParts: 0, windowBytes: 0, streamParts: 0, streamBytes: 0, listeners: 0 };
  for (const t of transfers) {
    byState[t.state] += 1;
    totals.windowParts += t.window.parts();
    totals.windowBytes += t.window.windowBytes();
    // Parts out of the window that a response is still streaming (R14-F03).
    totals.streamParts += t.window.streamParts();
    totals.streamBytes += t.window.streamBytes();
    totals.listeners += t.listeners.size;
  }
  return totals;
}

/**
 * The call plumbing. `run(fn, { force })` reads the clock (a non-finite or throwing clock refuses the call,
 * unless `force`, which uses the last good time) and runs `fn(now)`; afterwards it fires the woken
 * transfers' one-shot listeners and hands the gathered events to `onEvents(list)`. Neither a listener nor
 * the sink can throw into the relay, and either may call the relay again.
 */
function createCallRunner({ clock, onEvents, isDisposed }) {
  let pending = [];
  let lastNow = 0;
  const woken = new Set();

  function readClock() {
    try {
      const value = clock();
      if (Number.isFinite(value)) {
        lastNow = value;
        return value;
      }
    } catch (_error) {
      // A broken clock is answered below.
    }
    return null;
  }

  function flush() {
    const transfers = [...woken];
    woken.clear();
    for (const t of transfers) {
      const listeners = [...t.listeners];
      t.listeners.clear();
      for (const entry of listeners) {
        try {
          entry.fn(t.id);
        } catch (_error) {
          // A listener never decides anything.
        }
      }
    }
    if (pending.length === 0) return;
    const events = pending;
    pending = [];
    try {
      onEvents(events);
    } catch (_error) {
      // Publishing is the caller's; a throwing sink changes nothing here.
    }
  }

  function run(fn, { force = false } = {}) {
    if (isDisposed()) return RELAY_FAILURES.stopped();
    const read = readClock();
    if (read === null && !force) return RELAY_FAILURES.stopped();
    try {
      return fn(read === null ? lastNow : read);
    } finally {
      flush();
    }
  }

  return {
    run,
    emit: (audience, type, payload) => pending.push({ audience: [...new Set(audience)], type, payload }),
    wake: (t) => { if (t.listeners.size > 0) woken.add(t); },
    pendingEvents: () => pending.length,
  };
}

module.exports = {
  CANCEL_TRIGGERS, COMPLETE_REASONS, LIVE, MODEL_RELAY_ID_PATTERNS, RELAY_FAILURES, TRANSFER_STATES,
  TRANSFER_TRANSITIONS, checkLimits, chooseAdmissions, createCallRunner, holdsSlot, isSender, manifestFailure, newId,
  newOffer, newTransfer, offerSummary, ownsAllocation, parseOutcome, partyRole, putAnswer, receivable, receiverList,
  relayTotals, sameStarts, transferView, validActor,
};
