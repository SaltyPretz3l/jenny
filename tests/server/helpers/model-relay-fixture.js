'use strict';

// Shared setup for the model relay tests (slice 6-2): a relay on an injected clock and counter-based random
// bytes, small part sizes, an events sink, members and devices, a valid offer body and a started transfer.

const { MODEL_TRANSFER_LIMITS } = require('../../../server/team/model-manifest');
const { createModelRelay } = require('../../../server/team/model-relay');
const { createClock } = require('./clock');

// Parts of 4 bytes, so a 10-byte file is parts of 4, 4 and 2.
const SMALL = Object.freeze({ ...MODEL_TRANSFER_LIMITS, partBytes: 4 });
const HASH = 'a'.repeat(64);

const actor = (name, device = 'a') => ({ memberId: `member_${name}`, deviceId: `device_${name}_${device}` });
const SENDER = actor('sender');
const RECEIVER = actor('receiver');
const OTHER = actor('other');
const RECEIVER_B = actor('receiver', 'b');
const MEMBERS = Object.freeze([SENDER, RECEIVER, OTHER].map((entry) => entry.memberId));

const NOT_FOUND = Object.freeze({ ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_not_found', retryable: false } });
const reasonOf = (result) => (result.ok ? 'ok' : result.error.reason);

function body({ requestId = 'req_1', to = null, sizes = [10], displayName = 'Model one', provenance } = {}) {
  const names = ['Model-Q4_K_M.gguf', 'mmproj-Model-F16.gguf'];
  return {
    request_id: requestId,
    audience: to ? { kind: 'member', member_id: to.memberId } : { kind: 'team' },
    display_name: displayName,
    files: sizes.map((size, index) => ({ name: names[index], size, sha256: HASH, segments: [HASH] })),
    provenance: provenance || { licence: 'Apache-2.0', source_url: null, note: '' },
  };
}

function makeRelay({ limits = SMALL, logs = [], clock = createClock(1_000_000) } = {}) {
  let counter = 0;
  const randomBytes = (n) => {
    counter += 1;
    const bytes = Buffer.alloc(n);
    bytes.writeUInt32BE(counter, 0);
    return bytes;
  };
  const events = [];
  const relay = createModelRelay({
    clock, randomBytes, limits, logger: (...args) => logs.push(args), onEvents: (list) => events.push(...list),
  });
  return { relay, clock, logs, events };
}

function mustOk(result) {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result;
}

// Offer from `from` (direct to `to`, or to the team when `to` is null) and accept on `by`.
function startTransfer(relay, { to = RECEIVER, sizes, requestId, resume, by = RECEIVER, from = SENDER } = {}) {
  const receivers = [...new Set([...MEMBERS, by.memberId])];
  const made = mustOk(relay.offer(from, body({ to, sizes, requestId }), { receivers }));
  const accepted = mustOk(relay.accept(by, made.offer.offer_id, { resume, canReceive: true }));
  return { offerId: made.offer.offer_id, transferId: accepted.transfer.transfer_id, accepted };
}

// An exact-size buffer owning its allocation (the relay refuses pooled or sliced buffers).
function bytesOf(length, seed = 1) {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (seed * 31 + index) % 256;
  return bytes;
}

function viewOf(relay, transferId, who = SENDER) {
  return mustOk(relay.listOffers(who, { canReceive: true })).transfers.find((t) => t.transfer_id === transferId);
}

module.exports = {
  HASH, MEMBERS, NOT_FOUND, OTHER, RECEIVER, RECEIVER_B, SENDER, SMALL, actor, body, bytesOf, makeRelay, mustOk,
  reasonOf, startTransfer, viewOf,
};
