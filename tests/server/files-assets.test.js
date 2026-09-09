'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const { AttachmentAssetStore } = require('../../services/attachment-asset-store');
const { readJson, writeJson } = require('../../services/host/durable-json');
const {
  MAX_SELECTED_ATTACHMENTS,
  MAX_SELECTED_SERIALIZED_BYTES,
  MAX_STAGED_IMAGE_BYTES,
  STAGED_TTL_MS,
  createAssetCommands,
} = require('../../services/host/asset-commands');
const { MAX_FILE_CHARS, MAX_FILE_SIZE_BYTES } = require('../../services/attachment-service');
const { createAssetRoutes } = require('../../server/asset-routes');

function pngBytes() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
}

function makeBackend(userDataPath, messages = {}) {
  return {
    attachmentAssetStore: new AttachmentAssetStore({
      rootDir: path.join(userDataPath, 'attachments'),
    }),
    sessionStore: { listSessions: () => Object.keys(messages).map((id) => ({ id, message_count: messages[id].length })), getSessionIds: () => Object.keys(messages), getSessionMessages: (id) => messages[id] || [] },
    async getSessionMessages(sessionId) {
      return { data: messages[sessionId] || [] };
    },
  };
}

function makeTemp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-assets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function responseStub() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    destroyed: false,
    writableEnded: false,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body; this.writableEnded = true; },
  };
}

function getContext({ request, response, pathname, authorized = true }) {
  return { request, response, pathname, deviceId: 'device_1', clientId: 'client_1', authorized };
}

test('staged image uses the real asset store and survives command-surface restart', async (t) => {
  const userDataPath = makeTemp(t);
  const backend = makeBackend(userDataPath);
  const first = createAssetCommands({ backend, userDataPath });
  const uploaded = first.upload({ deviceId: 'device_1', bytes: pngBytes(), displayName: 'capture.png', mimeType: 'image/png' });
  assert.equal(uploaded.ok, true);
  assert.equal(Object.hasOwn(uploaded.attachment, 'asset_path'), false);
  const second = createAssetCommands({ backend: makeBackend(userDataPath), userDataPath });
  const resolved = await second.resolveAttachments([uploaded.attachment.id], { deviceId: 'device_1', sessionId: 'session_1' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.attachments[0].kind, 'image');
  assert.equal(fs.existsSync(resolved.attachments[0].assetPath), true);
  assert.equal(fs.readFileSync(resolved.attachments[0].assetPath).subarray(0, 8).equals(pngBytes().subarray(0, 8)), true);
});

test('text upload reuses attachment preparation limits and does not expose a path', async (t) => {
  const userDataPath = makeTemp(t);
  const commands = createAssetCommands({ backend: makeBackend(userDataPath), userDataPath });
  const uploaded = commands.upload({ deviceId: 'device_1', bytes: Buffer.from('x'.repeat(MAX_FILE_CHARS + 100)), displayName: 'notes.txt', mimeType: 'text/plain' });
  assert.equal(uploaded.ok, true);
  assert.equal(Object.hasOwn(uploaded.attachment, 'path'), false);
  const resolved = await commands.resolveAttachments([uploaded.attachment.id], { deviceId: 'device_1', sessionId: 'session_1' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.attachments[0].truncated, true);
  assert.ok(resolved.attachments[0].text.length <= MAX_FILE_CHARS);
  assert.equal(Object.hasOwn(resolved.attachments[0], 'path'), false);
});

test('upload validates MIME, signatures, sensitive names, and staged byte bounds', (t) => {
  const userDataPath = makeTemp(t);
  const commands = createAssetCommands({ backend: makeBackend(userDataPath), userDataPath });
  assert.equal(commands.upload({ deviceId: 'device_1', bytes: Buffer.from('<html>'), displayName: 'x.html', mimeType: 'text/html' }).error.reason, 'mime_type_unsupported');
  assert.equal(commands.upload({ deviceId: 'device_1', bytes: Buffer.from('not png'), displayName: 'x.png', mimeType: 'image/png' }).error.reason, 'image_signature_invalid');
  assert.equal(commands.upload({ deviceId: 'device_1', bytes: Buffer.from('secret'), displayName: '..\\.env', mimeType: 'text/plain' }).error.reason, 'display_name_invalid');
  assert.equal(commands.upload({ deviceId: 'device_1', bytes: Buffer.alloc(MAX_STAGED_IMAGE_BYTES + 1), displayName: 'x.webp', mimeType: 'image/webp' }).error.reason, 'attachment_size_limit');
});

test('staged records are device-bound, selected-count bounded, and expired records fail closed', async (t) => {
  const userDataPath = makeTemp(t);
  const backend = makeBackend(userDataPath);
  const commands = createAssetCommands({ backend, userDataPath });
  const uploaded = commands.upload({ deviceId: 'device_1', bytes: Buffer.from('hello'), displayName: 'x.txt', mimeType: 'text/plain' });
  assert.equal((await commands.resolveAttachments([uploaded.attachment.id], { deviceId: 'device_2', sessionId: 'session_1' })).error.reason, 'attachment_not_owned');
  const metadataPath = path.join(userDataPath, 'host-attachments.json');
  const metadata = readJson(metadataPath);
  metadata.records[0].expires_at = Date.now() - 1;
  metadata.records[0].created_at = metadata.records[0].expires_at - STAGED_TTL_MS;
  writeJson(metadataPath, metadata);
  const restarted = createAssetCommands({ backend: makeBackend(userDataPath), userDataPath });
  assert.equal((await restarted.resolveAttachments([uploaded.attachment.id], { deviceId: 'device_1', sessionId: 'session_1' })).error.reason, 'attachment_not_owned');
  const ids = [];
  for (let index = 0; index < MAX_SELECTED_ATTACHMENTS; index += 1) {
    const item = restarted.upload({ deviceId: 'device_1', bytes: Buffer.from(`x${index}`), displayName: `x${index}.txt`, mimeType: 'text/plain' });
    ids.push(item.attachment.id);
  }
  assert.equal((await restarted.resolveAttachments([...ids, 'extra'], { deviceId: 'device_1', sessionId: 'session_1' })).error.reason, 'attachment_selection_limit');
  assert.equal(STAGED_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(MAX_SELECTED_SERIALIZED_BYTES, 8 * 1024 * 1024);
});

test('future or malformed staged metadata is fail-closed', (t) => {
  const userDataPath = makeTemp(t);
  const metadataPath = path.join(userDataPath, 'host-attachments.json');
  writeJson(metadataPath, { schema_version: 2, records: [] });
  const commands = createAssetCommands({ backend: makeBackend(userDataPath), userDataPath });
  assert.equal(commands.upload({ deviceId: 'device_1', bytes: Buffer.from('x'), displayName: 'x.txt', mimeType: 'text/plain' }).error.reason, 'asset_metadata_unavailable');
});

test('canonical attachment reads require an exact session reference and never return a private path', async (t) => {
  const userDataPath = makeTemp(t);
  const messages = { session_1: [] };
  const backend = makeBackend(userDataPath, messages);
  const commands = createAssetCommands({ backend, userDataPath });
  const uploaded = commands.upload({ deviceId: 'device_1', bytes: pngBytes(), displayName: 'capture.png', mimeType: 'image/png' });
  const resolved = await commands.resolveAttachments([uploaded.attachment.id], { deviceId: 'device_1', sessionId: 'session_1' });
  messages.session_1.push({ id: 'message_1', role: 'user', attachments: resolved.attachments });
  const read = await commands.readAttachment('session_1', uploaded.attachment.id);
  assert.equal(read.ok, true);
  assert.equal(read.bytes[0], 0x89);
  assert.equal(Object.hasOwn(read.attachment, 'assetPath'), false);
  assert.equal((await commands.readAttachment('session_2', uploaded.attachment.id)).error.reason, 'attachment_reference_not_found');
});

test('asset routes recheck authorization after reading upload bytes and project canonical turn events', async (t) => {
  const userDataPath = makeTemp(t);
  const messages = { session_1: [{
    id: 'message_1', role: 'assistant', content: 'done',
    turn_events: [{ kind: 'assistant_text_segment', payload: { text: 'done' } }],
    attachments: [],
  }] };
  const backend = makeBackend(userDataPath, messages);
  const commands = createAssetCommands({ backend, userDataPath });
  const routes = createAssetRoutes({ commands });
  const body = Buffer.from('hello');
  const deniedResponse = responseStub();
  let checks = 0;
  const deniedRequest = Readable.from([body]);
  deniedRequest.method = 'POST';
  deniedRequest.headers = { 'content-type': 'text/plain', 'content-length': String(body.length), 'x-file-name': encodeURIComponent('notes.txt') };
  await routes(getContext({ request: deniedRequest, response: deniedResponse, pathname: '/api/v1/attachments', authorized: () => ++checks < 2 }));
  assert.equal(deniedResponse.statusCode, 403);
  const messageResponse = responseStub();
  const messageRequest = { method: 'GET', headers: {} };
  await routes(getContext({ request: messageRequest, response: messageResponse, pathname: '/api/v1/sessions/session_1/messages/message_1' }));
  assert.equal(messageResponse.statusCode, 200);
  const payload = JSON.parse(messageResponse.body);
  assert.deepEqual(payload.message.turn_events, messages.session_1[0].turn_events);
  assert.equal(JSON.stringify(payload).includes('assetPath'), false);
});

test('asset routes reject traversal names and oversized declared bodies', async (t) => {
  const userDataPath = makeTemp(t);
  const commands = createAssetCommands({ backend: makeBackend(userDataPath), userDataPath });
  const routes = createAssetRoutes({ commands });
  const traversalResponse = responseStub();
  const traversal = Readable.from([Buffer.from('x')]);
  traversal.method = 'POST';
  traversal.headers = { 'content-type': 'text/plain', 'content-length': '1', 'x-file-name': encodeURIComponent('../secret.txt') };
  await routes(getContext({ request: traversal, response: traversalResponse, pathname: '/api/v1/attachments' }));
  assert.equal(traversalResponse.statusCode, 400);
  const tooLargeResponse = responseStub();
  const tooLarge = Readable.from([]);
  tooLarge.method = 'POST';
  tooLarge.headers = { 'content-type': 'text/plain', 'content-length': String(MAX_STAGED_IMAGE_BYTES + 1) };
  await routes(getContext({ request: tooLarge, response: tooLargeResponse, pathname: '/api/v1/attachments' }));
  assert.equal(tooLargeResponse.statusCode, 429);
});

test('text bytes and later-turn context survive canonical normalization, restart, and staging expiry', async (t) => {
  const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
  const { createAttachmentContentStore } = require('../../services/host/attachment-content-store');
  const userDataPath = makeTemp(t);
  const storePath = path.join(userDataPath, 'sessions.json');
  let sessionStore = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  const backend = makeBackend(userDataPath);
  backend.sessionStore = sessionStore;
  backend.getSessionMessages = async (id) => ({ data: backend.sessionStore.getSessionMessages(id) });
  const session = sessionStore.createSession({ title: 'Durable attachment' });
  const commands = createAssetCommands({ backend, userDataPath });
  const bytes = Buffer.from('A durable document with Unicode: café.');
  const uploaded = commands.upload({ deviceId: 'device_1', bytes, displayName: 'notes.txt', mimeType: 'text/plain' });
  const resolved = await commands.resolveAttachments([uploaded.attachment.id], { deviceId: 'device_1', sessionId: session.id });
  sessionStore.appendMessage(session.id, { id: 'message_document', role: 'user', content: 'Read this', attachments: resolved.attachments });
  await sessionStore.flushAsync(); sessionStore.dispose();
  sessionStore = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  backend.sessionStore = sessionStore;
  t.after(() => sessionStore.dispose());
  const metadataPath = path.join(userDataPath, 'host-attachments.json');
  const metadata = readJson(metadataPath);
  metadata.records[0].expires_at = Date.now() - 1;
  metadata.records[0].created_at = metadata.records[0].expires_at - STAGED_TTL_MS;
  writeJson(metadataPath, metadata);
  const restarted = createAssetCommands({ backend, userDataPath });
  restarted.pruneExpired();
  assert.deepEqual((await restarted.readAttachment(session.id, uploaded.attachment.id)).bytes, bytes);
  const history = sessionStore.getSessionMessages(session.id);
  assert.equal(history[0].attachments[0].text, undefined, 'Canonical schema remains owned by its normalizer');
  const hydrated = createAttachmentContentStore(userDataPath).hydrateHistory(history);
  assert.ok(hydrated[0].content.includes(bytes.toString()));
  assert.equal(history[0].content, 'Read this', 'Prompt hydration does not mutate canonical history');
});

test('all asset result routes fence revocation after await', async () => {
  for (const mode of ['upload', 'readAttachment', 'readMessage']) {
    let active = true;
    const commands = { upload() {}, readAttachment() {}, readMessage() {} };
    commands[mode] = async () => { active = false; return { ok: true, bytes: Buffer.from('private'),
      attachment: { display_name: 'private', mime_type: 'text/plain' }, message: { content: 'private' } }; };
    const response = responseStub();
    const request = { method: mode === 'upload' ? 'POST' : 'GET', body: Buffer.from('x'), headers: { 'content-type': 'text/plain' } };
    const pathname = mode === 'upload' ? '/api/v1/attachments'
      : `/api/v1/sessions/session_1/${mode === 'readMessage' ? 'messages' : 'attachments'}/value_1`;
    await createAssetRoutes({ commands })(getContext({ request, response, pathname, authorized: () => active }));
    assert.equal(response.statusCode, 403);
    assert.equal(String(response.body).includes('private'), false);
  }
});

test('download filenames are valid Node headers for Unicode and punctuation', () => {
  const { validateHeaderValue } = require('node:http');
  const { downloadDisposition } = require('../../server/download-headers');
  for (const name of ['😀 café.txt', "owner's (notes).txt", 'a\\b.txt', '\ud800.txt']) {
    const value = downloadDisposition(name);
    assert.doesNotThrow(() => validateHeaderValue('Content-Disposition', value));
    assert.ok(value.includes('filename*=UTF-8'));
  }
});

test('five images and oversized aggregate text are rejected before turn admission', async (t) => {
  const userDataPath = makeTemp(t);
  const commands = createAssetCommands({ backend: makeBackend(userDataPath), userDataPath });
  const upload = (bytes, mimeType, displayName) => commands.upload({ deviceId: 'device_1', bytes, mimeType, displayName }).attachment.id;
  const images = Array.from({ length: 5 }, () => upload(pngBytes(), 'image/png', 'x.png'));
  const context = { deviceId: 'device_1', sessionId: 'session_1' };
  assert.equal((await commands.resolveAttachments(images, context)).error.reason, 'image_selection_limit');
  assert.equal((await commands.resolveAttachments(images.slice(0, 4), context)).ok, true);
  const texts = Array.from({ length: 4 }, () => upload(Buffer.from('x'.repeat(MAX_FILE_CHARS)), 'text/plain', 'x.txt'));
  assert.equal((await commands.resolveAttachments(texts, context)).error.reason, 'text_selection_limit');
});

test('expiry deletes abandoned image bytes and corrupt metadata remains untouched', (t) => {
  const userDataPath = makeTemp(t);
  const backend = makeBackend(userDataPath);
  const commands = createAssetCommands({ backend, userDataPath });
  commands.upload({ deviceId: 'device_1', bytes: pngBytes(), mimeType: 'image/png', displayName: 'x.png' });
  const file = path.join(userDataPath, 'host-attachments.json');
  const metadata = readJson(file);
  const assetPath = metadata.records[0].attachment.assetPath;
  metadata.records[0].expires_at = Date.now() - 1;
  metadata.records[0].created_at = metadata.records[0].expires_at - STAGED_TTL_MS;
  writeJson(file, metadata);
  createAssetCommands({ backend, userDataPath }).pruneExpired();
  assert.equal(fs.existsSync(assetPath), false);
  fs.writeFileSync(file, '{broken');
  const invalid = createAssetCommands({ backend, userDataPath });
  assert.throws(() => invalid.pruneExpired());
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('missing legacy text is explicit and original bytes remain the sole text source', (t) => {
  const { createAttachmentContentStore } = require('../../services/host/attachment-content-store');
  const root = makeTemp(t);
  const store = createAttachmentContentStore(root);
  const reference = { id: 'attachment_legacy', kind: 'text', displayName: 'legacy.txt', sizeBytes: 3 };
  const history = [{ role: 'user', content: 'Read it', attachments: [reference] }];
  assert.match(store.hydrateHistory(history)[0].content, /content unavailable/);
  store.save({ id: reference.id, text: 'forged' }, Buffer.from('real'));
  assert.equal(store.read(reference.id).text, 'real');
  assert.throws(() => store.read(reference.id, reference.sizeBytes), /invalid_text_asset/);
});

test('canonical inline text reads prefer managed bytes and bound the legacy fallback', async (t) => {
  const { createAttachmentContentStore } = require('../../services/host/attachment-content-store');
  const root = makeTemp(t);
  const reference = { id: 'attachment_inline', kind: 'text', displayName: 'legacy.txt',
    mimeType: 'text/plain', sizeBytes: 4, text: 'fake' };
  const messages = { session_1: [{ id: 'message_1', role: 'user', attachments: [reference] }] };
  const commands = createAssetCommands({ backend: makeBackend(root, messages), userDataPath: root });
  createAttachmentContentStore(root).save(reference, Buffer.from('real'));
  assert.equal((await commands.readAttachment('session_1', reference.id)).bytes.toString('utf8'), 'real');

  createAttachmentContentStore(root).remove(reference.id);
  assert.equal((await commands.readAttachment('session_1', reference.id)).bytes.toString('utf8'), 'fake');
  reference.text = 'x'.repeat(MAX_FILE_SIZE_BYTES + 1);
  assert.equal((await commands.readAttachment('session_1', reference.id)).error.reason, 'attachment_size_limit');
});

test('upload commit ambiguity retains content; expiry commit failure never deletes content first', (t) => {
  const root = makeTemp(t);
  const backend = makeBackend(root);
  let commands = createAssetCommands({ backend, userDataPath: root });
  commands.pruneExpired();
  const metadataPath = path.join(root, 'host-attachments.json');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { rename(from, to); if (to === metadataPath) throw new Error('simulated post-rename fsync failure'); };
  let result;
  try { result = commands.upload({ deviceId: 'device_1', bytes: pngBytes(), mimeType: 'image/png', displayName: 'x.png' }); }
  finally { fs.renameSync = rename; }
  assert.equal(result.ok, false);
  const metadata = readJson(metadataPath);
  const assetPath = metadata.records[0].attachment.assetPath;
  assert.equal(fs.existsSync(assetPath), true);
  metadata.records[0].expires_at = Date.now() - 1;
  metadata.records[0].created_at = metadata.records[0].expires_at - STAGED_TTL_MS;
  writeJson(metadataPath, metadata);
  commands = createAssetCommands({ backend, userDataPath: root });
  fs.renameSync = () => { throw new Error('simulated metadata commit failure'); };
  try { assert.throws(() => commands.pruneExpired()); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(assetPath), true);
  fs.unlinkSync(assetPath);
  const restarted = createAssetCommands({ backend, userDataPath: root });
  assert.doesNotThrow(() => restarted.pruneExpired(), 'Missing expired content can be discarded safely');
});

test('orphan cleanup refuses an incomplete canonical session reference scan', (t) => {
  const root = makeTemp(t);
  const backend = makeBackend(root);
  backend.sessionStore = { listSessions: () => [{ id: 'sess_unreadable', message_count: 1 }],
    peekSession: () => ({ messages: [] }) };
  const commands = createAssetCommands({ backend, userDataPath: root });
  assert.throws(() => commands.pruneExpired(), /empty stub/);
  assert.equal(fs.existsSync(path.join(root, 'host-attachments.json')), false);
});
