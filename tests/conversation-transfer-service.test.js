'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ConversationTransferService } = require('../services/conversation-transfer-service');
const { ConversationTransferStore } = require('../services/conversation-transfer-store');
const { JennyConversationAdapter } = require('../services/jenny-conversation-adapter');
const { CodexConversationAdapter, codexSnapshot } = require('../services/codex-conversation-adapter');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { AttachmentAssetStore } = require('../services/attachment-asset-store');
const { writeAssets, readSourceFile } = require('../services/conversation-transfer-assets');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const CODEX_ID = '12345678-1234-1234-1234-123456789abc';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-transfer-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receipts = new ConversationTransferStore(path.join(root, 'receipts'));
  const sessions = new ElectronSessionStore(path.join(root, 'sessions.json'));
  t.after(() => sessions.dispose());
  const assets = new AttachmentAssetStore({ rootDir: path.join(root, 'media') });
  const adapter = new JennyConversationAdapter({ sessionStore: sessions, attachmentAssetStore: assets,
    transferAssetRoot: path.join(root, 'copied-files') });
  let source = { title: 'Source chat', sourceWorkspace: '/source/untrusted', warnings: [],
    messages: [{ role: 'user', content: 'hello', attachments: [{ kind: 'image', name: 'image.png', mime: 'image/png', data: PNG }] },
      { role: 'assistant', content: 'reply', attachments: [] }] };
  const codex = { list: async () => [{ id: CODEX_ID, title: source.title, archived: true }],
    snapshot: async () => structuredClone(source) };
  const service = new ConversationTransferService({ adapters: { jenny: adapter, codex }, receiptStore: receipts });
  const preview = (copyAgain = false) => service.preview({ source: 'codex', destination: 'jenny', sourceId: CODEX_ID, copyAgain });
  return { root, receipts, sessions, assets, adapter, codex, service, preview,
    mutate: (fn) => fn(source), get source() { return source; } };
}

test('canonical import preserves dialogue/media independently; restart retry reuses destination', async (t) => {
  const f = fixture(t);
  const before = await f.preview();
  assert.match(before.destinationWorkspace, /General/);
  assert.equal(before.attachmentCount, 1);
  const copied = await f.service.copy({ previewToken: before.previewToken });
  assert.equal(copied.receipt.state, 'completed');
  const chat = f.sessions.getSession(copied.receipt.destinationId);
  assert.equal(chat.messages[0].content, 'hello');
  assert.equal(chat.project_id, 'project_general');
  assert.equal(chat.active_turn, null);
  assert.deepEqual(chat.turn_events, []);
  const imagePath = chat.messages[0].attachments[0].assetPath;
  assert.deepEqual(fs.readFileSync(imagePath), Buffer.from(PNG, 'base64'));
  const restarted = new ConversationTransferService({ adapters: { jenny: f.adapter, codex: f.codex },
    receiptStore: new ConversationTransferStore(path.join(f.root, 'receipts')) });
  const retryPreview = await restarted.preview({ source: 'codex', destination: 'jenny', sourceId: CODEX_ID });
  const retry = await restarted.copy({ previewToken: retryPreview.previewToken });
  assert.equal(retry.reused, true);
  assert.equal(retry.receipt.destinationId, copied.receipt.destinationId);
  const again = await f.preview(true);
  const freshCopy = await f.service.copy({ previewToken: again.previewToken });
  assert.notEqual(freshCopy.receipt.destinationId, copied.receipt.destinationId);
  const sameIntent = await f.service.copy({ previewToken: again.previewToken });
  assert.equal(sameIntent.receipt.destinationId, freshCopy.receipt.destinationId);
  assert.equal(sameIntent.reused, true);
});

test('stale preview refuses mutation; a busy source refuses preview', async (t) => {
  const f = fixture(t);
  const preview = await f.preview();
  f.mutate((source) => { source.messages[0].content = 'changed'; });
  await assert.rejects(f.service.copy({ previewToken: preview.previewToken }), { reason: 'source_changed' });
  assert.equal(f.receipts.records.length, 0);
  f.adapter.isBusy = () => true;
  const source = f.sessions.createSession({ title: 'Busy' });
  await assert.rejects(f.adapter.snapshot(source.id), { reason: 'source_busy' });
});

test('failed destination receipt write reconciles canonical import after process restart', async (t) => {
  const f = fixture(t);
  const preview = await f.preview();
  const save = f.receipts.save.bind(f.receipts);
  f.receipts.save = (record) => {
    if (record.state === 'completed') throw new Error('disk unavailable');
    save(record);
  };
  await assert.rejects(f.service.copy({ previewToken: preview.previewToken }), /disk unavailable/);
  assert.equal(f.sessions.listSessions().length, 1);
  const resumed = new ConversationTransferService({ adapters: { jenny: f.adapter, codex: f.codex },
    receiptStore: new ConversationTransferStore(path.join(f.root, 'receipts')) });
  f.mutate((source) => { source.messages[0].content = 'new source text'; });
  const next = await resumed.preview({ source: 'codex', destination: 'jenny', sourceId: CODEX_ID });
  assert.equal(next.dialogue[0].content, 'hello', 'resumes frozen snapshot');
  assert.match(next.warnings.join(' '), /resumes the saved snapshot/);
  await resumed.copy({ previewToken: next.previewToken });
  assert.equal(f.sessions.listSessions().length, 1);
});

test('same-token concurrent calls share a copy; other tokens are refused', async (t) => {
  const f = fixture(t);
  let release;
  const original = f.adapter.copy.bind(f.adapter);
  f.adapter.copy = async (...args) => { await new Promise((resolve) => { release = resolve; }); return original(...args); };
  const preview = await f.preview();
  const p1 = f.service.copy({ previewToken: preview.previewToken });
  const p2 = f.service.copy({ previewToken: preview.previewToken });
  assert.equal(p1, p2);
  assert.throws(() => f.service.copy({ previewToken: crypto.randomUUID() }), { reason: 'transfer_busy' });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await p1;
  assert.equal(f.sessions.listSessions().length, 1);
});

test('missing files are disclosed; system/developer/pending metadata never transfers', async (t) => {
  const f = fixture(t);
  const chat = f.sessions.createSession({ title: 'Archived source' });
  f.sessions.appendMessage(chat.id, { role: 'system', content: 'privileged instructions' });
  f.sessions.appendMessage(chat.id, { role: 'user', content: 'retained original text', attachments: [{ kind: 'text', displayName: 'lost.txt' }] });
  f.sessions.setSessionMeta(chat.id, { archived_at: new Date().toISOString() });
  const snapshot = await f.adapter.snapshot(chat.id);
  assert.equal(snapshot.messages.length, 1);
  assert.match(snapshot.warnings[0], /Original attachment unavailable: lost.txt/);
  assert.equal((await f.adapter.list())[0].archived, true);
});

test('asset containment rejects junctions and secret paths; original file bytes are durable', async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  const output = path.join(f.root, 'assets');
  fs.mkdirSync(outside); fs.mkdirSync(output);
  const id = crypto.randomUUID();
  fs.symlinkSync(outside, path.join(output, id), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => writeAssets(output, id, f.source), { reason: 'unsafe_asset_path' });
  const secret = path.join(f.root, 'auth.json'); fs.writeFileSync(secret, 'credential');
  assert.throws(() => readSourceFile(secret, [f.root], 'file'));
  const file = path.join(f.root, 'original.md'); fs.writeFileSync(file, 'retained original bytes\n');
  const attachment = readSourceFile(file, [f.root], 'file');
  f.mutate((source) => { source.messages[1].attachments = [attachment]; });
  const preview = await f.preview();
  const copied = await f.service.copy({ previewToken: preview.previewToken });
  fs.unlinkSync(file);
  const assets = fs.readdirSync(path.join(f.root, 'copied-files', copied.receipt.operationId));
  const stored = assets.find((name) => name.endsWith('.md'));
  assert.equal(fs.readFileSync(path.join(f.root, 'copied-files', copied.receipt.operationId, stored), 'utf8'), 'retained original bytes\n');
});

test('corrupted/future receipts fail closed and preserve their bytes', (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'receipts', 'receipts.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"version":99,"records":[]}');
  const store = new ConversationTransferStore(path.dirname(file));
  assert.throws(() => store.get(crypto.randomUUID()), { reason: 'receipt_store_unavailable' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"version":99,"records":[]}');
});

test('native source conversion retains completed tool text, rejects busy history, reports unsupported media', (t) => {
  const f = fixture(t);
  const thread = { name: '<unsafe>', cwd: f.root, status: { type: 'notLoaded' }, turns: [{
    status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'user' }, { type: 'audio' }] },
      { type: 'commandExecution', status: 'completed', command: 'do not replay', aggregatedOutput: 'success', exitCode: 0 },
      { type: 'agentMessage', text: 'assistant' }],
  }] };
  const snapshot = codexSnapshot(thread, f.root);
  assert.deepEqual(snapshot.messages.map((row) => row.role), ['user', 'assistant', 'assistant']);
  assert.match(snapshot.messages[1].content, /copied text only/);
  assert.match(snapshot.warnings.join(' '), /audio/);
  thread.turns[0].status = 'inProgress';
  assert.throws(() => codexSnapshot(thread, f.root), { reason: 'source_busy' });
});

test('Codex timeout reconciles migration history instead of importing a second chat', async (t) => {
  const f = fixture(t);
  const id = crypto.randomUUID();
  const record = { id, state: 'importing', importId: crypto.randomUUID(), createdAt: new Date().toISOString() };
  const source = path.join(f.root, 'receipts', 'scratch', id, 'discovery', '.claude', 'projects', 'jenny-transfer', id + '.jsonl');
  const calls = [];
  const client = { initialize: async () => {}, dispose: async () => {},
    request: async (method) => {
      calls.push(method);
      if (method === 'externalAgentConfig/import/readHistories') return { data: [{ importId: record.importId,
        successes: [{ source, target: CODEX_ID }] }] };
      return {};
    } };
  const adapter = new CodexConversationAdapter({ codexHome: path.join(f.root, 'codex'),
    receiptStore: f.receipts, clientFactory: () => client });
  const target = await adapter.copy(f.source, record, (patch) => Object.assign(record, patch));
  assert.equal(target, CODEX_ID);
  assert.ok(!calls.includes('externalAgentConfig/import'));
  assert.equal(record.contextInjected, true);
  assert.ok(calls.includes('thread/inject_items'));
});

test('unknown Codex outcome fails closed; no import is reissued', async (t) => {
  const f = fixture(t);
  const record = { id: crypto.randomUUID(), state: 'importing', createdAt: new Date().toISOString() };
  const calls = [];
  const client = { initialize: async () => {}, dispose: async () => {}, request: async (method) => {
    calls.push(method); return { data: [] };
  } };
  const adapter = new CodexConversationAdapter({ codexHome: path.join(f.root, 'codex'),
    receiptStore: f.receipts, clientFactory: () => client });
  await assert.rejects(adapter.copy(f.source, record, (patch) => Object.assign(record, patch)), { reason: 'outcome_unknown' });
  assert.deepEqual(calls, ['externalAgentConfig/import/readHistories']);
});

test('typed native images outside the workspace are copied; credential aliases and redirected snapshots are refused', async (t) => {
  const f = fixture(t);
  const image = path.join(f.root, 'outside.png'); fs.writeFileSync(image, Buffer.from(PNG, 'base64'));
  const snapshot = codexSnapshot({ cwd: path.join(f.root, 'different-workspace'), turns: [{ status: 'completed',
    items: [{ type: 'userMessage', content: [{ type: 'localImage', path: image }] }] }] }, f.root);
  assert.equal(snapshot.messages[0].attachments[0].data, PNG);
  assert.equal(snapshot.warnings.length, 0);
  const allowed = path.join(f.root, 'allowed'); fs.mkdirSync(allowed);
  const redirected = path.join(allowed, 'alias');
  fs.symlinkSync(f.root, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readSourceFile(path.join(redirected, 'outside.png'), [allowed], 'image'));
});

test('full completed tool output and copied file excerpts are retained with secret redaction', async (t) => {
  const f = fixture(t);
  const source = f.sessions.createSession({ title: 'Tools' });
  f.sessions.appendMessage(source.id, { role: 'tool', content: 'short summary',
    tool_result: { call_id: 'call', tool_name: 'read_file', output_text: 'full completed output' } });
  assert.match((await f.adapter.snapshot(source.id)).messages[0].content, /full completed output/);
  f.mutate((snapshot) => { snapshot.messages[1].attachments = [{ kind: 'file', name: 'notes.txt', mime: 'text/plain',
    data: Buffer.from('api_key=abcdefgh123456789 retained notes').toString('base64') }]; });
  const preview = await f.preview();
  const copy = await f.service.copy({ previewToken: preview.previewToken });
  const imported = f.sessions.getSession(copy.receipt.destinationId);
  assert.match(imported.messages[1].content, /retained notes/);
  assert.ok(!imported.messages[1].content.includes('abcdefgh123456789'));
});

test('failed canonical durability never produces a completed receipt', async (t) => {
  const f = fixture(t);
  f.sessions.flushSession = () => false;
  const preview = await f.preview();
  await assert.rejects(f.service.copy({ previewToken: preview.previewToken }), { reason: 'destination_persist_failed' });
  assert.equal(f.receipts.records[0].state, 'importing');
});

test('confirmed failed native import resets admission for a safe saved-snapshot retry', async (t) => {
  const f = fixture(t);
  const record = { id: crypto.randomUUID(), state: 'importing', importId: crypto.randomUUID(), createdAt: new Date().toISOString() };
  const client = { initialize: async () => {}, dispose: async () => {},
    request: async () => ({ data: [{ importId: record.importId, successes: [], failures: [{ source: 'fixture' }] }] }) };
  const adapter = new CodexConversationAdapter({ codexHome: path.join(f.root, 'codex'), receiptStore: f.receipts,
    clientFactory: () => client });
  await assert.rejects(adapter.copy(f.source, record, (patch) => Object.assign(record, patch)), { reason: 'codex_import_failed' });
  assert.equal(record.state, 'prepared');
  assert.equal(record.importId, null);
});

test('native import refusal permits a saved-snapshot retry while timeout stays ambiguous', async (t) => {
  for (const reason of ['codex_api_error', 'codex_timeout']) {
    const f = fixture(t);
    const record = { id: crypto.randomUUID(), state: 'prepared', createdAt: new Date().toISOString() };
    const source = path.join(f.receipts.root, 'scratch', record.id, 'discovery', '.claude', 'projects', 'jenny-transfer', record.id + '.jsonl');
    let imports = 0;
    const client = { initialize: async () => {}, dispose: async () => {},
      request: async (method) => {
        if (method === 'externalAgentConfig/detect') return { items: [{ details: { sessions: [{ path: source }] } }] };
        if (method === 'externalAgentConfig/import') {
          if (++imports === 1) throw Object.assign(new Error('Rejected or lost response'), { reason });
          return { importId: 'accepted-import' };
        }
        if (method === 'externalAgentConfig/import/readHistories') return { data: [] };
        return {};
      },
      importCompleted: async () => ({ itemTypeResults: [{ itemType: 'SESSIONS', successes: [{ source, target: CODEX_ID }] }] }) };
    const adapter = new CodexConversationAdapter({ codexHome: path.join(f.root, 'codex'), receiptStore: f.receipts,
      clientFactory: () => client });
    const copy = () => adapter.copy(f.source, record, (patch) => Object.assign(record, patch));
    await assert.rejects(copy(), { reason });
    if (reason === 'codex_api_error') {
      assert.equal(record.state, 'prepared');
      assert.equal(record.importId, null);
      assert.equal(await copy(), CODEX_ID);
      assert.equal(imports, 2);
    } else {
      assert.equal(record.state, 'importing');
      await assert.rejects(copy(), { reason: 'outcome_unknown' });
      assert.equal(imports, 1);
    }
  }
});
