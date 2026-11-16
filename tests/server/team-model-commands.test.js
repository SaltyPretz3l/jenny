'use strict';

// new-test-file: slice 6-3's model command family and host wiring (server/team/model-commands.js,
// server/team/model-sharing.js) is a new surface; its part routes are in team-model-routes.test.js.

const assert = require('node:assert/strict');
const test = require('node:test');

const { ID_PATTERNS } = require('../../server/team/ids');
const { COMPLETE_REASONS, MODEL_RELAY_ID_PATTERNS, RELAY_FAILURES } = require('../../server/team/model-relay-core');
const { MODEL_TRANSFER_LIMITS } = require('../../server/team/model-manifest');
const { createModelRelay } = require('../../server/team/model-relay');
const { memberStreamFanOut, sweepPeriodMs } = require('../../server/team/model-sharing');
const { createTeamCommands } = require('../../server/team/team-commands');
const { PARAM_SCHEMAS, TEAM_MODEL_REASONS } = require('../../server/api-contract');
const { clean, makeSharing, manifest, reasonOf } = require('./helpers/team-model-fixture');

const NOT_FOUND = { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_not_found', retryable: false } };
const UNKNOWN_OFFER = `offer_${'A'.repeat(22)}`;
const UNKNOWN_TRANSFER = `mxfer_${'A'.repeat(22)}`;
const strip = (answer) => (answer.ok ? answer : { ok: false, error: { ...answer.error, request_id: undefined } });
const noRequestId = (answer) => JSON.parse(JSON.stringify(strip(answer)));

function offerAndAccept(env, { from, to, by = to, team = false } = {}) {
  const offered = env.send(from, 'team.model.offer', manifest({ to: team ? null : to }));
  assert.equal(reasonOf(offered), 'ok');
  const accepted = env.send(by, 'team.model.accept', { offer_id: offered.offer.offer_id });
  assert.equal(reasonOf(accepted), 'ok');
  return { offerId: offered.offer.offer_id, transferId: accepted.transfer.transfer_id };
}

test('one source: id kinds and schema ids are the relay\'s patterns, the complete enum is COMPLETE_REASONS', () => {
  assert.equal(ID_PATTERNS.model_offer.source, MODEL_RELAY_ID_PATTERNS.offer.source);
  assert.equal(ID_PATTERNS.model_transfer.source, MODEL_RELAY_ID_PATTERNS.transfer.source);
  assert.equal(PARAM_SCHEMAS['team.model.withdraw'].properties.offer_id.pattern, MODEL_RELAY_ID_PATTERNS.offer.source);
  assert.equal(PARAM_SCHEMAS['team.model.pause'].properties.transfer_id.pattern, MODEL_RELAY_ID_PATTERNS.transfer.source);
  assert.deepEqual(PARAM_SCHEMAS['team.model.complete'].properties.reason.enum, [...COMPLETE_REASONS]);
  for (const make of Object.values(RELAY_FAILURES)) assert.ok(TEAM_MODEL_REASONS.includes(make().error.reason));
});

test('the family handles exactly the ten model operations, all without a receipt', () => {
  const { sharing } = makeSharing();
  const operations = ['team.model.offer', 'team.model.withdraw', 'team.model.offers', 'team.model.offer.read',
    'team.model.accept', 'team.model.decline', 'team.model.pause', 'team.model.resume', 'team.model.cancel',
    'team.model.complete'];
  for (const operation of operations) {
    assert.equal(sharing.commands.handles(operation), true, operation);
    assert.equal(sharing.commands.isRead(operation), true, `${operation}: the relay is idempotent, no receipt`);
  }
  assert.equal(sharing.commands.handles('team.model.planted'), false);
  assert.equal(sharing.commands.handles('team.chat.post'), false);
});

test('offer, list, read, accept, pause, resume, cancel and complete pass the relay\'s answers through', () => {
  const env = makeSharing();
  const { owner, member } = env.actors;
  const offered = env.send(owner, 'team.model.offer', manifest({ to: member }));
  assert.equal(offered.offer.audience, 'member');
  const listed = env.send(member, 'team.model.offers');
  assert.deepEqual(listed.offers.map((o) => o.offer_id), [offered.offer.offer_id]);
  const read = env.send(member, 'team.model.offer.read', { offer_id: offered.offer.offer_id });
  assert.equal(read.manifest.files[0].size, 10);
  const accepted = env.send(member, 'team.model.accept', { offer_id: offered.offer.offer_id, resume: [{ index: 0, offset: 4 }] });
  assert.equal(accepted.transfer.state, 'accepted');
  assert.deepEqual(accepted.transfer.next, { index: 0, part: 1 }); // the start point, offset 4 with 4-byte parts
  const transfer = { transfer_id: accepted.transfer.transfer_id };
  assert.equal(env.send(owner, 'team.model.pause', transfer).transfer.state, 'paused');
  assert.equal(env.send(owner, 'team.model.resume', transfer).transfer.state, 'accepted');
  // complete only from the receiver: the sender's answer is the relay's own.
  assert.equal(reasonOf(env.send(owner, 'team.model.complete', { ...transfer, ok: true })), 'team_model_transfer_stale');
  assert.equal(env.send(member, 'team.model.complete', { ...transfer, ok: false, reason: 'model_exists' }).transfer.state,
    'failed');
  // A failed direct transfer reopens the offer; a second accept and a cancel.
  const again = env.send(member, 'team.model.accept', { offer_id: offered.offer.offer_id });
  assert.equal(env.send(member, 'team.model.cancel', { transfer_id: again.transfer.transfer_id }).transfer.state, 'cancelled');
  assert.equal(reasonOf(env.send(member, 'team.model.complete', { ...transfer, ok: true, reason: 'model_exists' })),
    'team_model_request_invalid');
});

test('a withdrawn offer and a declined direct offer end; a team offer declined stays for the others', () => {
  const env = makeSharing();
  const { owner, member, otherMember } = env.actors;
  const direct = env.send(owner, 'team.model.offer', manifest({ to: member }));
  assert.deepEqual(env.send(member, 'team.model.decline', { offer_id: direct.offer.offer_id }), { ok: true });
  assert.deepEqual(noRequestId(env.send(member, 'team.model.offer.read', { offer_id: direct.offer.offer_id })), NOT_FOUND);
  const team = env.send(owner, 'team.model.offer', manifest({ requestId: 'req_team' }));
  assert.deepEqual(env.send(member, 'team.model.decline', { offer_id: team.offer.offer_id }), { ok: true });
  assert.equal(env.send(otherMember, 'team.model.offers').offers.length, 1);
  assert.deepEqual(env.send(owner, 'team.model.withdraw', { offer_id: team.offer.offer_id }), { ok: true });
  assert.equal(env.send(otherMember, 'team.model.offers').offers.length, 0);
});

test('a non-party and a wrong device answer team_not_found deep-equal to an unknown id', () => {
  const env = makeSharing();
  const { owner, member, otherMember, memberSecondDevice } = env.actors;
  const { offerId, transferId } = offerAndAccept(env, { from: owner, to: member });
  const unknownOffer = noRequestId(env.send(otherMember, 'team.model.offer.read', { offer_id: UNKNOWN_OFFER }));
  assert.deepEqual(unknownOffer, NOT_FOUND);
  for (const [who, operation, params] of [
    [otherMember, 'team.model.offer.read', { offer_id: offerId }],
    [otherMember, 'team.model.accept', { offer_id: offerId }],
    [otherMember, 'team.model.withdraw', { offer_id: offerId }],
    [otherMember, 'team.model.cancel', { transfer_id: transferId }],
    [otherMember, 'team.model.pause', { transfer_id: UNKNOWN_TRANSFER }],
    [memberSecondDevice, 'team.model.complete', { transfer_id: transferId, ok: true }],
    [memberSecondDevice, 'team.model.pause', { transfer_id: transferId }],
  ]) assert.deepEqual(noRequestId(env.send(who, operation, params)), NOT_FOUND, `${operation} by ${who.device_id}`);
  // The wrong device of the right member sees the taken offer as taken, never the transfer.
  assert.equal(reasonOf(env.send(memberSecondDevice, 'team.model.accept', { offer_id: offerId })), 'team_model_offer_taken');
});

test('canReceive and the receivers come from the live directory at the call, never from the request', () => {
  const env = makeSharing();
  const { owner, member, read_only: readOnly } = env.actors;
  // A direct offer to a read-only member is to nobody who may receive.
  assert.deepEqual(noRequestId(env.send(owner, 'team.model.offer', manifest({ to: readOnly }))), NOT_FOUND);
  const team = env.send(owner, 'team.model.offer', manifest({ requestId: 'req_team' }));
  const offerEvent = env.published.find((event) => event.type === 'team_model_offer');
  assert.deepEqual([...offerEvent.options.audience].sort(), ['member_a', 'member_b', 'member_owner']);
  assert.equal(env.send(member, 'team.model.offers').offers.length, 1);
  // Demoted in the directory (no membership event yet): the member no longer sees or accepts it.
  env.dir.setRole(member.device_id, 'read_only');
  assert.equal(reasonOf(env.send(member, 'team.model.accept', { offer_id: team.offer.offer_id })), 'team_not_found');
  env.dir.setRole(member.device_id, 'member');
  assert.equal(reasonOf(env.send(member, 'team.model.accept', { offer_id: team.offer.offer_id })), 'ok');
});

test('events go to the relay audience only, live, under the #team bucket; a throwing publish changes nothing', () => {
  const env = makeSharing();
  const { owner, member } = env.actors;
  offerAndAccept(env, { from: owner, to: member });
  assert.ok(env.published.length >= 3);
  for (const event of env.published) {
    assert.ok(['team_model_offer', 'team_model_transfer'].includes(event.type));
    assert.deepEqual([...event.options.audience].sort(), ['member_a', 'member_owner']);
    assert.equal(event.options.bucket, 'teamchat:chan_team');
    assert.equal(event.options.ephemeral, true);
  }
  assert.equal(env.published.some((event) => JSON.stringify(event.payload).includes('Zebra licence')), false);
  const failing = makeSharing({ failPublish: true });
  const answer = offerAndAccept(failing, { from: failing.actors.owner, to: failing.actors.member });
  assert.match(answer.transferId, /^mxfer_/u);
});

test('setting 0: every operation answers only team_model_sharing_off, no event, no timer, nothing held', () => {
  const env = makeSharing({ flowing: 0 });
  const { owner, member } = env.actors;
  const params = { offer_id: UNKNOWN_OFFER, transfer_id: UNKNOWN_TRANSFER };
  for (const operation of ['team.model.offer', 'team.model.withdraw', 'team.model.offers', 'team.model.offer.read',
    'team.model.accept', 'team.model.decline', 'team.model.pause', 'team.model.resume', 'team.model.cancel',
    'team.model.complete']) {
    const body = operation === 'team.model.offer' ? manifest({ to: member }) : params;
    assert.equal(reasonOf(env.send(owner, operation, body)), 'team_model_sharing_off', operation);
  }
  assert.equal(env.published.length, 0);
  assert.equal(env.timers.count(), 0);
  assert.deepEqual(env.sharing.resources().relay, null);
  // A changed setting takes effect: on, a transfer, then off again ends it and stops the timer.
  assert.deepEqual(env.sharing.setFlowingLimit(2), { ok: true });
  assert.equal(env.timers.count(), 1);
  offerAndAccept(env, { from: owner, to: member });
  const before = env.published.length;
  assert.deepEqual(env.sharing.setFlowingLimit(0), { ok: true });
  assert.ok(env.published.slice(before).every((event) => event.payload.reason === 'sharing_off'));
  assert.equal(env.timers.count(), 0);
  const after = env.published.length;
  assert.equal(reasonOf(env.send(owner, 'team.model.offers')), 'team_model_sharing_off');
  assert.equal(env.published.length, after);
  for (const bad of [5, -1, 1.5, '2', null]) assert.equal(reasonOf(env.sharing.setFlowingLimit(bad)), 'team_model_request_invalid');
});

test('host stop and Force local (dispose): host_unavailable everywhere, timers cleared, nothing held', () => {
  const env = makeSharing();
  const { owner, member } = env.actors;
  offerAndAccept(env, { from: owner, to: member });
  assert.equal(env.timers.count(), 1);
  // The attach unsubscribes are what team-main's teardown runs: the last one disposes.
  for (const unsubscribe of env.unsubscribes.reverse()) unsubscribe();
  assert.equal(env.timers.count(), 0);
  const published = env.published.length;
  assert.equal(reasonOf(env.send(owner, 'team.model.offers')), 'host_unavailable');
  assert.equal(reasonOf(env.send(member, 'team.model.offer', manifest({ to: owner }))), 'host_unavailable');
  assert.equal(reasonOf(env.sharing.setFlowingLimit(2)), 'host_unavailable');
  assert.equal(env.published.length, published);
  assert.equal(env.sharing.resources().relay, null);
  assert.equal(env.sharing.resources().sweepTimers, 0);
});

test('the sweep timer: unref\'d, a period of a quarter of the smallest relay timeout, and it pauses an idle transfer', () => {
  assert.equal(sweepPeriodMs(MODEL_TRANSFER_LIMITS), 15_000);
  const env = makeSharing();
  const [handle] = env.timers.handles();
  assert.equal(handle.ms, 15_000);
  assert.equal(handle.unrefed, true);
  const { owner, member } = env.actors;
  const { transferId } = offerAndAccept(env, { from: owner, to: member });
  env.timers.advance(MODEL_TRANSFER_LIMITS.pauseIdleMs + 15_000);
  const paused = env.published.filter((event) => event.type === 'team_model_transfer' && event.payload.transfer_id === transferId);
  assert.equal(paused.at(-1).payload.state, 'paused');
  assert.equal(paused.at(-1).payload.reason, 'idle');
});

test('lifecycle: revoke and leave end a member\'s offers and transfers; a role change to read-only ends them too', () => {
  const env = makeSharing();
  const { owner, member, otherMember } = env.actors;
  const first = offerAndAccept(env, { from: owner, to: member });
  env.membership.emit({ kind: 'member_revoked', member_id: member.member_id, device_ids: [member.device_id],
    role: 'member', at: 1 });
  const ended = env.published.filter((event) => event.payload.transfer_id === first.transferId).at(-1);
  assert.deepEqual([ended.payload.state, ended.payload.reason], ['cancelled', 'member_gone']);
  const second = offerAndAccept(env, { from: otherMember, to: owner });
  env.membership.emit({ kind: 'role_changed', member_id: otherMember.member_id, device_ids: [otherMember.device_id],
    role: 'read_only', at: 2 });
  const demoted = env.published.filter((event) => event.payload.transfer_id === second.transferId).at(-1);
  assert.deepEqual([demoted.payload.state, demoted.payload.reason], ['cancelled', 'role_changed']);
  // A role change to member keeps everything; an owner transfer changes nothing either.
  const third = offerAndAccept(env, { from: owner, to: otherMember });
  const count = env.published.length;
  env.membership.emit({ kind: 'role_changed', member_id: otherMember.member_id, device_ids: [], role: 'member', at: 3 });
  env.membership.emit({ kind: 'owner_transferred', member_id: otherMember.member_id, device_ids: [], role: 'owner', at: 4 });
  assert.equal(env.published.length, count);
  assert.equal(reasonOf(env.send(owner, 'team.model.pause', { transfer_id: third.transferId })), 'ok');
});

test('device presence: the offering device\'s last stream closing starts the grace; back inside it keeps the offer', () => {
  const env = makeSharing({ streams: false });
  const { owner, member } = env.actors;
  const offerOf = (requestId) => env.send(owner, 'team.model.offer', manifest({ to: member, requestId })).offer.offer_id;
  env.sharing.onMemberStream(owner.member_id, owner.device_id, 'open');
  env.sharing.onMemberStream(owner.member_id, owner.device_id, 'open');
  const kept = offerOf('req_kept');
  env.sharing.onMemberStream(owner.member_id, owner.device_id, 'close'); // one stream still open: not gone
  env.timers.advance(MODEL_TRANSFER_LIMITS.senderGraceMs + 15_000);
  assert.equal(reasonOf(env.send(member, 'team.model.offer.read', { offer_id: kept })), 'ok');
  env.sharing.onMemberStream(owner.member_id, owner.device_id, 'close'); // the last: gone
  env.timers.advance(60_000);
  env.sharing.onMemberStream(owner.member_id, owner.device_id, 'open'); // back inside the grace
  env.timers.advance(MODEL_TRANSFER_LIMITS.senderGraceMs + 15_000);
  assert.equal(reasonOf(env.send(member, 'team.model.offer.read', { offer_id: kept })), 'ok');
  env.sharing.onMemberStream(owner.member_id, owner.device_id, 'close');
  env.timers.advance(MODEL_TRANSFER_LIMITS.senderGraceMs + 15_000);
  assert.equal(reasonOf(env.send(member, 'team.model.offer.read', { offer_id: kept })), 'team_not_found');
  const ended = env.published.filter((event) => event.type === 'team_model_offer').at(-1);
  assert.deepEqual([ended.payload.state, ended.payload.reason], ['ended', 'sender_offline']);
  assert.equal(env.sharing.resources().devices, 0);
});

test('the member-stream fan-out runs every hook, logs a throwing one by name, and refuses a hook without the method', () => {
  const heard = [];
  const logs = [];
  const fanOut = memberStreamFanOut({ chat: { onMemberStream: () => { throw new Error('x'); } },
    models: { onMemberStream: (...args) => heard.push(args) } }, (...args) => logs.push(args));
  fanOut('member_a', 'device_a1', 'open');
  assert.deepEqual(heard, [['member_a', 'device_a1', 'open']]);
  assert.deepEqual(logs, [['WARN', 'team.member_stream_hook_failed', { hook: 'chat' }]]);
  assert.throws(() => memberStreamFanOut({ chat: {}, models: { onMemberStream() {} } }), TypeError);
  assert.throws(() => memberStreamFanOut({ chat: null }), TypeError);
});

test('redaction: names, hashes, licence and URL reach no log line and no failure payload', () => {
  const env = makeSharing();
  const { owner, member, otherMember } = env.actors;
  const { offerId, transferId } = offerAndAccept(env, { from: owner, to: member });
  const failures = [
    env.send(otherMember, 'team.model.offer.read', { offer_id: offerId }),
    env.send(owner, 'team.model.offer', { ...manifest({ to: member }), display_name: '' }),
    env.send(owner, 'team.model.offer', manifest({ to: member, sizes: [MODEL_TRANSFER_LIMITS.maxFileBytes + 1] })),
    env.send(member, 'team.model.complete', { transfer_id: transferId, ok: false, reason: 'model_hash_mismatch' }),
  ];
  env.sharing.setFlowingLimit(0);
  env.sharing.dispose();
  assert.ok(env.logs.length > 0);
  assert.equal(clean(env.logs), true, 'logs');
  assert.equal(clean(failures.filter((answer) => !answer.ok)), true, 'failures');
});

test('config: team.model_relay_flowing is 0 to 4 (absent: the default 2); 5, -1, a fraction, a string and null are refused', (t) => {
  const { loadHostConfig } = require('../../server/config');
  const { createTeamHostFixture } = require('./helpers/team-host-fixture');
  const fx = createTeamHostFixture(t);
  fx.writeConfig();
  assert.equal(Object.hasOwn(loadHostConfig(fx.configPath).team, 'modelRelayFlowing'), false, 'absent: the default applies');
  for (const value of [0, 2, 4]) {
    fx.writeConfig({ team: { model_relay_flowing: value } });
    assert.equal(loadHostConfig(fx.configPath).team.modelRelayFlowing, value);
  }
  for (const value of [5, -1, 1.5, '2', null]) {
    fx.writeConfig({ team: { model_relay_flowing: value } });
    assert.throws(() => loadHostConfig(fx.configPath), (error) => error.code === 'team_model_relay_flowing_invalid'
      || /team_model_relay_flowing_invalid/u.test(String(error.message) + String(error.reason)), String(value));
  }
});

// ---- Fix list 6-3: hooks, presence, setting changes, revoked receivers, the limiter -----------------------------

const GRACE = MODEL_TRANSFER_LIMITS.senderGraceMs + 15_000;
const lastOf = (env, id) => env.published.filter((event) => event.payload.transfer_id === id || event.payload.offer_id === id).at(-1);

test('a membership hook that throws is logged as team_model.hook_failed and never marks the store degraded', (t) => {
  const boom = () => { throw new Error('relay_boom'); };
  const createRelay = (input) => Object.assign(createModelRelay(input), { memberGone: boom, roleChanged: boom, listOffers: boom });
  const env = makeSharing({ t, createRelay });
  const { member } = env.actors;
  for (const kind of ['member_revoked', 'role_changed', 'device_revoked']) {
    assert.doesNotThrow(() => env.membership.emit({ kind, member_id: member.member_id, device_ids: [member.device_id],
      role: 'read_only', at: 1 }));
  }
  assert.equal(env.membership.isDegraded(), false);
  assert.deepEqual(env.logs.filter((line) => line[1] === 'team_model.hook_failed').map((line) => line[2].event_kind),
    ['member_revoked', 'role_changed', 'device_revoked']);
});

test('presence at the 64-device cap: a device first seen at the cap stays ignored until its streams close (fail open)', (t) => {
  const env = makeSharing({ t, streams: false });
  const { owner, member } = env.actors;
  const open = (deviceId, change = 'open') => env.sharing.onMemberStream('member_x', deviceId, change);
  const held = () => env.sharing.resources();
  for (let i = 0; i < 64; i += 1) open(`device_f${i}`);
  env.sharing.onMemberStream(owner.member_id, owner.device_id, 'open');
  env.sharing.onMemberStream(owner.member_id, owner.device_id, 'open');
  assert.deepEqual([held().devices, held().ignoredDevices, held().droppedOpens], [64, 1, 2]);
  open('device_f0', 'close');
  // Room again, but the owner's device is never counted mid-way (its first close would read as its last).
  env.sharing.onMemberStream(owner.member_id, owner.device_id, 'open');
  assert.deepEqual([held().devices, held().droppedOpens], [63, 3]);
  // An ignored device is never seen as gone: its offer outlives the sender grace.
  const offerId = env.send(owner, 'team.model.offer', manifest({ to: member })).offer.offer_id;
  env.timers.advance(GRACE);
  assert.equal(reasonOf(env.send(member, 'team.model.offer.read', { offer_id: offerId })), 'ok');
  for (let i = 0; i < 3; i += 1) env.sharing.onMemberStream(owner.member_id, owner.device_id, 'close');
  assert.deepEqual([held().devices, held().ignoredDevices], [63, 0]);
});

test('presence after dispose counts nothing', (t) => {
  const env = makeSharing({ t, streams: false });
  env.sharing.dispose();
  env.sharing.onMemberStream('member_owner', 'device_owner', 'open');
  assert.equal(env.sharing.resources().devices, 0);
});

test('an offer from a device with no stream is gone from the start; a member\'s other device closing changes nothing', (t) => {
  const env = makeSharing({ t, streams: false });
  const { owner, member, memberSecondDevice } = env.actors;
  const lonely = env.send(owner, 'team.model.offer', manifest({ to: member, requestId: 'req_lonely' })).offer.offer_id;
  env.timers.advance(GRACE);
  assert.equal(reasonOf(env.send(member, 'team.model.offer.read', { offer_id: lonely })), 'team_not_found');
  assert.deepEqual([lastOf(env, lonely).payload.state, lastOf(env, lonely).payload.reason], ['ended', 'sender_offline']);
  // Member a on two devices: a1 offers with its stream open; a2's stream closing does not make a1 gone.
  env.sharing.onMemberStream(member.member_id, member.device_id, 'open');
  env.sharing.onMemberStream(member.member_id, memberSecondDevice.device_id, 'open');
  const kept = env.send(member, 'team.model.offer', manifest({ to: owner, requestId: 'req_kept' })).offer.offer_id;
  env.sharing.onMemberStream(member.member_id, memberSecondDevice.device_id, 'close');
  env.timers.advance(GRACE);
  assert.equal(reasonOf(env.send(owner, 'team.model.offer.read', { offer_id: kept })), 'ok');
  // At the cap the rule fails open: an offer from an uncounted device is not marked gone.
  const full = makeSharing({ t, streams: false });
  for (let i = 0; i < 64; i += 1) full.sharing.onMemberStream('member_x', `device_f${i}`, 'open');
  const capped = full.send(full.actors.owner, 'team.model.offer', manifest({ to: full.actors.member })).offer.offer_id;
  full.timers.advance(GRACE);
  assert.equal(reasonOf(full.send(full.actors.member, 'team.model.offer.read', { offer_id: capped })), 'ok');
});

test('setFlowingLimit on a live relay (2 to 3, 3 to 1), before attach, and a second attach', (t) => {
  const env = makeSharing({ t });
  assert.deepEqual(env.sharing.setFlowingLimit(3), { ok: true });
  assert.equal(env.sharing.resources().relay.flowingLimit, 3);
  assert.deepEqual(env.sharing.setFlowingLimit(1), { ok: true });
  assert.deepEqual([env.sharing.resources().relay.flowingLimit, env.timers.count()], [1, 1]);
  const early = makeSharing({ t, attach: false });
  assert.deepEqual(early.sharing.setFlowingLimit(3), { ok: true });
  assert.deepEqual([early.sharing.resources().on, early.timers.count()], [false, 0], 'nothing starts before attach');
  const unsubscribes = early.sharing.attach();
  assert.equal(unsubscribes.length, 2);
  assert.deepEqual([early.sharing.resources().relay.flowingLimit, early.timers.count()], [3, 1]);
  assert.deepEqual(early.sharing.attach(), [], 'a second attach adds nothing');
  assert.equal(early.timers.count(), 1);
  for (const unsubscribe of unsubscribes.reverse()) unsubscribe();
});

test('a revoked receiving device: its live transfers, a queued one too, end as cancelled_by_receiver', (t) => {
  const env = makeSharing({ t });
  const { owner, member, otherMember, memberSecondDevice } = env.actors;
  const first = offerAndAccept(env, { from: owner, to: member });
  const queuedOffer = env.send(otherMember, 'team.model.offer', manifest({ to: member, requestId: 'req_q' }));
  const queued = env.send(member, 'team.model.accept', { offer_id: queuedOffer.offer.offer_id });
  assert.equal(queued.transfer.queued, true, 'one incoming transfer flows per member: the second waits');
  env.membership.emit({ kind: 'device_revoked', member_id: member.member_id, device_ids: [member.device_id], role: 'member', at: 1 });
  for (const id of [first.transferId, queued.transfer.transfer_id]) {
    assert.deepEqual([lastOf(env, id).payload.state, lastOf(env, id).payload.reason], ['cancelled', 'cancelled_by_receiver']);
  }
  // The member's other device is untouched and may accept the reopened direct offer.
  assert.equal(reasonOf(env.send(memberSecondDevice, 'team.model.accept', { offer_id: queuedOffer.offer.offer_id })), 'ok');
});

test('sharing off answers before the rate-limit token is taken; on, a model command takes one', async () => {
  for (const [flowing, grant, expected, tokens] of [[0, false, 'team_model_sharing_off', 0], [2, false, 'team_rate_limit', 1],
    [2, true, 'ok', 1]]) {
    const env = makeSharing({ flowing });
    let taken = 0;
    const commands = createTeamCommands({ store: { snapshot() {}, rename() {} }, invites: { create() {} },
      directory: env.dir.directory, limiter: { take: () => { taken += 1; return grant; } }, models: env.sharing.commands });
    const answer = await commands.dispatch({ operation: 'team.model.offers', params: {}, request_id: 'req_d5' },
      { deviceId: env.actors.owner.device_id });
    assert.deepEqual([reasonOf(answer), taken], [expected, tokens], `flowing ${flowing}`);
    if (!answer.ok) assert.equal(answer.error.request_id, 'req_d5');
  }
});

test('a team offer while the directory cannot be read answers host_unavailable, never an empty audience', (t) => {
  const env = makeSharing({ t });
  env.dir.directory.activeMemberIds = () => { throw new Error('directory_down'); };
  assert.equal(reasonOf(env.send(env.actors.owner, 'team.model.offer', manifest({ requestId: 'req_down' }))), 'host_unavailable');
  assert.equal(env.published.length, 0);
});
