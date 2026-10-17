'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ConversationTransferService } = require('../services/conversation-transfer-service');
const { ConversationTransferStore } = require('../services/conversation-transfer-store');
const { CodexConversationAdapter, codexSnapshot } = require('../services/codex-conversation-adapter');
const { MAX_SNAPSHOT_BYTES } = require('../services/conversation-transfer-contract');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const CODEX_ID = '12345678-1234-1234-1234-123456789abc';
function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-transfer-hardening-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// A13-F1: an image-context injection whose outcome is unknown must never be appended twice.
function injectionFixture(t, onInject) {
  const root = tempRoot(t);
  let injects = 0;
  const client = { initialize: async () => {}, dispose: async () => {},
    request: async (method) => (method === 'thread/inject_items' ? onInject(++injects) : {}) };
  const adapter = new CodexConversationAdapter({ codexHome: path.join(root, 'codex'),
    receiptStore: { root: path.join(root, 'receipts') }, clientFactory: () => client });
  const snapshot = { title: 'Source chat', sourceWorkspace: 'General', warnings: [],
    messages: [{ role: 'user', content: 'hello', attachments: [{ kind: 'image', name: 'image.png', mime: 'image/png', data: PNG }] }] };
  const record = { id: crypto.randomUUID(), state: 'imported', destinationId: CODEX_ID, createdAt: new Date().toISOString() };
  let failWrite = null;
  // Mirrors the service: a failed receipt save leaves the persisted record unchanged.
  const update = (patch) => {
    if (failWrite?.(patch)) throw new Error('disk unavailable');
    Object.assign(record, patch);
  };
  return { adapter, record, copy: () => adapter.copy(snapshot, record, update),
    failWhen: (fn) => { failWrite = fn; }, get injects() { return injects; } };
}

test('accepted image injection with a failed receipt update is never injected again', async (t) => {
  const f = injectionFixture(t, async () => ({}));
  f.failWhen((patch) => patch.contextInjected === true);
  await assert.rejects(f.copy(), /disk unavailable/);
  f.failWhen(null);
  await assert.rejects(f.copy(), (error) => error.reason === 'context_outcome_unknown' && /Codex thread/.test(error.message));
  assert.equal(f.injects, 1);
});

test('a lost injection response fails closed instead of re-injecting', async (t) => {
  const f = injectionFixture(t, async () => { throw Object.assign(new Error('lost'), { reason: 'codex_timeout' }); });
  await assert.rejects(f.copy(), { reason: 'codex_timeout' });
  await assert.rejects(f.copy(), { reason: 'context_outcome_unknown' });
  assert.equal(f.injects, 1);
});

test('a server-refused injection permits a retry, still capped at three attempts', async (t) => {
  const refuse = () => { throw Object.assign(new Error('refused'), { reason: 'codex_api_error' }); };
  const once = injectionFixture(t, async (count) => (count === 1 ? refuse() : {}));
  await assert.rejects(once.copy(), { reason: 'codex_api_error' });
  assert.equal(await once.copy(), CODEX_ID);
  assert.equal(once.injects, 2);
  assert.equal(once.record.contextInjected, true);
  const always = injectionFixture(t, async () => refuse());
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(always.copy(), { reason: 'codex_api_error' });
  await assert.rejects(always.copy(), { reason: 'context_outcome_unknown' });
  assert.equal(always.injects, 3);
});

// A13-F4: aggregate attachment limits are reserved before any linked file is read.
test('repeated links to one large file exhaust the shared budget before further reads', (t) => {
  const root = tempRoot(t);
  const big = path.join(root, 'big.md');
  fs.writeFileSync(big, Buffer.alloc(10_000_000, 'a'));
  const bigReal = fs.realpathSync(big);
  const original = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', function (file, ...rest) {
    if (String(file) === bigReal) reads += 1;
    return original.call(this, file, ...rest);
  });
  const thread = (links) => ({ cwd: root, turns: [{ status: 'completed', items: [{ type: 'agentMessage',
    text: Array.from({ length: links }, (_v, index) => '[copy ' + index + '](' + big + ')').join('\n') }] }] });
  // 3 x 10,000,000 bytes fit the 32,000,000-byte aggregate; the fourth reservation fails before its read.
  assert.throws(() => codexSnapshot(thread(5), path.join(root, 'codex')), { reason: 'snapshot_too_large' });
  assert.equal(reads, 3);
  reads = 0;
  const within = codexSnapshot(thread(2), path.join(root, 'codex'));
  assert.equal(within.messages[0].attachments.length, 2);
  assert.equal(reads, 2);
});

test('inline images reserve the shared attachment count', (t) => {
  const root = tempRoot(t);
  const images = (count) => ({ cwd: root, turns: [{ status: 'completed', items: [{ type: 'userMessage',
    content: Array.from({ length: count }, () => ({ type: 'image', url: 'data:image/png;base64,' + PNG })) }] }] });
  assert.equal(codexSnapshot(images(256), root).messages[0].attachments.length, 256);
  assert.throws(() => codexSnapshot(images(257), root), { reason: 'snapshot_too_large' });
});

// A13-F5: a snapshot admitted near the size cap must stay recoverable after an interrupted copy.
function nearLimitSnapshot() {
  const count = 5000;
  const snapshot = { title: 'Large chat', sourceWorkspace: 'General', warnings: [],
    messages: Array.from({ length: count }, (_v, index) => ({ role: index % 2 ? 'assistant' : 'user', content: '', attachments: [] })) };
  const base = Buffer.byteLength(JSON.stringify(snapshot));
  const each = Math.floor((MAX_SNAPSHOT_BYTES - base - 4096) / count);
  for (const message of snapshot.messages) message.content = 'x'.repeat(each);
  snapshot.messages[0].content += 'x'.repeat(MAX_SNAPSHOT_BYTES - 64 - Buffer.byteLength(JSON.stringify(snapshot)));
  return snapshot;
}

test('near-limit snapshot survives an interrupted copy and a pretty-printed legacy file reopens', async (t) => {
  const root = tempRoot(t);
  const snapshot = nearLimitSnapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_SNAPSHOT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot, null, 2)) > MAX_SNAPSHOT_BYTES, 'fixture exercises formatting overhead');
  const destinationId = 'sess_transfer_hardening';
  let copies = 0;
  const adapters = { codex: { snapshot: async () => snapshot },
    jenny: { exists: async () => true, copy: async () => {
      copies += 1;
      if (copies === 1) throw Object.assign(new Error('interrupted'), { reason: 'destination_persist_failed' });
      return destinationId;
    } } };
  const open = () => new ConversationTransferService({ adapters,
    receiptStore: new ConversationTransferStore(path.join(root, 'receipts')) });
  const request = { source: 'codex', destination: 'jenny', sourceId: CODEX_ID };
  const first = open();
  const preview = await first.preview(request);
  await assert.rejects(first.copy({ previewToken: preview.previewToken }), { reason: 'destination_persist_failed' });
  const reopened = await open().preview(request);
  assert.match(reopened.warnings.join(' '), /resumes the saved snapshot/);
  assert.equal(reopened.messageCount, 5000);
  const operationId = reopened.receipt.operationId;
  const file = path.join(root, 'receipts', 'scratch', operationId, 'snapshot.json');
  fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')), null, 2));
  assert.ok(fs.statSync(file).size > MAX_SNAPSHOT_BYTES);
  const legacy = open();
  const legacyPreview = await legacy.preview(request);
  assert.equal(legacyPreview.receipt.operationId, operationId);
  const copied = await legacy.copy({ previewToken: legacyPreview.previewToken });
  assert.equal(copied.receipt.state, 'completed');
  assert.equal(copied.receipt.destinationId, destinationId);
});
