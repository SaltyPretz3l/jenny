'use strict';

// new-test-file: a thread's own unread sign (row 123 slice E59) is its own surface, and the thread and timeline test
// files are near the line cap. The replies link's words and its "N new" span, its accessible name and escaping, the
// row redrawn when only the count changes, the thread counted read when its end is on screen in a focused window
// (also a capped thread, a thread the row does not list, and a reply and its row push in either order), a deleted
// root, the read pacing, and the catalogs. The channel row's number and the tab number follow main's counts
// (tests/team-client-thread-marks.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OTHER, CHAN, flush, message, msgId, ROOT, rootMsg, reply, threadAnswer, openThreadChat, channelRow: chRow,
  openThreadFrom: openFrom, chatPush: push } = require('./helpers/team-settings-harness');
const { createChatReads } = require('../renderer/team/renderer-team-chat-reads');

const link = (h) => chRow(h, 2).querySelector('.team-thread-link');
const channelWith = (over = {}) => ({ channel_id: CHAN, kind: 'team', archived: false, rev: 9, last_seq: 4, floor_seq: 1,
  last_read_seq: 4, notify: 'all', unread: 0, unread_capped: false, mention: false, ...over });
const pushRow = (h, over) => push(h, { type: 'channels', partial: true, channels: [channelWith(over)] });
const withThread = (unread, over = {}) => ({ unread, threads: unread ? [{ root_id: ROOT, unread, mention: false }] : [], ...over });
const threadMarks = (h) => h.sent('chatMarkRead').filter((call) => call.payload.thread_root_id).map((call) => call.payload.seq);
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('the link says "N new" in its own span while a followed thread has unseen replies; its name has the same words', async (t) => {
  const { h } = await openThreadChat({ channel: channelWith(withThread(1)) });
  t.after(h.restore);
  const button = link(h);
  assert.match(button.textContent, /^2 replies, 1 new, last /);
  const span = button.querySelector('.team-thread-link__new');
  assert.equal(span.textContent, '1 new');
  assert.equal(button.children.length, 1, 'the span is the only markup');
  assert.equal(button.getAttribute('aria-label'), null, 'the accessible name is the button text itself');
  assert.equal(button.title, button.textContent, 'its title has the same words');
  // One reply and many new: each count takes its own plural form.
  pushRow(h, withThread(12));
  await flush();
  assert.match(link(h).textContent, /^2 replies, 12 new, last /, 'the row redraws when only the thread count changed');
  push(h, { type: 'messages', channel_id: CHAN, messages: [rootMsg({ reply_count: 1, rev: 50 })] });
  await flush();
  assert.match(link(h).textContent, /^1 reply, 12 new, last /);
  // Read: back to today's words.
  pushRow(h, withThread(0));
  await flush();
  assert.match(link(h).textContent, /^1 reply, last /);
  assert.equal(link(h).querySelector('.team-thread-link__new'), null);
});

test('no sign on a thread the row does not list, or with a hostile count; a deleted root keeps its link and sign', async (t) => {
  const { h } = await openThreadChat({ channel: channelWith({ unread: 3, threads: [{ root_id: msgId(9), unread: 3, mention: false }] }) });
  t.after(h.restore);
  assert.equal(link(h).querySelector('.team-thread-link__new'), null, 'another thread\'s count');
  for (const unread of ['<img src=x onerror=alert(1)>', -2, 1.5, null]) {
    pushRow(h, { unread: 1, threads: [{ root_id: ROOT, unread, mention: false }] });
    await flush();
    assert.equal(link(h).querySelector('.team-thread-link__new'), null, String(unread));
    assert.equal(link(h).querySelector('img'), null);
  }
  push(h, { type: 'messages', channel_id: CHAN, messages: [rootMsg({ rev: 60, text: '', deleted: { by: msgId(1).replace('msg_', 'member_'), at: new Date().toISOString() } })] });
  pushRow(h, withThread(2));
  await flush();
  assert.match(link(h).textContent, /^2 replies, 2 new, last /, 'a deleted root keeps its link and its sign');
});

test('the thread counts as read once its end is on screen in a focused window, not while it is scrolled up', async (t) => {
  const many = Array.from({ length: 20 }, (_, n) => reply(n + 3));
  const { h, box } = await openThreadChat({ channel: channelWith(withThread(20)), focused: false,
    answers: { chatThread: () => threadAnswer({ replies: many, root: rootMsg({ reply_count: 20 }) }) } });
  t.after(h.restore);
  const thread = () => h.sent('chatMarkRead').filter((call) => call.payload.thread_root_id);
  await openFrom(h);
  const log = h.view.q('aside.team-thread .team-thread__scroll');
  assert.equal(thread().length, 0, 'not while the window is unfocused, though the column shows its end');
  box.setFocus(true);
  await flush();
  assert.deepEqual(thread().map((call) => call.payload), [{ team_id: OTHER, channel_id: CHAN, seq: 22, thread_root_id: ROOT }]);
  // Scrolled up, a new reply arrives: nothing until the end is on screen again.
  box.scroll(log, 0);
  push(h, { type: 'messages', channel_id: CHAN, messages: [reply(23)] });
  pushRow(h, withThread(1));
  await flush();
  assert.equal(thread().length, 1, 'not while the column is scrolled up');
  box.scroll(log, box.max(log));
  await flush();
  assert.deepEqual(thread().map((call) => call.payload.seq), [22], 'paced: the store holds it for its window');
  await new Promise((resolve) => { setTimeout(resolve, 2100); });
  await flush();
  assert.deepEqual(thread().map((call) => call.payload.seq), [22, 23]);
  assert.equal(h.sent('chatMarkRead').filter((call) => !call.payload.thread_root_id && call.payload.seq > 4).length, 0,
    'the channel mark does not move');
  // Once the row no longer lists the thread, nothing more is sent.
  pushRow(h, withThread(0));
  await flush();
  box.scroll(log, 0);
  box.scroll(log, box.max(log));
  await flush();
  push(h, { type: 'messages', channel_id: CHAN, messages: [reply(24, { author: { kind: 'member', member_id: msgId(1).replace('msg_', 'member_') } })] });
  await new Promise((resolve) => { setTimeout(resolve, 2100); });
  await flush();
  assert.equal(thread().length, 2);
});

test('thread marks are paced per thread, sent only while the row lists the thread, and asked again after a refusal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  let answer = { ok: true, last_read_seq: 0, thread_read_seq: 5 };
  const state = { reads: new Map(), threadReads: new Map() };
  let row = { channel_id: CHAN, last_read_seq: 0, threads: [{ root_id: ROOT, unread: 2, mention: false }] };
  const reads = createChatReads({ send: async (method, payload) => { sent.push(payload); return answer; },
    channel: () => row, stateOf: () => state, notify: () => {}, noAnswer: {} });
  const settle = async () => { for (let n = 0; n < 5; n += 1) await Promise.resolve(); };
  reads.markThreadRead('team_x', CHAN, ROOT, 4);
  reads.markThreadRead('team_x', CHAN, ROOT, 5);
  reads.markRead('team_x', CHAN, 3);
  await settle();
  assert.deepEqual(sent.map((p) => [p.seq, p.thread_root_id || null]), [[4, ROOT], [3, null]], 'a channel mark never waits');
  t.mock.timers.tick(2000);
  await settle();
  assert.deepEqual(sent.slice(2).map((p) => p.seq), [5], 'the held thread mark at the end of its window');
  answer = { ok: false, error: { reason: 'team_unavailable' } };
  t.mock.timers.tick(2000);
  reads.markThreadRead('team_x', CHAN, ROOT, 7);
  await settle();
  assert.equal(sent.length, 4);
  answer = { ok: true, last_read_seq: 0, thread_read_seq: 7 };
  t.mock.timers.tick(9999);
  await settle();
  assert.equal(sent.length, 4, 'none for 10 s after a refusal');
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(sent.at(-1), { team_id: 'team_x', channel_id: CHAN, seq: 7, thread_root_id: ROOT });
  row = { ...row, threads: [] };
  t.mock.timers.tick(5000);
  reads.markThreadRead('team_x', CHAN, ROOT, 9);
  await settle();
  assert.equal(sent.length, 5, 'a thread the row does not list, with no mark from its page (an older host), is not marked');
  reads.markThreadRead('team_x', CHAN, ROOT, 9, 8);
  await settle();
  assert.deepEqual(sent.at(-1), { team_id: 'team_x', channel_id: CHAN, seq: 9, thread_root_id: ROOT },
    'past the mark its own page gave, it is marked though the row does not list it');
  t.mock.timers.tick(5000);
  reads.markThreadRead('team_x', CHAN, ROOT, 9, 9);
  await settle();
  assert.equal(sent.length, 6, 'not at or under that mark');
});

test('every locale has every plural form the new link words need, with the {new} and {time} slots', () => {
  const dir = path.join(__dirname, '..', 'locales');
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    const strings = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const forms = (key) => Object.keys(strings).filter((name) => name.startsWith(key + '#')).map((name) => name.split('#')[1]).sort();
    const wanted = forms('team.chat.replies');
    assert.deepEqual(forms('team.chat.repliesNew'), wanted, `${file} team.chat.repliesNew`);
    assert.deepEqual(forms('team.chat.repliesNewCount'), wanted, `${file} team.chat.repliesNewCount`);
    for (const form of wanted) {
      const text = strings[`team.chat.repliesNew#${form}`];
      assert.ok(text.includes('{new}') && text.includes('{time}'), `${file} ${form}: ${text}`);
      assert.ok(strings[`team.chat.repliesNewCount#${form}`].includes('{count}'), `${file} ${form}`);
    }
  }
});

test('a capped thread (over 400 replies) is marked up to the newest reply it shows; the rest stay unread', async (t) => {
  const page = (after) => Array.from({ length: 100 }, (_, n) => reply(after + 1 + n));
  const { h } = await openThreadChat({ channel: channelWith(withThread(450)),
    answers: { chatThread: (p) => threadAnswer({ root: rootMsg({ reply_count: 450 }), replies: page(p.after_seq || 2), has_more: true }) } });
  t.after(h.restore);
  await openFrom(h);
  await flush();
  assert.ok(h.view.q('aside.team-thread .team-thread__capped'), 'the column says it shows the first 400');
  assert.deepEqual(threadMarks(h), [402], 'the 400th reply: the host holds the mark there, and replies 403 on stay counted');
});

test('a followed thread the row does not list is marked when its page shows replies past its mark; not on an older host', async (t) => {
  const listedNone = channelWith({ unread: 2, threads: [] });
  const modern = await openThreadChat({ channel: listedNone, answers: { chatThread: () => threadAnswer({ following: true, read_seq: 3 }) } });
  t.after(modern.h.restore);
  await openFrom(modern.h);
  assert.deepEqual(threadMarks(modern.h), [4], 'reply 4 lies past the mark 3 the thread answer gave');
  modern.h.restore();
  const older = await openThreadChat({ channel: listedNone, answers: { chatThread: () => threadAnswer({ following: true }) } });
  t.after(older.h.restore);
  await openFrom(older.h);
  assert.deepEqual(threadMarks(older.h), [], 'an older host sends no mark: nothing is sent');
  older.h.restore();
  const unfollowed = await openThreadChat({ channel: listedNone, answers: { chatThread: () => threadAnswer({ following: false, read_seq: 0 }) } });
  t.after(unfollowed.h.restore);
  await openFrom(unfollowed.h);
  assert.deepEqual(threadMarks(unfollowed.h), [], 'a thread not followed has no mark to move');
});

test('a reply in the open thread and its row push: in either order the thread ends marked to that reply', async (t) => {
  for (const order of ['reply first', 'row first']) {
    const { h } = await openThreadChat({ channel: channelWith(withThread(0)) });
    await openFrom(h);
    assert.deepEqual(threadMarks(h), [], `${order}: nothing to mark at first`);
    const replyPush = () => push(h, { type: 'messages', channel_id: CHAN, messages: [reply(5)] });
    if (order === 'reply first') { replyPush(); await flush(); pushRow(h, withThread(1)); } else { pushRow(h, withThread(1)); await flush(); replyPush(); }
    await flush();
    // The row push and the reply each reach the column's pass (renderer-team-tab.js hands every change to it), and
    // each pass checks the mark: a row push after the reply sends 5 at once; a row push before it sends the newest
    // shown then (4), and 5 follows at the end of the store's 2 s window.
    if (order === 'row first') await wait(2100);
    await flush();
    assert.equal(threadMarks(h).at(-1), 5, `${order}: ${threadMarks(h)}`);
    h.restore();
  }
});

test('the column marks nothing while a read is out or after it failed', async (t) => {
  let release = null;
  const answers = { chatThread: (p) => (p.after_seq ? new Promise((resolve) => { release = resolve; })
    : threadAnswer({ has_more: true })) };
  const { h } = await openThreadChat({ channel: channelWith(withThread(2)), answers });
  t.after(h.restore);
  await openFrom(h);
  assert.deepEqual(threadMarks(h), [], 'the second page is out');
  release({ ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } });
  await flush();
  assert.ok(h.view.q('aside.team-thread .team-thread__error'), 'the column shows the failure');
  assert.deepEqual(threadMarks(h), [], 'a failed read marks nothing');
});

// ------------------------------------------------------------ the link's words (renderer-team-message-row.js threadLink)

test('the link\'s words: a translation without the {new} slot, hostile translation text, the plain link\'s title', (t) => {
  const file = require.resolve('../renderer/team/renderer-team-message-row');
  const saved = globalThis.jennyI18n;
  const strings = { 'team.chat.repliesNew': '<b>{count}</b> réponses {time}', 'team.chat.repliesNewCount': '{count} <i>nouvelles</i>',
    'team.chat.replies': '{count} réponses <script>x</script>' };
  const fill = (text, params) => text.replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(params, name) ? String(params[name]) : m));
  globalThis.jennyI18n = { t: (k, d, p) => fill(d, p || {}), tn: (k, count, params) => fill(strings[k], { count, ...params }) };
  delete require.cache[file];
  t.after(() => { globalThis.jennyI18n = saved; delete require.cache[file]; });
  const { threadLink } = require(file);
  const at = new Date(2026, 10, 12, 9, 30).toISOString();
  const fresh = threadLink({ reply_count: 3, last_reply_at: at }, 2);
  assert.ok(fresh.html.endsWith(' <span class="team-thread-link__new">2 &lt;i&gt;nouvelles&lt;/i&gt;</span>'),
    'no {new} slot: the words go at the end, escaped like the rest: ' + fresh.html);
  assert.ok(fresh.html.startsWith('&lt;b&gt;3&lt;/b&gt; réponses '), fresh.html);
  assert.ok(fresh.text.endsWith(' 2 <i>nouvelles</i>') && !fresh.text.includes('span'), 'the title is the plain words');
  const plain = threadLink({ reply_count: 3, last_reply_at: 'not a time <img src=x>' }, 0);
  assert.deepEqual(plain, { text: '3 réponses <script>x</script>', html: '3 réponses &lt;script&gt;x&lt;/script&gt;' },
    'no new replies: today\'s words, escaped, with the same plain words as its title; a hostile time string shows no time');
});

void message;
