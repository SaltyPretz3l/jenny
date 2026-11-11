'use strict';

// Team chat store (row 123 slice 2a-1, review round): crash consistency of a
// torn head that later rolls, the current head never pruned, which failures
// latch the store and which do not, one broken channel beside working ones,
// and the path guard before listing or creating a directory. Every case reads
// back through a fresh store instance.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  ALICE, DAY_MS, createChatFixture, seeded, assertFailure,
} = require('./helpers/team-chat-fixture');
const { createFileIo } = require('../../services/host/team-chat-files');

const PERSISTENCE = 'CMP-HOST-0006';
const LIMIT = 'CMP-HOST-0007';

const segmentNs = (fx, channel = 'chan_team') => fx.readDoc(`${channel}/channel.json`).segments.map((s) => s.n);
const rising = (ns) => ns.every((n, i) => i === 0 || n > ns[i - 1]);

// ------------------------------------------------------------ item 1

test('a torn post in a nearly full head, then a post that rolls by bytes, reopens intact', async (t) => {
  const limits = { segmentMaxBytes: 4000 };
  const { fx, store } = await seeded(t, limits);
  await fx.postOk(store, { text: 'a'.repeat(1500) });
  await fx.postOk(store, { text: 'b'.repeat(1000) });
  fx.control.crashAfter = 1;
  await fx.post(store, { text: 'torn' });
  fx.control.crashAfter = null;
  assert.deepEqual(segmentNs(fx), [1], 'the torn post did not roll');
  const reopened = fx.openStore({ limits });
  const big = await fx.postOk(reopened, { text: 'c'.repeat(1500) });
  assert.equal(big.seq, 3);
  assert.deepEqual(segmentNs(fx), [1, 2], 'the big post rolled');
  const again = fx.openStore({ limits });
  const page = again.history('chan_team', { limit: 10 });
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.deepEqual(page.messages.map((m) => m.seq), [1, 2, 3]);
  assert.equal(page.messages.some((m) => m.text === 'torn'), false);
});

// ------------------------------------------------------------ item 2

test('a rolling post never prunes the current head: aged segments, count roll and byte roll', async (t) => {
  for (const limits of [{ segmentMaxMessages: 2 }, { segmentMaxBytes: 2500 }]) {
    const { fx, store } = await seeded(t, limits);
    for (let i = 0; i < 4; i += 1) await fx.postOk(store, { text: 'x'.repeat(1500) });
    const before = segmentNs(fx);
    fx.advance(365 * DAY_MS + 1);
    const next = await fx.post(store, { text: 'x'.repeat(1500) });
    assert.equal(next.ok, true, JSON.stringify(next));
    const after = segmentNs(fx);
    assert.ok(rising(after) && after.at(-1) === before.at(-1) + 1, `${JSON.stringify(limits)}: ${after}`);
    assert.ok(after.includes(before.at(-1)), 'the old head stays until a later pass');
    assert.equal(fx.openStore({ limits }).history('chan_team', { limit: 10 }).messages.at(-1).seq, next.seq);
  }
});

test('maxMessages below one segment keeps segment numbers rising', async (t) => {
  const limits = { maxMessages: 3, segmentMaxMessages: 5 };
  const { fx, store } = await seeded(t, limits);
  const heads = [];
  for (let i = 1; i <= 16; i += 1) {
    assert.equal((await fx.post(store, { text: `m${i}` })).ok, true);
    assert.ok(rising(segmentNs(fx)), `${segmentNs(fx)}`);
    heads.push(segmentNs(fx).at(-1));
  }
  assert.ok(heads.every((n, i) => i === 0 || n >= heads[i - 1]), `head numbers ${heads}`);
  assert.equal(heads.at(-1), 4);
  const reopened = fx.openStore({ limits });
  assert.equal(reopened.channelInfo('chan_team').last_seq, 16);
  assert.equal(reopened.history('chan_team', { limit: 100 }).messages.at(-1).seq, 16);
});

// ------------------------------------------------------------ item 3

test('a transient read error answers store_failed once and leaves the store usable', async (t) => {
  const { fx, store } = await seeded(t);
  await fx.postOk(store);
  await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: 1 });
  const cases = [
    ['index.json', (s) => s.open()],
    ['chan_team/seg-1.json', (s) => s.history('chan_team', { limit: 5 })],
    ['chan_team/read.json', (s) => s.readState('chan_team', ALICE)],
    ['chan_team/seg-1.json', (s) => fx.post(s)],
  ];
  for (const [file, call] of cases) {
    const fresh = fx.newStore();
    fx.control.busyOnce = file;
    assertFailure(await call(fresh), PERSISTENCE, 'team_chat_store_failed');
    const retried = await call(fresh);
    assert.equal(retried.ok, true, `${file}: ${JSON.stringify(retried)}`);
  }
  assert.equal(fx.openStore().channelInfo('chan_team').last_seq, 2);
});

test('a document over its bound is refused as storage_limit before anything is created', (t) => {
  const fx = createChatFixture(t);
  const io = createFileIo({ guard: () => {}, ops: fx.fileOps, log: () => {} });
  const target = path.join(fx.chatDir, 'chan_team', 'x.json');
  let refused = null;
  try { io.write(target, { big: 'x'.repeat(100) }, 50); } catch (error) { refused = error.refusal; }
  assert.equal(refused?.error.code, LIMIT);
  assert.equal(refused?.error.reason, 'team_chat_storage_limit');
  assert.equal(fs.existsSync(path.dirname(target)), false);
});

test('an id collision is refused without latching the store', async (t) => {
  const { fx, store } = await seeded(t);
  fx.control.fixedRandom = true;
  await fx.postOk(store);
  assertFailure(await fx.post(store), PERSISTENCE, 'team_chat_store_failed');
  fx.control.fixedRandom = false;
  assert.equal((await fx.postOk(store)).seq, 2);
  assert.equal(fx.openStore().channelInfo('chan_team').last_seq, 2);
});

test('a prune is a full commit: a failed first write of the post that follows does not latch', async (t) => {
  const limits = { maxMessages: 2, segmentMaxMessages: 1 };
  const { fx, store } = await seeded(t, limits);
  await fx.postOk(store);
  await fx.postOk(store);
  fx.control.failWrite = (file) => file === 'chan_team/seg-3.json';
  assertFailure(await fx.post(store), PERSISTENCE, 'team_chat_store_failed');
  fx.control.failWrite = null;
  assert.equal(store.channelInfo('chan_team').floor_seq, 2, 'the prune stands');
  assert.equal((await fx.postOk(store)).seq, 3);
  assert.equal(fx.openStore({ limits }).channelInfo('chan_team').last_seq, 3);
});

test('a prune interrupted by a crash after channel.json reopens with the floor raised', async (t) => {
  const limits = { maxMessages: 2, segmentMaxMessages: 1 };
  const { fx, store } = await seeded(t, limits);
  await fx.postOk(store);
  await fx.postOk(store);
  fx.control.crashAfter = 1;
  fx.control.failRemove = true;
  await fx.post(store);
  fx.control.crashAfter = null;
  fx.control.failRemove = false;
  const reopened = fx.openStore({ limits });
  assert.equal(reopened.channelInfo('chan_team').floor_seq, 2);
  assert.deepEqual(reopened.history('chan_team', { limit: 5 }).messages.map((m) => m.seq), [2]);
  await fx.postOk(reopened);
  assert.equal(fs.existsSync(path.join(fx.chatDir, 'chan_team', 'seg-1.json')), false, 'the stray is swept');
});

// ------------------------------------------------------------ item 4

test('one broken channel leaves the others working and nothing in it is rewritten', async (t) => {
  const { fx, store } = await seeded(t);
  for (const id of ['chan_project_a', 'chan_project_b']) {
    await fx.createChannel(store, id);
    await fx.postOk(store, { channelId: id });
    await store.markRead({ channelId: id, actorId: ALICE, seq: 1 });
  }
  const seg = fx.readDoc('chan_project_a/seg-1.json');
  seg.schema_version = 2;
  fx.writeDoc('chan_project_a/seg-1.json', seg);
  fx.writeDoc('chan_project_b/read.json', '{"schema_version":1,');
  const before = fx.snapshotTree();
  const fresh = fx.openStore();
  assertFailure(fresh.history('chan_project_a', { limit: 5 }), PERSISTENCE, 'team_chat_schema_unsupported');
  assertFailure(await fx.post(fresh, { channelId: 'chan_project_a' }), PERSISTENCE, 'team_chat_schema_unsupported');
  assertFailure(fresh.readState('chan_project_b', ALICE), PERSISTENCE, 'team_chat_store_failed');
  assertFailure(await fx.post(fresh, { channelId: 'chan_project_b' }), PERSISTENCE, 'team_chat_store_failed');
  const changedA = Object.keys(before).filter((k) => !k.startsWith('chan_team/') && fx.snapshotTree()[k] !== before[k]);
  assert.deepEqual(changedA, []);
  assert.equal((await fx.postOk(fresh)).seq, 1);
  assert.equal(fresh.history('chan_team', { limit: 5 }).messages.length, 1);
  assert.deepEqual((await fresh.applyRetention()).pruned, []);
});

// ------------------------------------------------------------ item 7

test('the file layer guards before it lists or creates a directory', (t) => {
  const fx = createChatFixture(t);
  const listed = [];
  const io = createFileIo({
    guard: () => { throw Object.assign(new Error('unsafe'), { reason: 'unsafe_path' }); },
    ops: { ...fx.fileOps, listDir: (dir) => { listed.push(dir); return []; } },
    log: () => {},
  });
  const target = path.join(fx.chatDir, 'chan_team', 'channel.json');
  assert.throws(() => io.write(target, { a: 1 }, 1000), /unsafe/u);
  assert.equal(fs.existsSync(path.join(fx.chatDir, 'chan_team')), false, 'nothing created before the guard');
  assert.throws(() => io.list(fx.chatDir), /unsafe/u);
  assert.deepEqual(listed, []);
});

test('a linked team-chat directory creates nothing at the link target', { skip: process.platform !== 'win32' && 'junctions are a Windows case' }, (t) => {
  const fx = createChatFixture(t);
  const elsewhere = fs.mkdtempSync(path.join(fx.profileDir, 'elsewhere-'));
  fs.symlinkSync(elsewhere, fx.chatDir, 'junction');
  const io = createFileIo({ guard: require('../../services/host/path-guard').assertSafeFile, ops: fx.fileOps,
    log: () => {} });
  assert.throws(() => io.write(path.join(fx.chatDir, 'chan_team', 'channel.json'), { a: 1 }, 1000));
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

// ------------------------------------------------------------ item 10 and gaps

test('pins naming a missing or deleted message are dropped on load', async (t) => {
  const { fx, store } = await seeded(t);
  const live = await fx.postOk(store);
  const gone = await fx.postOk(store);
  await fx.del(store, { messageId: gone.message_id });
  const doc = fx.readDoc('chan_team/channel.json');
  doc.pins = [gone.message_id, live.message_id, 'msg_00000000000000000000000000'];
  fx.writeDoc('chan_team/channel.json', doc);
  assert.deepEqual(fx.openStore().channelInfo('chan_team').pins, [live.message_id]);
});

test('torn reply with the root in the head segment: reply absent, revision not reused', async (t) => {
  const { fx, store } = await seeded(t);
  const root = await fx.postOk(store, { text: 'root' });
  fx.control.crashAfter = 1;
  await fx.post(store, { threadRootId: root.message_id, text: 'reply' });
  fx.control.crashAfter = null;
  const reopened = fx.openStore();
  const rootNow = reopened.getMessage('chan_team', root.message_id).message;
  assert.equal(rootNow.reply_count, 0);
  assert.equal(reopened.channelInfo('chan_team').last_seq, 1);
  assert.ok(reopened.channelInfo('chan_team').rev >= rootNow.rev);
  assert.ok((await fx.postOk(reopened)).rev > rootNow.rev);
});

test('age retention: a segment exactly at the limit stays, one millisecond older goes', async (t) => {
  const limits = { segmentMaxMessages: 1 };
  const { fx, store } = await seeded(t, limits);
  await fx.postOk(store);
  await fx.postOk(store);
  fx.advance(365 * DAY_MS);
  assert.deepEqual((await store.applyRetention()).pruned, []);
  fx.advance(1);
  assert.equal((await store.applyRetention()).pruned.length, 1);
  assert.equal(fx.openStore({ limits }).channelInfo('chan_team').floor_seq, 2);
});

// ------------------------------------------------------------ a write that landed, then failed

test('a head write that landed but failed, then a rolling post, reopens without a gap', async (t) => {
  const limits = { segmentMaxBytes: 4000 };
  const { fx, store } = await seeded(t, limits);
  await fx.postOk(store, { text: 'a'.repeat(1500) });
  await fx.postOk(store, { text: 'b'.repeat(1000) });
  fx.control.failAfterWrite = (rel) => rel === 'chan_team/seg-1.json';
  assertFailure(await fx.post(store, { text: 'lost' }), PERSISTENCE, 'team_chat_store_failed');
  assert.equal((await fx.postOk(store, { text: 'c'.repeat(1500) })).seq, 3);
  const page = fx.openStore({ limits }).history('chan_team', { limit: 10 });
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.deepEqual(page.messages.map((m) => m.seq), [1, 2, 3]);
  assert.equal(page.messages.some((m) => m.text === 'lost'), false);
});

test('an edit write that landed but failed never shares its revision with the next change', async (t) => {
  const { fx, store } = await seeded(t);
  const first = await fx.postOk(store, { text: 'one' });
  fx.control.failAfterWrite = (rel) => rel === 'chan_team/seg-1.json';
  assertFailure(await fx.edit(store, { messageId: first.message_id, expectedRev: first.rev, text: 'edited' }),
    PERSISTENCE, 'team_chat_store_failed');
  const editedRev = fx.readDoc('chan_team/seg-1.json').messages[0].rev;
  assert.ok(editedRev > first.rev, 'the edited message is on disk');
  const next = await fx.postOk(store, { text: 'two' });
  assert.ok(next.rev > editedRev, `post rev ${next.rev} must pass the landed edit ${editedRev}`);
  assert.ok(fx.openStore().channelInfo('chan_team').rev >= editedRev);
});

test('a read.json write that landed but failed is what the next readState returns', async (t) => {
  const { fx, store } = await seeded(t);
  await fx.postOk(store);
  await fx.postOk(store);
  fx.control.failAfterWrite = (rel) => rel === 'chan_team/read.json';
  assertFailure(await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: 2 }), PERSISTENCE,
    'team_chat_store_failed');
  const onDisk = fx.readDoc('chan_team/read.json').members[0].last_read_seq;
  assert.equal(onDisk, 2);
  assert.equal(store.readState('chan_team', ALICE).last_read_seq, onDisk);
  assert.equal(fx.openStore().readState('chan_team', ALICE).last_read_seq, onDisk);
});
