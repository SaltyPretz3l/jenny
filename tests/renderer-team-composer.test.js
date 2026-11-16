'use strict';

// The team channel you can write in (row 123, slice 2a-5b): the composer (Enter, drafts, the hint,
// mentions, typing out, the read-only sentence, locked teams), the typing line, and the message
// actions (the action row, edit in place, delete through the two-step confirm, mark unread, single
// keys). Real modules over the harness bridge; the layout stub gives the timeline a height.
// Outbox rows (queued, settled, failed) are in renderer-team-timeline.test.js, presence in
// renderer-team-tab-gate.test.js and the typing store in renderer-team-chat-store.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OTHER, ME, DOT, MAYA, CHAN, CHAT_MEMBERS, flush, micro, snapshot, memberTeam, hostState, chatMember, message, msgId, overview, openChat, heldAnswers,
  menu, menuLabels, type, key } = require('./helpers/team-settings-harness');

// In `memberTeam()` this Jenny is Dot (a member); the owner is Olive (ME). `message()` is by Dot.
const byOlive = (seq, over = {}) => message(seq, { author: { kind: 'member', member_id: ME }, ...over });
const input = (h) => h.view.q('.team-composer__input');
const hint = (h) => h.view.q('.team-composer__hint').textContent;
const row = (h, seq) => h.view.q(`.team-msg[data-message-id="${msgId(seq)}"]`);
const editBox = (h, seq) => row(h, seq)?.querySelector('.team-edit__input') || null;
const strip = (text) => String(text).replace(/[⁨⁩]/g, '');
const pick = (h, label) => [...menu(h).querySelectorAll('.inv-context-menu-item')].find((el) => el.textContent.trim() === label).click();

// ------------------------------------------------------------------ composer

test('Enter sends; Shift+Enter, Enter while composing and blank text do not', async (t) => {
  const { h } = await openChat();
  t.after(h.restore);
  const el = input(h);
  assert.ok(el, 'a composer under the timeline');
  assert.equal(el.getAttribute('dir'), 'auto');
  type(h, '   \n  ');
  key(h, el, 'Enter');
  h.view.q('[data-team-composer="send"]').click();
  await flush();
  assert.equal(h.sent('chatPost').length, 0, 'blank text is not sent');
  type(h, 'hello team');
  assert.equal(key(h, el, 'Enter', { shiftKey: true }).defaultPrevented, false, 'Shift+Enter is a new line');
  key(h, el, 'Enter', { isComposing: true });
  await flush();
  assert.equal(h.sent('chatPost').length, 0, 'Enter during IME composition does not send');
  assert.equal(key(h, el, 'Enter').defaultPrevented, true);
  await flush();
  assert.deepEqual(h.sent('chatPost').map((call) => call.payload), [{ team_id: OTHER, channel_id: CHAN, text: 'hello team' }]);
  assert.equal(el.value, '', 'the text leaves once it is queued');
});

test('two Enters while a post is in flight send it once', async (t) => {
  const gate = heldAnswers({ ok: true, entry_id: 'out_1_entry_00000000' });
  const { h } = await openChat({ answers: { chatPost: gate.answer } });
  t.after(h.restore);
  type(h, 'once');
  key(h, input(h), 'Enter');
  key(h, input(h), 'Enter');
  await flush();
  assert.equal(gate.calls.length, 1);
  gate.release();
  await flush();
  assert.equal(input(h).value, '');
});

test('the composer stays usable while reconnecting and offline, and the hint says when it sends', async (t) => {
  const { h } = await openChat();
  t.after(h.restore);
  assert.equal(hint(h), 'Markdown · Enter to send');
  h.listeners.state({ teams: [memberTeam({ state: 'reconnecting' })] });
  await flush();
  assert.equal(hint(h), 'Sends when reconnected');
  assert.equal(input(h).disabled, false);
  type(h, 'queued while away');
  key(h, input(h), 'Enter');
  await flush();
  assert.equal(h.sent('chatPost').length, 1, 'it queues');
  h.listeners.state({ teams: [memberTeam({ state: 'offline', since: 5 })] });
  await flush();
  assert.equal(hint(h), 'Sends when the host is back');
  assert.equal(input(h).disabled, false);
});

test('too large and the draft limit are said in the hint, by their words, and the text stays', async (t) => {
  const { h } = await openChat({ answers: {
    chatPost: { ok: false, error: { code: 'invalid_request', reason: 'team_chat_request_too_large' } },
    chatDraftSet: { ok: false, error: { code: 'invalid_request', reason: 'team_chat_draft_limit' } },
  } });
  t.after(h.restore);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  type(h, 'a very long text');
  key(h, input(h), 'Enter');
  await micro();
  assert.equal(hint(h), 'This message is too long to send. Shorten it and try again.');
  assert.equal(input(h).value, 'a very long text');
  type(h, 'a very long text, shorter');
  assert.equal(hint(h), 'Markdown · Enter to send', 'typing takes the words away');
  t.mock.timers.tick(500);
  await micro();
  assert.equal(hint(h), 'Jenny cannot keep more drafts. This text stays here but is not saved as a draft.');
  assert.equal(input(h).value, 'a very long text, shorter');
});

test('a read-only member reads one sentence naming the owner and files (2c pick 8), as text, and no draft is read', async (t) => {
  const members = [chatMember(ME, '<b>Olive</b>', { role: 'owner' }), chatMember(DOT, 'Dot', { role: 'read_only' })];
  const { h } = await openChat({ teams: [memberTeam({ role: 'read_only' })], members });
  t.after(h.restore);
  assert.equal(input(h), null);
  assert.equal(h.view.q('[data-team-composer="send"]'), null);
  const closed = h.view.q('.team-composer--closed');
  assert.equal(strip(closed.textContent), 'You can read this team’s channels and download its files. Ask <b>Olive</b> for write access to post or attach files.');
  assert.ok(closed.textContent.includes('⁨<b>Olive</b>⁩'), 'the name is isolated');
  assert.equal(closed.querySelector('b'), null);
  assert.equal(h.sent('chatDraftGet').length, 0);
});

for (const state of ['pending', 'revoked', 'update_required']) {
  test(`a ${state} team has no composer and makes no chat call`, async (t) => {
    const { h } = await openChat({ teams: [memberTeam({ state })] });
    t.after(h.restore);
    assert.equal(h.view.q('.team-composer, .team-typing'), null);
    assert.deepEqual(h.calls.filter((call) => call.method.startsWith('chat') || call.method === 'presenceSet').map((call) => call.method), []);
  });
}

test('typed text is not saved as a draft once the team locks', async (t) => {
  const { h } = await openChat();
  t.after(h.restore);
  type(h, 'half a thought');
  h.listeners.state({ teams: [memberTeam({ state: 'revoked' })] });
  await new Promise((resolve) => setTimeout(resolve, 650)); // past the 500 ms draft pause
  await flush();
  assert.equal(h.view.q('.team-composer'), null);
  assert.equal(h.sent('chatDraftSet').length, 0);
});

// ------------------------------------------------------------------ drafts

test('a draft is read when the channel opens and restored', async (t) => {
  const { h } = await openChat({ answers: { chatDraftGet: (p) => ({ ok: true, text: 'draft for ' + p.channel_id }) } });
  t.after(h.restore);
  assert.deepEqual(h.sent('chatDraftGet').map((call) => call.payload), [{ team_id: OTHER, channel_id: CHAN }]);
  assert.equal(input(h).value, 'draft for chan_team');
});

test('a draft answer that comes after typing does not overwrite the typed text', async (t) => {
  const gate = heldAnswers({ ok: true, text: 'an old draft' });
  const { h } = await openChat({ answers: { chatDraftGet: gate.answer } });
  t.after(h.restore);
  type(h, 'new words');
  gate.release();
  await flush();
  assert.equal(input(h).value, 'new words');
});

test('drafts save 500 ms after typing, one call in flight with the latest text after it, and empty text clears', async (t) => {
  const gate = heldAnswers({ ok: true });
  const sets = [];
  const { h } = await openChat({ answers: { chatDraftSet: (p) => { sets.push(p.text); return sets.length === 1 ? gate.answer(p) : { ok: true }; } } });
  t.after(h.restore);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  type(h, 'a');
  t.mock.timers.tick(499);
  await micro();
  assert.deepEqual(sets, []);
  t.mock.timers.tick(1);
  await micro();
  assert.deepEqual(sets, ['a']);
  type(h, 'ab');
  t.mock.timers.tick(500);
  type(h, 'abc');
  t.mock.timers.tick(500);
  await micro();
  assert.deepEqual(sets, ['a'], 'one in flight per channel');
  gate.release();
  await micro();
  assert.deepEqual(sets, ['a', 'abc'], 'the latest text trails');
  assert.deepEqual(h.sent('chatDraftSet')[1].payload, { team_id: OTHER, channel_id: CHAN, text: 'abc' });
  type(h, '');
  t.mock.timers.tick(500);
  await micro();
  assert.deepEqual(sets, ['a', 'abc', ''], 'an empty composer clears the draft');
});

test('leaving the view saves the draft once, at once', async (t) => {
  const { h } = await openChat();
  t.after(h.restore);
  type(h, 'unsent');
  h.tab.hideTeamTab();
  await flush();
  assert.deepEqual(h.sent('chatDraftSet').map((call) => call.payload.text), ['unsent']);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(h.sent('chatDraftSet').length, 1, 'the paused save does not run again');
});

// ------------------------------------------------------------- mentions and typing

test('the mention list: people and @channel, no @Jenny, names as text, keyboard reachable, picking inserts text', async (t) => {
  const members = [chatMember(ME, '<img src=x onerror=boom()>Olive', { role: 'owner' }), chatMember(DOT, 'Dot'), chatMember(MAYA, 'Maya')];
  const { h } = await openChat({ members });
  t.after(h.restore);
  h.view.q('[data-team-composer="mention"]').click();
  const list = h.view.q('.team-menu--mention');
  assert.equal(list.getAttribute('role'), 'listbox');
  assert.equal(list.hidden, false);
  const options = [...list.querySelectorAll('[role="option"]')];
  assert.deepEqual(options.map((el) => el.querySelector('.team-row__name').textContent), ['<img src=x onerror=boom()>Olive', 'Maya', '@channel']);
  assert.equal(list.querySelector('img'), null, 'a name with markup is text');
  assert.ok(!list.textContent.includes('Jenny'));
  const el = input(h);
  assert.equal(h.window.document.activeElement, el, 'the text area keeps the focus');
  key(h, el, 'ArrowDown');
  assert.equal(el.getAttribute('aria-activedescendant'), options[1].id);
  key(h, el, 'Enter');
  assert.equal(list.hidden, true);
  assert.equal(el.value, '@Maya ');
  assert.equal(h.sent('chatPost').length, 0, 'Enter in the list picks, it does not send');
  type(h, el.value + 'can you look?');
  key(h, el, 'Enter');
  await flush();
  assert.equal(h.sent('chatPost')[0].payload.text, '<@member_maya> can you look?', 'the name becomes the mention token on send');
  h.view.q('[data-team-composer="mention"]').click();
  key(h, el, 'Escape');
  assert.equal(list.hidden, true, 'Esc closes the list');
});

test('the typing line: a name for 6 s after its last push, your own never, the line stays in place', async (t) => {
  const members = [...CHAT_MEMBERS, chatMember(MAYA, '<i>Maya</i>')];
  const { h } = await openChat({ members });
  t.after(h.restore);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const line = h.view.q('.team-typing');
  assert.ok(line, 'the line is there before anyone types');
  assert.equal(line.textContent, '');
  const typing = (member) => h.listeners.chat({ team_id: OTHER, type: 'typing', channel_id: CHAN, thread_root_id: null, member_id: member });
  typing(MAYA);
  typing(DOT);
  await micro();
  assert.equal(strip(line.textContent), '<i>Maya</i> is typing', 'your own entry is never shown');
  assert.equal(line.querySelector('i'), null);
  t.mock.timers.tick(5_000);
  typing(MAYA);
  t.mock.timers.tick(5_000);
  await micro();
  assert.match(line.textContent, /Maya/, 'renewed by the later push');
  t.mock.timers.tick(1_000);
  await micro();
  assert.equal(line.textContent, '');
  assert.equal(h.view.q('.team-typing'), line, 'the same line, still in place');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'team-chat.css'), 'utf8');
  assert.match(css, /\.team-typing\s*\{[^}]*\bheight:/, 'a fixed height, so nothing shifts');
});

test('your own typing is sent at most once every 3 s, and never for an empty composer', async (t) => {
  const { h } = await openChat();
  t.after(h.restore);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  type(h, 'a');
  type(h, 'ab');
  assert.deepEqual(h.sent('chatTyping').map((call) => call.payload), [{ team_id: OTHER, channel_id: CHAN }]);
  t.mock.timers.tick(2_999);
  type(h, 'abc');
  assert.equal(h.sent('chatTyping').length, 1);
  t.mock.timers.tick(1);
  type(h, 'abcd');
  assert.equal(h.sent('chatTyping').length, 2);
  t.mock.timers.tick(3_000);
  type(h, '');
  type(h, '   ');
  assert.equal(h.sent('chatTyping').length, 2, 'none for an empty composer');
});

test('a message push while the reader types keeps the caret, the text and the scroll', async (t) => {
  const { h, box } = await openChat({ messages: Array.from({ length: 30 }, (_, i) => byOlive(i + 1)) });
  t.after(h.restore);
  const el = input(h);
  type(h, 'draft text here');
  el.focus();
  el.setSelectionRange(5, 5);
  const scroller = h.view.q('.team-scroll');
  box.scroll(scroller, 200);
  h.listeners.chat({ team_id: OTHER, type: 'messages', channel_id: CHAN, reset: false, messages: [byOlive(31)] });
  await flush();
  assert.equal(input(h), el, 'the same text area');
  assert.equal(el.value, 'draft text here');
  assert.equal(el.selectionStart, 5);
  assert.equal(h.window.document.activeElement, el);
  assert.equal(scroller.scrollTop, 200);
});

// ------------------------------------------------------------------ message actions

test('each message has an action row (a toolbar holding More); a queued row has none', async (t) => {
  const outbox = [{ entry_id: 'out_q_entry_00000000', operation: 'post', channel_id: CHAN, thread_root_id: null, message_id: null, text: 'waiting', created_at: new Date().toISOString(), state: 'queued', error: null }];
  const { h } = await openChat({ messages: [byOlive(1)], outbox });
  t.after(h.restore);
  const acts = row(h, 1).querySelector('.team-acts');
  assert.equal(acts.getAttribute('role'), 'toolbar');
  assert.ok(acts.querySelector('[data-team-msg-action="more"]'));
  assert.equal(h.view.q('.team-msg[data-pending="true"] .team-acts'), null);
});

test('edit in place: own messages only, with the row’s rev; Up opens the last own message; Esc restores the composer', async (t) => {
  const { h } = await openChat({ messages: [byOlive(1), message(2, { text: 'first', rev: 4 }), byOlive(3)] });
  t.after(h.restore);
  const doc = h.window.document;
  row(h, 3).focus();
  key(h, row(h, 3), 'e');
  assert.equal(editBox(h, 3), null, 'not on someone else’s message');
  row(h, 3).querySelector('[data-team-msg-action="more"]').click();
  assert.deepEqual(menuLabels(h), ['Add reaction', 'PinP', 'Mark unread'], 'no Edit or Delete on someone else’s message for a member');
  key(h, doc.activeElement, 'Escape');
  key(h, input(h), 'ArrowUp');
  const box = editBox(h, 2);
  assert.ok(box, 'Up in an empty composer edits your last message');
  assert.equal(box.value, 'first');
  assert.equal(doc.activeElement, box);
  key(h, box, 'Escape');
  assert.equal(editBox(h, 2), null);
  assert.equal(doc.activeElement, input(h), 'Esc leaves the edit and gives the composer back');
  assert.equal(h.sent('chatEdit').length, 0);
  row(h, 2).focus();
  key(h, row(h, 2), 'e');
  type(h, 'first, fixed', editBox(h, 2));
  key(h, editBox(h, 2), 'Enter');
  await flush();
  assert.deepEqual(h.sent('chatEdit').map((call) => call.payload), [{ team_id: OTHER, channel_id: CHAN, message_id: msgId(2), text: 'first, fixed', expected_rev: 4 }]);
  assert.equal(editBox(h, 2), null, 'closed once queued');
});

// Main queues an edit at once; it refuses at once only what it checks itself (here, the size). A conflict
// comes back later as a failed outbox entry (the next test).
test('a refused edit says why in words and keeps the edit text', async (t) => {
  const { h } = await openChat({ messages: [message(2, { text: 'first', rev: 4 })],
    answers: { chatEdit: { ok: false, error: { code: 'invalid_request', reason: 'team_chat_request_too_large' } } } });
  t.after(h.restore);
  key(h, input(h), 'ArrowUp');
  type(h, 'my better words', editBox(h, 2));
  key(h, editBox(h, 2), 'Enter');
  await flush();
  assert.equal(editBox(h, 2).value, 'my better words');
  assert.equal(row(h, 2).querySelector('.team-edit__hint').textContent, 'This message is too long to send. Shorten it and try again.');
});

test('a failed edit in the outbox says so on its message, and Retry sends its own text against the current rev', async (t) => {
  const outbox = [{ entry_id: 'out_e_entry_00000000', operation: 'edit', channel_id: CHAN, thread_root_id: null, message_id: msgId(2), text: 'my words',
    created_at: new Date().toISOString(), state: 'failed', error: { code: 'CMP-HOST-0004', reason: 'team_chat_stale' } }];
  const { h } = await openChat({ messages: [message(2, { text: 'theirs', rev: 7 })], outbox });
  t.after(h.restore);
  assert.match(row(h, 2).querySelector('.team-msg__foot').textContent, /Your edit was not saved\. Someone changed this message first\./);
  assert.deepEqual([...row(h, 2).querySelectorAll('.team-msg__foot button')].map((el) => el.textContent.trim()), ['Retry', 'Dismiss']);
  row(h, 2).querySelector('[data-team-msg-action="retry"]').click();
  await flush();
  assert.deepEqual(h.sent('chatEdit').map((call) => call.payload), [{ team_id: OTHER, channel_id: CHAN, message_id: msgId(2), text: 'my words', expected_rev: 7 }]);
  assert.deepEqual(h.sent('chatOutboxDiscard').map((call) => call.payload), [{ team_id: OTHER, entry_id: 'out_e_entry_00000000' }]);
});

test('delete: your own message through the two-step confirm; Cancel sends nothing; not someone else’s for a member', async (t) => {
  const { h } = await openChat({ messages: [byOlive(1), message(2)] });
  t.after(h.restore);
  let asked = 0;
  h.window.confirm = () => { asked += 1; return true; };
  row(h, 1).focus();
  key(h, row(h, 1), 'Delete');
  assert.equal(h.view.q('.team-confirm'), null, 'a member cannot delete someone else’s message');
  row(h, 2).focus();
  key(h, row(h, 2), 'Delete');
  const confirm = row(h, 2).querySelector('.team-confirm');
  assert.match(confirm.textContent, /Delete this message\?/);
  confirm.querySelector('[data-team-msg-action="delete-cancel"]').click();
  await flush();
  assert.equal(row(h, 2).querySelector('.team-confirm'), null);
  assert.equal(h.sent('chatDelete').length, 0, 'Cancel sends nothing');
  row(h, 2).querySelector('[data-team-msg-action="more"]').click();
  assert.deepEqual(menuLabels(h), ['Add reaction', 'PinP', 'Edit', 'Delete', 'Mark unread']);
  pick(h, 'Delete');
  row(h, 2).querySelector('[data-team-msg-action="delete-confirm"]').click();
  await flush();
  assert.deepEqual(h.sent('chatDelete').map((call) => call.payload), [{ team_id: OTHER, channel_id: CHAN, message_id: msgId(2) }]);
  assert.equal(asked, 0, 'never window.confirm');
});

test('the team owner can delete anyone’s message, through the confirm', async (t) => {
  const { h } = await openChat({ teams: [snapshot()], host: hostState(), messages: [message(1)] }); // by Dot; this Jenny is Olive, the owner
  t.after(h.restore);
  row(h, 1).querySelector('[data-team-msg-action="more"]').click();
  assert.deepEqual(menuLabels(h), ['Add reaction', 'PinP', 'Delete', 'Mark unread'], 'no Edit on someone else’s message');
  key(h, h.window.document.activeElement, 'Escape');
  row(h, 1).focus();
  key(h, row(h, 1), 'Delete');
  row(h, 1).querySelector('[data-team-msg-action="delete-confirm"]').click();
  await flush();
  assert.deepEqual(h.sent('chatDelete').map((call) => call.payload.message_id), [msgId(1)]);
});

test('mark unread from here sends unread with that message’s seq, and the channel is not marked read again until reopened', async (t) => {
  const { h } = await openChat({ messages: [byOlive(1), byOlive(2), byOlive(3)], channel: { last_seq: 3, last_read_seq: 3 } });
  t.after(h.restore);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 5_000 });
  const before = h.sent('chatMarkRead').length;
  row(h, 2).querySelector('[data-team-msg-action="more"]').click();
  pick(h, 'Mark unread');
  await flush();
  const unread = h.sent('chatMarkRead').slice(before);
  assert.deepEqual(unread.map((call) => call.payload), [{ team_id: OTHER, channel_id: CHAN, seq: 2, unread: true }]);
  t.mock.timers.tick(10_000);
  h.listeners.chat({ team_id: OTHER, type: 'messages', channel_id: CHAN, reset: false, messages: [byOlive(4)] });
  await flush();
  assert.equal(h.sent('chatMarkRead').length, before + 1, 'not marked read again while it stays open');
  h.tab.hideTeamTab();
  h.showTab();
  await flush();
  const after = h.sent('chatMarkRead').slice(before + 1);
  assert.ok(after.length >= 1 && after.every((call) => call.payload.unread === undefined), 'reopened, it is marked read');
});

test('single keys act only on a focused message: never in a text field, never while a menu is open; Esc with nothing open does nothing', async (t) => {
  const { h } = await openChat({ messages: [message(1), message(2)] });
  t.after(h.restore);
  const doc = h.window.document;
  key(h, input(h), 'Delete');
  type(h, 'e');
  key(h, input(h), 'e');
  assert.equal(h.view.q('.team-confirm, .team-edit__input'), null, 'not from the composer');
  row(h, 1).focus();
  key(h, row(h, 1), 'e');
  key(h, editBox(h, 1), 'Delete');
  assert.equal(h.view.q('.team-confirm'), null, 'not from the edit box');
  key(h, editBox(h, 1), 'Escape');
  row(h, 2).focus();
  key(h, row(h, 2), 'ContextMenu');
  assert.ok(menu(h), 'the context-menu key opens More');
  key(h, row(h, 2), 'e');
  key(h, row(h, 2), 'Delete');
  assert.equal(h.view.q('.team-confirm, .team-edit__input'), null, 'not while the menu is open');
  key(h, doc.activeElement, 'Escape');
  assert.equal(menu(h), null, 'Esc closes the menu first');
  row(h, 2).focus();
  const calls = h.calls.length;
  key(h, row(h, 2), 'Escape');
  assert.equal(doc.activeElement, row(h, 2), 'with nothing open, Esc does nothing');
  assert.equal(h.calls.length, calls);
});

test('a read-only member’s action row offers Mark unread only, and E and Delete do nothing', async (t) => {
  const { h } = await openChat({ teams: [memberTeam({ role: 'read_only' })], messages: [message(1)] });
  t.after(h.restore);
  row(h, 1).querySelector('[data-team-msg-action="more"]').click();
  assert.deepEqual(menuLabels(h), ['Add reactionRead-only members cannot react.', 'PinRead-only members cannot pin.P', 'Mark unread'], 'greyed with the reason (2b-2)');
  key(h, h.window.document.activeElement, 'Escape');
  row(h, 1).focus();
  key(h, row(h, 1), 'e');
  key(h, row(h, 1), 'Delete');
  assert.equal(h.view.q('.team-confirm, .team-edit__input'), null);
});

// ------------------------------------------------------------------ review round (2a-5b)

test('a mouse pick in the mention list inserts the name: the press keeps the focus in the text area', async (t) => {
  const { h } = await openChat({ members: [...CHAT_MEMBERS, chatMember(MAYA, 'Maya')] });
  t.after(h.restore);
  h.view.q('[data-team-composer="mention"]').click();
  const option = h.view.qa('.team-menu--mention [role="option"]').find((el) => el.textContent.includes('Maya'));
  const press = new h.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  option.dispatchEvent(press);
  assert.equal(press.defaultPrevented, true, 'the press does not take the focus, so no blur follows it');
  option.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(input(h).value, '@Maya ');
  assert.equal(h.view.q('.team-menu--mention').hidden, true);
});

test('Esc closes the mention list from the Mention button too', async (t) => {
  const { h } = await openChat();
  t.after(h.restore);
  const button = h.view.q('[data-team-composer="mention"]');
  button.click();
  button.focus();
  assert.equal(h.view.q('.team-menu--mention').hidden, false, 'still open with the focus on the button');
  assert.equal(key(h, button, 'Escape').defaultPrevented, true);
  assert.equal(h.view.q('.team-menu--mention').hidden, true);
});

test('an edit keeps mentions of people this Jenny cannot name as their own tokens', async (t) => {
  const text = '<@member_gone1> and <@member_gone2> look';
  const { h } = await openChat({ messages: [message(2, { text, mentions: ['member_gone1', 'member_gone2'], rev: 3 })] });
  t.after(h.restore);
  key(h, input(h), 'ArrowUp');
  key(h, editBox(h, 2), 'Enter');
  await flush();
  assert.equal(h.sent('chatEdit').length, 0, 'an untouched edit sends nothing');
  key(h, input(h), 'ArrowUp');
  type(h, editBox(h, 2).value.replace('look', 'please look'), editBox(h, 2));
  key(h, editBox(h, 2), 'Enter');
  await flush();
  assert.deepEqual(h.sent('chatEdit').map((call) => call.payload.text), ['<@member_gone1> and <@member_gone2> please look']);
});

test('an open edit is kept: E, Delete, another row’s Edit or Delete and Up in the composer go back to it', async (t) => {
  const { h } = await openChat({ messages: [message(1, { text: 'one' }), message(2, { text: 'two' })] });
  t.after(h.restore);
  const doc = h.window.document;
  row(h, 1).focus();
  key(h, row(h, 1), 'e');
  type(h, 'one, half edited', editBox(h, 1));
  const kept = (how) => {
    assert.equal(editBox(h, 1)?.value, 'one, half edited', how);
    assert.equal(doc.activeElement, editBox(h, 1), how);
    assert.equal(h.view.qa('.team-edit__input, .team-confirm').length, 1, how);
  };
  for (const name of ['e', 'Delete']) { row(h, 2).focus(); key(h, row(h, 2), name); kept(name); }
  for (const label of ['Edit', 'Delete']) { row(h, 2).querySelector('[data-team-msg-action="more"]').click(); pick(h, label); kept(label); }
  key(h, input(h), 'ArrowUp');
  kept('Up');
});

test('a message whose edit or delete is still queued offers neither Edit nor Delete', async (t) => {
  const entry = (op, seq) => ({ entry_id: 'q_' + op, operation: op, channel_id: CHAN, thread_root_id: null, message_id: msgId(seq),
    text: op === 'edit' ? 'new words' : null, created_at: new Date().toISOString(), state: 'queued', error: null });
  const { h } = await openChat({ messages: [message(1), message(2)], outbox: [entry('edit', 1), entry('delete', 2)] });
  t.after(h.restore);
  for (const seq of [1, 2]) {
    row(h, seq).querySelector('[data-team-msg-action="more"]').click();
    assert.deepEqual(menuLabels(h), ['Add reaction', 'PinP', 'Mark unread'], 'message ' + seq);
    key(h, h.window.document.activeElement, 'Escape');
    row(h, seq).focus();
    key(h, row(h, seq), 'e');
    key(h, row(h, seq), 'Delete');
    assert.equal(h.view.q('.team-confirm, .team-edit__input'), null, 'message ' + seq);
  }
});

test('switching to a locked team saves the shown team’s draft; a team that left the list sends nothing', async (t) => {
  const locked = memberTeam({ team_id: 'team_L', team_name: 'Locked lab', state: 'revoked' });
  const { h } = await openChat({ teams: [memberTeam(), locked] });
  t.after(h.restore);
  type(h, 'unsent words');
  h.view.q('[data-team-tab-action="switch"]').click();
  [...h.window.document.querySelectorAll('.team-switch-menu [role="menuitemradio"]')].find((el) => el.textContent.includes('Locked lab')).click();
  await flush();
  assert.deepEqual(h.sent('chatDraftSet').map((call) => call.payload), [{ team_id: OTHER, channel_id: CHAN, text: 'unsent words' }]);

  const other = memberTeam({ team_id: 'team_B', team_name: 'Beta lab' });
  const second = await openChat({ teams: [memberTeam(), other] });
  t.after(second.h.restore);
  type(second.h, 'for a team I left');
  second.h.listeners.state({ teams: [other] });
  await flush();
  assert.deepEqual(second.h.sent('chatDraftSet').filter((call) => call.payload.team_id === OTHER), [], 'no draft call for a team that is gone');
});

test('a draft is not erased when write access goes while a save is in flight, and nothing trails a locked team', async (t) => {
  for (const change of [{ role: 'read_only' }, { state: 'revoked' }]) {
    const gate = heldAnswers({ ok: true });
    const { h } = await openChat({ answers: { chatDraftSet: gate.answer } });
    t.after(h.restore);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    type(h, 'first');
    t.mock.timers.tick(500);
    await micro();
    type(h, 'second');
    t.mock.timers.tick(500);
    await micro();
    assert.deepEqual(gate.calls.map((p) => p.text), ['first'], 'one in flight');
    h.listeners.state({ teams: [memberTeam(change)] });
    await micro();
    gate.release();
    for (let i = 0; i < 2; i += 1) await micro();
    const texts = gate.calls.map((p) => p.text);
    if (change.role) assert.deepEqual(texts, ['first', 'second'], 'the trailing save keeps the text, it does not clear the draft');
    else assert.deepEqual(texts, ['first'], 'no draft call once the team locked');
    t.mock.timers.reset();
  }
});

test('a failed Mark unread lets the channel be marked read again', async (t) => {
  const refused = { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } };
  const { h } = await openChat({ messages: [byOlive(1), byOlive(2), byOlive(3)], channel: { last_seq: 3, last_read_seq: 3 },
    answers: { chatMarkRead: (p) => (p.unread ? refused : { ok: true, last_read_seq: p.seq }) } });
  t.after(h.restore);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 5_000 });
  row(h, 2).querySelector('[data-team-msg-action="more"]').click();
  pick(h, 'Mark unread');
  await flush();
  const before = h.sent('chatMarkRead').length;
  assert.equal(h.sent('chatMarkRead').at(-1).payload.unread, true);
  t.mock.timers.tick(10_000);
  h.listeners.chat({ team_id: OTHER, type: 'messages', channel_id: CHAN, reset: false, messages: [byOlive(4)] });
  await flush();
  assert.deepEqual(h.sent('chatMarkRead').slice(before).map((call) => call.payload), [{ team_id: OTHER, channel_id: CHAN, seq: 4 }]);
});
