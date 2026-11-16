'use strict';

// new-test-file: the thread column (row 123, slice 2a-6a) is its own surface, and renderer-team-composer.test.js is at the line cap.
// The thread column: opening (the replies button, Reply in thread, R), the column (root, count rule,
// replies, paging, the 400 cap, a failed read), live pushes, queued replies, the thread composer, typing,
// the follow toggle, Esc and focus, closing, layout attributes, and two composer fixes carried in from the
// 2a-5b review. Real modules over the harness bridge; the layout stub gives both logs a height.

const test = require('node:test');
const assert = require('node:assert/strict');
const { OTHER, DOT, MAYA, CHAN, CHAT_MEMBERS, flush, memberTeam, chatMember, message, msgId, overview, openChat, heldAnswers, liveTimers, menu, menuLabels, type, key,
  ROOT, rootMsg, reply, threadAnswer: answerFor, byRoot, openThreadChat, threadOf: aside, threadIds: thIds, channelRow: chRow, openThreadFrom: openFrom,
  chatPush: push, pushMessages } = require('./helpers/team-settings-harness');

// In `memberTeam()` this Jenny is Dot; `message()` is by Dot.
const shell = (h) => h.view.q('.team-shell');
const thRow = (h, seq) => h.view.q(`aside.team-thread .team-msg[data-message-id="${msgId(seq)}"]`);
const thInput = (h) => h.view.q('aside.team-thread .team-composer__input');
const chInput = (h) => h.view.q('[data-team-region="composer"] .team-composer__input');

// ------------------------------------------------------------------ opening

test('the replies foot is a button that opens the thread; Reply in thread and R open it too', async (t) => {
  const { h } = await openThreadChat();
  t.after(h.restore);
  const link = chRow(h, 2).querySelector('.team-thread-link');
  assert.equal(link.tagName, 'BUTTON');
  assert.match(link.textContent, /2 replies/);
  link.click();
  await flush();
  assert.deepEqual(h.sent('chatThread').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN, root_id: ROOT, limit: 100 }]);
  assert.ok(aside(h));
  assert.equal(shell(h).dataset.thread, 'side');
  assert.equal(h.window.document.activeElement, thInput(h), 'the focus goes to the thread composer');
  h.view.q('[data-team-thread-action="close"]').click();
  await flush();
  assert.equal(aside(h), null);
  assert.notEqual(shell(h).dataset.thread, 'side');
  const replyButton = chRow(h, 1).querySelector('.team-acts [data-team-msg-action="reply"]');
  assert.equal(replyButton.getAttribute('title'), 'Reply in thread (R)');
  replyButton.click();
  await flush();
  assert.equal(h.sent('chatThread').at(-1).payload.root_id, msgId(1));
  key(h, thInput(h), 'Escape');
  await flush();
  chRow(h, 2).focus();
  key(h, chRow(h, 2), 'r');
  await flush();
  assert.equal(h.sent('chatThread').at(-1).payload.root_id, ROOT, 'R on a focused row');
});

test('R is ignored in a text field and while a menu is open, and goes back to an open edit', async (t) => {
  const { h } = await openThreadChat();
  t.after(h.restore);
  type(h, 'r', chInput(h));
  key(h, chInput(h), 'r');
  chRow(h, 2).querySelector('[data-team-msg-action="more"]').click();
  key(h, chRow(h, 2), 'r');
  assert.equal(h.sent('chatThread').length, 0);
  key(h, h.window.document.activeElement, 'Escape');
  chRow(h, 1).focus();
  key(h, chRow(h, 1), 'e');
  const box = chRow(h, 1).querySelector('.team-edit__input');
  chRow(h, 2).focus();
  key(h, chRow(h, 2), 'r');
  await flush();
  assert.equal(h.sent('chatThread').length, 0, 'no thread while an edit is open');
  assert.equal(h.window.document.activeElement, box, 'back to the edit');
});

test('a reply opens its root’s thread: R on a reply keeps the shown thread and focuses its composer', async (t) => {
  const { h } = await openThreadChat();
  t.after(h.restore);
  await openFrom(h);
  thRow(h, 3).focus();
  key(h, thRow(h, 3), 'r');
  await flush();
  assert.equal(h.sent('chatThread').length, 1, 'the same thread, not read again');
  assert.equal(h.window.document.activeElement, thInput(h));
  thRow(h, 3).querySelector('[data-team-msg-action="more"]').click();
  assert.deepEqual(menuLabels(h), ['Add reaction', 'PinP', 'Edit', 'Delete'], 'no Mark unread or Reply in a thread');
  assert.equal(aside(h).querySelector('[data-team-msg-action="reply"], .team-thread-link'), null);
});

// ------------------------------------------------------------------ the column

test('the column shows the root, the count rule and the replies oldest first', async (t) => {
  const { h } = await openThreadChat();
  t.after(h.restore);
  await openFrom(h);
  assert.deepEqual(thIds(h), [ROOT, msgId(3), msgId(4)]);
  assert.equal(aside(h).querySelector('.team-thread__count').textContent, '2 replies');
  assert.equal(aside(h).querySelector('.team-head__name').textContent, 'Thread');
  assert.equal(aside(h).querySelector('.team-head__sub').textContent, '#team');
});

test('paging with after_seq while has_more, one call in flight, capped at 400 with a line', async (t) => {
  const gate = heldAnswers();
  const { h } = await openThreadChat({ answers: { chatThread: gate.answer } });
  t.after(h.restore);
  await openFrom(h);
  const page = (from) => Array.from({ length: 100 }, (_v, i) => reply(10 + from + i));
  gate.release(answerFor({ replies: page(0), has_more: true }));
  await flush();
  assert.equal(gate.calls.length, 2);
  assert.equal(gate.calls[1].after_seq, 109);
  pushMessages(h, [], true); // a reset while a page is out: still one call in flight
  await flush();
  assert.equal(gate.calls.length, 2, 'one call in flight');
  gate.release(answerFor({ replies: page(100), has_more: true }));
  await flush();
  assert.equal(gate.calls.at(-1).after_seq, undefined, 'the reset reads from the start');
  for (let n = 0; n < 4; n += 1) { gate.release(answerFor({ replies: page(n * 100), has_more: true })); await flush(); }
  assert.equal(thIds(h).length, 401, 'the root and the first 400 replies');
  assert.match(aside(h).querySelector('.team-thread__capped').textContent, /first 400 replies/);
  const calls = gate.calls.length;
  await flush();
  assert.equal(gate.calls.length, calls, 'no page past 400');
});

test('a failed read keeps the replies shown and offers Try again', async (t) => {
  let n = 0;
  const refused = { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } };
  const { h } = await openThreadChat({ answers: { chatThread: () => { n += 1; return n === 2 ? refused : answerFor({ has_more: n === 1 }); } } });
  t.after(h.restore);
  await openFrom(h);
  assert.deepEqual(thIds(h), [ROOT, msgId(3), msgId(4)], 'kept');
  const error = aside(h).querySelector('.team-thread__error');
  assert.match(error.textContent, /Replies could not be loaded/);
  error.querySelector('button').click();
  await flush();
  assert.equal(h.sent('chatThread').length, 3);
  assert.equal(h.sent('chatThread')[2].payload.after_seq, 4);
  assert.equal(aside(h).querySelector('.team-thread__error'), null);
});

// ------------------------------------------------------------------ live

test('live pushes: a reply once, an edit and a delete update it, a root push updates the root', async (t) => {
  const { h } = await openThreadChat();
  t.after(h.restore);
  await openFrom(h);
  pushMessages(h, [reply(5)]);
  pushMessages(h, [reply(5)]);
  await flush();
  assert.deepEqual(thIds(h), [ROOT, msgId(3), msgId(4), msgId(5)]);
  assert.equal(chRow(h, 5), null, 'never in the channel');
  pushMessages(h, [reply(3, { text: 'changed words', rev: 9, edited_at: new Date().toISOString() }), reply(4, { deleted: { by: DOT, at: new Date().toISOString() } })]);
  pushMessages(h, [rootMsg({ text: 'root, edited', rev: 5 })]);
  await flush();
  assert.match(thRow(h, 3).textContent, /changed words/);
  assert.ok(thRow(h, 4).querySelector('.team-msg__deleted'));
  assert.match(thRow(h, 2).textContent, /root, edited/);
});

test('reset and coming back online read the thread again from the start', async (t) => {
  const { h } = await openThreadChat();
  t.after(h.restore);
  await openFrom(h);
  pushMessages(h, [message(1), rootMsg()], true);
  await flush();
  assert.equal(h.sent('chatThread').length, 2);
  assert.equal(h.sent('chatThread')[1].payload.after_seq, undefined);
  h.listeners.state({ teams: [memberTeam({ state: 'reconnecting' })] });
  await flush();
  h.listeners.state({ teams: [memberTeam()] });
  await flush();
  assert.equal(h.sent('chatThread').length, 3, 'back online');
  assert.ok(aside(h), 'still open');
});

test('a late answer for a closed or a replaced thread changes nothing and asks nothing', async (t) => {
  const gate = heldAnswers();
  const follow = heldAnswers();
  const { h } = await openThreadChat({ answers: { chatThread: gate.answer, chatFollow: follow.answer } });
  t.after(h.restore);
  await openFrom(h);
  gate.release(answerFor({ has_more: true, following: true }));
  await flush();
  assert.equal(gate.calls.length, 2, 'a page is owed');
  aside(h).querySelector('[data-team-thread-action="follow"]').click();
  await flush();
  h.view.q('[data-team-thread-action="close"]').click();
  gate.release(answerFor({ replies: [reply(5)], has_more: true }));
  follow.release({ ok: true, root_id: ROOT, on: false });
  await flush();
  assert.equal(aside(h), null);
  assert.equal(gate.calls.length, 2, 'no page asked after Close');
  await openFrom(h);
  await openFrom(h, 1);
  gate.release(answerFor());
  await flush();
  assert.deepEqual(thIds(h), [], 'the answer for the replaced thread is dropped');
  gate.release({ ok: true, root: message(1, { text: 'other root' }), replies: [], has_more: false });
  await flush();
  assert.deepEqual(thIds(h), [msgId(1)]);
});

// ------------------------------------------------------------------ queued replies

const outReply = (id, over = {}) => ({ entry_id: id, operation: 'post', channel_id: CHAN, thread_root_id: ROOT, message_id: null, text: 'my reply',
  created_at: new Date().toISOString(), state: 'queued', error: null, ...over });
const myReplies = (h) => h.view.qa('aside.team-thread .team-msg').filter((el) => /my reply/.test(el.textContent));

test('a queued reply is drawn at the end of its thread, never in the channel, and once when it settles in either order', async (t) => {
  for (const order of ['outbox first', 'message first']) {
    const { h } = await openThreadChat();
    t.after(h.restore);
    await openFrom(h);
    push(h, { type: 'outbox', outbox: [outReply('out_e1_entry_0000000')], settled: [] });
    await flush();
    assert.equal(myReplies(h).length, 1, order);
    assert.equal(myReplies(h)[0].dataset.pending, 'true');
    assert.equal(h.view.qa('[data-team-region="timeline"] .team-msg[data-pending]').length, 0, 'never in the channel');
    const settle = () => push(h, { type: 'outbox', outbox: [], settled: [{ entry_id: 'out_e1_entry_0000000', ok: true, message_id: msgId(7), seq: 7, rev: 1 }] });
    const arrive = () => pushMessages(h, [reply(7, { text: 'my reply', created_at: new Date().toISOString() })]);
    if (order === 'outbox first') { settle(); await flush(); arrive(); } else { arrive(); await flush(); settle(); }
    await flush();
    assert.equal(myReplies(h).length, 1, order + ': drawn once');
    assert.equal(myReplies(h)[0].dataset.messageId, msgId(7));
  }
});

test('a failed reply offers Retry and Dismiss rules as in the channel; Retry posts to the thread', async (t) => {
  const failed = outReply('out_f_entry_00000000', { state: 'failed', error: { code: 'CMP-HOST-0001', reason: 'role_forbidden' } });
  const { h } = await openThreadChat({ answers: { chatOverview: overview({ outbox: [failed] }) } });
  t.after(h.restore);
  await openFrom(h);
  const row = aside(h).querySelector('.team-msg[data-pending="true"]');
  assert.deepEqual([...row.querySelectorAll('.team-msg__foot button')].map((b) => b.textContent.trim()), ['Retry', 'Delete']);
  row.querySelector('[data-team-msg-action="retry"]').click();
  await flush();
  assert.deepEqual(h.sent('chatPost').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN, text: 'my reply', thread_root_id: ROOT }]);
});

// ------------------------------------------------------------------ the thread composer

test('the thread composer posts with the root, keeps its own draft and sends typing with the root', async (t) => {
  const drafts = { [CHAN]: 'channel draft', [ROOT]: 'thread draft' };
  const { h } = await openThreadChat({ answers: { chatDraftGet: (p) => ({ ok: true, text: drafts[p.thread_root_id || p.channel_id] }) } });
  t.after(h.restore);
  await openFrom(h);
  assert.deepEqual(h.sent('chatDraftGet').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN }, { team_id: OTHER, channel_id: CHAN, thread_root_id: ROOT }]);
  assert.equal(chInput(h).value, 'channel draft');
  assert.equal(thInput(h).value, 'thread draft');
  assert.equal(thInput(h).getAttribute('placeholder'), 'Reply in thread');
  type(h, 'a reply', thInput(h));
  assert.deepEqual(h.sent('chatTyping').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN, thread_root_id: ROOT }]);
  type(h, 'a reply!', thInput(h));
  assert.equal(h.sent('chatTyping').length, 1, 'at most once every 3 s');
  key(h, thInput(h), 'Enter');
  await flush();
  assert.deepEqual(h.sent('chatPost').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN, text: 'a reply!', thread_root_id: ROOT }]);
  assert.equal(chInput(h).value, 'channel draft', 'the channel composer is untouched');
  h.view.q('[data-team-thread-action="close"]').click();
  await flush();
  const saved = h.sent('chatDraftSet').map((c) => c.payload);
  assert.ok(saved.every((p) => p.thread_root_id === ROOT), 'only the thread draft was saved: ' + JSON.stringify(saved));
});

test('a late thread draft answer does not overwrite typed text; a read-only member gets the sentence', async (t) => {
  const gate = heldAnswers({ ok: true, text: 'old thread draft' });
  const { h } = await openThreadChat({ answers: { chatDraftGet: (p) => (p.thread_root_id ? gate.answer(p) : { ok: true, text: '' }) } });
  t.after(h.restore);
  await openFrom(h);
  type(h, 'new words', thInput(h));
  gate.release();
  await flush();
  assert.equal(thInput(h).value, 'new words');
  const ro = await openThreadChat({ teams: [memberTeam({ role: 'read_only' })] });
  t.after(ro.h.restore);
  await openFrom(ro.h);
  assert.equal(thInput(ro.h), null);
  assert.match(aside(ro.h).querySelector('.team-composer--closed').textContent, /You can read this team/);
  assert.equal(ro.h.sent('chatDraftGet').length, 0);
});

test('a lock closes the thread: no composer and no call behind it', async (t) => {
  for (const state of ['pending', 'revoked', 'update_required']) {
    const { h } = await openThreadChat();
    t.after(h.restore);
    await openFrom(h);
    type(h, 'unsent', thInput(h));
    const before = h.calls.length;
    h.listeners.state({ teams: [memberTeam({ state })] });
    await flush();
    assert.equal(aside(h), null, state);
    assert.deepEqual(h.calls.slice(before).filter((c) => /^chat/.test(c.method)).map((c) => c.method), [], state + ': no chat call');
  }
});

// ------------------------------------------------------------------ typing

test('typing in a thread shows only in that thread, ends 6 s after its last push, and leaves no timer when closed', async (t) => {
  const members = [...CHAT_MEMBERS, chatMember(MAYA, '<b>Maya</b>')];
  const { h } = await openThreadChat({ members });
  t.after(h.restore);
  await openFrom(h);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const live = liveTimers(t);
  const line = aside(h).querySelector('.team-typing');
  const channelLine = h.view.q('[data-team-region="composer"] .team-typing');
  push(h, { type: 'typing', channel_id: CHAN, thread_root_id: ROOT, member_id: MAYA });
  assert.equal(line.textContent.replace(/[⁨⁩]/g, ''), '<b>Maya</b> is typing');
  assert.equal(line.querySelector('b'), null, 'a name with markup is text');
  assert.equal(channelLine.textContent, '', 'not in the channel line');
  push(h, { type: 'typing', channel_id: CHAN, thread_root_id: null, member_id: MAYA });
  assert.equal(line.textContent.replace(/[⁨⁩]/g, ''), '<b>Maya</b> is typing');
  t.mock.timers.tick(6_000);
  assert.equal(line.textContent, '');
  assert.equal(line.isConnected, true, 'the line keeps its place');
  push(h, { type: 'typing', channel_id: CHAN, thread_root_id: ROOT, member_id: MAYA });
  h.view.q('[data-team-thread-action="close"]').click();
  assert.deepEqual(h.chat.typing(OTHER, CHAN, ROOT), [], 'gone at Close, no timer advanced');
  const told = [];
  const release = h.chat.subscribe((change) => told.push(change));
  push(h, { type: 'typing', channel_id: CHAN, thread_root_id: ROOT, member_id: MAYA });
  release();
  assert.deepEqual(h.chat.typing(OTHER, CHAN, ROOT), [], 'a typing push for a closed thread is ignored');
  assert.deepEqual(told, [], 'and tells nothing');
  t.mock.timers.tick(6_000);
  assert.equal(live.size, 0, 'no timer left');
});

test('a root author named with markup is text in the thread', async (t) => {
  const members = [chatMember(DOT, '<img src=x onerror=boom()>Dot')];
  const { h } = await openThreadChat({ members });
  t.after(h.restore);
  await openFrom(h);
  assert.equal(aside(h).querySelector('img'), null);
  assert.match(thRow(h, 2).querySelector('.team-msg__author').textContent, /<img src=x/);
});

// ------------------------------------------------------------------ follow

test('follow: no toggle without a boolean following; the answered state; a click sends the opposite once', async (t) => {
  const { h } = await openThreadChat();
  t.after(h.restore);
  await openFrom(h);
  assert.equal(aside(h).querySelector('[data-team-thread-action="follow"]'), null, 'nothing behind it, nothing drawn');
  const gate = heldAnswers();
  const second = await openThreadChat({ answers: { chatThread: byRoot({ following: true }), chatFollow: gate.answer } });
  t.after(second.h.restore);
  await openFrom(second.h);
  const bell = () => aside(second.h).querySelector('[data-team-thread-action="follow"]');
  assert.equal(bell().getAttribute('aria-pressed'), 'true');
  bell().click();
  bell().click();
  await flush();
  assert.deepEqual(gate.calls, [{ team_id: OTHER, channel_id: CHAN, root_id: ROOT, on: false }]);
  gate.release({ ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } });
  await flush();
  assert.equal(bell().getAttribute('aria-pressed'), 'true', 'a refusal keeps the state');
  assert.match(aside(second.h).querySelector('.team-thread__note').textContent, /Could not change/);
  bell().click();
  gate.release({ ok: true, root_id: ROOT, on: false });
  await flush();
  assert.equal(bell().getAttribute('aria-pressed'), 'false');
});

test('follow: a later answer updates the toggle, and your own settled reply reads once more', async (t) => {
  let following = false;
  const { h } = await openThreadChat({ answers: { chatThread: (p) => answerFor({ following, replies: p.after_seq ? [] : [reply(3), reply(4)] }) } });
  t.after(h.restore);
  await openFrom(h);
  const bell = () => aside(h).querySelector('[data-team-thread-action="follow"]');
  assert.equal(bell().getAttribute('aria-pressed'), 'false');
  following = true;
  push(h, { type: 'outbox', outbox: [outReply('out_e1_entry_0000000')], settled: [] });
  await flush();
  push(h, { type: 'outbox', outbox: [], settled: [{ entry_id: 'out_e1_entry_0000000', ok: true, message_id: msgId(7), seq: 7, rev: 1 }] });
  await flush();
  assert.deepEqual(h.sent('chatThread').slice(1).map((c) => c.payload.after_seq), [4], 'one read after your reply settled');
  assert.equal(bell().getAttribute('aria-pressed'), 'true');
});

// ------------------------------------------------------------------ Esc, focus, closing

test('Esc closes the menu, then the edit, then the thread; the focus returns to the opening row', async (t) => {
  const { h } = await openThreadChat();
  t.after(h.restore);
  await openFrom(h);
  const doc = h.window.document;
  thRow(h, 3).querySelector('[data-team-msg-action="more"]').click();
  key(h, doc.activeElement, 'Escape');
  assert.equal(menu(h), null);
  assert.ok(aside(h), 'the menu first');
  thRow(h, 3).focus();
  key(h, thRow(h, 3), 'e');
  key(h, thRow(h, 3).querySelector('.team-edit__input'), 'Escape');
  assert.ok(aside(h), 'then the edit');
  key(h, thInput(h), 'Escape');
  await flush();
  assert.equal(aside(h), null, 'then the thread');
  assert.equal(doc.activeElement, chRow(h, 2), 'back to the row that opened it');
  await openFrom(h);
  pushMessages(h, [message(1)], true);
  await flush();
  key(h, thInput(h), 'Escape');
  await flush();
  assert.equal(doc.activeElement, chInput(h), 'the channel composer when that row is gone');
});

test('changing team, cleared and a root the host no longer has close the thread; the last says so in the channel', async (t) => {
  const other = memberTeam({ team_id: 'team_B', team_name: 'Beta lab' });
  const { h } = await openThreadChat({ teams: [memberTeam(), other] });
  t.after(h.restore);
  await openFrom(h);
  h.view.q('[data-team-tab-action="switch"]').click();
  [...h.window.document.querySelectorAll('.team-switch-menu [role="menuitemradio"]')].find((el) => el.textContent.includes('Beta lab')).click();
  await flush();
  assert.equal(aside(h), null, 'another team');
  const c = await openThreadChat();
  t.after(c.h.restore);
  await openFrom(c.h);
  push(c.h, { type: 'cleared' });
  await flush();
  assert.equal(aside(c.h), null, 'cleared');
  const g = await openThreadChat({ answers: { chatThread: { ok: false, error: { code: 'CMP-TEAM-0004', reason: 'team_chat_not_found' } } } });
  t.after(g.h.restore);
  await openFrom(g.h);
  assert.equal(aside(g.h), null, 'gone from the host');
  assert.match(g.h.view.q('[data-team-region="timeline"] .team-thread-gone').textContent, /no longer on the host/);
  assert.equal(g.h.window.document.querySelector('.inv-toast'), null, 'never a toast');
});

test('a push to the channel keeps the thread composer, and a push to the thread keeps the channel composer', async (t) => {
  const { h } = await openThreadChat();
  t.after(h.restore);
  await openFrom(h);
  const th = thInput(h);
  type(h, 'half a reply', th);
  th.setSelectionRange(4, 4);
  pushMessages(h, [message(5, { text: 'channel news' })]);
  await flush();
  assert.equal(thInput(h), th);
  assert.equal(th.value, 'half a reply');
  assert.equal(th.selectionStart, 4);
  const ch = chInput(h);
  type(h, 'half a message', ch);
  ch.focus();
  ch.setSelectionRange(2, 2);
  pushMessages(h, [reply(6)]);
  await flush();
  assert.equal(chInput(h), ch);
  assert.equal(ch.selectionStart, 2);
  assert.equal(h.window.document.activeElement, ch, 'the focus stays in the channel');
});

test('layout: data-thread="side" while open; under 720 px data-screen="thread", and Back closes it as Close does', async (t) => {
  const { h } = await openThreadChat({ narrow: true });
  t.after(h.restore);
  await openFrom(h);
  assert.equal(shell(h).dataset.thread, 'side');
  assert.equal(shell(h).dataset.screen, 'thread');
  type(h, 'half a reply', thInput(h));
  aside(h).querySelector('[data-team-thread-action="back"]').click();
  await flush();
  assert.equal(shell(h).dataset.screen, 'channel');
  assert.equal(aside(h), null, 'no thread left running behind the channel');
  assert.equal(shell(h).dataset.thread, undefined);
  assert.equal(h.window.document.activeElement, chRow(h, 2), 'the focus goes back to the opening row');
  assert.equal(h.sent('chatDraftSet').at(-1).payload.text, 'half a reply', 'the draft is saved');
});

test('Esc while composing text (IME) closes nothing: not the thread, not an edit, not the mention list', async (t) => {
  const { h } = await openThreadChat();
  t.after(h.restore);
  await openFrom(h);
  const ime = [{ isComposing: true }, { keyCode: 229 }];
  for (const over of ime) key(h, thInput(h), 'Escape', over);
  assert.ok(aside(h), 'the thread stays');
  thRow(h, 3).focus();
  key(h, thRow(h, 3), 'e');
  const box = thRow(h, 3).querySelector('.team-edit__input');
  for (const over of ime) key(h, box, 'Escape', over);
  assert.ok(thRow(h, 3).querySelector('.team-edit__input'), 'the edit stays');
  key(h, box, 'Escape');
  aside(h).querySelector('[data-team-composer="mention"]').click();
  const list = aside(h).querySelector('.team-menu--mention');
  assert.equal(list.hidden, false);
  for (const over of ime) key(h, thInput(h), 'Escape', over);
  assert.equal(list.hidden, false, 'the mention list stays');
  assert.ok(aside(h));
});

test('F6 skips a region that is not shown and still moves', async (t) => {
  const { h } = await openThreadChat({ narrow: true });
  t.after(h.restore);
  await openFrom(h);
  const timeline = h.view.q('[data-team-region="timeline"]');
  timeline.checkVisibility = () => false; // the channel screen is hidden under 720 px
  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    key(h, h.window.document.activeElement, 'F6');
    const el = h.window.document.activeElement;
    assert.equal(timeline.contains(el), false, 'never the hidden timeline');
    seen.add(el);
  }
  assert.ok(seen.size > 1, 'the focus moves');
});

test('F6 reaches the thread and its composer', async (t) => {
  const { h } = await openThreadChat();
  t.after(h.restore);
  await openFrom(h);
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    key(h, h.window.document.activeElement, 'F6');
    const el = h.window.document.activeElement;
    seen.push(aside(h).contains(el) ? (el === thInput(h) ? 'thread composer' : 'thread') : 'channel');
  }
  assert.ok(seen.includes('thread') && seen.includes('thread composer'), seen.join(', '));
});

// ------------------------------------------------------------------ carried in from the 2a-5b review

test('(a) a press on the mention list keeps the focus by itself; one dragged off the list leaves nothing behind', async (t) => {
  const { h } = await openChat({ members: [...CHAT_MEMBERS, chatMember(MAYA, 'Maya')] });
  t.after(h.restore);
  const W = h.window;
  h.view.q('[data-team-composer="mention"]').click();
  const option = () => h.view.qa('.team-menu--mention [role="option"]').find((el) => el.textContent.includes('Maya'));
  const press = new W.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  option().dispatchEvent(press);
  assert.equal(press.defaultPrevented, true);
  chInput(h).dispatchEvent(new W.FocusEvent('focusout', { bubbles: true, relatedTarget: null })); // dragged off, then the focus left
  assert.equal(h.view.q('.team-menu--mention').hidden, true, 'the list closes when the focus leaves');
  h.view.q('[data-team-composer="mention"]').click();
  option().dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  option().dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(chInput(h).value, '@Maya ');
});

test('(b) write access going and coming back in one frame restores the stored draft and does not clear it', async (t) => {
  let stored = 'stored draft';
  const sets = [];
  const { h } = await openChat({ answers: { chatDraftGet: () => ({ ok: true, text: stored }), chatDraftSet: (p) => { sets.push(p.text); stored = p.text; return { ok: true }; } } });
  t.after(h.restore);
  assert.equal(chInput(h).value, 'stored draft');
  type(h, 'typed words', chInput(h));
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(sets, ['typed words']);
  h.listeners.state({ teams: [memberTeam({ role: 'read_only' })] });
  await flush();
  h.listeners.state({ teams: [memberTeam()] });
  await flush();
  assert.equal(chInput(h).value, 'typed words', 'restored like a fresh composer');
  h.tab.hideTeamTab();
  await flush();
  assert.ok(!sets.includes(''), 'never cleared: ' + JSON.stringify(sets));
});

