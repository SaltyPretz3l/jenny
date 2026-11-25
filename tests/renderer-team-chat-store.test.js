'use strict';

// The team chat store (row 123, slice 2a-5a): chat state per team, the `onChat` pushes and the
// count of channels that mention you, through the real store over the harness's stubbed
// `window.jennyShell.team`. No DOM is drawn by the store.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, OTHER, DOT, CHAN, flush, micro, snapshot, memberTeam, harness, chatChannel, chatMember, message, overview, liveTimers, heldAnswers }
  = require('./helpers/team-settings-harness');

function open(options = {}) {
  const h = harness({ show: false, ...options });
  const release = h.chat.use();
  h.cleanups.push(release);
  return h;
}
const push = (h, payload) => h.listeners.chat(payload);
const seqs = (h, team = TEAM) => h.chat.timeline(team, CHAN).list.map((m) => m.seq);

test('one overview per connected team; never for a pending, revoked, update-required or connecting team', async (t) => {
  const h = open();
  t.after(h.restore);
  const teams = [snapshot(), memberTeam(), memberTeam({ team_id: 'team_P', state: 'pending' }), memberTeam({ team_id: 'team_R', state: 'revoked' }),
    memberTeam({ team_id: 'team_U', state: 'update_required' }), memberTeam({ team_id: 'team_C', state: 'connecting' })];
  h.chat.sync(teams);
  h.chat.sync(teams);
  await flush();
  h.chat.sync(teams);
  await flush();
  assert.deepEqual(h.sent('chatOverview').map((call) => call.payload), [{ team_id: TEAM }, { team_id: OTHER }]);
  assert.equal(h.chat.team('team_P'), null);
  h.chat.sync(teams.map((team) => (team.team_id === 'team_C' ? { ...team, state: 'online' } : team)));
  await flush();
  assert.deepEqual(h.sent('chatOverview').map((call) => call.payload.team_id), [TEAM, OTHER, 'team_C'], 'asked once it connects');
  assert.deepEqual(h.chat.team(TEAM).members.map((m) => m.member_id).length, 2);
});

test('a team that becomes pending or revoked loses everything held for it, and its pushes are ignored', async (t) => {
  const h = open({ answers: { chatOverview: overview({ channels: [chatChannel({ mention: true, unread: 2 })] }) } });
  t.after(h.restore);
  h.chat.sync([memberTeam()]);
  await flush();
  assert.equal(h.chat.mentionCount(), 1);
  h.chat.sync([memberTeam({ state: 'revoked' })]);
  assert.equal(h.chat.team(OTHER), null);
  assert.equal(h.chat.mentionCount(), 0);
  push(h, { team_id: OTHER, type: 'channels', channels: [chatChannel({ mention: true })] });
  assert.equal(h.chat.mentionCount(), 0, 'a push for a locked-out team is dropped');
  assert.equal(h.chat.team(OTHER), null, 'and builds no state');
});

test('mentionCount counts channels that mention you across teams; channels pushes merge or replace', async (t) => {
  const h = open({ answers: { chatOverview: (p) => overview({ channels: [chatChannel({ mention: p.team_id === TEAM, unread: 1 })] }) } });
  t.after(h.restore);
  const changes = [];
  h.chat.subscribe((change) => changes.push(change.type));
  h.chat.sync([snapshot(), memberTeam()]);
  await flush();
  assert.equal(h.chat.mentionCount(), 1);
  push(h, { team_id: OTHER, type: 'channels', partial: true, channels: [chatChannel({ mention: true, unread: 3 })] });
  assert.equal(h.chat.mentionCount(), 2);
  assert.equal(h.chat.channel(OTHER, CHAN).unread, 3);
  const project = { ...chatChannel({ channel_id: 'chan_project_x', kind: 'project', mention: true }) };
  push(h, { team_id: OTHER, type: 'channels', channels: [project] });
  assert.equal(h.chat.channel(OTHER, CHAN), null, 'a whole list replaces');
  assert.equal(h.chat.mentionCount(), 2, 'any channel that mentions you counts');
  push(h, { team_id: TEAM, type: 'cleared' });
  assert.equal(h.chat.team(TEAM), null);
  assert.equal(h.chat.mentionCount(), 1);
  assert.ok(changes.includes('channels') && changes.includes('cleared'));
});

test('a channels push that lands while the overview is out is newer than the overview', async (t) => {
  let answer;
  const h = open({ answers: { chatOverview: () => new Promise((resolve) => { answer = resolve; }) } });
  t.after(h.restore);
  h.chat.sync([snapshot()]);
  await flush();
  push(h, { team_id: TEAM, type: 'channels', channels: [chatChannel({ mention: true, unread: 5 })] });
  answer(overview({ channels: [chatChannel({ unread: 0 })] }));
  await flush();
  assert.equal(h.chat.channel(TEAM, CHAN).unread, 5);
  assert.equal(h.chat.team(TEAM).loaded, true);
});

test('a failed overview is asked again on a later sync, not in a loop', async (t) => {
  let fail = true;
  const h = open({ answers: { chatOverview: () => (fail ? { ok: false, error: { reason: 'team_not_connected' } } : overview()) } });
  t.after(h.restore);
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  h.chat.sync([snapshot()]);
  await flush();
  h.chat.sync([snapshot()]);
  await flush();
  assert.equal(h.sent('chatOverview').length, 1);
  fail = false;
  t.mock.timers.tick(10_001);
  h.chat.sync([snapshot()]);
  await flush();
  assert.equal(h.sent('chatOverview').length, 2);
  assert.equal(h.chat.team(TEAM).loaded, true);
});

test('history: open, older pages with before_seq, pushes merged by id, replies left out, reset replaces', async (t) => {
  const h = open({ answers: {
    chatHistory: (p) => (p.before_seq
      ? { ok: true, messages: [message(1), message(2)], has_more: false, floor_seq: 1 }
      : { ok: true, messages: [message(3), message(4)], has_more: true }),
  } });
  t.after(h.restore);
  h.chat.sync([snapshot()]);
  await flush();
  await h.chat.openChannel(TEAM, CHAN);
  assert.deepEqual(h.sent('chatHistory')[0].payload, { team_id: TEAM, channel_id: CHAN });
  assert.deepEqual(seqs(h), [3, 4]);
  assert.equal(h.chat.timeline(TEAM, CHAN).hasMore, true);
  await h.chat.loadOlder(TEAM, CHAN);
  assert.deepEqual(h.sent('chatHistory')[1].payload, { team_id: TEAM, channel_id: CHAN, before_seq: 3, limit: 50 });
  assert.deepEqual(seqs(h), [1, 2, 3, 4]);
  assert.equal(h.chat.timeline(TEAM, CHAN).hasMore, false);
  push(h, { team_id: TEAM, type: 'messages', channel_id: CHAN, reset: false, messages: [
    message(4, { rev: 9, text: 'edited', edited_at: new Date().toISOString() }), message(5),
    message(6, { thread_root_id: message(3).id }), message(3, { reply_count: 1, rev: 10 })] });
  assert.deepEqual(seqs(h), [1, 2, 3, 4, 5], 'a reply is not a timeline message');
  assert.equal(h.chat.timeline(TEAM, CHAN).list[3].text, 'edited');
  assert.equal(h.chat.timeline(TEAM, CHAN).list[2].reply_count, 1);
  push(h, { team_id: TEAM, type: 'messages', channel_id: CHAN, reset: true, messages: [message(7)] });
  assert.deepEqual(seqs(h), [7]);
});

test('history: an answer built before a push never undoes it (a newer rev stays, a newer message is kept)', async (t) => {
  let release = null;
  const h = open({ answers: { chatHistory: () => new Promise((resolve) => { release = resolve; }) } });
  t.after(h.restore);
  h.chat.sync([snapshot()]);
  await flush();
  const opening = h.chat.openChannel(TEAM, CHAN);
  push(h, { team_id: TEAM, type: 'messages', channel_id: CHAN, reset: false, messages: [message(4, { rev: 9, text: 'edited' }), message(5)] });
  release({ ok: true, messages: [message(3), message(4)], has_more: false });
  await opening;
  assert.deepEqual(seqs(h), [3, 4, 5]);
  assert.equal(h.chat.timeline(TEAM, CHAN).list[1].text, 'edited');
  push(h, { team_id: TEAM, type: 'messages', channel_id: CHAN, reset: false, messages: [message(4, { rev: 2, text: 'older' })] });
  assert.equal(h.chat.timeline(TEAM, CHAN).list[1].text, 'edited', 'an older push does not replace it either');
});

test('trim keeps a window of messages; with the newest trimmed, later messages wait for a reload', async (t) => {
  const many = Array.from({ length: 10 }, (_v, i) => message(i + 1));
  const h = open({ answers: { chatHistory: { ok: true, messages: many, has_more: false } } });
  t.after(h.restore);
  h.chat.sync([snapshot()]);
  await flush();
  await h.chat.openChannel(TEAM, CHAN);
  h.chat.trim(TEAM, CHAN, 'oldest', 6);
  assert.deepEqual(seqs(h), [5, 6, 7, 8, 9, 10]);
  assert.equal(h.chat.timeline(TEAM, CHAN).hasMore, true);
  h.chat.trim(TEAM, CHAN, 'newest', 4);
  assert.deepEqual(seqs(h), [5, 6, 7, 8]);
  assert.equal(h.chat.timeline(TEAM, CHAN).hasNewer, true);
  push(h, { team_id: TEAM, type: 'messages', channel_id: CHAN, reset: false, messages: [message(11), message(6, { rev: 20, text: 'x' })] });
  assert.deepEqual(seqs(h), [5, 6, 7, 8], 'not held past the window');
  assert.equal(h.chat.timeline(TEAM, CHAN).list[1].text, 'x', 'a change inside the window is');
  await h.chat.openChannel(TEAM, CHAN);
  assert.equal(h.chat.timeline(TEAM, CHAN).hasNewer, false);
});

test('outbox, members and presence pushes', async (t) => {
  const h = open();
  t.after(h.restore);
  h.chat.sync([snapshot()]);
  await flush();
  const entry = { entry_id: 'e1', operation: 'post', channel_id: CHAN, thread_root_id: null, message_id: null, text: 'hi', created_at: 1, state: 'queued', error: null };
  push(h, { team_id: TEAM, type: 'outbox', outbox: [entry], settled: [] });
  assert.deepEqual(h.chat.team(TEAM).outbox, [entry]);
  push(h, { team_id: TEAM, type: 'members', members: [chatMember(DOT, 'Dot', { state: 'away' })] });
  assert.equal(h.chat.member(TEAM, DOT).state, 'away');
  push(h, { team_id: TEAM, type: 'presence', member_id: DOT, state: 'offline', last_seen_at: '2026-11-11T09:00:00.000Z' });
  assert.equal(h.chat.member(TEAM, DOT).state, 'offline');
  assert.equal(h.chat.member(TEAM, DOT).last_seen_at, '2026-11-11T09:00:00.000Z');
  push(h, { team_id: TEAM, type: 'presence', member_id: 'member_nobody', state: 'online', last_seen_at: null });
  assert.equal(h.chat.member(TEAM, 'member_nobody'), null);
});

test('mark read goes once per new position and never below the read position; notify sends the level', async (t) => {
  const h = open({ answers: { chatOverview: overview({ channels: [chatChannel({ last_read_seq: 4, last_seq: 9, unread: 5 })] }) } });
  t.after(h.restore);
  h.chat.sync([snapshot()]);
  await flush();
  h.chat.markRead(TEAM, CHAN, 3);
  h.chat.markRead(TEAM, CHAN, 9);
  h.chat.markRead(TEAM, CHAN, 9);
  await flush();
  assert.deepEqual(h.sent('chatMarkRead').map((call) => call.payload), [{ team_id: TEAM, channel_id: CHAN, seq: 9 }]);
  assert.equal(h.chat.channel(TEAM, CHAN).last_read_seq, 9);
  const answer = await h.chat.setNotify(TEAM, CHAN, 'mentions');
  assert.equal(answer.ok, true);
  assert.deepEqual(h.sent('chatSetNotify')[0].payload, { team_id: TEAM, channel_id: CHAN, level: 'mentions' });
  assert.equal(h.chat.channel(TEAM, CHAN).notify, 'mentions');
});

test('pushes are followed only while the store is held', async (t) => {
  const h = harness({ show: false });
  t.after(h.restore);
  assert.equal(h.listeners.chat, null);
  const release = h.chat.use();
  assert.equal(typeof h.listeners.chat, 'function');
  release();
  assert.equal(h.listeners.chat, null);
});

// ---------------------------------------------------------- review round (2a-5a)

const refused = { ok: false, error: { code: 'CMP-TEAM-0007', reason: 'team_chat_rate_limit' } };

// A member team with its overview in, then a fake clock (setTimeout and Date) from 1,000,000 ms.
async function paced(t, answers = {}) {
  const h = open({ answers: { chatOverview: overview({ channels: [chatChannel({ last_read_seq: 0, last_seq: 100, unread: 100 })] }), ...answers } });
  t.after(h.restore);
  h.chat.sync([memberTeam()]);
  await flush();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  return { h, tick: async (ms) => { t.mock.timers.tick(ms); await micro(); } };
}
const readSeqs = (h) => h.sent('chatMarkRead').map((call) => call.payload.seq);

test('read marks are paced: 100 messages in 10 s send at most 6 calls, the last with the newest seq', async (t) => {
  const { h, tick } = await paced(t);
  for (let seq = 1; seq <= 100; seq += 1) {
    void h.chat.markRead(OTHER, CHAN, seq);
    await micro();
    await tick(100);
  }
  await tick(2_000);
  await tick(2_000);
  const sent = readSeqs(h);
  assert.ok(sent.length <= 6, `sent ${sent.length}: ${sent}`);
  assert.equal(sent.at(-1), 100);
  assert.ok(sent.every((seq, i) => i === 0 || seq > sent[i - 1]), 'rising');
});

test('a refused read mark is not sent again for 10 s, whatever asks, then once', async (t) => {
  let refuse = true;
  const { h, tick } = await paced(t, { chatMarkRead: (p) => (refuse ? refused : { ok: true, last_read_seq: p.seq }) });
  void h.chat.markRead(OTHER, CHAN, 5);
  await micro();
  assert.deepEqual(readSeqs(h), [5]);
  refuse = false;
  for (let i = 0; i < 9; i += 1) {
    void h.chat.markRead(OTHER, CHAN, i % 2 ? 5 : 6);
    await tick(1_000);
  }
  assert.deepEqual(readSeqs(h), [5], 'nothing inside 10 s');
  await tick(1_100);
  assert.deepEqual(readSeqs(h), [5, 6], 'once after, with the newest position');
  await tick(20_000);
  assert.deepEqual(readSeqs(h), [5, 6]);
  assert.equal(h.chat.channel(OTHER, CHAN).last_read_seq, 6);
});

test('a pending read mark is dropped with the team (cleared, sync, dispose)', async (t) => {
  const { h, tick } = await paced(t);
  void h.chat.markRead(OTHER, CHAN, 1);
  await micro();
  void h.chat.markRead(OTHER, CHAN, 2);
  push(h, { team_id: OTHER, type: 'cleared' });
  await tick(5_000);
  assert.deepEqual(readSeqs(h), [1]);
});

test('older pages: a failure is not asked again for 10 s, a later page clears it, an empty page ends the history', async (t) => {
  let olderFails = true;
  let olderEmpty = false;
  const h = open({ answers: {
    chatOverview: overview(),
    chatHistory: (p) => {
      if (!p.before_seq) return { ok: true, messages: [5, 6, 7].map((seq) => message(seq)), has_more: true };
      if (olderFails) return refused;
      return { ok: true, messages: olderEmpty ? [] : [message(p.before_seq - 1)], has_more: true };
    },
  } });
  t.after(h.restore);
  h.chat.sync([memberTeam()]);
  await flush();
  await h.chat.openChannel(OTHER, CHAN);
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  await h.chat.loadOlder(OTHER, CHAN);
  assert.ok(h.chat.timeline(OTHER, CHAN).error, 'the failure is said');
  olderFails = false;
  assert.equal(await h.chat.loadOlder(OTHER, CHAN), null, 'not asked inside 10 s');
  assert.equal(h.sent('chatHistory').length, 2);
  t.mock.timers.tick(10_001);
  await h.chat.loadOlder(OTHER, CHAN);
  assert.equal(h.chat.timeline(OTHER, CHAN).error, null, 'a page that comes back clears it');
  assert.deepEqual(seqs(h, OTHER), [4, 5, 6, 7]);
  olderEmpty = true;
  await h.chat.loadOlder(OTHER, CHAN);
  assert.equal(h.chat.timeline(OTHER, CHAN).hasMore, false, 'an ok page that adds nothing is the end');
  assert.equal(await h.chat.loadOlder(OTHER, CHAN), null);
  assert.equal(h.sent('chatHistory').length, 4);
});

test('a partial channels push during the overview is merged over its answer; a full one replaces it', async (t) => {
  const answer = overview({ channels: [chatChannel({ unread: 1 }), chatChannel({ channel_id: 'chan_project_x', unread: 0 })] });
  let resolve = null;
  const h = open({ answers: { chatOverview: () => new Promise((done) => { resolve = done; }) } });
  t.after(h.restore);
  h.chat.sync([memberTeam()]);
  await flush();
  push(h, { team_id: OTHER, type: 'channels', partial: true, channels: [chatChannel({ channel_id: 'chan_project_x', unread: 5, mention: true })] });
  resolve(answer);
  await flush();
  const listed = h.chat.team(OTHER).channels;
  assert.deepEqual(listed.map((c) => c.channel_id).sort(), [CHAN, 'chan_project_x'].sort());
  assert.equal(h.chat.channel(OTHER, 'chan_project_x').unread, 5);
  assert.equal(h.chat.mentionCount(), 1);
  h.chat.sync([]);
  h.chat.sync([memberTeam()]);
  await flush();
  push(h, { team_id: OTHER, type: 'channels', channels: [chatChannel({ channel_id: 'chan_project_y' })] });
  resolve(answer);
  await flush();
  assert.deepEqual(h.chat.team(OTHER).channels.map((c) => c.channel_id), ['chan_project_y'], 'a full list wins');
});

test('cleared forgets the team until the next sync asks again', async (t) => {
  const h = open({ answers: { chatOverview: overview({ channels: [chatChannel({ mention: true })] }) } });
  t.after(h.restore);
  h.chat.sync([memberTeam()]);
  await flush();
  push(h, { team_id: OTHER, type: 'cleared' });
  push(h, { team_id: OTHER, type: 'channels', partial: true, channels: [chatChannel({ mention: true })] });
  assert.equal(h.chat.team(OTHER), null);
  assert.equal(h.chat.mentionCount(), 0);
  h.chat.sync([memberTeam()]);
  await flush();
  assert.equal(h.sent('chatOverview').length, 2);
  assert.equal(h.chat.mentionCount(), 1);
});

// ------------------------------------------------------------------ typing (2a-5b)

const typing = (h, member, team = TEAM) => push(h, { team_id: team, type: 'typing', channel_id: CHAN, thread_root_id: null, member_id: member });

test('typing: an entry per member of the team, gone 6 s after its last push; a refresh moves the expiry only', async (t) => {
  const h = open();
  t.after(h.restore);
  h.chat.sync([snapshot()]);
  await flush();
  push(h, { team_id: TEAM, type: 'typing', channel_id: 'chan_elsewhere', thread_root_id: null, member_id: DOT });
  assert.deepEqual(h.chat.typing(TEAM, 'chan_elsewhere'), [], 'not for a channel this window has not opened');
  await h.chat.openChannel(TEAM, CHAN);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const told = [];
  const stop = h.chat.subscribe((change) => { if (change && change.type === 'typing') told.push(change.channel_id); });
  t.after(stop);
  typing(h, DOT);
  typing(h, 'member_stranger');
  push(h, { team_id: TEAM, type: 'typing', channel_id: CHAN, thread_root_id: 'msg_00000000000000000000000001', member_id: DOT });
  assert.deepEqual(h.chat.typing(TEAM, CHAN), [DOT], 'never someone who is not a member, never a thread');
  t.mock.timers.tick(4_000);
  typing(h, DOT);
  assert.deepEqual(told, [CHAN], 'told once, not on the refresh');
  t.mock.timers.tick(4_000);
  assert.deepEqual(h.chat.typing(TEAM, CHAN), [DOT]);
  t.mock.timers.tick(2_000);
  assert.deepEqual(h.chat.typing(TEAM, CHAN), []);
});

for (const [name, end] of [
  ['cleared', (h) => push(h, { team_id: TEAM, type: 'cleared' })],
  ['closeChannel', (h) => h.chat.closeChannel(TEAM, CHAN)],
  ['dispose', (h) => h.chat.dispose()],
]) {
  test(`typing: the expiry timer is gone after ${name}`, async (t) => {
    const h = open();
    t.after(h.restore);
    h.chat.sync([snapshot()]);
    await flush();
    await h.chat.openChannel(TEAM, CHAN);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const live = liveTimers(t);
    typing(h, DOT);
    assert.equal(live.size, 1, 'one timer');
    end(h);
    assert.equal(live.size, 0);
    assert.deepEqual(h.chat.typing(TEAM, CHAN), []);
  });
}

test('mark unread sends unread with the seq and lets a later read mark through at once', async (t) => {
  const h = open({ answers: { chatOverview: overview({ channels: [chatChannel({ last_seq: 9, last_read_seq: 9 })] }),
    chatMarkRead: (p) => ({ ok: true, last_read_seq: p.unread ? p.seq - 1 : p.seq }) } });
  t.after(h.restore);
  h.chat.sync([snapshot()]);
  await flush();
  const answer = await h.chat.markUnread(TEAM, CHAN, 4);
  assert.equal(answer.ok, true);
  assert.equal(h.chat.channel(TEAM, CHAN).last_read_seq, 3);
  h.chat.markRead(TEAM, CHAN, 9);
  await flush();
  assert.deepEqual(h.sent('chatMarkRead').map((call) => call.payload), [
    { team_id: TEAM, channel_id: CHAN, seq: 4, unread: true }, { team_id: TEAM, channel_id: CHAN, seq: 9 }]);
});


test('a newer page that lands after the newest end was trimmed is dropped: the window stays whole', async (t) => {
  const gate = heldAnswers();
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_v, i) => message(from + i));
  const pages = { 151: { ok: true, messages: range(51, 150), has_more: true }, 51: { ok: true, messages: range(1, 50), has_more: false } };
  const h = open({ answers: { chatOverview: overview({ channels: [chatChannel({ last_seq: 300 })] }),
    chatHistory: (p) => (p.before_seq === 201 ? gate.answer(p) : pages[p.before_seq] || { ok: true, messages: [], has_more: false }) } });
  t.after(h.restore);
  h.chat.sync([snapshot()]);
  await flush();
  await h.chat.openChannel(TEAM, CHAN, 100);
  const newer = h.chat.loadNewer(TEAM, CHAN);
  await h.chat.loadOlder(TEAM, CHAN);
  assert.equal(h.chat.trim(TEAM, CHAN, 'newest', 100), true, 'the timeline trims the newest at its cap');
  gate.release({ ok: true, messages: range(151, 200), has_more: true });
  await newer;
  assert.deepEqual(seqs(h), range(1, 100).map((m) => m.seq));
  assert.equal(h.chat.timeline(TEAM, CHAN).newerAt, 100);
  assert.equal(h.chat.timeline(TEAM, CHAN).hasNewer, true);
});

test('slice 2b-2: the overview\'s reaction_emoji is kept per team for the picker; none until it answers', async (t) => {
  const h = open({ teams: [snapshot(), memberTeam()], answers: { chatOverview: (p) => overview({ reaction_emoji: p.team_id === TEAM ? ['👍', '🎉'] : ['🔥', 7, ''] }) } });
  t.after(h.restore);
  h.chat.sync([snapshot(), memberTeam()]);
  assert.equal(h.chat.emoji(TEAM), null, 'before the overview answers');
  await flush();
  assert.deepEqual(h.chat.emoji(TEAM), ['👍', '🎉']);
  assert.deepEqual(h.chat.emoji(OTHER), ['🔥'], 'text only, per team');
  h.chat.emoji(TEAM).push('x');
  assert.deepEqual(h.chat.emoji(TEAM), ['👍', '🎉'], 'a copy');
  assert.equal(h.chat.emoji('team_nobody'), null);
});

// C9.1: a `reset` push replaces the window, so a page asked for before it describes a window that is gone.
test('C9.1: an older page that lands after a reset push is dropped, and live delivery goes on', async (t) => {
  const gate = heldAnswers();
  const h = open({ answers: { chatOverview: overview({ channels: [chatChannel({ last_seq: 4 })] }),
    chatHistory: (p) => (p.before_seq ? gate.answer(p) : { ok: true, messages: [message(3), message(4)], has_more: true }) } });
  t.after(h.restore);
  h.chat.sync([snapshot()]);
  await flush();
  await h.chat.openChannel(TEAM, CHAN);
  const older = h.chat.loadOlder(TEAM, CHAN);
  push(h, { team_id: TEAM, type: 'messages', channel_id: CHAN, reset: true, messages: [message(10), message(11)] });
  gate.release({ ok: true, messages: [message(1), message(2)], has_more: false, floor_seq: 1 });
  await older;
  assert.deepEqual(seqs(h), [10, 11], 'rows from before the reset are not put in front of the new window');
  push(h, { team_id: TEAM, type: 'messages', channel_id: CHAN, reset: false, messages: [message(12)] });
  assert.deepEqual(seqs(h), [10, 11, 12], 'a live message after the reset is still drawn');
});

test('C9.1: a newer page that lands after a reset push cannot turn live delivery off', async (t) => {
  const gate = heldAnswers();
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_v, i) => message(from + i));
  const h = open({ answers: { chatOverview: overview({ channels: [chatChannel({ last_seq: 100 })] }),
    chatHistory: (p) => (p.before_seq === 121 ? gate.answer(p) : { ok: true, messages: range(1, 70), has_more: false }) } });
  t.after(h.restore);
  h.chat.sync([snapshot()]);
  await flush();
  await h.chat.openChannel(TEAM, CHAN, 20);
  assert.equal(h.chat.timeline(TEAM, CHAN).hasNewer, true, 'a jump leaves the newest unloaded');
  const newer = h.chat.loadNewer(TEAM, CHAN);
  push(h, { team_id: TEAM, type: 'messages', channel_id: CHAN, reset: true, messages: [message(99), message(100)] });
  push(h, { team_id: TEAM, type: 'messages', channel_id: CHAN, reset: false, messages: [message(101)] });
  push(h, { team_id: TEAM, type: 'channels', partial: true, channels: [chatChannel({ last_seq: 101 })] });
  gate.release({ ok: true, messages: range(71, 75), has_more: true });
  await newer;
  assert.deepEqual(seqs(h), [99, 100, 101]);
  assert.equal(h.chat.timeline(TEAM, CHAN).hasNewer, false, 'the reset window holds the newest');
  push(h, { team_id: TEAM, type: 'messages', channel_id: CHAN, reset: false, messages: [message(102)] });
  assert.deepEqual(seqs(h), [99, 100, 101, 102], 'live delivery continues');
});

test('C9.1: a reset that lands while the channel is being opened is the window; the late answer does not undo it', async (t) => {
  const gate = heldAnswers();
  const h = open({ answers: { chatOverview: overview({ channels: [chatChannel({ last_seq: 12 })] }), chatHistory: (p) => gate.answer(p) } });
  t.after(h.restore);
  h.chat.sync([snapshot()]);
  await flush();
  const opening = h.chat.openChannel(TEAM, CHAN);
  push(h, { team_id: TEAM, type: 'messages', channel_id: CHAN, reset: true, messages: [message(11), message(12)] });
  gate.release({ ok: true, messages: [message(1), message(2)], has_more: false });
  await opening;
  assert.deepEqual(seqs(h), [11, 12]);
  assert.equal(h.chat.timeline(TEAM, CHAN).loaded, true, 'the reset window is a loaded one');
});
