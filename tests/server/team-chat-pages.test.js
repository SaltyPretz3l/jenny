'use strict';

// Slice 2a-3a review: the page byte bound in services/host/team-chat-pages.js,
// driven with constructed pages so every branch is reached at a small budget.
// Slice 2a-3b: the overview's thread-reply unread rule, through the real commands.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { boundPage, fitOne, overviewChannels } = require('../../services/host/team-chat-pages');
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
  // r2 (followed) and r3 (mentioned), and (E59) the two replies in those threads from before her channel read:
  // a channel read never reads a thread reply, so the mention in one stays.
  assert.deepEqual(await counts(rae), [4, true], '"alice replied" (followed by hand at mark 0), "looping in" (the '
    + 'reply naming her: her follow starts there), r2 and r3; the mention in "looping in" sets the flag');

  // A reply that mentions the member starts the follow and sets the flag; the follow counts from that reply on, so
  // the thread's earlier r4, from before she was named, does not count (E59 fix 21).
  await reply(bob, quietRoot, `<@${rae.member_id}> have a look`);
  assert.deepEqual(await counts(rae), [5, true], 'the four above and "have a look"; not r4');

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
  assert.deepEqual(page.messages, [{ seq: posted.seq, root_id: null, author: { kind: 'member', member_id: alice.member_id },
    mentions: [bob.member_id], deleted: false }]);
});

// ------------------------------------------------------------ the thread answer's `following` (slice 2a-6h)

test('the thread answer says whether the asking member follows it: the unread rule, for that member only', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { owner, alice, bob, rae } = f.seats;
  const ask = async (seat, root, extra = {}) => f.send(seat, 'team.chat.thread',
    { channel_id: 'chan_team', root_id: root.message_id, limit: 10, ...extra });
  const follows = async (seat, root) => (await ask(seat, root)).following;
  const root = await f.post(alice, 'alice wrote this root');
  assert.equal(await follows(alice, root), true, 'the root author follows a thread with no reply yet');
  assert.equal(await follows(bob, root), false);

  const reply = await f.post(bob, 'bob replies', { thread_root_id: root.message_id });
  await f.post(owner, `looping in <@${rae.member_id}>`, { thread_root_id: root.message_id });
  assert.deepEqual([await follows(alice, root), await follows(bob, root), await follows(rae, root),
    await follows(owner, root)], [true, true, true, true], 'author, replier, mentioned, replier');
  const quiet = await f.post(bob, 'a thread alice never joined');
  assert.deepEqual([await follows(alice, quiet), await follows(rae, quiet)], [false, false]);
  const byReply = await ask(alice, { message_id: reply.message_id });
  assert.equal(byReply.root.id, root.message_id);
  assert.equal(byReply.following, true, 'a reply id names its root');

  // An explicit entry beats every implicit reason, in both directions.
  const set = (seat, target, on) => f.send(seat, 'team.chat.follow', { channel_id: 'chan_team', root_id: target.message_id, on });
  assert.equal((await set(alice, root, false)).ok, true);
  assert.equal((await set(rae, quiet, true)).ok, true);
  const [aliceView, bobView] = [await ask(alice, root), await ask(bob, root)];
  assert.deepEqual([aliceView.following, bobView.following], [false, true], 'one member\'s entry never shows in another\'s answer');
  assert.equal(await follows(rae, quiet), true);
  assert.equal(await follows(alice, quiet), false);
  for (const view of [aliceView, bobView]) {
    assert.deepEqual(Object.keys(view).sort(), ['following', 'has_more', 'ok', 'read_seq', 'replies', 'root']);
    assert.equal(JSON.stringify(view).includes('followed'), false);
  }
  assert.equal((await ask(alice, root, { after_seq: reply.seq })).following, false, 'a page with after_seq carries it');
  assert.equal((await ask(bob, root, { after_seq: reply.seq })).following, true);
});

test('a thread page trimmed by the byte budget still says following', async (t) => {
  const f = await createTeamChatCommandsFixture(t, { maxResponseBytes: 7000 });
  const { alice, bob } = f.seats;
  const root = await f.post(alice, 'root');
  for (let n = 0; n < 4; n += 1) await f.post(bob, `${n}`.repeat(1200), { thread_root_id: root.message_id });
  for (const [seat, expected] of [[alice, true], [bob, true]]) {
    const view = await f.send(seat, 'team.chat.thread', { channel_id: 'chan_team', root_id: root.message_id, limit: 10 });
    assert.equal(view.has_more, true, 'the budget cut the replies');
    assert.ok(view.replies.length < 4 && view.replies.length >= 1);
    assert.ok(size(view) <= 7000 - 4096, `${size(view)} bytes`);
    assert.equal(view.following, expected);
  }
  assert.equal((await f.send(f.seats.owner, 'team.chat.thread',
    { channel_id: 'chan_team', root_id: root.message_id, limit: 10 })).following, false);
});

test('boundPage keeps the thread page\'s extra fields through the trim', () => {
  const root = message({ chars: 1000, edits: 10 });
  const page = { ok: true, root, replies: [message({ chars: 1500, root: root.id }), message({ chars: 1500, root: root.id })],
    has_more: false, following: true };
  const bounded = boundPage('thread', page, 6000);
  assert.ok(size(bounded) <= 6000);
  assert.equal(bounded.following, true);
  assert.equal(bounded.has_more, true);
});

test('an unreadable follow list leaves following out; the page still answers', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  const root = await f.post(alice, 'root');
  await f.post(bob, 'a reply', { thread_root_id: root.message_id });
  fs.writeFileSync(path.join(f.fx.dir, 'team-chat', 'chan_team', 'read.json'), '{"schema_version":1,');
  const view = await f.send(alice, 'team.chat.thread', { channel_id: 'chan_team', root_id: root.message_id, limit: 10 });
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(Object.hasOwn(view, 'following'), false, 'never false as a guess');
  assert.deepEqual(view.replies.map((m) => m.text), ['a reply']);
});

test('the follow lookup runs in the same synchronous step as the page: no await opens a window after the router\'s audience check', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice } = f.seats;
  const root = await f.post(alice, 'root');
  const { store } = f.chat;
  let turnPassed = false;
  const seen = [];
  for (const name of ['thread', 'readState', 'threadMembers']) {
    const original = store[name].bind(store);
    store[name] = (...args) => {
      if (name === 'thread') queueMicrotask(() => { turnPassed = true; });
      seen.push([name, turnPassed]);
      return original(...args);
    };
  }
  const view = await f.send(alice, 'team.chat.thread', { channel_id: 'chan_team', root_id: root.message_id, limit: 10 });
  assert.equal(view.following, true);
  assert.deepEqual(seen, [['thread', false], ['readState', false], ['threadMembers', false]]);
});

// ------------------------------------------------------------ read positions, pin count, team.chat.pins

const CHANNEL = 'chan_team';
const sortedReads = (reads) => [...reads].sort((a, b) => (a.member_id < b.member_id ? -1 : 1));
const overviewRow = async (f, seat, channelId = CHANNEL) => (await f.send(seat, 'team.chat.overview')).channels
  .find((row) => row.channel_id === channelId);
const markRead = async (f, seat, seq, channelId = CHANNEL) => {
  assert.equal((await f.send(seat, 'team.chat.mark_read', { channel_id: channelId, seq })).ok, true);
};
const pinOf = (f, seat, id, on = true, channelId = CHANNEL) => f.send(seat, 'team.chat.pin',
  { channel_id: channelId, message_id: id, on });

test('the overview lists the other audience members\' read positions: not the asker\'s, none at 0, none who left', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { owner, alice, bob, rae } = f.seats;
  for (let n = 0; n < 3; n += 1) await f.post(alice, `m${n}`);
  await markRead(f, alice, 2);
  await markRead(f, bob, 3);
  await markRead(f, rae, 1);
  const expected = (...pairs) => sortedReads(pairs.map(([seat, seq]) => ({ member_id: seat.member_id, seq })));
  const asBob = await overviewRow(f, bob);
  assert.deepEqual(asBob.reads, expected([alice, 2], [rae, 1]), 'sorted by member id; the owner at 0 and bob himself are left out');
  assert.deepEqual((await overviewRow(f, alice)).reads, expected([bob, 3], [rae, 1]));
  assert.deepEqual((await overviewRow(f, owner)).reads, expected([alice, 2], [bob, 3], [rae, 1]));
  assert.deepEqual(Object.keys(asBob.reads[0]).sort(), ['member_id', 'seq']);

  // A project channel: a member removed from the project keeps a stored position and is not listed.
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_alpha' })).ok, true);
  await f.addToProject('project_alpha', 'alice', 'bob');
  const inside = await f.send(alice, 'team.chat.post', { channel_id: 'chan_project_alpha', text: 'inside' });
  assert.equal(inside.ok, true);
  await markRead(f, alice, 1, 'chan_project_alpha');
  await markRead(f, bob, 1, 'chan_project_alpha');
  assert.deepEqual((await overviewRow(f, alice, 'chan_project_alpha')).reads, expected([bob, 1]));
  const removed = await f.store.removeProjectMember({ actorMemberId: owner.member_id, projectId: 'project_alpha',
    memberId: bob.member_id });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(f.chat.store.readState('chan_project_alpha', bob.member_id).last_read_seq, 1, 'the position is still stored');
  assert.deepEqual((await overviewRow(f, alice, 'chan_project_alpha')).reads, []);
  assert.equal(await overviewRow(f, bob, 'chan_project_alpha'), undefined, 'a channel the member cannot see has no row');
});

// Slice 2b-3: a project row names who can read it, so "Seen by N of M" has its M there. The fixture's member ids
// are fixed (its seeded randomBytes), so the insertion order below is checked against id order, not assumed.
test('a project row carries audience, its active members in id order; team and direct rows carry none', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { owner, alice, bob, rae, pat } = f.seats;
  const PROJECT = 'chan_project_alpha';
  const add = (seat, role) => f.store.addProjectMember({ actorMemberId: owner.member_id, projectId: 'project_alpha',
    memberId: seat.member_id, role });
  assert.equal((await f.chat.store.createChannel({ channelId: PROJECT })).ok, true);
  await f.addToProject('project_alpha');
  // Added in descending id order, so a host that kept the store's order instead of sorting would answer it reversed.
  const others = [alice, bob, rae].sort((a, b) => (a.member_id < b.member_id ? 1 : -1));
  for (const seat of others) assert.equal((await add(seat, seat === rae ? 'reader' : 'writer')).ok, true);
  const refused = await add(pat, 'writer');
  assert.equal(refused.ok, false, 'a pending member cannot be added to a project');
  assert.equal(refused.error.reason, 'team_member_state_invalid');
  const exact = [owner.member_id, ...others.map((seat) => seat.member_id)].sort();
  assert.notDeepEqual([owner.member_id, ...others.map((seat) => seat.member_id)], exact, 'insertion order is not id order');
  assert.deepEqual((await overviewRow(f, alice, PROJECT)).audience, exact, 'the asker included, in code-unit order');

  assert.equal((await f.store.removeProjectMember({ actorMemberId: owner.member_id, projectId: 'project_alpha',
    memberId: bob.member_id })).ok, true);
  assert.equal((await f.store.revokeMember({ actorMemberId: owner.member_id, memberId: rae.member_id })).ok, true);
  const kept = [owner.member_id, alice.member_id].sort();
  assert.deepEqual((await overviewRow(f, alice, PROJECT)).audience, kept, 'removed from the project and revoked are gone');
  assert.equal(await overviewRow(f, bob, PROJECT), undefined, 'a member outside the project still gets no row');

  // The active filter: revokeMember leaves every project first, so the directory is rebuilt from a copy of the
  // member file whose project still holds the revoked member's row (as a hand-edited file would).
  const doc = structuredClone(f.store._doc);
  doc.projects.find((entry) => entry.project_id === 'project_alpha').members.push({ member_id: rae.member_id,
    role: 'reader', added_by: owner.member_id, added_at: new Date(0).toISOString() });
  f.store.directory.rebuild(doc);
  assert.equal(f.store.directory.projectRole(rae.member_id, 'project_alpha'), 'reader', 'the row is there');
  assert.deepEqual((await overviewRow(f, alice, PROJECT)).audience, kept, 'a member no longer active is not in it');
  f.store.directory.rebuild(f.store._doc);

  const opened = await f.send(alice, 'team.chat.dm_open', { member_ids: [bob.member_id] });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const rows = (await f.send(alice, 'team.chat.overview')).channels;
  for (const kind of ['team', 'dm']) {
    const other = rows.find((entry) => entry.kind === kind);
    assert.ok(other, kind);
    assert.equal('audience' in other, false, `a ${kind} row carries no audience`);
  }
});

test('a team owner with no project row and a deleting project get no project row', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { owner, alice } = f.seats;
  const PROJECT = 'chan_project_alpha';
  assert.equal((await f.chat.store.createChannel({ channelId: PROJECT })).ok, true);
  await f.addToProject('project_alpha');
  assert.equal((await f.store.addProjectMember({ actorMemberId: owner.member_id, projectId: 'project_alpha',
    memberId: alice.member_id, role: 'admin' })).ok, true);
  assert.equal((await f.store.removeProjectMember({ actorMemberId: owner.member_id, projectId: 'project_alpha',
    memberId: owner.member_id })).ok, true, 'the owner leaves the project');
  assert.equal(await overviewRow(f, owner, PROJECT), undefined, 'the team owner without a project row gets no row');
  assert.deepEqual((await overviewRow(f, alice, PROJECT)).audience, [alice.member_id]);
  const deleting = await f.store.markProjectDeleting({ actorMemberId: alice.member_id, projectId: 'project_alpha',
    counts: { conversations: 0, files: 0 } });
  assert.equal(deleting.ok, true, JSON.stringify(deleting));
  assert.equal(await overviewRow(f, alice, PROJECT), undefined, 'a deleting project gives no row');
});

test('a channel whose read states cannot be read answers reads: [] and keeps its row', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  await f.post(alice, 'one');
  fs.writeFileSync(path.join(f.fx.dir, 'team-chat', 'chan_team', 'read.json'), '{"schema_version":1,');
  const row = await overviewRow(f, bob);
  assert.deepEqual([row.reads, row.pin_count, row.last_seq], [[], 0, 1]);
});

test('pin_count follows pin, unpin, delete of a pinned message and a prune, and the overview reads no segment for it', async (t) => {
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { maxMessages: 4, segmentMaxMessages: 1 } });
  const { alice, bob } = f.seats;
  const posted = [];
  for (let n = 0; n < 3; n += 1) posted.push(await f.post(alice, `m${n}`));
  const store = f.chat.store;
  const loads = [];
  for (const name of ['ensureLoaded', 'recentMessages', 'getMessage', 'history']) {
    const original = store[name].bind(store);
    store[name] = (...args) => { loads.push(name); return original(...args); };
  }
  const count = async () => {
    await markRead(f, bob, (await overviewRow(f, bob)).last_seq);
    loads.length = 0;
    const row = await overviewRow(f, bob);
    assert.deepEqual(loads, [], 'a caught-up member costs no message read and no load');
    return row.pin_count;
  };
  assert.equal(await count(), 0);
  assert.equal((await pinOf(f, alice, posted[0].message_id)).ok, true);
  assert.equal((await pinOf(f, alice, posted[1].message_id)).ok, true);
  assert.equal(await count(), 2);
  assert.equal((await pinOf(f, alice, posted[0].message_id, false)).ok, true);
  assert.equal(await count(), 1);
  const gone = await f.send(alice, 'team.chat.delete', { channel_id: CHANNEL, message_id: posted[1].message_id });
  assert.equal(gone.ok, true);
  assert.equal(await count(), 0, 'deleting a pinned message frees its pin');
  assert.equal((await pinOf(f, alice, posted[2].message_id)).ok, true);
  assert.equal(await count(), 1);
  for (let n = 0; n < 4; n += 1) await f.post(alice, `later ${n}`);
  assert.equal(store.channelInfo(CHANNEL).pins.length, 0, 'the prune removed the pinned message');
  assert.equal(await count(), 0, 'a prune that removes a pinned message lowers the count');
});

test('team.chat.pins lists the pinned messages in the channel\'s pin order, without their earlier versions', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, rae } = f.seats;
  const first = await f.post(alice, 'first');
  const second = await f.post(alice, 'second');
  const third = await f.post(alice, 'third');
  assert.equal((await f.send(alice, 'team.chat.edit', { channel_id: CHANNEL, message_id: second.message_id, text: 'second, edited',
    expected_rev: second.rev })).ok, true);
  for (const posted of [third, first, second]) assert.equal((await pinOf(f, alice, posted.message_id)).ok, true);
  const listed = await f.send(rae, 'team.chat.pins', { channel_id: CHANNEL });
  assert.equal(listed.ok, true, 'a read-only member reads the list');
  assert.deepEqual(Object.keys(listed).sort(), ['channel_rev', 'ok', 'pins', 'trimmed']);
  assert.equal(listed.trimmed, false);
  assert.equal(listed.channel_rev, f.chat.store.channelInfo(CHANNEL).rev);
  assert.deepEqual(listed.pins.map((m) => m.id), [third.message_id, first.message_id, second.message_id]);
  const history = await f.send(rae, 'team.chat.history', { channel_id: CHANNEL, limit: 10 });
  const byId = new Map(history.messages.map((m) => [m.id, m]));
  assert.ok(byId.get(second.message_id).edits.length > 0);
  for (const pin of listed.pins) assert.deepEqual(pin, { ...byId.get(pin.id), edits: [] }, 'a record as history sends it, edits emptied');

  const gone = await f.send(alice, 'team.chat.delete', { channel_id: CHANNEL, message_id: first.message_id });
  assert.equal(gone.ok, true);
  const after = await f.send(rae, 'team.chat.pins', { channel_id: CHANNEL });
  assert.deepEqual(after.pins.map((m) => m.id), [third.message_id, second.message_id], 'a deleted message is not listed');
});

test('team.chat.pins answers a member outside the channel what history answers, and refuses an extra param', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_alpha' })).ok, true);
  await f.addToProject('project_alpha', 'alice');
  const secret = await f.send(alice, 'team.chat.post', { channel_id: 'chan_project_alpha', text: 'secret' });
  assert.equal((await pinOf(f, alice, secret.message_id, true, 'chan_project_alpha')).ok, true);
  const stripped = (answer) => { const { request_id: _id, ...rest } = answer.error; return rest; };
  const history = await f.send(bob, 'team.chat.history', { channel_id: 'chan_project_alpha', limit: 10 });
  const pins = await f.send(bob, 'team.chat.pins', { channel_id: 'chan_project_alpha' });
  assert.equal(pins.ok, false);
  assert.deepEqual(stripped(pins), stripped(history));
  assert.equal(JSON.stringify(pins).includes('secret'), false);
  const extra = await f.send(alice, 'team.chat.pins', { channel_id: CHANNEL, limit: 5 });
  assert.equal(extra.ok, false);
  assert.equal(extra.error.reason, 'invalid_command_parameters');
  assert.equal((await f.send(alice, 'team.chat.pins', {})).ok, false, 'channel_id is required');
});

test('50 pins of the longest legal text answer within the page budget with trimmed: true, oldest pins first', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { owner, alice, bob, rae } = f.seats;
  const text = '\u{1F600}'.repeat(16000);
  const ids = [];
  for (let n = 0; n < 50; n += 1) ids.push((await f.post([owner, alice, bob][n % 3], text)).message_id);
  for (const id of ids) assert.equal((await pinOf(f, alice, id)).ok, true, id);
  const listed = await f.send(rae, 'team.chat.pins', { channel_id: CHANNEL });
  assert.equal(listed.ok, true);
  assert.equal(listed.trimmed, true);
  assert.ok(size(listed) <= 512 * 1024, `${size(listed)} bytes`);
  assert.ok(listed.pins.length >= 1 && listed.pins.length < 50);
  assert.deepEqual(listed.pins.map((m) => m.id), ids.slice(0, listed.pins.length), 'records are left off the end');
  assert.equal(f.chat.store.channelInfo(CHANNEL).pins.length, 50);
});

test('boundPage trims a pins page from the end and says so; a page that fits says trimmed: false', () => {
  const pins = [message({ chars: 2000 }), message({ chars: 2000 }), message({ chars: 2000 })];
  const page = { ok: true, channel_rev: 4, pins };
  assert.deepEqual(boundPage('pins', page, 100_000), { ...page, trimmed: false });
  const bounded = boundPage('pins', page, 5000);
  assert.ok(size(bounded) <= 5000);
  assert.deepEqual(bounded.pins.map((m) => m.id), pins.slice(0, 2).map((m) => m.id));
  assert.equal(bounded.trimmed, true);
  assert.deepEqual(boundPage('pins', { ...page, pins: [] }, 5000), { ok: true, channel_rev: 4, pins: [], trimmed: false });
});

test('the overview lists at most seven read positions of other members, the lowest member ids', async () => {
  const others = Array.from({ length: 10 }, (_, n) => `member_${String(9 - n).padStart(2, '0')}`);
  const entries = [{ member_id: 'member_me', last_read_seq: 3 }, ...others.map((id, n) => ({ member_id: id, last_read_seq: n + 1 }))];
  const stub = {
    listChannels: () => ({ ok: true, channels: [{ channel_id: 'chan_team', kind: 'team', archived: false, rev: 1, last_seq: 3,
      floor_seq: 1, broken: false, pin_count: 0 }] }),
    readState: () => ({ ok: true, last_read_seq: 3, notify: 'all', followed: [] }),
    readStates: () => ({ ok: true, members: entries.map((entry) => ({ ...entry, notify: 'all', followed: [] })) }),
    readPositions: () => ({ ok: true, positions: entries }),
  };
  const everyone = new Set(entries.map((entry) => entry.member_id));
  const answer = await overviewChannels(stub, 'member_me', () => true, () => everyone);
  assert.deepEqual(answer.channels[0].reads.map((entry) => entry.member_id), others.slice().sort().slice(0, 7));
});

test('readPositions answers only member id and position, and fails as readStates does', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  await f.post(alice, 'one');
  assert.equal((await f.send(alice, 'team.chat.follow', { channel_id: CHANNEL, root_id: (await f.post(bob, 'two')).message_id,
    on: true })).ok, true);
  await markRead(f, bob, 2);
  const lean = f.chat.store.readPositions(CHANNEL);
  assert.equal(lean.ok, true);
  assert.deepEqual(lean.positions, [{ member_id: alice.member_id, last_read_seq: 0 }, { member_id: bob.member_id, last_read_seq: 2 }]
    .filter((entry) => f.chat.store.readStates(CHANNEL).members.some((m) => m.member_id === entry.member_id)));
  for (const entry of lean.positions) assert.deepEqual(Object.keys(entry), ['member_id', 'last_read_seq']);

  const broken = [];
  for (const name of ['readStates', 'readPositions']) {
    const g = await createTeamChatCommandsFixture(t);
    await g.post(g.seats.alice, 'one');
    fs.writeFileSync(path.join(g.fx.dir, 'team-chat', 'chan_team', 'read.json'), '{"schema_version":1,');
    broken.push(g.chat.store[name](CHANNEL));
  }
  assert.equal(broken[1].ok, false);
  assert.deepEqual(broken[1], broken[0]);
});
