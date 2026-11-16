'use strict';

// Slice 2b-1: reactions, pins, edit history and the read event on the host.
// The command tests run the real router, the real authorizer and operation
// registry, the real team commands and a real chat store; the store tests use
// the 2a-1 chat fixture. Each test names the fault that makes it fail.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createEventScope } = require('../../server/team/event-scope');
const { streamIdentity } = require('../../server/team/authorize');
const { REACTION_EMOJI, isReactionEmoji } = require('../../services/host/team-chat-emoji');
const { boundEdits } = require('../../services/host/team-chat-pages');
const { createTeamChatCommandsFixture } = require('./helpers/team-chat-commands-fixture');
const { createChatFixture, ALICE, BOB, ALICE_DEVICE } = require('./helpers/team-chat-fixture');
const { createTeamHttpFixture, waitUntil } = require('./helpers/team-http-fixture');

const THUMB = REACTION_EMOJI[0];
const CHANNEL = 'chan_team';

const reactParams = (id, emoji = THUMB, on = true, channel = CHANNEL) => ({ channel_id: channel, message_id: id, emoji, on });
const pinParams = (id, on = true, channel = CHANNEL) => ({ channel_id: channel, message_id: id, on });
const record = (f, id, channel = CHANNEL) => f.chat.store.getMessage(channel, id).message;
const messageEvents = (f) => f.published.filter((entry) => entry.type === 'team_chat_message');
const readEvents = (f) => f.published.filter((entry) => entry.type === 'team_chat_read');
const freeze = (f, id) => JSON.stringify([record(f, id), f.chat.store.channelInfo(CHANNEL), f.published.length]);

// ------------------------------------------------------------ the emoji list

test('the allowlist is about forty frozen, unique, single-picture strings with no skin tone or joiner', () => {
  assert.equal(Object.isFrozen(REACTION_EMOJI), true);
  assert.equal(new Set(REACTION_EMOJI).size, REACTION_EMOJI.length);
  assert.ok(REACTION_EMOJI.length >= 36 && REACTION_EMOJI.length <= 44, `${REACTION_EMOJI.length} entries`);
  for (const emoji of REACTION_EMOJI) {
    assert.equal(emoji.includes('‍'), false, `${emoji} has a joiner`);
    assert.equal([...emoji].some((char) => char.codePointAt(0) >= 0x1F3FB && char.codePointAt(0) <= 0x1F3FF), false,
      `${emoji} has a skin tone`);
    assert.ok([...emoji].length <= 2, `${emoji} is one picture, at most picture plus selector`);
    assert.equal(isReactionEmoji(emoji), true);
  }
  for (const bad of ['x', '', '\u{1F44D}\u{1F3FD}', '\u{1F468}‍\u{1F469}', '❤', '__proto__', 7, null]) {
    assert.equal(isReactionEmoji(bad), false, String(bad));
  }
});

// ------------------------------------------------------------ authorization

const OPERATIONS = [
  ['team.chat.react', 'OM', (id) => reactParams(id)],
  ['team.chat.pin', 'OM', (id) => pinParams(id)],
  ['team.chat.edits', 'OMR', (id) => ({ channel_id: CHANNEL, message_id: id })],
];

test('a refused role reaches no store: the record and the event log stay as they were (fault: a refusal reaches the store)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const target = await f.post(f.seats.alice, 'a message');
  const before = freeze(f, target.message_id);
  for (const seat of ['rae', 'pat', 'invite', 'revoked']) {
    for (const [operation, , params] of OPERATIONS.slice(0, 2)) {
      const answer = await f.send(f.seats[seat], operation, params(target.message_id));
      assert.equal(answer.ok, false, `${seat} ${operation}`);
      assert.equal(freeze(f, target.message_id), before, `${seat} ${operation} changed the record or published`);
    }
  }
});

test('no actor and no guard fail closed (fault: a missing device or publisher is served as the owner)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const target = await f.post(f.seats.alice, 'a message');
  const events = f.published.length;
  for (const [operation, , params] of OPERATIONS) {
    const cmd = f.command(f.seats.owner.auth, operation, params(target.message_id));
    for (const context of [{ deviceId: 'device_nobody' }, { deviceId: f.seats.pat.device_id }, {}, undefined]) {
      const refused = await f.chat.commands.dispatch(cmd, context, { canAdmit: () => true, publish: () => {} });
      assert.equal(refused.error.reason, 'role_forbidden', `${operation} ${JSON.stringify(context)}`);
    }
  }
  const owner = { deviceId: f.seats.owner.device_id };
  const react = f.command(f.seats.owner.auth, 'team.chat.react', reactParams(target.message_id));
  const pin = f.command(f.seats.owner.auth, 'team.chat.pin', pinParams(target.message_id));
  assert.equal((await f.chat.commands.dispatch(react, owner, { publish: () => {} })).error.reason, 'disk_pressure');
  assert.equal((await f.chat.commands.dispatch(pin, owner, { publish: () => {} })).error.reason, 'disk_pressure');
  assert.equal((await f.chat.commands.dispatch(react, owner, { canAdmit: () => true })).error.reason, 'team_unavailable');
  assert.equal((await f.chat.commands.dispatch(pin, owner, { canAdmit: () => true })).error.reason, 'team_unavailable');
  assert.deepEqual(record(f, target.message_id).reactions, {});
  assert.equal(record(f, target.message_id).pinned, null);
  assert.equal(f.published.length, events);
});

test('a message named in a channel the client cannot read answers exactly like a forged id (fault: the id is checked against the wrong channel)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_alpha' })).ok, true);
  await f.addToProject('project_alpha', 'alice');
  const secret = await f.send(f.seats.alice, 'team.chat.post', { channel_id: 'chan_project_alpha', text: 'secret' });
  const open = await f.post(f.seats.alice, 'open');
  const forged = 'msg_00000000000000000000000000';
  const stripped = (answer) => { const { request_id: _id, ...rest } = answer.error; return rest; };
  const before = JSON.stringify(record(f, secret.message_id, 'chan_project_alpha'));
  const bob = f.seats.bob;
  for (const [operation, params] of [
    ['team.chat.react', (channel, id) => reactParams(id, THUMB, true, channel)],
    ['team.chat.pin', (channel, id) => pinParams(id, true, channel)],
    ['team.chat.edits', (channel, id) => ({ channel_id: channel, message_id: id })],
  ]) {
    const baseline = stripped(await f.send(bob, operation, params(CHANNEL, forged)));
    assert.equal(baseline.reason, 'team_chat_not_found');
    // The project channel, which bob may not read, with the real id and with a forged one.
    assert.deepEqual(stripped(await f.send(bob, operation, params('chan_project_alpha', secret.message_id))), baseline, operation);
    assert.deepEqual(stripped(await f.send(bob, operation, params('chan_project_alpha', forged))), baseline, operation);
    // The secret's id under a channel bob may read: the message is not in that channel.
    assert.deepEqual(stripped(await f.send(bob, operation, params(CHANNEL, secret.message_id))), baseline, operation);
  }
  assert.equal(JSON.stringify(record(f, secret.message_id, 'chan_project_alpha')), before, 'the secret is untouched');
  assert.equal(record(f, open.message_id).pinned, null);
  assert.equal(f.published.filter((entry) => entry.payload?.message?.reactions
    && Object.keys(entry.payload.message.reactions).length > 0).length, 0, 'no reaction was stored or published anywhere');
});

// ------------------------------------------------------------ react and pin

test('react and pin are idempotent by state: a repeat answers ok with the same rev, writes and publishes nothing', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const target = await f.post(f.seats.alice, 'hello');
  const base = messageEvents(f).length;
  const first = await f.send(f.seats.bob, 'team.chat.react', reactParams(target.message_id));
  assert.equal(first.ok, true);
  assert.ok(first.rev > target.rev);
  const afterFirst = JSON.stringify([record(f, target.message_id), f.chat.store.channelInfo(CHANNEL)]);
  assert.equal(messageEvents(f).length, base + 1, 'a real change publishes exactly one event');
  const again = await f.send(f.seats.bob, 'team.chat.react', reactParams(target.message_id));
  assert.deepEqual(again, first, 'fault: the repeat bumped the rev or answered another number');
  const off = await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id, THUMB, false));
  assert.equal(off.ok, true);
  assert.equal(off.rev, first.rev, 'removing a reaction that is not there answers the current rev');
  const other = await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id, REACTION_EMOJI[1], false));
  assert.equal(other.rev, first.rev);
  assert.equal(JSON.stringify([record(f, target.message_id), f.chat.store.channelInfo(CHANNEL)]), afterFirst);
  assert.equal(messageEvents(f).length, base + 1, 'fault: a no-op published an event');

  const pinned = await f.send(f.seats.owner, 'team.chat.pin', pinParams(target.message_id));
  assert.ok(pinned.rev > first.rev);
  assert.equal(messageEvents(f).length, base + 2);
  const pinState = JSON.stringify([record(f, target.message_id), f.chat.store.channelInfo(CHANNEL)]);
  assert.deepEqual(await f.send(f.seats.alice, 'team.chat.pin', pinParams(target.message_id)), pinned);
  const unpin = await f.send(f.seats.owner, 'team.chat.pin', pinParams(target.message_id, false));
  assert.ok(unpin.rev > pinned.rev);
  assert.equal(messageEvents(f).length, base + 3);
  assert.deepEqual(await f.send(f.seats.owner, 'team.chat.pin', pinParams(target.message_id, false)), unpin);
  assert.notEqual(pinState, JSON.stringify([record(f, target.message_id), f.chat.store.channelInfo(CHANNEL)]));
  assert.equal(messageEvents(f).length, base + 3, 'fault: a repeat unpin published');
  assert.deepEqual(f.chat.store.channelInfo(CHANNEL).pins, []);
});

test('a real change publishes one team_chat_message with the full record to exactly the channel audience (fault: wrong or missing audience)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_alpha' })).ok, true);
  await f.addToProject('project_alpha', 'alice');
  const channel = 'chan_project_alpha';
  const posted = await f.send(f.seats.alice, 'team.chat.post', { channel_id: channel, text: 'in the project' });
  f.published.length = 0;
  const reacted = await f.send(f.seats.alice, 'team.chat.react', reactParams(posted.message_id, THUMB, true, channel));
  const pinned = await f.send(f.seats.owner, 'team.chat.pin', pinParams(posted.message_id, true, channel));
  const events = f.chatEvents();
  assert.deepEqual(events.map((entry) => entry.type), ['team_chat_message', 'team_chat_message']);
  const expected = [f.seats.alice.member_id, f.seats.owner.member_id].sort();
  for (const entry of events) {
    assert.ok(entry.options.audience instanceof Set);
    assert.deepEqual([...entry.options.audience].sort(), expected, 'the project members, bob outside');
    assert.equal(entry.options.bucket, `teamchat:${channel}`);
    assert.equal(entry.payload.message.id, posted.message_id);
  }
  assert.deepEqual(events[0].payload.message.reactions, { [THUMB]: [f.seats.alice.member_id] });
  assert.equal(events[0].payload.channel_rev, reacted.rev);
  assert.equal(events[0].payload.message.rev, reacted.rev);
  assert.equal(events[1].payload.message.pinned.by, f.seats.owner.member_id);
  assert.equal(events[1].payload.channel_rev, pinned.rev);
});

test('an emoji outside the allowlist is refused before any write (fault: the check is missing or runs after the write)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const target = await f.post(f.seats.alice, 'hello');
  const before = freeze(f, target.message_id);
  for (const emoji of ['x', 'ab', '\u{1F44D}\u{1F3FD}', '\u{1F468}‍\u{1F469}‍\u{1F467}', '❤', '__proto__',
    '\u{1F600}', ' ', '\u0007']) {
    const answer = await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id, emoji));
    assert.equal(answer.ok, false, JSON.stringify(emoji));
    assert.equal(answer.error.code, 'CMP-HOST-0001', `${JSON.stringify(emoji)} ${answer.error.reason}`);
    assert.equal(answer.error.reason, 'team_chat_emoji_invalid', JSON.stringify(emoji));
  }
  assert.equal(freeze(f, target.message_id), before);
  // Removing an unlisted emoji is refused too: the list gates the name, not the direction.
  assert.equal(f.reasonOf(await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id, 'x', false))),
    'team_chat_emoji_invalid');
});

test('21 distinct emoji are refused with the record byte-identical; 20 pass (fault: limit off by one or checked after the write)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const target = await f.post(f.seats.alice, 'hello');
  for (const emoji of REACTION_EMOJI.slice(0, 20)) {
    assert.equal((await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id, emoji))).ok, true, emoji);
  }
  assert.equal(Object.keys(record(f, target.message_id).reactions).length, 20);
  const before = freeze(f, target.message_id);
  const refused = await f.send(f.seats.bob, 'team.chat.react', reactParams(target.message_id, REACTION_EMOJI[20]));
  assert.equal(refused.error.reason, 'team_chat_reaction_limit');
  assert.equal(refused.error.code, 'CMP-HOST-0007');
  assert.equal(freeze(f, target.message_id), before);
  // A new reactor on an emoji already there is not a 21st emoji.
  assert.equal((await f.send(f.seats.bob, 'team.chat.react', reactParams(target.message_id, REACTION_EMOJI[3]))).ok, true);
  // Removing one makes room again.
  assert.equal((await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id, REACTION_EMOJI[0], false))).ok, true);
  assert.equal((await f.send(f.seats.bob, 'team.chat.react', reactParams(target.message_id, REACTION_EMOJI[20]))).ok, true);
  assert.equal(record(f, target.message_id).reactions[REACTION_EMOJI[0]], undefined, 'an emptied emoji leaves the map');
});

test('the 65th reactor and the 51st pin are refused with the stored files byte-identical; 64 and 50 pass', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  await fx.createChannel(store);
  const target = await fx.postOk(store);
  const react = (n, extra = {}) => store.react({ channelId: CHANNEL, actorId: `member_r${n}`, deviceId: `device_r${n}`,
    requestId: `req_r${n}`, messageId: target.message_id, emoji: THUMB, on: true, ...extra });
  for (let n = 1; n <= 64; n += 1) assert.equal((await react(n)).ok, true, `reactor ${n}`);
  const before = fx.snapshotTree();
  const refused = await react(65);
  assert.equal(refused.error.reason, 'team_chat_reaction_limit');
  assert.deepEqual(fx.snapshotTree(), before);
  assert.equal((await react(1)).ok, true, 'an existing reactor repeating is a no-op, not a 65th');
  assert.equal((await react(1, { on: false, requestId: 'req_off1' })).ok, true);
  assert.equal((await react(65, { requestId: 'req_r65b' })).ok, true, 'a freed slot is usable');

  const ids = [];
  for (let n = 0; n < 51; n += 1) ids.push((await fx.postOk(store, { text: `p${n}` })).message_id);
  const pin = (id, n, on = true) => store.pin({ channelId: CHANNEL, actorId: BOB, deviceId: 'device_bob1', requestId: `req_p${n}_${on}`,
    messageId: id, on });
  for (let n = 0; n < 50; n += 1) assert.equal((await pin(ids[n], n)).ok, true, `pin ${n}`);
  const held = store.getMessage(CHANNEL, ids[1]).message.rev;
  const repeat = await pin(ids[1], 'again');
  assert.deepEqual([repeat.ok, repeat.rev], [true, held], 'a message already pinned is not a 51st pin');
  const pinsBefore = fx.snapshotTree();
  const over = await pin(ids[50], 50);
  assert.equal(over.error.reason, 'team_chat_pin_limit');
  assert.deepEqual(fx.snapshotTree(), pinsBefore);
  assert.equal((await pin(ids[0], 0, false)).ok, true);
  assert.equal((await pin(ids[50], 50)).ok, true, 'unpinning makes room');
});

test('archived, deleted and missing targets are refused before any write; delete drops the pin and the reactions', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const target = await f.post(f.seats.alice, 'hello');
  await f.send(f.seats.bob, 'team.chat.react', reactParams(target.message_id));
  await f.send(f.seats.owner, 'team.chat.pin', pinParams(target.message_id));
  assert.equal((await f.send(f.seats.alice, 'team.chat.delete', { channel_id: CHANNEL, message_id: target.message_id })).ok, true);
  const tomb = record(f, target.message_id);
  assert.deepEqual([tomb.reactions, tomb.pinned], [{}, null]);
  assert.deepEqual(f.chat.store.channelInfo(CHANNEL).pins, []);
  const before = freeze(f, target.message_id);
  for (const [operation, params] of [['team.chat.react', reactParams(target.message_id)],
    ['team.chat.react', reactParams(target.message_id, THUMB, false)], ['team.chat.pin', pinParams(target.message_id)],
    ['team.chat.pin', pinParams(target.message_id, false)]]) {
    assert.equal(f.reasonOf(await f.send(f.seats.alice, operation, params)), 'team_chat_not_found', `fault: ${operation} on a tombstone`);
  }
  assert.equal(freeze(f, target.message_id), before);
  const live = await f.post(f.seats.alice, 'second');
  assert.equal((await f.chat.store.archiveChannel({ channelId: CHANNEL })).ok, true);
  const archivedBefore = freeze(f, live.message_id);
  for (const [operation, params] of [['team.chat.react', reactParams(live.message_id)],
    ['team.chat.react', reactParams(live.message_id, THUMB, false)], ['team.chat.pin', pinParams(live.message_id)]]) {
    assert.equal(f.reasonOf(await f.send(f.seats.alice, operation, params)), 'team_chat_archived', operation);
  }
  assert.equal(freeze(f, live.message_id), archivedBefore);
  assert.equal(f.reasonOf(await f.send(f.seats.alice, 'team.chat.edits', { channel_id: CHANNEL, message_id: live.message_id })), 'ok',
    'an archived channel is still readable');
});

test('a react or pin racing an edit or delete: one wins in call order and nothing is lost (fault: a write built from a stale read)', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  await fx.createChannel(store);
  const base = (n) => ({ channelId: CHANNEL, actorId: ALICE, deviceId: ALICE_DEVICE, requestId: `req_race${n}` });
  const validate = (id) => {
    const found = store.getMessage(CHANNEL, id).message;
    const info = store.channelInfo(CHANNEL);
    assert.equal(info.pins.includes(id), found.pinned !== null, 'the channel pin list and the record agree');
    assert.ok(found.rev <= info.rev);
    return found;
  };

  const a = await fx.postOk(store, { text: 'v0' });
  const [reactFirst, editStale] = await Promise.all([
    store.react({ ...base(1), messageId: a.message_id, emoji: THUMB, on: true }),
    store.edit({ ...base(2), messageId: a.message_id, text: 'v1', expectedRev: a.rev }),
  ]);
  assert.equal(reactFirst.ok, true);
  assert.equal(editStale.error.reason, 'team_chat_stale', 'the react bumped the rev, so the stale edit loses');
  assert.deepEqual([validate(a.message_id).text, validate(a.message_id).reactions[THUMB]], ['v0', [ALICE]]);

  const [editFirst, reactAfter, pinAfter] = await Promise.all([
    store.edit({ ...base(3), messageId: a.message_id, text: 'v2', expectedRev: reactFirst.rev }),
    store.react({ ...base(4), actorId: BOB, deviceId: 'device_bob1', messageId: a.message_id, emoji: THUMB, on: true }),
    store.pin({ ...base(5), messageId: a.message_id, on: true }),
  ]);
  assert.deepEqual([editFirst.ok, reactAfter.ok, pinAfter.ok], [true, true, true]);
  const merged = validate(a.message_id);
  assert.equal(merged.text, 'v2');
  assert.deepEqual(merged.reactions[THUMB], [ALICE, BOB], 'the edit kept the reaction, the second reactor was added');
  assert.equal(merged.pinned.by, ALICE);
  assert.ok(editFirst.rev < reactAfter.rev && reactAfter.rev < pinAfter.rev, 'revisions follow call order');

  const [pinThenDelete, deleted] = await Promise.all([
    store.pin({ ...base(6), messageId: a.message_id, on: false }),
    store.delete({ ...base(7), messageId: a.message_id }),
  ]);
  assert.deepEqual([pinThenDelete.ok, deleted.ok], [true, true]);
  const tomb = validate(a.message_id);
  assert.deepEqual([tomb.text, tomb.reactions, tomb.pinned, tomb.edits], ['', {}, null, []]);

  const b = await fx.postOk(store, { text: 'b' });
  const [deleteFirst, reactLoses, pinLoses] = await Promise.all([
    store.delete({ ...base(8), messageId: b.message_id }),
    store.react({ ...base(9), messageId: b.message_id, emoji: THUMB, on: true }),
    store.pin({ ...base(10), messageId: b.message_id, on: true }),
  ]);
  assert.equal(deleteFirst.ok, true);
  assert.equal(reactLoses.error.reason, 'team_chat_not_found');
  assert.equal(pinLoses.error.reason, 'team_chat_not_found');
  assert.deepEqual(validate(b.message_id).reactions, {});
  const tail = await fx.postOk(store, { text: 'tail' });
  const pinTail = await store.pin({ ...base(11), messageId: tail.message_id, on: true });
  const deleteTail = await store.delete({ ...base(12), messageId: tail.message_id });
  assert.deepEqual([pinTail.ok, deleteTail.ok], [true, true]);
  assert.deepEqual(store.channelInfo(CHANNEL).pins, [], 'delete after pin leaves no pin behind');
});

test('a repeat of a committed react or pin answers ok with the same rev, writes nothing and applies once, across a restart and a failed answer', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  await fx.createChannel(store);
  const target = await fx.postOk(store);
  const react = { channelId: CHANNEL, actorId: ALICE, deviceId: ALICE_DEVICE, requestId: 'req_same', messageId: target.message_id,
    emoji: THUMB, on: true };
  const first = await store.react(react);
  assert.equal(first.ok, true);
  const ledger = JSON.stringify(fx.readDoc('chan_team/channel.json').requests);
  const writes = fx.writes.length;
  const sameStore = await store.react(react);
  assert.deepEqual([sameStore.ok, sameStore.rev, sameStore.unchanged], [true, first.rev, true]);
  // The process restarts after the write but before the answer reached the client.
  const restarted = fx.openStore();
  const again = await restarted.react(react);
  assert.deepEqual([again.ok, again.rev, again.unchanged], [true, first.rev, true]);
  assert.equal(fx.writes.length, writes, 'a repeat writes nothing');
  assert.deepEqual(restarted.getMessage(CHANNEL, target.message_id).message.reactions, { [THUMB]: [ALICE] });
  assert.equal(ledger, JSON.stringify(fx.readDoc('chan_team/channel.json').requests), 'fault: a mark took a ledger entry');

  // channel.json lands, then the call fails (a failed directory sync, which latches this store until a restart):
  // the retry on the restarted host finds the pin set and answers ok.
  const pin = { channelId: CHANNEL, actorId: ALICE, deviceId: ALICE_DEVICE, requestId: 'req_pin', messageId: target.message_id, on: true };
  fx.control.failAfterWrite = (relative) => relative === 'chan_team/channel.json' || relative === 'channel.json';
  const lost = await restarted.pin(pin);
  assert.equal(lost.ok, false);
  fx.control.failAfterWrite = null;
  const reopened = fx.openStore();
  const retry = await reopened.pin(pin);
  assert.deepEqual([retry.ok, retry.unchanged], [true, true], 'fault: the committed pin was applied a second time');
  assert.deepEqual(reopened.channelInfo(CHANNEL).pins, [target.message_id]);
  assert.equal(reopened.getMessage(CHANNEL, target.message_id).message.rev, retry.rev);
});

test('the same react sent twice through the router answers alike and publishes once (by state)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const target = await f.post(f.seats.alice, 'hello');
  const cmd = f.command(f.seats.bob.auth, 'team.chat.react', reactParams(target.message_id));
  const base = messageEvents(f).length;
  const first = await f.dispatch(f.seats.bob, cmd);
  const second = await f.dispatch(f.seats.bob, cmd);
  assert.deepEqual(second, first);
  assert.equal(messageEvents(f).length, base + 1);
});

// ------------------------------------------------------------ edit history

test('edits: never edited, ten times edited, deleted, forged, and a read-only reader (fault: wrong order, wrong cap, or text on a tombstone)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const fresh = await f.post(f.seats.alice, 'never edited');
  const edits = (seat, id, channel = CHANNEL) => f.send(f.seats[seat], 'team.chat.edits', { channel_id: channel, message_id: id });
  assert.deepEqual(await edits('rae', fresh.message_id), { ok: true, edits: [], rev: fresh.rev });

  let rev = fresh.rev;
  for (let n = 1; n <= 11; n += 1) {
    const edited = await f.send(f.seats.alice, 'team.chat.edit', { channel_id: CHANNEL, message_id: fresh.message_id,
      text: `v${n}`, expected_rev: rev });
    assert.equal(edited.ok, true, `edit ${n}`);
    rev = edited.rev;
  }
  const history = await edits('rae', fresh.message_id);
  assert.equal(history.ok, true);
  assert.equal(history.rev, rev);
  assert.equal(history.edits.length, 10, 'at most ten');
  assert.deepEqual(history.edits.map((entry) => entry.text), Array.from({ length: 10 }, (_v, n) => `v${n + 1}`),
    'earlier versions, oldest first; v0 fell off the end');
  for (const entry of history.edits) {
    assert.deepEqual(Object.keys(entry).sort(), ['edited_at', 'text']);
    assert.match(entry.edited_at, /^\d{4}-\d\d-\d\dT/u);
  }
  assert.equal(record(f, fresh.message_id).text, 'v11');
  assert.deepEqual(await edits('owner', fresh.message_id), history, 'the same for anyone who may read');

  assert.equal((await f.send(f.seats.alice, 'team.chat.delete', { channel_id: CHANNEL, message_id: fresh.message_id })).ok, true);
  const tomb = await edits('rae', fresh.message_id);
  assert.deepEqual([tomb.ok, tomb.edits], [true, []]);
  assert.equal(tomb.rev, record(f, fresh.message_id).rev);
  assert.equal(JSON.stringify(tomb).includes('v5'), false);

  assert.equal(f.reasonOf(await edits('rae', 'msg_00000000000000000000000000')), 'team_chat_not_found');
  assert.equal(f.reasonOf(await edits('pat', fresh.message_id)), 'member_pending');
  assert.equal(f.reasonOf(await edits('revoked', fresh.message_id)), 'member_revoked');
  assert.equal(f.published.filter((entry) => entry.type === 'team_chat_read').length, 0);
});

test('an edit history over the page bound drops the oldest versions, keeps the newest and says so (fault: an unbounded answer)', () => {
  const version = (n) => ({ text: String(n).repeat(100), edited_at: '2026-11-11T09:00:00.000Z' });
  const answer = { ok: true, edits: [1, 2, 3, 4, 5].map(version), rev: 9 };
  assert.deepEqual(boundEdits(answer, 1_000_000), answer);
  const size = (value) => Buffer.byteLength(JSON.stringify(value));
  const budget = size({ ...answer, edits: answer.edits.slice(2), trimmed: true });
  const cut = boundEdits(answer, budget);
  assert.deepEqual(cut.edits.map((entry) => entry.text[0]), ['3', '4', '5']);
  assert.equal(cut.trimmed, true);
  assert.ok(size(cut) <= budget);
  assert.equal(boundEdits(answer, 10).edits.length, 1, 'the newest version always stays');
  const failure = { ok: false, error: { reason: 'team_chat_not_found' } };
  assert.equal(boundEdits(failure, 10), failure);
});

// ------------------------------------------------------------ the read event

test('team_chat_read: published once per real change, to the channel audience only, and not for a no-op (fault: published unconditionally)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const channel = CHANNEL;
  const first = await f.send(f.seats.alice, 'team.chat.post', { channel_id: channel, text: 'one' });
  const second = await f.send(f.seats.alice, 'team.chat.post', { channel_id: channel, text: 'two' });
  f.published.length = 0;
  const mark = (seat, seq, extra = {}, channelId = channel) => f.send(f.seats[seat], 'team.chat.mark_read',
    { channel_id: channelId, seq, ...extra });
  assert.deepEqual(await mark('rae', first.seq), { ok: true, last_read_seq: first.seq });
  assert.equal(readEvents(f).length, 1, 'read-only members publish their position too');
  const [event] = readEvents(f);
  assert.deepEqual(event.payload, { channel_id: channel, member_id: f.seats.rae.member_id, seq: first.seq });
  assert.ok(event.options.audience instanceof Set);
  assert.deepEqual([...event.options.audience].sort(),
    ['owner', 'alice', 'bob', 'rae', 'revoked'].map((name) => f.seats[name].member_id).sort(),
    'every active member (the revoked seat is a device, its member is still active); the pending one is outside');
  assert.equal(event.options.bucket, `teamchat:${channel}`);
  assert.notEqual(event.options.ephemeral, true, 'stored for replay');

  assert.equal((await mark('rae', first.seq)).ok, true);
  assert.equal((await mark('rae', 0)).ok, true, 'a lower seq does not move the position down');
  assert.equal(readEvents(f).length, 1, 'no change, no event');
  assert.equal((await mark('rae', 99)).last_read_seq, second.seq, 'clamped to the last seq');
  assert.equal(readEvents(f).length, 2);
  assert.equal(readEvents(f)[1].payload.seq, second.seq);
  assert.equal((await mark('rae', 99)).ok, true);
  assert.equal(readEvents(f).length, 2, 'already at the end');
  assert.equal((await mark('rae', second.seq, { unread: true })).last_read_seq, first.seq);
  assert.equal(readEvents(f).length, 3, 'mark unread from here is a change');
  assert.equal(readEvents(f)[2].payload.seq, first.seq);
  assert.equal(f.published.filter((entry) => entry.type !== 'team_chat_read').length, 0);
  // The position is the member's, and two members' marks do not collide.
  assert.equal((await mark('alice', first.seq)).ok, true);
  assert.equal(readEvents(f).at(-1).payload.member_id, f.seats.alice.member_id);
  // A project channel: the audience is the project's members, so an outsider's event never lists them.
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_alpha' })).ok, true);
  await f.addToProject('project_alpha', 'alice');
  const inside = await f.send(f.seats.alice, 'team.chat.post', { channel_id: 'chan_project_alpha', text: 'inside' });
  const count = readEvents(f).length;
  assert.equal((await mark('alice', inside.seq, {}, 'chan_project_alpha')).ok, true);
  assert.equal(readEvents(f).length, count + 1);
  const scoped = readEvents(f).at(-1);
  assert.deepEqual([...scoped.options.audience].sort(), [f.seats.alice.member_id, f.seats.owner.member_id].sort(),
    'the project members, bob outside');
  assert.equal(f.reasonOf(await mark('bob', 1, {}, 'chan_project_alpha')), 'team_chat_not_found',
    'an outsider is refused and publishes nothing');
  assert.equal(readEvents(f).length, count + 1);
});

test('the closed event table holds team_chat_read: it passes with an audience and is dropped and counted without one', () => {
  const logs = [];
  const scope = createEventScope({ sessionScope: { audience: () => new Set() }, logger: (_l, _e, fields) => logs.push(fields) });
  const payload = { channel_id: 'chan_team', member_id: 'member_a', seq: 3 };
  const audience = new Set(['member_a']);
  assert.deepEqual(scope('team_chat_read', payload, { audience, bucket: 'teamchat:chan_team' }),
    { audience, bucket: 'teamchat:chan_team' });
  const empty = scope('team_chat_read', payload, { audience: new Set(), bucket: 'teamchat:chan_team' });
  assert.ok(empty.audience instanceof Set && empty.audience.size === 0, 'an empty audience is an empty Set, never null');
  assert.equal(scope('team_chat_read', payload, { audience: null, bucket: 'teamchat:chan_team' }), null);
  assert.equal(scope('team_chat_read', payload), null);
  assert.deepEqual(scope.dropCounts(), { 'team_chat_read:audience_missing': 2 });
  assert.deepEqual(logs, [{ event_type: 'team_chat_read', reason: 'audience_missing' }]);
});

// ------------------------------------------------------------ the stream

const framesOf = (frames) => frames.join('').split('\n').filter((line) => line.startsWith('data: '))
  .map((line) => JSON.parse(line.slice(6))).filter((frame) => String(frame.event_type).startsWith('team_chat_'));

test('through the real stream: a member outside the project channel receives no reaction, pin or read event, live or on replay', async (t) => {
  const env = await createTeamHttpFixture(t, { withChat: true });
  const seeded = await env.seed();
  const { command } = require('../helpers/command-router-fixture');
  const connect = async (key) => {
    const client = env.client(key);
    await client.hello();
    const auth = await client.registerClient();
    const stream = await client.openStream(auth);
    const send = async (operation, params = {}) => (await client.request('POST', '/api/v1/commands', {
      body: { ...command(auth, operation, params), boot_epoch: env.context.bootEpoch },
      headers: { 'X-Client-Token': auth.client_token } })).json;
    return { stream, send };
  };
  const owner = await connect(seeded.owner.key);
  const member = await connect(seeded.member.key);
  assert.equal((await env.store.createProject({ actorMemberId: seeded.owner.member_id, projectId: 'project_p1' })).ok, true);
  const channel = 'chan_project_p1';
  assert.equal((await env.chat.store.createChannel({ channelId: channel })).ok, true);
  const posted = await owner.send('team.chat.post', { channel_id: channel, text: 'owner only' });
  assert.equal(posted.ok, true);
  assert.equal((await owner.send('team.chat.react', reactParams(posted.message_id, THUMB, true, channel))).ok, true);
  assert.equal((await owner.send('team.chat.pin', pinParams(posted.message_id, true, channel))).ok, true);
  assert.equal((await owner.send('team.chat.mark_read', { channel_id: channel, seq: posted.seq })).ok, true);
  assert.equal(await waitUntil(() => framesOf(owner.stream.frames).filter((frame) => frame.event_type === 'team_chat_read').length === 1), true);
  const live = framesOf(owner.stream.frames);
  assert.deepEqual(live.map((frame) => frame.event_type), ['team_chat_message', 'team_chat_message', 'team_chat_message', 'team_chat_read']);
  assert.equal(live[3].seq, posted.seq);
  assert.equal(live[3].member_id, seeded.owner.member_id);
  assert.deepEqual(framesOf(member.stream.frames), [], 'nothing live for the outsider');

  const replay = (key) => {
    const response = Object.assign(new EventEmitter(), { frames: [], writableLength: 0, write(frame) { this.frames.push(frame); }, destroy() {} });
    const identity = streamIdentity(env.store.directory, key);
    const unsubscribe = env.core.events.subscribe({ response, deviceId: key.device_id, authorized: () => true,
      bootEpoch: env.context.bootEpoch, cursor: 0, identity });
    unsubscribe?.();
    return framesOf(response.frames);
  };
  assert.deepEqual(replay(seeded.member).map((frame) => frame.event_type), [], 'nothing on replay for the outsider');
  assert.deepEqual(replay(seeded.owner).map((frame) => frame.event_type),
    ['team_chat_message', 'team_chat_message', 'team_chat_message', 'team_chat_read'], 'and replay does carry them for a member of the channel');
});

// ------------------------------------------------------------ logs

test('no message text, emoji or member name reaches a log line (fault: a handler logs its input)', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const target = await f.post(f.seats.alice, 'SECRET-TEXT-MARKER');
  assert.equal((await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id))).ok, true);
  assert.equal((await f.send(f.seats.alice, 'team.chat.react', reactParams(target.message_id, 'NOT-AN-EMOJI-MARKER'))).ok, false);
  assert.equal((await f.send(f.seats.alice, 'team.chat.pin', pinParams(target.message_id))).ok, true);
  await f.send(f.seats.rae, 'team.chat.pin', pinParams(target.message_id));
  await f.send(f.seats.alice, 'team.chat.edits', { channel_id: CHANNEL, message_id: target.message_id });
  await f.send(f.seats.alice, 'team.chat.mark_read', { channel_id: CHANNEL, seq: 1 });
  const logged = JSON.stringify(f.fx.logs);
  assert.ok(f.fx.logs.length > 0, 'something was logged, so the check can fail');
  for (const secret of ['SECRET-TEXT-MARKER', 'NOT-AN-EMOJI-MARKER', THUMB, 'Alice', 'Olive', 'Rae']) {
    assert.equal(logged.includes(secret), false, `${secret} reached a log`);
  }
});
