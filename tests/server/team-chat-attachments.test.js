'use strict';

// Slice 2c host: the team chat attachment routes (server/team/chat-attachment-routes.js) over the real chat
// command fixture: the authorization table, the three upload guard checks and the body rules, forged ids answered
// byte for byte alike, bounds and edges, kinds, names, redaction, the in-flight slots and idempotency. The store
// side (life cycle, retention, I/O failures, restart, wiring) is team-chat-attachments-store.test.js.

const assert = require('node:assert/strict');
const test = require('node:test');

const rawBody = require('../../server/team/raw-route-body');
const { isFileName } = require('../../services/host/team-chat-blobs');
const { createAttachmentsFixture, sha } = require('./helpers/team-chat-attachments-fixture');

const BOUNDED = { timeout: 60_000 };
const MIB = 1024 * 1024;
const TEAM = 'chan_team';
const PROJECT = 'chan_project_apollo';
const MARKER = 'ZQXMARKERQXZ';
const FORGED = 'att_00000000000000000000000000';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 body')]);
const GIF = Buffer.from('GIF89a gif body');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const reasonOf = (answer) => answer.json?.error?.reason ?? (answer.ok === false ? answer.error.reason : 'ok');
const deny = { ok: false, error: { code: 'CMP-HOST-0003', reason: 'role_forbidden', retryable: false } };

async function setup(t, options) {
  const h = await createAttachmentsFixture(t, options);
  assert.equal((await h.chat.store.createChannel({ channelId: PROJECT })).ok, true);
  await h.addToProject('project_apollo', 'alice');
  return h;
}

// One attached file in `channel` by `who`: { item, bytes, message_id }.
async function attached(h, who, channel, bytes = Buffer.from(`file ${Math.random()}`), options) {
  const item = await h.staged(who, channel, bytes, options);
  const posted = await h.post(who, channel, [item.id]);
  assert.equal(posted.ok, true, JSON.stringify(posted));
  return { item, bytes, message_id: posted.message_id };
}

const removeAlice = (h) => async () => {
  const removed = await h.store.removeProjectMember({ actorMemberId: h.seats.owner.member_id, projectId: 'project_apollo',
    memberId: h.seats.alice.member_id });
  assert.equal(removed.ok, true, JSON.stringify(removed));
};

test('authorization: write roles upload, read roles download, pending, revoked and outsiders get nothing', BOUNDED, async (t) => {
  const h = await setup(t);
  for (const who of ['owner', 'alice']) assert.equal((await h.upload(who, TEAM, Buffer.from('x'))).status, 200, who);
  const refusals = { rae: 'role_forbidden', pat: 'member_pending', revoked: 'member_revoked', invite: 'role_forbidden' };
  for (const [who, reason] of Object.entries(refusals)) {
    assert.equal(reasonOf(await h.upload(who, TEAM, Buffer.from('x'))), reason, `${who} upload`);
  }
  const file = await attached(h, 'alice', TEAM);
  for (const who of ['owner', 'alice', 'bob', 'rae']) {
    const read = await h.download(who, TEAM, file.item.id);
    assert.equal(read.status, 200, who);
    assert.equal(sha(read.bytes), sha(file.bytes));
  }
  for (const [who, reason] of Object.entries({ pat: 'member_pending', revoked: 'member_revoked', invite: 'role_forbidden' })) {
    const read = await h.download(who, TEAM, file.item.id);
    assert.deepEqual([reasonOf(read), read.bytes.includes(file.bytes)], [reason, false], `${who} download`);
  }
  // A project channel Bob is outside reads exactly like a channel that does not exist.
  const inside = await attached(h, 'alice', PROJECT);
  const outside = await h.upload('bob', PROJECT, Buffer.from('x'));
  const missing = await h.upload('bob', 'chan_project_nothere', Buffer.from('x'));
  const dm = await h.upload('bob', `chan_dm_${'a'.repeat(64)}`, Buffer.from('x'));
  assert.equal(reasonOf(outside), 'team_chat_not_found');
  assert.deepEqual([outside.status, outside.bytes], [missing.status, missing.bytes]);
  assert.deepEqual([outside.status, outside.bytes], [dm.status, dm.bytes]);
  const away = await h.download('bob', PROJECT, inside.item.id);
  const nothing = await h.download('bob', 'chan_project_nothere', inside.item.id);
  assert.deepEqual([away.status, away.bytes], [nothing.status, nothing.bytes]);
  assert.equal(reasonOf(away), 'team_chat_not_found');
  // No admitted client: refused before anything, and no byte of the file.
  const noClient = await h.download('alice', TEAM, file.item.id, { authorizedNow: () => false });
  assert.deepEqual([reasonOf(noClient), noClient.bytes.includes(file.bytes)], ['client_required', false]);
  assert.equal(reasonOf(await h.upload('alice', TEAM, Buffer.from('x'), { authorizedNow: () => false })), 'client_required');
  assert.equal(reasonOf(await h.download(null, TEAM, file.item.id)), 'role_forbidden', 'no guard: denied');
});

test('the three upload guard checks, each on its own; the stop rule; a download denied before its bytes', BOUNDED, async (t) => {
  const h = await setup(t);
  const realRead = rawBody.readExactly;
  let reads = 0;
  rawBody.readExactly = (...args) => { reads += 1; return realRead(...args); };
  t.after(() => { rawBody.readExactly = realRead; });
  const store = h.chat.store;
  const realStage = store.stageAttachment.bind(store);
  let stages = 0;
  store.stageAttachment = (input) => { stages += 1; return realStage(input); };
  // Before the body: no byte is read and nothing staged.
  const before = await h.upload('alice', PROJECT, Buffer.from('never read'), { guard: () => deny });
  assert.deepEqual([reasonOf(before), reads, stages], ['role_forbidden', 0, 0]);
  // While the body arrives: the body is read, stage is never called.
  const during = await h.upload('alice', PROJECT, Buffer.from('in flight bytes'), { during: removeAlice(h) });
  assert.deepEqual([reasonOf(during), reads, stages], ['team_chat_not_found', 1, 0]);
  await h.addToProject('project_apollo', 'alice');
  // During stage (the late check): the staged file is discarded and the answer is the refusal.
  store.stageAttachment = async (input) => { const staged = await realStage(input); await removeAlice(h)(); return staged; };
  const late = await h.upload('alice', PROJECT, Buffer.from('staged then refused'));
  assert.equal(reasonOf(late), 'team_chat_not_found');
  assert.equal(store.stagedAttachmentCount(h.seats.alice.member_id), 0);
  assert.deepEqual(h.listed('_staged'), []);
  // Past twice the cap: answered before the body ends and the socket destroyed; within it: drained, kept.
  const stopped = await h.upload('bob', TEAM, Buffer.from('small'), { length: 2 * 4 * MIB + 1 });
  assert.deepEqual([reasonOf(stopped), stopped.answeredBeforeBodyEnd, stopped.socketDestroyed],
    ['attachment_size_limit', true, true]);
  const drained = await h.upload('bob', TEAM, Buffer.from('small'), { length: 4 * MIB + 1 });
  assert.deepEqual([reasonOf(drained), drained.answeredBeforeBodyEnd, drained.socketDestroyed],
    ['attachment_size_limit', false, false]);
  // A download denied between the read and the send gets no byte.
  store.stageAttachment = realStage;
  const file = await attached(h, 'bob', TEAM);
  let calls = 0;
  const flip = (action, resource) => { calls += 1; return calls > 1 ? deny : h.authorize(h.seats.bob, action, resource); };
  const read = await h.download('bob', TEAM, file.item.id, { guard: flip });
  assert.deepEqual([read.status, reasonOf(read), read.bytes.includes(file.bytes), calls], [403, 'role_forbidden', false, 2]);
});

test('forged ids: every missing case answers with the same bytes, and a refused post consumes nothing', BOUNDED, async (t) => {
  const h = await setup(t);
  const elsewhere = await attached(h, 'alice', PROJECT);
  const stagedHere = await h.staged('alice', TEAM, Buffer.from('staged'));
  const stagedThere = await h.staged('alice', PROJECT, Buffer.from('staged there'));
  const bobs = await h.staged('bob', TEAM, Buffer.from('bob staged'));
  const doomed = await attached(h, 'alice', TEAM);
  assert.equal((await h.send(h.seats.alice, 'team.chat.delete', { channel_id: TEAM, message_id: doomed.message_id })).ok, true);
  const forged = await h.download('alice', TEAM, FORGED);
  assert.equal(reasonOf(forged), 'team_chat_not_found');
  for (const [what, id] of [['another channel', elsewhere.item.id], ['staged', stagedHere.id], ['malformed', 'att_short'],
    ['deleted message', doomed.item.id]]) {
    const answer = await h.download('alice', TEAM, id);
    assert.deepEqual([answer.status, answer.bytes], [forged.status, forged.bytes], what);
  }
  const before = h.chat.store.channelInfo(TEAM);
  const bare = (answer) => JSON.stringify({ ...answer, error: { ...answer.error, request_id: undefined } });
  const postForged = bare(await h.post('alice', TEAM, [FORGED]));
  for (const [what, ids] of [['another channel staged', [stagedThere.id]], ['another member staged', [bobs.id]],
    ['one good one forged', [stagedHere.id, FORGED]]]) {
    assert.equal(bare(await h.post('alice', TEAM, ids)), postForged, what);
  }
  assert.deepEqual(h.chat.store.channelInfo(TEAM), before, 'nothing written');
  assert.equal(h.chat.store.stagedAttachmentCount(h.seats.alice.member_id), 2, 'the refused posts consumed nothing');
  h.fx.advance(60 * 60 * 1000);
  assert.equal(bare(await h.post('alice', TEAM, [stagedHere.id])), postForged, 'expired');
});

test('bounds: size, Content-Length, ids, the staged cap, in-flight slots, the attachment total, names and types', BOUNDED, async (t) => {
  const h = await setup(t, { storeLimits: { attachmentMaxBytes: 64 } });
  const big = await h.upload('alice', TEAM, Buffer.alloc(4 * MIB + 1));
  assert.deepEqual([reasonOf(big), big.headers.Connection], ['attachment_size_limit', 'close']);
  assert.equal(reasonOf(await h.upload('alice', TEAM, Buffer.from('abc'), { length: null })), 'team_chat_request_invalid');
  assert.equal(reasonOf(await h.upload('alice', TEAM, Buffer.from('abc'), { length: 0 })), 'team_chat_request_invalid');
  assert.equal(reasonOf(await h.upload('alice', TEAM, Buffer.from('abc'), { length: 5 })), 'attachment_size_limit', 'short body');
  assert.equal(reasonOf(await h.upload('alice', TEAM, Buffer.from('abcdef'), { length: 3 })), 'attachment_size_limit', 'long body');
  for (const name of ['bell\u0007.txt', 'a/b.txt', 'a\\b.txt', 'x'.repeat(256), '', null, '   ', ' 　',
    'evil‮txt.exe', 'zero​width', 'line break']) {
    assert.equal(reasonOf(await h.upload('alice', TEAM, Buffer.from('abc'), { name })), 'display_name_invalid', JSON.stringify(name));
  }
  const badEncoding = await h.upload('alice', TEAM, Buffer.from('abc'), { name: null, headers: { 'x-file-name': '%ED%A0%80' } });
  assert.equal(reasonOf(badEncoding), 'display_name_invalid', 'a lone surrogate in UTF-8 does not decode');
  assert.deepEqual(['\uD800.txt', 'ok éè.txt', 'x'.repeat(255)].map(isFileName), [false, true, true]);
  const lone = await h.chat.store.stageAttachment({ channelId: TEAM, memberId: h.seats.alice.member_id, name: '\uD800',
    mime: 'text/plain', bytes: Buffer.from('a') });
  assert.equal(lone.error.reason, 'team_chat_request_invalid', 'the store checks the name too');
  for (const type of ['Text/Html!', 'nonsense', null]) {
    assert.equal(reasonOf(await h.upload('alice', TEAM, Buffer.from('abc'), { type })), 'mime_type_unsupported', String(type));
  }
  // The attachment total (64 bytes): exactly 64 fits, one byte more does not; nothing is prunable here.
  const full = await h.staged('alice', TEAM, Buffer.alloc(64, 1));
  assert.equal(reasonOf(await h.upload('alice', TEAM, Buffer.alloc(1, 1))), 'team_chat_storage_limit');
  assert.equal(h.chat.store.discardAttachment(full.id), true);
  assert.equal(reasonOf(await h.upload('alice', TEAM, Buffer.alloc(65, 1))), 'team_chat_storage_limit');
  const ids = [];
  for (let i = 0; i < 16; i += 1) ids.push((await h.staged('alice', TEAM, Buffer.from('z'))).id);
  const seventeenth = await h.upload('alice', TEAM, Buffer.from('z'));
  assert.deepEqual([reasonOf(seventeenth), seventeenth.json.error.retryable], ['team_upload_limit', true]);
  assert.equal(reasonOf(await h.post('alice', TEAM, ids.slice(0, 9))), 'invalid_command_parameters', 'a ninth id');
  assert.equal(reasonOf(await h.post('alice', TEAM, [ids[0], ids[0]])), 'invalid_command_parameters', 'a duplicate id');
  const direct = await h.chat.store.post({ actorId: h.seats.alice.member_id, deviceId: h.seats.alice.device_id,
    requestId: 'direct_dup', channelId: TEAM, text: 'x', attachmentIds: [ids[0], ids[0]] });
  assert.equal(direct.error.reason, 'team_chat_request_invalid', 'the store checks again');
  const eight = await h.post('alice', TEAM, ids.slice(0, 8));
  assert.equal(eight.ok, true, 'exactly eight ids');
  // Four uploads in flight hold every slot: the fifth is refused at once, retryable.
  const holding = [1, 2, 3, 4].map(() => h.start('bob', 'POST', `/api/v1/team/chat/uploads/${TEAM}`, {
    body: Buffer.from('slot'), headers: { 'x-file-name': 'slot.txt', 'content-type': 'text/plain' } }));
  await h.turn();
  const fifth = await h.upload('bob', TEAM, Buffer.from('fifth'));
  assert.deepEqual([reasonOf(fifth), fifth.json.error.retryable], ['team_upload_limit', true]);
  const held = await Promise.all(holding.map((request) => request.finish()));
  assert.deepEqual(held.map((answer) => answer.status), [200, 200, 200, 200]);
  h.setDiskAdmit(false);
  const pressed = await h.upload('bob', TEAM, Buffer.from('z'));
  assert.deepEqual([reasonOf(pressed), pressed.json.error.retryable], ['disk_pressure', true]);
  assert.equal(reasonOf(await h.upload('bob', TEAM, Buffer.from('z'), { type: 'Bad!' })), 'mime_type_unsupported',
    'the free header refusals come before the disk gate');
});

test('edges: exactly 4 MiB, a type with a parameter and in upper case, an archived channel refused before the body', BOUNDED, async (t) => {
  const h = await setup(t);
  const exact = await h.upload('alice', TEAM, Buffer.alloc(4 * MIB, 7));
  assert.equal(exact.status, 200);
  assert.equal(exact.json.attachment.size_bytes, 4 * MIB);
  const typed = await h.upload('alice', TEAM, PNG, { name: 'p.png', type: 'IMAGE/PNG; charset=binary' });
  assert.deepEqual([typed.json.attachment.mime, typed.json.attachment.kind], ['image/png', 'image']);
  assert.equal((await h.chat.store.archiveChannel({ channelId: PROJECT })).ok, true);
  const realRead = rawBody.readExactly;
  let reads = 0;
  rawBody.readExactly = (...args) => { reads += 1; return realRead(...args); };
  t.after(() => { rawBody.readExactly = realRead; });
  const archived = await h.upload('alice', PROJECT, Buffer.alloc(1024, 1));
  assert.deepEqual([reasonOf(archived), reads], ['team_chat_archived', 0]);
});

test('kinds: signed PNG, JPEG and WebP are images; anything else is a file served as octet-stream', BOUNDED, async (t) => {
  const h = await setup(t);
  const cases = [
    ['a.png', 'image/png', PNG, 'image', 'image/png'], ['a.jpg', 'image/jpeg', JPEG, 'image', 'image/jpeg'],
    ['a.webp', 'image/webp', WEBP, 'image', 'image/webp'], ['fake.png', 'image/png', HTML, 'file', 'application/octet-stream'],
    ['png.jpg', 'image/jpeg', PNG, 'file', 'application/octet-stream'],
    ['a.gif', 'image/gif', GIF, 'file', 'application/octet-stream'],
    ['a.svg', 'image/svg+xml', Buffer.from('<svg onload="x()"/>'), 'file', 'application/octet-stream'],
    ['a.html', 'text/html', HTML, 'file', 'application/octet-stream'],
  ];
  for (const [name, type, bytes, kind, served] of cases) {
    const file = await attached(h, 'alice', TEAM, bytes, { name, type });
    assert.deepEqual(file.item, { id: file.item.id, name, mime: type, size_bytes: bytes.length, kind }, name);
    const read = await h.download('bob', TEAM, file.item.id);
    assert.equal(read.headers['Content-Type'], served, name);
    assert.equal(read.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(read.headers['Cache-Control'], 'no-store');
    assert.match(read.headers['Content-Disposition'], /^attachment; filename="/u);
    assert.equal(sha(read.bytes), sha(bytes));
  }
});

test('redaction: a marked name and marked bytes reach no log line and no failure payload', BOUNDED, async (t) => {
  const h = await setup(t, { storeLimits: { attachmentMaxBytes: 4096 } });
  const name = `${MARKER}.txt`;
  const bytes = Buffer.from(`${MARKER} secret body`);
  const payloads = [];
  const keep = (answer) => { payloads.push(answer.bytes.toString('latin1')); return answer; };
  const file = await attached(h, 'alice', TEAM, bytes, { name });
  keep(await h.upload('rae', TEAM, bytes, { name }));
  keep(await h.upload('bob', PROJECT, bytes, { name }));
  keep(await h.upload('alice', TEAM, bytes, { name, length: bytes.length + 3 }));
  keep(await h.upload('alice', TEAM, bytes, { name: `${MARKER}/x` }));
  keep(await h.upload('alice', TEAM, bytes, { name, type: `${MARKER}!` }));
  keep(await h.upload('alice', TEAM, Buffer.alloc(5000, MARKER), { name }));
  keep(await h.download('pat', TEAM, file.item.id));
  keep(await h.download('bob', PROJECT, file.item.id));
  payloads.push(JSON.stringify(await h.post('alice', TEAM, [FORGED])));
  for (let i = 0; i < 16; i += 1) await h.staged('bob', TEAM, Buffer.from(`${MARKER}${i}`), { name });
  assert.equal(reasonOf(keep(await h.upload('bob', TEAM, bytes, { name }))), 'team_upload_limit');
  h.setDiskAdmit(false);
  assert.equal(reasonOf(keep(await h.upload('alice', TEAM, bytes, { name }))), 'disk_pressure');
  h.setDiskAdmit(true);
  assert.equal(reasonOf(keep(await h.upload('owner', TEAM, Buffer.alloc(4000, MARKER), { name }))), 'team_chat_storage_limit');
  const read = await h.download('bob', TEAM, file.item.id);
  assert.equal(read.bytes.toString(), bytes.toString());
  for (const payload of payloads) assert.equal(payload.includes(MARKER), false, payload);
  assert.equal(JSON.stringify(h.fx.logs).includes(MARKER), false);
});

test('a stage that throws releases its in-flight slot', BOUNDED, async (t) => {
  const h = await setup(t);
  const store = h.chat.store;
  const realStage = store.stageAttachment.bind(store);
  store.stageAttachment = async () => { throw new Error('boom'); };
  for (let i = 0; i < 4; i += 1) assert.equal(reasonOf(await h.upload('bob', TEAM, Buffer.from('x'))), 'host_unavailable');
  store.stageAttachment = realStage;
  assert.equal((await h.upload('bob', TEAM, Buffer.from('fifth'))).status, 200, 'no slot leaked');
});

test('idempotency: a retried post makes one message; changed ids under the same request id are refused', BOUNDED, async (t) => {
  const h = await setup(t);
  const one = await h.staged('alice', TEAM, Buffer.from('one'));
  const two = await h.staged('alice', TEAM, Buffer.from('two'));
  const cmd = h.command(h.seats.alice.auth, 'team.chat.post', { channel_id: TEAM, text: 'files', attachment_ids: [one.id] });
  const first = await h.dispatch(h.seats.alice, cmd);
  const retry = await h.dispatch(h.seats.alice, cmd);
  assert.equal(first.ok, true);
  assert.deepEqual([retry.ok, retry.message_id], [true, first.message_id]);
  assert.equal(h.chat.store.channelInfo(TEAM).message_count, 1);
  const changed = await h.dispatch(h.seats.alice, { ...cmd, params: { ...cmd.params, attachment_ids: [two.id] } });
  assert.equal(reasonOf(changed), 'request_payload_changed');
  assert.equal(h.chat.store.stagedAttachmentCount(h.seats.alice.member_id), 1, 'the refused retry kept the second staged');
});
