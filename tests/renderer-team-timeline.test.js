'use strict';

// Team chat timeline, read side (row 123, slice 2a-5a): history and paging, separators and runs,
// Markdown through the sanitizer, mentions, edited, deleted, Former member, empty and pruned,
// "Jump to latest", read marking, outbox rows, `cleared` and `reset`, and the drawing rule that a
// push never resets scroll, selection or focus. Real modules over the harness bridge; the layout
// stub gives the timeline a height.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ROSTER, OTHER, ME, DOT, MAYA, CHAN, CHAT_MEMBERS, flush, snapshot, memberTeam, hostState, harness, layout, chatChannel, chatMember, message, msgId, overview, openChat, heldAnswers } = require('./helpers/team-settings-harness');

const MIN = 60_000;
const at = (ms) => new Date(ms).toISOString();

const rows = (h) => h.view.qa('.team-scroll .team-msg');
const push = (h, team, messages, reset = false) => h.listeners.chat({ team_id: team, type: 'messages', channel_id: CHAN, reset, messages });

test('runs, day separators, the New separator, edited, deleted and Former member', async (t) => {
  const now = Date.now();
  const twoDaysAgo = now - 2 * 24 * 60 * MIN;
  const recent = now - 30 * MIN;
  const messages = [
    message(1, { author: { kind: 'member', member_id: ME }, created_at: at(twoDaysAgo) }),
    message(2, { author: { kind: 'member', member_id: ME }, created_at: at(twoDaysAgo + 2 * MIN) }),
    message(3, { author: { kind: 'member', member_id: 'member_gone' }, created_at: at(recent) }),
    message(4, { author: { kind: 'member', member_id: ME }, created_at: at(recent + MIN) }),
    message(5, { author: { kind: 'member', member_id: ME }, created_at: at(recent + 2 * MIN), edited_at: at(recent + 3 * MIN) }),
    message(6, { author: { kind: 'member', member_id: ME }, created_at: at(recent + 4 * MIN), text: '', deleted: { by: ME, at: at(recent + 5 * MIN) } }),
    message(7, { author: { kind: 'member', member_id: ME }, created_at: at(recent + 20 * MIN), reply_count: 3, last_reply_at: at(recent + 25 * MIN) }),
  ];
  const { h } = await openChat({ messages, channel: { last_read_seq: 3, last_seq: 7, unread: 4 } });
  t.after(h.restore);
  const log = h.view.q('.team-scroll');
  assert.equal(log.getAttribute('role'), 'log');
  assert.equal(h.view.qa('.team-day').length, 2, 'a separator per day');
  const list = rows(h);
  assert.deepEqual(list.map((row) => row.dataset.first), ['true', 'false', 'true', 'true', 'false', 'false', 'true'], 'a run is one author within 5 minutes');
  assert.equal(list[1].querySelector('.team-msg__author'), null, 'later rows of a run show no name');
  assert.ok(list[1].querySelector('.team-msg__gutter-time').textContent, 'but keep their time in the gutter');
  assert.equal(list[0].querySelector('.team-msg__author').textContent, 'Olive Owner');
  assert.equal(list[0].querySelector('.team-avatar').textContent, 'O');
  const former = list[2];
  assert.equal(former.querySelector('.team-msg__author').textContent, 'Former member');
  assert.equal(former.querySelector('.team-msg__author').dataset.former, 'true');
  assert.equal(former.querySelector('.team-avatar').dataset.former, 'true');
  assert.equal(former.querySelector('.team-avatar').textContent, '', 'an empty avatar');
  const kids = [...log.children];
  const fresh = log.querySelector('.team-new');
  assert.equal(fresh.textContent.trim(), 'New');
  assert.equal(kids.indexOf(fresh) + 1, kids.indexOf(list[3]), 'New sits above the first unread message');
  assert.equal(list[4].querySelector('.team-msg__edited').textContent, 'edited');
  assert.equal(list[5].querySelector('.team-msg__deleted').textContent, 'Message deleted by \u2068Olive Owner\u2069', 'the name is isolated in the sentence');
  assert.equal(list[0].querySelector('.team-msg__author').getAttribute('dir'), 'auto');
  assert.equal(list[5].querySelector('.team-msg__text'), null);
  assert.match(list[6].querySelector('.team-thread-link').textContent, /^3 replies, last /);
  assert.equal(list[6].querySelector('.team-thread-link').tagName, 'BUTTON', 'it opens the thread (2a-6a)');
  // Each row's action row holds Reply in thread and More (2a-6a); the replies foot opens the thread.
  assert.deepEqual([...new Set(h.view.qa('.team-scroll button').map((b) => b.dataset.teamMsgAction))].sort(), ['copy-link', 'more', 'react-pick', 'reply', 'thread', 'versions']);
});

test('the New separator stays where it was drawn when the channel is read', async (t) => {
  const messages = [message(1), message(2, { author: { kind: 'member', member_id: ME } })];
  const { h } = await openChat({ messages, channel: { last_read_seq: 1, last_seq: 2, unread: 1 } });
  t.after(h.restore);
  assert.ok(h.view.q('.team-new'));
  const before = h.view.q('.team-new').nextElementSibling;
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [chatChannel({ last_read_seq: 2, last_seq: 2, unread: 0 })] });
  await flush();
  assert.ok(h.view.q('.team-new'));
  push(h, OTHER, [message(3)]);
  h.listeners.chat({ team_id: OTHER, type: 'members', members: CHAT_MEMBERS });
  await flush();
  assert.equal(h.view.qa('.team-new').length, 1);
  assert.equal(h.view.q('.team-new').nextElementSibling, before, 'later store events do not move it');
});

test('an empty channel: its name and one sentence; a team with only you adds Invite someone', async (t) => {
  const member = await openChat();
  t.after(member.h.restore);
  const empty = member.h.view.q('.team-empty');
  assert.match(empty.textContent, /#team/);
  assert.match(empty.textContent, /Everyone on the team can read and post here\./);
  assert.equal(empty.querySelector('button'), null);
  const owner = await openChat({ teams: [snapshot()], host: hostState(), members: [chatMember(ME, 'Olive Owner', { role: 'owner' })],
    answers: { members: { ok: true, members: [ROSTER[0]] } } });
  t.after(owner.h.restore);
  owner.h.view.q('[data-team-channel="chan_team"]').click(); // a solo owner's tab opens on Overview (row 168)
  await flush();
  const invite = owner.h.view.q('.team-empty [data-team-tab-action="invite"]');
  assert.equal(invite.textContent, 'Invite someone');
  invite.click();
  assert.deepEqual(owner.h.opened, ['team']);
});

test('history pruned: one quiet line at the top when the floor is above the first message the host can give', async (t) => {
  const pruned = await openChat({ messages: [message(40), message(41)], channel: { floor_seq: 40, last_seq: 41 } });
  t.after(pruned.h.restore);
  const first = pruned.h.view.q('.team-scroll').firstElementChild;
  assert.ok(first.classList.contains('team-pruned'));
  assert.match(first.textContent, /removed/);
  const whole = await openChat({ messages: [message(1), message(2)], channel: { floor_seq: 1, last_seq: 2 } });
  t.after(whole.h.restore);
  assert.equal(whole.h.view.q('.team-pruned'), null);
});

test('hostile text renders nothing live: no image, no handler, no javascript: link; a name with markup is text', async (t) => {
  const evil = chatMember('member_evil', '<img src=x onerror="window.pwned=1">');
  const messages = [
    message(1, { author: { kind: 'member', member_id: 'member_evil' }, text: 'hi <img src=x onerror="window.pwned=1"> there' }),
    message(2, { text: '[click](javascript:window.pwned=1) and ![remote](https://evil.invalid/a.png) and [ok](https://example.com/)' }),
    message(3, { text: '<script>window.pwned=1</script><iframe src="https://evil.invalid"></iframe>' }),
  ];
  const { h } = await openChat({ messages, members: [chatMember(DOT, 'Dot'), evil] });
  t.after(h.restore);
  const log = h.view.q('.team-scroll');
  assert.equal(log.querySelector('img, script, iframe, [onerror]'), null);
  assert.equal(log.querySelector('a[href^="javascript:"]'), null);
  assert.equal(log.querySelector('a[href="https://example.com/"]').textContent, 'ok', 'a link stays a link');
  assert.equal(rows(h)[0].querySelector('.team-msg__author').textContent, evil.display_name);
  assert.match(rows(h)[0].querySelector('.team-msg__text').textContent, /<img src=x/, 'raw HTML is shown as text');
  assert.equal(h.window.pwned, undefined);
});

test('R13-F01: a relative link from a member stays text; an in-page and a web link stay links', async (t) => {
  const text = '[a](?jennyUiLanguage=qps-ploc) [b](index.html?x=1) [c](./?x) [d](other.html) [e](#top) [ok](https://example.com/)';
  const { h } = await openChat({ messages: [message(1, { author: { kind: 'member', member_id: DOT }, text })], members: [chatMember(DOT, 'Dot')] });
  t.after(h.restore);
  const body = rows(h)[0].querySelector('.team-msg__text');
  assert.deepEqual(h.view.qa('.team-scroll .team-msg__text a[href]').map((a) => a.getAttribute('href')), ['#top', 'https://example.com/']);
  assert.match(body.textContent, /a b c d e ok/, 'every link keeps its text');
});

test('mentions are marked from the mentions field on text nodes; a mention of you is tinted', async (t) => {
  const text = 'hey <@member_dot>, <@member_me> and <@channel>; not <@member_zz>; `<@member_dot>`';
  const { h } = await openChat({ messages: [message(1, { author: { kind: 'member', member_id: ME }, text, mentions: [DOT, ME, 'channel'] })] });
  t.after(h.restore);
  const marks = h.view.qa('.team-msg__text .team-mention');
  assert.deepEqual(marks.map((el) => el.textContent), ['@Dot', '@Olive Owner', '@channel']);
  assert.deepEqual(marks.map((el) => el.dataset.me), ['true', undefined, 'true']);
  const body = h.view.q('.team-msg__text').textContent;
  assert.match(body, /not <@member_zz>/, 'a token the host did not resolve stays as written');
  assert.equal(h.view.q('.team-msg__text code').textContent, '<@member_dot>', 'code is left alone');
});

test('a push while scrolled up with text selected keeps scroll and selection and offers Jump to latest; at the bottom it follows', async (t) => {
  const messages = Array.from({ length: 20 }, (_v, i) => message(i + 1, { created_at: at(Date.now() - 60 * MIN) }));
  const { h, box, scroller } = await openChat({ messages });
  t.after(h.restore);
  const log = scroller();
  assert.ok(box.atBottom(log), 'opens at the latest message');
  assert.equal(h.view.q('.team-jump').hidden, true);
  box.scroll(log, 100);
  const node = rows(h)[4].querySelector('.team-msg__text p').firstChild;
  const range = h.window.document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 7);
  const selection = h.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const shown = rows(h)[4];
  push(h, OTHER, [message(21, { created_at: at(Date.now()) })]);
  await flush();
  assert.equal(log.scrollTop, 100);
  assert.equal(scroller(), log, 'the timeline region is the same node');
  assert.equal(rows(h)[4], shown, 'an existing row is not redrawn');
  assert.equal(selection.rangeCount, 1);
  assert.equal(selection.getRangeAt(0).startContainer, node);
  assert.equal(node.isConnected, true);
  assert.equal(selection.toString(), 'Message');
  const jump = h.view.q('.team-jump');
  assert.equal(jump.hidden, false);
  jump.click();
  assert.ok(box.atBottom(log));
  assert.equal(h.view.q('.team-jump').hidden, true);
  push(h, OTHER, [message(22, { created_at: at(Date.now()) })]);
  await flush();
  assert.ok(box.atBottom(log), 'at the bottom the view follows');
  assert.equal(rows(h).length, 22);
});

test('pushes that redraw the column or header never replace the timeline, and focus on a message stays', async (t) => {
  const messages = Array.from({ length: 5 }, (_v, i) => message(i + 1));
  const { h, scroller } = await openChat({ messages });
  t.after(h.restore);
  const log = scroller();
  const row = rows(h)[2];
  row.focus();
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [chatChannel({ unread: 4, mention: true })] });
  h.listeners.chat({ team_id: OTHER, type: 'presence', member_id: DOT, state: 'away', last_seen_at: null });
  h.listeners.state({ teams: [memberTeam({ state: 'reconnecting' })] });
  await flush();
  assert.match(h.view.q('.team-banner').textContent, /Reconnecting/);
  assert.equal(scroller(), log);
  assert.equal(h.window.document.activeElement, row);
});

test('Markdown is rendered once per message revision', async (t) => {
  const { h } = await openChat({ messages: [message(1), message(2)] });
  t.after(h.restore);
  const real = h.window.markdownUtils.renderMarkdown;
  let renders = 0;
  h.window.markdownUtils.renderMarkdown = (...args) => { renders += 1; return real(...args); };
  t.after(() => { h.window.markdownUtils.renderMarkdown = real; });
  push(h, OTHER, [message(1), message(2)]);
  await flush();
  assert.equal(renders, 0);
  push(h, OTHER, [message(2, { rev: 9, text: 'changed', edited_at: at(Date.now()) })]);
  await flush();
  assert.equal(renders, 1);
  assert.match(rows(h)[1].textContent, /changed/);
  assert.ok(rows(h)[1].querySelector('.team-msg__edited'));
});

test('loading older messages keeps the first visible row in place, and the page never holds more than 400 rows', async (t) => {
  const when = at(Date.now() - 120 * MIN);
  const page = (from, to) => Array.from({ length: to - from + 1 }, (_v, i) => message(from + i, { created_at: when }));
  const { h, box, scroller } = await openChat({ answers: {
    chatHistory: (p) => (p.before_seq
      ? { ok: true, messages: page(Math.max(1, p.before_seq - p.limit), p.before_seq - 1), has_more: p.before_seq - p.limit > 1, floor_seq: 1 }
      : { ok: true, messages: page(901, 1000), has_more: true }),
  } });
  t.after(h.restore);
  const log = scroller();
  assert.equal(rows(h).length, 100);
  const firstSeq = () => rows(h)[0].dataset.seq;
  for (let round = 0; round < 8; round += 1) {
    const height = log.scrollHeight;
    box.scroll(log, 0);
    await flush();
    const added = log.scrollHeight - height;
    if (rows(h).length < 400) assert.equal(log.scrollTop, added, 'the row that was first stays where it was');
    assert.ok(rows(h).length <= 400, `round ${round}: ${rows(h).length} rows`);
  }
  assert.equal(rows(h).length, 400);
  assert.ok(Number(firstSeq()) < 901);
  assert.equal(h.view.q('.team-jump').hidden, false, 'with the newest rows dropped, Jump to latest brings them back');
  h.view.q('.team-jump').click();
  await flush();
  assert.equal(rows(h).at(-1).dataset.seq, '1000');
  assert.ok(box.atBottom(log));
});

test('at the bottom, new messages past 400 drop the oldest rows', async (t) => {
  const when = at(Date.now() - 120 * MIN);
  const { h } = await openChat({ messages: Array.from({ length: 400 }, (_v, i) => message(i + 1, { created_at: when })) });
  t.after(h.restore);
  push(h, OTHER, Array.from({ length: 5 }, (_v, i) => message(401 + i, { created_at: when })));
  await flush();
  assert.equal(rows(h).length, 400);
  assert.equal(rows(h)[0].dataset.seq, '6');
});

test('mark read only with the view shown, the window focused and the bottom reached', async (t) => {
  const messages = Array.from({ length: 20 }, (_v, i) => message(i + 1, { created_at: at(Date.now() - 60 * MIN) }));
  const { h, box, scroller } = await openChat({ messages, focused: false, channel: { last_read_seq: 0, last_seq: 20, unread: 20 } });
  t.after(h.restore);
  assert.equal(h.sent('chatMarkRead').length, 0, 'not while the window is in the background');
  box.setFocus(true);
  await flush();
  assert.deepEqual(h.sent('chatMarkRead').map((call) => call.payload), [{ team_id: OTHER, channel_id: CHAN, seq: 20 }]);
  box.scroll(scroller(), 0);
  push(h, OTHER, [message(21, { created_at: at(Date.now()) })]);
  await flush();
  assert.equal(h.sent('chatMarkRead').length, 1, 'not while scrolled up');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 5_000 }); // past the store's 2 s pacing
  box.scroll(scroller(), 100_000);
  await flush();
  assert.deepEqual(h.sent('chatMarkRead').map((call) => call.payload.seq), [20, 21]);
  h.tab.hideTeamTab();
  push(h, OTHER, [message(22, { created_at: at(Date.now()) })]);
  await flush();
  assert.equal(h.sent('chatMarkRead').length, 2, 'not while the Team view is hidden');
});

test('reset replaces the rows; cleared empties the view', async (t) => {
  const { h } = await openChat({ messages: [message(1), message(2)] });
  t.after(h.restore);
  push(h, OTHER, [message(50)], true);
  await flush();
  assert.deepEqual(rows(h).map((row) => row.dataset.messageId), [msgId(50)]);
  h.listeners.chat({ team_id: OTHER, type: 'cleared' });
  await flush();
  assert.equal(rows(h).length, 0);
  assert.equal(h.view.q('.team-empty'), null, 'nothing is said about a channel that is gone');
});

test('queued and failed posts are dimmed rows at the end; a settled post is drawn once', async (t) => {
  const outbox = [
    { entry_id: 'out_queued_entry_000', operation: 'post', channel_id: CHAN, thread_root_id: null, message_id: null, text: 'on its way', created_at: 2, state: 'queued', error: null },
    { entry_id: 'out_failed_entry_000', operation: 'post', channel_id: CHAN, thread_root_id: null, message_id: null, text: 'refused', created_at: 1, state: 'failed', error: { code: 'CMP-HOST-0001', reason: 'role_forbidden' } },
    { entry_id: 'out_edit_entry_00000', operation: 'edit', channel_id: CHAN, thread_root_id: null, message_id: msgId(1), text: 'x', created_at: 3, state: 'queued', error: null },
    { entry_id: 'out_reply_entry_0000', operation: 'post', channel_id: CHAN, thread_root_id: msgId(1), message_id: null, text: 'reply', created_at: 4, state: 'queued', error: null },
  ];
  const { h } = await openChat({ messages: [message(1)], answers: { chatOverview: overview({ outbox }) } });
  t.after(h.restore);
  const pending = h.view.qa('.team-msg[data-pending="true"]');
  assert.deepEqual(pending.map((row) => row.querySelector('.team-msg__text').textContent.trim()), ['refused', 'on its way'], 'in created_at order');
  assert.equal(pending[0].querySelector('.team-failed').textContent, 'Not sent. Only the owner can do that.');
  assert.equal(pending[1].querySelector('.team-queued').textContent, 'Sending');
  assert.equal(pending[1].querySelector('button'), null, 'a queued row has no buttons');
  assert.equal(rows(h).at(-1), pending[1]);
  assert.equal(h.view.q(`.team-msg[data-message-id="${msgId(1)}"] .team-queued`).textContent, 'Saving your edit', 'a queued edit shows on its message');
  h.listeners.state({ teams: [memberTeam({ state: 'reconnecting' })] });
  await flush();
  assert.equal(h.view.q('.team-msg[data-pending="true"] .team-queued').textContent, 'Sends when reconnected');
  h.listeners.chat({ team_id: OTHER, type: 'outbox', outbox: [{ ...outbox[0], message_id: msgId(2) }], settled: [] });
  push(h, OTHER, [message(2, { text: 'on its way', author: { kind: 'member', member_id: DOT } })]);
  await flush();
  assert.equal(h.view.qa('.team-msg').filter((row) => /on its way/.test(row.textContent)).length, 1, 'never drawn twice');
});

test('a history that fails to load says why in words and can be asked again', async (t) => {
  let fail = true;
  const { h } = await openChat({ answers: { chatHistory: () => (fail ? { ok: false, error: { code: 'CMP-TEAM-0008', reason: 'team_chat_not_found' } } : { ok: true, messages: [message(1)], has_more: false }) } });
  t.after(h.restore);
  const note = h.view.q('.team-timeline-error');
  assert.match(note.textContent, /not available/);
  assert.equal(/team_chat_not_found/.test(note.textContent), false);
  fail = false;
  note.querySelector('[data-team-tab-action="retry-history"]').click();
  await flush();
  assert.equal(rows(h).length, 1);
  assert.equal(h.view.q('.team-timeline-error'), null);
});

test('the timeline is not asked for behind a gate, and a team that was never online makes no chat call', async (t) => {
  const h = harness({ show: false, teams: [memberTeam({ state: 'pending' })] });
  t.after(h.restore);
  layout(h);
  h.showTab();
  await flush();
  assert.equal(h.view.q('.team-scroll'), null);
  assert.equal(h.calls.filter((call) => String(call.method).startsWith('chat')).length, 0);
});

// ---------------------------------------------------------- review round (2a-5a)

const errorAnswer = { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } };

test('a channel off screen (the list screen under 720 px) is never marked read; shown and scrolled to the bottom it is', async (t) => {
  const messages = Array.from({ length: 20 }, (_, i) => message(i + 1));
  const { h, box, scroller } = await openChat({ messages, channel: { last_read_seq: 20, last_seq: 20 }, narrow: true });
  t.after(h.restore);
  assert.equal(h.sent('chatMarkRead').length, 0, 'already read');
  h.view.q('[data-team-tab-action="back"]').click();
  assert.equal(scroller().clientHeight, 0, 'the log is not laid out');
  push(h, OTHER, [message(21)]);
  await flush();
  box.setFocus(true);
  await flush();
  assert.equal(h.sent('chatMarkRead').length, 0, 'a hidden log is not at the bottom');
  h.view.q('[data-team-channel]').click();
  await flush();
  assert.equal(h.sent('chatMarkRead').length, 0, 'shown, not at the bottom yet');
  box.scroll(scroller(), 100_000);
  await flush();
  assert.deepEqual(h.sent('chatMarkRead').map((call) => call.payload.seq), [21]);
});

test('a failed open is not asked again by later store events; Try again asks exactly once', async (t) => {
  const { h } = await openChat({ answers: { chatHistory: errorAnswer } });
  t.after(h.restore);
  assert.equal(h.sent('chatHistory').length, 1);
  for (let i = 0; i < 10; i += 1) {
    const kind = ['presence', 'channels', 'outbox'][i % 3];
    if (kind === 'presence') h.listeners.chat({ team_id: OTHER, type: 'presence', member_id: DOT, state: i % 2 ? 'away' : 'online' });
    if (kind === 'channels') h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [chatChannel({ unread: i })] });
    if (kind === 'outbox') h.listeners.chat({ team_id: OTHER, type: 'outbox', outbox: [] });
    await flush();
  }
  assert.equal(h.sent('chatHistory').length, 1, 'no retry from pushes');
  h.view.q('[data-team-tab-action="retry-history"]').click();
  await flush();
  assert.equal(h.sent('chatHistory').length, 2, 'one click, one call');
});

test('scrolled up, pushes past 400 drop the newest rows and keep the first visible row; a hidden tab stops holding the channel', async (t) => {
  const messages = Array.from({ length: 50 }, (_, i) => message(i + 1));
  const { h, box, scroller } = await openChat({ messages });
  t.after(h.restore);
  box.scroll(scroller(), 300);
  const top = rows(h).slice(0, 10);
  for (let batch = 0; batch < 5; batch += 1) {
    push(h, OTHER, Array.from({ length: 100 }, (_, i) => message(51 + batch * 100 + i)));
    await flush();
  }
  assert.ok(rows(h).length <= 400, `rows ${rows(h).length}`);
  assert.ok(h.chat.timeline(OTHER, CHAN).list.length <= 400, 'the store window is capped too');
  assert.equal(h.chat.timeline(OTHER, CHAN).hasNewer, true, 'Jump to latest reads the dropped ones');
  assert.equal(scroller().scrollTop, 300);
  assert.ok(top.every((el, i) => rows(h)[i] === el), 'the first rows are the same nodes');
  assert.equal(h.view.q('.team-jump').hidden, false);
  h.tab.hideTeamTab();
  push(h, OTHER, [message(9_000)]);
  assert.equal(h.chat.timeline(OTHER, CHAN).list.length, 0, 'a closed channel is not held');
});

test('a refused overview says so in the timeline; Try again asks the overview once more', async (t) => {
  let fail = true;
  const { h } = await openChat({ answers: { chatOverview: () => (fail ? errorAnswer : overview({ channels: [chatChannel()] })) } });
  t.after(h.restore);
  const row = h.view.q('.team-timeline-error');
  assert.ok(row, 'the error row is drawn');
  assert.match(row.textContent, /Messages could not be loaded/);
  assert.equal(h.sent('chatOverview').length, 1);
  fail = false;
  row.querySelector('[data-team-tab-action="retry-history"]').click();
  await flush();
  assert.equal(h.sent('chatOverview').length, 2);
  assert.equal(h.view.q('.team-timeline-error'), null);
  assert.equal(h.sent('chatHistory').length, 1, 'the channel opens once the chat is in');
});

test('a mention of someone not listed yet shows their name once the members push brings them', async (t) => {
  const { h } = await openChat({ messages: [message(1, { text: 'hi <@member_nia>', mentions: ['member_nia'] })] });
  t.after(h.restore);
  assert.equal(h.view.q('.team-mention').textContent, '@Former member');
  h.listeners.chat({ team_id: OTHER, type: 'members', members: CHAT_MEMBERS.concat(chatMember('member_nia', 'Nia')) });
  await flush();
  assert.equal(h.view.q('.team-mention').textContent, '@Nia');
});

test('while an older page failure is shown, scrolling to the top does not ask again', async (t) => {
  const messages = Array.from({ length: 20 }, (_, i) => message(i + 30));
  const { h, box, scroller } = await openChat({ answers: { chatHistory: (p) => (p.before_seq ? errorAnswer : { ok: true, messages, has_more: true }) } });
  t.after(h.restore);
  box.scroll(scroller(), 0);
  await flush();
  assert.equal(h.sent('chatHistory').length, 2);
  assert.ok(h.view.q('.team-timeline-error'));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_000 });
  box.scroll(scroller(), 10);
  box.scroll(scroller(), 0);
  await flush();
  assert.equal(h.sent('chatHistory').length, 2, 'the error row has Try again; scrolling does not resend');
});

// ---------------------------------------------------------- outbox rows (2a-5b)

const outEntry = (id, over = {}) => ({ entry_id: id, operation: 'post', channel_id: CHAN, thread_root_id: null, message_id: null,
  text: 'Hello there', created_at: new Date().toISOString(), state: 'queued', error: null, ...over });
const outbox = (h, list, settled = []) => h.listeners.chat({ team_id: OTHER, type: 'outbox', outbox: list, settled });
const hellos = (h) => rows(h).filter((row) => /Hello there/.test(row.textContent));

test('a settled post is drawn once when the outbox push comes first', async (t) => {
  const { h } = await openChat({ messages: [message(1, { author: { kind: 'member', member_id: ME } })] });
  t.after(h.restore);
  outbox(h, [outEntry('out_e1_entry_0000000')]);
  await flush();
  assert.equal(hellos(h).length, 1);
  assert.equal(hellos(h)[0].dataset.pending, 'true');
  outbox(h, [], [{ entry_id: 'out_e1_entry_0000000', ok: true, message_id: msgId(5), seq: 5, rev: 1 }]);
  await flush();
  assert.equal(hellos(h).length, 1, 'still drawn until its message arrives');
  push(h, OTHER, [message(5, { text: 'Hello there', created_at: new Date().toISOString() })]);
  await flush();
  assert.equal(hellos(h).length, 1, 'never twice');
  assert.equal(hellos(h)[0].dataset.messageId, msgId(5), 'the real message replaced it');
});

test('a settled post is drawn once when its message arrives before the outbox push', async (t) => {
  const { h } = await openChat({ messages: [message(1, { author: { kind: 'member', member_id: ME } })] });
  t.after(h.restore);
  outbox(h, [outEntry('out_e1_entry_0000000')]);
  await flush();
  push(h, OTHER, [message(5, { text: 'Hello there', created_at: new Date().toISOString() })]);
  await flush();
  assert.equal(hellos(h).length, 1, 'never twice');
  assert.equal(hellos(h)[0].dataset.messageId, msgId(5));
  outbox(h, [], [{ entry_id: 'out_e1_entry_0000000', ok: true, message_id: msgId(5), seq: 5, rev: 1 }]);
  await flush();
  assert.equal(hellos(h).length, 1);
});

test('a queued post with the same text as an older message of yours is still drawn', async (t) => {
  const { h } = await openChat({ messages: [message(1, { text: 'Hello there', created_at: new Date(Date.now() - 10 * MIN).toISOString() })] });
  t.after(h.restore);
  outbox(h, [outEntry('out_e1_entry_0000000')]);
  await flush();
  assert.equal(hellos(h).length, 2);
});

test('a failed post keeps its row with Retry and Delete; Delete discards it', async (t) => {
  const failed = outEntry('out_f_entry_00000000', { state: 'failed', error: { code: 'CMP-HOST-0001', reason: 'role_forbidden' } });
  const { h } = await openChat({ answers: { chatOverview: overview({ outbox: [failed] }) } });
  t.after(h.restore);
  const pendingRow = h.view.q('.team-msg[data-pending="true"]');
  assert.match(pendingRow.querySelector('.team-failed').textContent, /^Not sent\. Only the owner can do that\.$/);
  pendingRow.querySelector('[data-team-msg-action="discard"]').click();
  await flush();
  assert.deepEqual(h.sent('chatOutboxDiscard').map((call) => call.payload), [{ team_id: OTHER, entry_id: 'out_f_entry_00000000' }]);
  assert.equal(h.sent('chatPost').length, 0);
});

test('Retry sends the same post again, then discards the failed entry once that answers ok; a double click sends once', async (t) => {
  const failed = outEntry('out_f_entry_00000000', { text: 'try me', state: 'failed', error: { code: 'CMP-HOST-0001', reason: 'role_forbidden' } });
  const gate = heldAnswers();
  const { h } = await openChat({ answers: { chatOverview: overview({ outbox: [failed] }), chatPost: gate.answer } });
  t.after(h.restore);
  const retry = () => h.view.q('.team-msg[data-pending="true"] [data-team-msg-action="retry"]');
  retry().click();
  retry().click();
  await flush();
  assert.equal(gate.calls.length, 1, 'once');
  assert.deepEqual(gate.calls[0], { team_id: OTHER, channel_id: CHAN, text: 'try me' });
  assert.equal(retry().disabled, true, 'busy while in flight');
  assert.equal(h.sent('chatOutboxDiscard').length, 0, 'nothing discarded before the answer');
  gate.release({ ok: true, entry_id: 'out_new_entry_000000' });
  await flush();
  assert.deepEqual(h.sent('chatOutboxDiscard').map((call) => call.payload), [{ team_id: OTHER, entry_id: 'out_f_entry_00000000' }]);
});

test('a refused Retry keeps the row and says why', async (t) => {
  const failed = outEntry('out_f_entry_00000000', { state: 'failed', error: { code: 'CMP-HOST-0001', reason: 'role_forbidden' } });
  const { h } = await openChat({ answers: { chatOverview: overview({ outbox: [failed] }),
    chatPost: { ok: false, error: { code: 'invalid_request', reason: 'team_chat_outbox_full' } } } });
  t.after(h.restore);
  h.view.q('.team-msg[data-pending="true"] [data-team-msg-action="retry"]').click();
  await flush();
  assert.equal(h.sent('chatOutboxDiscard').length, 0);
  const pendingRow = h.view.q('.team-msg[data-pending="true"]');
  assert.ok(pendingRow, 'the row stays');
  assert.match(pendingRow.querySelector('.team-msg__foot').textContent, /Too many messages are waiting to send/);
});

test('a Retry whose re-send is queued but whose discard is refused never posts again: the row offers Dismiss only', async (t) => {
  const failed = outEntry('out_f_entry_00000000', { text: 'once only', state: 'failed', error: { code: 'CMP-HOST-0001', reason: 'role_forbidden' } });
  const { h } = await openChat({ answers: { chatOverview: overview({ outbox: [failed] }),
    chatOutboxDiscard: { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } } } });
  t.after(h.restore);
  const pendingRow = () => h.view.q('.team-msg[data-pending="true"]');
  pendingRow().querySelector('[data-team-msg-action="retry"]').click();
  await flush();
  assert.equal(h.sent('chatPost').length, 1);
  assert.equal(h.sent('chatOutboxDiscard').length, 1);
  assert.equal(pendingRow().querySelector('[data-team-msg-action="retry"]'), null, 'no second Retry');
  const dismiss = pendingRow().querySelector('[data-team-msg-action="discard"]');
  assert.equal(dismiss.textContent.trim(), 'Dismiss');
  dismiss.click();
  await flush();
  assert.equal(h.sent('chatPost').length, 1, 'posted once');
  assert.equal(h.sent('chatOutboxDiscard').length, 2, 'Dismiss asks for the discard again');
});

test('a queued post shows its mentions as names, as it will read once sent', async (t) => {
  const members = [...CHAT_MEMBERS, chatMember(MAYA, 'Maya')];
  const { h } = await openChat({ members, answers: { chatOverview: overview({ members, outbox: [outEntry('out_e1_entry_0000000', { text: '<@member_maya> look' })] }) } });
  t.after(h.restore);
  const text = h.view.q('.team-msg[data-pending="true"] .team-msg__text');
  assert.deepEqual([...text.querySelectorAll('.team-mention')].map((el) => el.textContent), ['@Maya']);
  assert.ok(!text.textContent.includes('<@'), 'no raw token');
});

test('at the bottom with the window focused, the read mark covers replies past the last timeline row', async (t) => {
  // A reply in a followed thread has a channel seq above the last timeline row and counts as unread.
  const { h } = await openChat({ messages: [message(1), message(2)], channel: { last_seq: 7, last_read_seq: 2, unread: 1 } });
  t.after(h.restore);
  assert.deepEqual(h.sent('chatMarkRead').map((call) => call.payload.seq), [7], 'the channel’s last_seq, so the reply is not unread forever');
});
