'use strict';

// new-test-file: renderer-team-thread.test.js is near the line cap; this file holds the thread column's
// reads under live pushes (row 123, slice 2a-6a review round): paging that never skips a reply, a read
// from the start that never drops one pushed meanwhile and replaces what is shown only when finished,
// Try again repeating the read that failed, an older record never undoing a newer one, a push carried
// through a closing menu, the follow state against an older read, one draw per change, and your own
// reply settling. Real modules over the harness bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { OTHER, CHAN, CHAT_MEMBERS, MAYA, flush, msgId, message, chatMember, heldAnswers, ROOT, rootMsg, reply, threadAnswer, openThreadChat,
  threadOf, threadIds, openThreadFrom, chatPush, pushMessages } = require('./helpers/team-settings-harness');

const page = (from, n = 100) => Array.from({ length: n }, (_v, i) => reply(10 + from + i));
const idsOf = (from, n) => Array.from({ length: n }, (_v, i) => msgId(10 + from + i));
const refused = { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } };
const bell = (h) => threadOf(h).querySelector('[data-team-thread-action="follow"]');
const tryAgain = (h) => threadOf(h).querySelector('.team-thread__error button');

test('a reply pushed while a page is out is read once, in order, and paging goes on after the last page delivered', async (t) => {
  const gate = heldAnswers();
  const { h } = await openThreadChat({ answers: { chatThread: gate.answer } });
  t.after(h.restore);
  await openThreadFrom(h);
  gate.release(threadAnswer({ replies: page(0), has_more: true }));
  await flush();
  pushMessages(h, [reply(500)]);
  await flush();
  assert.equal(threadIds(h).includes(msgId(500)), false, 'held aside while pages are owed: the paging brings it');
  gate.release(threadAnswer({ replies: page(100), has_more: true }));
  await flush();
  assert.equal(gate.calls.at(-1).after_seq, 209, 'page 3 asks after the last reply an answer delivered');
  gate.release(threadAnswer({ replies: page(200, 50), has_more: false }));
  await flush();
  assert.deepEqual(threadIds(h), [ROOT, ...idsOf(0, 250), msgId(500)]);
});

test('a reply pushed after a failed page is read once, in order, after Try again', async (t) => {
  let n = 0;
  const answers = [threadAnswer({ replies: page(0), has_more: true }), refused, threadAnswer({ replies: page(100), has_more: false })];
  const { h } = await openThreadChat({ answers: { chatThread: () => answers[n++] } });
  t.after(h.restore);
  await openThreadFrom(h);
  assert.ok(tryAgain(h));
  pushMessages(h, [reply(500)]);
  await flush();
  tryAgain(h).click();
  await flush();
  assert.equal(h.sent('chatThread')[2].payload.after_seq, 109);
  assert.deepEqual(threadIds(h), [ROOT, ...idsOf(0, 200), msgId(500)]);
});

test('a reply pushed while the first read is out stays when the answer does not have it', async (t) => {
  const gate = heldAnswers();
  const { h } = await openThreadChat({ answers: { chatThread: gate.answer } });
  t.after(h.restore);
  await openThreadFrom(h);
  pushMessages(h, [reply(7)]);
  await flush();
  gate.release(threadAnswer());
  await flush();
  assert.deepEqual(threadIds(h), [ROOT, msgId(3), msgId(4), msgId(7)]);
});

test('a reset re-reads a shown thread without tearing it down; the replies it no longer has go at the end', async (t) => {
  const gate = heldAnswers();
  const { h } = await openThreadChat({ answers: { chatThread: gate.answer } });
  t.after(h.restore);
  await openThreadFrom(h);
  gate.release(threadAnswer({ replies: page(0), has_more: true }));
  await flush();
  gate.release(threadAnswer({ replies: page(100, 50), has_more: false }));
  await flush();
  assert.equal(threadIds(h).length, 151);
  const scroll = threadOf(h).querySelector('.team-thread__scroll');
  const before = new Map([...scroll.querySelectorAll('.team-msg[data-message-id]')].map((el) => [el.dataset.messageId, el]));
  const counts = [];
  const watch = new h.window.MutationObserver(() => counts.push(threadIds(h).length));
  watch.observe(scroll, { childList: true });
  t.after(() => watch.disconnect());
  pushMessages(h, [message(1), rootMsg()], true);
  await flush();
  assert.equal(gate.calls.at(-1).after_seq, undefined, 'from the start');
  gate.release(threadAnswer({ replies: page(0), has_more: true }));
  await flush();
  assert.equal(threadIds(h).length, 151, 'nothing replaced before the read has finished');
  assert.ok(counts.every((count) => count >= 151), 'no pass in between shows fewer replies: ' + counts.join(','));
  gate.release(threadAnswer({ replies: page(100, 49), has_more: false }));
  await flush();
  assert.deepEqual(threadIds(h), [ROOT, ...idsOf(0, 149)], 'the reply the host no longer has is gone');
  for (const id of idsOf(0, 149)) assert.equal(scroll.querySelector(`[data-message-id="${id}"]`), before.get(id), 'the same row node');
});

test('Try again after a failed read from the start reads from the start again', async (t) => {
  let n = 0;
  const answers = [threadAnswer(), refused, threadAnswer({ replies: [reply(3, { text: 'edited while away', rev: 9 })] })];
  const { h } = await openThreadChat({ answers: { chatThread: () => answers[n++] } });
  t.after(h.restore);
  await openThreadFrom(h);
  pushMessages(h, [message(1), rootMsg()], true);
  await flush();
  tryAgain(h).click();
  await flush();
  assert.equal(h.sent('chatThread')[2].payload.after_seq, undefined);
  assert.deepEqual(threadIds(h), [ROOT, msgId(3)]);
  assert.match(threadOf(h).textContent, /edited while away/);
});

test('an answer built before a pushed edit never puts the older text back, for a reply or the root', async (t) => {
  const gate = heldAnswers();
  const { h } = await openThreadChat({ answers: { chatThread: gate.answer } });
  t.after(h.restore);
  await openThreadFrom(h);
  gate.release(threadAnswer({ has_more: true }));
  await flush();
  pushMessages(h, [reply(5, { text: 'edited five', rev: 50 }), rootMsg({ text: 'edited root', rev: 60 })]);
  await flush();
  gate.release(threadAnswer({ replies: [reply(5)], has_more: false }));
  await flush();
  assert.deepEqual(threadIds(h), [ROOT, msgId(3), msgId(4), msgId(5)]);
  assert.match(threadOf(h).textContent, /edited five/);
  assert.match(threadOf(h).textContent, /edited root/);
  assert.doesNotMatch(threadOf(h).textContent, /reply 5|the root/);
});

test('a reply pushed while the notify menu is open reaches the thread when the menu closes for it', async (t) => {
  const { h } = await openThreadChat();
  t.after(h.restore);
  await openThreadFrom(h);
  h.view.q('[data-team-tab-action="notify"]').click();
  await flush();
  assert.ok(h.window.document.querySelector('.team-notify-menu'), 'the menu is open');
  const record = h.chat.team(OTHER).channels.find((c) => c.channel_id === CHAN);
  Object.assign(record, { unread: 5, mention: true }); // the same change also alters the column
  pushMessages(h, [reply(5)]);
  await flush();
  assert.deepEqual(threadIds(h), [ROOT, msgId(3), msgId(4), msgId(5)]);
});

test('a read sent before a follow change never undoes it on screen', async (t) => {
  const gate = heldAnswers();
  const { h } = await openThreadChat({ answers: { chatThread: gate.answer, chatFollow: (p) => ({ ok: true, root_id: ROOT, on: p.on }) } });
  t.after(h.restore);
  await openThreadFrom(h);
  gate.release(threadAnswer({ has_more: true, following: true }));
  await flush();
  assert.equal(bell(h).getAttribute('aria-pressed'), 'true');
  bell(h).click();
  await flush();
  assert.equal(bell(h).getAttribute('aria-pressed'), 'false');
  gate.release(threadAnswer({ replies: [reply(5)], has_more: false, following: true }));
  await flush();
  assert.equal(bell(h).getAttribute('aria-pressed'), 'false', 'the older read is not applied');
});

test('one pushed reply draws the thread once; a typing or presence push does not draw it', async (t) => {
  const { h } = await openThreadChat({ members: [...CHAT_MEMBERS, chatMember(MAYA, 'Maya')] });
  t.after(h.restore);
  await openThreadFrom(h);
  const rows = require('../renderer/team/renderer-team-message-row');
  const real = rows.pendingPosts;
  let passes = 0;
  rows.pendingPosts = function (entries, list, ...rest) {
    if (list.some((m) => m.thread_root_id === ROOT)) passes += 1;
    return real.call(this, entries, list, ...rest);
  };
  t.after(() => { rows.pendingPosts = real; });
  pushMessages(h, [reply(5)]);
  await flush();
  assert.equal(passes, 1, 'one pass for one push');
  passes = 0;
  chatPush(h, { type: 'typing', channel_id: CHAN, thread_root_id: ROOT, member_id: MAYA });
  chatPush(h, { type: 'typing', channel_id: CHAN, thread_root_id: null, member_id: MAYA });
  chatPush(h, { type: 'presence', member_id: MAYA, state: 'away', last_seen_at: null });
  await flush();
  assert.match(threadOf(h).querySelector('.team-typing').textContent, /Maya/, 'the typing line still updates');
  assert.equal(passes, 0, 'no pass for typing or presence');
});

test('your reply settling reads once more, also one queued and settled within one push', async (t) => {
  const queued = { entry_id: 'e9', operation: 'post', channel_id: CHAN, thread_root_id: ROOT, message_id: null, text: 'my reply',
    created_at: new Date().toISOString(), state: 'queued', error: null };
  const { h } = await openThreadChat();
  t.after(h.restore);
  await openThreadFrom(h);
  const before = h.sent('chatThread').length;
  chatPush(h, { type: 'outbox', outbox: [queued], settled: [{ entry_id: 'e9', ok: true, message_id: msgId(7), seq: 7, rev: 7 }] });
  await flush();
  assert.equal(h.sent('chatThread').length, before + 1);
  assert.equal(h.sent('chatThread').at(-1).payload.after_seq, 4);
});
