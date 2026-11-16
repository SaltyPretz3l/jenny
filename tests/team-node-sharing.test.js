'use strict';

// Row 123 slice 4e: "Share this PC's GPU" (services/team/node/team-sharing.js) with the real node
// agent and the real team link over a fake transport bridge (the team's one connection, lent by a
// fake connection manager) in front of the agent fixture's fake host, a scripted engine on a real
// loopback socket and manual timers. No team host, no GPU, no model, no window.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const nodeTest = require('node:test');

const { MARK_BLOCK, createTeamSharing } = require('../services/team/node/team-sharing');
const { createNodeAgent } = require('../services/team/node/node-agent');
const { clientFilePath, saveClientFile } = require('../services/team/client-file');
const { loadSharing, saveSharing, sharingFilePath } = require('../services/team/node/sharing-file');
const { deriveTeamId, keyPairFromSeed } = require('../server/team/ids');
const { DONE, MARKER, createFakeHost, createLogs, createManualTimers, failure, requestBody, sse, startEngine, until } = require('./helpers/team-node-agent-fixture');
const { TOKEN, createBridge, createManager, createSavedStore } = require('./helpers/team-node-sharing-fixture');
const { tempProfile } = require('./helpers/team-client-host');

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const TEAM = 'team_AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'team_BBBBBBBBBBBBBBBBBBBBBB';
const ENGINE_KEY = 'engine_key_secret_value_4e';
const WALL = 1_800_000_000_000;

async function setup(t, { store = createSavedStore(), wall = WALL, key = '', userDataPath = 'unused-profile', load, save, models = ['alpha'],
  hook = (agent) => agent, options = {} } = {}) {
  const timers = createManualTimers();
  const host = createFakeHost({ timers });
  const engine = await startEngine(t, { models });
  const logs = createLogs();
  const bridge = createBridge(host);
  const manager = createManager(bridge);
  const clock = { wall };
  const busy = { on: false };
  const agents = [];
  const engineState = { value: { url: engine.url, kind: 'llama-server', key } };
  const sharing = createTeamSharing({
    userDataPath, getBackend: () => ({}), isBusy: () => busy.on, log: logs.logger, now: () => clock.wall, timers,
    createAgent: (o) => { const agent = createNodeAgent({ ...o, timers, now: () => clock.wall, clock: timers.now }); agents.push(agent); return hook(agent); },
    resolveEngine: () => engineState.value, load: load || store.load, save: save || store.save, ...options,
  });
  let pushes = 0;
  sharing.attach({ onChange: () => { pushes += 1; } });
  t.after(() => sharing.stopAll());
  const drive = async (predicate, label, step = 250, steps = 2000) => {
    for (let i = 0; i < steps; i += 1) {
      if (predicate()) return;
      await timers.advance(step);
    }
    throw new Error(`not reached: ${label}`);
  };
  return { timers, host, engine, logs, bridge, manager, clock, busy, agents, engineState, sharing, store, drive, pushes: () => pushes };
}

const stateOf = (s) => s.sharing.snapshot()?.state ?? 'off';
async function shareOn(s, teamId = TEAM) {
  s.sharing.connectionChanged(teamId, s.manager);
  const answer = await s.sharing.set(teamId, true, { confirmed: true });
  assert.equal(answer.ok, true);
  await s.drive(() => stateOf(s) === 'idle', 'idle');
}
const holdEngine = (engine) => {
  const held = [];
  engine.handle = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(sse('first')); held.push(res); };
  return held;
};
const zero = (agent) => assert.deepEqual(agent.resources(), { timers: 0, sleepers: 0, teamCalls: 0, engineRequests: 0 });
const idleResources = (s) => assert.deepEqual(s.sharing.resources(), { agents: 0, timers: 0, ending: 0, agent: null });

test('off by default: nothing registers, nothing is asked of the bridge, no state', async (t) => {
  const s = await setup(t);
  s.sharing.connectionChanged(TEAM, s.manager);
  await s.timers.advance(5000);
  assert.equal(s.sharing.snapshot(), null);
  assert.equal(s.bridge.requests.length, 0);
  assert.equal(s.agents.length, 0);
  idleResources(s);
});

test('the first turn-on asks for the notice; once confirmed it registers once through the team connection and opens no other', async (t) => {
  const s = await setup(t);
  s.sharing.connectionChanged(TEAM, s.manager);
  assert.deepEqual(await s.sharing.set(TEAM, true), { ok: false, error: { code: 'invalid_request', reason: 'team_share_confirm_needed' } });
  assert.equal(s.store.records.size, 0, 'nothing saved before the notice is confirmed');
  await shareOn(s);
  assert.deepEqual(s.bridge.operations().filter((op) => op === 'team.node.register'), ['team.node.register']);
  const commands = s.bridge.requests.filter((r) => r.path === '/api/v1/commands');
  assert.ok(commands.length > 0 && commands.every((r) => r.headers['X-Client-Token'] === TOKEN
    && JSON.parse(r.body.toString('utf8')).client_id === 'client_1' && JSON.parse(r.body.toString('utf8')).boot_epoch === 'epoch_1'),
  'every command carries the registered client of the one connection');
  assert.ok(s.manager.borrows() > 0, 'calls borrow the live connection');
  // No second connection: neither sharing module can open one (team-link.js holds none of its own).
  for (const file of ['team-sharing', 'team-link', 'sharing-file']) {
    const source = fs.readFileSync(require.resolve(`../services/team/node/${file}`), 'utf8');
    assert.doesNotMatch(source, /require\([^)]*(transport|bridge|node:net|node:tls|http-client)[^)]*\)/u, `${file} opens nothing`);
  }
  assert.equal(s.store.records.get(TEAM).on, true);
  // A later turn-on of a team shared before does not ask again.
  await s.sharing.set(TEAM, false);
  assert.equal((await s.sharing.set(TEAM, true)).ok, true);
});

test('each state the page draws: starting, idle, serving, busy_own, paused, no_model, off', async (t) => {
  const s = await setup(t);
  s.sharing.connectionChanged(TEAM, s.manager);
  await s.sharing.set(TEAM, true, { confirmed: true });
  assert.equal(stateOf(s), 'starting');
  await s.drive(() => stateOf(s) === 'idle', 'idle');
  const { node_id: nodeId, ...shown } = s.sharing.snapshot();
  assert.deepEqual(shown, { team_id: TEAM, serving_since: null, models: ['alpha'], engine: 'llama-server', state: 'idle' });
  assert.equal(nodeId, s.host.of('team.node.register').length ? s.agents[0].status().node_id : null, 'the node this PC shares as');
  assert.match(nodeId, /^node_/u);
  const held = holdEngine(s.engine);
  s.host.queueJob();
  await s.drive(() => stateOf(s) === 'serving', 'serving');
  assert.equal(s.sharing.snapshot().serving_since, s.clock.wall);
  held[0].end(Buffer.concat([sse('rest'), DONE]));
  await s.drive(() => stateOf(s) === 'idle', 'idle again');
  s.busy.on = true;
  await s.drive(() => stateOf(s) === 'busy_own', 'busy_own');
  s.busy.on = false;
  await s.drive(() => stateOf(s) === 'idle', 'idle after own work');
  await s.sharing.pause(TEAM, true);
  assert.equal(stateOf(s), 'paused');
  await s.sharing.pause(TEAM, false);
  await s.drive(() => stateOf(s) === 'idle', 'resumed');
  s.engineState.value = null;
  await s.drive(() => stateOf(s) === 'no_model', 'no_model');
  await s.drive(() => s.sharing.resources().agents === 0, 'the agent stops with no model');
  s.engineState.value = { url: s.engine.url, kind: 'llama-server', key: '' };
  await s.drive(() => stateOf(s) === 'idle', 'starts again when a model runs');
  await s.sharing.set(TEAM, false);
  assert.equal(stateOf(s), 'off');
  assert.ok(s.pushes() > 0, 'state changes reach the state push');
});

test('the member’s own chat stops new claims and a running request finishes', async (t) => {
  const s = await setup(t);
  await shareOn(s);
  const held = holdEngine(s.engine);
  const job = s.host.queueJob();
  await s.drive(() => held.length === 1, 'job forwarding');
  s.busy.on = true;
  held[0].end(Buffer.concat([sse('rest'), DONE]));
  await s.drive(() => job.state === 'done', 'the running job finished');
  const claims = s.host.of('team.node.claim').length;
  s.host.queueJob();
  await s.timers.advance(10_000);
  assert.equal(s.host.of('team.node.claim').length, claims, 'no claim while the member chats');
  s.busy.on = false;
  await s.drive(() => s.host.of('team.node.claim').length > claims, 'claims resume');
});

test('Pause, Resume, Stop now (beside Pause) and Stop after it do what the picks say', async (t) => {
  const s = await setup(t);
  await shareOn(s);
  let held = holdEngine(s.engine);
  let job = s.host.queueJob();
  await s.drive(() => held.length === 1, 'forwarding');
  // Pause: the running request finishes, nothing new is taken, the PC stays registered.
  await s.sharing.pause(TEAM, true);
  assert.deepEqual(s.host.of('team.node.pause').at(-1).params, { on: true, stop_running: false });
  held[0].end(Buffer.concat([sse('rest'), DONE]));
  await s.drive(() => job.state === 'done', 'finished while paused');
  assert.equal(s.host.of('team.node.unregister').length, 0);
  // Resume.
  await s.sharing.pause(TEAM, false);
  assert.deepEqual(s.host.of('team.node.pause').at(-1).params, { on: false });
  // Stop now beside Pause: the request ends at once, the PC stays shared and paused.
  held = holdEngine(s.engine);
  job = s.host.queueJob();
  await s.drive(() => held.length === 1, 'forwarding again');
  await s.sharing.pause(TEAM, true, true);
  assert.deepEqual(s.host.of('team.node.pause').at(-1).params, { on: true, stop_running: true });
  assert.equal(job.state, 'failed');
  assert.equal(stateOf(s), 'paused');
  assert.equal(s.store.records.get(TEAM).on, true);
  // Stop after it: the setting goes off now, the request finishes, then the PC unregisters.
  await s.sharing.pause(TEAM, false);
  held = holdEngine(s.engine);
  job = s.host.queueJob();
  await s.drive(() => held.length === 1, 'forwarding a third time');
  await s.sharing.set(TEAM, false);
  assert.equal(s.store.records.get(TEAM).on, false);
  assert.equal(s.sharing.snapshot(), null);
  assert.equal(s.host.of('team.node.unregister').length, 0, 'not before the request ended');
  held[0].end(Buffer.concat([sse('rest'), DONE]));
  await s.drive(() => s.host.of('team.node.unregister').length === 1, 'unregisters after it');
  assert.equal(job.state, 'done');
  await s.drive(() => s.sharing.resources().agents === 0 && s.sharing.resources().ending === 0, 'let go');
  zero(s.agents.at(-1));
});

test('the switch-off question’s Stop now ends the running request and sharing at once', async (t) => {
  const s = await setup(t);
  await shareOn(s);
  const held = holdEngine(s.engine);
  const job = s.host.queueJob();
  await s.drive(() => held.length === 1, 'forwarding');
  const stopping = s.sharing.stopNow(TEAM);
  await s.drive(() => s.host.of('team.node.unregister').length === 1, 'unregistered');
  await stopping;
  assert.equal(job.state, 'failed');
  assert.equal(s.store.records.get(TEAM).on, false);
  idleResources(s);
  zero(s.agents[0]);
});

test('a second team is refused node_agent_running while one shares', async (t) => {
  const s = await setup(t);
  await shareOn(s);
  s.sharing.connectionChanged(OTHER, createManager(s.bridge));
  assert.deepEqual(await s.sharing.set(OTHER, true, { confirmed: true }), { ok: false, error: { code: 'invalid_request', reason: 'node_agent_running' } });
  assert.equal(s.store.records.has(OTHER), false);
});

for (const [name, end] of [
  ['leaving or removing the team', (s) => s.sharing.drop(TEAM)],
  ['a revoked membership', (s) => { s.manager.row.state = 'revoked'; s.sharing.connectionChanged(TEAM, s.manager); }],
  ['app stop', (s) => s.sharing.stopAll()],
]) {
  test(`${name} ends sharing and leaves no timer, loop or open request`, async (t) => {
    const s = await setup(t);
    await shareOn(s);
    const held = holdEngine(s.engine);
    s.host.queueJob();
    await s.drive(() => held.length === 1, 'forwarding');
    await end(s);
    await s.drive(() => s.sharing.resources().ending === 0, 'let go');
    await until(() => s.engine.openSockets() === 0, 'engine sockets closed');
    idleResources(s);
    zero(s.agents[0]);
    assert.equal(s.timers.pending(), 0, 'no timer left');
  });
}

test('after a restart the first claim number is above every number used before, also when the clock stepped back', async (t) => {
  const store = createSavedStore();
  const first = await setup(t, { store });
  await shareOn(first);
  for (let i = 0; i < 3; i += 1) {
    const job = first.host.queueJob();
    await first.drive(() => job.state === 'done', `job ${i}`);
  }
  const used = Math.max(...first.host.of('team.node.claim').map((call) => call.params.claim_seq));
  await first.sharing.stopAll();
  assert.ok(store.records.get(TEAM).claim_seq > used);
  assert.ok(store.records.get(TEAM).claim_seq <= WALL + 2 * MARK_BLOCK, 'the mark moves in blocks, not per claim');
  assert.equal(store.records.get(TEAM).on, true, 'a quit keeps the setting on');
  const second = await setup(t, { store, wall: WALL - 3_600_000 });
  second.sharing.connectionChanged(TEAM, second.manager);
  await second.drive(() => second.host.of('team.node.claim').length > 0, 'resumed at launch and claimed');
  assert.ok(second.host.of('team.node.claim')[0].params.claim_seq > used);
});

test('no prompt, reply or key in the saved record or any log line', async (t) => {
  const dir = tempProfile(t, 'jenny-team-sharing-');
  const host = keyPairFromSeed(crypto.randomBytes(32)).publicKey;
  const teamId = deriveTeamId(host);
  assert.deepEqual(saveClientFile(dir, { schema_version: 1, team_id: teamId, host_public_key: host, address_hints: ['192.0.2.7:4242'],
    last_addresses: [], member_id: 'member_abcDEF123', device_id: 'device_abcDEF123', display_name: 'Mika', joined_at: '2026-11-10T10:00:00.000Z',
    state_seen: 'active' }), { ok: true });
  const clientBefore = fs.readFileSync(clientFilePath(dir, teamId));
  const s = await setup(t, { userDataPath: dir, key: ENGINE_KEY, load: loadSharing, save: saveSharing });
  s.engine.handle = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(Buffer.concat([sse(`reply ${MARKER}`), DONE])); };
  await shareOn(s, teamId);
  const job = s.host.queueJob(requestBody(MARKER));
  await s.drive(() => job.state === 'done', 'job done');
  assert.equal(s.engine.chats()[0].headers.authorization, `Bearer ${ENGINE_KEY}`, 'the key goes to the engine only');
  await s.sharing.stopAll();
  assert.deepEqual(fs.readFileSync(clientFilePath(dir, teamId)), clientBefore, 'the client file an older Jenny reads is untouched');
  const saved = fs.readFileSync(sharingFilePath(dir, teamId), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['claim_seq', 'on', 'schema_version']);
  for (const secret of [MARKER, ENGINE_KEY, TOKEN, 'reply']) {
    assert.equal(saved.includes(secret), false, `${secret} is not saved`);
    assert.equal(s.logs.text().includes(secret), false, `${secret} is not logged`);
  }
});

// ------------------------------------------------------------ fix round (slice 4e review)

const events = (s, name) => s.logs.lines.filter((line) => line.event === name);

test('fix 2: the team going offline while sharing is its own state, with the team’s connection word', async (t) => {
  const s = await setup(t);
  await shareOn(s);
  s.manager.row.state = 'reconnecting';
  s.sharing.connectionChanged(TEAM, s.manager);
  await s.timers.advance(1000);
  assert.deepEqual([stateOf(s), s.sharing.snapshot().connection], ['team_offline', 'reconnecting']);
  s.manager.row.state = 'online';
  s.sharing.connectionChanged(TEAM, s.manager);
  await s.drive(() => stateOf(s) === 'idle', 'idle again once online');
});

test('fix 2: a host with no pool yet is a state of its own, retried at the agent’s pace and not logged each time', async (t) => {
  const s = await setup(t);
  s.host.script['team.node.register'] = Array.from({ length: 40 }, () => failure('CMP-HOST-0005', 'team_pool_unavailable'));
  s.sharing.connectionChanged(TEAM, s.manager);
  await s.sharing.set(TEAM, true, { confirmed: true });
  await s.drive(() => stateOf(s) === 'host_not_ready', 'host_not_ready');
  await s.timers.advance(10 * 60_000);
  const tries = s.host.of('team.node.register').length;
  assert.ok(tries >= 8 && tries <= 20, `retried at a backoff up to 60 s (${tries})`);
  assert.ok(events(s, 'team.node.register_retry').length <= 1, 'one line for the streak');
  assert.equal(stateOf(s), 'host_not_ready');
});

test('fix 4: a mark that cannot be saved backs off to a minute, logs once and never claims', async (t) => {
  const store = createSavedStore();
  let saves = 0;
  const save = (dir, teamId, value) => { saves += 1; return saves === 1 ? store.save(dir, teamId, value) : { ok: false, reason: 'team_client_write_failed' }; };
  const s = await setup(t, { store, save });
  s.sharing.connectionChanged(TEAM, s.manager);
  assert.equal((await s.sharing.set(TEAM, true, { confirmed: true })).ok, true);
  await s.timers.advance(5 * 60_000);
  assert.ok(saves >= 5 && saves <= 12, `backed off (${saves} tries in 5 minutes)`);
  assert.equal(events(s, 'team.sharing.save_failed').length, 1);
  assert.equal(s.host.of('team.node.register').length, 0, 'nothing registers without the mark on disk');
});

test('fix 4 and 20: the mark moves ahead before the claim number reaches it; a failed move stops claiming at the saved mark', async (t) => {
  const store = createSavedStore();
  let failing = false;
  const save = (dir, teamId, value) => (failing && value.on ? { ok: false, reason: 'team_client_write_failed' } : store.save(dir, teamId, value));
  const s = await setup(t, { store, save, options: { markBlock: 20, markMargin: 8 } });
  await shareOn(s);
  const first = store.records.get(TEAM).claim_seq;
  for (let i = 0; i < 14; i += 1) { const job = s.host.queueJob(); await s.drive(() => job.state === 'done', `job ${i}`); }
  assert.ok(store.records.get(TEAM).claim_seq > first, 'the mark moved');
  failing = true;
  for (let i = 0; i < 40 && s.sharing.resources().agents === 1; i += 1) { s.host.queueJob(); await s.timers.advance(2000); }
  const used = Math.max(...s.host.of('team.node.claim').map((call) => call.params.claim_seq));
  assert.ok(used < store.records.get(TEAM).claim_seq, 'never a claim number at or past the saved mark');
});

test('fix 5: a look that throws is caught and the next one still runs', async (t) => {
  let throws = 0;
  const s = await setup(t, { hook: (agent) => ({ ...agent, status: () => { if (throws === 1) { throws = 2; throw new Error('boom'); } return agent.status(); } }) });
  await shareOn(s);
  throws = 1;
  await s.timers.advance(3000);
  assert.equal(throws, 2);
  s.busy.on = true;
  await s.drive(() => stateOf(s) === 'busy_own', 'still looked at');
});

test('fix 10: two teams saved as on: the first online shares and the other’s flag is cleared', async (t) => {
  const store = createSavedStore({ [TEAM]: { on: true, claim_seq: 5 }, [OTHER]: { on: true, claim_seq: 5 } });
  const s = await setup(t, { store });
  s.sharing.connectionChanged(TEAM, s.manager);
  await s.drive(() => stateOf(s) === 'idle', 'the first team shares');
  s.sharing.connectionChanged(OTHER, createManager(s.bridge));
  await s.timers.advance(1000);
  assert.deepEqual([store.records.get(TEAM).on, store.records.get(OTHER).on], [true, false]);
});

test('fix 11 and 20: Stop now in the stop-after-it window ends the request; turning on again there keeps sharing', async (t) => {
  const s = await setup(t);
  await shareOn(s);
  let held = holdEngine(s.engine);
  let job = s.host.queueJob();
  await s.drive(() => held.length === 1, 'forwarding');
  await s.sharing.set(TEAM, false);
  assert.equal((await s.sharing.set(TEAM, true)).ok, true, 'turned on again in the window');
  held[0].end(Buffer.concat([sse('rest'), DONE]));
  await s.drive(() => job.state === 'done', 'finished');
  await s.drive(() => stateOf(s) === 'idle', 'still sharing');
  assert.equal(s.host.of('team.node.unregister').length, 0);
  held = holdEngine(s.engine);
  job = s.host.queueJob();
  await s.drive(() => held.length === 1, 'forwarding again');
  await s.sharing.set(TEAM, false);
  await s.sharing.stopNow(TEAM);
  await s.drive(() => s.host.of('team.node.unregister').length === 1, 'stopped at once', 250, 20);
  assert.equal(job.state, 'failed');
});

for (const word of ['role_forbidden', 'member_revoked', 'member_pending']) {
  test(`fix 20: a final refusal (${word}) turns the setting off; nothing registers again`, async (t) => {
    const s = await setup(t);
    s.host.script['team.node.register'] = [failure('CMP-HOST-0003', word)];
    s.sharing.connectionChanged(TEAM, s.manager);
    await s.sharing.set(TEAM, true, { confirmed: true });
    await s.drive(() => s.sharing.snapshot() === null, 'off');
    await s.timers.advance(30_000);
    assert.deepEqual([s.store.records.get(TEAM).on, s.host.of('team.node.register').length], [false, 1]);
  });
}

test('fix 20: update_required ends sharing and turns the setting off', async (t) => {
  const s = await setup(t);
  await shareOn(s);
  s.manager.row.state = 'update_required';
  s.sharing.connectionChanged(TEAM, s.manager);
  await s.drive(() => s.sharing.resources().agents === 0 && s.sharing.resources().ending === 0, 'ended');
  assert.deepEqual([s.sharing.snapshot(), s.store.records.get(TEAM).on], [null, false]);
});

test('fix 1: a request that names a cloud model is never forwarded, whatever the engine', async (t) => {
  const s = await setup(t, { models: ['alpha', 'gpt-oss:120b-cloud'] });
  await shareOn(s);
  assert.deepEqual(s.sharing.snapshot().models, ['alpha'], 'the cloud model is not offered');
  const named = s.host.queueJob(Buffer.from(JSON.stringify({ model: 'gpt-oss:120b-cloud', stream: true, messages: [] })));
  await s.drive(() => named.state === 'failed', 'refused (body)');
  const described = s.host.queueJob(requestBody(), { model: 'qwen3:cloud' });
  await s.drive(() => described.state === 'failed', 'refused (descriptor)');
  assert.equal(s.engine.chats().length, 0, 'nothing reached the engine');
});

test('fix 19: the registration’s own-work check makes busy_own', async (t) => {
  const { sharingIsBusy } = require('../services/main/team-registration');
  const backend = { activeStreams: new Map() };
  const s = await setup(t, { options: { isBusy: sharingIsBusy(backend) } });
  await shareOn(s);
  backend.activeStreams.set('chat', {});
  await s.drive(() => stateOf(s) === 'busy_own', 'busy_own');
});

test('fix 17: an engine with no model is no_model; a moved engine restarts the agent; an address that is not local is not tried again', async (t) => {
  const s = await setup(t, { models: [] });
  s.sharing.connectionChanged(TEAM, s.manager);
  await s.sharing.set(TEAM, true, { confirmed: true });
  await s.drive(() => stateOf(s) === 'no_model', 'no_model from the engine’s reason');
  const other = await startEngine(t, { models: ['beta'] });
  s.engineState.value = { url: other.url, kind: 'llama-server', key: '' };
  await s.drive(() => stateOf(s) === 'idle', 'the moved engine shares');
  assert.deepEqual(s.sharing.snapshot().models, ['beta']);
  const agents = s.agents.length;
  const third = await startEngine(t, { models: ['gamma'] });
  s.engineState.value = { url: third.url, kind: 'llama-server', key: '' };
  await s.drive(() => s.agents.length > agents && stateOf(s) === 'idle', 'restarted on the engine it moved to');
  assert.deepEqual(s.sharing.snapshot().models, ['gamma']);
  assert.ok(s.host.of('team.node.unregister').length >= 1, 'the old agent let go first');
  const remote = s.agents.length;
  s.engineState.value = { url: 'http://192.0.2.10:8080/v1', kind: 'local', key: '' };
  await s.drive(() => stateOf(s) === 'no_model', 'not local: offers nothing');
  await s.timers.advance(30_000);
  assert.ok(s.agents.length <= remote + 1, 'the refused address is not tried again');
  s.engineState.value = { url: other.url, kind: 'llama-server', key: '' };
  await s.drive(() => stateOf(s) === 'idle', 'a new address is tried');
});

test('fix 3: the sharing file is its own; a bad one reads as not sharing and is logged once; a removed team is never written', async (t) => {
  const dir = tempProfile(t, 'jenny-team-sharing-file-');
  assert.deepEqual(saveSharing(dir, TEAM, { on: true, claim_seq: 5 }), { ok: false, reason: 'team_client_missing' }, 'no team directory: nothing created');
  assert.equal(fs.existsSync(sharingFilePath(dir, TEAM)), false);
  fs.mkdirSync(require('node:path').dirname(sharingFilePath(dir, TEAM)), { recursive: true });
  assert.deepEqual(loadSharing(dir, TEAM), { ok: true, on: false, claim_seq: 0 }, 'nothing saved yet');
  assert.deepEqual(saveSharing(dir, TEAM, { on: true, claim_seq: 5 }), { ok: true });
  assert.deepEqual(loadSharing(dir, TEAM), { ok: true, on: true, claim_seq: 5 });
  for (const bad of ['{', '{"schema_version":2,"on":true,"claim_seq":5}', '{"schema_version":1,"on":"yes","claim_seq":5}',
    '{"schema_version":1,"on":true,"claim_seq":-1}', '{"schema_version":1,"on":true,"claim_seq":5,"url":"x"}']) {
    fs.writeFileSync(sharingFilePath(dir, TEAM), bad);
    assert.deepEqual(loadSharing(dir, TEAM), { ok: true, on: false, claim_seq: 0, bad: true }, bad);
  }
  const s = await setup(t, { userDataPath: dir, load: loadSharing, save: saveSharing });
  s.sharing.connectionChanged(TEAM, s.manager);
  s.sharing.drop(TEAM);
  s.sharing.connectionChanged(TEAM, s.manager);
  await s.timers.advance(2000);
  assert.equal(s.sharing.snapshot(), null, 'not sharing');
  assert.equal(events(s, 'team.sharing.file_refused').length, 1, 'logged once a run');
});
