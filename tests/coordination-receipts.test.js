'use strict';

/* coordination_receipts (row 59 checkpoint 5b-2, slice M1): the shared pure record module and its
 * two durable writers (the proposal store and the session mail store). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const C = require('../services/backend/coordination-receipts');
const { createChatProposalStore } = require('../services/backend/chat-proposal-store');
const { createSessionMailStore } = require('../services/backend/session-mail-store');
const { normalizeCoordinationReceipts } = require('../services/backend/session-coordination-records');
const F = require('./helpers/session-mail-fixtures');

const NOW = new Date('2026-10-15T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs);

const make = (n, extra = {}) => C.buildReceipt({
  mutationId: `gesture_${n}`, method: 'chatMessages.createGrant', args: { n }, resourceKind: 'authorization', resourceId: `auth_${n}`,
  acceptedRevision: n, now: NOW, ...extra,
});

test('buildReceipt returns the closed record and hashes canonical arguments', () => {
  const receipt = make(1);
  assert.deepEqual(Object.keys(receipt), C.RECEIPT_KEYS);
  assert.equal(receipt.schema_version, 1);
  assert.equal(receipt.accepted_revision, 1);
  assert.equal(receipt.created_at, NOW.toISOString());
  assert.equal(receipt.settled_at, NOW.toISOString());
  assert.equal(make(1, { args: { a: 1, b: [2, 3] } }).args_sha256, make(1, { args: { b: [2, 3], a: 1 } }).args_sha256, 'key order never matters');
  assert.notEqual(make(1, { args: { a: 1 } }).args_sha256, make(1, { args: { a: 2 } }).args_sha256);
  assert.equal(make(1, { settled: false }).settled_at, null);
  assert.equal(make(1, { acceptedRevision: null }).accepted_revision, null);
  assert.equal(C.argsSha256({ a: 1 }).length, 64);
});

test('buildReceipt rejects what the record cannot carry and normalizeReceipt is strict', () => {
  assert.equal(make(1, { mutationId: '' }), null);
  assert.equal(make(1, { method: 'bad method!' }), null);
  assert.equal(make(1, { resourceKind: 'Bad Kind' }), null);
  assert.equal(make(1, { acceptedRevision: -1 }), null);
  assert.throws(() => make(1, { now: 'not a date' }));
  const ok = make(1);
  assert.deepEqual(C.normalizeReceipt(ok), ok);
  assert.notEqual(C.normalizeReceipt(ok), ok, 'a clone');
  for (const patch of [{ schema_version: 2 }, { extra: 1 }, { args_sha256: 'x' }, { created_at: 'yesterday' }, { settled_at: 5 },
    { resource_id: 'x'.repeat(513) }]) {
    assert.equal(C.normalizeReceipt({ ...ok, ...patch }), null, JSON.stringify(patch));
  }
  assert.equal(C.normalizeReceipt(null), null);
  assert.equal(C.normalizeReceipt([ok]), null);
});

test('partitionReceipts keeps invalid, future and duplicate entries as opaque raw values', () => {
  const first = make(1);
  const future = { schema_version: 2, mutation_id: 'later', whatever: ['kept'] };
  const duplicate = { ...make(1), resource_id: 'auth_other' };
  const { records, opaque } = C.partitionReceipts([future, first, duplicate, 'junk']);
  assert.deepEqual(records, [first]);
  assert.deepEqual(opaque, [future, duplicate, 'junk']);
  assert.deepEqual(C.partitionReceipts(undefined), { records: [], opaque: [] });
  assert.deepEqual(C.normalizeReceiptList([first]), [first]);
  assert.equal(C.normalizeReceiptList([first, first]), null, 'a repeated mutation_id is refused');
  assert.equal(C.normalizeReceiptList([{ ...first, extra: 1 }]), null);
  assert.equal(C.normalizeReceiptList('x'), null);
});

test('the container reading keeps every stored entry: valid ones canonical, the rest verbatim', () => {
  const valid = make(1);
  const raw = [valid, { schema_version: 1, mutation_id: 'm1' }, { schema_version: 3, mutation_id: 'future' }];
  const kept = normalizeCoordinationReceipts(raw);
  assert.deepEqual(kept, raw);
  assert.notEqual(kept, raw);
  assert.deepEqual(normalizeCoordinationReceipts('nope'), []);
});

test('replayVerdict: none, same (method and arguments) or conflict', () => {
  const list = [make(1)];
  const args = { n: 1 };
  assert.deepEqual(C.replayVerdict(list, 'gesture_9', 'chatMessages.createGrant', args), { state: 'none' });
  assert.equal(C.replayVerdict(list, 'gesture_1', 'chatMessages.createGrant', args).state, 'same');
  assert.equal(C.replayVerdict(list, 'gesture_1', 'chatMessages.createGrant', { n: 2 }).state, 'conflict');
  assert.equal(C.replayVerdict(list, 'gesture_1', 'chatMessages.revokeGrant', args).state, 'conflict');
  assert.equal(C.replayVerdict(list, 'gesture_1', 'chatMessages.createGrant', args).receipt.resource_id, 'auth_1');
  assert.deepEqual(C.replayVerdict(undefined, 'gesture_1', 'x', {}), { state: 'none' });
});

test('pruneReceipts keeps every unsettled receipt and the newest 1,024 finalized ones within 30 days', () => {
  const unsettled = make(1, { settled: false, now: at(-90 * DAY) });
  const old = make(2, { now: at(-31 * DAY) });
  const edge = make(3, { now: at(-30 * DAY) });
  const finalized = Array.from({ length: 1030 }, (_, i) => make(100 + i, { now: at(-i * 1000) }));
  const pruned = C.pruneReceipts([unsettled, old, edge, ...finalized], { now: NOW });
  assert.ok(pruned.includes(unsettled), 'unsettled work is never pruned');
  assert.equal(pruned.includes(old), false, 'older than 30 days');
  assert.equal(pruned.filter((receipt) => receipt.settled_at !== null).length, 1024);
  assert.equal(pruned.includes(finalized[0]), true, 'the newest stays');
  assert.equal(pruned.includes(finalized[1029]), false, 'the oldest over the cap goes');
  assert.equal(pruned.includes(edge), false, 'the cap keeps only the newest');
  assert.deepEqual(C.pruneReceipts([old, edge], { now: NOW }), [edge], 'exactly 30 days still counts');
});

test('appendReceipt is idempotent on mutation_id, prunes, and settleReceipt only settles an unsettled one', () => {
  const first = make(1);
  assert.deepEqual(C.appendReceipt([], first, { now: NOW }), [first]);
  assert.deepEqual(C.appendReceipt([first], { ...first, resource_id: 'other' }, { now: NOW }), [first], 'the existing receipt wins');
  assert.deepEqual(C.appendReceipt([first], null, { now: NOW }), [first]);
  const open = make(2, { settled: false });
  const settled = C.settleReceipt([first, open], 'gesture_2', { now: at(1000) });
  assert.equal(settled[1].settled_at, at(1000).toISOString());
  assert.equal(C.settleReceipt(settled, 'gesture_2', { now: at(5000) })[1].settled_at, at(1000).toISOString());
  assert.deepEqual(C.findReceipt(settled, 'gesture_1'), first);
  assert.equal(C.findReceipt(settled, 'nope'), null);
});

// ---------- the two durable writers ----------

function createFakeStore(initial, { failFlush = false, sessions } = {}) {
  const records = new Map(Object.entries(sessions || { sess_a: initial }));
  const calls = [];
  for (const [key, value] of records) records.set(key, structuredClone(value));
  return {
    calls,
    records,
    peekSession: (id) => records.get(id) || null,
    hasNewerSchema: () => false,
    _updateSessionRecord(id, patch, options) {
      calls.push({ op: 'update', id, patch: structuredClone(patch), options });
      if (!records.has(id)) return null;
      records.set(id, { ...records.get(id), ...structuredClone(patch) });
      return { id };
    },
    flushSession(id) {
      calls.push({ op: 'flush', id });
      return !failFlush;
    },
  };
}

const mailSession = (extra = {}) => ({
  session_incarnation: 'inc_a', project_id: 'proj_1', coordination_revision: 4, session_mail: F.emptyMail(), coordination_receipts: [], ...extra,
});
const proposalSession = (extra = {}) => ({
  session_incarnation: 'inc_a', coordination_revision: 4, chat_proposals: { schema_version: 1, records: [], launch_grants: [] },
  coordination_receipts: [], ...extra,
});

for (const [name, create, session, mutateWith] of [
  ['session mail store', createSessionMailStore, mailSession, (receipts) => ({ mail: F.emptyMail(), coordination_receipts: receipts })],
  ['proposal store', createChatProposalStore, proposalSession, (receipts) => ({ records: [], coordination_receipts: receipts })],
]) {
  test(`${name}: a returned receipt is written in the same flushed update as the effect and echoed back`, () => {
    const fake = createFakeStore(session());
    const store = create(fake);
    assert.deepEqual(store.read('sess_a').coordination_receipts, []);
    const receipt = make(1, { acceptedRevision: 5 });
    const result = store.mutate('sess_a', (draft) => {
      assert.deepEqual(draft.coordination_receipts, []);
      return mutateWith([receipt]);
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.coordination_receipts, [receipt]);
    assert.equal(result.coordination_revision, 5, 'a receipt alone is a change: the revision moves');
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(fake.calls[0].patch.coordination_receipts, [receipt]);
    assert.equal(fake.calls[0].patch.coordination_revision, 5);
    assert.deepEqual(fake.calls[1], { op: 'flush', id: 'sess_a' });
    assert.deepEqual(store.read('sess_a').coordination_receipts, [receipt]);
    store.mutate('sess_a', (draft) => {
      assert.deepEqual(draft.coordination_receipts, [receipt], 'the next mutation re-reads the array');
      return mutateWith(draft.coordination_receipts);
    });
    assert.equal(fake.calls.length, 2, 'unchanged receipts and effect write nothing');
  });

  test(`${name}: a flush failure rolls the receipt back with the effect`, () => {
    const fake = createFakeStore(session(), { failFlush: true });
    const result = create(fake).mutate('sess_a', () => mutateWith([make(1)]));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'io_failed');
    assert.equal(fake.calls.length, 3);
    assert.deepEqual(fake.calls[2].options, { bumpUpdatedAt: false, persist: false });
    assert.deepEqual(fake.calls[2].patch.coordination_receipts, []);
    assert.equal(fake.calls[2].patch.coordination_revision, 4);
    assert.deepEqual(create(fake).read('sess_a').coordination_receipts, []);
  });

  test(`${name}: opaque receipt entries survive a write and are kept verbatim`, () => {
    const future = { schema_version: 1, mutation_id: 'broken' };
    const kept = make(1);
    const fake = createFakeStore(session({ coordination_receipts: [kept, future] }));
    const store = create(fake);
    assert.deepEqual(store.read('sess_a').coordination_receipts, [kept], 'reads drop the invalid entry');
    const next = make(2);
    store.mutate('sess_a', () => mutateWith([kept, next]));
    assert.deepEqual(fake.records.get('sess_a').coordination_receipts, [kept, next, future], 'the opaque entry is kept verbatim');
  });

  test(`${name}: invalid receipts refuse the mutation and a frozen (future) receipt array is never written`, () => {
    const fake = createFakeStore(session());
    const store = create(fake);
    for (const bad of [[{ nope: true }], [make(1), make(1)], 'x']) {
      const result = store.mutate('sess_a', () => mutateWith(bad));
      assert.equal(result.reason, 'invalid_record', JSON.stringify(bad));
    }
    assert.equal(fake.calls.length, 0);
    const frozen = createFakeStore(session({ coordination_receipts: [{ schema_version: 2, mutation_id: 'x' }] }));
    const refused = create(frozen).mutate('sess_a', () => mutateWith([make(1)]));
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'unavailable');
    assert.equal(frozen.calls.length, 0);
  });
}

test('session mail store: a callback that omits the receipt list leaves the stored receipts untouched', () => {
  const kept = make(1);
  const fake = createFakeStore(mailSession({ coordination_receipts: [kept, { schema_version: 1, mutation_id: 'broken' }] }));
  const result = createSessionMailStore(fake).mutate('sess_a', ({ mail }) => ({ mail: { ...mail, reporting_enabled: true } }));
  assert.equal(result.ok, true);
  assert.equal('coordination_receipts' in fake.calls[0].patch, false, 'receipts were not rewritten');
  assert.deepEqual(fake.records.get('sess_a').coordination_receipts, [kept, { schema_version: 1, mutation_id: 'broken' }]);
});
