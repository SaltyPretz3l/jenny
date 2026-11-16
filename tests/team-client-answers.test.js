'use strict';

// The desktop chat client checks every host answer before the renderer sees it
// (slice 2a-4b review): an older history page, a thread page, the read, notify
// and follow answers and the outbox settlement each pass the host's own record
// validator and bounds; a page that fails answers team_chat_answer_invalid and
// carries nothing of the hostile answer. A member who is not online (pending,
// reconnecting) sends no chat command on any direct path. Against the real host
// chat store and dispatcher behind a fake connection manager.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ME, OTHER, createChatFakeHost, settleChats, startChats, tempDir, writeMembership,
} = require('./helpers/team-chat-fake-host');

async function setup(t, options = {}) {
  const host = await createChatFakeHost(t);
  const userData = tempDir(t, 'jenny-team-chat-answers-');
  const teamId = writeMembership(userData).team_id;
  const started = startChats(t, host, { userData, teamId, ...options });
  return { host, teamId, ...started };
}

const INVALID = 'team_chat_answer_invalid';

test('an older history page or a thread page that fails the host checks answers team_chat_answer_invalid', async (t) => {
  const s = await setup(t);
  const root = await s.host.postAs(OTHER, 'root');
  await s.host.postAs(OTHER, 'reply', { thread_root_id: root.message_id });
  for (let n = 0; n < 3; n += 1) await s.host.postAs(OTHER, `older ${n}`);
  const page = await s.host.dispatch(ME, 'team.chat.history', { channel_id: 'chan_team', limit: 100 });
  const thread = await s.host.dispatch(ME, 'team.chat.thread', { channel_id: 'chan_team', root_id: root.message_id, limit: 100 });
  assert.equal(page.ok && thread.ok, true);
  const record = page.messages.at(-1);
  const hostilePages = [
    { ...page, messages: [{ ...record, channel_id: 'chan_project_other' }] },
    { ...page, messages: [{ ...record, secret: 'leak' }] },
    { ...page, has_more: 'yes' },
    { ...page, floor_seq: -1 },
    { ...page, messages: page.messages.slice(0, 3) },
  ];
  for (const [index, hostile] of hostilePages.entries()) {
    s.manager.hook = async ({ operation }) => (operation === 'team.chat.history' ? hostile : null);
    const answer = await s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: 'chan_team', before_seq: 99,
      limit: index === 4 ? 2 : 100 });
    assert.equal(answer.ok, false, `page ${index}`);
    assert.equal(answer.error.reason, INVALID, `page ${index}`);
    assert.equal(JSON.stringify(answer).includes('leak'), false);
  }
  const reply = thread.replies[0];
  const hostileThreads = [
    { ...thread, root: { ...thread.root, channel_id: 'chan_project_other' } },
    { ...thread, replies: [{ ...reply, thread_root_id: record.id }] },
    { ...thread, replies: [{ ...reply, token: 'leak' }] },
    { ...thread, has_more: 1 },
  ];
  for (const [index, hostile] of hostileThreads.entries()) {
    s.manager.hook = async ({ operation }) => (operation === 'team.chat.thread' ? hostile : null);
    const answer = await s.chats.handle('chatThread', { team_id: s.teamId, channel_id: 'chan_team', root_id: root.message_id });
    assert.equal(answer.ok, false, `thread ${index}`);
    assert.equal(answer.error.reason, INVALID, `thread ${index}`);
  }
  s.manager.hook = null;
  const good = await s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: 'chan_team', before_seq: 99, limit: 2 });
  assert.equal(good.ok, true);
  assert.deepEqual(Object.keys(good).sort(), ['floor_seq', 'has_more', 'messages', 'ok']);
  assert.equal(good.messages.length, 2);
  const goodThread = await s.chats.handle('chatThread', { team_id: s.teamId, channel_id: 'chan_team', root_id: root.message_id });
  assert.deepEqual(goodThread.replies.map((message) => message.text), ['reply']);
});

test('read, notify and follow answers are checked; an outbox settlement carries only a valid id and counts', async (t) => {
  const s = await setup(t);
  const root = await s.host.postAs(OTHER, 'root');
  const hostile = {
    'team.chat.mark_read': { ok: true, last_read_seq: 'all' },
    'team.chat.set_notify': { ok: true, level: 'loud' },
    'team.chat.follow': { ok: true, root_id: '../x', on: true },
  };
  s.manager.hook = async ({ operation }) => hostile[operation] || null;
  const answers = [
    await s.chats.handle('chatMarkRead', { team_id: s.teamId, channel_id: 'chan_team', seq: 1 }),
    await s.chats.handle('chatSetNotify', { team_id: s.teamId, channel_id: 'chan_team', level: 'all' }),
    await s.chats.handle('chatFollow', { team_id: s.teamId, channel_id: 'chan_team', root_id: root.message_id, on: true }),
  ];
  for (const answer of answers) assert.equal(answer.error?.reason, INVALID, JSON.stringify(answer));
  s.manager.hook = async ({ operation, dispatch }) => {
    if (operation !== 'team.chat.post') return null;
    const answer = await dispatch();
    return { ...answer, message_id: '../../etc/passwd', seq: -4 };
  };
  const queued = await s.chats.handle('chatPost', { team_id: s.teamId, channel_id: 'chan_team', text: 'mine' });
  await settleChats(s.chats, s.teamId, s.timers);
  const settlement = s.pushes.filter((push) => push.type === 'outbox').flatMap((push) => push.settled)
    .find((item) => item.entry_id === queued.entry_id);
  assert.equal(settlement.ok, true);
  assert.equal(Object.hasOwn(settlement, 'message_id'), false, 'an invalid message id is not passed on');
  assert.equal(Object.hasOwn(settlement, 'seq'), false);
  assert.ok(Number.isSafeInteger(settlement.rev) && settlement.rev >= 1);
});

test('a member who is not online sends no chat command on any direct path', async (t) => {
  for (const state of ['pending', 'reconnecting']) {
    const s = await setup(t);
    const root = await s.host.postAs(OTHER, 'root');
    s.manager.state = state;
    const answers = [
      await s.chats.handle('chatThread', { team_id: s.teamId, channel_id: 'chan_team', root_id: root.message_id }),
      await s.chats.handle('chatMarkRead', { team_id: s.teamId, channel_id: 'chan_team', seq: 1 }),
      await s.chats.handle('chatSetNotify', { team_id: s.teamId, channel_id: 'chan_team', level: 'none' }),
      await s.chats.handle('chatFollow', { team_id: s.teamId, channel_id: 'chan_team', root_id: root.message_id, on: true }),
      await s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: 'chan_team', before_seq: 5 }),
      await s.chats.handle('chatOverview', { team_id: s.teamId }),
    ];
    await settleChats(s.chats, s.teamId, s.timers);
    for (const answer of answers) {
      assert.equal(answer.ok, false, `${state}: ${JSON.stringify(answer)}`);
      assert.equal(answer.error.reason, 'team_not_connected');
    }
    assert.deepEqual(s.manager.calls, [], `${state}: no command reached the manager`);
  }
});

test('a thread page passes following through when it is a boolean and leaves it out when the host sent none', async (t) => {
  const s = await setup(t);
  const root = await s.host.postAs(OTHER, 'root');
  await s.host.postAs(OTHER, 'reply', { thread_root_id: root.message_id });
  const ask = () => s.chats.handle('chatThread', { team_id: s.teamId, channel_id: 'chan_team', root_id: root.message_id });
  const real = await s.host.dispatch(ME, 'team.chat.thread', { channel_id: 'chan_team', root_id: root.message_id, limit: 100 });
  assert.equal(real.following, false, 'the host answers for the asking member');
  const sent = (change) => async ({ operation }) => (operation === 'team.chat.thread' ? change(real) : null);

  s.manager.hook = sent((page) => ({ ...page, following: true }));
  const followed = await ask();
  assert.equal(followed.ok, true);
  assert.equal(followed.following, true);
  assert.deepEqual(Object.keys(followed).sort(), ['following', 'has_more', 'ok', 'read_seq', 'replies', 'root']);

  s.manager.hook = sent((page) => ({ ...page, following: false }));
  assert.equal((await ask()).following, false);

  s.manager.hook = sent(({ following: _dropped, read_seq: _mark, ...older }) => older);
  const older = await ask();
  assert.equal(older.ok, true);
  assert.deepEqual(Object.keys(older).sort(), ['has_more', 'ok', 'replies', 'root'], 'an older host sends none');

  for (const hostile of ['yes', 1, null, 'true']) {
    s.manager.hook = sent((page) => ({ ...page, following: hostile }));
    const answer = await ask();
    assert.equal(answer.ok, false, String(hostile));
    assert.equal(answer.error.reason, INVALID, String(hostile));
  }
});

test('a record the client keeps or pushes carries no earlier versions, from a page and from an event', async (t) => {
  const s = await setup(t);
  const text = (letter) => letter.repeat(5000);
  const edit = async (posted, letter) => {
    const edited = await s.host.dispatch(OTHER, 'team.chat.edit', { channel_id: 'chan_team', message_id: posted.message_id,
      text: text(letter), expected_rev: posted.rev });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    return { message_id: posted.message_id, rev: edited.rev };
  };
  let posted = await s.host.postAs(OTHER, text('a'));
  posted = await edit(await edit(posted, 'b'), 'c');
  const hostRecord = (await s.host.dispatch(OTHER, 'team.chat.history', { channel_id: 'chan_team', limit: 10 })).messages[0];
  assert.equal(hostRecord.edits.length, 2, 'the host record holds the earlier versions');

  assert.equal((await s.chats.handle('chatOverview', { team_id: s.teamId })).ok, true);
  const page = await s.chats.handle('chatHistory', { team_id: s.teamId, channel_id: 'chan_team' });
  assert.equal(page.ok, true, JSON.stringify(page));
  const cached = () => s.chats.cacheOf(s.teamId).open.chan_team.messages;
  const earlier = (value, letters) => letters.some((letter) => JSON.stringify(value).includes(letter.repeat(100)));
  for (const messages of [page.messages, cached()]) {
    const record = messages.find((message) => message.id === posted.message_id);
    assert.equal(Object.hasOwn(record, 'edits'), false, 'no earlier versions kept');
    assert.equal(record.text, text('c'));
    assert.deepEqual(Object.keys(record).sort(), Object.keys(hostRecord).filter((key) => key !== 'edits').sort(),
      'the host record without its earlier versions, and nothing added');
    assert.ok(record.edited_at, 'edited_at still says it was edited');
    assert.equal(earlier(messages, ['a', 'b']), false);
  }

  posted = await edit(posted, 'd');
  await settleChats(s.chats, s.teamId, s.timers);
  const pushed = s.pushes.filter((push) => push.type === 'messages').flatMap((push) => push.messages)
    .filter((message) => message.id === posted.message_id && message.rev === posted.rev);
  assert.equal(pushed.length, 1, 'the event reached the renderer once');
  assert.equal(Object.hasOwn(pushed[0], 'edits'), false);
  assert.equal(Object.hasOwn(cached().find((message) => message.id === posted.message_id), 'edits'), false);
  assert.equal(earlier([pushed, cached()], ['a', 'b', 'c']), false, 'no earlier version text after the event');
});
