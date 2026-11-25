'use strict';

// The desktop team host supervisor (slice 1f-2) over a fake utility process:
// the key goes only in the `start` message, sent once the child has spawned;
// states stopped | starting | running | stopping | failed; `error` is failure in
// every state, also after `ready`; an exit with no `stopped` is failure; no
// restart; stop asks first and ends the child through the held handle exactly
// once when it does not answer in time; nothing is left behind.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createHostSupervisor } = require('../services/team/host/host-supervisor');
const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { createFakeFork, healthyHostScript } = require('./helpers/team-host-fakes');

const BOUNDS = Object.freeze({ stopMs: 150, killWaitMs: 150, startMs: 2_000, pingMs: 40 });
const ARGS = ['--config', 'C:\\data\\team-host\\host-config.json', '--team-init'];
const tick = (ms = 10) => new Promise((resolve) => { setTimeout(resolve, ms); });

function setup(t, { script, bounds = BOUNDS, env = { SystemRoot: 'C:\\Windows' }, stdout = false } = {}) {
  const fake = createFakeFork({ script, stdout });
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

test('owner_invite: a 512-char v2 invite is delivered, 513 is dropped (the invite cap, not the 256 text cap)', async (t) => {
  const { MAX_INVITE_CHARS } = require('../server/team/invites');
  assert.equal(MAX_INVITE_CHARS, 512);
  const fits = `jteam2_${'a'.repeat(MAX_INVITE_CHARS - 7)}`;
  const over = `jteam2_${'b'.repeat(MAX_INVITE_CHARS - 6)}`;
  const { logs, supervisor } = setup(t, { script: (child, message) => {
    if (message.type === 'start') {
      setImmediate(() => {
        child.reply({ type: 'ready', boot_epoch: 'e', team_id: 't', public_key: 'p', addresses: [] });
        child.reply({ type: 'owner_invite', invite: over });
        child.reply({ type: 'owner_invite', invite: fits });
      });
    }
    if (message.type === 'stop') setImmediate(() => { child.reply({ type: 'stopped' }); child.exit(0); });
  } });
  const seen = [];
  await supervisor.start({ args: ARGS, hostKey: key(), teamName: 'S', onOwnerInvite: (value) => seen.push(value) });
  await tick(20);
  assert.deepEqual(seen.map((value) => value.length), [MAX_INVITE_CHARS], 'only the 512-char invite arrived');
  assert.equal(logs.filter((entry) => entry.event === 'team.host.message_dropped').length, 1, 'the 513-char one was dropped');
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

test('a relay token travels only in start, after the key; the child spawn options, logs and states never carry it', async (t) => {
  const token = 'owner-relay-token-5a';
  const { fake, logs, states, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }) });
  const started = await supervisor.start({ args: ARGS, hostKey: key(), relayToken: token });
  assert.equal(started.ok, true, JSON.stringify(started));
  const call = fake.calls[0];
  assert.deepEqual(Object.keys(call.child.posted[0]), ['type', 'host_key', 'relay_token']);
  assert.equal(call.child.posted[0].relay_token, token);
  const elsewhere = JSON.stringify([call.args, call.options, logs, states, call.child.posted.slice(1), supervisor.snapshot()]);
  assert.equal(elsewhere.includes(token), false);
  // What the child was spawned with, as the fork received it.
  assert.equal(JSON.stringify(call.options.env ?? {}).includes(token), false, 'no token in the child environment');
  assert.equal(JSON.stringify(call.args).includes(token), false, 'no token in the child arguments');
  assert.equal(JSON.stringify(call.options.execArgv ?? []).includes(token), false, 'no token in the child execArgv');
  assert.ok(Object.keys(call.options.env).length > 0, 'the env the fork received is the one checked');
  await supervisor.stop();
  const plain = setup(t, { script: healthyHostScript({ teamId: 'team_x' }) });
  await plain.supervisor.start({ args: ARGS, hostKey: key() });
  assert.deepEqual(Object.keys(plain.fake.calls[0].child.posted[0]), ['type', 'host_key'], 'no token, no field');
  await plain.supervisor.stop();
  const badKey = key();
  const refused = await plain.supervisor.start({ args: ARGS, hostKey: badKey, relayToken: 'has a space' });
  assert.deepEqual(refused, { ok: false, error: { code: 'invalid_request', reason: 'team_relay_token_invalid' } });
  assert.equal(plain.fake.calls.length, 1, 'a bad token forks nothing');
  assert.equal(badKey.every((byte) => byte === 0), true, 'and the key is zeroed');
});

test('`reach` sets the snapshot while running, tells listeners once per change, and clears on leaving running', async (t) => {
  // No push interval here: tests/team-host-supervisor-reach.test.js holds that rule.
  const { fake, logs, states, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }),
    bounds: { ...BOUNDS, reachPushMs: 0 } });
  assert.equal(supervisor.snapshot().reach, null, 'null before any host');
  await supervisor.start({ args: ARGS, hostKey: key() });
  const child = fake.last();
  assert.equal(supervisor.snapshot().reach, null, 'null until the host judges');
  const before = states.length;
  await tick(15); // so a `since` taken now would differ from the running state's
  child.reply({ type: 'reach', result: 'probably_reachable', reason: 'mapped' });
  await tick();
  assert.deepEqual(supervisor.snapshot().reach, { result: 'probably_reachable', reason: 'mapped' });
  assert.equal(states.length, before + 1, 'one notice');
  assert.deepEqual(states.at(-1).reach, { result: 'probably_reachable', reason: 'mapped' });
  assert.equal(states.at(-1).since, states.at(-2).since, 'a verdict keeps the since of the running state');
  child.reply({ type: 'reach', result: 'probably_reachable', reason: 'mapped' });
  await tick();
  assert.equal(states.length, before + 1, 'the same verdict again tells nobody');
  for (const bad of [{ type: 'reach', result: 'maybe', reason: 'mapped' }, { type: 'reach', result: 'relay', reason: 'wifi' },
    { type: 'reach', result: 'relay' }, { type: 'reach', result: 'relay', reason: 'relay_connected', extra: 1 }]) {
    child.reply(bad);
  }
  await tick();
  assert.equal(supervisor.snapshot().state, 'running', 'a bad reach never fails the host');
  assert.deepEqual(supervisor.snapshot().reach, { result: 'probably_reachable', reason: 'mapped' });
  assert.equal(logs.filter((entry) => entry.event === 'team.host.message_dropped').length, 4, 'each dropped and counted');
  child.reply({ type: 'reach', result: 'relay', reason: 'relay_connected' });
  await tick();
  assert.deepEqual(states.at(-1).reach, { result: 'relay', reason: 'relay_connected' });
  await supervisor.stop();
  assert.equal(supervisor.snapshot().reach, null, 'cleared after stop');
  assert.equal(states.filter((s) => s.state !== 'running').every((s) => s.reach === null), true, 'only running carries reach');

  await supervisor.start({ args: ARGS, hostKey: key() });
  const second = fake.last();
  second.reply({ type: 'reach', result: 'not_reachable', reason: 'internet_off' });
  await tick();
  assert.deepEqual(supervisor.snapshot().reach, { result: 'not_reachable', reason: 'internet_off' });
  second.reply({ type: 'error', reason: 'team_store_failed' });
  await tick();
  assert.equal(supervisor.snapshot().state, 'failed');
  assert.equal(supervisor.snapshot().reach, null, 'cleared after a failure');
});

test('a relay token is never sent when the fork throws, or a stop or a failure comes before the spawn', async (t) => {
  const token = 'relay-token-drop';
  const throwing = createHostSupervisor({ fork: () => { throw new Error('spawn failed'); }, entryPath: 'e.js', env: {}, bounds: BOUNDS });
  const failed = await throwing.start({ args: ARGS, hostKey: key(), relayToken: token });
  assert.equal(failed.error.reason, 'team_host_spawn_failed');
  assert.equal(JSON.stringify(throwing.snapshot()).includes(token), false);

  for (const before of ['stop', 'error']) {
    const fake = createFakeFork({ spawnDelay: 'manual', script: healthyHostScript({ teamId: 'team_x' }) });
    const supervisor = createHostSupervisor({ fork: fake.fork, entryPath: 'e.js', env: {}, bounds: BOUNDS });
    t.after(() => supervisor.stop());
    const started = supervisor.start({ args: ARGS, hostKey: key(), relayToken: token });
    const child = fake.last();
    if (before === 'stop') void supervisor.stop(); else child.reply({ type: 'error', reason: 'team_store_failed' });
    child.spawnNow();
    await started;
    await tick(20);
    assert.equal(child.posted.some((message) => message.type === 'start'), false, `${before}: no start message`);
    assert.equal(JSON.stringify(child.posted).includes(token), false, `${before}: the token was not sent`);
  }
});

test('a change that is only the verdict logs team.host.reach with its words, and no team.host.state line', async (t) => {
  const { fake, logs, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }) });
  await supervisor.start({ args: ARGS, hostKey: key() });
  const stateLines = () => logs.filter((entry) => entry.event === 'team.host.state').length;
  const before = stateLines();
  fake.last().reply({ type: 'reach', result: 'relay', reason: 'relay_connected' });
  await tick();
  assert.equal(stateLines(), before, 'no second running line');
  assert.deepEqual(logs.filter((entry) => entry.event === 'team.host.reach'),
    [{ level: 'INFO', event: 'team.host.reach', fields: { result: 'relay', reason: 'relay_connected' } }]);
});

test('the child is forked with stdout piped and stdin and stderr ignored', async (t) => {
  const { fake, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }) });
  assert.equal((await supervisor.start({ args: ARGS, hostKey: key() })).ok, true);
  assert.deepEqual(fake.calls[0].options.stdio, ['ignore', 'pipe', 'ignore']);
});

// A temp `<base>/team-host/logs/` and the `--config` arguments that point the sink at it.
function logFolder(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-sup-log-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'team-host', 'logs'), { recursive: true });
  const file = path.join(base, 'team-host', 'logs', 'host.log');
  const lines = () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((text) => JSON.parse(text));
  return {
    args: ['--config', path.join(base, 'team-host', 'host-config.json')], file, lines,
    events: () => lines().map((entry) => entry.event),
    write: (stream, event) => stream.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', event })}\n`),
  };
}

test('a piped child writes <config dir>/logs/host.log for its run; every way out ends the sink; a new start appends', async (t) => {
  const { args, file, events, write } = logFolder(t);
  const { fake, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }), stdout: true });
  assert.equal((await supervisor.start({ args, hostKey: key() })).ok, true);
  const first = fake.last().stdout;
  write(first, 'team.first.line');
  await tick();
  await supervisor.stop();
  assert.equal(first.listenerCount('data'), 0, 'no listener outlives the run');
  // A run that fails after ready is ended through the handle; its sink ends with it.
  assert.equal((await supervisor.start({ args, hostKey: key() })).ok, true);
  const second = fake.last().stdout;
  write(second, 'team.second.line');
  await tick();
  const failing = fake.last();
  failing.reply({ type: 'error', reason: 'team_store_failed' });
  for (let waited = 0; !failing.exited && waited < 2_000; waited += 10) await tick();
  assert.equal(failing.exited, true, 'the failed child is ended through the handle');
  await supervisor.stop(); // with no run, it waits for the released sink's last read
  assert.equal(second.listenerCount('data'), 0);
  assert.deepEqual(events(), ['team.first.line', 'team.host_log.closed', 'team.second.line', 'team.host_log.closed']);
  // A fork that throws makes no sink and writes nothing.
  const before = fs.readFileSync(file, 'utf8');
  const throwing = createHostSupervisor({ fork: () => { throw new Error('spawn failed'); }, entryPath: 'e.js', bounds: BOUNDS });
  assert.equal((await throwing.start({ args, hostKey: key() })).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('the sink keeps the lines written after an unrequested exit, and ends on the late exit of a held child', async (t) => {
  const { args, lines, events, write } = logFolder(t);
  const { fake, supervisor } = setup(t, { stdout: true, script: (child, message) => {
    if (message.type === 'start') { child.exitOnKill = false; setImmediate(() => child.reply({ ...READY })); }
  } });
  assert.equal((await supervisor.start({ args, hostKey: key() })).ok, true);
  const exiting = fake.last();
  const first = exiting.stdout;
  write(first, 'team.before.exit');
  // Runs after the supervisor's own exit listener and before the pipe ends, as a real pipe can.
  exiting.once('exit', () => write(first, 'team.after.exit'));
  exiting.exit(1);
  assert.equal(supervisor.snapshot().reason, 'team_host_exited');
  await supervisor.stop();
  assert.deepEqual(events(), ['team.before.exit', 'team.after.exit', 'team.host_log.closed']);
  assert.equal(lines().at(-1).kept, 2);
  assert.equal(first.listenerCount('data'), 0);
  // A child that survives the kill is held, and its sink reads on until that late exit.
  assert.equal((await supervisor.start({ args, hostKey: key() })).ok, true);
  const held = fake.last();
  const second = held.stdout;
  assert.equal((await supervisor.stop()).reason, 'team_host_exit_unconfirmed');
  write(second, 'team.while.held');
  await tick();
  assert.equal(second.listenerCount('data'), 1, 'still read while held');
  held.exit(0);
  await supervisor.stop();
  assert.equal(second.listenerCount('data'), 0);
  assert.deepEqual(events().slice(3), ['team.while.held', 'team.host_log.closed']);
});

test('a sink that throws when the run is released never keeps the run held', async (t) => {
  const { args } = logFolder(t);
  const { fake, supervisor } = setup(t, { script: healthyHostScript({ teamId: 'team_x' }), stdout: true });
  assert.equal((await supervisor.start({ args, hostKey: key() })).ok, true);
  const stdout = fake.last().stdout;
  const { once, removeListener } = stdout;
  // One throw from whichever the release reaches first: subscribing for the drain, or removing the reader.
  stdout.once = () => { stdout.once = once; throw new Error('sink failed'); };
  stdout.removeListener = (type, listener) => {
    if (type !== 'data') return removeListener.call(stdout, type, listener);
    stdout.removeListener = removeListener;
    throw new Error('sink failed');
  };
  await supervisor.stop();
  stdout.once = once;
  stdout.removeListener = removeListener;
  assert.deepEqual(supervisor.resources(), { child: false, timers: 0, childListeners: 0 });
  assert.equal(supervisor.snapshot().state, 'stopped');
  // The sink's own one-second timer still closes the file before the folder is removed.
  for (let waited = 0; stdout.listenerCount('data') > 0 && waited < 2_000; waited += 20) await tick(20);
  assert.equal(stdout.listenerCount('data'), 0);
  assert.equal((await supervisor.start({ args, hostKey: key() })).ok, true, 'a new start is not refused');
});
