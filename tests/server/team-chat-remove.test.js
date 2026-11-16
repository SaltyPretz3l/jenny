'use strict';

// new-test-file: tests/server/team-chat-store.test.js, the chat store's own file, is at its line cap (596 lines).
// Owner decision E67 (2026-11-14, review X3c-F01): removing a deleted project's channel from the team chat store
// (services/host/team-chat-remove.js): the channel document, every segment, its read state, its attachments and its
// index row; the 1,024 channel cap then counts live channels only; a cut removal is finished; nothing follows a link;
// the start-up pass removes the channels earlier builds archived for projects that no longer exist.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ALICE, ALICE_DEVICE, BOB, createChatFixture, assertFailure } = require('./helpers/team-chat-fixture');
const { LIMITS } = require('../../services/host/team-chat-schema');

const FORBIDDEN = 'CMP-HOST-0003';
const APOLLO = 'chan_project_apollo';
const newProjectChannel = () => `chan_project_${crypto.randomBytes(16).toString('hex')}`;

function logged(fx) {
  const lines = [];
  const store = fx.openStore({ logger: (level, event, fields) => lines.push({ level, event, fields }) });
  return { store, lines };
}

// A channel with two messages, one of them carrying an attachment, and a read mark.
async function populated(fx, store, channelId) {
  await fx.createChannel(store, channelId);
  const staged = await store.stageAttachment({ channelId, memberId: ALICE, name: 'plan.txt', mime: 'text/plain',
    bytes: Buffer.from('attachment bytes') });
  assert.equal(staged.ok, true, JSON.stringify(staged));
  await fx.postOk(store, { channelId, attachmentIds: [staged.attachment.id] });
  await fx.postOk(store, { channelId, text: 'second' });
  assert.equal((await store.markRead({ channelId, actorId: ALICE, seq: 2 })).ok, true);
  return staged.attachment.id;
}

const exists = (fx, ...parts) => fs.existsSync(path.join(fx.chatDir, ...parts));
const indexIds = (fx) => fx.readDoc('index.json').channels.map((entry) => entry.channel_id);
const listedIds = (store) => store.listChannels().channels.map((info) => info.channel_id);

test('E67: removeChannel takes the document, every segment, the read state, the attachments and the index row', async (t) => {
  const fx = createChatFixture(t);
  const { store, lines } = logged(fx);
  await fx.createChannel(store);
  await fx.postOk(store, { text: 'team stays' });
  const attachmentId = await populated(fx, store, APOLLO);
  assert.deepEqual(fs.readdirSync(path.join(fx.chatDir, APOLLO)).sort(), ['channel.json', 'read.json', 'seg-1.json']);
  assert.equal(exists(fx, 'blobs', APOLLO, attachmentId), true);
  const teamBytes = fx.readDoc('chan_team/channel.json').bytes;
  assert.ok(store.totalBytes() > teamBytes);

  const removed = await store.removeChannel({ channelId: APOLLO });
  assert.deepEqual(removed, { ok: true, removed: true });
  assert.equal(exists(fx, APOLLO), false, 'the channel folder');
  assert.equal(exists(fx, 'blobs', APOLLO), false, 'the attachment folder');
  assert.deepEqual(indexIds(fx), ['chan_team']);
  assert.deepEqual(listedIds(store), ['chan_team']);
  assertFailure(store.channelHeader(APOLLO), FORBIDDEN, 'team_chat_not_found');
  assertFailure(await fx.post(store, { channelId: APOLLO }), FORBIDDEN, 'team_chat_not_found');
  assertFailure(await store.readAttachment(APOLLO, attachmentId), FORBIDDEN, 'team_chat_not_found');
  assert.equal(store.totalBytes(), teamBytes, 'no byte of it is still counted');
  assert.equal(store.history('chan_team', { limit: 10 }).messages[0].text, 'team stays');
  // A restart reads the same.
  const restarted = fx.openStore();
  assert.deepEqual(listedIds(restarted), ['chan_team']);
  assert.equal(restarted.totalBytes(), teamBytes);
  assert.deepEqual(lines.filter((line) => line.event === 'team_chat.channel_removed').map((line) => line.fields),
    [{ channel_id: APOLLO, left: 0 }]);
});

test('E67 (X3c-F01): 1,100 create and remove cycles leave only the live channels; new channels still open', { timeout: 590_000 }, async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  await fx.createChannel(store);
  const live = [newProjectChannel(), newProjectChannel()];
  for (const channelId of live) await fx.createChannel(store, channelId);
  for (let cycle = 0; cycle < 1_100; cycle += 1) {
    const channelId = newProjectChannel();
    await fx.createChannel(store, channelId);
    assert.deepEqual(await store.removeChannel({ channelId }), { ok: true, removed: true }, `cycle ${cycle}`);
  }
  assert.ok(1_100 > LIMITS.CHANNELS_MAX, 'more cycles than the cap');
  assert.deepEqual(listedIds(store).sort(), ['chan_team', ...live].sort());
  const restarted = fx.openStore();
  assert.deepEqual(listedIds(restarted).sort(), ['chan_team', ...live].sort());
  assert.deepEqual(fs.readdirSync(fx.chatDir).sort(), ['chan_team', ...live, 'index.json'].sort());
  // The next project gets its channel and a new direct conversation opens.
  assert.equal((await restarted.createChannel({ channelId: newProjectChannel() })).created, true);
  assert.equal((await restarted.openDirect({ memberIds: ['member_carol', 'member_dave'] })).ok, true);
});

test('E67: a channel never made answers ok; the team channel and a direct conversation are never removed', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  await fx.createChannel(store);
  const dm = await store.openDirect({ memberIds: [ALICE, BOB] });
  assert.equal(dm.ok, true);
  const before = fx.snapshotTree();
  assert.deepEqual(await store.removeChannel({ channelId: 'chan_project_never' }), { ok: true, removed: false });
  for (const channelId of ['chan_team', dm.channel_id, 'not a channel', undefined]) {
    assertFailure(await store.removeChannel({ channelId }), FORBIDDEN, 'team_chat_not_found');
  }
  assert.deepEqual(fx.snapshotTree(), before);
  assert.deepEqual(listedIds(store), ['chan_team', dm.channel_id]);
});

test('E67: a removal cut after its index commit is finished by the next removal or the start pass', async (t) => {
  for (const finish of ['remove', 'sweep']) {
    const fx = createChatFixture(t);
    const store = fx.openStore();
    await fx.createChannel(store);
    await populated(fx, store, APOLLO);
    fx.control.failRemove = true; // every file removal fails, as a crash part way would leave it
    assert.deepEqual(await store.removeChannel({ channelId: APOLLO }), { ok: true, removed: true });
    assert.deepEqual(indexIds(fx), ['chan_team'], 'the index row went first');
    assert.equal(exists(fx, APOLLO, 'channel.json'), true, 'the folder is left');
    fx.control.failRemove = false;
    const restarted = fx.openStore();
    assert.deepEqual(listedIds(restarted), ['chan_team']);
    if (finish === 'remove') {
      assert.deepEqual(await restarted.removeChannel({ channelId: APOLLO }), { ok: true, removed: false });
    } else {
      assert.deepEqual(await restarted.removeDeadProjectChannels({ isLive: () => true }),
        { ok: true, removed: 0, leftovers: 1 });
    }
    assert.equal(exists(fx, APOLLO), false, finish);
    assert.equal(exists(fx, 'blobs', APOLLO), false, `${finish}: the attachment folder`);
  }
});

test('E67: a removal never follows a link: what a junction in a channel or attachment folder points at stays', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-e67-outside-')));
  const links = [];
  t.after(() => {
    for (const link of links) fs.rmSync(link, { force: true, recursive: false });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outside, 'seg-1.json'), 'keep');
  fs.writeFileSync(path.join(outside, 'att_00000000000000000000000000'), 'keep');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  // A junction inside a channel folder.
  await populated(fx, store, APOLLO);
  links.push(path.join(fx.chatDir, APOLLO, 'linked'));
  fs.symlinkSync(outside, links[0], kind);
  // A junction in place of a channel's attachment folder.
  const zephyr = 'chan_project_zephyr';
  await populated(fx, store, zephyr);
  const blobDir = path.join(fx.chatDir, 'blobs', zephyr);
  fs.rmSync(blobDir, { recursive: true });
  links.push(blobDir);
  fs.symlinkSync(outside, blobDir, kind);
  for (const channelId of [APOLLO, zephyr]) {
    assert.deepEqual(await store.removeChannel({ channelId }), { ok: true, removed: true });
  }
  assert.deepEqual(fs.readdirSync(outside).sort(), ['att_00000000000000000000000000', 'seg-1.json']);
  assert.equal(fs.readFileSync(path.join(outside, 'seg-1.json'), 'utf8'), 'keep');
  assert.deepEqual(listedIds(store), []);
});

test('E67: the start pass removes every project channel whose project is gone, archived or not, logged by count only', async (t) => {
  const fx = createChatFixture(t);
  const { store, lines } = logged(fx);
  await fx.createChannel(store);
  const dm = await store.openDirect({ memberIds: [ALICE, BOB] });
  for (const channelId of ['chan_project_live', 'chan_project_oldone', 'chan_project_oldtwo', 'chan_project_cut']) {
    await fx.createChannel(store, channelId);
  }
  await populated(fx, store, 'chan_project_attached');
  for (const channelId of ['chan_project_oldone', 'chan_project_attached']) {
    assert.equal((await store.archiveChannel({ channelId })).ok, true); // as earlier builds did on a delete
  }
  const asked = [];
  const mark = lines.length;
  const answer = await store.removeDeadProjectChannels({ isLive: (projectId) => {
    asked.push(projectId);
    if (projectId === 'project_cut') throw new Error('lookup failed'); // a throw keeps the channel (fail closed)
    return projectId === 'project_live';
  } });
  assert.deepEqual(answer, { ok: true, removed: 3, leftovers: 0 });
  assert.deepEqual(asked.sort(), ['project_attached', 'project_cut', 'project_live', 'project_oldone', 'project_oldtwo']);
  assert.deepEqual(listedIds(store), ['chan_team', dm.channel_id, 'chan_project_live', 'chan_project_cut']);
  for (const name of ['chan_project_oldone', 'chan_project_oldtwo', 'chan_project_attached']) {
    assert.equal(exists(fx, name), false, name);
    assert.equal(exists(fx, 'blobs', name), false, `${name} attachments`);
  }
  assert.equal(store.totalBytes(), 0);
  const counted = lines.filter((line) => line.event === 'team_chat.dead_channels_removed');
  assert.deepEqual(counted.map((line) => line.fields), [{ removed: 3, leftovers: 0 }]);
  assert.equal(lines.slice(mark).some((line) => JSON.stringify(line).includes('chan_project')), false,
    'the pass logs no channel id');
  // A missing lookup is refused before anything is read.
  assertFailure(await store.removeDeadProjectChannels({}), 'CMP-HOST-0001', 'team_chat_request_invalid');
  assert.deepEqual(await store.removeDeadProjectChannels({ isLive: () => true }), { ok: true, removed: 0, leftovers: 0 });
  // A post in the team channel still works after the pass.
  await fx.postOk(store, { actorId: ALICE, deviceId: ALICE_DEVICE });
});
