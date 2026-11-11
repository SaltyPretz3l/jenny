'use strict';

// Owner decision E19 (slice 1f-2): a team host needs no model endpoint until
// Phase 4. A team config without `model_endpoint` starts a host that reaches
// `ready`, composes the real hosted backend with no sidecar it could spawn,
// answers a chat with the existing "unavailable" failure at once, and stops with
// the profile lock released. The single-owner host still requires an endpoint.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createHostedBackend } = require('../../services/host/service-composition');
const { createTeamHostFixture } = require('./helpers/team-host-fixture');

const BOOT_FIELDS = Object.freeze({ api_version: 1 });

// A sidecar manager that records any attempt to start: none may reach it.
class SpawnRecorder extends EventEmitter {
  constructor() { super(); this.process = null; this.isStopping = false; this.calls = []; }
  getStatus() { return { phase: 'stopped' }; }
  async start() { this.calls.push('start'); return { phase: 'ready' }; }
  async retryStart() { this.calls.push('retryStart'); return { phase: 'ready' }; }
  async stop() { this.calls.push('stop'); return { exitConfirmed: true, forced: false }; }
}

function realBackendFixture(t) {
  const fx = createTeamHostFixture(t);
  fx.writeConfig({ extra: { model_endpoint: undefined } });
  const recorder = new SpawnRecorder();
  const built = [];
  const createBackend = (options) => {
    const composition = createHostedBackend({ ...options, sidecarManager: recorder,
      repoRoot: path.resolve(__dirname, '../..') });
    built.push({ options, composition });
    return composition;
  };
  return { fx, recorder, built, createBackend };
}

test('E19: a team host with no model endpoint reaches ready and spawns no sidecar', async (t) => {
  const { fx, recorder, built, createBackend } = realBackendFixture(t);
  const seeded = await fx.seedMembers(fx.client().deviceKey);
  const parent = fx.newParent();
  const host = await fx.start(parent, { createBackend });
  assert.deepEqual(parent.sentTypes(), ['ready']);
  const [{ options, composition }] = built;
  assert.equal(options.modelEndpoint, null);
  assert.equal(options.modelOptional, true, 'host-core opts in from the team config');
  assert.notEqual(composition.backend.sidecarManager, recorder, 'the no-model manager replaces any other');
  assert.equal(composition.backend.sidecarManager.process, null);
  assert.ok(fx.logs.some((entry) => entry.event === 'team.host.model_none'));
  assert.equal(fx.logs.some((entry) => entry.event === 'host.model_unavailable'), false, 'no start was attempted');

  // A chat on this host: the router accepts it and its stream fails with the existing unavailable failure.
  const context = fx.context();
  const client = context.clients.register(seeded.owner.device_id);
  const actor = { member_id: seeded.owner.member_id, device_id: seeded.owner.device_id, role: 'owner', state: 'active' };
  const dispatchContext = { deviceId: actor.device_id, clientToken: client.client_token, isAuthenticated: () => true, actor };
  let sequence = 0;
  const send = (operation, params = {}, extra = {}) => context.router.dispatch({ ...BOOT_FIELDS, operation,
    request_id: `request_${++sequence}_${crypto.randomUUID()}`, client_id: client.client_id,
    boot_epoch: context.bootEpoch, params, ...extra }, dispatchContext);
  const created = await send('sessions.create', { title: 'No model' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const sessionId = created.session.session_id;
  const lease = await send('control.acquire', { takeover: false }, { session_id: sessionId });
  assert.equal(lease.ok, true, JSON.stringify(lease));
  const begun = Date.now();
  const sent = await send('chat.send', { prompt: 'hello' }, { session_id: sessionId,
    control_generation: lease.lease.generation, expected_revision: context.router.snapshot(sessionId).session.revision });
  const failure = sent.ok ? await waitForStreamFailure(composition.backend, sessionId) : sent.error;
  assert.ok(Date.now() - begun < 10_000, 'answered at once, no hang');
  // The failure a host gives when its sidecar is down; no new error code.
  assert.equal(failure.type, 'error', JSON.stringify(failure));
  assert.equal(failure.category, 'managed_sidecar');
  assert.match(failure.message, /unavailable/i);
  assert.equal(composition.backend.sidecarManager.process, null, 'still no sidecar');
  assert.deepEqual(recorder.calls, []);

  parent.emit({ type: 'stop' });
  await host.stopped;
  assert.deepEqual(parent.sentTypes(), ['ready', 'stopped']);
  assert.equal(fx.lock.released, 1, 'the profile lock is released');
});

// Waits for the session's stream to end in an error and returns it.
function waitForStreamFailure(backend, sessionId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no stream failure')), 10_000);
    const onEvent = (event) => {
      const text = JSON.stringify(event);
      if (!text.includes(sessionId) || !/error|failed/i.test(text)) return;
      clearTimeout(timer);
      backend.off('chat-stream', onEvent);
      resolve(event);
    };
    backend.on('chat-stream', onEvent);
  });
}

test('E19: a team host with a model endpoint starts its backend as before', async (t) => {
  const fx = createTeamHostFixture(t);
  const parent = fx.newParent();
  const host = await fx.start(parent);
  assert.deepEqual(fx.backends[0].calls, ['start']);
  assert.equal(fx.logs.some((entry) => entry.event === 'team.host.model_none'), false);
  parent.emit({ type: 'stop' });
  await host.stopped;
});

test('E19: host-core opts in only for a team config', (t) => {
  const { createHostCore } = require('../../server/host-core');
  const dir = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-no-model-'));
  t.after(() => require('node:fs').rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const createBackend = (options) => { seen.push(options.modelOptional); throw new Error('captured'); };
  const base = { userDataPath: dir, secretsDir: dir, modelEndpoint: null };
  for (const config of [base, { ...base, team: { name: 'T', key_source: 'parent_channel', direct_port: null } }]) {
    assert.throws(() => createHostCore({ config, createBackend, launch: { repoRoot: dir } }), /captured/);
  }
  assert.deepEqual(seen, [false, true]);
});
