'use strict';

// new-test-file: the jump to a message, Copy link and the message-link chip are a new surface (row 123,
// slice 2a-6b): one jump for search results and chips (a window read around a seq, newer pages until the
// newest, the thread column for a reply, the tint), the link token on the clipboard, and chips in drawn
// messages. Real modules over the harness bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { OTHER, CHAN, DOT, ME, micro, flush, msgId, message, memberTeam, snapshot, chatChannel, openChat, heldAnswers, liveTimers, type, key, menu, ROOT,
  rootMsg, reply, threadAnswer, threadOf, openThreadChat, openThreadFrom, pushMessages, chatPush, searchField: field, searchMatch: match }
  = require('./helpers/team-settings-harness');

const results = (h) => h.view.qa('.team-result');
const row = (h, seq) => h.view.q(`[data-team-region="timeline"] .team-msg[data-message-id="${msgId(seq)}"]`);
const seqs = (h) => h.view.qa('[data-team-region="timeline"] .team-msg[data-message-id]').map((el) => Number(el.dataset.seq));
const jumped = (h) => h.view.qa('[data-jumped="true"]').map((el) => el.dataset.messageId);
const jumpButton = (h) => h.view.q('.team-jump');
const note = (h) => (h.view.q('.team-thread-gone') || { textContent: '' }).textContent;
const histories = (h) => h.sent('chatHistory').map((call) => call.payload);
const found = (matches) => ({ ok: true, matches, next_cursor: null });
const range = (from, to, over = {}) => Array.from({ length: to - from + 1 }, (_v, i) => message(from + i, over));
const token = (seq, over = {}) => `jenny-team:${over.team || OTHER}/${over.channel || CHAN}/${over.seq ?? seq}/${over.id || msgId(seq)}${over.root ? '/' + over.root : ''}`;

// Searches with real timers (the 300 ms wait) and clicks the result for `seq`.
async function jumpVia(h, seq) {
  type(h, 'message', field(h));
  await new Promise((resolve) => setTimeout(resolve, 320));
  await flush();
  results(h).find((el) => el.dataset.messageId === msgId(seq)).click();
  await flush();
}
// History: the newest page with no `before_seq`, else the window below it from `pages`.
const history = (newest, pages = {}) => (p) => (p.before_seq === undefined ? { ok: true, messages: newest, has_more: true }
  : (pages[p.before_seq] || { ok: true, messages: [], has_more: false }));

test('an in-window target reads nothing, and is focused and tinted until its time is up; no timer outlives dispose', async (t) => {
  const { h } = await openChat({ messages: range(1, 5), channel: { last_seq: 5 }, answers: { chatSearch: { ok: true, matches: [match(3)], next_cursor: null } } });
  t.after(h.restore);
  const before = histories(h).length;
  await jumpVia(h, 3);
  assert.equal(histories(h).length, before, 'held already: nothing read');
  assert.deepEqual(jumped(h), [msgId(3)]);
  assert.equal(h.window.document.activeElement, row(h, 3));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const live = liveTimers(t, { keep: (ms) => ms === 2400 }); // the tint
  results(h)[0].click();
  await micro();
  assert.equal(live.size, 1, 'one tint timer');
  t.mock.timers.tick(2_399);
  assert.deepEqual(jumped(h), [msgId(3)]);
  t.mock.timers.tick(1);
  assert.deepEqual(jumped(h), [], 'removed after 2.4 s');
  results(h)[0].click();
  await micro();
  h.tab.hideTeamTab();
  assert.equal(live.size, 0, 'nothing left after dispose');
});

test('an out-of-window target reads a window around it, shows Jump to latest, marks nothing read, and pages newer to the end', async (t) => {
  const newest = range(201, 250);
  const pages = { 151: { ok: true, messages: range(51, 150), has_more: true }, 201: { ok: true, messages: range(151, 200), has_more: true },
    251: { ok: true, messages: range(201, 250), has_more: true } };
  const { h, box, scroller } = await openChat({ messages: newest, channel: { last_seq: 250, last_read_seq: 40 }, focused: false,
    answers: { chatHistory: history(newest, pages), chatSearch: { ok: true, matches: [match(100)], next_cursor: null } } });
  t.after(h.restore);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 5_000 });
  const reads = h.sent('chatMarkRead').length;
  await jumpVia(h, 100);
  assert.deepEqual(histories(h).at(-1), { team_id: OTHER, channel_id: CHAN, before_seq: 151, limit: 100 });
  assert.deepEqual(seqs(h), range(51, 150).map((m) => m.seq), 'the answer replaces the window');
  assert.deepEqual(jumped(h), [msgId(100)]);
  assert.equal(h.window.document.activeElement, row(h, 100));
  assert.equal(jumpButton(h).hidden, false, 'Jump to latest the whole time');
  box.setFocus(true);
  box.scroll(scroller(), 1e9);
  assert.equal(jumpButton(h).hidden, false, 'also at the bottom');
  await flush();
  assert.deepEqual(histories(h).at(-1), { team_id: OTHER, channel_id: CHAN, before_seq: 201, limit: 50 });
  assert.equal(seqs(h).at(-1), 200);
  assert.equal(jumpButton(h).hidden, false);
  box.scroll(scroller(), 1e9);
  await flush();
  assert.deepEqual(histories(h).at(-1), { team_id: OTHER, channel_id: CHAN, before_seq: 251, limit: 50 });
  assert.equal(seqs(h).at(-1), 250);
  assert.equal(h.sent('chatMarkRead').length, reads, 'nothing marked read while the newest were not held');
  const asked = histories(h).length;
  box.scroll(scroller(), 1e9);
  await flush();
  assert.equal(histories(h).length, asked, 'the newest reached: no more pages');
  chatPush(h, { type: 'channels', partial: true, channels: [{ channel_id: CHAN, kind: 'team', last_seq: 251, last_read_seq: 250, unread: 1, notify: 'all' }] });
  pushMessages(h, [message(251)]);
  await flush();
  assert.equal(seqs(h).at(-1), 251, 'live following again');
});

test('Jump to latest after a jump reads the newest page again', async (t) => {
  const newest = range(201, 250);
  const { h } = await openChat({ messages: newest, channel: { last_seq: 250 },
    answers: { chatHistory: history(newest, { 151: { ok: true, messages: range(51, 150), has_more: true } }), chatSearch: { ok: true, matches: [match(100)], next_cursor: null } } });
  t.after(h.restore);
  await jumpVia(h, 100);
  jumpButton(h).click();
  await flush();
  assert.equal(histories(h).at(-1).before_seq, undefined);
  assert.equal(seqs(h).at(-1), 250);
  assert.equal(jumpButton(h).hidden, true);
});

test('a late window answer after a newer jump changes nothing; a missing target shows the page and the line', async (t) => {
  const gate = heldAnswers();
  const newest = range(201, 250);
  const { h } = await openChat({ messages: newest, channel: { last_seq: 250 },
    answers: { chatHistory: (p) => (p.before_seq === undefined ? { ok: true, messages: newest, has_more: true } : gate.answer(p)),
      chatSearch: { ok: true, matches: [match(100), match(20)], next_cursor: null } } });
  t.after(h.restore);
  await jumpVia(h, 100);
  results(h)[1].click();
  await flush();
  assert.deepEqual(gate.calls.map((p) => p.before_seq), [151, 71]);
  gate.release({ ok: true, messages: range(51, 150), has_more: true });
  await flush();
  assert.equal(seqs(h).at(-1), 250, 'the older read is dropped');
  gate.release({ ok: true, messages: range(1, 19).concat(range(21, 70)), has_more: false });
  await flush();
  assert.equal(seqs(h)[0], 1, 'the page is shown');
  assert.deepEqual(jumped(h), []);
  assert.equal(note(h), 'That message is no longer here.');
});

test('a deleted target shows the line; a failed read says why and keeps what is shown', async (t) => {
  const refused = { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } };
  const { h } = await openChat({ messages: [message(1), message(2, { deleted: { by: DOT, at: 1 } })], channel: { last_seq: 2 },
    answers: { chatSearch: { ok: true, matches: [match(2), match(900)], next_cursor: null }, chatHistory: (p) => (p.before_seq ? refused : { ok: true, messages: [message(1), message(2, { deleted: { by: DOT, at: 1 } })], has_more: false }) } });
  t.after(h.restore);
  await jumpVia(h, 2);
  assert.equal(note(h), 'That message is no longer here.');
  results(h)[1].click();
  await flush();
  assert.deepEqual(seqs(h), [1, 2], 'nothing shown changed');
  assert.equal(h.view.q('.team-timeline-error'), null, 'no error row');
  assert.match(note(h), /not connected to the team/);
});

test('a reply: chatThread for the root, the window around the root, the thread open, the reply focused and tinted', async (t) => {
  const newest = range(301, 350);
  const { h } = await openThreadChat({ messages: newest, channel: { last_seq: 350 },
    answers: { chatHistory: history(newest, { 53: { ok: true, messages: [message(1), rootMsg()], has_more: false } }),
      chatSearch: { ok: true, matches: [match(4, { root_id: ROOT })], next_cursor: null } } });
  t.after(h.restore);
  await jumpVia(h, 4);
  assert.equal(h.sent('chatThread')[0].payload.root_id, ROOT);
  assert.deepEqual(histories(h).at(-1), { team_id: OTHER, channel_id: CHAN, before_seq: 53, limit: 100 });
  assert.ok(threadOf(h), 'the thread column is open');
  const target = threadOf(h).querySelector(`.team-msg[data-message-id="${msgId(4)}"]`);
  assert.equal(target.dataset.jumped, 'true');
  assert.equal(h.window.document.activeElement, target);
  assert.equal(h.view.q('.team-shell').dataset.screen, 'thread');
});

test('a match in a channel that is not listed changes nothing shown and says so', async (t) => {
  const { h } = await openChat({ messages: range(1, 3), answers: { chatSearch: { ok: true, matches: [match(7, { channel_id: 'chan_project_web' })], next_cursor: null } } });
  t.after(h.restore);
  const before = histories(h).length;
  await jumpVia(h, 7);
  assert.equal(histories(h).length, before);
  assert.deepEqual(seqs(h), [1, 2, 3]);
  assert.equal(note(h), 'That message is in a channel this tab does not show yet.');
});

test('a jump keeps the channel composer text and caret: to a held row, around a seq, and into a thread', async (t) => {
  const newest = range(201, 250);
  const pages = { 151: { ok: true, messages: range(51, 150), has_more: true }, 53: { ok: true, messages: [message(1), rootMsg()], has_more: false } };
  const { h } = await openThreadChat({ messages: newest, channel: { last_seq: 250 },
    answers: { chatHistory: history(newest, pages), chatSearch: found([match(240), match(100), match(4, { root_id: ROOT })]) } });
  t.after(h.restore);
  const composer = h.view.q('.team-composer__input');
  type(h, 'half a thought', composer);
  composer.setSelectionRange(4, 4);
  await jumpVia(h, 240);
  assert.deepEqual(jumped(h), [msgId(240)]);
  results(h)[1].click();
  await flush();
  assert.equal(seqs(h)[0], 51, 'the window around 100');
  results(h)[2].click();
  await flush();
  assert.ok(threadOf(h), 'the thread is open');
  assert.notEqual(h.window.document.activeElement, composer);
  assert.equal(composer.value, 'half a thought');
  assert.equal(composer.selectionStart, 4);
});

// ---------------------------------------------------------------- copy link

const copyOf = (el) => el && el.querySelector('[data-team-msg-action="copy-link"]');

test('Copy link: before More, the button and L write the exact token once and say so; a reply carries its root', async (t) => {
  const { h } = await openThreadChat({ teams: [memberTeam({ role: 'read_only' })] });
  t.after(h.restore);
  const button = copyOf(row(h, 1));
  assert.ok(button, 'a read-only member has it');
  assert.equal(button.title, 'Copy link (L)');
  const acts = [...row(h, 1).querySelectorAll('.team-acts button')];
  assert.equal(acts.indexOf(button), acts.length - 2, 'just before More');
  button.click();
  await flush();
  assert.deepEqual(h.copied, [token(1)]);
  assert.equal(h.view.q('.team-copied .inv-toast__message').textContent, 'Link copied');
  row(h, 2).focus();
  key(h, row(h, 2), 'l');
  await flush();
  assert.deepEqual(h.copied, [token(1), token(2)]);
  await openThreadFrom(h);
  const inThread = threadOf(h).querySelector(`.team-msg[data-message-id="${msgId(3)}"]`);
  copyOf(inThread).click();
  await flush();
  assert.equal(h.copied.at(-1), token(3, { root: ROOT }));
});

test('L is ignored in a text field and while a menu is open; a queued or deleted row has no Copy link; a failed write says so', async (t) => {
  const outbox = [{ entry_id: 'out_q', operation: 'post', channel_id: CHAN, thread_root_id: null, message_id: null, text: 'waiting', created_at: new Date().toISOString(), state: 'queued', error: null }];
  const { h } = await openChat({ outbox, messages: [message(1), message(2, { deleted: { by: DOT, at: 1 } })] });
  t.after(h.restore);
  key(h, h.view.q('.team-composer__input'), 'l');
  row(h, 1).querySelector('[data-team-msg-action="more"]').click();
  assert.ok(menu(h));
  key(h, row(h, 1), 'l');
  await flush();
  assert.deepEqual(h.copied, []);
  assert.equal(copyOf(h.view.q('.team-msg[data-pending="true"]')), null);
  assert.equal(copyOf(row(h, 2)), null);
  h.window.document.body.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  h.window.jennyShell.clipboard.writeText = () => Promise.reject(new Error('denied'));
  copyOf(row(h, 1)).click();
  await flush();
  assert.equal(h.view.q('.team-copied .inv-toast__message').textContent, 'The link could not be copied.');
});

// ---------------------------------------------------------------- chips

const chips = (h, seq) => [...row(h, seq).querySelectorAll('button.team-msglink')];

test('a valid token becomes a chip: held as "#channel · Author · time" and its first line, else "#channel · message"; a click jumps', async (t) => {
  const messages = [message(1, { text: 'First line\nsecond' }), message(2, { author: { kind: 'member', member_id: ME }, text: `see ${token(1)} and ${token(900)}` })];
  const { h } = await openChat({ messages, channel: { last_seq: 2 } });
  t.after(h.restore);
  const [held, unheld] = chips(h, 2);
  assert.match(held.querySelector('.team-msglink__where').textContent, /^#team · Dot · \S/);
  assert.equal(held.querySelector('.team-msglink__text').textContent, 'First line');
  assert.equal(held.dataset.linkMessage, msgId(1));
  assert.equal(held.title, 'Go to this message');
  assert.equal(unheld.querySelector('.team-msglink__where').textContent, '#team · message');
  assert.equal(unheld.querySelector('.team-msglink__text'), null);
  const reads = h.calls.length;
  held.click();
  await flush();
  assert.equal(h.calls.length, reads, 'held: no read');
  assert.deepEqual(jumped(h), [msgId(1)]);
});

test('tokens stay text in code, in a link, for another team, an unlisted channel, a malformed id, seq 0, and past the fifth', async (t) => {
  const bad = [`\`${token(1)}\``, `[x](${token(1)})`, token(1, { team: 'team_CCCCCCCCCCCCCCCCCCCCCC' }), token(1, { channel: 'chan_project_web' }),
    token(1, { id: 'msg_123' }), token(1, { seq: 0 })];
  const many = Array.from({ length: 6 }, () => token(1)).join(' ');
  const messages = [message(1), message(2, { text: bad.join('\n\n') }), message(3, { text: many }), message(4, { text: token(1).replace('msg_', 'msg_<b>') })];
  const { h } = await openChat({ messages, channel: { last_seq: 4 } });
  t.after(h.restore);
  assert.equal(chips(h, 2).length, 0);
  assert.equal(chips(h, 3).length, 5, 'at most five per message');
  assert.equal(chips(h, 4).length, 0);
  assert.equal(row(h, 4).querySelector('.team-msg__body b'), null);
  assert.ok(row(h, 2).textContent.includes(token(1, { seq: 0 })), 'left as written');
});


// ---------------------------------------------------------------- links into other teams and to a channel (F19, item 14)

const SECOND = 'team_DDDDDDDDDDDDDDDDDDDDDD';
const DESIGN = 'chan_c_aaaaaaaaaaaaaaaa';
const customRow = (over = {}) => chatChannel({ channel_id: DESIGN, kind: 'channel', name: 'design', topic: '', created_by: DOT, archived: false, archived_by: null, changes: [], rev: 2, ...over });
const panelTitle = (h) => h.view.q('.team-panel__title').textContent;

test('a link into another team this member belongs to is a chip that switches to that team; one into a team not joined stays text', async (t) => {
  const messages = [message(1), message(2, { text: `go ${token(1, { team: SECOND })} or ${token(1, { team: 'team_CCCCCCCCCCCCCCCCCCCCCC' })}` })];
  const { h } = await openChat({ messages, channel: { last_seq: 2 }, teams: [memberTeam(), memberTeam({ team_id: SECOND, team_name: 'Studio' })] });
  t.after(h.restore);
  const found = chips(h, 2);
  assert.equal(found.length, 1, 'only the joined team is a link');
  assert.equal(found[0].dataset.linkTeam, SECOND);
  assert.equal(found[0].querySelector('.team-msglink__where').textContent, 'Studio · #team · message');
  assert.ok(row(h, 2).textContent.includes('team_CCCCCCCCCCCCCCCCCCCCCC'), 'the other one is left as written');
  assert.equal(panelTitle(h), 'Dot lab');
  found[0].click();
  await flush();
  assert.equal(panelTitle(h), 'Studio', 'the click switches team, then opens there');
});

test('a link to a custom channel is a chip that shows it, in this team and in another; a team no longer joined says so', async (t) => {
  const own = `jenny-team:${OTHER}/${DESIGN}`;
  const there = `jenny-team:${SECOND}/${DESIGN}`;
  const messages = [message(1), message(2, { text: `see ${own} and ${there} and jenny-team:${OTHER}/chan_c_zzzzzzzzzzzzzzzz` })];
  const { h } = await openChat({ messages, channel: { last_seq: 2 }, teams: [memberTeam(), memberTeam({ team_id: SECOND, team_name: 'Studio' })],
    answers: { chatOverview: { ok: true, ...require('./helpers/team-settings-harness').overview({ channels: [chatChannel({ last_seq: 2 }), customRow()] }) } } });
  t.after(h.restore);
  const [first, second] = chips(h, 2);
  assert.equal(chips(h, 2).length, 2, 'an unlisted channel stays text');
  assert.equal(first.querySelector('.team-msglink__where').textContent, '#design');
  assert.equal(first.title, 'Go to this channel');
  assert.equal(second.querySelector('.team-msglink__where').textContent, 'Studio · #design');
  first.click();
  await flush();
  assert.equal(h.view.q('[data-team-channel][aria-current="true"]').dataset.teamChannel, DESIGN);
  assert.equal(panelTitle(h), 'Dot lab');
});


// ---------------------------------------------------------------- review round

test('a jump superseded by a plain open of the channel says nothing', async (t) => {
  const gate = heldAnswers();
  const newest = range(201, 250);
  const { h } = await openChat({ messages: newest, channel: { last_seq: 250 },
    answers: { chatHistory: (p) => (p.before_seq === undefined ? { ok: true, messages: newest, has_more: true } : gate.answer(p)), chatSearch: found([match(100)]) } });
  t.after(h.restore);
  await jumpVia(h, 100);
  void h.chat.openChannel(OTHER, CHAN);
  await flush();
  gate.release({ ok: true, messages: range(51, 150), has_more: true });
  await flush();
  assert.equal(note(h), '');
  assert.deepEqual(jumped(h), []);
  assert.equal(seqs(h).at(-1), 250);
});

test('a message pushed while the last newer page is out is read by the next page, and nothing is marked read before', async (t) => {
  const gate = heldAnswers();
  const newest = range(71, 120);
  const pages = { 81: { ok: true, messages: range(1, 80), has_more: false }, 171: { ok: true, messages: [message(121)], has_more: false } };
  const { h, box, scroller } = await openChat({ messages: newest, channel: { last_seq: 120, last_read_seq: 120 },
    answers: { chatHistory: (p) => (p.before_seq === 131 ? gate.answer(p) : history(newest, pages)(p)), chatSearch: found([match(30)]) } });
  t.after(h.restore);
  await jumpVia(h, 30);
  const reads = h.sent('chatMarkRead').length;
  box.scroll(scroller(), 1e9);
  await flush();
  assert.equal(gate.calls.length, 1);
  chatPush(h, { type: 'channels', partial: true, channels: [chatChannel({ last_seq: 121, last_read_seq: 120, unread: 1 })] });
  pushMessages(h, [message(121)]);
  gate.release({ ok: true, messages: range(81, 120), has_more: true });
  await flush();
  assert.equal(seqs(h).at(-1), 120);
  assert.equal(jumpButton(h).hidden, false, 'the newest are still not held');
  box.scroll(scroller(), 1e9);
  await flush();
  assert.equal(h.sent('chatMarkRead').length, reads, 'nothing marked read before the newest page');
  assert.deepEqual(histories(h).at(-1), { team_id: OTHER, channel_id: CHAN, before_seq: 171, limit: 50 });
  assert.equal(seqs(h).at(-1), 121);
});

test('newer pages that hold only thread replies are followed by the next page without another scroll', async (t) => {
  const newest = range(251, 300);
  const replies = (from, to) => range(from, to, { thread_root_id: ROOT });
  const pages = { 151: { ok: true, messages: range(51, 150), has_more: true }, 201: { ok: true, messages: replies(151, 200), has_more: true },
    251: { ok: true, messages: replies(201, 250), has_more: true }, 301: { ok: true, messages: range(251, 300), has_more: true } };
  const { h, box, scroller } = await openChat({ messages: newest, channel: { last_seq: 300 }, answers: { chatHistory: history(newest, pages), chatSearch: found([match(100)]) } });
  t.after(h.restore);
  await jumpVia(h, 100);
  box.scroll(scroller(), 1e9);
  await flush();
  await flush();
  assert.deepEqual(histories(h).filter((p) => p.limit === 50).map((p) => p.before_seq), [201, 251, 301]);
  assert.equal(seqs(h).at(-1), 300);
});

test('an open edit keeps the focus and its text when a jump would replace the window; a held target still jumps', async (t) => {
  const newest = range(201, 250);
  const { h } = await openChat({ messages: newest, channel: { last_seq: 250 },
    answers: { chatHistory: history(newest, { 151: { ok: true, messages: range(51, 150), has_more: true } }), chatSearch: found([match(100), match(240)]) } });
  t.after(h.restore);
  row(h, 249).focus();
  key(h, row(h, 249), 'e');
  const edit = h.view.q('.team-edit__input');
  edit.value = 'half an edit';
  const before = histories(h).length;
  await jumpVia(h, 100);
  assert.equal(histories(h).length, before, 'nothing read');
  assert.equal(h.window.document.activeElement, edit);
  assert.equal(edit.value, 'half an edit');
  results(h)[1].click();
  await flush();
  assert.deepEqual(jumped(h), [msgId(240)]);
  assert.equal(h.view.q('.team-edit__input'), edit, 'the edit stays open');
});

test('a `cleared` team cancels a jump in flight', async (t) => {
  const gate = heldAnswers();
  const { h } = await openThreadChat({ answers: { chatThread: gate.answer, chatSearch: found([match(4, { root_id: ROOT })]) } });
  t.after(h.restore);
  await jumpVia(h, 4);
  assert.equal(gate.calls.length, 1);
  chatPush(h, { type: 'cleared' });
  await flush();
  h.listeners.state({ teams: [memberTeam()] }); // asked again: the root is held once more
  await flush();
  gate.release(threadAnswer());
  await flush();
  assert.equal(note(h), '');
  assert.equal(threadOf(h), null, 'the old jump opened nothing');
});

test('a late window answer after a team change draws nothing and says nothing', async (t) => {
  const gate = heldAnswers();
  const newest = range(201, 250);
  const { h } = await openChat({ teams: [memberTeam(), snapshot()], messages: newest, channel: { last_seq: 250 },
    answers: { chatHistory: (p) => (p.before_seq === undefined ? { ok: true, messages: newest, has_more: true } : gate.answer(p)), chatSearch: found([match(100)]) } });
  t.after(h.restore);
  await jumpVia(h, 100);
  h.listeners.state({ teams: [snapshot()] });
  await flush();
  gate.release({ ok: true, messages: range(51, 150), has_more: true });
  await flush();
  assert.equal(note(h), '');
  assert.deepEqual(jumped(h), []);
});

test('a reply past the 400 its thread shows tints the root and says nothing', async (t) => {
  const many = Array.from({ length: 400 }, (_v, i) => reply(i + 3));
  const { h } = await openThreadChat({ answers: { chatThread: () => threadAnswer({ replies: many, has_more: true }), chatSearch: found([match(900, { root_id: ROOT })]) } });
  t.after(h.restore);
  await jumpVia(h, 900);
  assert.ok(threadOf(h).querySelector('.team-thread__capped'));
  assert.equal(threadOf(h).querySelector(`.team-msg[data-message-id="${ROOT}"]`).dataset.jumped, 'true');
  assert.equal(note(h), '');
});
