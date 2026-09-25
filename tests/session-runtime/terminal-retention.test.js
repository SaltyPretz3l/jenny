'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RuntimeStore, createRuntimeStoreIO } = require('../../services/session-runtime/store');
const { validateWorkRecord } = require('../../services/session-runtime/contracts');
const { CheckpointStore } = require('../../services/session-runtime/checkpoint-store');
const { encodeContinuation } = require('../../services/session-runtime/continuation-contracts');
const { RETENTION_MS } = require('../../services/session-runtime/terminal-retention-contract');
const { collectRuntimeLedgerPayload, projectRuntimeLedgerPayload } = require('../../services/data-lifecycle/runtime-ledger-archive');
const { createAdapterHarness, AUTHORITY, continuationFixture } = require('../helpers/session-runtime-chat-adapter-harness');
const { initializeSessionRuntimeComposition } = require('../../services/session-runtime/composition');
const { ensureSessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');

const START = Date.parse('2026-08-01T00:00:00.000Z');
const attempt = { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'host_1', authority_revision: 'authority_1' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-terminal-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = START;
  const io = createRuntimeStoreIO();
  const store = new RuntimeStore(path.join(root, 'session-runtime'), { io, now: () => new Date(now) });
  function submission(id = '1', sessionId = 'session_1') {
    return { idempotencyKey: `send_${id}`, workId: `work_${id}`, turnId: `turn_${id}`,
      projectId: AUTHORITY.project_id, sessionId, purpose: 'chat', authority: AUTHORITY,
      input: { schema_version: 1, kind: 'immediate_chat', route: { configuration_revision: 'config:1' }, request: { sessionId, prompt: 'private request '.repeat(1000) } } };
  }
  function terminal(id = '1', status = 'completed', sessionId) {
    let work = store.submit(submission(id, sessionId)).record;
    if (status !== 'cancelled') work = store.transition(work.work_id, { expectedRevision: work.revision,
      to: 'running', reason: 'admitted', attempt }).record;
    return store.transition(work.work_id, { expectedRevision: work.revision, to: status,
      expectedAttempt: work.attempt, reason: 'producer_settled' }).record;
  }
  return { root, io, store, submission, terminal, age: (delta = RETENTION_MS) => { now = START + delta; } };
}

for (const status of ['completed', 'failed', 'cancelled']) test(`${status} retention preserves identity and original idempotency at the exact 30-day cutoff`, t => {
  const h = fixture(t);
  const original = h.terminal('1', status);
  h.age(RETENTION_MS - 1);
  assert.equal(h.store.compactTerminalDetail({ canCompact: () => true }).compacted, 0);
  h.age();
  const result = h.store.compactTerminalDetail({ canCompact: () => true });
  assert.equal(result.compacted, 1);
  assert.ok(result.saved_bytes > 10_000);
  const compacted = h.store.get(original.work_id);
  assert.equal(compacted.submission_hash, original.submission_hash);
  assert.deepEqual(compacted.transition, original.transition);
  assert.equal(compacted.input.kind, 'terminal_tombstone');
  assert.equal(compacted.input.original_input_bytes, original.input_bytes);
  assert.deepEqual(compacted.input.canonical_result_ref, status === 'cancelled' ? null
    : { session_id: original.session_id, turn_id: original.turn_id });
  assert.equal(compacted.revision, original.revision + 1);
  assert.equal(JSON.stringify(compacted).includes('private request'), false);
  const duplicate = h.store.submit(h.submission());
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.work_id, original.work_id);
  assert.throws(() => h.store.submit({ ...h.submission(), input: { prompt: 'different' } }), { code: 'idempotency_conflict' });
  assert.equal(h.store.compactTerminalDetail({ canCompact: () => true }).compacted, 0);
  const restarted = new RuntimeStore(h.store.root);
  assert.equal(restarted.getStatus().read_only, false);
  assert.deepEqual(restarted.get(original.work_id), compacted);
  assert.equal(restarted.submit(h.submission()).created, false);
  assert.throws(() => restarted.transition(original.work_id, { expectedRevision: compacted.revision,
    to: 'pending', reason: 'resume' }), { code: 'invalid_transition' });
});

test('scanning is bounded, skips pending input hydration and advances past retained evidence', t => {
  const h = fixture(t);
  h.store.submit(h.submission('pending'));
  h.terminal('old');
  h.terminal('later');
  h.age();
  const get = h.store.get.bind(h.store);
  h.store.get = id => { assert.notEqual(id, 'work_pending'); return get(id); };
  let proofCount = 0;
  const first = h.store.compactTerminalDetail({ limit: 2, canCompact: () => { proofCount++; return false; } });
  assert.equal(first.scanned, 2);
  assert.equal(first.compacted, 0);
  assert.equal(proofCount, 1);
  assert.equal(first.next_sequence, 2);
  const second = h.store.compactTerminalDetail({ limit: 2, afterSequence: first.next_sequence, canCompact: () => true });
  assert.equal(second.compacted, 1);
  assert.equal(second.next_sequence, 0);
  assert.equal(get('work_old').input.kind, 'immediate_chat');
});

test('checkpoint-backed and unresolved states never lose input or evidence', t => {
  const h = fixture(t);
  let work = h.store.submit(h.submission()).record;
  work = h.store.transition(work.work_id, { expectedRevision: work.revision, to: 'running', reason: 'start', attempt }).record;
  const ref = { schema_version: 1, checkpoint_id: 'checkpoint_1', bytes: 100,
    sha256: 'a'.repeat(64), source_attempt: attempt };
  work = h.store.transition(work.work_id, { expectedRevision: work.revision, to: 'paused',
    reason: 'checkpoint_suspended', expectedAttempt: attempt, checkpointRef: ref }).record;
  h.age();
  assert.equal(h.store.compactTerminalDetail({ canCompact: () => { throw new Error('must not consult'); } }).compacted, 0);
  work = h.store.transition(work.work_id, { expectedRevision: work.revision, to: 'cancelled', reason: 'cancel' }).record;
  h.age(2 * RETENTION_MS);
  assert.equal(h.store.compactTerminalDetail({ canCompact: () => true }).compacted, 0);
  assert.deepEqual(h.store.get(work.work_id).checkpoint_ref, ref);
  assert.equal(h.store.get(work.work_id).input.request.prompt, h.submission().input.request.prompt);
});

test('missing, failed, or asynchronous proof retains detail', t => {
  const h = fixture(t);
  h.terminal();
  h.age();
  assert.throws(() => h.store.compactTerminalDetail(), { code: 'retention_request_invalid' });
  for (const canCompact of [() => false, () => null, () => Promise.resolve(true), () => { throw new Error('unavailable'); }]) {
    assert.equal(h.store.compactTerminalDetail({ canCompact }).compacted, 0);
  }
  assert.equal(h.store.get('work_1').input.kind, 'immediate_chat');
});

test('tombstones have a closed versioned shape and cannot be submitted or changed to live work', t => {
  const h = fixture(t);
  h.terminal(); h.age(); h.store.compactTerminalDetail({ canCompact: () => true });
  const work = h.store.get('work_1');
  for (const input of [{ ...work.input, schema_version: 2 }, { ...work.input, extra: true },
    { ...work.input, canonical_result_ref: { session_id: 'other', turn_id: work.turn_id } },
    { ...work.input, original_input_bytes: -1 }]) {
    assert.equal(validateWorkRecord({ ...work, input, input_bytes: Buffer.byteLength(JSON.stringify(input)) }).ok, false);
  }
  assert.equal(validateWorkRecord({ ...work, status: 'paused', transition: { ...work.transition, to: 'paused' } }).ok, false);
  assert.throws(() => h.store.submit({ ...h.submission('other'), input: work.input }), { code: 'invalid_submission_input' });
});

for (const boundary of ['journal', 'record', 'index', 'remove']) test(`retention repairs a crash after ${boundary} publication without losing identity`, t => {
  const h = fixture(t);
  const original = h.terminal(); h.age();
  const write = h.io.writeJsonAtomic;
  const remove = h.io.remove;
  let failed = false;
  // The production IO object is frozen; replace only the store's injected port.
  h.store.io = { ...h.io, writeJsonAtomic(file, value) {
    write(file, value);
    const hit = boundary === 'journal' ? file === h.store.journalPath
      : boundary === 'record' ? file.endsWith(`${original.work_id}.json`)
        : boundary === 'index' && file === h.store.indexPath;
    if (hit && !failed) { failed = true; throw new Error('injected interruption'); }
  }, remove(file) {
    if (boundary === 'remove' && !failed) { failed = true; throw new Error('injected interruption'); }
    remove(file);
  } };
  if (boundary === 'remove') {
    // A failed journal removal after a complete commit is not a failed write: the
    // store stays writable and the stale journal is reconciled on restart.
    h.store.compactTerminalDetail({ canCompact: () => true });
    assert.equal(h.store.getStatus().read_only, false);
    assert.equal(fs.existsSync(h.store.journalPath), true);
  } else {
    assert.throws(() => h.store.compactTerminalDetail({ canCompact: () => true }), { code: 'write_failed' });
    // The published journal was replayed in place, so the live store already
    // holds the repaired tombstone and stays writable.
    assert.equal(h.store.getStatus().read_only, false);
    assert.equal(h.store.get(original.work_id).input.kind, 'terminal_tombstone');
    assert.equal(fs.existsSync(h.store.journalPath), false);
  }
  const restarted = new RuntimeStore(h.store.root);
  assert.equal(restarted.getStatus().read_only, false);
  const work = restarted.get(original.work_id);
  assert.equal(work.input.kind, 'terminal_tombstone');
  assert.equal(work.submission_hash, original.submission_hash);
  assert.equal(work.status, 'completed');
  assert.equal(restarted.submit(h.submission()).created, false);
  assert.equal(fs.existsSync(restarted.journalPath), false);
});

test('portable archive round trip preserves terminal tombstones and never restores executable input', t => {
  const h = fixture(t);
  h.terminal(); h.age(); h.store.compactTerminalDetail({ canCompact: () => true });
  const payload = collectRuntimeLedgerPayload(h.root);
  const projection = projectRuntimeLedgerPayload(payload);
  const restoredRoot = path.join(h.root, 'restored');
  for (const file of projection.files) {
    const target = path.join(restoredRoot, file.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.bytes);
  }
  const restored = new RuntimeStore(restoredRoot);
  assert.equal(restored.getStatus().read_only, false);
  assert.equal(restored.get('work_1').input.kind, 'terminal_tombstone');
  assert.equal(restored.submit(h.submission()).created, false);
  assert.deepEqual(restored.get('work_1').input.canonical_result_ref,
    { session_id: 'session_1', turn_id: 'turn_1' });
});

function productionFixture(t) {
  const h = fixture(t);
  const adapter = createAdapterHarness(t);
  const work = h.terminal('1', 'completed', adapter.sessionId);
  adapter.service.sessionStore.appendMessage(adapter.sessionId, {
    id: 'answer_1', role: 'assistant', content: 'canonical result', turn_id: work.turn_id });
  adapter.service.sessionStore.flushSession(adapter.sessionId);
  adapter.service.options = { userDataPath: h.root };
  adapter.service.featureFlags.session_runtime = true;
  const entries = [];
  adapter.service.turnEventJournal = { list: () => entries };
  ensureSessionTurnActorRegistry(adapter.service);
  return { ...h, ...adapter, work, entries };
}

test('production startup compacts old durable results and preserves the canonical transcript', t => {
  const h = productionFixture(t);
  const runtime = initializeSessionRuntimeComposition(h.service);
  assert.equal(runtime.store.get(h.work.work_id).input.kind, 'terminal_tombstone');
  assert.equal(h.service.sessionStore.getSession(h.sessionId).messages.at(-1).content, 'canonical result');
  assert.equal(runtime.lanes.snapshot().active_leases, 0);
});

for (const blocker of ['journal', 'dirty', 'actor', 'missing_result']) test(`production retains detail when ${blocker} proof is unresolved`, t => {
  const h = productionFixture(t);
  if (blocker === 'journal') h.entries.push({ event: 'unsettled' });
  if (blocker === 'dirty') h.service.sessionStore.hasPendingWrites = () => true;
  if (blocker === 'actor') h.service.sessionTurnActors.getQueuedSubmissionBlock = () => 'session_busy';
  if (blocker === 'missing_result') h.service.sessionStore.updateSession(h.sessionId, { messages: [] });
  const runtime = initializeSessionRuntimeComposition(h.service);
  assert.equal(runtime.store.get(h.work.work_id).input.kind, 'immediate_chat');
});

test('a new Send triggers bounded maintenance after canonical journal settlement', async t => {
  const h = productionFixture(t);
  h.entries.push({ event: 'unsettled' });
  const runtime = initializeSessionRuntimeComposition(h.service);
  assert.equal(runtime.store.get(h.work.work_id).input.kind, 'immediate_chat');
  h.entries.length = 0;
  // Keep the newly submitted turn pending; maintenance must not need a producer.
  const original = runtime.scheduler.notifyLaneAvailability;
  runtime.scheduler.notifyLaneAvailability = () => {};
  const submitted = await runtime.submit({ sessionId: h.sessionId, prompt: 'next' }, { idempotencyKey: 'next' });
  assert.equal(submitted.status, 'pending');
  assert.equal(runtime.store.get(h.work.work_id).input.kind, 'terminal_tombstone');
  await new Promise(resolve => setImmediate(resolve));
  runtime.scheduler.notifyLaneAvailability = original;
});

for (const olderAttempt of [false, true]) test(`failed publication retains preparing checkpoint context (${olderAttempt ? 'older' : 'current'} attempt)`, t => {
  const h = productionFixture(t);
  const work = olderAttempt ? { ...h.work, attempt: { ...h.work.attempt,
    attempt_id: 'older_attempt', stream_id: 'older_stream' } } : h.work;
  const checkpoints = new CheckpointStore(path.join(h.root, 'session-runtime-checkpoints'), {
    validateCanonical: () => null });
  const proposal = continuationFixture(work, 'checkpoint_orphan', 'user_1');
  delete proposal._userMessageId;
  const body = encodeContinuation(proposal).body;
  const ref = checkpoints.begin(body, work, { canonicalBytes: 128 });
  assert.throws(() => checkpoints.commit(ref, work), /checkpoint_canonical_unavailable/);
  assert.equal(checkpoints.snapshot().preparing_count, 1);
  const runtime = initializeSessionRuntimeComposition(h.service);
  assert.equal(runtime.store.get(h.work.work_id).checkpoint_ref, null);
  assert.equal(runtime.store.get(h.work.work_id).input.kind, 'immediate_chat');
  assert.equal(runtime.checkpointStore.canDiscardWorkContext(h.work.work_id), false);
  assert.equal(runtime.checkpointStore.snapshot().preparing_count, 1);
});

test('unreadable checkpoint inventory blocks retention even without an attached reference', t => {
  const h = productionFixture(t);
  const root = path.join(h.root, 'session-runtime-checkpoints');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'unresolved.json'), '{future}');
  const runtime = initializeSessionRuntimeComposition(h.service);
  assert.equal(runtime.checkpointStore.snapshot().read_only, true);
  assert.equal(runtime.store.get(h.work.work_id).input.kind, 'immediate_chat');
  assert.equal(fs.readFileSync(path.join(root, 'unresolved.json'), 'utf8'), '{future}');
});

test('an orphan checkpoint does not strand retention of later independent terminal work', t => {
  const h = productionFixture(t);
  const later = h.terminal('later', 'completed', h.sessionId);
  h.service.sessionStore.appendMessage(h.sessionId, { id: 'answer_later', role: 'assistant',
    content: 'Later result', turn_id: later.turn_id });
  h.service.sessionStore.flushSession(h.sessionId);
  const checkpoints = new CheckpointStore(path.join(h.root, 'session-runtime-checkpoints'), { validateCanonical: () => null });
  const proposal = continuationFixture(h.work, 'checkpoint_orphan', 'user_1');
  delete proposal._userMessageId;
  checkpoints.begin(encodeContinuation(proposal).body, h.work, { canonicalBytes: 128 });
  const runtime = initializeSessionRuntimeComposition(h.service);
  assert.equal(runtime.store.get(h.work.work_id).input.kind, 'immediate_chat');
  assert.equal(runtime.store.get(later.work_id).input.kind, 'terminal_tombstone');
  assert.equal(runtime.checkpointStore.snapshot().preparing_count, 1);
});
