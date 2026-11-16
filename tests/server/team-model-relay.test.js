'use strict';

// Slice 6-2: the model relay (server/team/model-relay.js, TEAM_MODEL_SHARING_SPEC "The relay" and "6-2 as
// built"). The spec's red tests, the state table cell by cell with its reasons, the transition table,
// event audiences, parties and visibility, and redaction. Caps, time and edge cases: team-model-relay-cases.

const assert = require('node:assert/strict');
const test = require('node:test');

const { MODEL_RELAY_ID_PATTERNS, TRANSFER_TRANSITIONS } = require('../../server/team/model-relay-core');
const {
  MEMBERS, NOT_FOUND, OTHER, RECEIVER, RECEIVER_B, SENDER, SMALL, actor, body, bytesOf, makeRelay, mustOk, reasonOf,
  startTransfer, viewOf,
} = require('./helpers/model-relay-fixture');

test('the spec red test: a third party reading a part gets the not-found answer', () => {
  const { relay } = makeRelay();
  const { transferId } = startTransfer(relay);
  mustOk(relay.putPart(SENDER, transferId, 0, 0, bytesOf(4)));
  assert.deepEqual(relay.takePart(OTHER, transferId, 0, 0), NOT_FOUND);
  assert.deepEqual(relay.takePart(RECEIVER_B, transferId, 0, 0), NOT_FOUND, 'the receiver member on another device');
  assert.deepEqual(relay.takePart(SENDER, transferId, 0, 0), NOT_FOUND, 'the sender never takes');
  assert.deepEqual(relay.putPart(RECEIVER, transferId, 0, 1, bytesOf(4)), NOT_FOUND, 'the receiver never puts');
});

test('the spec red test: a new instance knows no offer and no transfer', () => {
  const { relay } = makeRelay();
  const { offerId, transferId } = startTransfer(relay);
  const fresh = makeRelay().relay;
  assert.deepEqual(fresh.takePart(RECEIVER, transferId, 0, 0), NOT_FOUND);
  assert.deepEqual(fresh.accept(RECEIVER, offerId, { canReceive: true }), NOT_FOUND);
  const listed = mustOk(fresh.listOffers(RECEIVER, { canReceive: true }));
  assert.deepEqual([listed.offers, listed.transfers], [[], []]);
  assert.equal(fresh.resources().offers, 0);
});

// --- the state table ----------------------------------------------------------------------------------

function stateOf(relay, transferId) {
  if (relay.resources().flowingLimit === 0) mustOk(relay.setFlowingLimit(2));
  const view = viewOf(relay, transferId);
  return view ? `${view.state} ${view.reason ?? '-'}` : 'forgotten -';
}

function setUp(row) {
  const made = makeRelay();
  const { relay, clock } = made;
  if (row === 'queued') {
    mustOk(relay.setFlowingLimit(1));
    const blocker = mustOk(relay.offer(actor('blocker'), body({ to: OTHER }), { receivers: MEMBERS })).offer.offer_id;
    mustOk(relay.accept(OTHER, blocker, { canReceive: true }));
  }
  const team = row.startsWith('team');
  const { transferId, offerId } = startTransfer(relay, { sizes: [40], to: team ? null : RECEIVER });
  if (!['queued', 'accepted'].includes(row)) mustOk(relay.putPart(SENDER, transferId, 0, 0, bytesOf(4)));
  if (row === 'paused_sender') mustOk(relay.pause(SENDER, transferId));
  if (row === 'paused_idle') {
    clock.advance(SMALL.pauseIdleMs);
    mustOk(relay.sweep());
  }
  if (row === 'paused_offline') mustOk(relay.deviceGone(SENDER.deviceId));
  if (row === 'done' || row === 'team_done') mustOk(relay.complete(RECEIVER, transferId, { ok: true }));
  if (row === 'failed') mustOk(relay.complete(RECEIVER, transferId, { ok: false, reason: 'model_hash_mismatch' }));
  if (row === 'cancelled') mustOk(relay.cancel(RECEIVER, transferId));
  if (row === 'queued') assert.equal(viewOf(relay, transferId).queued, true);
  return { ...made, transferId, offerId };
}

const TRIGGERS = {
  put: ({ relay, transferId }) => {
    const next = viewOf(relay, transferId).next || { index: 0, part: 0 };
    return relay.putPart(SENDER, transferId, next.index, next.part, bytesOf(4));
  },
  take: ({ relay, transferId }) => relay.takePart(RECEIVER, transferId, 0, 0),
  check: ({ relay, transferId }) => {
    const next = viewOf(relay, transferId).next || { index: 0, part: 0 };
    return relay.checkPut(SENDER, transferId, next.index, next.part);
  },
  listen: ({ relay, transferId }) => relay.onChange(RECEIVER, transferId, () => {}),
  list: ({ relay }) => relay.listOffers(RECEIVER, { canReceive: true }),
  accept: ({ relay, offerId }) => relay.accept(RECEIVER, offerId, { canReceive: true }),
  decline: ({ relay, offerId }) => relay.decline(RECEIVER, offerId, { canReceive: true }),
  pause_s: ({ relay, transferId }) => relay.pause(SENDER, transferId),
  pause_r: ({ relay, transferId }) => relay.pause(RECEIVER, transferId),
  resume_s: ({ relay, transferId }) => relay.resume(SENDER, transferId),
  resume_r: ({ relay, transferId }) => relay.resume(RECEIVER, transferId),
  cancel_s: ({ relay, transferId }) => relay.cancel(SENDER, transferId),
  cancel_r: ({ relay, transferId }) => relay.cancel(RECEIVER, transferId),
  complete_ok: ({ relay, transferId }) => relay.complete(RECEIVER, transferId, { ok: true }),
  complete_fail: ({ relay, transferId }) => relay.complete(RECEIVER, transferId, { ok: false, reason: 'model_hash_mismatch' }),
  withdraw: ({ relay, offerId }) => relay.withdraw(SENDER, offerId),
  member_gone: ({ relay }) => relay.memberGone(RECEIVER.memberId),
  role_off: ({ relay }) => relay.roleChanged(SENDER.memberId, false),
  device_gone: ({ relay }) => relay.deviceGone(SENDER.deviceId),
  device_back: ({ relay }) => relay.deviceBack(SENDER.deviceId),
  limit0: ({ relay }) => relay.setFlowingLimit(0),
  idle_60s: ({ relay, clock }) => { clock.advance(SMALL.pauseIdleMs); return relay.sweep(); },
  grace_120s: ({ relay, clock }) => { clock.advance(SMALL.senderGraceMs); return relay.sweep(); },
  forget_1h: ({ relay, clock }) => { clock.advance(SMALL.forgetIdleMs); return relay.sweep(); },
};

// Each cell: the answer ('ok' or a reason word), the state after and its reason ('-' for none).
const S = 'team_model_transfer_stale';
const NF = 'team_not_found';
const OFF = 'team_model_sender_offline';
const BUSY = 'team_model_relay_busy';
const ENDINGS = {
  cancel_s: 'ok cancelled cancelled_by_sender', cancel_r: 'ok cancelled cancelled_by_receiver', complete_ok: 'ok done -',
  complete_fail: 'ok failed model_hash_mismatch', withdraw: 'ok cancelled withdrawn', member_gone: 'ok cancelled member_gone',
  role_off: 'ok cancelled role_changed', limit0: 'ok cancelled sharing_off',
};
function liveRow(now, cells) {
  return {
    ...ENDINGS, listen: `ok ${now}`, list: `ok ${now}`, accept: `ok ${now}`, decline: `${S} ${now}`,
    pause_s: 'ok paused paused_by_sender', pause_r: 'ok paused paused_by_receiver', resume_s: `ok ${now}`, resume_r: `ok ${now}`,
    device_gone: 'ok paused sender_offline', device_back: `ok ${now}`, forget_1h: 'forgotten', ...cells,
  };
}
function pausedRow(why, cells) {
  const now = `paused ${why}`;
  return {
    ...ENDINGS, put: `${S} ${now}`, take: `${S} ${now}`, check: `${S} ${now}`, listen: `ok ${now}`, list: `ok ${now}`,
    accept: `ok ${now}`, decline: `${S} ${now}`, pause_s: `ok ${now}`, pause_r: `ok ${now}`, device_gone: `ok ${now}`,
    device_back: `ok ${now}`, idle_60s: `ok ${now}`, grace_120s: `ok ${now}`, forget_1h: 'ok forgotten -', ...cells,
  };
}
function endedRow(now, cells) {
  const same = Object.fromEntries(Object.keys(TRIGGERS).map((key) => [key, `ok ${now}`]));
  for (const key of ['put', 'take', 'check', 'listen', 'pause_s', 'pause_r', 'resume_s', 'resume_r', 'cancel_s', 'cancel_r',
    'complete_ok', 'complete_fail']) same[key] = `${S} ${now}`;
  return { ...same, forget_1h: 'ok forgotten -', ...cells };
}
const QUEUED = 'accepted -';
const TABLE = {
  // Queued: no slot, so no idle pause and no forgetting for waiting (the blocker ahead of it is).
  queued: liveRow(QUEUED, { put: `${BUSY} ${QUEUED}`, take: `ok ${QUEUED}`, check: `${BUSY} ${QUEUED}`,
    idle_60s: `ok ${QUEUED}`, grace_120s: `ok ${QUEUED}`, forget_1h: `ok ${QUEUED}` }),
  accepted: liveRow(QUEUED, { put: 'ok flowing -', take: `ok ${QUEUED}`, check: `ok ${QUEUED}`,
    idle_60s: 'ok paused idle', grace_120s: 'ok paused idle', forget_1h: 'ok forgotten -' }),
  flowing: liveRow('flowing -', { put: 'ok flowing -', take: 'ok flowing -', check: 'ok flowing -',
    idle_60s: 'ok paused idle', grace_120s: 'ok paused idle', forget_1h: 'ok forgotten -' }),
  paused_sender: pausedRow('paused_by_sender', { resume_s: `ok ${QUEUED}`, resume_r: `${S} paused paused_by_sender` }),
  paused_idle: pausedRow('idle', { resume_s: `ok ${QUEUED}`, resume_r: `ok ${QUEUED}` }),
  paused_offline: pausedRow('sender_offline', {
    resume_s: `${OFF} paused sender_offline`, resume_r: `${OFF} paused sender_offline`, device_back: `ok ${QUEUED}`,
    grace_120s: 'ok cancelled sender_offline', forget_1h: 'ok cancelled sender_offline',
  }),
  // A done direct offer is fulfilled and gone.
  done: endedRow('done -', { accept: `${NF} done -`, decline: `${NF} done -`, withdraw: `${NF} done -`, complete_ok: 'ok done -' }),
  // A failed or cancelled direct offer is open again: accept makes a new transfer, decline ends the offer.
  failed: endedRow('failed model_hash_mismatch', { complete_fail: 'ok failed model_hash_mismatch' }),
  cancelled: endedRow('cancelled cancelled_by_receiver', {
    cancel_s: 'ok cancelled cancelled_by_receiver', cancel_r: 'ok cancelled cancelled_by_receiver',
  }),
  team_flowing: liveRow('flowing -', { put: 'ok flowing -', take: 'ok flowing -', check: 'ok flowing -',
    idle_60s: 'ok paused idle', grace_120s: 'ok paused idle', forget_1h: 'ok forgotten -' }),
  // A team offer survives a done transfer.
  team_done: endedRow('done -', { complete_ok: 'ok done -' }),
};

test('the state table: every state against every call and every time-based change, with its reason', () => {
  const triggers = Object.keys(TRIGGERS).sort();
  for (const [row, cells] of Object.entries(TABLE)) {
    assert.deepEqual(Object.keys(cells).sort(), triggers, `row ${row} names every trigger`);
    for (const trigger of triggers) {
      const fixture = setUp(row);
      const answer = reasonOf(TRIGGERS[trigger](fixture));
      const expected = cells[trigger] === 'forgotten' ? 'ok forgotten -' : cells[trigger];
      assert.equal(`${answer} ${stateOf(fixture.relay, fixture.transferId)}`, expected, `${row} x ${trigger}`);
    }
  }
});

test('the transition table is exactly the spec table', () => {
  const cancel = ['cancelled_by_sender', 'cancelled_by_receiver', 'withdrawn', 'declined', 'expired', 'member_gone',
    'role_changed', 'sender_offline', 'sharing_off', 'host_stopping'];
  const pauses = ['paused_by_sender', 'paused_by_receiver', 'sender_offline', 'idle'];
  const ends = (from) => ({ [`${from}>done`]: ['complete_ok'], [`${from}>failed`]: ['complete_failed'], [`${from}>cancelled`]: cancel });
  assert.deepEqual(JSON.parse(JSON.stringify(TRANSFER_TRANSITIONS)), {
    'accepted>flowing': ['first_part'], 'accepted>paused': pauses, 'flowing>paused': pauses,
    'paused>accepted': ['resumed', 'sender_back'], ...ends('accepted'), ...ends('flowing'), ...ends('paused'),
  });
});

// --- events -------------------------------------------------------------------------------------------

test('answers carry no events; every event goes to the sink with its parties only', () => {
  const { relay, events, clock } = makeRelay();
  const team = mustOk(relay.offer(SENDER, body({ requestId: 't' }), { receivers: [RECEIVER.memberId, OTHER.memberId] }));
  assert.equal('events' in team, false);
  const direct = mustOk(relay.offer(SENDER, body({ to: RECEIVER, requestId: 'd' }), { receivers: MEMBERS }));
  const t = mustOk(relay.accept(RECEIVER, direct.offer.offer_id, { canReceive: true })).transfer.transfer_id;
  mustOk(relay.cancel(RECEIVER, t));
  const t2 = mustOk(relay.accept(RECEIVER, direct.offer.offer_id, { canReceive: true })).transfer.transfer_id;
  clock.advance(SMALL.forgetIdleMs);
  mustOk(relay.sweep());
  const seen = events.length;
  const third = mustOk(relay.listOffers(OTHER, { canReceive: true }));
  assert.equal(events.length, seen, 'a third member\'s call delivers nothing');
  assert.equal(third.transfers.length, 0, 'and lists none of another pair\'s transfers');
  mustOk(relay.memberGone(RECEIVER.memberId));
  const pair = [SENDER.memberId, RECEIVER.memberId].sort();
  const audience = (event) => [...event.audience].sort();
  const offerEvents = (id, state) => events.filter((e) => e.type === 'team_model_offer' && e.payload.offer_id === id && e.payload.state === state);
  assert.deepEqual(audience(offerEvents(team.offer.offer_id, 'open')[0]), [...MEMBERS].sort(), 'a team offer: sender and receivers');
  assert.deepEqual(audience(offerEvents(direct.offer.offer_id, 'open')[0]), pair, 'a direct offer: sender and receiver');
  assert.equal(offerEvents(direct.offer.offer_id, 'open').length, 3, 'opened, reopened on cancel, reopened on forget');
  assert.deepEqual(audience(offerEvents(direct.offer.offer_id, 'ended')[0]), pair, 'memberGone');
  for (const event of events.filter((e) => e.type === 'team_model_transfer')) assert.deepEqual(audience(event), pair);
  assert.ok(events.some((e) => e.payload.transfer_id === t2 && e.payload.state === 'forgotten'));
  assert.ok(events.every((e) => !JSON.stringify(e).includes('Apache')), 'no provenance in any event');
  assert.equal(relay.resources().pendingEvents, 0);
});

test('a throwing sink or listener changes nothing; a listener may call the relay from inside itself', () => {
  const { relay } = makeRelay();
  const { transferId } = startTransfer(relay);
  const inner = [];
  mustOk(relay.onChange(RECEIVER, transferId, () => { inner.push(relay.takePart(RECEIVER, transferId, 0, 0)); }));
  mustOk(relay.onChange(RECEIVER, transferId, () => { throw new Error('boom'); }));
  mustOk(relay.putPart(SENDER, transferId, 0, 0, bytesOf(4)));
  assert.equal(inner.length, 1);
  assert.ok(inner[0].bytes.equals(bytesOf(4)));
  const sinkThrows = require('../../server/team/model-relay').createModelRelay({
    clock: () => 1, randomBytes: require('node:crypto').randomBytes, limits: SMALL, onEvents: () => { throw new Error('sink'); },
  });
  mustOk(sinkThrows.offer(SENDER, body(), { receivers: MEMBERS }));
  assert.equal(sinkThrows.resources().pendingEvents, 0);
});

// --- parties and visibility ---------------------------------------------------------------------------

test('a direct offer is visible to its member only when it may receive; a team offer follows canReceive and decline', () => {
  const { relay } = makeRelay();
  const direct = mustOk(relay.offer(SENDER, body({ to: RECEIVER, requestId: 'd' }), { receivers: MEMBERS })).offer.offer_id;
  const team = mustOk(relay.offer(SENDER, body({ requestId: 't' }), { receivers: MEMBERS })).offer.offer_id;
  const seen = (who, canReceive) => mustOk(relay.listOffers(who, { canReceive })).offers.map((o) => o.offer_id).sort();
  assert.deepEqual(seen(OTHER, true), [team]);
  assert.deepEqual(seen(OTHER, false), []);
  assert.deepEqual(seen(RECEIVER, true), [direct, team].sort());
  assert.deepEqual(seen(RECEIVER, false), [], 'a demoted member sees not even its direct offer');
  assert.deepEqual(seen(actor('sender', 'z'), false), [direct, team].sort(), 'the sending member\'s other devices see its offers');
  assert.deepEqual(relay.accept(RECEIVER, direct, { canReceive: false }), NOT_FOUND);
  assert.deepEqual(relay.decline(RECEIVER, direct, { canReceive: false }), NOT_FOUND);
  assert.deepEqual(relay.getOffer(RECEIVER, direct, { canReceive: false }), NOT_FOUND);
  assert.deepEqual(relay.accept(OTHER, direct, { canReceive: true }), NOT_FOUND);
  assert.deepEqual(relay.accept(SENDER, team, { canReceive: true }), NOT_FOUND, 'the sender cannot accept its own');
  mustOk(relay.decline(OTHER, team, { canReceive: true }));
  assert.deepEqual(seen(OTHER, true), []);
  mustOk(relay.accept(RECEIVER, direct, { canReceive: true }));
  assert.ok(seen(RECEIVER_B, true).includes(direct), 'the same member sees the taken offer');
  assert.equal(reasonOf(relay.offer(SENDER, body({ to: actor('stranger'), requestId: 's' }), { receivers: MEMBERS })), NF);
});

test('the list is a summary; one offer read gives the manifest to whoever may see it', () => {
  const { relay } = makeRelay();
  const made = mustOk(relay.offer(SENDER, body({ to: RECEIVER }), { receivers: MEMBERS }));
  const [listed] = mustOk(relay.listOffers(RECEIVER, { canReceive: true })).offers;
  assert.deepEqual(Object.keys(listed).sort(), ['audience', 'display_name', 'files', 'offer_id', 'sender_member_id', 'state', 'total_bytes']);
  assert.equal(mustOk(relay.getOffer(RECEIVER, made.offer.offer_id, { canReceive: true })).manifest.files[0].sha256.length, 64);
  mustOk(relay.getOffer(actor('sender', 'z'), made.offer.offer_id, {}));
  assert.deepEqual(relay.getOffer(OTHER, made.offer.offer_id, { canReceive: true }), NOT_FOUND);
});

test('every not-yours answer deep-equals the not-there answer', () => {
  const { relay } = makeRelay();
  const { transferId, offerId } = startTransfer(relay);
  const unknownT = 'mxfer_AAAAAAAAAAAAAAAAAAAAAA';
  const unknownO = 'offer_AAAAAAAAAAAAAAAAAAAAAA';
  const calls = [
    (who, t) => relay.pause(who, t), (who, t) => relay.resume(who, t), (who, t) => relay.cancel(who, t),
    (who, t) => relay.complete(who, t, { ok: true }), (who, t) => relay.checkPut(who, t, 0, 0),
    (who, t) => relay.putPart(who, t, 0, 0, bytesOf(4)), (who, t) => relay.takePart(who, t, 0, 0),
    (who, t) => relay.onChange(who, t, () => {}),
  ];
  for (const fn of calls) {
    assert.deepEqual(fn(OTHER, transferId), NOT_FOUND);
    assert.deepEqual(fn(OTHER, unknownT), NOT_FOUND);
    assert.deepEqual(fn(SENDER, 'garbage'), NOT_FOUND);
    assert.deepEqual(fn({ memberId: 'x', deviceId: 'y' }, transferId), NOT_FOUND);
  }
  for (const fn of [(who, o) => relay.withdraw(who, o), (who, o) => relay.decline(who, o, { canReceive: true }),
    (who, o) => relay.getOffer(who, o, { canReceive: true })]) {
    assert.deepEqual(fn(OTHER, offerId), NOT_FOUND);
    assert.deepEqual(fn(SENDER, unknownO), NOT_FOUND);
  }
  assert.deepEqual(relay.withdraw(actor('sender', 'z'), offerId), NOT_FOUND, 'only the offering device withdraws');
  assert.match(offerId, MODEL_RELAY_ID_PATTERNS.offer);
  assert.match(transferId, MODEL_RELAY_ID_PATTERNS.transfer);
});

// --- redaction ----------------------------------------------------------------------------------------

test('no name, display name, hash, licence or URL reaches a log record; refusals are the fixed shapes', () => {
  const logs = [];
  const { relay } = makeRelay({ logs });
  const marked = body({ to: RECEIVER, displayName: 'MARKERDISPLAY', provenance: {
    licence: 'MARKERLICENCE', source_url: 'https://markerhost.example/MARKERURL', note: 'MARKERNOTE' } });
  marked.files[0].sha256 = 'beef'.repeat(16);
  marked.files[0].segments = ['cafe'.repeat(16)];
  marked.files[0].name = 'MARKERNAME-Q4_K_M.gguf';
  const made = mustOk(relay.offer(SENDER, marked, { receivers: MEMBERS }));
  const fixed = (code, reason, retryable = false) => ({ ok: false, error: { code, reason, retryable } });
  assert.deepEqual(relay.offer(SENDER, { ...marked, display_name: 'MARKERDISPLAY2' }, { receivers: MEMBERS }),
    fixed('CMP-HOST-0004', 'team_model_request_reused'));
  assert.deepEqual(relay.offer(SENDER, { ...marked, request_id: 'r2', files: [{ ...marked.files[0], name: 'MARKER/bad.gguf' }] },
    { receivers: MEMBERS }), fixed('CMP-HOST-0001', 'team_model_name_invalid'));
  const t = mustOk(relay.accept(RECEIVER, made.offer.offer_id, { canReceive: true })).transfer.transfer_id;
  mustOk(relay.putPart(SENDER, t, 0, 0, bytesOf(4)));
  assert.deepEqual(relay.takePart(OTHER, t, 0, 0), NOT_FOUND);
  assert.deepEqual(relay.putPart(SENDER, t, 0, 5, bytesOf(4)), fixed('CMP-HOST-0007', 'team_model_size_limit'));
  mustOk(relay.complete(RECEIVER, t, { ok: false, reason: 'model_hash_mismatch' }));
  mustOk(relay.dispose());
  const text = JSON.stringify(logs);
  for (const marker of ['MARKER', 'markerhost', 'beef', 'cafe']) assert.ok(!text.includes(marker), marker);
  assert.ok(logs.length > 0);
});

test('partyLive (slice 6-3 routes): ok for either party while live; stale once ended; not-found for anyone else', () => {
  const { relay, events } = makeRelay();
  const { transferId } = startTransfer(relay);
  const before = events.length;
  assert.deepEqual(relay.partyLive(SENDER, transferId), { ok: true });
  assert.deepEqual(relay.partyLive(RECEIVER, transferId), { ok: true });
  assert.deepEqual(relay.partyLive(OTHER, transferId), NOT_FOUND);
  assert.deepEqual(relay.partyLive(RECEIVER_B, transferId), NOT_FOUND);
  assert.deepEqual(relay.partyLive(SENDER, 'mxfer_short'), NOT_FOUND);
  assert.equal(events.length, before, 'a read emits nothing');
  mustOk(relay.cancel(RECEIVER, transferId));
  assert.equal(reasonOf(relay.partyLive(SENDER, transferId)), 'team_model_transfer_stale');
});
