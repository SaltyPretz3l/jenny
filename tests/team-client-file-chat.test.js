'use strict';

// client.json schema 2 (slice 2a-4b): the member's chat drafts and unsent
// outbox beside the membership fields. Schema 1 loads and is rewritten as
// schema 2; a newer or unparseable file is refused and left alone; a bad draft
// or outbox entry is dropped alone (one WARN with counts) and never makes the
// membership unloadable; each writer keeps the other's part, and a membership
// save never empties a readable chat part; the chat part is never written where
// no team file exists; drafts are bounded (200, 64 KiB each), written behind a
// short timer and flushed on stop; the outbox is bounded (50) and holds only
// chat mutations. A membership save never replaces a file it could not read,
// and a new device is saved with the old device's attempted entries marked
// unconfirmed in the same write (member-side saved-team fixes).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  clientFilePath, loadChatState, loadClientFile, saveChatState, saveClientFile, saveDeviceRecord,
} = require('../services/team/client-file');
const { createChatLocalStore } = require('../services/team/chat-local-store');
const { createChatFakeHost, createManualTimers, startChats, tempDir, writeMembership } = require('./helpers/team-chat-fake-host');
const { watchWrites } = require('./helpers/team-saved');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const messageId = (n) => `msg_${n.toString(32).toUpperCase().split('').map((c) => CROCKFORD[parseInt(c, 32)]).join('').padStart(26, '0')}`;
const draft = (text, rootId = null, channelId = 'chan_team') => ({ channel_id: channelId, thread_root_id: rootId, text,
  updated_at: '2026-11-10T10:00:00.000Z' });
const entry = (n, operation = 'team.chat.post', params = { channel_id: 'chan_team', text: `queued ${n}` }) => ({
  entry_id: `out_entry${String(n).padStart(16, '0')}`, request_id: `req_${n}`, operation, params,
  created_at: '2026-11-10T10:00:00.000Z', attempted: false, failed: null });

function schemaOne(userData) {
  const record = writeMembership(userData);
  const file = clientFilePath(userData, record.team_id);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete value.drafts;
  delete value.outbox;
  value.schema_version = 1;
  fs.writeFileSync(file, JSON.stringify(value));
  return { record, file, value };
}

test('a schema 1 file loads and is rewritten as schema 2 with no drafts and an empty outbox', (t) => {
  const userData = tempDir(t, 'jenny-team-file-chat-');
  const { record, file, value } = schemaOne(userData);
  const loaded = loadClientFile(userData, record.team_id);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.record.schema_version, 2);
  const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(rewritten, { ...value, schema_version: 2, drafts: [], outbox: [] });
  assert.deepEqual(loadChatState(userData, record.team_id), { ok: true, drafts: [], outbox: [], dropped: { drafts: 0, outbox: 0 } });
});

test('a newer or unparseable file is refused by every reader and writer and left byte for byte', (t) => {
  const userData = tempDir(t, 'jenny-team-file-chat-');
  const record = writeMembership(userData);
  const file = clientFilePath(userData, record.team_id);
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const text of [
    JSON.stringify({ ...base, schema_version: 4, extra: 'future' }),
    JSON.stringify({ ...base, display_name: 42 }),
    '{broken',
  ]) {
    fs.writeFileSync(file, text);
    assert.equal(loadClientFile(userData, record.team_id).ok, false);
    assert.equal(loadChatState(userData, record.team_id).ok, false);
    assert.equal(saveChatState(userData, record.team_id, { drafts: [draft('x')], outbox: [] }).ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'nothing rewritten');
  }
  fs.writeFileSync(file, JSON.stringify({ ...base, schema_version: 4 }));
  assert.equal(saveClientFile(userData, { ...record, state_seen: 'revoked' }).reason, 'team_client_schema_unsupported');
});

test('each writer keeps the other part; the chat part is never written without a team file', (t) => {
  const userData = tempDir(t, 'jenny-team-file-chat-');
  const record = writeMembership(userData);
  assert.deepEqual(saveChatState(userData, record.team_id, { drafts: [draft('keep me')], outbox: [entry(1)] }), { ok: true });
  assert.deepEqual(saveClientFile(userData, { ...record, state_seen: 'revoked' }), { ok: true });
  const chat = loadChatState(userData, record.team_id);
  assert.deepEqual(chat.drafts.map((item) => item.text), ['keep me']);
  assert.deepEqual(chat.outbox.map((item) => item.request_id), ['req_1']);
  assert.equal(loadClientFile(userData, record.team_id).record.state_seen, 'revoked');
  fs.rmSync(path.dirname(clientFilePath(userData, record.team_id)), { recursive: true });
  assert.equal(saveChatState(userData, record.team_id, { drafts: [draft('x')], outbox: [] }).ok, false);
  assert.equal(fs.existsSync(path.dirname(clientFilePath(userData, record.team_id))), false, 'no file recreated');
});

test('stored bounds: 200 drafts of at most 64 KiB, 50 outbox entries, chat operations only', (t) => {
  const userData = tempDir(t, 'jenny-team-file-chat-');
  const record = writeMembership(userData);
  const drafts = Array.from({ length: 200 }, (_, n) => draft(`d${n}`, messageId(n + 1)));
  assert.equal(saveChatState(userData, record.team_id, { drafts, outbox: [] }).ok, true);
  assert.equal(saveChatState(userData, record.team_id, { drafts: [...drafts, draft('one more')], outbox: [] }).ok, false);
  assert.equal(saveChatState(userData, record.team_id, { drafts: [draft('x'.repeat(64 * 1024))], outbox: [] }).ok, false);
  assert.equal(saveChatState(userData, record.team_id, { drafts: [draft('x'.repeat(64 * 1024 - 2))], outbox: [] }).ok, true);
  const outbox = Array.from({ length: 50 }, (_, n) => entry(n));
  assert.equal(saveChatState(userData, record.team_id, { drafts: [], outbox }).ok, true);
  assert.equal(saveChatState(userData, record.team_id, { drafts: [], outbox: [...outbox, entry(50)] }).ok, false);
  assert.equal(saveChatState(userData, record.team_id, { drafts: [],
    outbox: [entry(1, 'team.member.revoke', { member_id: 'member_x' })] }).ok, false);
  assert.equal(saveChatState(userData, record.team_id, { drafts: [], outbox: [entry(1), { ...entry(2), request_id: 'req_1' }] }).ok,
    false, 'request ids are unique');
});

test('one bad draft or outbox entry is dropped alone; the membership and every other entry load', (t) => {
  const userData = tempDir(t, 'jenny-team-file-chat-');
  const record = writeMembership(userData);
  const file = clientFilePath(userData, record.team_id);
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...base,
    drafts: [draft('a', messageId(1)), draft('x'.repeat(70 * 1024), messageId(2)), draft('b', messageId(3)),
      draft('again a', messageId(1))],
    outbox: [entry(1), entry(2, 'team.member.revoke', { member_id: 'member_x' }), entry(3)] }));
  assert.equal(loadClientFile(userData, record.team_id).ok, true, 'the membership loads');
  const chat = loadChatState(userData, record.team_id);
  assert.equal(chat.ok, true);
  assert.deepEqual(chat.drafts.map((item) => item.text), ['a', 'b']);
  assert.deepEqual(chat.outbox.map((item) => item.request_id), ['req_1', 'req_3']);
  const logs = [];
  const store = createChatLocalStore({ userDataPath: userData, teamId: record.team_id,
    log: (level, event, fields) => logs.push({ level, event, fields }) });
  assert.equal(store.getDraft('chan_team', messageId(3)), 'b');
  store.kill();
  assert.deepEqual(logs, [{ level: 'WARN', event: 'team.chat.state_entries_dropped',
    fields: { team_id: record.team_id, drafts: 2, outbox: 1 } }], 'one WARN, counts only');
});

test('a membership save keeps the readable chat part beside a bad entry or a bad membership field', (t) => {
  const userData = tempDir(t, 'jenny-team-file-chat-');
  const record = writeMembership(userData);
  const file = clientFilePath(userData, record.team_id);
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const broken of [{ drafts: [draft('keep'), draft('x'.repeat(70 * 1024), messageId(2))] }, { display_name: 42 }]) {
    fs.writeFileSync(file, JSON.stringify({ ...base, drafts: [draft('keep')], outbox: [entry(1)], ...broken }));
    assert.deepEqual(saveClientFile(userData, { ...record, state_seen: 'revoked' }), { ok: true });
    const chat = loadChatState(userData, record.team_id);
    assert.deepEqual(chat.outbox.map((item) => item.request_id), ['req_1'], 'the outbox is kept');
    assert.deepEqual(chat.drafts.map((item) => item.text), ['keep']);
    assert.equal(loadClientFile(userData, record.team_id).record.state_seen, 'revoked');
  }
});

// Fault: a membership save over a file it could not read (unparseable,
// or a read that throws on a second hard link), which replaced the drafts and outbox with an empty part.
test('a membership save never replaces a file it could not read; a missing file is still written', (t) => {
  const userData = tempDir(t, 'jenny-team-file-chat-');
  const record = writeMembership(userData);
  const file = clientFilePath(userData, record.team_id);
  const full = JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), drafts: [draft('keep')], outbox: [entry(1)] });
  fs.writeFileSync(file, '{broken');
  for (const save of [saveClientFile, saveDeviceRecord]) {
    assert.deepEqual(save(userData, { ...record, state_seen: 'revoked' }), { ok: false, reason: 'team_client_invalid' });
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken', 'an unparseable file is left byte for byte');
  }
  fs.writeFileSync(file, full);
  const link = path.join(path.dirname(file), 'second-link.json');
  fs.linkSync(file, link);
  for (const save of [saveClientFile, saveDeviceRecord]) {
    assert.deepEqual(save(userData, { ...record, state_seen: 'revoked' }), { ok: false, reason: 'team_client_invalid' });
    assert.equal(fs.readFileSync(file, 'utf8'), full, 'a file whose read throws is left byte for byte');
    assert.equal(fs.statSync(file).nlink, 2, 'and is still the same file');
  }
  fs.rmSync(path.dirname(file), { recursive: true });
  assert.deepEqual(saveClientFile(userData, record), { ok: true }, 'a missing file is still written');
  assert.deepEqual(loadClientFile(userData, record.team_id), { ok: true, record });
});

// Fault: the new device id and the unconfirmed marks written as two writes
// (a stop between them leaves the old device's attempted entries to be resent), or an entry that was never
// sent, or one already failed, marked.
test('a new device is saved with the attempted entries of the old one marked unconfirmed, in one write', (t) => {
  const userData = tempDir(t, 'jenny-team-file-chat-');
  const record = writeMembership(userData);
  const tooLarge = { code: 'invalid_request', reason: 'team_request_too_large' };
  assert.equal(saveChatState(userData, record.team_id, { drafts: [draft('keep')],
    outbox: [{ ...entry(1), attempted: true }, entry(2), { ...entry(3), attempted: true, failed: tooLarge }] }).ok, true);
  const writes = watchWrites(t, clientFilePath(userData, record.team_id));
  const next = { ...record, device_id: 'device_newCCCC3333' };
  assert.deepEqual(saveDeviceRecord(userData, next), { ok: true, count: 1 });
  assert.equal(writes.count, 1, 'one write');
  assert.equal(loadClientFile(userData, record.team_id).record.device_id, 'device_newCCCC3333');
  const chat = loadChatState(userData, record.team_id);
  assert.deepEqual(chat.outbox.map((item) => item.failed), [
    { code: 'invalid_request', reason: 'team_chat_outbox_unconfirmed' }, null, tooLarge]);
  assert.deepEqual(chat.drafts.map((item) => item.text), ['keep']);
  fs.rmSync(path.dirname(clientFilePath(userData, record.team_id)), { recursive: true });
  assert.deepEqual(saveDeviceRecord(userData, next), { ok: true, count: 0 }, 'a missing file is written');
  assert.equal(saveDeviceRecord(userData, { ...next, device_id: 'not a device' }).ok, false);
});

async function draftsClient(t) {
  const host = await createChatFakeHost(t);
  const userData = tempDir(t, 'jenny-team-file-chat-');
  const record = writeMembership(userData);
  const timers = createManualTimers();
  const start = () => startChats(t, host, { userData, teamId: record.team_id, timers }).chats;
  return { userData, teamId: record.team_id, timers, start };
}

test('drafts through the client: written behind a timer, flushed on stop, back after a restart, bounded', async (t) => {
  const s = await draftsClient(t);
  const chats = s.start();
  const set = (payload) => chats.handle('chatDraftSet', { team_id: s.teamId, ...payload });
  assert.deepEqual(await set({ channel_id: 'chan_team', text: 'thinking' }), { ok: true });
  assert.deepEqual(loadChatState(s.userData, s.teamId).drafts, [], 'not written at once');
  assert.equal(s.timers.fire(), 1);
  assert.deepEqual(loadChatState(s.userData, s.teamId).drafts.map((item) => item.text), ['thinking']);
  await set({ channel_id: 'chan_team', thread_root_id: messageId(1), text: 'in a thread' });
  await chats.stopAll();
  const next = s.start();
  const get = (payload) => next.handle('chatDraftGet', { team_id: s.teamId, ...payload });
  assert.deepEqual(await get({ channel_id: 'chan_team' }), { ok: true, text: 'thinking' });
  assert.deepEqual(await get({ channel_id: 'chan_team', thread_root_id: messageId(1) }), { ok: true, text: 'in a thread' });
  assert.deepEqual(await get({ channel_id: 'chan_project_none' }), { ok: true, text: '' });
  assert.deepEqual(await next.handle('chatDraftSet', { team_id: s.teamId, channel_id: 'chan_team', text: '' }), { ok: true });
  assert.deepEqual(await get({ channel_id: 'chan_team' }), { ok: true, text: '' }, 'an empty text clears the draft');
  for (let n = 2; n <= 200; n += 1) {
    const answer = await next.handle('chatDraftSet', { team_id: s.teamId, channel_id: 'chan_team', thread_root_id: messageId(n),
      text: `draft ${n}` });
    assert.equal(answer.ok, true, `draft ${n}`);
  }
  const over = await next.handle('chatDraftSet', { team_id: s.teamId, channel_id: 'chan_team', thread_root_id: messageId(500),
    text: 'the 201st' });
  assert.equal(over.ok, false);
  assert.equal(over.error.reason, 'team_chat_draft_limit');
  const tooLong = await next.handle('chatDraftSet', { team_id: s.teamId, channel_id: 'chan_team', text: 'x'.repeat(70_000) });
  assert.equal(tooLong.error.code, 'invalid_request');
  await next.stopAll();
  assert.equal(loadChatState(s.userData, s.teamId).drafts.length, 200);
});
