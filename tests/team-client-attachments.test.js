'use strict';

// new-test-file: a new module (services/team/chat-attachments.js) and the http client's two chat attachment routes.
//
// Team chat attachments in the member client (row 123 slice 2c renderer): the wire (the upload's percent-encoded
// x-file-name, its checked type, the client headers; a file answered as raw bytes only with an image's type or
// octet-stream), and the module's rules against a fake live link: the 4 MiB cap and the host's name rule before any
// request, a host refusal passed through by its checked reason, a picture answered only for a real image, Download
// written through a partial name that never outlives a failure or a cancel, `attachment_ids` checked before
// anything is sent, and a stop (Force local, leave, revoke) ending an upload and a download in flight with no
// further request.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTeamHttp } = require('../services/team/http-client');
const { MEMBER_PREAMBLE_BYTES } = require('../server/team/transport/preamble');
const { createTeamSession } = require('../services/team/team-session');
const { DOWNLOADS_AT_ONCE, createChatAttachments, saveName } = require('../services/team/chat-attachments');
const { createTeamChats } = require('../services/team/team-chat');
const { validatePayload } = require('../services/team/ipc-methods');
const { createDeferred } = require('./helpers/deferred');

const launchSecret = new Uint8Array(crypto.randomBytes(32));
const TEAM = 'team_' + 'a'.repeat(26);
const ATT = 'att_' + '0'.repeat(26);
const ATT2 = 'att_' + '1'.repeat(26);
// Real headers: a PNG's IHDR, a JPEG's SOF0 after an APP0, a WebP's VP8X (fix list M4 reads the declared size).
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const png = (w, h) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from('IHDR'), u32(w), u32(h),
  Buffer.from([8, 6, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('rest of a picture')]);
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const webp = (w, h) => { const b = Buffer.alloc(40); b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(32, 4); b.write('WEBPVP8X', 8, 'latin1');
  b.writeUInt32LE(10, 16); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };
const PNG = png(64, 48);
const MIB4 = 4 * 1024 * 1024;
const item = (over = {}) => ({ id: ATT, name: 'shot.png', mime: 'image/png', size_bytes: PNG.length, kind: 'image', ...over });

// ------------------------------------------------------------------ the wire

async function rawServer(t, respond) {
  const sockets = [];
  const server = net.createServer((socket) => {
    const record = { chunks: [], socket };
    sockets.push(record);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      record.chunks.push(chunk);
      const all = Buffer.concat(record.chunks).subarray(MEMBER_PREAMBLE_BYTES);
      const head = all.indexOf('\r\n\r\n');
      if (head < 0 || record.done) return;
      const length = Number((/\r\ncontent-length: (\d+)/i.exec(all.toString('latin1', 0, head)) || [])[1] || 0);
      if (all.length - head - 4 >= length) { record.done = true; respond(socket, record); }
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { for (const r of sockets) r.socket.destroy(); server.close(() => resolve()); }));
  return { port: server.address().port, sockets };
}

function reply(socket, status, type, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${status} OK\r\nContent-Type: ${type}\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`, 'latin1'), bytes]));
}

const CLIENT = { client_id: 'client_1', client_token: 'tok_' + 'x'.repeat(40) };

test('an upload goes as a POST to the channel route with the name percent-encoded, its type and the client headers', async (t) => {
  const server = await rawServer(t, (socket) => reply(socket, 200, 'application/json', { ok: true, attachment: item() }));
  const session = createTeamSession({ http: createTeamHttp({ port: server.port, launchSecret }), appVersion: '1.7.1' });
  const name = 'notes <b>ü</b> 1.png';
  const answer = await session.chatUpload(CLIENT, { channelId: 'chan_team', name, type: 'image/png', bytes: PNG });
  assert.deepEqual(answer, { ok: true, attachment: item() });
  const sent = Buffer.concat(server.sockets[0].chunks).subarray(MEMBER_PREAMBLE_BYTES);
  const head = sent.toString('latin1');
  assert.ok(head.startsWith('POST /api/v1/team/chat/uploads/chan_team HTTP/1.1\r\n'));
  assert.match(head, new RegExp(`\\r\\nX-File-Name: ${encodeURIComponent(name).replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')}\\r\\n`, 'i'));
  assert.match(head, /\r\nContent-Type: image\/png\r\n/i);
  assert.match(head, new RegExp(`\\r\\nContent-Length: ${PNG.length}\\r\\n`, 'i'));
  assert.match(head, /\r\nX-Client-Id: client_1\r\n/i);
  assert.ok(sent.subarray(sent.length - PNG.length).equals(PNG), 'the body is the bytes as they are');
});

test('the raw chat routes refuse anything off their shape before a socket opens', async (t) => {
  const server = await rawServer(t, (socket) => reply(socket, 200, 'application/json', { ok: true }));
  const http = createTeamHttp({ port: server.port, launchSecret });
  const refused = (error) => ['team_request_invalid', 'team_path_invalid', 'team_request_too_large'].includes(error.reason);
  const up = '/api/v1/team/chat/uploads/chan_team';
  const file = `/api/v1/team/chat/attachments/chan_team/${ATT}`;
  await assert.rejects(http.postChatUpload('/api/v1/team/chat/uploads/chan_other', PNG, { type: 'image/png' }), refused);
  await assert.rejects(http.postChatUpload(`${up}/x`, PNG, { type: 'image/png' }), refused);
  await assert.rejects(http.postChatUpload(up, PNG, { type: 'Image/PNG; x' }), refused);
  await assert.rejects(http.postChatUpload(up, PNG, {}), refused);
  await assert.rejects(http.postChatUpload(up, Buffer.alloc(0), { type: 'image/png' }), refused);
  await assert.rejects(http.postChatUpload(up, Buffer.alloc(MIB4 + 1), { type: 'image/png' }), refused);
  await assert.rejects(http.getChatFile(file.replace(ATT, 'att_../x')), refused);
  await assert.rejects(http.getChatFile(up), refused);
  await assert.rejects(http.request('POST', up, { body: {} }), refused);
  await assert.rejects(http.request('GET', file), refused);
  await assert.rejects(http.openStream(file), refused);
  await assert.rejects(http.putPart(up, PNG), refused);
  assert.equal(server.sockets.length, 0, 'no socket opened');
});

test('a file comes back as raw bytes only with an image type or octet-stream; any other answer is read as JSON', async (t) => {
  let mode = 'png';
  const server = await rawServer(t, (socket) => {
    if (mode === 'png') reply(socket, 200, 'image/png', PNG);
    else if (mode === 'octet') reply(socket, 200, 'application/octet-stream', Buffer.from('<svg/>'));
    else if (mode === 'html') reply(socket, 200, 'text/html', Buffer.from('<p>x</p>'));
    else reply(socket, 404, 'application/json', { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_chat_not_found' } });
  });
  const session = createTeamSession({ http: createTeamHttp({ port: server.port, launchSecret }), appVersion: '1.7.1' });
  const get = () => session.chatFile(CLIENT, { channelId: 'chan_team', attachmentId: ATT });
  const png = await get();
  assert.equal(png.type, 'image/png');
  assert.ok(png.bytes.equals(PNG));
  mode = 'octet';
  assert.equal((await get()).type, 'application/octet-stream');
  mode = 'html';
  await assert.rejects(get(), (error) => error.reason === 'team_response_invalid');
  mode = 'gone';
  assert.deepEqual(await get(), { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_chat_not_found' } });
});

// ------------------------------------------------------------------ the module, on a fake live link

// A manager whose live link records each raw call; `answers.upload` / `answers.file` answer them (a function or a value).
function fakeLink({ answers = {}, state = 'online' } = {}) {
  const calls = [];
  const commands = [];
  const requestIds = [];
  const status = { state };
  const session = {
    chatUpload: async (client, args) => { calls.push({ kind: 'upload', ...args }); return typeof answers.upload === 'function' ? answers.upload(args) : answers.upload; },
    chatFile: async (client, args) => { calls.push({ kind: 'file', ...args }); return typeof answers.file === 'function' ? answers.file(args) : answers.file; },
  };
  const link = { session, client: CLIENT };
  const manager = {
    snapshot: () => ({ state: status.state, member_id: 'member_me' }),
    borrow: () => ({ online: status.state === 'online', link, ensureClient: async () => null }),
    command: async (operation, params, options) => {
      commands.push({ operation, params });
      requestIds.push(options && options.requestId);
      const posted = typeof answers.post === 'function' ? answers.post(options) : answers.post;
      return posted || { ok: true, message_id: 'msg_' + '2'.repeat(26), seq: 4, rev: 4 };
    },
  };
  return { manager, calls, commands, requestIds, status };
}

function fakeDialogs({ save = null, files = [] } = {}) {
  const shown = [];
  return { shown, pickFiles: async () => files, pickSave: async (name) => { shown.push(name); return typeof save === 'function' ? save() : save; },
    reveal: (file) => shown.push(['reveal', file]), copyImage: () => true };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-chat-att-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const upload = (over = {}) => ({ channel_id: 'chan_team', upload_id: 'up1', name: 'shot.png', type: 'image/png', bytes: new Uint8Array(PNG), ...over });

test('an upload over 4 MiB or with a name the host refuses sends nothing; an odd type goes as octet-stream', async () => {
  const fake = fakeLink({ answers: { upload: { ok: true, attachment: item() } } });
  const att = createChatAttachments({ teamId: TEAM, manager: fake.manager, dialogs: fakeDialogs() });
  assert.equal((await att.handle('chatUpload', upload({ bytes: new ArrayBuffer(MIB4 + 1) }))).error.reason, 'attachment_size_limit');
  for (const name of ['a/b.png', 'a\\b.png', 'x‮evil.png', 'tab\there', '   ', 'x'.repeat(256)]) {
    assert.equal((await att.handle('chatUpload', upload({ name }))).error.reason, 'display_name_invalid', JSON.stringify(name));
  }
  assert.equal(fake.calls.length, 0, 'nothing was sent');
  assert.deepEqual(await att.handle('chatUpload', upload({ type: 'Weird Type' })), { ok: true, attachment: item() });
  assert.equal(fake.calls[0].type, 'application/octet-stream');
  assert.ok(fake.calls[0].bytes.equals(PNG));
  await att.handle('chatUpload', upload({ type: undefined, upload_id: 'up2' }));
  assert.equal(fake.calls[1].type, 'application/octet-stream');
});

test('each host refusal of an upload passes through by its reason; an answer off shape is invalid', async () => {
  const reasons = ['attachment_size_limit', 'team_upload_limit', 'team_chat_storage_limit', 'disk_pressure', 'display_name_invalid',
    'mime_type_unsupported', 'team_chat_request_invalid', 'team_chat_not_found'];
  for (const reason of reasons) {
    const fake = fakeLink({ answers: { upload: { ok: false, error: { code: 'CMP-HOST-0007', reason, retryable: true } } } });
    const att = createChatAttachments({ teamId: TEAM, manager: fake.manager, dialogs: fakeDialogs() });
    const answer = await att.handle('chatUpload', upload());
    assert.equal(answer.ok, false);
    assert.equal(answer.error.reason, reason);
  }
  const bad = createChatAttachments({ teamId: TEAM, manager: fakeLink({ answers: { upload: { ok: true, attachment: item({ name: 'a/b' }) } } }).manager, dialogs: fakeDialogs() });
  assert.equal((await bad.handle('chatUpload', upload())).error.reason, 'team_chat_answer_invalid');
  const offline = fakeLink({ state: 'reconnecting' });
  const off = createChatAttachments({ teamId: TEAM, manager: offline.manager, dialogs: fakeDialogs() });
  assert.equal((await off.handle('chatUpload', upload())).error.reason, 'team_not_connected');
  assert.equal(offline.calls.length, 0);
});

test('chatPost carries attachment_ids: at most 8, distinct, in the host pattern, else refused before anything is sent', () => {
  const base = { team_id: TEAM, channel_id: 'chan_team', text: 'see these' };
  const ids = (n) => Array.from({ length: n }, (_, i) => 'att_' + String(i).padStart(26, '0'));
  assert.equal(validatePayload('chatPost', { ...base, attachment_ids: ids(8) }).ok, true);
  for (const bad of [ids(9), [], [ATT, ATT], ['att_short'], ['msg_' + '0'.repeat(26)], 'att', [1]]) {
    assert.equal(validatePayload('chatPost', { ...base, attachment_ids: bad }).ok, false, JSON.stringify(bad));
  }
  assert.equal(validatePayload('chatUpload', { team_id: TEAM, channel_id: 'chan_team', upload_id: 'up1', name: 'a.png', bytes: 'text' }).ok, false);
  assert.equal(validatePayload('chatUpload', { team_id: TEAM, channel_id: 'chan_team', upload_id: 'up1', name: 'a.png', bytes: new ArrayBuffer(0) }).ok, false);
  assert.equal(validatePayload('chatUpload', { team_id: TEAM, channel_id: 'chan_team', upload_id: 'up 1', name: 'a.png', bytes: new ArrayBuffer(1) }).ok, false);
  assert.equal(validatePayload('chatAttachPick', { team_id: TEAM, room: 9 }).ok, false);
  assert.equal(validatePayload('chatAttachmentImage', { team_id: TEAM, channel_id: 'chan_team', attachment_id: 'att_x' }).ok, false);
});

test('a post with files is sent online as one host command and refused offline with nothing sent', async () => {
  const fake = fakeLink();
  const att = createChatAttachments({ teamId: TEAM, manager: fake.manager, dialogs: fakeDialogs() });
  const value = { channel_id: 'chan_team', text: 'look', attachment_ids: [ATT, ATT2] };
  assert.deepEqual(await att.handle('chatPost', value), { ok: true, message_id: 'msg_' + '2'.repeat(26), seq: 4, rev: 4 });
  assert.deepEqual(fake.commands, [{ operation: 'team.chat.post', params: value }]);
  fake.status.state = 'offline';
  assert.equal((await att.handle('chatPost', value)).error.reason, 'team_not_connected');
  assert.equal(fake.commands.length, 1, 'never queued, never sent offline');
  assert.match(fake.requestIds[0], /^[A-Za-z0-9_-]{1,128}$/, 'it carries a request id (fix list S1)');
});

test('a post whose answer was lost is sent once more under the same request id, and the host posts it once (T4)', async () => {
  const posted = new Map(); // what the host records by request id: a repeat is answered from the record
  let drop = true;
  const fake = fakeLink({ answers: { post: ({ requestId }) => {
    if (!posted.has(requestId)) posted.set(requestId, { ok: true, message_id: 'msg_' + '3'.repeat(26), seq: 5, rev: 5 });
    if (drop) { drop = false; return { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_connection_reset' } }; }
    return posted.get(requestId);
  } } });
  const att = createChatAttachments({ teamId: TEAM, manager: fake.manager, dialogs: fakeDialogs() });
  const answer = await att.handle('chatPost', { channel_id: 'chan_team', text: 'look', attachment_ids: [ATT] });
  assert.equal(answer.ok, true);
  assert.equal(fake.commands.length, 2);
  assert.equal(fake.requestIds[0], fake.requestIds[1], 'the same id both times');
  assert.equal(posted.size, 1, 'one post reached the host');
  const refused = fakeLink({ answers: { post: { ok: false, error: { code: 'CMP-HOST-0001', reason: 'role_forbidden' } } } });
  await createChatAttachments({ teamId: TEAM, manager: refused.manager, dialogs: fakeDialogs() }).handle('chatPost', { channel_id: 'chan_team', text: 'x', attachment_ids: [ATT] });
  assert.equal(refused.commands.length, 1, 'a refusal is not sent again');
});

test('a picture is answered as a data: URL only when served as an image whose bytes match', async () => {
  let answer = { ok: true, bytes: PNG, type: 'image/png' };
  const fake = fakeLink({ answers: { file: () => answer } });
  const att = createChatAttachments({ teamId: TEAM, manager: fake.manager, dialogs: fakeDialogs() });
  const value = { channel_id: 'chan_team', attachment_id: ATT };
  assert.deepEqual(await att.handle('chatAttachmentImage', value), { ok: true, data_url: 'data:image/png;base64,' + PNG.toString('base64') });
  for (const wrong of [{ ok: true, bytes: Buffer.from('<svg/>'), type: 'application/octet-stream' }, { ok: true, bytes: PNG, type: 'application/octet-stream' },
    { ok: true, bytes: Buffer.from('<html>'), type: 'image/png' }, { ok: true, bytes: PNG, type: 'image/jpeg' }]) {
    answer = wrong;
    assert.equal((await att.handle('chatAttachmentImage', value)).error.reason, 'team_attachment_not_image');
  }
});

test('a picture over 8192 px a side or 40 megapixels, or with a header that cannot be read, is neither drawn nor copied (M4)', async () => {
  let answer = null;
  const fake = fakeLink({ answers: { file: () => answer } });
  const copied = [];
  const dialogs = { ...fakeDialogs(), copyImage: (bytes) => { copied.push(bytes.length); return true; } };
  const att = createChatAttachments({ teamId: TEAM, manager: fake.manager, dialogs });
  const value = { channel_id: 'chan_team', attachment_id: ATT };
  const cases = [[png(8192, 4096), 'image/png', true], [jpeg(100, 80), 'image/jpeg', true], [webp(640, 480), 'image/webp', true],
    [png(8193, 10), 'image/png', false], [png(7000, 7000), 'image/png', false], [png(30000, 30000), 'image/png', false],
    [jpeg(30000, 300), 'image/jpeg', false], [webp(9000, 1), 'image/webp', false], [png(0, 10), 'image/png', false],
    [Buffer.concat([PNG.subarray(0, 8), Buffer.from('no header at all here')]), 'image/png', false],
    [Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg', false], [Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'image/webp', false]];
  for (const [bytes, type, ok] of cases) {
    answer = { ok: true, bytes, type };
    const drawn = await att.handle('chatAttachmentImage', value);
    const copy = await att.handle('chatAttachmentCopy', value);
    assert.equal(drawn.ok, ok, `${type} ${bytes.length} drawn`);
    assert.equal(copy.ok, ok, `${type} ${bytes.length} copied`);
    if (!ok) { assert.equal(drawn.error.reason, 'team_attachment_not_image'); assert.equal(copy.error.reason, 'team_attachment_not_image'); }
  }
  assert.equal(copied.length, 3, 'only the pictures in bounds reached the clipboard');
});

test('at most 3 picture reads and saves fetch at once; the rest wait their turn (S7)', async () => {
  const gates = [];
  const fake = fakeLink({ answers: { file: () => new Promise((resolve) => { gates.push(resolve); }) } });
  const att = createChatAttachments({ teamId: TEAM, manager: fake.manager, dialogs: fakeDialogs() });
  const pending = Array.from({ length: 5 }, () => att.handle('chatAttachmentImage', { channel_id: 'chan_team', attachment_id: ATT }));
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(DOWNLOADS_AT_ONCE, 3);
  assert.equal(fake.calls.length, 3);
  gates.shift()({ ok: true, bytes: PNG, type: 'image/png' });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(fake.calls.length, 4, 'a slot freed starts the next');
  att.stop();
  for (const resolve of gates.splice(0)) resolve({ ok: true, bytes: PNG, type: 'image/png' });
  const answers = await Promise.all(pending);
  assert.equal(answers[0].ok, true);
  assert.equal(answers[4].error.reason, 'team_connection_stopped', 'one still waiting ends at a stop with no request');
  assert.equal(fake.calls.length, 4);
});

test('the paperclip reads the picked files in main: bounded, only files with bytes, the rest counted as not added (T6)', async (t) => {
  const dir = tempDir(t);
  const write = (name, bytes) => { const file = path.join(dir, name); fs.writeFileSync(file, bytes); return file; };
  const files = [write('notes.txt', 'hello'), write('empty.txt', ''), write('big.png', Buffer.alloc(MIB4 + 1)), path.join(dir), 'relative.txt', write('late.pdf', 'x')];
  const att = createChatAttachments({ teamId: TEAM, manager: fakeLink().manager, dialogs: fakeDialogs({ files }) });
  const answer = await att.handle('chatAttachPick', { room: 5 });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.files.map((f) => [f.name, f.type, f.size, f.bytes ? f.bytes.length : null]),
    [['notes.txt', 'text/plain', 5, 5], ['big.png', 'image/png', MIB4 + 1, null], ['late.pdf', 'application/pdf', 1, 1]], 'a relative path, an empty file and a folder are left out; over 4 MiB is sized, not read');
  assert.equal(answer.not_added, 0);
  const few = createChatAttachments({ teamId: TEAM, manager: fakeLink().manager, dialogs: fakeDialogs({ files: [files[0], files[5], files[0]] }) });
  const room = await few.handle('chatAttachPick', { room: 2 });
  assert.equal(room.files.length, 2);
  assert.equal(room.not_added, 1);
});

test('uploads: a duplicate upload id is refused, a fifth in flight is refused by the local limit of 4 (T6)', async () => {
  const fake = fakeLink({ answers: { upload: () => new Promise(() => {}) } });
  const att = createChatAttachments({ teamId: TEAM, manager: fake.manager, dialogs: fakeDialogs() });
  for (const id of ['u1', 'u2', 'u3', 'u4']) void att.handle('chatUpload', upload({ upload_id: id }));
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal((await att.handle('chatUpload', upload({ upload_id: 'u1' }))).error.reason, 'team_request_invalid');
  assert.equal((await att.handle('chatUpload', upload({ upload_id: 'u5' }))).error.reason, 'team_upload_limit');
  assert.equal(fake.calls.length, 4);
  att.stop();
});

test('Show in folder for a file not saved here is refused; a rename that fails after the partial exists leaves nothing (T6)', async (t) => {
  const dir = tempDir(t);
  const fake = fakeLink({ answers: { file: { ok: true, bytes: Buffer.from('%PDF'), type: 'application/octet-stream' } } });
  const blocked = path.join(dir, 'taken');
  fs.mkdirSync(blocked); // a folder where the file would go: the rename onto it fails
  const att = createChatAttachments({ teamId: TEAM, manager: fake.manager, dialogs: fakeDialogs({ save: blocked }) });
  assert.equal((await att.handle('chatAttachmentReveal', { attachment_id: ATT })).error.reason, 'team_attachment_not_saved');
  assert.equal((await att.handle('chatAttachmentSave', { channel_id: 'chan_team', attachment_id: ATT, name: 'taken' })).error.reason, 'team_download_write_failed');
  assert.deepEqual(fs.readdirSync(dir), ['taken'], 'no partial file is left');
  assert.equal((await att.handle('chatAttachmentReveal', { attachment_id: ATT })).error.reason, 'team_attachment_not_saved');
});

test('Download writes through a partial name: saved in place, nothing left after a failure, a cancel or a stop', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'report.pdf');
  let answer = { ok: true, bytes: Buffer.from('%PDF-1.7 bytes'), type: 'application/octet-stream' };
  let save = target;
  const fake = fakeLink({ answers: { file: () => (typeof answer === 'function' ? answer() : answer) } });
  const dialogs = fakeDialogs({ save: () => save });
  const att = createChatAttachments({ teamId: TEAM, manager: fake.manager, dialogs });
  const value = { channel_id: 'chan_team', attachment_id: ATT, name: '../x/<report>.pdf' };
  assert.deepEqual(await att.handle('chatAttachmentSave', value), { ok: true, saved: true, folder: path.basename(dir) });
  assert.equal(dialogs.shown[0], '_report_.pdf', 'the suggested name is a cleaned base name');
  assert.equal(fs.readFileSync(target, 'utf8'), '%PDF-1.7 bytes');
  assert.deepEqual(fs.readdirSync(dir), ['report.pdf']);
  assert.deepEqual(await att.handle('chatAttachmentReveal', { attachment_id: ATT }), { ok: true });
  // Cancelled dialog: nothing fetched, nothing said.
  save = null;
  const before = fake.calls.length;
  assert.deepEqual(await att.handle('chatAttachmentSave', value), { ok: true, saved: false });
  assert.equal(fake.calls.length, before);
  // A refusal after the dialog: nothing written.
  save = path.join(dir, 'gone.pdf');
  answer = { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_chat_not_found' } };
  assert.equal((await att.handle('chatAttachmentSave', value)).error.reason, 'team_chat_not_found');
  // A folder that is not there: the write fails and leaves nothing.
  answer = { ok: true, bytes: Buffer.from('x'), type: 'application/octet-stream' };
  save = path.join(dir, 'missing', 'x.pdf');
  assert.equal((await att.handle('chatAttachmentSave', value)).error.reason, 'team_download_write_failed');
  // A stop while the file is fetched: nothing written, and the call ends.
  const held = createDeferred();
  answer = () => held.promise;
  save = path.join(dir, 'late.pdf');
  const pending = att.handle('chatAttachmentSave', value);
  await new Promise((resolve) => { setImmediate(resolve); });
  att.stop();
  held.resolve({ ok: true, bytes: Buffer.from('late'), type: 'application/octet-stream' });
  assert.equal((await pending).error.reason, 'team_connection_stopped');
  assert.deepEqual(fs.readdirSync(dir), ['report.pdf'], 'no partial and no late file');
  assert.equal(saveName('..'), 'file');
  assert.equal(saveName('re\u202eport\u200b.pdf. . '), 'report.pdf', 'format characters and trailing dots and spaces go (S8)');
});

test('a stop ends an upload in flight and refuses every later call with no request', async () => {
  const held = createDeferred();
  let signal = null;
  const fake = fakeLink({ answers: { upload: (args) => { signal = args.signal; return held.promise; } } });
  const att = createChatAttachments({ teamId: TEAM, manager: fake.manager, dialogs: fakeDialogs() });
  const pending = att.handle('chatUpload', upload());
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(att.inFlight(), 1);
  att.stop();
  assert.equal(signal.aborted, true, 'the request was ended');
  held.resolve({ ok: true, attachment: item() });
  assert.equal((await pending).error.reason, 'team_connection_stopped');
  const calls = fake.calls.length;
  for (const [method, value] of [['chatUpload', upload({ upload_id: 'up9' })], ['chatAttachmentImage', { channel_id: 'chan_team', attachment_id: ATT }],
    ['chatPost', { channel_id: 'chan_team', text: 'x', attachment_ids: [ATT] }]]) {
    assert.equal((await att.handle(method, value)).error.reason, 'team_connection_stopped', method);
  }
  assert.equal(fake.calls.length, calls);
  assert.equal(fake.commands.length, 0);
});

test('chatUploadCancel ends that upload only', async () => {
  const gates = new Map();
  const fake = fakeLink({ answers: { upload: (args) => new Promise((resolve) => { gates.set(args.signal, resolve); args.signal.addEventListener('abort', () => resolve(null)); }) } });
  const att = createChatAttachments({ teamId: TEAM, manager: fake.manager, dialogs: fakeDialogs() });
  const one = att.handle('chatUpload', upload({ upload_id: 'one' }));
  const two = att.handle('chatUpload', upload({ upload_id: 'two' }));
  await new Promise((resolve) => { setImmediate(resolve); });
  await att.handle('chatUploadCancel', { upload_id: 'one' });
  assert.equal((await one).ok, false);
  for (const [signal, resolve] of gates) if (!signal.aborted) resolve({ ok: true, attachment: item() });
  assert.equal((await two).ok, true);
});

// ------------------------------------------------------------------ routing, Force local and leave

test('the team chats route attachment calls per team; a hold (detach) and a leave (drop) end transfers and send nothing more', async (t) => {
  const userDataPath = tempDir(t);
  const held = createDeferred();
  const fake = fakeLink({ answers: { file: () => held.promise, upload: () => new Promise(() => {}) } });
  const manager = { ...fake.manager, onEvent: () => () => {} };
  const chats = createTeamChats({ userDataPath, defer: (fn) => setImmediate(fn), attachmentOptions: { dialogs: fakeDialogs() } });
  t.after(() => chats.stopAll());
  chats.attach(TEAM, manager);
  const picture = chats.handle('chatAttachmentImage', { team_id: TEAM, channel_id: 'chan_team', attachment_id: ATT });
  const up = chats.handle('chatUpload', { team_id: TEAM, ...upload() });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(fake.calls.map((call) => call.kind).sort(), ['file', 'upload']);
  chats.detach(TEAM); // what a Force local hold does to each team (team-service-hold.js stopHeld)
  assert.equal((await picture).ok, false);
  assert.equal((await up).ok, false);
  const before = fake.calls.length;
  assert.equal((await chats.handle('chatUpload', { team_id: TEAM, ...upload() })).error.reason, 'team_not_found');
  chats.attach(TEAM, manager);
  const again = chats.handle('chatAttachmentImage', { team_id: TEAM, channel_id: 'chan_team', attachment_id: ATT });
  await new Promise((resolve) => { setImmediate(resolve); });
  chats.drop(TEAM); // leave or Remove team
  assert.equal((await again).ok, false);
  assert.equal((await chats.handle('chatAttachmentImage', { team_id: TEAM, channel_id: 'chan_team', attachment_id: ATT })).error.reason, 'team_not_found');
  assert.equal(fake.calls.length, before + 1);
  held.resolve({ ok: true, bytes: PNG, type: 'image/png' });
});
