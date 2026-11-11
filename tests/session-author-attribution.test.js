'use strict';

// Team slice 3-5: a trusted author on user messages and session store schema 27.
// The author comes only from the team host's authenticated actor, rides a
// trusted options argument (never a payload), and every write keeps it only as
// `{ kind: 'member', member_id }` on a user row.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ID_PATTERNS } = require('../server/team/ids');
const { SINGLE_OWNER_MEMBER_ID, singleOwnerActor } = require('../server/team/authorize');
const { projectMessage } = require('../server/session-snapshots');
const { ClientRegistry } = require('../server/client-registry');
const { ControlLeases } = require('../server/control-leases');
const { CommandReceipts } = require('../server/command-receipts');
const { createCommandRouter } = require('../server/command-router');
const {
  MEMBER_ID_PATTERN, memberAuthor, normalizeMessageAuthor, repairSessionForV27,
} = require('../services/backend/message-author');
const { normalizeMessageFields } = require('../services/backend/message-normalization');
const { migrateStorePayload } = require('../services/backend/session-store-migrations');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { encodeRecord } = require('../services/backend/session-journal');
const { forkSession } = require('../services/backend/session-branching');
const { importSession, exportSession } = require('../services/backend/session-export-import');
const { stripUnknownImportedMessageKeys } = require('../services/backend/session-import-message-bounds');
const { prepareLocalEngineChatRequest } = require('../services/backend/local-engine-requests');
const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const { RuntimeApplicationService } = require('../services/session-runtime/application-service');
const { registerSessionRuntimeIpcHandlers } = require('../services/main/session-runtime-ipc-registration');
const { BackendHarness, command } = require('./helpers/command-router-fixture');
const { buildManagedChatRequest, createManagedChatServiceStub } = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const { createAdapterHarness, request: adapterRequest } = require('./helpers/session-runtime-chat-adapter-harness');
const { fixture: runtimeFixture } = require('./helpers/session-runtime-children-fixture');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

const M = 'member_alice_01';
const N = 'member_bob_02';
const author = (memberId = M) => ({ kind: 'member', member_id: memberId });
const BAD_AUTHORS = [
  ['extra key', { kind: 'member', member_id: M, display_name: 'Alice' }],
  ['wrong kind', { kind: 'owner', member_id: M }],
  ['malformed member id', { kind: 'member', member_id: 'member_' }],
  ['foreign id prefix', { kind: 'member', member_id: 'device_abc' }],
  ['over-long member id', { kind: 'member', member_id: `member_${'a'.repeat(65)}` }],
  ['non-object', `member:${M}`],
  ['array', [M]],
  ['null', null],
];

function store() {
  const root = createTrackedTempDir('jenny-author-store-');
  const sessions = new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 });
  return { root, sessions, reopen: () => new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 }) };
}

// ---- One validator ---------------------------------------------------------

test('the services copy of the member id pattern equals the team id pattern', () => {
  assert.equal(MEMBER_ID_PATTERN.source, ID_PATTERNS.member.source);
  assert.equal(MEMBER_ID_PATTERN.flags, ID_PATTERNS.member.flags);
});

test('only an exact { kind, member_id } with a valid member id is an author', () => {
  assert.deepEqual(normalizeMessageAuthor(author()), author());
  assert.deepEqual(normalizeMessageAuthor(JSON.parse(JSON.stringify(author()))), author());
  for (const [label, value] of BAD_AUTHORS) assert.equal(normalizeMessageAuthor(value), null, label);
  assert.equal(normalizeMessageAuthor({ kind: 'member' }), null);
  assert.equal(normalizeMessageAuthor(Object.assign(Object.create({ inherited: true }), author())), null);
  assert.deepEqual(memberAuthor(author().member_id), author());
  for (const id of [undefined, '', 'member_', 'owner_x', 'member_a b']) assert.equal(memberAuthor(id), null, String(id));
});

// ---- Normalization on every write and the V27 step --------------------------

test('normalization keeps a valid author on a user row only and removes every other shape', () => {
  const user = normalizeMessageFields({ id: 'u1', role: 'user', content: 'hi', author: author() });
  assert.deepEqual(user.author, author());
  for (const role of ['assistant', 'tool', 'system']) {
    const row = normalizeMessageFields({ id: `r_${role}`, role, content: 'x', author: author() });
    assert.equal(Object.hasOwn(row, 'author'), false, role);
  }
  for (const [label, value] of BAD_AUTHORS) {
    const row = normalizeMessageFields({ id: 'u2', role: 'user', content: 'hi', author: value });
    assert.equal(Object.hasOwn(row, 'author'), false, label);
  }
  const plain = normalizeMessageFields({ id: 'u3', role: 'user', content: 'hi' });
  assert.equal(Object.hasOwn(plain, 'author'), false, 'a message without an author gains nothing');
});

test('a valid author survives a save and reload; forged shapes never persist', () => {
  const { sessions, reopen } = store();
  const id = sessions.createSession({ title: 'Authors' }).id;
  sessions.appendMessage(id, { id: 'u_ok', role: 'user', content: 'mine', author: author() });
  sessions.appendMessage(id, { id: 'a_1', role: 'assistant', content: 'answer', author: author() });
  sessions.appendMessage(id, { id: 'u_bad', role: 'user', content: 'forged', author: { kind: 'member', member_id: M, x: 1 } });
  sessions.flushSession(id);
  sessions.dispose();
  const reopened = reopen();
  const rows = Object.fromEntries(reopened.getSession(id).messages.map((row) => [row.id, row]));
  assert.deepEqual(rows.u_ok.author, author());
  assert.equal(Object.hasOwn(rows.a_1, 'author'), false);
  assert.equal(Object.hasOwn(rows.u_bad, 'author'), false);
  reopened.dispose();
});

test('the V27 step removes invalid authors and leaves every other message byte-for-byte equal', () => {
  const messages = [
    { id: 'u_plain', role: 'user', content: 'old message' },
    { id: 'u_ok', role: 'user', content: 'attributed', author: author() },
    { id: 'a_bad', role: 'assistant', content: 'reply', author: author() },
    ...BAD_AUTHORS.map(([label, value], index) => ({ id: `u_bad_${index}`, role: 'user', content: label, author: value })),
  ];
  const payload = { schema_version: 26, sessions: { sess_a: { id: 'sess_a', title: 'Old', messages } } };
  const before = JSON.stringify(payload);
  const migrated = migrateStorePayload(payload).sessions.sess_a;
  assert.equal(JSON.stringify(payload), before, 'the input payload is not mutated');
  assert.equal(migrated.messages.length, messages.length);
  migrated.messages.forEach((row, index) => {
    const { author: _ignored, ...source } = messages[index];
    const { author: kept, ...rest } = row;
    assert.equal(JSON.stringify(rest), JSON.stringify(source), `${row.id} content unchanged`);
    assert.deepEqual(kept, row.id === 'u_ok' ? author() : undefined, row.id);
  });
  assert.equal(migrated.messages[0], messages[0], 'a message without an author is the same object');
  assert.deepEqual(repairSessionForV27({ id: 'no_messages' }), { id: 'no_messages' });
  assert.deepEqual(repairSessionForV27({ messages: ['not a message'] }).messages, ['not a message']);
});

test('a store loaded from disk drops an author on an assistant row and a malformed one on a user row', async () => {
  for (const fixture of ['userdata-v26-current', 'userdata-v27-current']) {
    const root = createTrackedTempDir('jenny-author-disk-');
    fs.cpSync(path.join(__dirname, 'release-compat', 'fixtures', fixture, 'sessions'), path.join(root, 'sessions'), { recursive: true });
    const journal = path.join(root, 'sessions', 'sess_v23_second.1.journal');
    const rows = new Map(fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line.slice(line.indexOf('{')))).flatMap((record) => record.ops || [])
      .filter((op) => op.o === 'm').map((op) => [op.i, op.v]));
    fs.appendFileSync(journal, encodeRecord([
      { o: 'm', i: 0, v: { ...rows.get(0), author: { kind: 'member', member_id: 'member_' } } },
      { o: 'm', i: 1, v: { ...rows.get(1), author: author() } },
    ]));
    const sessions = new ElectronSessionStore(path.join(root, 'sessions.json'), { sessionJournal: true });
    if (sessions.hasPendingMigrations()) assert.equal((await sessions.runPendingMigrations({ batchSize: 1 })).success, true);
    const loaded = sessions.getSession('sess_v23_second').messages;
    assert.deepEqual(loaded.map((row) => row.id), ['b_user_1', 'b_assistant_1'], fixture);
    assert.equal(loaded.some((row) => Object.hasOwn(row, 'author')), false, fixture);
    sessions.dispose();
  }
});

// ---- Snapshot, import, branch, regenerate ------------------------------------

test('the snapshot projects a valid author on user rows only', () => {
  assert.deepEqual(projectMessage({ id: 'u', role: 'user', content: 'x', author: author() }).author, author());
  assert.equal(Object.hasOwn(projectMessage({ id: 'a', role: 'assistant', content: 'x', author: author() }), 'author'), false);
  assert.equal(Object.hasOwn(projectMessage({ id: 'u', role: 'user', content: 'x', author: { kind: 'member', member_id: 'nope' } }), 'author'), false);
  assert.equal(Object.hasOwn(projectMessage({ id: 'u', role: 'user', content: 'x' }), 'author'), false);
});

test('import and trusted archive restore never bring an author', () => {
  const stripped = stripUnknownImportedMessageKeys({ id: 'u', role: 'user', content: 'x', author: author() });
  assert.equal(Object.hasOwn(stripped.message, 'author'), false);
  assert.deepEqual([...stripped.strippedKeys], ['author']);
  const { sessions } = store();
  const id = sessions.createSession({ title: 'Exported' }).id;
  sessions.appendMessage(id, { id: 'u_ok', role: 'user', content: 'attributed', author: author() });
  const exported = exportSession(sessions, id);
  for (const options of [{}, { trustedArchive: true, restoredSessionId: 'sess_restored_author' }]) {
    const restored = importSession(sessions, typeof exported === 'string' ? exported : JSON.stringify(exported), null, options);
    const rows = sessions.getSession(restored.id).messages;
    assert.equal(rows.length, 1);
    assert.equal(Object.hasOwn(rows[0], 'author'), false, JSON.stringify(options));
  }
  sessions.dispose();
});

test('a branch keeps each message author; regenerating keeps it; an edit keeps it (known limit)', () => {
  const { sessions } = store();
  const id = sessions.createSession({ title: 'Branch source' }).id;
  sessions.appendMessage(id, { id: 'u_1', role: 'user', content: 'first', author: author(M) });
  sessions.appendMessage(id, { id: 'a_1', role: 'assistant', content: 'one' });
  sessions.appendMessage(id, { id: 'u_2', role: 'user', content: 'second', author: author(N) });
  sessions.appendMessage(id, { id: 'a_2', role: 'assistant', content: 'two' });
  const branch = forkSession(sessions, id, 'a_2');
  const branched = sessions.getSession(branch.id).messages;
  assert.deepEqual(branched.map((row) => row.author?.member_id ?? null), [M, null, N, null]);
  assert.ok(sessions.truncateAfterMessage(id, 'u_2', { replaceMessageContent: 'second' }));
  assert.deepEqual(sessions.getSession(id).messages.at(-1).author, author(N));
  // Known limit (3-5 as built): an edit keeps the stored author. No host path submits an edit
  // today; the slice that adds one replaces the author here and flips this assertion.
  assert.ok(sessions.truncateAfterMessage(id, 'u_2', { replaceMessageContent: 'edited' }));
  assert.deepEqual(sessions.getSession(id).messages.at(-1).author, author(N));
  sessions.dispose();
});

// ---- Trusted seam: application service and desktop IPC -----------------------

function capturingApp() {
  const seen = [];
  const runtime = {
    store: {},
    submit: async (request) => { seen.push(request); return { ok: true, work_id: 'work_1' }; },
    start: async (request) => { seen.push(request); return { ok: true, work_id: 'work_1' }; },
  };
  return { seen, app: new RuntimeApplicationService({ getRuntime: () => runtime }) };
}
const sendPayload = (extra = {}) => ({ session_id: 'sess_1', prompt: 'hello', idempotency_key: 'idem_1', ...extra });
const startPayload = (extra = {}) => sendPayload({ purpose: 'Inspect', limits: { inference_requests: 1, input_tokens: 8, output_tokens: 8 }, ...extra });

test('the application service takes the author from its trusted options only', async () => {
  const { seen, app } = capturingApp();
  assert.equal((await app.submit(sendPayload(), { author: author() })).ok, true);
  assert.equal((await app.start(startPayload(), { author: author(N) })).ok, true);
  assert.deepEqual(seen.map((request) => request.author), [author(), author(N)]);
  seen.length = 0;
  assert.equal((await app.submit(sendPayload({ author: author() }))).error.reason, 'runtime_submission_request_invalid');
  assert.equal((await app.start(startPayload({ author: author() }))).error.reason, 'runtime_start_request_invalid');
  assert.equal(seen.length, 0, 'a payload author is refused before the runtime');
  await app.submit(sendPayload(), { author: { kind: 'member', member_id: 'bad id' } });
  await app.submit(sendPayload());
  assert.deepEqual(seen.map((request) => Object.hasOwn(request, 'author')), [false, false]);
});

test('a desktop IPC submit can never set an author', async () => {
  const { seen, app } = capturingApp();
  const handlers = new Map();
  registerSessionRuntimeIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    applicationService: {}, runtimeApplicationService: app,
    authorization: { authorize: () => true, unauthorizedResult: () => ({ ok: false }) },
  });
  for (const channel of ['session-runtime:submit', 'session-runtime:start']) {
    const payload = channel.endsWith('start') ? startPayload : sendPayload;
    assert.equal((await handlers.get(channel)({}, payload({ author: author() }))).ok, false, channel);
    assert.equal((await handlers.get(channel)({}, payload(), { author: author() })).ok, true, channel);
  }
  assert.deepEqual(seen.map((request) => Object.hasOwn(request, 'author')), [false, false]);
});

// ---- Producers: the router's chat.send and sessionRuntime.start ---------------

function teamRouter({ team = true } = {}) {
  const root = createTrackedTempDir('jenny-author-router-');
  const backend = new BackendHarness(root);
  const calls = [];
  const submit = backend.runtimeApplicationService.submit;
  backend.runtimeApplicationService.submit = (payload, options) => { calls.push({ payload, options }); return submit(payload, options); };
  const clients = new ClientRegistry();
  const router = createCommandRouter({ backend, clients, leases: new ControlLeases(),
    receipts: new CommandReceipts({ filePath: path.join(root, 'receipts.json') }), bootEpoch: 'boot_test',
    eventStream: { publish() {} }, ...(team ? { authorize: () => ({ ok: true }) } : {}) });
  const auth = clients.register('device-a');
  const context = (memberId) => ({ deviceId: 'device-a', clientToken: auth.client_token, isAuthenticated: () => true,
    actor: memberId === SINGLE_OWNER_MEMBER_ID ? singleOwnerActor('device-a')
      : { ...(memberId ? { member_id: memberId } : {}), device_id: 'device-a', role: 'member', state: 'active' } });
  return { backend, router, auth, calls, context, close() { router.dispose(); backend.dispose(); } };
}

async function send(h, memberId, params = { prompt: 'hello' }) {
  const ctx = h.context(memberId);
  const created = await h.router.dispatch(command(h.auth, 'sessions.create', { title: 'Team' }), ctx);
  const sessionId = created.session.session_id;
  const lease = await h.router.dispatch(command(h.auth, 'control.acquire', { takeover: false }, { session_id: sessionId }), ctx);
  const result = await h.router.dispatch(command(h.auth, 'chat.send', params, { session_id: sessionId,
    control_generation: lease.lease.generation, expected_revision: `boot_test:1` }), ctx);
  return { result, sessionId };
}

test('team chat.send hands the actor as the trusted author; params cannot forge one', async (t) => {
  const h = teamRouter();
  t.after(() => h.close());
  const { result } = await send(h, M);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.calls[0].options.author, author(M));
  assert.equal(Object.hasOwn(h.calls[0].payload, 'author'), false);
  const forged = await send(h, M, { prompt: 'hello', author: author(N) });
  assert.equal(forged.result.error.reason, 'invalid_command_parameters');
  assert.equal(h.calls.length, 1, 'a forged params author never reaches the submission');
});

test('the single-owner host sends no author, even with its member_single_owner actor', async (t) => {
  for (const [team, memberId] of [[false, SINGLE_OWNER_MEMBER_ID], [false, M]]) {
    const h = teamRouter({ team });
    t.after(() => h.close());
    const { result } = await send(h, memberId);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(h.calls[0].options.author, undefined, `${team}:${memberId}`);
  }
});

async function teamRuntimeRouter(t) {
  const h = await runtimeFixture(t);
  h.service.runtimeApplicationService = h.app;
  const clients = new ClientRegistry();
  const router = createCommandRouter({ backend: h.service, clients, leases: new ControlLeases(),
    receipts: new CommandReceipts({ filePath: path.join(h.service.options.userDataPath, 'r.json') }),
    bootEpoch: 'boot_test', eventStream: { publish() {} }, authorize: () => ({ ok: true }) });
  t.after(() => router.dispose());
  const auth = clients.register('device_a');
  const ctx = (memberId) => ({ deviceId: 'device_a', clientToken: auth.client_token, isAuthenticated: () => true,
    actor: { ...(memberId ? { member_id: memberId } : {}), device_id: 'device_a', role: 'member', state: 'active' } });
  const lease = await router.dispatch(command(auth, 'control.acquire', {}, { session_id: h.sessionId }), ctx(M));
  const mutation = (operation, params, memberId, revision) => router.dispatch(command(auth, operation, params, {
    session_id: h.sessionId, control_generation: lease.lease.generation, expected_revision: `boot_test:${revision}` }), ctx(memberId));
  const start = (memberId, params = {}, revision = 0) => mutation('sessionRuntime.start', { prompt: 'Team task', purpose: 'Inspect',
    limits: { inference_requests: 3, input_tokens: 96, output_tokens: 96 }, ...params }, memberId, revision);
  return { h, router, mutation, start };
}

test('team sessionRuntime.start stores the actor author on the durable work request', async (t) => {
  const { h, start } = await teamRuntimeRouter(t);
  assert.equal((await start(M, { author: author(N) })).error.reason, 'invalid_command_parameters', 'a params author is refused');
  const result = await start(M);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.runtime.store.get(result.runtime.work_id).input.request.author, author(M));
  assert.equal(Object.hasOwn(h.runtime.store.get(h.started.work_id).input.request, 'author'), false,
    'the desktop-shaped start without options carries none');
});

test('only its author may rewrite a queued prompt; anyone else is refused and nothing changes', async (t) => {
  const { h, mutation, start } = await teamRuntimeRouter(t);
  const queued = await start(M);
  assert.equal(queued.runtime.status, 'pending', JSON.stringify(queued));
  const workId = queued.runtime.work_id;
  const before = JSON.stringify(h.runtime.store.get(workId));
  const edit = (memberId, prompt, revision) => mutation('sessionRuntime.updatePending',
    { work_id: workId, expected_revision: h.runtime.store.get(workId).revision, prompt }, memberId, revision);
  const refused = await edit(N, 'Words M never wrote', 1);
  assert.equal(refused.error.reason, 'pending_update_forbidden', JSON.stringify(refused));
  assert.equal(refused.error.code, require('../server/api-contract').hostFailure('forbidden', 'x').error.code);
  assert.equal(JSON.stringify(h.runtime.store.get(workId)), before, 'the stored record is unchanged');
  assert.equal((await edit(undefined, 'No author at all', 1)).error.reason, 'pending_update_forbidden');
  const own = await edit(M, 'M rewrites it', 1);
  assert.equal(own.ok, true, JSON.stringify(own));
  const request = h.runtime.store.get(workId).input.request;
  assert.deepEqual([request.prompt, request.author], ['M rewrites it', author(M)]);
});

test('a desktop queued prompt without an author is edited exactly as before', async (t) => {
  const h = await runtimeFixture(t);
  const queued = await h.app.start({ session_id: h.sessionId, prompt: 'Desktop task', idempotency_key: 'desk_2',
    purpose: 'Inspect', limits: { inference_requests: 3, input_tokens: 96, output_tokens: 96 } });
  assert.equal(queued.status, 'pending', JSON.stringify(queued));
  const edited = await h.app.updatePending({ work_id: queued.work_id,
    expected_revision: h.runtime.store.get(queued.work_id).revision, prompt: 'Edited on desktop' });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(h.runtime.store.get(queued.work_id).input.request.prompt, 'Edited on desktop');
  assert.equal(Object.hasOwn(h.runtime.store.get(queued.work_id).input.request, 'author'), false);
});

test('a team host refuses chat.send and sessionRuntime.start when the actor yields no author', async (t) => {
  const h = teamRouter();
  t.after(() => h.close());
  const { result } = await send(h, undefined);
  assert.equal(result.error.reason, 'member_author_required', JSON.stringify(result));
  assert.equal(h.calls.length, 0, 'nothing was submitted');
  const runtime = await teamRuntimeRouter(t);
  assert.equal((await runtime.start(undefined)).error.reason, 'member_author_required');
  assert.equal((await runtime.start('not a member id')).error.reason, 'member_author_required');
});

// ---- Hops to the persisted user message --------------------------------------

test('the local engine request keeps a valid author and drops anything else', async () => {
  const service = { sessionStore: { getSession: () => ({ id: 's' }), getSessionSummary: () => ({ id: 's' }) } };
  const base = { sessionId: 's', prompt: 'p', visiblePrompt: 'p', preferredModel: 'gemma', attachments: [] };
  assert.deepEqual((await prepareLocalEngineChatRequest(service, { ...base, author: author() })).author, author());
  for (const value of [undefined, { kind: 'member', member_id: M, extra: true }]) {
    assert.equal(Object.hasOwn(await prepareLocalEngineChatRequest(service, { ...base, author: value }), 'author'), false);
  }
});

test('a turn resumed from its durable work record keeps its author', async (t) => {
  const { adapter, sessionId } = createAdapterHarness(t);
  const prepared = await adapter.prepareImmediate(adapterRequest(sessionId, { author: author() }), {}, { workId: 'work_a', turnId: 'turn_a' });
  assert.deepEqual(prepared.input.request.author, author(), 'the author rides the durable request');
  adapter.discard(prepared);
  const paused = { work_id: 'work_a', turn_id: 'turn_a', session_id: sessionId, project_id: prepared.authority.project_id,
    status: 'paused', attempt: null, authority: prepared.authority, input: prepared.input };
  const resumed = adapter.prepareResume(paused, { getCurrentWork: () => paused });
  assert.deepEqual(resumed.request.author, author());
  adapter.discard(resumed);
});

test('the managed turn writes the author on the user row only and never sends it to the model', async () => {
  const service = createManagedChatServiceStub();
  let sent = null;
  service.sidecarClient = {
    connected: true,
    async chatSend(params, options = {}) {
      sent = params;
      options.onNotification({ method: 'chat.token', params: { delta: 'Hi there.' } });
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
      return { status: 'completed' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_author', prompt: 'Hello team', author: author(),
  }));
  await service.activeStreams.get(stream.streamId)?._pendingPromise;
  const users = service.sessionMessages.filter((row) => row.role === 'user');
  assert.equal(users.length, 1);
  assert.deepEqual(users[0].author, author());
  assert.ok(service.sessionMessages.some((row) => row.role === 'assistant'));
  for (const row of service.sessionMessages.filter((entry) => entry.role !== 'user')) {
    assert.equal(Object.hasOwn(row, 'author'), false, row.role);
  }
  assert.ok(Array.isArray(sent?.messages) && sent.messages.length > 0);
  assert.equal(JSON.stringify(sent.messages).includes('"author"'), false, 'the model history has no author key');
  assert.equal(JSON.stringify(sent).includes(M), false, 'no member id reaches the sidecar');
});

test('a desktop managed turn writes no author', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = { connected: true, async chatSend(_params, options = {}) {
    options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
    return { status: 'completed' };
  } };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({ sessionId: 'session_plain', prompt: 'Hello' }));
  await service.activeStreams.get(stream.streamId)?._pendingPromise;
  assert.equal(service.sessionMessages.some((row) => Object.hasOwn(row, 'author')), false);
});

