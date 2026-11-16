'use strict';

// chatSearch (slice 2a-4c): the host's search page rebuilt from checked fields,
// paged through its opaque cursor, never queued and never cached. A match that
// names a channel outside the cache, an excerpt longer than the host's bound, an
// extra key or a cursor that is not the host's shape makes the answer
// team_chat_answer_invalid; a member who is not online sends nothing. Against
// the real host chat search behind a fake connection manager.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  OTHER, createChatFakeHost, startChats, tempDir, writeMembership,
} = require('./helpers/team-chat-fake-host');

const INVALID = 'team_chat_answer_invalid';

async function setup(t, options = {}) {
  const host = await createChatFakeHost(t);
  const userData = tempDir(t, 'jenny-team-chat-search-');
  const teamId = writeMembership(userData).team_id;
  const started = startChats(t, host, { userData, teamId, ...options });
  return { host, teamId, userData, ...started };
}

const search = (s, payload) => s.chats.handle('chatSearch', { team_id: s.teamId, ...payload });
const searches = (s) => s.manager.calls.filter((call) => call.operation === 'team.chat.search');

test('two pages through the cursor against the real host search', async (t) => {
  const s = await setup(t);
  for (let n = 1; n <= 3; n += 1) await s.host.postAs(OTHER, `the needle number ${n}`);
  await s.host.postAs(OTHER, 'nothing to find here');
  const first = await search(s, { query: 'NEEDLE', limit: 2 });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(Object.keys(first).sort(), ['matches', 'next_cursor', 'ok']);
  assert.deepEqual(first.matches.map((match) => match.excerpt), ['the needle number 3', 'the needle number 2']);
  assert.deepEqual(Object.keys(first.matches[0]).sort(),
    ['author', 'channel_id', 'created_at', 'excerpt', 'message_id', 'root_id', 'seq']);
  assert.equal(typeof first.next_cursor, 'string');
  const second = await search(s, { query: 'NEEDLE', limit: 2, cursor: first.next_cursor });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.matches.map((match) => match.excerpt), ['the needle number 1']);
  assert.equal(second.next_cursor, null);
  assert.deepEqual(searches(s).map((call) => call.params), [
    { query: 'NEEDLE', limit: 2 }, { query: 'NEEDLE', limit: 2, cursor: first.next_cursor },
  ]);
  // Scoped to a channel, with the default page size.
  const scoped = await search(s, { query: 'needle', channel_id: 'chan_team' });
  assert.equal(scoped.matches.length, 3);
  assert.equal(searches(s).at(-1).params.channel_id, 'chan_team');
  assert.equal(s.chats.cacheOf(s.teamId).open.chan_team, undefined, 'a search opens nothing and caches nothing');
});

test('a scoped search for a channel the overview does not list sends nothing', async (t) => {
  const s = await setup(t);
  const answer = await search(s, { query: 'x', channel_id: 'chan_project_ghost' });
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'team_chat_not_found');
  assert.deepEqual(searches(s), []);
});

test('a match outside the cache, an over-long excerpt, an extra key or a bad cursor makes the answer invalid', async (t) => {
  const s = await setup(t);
  await s.host.postAs(OTHER, 'a needle in the team channel');
  const real = await s.host.dispatch(OTHER, 'team.chat.search', { query: 'needle', limit: 20 });
  assert.equal(real.ok, true);
  const match = real.matches[0];
  const hostile = [
    { ...real, matches: [{ ...match, channel_id: 'chan_project_ghost' }] },
    { ...real, matches: [{ ...match, excerpt: 'x'.repeat(201) }] },
    { ...real, matches: [{ ...match, excerpt: '' }] },
    { ...real, matches: [{ ...match, excerpt: 'bell\u0007' }] },
    { ...real, matches: [{ ...match, request_id: 'req_leak' }] },
    { ...real, matches: [{ ...match, author: { kind: 'member', member_id: 'member_x', token: 'leak' } }] },
    { ...real, matches: [{ ...match, seq: 0 }] },
    { ...real, matches: [{ ...match, root_id: '../x' }] },
    { ...real, matches: [{ ...match, created_at: 'now' }] },
    { ...real, next_cursor: 'not a cursor!' },
    { ...real, next_cursor: 'a'.repeat(513) },
    { ...real, matches: Array.from({ length: 21 }, () => match) },
    { ...real, matches: 'leak' },
  ];
  for (const [index, answer] of hostile.entries()) {
    s.manager.hook = async ({ operation }) => (operation === 'team.chat.search' ? answer : null);
    const got = await search(s, { query: 'needle' });
    assert.equal(got.ok, false, `case ${index}: ${JSON.stringify(got)}`);
    assert.equal(got.error.reason, INVALID, `case ${index}`);
    assert.equal(/leak|ghost/u.test(JSON.stringify(got)), false);
  }
  // Fields the page does not define (a request id the host echoed) are rebuilt away, never passed on.
  s.manager.hook = async ({ operation }) => (operation === 'team.chat.search'
    ? { ...real, request_id: 'req_leak', extra: 'leak' } : null);
  const rebuilt = await search(s, { query: 'needle' });
  assert.deepEqual(Object.keys(rebuilt).sort(), ['matches', 'next_cursor', 'ok']);
  assert.equal(JSON.stringify(rebuilt).includes('leak'), false);
  s.manager.hook = null;
  assert.equal((await search(s, { query: 'needle' })).ok, true, 'the real answer passes');
});

test('a host refusal passes as its code and reason only', async (t) => {
  const s = await setup(t);
  s.manager.hook = async ({ operation }) => (operation === 'team.chat.search'
    ? { ok: false, error: { code: 'CMP-HOST-0001', reason: 'team_chat_cursor_invalid', request_id: 'req_leak' } } : null);
  const got = await search(s, { query: 'x', cursor: 'abc' });
  assert.deepEqual(got, { ok: false, error: { code: 'CMP-HOST-0001', reason: 'team_chat_cursor_invalid' } });
});

test('a member who is not online searches nothing', async (t) => {
  for (const state of ['pending', 'reconnecting']) {
    const s = await setup(t);
    s.manager.state = state;
    const got = await search(s, { query: 'needle' });
    assert.equal(got.ok, false, state);
    assert.equal(got.error.reason, 'team_not_connected');
    assert.deepEqual(s.manager.calls, [], `${state}: nothing sent`);
  }
});

test('a scoped search refuses a match from another listed channel', async (t) => {
  const s = await setup(t);
  const created = await s.host.store.createChannel({ channelId: 'chan_project_two' });
  assert.equal(created.ok, true, JSON.stringify(created));
  await s.host.postAs(OTHER, 'a needle in the team channel');
  const listed = await s.chats.handle('chatOverview', { team_id: s.teamId });
  assert.ok(listed.channels.some((channel) => channel.channel_id === 'chan_project_two'), 'the second channel is listed');
  const real = await s.host.dispatch(OTHER, 'team.chat.search', { query: 'needle', limit: 20 });
  const elsewhere = { ...real, matches: [{ ...real.matches[0], channel_id: 'chan_project_two' }] };
  s.manager.hook = async ({ operation }) => (operation === 'team.chat.search' ? elsewhere : null);
  const scoped = await search(s, { query: 'needle', channel_id: 'chan_team' });
  assert.equal(scoped.error?.reason, INVALID, JSON.stringify(scoped));
  const unscoped = await search(s, { query: 'needle' });
  assert.equal(unscoped.ok, true, 'the same page passes unscoped: the channel is listed');
});
