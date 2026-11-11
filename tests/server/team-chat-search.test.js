'use strict';

// Slice 2a-3b: team.chat.search through the real router, authorizer and
// operation registry, the real team commands and a real chat store. Bounds
// (clock, scan count, yields) are injected; nothing waits on wall time.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { encodeCursor, queryDigest } = require('../../services/host/team-chat-search');
const { createTeamChatCommandsFixture } = require('./helpers/team-chat-commands-fixture');
const { turn } = require('./helpers/team-chat-timers');

const DM = `chan_dm_${'a'.repeat(64)}`;
const search = (f, seat, params) => f.send(seat, 'team.chat.search', { limit: 50, ...params });
const withoutRequestId = (answer) => {
  assert.equal(answer.ok, false);
  const { request_id: requestId, ...rest } = answer.error;
  assert.match(requestId, /^request_\d+$/u);
  return rest;
};

// Every page of one search, following `next_cursor` until it is null.
async function allPages(f, seat, params) {
  const pages = [];
  let cursor;
  for (let guard = 0; guard < 200; guard += 1) {
    const answer = await search(f, seat, { ...params, ...(cursor ? { cursor } : {}) });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    pages.push(answer);
    if (answer.next_cursor === null) return pages;
    cursor = answer.next_cursor;
  }
  throw new Error('search did not finish');
}

test('search finds replies, leaves out deleted messages, answers newest first with a bounded excerpt', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  const root = await f.post(alice, 'The Needle is here');
  const reply = await f.post(bob, `a reply with a needle ${'x'.repeat(400)}`, { thread_root_id: root.message_id });
  const gone = await f.post(alice, 'a deleted needle');
  await f.send(alice, 'team.chat.delete', { channel_id: 'chan_team', message_id: gone.message_id });
  await f.post(alice, 'nothing to see');
  const long = await f.post(bob, `${'a'.repeat(1000)}NEEDLE${'b'.repeat(1000)}`);

  const answer = await search(f, alice, { query: 'needle' });
  assert.equal(answer.ok, true);
  assert.equal(answer.next_cursor, null);
  assert.deepEqual(answer.matches.map((match) => match.seq), [long.seq, reply.seq, root.seq], 'newest first');
  const [first, second, third] = answer.matches;
  assert.deepEqual(Object.keys(first).sort(),
    ['author', 'channel_id', 'created_at', 'excerpt', 'message_id', 'root_id', 'seq']);
  assert.equal(first.excerpt.length, 200);
  assert.match(first.excerpt, /^a+NEEDLEb+$/u, 'the excerpt is centred on the match');
  assert.ok(second.excerpt.length <= 200 && second.excerpt.includes('needle'));
  assert.equal(second.root_id, root.message_id, 'a reply names its root');
  assert.deepEqual(second.author, { kind: 'member', member_id: bob.member_id });
  assert.equal(third.root_id, null);
  assert.equal(third.excerpt, 'The Needle is here');
  assert.equal(third.message_id, root.message_id);
});

test('the clock budget ends a call with a cursor that continues without a gap or a repeat', async (t) => {
  let now = 0;
  const yields = [];
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 5 },
    searchOptions: { clock: () => { now += 60; return now; }, yieldTo: async () => { yields.push(now); } } });
  const { alice, bob } = f.seats;
  const expected = [];
  for (let i = 0; i < 40; i += 1) {
    const posted = await f.post(i % 2 ? bob : alice, i % 2 ? `hit ${i}` : `miss ${i}`);
    if (i % 2) expected.unshift(posted.seq);
  }
  const pages = await allPages(f, alice, { query: 'HIT' });
  assert.ok(pages.length > 1, 'the budget ended at least one call early');
  assert.ok(pages[0].matches.length < expected.length);
  const seqs = pages.flatMap((page) => page.matches.map((match) => match.seq));
  assert.deepEqual(seqs, expected, 'every match once, newest first, across pages');
  assert.ok(yields.length > 0, 'the scan yields between segments');
});

test('the message count bounds a call when the clock never runs out', async (t) => {
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 5 },
    searchOptions: { scanMax: 5 } });
  for (let i = 0; i < 20; i += 1) await f.post(f.seats.alice, `entry ${i}`);
  const pages = await allPages(f, f.seats.bob, { query: 'entry' });
  assert.equal(pages.length, 4, 'five messages a call, one segment each');
  assert.equal(pages.flatMap((page) => page.matches).length, 20);
});

test('a search yields between segments, so another request is answered meanwhile', async (t) => {
  const gates = [];
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 5 },
    searchOptions: { yieldTo: () => new Promise((resolve) => { gates.push(resolve); }) } });
  for (let i = 0; i < 20; i += 1) await f.post(f.seats.alice, `line ${i}`);
  let done = false;
  const pending = search(f, f.seats.alice, { query: 'absent' }).then((answer) => { done = true; return answer; });
  for (let i = 0; i < 20 && gates.length === 0; i += 1) await turn();
  assert.equal(gates.length, 1, 'the scan is parked at its first yield');
  const other = await f.send(f.seats.bob, 'team.chat.history', { channel_id: 'chan_team', limit: 5 });
  assert.equal(other.ok, true, 'answered while the search waits');
  assert.equal(done, false);
  while (!done) {
    gates.shift()?.();
    await turn();
  }
  assert.deepEqual(await pending, { ok: true, matches: [], next_cursor: null });
});

test('an edit or a prune between two pages leaves no gap and no repeat', async (t) => {
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 5, maxAgeMs: 60_000 } });
  const { alice, bob } = f.seats;
  for (let i = 0; i < 10; i += 1) await f.post(bob, `old hit ${i}`);
  f.fx.advance(50_000);
  const fresh = [];
  for (let i = 0; i < 10; i += 1) fresh.push(await f.post(alice, `new hit ${i}`));
  const first = await search(f, alice, { query: 'hit', limit: 3 });
  assert.deepEqual(first.matches.map((match) => match.seq), [fresh[9].seq, fresh[8].seq, fresh[7].seq]);
  // Between pages: one older match edited away, one edited but still matching, the old segments pruned.
  const edit = async (posted, text) => {
    const answer = await f.send(alice, 'team.chat.edit', { channel_id: 'chan_team', message_id: posted.message_id,
      text, expected_rev: posted.rev });
    assert.equal(answer.ok, true);
  };
  await edit(fresh[4], 'no longer matching');
  await edit(fresh[5], 'new hit 5, edited');
  const before = f.chat.store.channelInfo('chan_team').floor_seq;
  f.fx.advance(30_000);
  await f.chat.runRetention();
  assert.ok(f.chat.store.channelInfo('chan_team').floor_seq > before, 'the old segments were pruned');

  const rest = (await allPages(f, alice, { query: 'hit', limit: 3, cursor: first.next_cursor }))
    .flatMap((page) => page.matches.map((match) => match.seq));
  const current = (await search(f, alice, { query: 'hit' })).matches.map((match) => match.seq);
  const last = first.matches.at(-1).seq;
  assert.deepEqual(rest, current.filter((seq) => seq < last), 'exactly the live matches older than the cursor');
  assert.equal(rest.includes(fresh[4].seq), false);
  assert.equal(rest.includes(fresh[5].seq), true);
});

test('an unscoped search spans the visible channels in order; a scoped one stays in its channel', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice } = f.seats;
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_alpha' })).ok, true);
  const inTeam = await f.post(alice, 'hit in team');
  const inProject = await f.send(alice, 'team.chat.post', { channel_id: 'chan_project_alpha', text: 'hit in project' });
  assert.equal(inProject.ok, true);
  const all = await search(f, alice, { query: 'hit' });
  assert.deepEqual(all.matches.map((match) => [match.channel_id, match.seq]),
    [['chan_team', inTeam.seq], ['chan_project_alpha', inProject.seq]]);
  const scoped = await search(f, alice, { query: 'hit', channel_id: 'chan_project_alpha' });
  assert.deepEqual(scoped.matches.map((match) => match.channel_id), ['chan_project_alpha']);
  const paged = (await allPages(f, alice, { query: 'hit', limit: 1 })).flatMap((page) => page.matches);
  assert.deepEqual(paged.map((match) => match.channel_id), ['chan_team', 'chan_project_alpha']);
});

test('a direct or unknown channel, or a cursor naming one, answers team_chat_not_found and reveals nothing', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, owner } = f.seats;
  await f.post(alice, 'secret needle text');
  const unknown = withoutRequestId(await search(f, alice, { query: 'needle', channel_id: 'chan_project_nope' }));
  assert.deepEqual(unknown, { code: 'CMP-HOST-0003', reason: 'team_chat_not_found', retryable: false });
  for (const seat of [alice, owner]) {
    assert.deepEqual(withoutRequestId(await search(f, seat, { query: 'needle', channel_id: DM })), unknown);
    // A well-formed cursor (the right digest) that names a channel the actor cannot see.
    const forged = encodeCursor(DM, 0, queryDigest('needle', undefined));
    const answer = await search(f, seat, { query: 'needle', cursor: forged });
    assert.deepEqual(withoutRequestId(answer), unknown);
    assert.equal(JSON.stringify(answer).includes('secret'), false);
  }
});

test('a malformed cursor is refused before any channel is read', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice } = f.seats;
  await f.post(alice, 'needle');
  const raw = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const digest = queryDigest('needle', undefined);
  const malformed = [
    raw({ v: 1 }),
    raw({ v: 2, c: 'chan_team', b: 0, h: digest }),
    raw({ v: 1, c: 'chan_team', b: -1, h: digest }),
    raw({ v: 1, c: 'chan_team', b: 1.5, h: digest }),
    raw({ v: 1, c: 'chan_team', b: 0, h: digest, extra: true }),
    raw({ v: 1, c: 'not_a_channel', b: 0, h: digest }),
    raw(['chan_team', 0]),
    encodeCursor('chan_team', 0, queryDigest('other query', undefined)),
    'AAAA',
  ];
  for (const cursor of malformed) {
    const answer = await search(f, alice, { query: 'needle', cursor });
    assert.deepEqual(withoutRequestId(answer), { code: 'CMP-HOST-0001', reason: 'team_chat_cursor_invalid',
      retryable: false }, cursor);
  }
  f.fx.advance(10_000); // past the search rate limit
  // A cursor for another scope does not continue this one.
  const teamCursor = encodeCursor('chan_team', 0, queryDigest('needle', 'chan_team'));
  assert.equal((await search(f, alice, { query: 'needle', channel_id: 'chan_team', cursor: teamCursor })).ok, true);
  const otherScope = await search(f, alice, { query: 'needle', channel_id: 'chan_project_x', cursor: teamCursor });
  assert.equal(otherScope.error.reason, 'team_chat_cursor_invalid');
  const schema = await search(f, alice, { query: 'needle', cursor: 'not base64!' });
  assert.equal(schema.error.reason, 'invalid_command_parameters');
});

test('the rate limit refuses the eleventh search in 10 s; no query reaches a log', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  await f.post(alice, 'findable');
  for (let i = 0; i < 10; i += 1) assert.equal((await search(f, alice, { query: 'query-secret-one' })).ok, true, `${i}`);
  const refused = await search(f, alice, { query: 'query-secret-one' });
  assert.deepEqual(withoutRequestId(refused), { code: 'CMP-HOST-0007', reason: 'team_chat_rate_limit', retryable: false });
  assert.equal((await search(f, bob, { query: 'query-secret-two' })).ok, true, 'the limit is per member');
  f.fx.advance(10_000);
  assert.equal((await search(f, alice, { query: 'findable' })).matches.length, 1);
  const logs = JSON.stringify(f.fx.logs);
  for (const secret of ['query-secret', 'findable']) assert.equal(logs.includes(secret), false, secret);
});

// ------------------------------------------------------------ review round (slice 2a-3b)

test('an unscoped search answers a transient read failure instead of a partial result', async (t) => {
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 2 } });
  const { alice } = f.seats;
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_alpha' })).ok, true);
  await f.post(alice, 'hit in team');
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await f.send(alice, 'team.chat.post', { channel_id: 'chan_project_alpha', text: `hit ${i}` })).ok, true);
  }
  const store = f.chat.store;
  const original = store._readSegment;
  store._readSegment = function busy(channelId, n) {
    if (channelId === 'chan_project_alpha') throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return original.call(this, channelId, n);
  };
  const answer = await search(f, alice, { query: 'hit' });
  assert.equal(answer.ok, false, 'not a complete answer with one channel missing');
  assert.equal(answer.error.reason, 'team_chat_store_failed');
  assert.equal(store.brokenReason(), null, 'a transient failure latches nothing');
  store._readSegment = original;
  const again = await search(f, alice, { query: 'hit' });
  assert.equal(again.matches.length, 6, 'the retry finds every match');
});

test('an unscoped search passes over a channel the store reports broken before the scan', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice } = f.seats;
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_alpha' })).ok, true);
  const inTeam = await f.post(alice, 'hit in team');
  assert.equal((await f.send(alice, 'team.chat.post', { channel_id: 'chan_project_alpha', text: 'hit' })).ok, true);
  // As a corrupt segment leaves it: this channel only answers its reason.
  f.chat.store._channels.get('chan_project_alpha').broken = 'team_chat_store_failed';
  const answer = await search(f, alice, { query: 'hit' });
  assert.deepEqual([answer.ok, answer.next_cursor], [true, null]);
  assert.deepEqual(answer.matches.map((match) => match.seq), [inTeam.seq]);
  const scoped = await search(f, alice, { query: 'hit', channel_id: 'chan_project_alpha' });
  assert.equal(scoped.error.reason, 'team_chat_store_failed', 'a scoped search answers the channel\'s failure');
});

test('one search runs at a time host-wide, first come first served, with at most 8 waiting', async (t) => {
  const gates = [];
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 5 },
    searchOptions: { yieldTo: () => new Promise((resolve) => { gates.push(resolve); }) } });
  const { alice, bob, owner, rae } = f.seats;
  for (let i = 0; i < 10; i += 1) await f.post(alice, `line ${i}`);
  const finished = [];
  const start = (seat, label) => search(f, seat, { query: 'absent' })
    .then((answer) => { finished.push(label); return answer; });
  const first = start(alice, 'first');
  for (let i = 0; i < 20 && gates.length === 0; i += 1) await turn();
  assert.equal(gates.length, 1, 'the first search is parked between segments');
  const seats = [bob, bob, bob, owner, owner, owner, rae, rae];
  const waiting = seats.map((seat, i) => start(seat, `waiting ${i}`));
  for (let i = 0; i < 10; i += 1) await turn();
  assert.equal(gates.length, 1, 'nobody else scans while one search runs');
  const ninth = search(f, rae, { query: 'absent' });
  const refused = await Promise.race([ninth, (async () => { for (let i = 0; i < 50; i += 1) await turn(); return 'pending'; })()]);
  assert.notEqual(refused, 'pending', 'the ninth waiter is answered at once');
  assert.equal(f.reasonOf(refused), 'team_chat_rate_limit', 'the ninth waiter is refused');
  while (finished.length < 9) {
    gates.shift()?.();
    await turn();
  }
  assert.deepEqual(finished, ['first', ...seats.map((_, i) => `waiting ${i}`)], 'answered in arrival order');
  for (const answer of [await first, ...(await Promise.all(waiting))]) assert.equal(answer.ok, true);
  let after = null;
  const next = search(f, rae, { query: 'line 3' }).then((answer) => { after = answer; });
  while (after === null) {
    gates.shift()?.();
    await turn();
  }
  await next;
  assert.equal(after.matches.length, 1, 'the queue drained: a later search runs');
});

test('the 250 ms budget starts after the channel load, so a cold first call scans', async (t) => {
  let now = 0;
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 5 },
    searchOptions: { clock: () => now },
    // Each step of the stepwise first load costs a second on the search clock.
    storeYield: async () => { now += 1_000; } });
  for (let i = 0; i < 20; i += 1) await f.post(f.seats.alice, `entry ${i}`);
  const store = f.chat.store;
  store._forgetWrite(path.join(store.dir, 'chan_team', 'channel.json')); // the channel is cold again
  const answer = await search(f, f.seats.bob, { query: 'entry' });
  assert.ok(now >= 3_000, 'the load ran on the search clock');
  assert.equal(answer.next_cursor, null, 'the budget was not spent on the load');
  assert.equal(answer.matches.length, 20);
});
