'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStage7ControlPlane } = require('../../services/plugins/stage7-control-plane');

function harness(options = {}) {
  let destroyed = () => {};
  const descriptor = {
    publisher_id: 'jenny-official', plugin_id: 'fixture', contribution_id: 'artifact',
    kind: 'artifact_renderer', artifact_digest: 'a'.repeat(64), content_digest: 'b'.repeat(64),
    generation_id: 'gen-stage7', commit_epoch: 7,
    content: { entry_path: 'view/index.html', entry_sha256: 'c'.repeat(64),
      allowed_bridge_operations: ['artifact_read_chunk'], allowed_event_topics: [] },
  };
  const viewHost = {
    active: null,
    async commitGeneration() { return { ok: true }; },
    async destroyAll() {
      if (this.active) destroyed(this.active.viewInstanceId);
      this.active = null;
      return { ok: true };
    },
    async open(value, openOptions = {}) {
      this.active = { descriptor: value, options: openOptions, viewInstanceId: 'view-stage7' };
      return { ok: true, view_instance_id: 'view-stage7' };
    },
    contextForEvent(event) {
      if (!this.active || event?.sender?.id !== 42) return null;
      const activeDescriptor = this.active.descriptor;
      return { senderId: 42, origin: `jenny-plugin-view://${activeDescriptor.artifact_digest}`,
        viewInstanceId: this.active.viewInstanceId, contributionId: activeDescriptor.contribution_id,
        artifactDigest: activeDescriptor.artifact_digest, commitEpoch: activeDescriptor.commit_epoch,
        lifecycleEpoch: 0, allowedOperations: activeDescriptor.content.allowed_bridge_operations,
        allowedEventTopics: activeDescriptor.content.allowed_event_topics || [],
        sessionId: this.active.options?.sessionId || '',
        sessionIncarnation: this.active.options?.sessionIncarnation || '',
        sessionProviderAuthorized: Boolean(
          this.active.options?.sessionId && this.active.options?.sessionIncarnation),
      };
    },
    setOnViewDestroyed(callback) { destroyed = callback; },
    setBounds: () => ({ ok: true }), setZoom: () => ({ ok: true }), focus() {},
    snapshot: () => ({ active_views: 1 }), sendEvent: () => true,
  };
  const sidecar = {
    prepare: async () => ({ ok: true, commit: async () => ({ ok: true }) }),
    reconcile: async () => ({ ok: true }), getState: () => ({}), detach() {},
  };
  const control = createStage7ControlPlane({ runtimeCoordinator: sidecar, viewHost,
    pluginService: { getState: async () => options.pluginState || ({ ok: true }),
      updateSettings: async () => ({ ok: true }) },
    authorizeSessionView: options.authorizeSessionView,
    sessionProviderCall: options.sessionProviderCall,
  });
  return { control, viewHost, descriptor };
}

test('artifact chunks are authority-bound and erased on view teardown', async () => {
  const { control, viewHost, descriptor } = harness();
  const prepared = await control.runtimeCoordinator.prepare({ compiled: {
    snapshot: { runtime_schema_version: 5, active_generation_id: 'gen-stage7', commit_epoch: 7 },
    view_descriptors: [descriptor], view_assets: new Map(), provider_descriptor_values: [],
  } });
  assert.equal(prepared.ok, true);
  assert.deepEqual(await prepared.commit(), { ok: true, degraded: false });
  assert.equal((await control.openViewContribution({ publisher_id: descriptor.publisher_id,
    plugin_id: descriptor.plugin_id, contribution_id: descriptor.contribution_id,
    generation_id: descriptor.generation_id,
    artifact_payload_json: '{"private":"fixture"}' })).ok, true);

  const event = { sender: { id: 42 }, senderFrame: {
    origin: `jenny-plugin-view://${descriptor.artifact_digest}`,
  } };
  const first = await control.bridge(event, { method: 'request', request_id: 'read-one',
    operation: 'artifact_read_chunk', payload: { offset: 0 } });
  assert.equal(first.status, 'succeeded');
  const chunk = JSON.parse(first.payload_json).chunk;
  assert.equal(Buffer.from(chunk, 'base64').toString('utf8'), '{"private":"fixture"}');

  await viewHost.destroyAll();
  // Even if a stale renderer event is replayed after teardown, its payload is
  // gone before sender validation or a future view can observe it.
  viewHost.active = { descriptor, viewInstanceId: 'view-stage7-next' };
  const second = await control.bridge(event, { method: 'request', request_id: 'read-two',
    operation: 'artifact_read_chunk', payload: { offset: 0 } });
  assert.equal(second.status, 'failed');
  assert.equal(second.reason_code, 'artifact_payload_unavailable');
  await control.dispose();
});

test('artifact payload follows the successfully replaced view instance', async () => {
  const { control, viewHost, descriptor } = harness();
  let nextView = 1;
  viewHost.open = async function open(value, openOptions = {}) {
    await this.destroyAll('view_replaced');
    const viewInstanceId = `view-stage7-${nextView}`;
    nextView += 1;
    this.active = { descriptor: value, options: openOptions, viewInstanceId };
    return { ok: true, view_instance_id: viewInstanceId };
  };
  const prepared = await control.runtimeCoordinator.prepare({ compiled: {
    snapshot: { runtime_schema_version: 5, active_generation_id: 'gen-stage7', commit_epoch: 7 },
    view_descriptors: [descriptor], view_assets: new Map(), provider_descriptor_values: [],
  } });
  await prepared.commit();
  const identity = { publisher_id: descriptor.publisher_id, plugin_id: descriptor.plugin_id,
    contribution_id: descriptor.contribution_id, generation_id: descriptor.generation_id };
  assert.equal((await control.openViewContribution({ ...identity,
    artifact_payload_json: '{"payload":"first"}' })).ok, true);
  assert.equal((await control.openViewContribution({ ...identity,
    artifact_payload_json: '{"payload":"second"}' })).ok, true);

  const event = { sender: { id: 42 }, senderFrame: {
    origin: `jenny-plugin-view://${descriptor.artifact_digest}`,
  } };
  const result = await control.bridge(event, { method: 'request', request_id: 'read-replacement',
    operation: 'artifact_read_chunk', payload: { offset: 0 } });
  assert.equal(result.status, 'succeeded');
  assert.equal(Buffer.from(JSON.parse(result.payload_json).chunk, 'base64').toString('utf8'),
    '{"payload":"second"}');
  await control.dispose();
});

test('artifact payload validation rejection leaves the active view payload intact', async () => {
  const { control, viewHost, descriptor } = harness();
  const prepared = await control.runtimeCoordinator.prepare({ compiled: {
    snapshot: { runtime_schema_version: 5, active_generation_id: 'gen-stage7', commit_epoch: 7 },
    view_descriptors: [descriptor], view_assets: new Map(), provider_descriptor_values: [],
  } });
  await prepared.commit();
  const identity = { publisher_id: descriptor.publisher_id, plugin_id: descriptor.plugin_id,
    contribution_id: descriptor.contribution_id, generation_id: descriptor.generation_id };
  assert.equal((await control.openViewContribution({ ...identity,
    artifact_payload_json: '{"payload":"survives"}' })).ok, true);
  const activeViewInstanceId = viewHost.active.viewInstanceId;
  const rejected = await control.openViewContribution({ ...identity,
    artifact_payload_json: '{not-json' });
  assert.deepEqual(rejected, { ok: false, reason: 'artifact_payload_invalid' });
  assert.equal(viewHost.active.viewInstanceId, activeViewInstanceId);

  const event = { sender: { id: 42 }, senderFrame: {
    origin: `jenny-plugin-view://${descriptor.artifact_digest}`,
  } };
  const result = await control.bridge(event, { method: 'request', request_id: 'read-survivor',
    operation: 'artifact_read_chunk', payload: { offset: 0 } });
  assert.equal(result.status, 'succeeded');
  assert.equal(Buffer.from(JSON.parse(result.payload_json).chunk, 'base64').toString('utf8'),
    '{"payload":"survives"}');
  await control.dispose();
});

test('stale view identities cannot resolve a current contribution after generation change', async () => {
  const { control, descriptor } = harness();
  const prepared = await control.runtimeCoordinator.prepare({ compiled: {
    snapshot: { runtime_schema_version: 5, active_generation_id: 'gen-stage7', commit_epoch: 7 },
    view_descriptors: [descriptor], view_assets: new Map(), provider_descriptor_values: [],
  } });
  await prepared.commit();
  const result = await control.openViewContribution({ publisher_id: descriptor.publisher_id,
    plugin_id: descriptor.plugin_id, contribution_id: descriptor.contribution_id,
    generation_id: 'stale-generation' });
  assert.deepEqual(result, { ok: false, reason: 'view_contribution_not_active' });
  await control.dispose();
});

test('session views bind through core authority and expose only an authorization marker', async () => {
  const calls = [];
  const authorizeSessionView = async (sessionId, descriptor) => {
    calls.push(['authorize', sessionId, descriptor.contribution_id]);
    return { ok: true, sessionIncarnation: 'incarnation-1' };
  };
  const sessionProviderCall = async (call, context) => {
    calls.push(['call', call.action, context.sessionId, JSON.parse(call.payload_json)]);
    return { ok: true, value: { bound: true } };
  };
  const { control, viewHost, descriptor } = harness({ authorizeSessionView, sessionProviderCall });
  const panel = { ...descriptor, contribution_id: 'image_workspace', kind: 'panel',
    content: { ...descriptor.content, allowed_bridge_operations: ['get_context'] } };
  const prepared = await control.runtimeCoordinator.prepare({ compiled: {
    snapshot: { runtime_schema_version: 5, active_generation_id: 'gen-stage7', commit_epoch: 7 },
    view_descriptors: [panel], view_assets: new Map(), provider_descriptor_values: [],
  } });
  await prepared.commit();

  const opened = await control.openViewContribution({ publisher_id: panel.publisher_id,
    plugin_id: panel.plugin_id, contribution_id: panel.contribution_id,
    generation_id: panel.generation_id, sessionId: 'plugin-session' });
  assert.equal(opened.ok, true);
  assert.deepEqual(viewHost.active.options, {
    sessionId: 'plugin-session', sessionIncarnation: 'incarnation-1',
  });

  const event = { sender: { id: 42 }, senderFrame: {
    origin: `jenny-plugin-view://${panel.artifact_digest}`,
  } };
  const contextResult = await control.bridge(event, { method: 'request', request_id: 'context-one',
    operation: 'get_context', payload: {} });
  const context = JSON.parse(contextResult.payload_json);
  assert.equal(context.session_provider_authorized, true);
  assert.equal(Object.hasOwn(context, 'session_id'), false);
  assert.equal(Object.hasOwn(context, 'session_incarnation'), false);

  const providerResult = await control.bridge(event, { method: 'request', request_id: 'provider-one',
    operation: 'session_provider_call', payload: { action: 'get_context', payload: {
      session_id: 'spoofed-session',
    } } });
  assert.equal(providerResult.status, 'succeeded');
  assert.deepEqual(JSON.parse(providerResult.payload_json), { bound: true });
  assert.deepEqual(calls, [
    ['authorize', 'plugin-session', 'image_workspace'],
    ['call', 'get_context', 'plugin-session', { session_id: 'spoofed-session' }],
  ]);
  await control.dispose();
});

test('session view open fails closed without an authorizer or when authorization is denied', async () => {
  for (const options of [{}, { authorizeSessionView: async () => (
    { ok: false, reason: 'plugin_session_view_binding_mismatch' }
  ) }]) {
    const { control, descriptor } = harness(options);
    const prepared = await control.runtimeCoordinator.prepare({ compiled: {
      snapshot: { runtime_schema_version: 5, active_generation_id: 'gen-stage7', commit_epoch: 7 },
      view_descriptors: [descriptor], view_assets: new Map(), provider_descriptor_values: [],
    } });
    await prepared.commit();
    const result = await control.openViewContribution({ publisher_id: descriptor.publisher_id,
      plugin_id: descriptor.plugin_id, contribution_id: descriptor.contribution_id,
      generation_id: descriptor.generation_id, sessionId: 'plugin-session' });
    assert.equal(result.ok, false);
    await control.dispose();
  }
});

test('read_settings returns only the calling contribution settings projection', async () => {
  const pluginState = { ok: true, plugins: [{ publisher_id: 'jenny-official', plugin_id: 'fixture',
    contributions: [{ contribution_id: 'artifact', settings: { revision: 2, values: { theme: 'dark' } } },
      { contribution_id: 'other', settings: { values: { secret: 'must-not-leak' } } }] },
  { publisher_id: 'other', plugin_id: 'catalog', contributions: [{ contribution_id: 'x',
    settings: { values: { secret: 'also-hidden' } } }] }] };
  const { control, descriptor } = harness({ pluginState });
  const settingsDescriptor = { ...descriptor, content: { ...descriptor.content,
    allowed_bridge_operations: ['read_settings'] } };
  const prepared = await control.runtimeCoordinator.prepare({ compiled: {
    snapshot: { runtime_schema_version: 5, active_generation_id: 'gen-stage7', commit_epoch: 7 },
    view_descriptors: [settingsDescriptor], view_assets: new Map(), provider_descriptor_values: [],
  } });
  await prepared.commit();
  await control.openViewContribution({ publisher_id: descriptor.publisher_id,
    plugin_id: descriptor.plugin_id, contribution_id: descriptor.contribution_id,
    generation_id: descriptor.generation_id });
  const event = { sender: { id: 42 }, senderFrame: {
    origin: `jenny-plugin-view://${descriptor.artifact_digest}`,
  } };
  const result = await control.bridge(event, { method: 'request', request_id: 'settings-one',
    operation: 'read_settings', payload: {} });
  assert.equal(result.status, 'succeeded');
  const value = JSON.parse(result.payload_json);
  assert.deepEqual(value, { publisher_id: 'jenny-official', plugin_id: 'fixture',
    contribution_id: 'artifact', settings: { revision: 2, values: { theme: 'dark' } } });
  assert.equal(result.payload_json.includes('must-not-leak'), false);
  await control.dispose();
});

test('provider auth is bound to the committed official setup scene and provider ref', async () => {
  let authCalls = 0;
  let destroyed = () => {};
  const hostCommands = [];
  const setup = {
    publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription',
    contribution_id: 'chatgpt-setup', kind: 'setup_scene', artifact_digest: 'd'.repeat(64),
    generation_id: 'gen-auth', commit_epoch: 9,
    content: { entry_path: 'view/index.html', provider_ref: 'chatgpt',
      allowed_bridge_operations: ['provider_auth_status', 'provider_activate'], allowed_event_topics: [] },
  };
  const viewHost = {
    active: null,
    async commitGeneration() { return { ok: true }; },
    async destroyAll() { this.active = null; return { ok: true }; },
    async open(value) { this.active = { descriptor: value, viewInstanceId: 'view-auth' }; return { ok: true }; },
    contextForEvent(event) {
      const descriptor = this.active?.descriptor;
      if (!descriptor || event?.sender?.id !== 42) return null;
      return { senderId: 42, origin: `jenny-plugin-view://${descriptor.artifact_digest}`,
        viewInstanceId: 'view-auth', contributionId: descriptor.contribution_id,
        artifactDigest: descriptor.artifact_digest, commitEpoch: descriptor.commit_epoch,
        lifecycleEpoch: 0, allowedOperations: descriptor.content.allowed_bridge_operations,
        allowedEventTopics: descriptor.content.allowed_event_topics };
    },
    setOnViewDestroyed(callback) { destroyed = callback; },
    setBounds: () => ({ ok: true }), setZoom: () => ({ ok: true }), focus() {}, sendEvent: () => true,
    sendHostCommand: (...args) => { hostCommands.push(args); return true; },
  };
  const sidecar = { prepare: async () => ({ ok: true, commit: async () => ({ ok: true }) }),
    reconcile: async () => ({ ok: true }), getState: () => ({}), detach() {} };
  const auth = { getStatus: () => { authCalls += 1; return { state: 'signed_out' }; },
    onStatusChange: () => () => {}, cancel() {}, signOut: async () => ({ state: 'signed_out' }),
    start: async () => ({ state: 'signed_in' }) };
  const control = createStage7ControlPlane({ runtimeCoordinator: sidecar, viewHost,
    pluginService: { getState: async () => ({ ok: true, plugins: [] }), updateSettings: async () => ({ ok: true }) },
    chatgptAuthService: auth,
    activateProvider: async (providerId) => ({ ok: true, value: { provider_id: providerId } }),
  });
  const prepared = await control.runtimeCoordinator.prepare({ compiled: {
    snapshot: { runtime_schema_version: 5, active_generation_id: 'gen-auth', commit_epoch: 9 },
    view_descriptors: [setup], view_assets: new Map(),
    provider_descriptor_values: [{ provider_id: 'chatgpt' }],
  } });
  await prepared.commit();
  await control.openViewContribution({ publisher_id: setup.publisher_id, plugin_id: setup.plugin_id,
    contribution_id: setup.contribution_id, generation_id: setup.generation_id });
  const event = { sender: { id: 42 }, senderFrame: { origin: `jenny-plugin-view://${setup.artifact_digest}` } };
  const accepted = await control.bridge(event, { method: 'request', request_id: 'auth-ok',
    operation: 'provider_auth_status', payload: { provider_id: 'chatgpt' } });
  assert.equal(accepted.status, 'succeeded');
  assert.equal(authCalls, 1);
  const activated = await control.bridge(event, { method: 'request', request_id: 'activate-ok',
    operation: 'provider_activate', payload: { provider_id: 'chatgpt' } });
  assert.equal(activated.status, 'succeeded');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(hostCommands, [['provider_activated', { provider_id: 'chatgpt' }, 'view-auth']]);
  const rejected = await control.bridge(event, { method: 'request', request_id: 'auth-cross-provider',
    operation: 'provider_auth_status', payload: { provider_id: 'other' } });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.reason_code, 'provider_view_authority_rejected');
  assert.equal(authCalls, 1);
  destroyed('view-auth', 'test');
  await control.dispose();
});
