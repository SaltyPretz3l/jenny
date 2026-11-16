'use strict';

// The desktop chat client's resume (slice 2a-4b, TEAM_CHAT_SPEC "Resume after a
// disconnect"), against the real host chat store and dispatcher behind a fake
// connection manager: a channel_rev gap, resync_required and a new boot epoch
// each lead to team.chat.overview, then team.chat.sync from the cached revision,
// paging by the last returned message's rev until `more` is false (set here by
// the host's byte bound), and end with the cache a fresh load gives; a floor
// that passed the oldest cached message drops the channel's cache and reloads
// its latest page; channels that are not open only refresh their counts. A
// failing resync waits for its backoff timer and a successful one is not
// repeated within a second; waiting opens are answered when a resync fails.

const assert = require('node:assert/strict');
const test = require('node:test');

const { hostFailure } = require('../server/api-contract');
const { createChatCache } = require('../services/team/chat-cache');
const { createDeferred } = require('./helpers/deferred');
const {
  ME, OTHER, createChatFakeHost, createManualTimers, settleChats, startChats, tempDir, writeMembership,
} = require('./helpers/team-chat-fake-host');

// A small response bound: the host's byte bound sets `more` and `has_more` after a few messages.
const SMALL_RESPONSES = 4096 + 3072;

async function setup(t, hostOptions = {}) {
  const host = await createChatFakeHost(t, hostOptions);
  const userData = tempDir(t, 'jenny-team-chat-client-');
  const record = writeMembership(userData);
  const teamId = record.team_id;
  const timers = createManualTimers();
  const { chats, manager, pushes, logs } = startChats(t, host, { userData, teamId, timers });
  const open = async (target = chats, channelId = 'chan_team') => {
    const overview = await target.handle('chatOverview', { team_id: teamId });
    assert.equal(overview.ok, true, JSON.stringify(overview));
    const history = await target.handle('chatHistory', { team_id: teamId, channel_id: channelId });
    assert.equal(history.ok, true, JSON.stringify(history));
    return history;
  };
  // A second client for the same member, loaded from scratch: what the resumed cache must equal.
  const fresh = async () => {
    const other = startChats(t, host, { userData, teamId, timers: createManualTimers() }).chats;
    await open(other);
    return other;
  };
  const settle = () => settleChats(chats, teamId, timers);
  return { host, userData, teamId, manager, chats, pushes, logs, timers, open, fresh, settle };
}

const texts = (messages) => messages.map((message) => message.text);

// The resumed cache holds the fresh load's messages as its newest ones, record for record, and the same channel state.
function assertSameAsFresh(resumed, loaded, teamId) {
  const a = resumed.cacheOf(teamId);
  const b = loaded.cacheOf(teamId);
  assert.deepEqual(a.channels, b.channels, 'channel list and counts');
  const mine = a.open.chan_team;
  const theirs = b.open.chan_team;
  assert.ok(theirs.messages.length > 0);
  assert.deepEqual(mine.messages.slice(-theirs.messages.length), theirs.messages, 'newest messages, record for record');
  assert.equal(mine.rev, theirs.rev);
}

function syncCallsAfter(manager, index) {
  return manager.calls.slice(index).filter((call) => call.operation === 'team.chat.sync');
}

test('a channel_rev gap leads to overview, then sync paged until more is false, ending equal to a fresh load', async (t) => {
  const s = await setup(t, { maxResponseBytes: SMALL_RESPONSES });
  for (let n = 0; n < 3; n += 1) await s.host.postAs(OTHER, `early ${n}`);
  await s.open();
  const before = s.chats.cacheOf(s.teamId).open.chan_team.rev;
  s.manager.paused = true;
  const missed = [];
  for (let n = 0; n < 12; n += 1) missed.push(await s.host.postAs(OTHER, `missed ${n}`));
  const firstEarly = s.chats.cacheOf(s.teamId).open.chan_team.messages[0];
  const edited = await s.host.dispatch(OTHER, 'team.chat.edit', { channel_id: 'chan_team', message_id: firstEarly.id,
    text: 'early 0, edited', expected_rev: firstEarly.rev });
  assert.equal(edited.ok, true);
  s.manager.paused = false;
  const mark = s.manager.calls.length;
  await s.host.postAs(OTHER, 'after the gap');
  await s.settle();
  const ops = s.manager.calls.slice(mark).map((call) => call.operation);
  assert.equal(ops[0], 'team.chat.overview', 'the gap asks for a snapshot first');
  const syncs = syncCallsAfter(s.manager, mark);
  assert.ok(syncs.length >= 2 && syncs.length <= 3, `paged sync (${syncs.length} pages)`);
  assert.equal(syncs[0].params.after_rev, before, 'the first page starts at the cached revision');
  for (let i = 1; i < syncs.length; i += 1) {
    assert.ok(syncs[i].params.after_rev > syncs[i - 1].params.after_rev, 'each page starts after the last returned rev');
  }
  const last = await s.host.dispatch(ME, 'team.chat.sync', { channel_id: 'chan_team',
    after_rev: syncs.at(-1).params.after_rev, limit: 200 });
  assert.equal(last.more, false, 'the last page the client asked for was the final one');
  const cache = s.chats.cacheOf(s.teamId).open.chan_team;
  assert.ok(texts(cache.messages).includes('early 0, edited'), 'an edit made while away is applied');
  assert.ok(texts(cache.messages).includes('missed 11') && texts(cache.messages).includes('after the gap'));
  assertSameAsFresh(s.chats, await s.fresh(), s.teamId);
});

test('resync_required leads to overview then sync, ending equal to a fresh load', async (t) => {
  const s = await setup(t, { maxResponseBytes: SMALL_RESPONSES });
  await s.host.postAs(OTHER, 'first');
  await s.open();
  s.manager.paused = true;
  for (let n = 0; n < 12; n += 1) await s.host.postAs(OTHER, `away ${n}`);
  s.manager.paused = false;
  const mark = s.manager.calls.length;
  s.manager.deliver({ event_type: 'resync_required', reason: 'replay_unavailable', cursor: s.host.nextCursor(),
    boot_epoch: s.host.bootEpoch(), api_version: 1 });
  await s.settle();
  const ops = s.manager.calls.slice(mark).map((call) => call.operation);
  assert.equal(ops[0], 'team.chat.overview');
  assert.ok(syncCallsAfter(s.manager, mark).length >= 2, 'paged');
  assertSameAsFresh(s.chats, await s.fresh(), s.teamId);
});

test('a new boot epoch leads to overview then sync, ending equal to a fresh load', async (t) => {
  const s = await setup(t, { maxResponseBytes: SMALL_RESPONSES });
  await s.host.postAs(OTHER, 'first');
  await s.open();
  // One event under the first epoch, so the client knows it.
  await s.host.postAs(OTHER, 'seen');
  await s.chats.idle(s.teamId);
  s.manager.paused = true;
  for (let n = 0; n < 9; n += 1) await s.host.postAs(OTHER, `restart ${n}`);
  s.manager.paused = false;
  s.host.setBootEpoch('boot_two');
  const mark = s.manager.calls.length;
  s.manager.deliver({ event_type: 'team_test_event', cursor: 1, boot_epoch: 'boot_two', api_version: 1 });
  await s.settle();
  assert.equal(s.manager.calls[mark]?.operation, 'team.chat.overview', 'a new epoch asks for a snapshot');
  assert.ok(syncCallsAfter(s.manager, mark).length >= 1);
  assertSameAsFresh(s.chats, await s.fresh(), s.teamId);
});

test('an event for the revision already held (a reply and its root share one) is not a gap', async (t) => {
  const s = await setup(t);
  const root = await s.host.postAs(OTHER, 'root');
  await s.open();
  const mark = s.manager.calls.length;
  await s.host.postAs(OTHER, 'reply', { thread_root_id: root.message_id });
  await s.chats.idle(s.teamId);
  assert.deepEqual(s.manager.calls.slice(mark).map((call) => call.operation), [], 'no resync for the root record');
  const cached = s.chats.cacheOf(s.teamId).open.chan_team.messages;
  assert.equal(cached.find((message) => message.id === root.message_id).reply_count, 1);
  assert.equal(cached.some((message) => message.text === 'reply'), false, 'replies stay out of the timeline cache');
});

test('a floor that passed the oldest cached message drops the cache and loads the latest page', async (t) => {
  const s = await setup(t, { storeLimits: { maxMessages: 3, segmentMaxMessages: 1 } });
  for (let n = 0; n < 3; n += 1) await s.host.postAs(OTHER, `kept ${n}`);
  await s.open();
  assert.deepEqual(texts(s.chats.cacheOf(s.teamId).open.chan_team.messages), ['kept 0', 'kept 1', 'kept 2']);
  s.manager.paused = true;
  for (let n = 0; n < 4; n += 1) await s.host.postAs(OTHER, `newer ${n}`);
  s.manager.paused = false;
  const mark = s.manager.calls.length;
  s.manager.deliver({ event_type: 'resync_required', reason: 'replay_unavailable', cursor: s.host.nextCursor(),
    boot_epoch: s.host.bootEpoch(), api_version: 1 });
  await s.settle();
  const ops = s.manager.calls.slice(mark).map((call) => call.operation);
  assert.equal(ops[0], 'team.chat.overview');
  assert.ok(ops.includes('team.chat.history'), `the latest page is loaded again (${ops.join(', ')})`);
  const cache = s.chats.cacheOf(s.teamId).open.chan_team;
  assert.equal(texts(cache.messages).some((text) => text.startsWith('kept')), false, 'pruned messages are gone');
  assert.ok(cache.messages[0].seq >= s.chats.cacheOf(s.teamId).channels.find((c) => c.channel_id === 'chan_team').floor_seq);
  const reset = s.pushes.filter((push) => push.type === 'messages' && push.reset === true);
  assert.ok(reset.length >= 1, 'the renderer is told the channel was reloaded');
  assertSameAsFresh(s.chats, await s.fresh(), s.teamId);
});

test('a prune event that passes the oldest cached message also reloads the channel', async (t) => {
  const s = await setup(t, { storeLimits: { maxMessages: 2, segmentMaxMessages: 1 } });
  for (let n = 0; n < 2; n += 1) await s.host.postAs(OTHER, `old ${n}`);
  await s.open();
  const mark = s.manager.calls.length;
  await s.host.postAs(OTHER, 'pushes one out');
  await s.chats.idle(s.teamId);
  const ops = s.manager.calls.slice(mark).map((call) => call.operation);
  assert.ok(ops.includes('team.chat.history'), `reloaded (${ops.join(', ')})`);
  assert.equal(texts(s.chats.cacheOf(s.teamId).open.chan_team.messages).includes('old 0'), false);
  assertSameAsFresh(s.chats, await s.fresh(), s.teamId);
});

test('a channel that is not open only refreshes its counts on a resync', async (t) => {
  const s = await setup(t);
  await s.host.store.createChannel({ channelId: 'chan_project_alpha' });
  await s.host.postAs(OTHER, 'team hello');
  await s.open();
  s.manager.paused = true;
  for (let n = 0; n < 3; n += 1) {
    await s.host.dispatch(OTHER, 'team.chat.post', { channel_id: 'chan_project_alpha', text: `project ${n}` });
  }
  s.manager.paused = false;
  const mark = s.manager.calls.length;
  s.manager.deliver({ event_type: 'resync_required', reason: 'replay_unavailable', cursor: s.host.nextCursor(),
    boot_epoch: s.host.bootEpoch(), api_version: 1 });
  await s.settle();
  const calls = s.manager.calls.slice(mark);
  assert.deepEqual(calls.map((call) => call.operation), ['team.chat.overview'], 'no sync or history for a closed channel');
  const project = s.chats.cacheOf(s.teamId).channels.find((channel) => channel.channel_id === 'chan_project_alpha');
  assert.equal(project.unread, 3);
  assert.equal(s.chats.cacheOf(s.teamId).open.chan_project_alpha, undefined);
});

test('live events while online apply in order with no extra request, and counts follow', async (t) => {
  const s = await setup(t);
  await s.host.store.createChannel({ channelId: 'chan_project_beta' });
  await s.open();
  const mark = s.manager.calls.length;
  for (let n = 0; n < 3; n += 1) await s.host.postAs(OTHER, `live ${n}`);
  await s.host.dispatch(OTHER, 'team.chat.post', { channel_id: 'chan_project_beta', text: `hi <@${ME.member_id}>` });
  await s.chats.idle(s.teamId);
  assert.deepEqual(s.manager.calls.slice(mark), []);
  assert.deepEqual(texts(s.chats.cacheOf(s.teamId).open.chan_team.messages), ['live 0', 'live 1', 'live 2']);
  const beta = s.chats.cacheOf(s.teamId).channels.find((channel) => channel.channel_id === 'chan_project_beta');
  assert.equal(beta.unread, 1);
  assert.equal(beta.mention, true);
  const pushed = s.pushes.filter((push) => push.type === 'messages' && push.channel_id === 'chan_team');
  assert.deepEqual(pushed.flatMap((push) => texts(push.messages)).slice(-3), ['live 0', 'live 1', 'live 2']);
});

// ---------------------------------------------------------------- resync pacing and waiting opens

const overviews = (manager) => manager.calls.filter((call) => call.operation === 'team.chat.overview').length;
// A host refusal answered on a later turn of the event loop, so a resync loop that never waits cannot starve timers.
const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const refuseLater = async () => {
  await tick();
  return hostFailure('unavailable', 'team_unavailable');
};
async function within(promise, ms = 1500) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('still waiting'), ms); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}
const resyncRequired = (s) => s.manager.deliver({ event_type: 'resync_required', reason: 'replay_unavailable',
  cursor: s.host.nextCursor(), boot_epoch: s.host.bootEpoch(), api_version: 1 });

test('a failing resync waits for its backoff timer: one overview per timer fire', async (t) => {
  const s = await setup(t);
  s.manager.hook = ({ operation }) => (operation === 'team.chat.overview' ? refuseLater() : null);
  const answer = await s.chats.handle('chatOverview', { team_id: s.teamId });
  assert.equal(answer.ok, false);
  await s.chats.idle(s.teamId);
  assert.equal(overviews(s.manager), 1, 'one overview before the first timer');
  for (let fire = 1; fire <= 3; fire += 1) {
    assert.equal(s.timers.fire(), 1, 'one resync timer at a time');
    await s.chats.idle(s.teamId);
    assert.equal(overviews(s.manager), 1 + fire, `one overview per fire (${fire})`);
  }
  const delays = s.timers.delays.slice(-3);
  assert.ok(delays[0] < delays[1] && delays[1] < delays[2], `the backoff grows (${delays})`);
});

test('a resync is not repeated within a second of a successful one; the timer runs it', async (t) => {
  const s = await setup(t);
  await s.open();
  const before = overviews(s.manager);
  resyncRequired(s);
  await s.chats.idle(s.teamId);
  assert.equal(overviews(s.manager), before, 'held by the floor');
  assert.equal(s.timers.pending(), 1);
  assert.ok(s.timers.delays.at(-1) <= 1000);
  s.timers.fire();
  await s.chats.idle(s.teamId);
  assert.equal(overviews(s.manager), before + 1);
});

test('a channel waiting to open is answered when the resync before it fails', async (t) => {
  const s = await setup(t);
  await s.host.store.createChannel({ channelId: 'chan_project_alpha' });
  assert.equal((await s.chats.handle('chatOverview', { team_id: s.teamId })).ok, true);
  s.manager.hook = ({ operation }) => (operation === 'team.chat.overview' ? refuseLater() : null);
  resyncRequired(s);
  await s.chats.idle(s.teamId);
  const open = () => s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: 'chan_project_alpha' });
  const waiting = open();
  await s.chats.idle(s.teamId);
  assert.equal(s.timers.fire(), 1, 'the resync waits on its timer');
  const answer = await within(waiting);
  assert.notEqual(answer, 'still waiting', 'the open is answered, not left waiting');
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'team_unavailable');
  const during = await within(open());
  assert.equal(during.ok, false, 'an open during the backoff is answered at once');
  assert.equal(s.manager.calls.filter((call) => call.operation === 'team.chat.history').length, 0);
});

test('a channel whose load throws answers its waiters with a failure', async (t) => {
  const s = await setup(t);
  s.manager.hook = ({ operation }) => {
    if (operation === 'team.chat.history') throw new Error('lost');
    return null;
  };
  assert.equal((await s.chats.handle('chatOverview', { team_id: s.teamId })).ok, true);
  const answer = await within(s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: 'chan_team' }));
  assert.notEqual(answer, 'still waiting', 'the open is answered, not left waiting');
  assert.equal(answer.ok, false);
});

// ---------------------------------------------------------------- revisions the cache does not hold

test('a live event never advances an opened channel past revisions it does not hold', async (t) => {
  const s = await setup(t);
  for (let n = 0; n < 5; n += 1) await s.host.postAs(OTHER, `held ${n}`);
  const overview = await s.host.dispatch(ME, 'team.chat.overview', {});
  const page = await s.host.dispatch(ME, 'team.chat.history', { channel_id: 'chan_team', limit: 100 });
  const cache = createChatCache({ memberId: ME.member_id });
  assert.equal(cache.setOverview(overview.channels), true);
  const stalePage = { ...page, messages: page.messages.filter((message) => message.rev <= 3), channel_rev: 3 };
  assert.equal(cache.openChannel('chan_team', stalePage), true);
  const posted = await s.host.postAs(OTHER, 'live');
  const record = (await s.host.dispatch(ME, 'team.chat.history', { channel_id: 'chan_team', limit: 1 })).messages[0];
  const applied = cache.applyMessage({ channel_id: 'chan_team', channel_rev: posted.rev, message: record });
  assert.equal(applied.status, 'applied');
  assert.equal(cache.cached('chan_team').rev, 3, 'revisions 4 and 5 are still owed a sync');
});

test('a channel opened from a stale page whose catch-up sync fails resyncs and ends equal to a fresh load', async (t) => {
  const s = await setup(t);
  for (let n = 0; n < 5; n += 1) await s.host.postAs(OTHER, `before ${n}`);
  let stale = true;
  let failSync = true;
  s.manager.hook = async ({ operation, dispatch }) => {
    if (operation === 'team.chat.history' && stale) {
      stale = false;
      const page = await dispatch();
      return { ...page, messages: page.messages.filter((message) => message.rev <= 3), channel_rev: 3 };
    }
    if (operation === 'team.chat.sync' && failSync) {
      failSync = false;
      return hostFailure('unavailable', 'team_unavailable');
    }
    return null;
  };
  await s.open();
  await s.host.postAs(OTHER, 'live');
  await s.settle();
  assertSameAsFresh(s.chats, await s.fresh(), s.teamId);
});

test('a channel needing more than three sync pages is reloaded from its latest page instead', async (t) => {
  const s = await setup(t, { maxResponseBytes: SMALL_RESPONSES });
  await s.host.postAs(OTHER, 'first');
  await s.open();
  s.manager.paused = true;
  // Long messages fill the small response bound after a few, so 15 of them need more than three pages.
  for (let n = 0; n < 15; n += 1) await s.host.postAs(OTHER, `far ${n} ${'x'.repeat(1500)}`);
  s.manager.paused = false;
  const mark = s.manager.calls.length;
  resyncRequired(s);
  await s.settle();
  const ops = s.manager.calls.slice(mark).map((call) => call.operation);
  assert.equal(syncCallsAfter(s.manager, mark).length, 3, `three pages at most (${ops.join(', ')})`);
  assert.equal(ops.at(-1), 'team.chat.history', 'then the latest page');
  assertSameAsFresh(s.chats, await s.fresh(), s.teamId);
});

const alpha = (s) => ({ team_id: s.teamId, channel_id: 'chan_project_alpha' });
// A post hook that holds every post on one gate, so a send stays in flight until the test opens it.
function holdPosts(s) {
  const gate = createDeferred();
  s.manager.hook = async ({ operation }) => { if (operation === 'team.chat.post') await gate.promise; return null; };
  return gate.resolve;
}
const queuePost = (s, text) => s.chats.handle('chatPost', { team_id: s.teamId, channel_id: 'chan_team', text });

test('a channel open parked behind the resync floor answers team_not_connected when the member goes offline', async (t) => {
  const s = await setup(t);
  await s.host.store.createChannel({ channelId: 'chan_project_alpha' });
  assert.equal((await s.chats.handle('chatOverview', { team_id: s.teamId })).ok, true);
  resyncRequired(s);
  await s.chats.idle(s.teamId);
  assert.equal(s.timers.pending(), 1, 'the floor timer is armed');
  const waiting = s.chats.handle('chatHistory', alpha(s));
  await s.chats.idle(s.teamId);
  s.manager.setState('reconnecting');
  const answer = await within(waiting);
  assert.notEqual(answer, 'still waiting', 'the open is answered, not left waiting for a reconnect');
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'team_not_connected');
});

test('a channel open parked while the loop sends answers team_not_connected when the member goes offline', async (t) => {
  const s = await setup(t);
  await s.host.store.createChannel({ channelId: 'chan_project_alpha' });
  assert.equal((await s.chats.handle('chatOverview', { team_id: s.teamId })).ok, true);
  const release = holdPosts(s);
  t.after(release);
  assert.equal((await queuePost(s, 'in flight')).ok, true);
  await tick();
  assert.equal(s.manager.ops().filter((op) => op === 'team.chat.post').length, 1, 'the send is in flight');
  const waiting = s.chats.handle('chatHistory', alpha(s));
  await tick();
  s.manager.setState('reconnecting');
  const answer = await within(waiting);
  assert.notEqual(answer, 'still waiting', 'the open is answered while the send is still held');
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'team_not_connected');
  release();
});

test('the overview and a history read of an open channel do not wait for a send in flight', async (t) => {
  const s = await setup(t);
  await s.open();
  const release = holdPosts(s);
  t.after(release);
  assert.equal((await queuePost(s, 'slow')).ok, true);
  await tick();
  const overview = await within(s.chats.handle('chatOverview', { team_id: s.teamId }));
  assert.notEqual(overview, 'still waiting', 'the overview does not wait for the post');
  assert.equal(overview.ok, true);
  assert.equal(overview.outbox.length, 1, 'the queued post is listed');
  const history = await within(s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: 'chan_team' }));
  assert.notEqual(history, 'still waiting', 'a read of an open channel does not wait for the post');
  assert.equal(history.ok, true);
  release();
});

test('opening a channel waits for the send in flight only: it reaches the host before the next queued post', async (t) => {
  const s = await setup(t);
  await s.host.store.createChannel({ channelId: 'chan_project_alpha' });
  assert.equal((await s.chats.handle('chatOverview', { team_id: s.teamId })).ok, true);
  const release = holdPosts(s);
  t.after(release);
  await queuePost(s, 'first');
  await queuePost(s, 'second');
  await tick();
  const waiting = s.chats.handle('chatHistory', alpha(s));
  await tick();
  release();
  const answer = await within(waiting);
  assert.notEqual(answer, 'still waiting');
  assert.equal(answer.ok, true, JSON.stringify(answer));
  await s.chats.idle(s.teamId);
  const ops = s.manager.ops();
  const open = ops.indexOf('team.chat.history');
  const posts = ops.map((op, at) => (op === 'team.chat.post' ? at : -1)).filter((at) => at >= 0);
  assert.equal(posts.length, 2);
  assert.ok(posts[0] < open && open < posts[1], `the open sits between the two posts (${ops.join(',')})`);
});

test('a first-page read of a channel whose reload is owed waits for that reload and not for the outbox', async (t) => {
  const s = await setup(t, { storeLimits: { maxMessages: 2, segmentMaxMessages: 1 } });
  for (let n = 0; n < 2; n += 1) await s.host.postAs(OTHER, `old ${n}`);
  await s.open();
  const reload = createDeferred();
  const post = createDeferred();
  t.after(() => { reload.resolve(); post.resolve(); });
  s.manager.hook = async ({ operation }) => {
    if (operation === 'team.chat.history') await reload.promise;
    if (operation === 'team.chat.post') await post.promise;
    return null;
  };
  await s.host.postAs(OTHER, 'pushes one out');
  await tick();
  await tick();
  assert.equal(s.manager.ops().filter((op) => op === 'team.chat.history').length >= 2, true, 'the reload is in flight');
  assert.equal((await queuePost(s, 'queued behind it')).ok, true);
  const read = s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: 'chan_team' });
  assert.equal(await within(read, 150), 'still waiting', 'the read waits for the reload');
  reload.resolve();
  const answer = await within(read);
  assert.notEqual(answer, 'still waiting', 'and not for the queued post, which is still held');
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(texts(answer.messages).includes('old 0'), false, 'no message below the floor');
  assert.deepEqual(texts(answer.messages), ['old 1', 'pushes one out']);
  post.resolve();
});

test('a first-page read waiting for its reload is answered when the reload fails or the member goes offline', async (t) => {
  const s = await setup(t, { storeLimits: { maxMessages: 2, segmentMaxMessages: 1 } });
  for (let n = 0; n < 2; n += 1) await s.host.postAs(OTHER, `old ${n}`);
  await s.open();
  const reload = createDeferred();
  t.after(() => reload.resolve());
  s.manager.hook = async ({ operation }) => (operation === 'team.chat.history' ? reload.promise : null);
  await s.host.postAs(OTHER, 'pushes one out');
  await tick();
  await tick();
  const read = s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: 'chan_team' });
  await tick();
  s.manager.setState('reconnecting');
  const answer = await within(read);
  assert.notEqual(answer, 'still waiting', 'answered when the member goes offline');
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'team_not_connected');
  reload.resolve();
});

test('the first chat read after start does not wait for a queued post whose send hangs', async (t) => {
  const s = await setup(t);
  const release = holdPosts(s);
  t.after(release);
  assert.equal((await queuePost(s, 'hangs')).ok, true);
  const searching = s.chats.handle('chatSearch', { team_id: s.teamId, query: 'nothing here' });
  const answer = await within(searching);
  assert.notEqual(answer, 'still waiting', 'the search answers once the snapshot is in');
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(s.manager.ops().filter((op) => op === 'team.chat.post').length, 1, 'the post is still in flight');
  release();
});

test('parked opens answer plain team_not_connected when the member goes offline, whatever the last resync failure was', async (t) => {
  const s = await setup(t);
  await s.host.store.createChannel({ channelId: 'chan_project_alpha' });
  assert.equal((await s.chats.handle('chatOverview', { team_id: s.teamId })).ok, true);
  const release = holdPosts(s);
  t.after(release);
  await queuePost(s, 'in flight');
  await tick();
  const waiting = s.chats.handle('chatHistory', alpha(s));
  await tick();
  s.manager.setState('reconnecting');
  const answer = await within(waiting);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'team_not_connected');
  release();
});

test('a channel with a reload owed that left the open set is opened by an ordinary open, not answered not found', async (t) => {
  const s = await setup(t, { storeLimits: { maxMessages: 2, segmentMaxMessages: 1 } });
  for (let n = 0; n < 2; n += 1) await s.host.postAs(OTHER, `old ${n}`);
  const others = Array.from({ length: 8 }, (_, n) => `chan_project_c${n}`);
  for (const channelId of others) await s.host.store.createChannel({ channelId });
  await s.open();
  const opened = async (channelId) => (await s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: channelId })).ok;
  for (const channelId of others.slice(0, 7)) assert.equal(await opened(channelId), true);
  // chan_team is now the oldest of the eight open channels; the ninth open pushes it out while a reload is owed.
  const gate = createDeferred();
  t.after(() => gate.resolve());
  s.manager.hook = async ({ operation, params }) => {
    if (operation === 'team.chat.history' && params.channel_id === others[7]) await gate.promise;
    return null;
  };
  const ninth = s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: others[7] });
  await tick();
  await s.host.postAs(OTHER, 'pushes one out');
  await tick();
  await tick();
  const mark = s.manager.calls.length;
  const plain = s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: 'chan_team' });
  await tick();
  gate.resolve();
  assert.equal((await within(ninth)).ok, true);
  const answer = await within(plain);
  assert.notEqual(answer, 'still waiting');
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(texts(answer.messages), ['old 1', 'pushes one out']);
  const sent = s.manager.calls.slice(mark).filter((call) => call.operation === 'team.chat.history' && call.params.channel_id === 'chan_team');
  assert.equal(sent.length, 1, 'one history command for it');
});
