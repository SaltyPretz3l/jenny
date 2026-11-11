'use strict';

// The desktop team host supervisor (slice 1f-2) over a fake utility process:
// the key goes only in the `start` message, sent once the child has spawned;
// states stopped | starting | running | stopping | failed; `error` is failure in
// every state, also after `ready`; an exit with no `stopped` is failure; no
// restart; stop asks first and ends the child through the held handle exactly
// once when it does not answer in time; nothing is left behind.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { createHostSupervisor } = require('../services/team/host/host-supervisor');
const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { createFakeFork, healthyHostScript } = require('./helpers/team-host-fakes');

const BOUNDS = Object.freeze({ stopMs: 150, killWaitMs: 150, startMs: 2_000, pingMs: 40 });
const ARGS = ['--config', 'C:\\data\\team-host\\host-config.json', '--team-init'];
const tick = (ms = 10) => new Promise((resolve) => { setTimeout(resolve, ms); });

function setup(t, { script, bounds = BOUNDS, env = { SystemRoot: 'C:\\Windows' } } = {}) {
  const fake = createFakeFork({ script });
  const logs = [];
  const states = [];
  const supervisor = createHostSupervisor({ fork: fake.fork, entryPath: 'C:\\app\\host-entry.js', env, bounds,
    log: (level, event, fields) => logs.push({ level, event, fields: fields ?? {} }) });
  supervisor.onState((snapshot) => states.push(snapshot));
  t.after(async () => { await supervisor.stop(); });
  return { fake, logs, states, supervisor };
}

function key() {
  return crypto.randomBytes(32);
}

test('start: the key travels only in start{host_key}, after spawn; args and env never carry it', async (t) => {
  const hostKey = key();
  const encoded = hostKey.toString('base64url');
  const { fake, logs, states, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }) });
  const started = await supervisor.start({ args: ARGS, hostKey, teamName: 'Studio' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const call = fake.calls[0];
  assert.equal(call.modulePath, 'C:\\app\\host-entry.js');
  assert.deepEqual(call.args, ARGS);
  assert.deepEqual(call.child.posted[0], { type: 'start', host_key: encoded });
  assert.equal(JSON.stringify(call.args).includes(encoded), false);
  assert.equal(JSON.stringify(call.options).includes(encoded), false);
  assert.equal(JSON.stringify(logs).includes(encoded), false);
  assert.equal(JSON.stringify(states).includes(encoded), false);
  assert.equal(hostKey.every((byte) => byte === 0), true, 'the caller buffer is zeroed after use');
  assert.equal(supervisor.snapshot().state, 'running');
  assert.equal(supervisor.snapshot().team_id, 'team_x');
  assert.equal(supervisor.snapshot().team_name, 'Studio');
  assert.deepEqual(states.map((s) => s.state), ['starting', 'running']);
});

test('the start message waits for spawn', async (t) => {
  const fake = createFakeFork({ spawnDelay: 'manual', script: healthyHostScript({ teamId: 'team_x' }) });
  const supervisor = createHostSupervisor({ fork: fake.fork, entryPath: 'e.js', env: {}, bounds: BOUNDS });
  t.after(() => supervisor.stop());
  const pending = supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  await tick();
  assert.deepEqual(fake.last().posted, [], 'nothing is posted before spawn');
  fake.last().spawnNow();
  assert.equal((await pending).ok, true);
  assert.equal(fake.last().posted[0].type, 'start');
});

test('the parent pings while the child lives and stops pinging after exit', async (t) => {
  const { fake, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }) });
  await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  await tick(150);
  const pings = fake.last().posted.filter((m) => m.type === 'ping').length;
  assert.ok(pings >= 2, `pings sent: ${pings}`);
  await supervisor.stop();
  const after = fake.last().posted.length;
  await tick(120);
  assert.equal(fake.last().posted.length, after, 'no ping after the child is gone');
});

test('error before ready: failed with the reason, no restart, the handle released', async (t) => {
  const { fake, supervisor } = setup(t, { script: (child, message) => {
    if (message.type === 'start') setImmediate(() => { child.reply({ type: 'error', reason: 'team_host_key_mismatch' }); setImmediate(() => child.exit(1)); });
  } });
  const started = await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  assert.deepEqual(started, { ok: false, error: { code: TEAM_ERROR_CODES.HOST_UNAVAILABLE, reason: 'team_host_key_mismatch' } });
  await tick(30);
  assert.equal(supervisor.snapshot().state, 'failed');
  assert.equal(supervisor.snapshot().reason, 'team_host_key_mismatch');
  assert.equal(fake.calls.length, 1, 'no restart');
  assert.deepEqual(supervisor.resources(), { child: false, timers: 0, childListeners: 0 });
});

test('error after ready: failed, and a child that does not exit is ended through the handle once', async (t) => {
  const { fake, supervisor } = setup(t, { script: (child, message) => {
    if (message.type === 'start') {
      setImmediate(() => {
        child.reply({ type: 'ready', boot_epoch: 'e', team_id: 'team_x', public_key: 'pk', addresses: [] });
        setImmediate(() => child.reply({ type: 'error', reason: 'team_member_state_invalid' }));
      });
    }
  } });
  const started = await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  assert.equal(started.ok, true, 'ready came first');
  await tick(30);
  assert.equal(supervisor.snapshot().state, 'failed');
  assert.equal(supervisor.snapshot().reason, 'team_member_state_invalid');
  await tick(BOUNDS.stopMs + 80);
  assert.equal(fake.last().kills, 1, 'ended through the held handle once');
  assert.equal(fake.calls.length, 1, 'no restart');
  assert.deepEqual(supervisor.resources(), { child: false, timers: 0, childListeners: 0 });
});

test('a child that exits with no message is failed with a reason', async (t) => {
  const { fake, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }) });
  await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  fake.last().exit(3);
  await tick();
  assert.equal(supervisor.snapshot().state, 'failed');
  assert.equal(supervisor.snapshot().reason, 'team_host_exited');
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(supervisor.resources(), { child: false, timers: 0, childListeners: 0 });
});

test('a start that never reaches ready is stopped at the start bound', async (t) => {
  const { fake, supervisor } = setup(t, { bounds: { ...BOUNDS, startMs: 80 }, script: (child, message) => {
    if (message.type === 'stop') setImmediate(() => { child.reply({ type: 'stopped' }); child.exit(0); });
  } });
  const started = await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  assert.equal(started.ok, false);
  assert.equal(started.error.reason, 'team_host_start_timeout');
  await tick(30);
  assert.equal(supervisor.snapshot().state, 'failed');
  assert.equal(fake.last().kills, 0);
});

test('stop: stopped in time ends cleanly, no kill', async (t) => {
  const { fake, states, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }) });
  await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  const stopped = await supervisor.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.reason, null);
  assert.equal(fake.last().kills, 0);
  assert.deepEqual(fake.last().posted.filter((m) => m.type === 'stop'), [{ type: 'stop' }]);
  assert.deepEqual(states.map((s) => s.state), ['starting', 'running', 'stopping', 'stopped']);
  assert.deepEqual(supervisor.resources(), { child: false, timers: 0, childListeners: 0 });
});

test('stop: no answer within the bound ends the child through the held handle exactly once', async (t) => {
  const { fake, supervisor } = setup(t, { script: (child, message) => {
    if (message.type === 'start') setImmediate(() => child.reply({ type: 'ready', boot_epoch: 'e', team_id: 't', public_key: 'p', addresses: [] }));
  } });
  await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  const begun = Date.now();
  const [first, second] = await Promise.all([supervisor.stop(), supervisor.stop()]);
  assert.ok(Date.now() - begun >= BOUNDS.stopMs - 10);
  assert.equal(fake.last().kills, 1, 'exactly one kill through the handle');
  assert.equal(first.state, 'stopped');
  assert.equal(first.reason, 'team_host_stop_timeout');
  assert.deepEqual(first, second);
  assert.deepEqual(supervisor.resources(), { child: false, timers: 0, childListeners: 0 });
});

const READY = Object.freeze({ type: 'ready', boot_epoch: 'e', team_id: 't', public_key: 'p', addresses: [] });

// Until the exit is seen the child may still hold the profile lock: no second host.
async function assertHeldUntilExit(fake, supervisor, finalState) {
  assert.equal(supervisor.snapshot().state, 'failed');
  assert.equal(supervisor.snapshot().reason, 'team_host_exit_unconfirmed');
  const held = supervisor.resources();
  assert.equal(held.child, true, 'the handle is kept');
  assert.ok(held.childListeners > 0, 'the exit listener is kept');
  assert.equal(held.timers, 0, 'no ping or wait timer is left running');
  const refused = await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  assert.deepEqual(refused, { ok: false, error: { code: 'invalid_request', reason: 'team_host_exit_unconfirmed' } });
  assert.equal(fake.calls.length, 1, 'no second host is forked');
  const again = await supervisor.stop();
  assert.equal(again.reason, 'team_host_exit_unconfirmed', 'a second stop leaves the held state as it is');
  assert.equal(fake.last().kills, 1, 'and kills no second time');
  fake.last().exit(1);
  await tick();
  assert.deepEqual(supervisor.resources(), { child: false, timers: 0, childListeners: 0 });
  assert.deepEqual({ state: supervisor.snapshot().state, reason: supervisor.snapshot().reason }, finalState);
  fake.last().exitOnKill = true;
}

test('stop: a child that survives the kill is held, and a new start waits for its exit', async (t) => {
  const { fake, supervisor } = setup(t, { script: (child, message) => {
    if (message.type === 'start') { child.exitOnKill = false; setImmediate(() => child.reply({ ...READY })); }
  } });
  await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  const result = await supervisor.stop();
  assert.equal(fake.last().kills, 1);
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'team_host_exit_unconfirmed');
  await assertHeldUntilExit(fake, supervisor, { state: 'stopped', reason: 'team_host_stop_timeout' });
  const again = await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  assert.equal(again.ok, true, 'accepted once the exit is seen');
  assert.equal(fake.calls.length, 2);
});

test('error after ready: a child that survives the kill is held until its exit', async (t) => {
  const { fake, supervisor } = setup(t, { script: (child, message) => {
    if (message.type === 'start') {
      child.exitOnKill = false;
      setImmediate(() => { child.reply({ ...READY }); setImmediate(() => child.reply({ type: 'error', reason: 'team_member_state_invalid' })); });
    }
  } });
  await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  await tick(BOUNDS.stopMs + BOUNDS.killWaitMs + 80);
  assert.equal(fake.last().kills, 1);
  await assertHeldUntilExit(fake, supervisor, { state: 'failed', reason: 'team_member_state_invalid' });
});

test('a stop before spawn: the spawn sends no key and starts no ping', async (t) => {
  const fake = createFakeFork({ spawnDelay: 'manual' });
  const supervisor = createHostSupervisor({ fork: fake.fork, entryPath: 'e.js', env: {}, bounds: BOUNDS });
  t.after(() => supervisor.stop());
  const pending = supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  const stopping = supervisor.stop();
  fake.last().spawnNow();
  await tick(BOUNDS.pingMs * 3);
  assert.deepEqual(fake.last().posted.map((m) => m.type), ['stop'], 'no start{host_key} and no ping');
  fake.last().exit(0);
  assert.equal((await pending).ok, false);
  await stopping;
  assert.deepEqual(supervisor.resources(), { child: false, timers: 0, childListeners: 0 });
});

test('an unrequested stopped with no exit is reaped within the bound and ends stopped', async (t) => {
  const { fake, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }) });
  await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  fake.last().reply({ type: 'stopped' });
  await tick(BOUNDS.stopMs + 80);
  assert.equal(fake.last().kills, 1, 'ended through the held handle once');
  assert.equal(supervisor.snapshot().state, 'stopped');
  assert.equal(supervisor.snapshot().reason, 'team_host_stopped_itself');
  assert.deepEqual(supervisor.resources(), { child: false, timers: 0, childListeners: 0 });
});

test('a second start while starting or running is refused with a plain reason', async (t) => {
  const { fake, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }) });
  const first = supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  const whileStarting = await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  assert.deepEqual(whileStarting, { ok: false, error: { code: 'invalid_request', reason: 'team_host_busy' } });
  await first;
  const whileRunning = await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  assert.equal(whileRunning.error.reason, 'team_host_busy');
  assert.equal(fake.calls.length, 1);
  await supervisor.stop();
  const again = await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  assert.equal(again.ok, true, 'a start after a stop works');
  assert.equal(fake.calls.length, 2);
});

test('a refused start zeroes the key too', async (t) => {
  const { supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }) });
  await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  const second = key();
  await supervisor.start({ args: ARGS, hostKey: second, teamName: 'S' });
  assert.equal(second.every((byte) => byte === 0), true);
});

test('owner_invite goes to the callback once and never into a state or a log', async (t) => {
  const invite = 'jteam1-OWNER-INVITE-SECRET-TEXT';
  const { logs, states, supervisor } = setup(t, { script: (child, message) => {
    if (message.type === 'start') {
      setImmediate(() => {
        child.reply({ type: 'ready', boot_epoch: 'e', team_id: 't', public_key: 'p', addresses: [] });
        child.reply({ type: 'owner_invite', invite });
        child.reply({ type: 'owner_invite', invite: `${invite}-2` });
      });
    }
    if (message.type === 'stop') setImmediate(() => { child.reply({ type: 'stopped' }); child.exit(0); });
  } });
  const seen = [];
  await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S', onOwnerInvite: (value) => seen.push(value) });
  await tick(20);
  assert.deepEqual(seen, [invite]);
  assert.equal(JSON.stringify(states).includes('OWNER-INVITE'), false);
  assert.equal(JSON.stringify(logs).includes('OWNER-INVITE'), false);
  assert.equal(JSON.stringify(supervisor.snapshot()).includes('OWNER-INVITE'), false);
});

test('malformed child messages are dropped and counted, never acted on', async (t) => {
  const { logs, supervisor } = setup(t, { script: (child, message) => {
    if (message.type === 'start') {
      setImmediate(() => {
        child.reply({ type: 'ready', boot_epoch: 'e', team_id: 't', public_key: 'p', addresses: [], extra: 1 });
        child.reply({ type: 'error' });
        child.reply('ready');
        child.reply({ type: 'ready', boot_epoch: 'e', team_id: 't', public_key: 'p', addresses: ['1.2.3.4:5'] });
      });
    }
    if (message.type === 'stop') setImmediate(() => { child.reply({ type: 'stopped' }); child.exit(0); });
  } });
  const started = await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  assert.equal(started.ok, true);
  assert.deepEqual(supervisor.snapshot().addresses, ['1.2.3.4:5']);
  assert.equal(logs.filter((entry) => entry.event === 'team.host.message_dropped').length, 3);
});

test('membership_changed is forwarded to its callback without a state change', async (t) => {
  const { states, supervisor } = setup(t, { script: (child, message) => {
    if (message.type === 'start') {
      setImmediate(() => {
        child.reply({ type: 'ready', boot_epoch: 'e', team_id: 't', public_key: 'p', addresses: [] });
        child.reply({ type: 'membership_changed', kind: 'member_joined', member_id: 'member_abc' });
      });
    }
    if (message.type === 'stop') setImmediate(() => { child.reply({ type: 'stopped' }); child.exit(0); });
  } });
  const seen = [];
  await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S', onMembershipChanged: (event) => seen.push(event) });
  await tick(20);
  assert.deepEqual(seen, [{ kind: 'member_joined', member_id: 'member_abc' }]);
  assert.deepEqual(states.map((s) => s.state), ['starting', 'running']);
});

test('an unrequested stopped then exit is stopped, not failed', async (t) => {
  const { fake, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }) });
  await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S' });
  fake.last().reply({ type: 'stopped' });
  fake.last().exit(0);
  await tick();
  assert.equal(supervisor.snapshot().state, 'stopped');
  assert.equal(supervisor.snapshot().reason, 'team_host_stopped_itself');
});

test('a fork that throws is failed before anything is posted', async (t) => {
  const supervisor = createHostSupervisor({ fork: () => { throw new Error('no utility process'); }, entryPath: 'e.js',
    env: {}, bounds: BOUNDS });
  t.after(() => supervisor.stop());
  const hostKey = key();
  const started = await supervisor.start({ args: ARGS, hostKey, teamName: 'S' });
  assert.equal(started.ok, false);
  assert.equal(started.error.reason, 'team_host_spawn_failed');
  assert.equal(hostKey.every((byte) => byte === 0), true);
  assert.deepEqual(supervisor.resources(), { child: false, timers: 0, childListeners: 0 });
});
