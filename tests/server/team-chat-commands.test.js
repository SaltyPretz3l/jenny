'use strict';

// Slice 2a-3a: the team chat commands on a real chat store in a temporary
// profile, through the real router, authorizer and team commands.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { PARAM_SCHEMAS } = require('../../server/api-contract');
const { LIMITS } = require('../../services/host/team-chat-schema');
const { createTeamChatCommandsFixture } = require('./helpers/team-chat-commands-fixture');
const { createTeamChatCommands, extractMentions } = require('../../services/host/team-chat-commands');
const { createTeamChatHost } = require('../../services/host/team-chat-host');

const PRIVATE_WORDS = 'zebra-orchid-private-words';
const KIB = 1024;

test('happy path: post, history, sync, thread, edit, delete, mark_read, set_notify, follow, overview', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  const root = await f.send(alice, 'team.chat.post', { channel_id: 'chan_team', text: 'first' });
  assert.deepEqual(Object.keys(root).sort(), ['message_id', 'ok', 'rev', 'seq']);
  assert.equal(root.seq, 1);
  const reply = await f.post(bob, 'a reply', { thread_root_id: root.message_id });
  assert.equal(reply.seq, 2);
  const refs = [{ kind: 'message', channel_id: 'chan_team', message_id: root.message_id }];
  const second = await f.post(bob, 'second', { refs });

  const history = await f.send(bob, 'team.chat.history', { channel_id: 'chan_team', limit: 10 });
  assert.equal(history.ok, true);
  assert.deepEqual(history.messages.map((m) => m.seq), [1, 3], 'replies are excluded');
  assert.equal(history.messages[0].reply_count, 1);
  assert.deepEqual(history.messages[1].refs, refs);
  assert.equal(history.has_more, false);
  const older = await f.send(bob, 'team.chat.history', { channel_id: 'chan_team', before_seq: 3, limit: 10 });
  assert.deepEqual(older.messages.map((m) => m.seq), [1]);

  const sync = await f.send(bob, 'team.chat.sync', { channel_id: 'chan_team', after_rev: 0, limit: 200 });
  assert.equal(sync.ok, true);
  assert.equal(sync.more, false);
  assert.equal(sync.channel_rev, second.rev);
  assert.equal(sync.messages.length, 3);

  const thread = await f.send(alice, 'team.chat.thread', { channel_id: 'chan_team', root_id: root.message_id, limit: 10 });
  assert.equal(thread.root.id, root.message_id);
  assert.deepEqual(thread.replies.map((m) => m.id), [reply.message_id]);

  const edited = await f.send(bob, 'team.chat.edit', { channel_id: 'chan_team', message_id: second.message_id,
    text: 'second, edited', expected_rev: second.rev });
  assert.deepEqual(Object.keys(edited).sort(), ['ok', 'rev']);
  const deleted = await f.send(bob, 'team.chat.delete', { channel_id: 'chan_team', message_id: second.message_id });
  assert.deepEqual(Object.keys(deleted).sort(), ['ok', 'rev']);
  assert.equal(deleted.rev, edited.rev + 1);

  assert.deepEqual(await f.send(bob, 'team.chat.mark_read', { channel_id: 'chan_team', seq: 3 }),
    { ok: true, last_read_seq: 3 });
  assert.deepEqual(await f.send(bob, 'team.chat.mark_read', { channel_id: 'chan_team', seq: 2, unread: true }),
    { ok: true, last_read_seq: 1 });
  assert.deepEqual(await f.send(bob, 'team.chat.set_notify', { channel_id: 'chan_team', level: 'none' }),
    { ok: true, level: 'none' });
  assert.deepEqual(await f.send(bob, 'team.chat.follow', { channel_id: 'chan_team', root_id: reply.message_id, on: true }),
    { ok: true, root_id: root.message_id, on: true });

  const overview = await f.send(bob, 'team.chat.overview');
  assert.deepEqual(overview.channels, [{
    channel_id: 'chan_team', kind: 'team', archived: false, rev: deleted.rev, last_seq: 3, floor_seq: 1,
    last_read_seq: 1, notify: 'none', unread: 0, unread_capped: false, mention: false,
  }]);
});

test('a retried post with the same request id returns the same ids and publishes once', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice } = f.seats;
  const cmd = f.command(alice.auth, 'team.chat.post', { channel_id: 'chan_team', text: 'once' });
  const first = await f.dispatch(alice, cmd);
  const again = await f.dispatch(alice, cmd);
  assert.equal(first.ok, true);
  assert.deepEqual(again, first);
  assert.equal(f.chatEvents().filter((e) => e.type === 'team_chat_message').length, 1);
  assert.equal(f.chat.store.channelInfo('chan_team').last_seq, 1);
  // The shared receipt store is not used by chat.
  assert.equal(fs.existsSync(f.receiptsPath) && fs.readFileSync(f.receiptsPath, 'utf8').includes(cmd.request_id), false);
  const changed = await f.dispatch(alice, { ...cmd, params: { channel_id: 'chan_team', text: 'twice' } });
  assert.equal(changed.error.reason, 'request_payload_changed');
  assert.equal(changed.error.code, 'CMP-HOST-0004');
});

test('author rules: edit by the author only; delete by the author or the owner', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { owner, alice, bob } = f.seats;
  const mine = await f.post(alice, 'alice wrote this');
  const edit = (seat, text, rev) => f.send(seat, 'team.chat.edit', { channel_id: 'chan_team', message_id: mine.message_id,
    text, expected_rev: rev });
  assert.equal(f.reasonOf(await edit(bob, 'bob edits', mine.rev)), 'role_forbidden');
  assert.equal(f.reasonOf(await edit(owner, 'owner edits', mine.rev)), 'role_forbidden');
  const ok = await edit(alice, 'alice edits', mine.rev);
  assert.equal(ok.ok, true);
  assert.equal(f.reasonOf(await edit(alice, 'stale edit', mine.rev)), 'team_chat_stale');
  const del = (seat, messageId) => f.send(seat, 'team.chat.delete', { channel_id: 'chan_team', message_id: messageId });
  assert.equal(f.reasonOf(await del(bob, mine.message_id)), 'role_forbidden');
  const byOwner = await del(owner, mine.message_id);
  assert.equal(byOwner.ok, true);
  const record = f.chat.store.getMessage('chan_team', mine.message_id).message;
  assert.equal(record.deleted.by, owner.member_id);
  const bobs = await f.post(bob, 'bob wrote this');
  assert.equal((await del(bob, bobs.message_id)).ok, true);
  // A deleted message keeps the store's answer for an edit.
  assert.equal(f.reasonOf(await f.send(bob, 'team.chat.edit', { channel_id: 'chan_team', message_id: bobs.message_id,
    text: 'zombie', expected_rev: 99 })), 'team_chat_not_found');
});

test('the 31st post in a minute is rate limited; team.rename keeps working and does not spend chat budget', async (t) => {
  // 31 renames (no admin limiter here) leave all 30 posts of the minute.
  const plain = await createTeamChatCommandsFixture(t);
  for (let i = 0; i < 31; i += 1) {
    assert.equal((await plain.send(plain.seats.owner, 'team.rename', { name: `Team ${i}` })).ok, true, `rename ${i}`);
  }
  for (let i = 0; i < 30; i += 1) await plain.post(plain.seats.owner, `post ${i}`);
  assert.equal(plain.reasonOf(await plain.send(plain.seats.owner, 'team.chat.post', { channel_id: 'chan_team',
    text: 'post 31' })), 'team_chat_rate_limit');

  // With the host's 30-a-minute admin limiter: chat never spends its budget, nor it chat's.
  const f = await createTeamChatCommandsFixture(t, { adminLimit: 30 });
  const { owner } = f.seats;
  for (let i = 0; i < 30; i += 1) await f.post(owner, `post ${i}`);
  const refused = await f.send(owner, 'team.chat.post', { channel_id: 'chan_team', text: 'post 31' });
  assert.equal(refused.error.reason, 'team_chat_rate_limit');
  assert.equal(refused.error.code, 'CMP-HOST-0007');
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await f.send(owner, 'team.rename', { name: `Team ${i}` })).ok, true, `rename ${i}`);
  }
  assert.equal(f.reasonOf(await f.send(owner, 'team.rename', { name: 'Team 31' })), 'team_rate_limit');
  // Other mutations have their own budget; reads are not limited here.
  assert.equal((await f.send(owner, 'team.chat.mark_read', { channel_id: 'chan_team', seq: 1 })).ok, true);
  assert.equal((await f.send(owner, 'team.chat.history', { channel_id: 'chan_team', limit: 1 })).ok, true);
  f.fx.advance(60_000);
  assert.equal((await f.send(owner, 'team.chat.post', { channel_id: 'chan_team', text: 'next minute' })).ok, true);
});

test('60 other chat mutations a minute per member', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  for (let i = 0; i < 60; i += 1) {
    const level = i % 2 ? 'all' : 'none';
    assert.equal((await f.send(alice, 'team.chat.set_notify', { channel_id: 'chan_team', level })).ok, true, `call ${i}`);
  }
  const refused = await f.send(alice, 'team.chat.mark_read', { channel_id: 'chan_team', seq: 0 });
  assert.equal(refused.error.reason, 'team_chat_rate_limit');
  assert.equal((await f.send(bob, 'team.chat.mark_read', { channel_id: 'chan_team', seq: 0 })).ok, true, 'per member');
});

test('canAdmit() false refuses post and edit, not reads or read state', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice } = f.seats;
  const mine = await f.post(alice, 'before pressure');
  f.setAdmit(false);
  for (const [operation, params] of [
    ['team.chat.post', { channel_id: 'chan_team', text: 'under pressure' }],
    ['team.chat.edit', { channel_id: 'chan_team', message_id: mine.message_id, text: 'x', expected_rev: mine.rev }],
  ]) {
    const answer = await f.send(alice, operation, params);
    assert.deepEqual([answer.error.code, answer.error.reason, answer.error.retryable],
      ['CMP-HOST-0005', 'disk_pressure', true], operation);
  }
  assert.equal((await f.send(alice, 'team.chat.history', { channel_id: 'chan_team', limit: 5 })).ok, true);
  assert.equal((await f.send(alice, 'team.chat.mark_read', { channel_id: 'chan_team', seq: 1 })).ok, true);
  assert.equal(f.chat.store.channelInfo('chan_team').last_seq, 1);
});

test('mention tokens: in order, unique, audience members only, at most 16', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { owner, alice, bob, rae, pat } = f.seats;
  const text = `hi <@${bob.member_id}> and <@jenny> <@${bob.member_id}> <@member_nobody> <@${pat.member_id}> `
    + `<@channel> <@${rae.member_id}> <@${alice.member_id}>`;
  const posted = await f.post(owner, text);
  const record = f.chat.store.getMessage('chan_team', posted.message_id).message;
  assert.deepEqual(record.mentions, [bob.member_id, 'jenny', 'channel', rae.member_id, alice.member_id],
    'a non-member and a pending member are dropped');
  assert.equal(record.text, text, 'the text is stored as sent');

  // A team holds at most eight live members, so the 16 cap is reached with a
  // synthetic audience through the same extractor the commands use.
  const audience = new Set(Array.from({ length: 20 }, (_, i) => `member_m${i}`));
  const tokens = [...audience].slice(0, 15).map((id) => `<@${id}>`).join(' ');
  assert.deepEqual(extractMentions(`${tokens} <@jenny> <@channel> <@member_m19>`, audience),
    [...[...audience].slice(0, 15), 'jenny'], 'the 17th and later are dropped');
  assert.deepEqual(extractMentions('<@member_out> <@member_m1> <@member_m1> <@Jenny> <@ channel>', audience),
    ['member_m1']);

  // Edit re-extracts.
  const edited = await f.send(owner, 'team.chat.edit', { channel_id: 'chan_team', message_id: posted.message_id,
    text: `now only <@${alice.member_id}>`, expected_rev: posted.rev });
  assert.equal(edited.ok, true);
  assert.deepEqual(f.chat.store.getMessage('chan_team', posted.message_id).message.mentions, [alice.member_id]);
});

test('a 100-message page of 16,000-character messages stays under the byte bound and reports more', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { owner } = f.seats;
  const big = 'é'.repeat(15_990);
  const ids = [];
  for (let i = 0; i < 100; i += 1) {
    f.fx.advance(2_100); // stay under 30 posts a minute
    ids.push((await f.post(owner, `${String(i).padStart(4, '0')}${big}`)).message_id);
  }
  const page = await f.send(owner, 'team.chat.history', { channel_id: 'chan_team', limit: 100 });
  assert.equal(page.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * KIB);
  assert.equal(page.has_more, true);
  assert.ok(page.messages.length > 0 && page.messages.length < 100);
  assert.equal(page.messages[page.messages.length - 1].id, ids[99], 'the newest end is kept');
  // Paging on from the oldest returned message reaches every message once.
  const seen = new Set(page.messages.map((m) => m.id));
  let before = page.messages[0].seq;
  for (let guard = 0; guard < 20 && before > 1; guard += 1) {
    const next = await f.send(owner, 'team.chat.history', { channel_id: 'chan_team', before_seq: before, limit: 100 });
    assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 512 * KIB);
    for (const m of next.messages) { assert.equal(seen.has(m.id), false); seen.add(m.id); }
    if (!next.has_more) break;
    before = next.messages[0].seq;
  }
  assert.equal(seen.size, 100);

  const sync = await f.send(owner, 'team.chat.sync', { channel_id: 'chan_team', after_rev: 0, limit: 200 });
  assert.ok(Buffer.byteLength(JSON.stringify(sync)) <= 512 * KIB);
  assert.equal(sync.more, true);
  assert.equal(sync.messages[0].id, ids[0], 'sync keeps the oldest revisions');

  // A smaller HTTP response cap lowers the bound too.
  const small = await createTeamChatCommandsFixture(t, { maxResponseBytes: 128 * KIB });
  for (let i = 0; i < 6; i += 1) await small.post(small.seats.owner, `${i}${big}`);
  const capped = await small.send(small.seats.owner, 'team.chat.history', { channel_id: 'chan_team', limit: 100 });
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) < 128 * KIB);
  assert.equal(capped.has_more, true);
});

test('overview: unread counts messages by others (replies only in followed threads), caps at 300, flags mentions', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  const root = await f.post(alice, 'one');
  // Bob's own reply: never unread for him; for Alice it is a reply in the thread she started (slice 2a-3b).
  await f.post(bob, 'reply, not counted', { thread_root_id: root.message_id });
  await f.post(bob, 'mine, not counted');
  const gone = await f.post(alice, 'deleted, not counted');
  await f.send(alice, 'team.chat.delete', { channel_id: 'chan_team', message_id: gone.message_id });
  await f.post(alice, 'two');
  const view = async () => (await f.send(bob, 'team.chat.overview')).channels[0];
  let channel = await view();
  assert.deepEqual([channel.unread, channel.unread_capped, channel.mention], [2, false, false]);
  await f.post(alice, `hey <@${bob.member_id}>`);
  channel = await view();
  assert.deepEqual([channel.unread, channel.mention], [3, true]);
  await f.send(bob, 'team.chat.mark_read', { channel_id: 'chan_team', seq: channel.last_seq });
  channel = await view();
  assert.deepEqual([channel.unread, channel.mention, channel.last_read_seq], [0, false, channel.last_seq]);
  await f.post(alice, 'hello <@channel>');
  assert.equal((await view()).mention, true);
  const forAlice = (await f.send(alice, 'team.chat.overview')).channels[0];
  assert.deepEqual([forAlice.unread, forAlice.mention], [2, false],
    'Bob\'s timeline message and his reply in the thread she started; her own never count');

  // Past 300 scanned messages the count is capped.
  const many = await createTeamChatCommandsFixture(t);
  for (let i = 0; i < 302; i += 1) {
    if (i % 30 === 0) many.fx.advance(60_000);
    await many.post(many.seats.alice, `m${i}`);
  }
  const capped = (await many.send(many.seats.bob, 'team.chat.overview')).channels[0];
  assert.deepEqual([capped.unread, capped.unread_capped], [300, true]);
  await many.send(many.seats.bob, 'team.chat.mark_read', { channel_id: 'chan_team', seq: 2 });
  const exact = (await many.send(many.seats.bob, 'team.chat.overview')).channels[0];
  assert.deepEqual([exact.unread, exact.unread_capped], [300, false]);
});

test('a chat store that fails to open leaves membership working and chat answering the store failure', async (t) => {
  const f = await createTeamChatCommandsFixture(t, {
    beforeStart: (fx) => {
      fs.mkdirSync(path.join(fx.dir, 'team-chat'), { recursive: true });
      fs.writeFileSync(path.join(fx.dir, 'team-chat', 'index.json'), '{not json');
    },
  });
  assert.equal((await f.send(f.seats.owner, 'team.members.list')).ok, true);
  const failure = f.chat.failure();
  assert.equal(failure.ok, false);
  for (const [operation, params] of [
    ['team.chat.overview', {}],
    ['team.chat.post', { channel_id: 'chan_team', text: 'x' }],
    ['team.chat.history', { channel_id: 'chan_team', limit: 5 }],
  ]) {
    const answer = await f.send(f.seats.alice, operation, params);
    assert.equal(answer.ok, false, operation);
    assert.equal(answer.error.code, failure.error.code, operation);
    assert.equal(answer.error.reason, failure.error.reason, operation);
  }
  assert.ok(f.fx.logs.some((entry) => entry.event === 'team_chat.unavailable'));
});

test('message text and mention lists never reach a log or an error payload', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  const posted = await f.post(alice, `${PRIVATE_WORDS} <@${bob.member_id}>`);
  const stale = await f.send(alice, 'team.chat.edit', { channel_id: 'chan_team', message_id: posted.message_id,
    text: `${PRIVATE_WORDS} again`, expected_rev: posted.rev + 5 });
  assert.equal(stale.error.reason, 'team_chat_stale');
  assert.equal(JSON.stringify(stale).includes(PRIVATE_WORDS), false);
  const forbidden = await f.send(bob, 'team.chat.edit', { channel_id: 'chan_team', message_id: posted.message_id,
    text: PRIVATE_WORDS, expected_rev: posted.rev });
  assert.equal(JSON.stringify(forbidden).includes(PRIVATE_WORDS), false);
  const logText = JSON.stringify(f.fx.logs);
  assert.equal(logText.includes(PRIVATE_WORDS), false);
  assert.equal(logText.includes(`<@${bob.member_id}>`), false);
});

test('a prune report from a post becomes a team_chat_channel event with an audience', async (t) => {
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { maxMessages: 2, segmentMaxMessages: 1 } });
  const { alice } = f.seats;
  for (let i = 0; i < 5; i += 1) await f.post(alice, `m${i}`);
  const pruned = f.chatEvents().filter((e) => e.type === 'team_chat_channel');
  assert.ok(pruned.length > 0, 'a post that pruned published a channel event');
  for (const event of pruned) {
    assert.deepEqual(Object.keys(event.payload).sort(), ['channel_id', 'channel_rev', 'floor_seq', 'reason']);
    assert.equal(event.payload.reason, 'pruned');
    assert.equal(event.options.bucket, 'teamchat:chan_team');
    assert.ok(event.options.audience instanceof Set);
  }
});

test('the chat host runs retention at start and every six hours on an unref\'d timer cleared by dispose', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const calls = [];
  const handle = { unref() { calls.push('unref'); } };
  const timers = {
    setInterval: (fn, ms) => { calls.push(['set', ms]); handle.fn = fn; return handle; },
    clearInterval: (value) => { calls.push(['clear', value === handle]); },
  };
  const host = createTeamChatHost({ profileDir: path.join(f.fx.dir, 'second'), directory: f.store.directory,
    logger: f.fx.logger, clock: f.fx.clock, timers });
  fs.mkdirSync(path.join(f.fx.dir, 'second'));
  assert.deepEqual(await host.start(), { ok: true });
  assert.equal(host.store.listChannels().channels[0].channel_id, 'chan_team');
  assert.deepEqual(calls, [['set', 6 * 60 * 60 * 1000], 'unref']);
  await host.runRetention();
  await host.dispose();
  assert.deepEqual(calls.at(-1), ['clear', true]);
  // A second start on the same profile finds the team channel already there.
  const again = createTeamChatHost({ profileDir: path.join(f.fx.dir, 'second'), directory: f.store.directory,
    timers: { setInterval: () => null, clearInterval: () => {} } });
  assert.deepEqual(await again.start(), { ok: true });
  await again.dispose();
});

test('a retry after the roster changed replays: mentions are not part of the request digest', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { owner, alice, bob } = f.seats;
  const cmd = f.command(alice.auth, 'team.chat.post', { channel_id: 'chan_team', text: `hi <@${bob.member_id}>` });
  const first = await f.dispatch(alice, cmd);
  assert.equal(first.ok, true);
  const record = f.chat.store.getMessage('chan_team', first.message_id).message;
  assert.deepEqual(record.mentions, [bob.member_id]);
  const events = f.chatEvents().length;
  const revoked = await f.store.revokeMember({ actorMemberId: owner.member_id, memberId: bob.member_id });
  assert.equal(revoked.ok, true);
  assert.deepEqual(await f.dispatch(alice, cmd), first, 'the same message, replayed');
  assert.equal(f.chatEvents().length, events, 'a replay publishes nothing');
  assert.equal(f.chat.store.channelInfo('chan_team').last_seq, 1);
  assert.deepEqual(f.chat.store.getMessage('chan_team', first.message_id).message.mentions, [bob.member_id],
    'the stored record keeps its original mentions');
  // An edit retried across the same kind of change replays too.
  const rae = f.seats.rae;
  const edit = f.command(alice.auth, 'team.chat.edit', { channel_id: 'chan_team', message_id: first.message_id,
    text: `now <@${rae.member_id}>`, expected_rev: first.rev });
  const edited = await f.dispatch(alice, edit);
  assert.equal(edited.ok, true);
  const afterEdit = f.chatEvents().length;
  assert.equal((await f.store.revokeMember({ actorMemberId: owner.member_id, memberId: rae.member_id })).ok, true);
  assert.deepEqual(await f.dispatch(alice, edit), edited);
  assert.equal(f.chatEvents().length, afterEdit);
});

test('overview reads no messages for a caught-up member', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  const store = f.chat.store;
  const original = store.recentMessages.bind(store);
  let reads = 0;
  store.recentMessages = (...args) => { reads += 1; return original(...args); };
  t.after(() => { store.recentMessages = original; });
  assert.equal((await f.send(bob, 'team.chat.overview')).channels[0].unread, 0);
  assert.equal(reads, 0, 'an empty channel needs no read');
  const posted = await f.post(alice, 'one');
  assert.equal((await f.send(bob, 'team.chat.overview')).channels[0].unread, 1);
  assert.ok(reads > 0);
  await f.send(bob, 'team.chat.mark_read', { channel_id: 'chan_team', seq: posted.seq });
  reads = 0;
  const caughtUp = (await f.send(bob, 'team.chat.overview')).channels[0];
  assert.deepEqual([caughtUp.unread, caughtUp.unread_capped, caughtUp.mention], [0, false, false]);
  assert.equal(reads, 0);
});

test('a post reads its record once; an edit of a reply does not republish the root', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  const store = f.chat.store;
  const original = store.getMessage.bind(store);
  let reads = 0;
  store.getMessage = (...args) => { reads += 1; return original(...args); };
  t.after(() => { store.getMessage = original; });
  const root = await f.post(alice, 'root');
  assert.equal(reads, 1, 'one read for a plain post');
  reads = 0;
  const reply = await f.post(bob, 'reply', { thread_root_id: root.message_id });
  assert.equal(reads, 2, 'the reply and its root');
  const before = f.chatEvents().length;
  const edited = await f.send(bob, 'team.chat.edit', { channel_id: 'chan_team', message_id: reply.message_id,
    text: 'reply, edited', expected_rev: reply.rev });
  assert.equal(edited.ok, true);
  const events = f.chatEvents().slice(before);
  assert.deepEqual(events.map((e) => e.payload.message.id), [reply.message_id]);
});

test('a Jenny reply: its member may delete it but not edit it; the owner may delete it; others may not', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { owner, alice, bob } = f.seats;
  const jenny = async (requestId) => {
    const posted = await f.chat.store.post({ channelId: 'chan_team', actorId: alice.member_id,
      deviceId: alice.device_id, requestId, text: 'a Jenny answer', authorKind: 'jenny' });
    assert.equal(posted.ok, true);
    return posted;
  };
  const first = await jenny('jenny_1');
  assert.equal(f.reasonOf(await f.send(alice, 'team.chat.edit', { channel_id: 'chan_team', message_id: first.message_id,
    text: 'rewritten', expected_rev: first.rev })), 'role_forbidden');
  const del = (seat, messageId) => f.send(seat, 'team.chat.delete', { channel_id: 'chan_team', message_id: messageId });
  assert.equal(f.reasonOf(await del(bob, first.message_id)), 'role_forbidden');
  assert.equal((await del(alice, first.message_id)).ok, true);
  const second = await jenny('jenny_2');
  assert.equal((await del(owner, second.message_id)).ok, true);
});

test('a prune report from an edit becomes a team_chat_channel event before the message event', async (t) => {
  // Measure three posts on an unlimited store, then allow a little more than that.
  const probe = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 1 } });
  for (let i = 0; i < 3; i += 1) await probe.post(probe.seats.alice, `${i}${'p'.repeat(999)}`);
  const treeMaxBytes = probe.chat.store.totalBytes() + 1500;
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 1, treeMaxBytes } });
  const posts = [];
  for (let i = 0; i < 3; i += 1) posts.push(await f.post(f.seats.alice, `${i}${'p'.repeat(999)}`));
  const before = f.chatEvents().length;
  assert.equal(f.chatEvents().filter((e) => e.type === 'team_chat_channel').length, 0, 'the posts pruned nothing');
  const last = posts[2];
  const edited = await f.send(f.seats.alice, 'team.chat.edit', { channel_id: 'chan_team', message_id: last.message_id,
    text: 'q'.repeat(3000), expected_rev: last.rev });
  assert.equal(edited.ok, true);
  const events = f.chatEvents().slice(before);
  assert.deepEqual(events.map((e) => e.type), ['team_chat_channel', 'team_chat_message']);
  assert.equal(events[0].options.bucket, 'teamchat:chan_team');
  assert.ok(events[0].options.audience instanceof Set);
  assert.equal(events[0].payload.reason, 'pruned');
  assert.ok(events[0].payload.channel_rev < edited.rev, 'the prune is the earlier revision');
});

test('the contract\'s chat bounds equal the store schema\'s', () => {
  const schemas = PARAM_SCHEMAS;
  const post = schemas['team.chat.post'].properties;
  assert.equal(post.text.maxLength, LIMITS.TEXT_MAX_CHARS * 2);
  assert.equal(schemas['team.chat.edit'].properties.text.maxLength, LIMITS.TEXT_MAX_CHARS * 2);
  assert.equal(post.refs.maxItems, LIMITS.REFS_MAX);
  const fileRef = post.refs.items.anyOf.find((shape) => shape.properties.kind.const === 'file');
  assert.equal(fileRef.properties.path.maxLength, LIMITS.REF_PATH_MAX_CHARS);
  assert.equal(schemas['team.chat.history'].properties.limit.maximum, LIMITS.HISTORY_LIMIT_MAX);
  assert.equal(schemas['team.chat.sync'].properties.limit.maximum, LIMITS.SYNC_LIMIT_MAX);
  assert.equal(schemas['team.chat.thread'].properties.limit.maximum, LIMITS.THREAD_LIMIT_MAX);
});

// ------------------------------------------------------------ repaid store limits (slice 2a-3b)

test('two concurrent deletes of one message announce its tombstone once', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, owner } = f.seats;
  const posted = await f.post(alice, 'to be deleted twice');
  const before = f.chatEvents().length;
  const params = { channel_id: 'chan_team', message_id: posted.message_id };
  const [first, second] = await Promise.all([f.send(alice, 'team.chat.delete', params),
    f.send(owner, 'team.chat.delete', params)]);
  assert.deepEqual([first.ok, second.ok], [true, true]);
  assert.equal(first.rev, second.rev);
  const announced = f.chatEvents().slice(before)
    .filter((entry) => entry.type === 'team_chat_message' && entry.payload.message.id === posted.message_id);
  assert.equal(announced.length, 1);
  assert.notEqual(announced[0].payload.message.deleted, null);
});

test('a failed mutation after a committed prune announces the prune and answers without it', async () => {
  const report = { channel_id: 'chan_team', reason: 'pruned', floor_seq: 5, channel_rev: 7, segments_removed: 1,
    messages_removed: 4, replies_removed: 0, bytes_removed: 900 };
  const failure = { ok: false, error: { code: 'CMP-HOST-0006', reason: 'team_chat_store_failed', retryable: false } };
  const store = {
    ensureLoaded: async () => {}, isLoading: () => false, getMessage: () => ({ ok: true, message: null }),
    post: async () => ({ ...failure, pruned: [report] }),
    delete: async () => ({ ...failure, pruned: [report] }),
  };
  const directory = { liveActor: () => ({ member_id: 'member_a', device_id: 'device_a', role: 'owner', state: 'active' }) };
  const commands = createTeamChatCommands({ store, directory, audience: () => new Set(['member_a']) });
  for (const [operation, params] of [['team.chat.post', { channel_id: 'chan_team', text: 'x' }],
    ['team.chat.delete', { channel_id: 'chan_team', message_id: 'msg_1' }]]) {
    const published = [];
    const answer = await commands.dispatch({ operation, params, request_id: 'req_1' }, { deviceId: 'device_a' },
      { canAdmit: () => true, publish: (type, payload, options) => published.push({ type, payload, options }) });
    assert.deepEqual(answer, failure, `${operation}: the answer carries no prune list`);
    assert.deepEqual(published.map((entry) => [entry.type, entry.payload, entry.options.bucket]),
      [['team_chat_channel', { channel_id: 'chan_team', reason: 'pruned', floor_seq: 5, channel_rev: 7 },
        'teamchat:chan_team']], operation);
  }
});

// ------------------------------------------------------------ review round (slice 2a-3b)

test('presence reports have their own per-device limit; a report that changes nothing spends nothing', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice } = f.seats;
  const posted = await f.post(f.seats.bob, 'one');
  // No stream from this device: every report changes nothing.
  for (let i = 0; i < 70; i += 1) {
    assert.equal((await f.send(alice, 'team.presence.set', { state: i % 2 ? 'idle' : 'active' })).ok, true, `${i}`);
  }
  // With a stream, alternating reports are counted per device, never against the shared mutation budget.
  f.chat.onMemberStream(alice.member_id, alice.device_id, 'open');
  let accepted = 0;
  let answer;
  for (let i = 0; i < 100; i += 1) {
    answer = await f.send(alice, 'team.presence.set', { state: i % 2 ? 'active' : 'idle' });
    if (!answer.ok) break;
    accepted += 1;
  }
  assert.equal(f.reasonOf(answer), 'team_chat_rate_limit');
  assert.equal(accepted, 30, 'thirty changes a minute per device');
  assert.equal(f.reasonOf(await f.send(alice, 'team.chat.mark_read', { channel_id: 'chan_team', seq: posted.seq })), 'ok',
    'mark_read keeps its budget');
  f.chat.onMemberStream(alice.member_id, alice.device_id, 'close');
});

test('the overview is limited to 20 per 10 s per member, read-only members included', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { rae, bob } = f.seats;
  await f.post(bob, 'one');
  for (let i = 0; i < 20; i += 1) assert.equal((await f.send(rae, 'team.chat.overview')).ok, true, `${i}`);
  assert.equal(f.reasonOf(await f.send(rae, 'team.chat.overview')), 'team_chat_rate_limit');
  assert.equal((await f.send(bob, 'team.chat.overview')).ok, true, 'per member');
  f.fx.advance(10_000);
  assert.equal((await f.send(rae, 'team.chat.overview')).ok, true);
});
