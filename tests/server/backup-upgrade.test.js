'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AttachmentAssetStore } = require('../../services/attachment-asset-store');
const { BackendService } = require('../../services/backend/backend-service');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { exportSession } = require('../../services/backend/session-export-import');
const { createArchive } = require('../../services/data-lifecycle/archive-service');
const { assertImportComplete, importConversations } = require('../../services/host/maintenance-commands');
const { readJson, writeJson } = require('../../services/host/durable-json');

class StoppedSidecar extends EventEmitter {
  getStatus() { return { phase: 'stopped' }; }
  async start() { throw new Error('sidecar must not start during import'); }
  async stop() { return { exitConfirmed: true }; }
}

function pngBytes() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createBackend(userDataPath) {
  return new BackendService({
    userDataPath,
    defaultModel: 'replay-test',
    sidecarManager: new StoppedSidecar(),
    attachmentAssetStore: new AttachmentAssetStore({
      rootDir: path.join(userDataPath, 'attachments'),
    }),
  });
}

function sourceSession(root, title) {
  const store = new ElectronSessionStore(path.join(root, `${title}.json`), { writeDebounceMs: 0 });
  const assets = new AttachmentAssetStore({ rootDir: path.join(root, `${title}-assets`) });
  const session = store.createSession({ title });
  const saved = assets.saveImageBufferSync(pngBytes(), {
    displayName: `${title}.png`, mimeType: 'image/png', sourceKind: 'test',
  });
  store.appendMessage(session.id, {
    role: 'user', content: `Message from ${title}`,
    attachments: [{ id: 'image_1', kind: 'image', displayName: `${title}.png`, mimeType: 'image/png', assetPath: saved.assetPath }],
  });
  store.flush();
  const payload = exportSession(store, session.id, assets, { requireManagedMedia: true });
  store.dispose();
  return { id: session.id, payload };
}

async function createPortableArchive(root, sessions, { encrypted = false, passphrase = '', name = '' } = {}) {
  const entries = sessions.map((session) => ({
    logicalPath: `sessions/${session.id}.json`,
    category: 'chats',
    data: session.payload,
    restoreMetadata: { session_id: session.id },
  }));
  entries.push({ logicalPath: 'preferences/ignored.json', category: 'preferences', data: '{}' });
  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: name || `portable-${sessions.length}-${encrypted ? 'encrypted' : 'plain'}.jenny-archive`,
    encrypted,
    passphrase,
    entries,
  });
  return result.archivePath;
}

function closeBackend(backend) {
  try { backend.dispose(); } catch (_error) { /* test cleanup */ }
}

test('imports real portable conversations and embedded media, with exact retry', async (t) => {
  const root = tempRoot(t, 'jenny-host-import-');
  const source = sourceSession(root, 'portable');
  const archivePath = await createPortableArchive(root, [source]);
  const userDataPath = path.join(root, 'hosted-profile');
  const backend = createBackend(userDataPath);
  t.after(() => closeBackend(backend));

  const imported = await importConversations({ backend, userDataPath, archivePath });
  assert.equal(imported.ok, true);
  assert.equal(imported.imported_count, 1);
  assert.deepEqual(imported.skipped, { count: 1, categories: [{ name: 'preferences', count: 1 }] });
  const session = backend.sessionStore.getSession(source.id);
  assert.equal(session.title, 'portable');
  assert.equal(session.messages[0].content, 'Message from portable');
  assert.equal(session.messages[0].attachments[0].assetPath.startsWith(path.join(userDataPath, 'attachments')), true);
  assert.equal(fs.existsSync(session.messages[0].attachments[0].assetPath), true);
  assert.deepEqual(assertImportComplete(userDataPath), { ok: true, state: 'completed', imported_count: 1 });

  const retry = await importConversations({ backend, userDataPath, archivePath });
  assert.deepEqual(retry, imported);
  assert.equal(backend.sessionStore.getSessionIds().length, 1);
  assert.equal(fs.readdirSync(userDataPath).some((name) => name.startsWith('.host-import-')), false);
});

test('wrong passphrase fails before receipt or canonical mutation', async (t) => {
  const root = tempRoot(t, 'jenny-host-import-auth-');
  const source = sourceSession(root, 'protected');
  const archivePath = await createPortableArchive(root, [source], {
    encrypted: true, passphrase: 'correct-password-123',
  });
  const userDataPath = path.join(root, 'hosted-profile');
  const backend = createBackend(userDataPath);
  t.after(() => closeBackend(backend));

  const result = await importConversations({ backend, userDataPath, archivePath, passphrase: 'wrong-password-123' });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'archive_authentication_failed');
  assert.deepEqual(backend.sessionStore.getSessionIds(), []);
  assert.equal(fs.existsSync(path.join(userDataPath, 'host-import.json')), false);
});

test('changed source conflicts after a completed import', async (t) => {
  const root = tempRoot(t, 'jenny-host-import-retry-');
  const first = sourceSession(root, 'first');
  const second = sourceSession(root, 'second');
  const firstArchive = await createPortableArchive(root, [first], { name: 'portable-first.jenny-archive' });
  const secondArchive = await createPortableArchive(root, [second], { name: 'portable-second.jenny-archive' });
  const userDataPath = path.join(root, 'hosted-profile');
  const backend = createBackend(userDataPath);
  t.after(() => closeBackend(backend));

  assert.equal((await importConversations({ backend, userDataPath, archivePath: firstArchive })).ok, true);
  const changed = await importConversations({ backend, userDataPath, archivePath: secondArchive });
  assert.equal(changed.ok, false);
  assert.equal(changed.error.reason, 'import_source_changed');
  assert.deepEqual(backend.sessionStore.getSessionIds(), [first.id]);
});

test('partial import leaves a durable pending marker and startup refuses it', async (t) => {
  const root = tempRoot(t, 'jenny-host-import-partial-');
  const first = sourceSession(root, 'one');
  const second = sourceSession(root, 'two');
  const archivePath = await createPortableArchive(root, [first, second]);
  const userDataPath = path.join(root, 'hosted-profile');
  const backend = createBackend(userDataPath);
  t.after(() => closeBackend(backend));
  const write = backend.sessionStore._write.bind(backend.sessionStore);
  let writes = 0;
  backend.sessionStore._write = (payload) => {
    writes += 1;
    if (writes > 1) throw new Error('injected canonical write failure');
    write(payload);
  };

  const result = await importConversations({ backend, userDataPath, archivePath });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'import_incomplete');
  assert.throws(() => assertImportComplete(userDataPath), (error) => error.reason === 'import_pending');
  assert.equal(readJson(path.join(userDataPath, 'host-import.json')).state, 'pending');
  assert.equal(backend.sessionStore.getSessionIds().length, 1);
});

test('future or malformed import markers fail closed and a nonempty profile is protected', async (t) => {
  const root = tempRoot(t, 'jenny-host-import-marker-');
  const source = sourceSession(root, 'marker');
  const archivePath = await createPortableArchive(root, [source]);
  const userDataPath = path.join(root, 'hosted-profile');
  fs.mkdirSync(userDataPath, { recursive: true });
  writeJson(path.join(userDataPath, 'host-import.json'), { schema_version: 99 });
  assert.throws(() => assertImportComplete(userDataPath), (error) => error.reason === 'import_receipt_future');
  const backend = createBackend(userDataPath);
  t.after(() => closeBackend(backend));
  const future = await importConversations({ backend, userDataPath, archivePath });
  assert.equal(future.error.reason, 'import_receipt_future');

  fs.rmSync(path.join(userDataPath, 'host-import.json'), { force: true });
  const existing = backend.sessionStore.createSession({ title: 'already here' });
  assert.ok(existing.id);
  const nonempty = await importConversations({ backend, userDataPath, archivePath });
  assert.equal(nonempty.error.reason, 'profile_not_empty');
});

test('import preflight rejects future canonical stores, malformed payloads and disk pressure without receipts', async (t) => {
  const root = tempRoot(t, 'jenny-host-import-preflight-');
  const source = sourceSession(root, 'preflight');
  const validArchive = await createPortableArchive(root, [source]);
  for (const scenario of ['future-store', 'future-payload', 'malformed', 'disk']) {
    const userDataPath = path.join(root, scenario);
    const backend = createBackend(userDataPath);
    t.after(() => closeBackend(backend));
    let archivePath = validArchive;
    if (scenario === 'future-store') backend.sessionStore.hasNewerSchema = () => true;
    if (scenario === 'future-payload' || scenario === 'malformed') {
      const payload = scenario === 'malformed' ? '{bad' : JSON.stringify({ ...JSON.parse(source.payload), format_version: 2 });
      archivePath = await createPortableArchive(root, [{ ...source, payload }], { name: `${scenario}.jenny-archive` });
    }
    const result = await importConversations({ backend, userDataPath, archivePath,
      ...(scenario === 'disk' ? { statfs: () => ({ bavail: 0, bsize: 4096 }) } : {}) });
    assert.equal(result.ok, false, scenario);
    assert.equal(fs.existsSync(path.join(userDataPath, 'host-import.json')), false, scenario);
    assert.deepEqual(backend.sessionStore.getSessionIds(), []);
    assert.equal(fs.readdirSync(userDataPath).some((name) => name.startsWith('.host-import-')), false);
  }
});

test('import rejects malformed UTF-8 and a nonempty shadow store before canonical mutation', async (t) => {
  const root = tempRoot(t, 'jenny-host-import-strict-');
  const source = sourceSession(root, 'strict');
  const invalidArchive = await createPortableArchive(root, [{ ...source,
    payload: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]) }], { name: 'invalid-utf8.jenny-archive' });
  const invalidRoot = path.join(root, 'invalid-utf8');
  const invalidBackend = createBackend(invalidRoot);
  t.after(() => closeBackend(invalidBackend));
  const invalid = await importConversations({ backend: invalidBackend, userDataPath: invalidRoot,
    archivePath: invalidArchive });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.reason, 'session_payload_invalid');
  assert.deepEqual(invalidBackend.sessionStore.getSessionIds(), []);
  assert.equal(fs.existsSync(path.join(invalidRoot, 'host-import.json')), false);

  const validArchive = await createPortableArchive(root, [source], { name: 'shadow-check.jenny-archive' });
  const shadowRoot = path.join(root, 'shadow-nonempty');
  const shadowBackend = createBackend(shadowRoot);
  t.after(() => closeBackend(shadowBackend));
  shadowBackend.shadowStore.upsertSession('sess_shadow_only', { title: 'Preserve shadow', messages: [] });
  const shadow = await importConversations({ backend: shadowBackend, userDataPath: shadowRoot,
    archivePath: validArchive });
  assert.equal(shadow.ok, false);
  assert.equal(shadow.error.reason, 'profile_not_empty');
  assert.deepEqual(shadowBackend.sessionStore.getSessionIds(), []);
  assert.ok(shadowBackend.shadowStore.getSession('sess_shadow_only'));
  assert.equal(fs.existsSync(path.join(shadowRoot, 'host-import.json')), false);
});

test('failed import-stage cleanup is diagnosed and retried on an exact receipt retry', async (t) => {
  const root = tempRoot(t, 'jenny-host-import-cleanup-');
  const source = sourceSession(root, 'cleanup');
  const archivePath = await createPortableArchive(root, [source]);
  const userDataPath = path.join(root, 'hosted-profile');
  const staleStage = path.join(userDataPath, '.host-import-stale_stage');
  fs.mkdirSync(staleStage, { recursive: true });
  fs.writeFileSync(path.join(staleStage, 'leftover'), 'preserve until retry');
  const backend = createBackend(userDataPath);
  t.after(() => closeBackend(backend));
  const logs = [];
  backend._emitServiceLog = (level, event, fields) => logs.push({ level, event, fields });
  const remove = fs.promises.rm;
  let injected = false;
  fs.promises.rm = async (target, options) => {
    if (!injected && path.resolve(target) === path.resolve(staleStage)) {
      injected = true;
      throw Object.assign(new Error('simulated cleanup denial'), { code: 'EPERM' });
    }
    return remove(target, options);
  };
  let imported;
  try {
    imported = await importConversations({ backend, userDataPath, archivePath });
  } finally {
    fs.promises.rm = remove;
  }
  assert.equal(imported.ok, true);
  assert.equal(fs.existsSync(staleStage), true);
  assert.deepEqual(logs.filter((entry) => entry.event === 'host.import_staging_cleanup_failed'), [{
    level: 'WARN', event: 'host.import_staging_cleanup_failed',
    fields: { phase: 'retry', reason: 'remove_failed' },
  }]);

  const retried = await importConversations({ backend, userDataPath, archivePath });
  assert.deepEqual(retried, imported);
  assert.equal(fs.existsSync(staleStage), false);
});

test('archive category/identity mismatch and excessive ignored categories reject before mutation', async (t) => {
  const root = tempRoot(t, 'jenny-host-import-identity-');
  const source = sourceSession(root, 'identity');
  for (const scenario of ['path', 'category', 'category-count']) {
    const entries = scenario === 'category-count'
      ? Array.from({ length: 129 }, (_, index) => ({ logicalPath: `ignored/${index}.json`, category: `category_${index}`, data: '{}' }))
      : [{ logicalPath: `sessions/${scenario === 'path' ? 'sess_wrong' : source.id}.json`, category: scenario === 'category' ? 'preferences' : 'chats',
        restoreMetadata: { session_id: source.id }, data: source.payload }];
    const { archivePath } = await createArchive({ destinationRoot: path.join(root, 'archives'), archiveName: `${scenario}.jenny-archive`, encrypted: false, entries });
    const userDataPath = path.join(root, scenario);
    const backend = createBackend(userDataPath);
    t.after(() => closeBackend(backend));
    assert.equal((await importConversations({ backend, userDataPath, archivePath })).ok, false);
    assert.equal(fs.existsSync(path.join(userDataPath, 'host-import.json')), false);
    assert.deepEqual(backend.sessionStore.getSessionIds(), []);
  }
});

test('CLI pending receipt guard runs before credential prompt or canonical composition', async (t) => {
  const { runCli } = require('../../server/cli');
  const root = tempRoot(t, 'jenny-host-import-cli-');
  writeJson(path.join(root, 'host-import.json'), { schema_version: 1, state: 'pending', source_manifest_digest: 'a'.repeat(64),
    session_ids: [], imported_count: 0, skipped: { count: 0, categories: [] }, created_at: new Date().toISOString() });
  const before = fs.readdirSync(root);
  let prompted = false;
  let released = false;
  await assert.rejects(runCli(['import-conversations', '--archive', 'source.archive', '--config', 'host.json'], {
    loadHostConfigImpl: () => ({ userDataPath: root }), acquireProfileImpl: () => ({ release: () => { released = true; } }),
    readPasswordImpl: () => { prompted = true; return ''; },
  }), /import_pending/);
  assert.equal(prompted, false);
  assert.equal(released, true);
  assert.deepEqual(fs.readdirSync(root), before);
});

test('an actual empty future canonical index is preserved and receives no import receipt', async (t) => {
  const root = tempRoot(t, 'jenny-host-import-future-index-');
  const source = sourceSession(root, 'future-index');
  const archivePath = await createPortableArchive(root, [source]);
  const userDataPath = path.join(root, 'profile');
  const directory = path.join(userDataPath, 'sessions');
  fs.mkdirSync(directory, { recursive: true });
  const index = path.join(directory, '_index.json');
  const bytes = JSON.stringify({ schema_version: 999, sessions: {}, future_field: 'preserve' });
  fs.writeFileSync(index, bytes);
  const backend = createBackend(userDataPath);
  t.after(() => closeBackend(backend));
  assert.equal(backend.sessionStore.hasNewerSchema(), true);
  const result = await importConversations({ backend, userDataPath, archivePath });
  assert.equal(result.error.reason, 'canonical_schema_future');
  assert.equal(fs.readFileSync(index, 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(userDataPath, 'host-import.json')), false);
});
