'use strict';

// Settings › Runs reads one snapshot shape: every unfinished item plus today's
// finished ones, grouped, in created_at order, with no revision-bound cursor.
const assert = require('node:assert/strict');
const test = require('node:test');

const { RuntimeApplicationService } = require('../../services/session-runtime/application-service');
const { RuntimeLaneAdmission } = require('../../services/session-runtime/lanes');
const { ResourceBroker } = require('../../services/session-runtime/resource-broker');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { DEFAULT_SESSION_RUNTIME } = require('../../services/shell-config-session-runtime');
const { cleanupTrackedResources, createTrackedTempDir } = require('../helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function idFactory() {
  let sequence = 0;
  return prefix => `${prefix}_${++sequence}`;
}

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 10, 12, 0, tick++));
}

function authority(projectId, suffix) {
  return { project_id: projectId, root_path: `G:\\private-${suffix}`, root_id: `root_${suffix}`,
    root_revision: 1, device_id: `device_${suffix}`, inode: `inode_${suffix}` };
}

function submit(store, suffix, { projectId = 'project_a', sessionId = `session_${suffix}`, route = 'local' } = {}) {
  return store.submit({
    idempotencyKey: `key_${suffix}`, projectId, sessionId, purpose: 'chat',
    input: { schema_version: 1, kind: 'immediate_chat',
      route: { resource_class: route, provider_id: route === 'local' ? 'ollama' : 'openai' },
      request: { prompt: `Prompt ${suffix}`, visiblePrompt: `Visible ${suffix}` } },
    authority: authority(projectId, suffix), workId: `work_${suffix}`, turnId: `turn_${suffix}`,
  }).record;
}

const ATTEMPT = Object.freeze({ attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
  authority_revision: 'authority_1' });

function runtimeFor(store, { enabled = true } = {}) {
  const lanes = new RuntimeLaneAdmission({ limits: DEFAULT_SESSION_RUNTIME, maxRunnableTurns: 3,
    maxInferenceRequests: 5, createId: () => 'lane_lease' });
  const resourceBroker = new ResourceBroker({ limits: DEFAULT_SESSION_RUNTIME.resources,
    createId: () => 'resource_lease', now: () => 10 });
  return { store, lanes, resourceBroker, scheduler: { enabled, closing: false } };
}

function setup() {
  const store = new RuntimeStore(createTrackedTempDir('jenny-runtime-runs-'), { createId: idFactory(), now: clock() });
  const runtime = runtimeFor(store);
  return { store, runtime, service: new RuntimeApplicationService({ getRuntime: () => runtime }) };
}

test('the runs view groups items in created_at order and keeps that order across transitions', () => {
  const { store, service } = setup();
  const first = submit(store, '1');
  const second = submit(store, '2');
  const third = submit(store, '3', { route: 'cloud' });
  const fourth = submit(store, '4');
  store.transition(first.work_id, { expectedRevision: first.revision, to: 'running', reason: 'test',
    attempt: ATTEMPT });
  store.transition(fourth.work_id, { expectedRevision: fourth.revision, to: 'paused', reason: 'test' });

  const result = service.getSnapshot({ view: 'runs', limit: 100, finished_since: '2026-09-10T00:00:00.000Z' });
  assert.equal(result.ok, true);
  assert.equal(result.view, 'runs');
  assert.equal(result.next_cursor, null);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.work.map(item => [item.work_id, item.group]), [
    ['work_1', 'running'], ['work_2', 'waiting'], ['work_3', 'waiting'], ['work_4', 'needs_you']]);
  // Queue place is per lane: work_3 is the first cloud item even though it was submitted third.
  assert.equal(result.work.find(item => item.work_id === second.work_id).queue_position, 1);
  assert.equal(result.work.find(item => item.work_id === third.work_id).queue_position, 1);
  assert.equal(result.work.find(item => item.work_id === first.work_id).queue_position, null);
  for (const item of result.work) {
    assert.equal(item.session_id, `session_${item.work_id.slice(5)}`);
    assert.equal(item.purpose, 'chat');
    assert.ok(item.created_at && item.updated_at && item.turn_id);
    assert.equal('input' in item, false, 'rows never carry submitted input');
  }
  assert.deepEqual(result.limit_defaults.defaults, DEFAULT_SESSION_RUNTIME);
  assert.deepEqual(result.limit_defaults.ranges.descendants, { min: 0, max: 512 });
  assert.deepEqual(result.limit_defaults.ranges.runnable_turns, { min: 1, max: 16 });

  // A transition bumps the index revision; the view has no cursor to go stale
  // and every row keeps its place.
  const running = store.get(first.work_id);
  store.transition(first.work_id, { expectedRevision: running.revision, to: 'completed', reason: 'test',
    expectedAttempt: running.attempt });
  const after = service.getSnapshot({ view: 'runs', limit: 100, finished_since: '2026-09-10T00:00:00.000Z' });
  assert.equal(after.ok, true);
  assert.deepEqual(after.work.map(item => item.work_id), ['work_2', 'work_3', 'work_4', 'work_1']);
  assert.equal(after.work.at(-1).group, 'finished');
});

test('finished items outside the window stay out; recovery and control kinds reach the row', () => {
  const { store, service } = setup();
  const done = submit(store, '1');
  store.transition(done.work_id, { expectedRevision: done.revision, to: 'cancelled', reason: 'test' });
  let paused = submit(store, '2');
  paused = store.transition(paused.work_id, { expectedRevision: paused.revision, to: 'running', reason: 'test',
    attempt: ATTEMPT }).record;
  store.requestPause(paused.work_id, { expectedRevision: paused.revision, expectedAttempt: ATTEMPT, reason: 'test' });

  const tomorrow = service.getSnapshot({ view: 'runs', finished_since: '2026-09-11T00:00:00.000Z' });
  assert.deepEqual(tomorrow.work.map(item => item.work_id), ['work_2']);
  const row = tomorrow.work[0];
  // Pause requested is not paused: the row stays running and names the request.
  assert.equal(row.group, 'running');
  assert.equal(row.control_kind, 'pause');
  assert.equal(row.recovery_kind, null);
  const today = service.getSnapshot({ view: 'runs', finished_since: '2026-09-10T00:00:00.000Z' });
  assert.deepEqual(today.work.map(item => [item.work_id, item.group]), [['work_2', row.group], ['work_1', 'finished']]);
  const none = service.getSnapshot({ view: 'runs' });
  assert.deepEqual(none.work.map(item => item.work_id), ['work_2'], 'no window means no finished rows');
});

test('the runs view filters by project and refuses cursor, session and stray window requests', () => {
  const { store, service } = setup();
  submit(store, '1', { projectId: 'project_a' });
  submit(store, '2', { projectId: 'project_b' });
  assert.deepEqual(service.getSnapshot({ view: 'runs', project_id: 'project_b' }).work.map(item => item.work_id), ['work_2']);
  assert.equal(service.getSnapshot({ view: 'runs', cursor: 'abc' }).ok, false);
  assert.equal(service.getSnapshot({ view: 'runs', session_id: 'session_1' }).ok, false);
  assert.equal(service.getSnapshot({ finished_since: '2026-09-10T00:00:00.000Z' }).ok, false);
  assert.equal(service.getSnapshot({ view: 'runs', finished_since: 'yesterday' }).ok, false);
  assert.equal(service.getSnapshot({ view: 'list' }).ok, false);
  // The paged snapshot keeps its exact shape.
  const paged = service.getSnapshot({ limit: 10 });
  assert.equal(paged.ok, true);
  assert.equal('view' in paged, false);
  assert.equal('limit_defaults' in paged, false);
});

test('the runs view caps rows and says so; unfinished work wins the slots', () => {
  const { store, service } = setup();
  const done = submit(store, '1');
  store.transition(done.work_id, { expectedRevision: done.revision, to: 'cancelled', reason: 'test' });
  submit(store, '2');
  submit(store, '3');
  const result = service.getSnapshot({ view: 'runs', limit: 2, finished_since: '2026-09-10T00:00:00.000Z' });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.work.map(item => item.work_id), ['work_2', 'work_3']);
});

test('runs rows project the scheduler admission wait', () => {
  const { store, runtime, service } = setup();
  const work = submit(store, '1');
  runtime.scheduler.admissionWait = workId => workId === work.work_id
    ? { reason: 'model_busy', since: Date.UTC(2026, 8, 10, 12, 30), blocking_session_id: 'session_other' }
    : null;
  const row = service.getSnapshot({ view: 'runs' }).work[0];
  assert.deepEqual(row.admission_wait, { reason: 'model_busy', since: '2026-09-10T12:30:00.000Z',
    blocking_session_id: 'session_other' });
});

test('inspection pre-fills the instructions of editable work and nothing else', () => {
  const { store, service } = setup();
  const work = submit(store, '1');
  const detail = service.getWork({ work_id: work.work_id });
  assert.equal(detail.ok, true);
  assert.equal(detail.coordination.editable, true);
  assert.equal(detail.coordination.prompt, 'Visible 1');
  store.transition(work.work_id, { expectedRevision: work.revision, to: 'cancelled', reason: 'test' });
  const finished = service.getWork({ work_id: work.work_id });
  assert.equal(finished.coordination.editable, false);
  assert.equal('prompt' in finished.coordination, false);
});

test('the runs request crosses the trusted desktop bridge unchanged, end to end', async () => {
  const { createJennyShellBridge } = require('../../services/ipc-contract');
  const { registerSessionRuntimeIpcHandlers } = require('../../services/main/session-runtime-ipc-registration');
  const { store, service } = setup();
  submit(store, '1');
  const handlers = new Map();
  registerSessionRuntimeIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    applicationService: {}, runtimeApplicationService: service,
    authorization: { authorize: event => event?.trusted === true, unauthorizedResult: () => ({ ok: false }) },
  });
  const bridge = createJennyShellBridge({ ipcRenderer: {
    invoke: (channel, ...args) => handlers.get(channel)({ trusted: true }, ...args), send() {} } });
  const result = await bridge.sessionRuntime.getSnapshot({ view: 'runs', limit: 100, finished_since: '2026-09-10T00:00:00.000Z' });
  assert.equal(result.ok, true);
  assert.equal(result.view, 'runs');
  assert.deepEqual(result.work.map(item => [item.work_id, item.group, item.queue_position]), [['work_1', 'waiting', 1]]);
});

test('runs scopes projects before limiting an inventory larger than 100 rows', () => {
  const { store, service } = setup();
  for (let i = 0; i < 101; i++) submit(store, String(i), { projectId: i === 100 ? 'project_b' : 'project_a' });
  assert.deepEqual(service.getSnapshot({ view: 'runs', project_id: 'project_b', limit: 1 }).work.map(row => row.work_id), ['work_100']);
});
