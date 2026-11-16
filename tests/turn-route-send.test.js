'use strict';

// Slice 4a-4 (T5): a host's turn route on the managed chat.send path. The sidecar
// client is a stub; the route is a fake that records each acquire and release.
// Without a route the params carry no `route_token`; with one, every chat.send of
// the turn (the first and a checkpoint resume) carries its own token, the release
// runs exactly once on every exit, and the token reaches no log, event or file.

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createManagedChatServiceStub, buildManagedChatRequest } = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { ALLOWED_NODES_PREFERENCE } = require('../services/backend/session-allowed-nodes');
const { ensureSessionTurnActorRegistry } = require('../services/backend/session-turn-actor');
const { CheckpointStore } = require('../services/session-runtime/checkpoint-store');
const { buildAdmittedContinuationContext } = require('../services/session-runtime/continuation-context');
const { captureRuntimeRoute } = require('../services/session-runtime/lanes');
const { beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization } = require('../services/session-runtime/inference-protocol');
const { stableJson } = require('../services/session-runtime/contracts');
const { hydrateRuntimeContinuation } = require('../services/backend/runtime-continuation-resume');
const { createCancellationError } = require('../services/backend/chat-stream-terminal-utils');
const { ensureSessionAttachmentAuthority } = require('../services/projects/session-attachment-authority');

const AUTHOR = Object.freeze({ kind: 'member', member_id: 'member_alice' });

function tokenOf(seed) {
  return createHash('sha256').update(seed).digest().toString('base64url');
}

// A fake turn route: hands out a fresh token per acquire unless told otherwise.
function createRoute({ acquire } = {}) {
  const route = { requests: [], releases: [], tokens: [] };
  route.acquire = async (request) => {
    route.requests.push({ ...request, signal: Boolean(request.signal) });
    if (acquire) return acquire(request, route);
    const token = tokenOf(`token-${route.requests.length}`);
    route.tokens.push(token);
    return { token, release: (outcome) => route.releases.push(outcome) };
  };
  return route;
}

function fixture(t, { turnRoute } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-turn-route-'));
  const service = createManagedChatServiceStub({ featureFlags: { canonical_bridge: false, canonical_turn_events: false } });
  service.userDataPath = root;
  service.pendingUserQuestions = new Map();
  service.sessionStore = new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 });
  if (turnRoute !== undefined) service.turnRoute = turnRoute;
  t.after(() => { service.sessionStore.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = buildManagedChatRequest();
  service.sessionStore.createSessionWithId(request.sessionId, { title: 'Turn route' });
  service.sessionStore.updateSession(request.sessionId, { preferred_model: 'alpha' });
  service.sidecarManager = { process: { pid: 4242 }, getStatus: () => ({ phase: 'ready' }) };
  service.sidecarClient = { connected: true, process: service.sidecarManager.process };
  completeRuntimeInferenceInitialization(service.sidecarClient,
    beginRuntimeInferenceInitialization(service.sidecarClient), {
      runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1, runtime_continuation_version: 1,
    });
  return { service, request, root, actor: ensureSessionTurnActorRegistry(service) };
}

async function runTurn(f, { chatSend, extra = {} } = {}) {
  const sent = [];
  f.service.sidecarClient.chatSend = async (params, options) => {
    sent.push(JSON.parse(JSON.stringify(params)));
    return chatSend ? chatSend(params, options) : { status: 'completed', response_text: 'Done.' };
  };
  const stream = await startManagedSidecarChatStream(f.service, { ...f.request, author: AUTHOR, ...extra });
  const controller = f.service.activeStreams.get(stream.streamId);
  if (controller) await controller._pendingPromise.catch(() => {});
  return { sent, stream };
}

function errorEvent(service) {
  return service.emittedEvents.find((row) => row.eventName === 'chat-stream' && row.payload?.type === 'error')?.payload || null;
}

function filesUnder(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full)); else out.push(full);
  }
  return out;
}

function assertTokenNowhere(f, token) {
  assert.equal(JSON.stringify(f.service.serviceLogs).includes(token), false, 'service log');
  assert.equal(JSON.stringify(f.service.emittedEvents).includes(token), false, 'emitted event');
  for (const file of filesUnder(f.root)) {
    assert.equal(fs.readFileSync(file, 'utf8').includes(token), false, `file ${path.relative(f.root, file)}`);
  }
}

test('with no turn route the params carry no route_token and match a service whose route is null', async (t) => {
  const absent = fixture(t);
  const nulled = fixture(t, { turnRoute: null });
  const { sent: a } = await runTurn(absent);
  const { sent: b } = await runTurn(nulled);
  assert.equal(a.length, 1);
  assert.equal(Object.hasOwn(a[0], 'route_token'), false);
  const shape = (params) => Object.keys(params).sort();
  assert.deepEqual(shape(a[0]), shape(b[0]));
  const stable = ({ request_id: _r, logical_turn_id: _l, trace_id: _t, session_incarnation: _i, execution_context: _e,
    session_start_date: _d, ...rest }) => rest;
  assert.deepEqual(stable(a[0]), stable(b[0]));
});

test('with a route the exact token rides the send, the request names the member, model and project, and release runs once', async (t) => {
  const route = createRoute();
  const f = fixture(t, { turnRoute: route });
  const { sent } = await runTurn(f);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].route_token, route.tokens[0]);
  assert.equal(route.tokens[0].length, 43);
  assert.deepEqual(route.requests, [{ sessionId: f.request.sessionId, projectId: 'project_general', memberId: 'member_alice',
    model: 'alpha', wantsVision: false, allowedNodes: null, signal: true }]);
  assert.deepEqual(route.releases, [{ ok: true }]);
  assert.equal(errorEvent(f.service), null);
  assertTokenNowhere(f, route.tokens[0]);
});

test('a turn with no author asks the route with no member id; it is never replaced by a default', async (t) => {
  const route = createRoute();
  const f = fixture(t, { turnRoute: route });
  const { sent } = await runTurn(f, { extra: { author: null } });
  assert.equal(route.requests[0].memberId, null);
  assert.equal(sent.length, 1, 'the fake route accepts it; the pool route refuses a missing member');
});

test('a thrown send releases once with ok false and keeps the token out of every record', async (t) => {
  const route = createRoute();
  const f = fixture(t, { turnRoute: route });
  const { sent } = await runTurn(f, { chatSend: async () => { throw Object.assign(new Error('engine failed'), { code: 'engine_failed' }); } });
  assert.equal(sent.length, 1);
  assert.deepEqual(route.releases, [{ ok: false }]);
  assert.ok(errorEvent(f.service));
  assertTokenNowhere(f, route.tokens[0]);
});

test('an abort during the send releases once with ok false', async (t) => {
  const route = createRoute();
  const f = fixture(t, { turnRoute: route });
  const { sent } = await runTurn(f, { chatSend: async () => {
    const controller = [...f.service.activeStreams.values()][0];
    controller.abort(createCancellationError('user'));
    throw createCancellationError('user');
  } });
  assert.equal(sent.length, 1);
  assert.deepEqual(route.releases, [{ ok: false }]);
});

test('a throw between the acquire and the send releases once with ok false and sends nothing', async (t) => {
  const route = createRoute();
  const f = fixture(t, { turnRoute: route });
  // Current until the route has been asked, stale from then on: the check after the acquire throws.
  const runtimeAssertCurrent = () => {
    if (route.requests.length > 0) throw Object.assign(new Error('work superseded'), { code: 'runtime_work_stale' });
  };
  const { sent } = await runTurn(f, { extra: { runtimeAssertCurrent } });
  assert.equal(route.requests.length, 1);
  assert.equal(sent.length, 0);
  assert.deepEqual(route.releases, [{ ok: false }]);
  assert.ok(errorEvent(f.service));
});

test('a turn with an image attachment asks the route for vision', async (t) => {
  const route = createRoute();
  const f = fixture(t, { turnRoute: route });
  const image = path.join(f.root, 'capture.png');
  fs.writeFileSync(image, Buffer.from('image-bytes'));
  f.service.attachmentAssetStore = { resolveManagedAssetRealPath: () => image };
  const attachment = { id: 'att_image', kind: 'image', assetPath: path.join(f.root, 'logical.png'),
    displayName: 'capture.png', mimeType: 'image/png' };
  const authority = ensureSessionAttachmentAuthority(f.service);
  authority.registerImportedImages(authority.captureImportScope(f.request.sessionId), [attachment]);
  const { sent } = await runTurn(f, { extra: { attachments: [attachment] } });
  assert.equal(sent.length, 1, JSON.stringify(errorEvent(f.service)));
  assert.equal(sent[0].attachments?.[0]?.kind, 'image');
  assert.equal(route.requests[0].wantsVision, true);
  assert.deepEqual(route.releases, [{ ok: true }]);
});

for (const [label, stored, expected] of [['a saved list', ['node_aaaaaaaaaaaaaaaaaaaaaa'], ['node_aaaaaaaaaaaaaaaaaaaaaa']],
  ['a damaged stored list (a restriction, never any node)', 'node_aaaaaaaaaaaaaaaaaaaaaa', []]]) {
  test(`the conversation's allowed_nodes rides the acquire: ${label}`, async (t) => {
    const route = createRoute();
    const f = fixture(t, { turnRoute: route });
    if (Array.isArray(stored)) f.service.sessionStore.setSessionPreferences(f.request.sessionId, { [ALLOWED_NODES_PREFERENCE]: stored });
    else f.service.sessionStore._updateSessionRecord(f.request.sessionId, { allowed_nodes: stored }); // as a damaged journal loads
    await runTurn(f);
    assert.deepEqual(route.requests[0].allowedNodes, expected);
  });
}

test('an acquire that resolves after the abort is released once and nothing is sent', async (t) => {
  let f;
  const route = createRoute({ acquire: async (request, self) => {
    const controller = [...f.service.activeStreams.values()][0];
    controller.abort(createCancellationError('user'));
    return { token: tokenOf('late'), release: (outcome) => self.releases.push(outcome) };
  } });
  f = fixture(t, { turnRoute: route });
  const { sent } = await runTurn(f);
  assert.equal(sent.length, 0);
  assert.deepEqual(route.releases, [{ ok: false }]);
});

test('an acquire the signal cancels sends nothing and fails nothing but the turn', async (t) => {
  let f;
  const route = createRoute({ acquire: (request) => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { reason: 'cancelled' })));
    [...f.service.activeStreams.values()][0].abort(createCancellationError('user'));
  }) });
  f = fixture(t, { turnRoute: route });
  const { sent } = await runTurn(f);
  assert.equal(sent.length, 0);
  assert.deepEqual(route.releases, []);
});

test('an acquire refusal fails the turn with its reason, keeps the user message and sends nothing', async (t) => {
  const route = createRoute({ acquire: async () => {
    throw Object.assign(new Error('no_eligible_node'), { kind: 'limit', reason: 'no_eligible_node', code: 'CMP-HOST-0007' });
  } });
  const f = fixture(t, { turnRoute: route });
  const { sent } = await runTurn(f);
  assert.equal(sent.length, 0);
  const event = errorEvent(f.service);
  assert.equal(event?.error_code, 'no_eligible_node', JSON.stringify(event));
  const rows = f.service.sessionStore.getSessionMessages(f.request.sessionId);
  assert.equal(rows.filter((row) => row.role === 'user').length, 1);
  assert.equal(rows.find((row) => row.role === 'user').content, f.request.prompt);
});

test('a malformed token sends nothing, releases once with ok false and fails with route_token_invalid', async (t) => {
  for (const token of [undefined, '', 'short', `${tokenOf('x')}=`, tokenOf('x').slice(1), 42]) {
    const releases = [];
    const route = createRoute({ acquire: async () => ({ token, release: (outcome) => releases.push(outcome) }) });
    const f = fixture(t, { turnRoute: route });
    const { sent } = await runTurn(f);
    assert.equal(sent.length, 0, String(token));
    assert.deepEqual(releases, [{ ok: false }]);
    assert.equal(errorEvent(f.service)?.error_code, 'route_token_invalid');
  }
});

// The checkpoint fixture of tests/session-runtime/managed-checkpoint-send.test.js: a first send that
// pauses at a checkpoint, then a resume that is a new attempt with its own chat.send.
function encoded(value) {
  const body = Buffer.from(stableJson(value));
  return { bytes: body.toString('base64'), sha256: createHash('sha256').update(body).digest('hex') };
}

function publishFromProvider(params, options) {
  const call = { call_id: 'call_1', tool_id: 'read_file', arguments: { path: 'README.md' },
    idempotency_key: '', coerced: false, malformed_arguments: false, argument_repairs: [] };
  const context = params.continuation_context;
  const frozen = { call_id: call.call_id, tool_name: call.tool_id,
    visible_tool_arguments: call.arguments, effective_tool_arguments: call.arguments,
    injected_arg_keys: [], effective_args_fingerprint: encoded(call.arguments).sha256,
    execution_context_payload: { session_id: params.session_id, logical_turn_id: params.logical_turn_id,
      authority_revision: context.source_attempt.authority_revision,
      project_id: context.authority.project_id, root_id: context.authority.root_id, root_revision: context.authority.root_revision } };
  const batchBytes = encoded({ calls: [call] });
  const frozenBytes = encoded(frozen);
  return options.onRuntimeOperation({ api_version: '2026-10-15', schema_version: 1,
    kind: 'continuation', phase: 'checkpoint', request_id: params.request_id,
    session_id: params.session_id, authority_revision: context.source_attempt.authority_revision,
    operation_id: call.call_id, continuation_context: context, tool_calls: [call],
    tool_batch_bytes: batchBytes.bytes, tool_batch_sha256: batchBytes.sha256,
    frozen_input: frozen, frozen_input_bytes: frozenBytes.bytes, frozen_input_sha256: frozenBytes.sha256,
    position: { completed_iterations: 1, remaining_iterations: 7, current_iteration: 1,
      tool_call_limit: 20, tool_calls_consumed: 1, active_budget_ms_remaining: 5000, ordered_call_ids: [call.call_id] },
    eligibility: { pending_call_index: 0, prior_outcome_count: 0, emitted_tool_execution_count: 0,
      preview_count: 0, approval_pending: false, mutation_started: false } });
}

test('a paused first send and its checkpoint resume each acquire, carry their own token and release once', async (t) => {
  const route = createRoute();
  const f = fixture(t, { turnRoute: route });
  const { service, request, actor } = f;
  const lease = actor.reserveStart({ sessionId: request.sessionId, store: service.sessionStore,
    activeStreams: service.activeStreams, logicalTurnId: 'turn_1', prompt: request.prompt });
  const binding = service.sessionExecutionAuthority.captureSession(request.sessionId, { requestId: lease.identity.streamId });
  const executionContext = service.sessionExecutionAuthority.toExecutionContext(binding);
  const runtimeRoute = captureRuntimeRoute({ engine_type: 'openai-compatible', provider_id: 'openai-compatible',
    configuration_revision: 'config_1', resource_class: 'local', requires_gpu: true });
  const attempt = { attempt_id: 'attempt_1', stream_id: lease.identity.streamId,
    incarnation: 'incarnation_1', authority_revision: executionContext.authority_revision };
  const work = { work_id: 'work_1', turn_id: 'turn_1', session_id: request.sessionId, status: 'running',
    project_id: executionContext.project_id, authority: service.projectAuthority.captureSession(),
    attempt, input: { route: runtimeRoute, request }, revision: 3, submission_hash: 'd'.repeat(64) };
  const checkpointStore = new CheckpointStore(path.join(f.root, 'checkpoints'), {
    validateCanonical: (continuation, current) => service.sessionStore.conversationStore.resolvePendingContinuation(continuation, current),
  });
  const gateway = { enableContinuation: () => true, snapshot: () => ({ active: 0, reserved: 0, quarantined: 0 }),
    tools: { validateResourceWait: () => ({ resource_class: 'filesystem', dependency_id: null }) } };
  const runtimeContinuation = { context: buildAdmittedContinuationContext({ work, attempt, route: runtimeRoute, executionContext }),
    checkpointStore, conversationStore: service.sessionStore.conversationStore, getCurrentWork: () => work, assertCurrent: () => true };
  const sent = [];
  service.sidecarClient.chatSend = async (params, options) => {
    sent.push(params.route_token);
    const published = await publishFromProvider(params, options);
    return { request_id: params.request_id, status: 'paused', checkpoint_ref: published.checkpoint_ref };
  };
  const first = await startManagedSidecarChatStream(service, { ...request, author: AUTHOR, turnLease: lease,
    runtimeExecutionAuthority: binding, runtimeOperationGateway: gateway, runtimeContinuation });
  const firstController = service.activeStreams.get(first.streamId);
  const paused = await firstController._runtimeCompletion;
  assert.equal(paused.status, 'paused', JSON.stringify(service.serviceLogs));
  assert.deepEqual(route.releases, [{ ok: true }], 'a paused result is a send that returned');
  firstController._runtimeSettlementUnregister?.();
  service.sessionExecutionAuthority.close(binding);

  const source = { ...work, status: 'paused', checkpoint_ref: paused.checkpointRef };
  const hydration = hydrateRuntimeContinuation({ work: source, checkpointStore,
    conversationStore: service.sessionStore.conversationStore, assertCurrent: () => true });
  const resumeLease = actor.reserveStart({ sessionId: work.session_id, store: service.sessionStore,
    activeStreams: service.activeStreams, checkpointResume: hydration.reserveIdentity(source) });
  const resumeBinding = service.sessionExecutionAuthority.captureSession(work.session_id, { requestId: resumeLease.identity.streamId });
  const resumeContext = service.sessionExecutionAuthority.toExecutionContext(resumeBinding);
  const fresh = { ...source, status: 'running', attempt: { ...source.attempt,
    attempt_id: 'attempt_2', stream_id: resumeLease.identity.streamId, authority_revision: resumeContext.authority_revision } };
  const context = buildAdmittedContinuationContext({ work: fresh, attempt: fresh.attempt,
    route: captureRuntimeRoute(fresh.input.route), executionContext: resumeContext });
  service.sidecarClient.chatSend = async (params) => {
    sent.push(params.route_token);
    assert.ok(params.runtime_continuation_resume, 'this is the resume send');
    return { status: 'completed', response_text: 'Resumed.' };
  };
  const second = await startManagedSidecarChatStream(service, { ...request, author: AUTHOR, turnLease: resumeLease,
    runtimeExecutionAuthority: resumeBinding, runtimeOperationGateway: gateway,
    runtimeContinuation: { ...runtimeContinuation, context, getCurrentWork: () => fresh, resumeHydration: hydration } });
  const controller = service.activeStreams.get(second.streamId);
  const outcome = await controller._runtimeCompletion;
  assert.equal(outcome.status, 'completed', JSON.stringify(service.serviceLogs));
  controller._runtimeSettlementUnregister?.();
  service.sessionExecutionAuthority.close(resumeBinding);

  assert.equal(route.requests.length, 2, 'the resume is a second acquire');
  assert.deepEqual(sent, route.tokens);
  assert.notEqual(route.tokens[0], route.tokens[1]);
  assert.deepEqual(route.releases, [{ ok: true }, { ok: true }]);
  for (const token of route.tokens) assertTokenNowhere(f, token);
});

test('4b member wiring: the engine port turn route holds one tag during the send and none after success, failure and abort', async (t) => {
  const { createTeamEnginePort } = require('../services/team/engine-port');
  const port = createTeamEnginePort({ forward: async () => { throw new Error('unused'); } });
  await port.start();
  t.after(() => port.stop());
  const endings = {
    success: async () => ({ status: 'completed', response_text: 'Done.' }),
    failure: async () => { throw Object.assign(new Error('engine failed'), { code: 'engine_failed' }); },
    abort: async (f) => {
      [...f.service.activeStreams.values()][0].abort(createCancellationError('user'));
      throw createCancellationError('user');
    },
  };
  for (const [ending, answer] of Object.entries(endings)) {
    const f = fixture(t, { turnRoute: port.turnRoute });
    const held = [];
    const { sent } = await runTurn(f, { chatSend: async () => { held.push(port.resources().turns); return answer(f); } });
    assert.equal(sent.length, 1, ending);
    assert.match(sent[0].route_token, /^[A-Za-z0-9_-]{43}$/u, ending);
    assert.deepEqual(held, [1], `${ending}: one tag while the send runs`);
    assert.equal(port.resources().turns, 0, `${ending}: released`);
    assertTokenNowhere(f, sent[0].route_token);
  }
});
