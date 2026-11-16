'use strict';

// Slice 2c host: the store side of team chat attachments (services/host/team-chat-blobs.js and the chat store):
// the life cycle, the pages, restart and reconcile, a torn write, blob I/O failures that never latch the store, an
// open that degrades instead of throwing, the count limit and the make-room pass, the staged sweep timer, and the
// two routes on a real team host. The routes themselves are team-chat-attachments.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { command } = require('../helpers/command-router-fixture');
const { assertSafeFile } = require('../../services/host/path-guard');
const { createTeamChatHost } = require('../../services/host/team-chat-host');
const { resolveLimits } = require('../../services/host/team-chat-retention');
const { TeamChatStore } = require('../../services/host/team-chat-store');
const { validateMessage } = require('../../services/host/team-chat-schema');
const { fakeTimers } = require('./helpers/team-chat-timers');
const { createAttachmentsFixture } = require('./helpers/team-chat-attachments-fixture');
const { startMountedHost } = require('./helpers/team-engine-mount-fixture');
const { randomKey } = require('./helpers/team-host-fixture');

const BOUNDED = { timeout: 60_000 };
const TEAM = 'chan_team';
const PROJECT = 'chan_project_apollo';
const FORGED = 'att_00000000000000000000000000';
const reasonOf = (answer) => answer.json?.error?.reason ?? (answer.ok === false ? answer.error.reason : 'ok');

async function setup(t, options) {
  const h = await createAttachmentsFixture(t, options);
  assert.equal((await h.chat.store.createChannel({ channelId: PROJECT })).ok, true);
  await h.addToProject('project_apollo', 'alice');
  return h;
}

async function attached(h, who, channel, bytes = Buffer.from(`file ${Math.random()}`), options) {
  const item = await h.staged(who, channel, bytes, options);
  const posted = await h.post(who, channel, [item.id]);
  assert.equal(posted.ok, true, JSON.stringify(posted));
  return { item, bytes, message_id: posted.message_id, rev: posted.rev };
}

const reopen = (h, options = {}) => {
  const store = new TeamChatStore({ profileDir: h.fx.dir, clock: h.fx.clock, logger: h.fx.logger, ...options });
  assert.equal(store.open().ok, true);
  return store;
};

// Every message object anywhere in a page.
function messagesIn(value, found = []) {
  if (Array.isArray(value)) for (const entry of value) messagesIn(entry, found);
  else if (value && typeof value === 'object') {
    if (typeof value.channel_id === 'string' && Array.isArray(value.attachments)) found.push(value);
    for (const entry of Object.values(value)) messagesIn(entry, found);
  }
  return found;
}

// Swaps `object[key]` for the test's duration.
function patch(t, object, key, replacement) {
  const real = object[key];
  object[key] = replacement(real);
  const restore = () => { object[key] = real; };
  t.after(restore);
  return restore;
}

// The store still takes an ordinary upload and post, and a text post.
async function stillWorks(h) {
  const file = await attached(h, 'bob', TEAM, Buffer.from(`still ${Math.random()}`));
  assert.equal((await h.download('alice', TEAM, file.item.id)).status, 200);
  assert.equal(h.chat.store.brokenReason(), null, 'never latched');
}

test('life cycle: post, pages, edit, delete and prune; missing ids answer like a forged one', BOUNDED, async (t) => {
  const h = await setup(t, { storeLimits: { segmentMaxMessages: 1, maxAgeMs: 60_000 } });
  const file = await attached(h, 'alice', TEAM, Buffer.from('keep these bytes'));
  assert.deepEqual([h.listed(TEAM), h.listed('_staged')], [[file.item.id], []]);
  const edited = await h.send(h.seats.alice, 'team.chat.edit', { channel_id: TEAM, message_id: file.message_id,
    text: 'renamed', expected_rev: file.rev });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal((await h.send(h.seats.alice, 'team.chat.pin', { channel_id: TEAM, message_id: file.message_id, on: true })).ok, true);
  const reply = await h.post('bob', TEAM, [], { thread_root_id: file.message_id });
  const pages = [
    await h.send(h.seats.bob, 'team.chat.history', { channel_id: TEAM, limit: 10 }),
    await h.send(h.seats.bob, 'team.chat.sync', { channel_id: TEAM, after_rev: 0, limit: 200 }),
    await h.send(h.seats.bob, 'team.chat.thread', { channel_id: TEAM, root_id: file.message_id, limit: 10 }),
    await h.send(h.seats.bob, 'team.chat.pins', { channel_id: TEAM }),
    await h.send(h.seats.bob, 'team.chat.search', { query: 'renamed', limit: 5 }),
  ];
  assert.equal(reply.ok, true);
  for (const page of pages) {
    assert.equal(page.ok, true, JSON.stringify(page));
    // A search match carries an excerpt, not the message: no attachment travels in it.
    if (page.matches) {
      assert.deepEqual(page.matches.map((match) => [match.message_id, 'attachments' in match]), [[file.message_id, false]]);
      continue;
    }
    const messages = messagesIn(page);
    assert.ok(messages.length > 0);
    // An older client's view: the member cache's check passes every page unchanged.
    assert.equal(messages.every((message) => validateMessage(message, message.channel_id)), true);
    const record = messages.find((message) => message.id === file.message_id);
    if (record) assert.deepEqual(record.attachments, [file.item], 'the edit kept the attachment');
  }
  const forged = await h.download('bob', TEAM, FORGED);
  const totalWith = h.chat.store.totalBytes();
  assert.equal((await h.send(h.seats.alice, 'team.chat.delete', { channel_id: TEAM, message_id: file.message_id })).ok, true);
  assert.deepEqual(h.listed(TEAM), []);
  assert.ok(h.chat.store.totalBytes() < totalWith);
  const deleted = await h.download('bob', TEAM, file.item.id);
  assert.deepEqual([deleted.status, deleted.bytes], [forged.status, forged.bytes], 'deleted');
  // Retention: the old segment goes with its blob, the head stays.
  const old = await attached(h, 'alice', TEAM, Buffer.from('old bytes'));
  h.fx.advance(120_000);
  const head = await attached(h, 'alice', TEAM, Buffer.from('head bytes'));
  const before = h.chat.store.totalBytes();
  await h.chat.runRetention();
  assert.deepEqual(h.listed(TEAM), [head.item.id]);
  const pruned = await h.download('bob', TEAM, old.item.id);
  assert.deepEqual([pruned.status, pruned.bytes], [forged.status, forged.bytes], 'pruned');
  assert.ok(h.chat.store.totalBytes() < before - 'old bytes'.length, 'segment and blob bytes both dropped');
  assert.equal((await h.download('bob', TEAM, head.item.id)).status, 200);
  // An archived channel still serves its files and takes no upload.
  const kept = await attached(h, 'alice', PROJECT, Buffer.from('archived bytes'));
  assert.equal((await h.chat.store.archiveChannel({ channelId: PROJECT })).ok, true);
  assert.equal((await h.download('alice', PROJECT, kept.item.id)).bytes.toString(), 'archived bytes');
  assert.equal(reasonOf(await h.upload('alice', PROJECT, Buffer.from('x'))), 'team_chat_archived');
  assert.equal((await h.chat.store.stageAttachment({ channelId: PROJECT, memberId: h.seats.alice.member_id,
    name: 'a.txt', mime: 'text/plain', bytes: Buffer.from('x') })).error.reason, 'team_chat_archived');
  assert.deepEqual(h.listed('_staged'), [], 'the refused stage removed its file');
});

test('a restart drops staged uploads, unnamed blobs and an unknown channel\'s files; retention on a never-used channel', BOUNDED, async (t) => {
  const h = await setup(t, { storeLimits: { segmentMaxMessages: 1, maxAgeMs: 60_000 } });
  const old = await attached(h, 'alice', TEAM, Buffer.from('old'));
  await h.post('alice', PROJECT, []);
  h.fx.advance(120_000);
  const file = await attached(h, 'alice', TEAM, Buffer.from('named'));
  await h.post('alice', PROJECT, []);
  const staged = await h.staged('alice', TEAM, Buffer.from('staged'));
  await h.chat.store.settled();
  const stray = 'att_7ZZZZZZZZZZZZZZZZZZZZZZZZZ';
  fs.writeFileSync(h.blobDir(TEAM, stray), 'nobody names me');
  fs.writeFileSync(h.blobDir(TEAM, 'notes.txt'), 'not a blob name');
  fs.mkdirSync(h.blobDir('chan_project_gone'), { recursive: true });
  fs.writeFileSync(h.blobDir('chan_project_gone', FORGED), 'orphan');
  assert.deepEqual(h.listed('_staged'), [staged.id]);
  const again = reopen(h, { limits: { segmentMaxMessages: 1, maxAgeMs: 60_000 } });
  assert.deepEqual(h.listed('_staged'), []);
  assert.deepEqual(h.listed('chan_project_gone'), [], 'the unlisted channel\'s files are removed, the directory kept');
  assert.equal(fs.existsSync(h.blobDir('chan_project_gone')), true);
  assert.deepEqual(h.listed(TEAM), [old.item.id, file.item.id, stray].sort(), 'reconciled at the first attachment use');
  // Retention before any attachment use: both channels are pruned, the old blob goes, the stray with it.
  const swept = await again.applyRetention();
  assert.equal(swept.ok, true);
  assert.ok(swept.pruned.some((report) => report.channel_id === PROJECT), 'the never-used channel was pruned');
  assert.deepEqual(h.listed(TEAM), [file.item.id]);
  const read = await again.readAttachment(TEAM, file.item.id);
  assert.equal(read.bytes.toString(), 'named');
  assert.equal((await again.readAttachment(TEAM, stray)).error.reason, 'team_chat_not_found');
  const segments = again.listChannels().channels.reduce((sum, info) => sum + again._channels.get(info.channel_id).doc.bytes, 0);
  assert.equal(again.totalBytes(), segments + 'named'.length, 'the total is segments plus the named blob');
  await again.settled();
});

test('a failed write after the blobs moved: no message names them, they are removed, a live file beside them stays', BOUNDED, async (t) => {
  const h = await setup(t);
  const store = h.chat.store;
  const live = await attached(h, 'alice', TEAM, Buffer.from('live'));
  const failOn = (suffix) => patch(t, store._files, 'write', (write) => function failing(filePath, ...rest) {
    if (filePath.endsWith(suffix)) throw Object.assign(new Error('EIO'), { code: 'EIO', duringWrite: true, filePath });
    return write.call(this, filePath, ...rest);
  });
  // The segment write fails: answered, not latched; the channel reloads and is reconciled.
  const torn = await h.staged('alice', TEAM, Buffer.from('torn'));
  let restore = failOn('.json');
  const failed = await h.post('alice', TEAM, [torn.id]);
  restore();
  assert.equal(reasonOf(failed), 'team_chat_store_failed');
  assert.deepEqual(h.listed(TEAM), [live.item.id, torn.id].sort(), 'moved before the message write');
  assert.equal(reasonOf(await h.download('alice', TEAM, torn.id)), 'team_chat_not_found');
  assert.deepEqual(h.listed(TEAM), [live.item.id], 'the reload reconciled the torn one away');
  assert.equal((await h.download('alice', TEAM, live.item.id)).bytes.toString(), 'live');
  assert.equal(store.channelInfo(TEAM).message_count, 1);
  // channel.json fails after the segment landed: the store latches; the next start removes the file at first use.
  const crashed = await h.staged('alice', TEAM, Buffer.from('crashed'));
  restore = failOn('channel.json');
  assert.equal((await h.post('alice', TEAM, [crashed.id])).ok, false);
  restore();
  assert.notEqual(store.brokenReason(), null);
  const again = reopen(h);
  await again.ensureLoaded(TEAM);
  assert.equal(again.channelInfo(TEAM).message_count, 1, 'the uncommitted message is dropped');
  assert.equal((await again.readAttachment(TEAM, crashed.id)).error.reason, 'team_chat_not_found');
  assert.equal((await again.readAttachment(TEAM, live.item.id)).bytes.toString(), 'live');
  assert.deepEqual(h.listed(TEAM), [live.item.id]);
});

test('blob I/O failures never latch the store: missing or changed files, ENOSPC, EEXIST, a short write, an unsafe staged directory', BOUNDED, async (t) => {
  const h = await setup(t);
  const store = h.chat.store;
  // A deleted blob answers not found and drops its bytes from the total.
  const gone = await attached(h, 'alice', TEAM, Buffer.from('soon gone'));
  const total = store.totalBytes();
  fs.unlinkSync(h.blobDir(TEAM, gone.item.id));
  assert.equal(reasonOf(await h.download('alice', TEAM, gone.item.id)), 'team_chat_not_found');
  assert.equal(store.totalBytes(), total - 'soon gone'.length);
  assert.equal(reasonOf(await h.download('alice', TEAM, gone.item.id)), 'team_chat_not_found', 'the entry is dropped');
  // A blob whose size changed is not served.
  const changed = await attached(h, 'alice', TEAM, Buffer.from('exact size'));
  fs.writeFileSync(h.blobDir(TEAM, changed.item.id), 'a different size entirely');
  assert.equal(reasonOf(await h.download('alice', TEAM, changed.item.id)), 'team_chat_not_found');
  await stillWorks(h);
  // A staged write that fails: a refusal, the partial file removed, the total unchanged.
  const failing = (fail) => patch(t, fsp, 'open', (open) => async (...args) => fail(open, ...args));
  for (const [what, fail, reason] of [
    ['ENOSPC', () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); }, 'team_chat_storage_limit'],
    ['EEXIST', () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); }, 'team_chat_store_failed'],
    ['short write', async (open, ...args) => {
      const handle = await open(...args);
      return { write: async () => ({ bytesWritten: 0 }), sync: () => handle.sync(), close: () => handle.close() };
    }, 'team_chat_store_failed'],
    ['ENOSPC mid-write', async (open, ...args) => {
      const handle = await open(...args);
      return { write: async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); },
        sync: () => handle.sync(), close: () => handle.close() };
    }, 'team_chat_storage_limit'],
  ]) {
    const before = store.totalBytes();
    const restore = failing(fail);
    const answer = await h.upload('bob', TEAM, Buffer.from('will not land'));
    restore();
    assert.equal(reasonOf(answer), reason, what);
    assert.deepEqual([h.listed('_staged'), store.totalBytes()], [[], before], what);
    await stillWorks(h);
  }
  // The staged directory replaced by a file: refused, then fine once it is a directory again.
  fs.rmSync(h.blobDir('_staged'), { recursive: true, force: true });
  fs.writeFileSync(h.blobDir('_staged'), 'not a directory');
  assert.equal(reasonOf(await h.upload('bob', TEAM, Buffer.from('nowhere'))), 'team_chat_store_failed');
  fs.unlinkSync(h.blobDir('_staged'));
  await stillWorks(h);
});

test('open degrades instead of throwing: an unsafe tree, an unreadable channel, a leftover it cannot remove', BOUNDED, async (t) => {
  const h = await setup(t);
  const file = await attached(h, 'alice', TEAM, Buffer.from('in team'));
  const other = await attached(h, 'alice', PROJECT, Buffer.from('in project'));
  await h.chat.store.settled();
  const warnings = (event) => h.fx.logs.filter((line) => JSON.stringify(line).includes(event));
  // One channel's directory fails the guard: its downloads answer not found, the others still serve.
  const channelDir = path.join('blobs', TEAM);
  const picky = reopen(h, { assertSafePath: (target, ...rest) => {
    if (target.includes(channelDir)) throw Object.assign(new Error('unsafe'), { code: 'EUNSAFE' });
    return assertSafeFile(target, ...rest);
  } });
  assert.equal(picky.uploadPrecheck(TEAM, h.seats.alice.member_id).error.reason, 'team_chat_storage_limit');
  assert.equal((await picky.readAttachment(TEAM, file.item.id)).error.reason, 'team_chat_not_found');
  assert.equal((await picky.readAttachment(PROJECT, other.item.id)).bytes.toString(), 'in project');
  assert.ok(warnings('blob_channel_unreadable').length > 0);
  assert.ok(warnings('uploads_blocked').some((line) => JSON.stringify(line).includes('blob_channel_unreadable')));
  // A staged leftover whose unlink fails is counted as a stray.
  fs.writeFileSync(h.blobDir('_staged', FORGED), 'stuck leftover');
  const restore = patch(t, fs, 'unlinkSync', (unlink) => (target, ...rest) => {
    if (String(target).endsWith(FORGED)) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return unlink(target, ...rest);
  });
  const stuck = reopen(h);
  restore();
  assert.equal(stuck._blobs.fileCount(), 3, 'two attached files and the stray');
  assert.equal(stuck._blobs.total(), 'in team'.length + 'in project'.length + 'stuck leftover'.length);
  fs.unlinkSync(h.blobDir('_staged', FORGED));
  // The blob tree is a file: chat opens, text posts work, uploads are refused, downloads answer not found.
  fs.rmSync(h.blobDir(), { recursive: true, force: true });
  fs.writeFileSync(h.blobDir(), 'not a tree');
  const blocked = reopen(h);
  assert.equal(blocked._blobs.blocked(), 'blob_tree_unsafe');
  assert.equal(blocked.uploadPrecheck(TEAM, h.seats.alice.member_id).error.reason, 'team_chat_storage_limit');
  assert.equal((await blocked.readAttachment(TEAM, file.item.id)).error.reason, 'team_chat_not_found');
  const text = await blocked.post({ actorId: h.seats.alice.member_id, deviceId: h.seats.alice.device_id,
    requestId: 'text_only', channelId: TEAM, text: 'still talking' });
  assert.equal(text.ok, true, JSON.stringify(text));
  assert.ok(warnings('uploads_blocked').some((line) => JSON.stringify(line).includes('blob_tree_unsafe')));
  await blocked.settled();
});

test('the count limit, make-room and the tree limit: exactly the needed segments go, and the prune is announced', BOUNDED, async (t) => {
  const h = await setup(t, { storeLimits: { segmentMaxMessages: 1, attachmentMaxFiles: 4 } });
  const store = h.chat.store;
  const files = [];
  for (let i = 0; i < 4; i += 1) files.push(await attached(h, 'alice', TEAM, Buffer.alloc(100, 65 + i)));
  // A fifth file is over the count: the oldest segment goes with its file, and the prune is published.
  const published = h.published.length;
  const fifth = await h.upload('alice', TEAM, Buffer.from('fifth'));
  assert.equal(fifth.status, 200, JSON.stringify(fifth.json));
  assert.deepEqual(h.listed(TEAM), files.slice(1).map((file) => file.item.id).sort());
  assert.ok(h.published.slice(published).some((entry) => entry.type === 'team_chat_channel'
    && entry.payload.reason === 'pruned' && entry.payload.channel_id === TEAM));
  // Staged files are not prunable: over the count with nothing left to prune is refused.
  assert.equal(store.discardAttachment(fifth.json.attachment.id), true);
  store._limits = resolveLimits({ segmentMaxMessages: 1, attachmentMaxFiles: 1 });
  assert.equal(reasonOf(await h.upload('alice', TEAM, Buffer.from('x'))), 'team_chat_storage_limit', 'the head is kept');
  // The attachment bytes: 300 attached under a 400-byte limit; 250 more needs exactly two segments pruned.
  store._limits = resolveLimits({ segmentMaxMessages: 1, attachmentMaxBytes: 400 });
  const big = await h.upload('alice', TEAM, Buffer.alloc(250, 1));
  assert.equal(big.status, 200, JSON.stringify(big.json));
  assert.deepEqual(h.listed(TEAM), [files[3].item.id], 'files 2 and 3 went, the head stayed');
  assert.equal(store.discardAttachment(big.json.attachment.id), true);
  // The tree limit (segments and blobs): exactly at it is accepted, one byte over is refused.
  store._limits = resolveLimits({ segmentMaxMessages: 1, treeMaxBytes: store.totalBytes() + 10 });
  const exact = await h.upload('bob', TEAM, Buffer.alloc(10, 2));
  assert.equal(exact.status, 200, JSON.stringify(exact.json));
  assert.equal(reasonOf(await h.upload('bob', TEAM, Buffer.alloc(1, 2))), 'team_chat_storage_limit');
  assert.equal(store.brokenReason(), null);
});

// Review round two (R07-F01). Texts of a channel's history, oldest first.
const textsOf = (store, channelId) => store.history(channelId, { limit: 100 }).messages.map((message) => message.text);

async function textPosts(h, who, channelId, count, label) {
  for (let i = 0; i < count; i += 1) {
    const posted = await h.send(h.seats[who], 'team.chat.post', { channel_id: channelId, text: `${label} ${i}` });
    assert.equal(posted.ok, true, JSON.stringify(posted));
  }
}

test('R07-F01: an upload no prune can make fit is refused having removed nothing, in any channel', BOUNDED, async (t) => {
  const h = await setup(t, { storeLimits: { segmentMaxMessages: 1, attachmentMaxBytes: 400 } });
  await textPosts(h, 'bob', TEAM, 5, 'team history');
  const dm = await h.send(h.seats.owner, 'team.chat.dm_open', { member_ids: [h.seats.bob.member_id] });
  assert.equal(dm.ok, true, JSON.stringify(dm));
  await textPosts(h, 'bob', dm.channel_id, 3, 'private');
  // Alice holds 350 of the 400 attachment bytes in the project channel's head segment (never prunable).
  const held = await attached(h, 'alice', PROJECT, Buffer.alloc(350, 7));
  const published = h.published.length;
  const refused = await h.upload('alice', PROJECT, Buffer.alloc(100, 8));
  assert.equal(reasonOf(refused), 'team_chat_storage_limit');
  const store = h.chat.store;
  assert.deepEqual({ team: textsOf(store, TEAM).length, dm: textsOf(store, dm.channel_id).length }, { team: 5, dm: 3 },
    'a refused upload that frees nothing deletes nothing');
  assert.deepEqual([h.listed(PROJECT), h.listed('_staged')], [[held.item.id], []]);
  assert.equal(h.published.slice(published).some((entry) => entry.payload?.reason === 'pruned'), false, 'no prune announced');
});

test('R07-F01: an upload that fits by pruning one file\'s segment removes that segment only', BOUNDED, async (t) => {
  const h = await setup(t, { storeLimits: { segmentMaxMessages: 1, attachmentMaxBytes: 400 } });
  // Oldest: a direct conversation with a 100-byte file in a sealed segment, then the team channel's text.
  const dm = await h.send(h.seats.owner, 'team.chat.dm_open', { member_ids: [h.seats.bob.member_id] });
  const dmFile = await attached(h, 'bob', dm.channel_id, Buffer.alloc(100, 1));
  await textPosts(h, 'bob', dm.channel_id, 1, 'private');
  h.fx.advance(1_000);
  await textPosts(h, 'bob', TEAM, 3, 'team history');
  h.fx.advance(1_000);
  // Newest: a 300-byte file in a sealed project segment, then project text in the head.
  const old = await attached(h, 'alice', PROJECT, Buffer.alloc(300, 2));
  await textPosts(h, 'alice', PROJECT, 1, 'project');
  // 400 of 400 used; 150 more needs 150 freed: the project file's segment frees 300, the direct file is not the
  // project's to remove, and no text-only segment frees an attachment byte.
  const fits = await h.upload('alice', PROJECT, Buffer.alloc(150, 3));
  assert.equal(fits.status, 200, JSON.stringify(fits.json));
  const store = h.chat.store;
  assert.equal(textsOf(store, TEAM).length, 3, 'the team channel\'s older text stays');
  assert.equal(store.history(dm.channel_id, { limit: 100 }).messages.length, 2, 'the direct conversation stays');
  assert.deepEqual(h.listed(dm.channel_id), [dmFile.item.id]);
  assert.deepEqual(h.listed(PROJECT), [], 'the project file went with its segment');
  assert.equal(reasonOf(await h.download('alice', PROJECT, old.item.id)), 'team_chat_not_found');
  assert.deepEqual(textsOf(store, PROJECT), ['project 0']);
});

// X6b-F05: the plan counts the pruned segment's blob as freed; when its unlink fails it stays a counted stray, and
// the check after the prunes (team-chat-room.js _makeRoom) is what refuses the upload.
test('R07-F01: an upload whose prune could not unlink a blob is refused after the prunes, with nothing registered', BOUNDED, async (t) => {
  const h = await setup(t, { storeLimits: { segmentMaxMessages: 1, attachmentMaxBytes: 400 } });
  const old = await attached(h, 'alice', PROJECT, Buffer.alloc(300, 2));
  await textPosts(h, 'alice', PROJECT, 1, 'project');
  const store = h.chat.store;
  patch(t, fs, 'unlinkSync', (unlink) => (target, ...rest) => {
    if (String(target).endsWith(old.item.id)) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return unlink(target, ...rest);
  });
  const refused = await h.upload('alice', PROJECT, Buffer.alloc(150, 3));
  assert.equal(reasonOf(refused), 'team_chat_storage_limit', JSON.stringify(refused.json));
  assert.deepEqual(textsOf(store, PROJECT), ['project 0'], 'the planned prune ran');
  assert.deepEqual([h.listed(PROJECT), h.listed('_staged')], [[old.item.id], []], 'the stray stays; nothing staged');
  assert.equal(store._blobs.total(), 300, 'the stray is still counted');
  assert.equal(store.stagedAttachmentCount(h.seats.alice.member_id), 0);
});

// Review round two (R07-F02, X4-F04 chat half): an absent index.json never deletes or overwrites at open.
test('R07-F02: with index.json gone, open rebuilds the list from the channel folders and keeps every file', BOUNDED, async (t) => {
  const h = await setup(t);
  const file = await attached(h, 'alice', TEAM, Buffer.from('keep me'));
  const other = await attached(h, 'alice', PROJECT, Buffer.from('keep me too'));
  await h.chat.store.settled();
  const channelFile = path.join(h.fx.dir, 'team-chat', TEAM, 'channel.json');
  const bytesBefore = fs.readFileSync(channelFile);
  fs.unlinkSync(path.join(h.fx.dir, 'team-chat', 'index.json'));
  const again = new TeamChatStore({ profileDir: h.fx.dir, clock: h.fx.clock, logger: h.fx.logger });
  const opened = again.open();
  assert.deepEqual({ blobs: [h.listed(TEAM), h.listed(PROJECT)], same: fs.readFileSync(channelFile).equals(bytesBefore) },
    { blobs: [[file.item.id], [other.item.id]], same: true }, `open answered ${JSON.stringify(opened)}; nothing removed`);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.deepEqual(again.listChannels().channels.map((info) => info.channel_id).sort(), [PROJECT, TEAM].sort());
  // The host's start creates chan_team: it exists, so nothing is overwritten.
  assert.equal((await again.createChannel({ channelId: TEAM })).created, false);
  assert.ok(fs.readFileSync(channelFile).equals(bytesBefore));
  assert.equal((await again.readAttachment(TEAM, file.item.id)).bytes.toString(), 'keep me');
  assert.ok(h.fx.logs.some((line) => JSON.stringify(line).includes('team_chat.index_rebuilt')));
  await again.settled();
});

test('R07-F02: with index.json gone and a folder it cannot rebuild from, open fails and removes nothing', BOUNDED, async (t) => {
  const h = await setup(t);
  const file = await attached(h, 'alice', TEAM, Buffer.from('keep me'));
  await textPosts(h, 'alice', PROJECT, 1, 'project');
  await h.chat.store.settled();
  fs.unlinkSync(path.join(h.fx.dir, 'team-chat', 'index.json'));
  fs.mkdirSync(h.blobDir('chan_project_gone'), { recursive: true });
  fs.writeFileSync(h.blobDir('chan_project_gone', FORGED), 'no channel folder names me');
  const tree = () => fs.readdirSync(path.join(h.fx.dir, 'team-chat'), { recursive: true }).sort();
  const before = tree();
  const opened = new TeamChatStore({ profileDir: h.fx.dir, clock: h.fx.clock, logger: h.fx.logger }).open();
  assert.equal(opened.ok, false, 'a blob folder no channel folder lists: chat does not start');
  assert.deepEqual([tree(), h.listed(TEAM)], [before, [file.item.id]], 'no file removed');
  // A channel folder whose channel.json is gone cannot be rebuilt either.
  fs.unlinkSync(h.blobDir('chan_project_gone', FORGED));
  fs.unlinkSync(path.join(h.fx.dir, 'team-chat', PROJECT, 'channel.json'));
  const second = tree();
  const failed = new TeamChatStore({ profileDir: h.fx.dir, clock: h.fx.clock, logger: h.fx.logger }).open();
  assert.equal(failed.ok, false);
  assert.deepEqual(tree(), second);
  assert.ok(h.fx.logs.some((line) => JSON.stringify(line).includes('index_missing')), 'the reason word is logged');
});

test('a post refused for a limit moves no blob: its staged uploads stay attachable', BOUNDED, async (t) => {
  const h = await setup(t);
  const store = h.chat.store;
  const one = await h.staged('alice', TEAM, Buffer.from('one'));
  const two = await h.staged('alice', TEAM, Buffer.from('two'));
  store._limits = resolveLimits({ treeMaxBytes: store.totalBytes() + 1 });
  assert.equal(reasonOf(await h.post('alice', TEAM, [one.id, two.id])), 'team_chat_storage_limit');
  assert.deepEqual([h.listed('_staged'), h.listed(TEAM)], [[one.id, two.id].sort(), []]);
  store._limits = resolveLimits({});
  const posted = await h.post('alice', TEAM, [one.id, two.id]);
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.deepEqual(h.listed(TEAM), [one.id, two.id].sort());
});

test('the staged sweep runs on its timer after the first retention pass; dispose leaves no timer', BOUNDED, async (t) => {
  const h = await setup(t);
  const timers = fakeTimers();
  const profileDir = path.join(h.fx.dir, 'second');
  fs.mkdirSync(profileDir);
  const host = createTeamChatHost({ profileDir, directory: h.store.directory, clock: h.fx.clock, timers });
  assert.deepEqual(await host.start(), { ok: true });
  assert.deepEqual([...timers.pending.values()].map((handle) => [handle.ms, handle.unrefed]),
    [[6 * 60 * 60 * 1000, true], [5 * 60 * 1000, true]]);
  const staged = await host.store.stageAttachment({ channelId: TEAM, memberId: h.seats.alice.member_id, name: 'a.txt',
    mime: 'text/plain', bytes: Buffer.from('stale') });
  assert.equal(staged.ok, true);
  const sweepTimer = [...timers.pending.values()].find((handle) => handle.ms === 5 * 60 * 1000);
  h.fx.advance(59 * 60 * 1000);
  sweepTimer.fn();
  assert.equal(host.store.stagedAttachmentCount(h.seats.alice.member_id), 1, 'not expired yet');
  h.fx.advance(60 * 1000);
  sweepTimer.fn();
  assert.equal(host.store.stagedAttachmentCount(h.seats.alice.member_id), 0);
  assert.deepEqual(fs.readdirSync(path.join(profileDir, 'team-chat', 'blobs', '_staged')), []);
  await host.dispose();
  assert.equal(timers.pending.size, 0);
});

test('on a real team host: the chain reaches both routes, the disk gate refuses under pressure, an unknown key gets no byte', BOUNDED, async (t) => {
  let pressure = false;
  const statfs = (root) => (pressure ? { bavail: 0, bsize: 1 } : fs.statfsSync(root));
  const m = await startMountedHost(t, { extra: { statfs } });
  const { member } = await m.seed();
  const { client, auth } = await m.ready(member);
  const uploadPath = `/api/v1/team/chat/uploads/${TEAM}`;
  const fileHeaders = { 'Content-Type': 'text/plain', 'X-File-Name': 'mounted.txt' };
  const up = await client.request('POST', uploadPath, { rawBody: Buffer.from('mounted bytes'), headers: { ...auth, ...fileHeaders } });
  assert.equal(up.status, 200, up.text);
  const id = up.json.attachment.id;
  const body = { ...command({ client_id: auth['X-Client-Id'] }, 'team.chat.post',
    { channel_id: TEAM, text: 'from the mounted host', attachment_ids: [id] }), boot_epoch: m.context.bootEpoch };
  const posted = await client.request('POST', '/api/v1/commands', { body, headers: { 'X-Client-Token': auth['X-Client-Token'] } });
  assert.equal(posted.json?.ok, true, posted.text);
  const downloadPath = `/api/v1/team/chat/attachments/${TEAM}/${id}`;
  const down = await client.request('GET', downloadPath, { headers: auth });
  assert.deepEqual([down.status, down.text, down.headers['x-content-type-options']], [200, 'mounted bytes', 'nosniff']);
  pressure = true;
  const pressed = await client.request('POST', uploadPath, { rawBody: Buffer.from('more'), headers: { ...auth, ...fileHeaders } });
  assert.deepEqual([pressed.status, pressed.json?.error?.reason], [503, 'disk_pressure']);
  pressure = false;
  const stranger = m.client(randomKey());
  await assert.rejects(stranger.request('POST', uploadPath, { rawBody: Buffer.from('x'), headers: fileHeaders }), 'unknown upload');
  await assert.rejects(stranger.request('GET', downloadPath), 'unknown download');
});
