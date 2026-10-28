'use strict';

// Row 76 S6: resetPrimaryChat / forgetPreview over a real ElectronSessionStore and a
// minimal fake BackendService. Memory goes through a fake `sidecarClient` (the real
// backend-memory.js functions run on top of it), so a spy on `memory.purge_session`
// proves the permanent-marker RPC is never sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = require('../services/backend/chat-proposal-records');
const S = require('../services/backend/chat-proposal-session-records');
const { createChatProposalStore } = require('../services/backend/chat-proposal-store');
const { createSessionMailStore } = require('../services/backend/session-mail-store');
const { AttachmentAssetStore } = require('../services/attachment-asset-store');
const { GENERAL_PROJECT_ID } = require('../services/projects/project-schema');
const { resetPrimaryChat, forgetPreview } = require('../services/backend/primary-chat-reset');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { freshStore, seedConversation } = require('./helpers/session-truncate-fixtures');
const F = require('./helpers/session-mail-fixtures');

const NOW = new Date('2026-10-25T09:08:07.000Z');
const DECISION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makeSessionProposal(sessionId, n = 1) {
  const input = S.normalizeSessionProposalInput({ initiation: 'offer', title: 'Fix the build' }).value;
  const binding = {
    source_project_id: null, workspace_id: null, root_identity: null,
    authority_revision: 1, run_mode: 'agent', restrictions: { read_only: false, plan_mode: false },
    model: null, effort: null, git: null, command: null,
    session: {
      effective_initiation: 'offer', authorization_required: false, launch_grant_ref: null, source_run_mode: 'ask', lockdown: false,
    },
  };
  const made = R.createProposalRecord({
    kind: 'session', sessionId, sessionIncarnation: 'inc_a', turnId: `turn_${n}`, toolCallId: `call_${n}`, input, binding,
    now: NOW, options: S.defaultOptions({ sourceProjectId: null }),
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  return made.record;
}

// A fake BackendService: real store, recorders for every port the module reaches.
function setup(t, options = {}) {
  const { store, userDataPath } = freshStore();
  t.after(() => store.dispose());
  const created = store.createSession({ title: 'Jenny', projectId: GENERAL_PROJECT_ID, sessionRole: 'primary' });
  const sessionId = created.id;
  store.setSessionMeta(sessionId, { pinned: true });
  seedConversation(store, sessionId);
  const calls = {
    cancel: [], discard: [], decide: [], journal: [], logs: [], rpc: [], prefs: [], history: [], order: [],
  };
  const memories = options.memories || [];
  const candidates = options.candidates || [];
  const mailStore = createSessionMailStore(store);
  const service = {
    sessionStore: store,
    featureFlags: options.featureFlags || {},
    options: { userDataPath: options.userDataPath || userDataPath },
    _emitServiceLog: (level, event, details) => calls.logs.push({ level, event, details }),
    sessionTurnActors: {
      runSessionMutation(id, site, operation, commit, opts) {
        calls.order.push('lease');
        if (opts?.requireIdle && store.getActiveTurn(id)) {
          return Promise.reject(Object.assign(new Error('a turn is already running'), { code: 'session_busy' }));
        }
        return Promise.resolve().then(operation).then(commit);
      },
    },
    sessionRuntime: {
      async cancelSessionAndWait(id, opts) {
        calls.order.push('cancel');
        calls.cancel.push({ id, opts });
        return options.cancelResult || { ok: true };
      },
    },
    chatMessages: {
      async discard(request) {
        calls.order.push('discard');
        calls.discard.push(structuredClone(request));
        if (options.discardResult) return options.discardResult;
        const ids = new Set(request.message_ids);
        const moved = mailStore.mutate(request.session_id, ({ mail }) => ({
          mail: {
            ...mail,
            inbox: mail.inbox.filter((record) => !ids.has(record.envelope.message_id)),
            discarded: [...mail.discarded, ...mail.inbox
              .filter((record) => ids.has(record.envelope.message_id))
              .map((record) => F.makeDiscard(Number(record.receive_sequence)))],
          },
        }));
        return { ok: moved.ok, updated_count: ids.size };
      },
    },
    chatProposals: {
      async decide(request) {
        calls.order.push('decide');
        calls.decide.push(structuredClone(request));
        return options.decideResult || { ok: true };
      },
    },
    turnEventJournal: {
      purgeTurnsAfter(id, surviving, opts) {
        calls.order.push('journal');
        calls.journal.push({ id, surviving: [...surviving], opts });
        return options.journalResult || { ok: true, purged: 1, durable: true, reason: null };
      },
      flush() {},
    },
    sidecarClient: {
      connected: true,
      async request(method, params) {
        calls.rpc.push({ method, params });
        switch (method) {
          case 'memory.list': return { memories, next_cursor: null };
          case 'memory.pending.list': return { candidates, next_cursor: null };
          case 'memory.delete': return { deleted: true, memory_id: params.memory_id };
          case 'memory.pending.delete': return { deleted: true };
          case 'conversations.purge': return { ok: true };
          default: throw new Error(`unexpected rpc ${method}`);
        }
      },
    },
    projectAuthority: { captureSession: () => ({ project_id: GENERAL_PROJECT_ID }) },
    async setSessionPreferences(id, preferences) {
      calls.prefs.push({ id, preferences });
      return store.setSessionPreferences(id, preferences);
    },
    primaryChatControls: { recordHistory: (kind) => calls.history.push(kind) },
    ...(options.service || {}),
  };
  return { service, store, calls, sessionId, userDataPath, mailStore };
}

const rpcCount = (calls, method) => calls.rpc.filter((entry) => entry.method === method).length;

test('refuses disabled when either kill switch is off', async (t) => {
  for (const featureFlags of [{ primary_chat_controls: false }, { primary_chat: false }]) {
    const { service, store, sessionId } = setup(t, { featureFlags });
    assert.deepEqual(await resetPrimaryChat(service, { now: () => NOW }), { ok: false, reason: 'disabled' });
    assert.deepEqual(await forgetPreview(service), { ok: false, reason: 'disabled' });
    assert.equal(store.getSession(sessionId).messages.length, 4);
  }
});

test('refuses not_found without a primary chat', async (t) => {
  const { service, store, sessionId } = setup(t);
  service.sessionStore = { listSessions: () => store.listSessions().filter((s) => s.id !== sessionId) };
  assert.deepEqual(await resetPrimaryChat(service), { ok: false, reason: 'not_found' });
  assert.deepEqual(await forgetPreview(service), { ok: false, reason: 'not_found' });
});

test('refuses session_busy while a turn holds the lease and changes nothing', async (t) => {
  const { service, store, sessionId, calls, userDataPath } = setup(t);
  store.setActiveTurn(sessionId, {
    request_id: 'req_1', turn_id: 'turn_9', stream_id: 'stream_1', user_message_id: 'msg_user_2',
    status: 'awaiting_assistant', started_at: NOW.toISOString(), last_event_at: NOW.toISOString(),
  });
  assert.ok(store.getActiveTurn(sessionId));
  const result = await resetPrimaryChat(service, { now: () => NOW });
  assert.deepEqual(result, { ok: false, reason: 'session_busy' });
  assert.equal(store.getSession(sessionId).messages.length, 4);
  assert.deepEqual(calls.cancel, []);
  assert.equal(fs.existsSync(path.join(userDataPath, 'exports')), false);
});

test('a busy session actor refuses session_busy without cancelling its runtime work', async (t) => {
  const { service, store, sessionId, calls } = setup(t);
  service.sessionTurnActors.hasActiveLifecycle = (id) => id === sessionId;
  assert.deepEqual(await resetPrimaryChat(service, { now: () => NOW }), { ok: false, reason: 'session_busy' });
  assert.deepEqual(calls.cancel, []);
  assert.deepEqual(calls.order, []);
  assert.equal(store.getSession(sessionId).messages.length, 4);
});

test('a plain reset empties the transcript and keeps the row, role, title, pin, project and counters', async (t) => {
  const { service, store, sessionId, calls } = setup(t);
  store.updateSession(sessionId, {
    pending_question_batch: { batch_id: 'b1', questions: [] },
    composer_draft: 'half typed',
    context_usage: null,
  });
  const before = store.getSession(sessionId);
  assert.ok(before.message_seq_counter > 0);
  assert.ok(before.turn_events.length > 0);

  const result = await resetPrimaryChat(service, { now: () => NOW });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.schema_version, 1);
  assert.equal(result.session_id, sessionId);
  assert.equal(result.cleared.messages, 4);
  assert.deepEqual(result.cleared.mail, { discarded: 0, kept: 0 });
  assert.deepEqual(result.cleared.proposals, { dismissed: 0, kept: 0 });
  assert.equal(result.forgotten, null);
  assert.deepEqual(result.limits, []);

  const after = store.getSession(sessionId);
  assert.deepEqual(after.messages, []);
  assert.deepEqual(after.turn_events, []);
  assert.equal(after.message_count, 0);
  assert.equal(after.last_message_preview, '');
  assert.equal(after.active_turn, null);
  assert.equal(after.pending_question_batch, null);
  assert.equal(after.pending_plan_proposal, null);
  assert.equal(after.compaction_snapshot, null);
  assert.equal(after.context_usage, null);
  assert.equal(after.composer_draft, undefined);
  for (const key of ['id', 'session_role', 'title', 'pinned', 'project_id', 'session_incarnation',
    'message_seq_counter', 'turn_event_seq_counter', 'turn_generation']) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(after.session_role, 'primary');
  assert.equal(after.pinned, true);

  // Once before the lease (paused work settles) and once inside it (work queued since).
  assert.equal(calls.cancel.length, 2);
  assert.deepEqual(calls.cancel.map((entry) => entry.id), [sessionId, sessionId]);
  assert.deepEqual(calls.order.slice(0, 3), ['cancel', 'lease', 'cancel']);
  assert.equal(calls.journal.length, 1);
  assert.deepEqual(calls.journal[0].surviving, []);
  assert.equal(rpcCount(calls, 'conversations.purge'), 1);
  assert.deepEqual(calls.rpc.find((entry) => entry.method === 'conversations.purge').params.session_ids, [sessionId]);
  assert.deepEqual(calls.history, ['reset']);
  const log = calls.logs.find((entry) => entry.event === 'primary_chat.reset');
  assert.ok(log);
  assert.equal(log.details.forget, false);
  assert.equal(JSON.stringify(calls.logs).includes(result.copy_path), false, 'the copy path is never logged');
});

test('a turn that starts during either cancel wait refuses session_busy before the copy or any clear', async (t) => {
  for (const startsOnCall of [1, 2]) {
    const { service, store, sessionId, calls, userDataPath } = setup(t);
    const original = service.sessionRuntime.cancelSessionAndWait;
    service.sessionRuntime.cancelSessionAndWait = async (id, opts) => {
      if (calls.cancel.length + 1 === startsOnCall) {
        store.setActiveTurn(sessionId, {
          request_id: 'req_2', turn_id: 'turn_10', stream_id: 'stream_2', user_message_id: 'msg_user_2',
          status: 'awaiting_assistant', started_at: NOW.toISOString(), last_event_at: NOW.toISOString(),
        });
      }
      return original(id, opts);
    };
    const result = await resetPrimaryChat(service, { now: () => NOW });
    assert.deepEqual(result, { ok: false, reason: 'session_busy' }, `turn starts on cancel ${startsOnCall}`);
    assert.equal(calls.cancel.length, startsOnCall);
    assert.equal(store.getSession(sessionId).messages.length, 4);
    assert.deepEqual(calls.discard, []);
    assert.equal(fs.existsSync(path.join(userDataPath, 'exports')), false);
  }
});

test('keep_copy writes a parseable export with the old messages before the clear', async (t) => {
  const { service, sessionId, calls, userDataPath } = setup(t);
  const result = await resetPrimaryChat(service, { now: () => NOW });
  assert.equal(result.ok, true);
  assert.match(result.copy_path, /^exports\/jenny-reset-\d{8}-\d{6}\.json$/, 'profile-relative, never an absolute path');
  const exported = JSON.parse(fs.readFileSync(path.join(userDataPath, result.copy_path), 'utf8'));
  assert.equal(exported.format, 'jenny-session-export');
  assert.deepEqual(exported.session.messages.map((message) => message.content),
    ['first prompt', 'first reply', 'second prompt', 'second reply']);
  assert.ok(calls.order.indexOf('lease') < calls.order.lastIndexOf('cancel'));
  assert.ok(sessionId);
});

test('keep_copy false writes no copy', async (t) => {
  const { service, userDataPath } = setup(t);
  const result = await resetPrimaryChat(service, { keep_copy: false, now: () => NOW });
  assert.equal(result.ok, true);
  assert.equal(result.copy_path, null);
  assert.equal(fs.existsSync(path.join(userDataPath, 'exports')), false);
});

test('a copy write failure aborts before anything is cleared', async (t) => {
  const { service, store, sessionId, calls, userDataPath } = setup(t);
  // `exports` exists as a file, so mkdir / write under it fails on every platform.
  fs.writeFileSync(path.join(userDataPath, 'exports'), 'not a directory');
  const result = await resetPrimaryChat(service, { now: () => NOW });
  assert.deepEqual(result, { ok: false, reason: 'copy_failed' });
  assert.equal(store.getSession(sessionId).messages.length, 4);
  assert.equal(store.getSession(sessionId).turn_events.length > 0, true);
  assert.deepEqual(calls.discard, []);
  assert.deepEqual(calls.journal, []);
  assert.equal(rpcCount(calls, 'conversations.purge'), 0);
  assert.ok(calls.logs.some((entry) => entry.event === 'primary_chat.reset_step_failed' && entry.details.step === 'copy'));
});

test('queued and excluded inbox mail is discarded; included mail is kept and counted', async (t) => {
  const { service, sessionId, calls, mailStore } = setup(t);
  const included = F.makeInbox(3, {
    context: {
      state: 'included', turn_id: 'turn_3', snapshot_id: F.uuid(6003), included_at: F.iso(),
      canonical_message_id: `ctx_${F.uuid(3)}`,
    },
  });
  const seeded = mailStore.mutate(sessionId, ({ mail }) => ({
    mail: {
      ...mail,
      inbox: [
        F.makeInbox(1),
        F.makeInbox(2, { context: { state: 'excluded_by_user', changed_at: F.iso() } }),
        included,
      ],
      next_receive_sequence: 4,
    },
  }));
  assert.equal(seeded.ok, true, JSON.stringify(seeded));

  const result = await resetPrimaryChat(service, { keep_copy: false, now: () => NOW });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.cleared.mail, { discarded: 2, kept: 1 });
  assert.equal(calls.discard.length, 1);
  assert.equal(calls.discard[0].schema_version, 1);
  assert.equal(calls.discard[0].session_id, sessionId);
  assert.deepEqual([...calls.discard[0].message_ids].sort(), [F.uuid(1), F.uuid(2)]);
  // Mail goes before the transcript clear (discard writes receipt rows).
  assert.ok(calls.order.indexOf('discard') < calls.order.indexOf('journal'));
});

test('a refused mail discard aborts the reset before the transcript clear', async (t) => {
  const { service, store, sessionId, mailStore, calls } = setup(t, {
    discardResult: { ok: false, reason: 'busy' },
  });
  mailStore.mutate(sessionId, ({ mail }) => ({ mail: { ...mail, inbox: [F.makeInbox(1)], next_receive_sequence: 2 } }));
  const result = await resetPrimaryChat(service, { keep_copy: false, now: () => NOW });
  assert.deepEqual(result, { ok: false, reason: 'unavailable' });
  assert.equal(store.getSession(sessionId).messages.length, 4);
  assert.deepEqual(calls.journal, []);
});

test('a pending session proposal is dismissed with its revision; other states are not touched', async (t) => {
  const { service, store, sessionId, calls } = setup(t);
  const pending = makeSessionProposal(sessionId, 1);
  const done = R.dismissProposal(makeSessionProposal(sessionId, 2), { decisionId: '22222222-2222-4222-8222-222222222222', now: NOW });
  assert.equal(done.decision_state, 'dismissed');
  const proposals = createChatProposalStore(store);
  const written = proposals.mutate(sessionId, () => ({ records: [pending, done] }));
  assert.equal(written.ok, true, JSON.stringify(written));
  const stored = proposals.read(sessionId).records.find((record) => record.proposal_id === pending.proposal_id);
  assert.equal(stored.decision_state, 'pending');

  const result = await resetPrimaryChat(service, { keep_copy: false, now: () => NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.cleared.proposals, { dismissed: 1, kept: 0 });
  assert.equal(calls.decide.length, 1);
  const request = calls.decide[0];
  assert.equal(request.schema_version, 1);
  assert.equal(request.session_id, sessionId);
  assert.equal(request.proposal_id, pending.proposal_id);
  assert.equal(request.expected_revision, stored.revision);
  assert.equal(request.choice, 'dismiss');
  assert.match(request.decision_id, DECISION_UUID);
});

test('a refused dismissal is counted as kept and the reset continues', async (t) => {
  const { service, store, sessionId } = setup(t, { decideResult: { ok: false, reason: 'expired' } });
  createChatProposalStore(store).mutate(sessionId, () => ({ records: [makeSessionProposal(sessionId, 1)] }));
  const result = await resetPrimaryChat(service, { keep_copy: false, now: () => NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.cleared.proposals, { dismissed: 0, kept: 1 });
  assert.equal(store.getSession(sessionId).messages.length, 0);
});

test('attachments orphaned by the clear are pruned', async (t) => {
  const { service, store, sessionId, userDataPath } = setup(t);
  const attachmentAssetStore = new AttachmentAssetStore({ rootDir: path.join(userDataPath, 'attachments') });
  const assetPath = path.join(attachmentAssetStore.ensureKindDir('image'), 'pic.png');
  fs.writeFileSync(assetPath, 'bytes');
  store.updateMessage(sessionId, 'msg_ai_2', {
    attachments: [{ id: 'img_1', kind: 'image', displayName: 'pic.png', mimeType: 'image/png', assetPath }],
  });
  service.attachmentAssetStore = attachmentAssetStore;
  const result = await resetPrimaryChat(service, { now: () => NOW });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(assetPath), false);
  assert.deepEqual(result.limits, []);
  // The copy was taken before the prune and carries the bytes.
  assert.match(fs.readFileSync(path.join(service.options.userDataPath, result.copy_path), 'utf8'), /_exportedData/);
});

test('the todo list file of the chat is removed', async (t) => {
  const { service, sessionId, userDataPath } = setup(t);
  const { todoListFileName } = require('../services/backend/session-todo-list-purge');
  const dir = path.join(userDataPath, 'todo-lists');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, todoListFileName(sessionId));
  fs.writeFileSync(file, '{}');
  const result = await resetPrimaryChat(service, { keep_copy: false, now: () => NOW });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(file), false);
});

test('best-effort step failures land in limits while the reset still succeeds', async (t) => {
  const { service, store, sessionId, calls } = setup(t, {
    journalResult: { ok: false, reason: 'io_failed' },
    service: {
      usageHistory: { resetSession: () => ({ ok: false }) },
      artifactService: { deleteSessionArtifacts: async () => { throw new Error('boom: C:\\secret\\path'); } },
      shadowStore: { upsertSession: () => null },
    },
  });
  const result = await resetPrimaryChat(service, { keep_copy: false, now: () => NOW });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([...result.limits].sort(), ['artifacts', 'journal', 'shadow_mirror', 'usage']);
  assert.equal(store.getSession(sessionId).messages.length, 0);
  assert.ok(calls.logs.some((entry) => entry.event === 'primary_chat.reset_replication_lag'));
  const failed = calls.logs.filter((entry) => entry.event === 'primary_chat.reset_step_failed');
  assert.ok(failed.length >= 3);
  assert.equal(JSON.stringify(calls.logs).includes('secret'), false, 'error text is never logged');
});

test('the shadow mirror is cleared when it holds the chat', async (t) => {
  const upserts = [];
  const { service, sessionId } = setup(t, {
    service: { shadowStore: { upsertSession: (id, patch, opts) => { upserts.push({ id, patch, opts }); return {}; } } },
  });
  const result = await resetPrimaryChat(service, { keep_copy: false, now: () => NOW });
  assert.deepEqual(result.limits, []);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].id, sessionId);
  assert.deepEqual(upserts[0].patch.messages, []);
  assert.equal(upserts[0].opts.allowCreate, false);
});

// Live 2026-10-27: a turn the app's restart paused (no checkpoint) blocked every reset. Its
// cancel proof needs the session actor idle, and the reset's own mutation kept it busy, so
// the wait always timed out. Real actor registry, runtime store, scheduler and chat adapter.
test('a turn a restart paused is cancelled and the reset succeeds', async (t) => {
  const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../services/session-runtime/lanes');
  const { SessionRuntimeScheduler } = require('../services/session-runtime/scheduler');
  const { SessionRuntimeService } = require('../services/session-runtime/service');
  const { RuntimeStore } = require('../services/session-runtime/store');
  const { SessionTurnActorRegistry } = require('../services/backend/session-turn-actor');
  const { SessionRuntimeChatAdapter } = require('../services/backend/session-runtime-chat-adapter');

  const { service, store, sessionId } = setup(t);
  const root = fs.mkdtempSync(path.join(service.options.userDataPath, 'runtime-'));
  let sequence = 0;
  const createId = (prefix) => `${prefix}_${++sequence}`;
  const before = new RuntimeStore(root, { createId });
  const submitted = before.submit({
    idempotencyKey: 'submit_prep', projectId: GENERAL_PROJECT_ID, sessionId, purpose: 'chat',
    input: { prompt: 'prepare a new chat' },
    authority: { project_id: GENERAL_PROJECT_ID, root_path: null, root_id: null, root_revision: 0, device_id: null, inode: null },
  }).record;
  before.transition(submitted.work_id, {
    expectedRevision: submitted.revision, to: 'running', reason: 'fixture',
    attempt: { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'host_1', authority_revision: 'authority_1' },
  });

  const runtimeStore = new RuntimeStore(root, { createId }); // the restart
  assert.equal(runtimeStore.get(submitted.work_id).status, 'paused');
  assert.equal(runtimeStore.get(submitted.work_id).recovery.kind, 'restart_paused');
  const lanes = new RuntimeLaneAdmission();
  service.sessionTurnActors = new SessionTurnActorRegistry();
  service.sessionExecutionAuthority = {};
  const adapter = new SessionRuntimeChatAdapter(service, {
    lanes, resourceBroker: {}, pathResolver: {}, checkpointStore: null,
  });
  const route = captureRuntimeRoute({ engine_type: 'mock', provider_id: 'mock',
    configuration_revision: 'config_1', resource_class: 'local', requires_gpu: false });
  const scheduler = new SessionRuntimeScheduler({
    store: runtimeStore, lanes, enabled: true, createId: () => createId('runtime'),
    resolveRoute: () => route, validateWork() {}, claimCanonical() { throw new Error('not dispatched'); },
    startProducer() { throw new Error('not dispatched'); },
    provePausedCleanup: (work, options) => adapter.provePausedCleanup(work, options),
  });
  const runtime = new SessionRuntimeService({ store: runtimeStore, scheduler, chatAdapter: { prepareImmediate() {} } });
  service.sessionRuntime = {
    cancelSessionAndWait: (id, opts) => runtime.cancelSessionAndWait(id, { ...opts, timeoutMs: 200 }),
  };

  const result = await resetPrimaryChat(service, { keep_copy: false, now: () => NOW });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(runtimeStore.get(submitted.work_id).status, 'cancelled');
  assert.equal(store.getSession(sessionId).messages.length, 0);
});

test('a runtime that cannot quiesce aborts the reset untouched', async (t) => {
  const { service, store, sessionId } = setup(t, { cancelResult: { ok: false, reason: 'timeout' } });
  const result = await resetPrimaryChat(service, { now: () => NOW });
  assert.deepEqual(result, { ok: false, reason: 'unavailable' });
  assert.equal(store.getSession(sessionId).messages.length, 4);
});

const MEMORIES = [
  { id: 11, project_id: GENERAL_PROJECT_ID, session_id: 'PRIMARY', scope_session_id: '' },
  { id: 12, project_id: 'project_alpha', session_id: 'sess_other', scope_session_id: 'PRIMARY' },
  { id: 13, project_id: GENERAL_PROJECT_ID, session_id: 'sess_other', scope_session_id: '' },
  { id: 14, project_id: 'project_beta', session_id: 'sess_other', scope_session_id: 'sess_other' },
];
const CANDIDATES = [
  { session_id: 'PRIMARY', content_fingerprint: 'a'.repeat(64), project_id: GENERAL_PROJECT_ID },
  { session_id: 'sess_other', content_fingerprint: 'b'.repeat(64), project_id: GENERAL_PROJECT_ID },
];

function withPrimaryId(rows, sessionId) {
  return rows.map((row) => ({
    ...row,
    session_id: row.session_id === 'PRIMARY' ? sessionId : row.session_id,
    ...(row.scope_session_id === 'PRIMARY' ? { scope_session_id: sessionId } : {}),
  }));
}

// The memory rows name the primary id, which exists only after the store is built.
function setupForget(t, extra = {}) {
  const memories = [];
  const candidates = [];
  const built = setup(t, { memories, candidates, ...extra });
  memories.push(...withPrimaryId(MEMORIES, built.sessionId));
  candidates.push(...withPrimaryId(CANDIDATES, built.sessionId));
  return built;
}

test('forget deletes only the primary memories and pending candidates; preview matches', async (t) => {
  const { service, store, sessionId, calls } = setupForget(t);
  assert.deepEqual(await forgetPreview(service), { ok: true, schema_version: 1, memories: 2, pending: 1 });
  assert.equal(rpcCount(calls, 'memory.delete'), 0, 'preview deletes nothing');

  const result = await resetPrimaryChat(service, { forget: true, keep_copy: false, now: () => NOW });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.forgotten, { memories: 2, pending: 1 });
  const deleted = calls.rpc.filter((entry) => entry.method === 'memory.delete')
    .map((entry) => [entry.params.memory_id, entry.params.project_id]);
  assert.deepEqual(deleted.sort(), [[11, GENERAL_PROJECT_ID], [12, 'project_alpha']]);
  const pending = calls.rpc.filter((entry) => entry.method === 'memory.pending.delete');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].params.session_id, sessionId);
  assert.equal(pending[0].params.content_fingerprint, 'a'.repeat(64));
  assert.equal(rpcCount(calls, 'memory.purge_session'), 0, 'purge_session is never sent');
  assert.deepEqual(calls.history, ['forgot']);
  assert.equal(calls.logs.find((entry) => entry.event === 'primary_chat.reset').details.forget, true);
  assert.equal(store.getSession(sessionId).messages.length, 0);
  // Forget runs after the index purge.
  const methods = calls.rpc.map((entry) => entry.method);
  // (the earlier preview listed once already, so look for a list after the purge)
  assert.ok(methods.indexOf('memory.list', methods.indexOf('conversations.purge')) > 0);
});

test('purgeSessionMemories is never called, even by a service that would count it', async (t) => {
  const memoryModule = require('../services/backend/backend-memory');
  const original = memoryModule.purgeSessionMemories;
  let purges = 0;
  memoryModule.purgeSessionMemories = (...args) => { purges += 1; return original(...args); };
  t.after(() => { memoryModule.purgeSessionMemories = original; });
  const { service, calls } = setupForget(t);
  await resetPrimaryChat(service, { forget: true, keep_copy: false, now: () => NOW });
  assert.equal(purges, 0);
  assert.equal(rpcCount(calls, 'memory.purge_session'), 0);
});

test('a memory deletion failure is reported in limits without failing the reset', async (t) => {
  const { service, calls } = setupForget(t);
  const request = service.sidecarClient.request;
  service.sidecarClient.request = async (method, params) => {
    if (method === 'memory.delete' && params.memory_id === 12) throw new Error('rpc down');
    return request(method, params);
  };
  const result = await resetPrimaryChat(service, { forget: true, keep_copy: false, now: () => NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.forgotten, { memories: 1, pending: 1 });
  assert.ok(result.limits.includes('memory'));
  assert.ok(calls.logs.some((entry) => entry.event === 'primary_chat.reset_step_failed' && entry.details.step === 'memory'));
});

test('forget is bounded at 500 memories per run', async (t) => {
  const memories = [];
  const built = setup(t, { memories });
  for (let id = 1; id <= 520; id += 1) {
    memories.push({ id, project_id: GENERAL_PROJECT_ID, session_id: built.sessionId, scope_session_id: '' });
  }
  const result = await resetPrimaryChat(built.service, { forget: true, keep_copy: false, now: () => NOW });
  assert.equal(result.forgotten.memories, 500);
  assert.equal(rpcCount(built.calls, 'memory.delete'), 500);
  assert.deepEqual(await forgetPreview(built.service), { ok: true, schema_version: 1, memories: 500, pending: 0 });
});

test('memory_opt_out writes the per-chat preference through the backend path and keeps the others', async (t) => {
  const { service, store, sessionId, calls } = setup(t);
  const before = store.getSession(sessionId).context_preferences;
  const result = await resetPrimaryChat(service, { memory_opt_out: true, keep_copy: false, now: () => NOW });
  assert.equal(result.ok, true);
  assert.equal(calls.prefs.length, 1);
  assert.equal(calls.prefs[0].id, sessionId);
  const after = store.getSession(sessionId).context_preferences;
  assert.equal(after.memory_opt_out, true);
  assert.deepEqual({ ...after, memory_opt_out: false }, { ...before, memory_opt_out: false });
});

test('a reset without opt-out leaves the preference alone', async (t) => {
  const { service, calls } = setup(t);
  await resetPrimaryChat(service, { keep_copy: false, now: () => NOW });
  assert.deepEqual(calls.prefs, []);
});
