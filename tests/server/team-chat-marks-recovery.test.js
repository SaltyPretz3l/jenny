'use strict';

// Slice 2b-1 review round: the pin list after a torn write, the disk gate and
// the limiter for marks, the lean mark event and the read event's race. The
// first file of the slice is team-chat-reactions-pins.test.js. Each test names
// the fault that makes it fail.

const assert = require('node:assert/strict');
const test = require('node:test');

const { REACTION_EMOJI } = require('../../services/host/team-chat-emoji');
const { createTeamChatCommandsFixture } = require('./helpers/team-chat-commands-fixture');
const { createChatFixture, ALICE, ALICE_DEVICE } = require('./helpers/team-chat-fixture');

const THUMB = REACTION_EMOJI[0];
const CHANNEL = 'chan_team';

const reactParams = (id, on = true, emoji = THUMB) => ({ channel_id: CHANNEL, message_id: id, emoji, on });
const pinParams = (id, on = true) => ({ channel_id: CHANNEL, message_id: id, on });
const messageEvents = (f) => f.published.filter((entry) => entry.type === 'team_chat_message');
const readEvents = (f) => f.published.filter((entry) => entry.type === 'team_chat_read');

// ------------------------------------------------------------ the pin list after a torn write

// Review round two (R07-F03): the prune drops an orphaned reply's pin; the reload must not bring it back.
test('R07-F03: a pinned reply whose root was pruned is not a pin after a reload (fault: the load counts orphans)', async (t) => {
  const fx = createChatFixture(t, { limits: { segmentMaxMessages: 1, maxMessages: 3 } });
  const store = fx.openStore();
  await fx.createChannel(store);
  const root = await fx.postOk(store, { text: 'root' });
  await fx.postOk(store, { text: 'filler' });
  const reply = await fx.postOk(store, { text: 'reply', threadRootId: root.message_id });
  assert.equal((await store.pin(pinInput(reply.message_id, 1))).ok, true);
  assert.equal(store.channelHeader(CHANNEL).pin_count, 1);
  const fourth = await fx.postOk(store, { text: 'fourth' });
  assert.ok(fourth.pruned.length > 0, 'the root\'s segment was pruned');
  assert.equal(store.channelHeader(CHANNEL).pin_count, 0, 'the prune dropped the orphan\'s pin');
  await store.settled();
  const again = fx.openStore();
  await again.ensureLoaded(CHANNEL);
  const info = again.channelInfo(CHANNEL);
  assert.equal(info.ok, true, JSON.stringify(info));
  assert.deepEqual({ pin_count: info.pin_count, pins: info.pins }, { pin_count: 0, pins: [] });
  assert.equal(again.pinned(CHANNEL).pins.length, info.pin_count, 'team.chat.pins lists what pin_count counts');
});

function pinInput(id, n, on = true) {
  return { channelId: CHANNEL, actorId: ALICE, deviceId: ALICE_DEVICE, requestId: `req_pin${n}_${on}`, messageId: id, on };
}

test('a pin whose channel.json write failed is repaired at load: the list holds it (fault: the list trusts channel.json over the segment)', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  await fx.createChannel(store);
  const target = await fx.postOk(store);
  fx.control.failWrite = (relative) => relative.endsWith('channel.json');
  assert.equal((await store.pin(pinInput(target.message_id, 1))).ok, false, 'the segment landed, channel.json did not');
  fx.control.failWrite = null;
  const reopened = fx.openStore();
  assert.equal(reopened.getMessage(CHANNEL, target.message_id).message.pinned.by, ALICE);
  assert.deepEqual(reopened.channelInfo(CHANNEL).pins, [target.message_id]);
  // The repair is committed with the next change, and the pin can be taken off again.
  assert.equal((await reopened.pin(pinInput(target.message_id, 2, false))).ok, true);
  assert.deepEqual(reopened.channelInfo(CHANNEL).pins, []);
  assert.equal(fx.openStore().getMessage(CHANNEL, target.message_id).message.pinned, null);
});

test('an unpin whose channel.json write failed frees its slot at load (fault: fifty torn unpins wedge team_chat_pin_limit)', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  await fx.createChannel(store);
  const ids = [];
  for (let n = 0; n < 51; n += 1) ids.push((await fx.postOk(store, { text: `p${n}` })).message_id);
  for (let n = 0; n < 50; n += 1) assert.equal((await store.pin(pinInput(ids[n], n))).ok, true, `pin ${n}`);
  fx.control.failWrite = (relative) => relative.endsWith('channel.json');
  assert.equal((await store.pin(pinInput(ids[0], 0, false))).ok, false);
  fx.control.failWrite = null;
  const reopened = fx.openStore();
  assert.equal(reopened.getMessage(CHANNEL, ids[0]).message.pinned, null);
  const pins = reopened.channelInfo(CHANNEL).pins;
  assert.equal(pins.length, 49);
  assert.equal(pins.includes(ids[0]), false);
  assert.equal((await reopened.pin(pinInput(ids[50], 50))).ok, true, 'a new pin at 49 others succeeds');
  assert.equal(reopened.channelInfo(CHANNEL).pins.length, 50);
});

// ------------------------------------------------------------ the disk gate and the limiter

test('under disk pressure un-react and unpin succeed and react and pin are refused (fault: removing is gated like adding)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const target = await f.post(f.seats.alice, 'hello');
  assert.equal((await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id))).ok, true);
  assert.equal((await f.send(f.seats.alice, 'team.chat.pin', pinParams(target.message_id))).ok, true);
  f.setAdmit(false);
  assert.equal(f.reasonOf(await f.send(f.seats.bob, 'team.chat.react', reactParams(target.message_id))), 'disk_pressure');
  assert.equal(f.reasonOf(await f.send(f.seats.bob, 'team.chat.pin', pinParams(target.message_id, false))), 'ok', 'a no-op is not gated');
  assert.equal(f.reasonOf(await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id, false))), 'ok');
  assert.equal(f.reasonOf(await f.send(f.seats.alice, 'team.chat.pin', pinParams(target.message_id, false))), 'ok');
  const unpinned = f.chat.store.getMessage(CHANNEL, target.message_id).message;
  assert.deepEqual([unpinned.reactions, unpinned.pinned], [{}, null]);
  assert.equal(f.reasonOf(await f.send(f.seats.alice, 'team.chat.pin', pinParams(target.message_id))), 'disk_pressure');
  assert.equal(f.reasonOf(await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id))), 'disk_pressure');
});

test('react and pin have their own 60 a minute table: mark_read and edit still work after 60 reactions (fault: one shared table)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const target = await f.post(f.seats.alice, 'hello');
  for (let n = 0; n < 60; n += 1) {
    assert.equal((await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id, n % 2 === 0))).ok, true, `call ${n}`);
  }
  assert.equal(f.reasonOf(await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id))), 'team_chat_rate_limit');
  assert.equal(f.reasonOf(await f.send(f.seats.alice, 'team.chat.pin', pinParams(target.message_id))), 'team_chat_rate_limit',
    'react and pin share their table');
  assert.equal(f.reasonOf(await f.send(f.seats.alice, 'team.chat.mark_read', { channel_id: CHANNEL, seq: 1 })), 'ok');
  const rev = f.chat.store.getMessage(CHANNEL, target.message_id).message.rev;
  assert.equal(f.reasonOf(await f.send(f.seats.alice, 'team.chat.edit', { channel_id: CHANNEL, message_id: target.message_id,
    text: 'edited', expected_rev: rev })), 'ok');
  assert.equal(f.reasonOf(await f.send(f.seats.bob, 'team.chat.react', reactParams(target.message_id))), 'ok', 'per member');
});

// ------------------------------------------------------------ the mark event is lean

test('a reaction on a heavily edited message sends a small frame with its reactions intact (fault: every toggle carries the edit history)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const version = (n) => `${String(n).padStart(2, '0')}${'x'.repeat(14_998)}`;
  const target = await f.post(f.seats.alice, version(0));
  let rev = target.rev;
  for (let n = 1; n <= 10; n += 1) {
    const edited = await f.send(f.seats.alice, 'team.chat.edit', { channel_id: CHANNEL, message_id: target.message_id,
      text: version(n), expected_rev: rev });
    assert.equal(edited.ok, true, `edit ${n}`);
    rev = edited.rev;
  }
  const editEvent = messageEvents(f).at(-1);
  assert.equal(editEvent.payload.message.edits.length, 10, 'an edit still carries its earlier versions');
  assert.ok(Buffer.byteLength(JSON.stringify(editEvent.payload)) > 80 * 1024);
  const events = messageEvents(f).length;
  assert.equal((await f.send(f.seats.bob, 'team.chat.react', reactParams(target.message_id))).ok, true);
  assert.equal((await f.send(f.seats.bob, 'team.chat.pin', pinParams(target.message_id))).ok, true);
  const marks = messageEvents(f).slice(events);
  assert.equal(marks.length, 2);
  for (const mark of marks) {
    assert.ok(Buffer.byteLength(JSON.stringify(mark.payload)) < 80 * 1024, 'the frame is small');
    assert.deepEqual(mark.payload.message.edits, []);
    assert.equal(mark.payload.message.text, version(10));
    assert.ok(mark.payload.message.edited_at);
  }
  assert.deepEqual(marks[0].payload.message.reactions, { [THUMB]: [f.seats.bob.member_id] });
  assert.equal(marks[1].payload.message.pinned.by, f.seats.bob.member_id);
  assert.equal(f.chat.store.getMessage(CHANNEL, target.message_id).message.edits.length, 10, 'the stored record keeps them');
});

// ------------------------------------------------------------ the read event

test('two concurrent marks to the same position publish one team_chat_read (fault: the change decided outside the write chain)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const posted = await f.post(f.seats.alice, 'one');
  const mark = () => f.send(f.seats.bob, 'team.chat.mark_read', { channel_id: CHANNEL, seq: posted.seq });
  const answers = await Promise.all([mark(), mark(), mark()]);
  assert.deepEqual(answers.map((answer) => answer.last_read_seq), [posted.seq, posted.seq, posted.seq]);
  assert.equal(readEvents(f).length, 1);
});

test('mark_read with no publisher is refused and the position stays (fault: the position commits without an announcement)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const posted = await f.post(f.seats.alice, 'one');
  const cmd = f.command(f.seats.bob.auth, 'team.chat.mark_read', { channel_id: CHANNEL, seq: posted.seq });
  const refused = await f.chat.commands.dispatch(cmd, { deviceId: f.seats.bob.device_id }, { canAdmit: () => true });
  assert.equal(refused.error.reason, 'team_unavailable');
  assert.equal(f.chat.store.readState(CHANNEL, f.seats.bob.member_id).last_read_seq, 0);
  assert.equal(readEvents(f).length, 0);
});
