'use strict';

// The desktop chat client's outbox (slice 2a-4b): chat mutations queue on this
// PC in order, one request id each, and send after a sync. A retry reuses the
// entry's request id, so a post whose answer was lost is answered from the
// host's idempotency record and appears once; team_chat_rate_limit and
// disk_pressure are retried with the same id under a bounded backoff; a refusal
// that will never succeed fails the entry and is reported; nothing but the
// team.chat.* mutations is ever resent; entries survive a restart in
// client.json and send after the next sync. A failed write after an answer
// holds the entry instead of settling it; after a recovery, entries already
// sent once fail as unconfirmed; a post over the request cap is refused when
// queued. Against the real host chat store and dispatcher behind a fake
// connection manager, with manual timers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { createChatOutbox } = require('../services/team/chat-outbox');
const { clientFilePath, loadChatState, loadClientFile, saveDeviceRecord } = require('../services/team/client-file');
const { hostFailure } = require('../server/api-contract');
const {
  ME, OTHER, createChatFakeHost, createManualTimers, settleChats, settleChatsBriefly, startChats, tempDir, writeMembership,
} = require('./helpers/team-chat-fake-host');
const { createDeferred } = require('./helpers/deferred');

const LOST = Object.freeze({ ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_request_timeout' } });

async function setup(t, { online = true } = {}) {
  const host = await createChatFakeHost(t);
  const userData = tempDir(t, 'jenny-team-chat-outbox-');
  const record = writeMembership(userData);
  const teamId = record.team_id;
  const pushes = [];
  const timers = createManualTimers();
  const start = () => startChats(t, host, { userData, teamId, online, timers, pushes });
  const first = start();
  return { host, userData, teamId, pushes, timers, start, ...first };
}

const post = (s, text, extra = {}, chats = s.chats) => chats.handle('chatPost',
  { team_id: s.teamId, channel_id: 'chan_team', text, ...extra });
const timeline = async (s) => (await s.host.dispatch(ME, 'team.chat.history', { channel_id: 'chan_team', limit: 100 }))
  .messages.map((message) => message.text);
const postCalls = (manager) => manager.calls.filter((call) => call.operation === 'team.chat.post');
const lastOutbox = (s) => s.pushes.filter((push) => push.type === 'outbox').at(-1);
const settled = (s) => s.pushes.filter((push) => push.type === 'outbox').flatMap((push) => push.settled);

test('entries keep their order and send after the sync that follows reconnecting', async (t) => {
  const s = await setup(t, { online: false });
  const answers = [];
  for (const text of ['one', 'two', 'three']) answers.push(await post(s, text));
  for (const answer of answers) {
    assert.equal(answer.ok, true);
    assert.match(answer.entry_id, /^out_/);
    assert.deepEqual(Object.keys(answer).sort(), ['entry_id', 'ok'], 'no request id reaches the renderer');
  }
  await s.chats.idle(s.teamId);
  assert.deepEqual(postCalls(s.manager), [], 'nothing is sent while not connected');
  assert.deepEqual(lastOutbox(s).outbox.map((entry) => entry.text), ['one', 'two', 'three']);
  s.manager.setState('online');
  await s.chats.idle(s.teamId);
  const ops = s.manager.ops();
  assert.equal(ops[0], 'team.chat.overview', 'a sync runs before the outbox sends');
  assert.deepEqual(postCalls(s.manager).map((call) => call.params.text), ['one', 'two', 'three']);
  assert.deepEqual(await timeline(s), ['one', 'two', 'three']);
  assert.deepEqual(lastOutbox(s).outbox, []);
  assert.deepEqual(settled(s).map((entry) => entry.ok), [true, true, true]);
  assert.deepEqual(loadChatState(s.userData, s.teamId).outbox, [], 'the outbox on disk is empty again');
});

test('a post whose answer was lost is resent with the same request id and appears once', async (t) => {
  const s = await setup(t);
  let lose = true;
  s.manager.hook = async ({ operation, dispatch }) => {
    if (operation !== 'team.chat.post' || !lose) return null;
    lose = false;
    await dispatch();
    return LOST;
  };
  assert.equal((await post(s, 'only once')).ok, true);
  await s.chats.idle(s.teamId);
  assert.equal(postCalls(s.manager).length, 1);
  assert.ok(s.timers.pending() >= 1, 'a retry is scheduled');
  s.timers.fire();
  await s.chats.idle(s.teamId);
  const calls = postCalls(s.manager);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].requestId, calls[1].requestId, 'the retry reuses the entry request id');
  assert.match(calls[0].requestId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.deepEqual(await timeline(s), ['only once'], 'the host answered the retry from its idempotency record');
  assert.deepEqual(lastOutbox(s).outbox, []);
});

test('team_chat_rate_limit and disk_pressure are retried later with the same id, under a bounded backoff', async (t) => {
  const s = await setup(t);
  let limited = 3;
  s.manager.hook = async ({ operation }) => {
    if (operation !== 'team.chat.post' || limited === 0) return null;
    limited -= 1;
    return hostFailure('limit', 'team_chat_rate_limit');
  };
  await post(s, 'patient');
  for (let round = 0; round < 3; round += 1) {
    await s.chats.idle(s.teamId);
    assert.equal(s.timers.fire(), 1, 'one retry timer at a time');
  }
  await s.chats.idle(s.teamId);
  const calls = postCalls(s.manager);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map((call) => call.requestId)).size, 1);
  assert.deepEqual(await timeline(s), ['patient']);
  const delays = s.timers.delays.slice(-3);
  assert.ok(delays[0] < delays[1] && delays[1] < delays[2], `the backoff grows (${delays})`);

  s.host.setAdmit(false);
  await post(s, 'disk later');
  await s.chats.idle(s.teamId);
  assert.equal(lastOutbox(s).outbox.length, 1, 'kept after disk_pressure');
  for (let round = 0; round < 12; round += 1) { s.timers.fire(); await s.chats.idle(s.teamId); }
  assert.ok(s.timers.delays.every((ms) => ms <= 60_000), 'the backoff is bounded');
  s.host.setAdmit(true);
  s.timers.fire();
  await s.chats.idle(s.teamId);
  const disk = postCalls(s.manager).filter((call) => call.params.text === 'disk later');
  assert.ok(disk.length >= 3);
  assert.equal(new Set(disk.map((call) => call.requestId)).size, 1);
  assert.deepEqual(await timeline(s), ['patient', 'disk later']);
});

test('a refusal that will never succeed fails the entry, is reported, and later entries still send', async (t) => {
  const s = await setup(t);
  await s.host.postAs(ME, 'mine');
  const mine = (await s.host.dispatch(ME, 'team.chat.history', { channel_id: 'chan_team', limit: 1 })).messages[0];
  const missing = await s.chats.handle('chatPost', { team_id: s.teamId, channel_id: 'chan_project_missing', text: 'lost' });
  const stale = await s.chats.handle('chatEdit', { team_id: s.teamId, channel_id: 'chan_team', message_id: mine.id,
    text: 'edited', expected_rev: mine.rev + 5 });
  const fine = await post(s, 'still goes');
  await s.chats.idle(s.teamId);
  assert.equal(s.timers.pending(), 0, 'no retry for a permanent refusal');
  const failed = lastOutbox(s).outbox;
  assert.deepEqual(failed.map((entry) => [entry.entry_id, entry.state]),
    [[missing.entry_id, 'failed'], [stale.entry_id, 'failed']]);
  assert.equal(failed[0].error.reason, 'team_chat_not_found');
  assert.match(failed[0].error.code, /^CMP-TEAM-\d{4}$/, 'mapped to the client code');
  assert.equal(failed[1].error.reason, 'team_chat_stale');
  const reported = settled(s);
  assert.deepEqual(reported.filter((entry) => !entry.ok).map((entry) => entry.entry_id), [missing.entry_id, stale.entry_id]);
  assert.equal(reported.find((entry) => entry.entry_id === fine.entry_id).ok, true);
  assert.deepEqual(await timeline(s), ['mine', 'still goes']);
  const discarded = await s.chats.handle('chatOutboxDiscard', { team_id: s.teamId, entry_id: missing.entry_id });
  assert.equal(discarded.ok, true);
  assert.deepEqual(lastOutbox(s).outbox.map((entry) => entry.entry_id), [stale.entry_id]);
  assert.deepEqual(loadChatState(s.userData, s.teamId).outbox.map((entry) => entry.entry_id), [stale.entry_id]);
});

test('nothing but team.chat.* mutations is ever resent', async (t) => {
  const s = await setup(t);
  s.manager.hook = async ({ operation }) => (operation === 'team.chat.mark_read' ? LOST : null);
  const marked = await s.chats.handle('chatMarkRead', { team_id: s.teamId, channel_id: 'chan_team', seq: 0 });
  assert.equal(marked.ok, false, 'the lost answer is reported, not queued');
  for (let round = 0; round < 3; round += 1) { s.timers.fire(); await s.chats.idle(s.teamId); }
  assert.equal(s.manager.calls.filter((call) => call.operation === 'team.chat.mark_read').length, 1);
  await post(s, 'queued once');
  await s.chats.idle(s.teamId);
  const resendable = new Set(['team.chat.post', 'team.chat.edit', 'team.chat.delete']);
  const counts = {};
  for (const call of s.manager.calls) counts[call.requestId || call.operation] = (counts[call.requestId || call.operation] || 0) + 1;
  for (const call of s.manager.calls) {
    if (call.requestId && counts[call.requestId] > 1) assert.ok(resendable.has(call.operation), call.operation);
  }
  // A stored entry naming any other operation is dropped on load (the rest of the file still loads): never sent.
  await s.chats.stopAll();
  const file = clientFilePath(s.userData, s.teamId);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.outbox = [{ entry_id: 'out_AAAAAAAAAAAAAAAAAAAA', request_id: 'req_admin1', operation: 'team.member.revoke',
    params: { member_id: OTHER.member_id }, created_at: '2026-11-10T10:00:00.000Z', attempted: true, failed: null }];
  fs.writeFileSync(file, JSON.stringify(value));
  assert.deepEqual(loadChatState(s.userData, s.teamId).outbox, []);
  const again = s.start();
  await again.chats.handle('chatOverview', { team_id: s.teamId });
  await again.chats.idle(s.teamId);
  assert.equal(again.manager.calls.some((call) => call.operation === 'team.member.revoke'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(value), 'loading rewrites nothing');
});

test('entries survive a restart through client.json and send after the next sync, once', async (t) => {
  const s = await setup(t);
  let lose = true;
  s.manager.hook = async ({ operation, dispatch }) => {
    if (operation !== 'team.chat.post' || !lose) return null;
    lose = false;
    await dispatch();
    return LOST;
  };
  await post(s, 'committed, answer lost');
  await s.chats.idle(s.teamId);
  s.manager.setState('reconnecting');
  await post(s, 'written offline');
  const sentBefore = postCalls(s.manager).map((call) => call.requestId);
  await s.chats.stopAll();
  const stored = loadChatState(s.userData, s.teamId).outbox;
  assert.deepEqual(stored.map((entry) => entry.params.text), ['committed, answer lost', 'written offline']);
  assert.equal(stored[0].request_id, sentBefore[0]);
  const next = s.start();
  await next.chats.idle(s.teamId);
  assert.equal(next.manager.ops()[0], 'team.chat.overview', 'the sync runs first');
  const resent = postCalls(next.manager);
  assert.deepEqual(resent.map((call) => call.requestId), stored.map((entry) => entry.request_id));
  assert.deepEqual(await timeline(s), ['committed, answer lost', 'written offline']);
  assert.deepEqual(loadChatState(s.userData, s.teamId).outbox, []);
});

test('the outbox is bounded and every entry is checked before it is kept', async (t) => {
  const s = await setup(t, { online: false });
  for (let n = 0; n < 50; n += 1) assert.equal((await post(s, `queued ${n}`)).ok, true);
  const full = await post(s, 'one too many');
  assert.equal(full.ok, false);
  assert.equal(full.error.reason, 'team_chat_outbox_full');
  assert.equal(loadChatState(s.userData, s.teamId).outbox.length, 50);
});

// ---------------------------------------------------------------- review round (2a-4b)

const MESSAGE_ID = 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV';

// An outbox over a store whose `failAt`-th write fails once.
function failingOutbox(failAt, answer) {
  const timers = createManualTimers();
  let writes = 0;
  let stored = [];
  const store = {
    outbox: () => stored.map((item) => ({ ...item })),
    saveOutbox(entries) {
      writes += 1;
      if (writes === failAt) return { ok: false, reason: 'team_client_write_failed' };
      stored = entries.map((item) => ({ ...item }));
      return { ok: true };
    },
  };
  const sends = [];
  const settlements = [];
  const outbox = createChatOutbox({ store, timers, onChange: (list, done) => settlements.push(...done),
    send: async (operation, params, requestId) => { sends.push(requestId); return answer; } });
  return { outbox, timers, sends, settlements, stored: () => stored };
}

test('a failed write after an answer holds the entry; the retry reuses its request id and settles once', async () => {
  // Writes: 1 queues the entry, 2 marks it attempted, 3 removes (or fails) it after the answer.
  for (const answer of [{ ok: true, message_id: MESSAGE_ID, seq: 4, rev: 9 },
    { ok: false, error: { code: 'invalid_request', reason: 'team_chat_stale' } }]) {
    const o = failingOutbox(3, answer);
    assert.equal(o.outbox.enqueue('team.chat.post', { channel_id: 'chan_team', text: 'hello' }).ok, true);
    assert.equal(await o.outbox.sendNext(), 'held', 'not settled while the entry is still on disk');
    assert.equal(o.sends.length, 1);
    assert.deepEqual(o.settlements, [], 'no settlement pushed');
    assert.equal(o.stored().length, 1);
    assert.equal(await o.outbox.sendNext(), 'held', 'the hold stands until its timer');
    assert.equal(o.sends.length, 1);
    assert.equal(o.timers.fire(), 1);
    assert.equal(await o.outbox.sendNext(), answer.ok ? 'sent' : 'failed');
    assert.deepEqual(o.sends, [o.sends[0], o.sends[0]], 'the retry reuses the request id');
    assert.equal(o.settlements.length, 1);
    assert.equal(o.settlements[0].ok, answer.ok);
    assert.equal(o.stored().length, answer.ok ? 0 : 1);
    assert.equal(await o.outbox.sendNext(), 'idle', 'nothing is sent again');
    assert.equal(o.sends.length, 2);
  }
});

test('after a recovery, entries already sent once fail as unconfirmed and entries never sent still go', async (t) => {
  const s = await setup(t);
  s.manager.hook = async ({ operation }) => (operation === 'team.chat.post' ? LOST : null);
  await post(s, 'maybe sent');
  await s.chats.idle(s.teamId);
  s.manager.setState('reconnecting');
  await post(s, 'never sent');
  await s.chats.idle(s.teamId);
  // A recovery: the chat client is let go, then the new device and the marks are one write (team-service.js).
  s.chats.detach(s.teamId);
  const saved = loadClientFile(s.userData, s.teamId).record;
  assert.equal(saveDeviceRecord(s.userData, { ...saved, device_id: 'device_newCCCC3333' }).ok, true);
  const stored = loadChatState(s.userData, s.teamId).outbox;
  assert.deepEqual(stored.map((item) => [item.params.text, item.failed?.reason || null]),
    [['maybe sent', 'team_chat_outbox_unconfirmed'], ['never sent', null]]);
  const again = s.start();
  await settleChats(again.chats, s.teamId, s.timers);
  assert.deepEqual(postCalls(again.manager).map((call) => call.params.text), ['never sent']);
  assert.deepEqual(await timeline(s), ['never sent']);
  assert.deepEqual(lastOutbox(s).outbox.map((item) => [item.text, item.state]), [['maybe sent', 'failed']]);
});

test('a post over the request cap is refused when queued; a local permanent refusal fails its entry', async (t) => {
  const s = await setup(t);
  const refs = Array.from({ length: 8 }, (_, n) => ({ kind: 'file', project_id: `project_p${n}`, path: 'é'.repeat(1024), line: null }));
  const big = await post(s, '😀'.repeat(16000), { refs });
  assert.equal(big.ok, false);
  assert.equal(big.error.reason, 'team_chat_request_too_large');
  assert.deepEqual(loadChatState(s.userData, s.teamId).outbox, [], 'nothing queued');

  let refuse = true;
  s.manager.hook = async ({ operation }) => {
    if (operation !== 'team.chat.post' || !refuse) return null;
    refuse = false;
    return { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_request_too_large' } };
  };
  const first = await post(s, 'refused locally');
  await post(s, 'after it');
  await s.chats.idle(s.teamId);
  const failed = lastOutbox(s).outbox;
  assert.deepEqual(failed.map((item) => [item.entry_id, item.state]), [[first.entry_id, 'failed']]);
  assert.equal(failed[0].error.reason, 'team_request_too_large');
  assert.deepEqual(await timeline(s), ['after it'], 'the next entry is not blocked');
});

test('a refusal marked retryable that classifies as failed is stored as { code, reason }, pushed once and not resent', async (t) => {
  const s = await setup(t);
  let sends = 0;
  s.manager.hook = async ({ operation }) => {
    if (operation !== 'team.chat.post') return null;
    sends += 1;
    return { ok: false, error: { code: 'invalid_request', reason: 'team_chat_text_invalid', retryable: true } };
  };
  const posted = await post(s, 'refused for good');
  assert.equal(posted.ok, true);
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(sends, 1, 'sent once');
  const stored = loadChatState(s.userData, s.teamId).outbox;
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].failed, { code: 'invalid_request', reason: 'team_chat_text_invalid' }, 'stored as the closed pair');
  const failures = settled(s).filter((entry) => entry.ok === false);
  assert.deepEqual(failures, [{ entry_id: posted.entry_id, ok: false,
    error: { code: 'invalid_request', reason: 'team_chat_text_invalid' } }], 'pushed once as failed');
  assert.equal(lastOutbox(s).outbox[0].state, 'failed');
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(sends, 1, 'not sent again on the next pass');
});

// ------------------------------------------------------------------ an edit made stale only by a mark

const editCalls = (manager) => manager.calls.filter((call) => call.operation === 'team.chat.edit');
const syncCalls = (manager) => manager.calls.filter((call) => call.operation === 'team.chat.sync');
const failedEntries = (s) => lastOutbox(s).outbox.filter((entry) => entry.state === 'failed');

// The member's own message, opened in the client, with an edit queued at its revision while the send is held.
async function staleSetup(t, { online = true } = {}) {
  const s = await setup(t, { online });
  const mine = await s.host.postAs(ME, 'my message');
  assert.equal((await s.chats.handle('chatOverview', { team_id: s.teamId })).ok, true);
  assert.equal((await s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: 'chan_team' })).ok, true);
  const gate = createDeferred();
  t.after(() => gate.resolve());
  // The first edit send waits on `gate`; `hooks.second`, when set, runs before the second one reaches the host.
  const hooks = { second: null };
  let edits = 0;
  s.manager.hook = async ({ operation, dispatch }) => {
    if (operation !== 'team.chat.edit') return null;
    edits += 1;
    if (edits === 1) {
      await gate.promise;
      return dispatch();
    }
    if (hooks.second) await hooks.second();
    return null;
  };
  const queueEdit = (text = 'my message, edited') => s.chats.handle('chatEdit', { team_id: s.teamId, channel_id: 'chan_team',
    message_id: mine.message_id, text, expected_rev: mine.rev });
  const react = (on, messageId = mine.message_id) => s.host.dispatch(OTHER, 'team.chat.react', { channel_id: 'chan_team',
    message_id: messageId, emoji: '\u{1F44D}', on });
  return { s, mine, gate, hooks, queueEdit, react };
}

test('an edit made stale only by a reaction is synced once and sent once more with the current rev and a new request id', async (t) => {
  const { s, mine, gate, queueEdit } = await staleSetup(t);
  assert.equal((await queueEdit()).ok, true);
  await settleChatsBriefly();
  const reacted = await s.host.dispatch(OTHER, 'team.chat.react', { channel_id: 'chan_team', message_id: mine.message_id,
    emoji: '\u{1F44D}', on: true });
  assert.equal(reacted.ok, true, JSON.stringify(reacted));
  assert.ok(reacted.rev > mine.rev, 'the reaction moved the revision');
  await settleChatsBriefly();
  const syncsBefore = syncCalls(s.manager).length;
  gate.resolve();
  await settleChats(s.chats, s.teamId, s.timers);
  const sends = editCalls(s.manager);
  assert.equal(sends.length, 2, 'the edit went twice: stale, then current');
  assert.equal(sends[0].params.expected_rev, mine.rev);
  assert.equal(sends[1].params.expected_rev, reacted.rev);
  assert.notEqual(sends[0].requestId, sends[1].requestId, 'a new request id');
  assert.equal(sends[1].params.text, 'my message, edited');
  assert.equal(syncCalls(s.manager).length - syncsBefore, 1, 'one sync between them');
  assert.deepEqual(failedEntries(s), [], 'the entry did not fail');
  assert.deepEqual(lastOutbox(s).outbox, [], 'and settled');
  const record = (await s.host.dispatch(ME, 'team.chat.history', { channel_id: 'chan_team', limit: 10 })).messages.at(-1);
  assert.equal(record.text, 'my message, edited');
  assert.deepEqual(loadChatState(s.userData, s.teamId).outbox, []);
});

test('an edit is not sent over a text change made on another device: no second send, the entry fails team_chat_stale', async (t) => {
  const { s, mine, gate, queueEdit } = await staleSetup(t);
  assert.equal((await queueEdit()).ok, true);
  await settleChatsBriefly();
  const elsewhere = await s.host.dispatch(ME, 'team.chat.edit', { channel_id: 'chan_team', message_id: mine.message_id,
    text: 'edited on my other device', expected_rev: mine.rev });
  assert.equal(elsewhere.ok, true, JSON.stringify(elsewhere));
  gate.resolve();
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(editCalls(s.manager).length, 1, 'no second send');
  assert.deepEqual(failedEntries(s).map((entry) => entry.error.reason), ['team_chat_stale']);
  const record = (await s.host.dispatch(ME, 'team.chat.history', { channel_id: 'chan_team', limit: 10 })).messages.at(-1);
  assert.equal(record.text, 'edited on my other device', 'the other device\'s text stands');
});

test('after the client was recreated an edit made stale by a reaction fails team_chat_stale, with no second send', async (t) => {
  const { s, mine, queueEdit } = await staleSetup(t);
  s.manager.hook = null;
  s.manager.setState('reconnecting');
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal((await queueEdit()).ok, true);
  const reacted = await s.host.dispatch(OTHER, 'team.chat.react', { channel_id: 'chan_team', message_id: mine.message_id,
    emoji: '\u{1F44D}', on: true });
  assert.equal(reacted.ok, true);
  await s.chats.stopAll();
  const next = s.start();
  // The first send is held for a rate limit, so the channel is open in the new client when the retry meets the stale
  // answer: the cached record is unchanged, and only the lost memo stops a second send.
  let limited = true;
  next.manager.hook = async ({ operation }) => {
    if (operation !== 'team.chat.edit' || !limited) return null;
    limited = false;
    return { ok: false, error: { code: 'CMP-HOST-0007', reason: 'team_chat_rate_limit' } };
  };
  const opening = next.chats.handle('chatOverview', { team_id: s.teamId })
    .then(() => next.chats.handle('chatHistory', { team_id: s.teamId, channel_id: 'chan_team' }));
  await settleChats(next.chats, s.teamId, s.timers);
  assert.equal((await opening).ok, true);
  const sends = editCalls(next.manager);
  assert.equal(sends.length, 2, 'the held send and its retry, and no third');
  assert.equal(sends[0].requestId, sends[1].requestId, 'the retry reuses the request id');
  assert.equal(sends[1].params.expected_rev, mine.rev);
  const ops = next.manager.ops();
  assert.ok(ops.indexOf('team.chat.history') < ops.lastIndexOf('team.chat.edit'), 'the channel was open when the retry went out');
  const stored = loadChatState(s.userData, s.teamId).outbox;
  assert.deepEqual(stored.map((entry) => entry.failed?.reason), ['team_chat_stale']);
});

test('an edit queued while the cached revision is not the one it names is never retried', async (t) => {
  const { s, mine, gate } = await staleSetup(t);
  const reacted = await s.host.dispatch(OTHER, 'team.chat.react', { channel_id: 'chan_team', message_id: mine.message_id,
    emoji: '\u{1F44D}', on: true });
  assert.equal(reacted.ok, true);
  await s.chats.idle(s.teamId);
  // The cache now holds the reaction's revision; this edit still names the older one.
  const queued = await s.chats.handle('chatEdit', { team_id: s.teamId, channel_id: 'chan_team', message_id: mine.message_id,
    text: 'from an older view', expected_rev: mine.rev });
  assert.equal(queued.ok, true);
  gate.resolve();
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(editCalls(s.manager).length, 1);
  assert.deepEqual(failedEntries(s).map((entry) => entry.error.reason), ['team_chat_stale']);
});

test('a second team_chat_stale on the retried send fails the entry: two sends and one sync in all', async (t) => {
  const { s, mine, gate, hooks, queueEdit, react } = await staleSetup(t);
  assert.equal((await queueEdit()).ok, true);
  await settleChatsBriefly();
  assert.equal((await react(true)).ok, true);
  hooks.second = async () => { assert.equal((await react(false)).ok, true); };
  const syncsBefore = syncCalls(s.manager).length;
  gate.resolve();
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(editCalls(s.manager).length, 2);
  assert.equal(syncCalls(s.manager).length - syncsBefore, 1);
  assert.deepEqual(failedEntries(s).map((entry) => entry.error.reason), ['team_chat_stale']);
});

test('two edits queued for one message at one revision: the first lands, the second answers stale and is not retried', async (t) => {
  const { s, gate, queueEdit } = await staleSetup(t);
  assert.equal((await queueEdit('first edit')).ok, true);
  assert.equal((await queueEdit('second edit')).ok, true);
  await settleChatsBriefly();
  gate.resolve();
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(editCalls(s.manager).length, 2, 'the text changed, so the second is not sent again');
  assert.deepEqual(failedEntries(s).map((entry) => entry.error.reason), ['team_chat_stale']);
  const record = (await s.host.dispatch(ME, 'team.chat.history', { channel_id: 'chan_team', limit: 10 })).messages.at(-1);
  assert.equal(record.text, 'first edit');
});

test('an edit of a thread reply is never held in the open cache: no memo, no sync, it fails team_chat_stale', async (t) => {
  const { s, mine, gate, react } = await staleSetup(t);
  const reply = await s.host.postAs(ME, 'a reply', { thread_root_id: mine.message_id });
  await s.chats.idle(s.teamId);
  const queued = await s.chats.handle('chatEdit', { team_id: s.teamId, channel_id: 'chan_team', message_id: reply.message_id,
    text: 'reply, edited', expected_rev: reply.rev });
  assert.equal(queued.ok, true, JSON.stringify(queued));
  await settleChatsBriefly();
  assert.equal((await react(true, reply.message_id)).ok, true);
  const syncsBefore = syncCalls(s.manager).length;
  gate.resolve();
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(editCalls(s.manager).length, 1);
  assert.equal(syncCalls(s.manager).length - syncsBefore, 0, 'no sync for the retry');
  assert.deepEqual(failedEntries(s).map((entry) => entry.error.reason), ['team_chat_stale']);
});

// ---- the stale retry at the outbox level

const STALE = Object.freeze({ ok: false, error: { code: 'invalid_request', reason: 'team_chat_stale' } });
const EDIT = Object.freeze({ channel_id: 'chan_team', message_id: MESSAGE_ID, text: 'edited', expected_rev: 3 });

// An outbox over an in-memory store holding one queued edit at revision 3 whose cached record is unchanged;
// `answerOf(n)` is the answer to the n-th send and `reconcile` the sync before a retry.
function staleOutbox({ reconcile, answerOf = () => STALE }) {
  let stored = [];
  const writes = [];
  const store = {
    outbox: () => stored.map((item) => ({ ...item })),
    saveOutbox(entries) {
      stored = entries.map((item) => ({ ...item }));
      writes.push(entries.length);
      return { ok: true };
    },
  };
  const sends = [];
  const outbox = createChatOutbox({ store, timers: createManualTimers(), reconcile,
    send: async (operation, params, requestId) => { sends.push({ params, requestId }); return answerOf(sends.length); },
    recordOf: () => ({ rev: 3, edited_at: null, deleted: null }) });
  assert.equal(outbox.enqueue('team.chat.edit', EDIT).ok, true);
  return { outbox, sends, stored: () => stored, writes };
}

test('the retried edit is stored as already attempted, under a new request id, at the record\'s revision', async () => {
  const hold = createDeferred();
  const o = staleOutbox({ reconcile: async () => ({ rev: 4, edited_at: null, deleted: null }),
    answerOf: (n) => (n === 1 ? STALE : hold.promise) });
  const [queued] = o.stored();
  const pending = o.outbox.sendNext();
  await settleChatsBriefly();
  assert.equal(o.sends.length, 2, 'the retry is in flight');
  const [entry] = o.stored();
  assert.equal(entry.attempted, true, 'a later hold still takes the resend-window check');
  assert.notEqual(entry.request_id, queued.request_id);
  assert.equal(entry.request_id, o.sends[1].requestId);
  assert.equal(entry.params.expected_rev, 4);
  assert.equal(entry.created_at, queued.created_at);
  hold.resolve({ ok: true, message_id: MESSAGE_ID, rev: 5 });
  assert.equal(await pending, 'sent');
});

test('a reconcile that throws sends nothing more and fails the entry team_chat_stale', async () => {
  const o = staleOutbox({ reconcile: async () => { throw new Error('boom'); } });
  assert.equal(await o.outbox.sendNext(), 'failed');
  assert.equal(o.sends.length, 1);
  assert.equal(o.stored()[0].failed.reason, 'team_chat_stale');
});

test('a stop during the stale sync writes nothing and sends nothing more', async () => {
  const sync = createDeferred();
  const o = staleOutbox({ reconcile: () => sync.promise });
  const pending = o.outbox.sendNext();
  await settleChatsBriefly();
  const writesAtStop = o.writes.length;
  o.outbox.stop();
  sync.resolve({ rev: 4, edited_at: null, deleted: null });
  assert.equal(await pending, 'idle');
  assert.equal(o.sends.length, 1);
  assert.equal(o.writes.length, writesAtStop);
});
