'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { SessionExecutionAuthority } = require('../../services/backend/session-execution-authority');
const { SessionRuntimeChatAdapter } = require('../../services/backend/session-runtime-chat-adapter');
const { retainManagedRuntimeController } = require('../../services/backend/chat-lifecycle-contracts');
const { ensureSessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const { RuntimeLaneAdmission } = require('../../services/session-runtime/lanes');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');
const { ResourceBroker, capacityResource } = require('../../services/session-runtime/resource-broker');
const { managedModelKey } = require('../../services/shell-config-engines');
const { createAdapterHarness, request } = require('../helpers/session-runtime-chat-adapter-harness');

// A managed id routes to openai-compatible only when it is loadable: an
// enabled managed entry, an artifact with a NInfer manager, or an alias the
// llama-server is serving right now (gate F27, Astra pass).
for (const [kind, forced, hinted, expected] of [
  ['llama-server', '', '', 'openai-compatible'],
  ['llama-server', 'ollama', '', 'ollama'],
  ['llama-server', '', 'ollama', 'ollama'],
  ['ninfer', '', '', 'openai-compatible'],
  ['ninfer-no-manager', '', '', 'ollama'],
  ['live-alias', '', '', 'openai-compatible'],
  ['stale-alias', '', '', 'ollama'],
  ['', '', 'ollama', 'ollama'],
]) {
  test(`runtime engine selection: ${kind || 'unmanaged'}, forced=${forced}, hint=${hinted}`, async t => {
    const { adapter, service, sessionId } = createAdapterHarness(t);
    const model = 'qwen3.8-27b-ud-q6_k';
    service.currentEngineType = 'ollama';
    service._modelEngineHints = new Map(hinted ? [[model, hinted]] : []);
    service.configService.getLocalEngines = () => ({ openaiCompatible: { managed: {
      enabled: kind === 'llama-server',
      perModel: kind === 'llama-server' ? { [managedModelKey(model)]: { engine: kind } } : {},
    } } });
    if (kind.startsWith('ninfer')) service.ninferRuntime = { artifacts: { artifacts: [{ id: model, model_id: model }] } };
    if (kind === 'ninfer') service.options = { getNinferManager: () => ({}) };
    if (kind.endsWith('-alias')) {
      const state = kind === 'live-alias' ? 'ready' : 'stopped';
      service.options = { getLlamaServerManager: () => ({ getStatus: () => ({ state, alias: model }) }) };
    }
    const prepared = await adapter.prepareImmediate(request(sessionId, {
      runtimePreferredModel: model, runtimePreferredEngineType: forced,
    }), {}, { workId: 'work_engine', turnId: 'turn_engine' });
    try {
      assert.equal(prepared.route.engine_type, expected);
      assert.equal(prepared.request.runtimePreferredEngineType, expected);
      assert.equal(prepared.input.request.runtimePreferredEngineType, expected);
    } finally {
      adapter.discard(prepared);
    }
  });
}

test('immediate runtime preflight reads session metadata without hydrating canonical history', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-preflight-'));
  const sessionStore = new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 });
  t.after(() => { sessionStore.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const sessionId = sessionStore.createSession({ title: 'Preflight summary' }).id;
  const authority = Object.freeze({ project_id: 'project_general', root_path: null,
    root_id: null, root_revision: 0, device_id: null, inode: null });
  const projectAuthority = { captureSession: () => authority, requireCurrent: () => authority };
  const sessionExecutionAuthority = new SessionExecutionAuthority({
    projectAuthority,
    permissionStore: { getSnapshot: () => ({ version: 3, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ tools_knowledge_enabled: false, knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  let hydrated = 0;
  sessionStore.getSession = () => { hydrated += 1; throw new Error('canonical history hydrated'); };
  const service = { activeStreams: new Map(), currentEngineType: 'mock', projectAuthority,
    sessionExecutionAuthority, sessionStore, featureFlags: {},
    configService: { getState: () => ({}) } };
  const adapter = new SessionRuntimeChatAdapter(service, {
    lanes: new RuntimeLaneAdmission(), resourceBroker: new ResourceBroker(),
    pathResolver: new PhysicalPathResolver(),
  });

  const prepared = await adapter.prepareImmediate({ sessionId, prompt: 'hello',
    visiblePrompt: 'hello', attachments: [], runtimePreferredModel: 'fixture-model',
    runtimePreferredEngineType: 'mock', normalizedInteractiveResponse: null,
    normalizedPreferences: { preferred_model: 'fixture-model', plan_mode: false },
    toolPreferences: null }, {}, { workId: 'work_preflight', turnId: 'turn_preflight' });

  assert.equal(hydrated, 0);
  assert.equal(prepared.sessionId, sessionId);
  assert.equal(adapter.discard(prepared), true);
});

test('paused managed completion preserves the private resource descriptor references', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-wait-forward-'));
  const sessionStore = new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 });
  t.after(() => { sessionStore.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const sessionId = sessionStore.createSession({ title: 'Wait forwarding' }).id;
  const authority = Object.freeze({ project_id: 'project_general', root_path: null,
    root_id: null, root_revision: 0, device_id: null, inode: null });
  const projectAuthority = { captureSession: () => authority, requireCurrent: () => authority };
  const sessionExecutionAuthority = new SessionExecutionAuthority({ projectAuthority,
    permissionStore: { getSnapshot: () => ({ version: 3, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}) });
  const service = { activeStreams: new Map(), currentEngineType: 'mock', projectAuthority,
    sessionExecutionAuthority, sessionStore, featureFlags: {},
    configService: { getState: () => ({}) } };
  const adapter = new SessionRuntimeChatAdapter(service, { lanes: new RuntimeLaneAdmission(),
    resourceBroker: new ResourceBroker(), pathResolver: new PhysicalPathResolver() });
  const prepared = await adapter.prepareImmediate({ sessionId, prompt: 'hello', visiblePrompt: 'hello',
    attachments: [], runtimePreferredModel: 'fixture-model', runtimePreferredEngineType: 'mock',
    normalizedInteractiveResponse: null, normalizedPreferences: { plan_mode: false },
    toolPreferences: null }, {}, { workId: 'work_wait', turnId: 'turn_wait' });
  adapter.register(prepared.workId, prepared);
  const pending = { work_id: prepared.workId, turn_id: prepared.turnId, session_id: sessionId,
    project_id: authority.project_id, input: prepared.input };
  const claim = adapter.claimCanonical(pending, prepared.route);
  const work = { ...pending, attempt: { attempt_id: 'attempt_wait', stream_id: claim.streamId,
    incarnation: 'host_wait', authority_revision: claim.authorityRevision } };
  const waitResources = Object.freeze([capacityResource('tests')]);
  service._startManagedSidecarChatStream = async options => {
    const controller = new AbortController();
    service.sessionTurnActors.attachController(options.turnLease, controller);
    controller._runtimeCompletion = Promise.resolve({ status: 'paused', producerSettled: true,
      canonicalSettled: true, checkpointSettled: true, checkpointRef: { source_attempt: work.attempt },
      waitResources });
    const started = retainManagedRuntimeController({ sessionId, streamId: claim.streamId }, controller);
    service.sessionTurnActors.release(options.turnLease, { status: 'completed' });
    return started;
  };

  const outcome = await adapter.startProducer({ work, route: prepared.route,
    assertCurrent: claim.assertCurrent });
  assert.equal(outcome.status, 'paused');
  assert.equal(outcome.waitResources, waitResources);
});

test('resume preflight rejection remains a scheduler outcome without an unhandled barrier rejection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-resume-rejection-'));
  const sessionStore = new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 });
  t.after(() => { sessionStore.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const sessionId = sessionStore.createSession({ title: 'Resume rejection' }).id;
  const authority = Object.freeze({ project_id: 'project_general', root_path: null,
    root_id: null, root_revision: 0, device_id: null, inode: null });
  const projectAuthority = { captureSession: () => authority, requireCurrent: () => authority };
  const sessionExecutionAuthority = new SessionExecutionAuthority({ projectAuthority,
    permissionStore: { getSnapshot: () => ({ version: 3, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}) });
  const service = { activeStreams: new Map(), currentEngineType: 'mock', projectAuthority,
    sessionExecutionAuthority, sessionStore, featureFlags: {},
    configService: { getState: () => ({}) } };
  const adapter = new SessionRuntimeChatAdapter(service, { lanes: new RuntimeLaneAdmission(),
    resourceBroker: new ResourceBroker(), pathResolver: new PhysicalPathResolver() });
  const initial = await adapter.prepareImmediate({ sessionId, prompt: 'hello', visiblePrompt: 'hello',
    attachments: [], runtimePreferredModel: 'fixture-model', runtimePreferredEngineType: 'mock',
    normalizedInteractiveResponse: null, normalizedPreferences: { plan_mode: false },
    toolPreferences: null }, {}, { workId: 'work_reject', turnId: 'turn_reject' });
  adapter.discard(initial);
  const attempt = { attempt_id: 'attempt_reject', stream_id: 'stream_reject',
    incarnation: 'host_reject', authority_revision: 'authority_reject' };
  const paused = { work_id: initial.workId, turn_id: initial.turnId, session_id: sessionId,
    project_id: authority.project_id, status: 'paused', revision: 4, authority,
    input: initial.input, attempt, checkpoint_ref: { source_attempt: attempt } };
  const prepared = adapter.prepareResume(paused, { getCurrentWork: () => paused });
  adapter.register(paused.work_id, prepared);
  prepared.lease = ensureSessionTurnActorRegistry(service).reserveStart({ sessionId,
    store: sessionStore, activeStreams: service.activeStreams,
    logicalTurnId: paused.turn_id, prompt: 'hello', path: 'managed' });
  const unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  t.after(() => process.removeListener('unhandledRejection', listener));

  const outcome = await adapter.startProducer({ work: { ...paused, status: 'running' },
    route: prepared.route, assertCurrent: () => { throw new Error('injected authority failure'); } });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(outcome, { status: 'failed', producerSettled: true, canonicalSettled: true });
  assert.deepEqual(unhandled, []);
});
