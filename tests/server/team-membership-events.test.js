'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixture } = require('./helpers/team-store-fixture');
const { EVENT_KINDS, createMembershipEvents } = require('../../server/team/membership-events');

function event(overrides = {}) {
  return {
    kind: 'admitted', member_id: 'member_abcdefghijklmnopqrstuv', device_ids: ['device_one'], role: 'member', at: 5,
    ...overrides,
  };
}

// ------------------------------------------------------------- the emitter

test('subscribers run in registration order and receive one frozen payload', () => {
  const events = createMembershipEvents();
  const order = [];
  const payloads = [];
  events.onMembershipChange((payload) => { order.push('a'); payloads.push(payload); });
  events.onMembershipChange((payload) => { order.push('b'); payloads.push(payload); });
  events.onMembershipChange((payload) => { order.push('c'); payloads.push(payload); });
  const source = event();
  events.emit(source);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(payloads[0], payloads[2]);
  assert.deepEqual(payloads[0], source);
  assert.equal(Object.isFrozen(payloads[0]), true);
  assert.equal(Object.isFrozen(payloads[0].device_ids), true);
  source.device_ids.push('device_late');
  assert.deepEqual(payloads[0].device_ids, ['device_one'], 'the payload is a copy');
  assert.deepEqual(Object.keys(payloads[0]).sort(), ['at', 'device_ids', 'kind', 'member_id', 'role']);
});

test('unsubscribe stops delivery, including from inside a listener', () => {
  const events = createMembershipEvents();
  const seen = [];
  const stopA = events.onMembershipChange(() => seen.push('a'));
  const stopB = events.onMembershipChange(() => { seen.push('b'); stopA(); });
  events.onMembershipChange(() => seen.push('c'));
  events.emit(event());
  assert.deepEqual(seen, ['a', 'b', 'c']);
  events.emit(event());
  assert.deepEqual(seen, ['a', 'b', 'c', 'b', 'c']);
  stopB();
  stopB();
  events.emit(event());
  assert.deepEqual(seen.slice(5), ['c']);
  assert.throws(() => events.onMembershipChange('nope'), TypeError);
});

test('a throwing subscriber is logged without its payload, sets degraded and does not stop the others', () => {
  const lines = [];
  const events = createMembershipEvents({ logger: (level, name, fields) => lines.push({ level, name, fields }) });
  const seen = [];
  events.onMembershipChange(() => seen.push('first'));
  events.onMembershipChange(() => { throw new Error('boom member_abcdefghijklmnopqrstuv'); });
  events.onMembershipChange(() => seen.push('third'));
  assert.equal(events.isDegraded(), false);
  assert.doesNotThrow(() => events.emit(event({ kind: 'member_revoked' })));
  assert.deepEqual(seen, ['first', 'third']);
  assert.equal(events.isDegraded(), true);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].fields, { event_kind: 'member_revoked', subscriber: 1 });
  const text = JSON.stringify(lines);
  assert.equal(text.includes('boom'), false, 'no error text');
  assert.equal(text.includes('member_abcdefghijklmnopqrstuv'), false, 'no payload');
  // Degraded is sticky: later clean emits do not clear it.
  events.emit(event());
  assert.equal(events.isDegraded(), true);
});

test('a subscriber that rejects asynchronously also sets degraded', async () => {
  const events = createMembershipEvents();
  const seen = [];
  events.onMembershipChange(async () => { throw new Error('late'); });
  events.onMembershipChange(() => seen.push('after'));
  events.emit(event());
  assert.deepEqual(seen, ['after']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.isDegraded(), true);
});

test('only the five membership kinds can be emitted', () => {
  const events = createMembershipEvents();
  assert.deepEqual([...EVENT_KINDS].sort(), [
    'admitted', 'device_revoked', 'member_revoked', 'owner_transferred', 'role_changed',
  ]);
  assert.throws(() => events.emit(event({ kind: 'invite_created' })), TypeError);
  assert.throws(() => events.emit(null), TypeError);
});

// --------------------------------------------------------- through the store

test('the store emits after the durable commit: the listener already sees the new state', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  const observed = [];
  store.onMembershipChange((payload) => {
    observed.push({
      payload,
      rev: store.rev(),
      onDisk: JSON.parse(require('node:fs').readFileSync(fx.memberFile, 'utf8')).rev,
      active: store.directory.isDeviceActive(joined.device_id),
      resolved: store.directory.resolveActor(joined.key),
    });
  });
  const before = store.rev();
  await store.revokeMember({ actorMemberId: owner.member_id, memberId: joined.member_id });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].rev, before + 1);
  assert.equal(observed[0].onDisk, before + 1, 'the commit is durable before the event');
  assert.equal(observed[0].active, false, 'the directory was rebuilt before the event');
  assert.equal(observed[0].resolved, null);
  assert.deepEqual(observed[0].payload, {
    kind: 'member_revoked', member_id: joined.member_id, device_ids: [joined.device_id], role: 'member', at: fx.clock(),
  });
});

test('each event kind fires exactly once for its transition and refused changes fire nothing', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const events = [];
  store.onMembershipChange((payload) => events.push(payload.kind));
  const owner = await fx.bootstrapOwner(store);
  assert.deepEqual(events, ['admitted'], 'the first owner is admitted');
  const joined = await fx.joinMember(store, owner.member_id, { admit: false });
  assert.deepEqual(events, ['admitted']);
  await store.admit({ actorMemberId: owner.member_id, memberId: joined.member_id });
  await store.setRole({ actorMemberId: owner.member_id, memberId: joined.member_id, role: 'read_only' });
  await store.setRole({ actorMemberId: owner.member_id, memberId: joined.member_id, role: 'read_only' });
  const phone = await fx.addDevice(store, joined.member_id);
  assert.equal(phone.ok, true);
  await store.revokeDevice({ actorMemberId: owner.member_id, deviceId: phone.device_id });
  await store.transferOwner({ actorMemberId: owner.member_id, memberId: joined.member_id });
  await store.revokeMember({ actorMemberId: joined.member_id, memberId: owner.member_id });
  assert.deepEqual(events, [
    'admitted', 'admitted', 'role_changed', 'device_revoked', 'owner_transferred', 'member_revoked',
  ]);
  const count = events.length;
  await store.revokeMember({ actorMemberId: joined.member_id, memberId: owner.member_id });
  await store.admit({ actorMemberId: joined.member_id, memberId: 'member_nobody' });
  await store.touchDevice(joined.device_id);
  assert.equal(events.length, count);
});

test('no event fires when the commit fails', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  const failing = fx.openStore({ writeJson() { throw Object.assign(new Error('disk'), { code: 'EIO' }); } });
  const events = [];
  failing.onMembershipChange((payload) => events.push(payload));
  const result = await failing.revokeMember({ actorMemberId: owner.member_id, memberId: joined.member_id });
  assert.equal(result.error.reason, 'team_store_failed');
  assert.deepEqual(events, []);
});

test('a throwing subscriber makes the directory report degraded; later subscribers still run', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  const seen = [];
  assert.equal(store.directory.isDegraded(), false);
  store.onMembershipChange(() => seen.push('bridge'));
  store.onMembershipChange(() => { throw new Error('clients.revokeDevice failed'); });
  store.onMembershipChange(() => seen.push('streams'));
  const result = await store.setRole({ actorMemberId: owner.member_id, memberId: joined.member_id, role: 'read_only' });
  assert.equal(result.ok, true, 'the committed mutation still succeeds');
  assert.deepEqual(seen, ['bridge', 'streams']);
  assert.equal(store.directory.isDegraded(), true);
  assert.equal(store.getMember(joined.member_id).role, 'read_only');
  const logged = JSON.stringify(fx.logs);
  assert.equal(logged.includes('clients.revokeDevice'), false);
  assert.equal(logged.includes(joined.member_id), false, 'the payload is not logged');
});

test('the directory reads live state on every call and never caches on a caller object', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  const first = store.directory.resolveActor(joined.key);
  first.role = 'owner';
  first.state = 'revoked';
  assert.equal(store.directory.resolveActor(joined.key).role, 'member');
  assert.equal(store.directory.liveActor(joined.device_id).state, 'active');
  await store.setRole({ actorMemberId: owner.member_id, memberId: joined.member_id, role: 'read_only' });
  assert.equal(store.directory.resolveActor(joined.key).role, 'read_only');
  assert.equal(store.directory.admitKind(joined.key), 'device');
  assert.equal(store.directory.admitKind(owner.key), 'device');
  for (const junk of [null, undefined, 42, '', 'short', `${joined.key}=`, joined.key.slice(1)]) {
    assert.equal(store.directory.resolveActor(junk), null);
    assert.equal(store.directory.admitKind(junk), null);
  }
  assert.equal(store.directory.liveActor(undefined), null);
  assert.equal(store.directory.liveActor('device_unknown'), null);
  assert.equal(store.directory.isDeviceActive(42), false);
});

// ------------------------------------------------- project events (slice 3-1)

test('project events go to their own subscribers, frozen, and share the degraded flag', () => {
  const { PROJECT_EVENT_REASONS } = require('../../server/team/membership-events');
  const lines = [];
  const events = createMembershipEvents({ logger: (level, name, fields) => lines.push({ level, name, fields }) });
  const memberSeen = [];
  const projectSeen = [];
  events.onMembershipChange((payload) => memberSeen.push(payload));
  const stop = events.onProjectChange((payload) => projectSeen.push(payload));
  events.onProjectChange(() => { throw new Error('boom project_secret'); });
  const input = { reason: 'members', project_id: 'project_p1', member_ids: ['member_abcdefghijklmnopqrstuv'], at: 5 };
  events.emitProject(input);
  input.member_ids.push('member_forged');
  assert.deepEqual(memberSeen, []);
  assert.equal(projectSeen.length, 1);
  assert.deepEqual(projectSeen[0], {
    reason: 'members', project_id: 'project_p1', member_ids: ['member_abcdefghijklmnopqrstuv'], at: 5,
  });
  assert.ok(Object.isFrozen(projectSeen[0]) && Object.isFrozen(projectSeen[0].member_ids));
  assert.equal(events.isDegraded(), true);
  assert.deepEqual(lines[0].fields, { event_kind: 'project_members', subscriber: 1 });
  assert.equal(JSON.stringify(lines).includes('project_secret'), false);
  stop();
  events.emitProject({ ...input, reason: 'deleted' });
  assert.equal(projectSeen.length, 1, 'unsubscribed');
  assert.deepEqual([...PROJECT_EVENT_REASONS], ['created', 'members', 'deleting', 'deleted']);
  assert.throws(() => events.emitProject({ ...input, reason: 'renamed' }), TypeError);
  assert.throws(() => events.onProjectChange('nope'), TypeError);
  assert.throws(() => events.emit({ ...event(), kind: 'members' }), TypeError, 'membership kinds stay closed');
});
