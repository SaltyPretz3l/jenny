'use strict';

// Reactions, pins, edit history and pinned messages on the desktop chat client: the mark queue
// (services/team/chat-marks.js) sends the marks of one key one at a time in call order, holds a newer call behind the
// send in flight, lets a still newer one replace the held one, never re-sends a mark and answers every held caller;
// the four methods are online only and refuse a bad payload before anything is sent; the edit history and the pinned
// list are rebuilt from checked fields only; the host's three refusals present as CMP-TEAM-0009 without `retryable`.
// Against the real host chat composition behind a fake connection manager.

const assert = require('node:assert/strict');
const test = require('node:test');

const { REACTION_EMOJI } = require('../services/host/team-chat-emoji');
const { createMarkQueue } = require('../services/team/chat-marks');
const { validatePayload } = require('../services/team/ipc-methods');
const { teamFailure } = require('../services/team/team-errors');
const { ME, OTHER, setupChatClient, settleChats, tick, within } = require('./helpers/team-chat-fake-host');
const { createDeferred } = require('./helpers/deferred');

const [THUMBS, HEART] = REACTION_EMOJI;
const INVALID = 'team_chat_answer_invalid';

// ------------------------------------------------------------------ the queue itself

// A send that records its value and waits on a gate the test opens.
function gatedSends() {
  const sent = [];
  const gates = [];
  const run = (value) => () => {
    sent.push(value);
    const gate = createDeferred();
    gates.push(gate);
    return gate.promise;
  };
  return { sent, gates, run };
}

test('marks for one key: on, off, on while the first is in flight send the first and the final state, and answer all three callers', async () => {
  const queue = createMarkQueue();
  const { sent, gates, run } = gatedSends();
  const first = queue.request('k', run('on#1'));
  const second = queue.request('k', run('off'));
  const third = queue.request('k', run('on#2'));
  await tick();
  assert.deepEqual(sent, ['on#1'], 'only the first is in flight');
  gates[0].resolve({ ok: true, rev: 2 });
  assert.deepEqual(await first, { ok: true, rev: 2 }, 'the first caller gets the first send');
  await tick();
  assert.deepEqual(sent, ['on#1', 'on#2'], 'the replaced mark is never sent');
  assert.equal(queue.size(), 1);
  gates[1].resolve({ ok: true, rev: 3 });
  assert.deepEqual(await second, { ok: true, rev: 3 }, 'the replaced caller gets the answer of the final send');
  assert.deepEqual(await third, { ok: true, rev: 3 });
  await tick();
  assert.equal(queue.size(), 0, 'the table is empty again');
});

test('marks of two keys do not wait for each other', async () => {
  const queue = createMarkQueue();
  const { sent, gates, run } = gatedSends();
  const one = queue.request('a', run('a'));
  const two = queue.request('b', run('b'));
  await tick();
  assert.deepEqual(sent, ['a', 'b']);
  gates[1].resolve({ ok: true, rev: 5 });
  assert.deepEqual(await within(two), { ok: true, rev: 5 }, 'b answered while a is still in flight');
  gates[0].resolve({ ok: true, rev: 4 });
  assert.deepEqual(await one, { ok: true, rev: 4 });
});

test('a failed send is answered to its callers and not sent again; the call held behind it is still sent', async () => {
  const queue = createMarkQueue();
  const { sent, gates, run } = gatedSends();
  const first = queue.request('k', run('on'));
  const held = queue.request('k', run('off'));
  await tick();
  gates[0].resolve({ ok: false, error: { code: 'CMP-HOST-0007', reason: 'team_chat_reaction_limit' } });
  assert.equal((await first).ok, false);
  await tick();
  assert.deepEqual(sent, ['on', 'off'], 'the held final state goes, the failed one is not repeated');
  gates[1].resolve({ ok: true, rev: 9 });
  assert.equal((await held).ok, true);
  await tick();
  await tick();
  assert.deepEqual(sent, ['on', 'off'], 'nothing more is ever sent');
});

test('a send that throws answers its callers with the failure and frees the key', async () => {
  const queue = createMarkQueue();
  const answer = await queue.request('k', () => { throw new Error('boom'); });
  assert.deepEqual(answer, teamFailure('CONNECTION_FAILED', 'team_unavailable'));
  assert.equal(queue.size(), 0);
  assert.deepEqual(await queue.request('k', async () => ({ ok: true, rev: 1 })), { ok: true, rev: 1 });
});

test('clear answers every held caller, starts nothing more and closes the queue', async () => {
  const queue = createMarkQueue();
  const { sent, gates, run } = gatedSends();
  const first = queue.request('k', run('on'));
  const held = queue.request('k', run('off'));
  const other = queue.request('j', run('j'));
  await tick();
  const stopped = { ok: false, error: { code: 'CMP-TEAM-0005', reason: 'team_connection_stopped' } };
  queue.clear(stopped);
  assert.deepEqual(await within(held), stopped, 'the held caller is answered at once');
  gates[0].resolve({ ok: true, rev: 2 });
  gates[1].resolve({ ok: true, rev: 3 });
  assert.deepEqual(await first, { ok: true, rev: 2 }, 'a send in flight still answers its own caller');
  assert.deepEqual(await other, { ok: true, rev: 3 });
  await tick();
  assert.deepEqual(sent, ['on', 'j'], 'the held mark is never sent');
  assert.deepEqual(await queue.request('k', run('late')), stopped, 'a call after clear gets the same answer');
  assert.deepEqual(sent, ['on', 'j']);
});

test('the table is bounded: a new key past the bound is refused with the retry-later failure, a known key is not', async () => {
  const queue = createMarkQueue();
  const { sent, gates, run } = gatedSends();
  const keys = Array.from({ length: 64 }, (_, index) => `key ${index}`);
  const inFlight = keys.map((key) => queue.request(key, run(key)));
  assert.equal(queue.size(), 64);
  const refused = await queue.request('one too many', run('one too many'));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'CMP-TEAM-0007');
  assert.equal(refused.error.reason, 'team_chat_rate_limit');
  assert.equal(Object.hasOwn(refused.error, 'retryable'), false);
  const again = queue.request(keys[0], run('again'));
  await tick();
  assert.equal(sent.length, 64, 'the refused key sent nothing and the known key is held, not refused');
  assert.equal(sent.includes('one too many'), false);
  for (const gate of gates) gate.resolve({ ok: true, rev: 1 });
  await Promise.all(inFlight);
  await tick();
  gates[64].resolve({ ok: true, rev: 2 });
  assert.equal((await again).ok, true);
  await tick();
  assert.equal(queue.size(), 0);
  assert.equal((await queue.request('one too many', async () => ({ ok: true, rev: 3 }))).ok, true, 'room again');
});

test('clear while the held call\'s own send is in flight: that send answers its caller, nothing is sent after, the table is empty', async () => {
  const queue = createMarkQueue();
  const { sent, gates, run } = gatedSends();
  const first = queue.request('k', run('on'));
  const held = queue.request('k', run('off'));
  await tick();
  gates[0].resolve({ ok: true, rev: 2 });
  assert.deepEqual(await first, { ok: true, rev: 2 });
  await tick();
  assert.deepEqual(sent, ['on', 'off'], 'the held call\'s own send is in flight');
  const stopped = { ok: false, error: { code: 'CMP-TEAM-0005', reason: 'team_connection_stopped' } };
  queue.clear(stopped);
  assert.equal(queue.size(), 0);
  gates[1].resolve({ ok: true, rev: 3 });
  assert.deepEqual(await within(held), { ok: true, rev: 3 }, 'its own caller gets its answer');
  await tick();
  assert.deepEqual(sent, ['on', 'off'], 'nothing is sent after');
  assert.equal(queue.size(), 0);
});

// ------------------------------------------------------------------ the four methods

async function opened(t) {
  const s = await setupChatClient(t, { prefix: 'jenny-team-chat-marks-' });
  const posted = await s.host.postAs(OTHER, 'a message to mark');
  assert.equal((await s.call('chatOverview')).ok, true);
  assert.equal((await s.call('chatHistory', { channel_id: 'chan_team' })).ok, true);
  s.messageId = posted.message_id;
  s.react = (on = true, emoji = THUMBS) => s.call('chatReact', { channel_id: 'chan_team', message_id: s.messageId, emoji, on });
  s.pin = (on = true) => s.call('chatPin', { channel_id: 'chan_team', message_id: s.messageId, on });
  return s;
}

test('react and pin answer { ok, rev }, reach the host once and change the record', async (t) => {
  const s = await opened(t);
  const reacted = await s.react();
  assert.deepEqual(Object.keys(reacted).sort(), ['ok', 'rev'], JSON.stringify(reacted));
  const pinned = await s.pin();
  assert.deepEqual(Object.keys(pinned).sort(), ['ok', 'rev']);
  assert.ok(pinned.rev > reacted.rev);
  assert.equal(s.sent('team.chat.react').length, 1);
  assert.equal(s.sent('team.chat.pin').length, 1);
  assert.deepEqual(s.sent('team.chat.react')[0].params,
    { channel_id: 'chan_team', message_id: s.messageId, emoji: THUMBS, on: true });
  await s.chats.idle(s.teamId);
  const record = (await s.call('chatHistory', { channel_id: 'chan_team' })).messages.find((m) => m.id === s.messageId);
  assert.deepEqual(record.reactions[THUMBS], [ME.member_id]);
  assert.notEqual(record.pinned, null);
  assert.equal(s.messageId, record.id);
  assert.equal(Object.hasOwn(record, 'edits'), false);
  assert.equal((await s.pin(false)).ok, true);
});

test('react on, off, on while the first is in flight: two requests, three answers, the final state', async (t) => {
  const s = await opened(t);
  const gate = createDeferred();
  t.after(() => gate.resolve());
  let held = true;
  s.manager.hook = async ({ operation, dispatch }) => {
    if (operation !== 'team.chat.react' || !held) return null;
    held = false;
    await gate.promise;
    return dispatch();
  };
  const first = s.react(true);
  await tick();
  const second = s.react(false);
  const third = s.react(true);
  await tick();
  await tick();
  assert.equal(s.sent('team.chat.react').length, 1, 'the newer calls are held behind the send in flight');
  gate.resolve();
  const answers = await Promise.all([first, second, third]);
  assert.deepEqual(answers.map((answer) => answer.ok), [true, true, true], JSON.stringify(answers));
  const sends = s.sent('team.chat.react');
  assert.deepEqual(sends.map((call) => call.params.on), [true, true], 'the replaced off is never sent');
  const record = (await s.host.dispatch(ME, 'team.chat.history', { channel_id: 'chan_team', limit: 10 })).messages.at(-1);
  assert.deepEqual(record.reactions[THUMBS], [ME.member_id]);
});

test('two emoji on one message, and a reaction and a pin, do not wait for each other', async (t) => {
  const s = await opened(t);
  const gate = createDeferred();
  t.after(() => gate.resolve());
  s.manager.hook = async ({ operation, params, dispatch }) => {
    if (operation === 'team.chat.react' && params.emoji === THUMBS) { await gate.promise; return dispatch(); }
    return null;
  };
  const slow = s.react(true, THUMBS);
  await tick();
  assert.equal((await within(s.react(true, HEART))).ok, true, 'another emoji answers while the first is held');
  assert.equal((await within(s.pin(true))).ok, true, 'a pin answers while the reaction is held');
  gate.resolve();
  assert.equal((await slow).ok, true);
});

test('a failed mark is passed on and never sent again; the call held behind it is still sent', async (t) => {
  const s = await opened(t);
  const gate = createDeferred();
  t.after(() => gate.resolve());
  let first = true;
  s.manager.hook = async ({ operation }) => {
    if (operation !== 'team.chat.react' || !first) return null;
    first = false;
    await gate.promise;
    return { ok: false, error: { code: 'CMP-HOST-0007', reason: 'team_chat_reaction_limit' } };
  };
  const failed = s.react(true);
  await tick();
  const held = s.react(false);
  await tick();
  gate.resolve();
  assert.equal((await failed).ok, false);
  assert.equal((await held).ok, true, 'the held state is sent, its caller asked for it');
  await settleChats(s.chats, s.teamId, s.timers);
  s.event('team_presence', { member_id: OTHER.member_id, state: 'away', last_seen_at: null });
  await s.chats.idle(s.teamId);
  assert.deepEqual(s.sent('team.chat.react').map((call) => call.params.on), [true, false],
    'the failed mark is not repeated, after the failure settled and after one more event drain');
});

test('two reactions for one key made before the first load is ready reach the queue in call order', async (t) => {
  const s = await setupChatClient(t, { prefix: 'jenny-team-chat-marks-' });
  const posted = await s.host.postAs(OTHER, 'a message to mark');
  const gate = createDeferred();
  t.after(() => gate.resolve());
  s.manager.hook = async ({ operation }) => {
    if (operation === 'team.chat.overview') await gate.promise;
    return null;
  };
  const react = (on) => s.call('chatReact', { channel_id: 'chan_team', message_id: posted.message_id, emoji: THUMBS, on });
  const first = react(true);
  const second = react(false);
  await tick();
  await tick();
  assert.equal(s.sent('team.chat.react').length, 0, 'nothing is sent before the snapshot is ready');
  gate.resolve();
  const answers = await Promise.all([first, second]);
  assert.deepEqual(answers.map((answer) => answer.ok), [true, true], JSON.stringify(answers));
  assert.deepEqual(s.sent('team.chat.react').map((call) => call.params.on), [true, false], 'on first, off is the final state');
});

test('the three host refusals present as CMP-TEAM-0009 with no retryable flag, whatever the host says', async (t) => {
  const s = await opened(t);
  const cases = [['team_chat_emoji_invalid', 'CMP-HOST-0001'], ['team_chat_reaction_limit', 'CMP-HOST-0007'],
    ['team_chat_pin_limit', 'CMP-HOST-0007']];
  for (const [reason, code] of cases) {
    for (const retryable of [undefined, true]) {
      s.manager.hook = async ({ operation }) => (operation === 'team.chat.react' || operation === 'team.chat.pin'
        ? { ok: false, error: { code, reason, ...(retryable ? { retryable } : {}) } } : null);
      const answer = reason === 'team_chat_pin_limit' ? await s.pin(true) : await s.react(true);
      assert.deepEqual(answer, { ok: false, error: { code: 'CMP-TEAM-0009', reason } }, `${reason} ${retryable}`);
    }
  }
});

test('each method refuses an unknown field, a bad id and a bad value before anything is sent', async (t) => {
  const s = await opened(t);
  const base = { team_id: s.teamId, channel_id: 'chan_team', message_id: s.messageId };
  const bad = [
    ['chatReact', { ...base, emoji: THUMBS, on: true, extra: 1 }],
    ['chatReact', { ...base, emoji: THUMBS }],
    ['chatReact', { ...base, emoji: 'x', on: true }],
    ['chatReact', { ...base, emoji: '\u{1F984}', on: true }],
    ['chatReact', { ...base, emoji: THUMBS, on: 1 }],
    ['chatReact', { ...base, message_id: 'msg_short', emoji: THUMBS, on: true }],
    ['chatReact', { ...base, channel_id: 'general', emoji: THUMBS, on: true }],
    ['chatPin', { ...base, on: true, emoji: THUMBS }],
    ['chatPin', { ...base, on: 'yes' }],
    ['chatPin', { ...base, message_id: 7, on: true }],
    ['chatPin', { team_id: s.teamId, message_id: s.messageId, on: true }],
    ['chatEdits', { ...base, extra: 1 }],
    ['chatEdits', { ...base, message_id: 'msg_short' }],
    ['chatEdits', { team_id: s.teamId, channel_id: 'chan_team' }],
    ['chatPins', { team_id: s.teamId, channel_id: 'chan_team', extra: 1 }],
    ['chatPins', { team_id: s.teamId, channel_id: 'general' }],
    ['chatPins', { team_id: s.teamId }],
  ];
  const before = s.manager.calls.length;
  for (const [method, payload] of bad) {
    assert.equal(validatePayload(method, payload).ok, false, `${method} ${JSON.stringify(payload).slice(0, 100)}`);
    const answer = await s.chats.handle(method, payload);
    assert.equal(answer.ok, false, method);
    assert.equal(answer.error.code, 'invalid_request', method);
  }
  assert.deepEqual(s.manager.calls.slice(before), [], 'nothing reached the host');
  for (const emoji of REACTION_EMOJI) assert.equal(validatePayload('chatReact', { ...base, emoji, on: true }).ok, true);
});

test('all four methods are online only: offline they answer team_not_connected and send nothing', async (t) => {
  const s = await opened(t);
  s.manager.setState('reconnecting');
  await settleChats(s.chats, s.teamId, s.timers);
  const before = s.manager.calls.length;
  const answers = [await s.react(), await s.pin(),
    await s.call('chatEdits', { channel_id: 'chan_team', message_id: s.messageId }),
    await s.call('chatPins', { channel_id: 'chan_team' })];
  for (const answer of answers) {
    assert.equal(answer.ok, false);
    assert.equal(answer.error.reason, 'team_not_connected');
  }
  assert.deepEqual(s.manager.calls.slice(before), []);
});

test('clear at stop answers a held mark with the stopped failure', async (t) => {
  const s = await opened(t);
  const gate = createDeferred();
  t.after(() => gate.resolve());
  s.manager.hook = async ({ operation, dispatch }) => {
    if (operation !== 'team.chat.react') return null;
    await gate.promise;
    return dispatch();
  };
  const first = s.react(true);
  await tick();
  const held = s.react(false);
  await tick();
  await s.chats.stopAll();
  const answer = await within(held);
  assert.notEqual(answer, 'still waiting');
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'team_connection_stopped');
  gate.resolve();
  await first;
  assert.equal(s.sent('team.chat.react').length, 1, 'the held state was not sent after the stop');
});

// ------------------------------------------------------------------ edit history and pinned messages

test('chatEdits answers { ok, edits, rev, trimmed } rebuilt from checked fields; a malformed answer is refused', async (t) => {
  const s = await opened(t);
  const mine = await s.host.postAs(ME, 'first text');
  let rev = mine.rev;
  for (const text of ['second text', 'third text']) {
    const edited = await s.host.dispatch(ME, 'team.chat.edit', { channel_id: 'chan_team', message_id: mine.message_id, text, expected_rev: rev });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    rev = edited.rev;
  }
  await s.chats.idle(s.teamId);
  const ask = () => s.call('chatEdits', { channel_id: 'chan_team', message_id: mine.message_id });
  const answer = await ask();
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(Object.keys(answer).sort(), ['edits', 'ok', 'rev', 'trimmed']);
  assert.deepEqual(answer.edits.map((edit) => edit.text), ['first text', 'second text']);
  for (const edit of answer.edits) assert.deepEqual(Object.keys(edit).sort(), ['edited_at', 'text']);
  assert.equal(answer.trimmed, false);
  assert.equal(answer.rev, rev);

  const real = await s.host.dispatch(ME, 'team.chat.edits', { channel_id: 'chan_team', message_id: mine.message_id });
  const edit = real.edits[0];
  const dropped = { ...real, secret: 'leak' };
  s.manager.hook = async ({ operation }) => (operation === 'team.chat.edits' ? dropped : null);
  const clean = await ask();
  assert.equal(clean.ok, true);
  assert.equal(JSON.stringify(clean).includes('leak'), false, 'unknown top-level fields are dropped');
  const hostile = [
    { ...real, edits: [{ ...edit, secret: 'leak' }] }, { ...real, edits: [{ text: edit.text }] },
    { ...real, edits: [{ ...edit, text: 7 }] }, { ...real, edits: [{ ...edit, edited_at: 'yesterday' }] },
    { ...real, edits: Array.from({ length: 11 }, () => edit) }, { ...real, edits: 'none' }, { ...real, rev: -1 },
    { ...real, rev: 'x' }, { ...real, trimmed: 'yes' },
  ];
  for (const [index, answerFromHost] of hostile.entries()) {
    s.manager.hook = async ({ operation }) => (operation === 'team.chat.edits' ? answerFromHost : null);
    const refused = await ask();
    assert.equal(refused.ok, false, `answer ${index}`);
    assert.equal(refused.error.reason, INVALID, `answer ${index}`);
    assert.equal(JSON.stringify(refused).includes('leak'), false);
  }
  s.manager.hook = async ({ operation }) => (operation === 'team.chat.edits'
    ? { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_chat_not_found' } } : null);
  const gone = await ask();
  assert.deepEqual(gone, { ok: false, error: { code: 'CMP-TEAM-0008', reason: 'team_chat_not_found' } });
});

test('chatPins answers { ok, pins, trimmed } with each record checked for the channel; one bad record drops the answer', async (t) => {
  const s = await opened(t);
  assert.equal((await s.pin(true)).ok, true);
  const page = await s.host.dispatch(ME, 'team.chat.history', { channel_id: 'chan_team', limit: 10 });
  const record = page.messages.find((message) => message.id === s.messageId);
  assert.notEqual(record.pinned, null);
  const answerOf = (extra = {}) => ({ ok: true, channel_rev: page.channel_rev, pins: [record], trimmed: false, ...extra });
  const ask = () => s.call('chatPins', { channel_id: 'chan_team' });
  s.manager.hook = async ({ operation }) => (operation === 'team.chat.pins' ? answerOf({ secret: 'leak' }) : null);
  const answer = await ask();
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(Object.keys(answer).sort(), ['ok', 'pins', 'trimmed']);
  assert.equal(answer.trimmed, false);
  assert.equal(answer.pins.length, 1);
  assert.equal(answer.pins[0].id, record.id);
  assert.equal(Object.hasOwn(answer.pins[0], 'edits'), false, 'no earlier versions are kept');
  assert.equal(JSON.stringify(answer).includes('leak'), false);
  const hostile = [
    answerOf({ pins: [record, { ...record, channel_id: 'chan_project_other' }] }), answerOf({ pins: [{ ...record, secret: 'leak' }] }),
    answerOf({ pins: [record, record] }),
    answerOf({ pins: [{ ...record, pinned: null }] }), answerOf({ pins: 'none' }),
    answerOf({ pins: Array.from({ length: 51 }, () => record) }), answerOf({ trimmed: 'no' }),
  ];
  for (const [index, answerFromHost] of hostile.entries()) {
    s.manager.hook = async ({ operation }) => (operation === 'team.chat.pins' ? answerFromHost : null);
    const refused = await ask();
    assert.equal(refused.ok, false, `answer ${index}`);
    assert.equal(refused.error.reason, INVALID, `answer ${index}`);
    assert.equal(JSON.stringify(refused).includes('leak'), false);
  }
  // A host that does not know the read yet: its failure is passed on like any other.
  s.manager.hook = async ({ operation }) => (operation === 'team.chat.pins'
    ? { ok: false, error: { code: 'CMP-HOST-0001', reason: 'unknown_operation' } } : null);
  assert.deepEqual(await ask(), { ok: false, error: { code: 'CMP-HOST-0001', reason: 'unknown_operation' } });
});
