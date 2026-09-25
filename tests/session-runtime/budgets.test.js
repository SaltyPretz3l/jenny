'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_OPERATIONS_PER_ROOT,
  RootRunBudgetStore,
} = require('../../services/session-runtime/budgets');
const { createRuntimeStoreIO } = require('../../services/session-runtime/store');

const FINGERPRINT = 'a'.repeat(64);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function clock() {
  let time = Date.parse('2026-09-09T00:00:00.000Z');
  return () => new Date(time += 1000);
}

function creation(overrides = {}) {
  return {
    rootRunId: 'root_run_1',
    authorityFingerprint: FINGERPRINT,
    allowedProviderIds: ['ollama', 'openai'],
    limits: { inference_requests: 4, input_tokens: 400, output_tokens: 200 },
    ...overrides,
  };
}

function reservation(overrides = {}) {
  return {
    rootRunId: 'root_run_1',
    workId: 'work_1',
    attemptId: 'attempt_1',
    operationId: 'operation_1',
    providerId: 'ollama',
    maxima: { inference_requests: 1, input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

function settlement(overrides = {}) {
  return {
    rootRunId: 'root_run_1',
    workId: 'work_1',
    attemptId: 'attempt_1',
    operationId: 'operation_1',
    consumption: 'known',
    usage: { inference_requests: 1, input_tokens: 75, output_tokens: 25 },
    ...overrides,
  };
}

function ownerDirectory(root, rootRunId) {
  return path.join(root, createHash('sha256').update(rootRunId).digest('hex'));
}

function faultingIO() {
  const base = createRuntimeStoreIO();
  let failure = null;
  return {
    ...base,
    failOnce(position) { failure = position; },
    writeJsonAtomic(filePath, value) {
      if (failure === 'before') {
        failure = null;
        throw new Error('before write');
      }
      base.writeJsonAtomic(filePath, value);
      if (failure === 'after') {
        failure = null;
        throw new Error('after write');
      }
    },
  };
}

test('create is durable, exact, idempotent, and never implicit', t => {
  const root = makeRoot(t);
  const store = new RootRunBudgetStore(root, { now: clock() });

  assert.throws(() => store.get('root_run_1'), { code: 'budget_not_found' });
  const first = store.create(creation({ allowedProviderIds: ['openai', 'ollama'] }));
  assert.equal(first.created, true);
  assert.deepEqual(first.record.allowed_provider_ids, ['ollama', 'openai']);
  assert.equal(store.create(creation()).created, false);
  assert.throws(() => store.create(creation({ authorityFingerprint: 'b'.repeat(64) })),
    { code: 'budget_root_id_conflict' });
  assert.equal(store.snapshot().root_record_count, 1);
  assert.deepEqual(store.inspect('root_run_1').reservations, []);
});

test('restart sweeps stale atomic-write temp files without blocking budget use', t => {
  const root = makeRoot(t);
  const first = new RootRunBudgetStore(root, { now: clock() });
  const created = first.create(creation()).record;
  const temp = path.join(ownerDirectory(root, 'root_run_1'),
    '.runtime-deadbeefdeadbeefdeadbeef.tmp');
  fs.writeFileSync(temp, 'stale');

  const reopened = new RootRunBudgetStore(root, { now: clock() });
  assert.equal(reopened.snapshot().read_only, false);
  assert.deepEqual(reopened.get('root_run_1'), created);
  assert.equal(fs.existsSync(temp), false);
  assert.equal(reopened.reserve(reservation()).created, true);
});

test('case-distinct root IDs use distinct hash-owned directories', t => {
  const root = makeRoot(t);
  const store = new RootRunBudgetStore(root, { now: clock() });
  store.create(creation());
  store.create(creation({ rootRunId: 'ROOT_RUN_1' }));

  assert.equal(store.get('root_run_1').root_run_id, 'root_run_1');
  assert.equal(store.get('ROOT_RUN_1').root_run_id, 'ROOT_RUN_1');
  assert.notEqual(ownerDirectory(root, 'root_run_1'), ownerDirectory(root, 'ROOT_RUN_1'));
  assert.equal(fs.readdirSync(root).length, 2);
});

test('a write failure blocks the owner until exact before/after state is recovered', t => {
  const root = makeRoot(t);
  const io = faultingIO();
  const store = new RootRunBudgetStore(root, { io, now: clock() });
  io.failOnce('before');
  assert.throws(() => store.create(creation()), { code: 'budget_write_uncertain' });
  assert.equal(store.snapshot().read_only, true);
  assert.throws(() => store.reserve(reservation()), { code: 'budget_write_uncertain' });

  const recovered = store.recover();
  assert.equal(recovered.read_only, false);
  assert.equal(store.get('root_run_1').revision, 1);

  io.failOnce('before');
  assert.throws(() => store.reserve(reservation()), { code: 'budget_write_uncertain' });
  store.recover();
  assert.equal(store.inspect('root_run_1').reservation_count, 0);
  assert.equal(store.reserve(reservation()).created, true);
});

test('restart after a pre-write create crash preserves the unresolved owner directory', t => {
  const root = makeRoot(t);
  const io = faultingIO();
  const first = new RootRunBudgetStore(root, { io, now: clock() });
  io.failOnce('before');
  assert.throws(() => first.create(creation()), { code: 'budget_write_uncertain' });

  const directory = ownerDirectory(root, 'root_run_1');
  assert.deepEqual(fs.readdirSync(directory), []);
  const reopened = new RootRunBudgetStore(root, { now: clock() });
  assert.equal(reopened.snapshot().read_only, true);
  assert.equal(reopened.snapshot().reason, 'budget_entry_unresolved');
  assert.throws(() => reopened.create(creation()), { code: 'budget_entry_unresolved' });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('recovery must persist known settlement overage before admitting any later reservation', t => {
  const root = makeRoot(t);
  const io = faultingIO();
  const store = new RootRunBudgetStore(root, { io, now: clock() });
  store.create(creation({ limits: { inference_requests: 4, input_tokens: 100, output_tokens: 200 } }));
  store.reserve(reservation({ maxima: { inference_requests: 1, input_tokens: 50, output_tokens: 50 } }));
  io.failOnce('before');
  assert.throws(() => store.settle(settlement({
    usage: { inference_requests: 1, input_tokens: 150, output_tokens: 25 },
  })), { code: 'budget_write_uncertain' });
  io.failOnce('before');
  assert.throws(() => store.recover(), { code: 'budget_recovery_failed' });
  assert.equal(store.snapshot().read_only, true);
  store.recover();
  assert.equal(store.get('root_run_1').charged.input_tokens, 150);
  assert.equal(store.get('root_run_1').over_limit, true);
  assert.throws(() => store.reserve(reservation({ operationId: 'operation_2',
    maxima: { inference_requests: 1, input_tokens: 50, output_tokens: 25 } })), { code: 'budget_exhausted' });
  assert.equal(new RootRunBudgetStore(root).get('root_run_1').charged.input_tokens, 150);
});

test('restart observes an after-write commit and conservatively charges held reservations', t => {
  const root = makeRoot(t);
  const io = faultingIO();
  const first = new RootRunBudgetStore(root, { io, now: clock() });
  first.create(creation());
  io.failOnce('after');
  assert.throws(() => first.reserve(reservation()), { code: 'budget_write_uncertain' });
  assert.equal(first.snapshot().read_only, true);

  const reopened = new RootRunBudgetStore(root, { now: clock() });
  const inspected = reopened.inspect('root_run_1');
  assert.equal(inspected.unresolved_reservation_count, 1);
  assert.deepEqual(inspected.charged,
    { inference_requests: 1, input_tokens: 100, output_tokens: 50 });
});

test('duplicate reserve and settlement are idempotent while conflicts fail closed', t => {
  const store = new RootRunBudgetStore(makeRoot(t), { now: clock() });
  store.create(creation());
  assert.equal(store.reserve(reservation()).created, true);
  assert.equal(store.reserve(reservation()).created, false);
  assert.throws(() => store.reserve(reservation({ workId: 'work_other' })),
    { code: 'budget_reservation_conflict' });
  assert.throws(() => store.reserve(reservation({
    maxima: { inference_requests: 2, input_tokens: 100, output_tokens: 50 },
  })), { code: 'budget_reservation_invalid' });

  assert.equal(store.settle(settlement()).changed, true);
  assert.equal(store.settle(settlement()).changed, false);
  assert.equal(store.reserve(reservation()).created, false);
  assert.throws(() => store.settle(settlement({
    usage: { inference_requests: 1, input_tokens: 76, output_tokens: 25 },
  })), { code: 'budget_settlement_conflict' });
});

test('unknown consumption retains the full reservation charge across restart', t => {
  const root = makeRoot(t);
  const first = new RootRunBudgetStore(root, { now: clock() });
  first.create(creation());
  first.reserve(reservation());
  first.settle(settlement({ consumption: 'unknown', usage: null }));

  const reopened = new RootRunBudgetStore(root, { now: clock() });
  const inspected = reopened.inspect('root_run_1');
  assert.equal(inspected.unresolved_reservation_count, 0);
  assert.equal(inspected.unknown_consumption_count, 1);
  assert.deepEqual(inspected.charged,
    { inference_requests: 1, input_tokens: 100, output_tokens: 50 });
});

test('provider rejection, exhausted limits, and actual overage stop later dispatch', t => {
  const store = new RootRunBudgetStore(makeRoot(t), { now: clock() });
  store.create(creation({
    allowedProviderIds: ['ollama'],
    limits: { inference_requests: 3, input_tokens: 100, output_tokens: 100 },
  }));
  assert.throws(() => store.reserve(reservation({ providerId: 'openai' })),
    { code: 'budget_provider_not_allowed' });
  store.reserve(reservation({
    maxima: { inference_requests: 1, input_tokens: 50, output_tokens: 25 },
  }));
  store.settle(settlement({
    usage: { inference_requests: 1, input_tokens: 150, output_tokens: 20 },
  }));
  const inspected = store.inspect('root_run_1');
  assert.equal(inspected.over_limit, true);
  assert.equal(inspected.charged.input_tokens, 150);
  assert.throws(() => store.reserve(reservation({
    workId: 'work_2', attemptId: 'attempt_2', operationId: 'operation_2',
    maxima: { inference_requests: 1, input_tokens: 0, output_tokens: 0 },
  })), { code: 'budget_exhausted' });

  const disabled = new RootRunBudgetStore(makeRoot(t), { now: clock() });
  disabled.create(creation({ rootRunId: 'disabled', allowedProviderIds: ['ollama'],
    limits: { inference_requests: 0, input_tokens: 0, output_tokens: 0 } }));
  assert.throws(() => disabled.reserve(reservation({ rootRunId: 'disabled' })),
    { code: 'budget_exhausted' });
});

test('settlement records aggregate actual overage above the bounded root limit', t => {
  const store = new RootRunBudgetStore(makeRoot(t), { now: clock() });
  store.create(creation({
    allowedProviderIds: ['ollama'],
    limits: { inference_requests: 2, input_tokens: 2, output_tokens: 2 },
  }));
  store.reserve(reservation({
    maxima: { inference_requests: 1, input_tokens: 1, output_tokens: 1 },
  }));
  store.reserve(reservation({
    workId: 'work_2', attemptId: 'attempt_2', operationId: 'operation_2',
    maxima: { inference_requests: 1, input_tokens: 1, output_tokens: 1 },
  }));

  store.settle(settlement({
    usage: { inference_requests: 1, input_tokens: 1_000_000_000_000, output_tokens: 1 },
  }));
  store.settle(settlement({
    workId: 'work_2', attemptId: 'attempt_2', operationId: 'operation_2',
    usage: { inference_requests: 1, input_tokens: 1_000_000_000_000, output_tokens: 1 },
  }));

  const inspected = store.inspect('root_run_1');
  assert.equal(inspected.over_limit, true);
  assert.equal(inspected.charged.input_tokens, 2_000_000_000_000);
});

test('descendant work shares the root budget without creating child budgets', t => {
  const store = new RootRunBudgetStore(makeRoot(t), { now: clock() });
  store.create(creation());
  store.reserve(reservation());
  store.reserve(reservation({
    workId: 'child_work', attemptId: 'child_attempt', operationId: 'child_operation',
  }));

  const inspected = store.inspect('root_run_1', { limit: 1 });
  assert.equal(inspected.reservation_count, 2);
  assert.equal(inspected.next_offset, 1);
  assert.deepEqual(inspected.charged,
    { inference_requests: 2, input_tokens: 200, output_tokens: 100 });
  assert.equal(store.snapshot().root_record_count, 1);
});

test('operation capacity is validated from durable data before another reservation', t => {
  const root = makeRoot(t);
  const io = createRuntimeStoreIO();
  const store = new RootRunBudgetStore(root, { io, now: clock() });
  store.create(creation({
    limits: { inference_requests: MAX_OPERATIONS_PER_ROOT + 1,
      input_tokens: MAX_OPERATIONS_PER_ROOT + 1,
      output_tokens: MAX_OPERATIONS_PER_ROOT + 1 },
  }));
  const record = clone(store.get('root_run_1'));
  record.reservations = Array.from({ length: MAX_OPERATIONS_PER_ROOT }, (_, index) => ({
    work_id: `work_${index}`,
    attempt_id: `attempt_${index}`,
    operation_id: `operation_${index}`,
    provider_id: 'ollama',
    maxima: { inference_requests: 1, input_tokens: 1, output_tokens: 1 },
    settlement: null,
  }));
  record.charged = { inference_requests: MAX_OPERATIONS_PER_ROOT,
    input_tokens: MAX_OPERATIONS_PER_ROOT, output_tokens: MAX_OPERATIONS_PER_ROOT };
  record.revision += 1;
  io.writeJsonAtomic(path.join(ownerDirectory(root, 'root_run_1'), 'record.json'), record);

  assert.throws(() => store.reserve(reservation({ operationId: 'operation_over' })),
    { code: 'budget_operation_capacity' });
});

test('future or unindexed owner data is preserved and never overwritten', t => {
  const root = makeRoot(t);
  const futureId = 'future_root';
  const directory = ownerDirectory(root, futureId);
  fs.mkdirSync(directory);
  const future = { schema_version: 2, root_run_id: futureId, future: 'preserve-me' };
  fs.writeFileSync(path.join(directory, 'record.json'), JSON.stringify(future));

  const blocked = new RootRunBudgetStore(root, { now: clock() });
  assert.equal(blocked.snapshot().read_only, true);
  assert.equal(blocked.snapshot().reason, 'budget_future_schema');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'record.json'), 'utf8')), future);

  const liveRoot = makeRoot(t);
  const live = new RootRunBudgetStore(liveRoot, { now: clock() });
  const intruder = ownerDirectory(liveRoot, 'root_run_1');
  fs.mkdirSync(intruder);
  fs.writeFileSync(path.join(intruder, 'record.json'), JSON.stringify(future));
  assert.throws(() => live.create(creation()), error => error?.code === 'budget_create_failed');
  assert.equal(live.snapshot().read_only, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(intruder, 'record.json'), 'utf8')), future);
});
