'use strict';

// new-test-file: these cases and team-model-relay.test.js together pass the 600-line cap; caps, time, limits, clock and edge cases of slice 6-2.

const assert = require('node:assert/strict');
const test = require('node:test');

const { MODEL_TRANSFER_LIMITS } = require('../../server/team/model-manifest');
const { createModelRelay } = require('../../server/team/model-relay');
const {
  HASH, MEMBERS, OTHER, RECEIVER, RECEIVER_B, SENDER, SMALL, actor, body, bytesOf, makeRelay, mustOk, reasonOf,
  startTransfer, viewOf,
} = require('./helpers/model-relay-fixture');

const BUSY = 'team_model_relay_busy';
const stateOf = (relay, id) => viewOf(relay, id)?.state ?? 'forgotten';

// --- caps ---------------------------------------------------------------------------------------------

test('caps: offers per member and per host, pending direct offers per receiver', () => {
  const { relay } = makeRelay();
  for (let n = 0; n < SMALL.maxOffersPerMember; n += 1) mustOk(relay.offer(SENDER, body({ requestId: `r${n}` }), { receivers: MEMBERS }));
  assert.equal(reasonOf(relay.offer(SENDER, body({ requestId: 'r_over' }), { receivers: MEMBERS })), 'team_model_offer_limit');
  const host = makeRelay().relay;
  for (let s = 0; s < SMALL.maxOffersPerHost / SMALL.maxOffersPerMember; s += 1) {
    for (let n = 0; n < SMALL.maxOffersPerMember; n += 1) mustOk(host.offer(actor(`s${s}`), body({ requestId: `r${n}` }), { receivers: [] }));
  }
  assert.equal(host.resources().offers, SMALL.maxOffersPerHost);
  assert.equal(reasonOf(host.offer(actor('late'), body(), { receivers: [] })), 'team_model_offer_limit');
  const direct = makeRelay().relay;
  for (let n = 0; n < SMALL.maxPendingDirectOffers; n += 1) mustOk(direct.offer(actor(`d${n}`), body({ to: RECEIVER }), { receivers: MEMBERS }));
  assert.equal(reasonOf(direct.offer(actor('d_over'), body({ to: RECEIVER }), { receivers: MEMBERS })), 'team_model_offer_limit');
  mustOk(direct.offer(actor('d_over'), body({ to: OTHER }), { receivers: MEMBERS }));
});

test('caps: the receivers list at the team size and one past', () => {
  const { relay } = makeRelay();
  const eight = Array.from({ length: SMALL.maxReceivers }, (_, i) => `member_r${i}`);
  mustOk(relay.offer(SENDER, body({ requestId: 'a' }), { receivers: eight }));
  assert.equal(reasonOf(relay.offer(SENDER, body({ requestId: 'b' }), { receivers: [...eight, 'member_r9'] })), 'team_model_request_invalid');
  assert.equal(reasonOf(relay.offer(SENDER, body({ requestId: 'c' }), { receivers: ['nope'] })), 'team_model_request_invalid');
  assert.equal(reasonOf(relay.offer(SENDER, body({ requestId: 'd' }))), 'team_model_request_invalid');
});

test('caps: flowing transfers queue in arrival order; one outgoing and one incoming per member', () => {
  const { relay } = makeRelay();
  const pairs = [1, 2, 3, 4].map((n) => [actor(`a${n}`), actor(`b${n}`)]);
  const ids = pairs.map(([from, by]) => startTransfer(relay, { from, by, to: by }).transferId);
  const queued = (id) => viewOf(relay, id, pairs[ids.indexOf(id)][0]).queued;
  assert.deepEqual(ids.map(queued), [false, false, true, true], 'the host limit is 2');
  assert.equal(reasonOf(relay.putPart(pairs[2][0], ids[2], 0, 0, bytesOf(4))), BUSY);
  mustOk(relay.cancel(pairs[0][1], ids[0]));
  assert.deepEqual(ids.slice(1).map(queued), [false, false, true], 'the first queued is admitted first');
  mustOk(relay.setFlowingLimit(4));
  assert.deepEqual(ids.slice(1).map(queued), [false, false, false]);
  const solo = makeRelay().relay;
  startTransfer(solo, { requestId: 'x1' });
  const second = startTransfer(solo, { to: OTHER, by: OTHER, requestId: 'x2' });
  assert.equal(viewOf(solo, second.transferId).queued, true, 'one outgoing per member');
  const third = startTransfer(solo, { from: actor('c'), requestId: 'x3' });
  assert.equal(viewOf(solo, third.transferId, RECEIVER).queued, true, 'one incoming per member');
});

test('caps: live transfers per receiving member at the edge and one past', () => {
  const { relay } = makeRelay();
  for (let n = 0; n < SMALL.maxLiveTransfersPerMember; n += 1) startTransfer(relay, { from: actor(`s${n}`), to: null });
  const over = mustOk(relay.offer(actor('s_over'), body(), { receivers: MEMBERS })).offer.offer_id;
  assert.equal(reasonOf(relay.accept(RECEIVER, over, { canReceive: true })), BUSY);
  mustOk(relay.accept(OTHER, over, { canReceive: true }));
});

test('caps: listeners per party (two for the receiver, one waiting put for the sender) and transfer records', () => {
  const { relay } = makeRelay();
  const { transferId } = startTransfer(relay);
  mustOk(relay.onChange(RECEIVER, transferId, () => {}));
  mustOk(relay.onChange(RECEIVER, transferId, () => {}));
  assert.equal(reasonOf(relay.onChange(RECEIVER, transferId, () => {})), BUSY);
  const one = mustOk(relay.onChange(SENDER, transferId, () => {}));
  assert.equal(reasonOf(relay.onChange(SENDER, transferId, () => {})), BUSY);
  one.off();
  mustOk(relay.onChange(SENDER, transferId, () => {}));
  const small = makeRelay({ limits: { ...SMALL, maxTransferRecords: 2 } }).relay;
  const a = startTransfer(small, { requestId: 'a' });
  startTransfer(small, { requestId: 'b', from: actor('b') });
  const made = mustOk(small.offer(actor('c'), body({ to: RECEIVER, requestId: 'c' }), { receivers: MEMBERS }));
  assert.equal(reasonOf(small.accept(RECEIVER, made.offer.offer_id, { canReceive: true })), BUSY);
  mustOk(small.cancel(RECEIVER, a.transferId));
  mustOk(small.accept(RECEIVER, made.offer.offer_id, { canReceive: true }));
  assert.equal(stateOf(small, a.transferId), 'forgotten', 'the ended record made way');
});

// --- limits and the clock -----------------------------------------------------------------------------

test('limits are checked once at creation', () => {
  const make = (limits) => () => createModelRelay({ clock: () => 1, limits, onEvents: () => {} });
  const { maxTransferRecords: _drop, ...partial } = SMALL;
  for (const limits of [partial, { ...SMALL, extra: 1 }, { ...SMALL, forgetIdleMs: 0 }, { ...SMALL, windowParts: 5 },
    { ...SMALL, partBytes: MODEL_TRANSFER_LIMITS.partBytes + 1 }, { ...SMALL, maxFlowingPerHost: 5 },
    { ...SMALL, maxTransferRecords: 257 }, { ...SMALL, flowingPerHost: 5 }, { ...SMALL, pauseIdleMs: '60' }, null]) {
    assert.throws(make(limits), RangeError);
  }
  assert.throws(() => createModelRelay({ clock: () => 1, limits: SMALL }), TypeError, 'an events sink is required');
  assert.throws(() => createModelRelay({}), TypeError);
  make({ ...SMALL, windowParts: 1 })();
});

for (const [name, bad] of [['NaN', () => Number.NaN], ['throwing', () => { throw new Error('clock'); }]]) {
  test(`a ${name} clock: ordinary calls refuse, the kill switch and dispose still end everything`, () => {
    let broken = false;
    const clock = () => (broken ? bad() : 1_000_000);
    for (const end of ['limit0', 'dispose']) {
      broken = false;
      const { relay } = makeRelay({ clock });
      const { transferId } = startTransfer(relay, { sizes: [40] });
      mustOk(relay.putPart(SENDER, transferId, 0, 0, bytesOf(4)));
      let woke = 0;
      mustOk(relay.onChange(RECEIVER, transferId, () => { woke += 1; }));
      broken = true;
      assert.equal(reasonOf(relay.listOffers(SENDER, { canReceive: true })), 'host_unavailable');
      mustOk(end === 'limit0' ? relay.setFlowingLimit(0) : relay.dispose());
      const left = relay.resources();
      assert.deepEqual([left.windowBytes, left.listeners, left.offers, woke], [0, 0, 0, 1], end);
      assert.equal(end === 'limit0' ? left.flowingLimit : left.disposed, end === 'limit0' ? 0 : true);
      assert.equal(left.transfers.flowing + left.transfers.accepted + left.transfers.paused, 0);
    }
  });
}

test('setFlowingLimit refuses bad values; lowered with bytes held, flowing transfers finish and admissions wait', () => {
  const { relay } = makeRelay();
  for (const n of [-1, 1.5, Number.NaN, SMALL.maxFlowingPerHost + 1, '2']) assert.equal(reasonOf(relay.setFlowingLimit(n)), 'team_model_request_invalid');
  mustOk(relay.setFlowingLimit(4));
  const ids = [1, 2, 3].map((n) => startTransfer(relay, { from: actor(`s${n}`), by: actor(`r${n}`), to: actor(`r${n}`), sizes: [40] }));
  ids.forEach(({ transferId }, i) => mustOk(relay.putPart(actor(`s${i + 1}`), transferId, 0, 0, bytesOf(4))));
  mustOk(relay.setFlowingLimit(1));
  assert.equal(relay.resources().windowBytes, 12, 'flowing transfers keep their parts');
  assert.equal(relay.resources().transfers.flowing, 3);
  const late = startTransfer(relay, { from: actor('s9'), by: actor('r9'), to: actor('r9') });
  assert.equal(viewOf(relay, late.transferId, actor('s9')).queued, true);
});

// X6b-F04: the admission half of R14-F03 (model-relay-core.js chooseAdmissions).
test('R14-F03: a paused or ended transfer whose parts still stream keeps its slot until the streams end', () => {
  const { relay } = makeRelay();
  mustOk(relay.setFlowingLimit(1));
  const [s1, r1, s2, r2] = [actor('s1'), actor('r1'), actor('s2'), actor('r2')];
  const a = startTransfer(relay, { from: s1, by: r1, to: r1, sizes: [40] }).transferId;
  const b = startTransfer(relay, { from: s2, by: r2, to: r2, sizes: [40] }).transferId;
  for (let part = 0; part < 4; part += 1) mustOk(relay.putPart(s1, a, 0, part, bytesOf(4)));
  const held = [0, 1, 2, 3].map((part) => mustOk(relay.takePart(r1, a, 0, part, { hold: true })));
  const bound = SMALL.windowParts; // flowing limit 1 x the window
  const alive = () => relay.resources().windowParts + relay.resources().streamParts;
  for (const [step, end] of [['paused', () => relay.pause(s1, a)], ['ended', () => relay.cancel(r1, a)]]) {
    mustOk(end());
    assert.ok(relay.resources().streamParts > 0, `${step}: parts of A still stream`);
    assert.equal(viewOf(relay, b, s2).queued, true, `${step}: B waits for A's streams`);
    assert.equal(reasonOf(relay.putPart(s2, b, 0, 0, bytesOf(4))), BUSY);
    assert.ok(alive() <= bound, `${step}: ${alive()} parts alive`);
  }
  for (const hold of held) hold.release();
  assert.equal(relay.resources().streamParts, 0);
  assert.equal(viewOf(relay, b, s2).queued, false, 'admitted once the streams end');
  for (let part = 0; part < 4; part += 1) mustOk(relay.putPart(s2, b, 0, part, bytesOf(4)));
  assert.ok(alive() <= bound);
});

test('dispose twice: the second answers host_unavailable', () => {
  const { relay } = makeRelay();
  mustOk(relay.dispose());
  assert.equal(reasonOf(relay.dispose()), 'host_unavailable');
  assert.equal(reasonOf(relay.sweep()), 'host_unavailable');
  assert.equal(reasonOf(relay.offer(SENDER, body(), { receivers: MEMBERS })), 'host_unavailable');
});

// --- accept, idempotency, offers ----------------------------------------------------------------------

test('accept again: the same start points give the same transfer, other ones are refused, another device is taken', () => {
  const { relay } = makeRelay();
  const { offerId, transferId } = startTransfer(relay, { sizes: [40], resume: [{ index: 0, offset: 8 }] });
  const same = mustOk(relay.accept(RECEIVER, offerId, { resume: [{ index: 0, offset: 8 }], canReceive: true }));
  assert.equal(same.transfer.transfer_id, transferId);
  assert.equal(reasonOf(relay.accept(RECEIVER, offerId, { resume: [{ index: 0, offset: 16 }], canReceive: true })), 'team_model_request_reused');
  assert.deepEqual(viewOf(relay, transferId).next, { index: 0, part: 2 }, 'nothing changed');
  assert.equal(reasonOf(relay.accept(RECEIVER_B, offerId, { canReceive: true })), 'team_model_offer_taken');
});

test('idempotency: one offer per request and body; a changed body, a second device; after the offer ended a new one', () => {
  const { relay, events } = makeRelay();
  const first = mustOk(relay.offer(SENDER, body({ to: RECEIVER }), { receivers: MEMBERS }));
  const count = events.length;
  assert.equal(mustOk(relay.offer(SENDER, body({ to: RECEIVER }), { receivers: MEMBERS })).offer.offer_id, first.offer.offer_id);
  assert.equal(events.length, count, 'a repeat sends no event');
  assert.equal(reasonOf(relay.offer(SENDER, body({ to: RECEIVER, displayName: 'Changed' }), { receivers: MEMBERS })), 'team_model_request_reused');
  assert.equal(reasonOf(relay.offer(actor('sender', 'z'), body({ to: RECEIVER }), { receivers: MEMBERS })), 'team_model_request_reused');
  mustOk(relay.withdraw(SENDER, first.offer.offer_id));
  assert.notEqual(mustOk(relay.offer(SENDER, body({ to: RECEIVER }), { receivers: MEMBERS })).offer.offer_id, first.offer.offer_id);
});

test('complete: only the receiver; a failed complete repeats with its reason; re-accept after cancel and fail', () => {
  const { relay } = makeRelay();
  const { offerId, transferId } = startTransfer(relay);
  assert.equal(reasonOf(relay.complete(SENDER, transferId, { ok: true })), 'team_model_transfer_stale');
  for (const outcome of [{ ok: false, reason: 'free text' }, { ok: true, reason: 'model_exists' }, null, { ok: 'yes' }]) {
    assert.equal(reasonOf(relay.complete(RECEIVER, transferId, outcome)), 'team_model_request_invalid');
  }
  mustOk(relay.complete(RECEIVER, transferId, { ok: false, reason: 'model_exists' }));
  mustOk(relay.complete(RECEIVER, transferId, { ok: false, reason: 'model_exists' }));
  const again = mustOk(relay.accept(RECEIVER, offerId, { canReceive: true })).transfer.transfer_id;
  assert.notEqual(again, transferId);
  mustOk(relay.cancel(SENDER, again));
  assert.notEqual(mustOk(relay.accept(RECEIVER, offerId, { canReceive: true })).transfer.transfer_id, again);
});

test('decline of a direct offer ends it for the sender', () => {
  const { relay, events } = makeRelay();
  const made = mustOk(relay.offer(SENDER, body({ to: RECEIVER }), { receivers: MEMBERS }));
  mustOk(relay.decline(RECEIVER, made.offer.offer_id, { canReceive: true }));
  assert.equal(relay.resources().offers, 0);
  assert.equal(events.at(-1).payload.reason, 'declined');
});

test('manifest refusals map to the relay reasons; a zero or fractional size is malformed, not a size limit', () => {
  const { relay } = makeRelay();
  const send = (patch) => reasonOf(relay.offer(SENDER, { ...body(), ...patch }, { receivers: MEMBERS }));
  const file = (fields) => ({ name: 'Model-Q4_K_M.gguf', size: 10, sha256: HASH, segments: [HASH], ...fields });
  const big = (n) => ({ name: `Big-Q8_0-0000${n}-of-00005.gguf`, size: 60 * 1024 ** 3, sha256: HASH, segments: Array(60).fill(HASH) });
  assert.equal(send({ files: [file({ name: '.hidden.gguf' })] }), 'team_model_name_invalid');
  assert.equal(send({ files: [file({}), file({ name: 'MODEL-q4_k_m.gguf' })] }), 'team_model_name_invalid');
  assert.equal(send({ files: [file({ size: 0 })] }), 'team_model_manifest_invalid');
  assert.equal(send({ files: [file({ size: 1.5 })] }), 'team_model_manifest_invalid');
  assert.equal(send({ files: [file({ size: 65 * 1024 ** 3, segments: Array(65).fill(HASH) })] }), 'team_model_size_limit');
  assert.equal(send({ files: [1, 2, 3, 4, 5].map(big) }), 'team_model_size_limit');
  assert.equal(send({ display_name: 'x'.repeat(70_000) }), 'team_model_size_limit');
  assert.equal(send({ request_id: 'bad id' }), 'team_model_manifest_invalid');
  assert.equal(send({ audience: { kind: 'crowd' } }), 'team_model_manifest_invalid');
  assert.equal(send({ files: [file({ sha256: 'x' })] }), 'team_model_manifest_invalid');
});

// --- time ---------------------------------------------------------------------------------------------

test('time: 60 s with no part pauses, through sweep and lazily; a repeated take of a served part does not reset it', () => {
  const { relay, clock } = makeRelay();
  const { transferId } = startTransfer(relay);
  mustOk(relay.putPart(SENDER, transferId, 0, 0, bytesOf(4)));
  mustOk(relay.takePart(RECEIVER, transferId, 0, 0));
  clock.advance(SMALL.pauseIdleMs - 1);
  mustOk(relay.takePart(RECEIVER, transferId, 0, 0));
  clock.advance(1);
  assert.equal(reasonOf(relay.putPart(SENDER, transferId, 0, 1, bytesOf(4))), 'team_model_transfer_stale', 'lazily paused');
  assert.equal(viewOf(relay, transferId).reason, 'idle');
  const swept = makeRelay();
  const t = startTransfer(swept.relay).transferId;
  swept.clock.advance(SMALL.pauseIdleMs);
  mustOk(swept.relay.sweep());
  assert.equal(viewOf(swept.relay, t).reason, 'idle', 'an admitted transfer with no first part pauses too');
});

test('time: resume is refused while the sender device is gone, after an idle or a party pause', () => {
  const { relay, clock } = makeRelay();
  const idle = startTransfer(relay).transferId;
  clock.advance(SMALL.pauseIdleMs);
  mustOk(relay.sweep());
  mustOk(relay.deviceGone(SENDER.deviceId));
  assert.equal(reasonOf(relay.resume(RECEIVER, idle)), 'team_model_sender_offline');
  const party = makeRelay().relay;
  const p = startTransfer(party).transferId;
  mustOk(party.pause(SENDER, p));
  mustOk(party.deviceGone(SENDER.deviceId));
  assert.equal(reasonOf(party.resume(SENDER, p)), 'team_model_sender_offline');
});

test('time: the sender device gone ends its offers after 120 s; back inside the grace keeps them', () => {
  const { relay, clock } = makeRelay();
  const { transferId } = startTransfer(relay);
  mustOk(relay.deviceGone(SENDER.deviceId));
  clock.advance(SMALL.senderGraceMs - 1);
  mustOk(relay.deviceBack(SENDER.deviceId));
  assert.equal(stateOf(relay, transferId), 'accepted');
  mustOk(relay.deviceGone(SENDER.deviceId));
  clock.advance(SMALL.senderGraceMs);
  assert.equal(stateOf(relay, transferId), 'cancelled', 'lazily on the next call');
  assert.equal(viewOf(relay, transferId).reason, 'sender_offline');
  const team = makeRelay();
  const made = mustOk(team.relay.offer(SENDER, body(), { receivers: MEMBERS }));
  mustOk(team.relay.deviceGone(SENDER.deviceId));
  assert.equal(reasonOf(team.relay.accept(RECEIVER, made.offer.offer_id, { canReceive: true })), 'team_model_sender_offline');
  team.clock.advance(SMALL.senderGraceMs);
  mustOk(team.relay.sweep());
  assert.equal(team.relay.resources().offers, 0);
});

test('time: a direct offer ends at 24 h and an idle transfer is forgotten at 1 h, each lazily and through sweep', () => {
  for (const lazy of [true, false]) {
    const { relay, clock } = makeRelay();
    const made = mustOk(relay.offer(SENDER, body({ to: RECEIVER }), { receivers: MEMBERS }));
    clock.advance(SMALL.directOfferLifeMs - 1);
    assert.equal(mustOk(relay.getOffer(RECEIVER, made.offer.offer_id, { canReceive: true })).offer.state, 'open');
    clock.advance(1);
    if (!lazy) mustOk(relay.sweep());
    assert.equal(reasonOf(relay.getOffer(RECEIVER, made.offer.offer_id, { canReceive: true })), 'team_not_found');
    const idle = makeRelay();
    const t = startTransfer(idle.relay).transferId;
    mustOk(idle.relay.putPart(SENDER, t, 0, 0, bytesOf(4)));
    idle.clock.advance(SMALL.forgetIdleMs);
    if (!lazy) mustOk(idle.relay.sweep());
    assert.equal(reasonOf(idle.relay.takePart(RECEIVER, t, 0, 0)), 'team_not_found');
    assert.ok(idle.events.some((e) => e.type === 'team_model_offer' && e.payload.state === 'open' && e.payload.reason === null
      && idle.events.indexOf(e) > 2), 'the forgotten direct transfer reopened its offer with an event');
  }
});

test('time: a taken direct offer does not expire at 24 h while its transfer flows', () => {
  const { relay, clock } = makeRelay();
  const parts = Math.ceil(SMALL.directOfferLifeMs / 50_000) + 2;
  const { offerId, transferId } = startTransfer(relay, { sizes: [parts * 4] });
  for (let part = 0; part < parts - 1; part += 1) {
    mustOk(relay.putPart(SENDER, transferId, 0, part, bytesOf(4)));
    mustOk(relay.takePart(RECEIVER, transferId, 0, part));
    clock.advance(50_000);
  }
  assert.equal(stateOf(relay, transferId), 'flowing');
  assert.equal(mustOk(relay.getOffer(RECEIVER, offerId, { canReceive: true })).offer.state, 'taken');
});

// --- members and leaks --------------------------------------------------------------------------------

test('memberGone and roleChanged end everything of that member; roleChanged(true) changes nothing', () => {
  const { relay } = makeRelay();
  const out = startTransfer(relay, { requestId: 'o' });
  const inc = startTransfer(relay, { from: OTHER, to: SENDER, by: SENDER, requestId: 'i' });
  mustOk(relay.roleChanged(SENDER.memberId, true));
  assert.equal(stateOf(relay, out.transferId), 'accepted');
  mustOk(relay.roleChanged(SENDER.memberId, false));
  assert.deepEqual([stateOf(relay, out.transferId), viewOf(relay, inc.transferId, OTHER).state], ['cancelled', 'cancelled']);
  assert.equal(relay.resources().offers, 0, 'its own offers and the direct offer to it ended');
  assert.equal(relay.resources().requestIds, 0, 'no request id outlives its offer');
  const team = makeRelay().relay;
  const offerId = mustOk(team.offer(SENDER, body(), { receivers: MEMBERS })).offer.offer_id;
  const t = mustOk(team.accept(RECEIVER, offerId, { canReceive: true })).transfer.transfer_id;
  mustOk(team.memberGone(RECEIVER.memberId));
  assert.equal(viewOf(team, t).reason, 'member_gone');
  assert.equal(team.resources().offers, 1, 'the team offer stands for the others');
});

test('no part bytes and no listener stay after any ending; no timer is ever created', (t) => {
  const counted = [];
  for (const name of ['setTimeout', 'setInterval', 'setImmediate']) t.mock.method(globalThis, name, () => { counted.push(name); return 0; });
  const endings = {
    done: (r, id) => r.complete(RECEIVER, id, { ok: true }),
    failed: (r, id) => r.complete(RECEIVER, id, { ok: false, reason: 'model_not_gguf' }),
    cancelled: (r, id) => r.cancel(SENDER, id),
    forgotten: (r, _id, clock) => { clock.advance(SMALL.forgetIdleMs); return r.sweep(); },
    paused: (r, id) => r.pause(RECEIVER, id),
    memberGone: (r) => r.memberGone(RECEIVER.memberId),
    withdraw: (r, _id, _clock, offerId) => r.withdraw(SENDER, offerId),
    grace: (r, _id, clock) => { mustOk(r.deviceGone(SENDER.deviceId)); clock.advance(SMALL.senderGraceMs); return r.sweep(); },
    limit0: (r) => r.setFlowingLimit(0),
    dispose: (r) => r.dispose(),
  };
  for (const [name, end] of Object.entries(endings)) {
    const { relay, clock } = makeRelay();
    const { transferId, offerId } = startTransfer(relay, { sizes: [40] });
    for (let part = 0; part < 4; part += 1) mustOk(relay.putPart(SENDER, transferId, 0, part, bytesOf(4)));
    let woke = 0;
    mustOk(relay.onChange(SENDER, transferId, () => { woke += 1; }));
    mustOk(relay.onChange(RECEIVER, transferId, () => { woke += 1; }));
    mustOk(end(relay, transferId, clock, offerId));
    const left = relay.resources();
    assert.deepEqual([left.windowBytes, left.windowParts, left.listeners, left.pendingEvents], [0, 0, 0, 0], name);
    assert.equal(woke, 2, `${name}: waiting routes are woken`);
  }
  // An expired direct offer holds nothing either.
  const { relay, clock } = makeRelay();
  mustOk(relay.offer(SENDER, body({ to: RECEIVER }), { receivers: MEMBERS }));
  clock.advance(SMALL.directOfferLifeMs);
  mustOk(relay.sweep());
  assert.deepEqual([relay.resources().offers, relay.resources().requestIds], [0, 0]);
  assert.deepEqual(counted, []);
});

test('the memory bound: at most the maximum setting x window parts x part size', () => {
  const { relay } = makeRelay();
  mustOk(relay.setFlowingLimit(SMALL.maxFlowingPerHost));
  for (let n = 1; n <= 5; n += 1) {
    const { transferId } = startTransfer(relay, { from: actor(`s${n}`), by: actor(`r${n}`), to: actor(`r${n}`), sizes: [40] });
    for (let part = 0; part <= SMALL.windowParts; part += 1) relay.putPart(actor(`s${n}`), transferId, 0, part, bytesOf(4));
  }
  assert.equal(relay.resources().windowBytes, SMALL.maxFlowingPerHost * SMALL.windowParts * SMALL.partBytes);
  assert.equal(MODEL_TRANSFER_LIMITS.maxFlowingPerHost * MODEL_TRANSFER_LIMITS.windowParts * MODEL_TRANSFER_LIMITS.partBytes,
    64 * 1024 * 1024, 'the spec\'s 64 MiB at the maximum setting');
});
