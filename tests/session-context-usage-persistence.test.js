'use strict';

/**
 * R9: per-session persistence of the last authoritative context-usage reading
 * (composer context-ring cold-reopen seed).
 *
 * 1. a terminal chat.done usage normalizes into `context_usage`, survives a
 *    store reload, and reaches the renderer through the session summary;
 * 2. malformed / non-authoritative readings fail closed to "no seed" instead
 *    of persisting a half-populated row;
 * 3. history rewrites (truncate, edit-and-resend, replaceMessages) drop the
 *    seed, and a branched session never inherits one;
 * 4. a session persisted before the field existed, and a session whose
 *    persisted record is corrupt, both load as "no seed" without crashing.
 *
 * Static-literal requires (the source->test existence gate walks this graph).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ElectronSessionStore,
  deriveSessionsDirectory,
} = require('../services/backend/electron-session-store');
const { forkSession } = require('../services/backend/session-branching');
const { rebuildChatDoneUsage } = require('../services/backend/chat-stream-usage');
const {
  buildSessionContextUsageRecord,
  normalizeSessionContextUsage,
} = require('../services/backend/session-context-usage');
const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');
const {
  makeCtx,
  makeHandleToolNotification,
  callsOf,
} = require('./helpers/managed-runtime-notification-harness');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createStore(tmpRoot) {
  return new ElectronSessionStore(path.join(tmpRoot, 'sessions.json'));
}

function makeRoot(label) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-ctxusage-${label}-`));
  trackDirectory(tmpRoot);
  return tmpRoot;
}

function seedStore(store, sessionId) {
  store.createSessionWithId(sessionId, { title: 'Context Usage Store' });
  store.appendMessage(sessionId, { id: 'u1', role: 'user', content: 'first question' });
  store.appendMessage(sessionId, { id: 'a1', role: 'assistant', content: 'first answer' });
  store.appendMessage(sessionId, { id: 'u2', role: 'user', content: 'second question' });
  store.appendMessage(sessionId, { id: 'a2', role: 'assistant', content: 'second answer' });
}

// Shaped like a real terminal chat.done usage block (post-commit-1: the
// sidecar already resolved context_used_tokens/context_used_source).
const TERMINAL_USAGE = Object.freeze({
  input_tokens: 900,
  output_tokens: 120,
  total_tokens: 1020,
  context_used_tokens: 42000,
  context_used_source: 'estimate',
  context_tokens_estimate: 42000,
  last_request_input_tokens: 900,
  context_window: 131072,
  compact_threshold_tokens: 61000,
  model: 'qwen',
  provider: 'ollama',
});

function terminalRecord(overrides = {}) {
  return buildSessionContextUsageRecord(
    { ...TERMINAL_USAGE, ...overrides },
    { updatedAt: '2026-08-29T12:00:00.000Z' }
  );
}

test('a terminal usage reading persists as a normalized record, reloads, and reaches the summary', () => {
  const tmpRoot = makeRoot('persist');
  const store = createStore(tmpRoot);
  seedStore(store, 'sess-seed');

  const summary = store.setSessionContextUsage('sess-seed', terminalRecord());
  assert.ok(summary, 'the write path returns the updated summary');
  assert.deepEqual(summary.context_usage, {
    version: 1,
    used_tokens: 42000,
    context_window: 131072,
    compact_threshold_tokens: 61000,
    model: 'qwen',
    usage_source: 'estimate',
    updated_at: '2026-08-29T12:00:00.000Z',
  });
  // The summary is the renderer's only view of the record: the raw usage block
  // (cost, provider, per-turn token counts) must not ride along with it.
  assert.equal(Object.hasOwn(summary.context_usage, 'cost_usd'), false);
  assert.equal(Object.hasOwn(summary.context_usage, 'provider'), false);
  assert.equal(Object.hasOwn(summary.context_usage, 'input_tokens'), false);

  store.flush();
  store.dispose();

  const reloaded = createStore(tmpRoot);
  assert.deepEqual(
    reloaded.getSession('sess-seed').context_usage,
    terminalRecord(),
    'the seed survives the reopen it exists for'
  );
  assert.equal(reloaded.listSessions()[0].context_usage.used_tokens, 42000);
  reloaded.dispose();
});

test('buildSessionContextUsageRecord keeps the sidecar max and refuses non-authoritative readings', () => {
  // KV-cache undercount: the provider counts only newly evaluated tokens, so
  // the sidecar estimate is the truthful occupancy (cause C of the accuracy work).
  const kvCache = terminalRecord();
  assert.equal(kvCache.used_tokens, 42000);
  assert.equal(kvCache.usage_source, 'estimate');

  // Older payloads that predate context_used_tokens reconstruct the same max.
  const legacy = buildSessionContextUsageRecord({
    context_tokens_estimate: 42000,
    last_request_input_tokens: 900,
    context_window: 131072,
    compact_threshold_tokens: 61000,
    model: 'qwen',
  });
  assert.equal(legacy.used_tokens, 42000);
  assert.equal(legacy.usage_source, 'estimate');

  const providerTruth = buildSessionContextUsageRecord({
    context_tokens_estimate: 900,
    last_request_input_tokens: 42000,
    context_window: 131072,
  });
  assert.equal(providerTruth.used_tokens, 42000);
  assert.equal(providerTruth.usage_source, 'provider');

  assert.equal(buildSessionContextUsageRecord(null), null);
  assert.equal(buildSessionContextUsageRecord('nope'), null);
  assert.equal(buildSessionContextUsageRecord({}), null, 'no numerator => no seed');
  assert.equal(
    buildSessionContextUsageRecord({ context_used_tokens: 42000, model: 'qwen' }),
    null,
    'no denominator => no seed'
  );
  assert.equal(
    buildSessionContextUsageRecord(rebuildChatDoneUsage({ input_tokens: 10, output_tokens: 20 })),
    null,
    'a turn that reported no context occupancy never seeds the ring'
  );
});

test('normalizeSessionContextUsage fails closed on malformed shapes', () => {
  assert.equal(normalizeSessionContextUsage(null), null);
  assert.equal(normalizeSessionContextUsage([]), null);
  assert.equal(normalizeSessionContextUsage('1'), null);
  assert.equal(normalizeSessionContextUsage({ ...terminalRecord(), version: 2 }), null);
  assert.equal(normalizeSessionContextUsage({ ...terminalRecord(), version: undefined }), null);
  assert.equal(normalizeSessionContextUsage({ ...terminalRecord(), used_tokens: 0 }), null);
  assert.equal(normalizeSessionContextUsage({ ...terminalRecord(), used_tokens: -5 }), null);
  assert.equal(normalizeSessionContextUsage({ ...terminalRecord(), used_tokens: 'lots' }), null);
  assert.equal(normalizeSessionContextUsage({ ...terminalRecord(), usage_source: 'guess' }), null);
  assert.equal(
    normalizeSessionContextUsage({
      ...terminalRecord(), context_window: 0, compact_threshold_tokens: 0,
    }),
    null
  );

  // A threshold-only reading is still seedable (the threshold is the ring's
  // denominator); a window-only one seeds the numerator floor alone.
  assert.equal(
    normalizeSessionContextUsage({ ...terminalRecord(), context_window: -1 }).context_window,
    0
  );
  assert.equal(
    normalizeSessionContextUsage({ ...terminalRecord(), compact_threshold_tokens: 0 })
      .compact_threshold_tokens,
    0
  );

  const coerced = normalizeSessionContextUsage({
    ...terminalRecord(),
    used_tokens: 4200.7,
    compact_threshold_tokens: '61000',
    model: '  qwen  ',
    unknown_field: 'dropped',
  });
  assert.equal(coerced.used_tokens, 4200, 'fractional counts floor rather than persisting');
  assert.equal(coerced.compact_threshold_tokens, 61000);
  assert.equal(coerced.model, 'qwen');
  assert.equal(Object.hasOwn(coerced, 'unknown_field'), false, 'unknown fields are dropped');
});

test('history rewrites drop the seed; a streaming commit on the live turn keeps it', () => {
  const tmpRoot = makeRoot('invalidate');
  const store = createStore(tmpRoot);

  // Truncate: the measured history no longer exists.
  seedStore(store, 'sess-trunc');
  store.setSessionContextUsage('sess-trunc', terminalRecord());
  assert.ok(store.truncateAfterMessage('sess-trunc', 'u2'));
  assert.equal(store.getSession('sess-trunc').context_usage, null);

  // Edit-and-resend rewrites the surviving target through the same seam.
  seedStore(store, 'sess-edit');
  store.setSessionContextUsage('sess-edit', terminalRecord());
  assert.ok(store.truncateAfterMessage('sess-edit', 'u2', {
    replaceMessageContent: 'second question, edited',
  }));
  assert.equal(store.getSession('sess-edit').context_usage, null);

  // A wholesale message replacement invalidates too.
  seedStore(store, 'sess-replace');
  store.setSessionContextUsage('sess-replace', terminalRecord());
  store.replaceMessages('sess-replace', [{ id: 'x1', role: 'user', content: 'new history' }]);
  assert.equal(store.getSession('sess-replace').context_usage, null);

  // updateMessage is the LIVE streaming commit path (segments, tool rows,
  // terminal settlement all run through it after chat.done). Treating it as an
  // invalidation seam would erase the seed the same turn wrote, so it is
  // deliberately not one; the user-facing edit flow truncates instead.
  seedStore(store, 'sess-stream');
  store.setSessionContextUsage('sess-stream', terminalRecord());
  assert.ok(store.updateMessage('sess-stream', 'a2', { content: 'second answer, streamed more' }));
  assert.ok(store.getSession('sess-stream').context_usage, 'the live turn keeps its own seed');
  store.dispose();
});

test('a branched session never inherits the source seed', () => {
  const tmpRoot = makeRoot('branch');
  const store = createStore(tmpRoot);
  seedStore(store, 'sess-branch-src');
  store.setSessionContextUsage('sess-branch-src', terminalRecord());

  const branch = forkSession(store, 'sess-branch-src', 'a2');
  assert.ok(branch, 'fork must succeed');
  assert.equal(store.getSession(branch.id).context_usage, null);
  assert.ok(store.getSession('sess-branch-src').context_usage, 'the source keeps its seed');
  store.dispose();
});

test('a session persisted without the field, or with a corrupt one, loads as "no seed"', () => {
  const tmpRoot = makeRoot('legacy');
  const store = createStore(tmpRoot);
  seedStore(store, 'sess-legacy');
  seedStore(store, 'sess-corrupt');
  store.setSessionContextUsage('sess-corrupt', terminalRecord());
  store.flush();
  store.dispose();

  // Rewrite both persisted records the way an older build (no field at all)
  // and a hand-edited/partially-written store (wrong types) would look.
  const sessionsDir = deriveSessionsDirectory(path.join(tmpRoot, 'sessions.json'));
  const legacyPath = path.join(sessionsDir, 'sess-legacy.json');
  const corruptPath = path.join(sessionsDir, 'sess-corrupt.json');
  const legacyRaw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  const corruptRaw = JSON.parse(fs.readFileSync(corruptPath, 'utf8'));
  const legacyRecord = legacyRaw.session || legacyRaw;
  const corruptRecord = corruptRaw.session || corruptRaw;
  assert.equal(legacyRecord.context_usage, null, 'a turn-less session persists no seed');
  delete legacyRecord.context_usage;
  corruptRecord.context_usage = {
    version: '1',
    used_tokens: 'lots',
    context_window: null,
    compact_threshold_tokens: [],
    model: { name: 'qwen' },
    usage_source: 'guess',
  };
  fs.writeFileSync(legacyPath, JSON.stringify(legacyRaw), 'utf8');
  fs.writeFileSync(corruptPath, JSON.stringify(corruptRaw), 'utf8');

  const reloaded = createStore(tmpRoot);
  const legacySession = reloaded.getSession('sess-legacy');
  assert.ok(legacySession, 'an older record still loads');
  assert.equal(legacySession.context_usage, null);
  assert.equal(legacySession.messages.length, 4, 'the rest of the record is untouched');
  const corruptSession = reloaded.getSession('sess-corrupt');
  assert.ok(corruptSession, 'a corrupt seed does not take the session down with it');
  assert.equal(corruptSession.context_usage, null);
  assert.equal(corruptSession.messages.length, 4);
  // A fresh authoritative reading re-seeds a session that dropped a bad one.
  assert.ok(reloaded.setSessionContextUsage('sess-corrupt', terminalRecord()));
  assert.equal(reloaded.getSession('sess-corrupt').context_usage.used_tokens, 42000);
  reloaded.dispose();
});

// ---------------------------------------------------------------------------
// Write seam: the chat.done branch of the managed notification dispatcher
// ---------------------------------------------------------------------------

// Only the TERMINAL reading is persisted. Mid-turn context.usage is ephemeral
// by contract, so a long agentic turn that never completes must leave the last
// completed turn's seed on disk untouched.
function withSessionContextUsageRecorder(ctx) {
  const writes = [];
  ctx.service.sessionStore = {
    setSessionContextUsage(sessionId, record) {
      writes.push({ sessionId, record });
      return { id: sessionId, context_usage: record };
    },
  };
  return writes;
}

function notifyDone(ctx, usage) {
  handleNotification(
    ctx,
    { method: 'chat.done', params: { stop_reason: 'end_turn', usage } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );
}

test('chat.done persists the terminal usage as the session context-usage seed', () => {
  const ctx = makeCtx();
  const writes = withSessionContextUsageRecorder(ctx);

  notifyDone(ctx, { ...TERMINAL_USAGE });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].sessionId, 'session-1');
  assert.equal(writes[0].record.version, 1);
  assert.equal(writes[0].record.used_tokens, 42000);
  assert.equal(writes[0].record.compact_threshold_tokens, 61000);
  assert.equal(writes[0].record.context_window, 131072);
  assert.equal(writes[0].record.model, 'qwen');
  assert.equal(writes[0].record.usage_source, 'estimate');
  assert.ok(writes[0].record.updated_at, 'the seed is stamped when it is written');
});

test('mid-turn context.usage never persists a session context-usage seed', () => {
  const ctx = makeCtx();
  const writes = withSessionContextUsageRecorder(ctx);

  handleNotification(
    ctx,
    { method: 'context.usage', params: { phase: 'iteration', iteration: 3, ...TERMINAL_USAGE } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(callsOf(ctx, 'emitChatStream').length, 1, 'the ring still moves mid-turn');
  assert.deepEqual(writes, [], 'an ephemeral snapshot is never durable');
});

test('a chat.done with no context occupancy leaves the persisted seed alone', () => {
  const ctx = makeCtx();
  const writes = withSessionContextUsageRecorder(ctx);

  notifyDone(ctx, { input_tokens: 10, output_tokens: 20, total_tokens: 30 });

  assert.ok(ctx.turnUsage, 'the turn still reports its usage to the renderer');
  assert.deepEqual(writes, [], 'a non-authoritative reading must not overwrite a good seed');
});

test('chat.done stays on its terminal path when the session store rejects the seed', () => {
  const ctx = makeCtx();
  ctx.streamSawText = true;
  ctx.service.sessionStore = {
    setSessionContextUsage() {
      throw new Error('disk full');
    },
  };

  notifyDone(ctx, { ...TERMINAL_USAGE });

  assert.equal(ctx.streamSawDone, true, 'a failed seed write must not break the turn');
  assert.equal(callsOf(ctx, 'beginVisibleCompletionFinalization').length, 1);
  const warns = callsOf(ctx, 'serviceLog')
    .filter((entry) => entry.code === 'chat.context_usage_not_persisted');
  assert.equal(warns.length, 1, 'the degradation is observable');
  assert.equal(warns[0].fields.reason, 'persistence_exception');
});
