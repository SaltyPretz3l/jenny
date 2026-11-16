'use strict';

// The supervisor's minimum interval between pushes caused by a new verdict alone (slice 5-5b), with a
// fake clock: the first verdict-only change is told at once, a later one waits for the end of the
// interval and is told then with the newest verdict, and a state change is told at once and drops any
// verdict push still waiting. The rest of the supervisor is in tests/team-host-supervisor.test.js.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { createHostSupervisor } = require('../services/team/host/host-supervisor');
const { createFakeFork, healthyHostScript } = require('./helpers/team-host-fakes');

const BOUNDS = Object.freeze({ stopMs: 150, killWaitMs: 150, startMs: 2_000, pingMs: 1_000, reachPushMs: 1_000 });
const ARGS = ['--config', 'C:\\data\\team-host\\host-config.json'];
const tick = (ms = 10) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A clock whose time moves only when the test says; its timers fire when the time passes them.
function fakeClock() {
  let time = 1_000_000;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => time,
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > time) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

async function running(t) {
  const clock = fakeClock();
  const fake = createFakeFork({ script: healthyHostScript({ teamId: 'team_x' }) });
  const logs = [];
  const states = [];
  const supervisor = createHostSupervisor({ fork: fake.fork, entryPath: 'C:\\app\\host-entry.js', env: {}, bounds: BOUNDS,
    clock, log: (level, event, fields) => logs.push({ level, event, fields: fields ?? {} }) });
  supervisor.onState((snapshot) => states.push(snapshot));
  t.after(() => supervisor.stop());
  await supervisor.start({ args: ARGS, hostKey: crypto.randomBytes(32) });
  const child = fake.last();
  const say = async (result, reason) => { child.reply({ type: 'reach', result, reason }); await tick(); };
  return { clock, child, logs, states, supervisor, say };
}

const verdicts = (states) => states.filter((s) => s.state === 'running' && s.reach).map((s) => s.reach.reason);

test('a flapping verdict is told at most once per interval, the newest one at the end of it', async (t) => {
  const { clock, states, supervisor, say, logs } = await running(t);
  await say('probably_reachable', 'mapped');
  assert.deepEqual(verdicts(states), ['mapped'], 'the first verdict is told at once');
  const timers = supervisor.resources().timers;
  await say('not_reachable', 'mapping_unavailable');
  await say('probably_reachable', 'mapped');
  await say('relay', 'relay_connected');
  assert.deepEqual(verdicts(states), ['mapped'], 'inside the interval nobody is told');
  assert.deepEqual(supervisor.snapshot().reach, { result: 'relay', reason: 'relay_connected' }, 'the snapshot is current');
  assert.equal(clock.pending(), 1, 'one push waits');
  assert.equal(supervisor.resources().timers, timers + 1, 'and resources() counts it');
  clock.advance(999);
  assert.deepEqual(verdicts(states), ['mapped']);
  clock.advance(1);
  assert.deepEqual(verdicts(states), ['mapped', 'relay_connected'], 'the newest verdict, once, at the end');
  assert.equal(supervisor.resources().timers, timers);
  assert.deepEqual(logs.filter((entry) => entry.event === 'team.host.reach').map((entry) => entry.fields.reason),
    ['mapped', 'relay_connected'], 'one log line per push');
});

test('a verdict that is back to the one last told is not told again', async (t) => {
  const { clock, states, say } = await running(t);
  await say('probably_reachable', 'mapped');
  await say('relay', 'relay_connected');
  await say('probably_reachable', 'mapped');
  clock.advance(1_000);
  assert.deepEqual(verdicts(states), ['mapped']);
  clock.advance(5_000);
  await say('relay', 'relay_connected');
  assert.deepEqual(verdicts(states), ['mapped', 'relay_connected'], 'after the interval a new verdict is told at once');
});

test('a state change is told at once and drops the verdict push that was waiting', async (t) => {
  const { clock, states, supervisor, say } = await running(t);
  await say('probably_reachable', 'mapped');
  await say('relay', 'relay_connected');
  assert.equal(clock.pending(), 1);
  const before = states.length;
  await supervisor.stop();
  assert.ok(states.length > before, 'stopping and stopped were told without waiting');
  assert.equal(clock.pending(), 0, 'the waiting push is gone');
  assert.deepEqual(supervisor.resources(), { child: false, timers: 0, childListeners: 0 });
  clock.advance(5_000);
  assert.deepEqual(verdicts(states), ['mapped'], 'nothing more after the stop');
  assert.equal(states.at(-1).state, 'stopped');
});

// The reconnect code needs the router's outside address; it stays in main and in no snapshot.
test('the mapped address is kept while running, in no snapshot, and gone with the host', async (t) => {
  const env = await running(t);
  assert.equal(env.supervisor.mapped(), null);
  env.child.reply({ type: 'mapped', external: '203.0.113.9:5999' });
  await tick();
  assert.equal(env.supervisor.mapped(), '203.0.113.9:5999');
  assert.equal(JSON.stringify(env.supervisor.snapshot()).includes('203.0.113.9'), false);
  assert.equal(JSON.stringify(env.states).includes('203.0.113.9'), false);
  assert.equal(JSON.stringify(env.logs).includes('203.0.113.9'), false);
  for (const external of ['not an address', 'team.example.net:1', '999.1.1.1:99999', '[2001:db8::1]:5', 5, undefined]) {
    env.child.reply({ type: 'mapped', external });
    await tick();
    assert.equal(env.supervisor.mapped(), '203.0.113.9:5999', `a malformed address is dropped: ${String(external)}`);
  }
  env.child.reply({ type: 'mapped', external: null });
  await tick();
  assert.equal(env.supervisor.mapped(), null);
  env.child.reply({ type: 'mapped', external: '203.0.113.9:5999' });
  await tick();
  await env.supervisor.stop();
  assert.equal(env.supervisor.mapped(), null);
});
