'use strict';

// Row 94 P4: the port behind the Jenny chat's `session_export` tool and its card.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPrimaryChatExportService, exportFileName } = require('../services/primary-chat-export-service');

const PRIMARY = 'p1';
const TARGET = 's1';
const TITLE = 'Release notes';
const FILE_NAME = 'Jenny - Release notes - 2026-11-02 0905.md';
const SECRET = 'sk-proj-secretsecretsecretsecret';
const WIN_PATH = 'C:\\Users\\someone\\secret\\notes.txt';
const MESSAGES = [
  { id: 'm1', role: 'user', content: `Ship the build with key ${SECRET}`, timestamp: '2026-11-02T08:00:00Z' },
  { id: 'm2', role: 'assistant', content: `Saved the draft to ${WIN_PATH} and done.`, timestamp: '2026-11-02T08:01:00Z' },
  { id: 'm3', role: 'assistant', content: '', timestamp: '2026-11-02T08:02:00Z' },
  { id: 'm4', role: 'system', content: 'internal note', timestamp: '2026-11-02T08:03:00Z' },
  { id: 'm5', role: 'assistant', kind: 'question_batch', content: 'Pick one', timestamp: '2026-11-02T08:04:00Z' },
];
const CARD = { session_id: PRIMARY, tool_call_id: 'call_1', target_session_id: TARGET, chat_title: TITLE };
const EXPORT = { caller_session_id: PRIMARY, tool_call_id: 'call_1', session_id: TARGET, chat_title: TITLE };

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harness(t, {
  flags = {}, primary = PRIMARY, host = 'desktop', messages = MESSAGES, visible = true, title = TITLE,
  downloads, protectedRoots = [],
} = {}) {
  const clock = { at: new Date(2026, 10, 2, 9, 5, 30).getTime() };
  const logs = [];
  const digests = [];
  const dir = downloads === undefined ? tempDir(t, 'jenny-dl-') : downloads;
  const service = createPrimaryChatExportService({
    sessionStore: () => ({ peekSession: (id) => (id === TARGET ? { id, messages } : null) }),
    sessionDirectory: () => ({
      title: async (request) => {
        digests.push(request);
        return visible && request.sessionId === TARGET ? { ok: true, title } : { ok: false, reason: 'not_found' };
      },
    }),
    featureFlags: () => flags,
    primarySessionId: () => primary,
    hostMode: () => host,
    getDownloadsDir: () => dir,
    protectedPaths: () => protectedRoots,
    now: () => new Date(clock.at),
    log: (level, event, details) => logs.push({ level, event, details }),
  });
  return { service, clock, logs, digests, dir };
}

test('exports a redacted Markdown copy under the prepared card', async (t) => {
  const { service, dir, digests, logs } = harness(t);
  assert.deepEqual(await service.prepareCard(CARD), { ok: true, chat_title: TITLE, file_name: FILE_NAME });
  assert.deepEqual(digests[0], { callerSessionId: PRIMARY, sessionId: TARGET });
  const answer = await service.exportChat(EXPORT);
  assert.equal(answer.ok, true);
  assert.equal(answer.file_name, FILE_NAME);
  assert.equal(answer.messages, 2);
  assert.ok(!JSON.stringify(answer).includes(dir), 'the answer never carries the folder');
  const content = fs.readFileSync(path.join(dir, FILE_NAME), 'utf8');
  assert.equal(answer.bytes, Buffer.byteLength(content, 'utf8'));
  assert.ok(content.startsWith('# Release notes\n\nExported from Jenny on 2026-11-02 09:05.\n\n'));
  assert.match(content, /## You/);
  assert.match(content, /Ship the build with key/);
  assert.match(content, /## Jenny/);
  assert.match(content, /Saved the draft to/);
  assert.ok(!content.includes(SECRET), 'the secret is redacted');
  assert.match(content, /\[redacted:secret\]/);
  assert.ok(!content.includes('C:\\Users\\someone'), 'the absolute path is redacted');
  assert.ok(content.includes('[redacted:path]\\notes.txt'));
  assert.ok(!content.includes('internal note') && !content.includes('Pick one'), 'only user and assistant text is exported');
  const written = logs.find((entry) => entry.event === 'primary_chat_export.written');
  assert.deepEqual(written, { level: 'INFO', event: 'primary_chat_export.written', details: { bytes: answer.bytes, messages: 2 } });
});

test('a name collision writes a numbered copy', async (t) => {
  const { service, dir } = harness(t);
  fs.writeFileSync(path.join(dir, FILE_NAME), 'existing');
  await service.prepareCard(CARD);
  const answer = await service.exportChat(EXPORT);
  assert.equal(answer.ok, true);
  assert.equal(answer.file_name, 'Jenny - Release notes - 2026-11-02 0905 (2).md');
  assert.equal(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'), 'existing');
  assert.ok(fs.existsSync(path.join(dir, answer.file_name)));
});

test('twenty collisions refuse with write_failed', async (t) => {
  const { service, dir } = harness(t);
  fs.writeFileSync(path.join(dir, FILE_NAME), 'x');
  for (let n = 2; n <= 20; n += 1) fs.writeFileSync(path.join(dir, `Jenny - Release notes - 2026-11-02 0905 (${n}).md`), 'x');
  await service.prepareCard(CARD);
  assert.deepEqual(await service.exportChat(EXPORT), { ok: false, reason: 'write_failed' });
});

test('an export needs its own card, used once and before it expires', async (t) => {
  const { service, clock, dir } = harness(t);
  assert.deepEqual(await service.exportChat(EXPORT), { ok: false, reason: 'not_allowed' });
  await service.prepareCard(CARD);
  assert.deepEqual(await service.exportChat({ ...EXPORT, session_id: 'other' }), { ok: false, reason: 'not_allowed' });
  await service.prepareCard(CARD);
  assert.equal((await service.exportChat(EXPORT)).ok, true);
  assert.deepEqual(await service.exportChat(EXPORT), { ok: false, reason: 'not_allowed' });
  // A card outlives the longest approval wait (an unattended-pause card waits up to 4 hours), then expires.
  await service.prepareCard({ ...CARD, tool_call_id: 'call_3' });
  clock.at += 4 * 60 * 60 * 1000;
  assert.equal((await service.exportChat({ ...EXPORT, tool_call_id: 'call_3' })).ok, true);
  await service.prepareCard({ ...CARD, tool_call_id: 'call_2' });
  clock.at += 4 * 60 * 60 * 1000 + 10 * 60 * 1000 + 1;
  assert.deepEqual(await service.exportChat({ ...EXPORT, tool_call_id: 'call_2' }), { ok: false, reason: 'not_allowed' });
  assert.equal(fs.readdirSync(dir).length, 2);
});

test('the card store keeps the newest 32 cards', async (t) => {
  const { service } = harness(t);
  for (let n = 0; n < 33; n += 1) await service.prepareCard({ ...CARD, tool_call_id: `c${n}` });
  assert.deepEqual(await service.exportChat({ ...EXPORT, tool_call_id: 'c0' }), { ok: false, reason: 'not_allowed' });
  assert.equal((await service.exportChat({ ...EXPORT, tool_call_id: 'c32' })).ok, true);
});

test('only the Jenny chat may export, with the switch on, on the desktop', async (t) => {
  assert.deepEqual(await harness(t, { primary: 'someone-else' }).service.prepareCard(CARD), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(await harness(t, { flags: { primary_chat_export: false } }).service.prepareCard(CARD), { ok: false, reason: 'disabled' });
  assert.deepEqual(await harness(t, { host: 'server' }).service.prepareCard(CARD), { ok: false, reason: 'unavailable' });
  const flags = {};
  const flagged = harness(t, { flags });
  await flagged.service.prepareCard(CARD);
  flags.primary_chat_export = false; // switched off between the card and the write
  assert.deepEqual(await flagged.service.exportChat(EXPORT), { ok: false, reason: 'disabled' });
  assert.deepEqual(fs.readdirSync(flagged.dir), []);
  assert.deepEqual(await harness(t, { primary: 'x' }).service.exportChat(EXPORT), { ok: false, reason: 'not_allowed' });
});

test('malformed input is refused before any lookup', async (t) => {
  const { service, digests } = harness(t);
  for (const patch of [{ tool_call_id: '' }, { tool_call_id: 'x'.repeat(257) }, { target_session_id: '' },
    { target_session_id: 7 }, { chat_title: '' }, { chat_title: '   ' }, { chat_title: 'x'.repeat(201) }]) {
    assert.deepEqual(await service.prepareCard({ ...CARD, ...patch }), { ok: false, reason: 'invalid_input' });
  }
  assert.equal(digests.length, 0);
});

test('a chat outside the caller scope is not_found', async (t) => {
  const { service } = harness(t, { visible: false });
  assert.deepEqual(await service.prepareCard(CARD), { ok: false, reason: 'not_found' });
});

test('a chat that leaves the scope after the card is not_found', async (t) => {
  let visible = true;
  const dir = tempDir(t, 'jenny-dl-');
  const service = createPrimaryChatExportService({
    sessionStore: () => ({ peekSession: () => ({ messages: MESSAGES }) }),
    sessionDirectory: () => ({ title: async () => (visible ? { ok: true, title: TITLE } : { ok: false, reason: 'not_found' }) }),
    primarySessionId: () => PRIMARY, getDownloadsDir: () => dir,
  });
  await service.prepareCard(CARD);
  visible = false;
  assert.deepEqual(await service.exportChat(EXPORT), { ok: false, reason: 'not_found' });
});

test('a title that names another chat returns the real title', async (t) => {
  const { service } = harness(t, { title: '  Release   NOTES ' });
  assert.equal((await service.prepareCard(CARD)).ok, true, 'case and spacing are not a different chat');
  const other = harness(t, { title: 'Budget review' });
  assert.deepEqual(await other.service.prepareCard(CARD), { ok: false, reason: 'title_mismatch', chat_title: 'Budget review' });
});

test('a chat with no user or assistant text is empty', async (t) => {
  const { service } = harness(t, { messages: [MESSAGES[2], MESSAGES[3], MESSAGES[4]] });
  assert.deepEqual(await service.prepareCard(CARD), { ok: false, reason: 'empty' });
  assert.deepEqual(await harness(t, { messages: [] }).service.prepareCard(CARD), { ok: false, reason: 'empty' });
});

test('a Downloads folder inside a protected root is refused', async (t) => {
  const root = tempDir(t, 'jenny-prot-');
  const same = harness(t, { downloads: root, protectedRoots: [root] });
  await same.service.prepareCard(CARD);
  assert.deepEqual(await same.service.exportChat(EXPORT), { ok: false, reason: 'protected_folder' });
  const inner = path.join(root, 'Downloads');
  fs.mkdirSync(inner);
  const nested = harness(t, { downloads: inner, protectedRoots: [root] });
  await nested.service.prepareCard(CARD);
  assert.deepEqual(await nested.service.exportChat(EXPORT), { ok: false, reason: 'protected_folder' });
  assert.deepEqual(fs.readdirSync(inner), []);
});

test('a junction Downloads that resolves into a protected root is refused', async (t) => {
  const root = tempDir(t, 'jenny-prot-');
  const outside = tempDir(t, 'jenny-link-');
  const link = path.join(outside, 'Downloads');
  try {
    fs.symlinkSync(root, link, 'junction');
  } catch (_error) {
    t.skip('junction creation is unavailable here');
    return;
  }
  const { service } = harness(t, { downloads: link, protectedRoots: [root] });
  await service.prepareCard(CARD);
  assert.deepEqual(await service.exportChat(EXPORT), { ok: false, reason: 'protected_folder' });
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a missing Downloads folder is no_folder', async (t) => {
  const parent = tempDir(t, 'jenny-dl-');
  const missing = harness(t, { downloads: path.join(parent, 'gone') });
  await missing.service.prepareCard(CARD);
  assert.deepEqual(await missing.service.exportChat(EXPORT), { ok: false, reason: 'no_folder' });
  const file = path.join(parent, 'file.txt');
  fs.writeFileSync(file, 'x');
  const notDir = harness(t, { downloads: file });
  await notDir.service.prepareCard(CARD);
  assert.deepEqual(await notDir.service.exportChat(EXPORT), { ok: false, reason: 'no_folder' });
  const none = harness(t, { downloads: null });
  await none.service.prepareCard(CARD);
  assert.deepEqual(await none.service.exportChat(EXPORT), { ok: false, reason: 'no_folder' });
});

test('an export over 8 MiB is too_large', async (t) => {
  const big = [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024 + 1) }];
  const { service, dir, logs } = harness(t, { messages: big });
  await service.prepareCard(CARD);
  assert.deepEqual(await service.exportChat(EXPORT), { ok: false, reason: 'too_large' });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(logs.at(-1), { level: 'WARN', event: 'primary_chat_export.failed', details: { reason: 'too_large' } });
});

test('a throwing dependency is unavailable, never a throw', async () => {
  const service = createPrimaryChatExportService({
    primarySessionId: () => PRIMARY,
    sessionDirectory: () => { throw new Error('boom at C:\\secret'); },
  });
  assert.deepEqual(await service.prepareCard(CARD), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await service.exportChat(EXPORT), { ok: false, reason: 'not_allowed' });
});

test('exportFileName makes a safe local-time file name', () => {
  const at = new Date(2026, 0, 5, 7, 3);
  assert.equal(exportFileName('Plan', at), 'Jenny - Plan - 2026-01-05 0703.md');
  assert.equal(exportFileName('a<b>c:d"e/f\\g|h?i*j\u0001k\u007fl', at), 'Jenny - a b c d e f g h i j k l - 2026-01-05 0703.md');
  assert.equal(exportFileName('  spaced   out...  ', at), 'Jenny - spaced out - 2026-01-05 0703.md');
  assert.equal(exportFileName('', at), 'Jenny - Chat - 2026-01-05 0703.md');
  assert.equal(exportFileName('???', at), 'Jenny - Chat - 2026-01-05 0703.md');
  assert.equal(exportFileName(null, at), 'Jenny - Chat - 2026-01-05 0703.md');
  assert.equal(exportFileName('con', at), 'Jenny - Chat con - 2026-01-05 0703.md');
  assert.equal(exportFileName('LPT9.txt', at), 'Jenny - Chat LPT9.txt - 2026-01-05 0703.md');
  assert.equal(exportFileName('Nul', at), 'Jenny - Chat Nul - 2026-01-05 0703.md');
  assert.equal(exportFileName('Console', at), 'Jenny - Console - 2026-01-05 0703.md');
  const long = `${'\u{1F600}'.repeat(79)}abc`;
  const name = exportFileName(long, at);
  const stem = name.slice('Jenny - '.length, -' - 2026-01-05 0703.md'.length);
  assert.equal(Array.from(stem).length, 80);
  assert.equal(stem, `${'\u{1F600}'.repeat(79)}a`);
});
