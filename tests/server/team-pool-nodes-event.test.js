'use strict';

// Row 123 slice 4e host: the `team_pool_nodes` event. The team.node.* module follows the pool's
// change feed and publishes the list every active member reads (team.node.list's rows, the stored
// team model and what Automatic means now): at most once a second, the latest state winning,
// ephemeral, audience-scoped to the active members. First the module with manual timers over a real
// scheduler, then through a real team host's event stream. No sidecar, no model, no engine, no window.

const assert = require('node:assert/strict');
const nodeTest = require('node:test');

const { POOL_NODES_EVENT, createEventScope } = require('../../server/team/event-scope');
const { model: poolModel } = require('./helpers/team-pool-fixture');
const { createNodeCommandsFixture, model, startNodeHost } = require('./helpers/team-node-fixture');
const { waitUntil } = require('./helpers/team-http-fixture');

const test = (name, fn) => nodeTest(name, { timeout: 30_000 }, fn);

function manualTimers() {
  let now = 10_000;
  let next = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { next += 1; const handle = { id: next, unref() { return handle; } }; pending.set(next, { at: now + ms, fn }); return handle; },
    clearTimeout(handle) { if (handle) pending.delete(handle.id); },
    pending: () => pending.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

async function moduleFixture(t) {
  const timers = manualTimers();
  const published = [];
  const f = await createNodeCommandsFixture(t, { nodeOptions: (store) => ({
    timers, clock: timers.now, publish: (type, payload, options) => published.push({ type, payload, options }),
    names: () => store.poolNames(),
  }) });
  assert.equal(f.nodes().watch(), true);
  return { ...f, timers, published };
}

test('the event type is publisher-scoped (an event without an audience is dropped)', () => {
  assert.equal(POOL_NODES_EVENT, 'team_pool_nodes');
  const scope = createEventScope({ sessionScope: { audience: () => null }, logger: () => {} });
  assert.equal(scope(POOL_NODES_EVENT, { nodes: [] }, { ephemeral: true }), null, 'dropped without an audience');
  const audience = new Set(['member_a']);
  assert.equal(scope(POOL_NODES_EVENT, { nodes: [] }, { audience, ephemeral: true }).audience, audience);
});

test('a change publishes the list rows to the active members, ephemeral; no device id, job or lease', async (t) => {
  const f = await moduleFixture(t);
  const nodeId = await f.register(f.seats.alice, { models: [model('alpha'), model('beta')] });
  f.timers.advance(0);
  assert.equal(f.published.length, 1);
  const [event] = f.published;
  assert.equal(event.type, 'team_pool_nodes');
  assert.equal(event.options.ephemeral, true);
  assert.deepEqual([...event.options.audience].sort(), [f.seats.owner, f.seats.alice, f.seats.rae].map((seat) => seat.member_id).sort(),
    'owner, member and read-only: every active member, never the pending one');
  const list = await f.send(f.seats.rae, 'team.node.list', {});
  const { ok: _ok, ...answer } = list;
  assert.deepEqual(event.payload, answer, 'the same rows team.node.list answers and nothing more');
  assert.equal(event.payload.nodes[0].node_id, nodeId);
  assert.equal(event.payload.automatic_model, 'alpha');
  const text = JSON.stringify(event.payload);
  for (const word of ['device_id', 'job', 'lease', f.seats.alice.device_id]) assert.equal(text.includes(word), false, `no ${word}`);
});

test('ten changes in one tick publish once, with the last state; then at most once a second', async (t) => {
  const f = await moduleFixture(t);
  await f.register(f.seats.alice);
  f.timers.advance(0);
  assert.equal(f.published.length, 1);
  for (let i = 0; i < 10; i += 1) {
    f.scheduler.setNodePaused(f.scheduler.nodeIdForDevice(f.seats.alice.device_id), { on: i % 2 === 1 });
  }
  f.timers.advance(999);
  assert.equal(f.published.length, 1, 'not within the second');
  f.timers.advance(1);
  assert.equal(f.published.length, 2, 'once');
  assert.equal(f.published[1].payload.nodes[0].paused, true, 'the last state (the tenth change paused it)');
  // A change that leaves the list as it was publishes nothing.
  f.scheduler.setNodePaused(f.scheduler.nodeIdForDevice(f.seats.alice.device_id), { on: true });
  f.timers.advance(2000);
  assert.equal(f.published.length, 2);
});

test('the team model reaches the event; the coalescing timer is cleared at stop', async (t) => {
  const f = await moduleFixture(t);
  await f.register(f.seats.alice, { models: [model('alpha'), model('beta')] });
  f.timers.advance(0);
  await f.store.setTeamModel({ actorMemberId: f.seats.owner.member_id, model: 'beta' });
  f.nodes().announce();
  f.timers.advance(1000);
  assert.equal(f.published.at(-1).payload.team_model, 'beta');
  f.scheduler.setNodePaused(f.scheduler.nodeIdForDevice(f.seats.alice.device_id), { on: true });
  assert.equal(f.timers.pending(), 1, 'a publish is waiting');
  f.nodes().dispose();
  assert.equal(f.timers.pending(), 0, 'cleared at stop');
  f.timers.advance(5000);
  assert.equal(f.published.at(-1).payload.nodes[0].paused, false, 'nothing published after stop');
});

test('the node commands themselves announce: a re-register with other models and the same slots, and a pause', async (t) => {
  const f = await moduleFixture(t);
  await f.register(f.seats.alice, { models: [model('alpha')] });
  f.timers.advance(0);
  await f.register(f.seats.alice, { models: [model('beta')] });
  f.timers.advance(1000);
  assert.deepEqual(f.published.at(-1).payload.nodes[0].models.map((entry) => entry.name), ['beta'], 'the new models are told');
  const before = f.published.length;
  assert.equal((await f.send(f.seats.alice, 'team.node.pause', { on: true })).ok, true);
  f.timers.advance(1000);
  assert.equal(f.published.length, before + 1);
  assert.equal(f.published.at(-1).payload.nodes[0].paused, true);
});

// ------------------------------------------------------------------ the real host

const eventsOf = (stream) => stream.frames.join('').split('\n').filter((line) => line.startsWith('data: '))
  .map((line) => JSON.parse(line.slice(6))).filter((event) => event.event_type === 'team_pool_nodes');

async function streamOf(h, principal) {
  const { client, hello, auth } = await h.m.ready(principal);
  if (hello.status !== 200 || !auth['X-Client-Id']) return { refused: true, status: hello.status };
  return client.openStream({ client_id: auth['X-Client-Id'], client_token: auth['X-Client-Token'] });
}

test('through the real host: every active member gets the event live and after a reconnect, nobody else, no device id, job or lease', async (t) => {
  const h = await startNodeHost(t);
  const { owner, member, second, readOnly, pending } = h.seats;
  const streams = { owner: await streamOf(h, owner), member: await streamOf(h, member), second: await streamOf(h, second), readOnly: await streamOf(h, readOnly) };
  const pendingStream = await streamOf(h, pending);
  const removed = await h.m.store.revokeMember({ actorMemberId: owner.member_id, memberId: second.member_id });
  assert.equal(removed.ok, true);
  await waitUntil(() => streams.second.closed, { attempts: 100 });
  h.m.node({ models: [poolModel('alpha')] });
  for (const name of ['owner', 'member', 'readOnly']) {
    assert.ok(await waitUntil(() => eventsOf(streams[name]).length >= 1, { attempts: 150 }), `${name} got the event`);
  }
  const [event] = eventsOf(streams.member);
  assert.equal(event.nodes.length, 1);
  assert.equal(event.automatic_model, 'alpha');
  assert.equal(eventsOf(streams.second).length, 0, 'a removed member gets nothing');
  assert.equal(pendingStream.refused, true, 'a pending member opens no stream at all');
  const text = streams.owner.frames.join('');
  for (const word of ['device_id', '"job', 'lease']) assert.equal(text.includes(word), false, `no ${word} on the wire`);

  // After a reconnect the next change arrives on the new stream (the event is ephemeral: it is not replayed).
  streams.member.response.destroy();
  const again = await streamOf(h, member);
  assert.equal(eventsOf(again).length, 0, 'nothing replayed');
  h.m.node({ models: [poolModel('beta')] });
  assert.ok(await waitUntil(() => eventsOf(again).length >= 1, { attempts: 150 }), 'the member gets the next change');
  assert.equal(eventsOf(again).at(-1).nodes.length, 2);
});
