'use strict';

// Slice 2a-3a review: the page byte bound in services/host/team-chat-pages.js,
// driven with constructed pages so every branch is reached at a small budget.
// Slice 2a-3b: the overview's thread-reply unread rule, through the real commands.

const assert = require('node:assert/strict');
const test = require('node:test');

const { boundPage, fitOne } = require('../../services/host/team-chat-pages');
const { createTeamChatCommandsFixture } = require('./helpers/team-chat-commands-fixture');

const size = (value) => Buffer.byteLength(JSON.stringify(value));
let next = 0;

// A record shaped like the store's, with `chars` of text and `edits` earlier versions.
function message({ seq = ++next, rev = seq, chars = 100, edits = 0, root = null } = {}) {
  return {
    id: `msg_${String(seq).padStart(26, '0')}`, channel_id: 'chan_team', seq, rev,
    author: { kind: 'member', member_id: 'member_a' }, created_at: '2026-11-10T00:00:00.000Z', edited_at: null,
    text: 'x'.repeat(chars), thread_root_id: root, reply_count: 0, last_reply_at: null, mentions: [], refs: [],
    attachments: [],
    edits: Array.from({ length: edits }, (_, i) => ({ text: `${i}`.repeat(chars), edited_at: '2026-11-10T00:00:00.000Z' })),
    reactions: {}, pinned: null, deleted: null, served_by: null,
  };
}

test('fitOne drops earlier versions oldest first until the record fits', () => {
  const big = message({ chars: 2000, edits: 10 });
  const fitted = fitOne(big, 9000);
  assert.ok(size(fitted) <= 9000);
  assert.ok(fitted.edits.length > 0 && fitted.edits.length < 10);
  assert.deepEqual(fitted.edits, big.edits.slice(10 - fitted.edits.length), 'the newest versions stay');
  assert.equal(fitted.text, big.text);
  assert.equal(fitOne(big, size(big)), big, 'a record that fits is returned as is');
});

test('history keeps the newest end; when nothing fits it keeps the newest message, trimmed', () => {
  const page = { ok: true, messages: [message({ chars: 3000 }), message({ chars: 3000 }), message({ chars: 3000 })],
    has_more: false, floor_seq: 1, channel_rev: 3 };
  const bounded = boundPage('history', page, 7000);
  assert.ok(size(bounded) <= 7000);
  assert.deepEqual(bounded.messages.map((m) => m.seq), page.messages.slice(1).map((m) => m.seq));
  assert.equal(bounded.has_more, true);

  const heavy = { ...page, messages: [message({ chars: 1000 }), message({ chars: 1000, edits: 10 })] };
  const one = boundPage('history', heavy, 5000);
  assert.ok(size(one) <= 5000);
  assert.equal(one.messages.length, 1);
  assert.equal(one.messages[0].seq, heavy.messages[1].seq);
  assert.ok(one.messages[0].edits.length < 10);
  assert.equal(one.has_more, true);
  assert.equal(boundPage('history', page, 100_000), page, 'a page that fits is unchanged');
});

test('sync keeps the oldest revisions and never ends inside one revision', () => {
  const a = message({ rev: 5, chars: 1500 });
  const b = message({ rev: 6, chars: 1500 });
  const c = message({ rev: 6, chars: 1500, root: b.id });
  const page = { ok: true, messages: [a, b, c], channel_rev: 6, floor_seq: 1, more: false };
  const bounded = boundPage('sync', page, size({ ...page, messages: [a, b] }) + 10);
  assert.deepEqual(bounded.messages.map((m) => m.id), [a.id], 'b and c share a revision');
  assert.equal(bounded.more, true);

  // Nothing fits: the whole first revision group is kept, each record trimmed.
  const r1 = message({ rev: 9, chars: 800, edits: 10 });
  const r2 = message({ rev: 9, chars: 800, edits: 10, root: r1.id });
  const grouped = { ok: true, messages: [r1, r2, message({ rev: 10 })], channel_rev: 10, floor_seq: 1, more: false };
  const kept = boundPage('sync', grouped, 6000);
  assert.ok(size(kept) <= 6000, `${size(kept)} bytes`);
  assert.deepEqual(kept.messages.map((m) => m.id), [r1.id, r2.id]);
  assert.equal(kept.more, true);
});

test('thread: a heavy root takes at most half the budget and at least one reply comes back', () => {
  const root = message({ chars: 1000, edits: 10 });
  const replies = [message({ chars: 1500, root: root.id }), message({ chars: 1500, root: root.id })];
  const page = { ok: true, root, replies, has_more: false };
  const budget = 6000;
  const bounded = boundPage('thread', page, budget);
  assert.ok(size(bounded) <= budget, `${size(bounded)} bytes`);
  assert.ok(size(bounded.root) <= budget / 2);
  assert.ok(bounded.replies.length >= 1);
  assert.equal(bounded.replies[0].id, replies[0].id);
  assert.equal(bounded.has_more, true);

  // Light root, replies trimmed from the newest end.
  const light = { ok: true, root: message({ chars: 100 }), replies: [message({ chars: 2000 }), message({ chars: 2000 }),
    message({ chars: 2000 })], has_more: false };
  const trimmed = boundPage('thread', light, 6000);
  assert.ok(size(trimmed) <= 6000);
  assert.deepEqual(trimmed.replies.map((m) => m.id), light.replies.slice(0, 2).map((m) => m.id));
  assert.equal(trimmed.has_more, true);

  // A root alone keeps the whole budget.
  const alone = boundPage('thread', { ok: true, root, replies: [], has_more: false }, 9000);
  assert.ok(size(alone) <= 9000);
  assert.ok(size(alone.root) > 4500);
});

test('a failure answer passes through unchanged', () => {
  const failure = { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_chat_not_found', retryable: false } };
  assert.equal(boundPage('history', failure, 1000), failure);
});

// ------------------------------------------------------------ thread-reply unread (slice 2a-3b)

test('a reply counts as unread only in a thread the member follows, for each of the four reasons', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { owner, alice, bob, rae } = f.seats;
  const view = async (seat) => (await f.send(seat, 'team.chat.overview')).channels[0];
  const counts = async (seat) => { const channel = await view(seat); return [channel.unread, channel.mention]; };
  const catchUp = async (seat) => {
    const answer = await f.send(seat, 'team.chat.mark_read', { channel_id: 'chan_team', seq: (await view(seat)).last_seq });
    assert.equal(answer.ok, true);
  };
  const reply = (seat, root, text) => f.post(seat, text, { thread_root_id: root.message_id });

  const aliceRoot = await f.post(alice, 'alice wrote this root');            // alice: wrote the root
  const ownerRoot = await f.post(owner, 'owner root');
  await reply(alice, ownerRoot, 'alice replied');                             // alice: replied
  const mentionRoot = await f.post(owner, 'another owner root');
  await reply(owner, mentionRoot, `looping in <@${rae.member_id}>`);          // rae: mentioned
  assert.equal((await f.send(rae, 'team.chat.follow',                         // rae: followed explicitly
    { channel_id: 'chan_team', root_id: ownerRoot.message_id, on: true })).ok, true);
  const quietRoot = await f.post(bob, 'a thread nobody else follows');
  await catchUp(alice);
  await catchUp(rae);
  assert.deepEqual(await counts(alice), [0, false]);

  await reply(bob, aliceRoot, 'r1');
  await reply(bob, ownerRoot, 'r2');
  await reply(bob, mentionRoot, 'r3');
  await reply(bob, quietRoot, 'r4');
  assert.deepEqual(await counts(alice), [2, false], 'r1 (her root) and r2 (she replied)');
  assert.deepEqual(await counts(rae), [2, false], 'r2 (followed) and r3 (mentioned)');

  // A reply that mentions the member starts the follow (the thread's earlier unread r4 counts too) and sets the flag.
  await reply(bob, quietRoot, `<@${rae.member_id}> have a look`);
  assert.deepEqual(await counts(rae), [4, true]);

  // An explicit unfollow wins over every implicit reason.
  for (const root of [ownerRoot, aliceRoot]) {
    assert.equal((await f.send(alice, 'team.chat.follow', { channel_id: 'chan_team', root_id: root.message_id,
      on: false })).ok, true);
  }
  assert.deepEqual(await counts(alice), [0, false]);
  await reply(bob, aliceRoot, 'r5');
  assert.deepEqual(await counts(alice), [0, false], 'nothing from a thread she unfollowed');
});

test('a reply mentioning @channel flags only members who follow its thread', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob, rae } = f.seats;
  const root = await f.post(alice, 'root');
  for (const seat of [alice, rae]) {
    const last = (await f.send(seat, 'team.chat.overview')).channels[0].last_seq;
    await f.send(seat, 'team.chat.mark_read', { channel_id: 'chan_team', seq: last });
  }
  await f.post(bob, 'heads up <@channel>', { thread_root_id: root.message_id });
  const forAlice = (await f.send(alice, 'team.chat.overview')).channels[0];
  const forRae = (await f.send(rae, 'team.chat.overview')).channels[0];
  assert.deepEqual([forAlice.unread, forAlice.mention], [1, true]);
  assert.deepEqual([forRae.unread, forRae.mention], [0, false], '@channel alone does not make Rae follow');
});

test('the unread walk reads light records: no text and no edit history', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  const posted = await f.post(alice, `hi <@${bob.member_id}>`);
  assert.equal((await f.send(alice, 'team.chat.edit', { channel_id: 'chan_team', message_id: posted.message_id,
    text: `edited <@${bob.member_id}>`, expected_rev: posted.rev })).ok, true);
  const page = f.chat.store.recentMessages('chan_team', { afterSeq: 0, limit: 10, follows: () => false });
  assert.equal(page.ok, true);
  assert.deepEqual(page.messages, [{ seq: posted.seq, author: { kind: 'member', member_id: alice.member_id },
    mentions: [bob.member_id], deleted: false }]);
});
