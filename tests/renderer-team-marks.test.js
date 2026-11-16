'use strict';

// Team chat slice 2b-2: reactions and pins on a message row (chips, the add chip, the picker, the optimistic
// overlay, More's entries and the P key, the pin mark), in the timeline and the thread column. Real modules over
// the harness bridge. The twelve acceptance criteria of the owner's 2b-2 picks are tagged [n].

const test = require('node:test');
const assert = require('node:assert/strict');
const { OTHER, ME, DOT, CHAN, flush, memberTeam, chatChannel, chatMember, message, msgId, overview, openChat, heldAnswers, menu, menuLabels, key,
  openThreadChat, threadOf, channelRow, openThreadFrom, reply, byRoot } = require('./helpers/team-settings-harness');

// The host's list is longer; the picker draws whatever the overview sent.
const EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '🔥', '✅', '😮', '😢'];
const OVERVIEW_TEXT = 'Your reaction was not added. ';

async function open({ messages = [message(1, { reactions: { '👍': [DOT, ME], '👀': [ME] } })], channel = {}, role = 'member', emoji = EMOJI, members, answers = {}, ...rest } = {}) {
  const got = await openChat({ messages, teams: [memberTeam({ role })], ...rest, answers: {
    chatOverview: overview({ channels: [chatChannel(channel)], reaction_emoji: emoji, ...(members ? { members } : {}) }),
    chatReact: { ok: true, rev: 99 },
    chatPin: { ok: true, rev: 99 },
    ...answers,
  } });
  return got;
}
const rowOf = (h, seq) => channelRow(h, seq);
const chips = (row) => [...row.querySelectorAll('.team-react:not(.team-react--add)')];
const chipText = (el) => [el.querySelector('.team-react__e').textContent, el.querySelector('.team-react__n').textContent];
const picker = (h) => h.view.q('.team-pop--emoji');
const pick = (h, emoji) => [...picker(h).querySelectorAll('.team-emoji__btn')].find((b) => b.dataset.emoji === emoji);
const push = (h, messages) => h.listeners.chat({ team_id: OTHER, type: 'messages', channel_id: CHAN, reset: false, messages });
const clickMore = (h, row) => { row.querySelector('[data-team-msg-action="more"]').click(); return menuLabels(h); };
const menuItem = (h, label) => [...menu(h).querySelectorAll('.inv-context-menu-item')].find((el) => el.textContent.trim().startsWith(label));
const foot = (row) => row.querySelector('.team-msg__foot');

test('[1] one chip per emoji in the record\'s order, your own pressed with a name that starts with You; none, no chips line', async (t) => {
  const { h } = await open({ messages: [message(1, { reactions: { '👍': [DOT, ME], '👀': [ME], '🔥': [DOT] } }), message(2)] });
  t.after(h.restore);
  const row = rowOf(h, 1);
  const list = chips(row);
  assert.deepEqual(list.map(chipText), [['👍', '2'], ['👀', '1'], ['🔥', '1']], 'the record\'s order, emoji and count');
  assert.deepEqual(list.map((el) => el.getAttribute('aria-pressed')), ['true', 'false', 'true'], 'DOT is this member: pressed where listed');
  assert.equal(list[0].getAttribute('aria-label'), 'You and Olive Owner reacted with 👍');
  assert.equal(list[1].getAttribute('aria-label'), 'Olive Owner reacted with 👀');
  assert.equal(list[0].title, list[0].getAttribute('aria-label'));
  assert.ok(row.querySelector('.team-react--add'), 'the add chip follows the chips');
  assert.equal(row.querySelector('.team-react--add').getAttribute('aria-label'), 'Add reaction');
  assert.ok(row.querySelector('.team-reacts').nextElementSibling === null || !row.querySelector('.team-reacts').nextElementSibling.classList.contains('team-react'), 'one line of chips');
  assert.equal(rowOf(h, 2).querySelector('.team-reacts'), null, 'no reactions, no chips line and no add chip');
  assert.equal(rowOf(h, 2).querySelector('.team-react--add'), null);
});

test('text from the host stays text: an emoji from a record is never markup, and one outside the team list is still drawn on a chip', async (t) => {
  const evil = '<img src=x onerror=alert(1)>';
  const { h } = await open({ messages: [message(1, { reactions: { [evil]: [ME], '🦄': [ME] } })] });
  t.after(h.restore);
  const row = rowOf(h, 1);
  assert.equal(row.querySelector('img'), null);
  assert.deepEqual(chips(row).map((el) => el.querySelector('.team-react__e').textContent), [evil, '🦄']);
  row.querySelector('.team-react--add').click();
  assert.deepEqual([...picker(h).querySelectorAll('.team-emoji__btn')].map((b) => b.dataset.emoji), EMOJI, 'the picker offers the team list only');
});

test('[2] a chip changes at once, the push confirms it with no flicker; a redraw while the call is out keeps it', async (t) => {
  const gate = heldAnswers({ ok: true, rev: 4 });
  const { h } = await open({ messages: [message(1, { rev: 2, reactions: { '👍': [ME] } })], answers: { chatReact: gate.answer } });
  t.after(h.restore);
  const row = rowOf(h, 1);
  chips(row)[0].click();
  await flush();
  assert.deepEqual(gate.calls, [{ team_id: OTHER, channel_id: CHAN, message_id: msgId(1), emoji: '👍', on: true }]);
  assert.deepEqual(chipText(chips(rowOf(h, 1))[0]), ['👍', '2'], 'at once');
  assert.equal(chips(rowOf(h, 1))[0].getAttribute('aria-pressed'), 'true');
  assert.equal(chat(h, 1).reactions['👍'].length, 1, 'the store\'s record is not written');
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [chatChannel({ last_seq: 1 })] });
  await flush();
  assert.deepEqual(chipText(chips(rowOf(h, 1))[0]), ['👍', '2'], 'a redraw of the row keeps the overlay');
  push(h, [message(1, { rev: 4, reactions: { '👍': [ME, DOT] } })]);
  await flush();
  assert.deepEqual(chipText(chips(rowOf(h, 1))[0]), ['👍', '2'], 'the push shows the same');
  gate.release();
  await flush();
  assert.deepEqual(chipText(chips(rowOf(h, 1))[0]), ['👍', '2'], 'no flicker after the answer');
  assert.equal(foot(rowOf(h, 1)).querySelector('.team-failed'), null);
  push(h, [message(1, { rev: 5, reactions: { '👍': [ME] } })]);
  await flush();
  assert.deepEqual(chipText(chips(rowOf(h, 1))[0]), ['👍', '1'], 'a later push without this member shows one fewer: the overlay is gone');
});
const chat = (h, seq) => h.chat.timeline(OTHER, CHAN).list.find((m) => m.id === msgId(seq));

test('[2] a refused change flips back and the row foot says why with the approved sentence, once and not in a toast', async (t) => {
  const cases = [
    ['team_chat_reaction_limit', 'This message already has 20 different reactions, the most it can have.'],
    ['team_chat_emoji_invalid', 'This team does not accept that reaction.'],
    ['role_forbidden', 'Read-only members cannot react.'],
    ['team_chat_rate_limit', 'The team server is busy. Try again in a moment.'],
    ['disk_pressure', 'The team server is low on disk space, so nothing can be added right now.'],
  ];
  for (const [reason, words] of cases) {
    const { h } = await open({ messages: [message(1, { reactions: { '👍': [ME] } })], answers: { chatReact: { ok: false, error: { code: 'CMP-TEAM-0009', reason } } } });
    chips(rowOf(h, 1))[0].click();
    await flush();
    assert.deepEqual(chipText(chips(rowOf(h, 1))[0]), ['👍', '1'], reason + ': flipped back');
    assert.equal(chips(rowOf(h, 1))[0].getAttribute('aria-pressed'), 'false');
    assert.equal([...rowOf(h, 1).querySelectorAll('.team-failed')].map((el) => el.textContent).join('|'), OVERVIEW_TEXT + words, reason);
    assert.equal(h.view.q('.inv-toast'), null, 'no toast');
    h.restore();
  }
  const { h } = await open({ messages: [message(1, { reactions: { '👍': [DOT] } })], answers: { chatReact: { ok: false, error: { code: 'CMP-TEAM-0007', reason: 'team_chat_rate_limit' } } } });
  chips(rowOf(h, 1))[0].click();
  await flush();
  assert.match(rowOf(h, 1).querySelector('.team-failed').textContent, /^Your reaction was not removed\. /);
  h.restore();
});

test('[3] the smiley, the add chip and More\'s Add reaction each open the picker: the team list, eight to a row; arrows, Home, End, Enter and Esc', async (t) => {
  const { h } = await open();
  t.after(h.restore);
  const row = rowOf(h, 1);
  const smiley = row.querySelector('[data-team-msg-action="react-pick"]');
  assert.equal(smiley.getAttribute('aria-label'), 'Add reaction');
  assert.equal(row.querySelector('.team-acts').firstElementChild, smiley, 'the smiley starts the action row');
  smiley.click();
  assert.equal(picker(h).getAttribute('role'), 'dialog');
  assert.equal(picker(h).getAttribute('aria-label'), 'Add reaction');
  assert.deepEqual([...picker(h).querySelectorAll('.team-emoji__btn')].map((b) => b.textContent), EMOJI, 'the overview\'s list, in its order');
  assert.equal(pick(h, '👍').getAttribute('aria-pressed'), 'true', 'yours is pressed');
  assert.equal(pick(h, '🎉').getAttribute('aria-pressed'), 'false');
  assert.equal(h.window.document.activeElement, pick(h, '👍'), 'focus starts on the first usable emoji');
  // Arrows move in two dimensions (eight to a row), Home and End jump, Enter picks, Esc closes and the row has the focus.
  const at = () => h.window.document.activeElement.dataset.emoji;
  key(h, picker(h), 'ArrowRight'); assert.equal(at(), '❤️');
  key(h, picker(h), 'ArrowDown'); assert.equal(at(), '😢', 'one row down');
  key(h, picker(h), 'ArrowUp'); assert.equal(at(), '❤️');
  key(h, picker(h), 'End'); assert.equal(at(), '😢');
  key(h, picker(h), 'Home'); assert.equal(at(), '👍');
  key(h, picker(h), 'Escape');
  assert.equal(picker(h), null);
  assert.equal(h.window.document.activeElement, rowOf(h, 1), 'focus returns to the message row');
  row.querySelector('.team-react--add').click();
  assert.ok(picker(h), 'the add chip');
  key(h, picker(h), 'Escape');
  clickMore(h, row);
  menuItem(h, 'Add reaction').click();
  assert.ok(picker(h), 'More\'s Add reaction');
  key(h, picker(h), 'ArrowRight'); key(h, picker(h), 'ArrowRight');
  pick(h, '🎉').click();
  await flush();
  assert.equal(picker(h), null, 'picking closes the picker');
  assert.deepEqual(h.sent('chatReact').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN, message_id: msgId(1), emoji: '🎉', on: true }]);
});

test('[3] picking an emoji of yours removes it; an open picker survives a push that redraws its row, closes on a click away and with the frame', async (t) => {
  const { h } = await open();
  t.after(h.restore);
  rowOf(h, 1).querySelector('[data-team-msg-action="react-pick"]').click();
  push(h, [message(1, { rev: 5, text: 'changed', reactions: { '👍': [DOT, ME], '👀': [ME] } })]);
  await flush();
  assert.ok(picker(h) && picker(h).isConnected, 'the redraw of the row leaves the picker');
  h.window.document.body.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true }));
  assert.equal(picker(h), null, 'a click away closes it');
  rowOf(h, 1).querySelector('[data-team-msg-action="react-pick"]').click();
  pick(h, '👍').click();
  await flush();
  assert.equal(h.sent('chatReact')[0].payload.on, false, 'it was yours: picking removes it');
  rowOf(h, 1).querySelector('[data-team-msg-action="react-pick"]').click();
  assert.ok(picker(h));
  h.tab.hideTeamTab();
  assert.equal(h.window.document.querySelector('.team-pop'), null, 'removed with the frame');
});

test('[4] 20 different emoji: the picker says the approved sentence and only the ones present can be picked', async (t) => {
  const twenty = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x1F600 + i));
  const reactions = Object.fromEntries(twenty.map((e) => [e, [ME]]));
  const { h } = await open({ messages: [message(1, { reactions })], emoji: [...twenty.slice(0, 5), '🙏', '🔥'] });
  t.after(h.restore);
  assert.equal(chips(rowOf(h, 1)).length, 20);
  const add = rowOf(h, 1).querySelector('.team-react--add');
  assert.equal(add.title, 'This message has 20 different reactions, the most it can have. You can still add to one of those.');
  add.click();
  assert.equal(picker(h).querySelector('.team-pop__note').textContent, 'This message has 20 different reactions, the most it can have. You can still add to one of those.');
  const state = Object.fromEntries([...picker(h).querySelectorAll('.team-emoji__btn')].map((b) => [b.dataset.emoji, b.disabled]));
  assert.deepEqual(state, { [twenty[0]]: false, [twenty[1]]: false, [twenty[2]]: false, [twenty[3]]: false, [twenty[4]]: false, '🙏': true, '🔥': true });
});

test('[5] a read-only member: chips, the smiley, the add chip, Add reaction and Pin greyed with the reason; nothing is sent', async (t) => {
  const { h } = await open({ role: 'read_only' });
  t.after(h.restore);
  const row = rowOf(h, 1);
  for (const el of [...chips(row), row.querySelector('.team-react--add')]) {
    assert.equal(el.getAttribute('aria-disabled'), 'true');
    assert.match(el.getAttribute('aria-label'), /Read-only members cannot react\.$/);
  }
  const smiley = row.querySelector('[data-team-msg-action="react-pick"]');
  assert.ok(smiley.disabled || smiley.getAttribute('aria-disabled') === 'true');
  assert.match(smiley.getAttribute('aria-label') + smiley.title, /Read-only members cannot react\./);
  chips(row)[0].click();
  row.querySelector('.team-react--add').click();
  smiley.click();
  assert.equal(picker(h), null);
  clickMore(h, row);
  const add = menuItem(h, 'Add reaction');
  const pin = menuItem(h, 'Pin');
  assert.equal(add.disabled, true);
  assert.equal(pin.disabled, true);
  assert.match(add.textContent, /Read-only members cannot react\./);
  assert.match(pin.textContent, /Read-only members cannot pin\./);
  add.click(); pin.click();
  key(h, menu(h), 'Escape');
  row.focus();
  key(h, row, 'p');
  await flush();
  assert.equal(foot(row).querySelector('.team-failed').textContent, 'Not pinned. Read-only members cannot pin.', 'P says why in the foot');
  assert.deepEqual([h.sent('chatReact').length, h.sent('chatPin').length], [0, 0], 'nothing sent');
});

test('[5] offline: the same controls say Needs the team online and send nothing', async (t) => {
  const { h } = await open();
  t.after(h.restore);
  h.listeners.state({ teams: [memberTeam({ state: 'offline' })], host: { state: 'stopped' } });
  await flush();
  const row = rowOf(h, 1);
  for (const el of [...chips(row), row.querySelector('.team-react--add')]) assert.match(el.getAttribute('aria-label'), /Needs the team online$/);
  chips(row)[0].click();
  clickMore(h, row);
  assert.match(menuItem(h, 'Add reaction').textContent, /Needs the team online/);
  assert.match(menuItem(h, 'Pin').textContent, /Needs the team online/);
  assert.equal(h.sent('chatReact').length, 0);
});

test('[6] More offers Pin on an unpinned live message and Unpin on a pinned one; P does the same; the foot then says Pinned by you', async (t) => {
  const { h } = await open({ messages: [message(1), message(2, { pinned: { by: ME, at: new Date().toISOString() } }), message(3, { text: '', deleted: { by: ME, at: new Date().toISOString() } })] });
  t.after(h.restore);
  assert.deepEqual(clickMore(h, rowOf(h, 1)).slice(0, 2), ['Add reaction', 'PinP']);
  menuItem(h, 'Pin').click();
  await flush();
  assert.deepEqual(h.sent('chatPin').map((c) => c.payload), [{ team_id: OTHER, channel_id: CHAN, message_id: msgId(1), on: true }]);
  push(h, [message(1, { rev: 9, pinned: { by: DOT, at: new Date().toISOString() } })]);
  await flush();
  assert.equal(rowOf(h, 1).querySelector('.team-pinmark').textContent.trim(), 'Pinned by you');
  assert.equal(rowOf(h, 2).querySelector('.team-pinmark').textContent.trim(), 'Pinned by Olive Owner');
  assert.deepEqual(clickMore(h, rowOf(h, 2)).slice(0, 2), ['Add reaction', 'UnpinP']);
  key(h, menu(h), 'Escape');
  rowOf(h, 2).focus();
  key(h, rowOf(h, 2), 'p');
  await flush();
  assert.equal(h.sent('chatPin')[1].payload.on, false, 'P on a pinned row unpins');
  assert.equal(rowOf(h, 3).querySelector('.team-pinmark'), null, 'a deleted message has no mark');
  assert.equal(rowOf(h, 3).querySelector('[data-team-msg-action="react-pick"]'), null, 'and offers no reaction');
});

test('[6] with 50 pins Pin is greyed with the approved reason, an unpin is not; a refused pin says so in the foot', async (t) => {
  const { h } = await open({ messages: [message(1), message(2, { pinned: { by: ME, at: new Date().toISOString() } })], channel: { pin_count: 50 } });
  t.after(h.restore);
  clickMore(h, rowOf(h, 1));
  assert.equal(menuItem(h, 'Pin').disabled, true);
  assert.match(menuItem(h, 'Pin').textContent, /This channel has 50 pinned messages, the most it can have\. Unpin one first\./);
  key(h, menu(h), 'Escape');
  clickMore(h, rowOf(h, 2));
  assert.equal(menuItem(h, 'Unpin').disabled, false);
  key(h, menu(h), 'Escape');
  assert.equal(h.sent('chatPin').length, 0);
  const refused = await open({ messages: [message(1)], answers: { chatPin: { ok: false, error: { code: 'CMP-TEAM-0009', reason: 'team_chat_pin_limit' } } } });
  clickMore(refused.h, rowOf(refused.h, 1));
  menuItem(refused.h, 'Pin').click();
  await flush();
  assert.equal(rowOf(refused.h, 1).querySelector('.team-failed').textContent, 'Not pinned. This channel already has 50 pinned messages, the most it can have. Unpin one first.');
  refused.h.restore();
});

test('[12] in a thread a reply draws chips, the pin mark and edited as in the timeline; More gains Add reaction and Pin; no Seen by', async (t) => {
  const { h } = await openThreadChat({ answers: {
    chatOverview: overview({ channels: [chatChannel({ reads: [{ member_id: ME, seq: 9 }] })], reaction_emoji: EMOJI }),
    chatReact: { ok: true, rev: 99 }, chatPin: { ok: true, rev: 99 },
    chatThread: byRoot({ replies: [reply(3, { reactions: { '🔥': [ME] }, pinned: { by: ME, at: new Date().toISOString() }, edited_at: new Date().toISOString() }), reply(4)] }),
  }, teams: [memberTeam()] });
  t.after(h.restore);
  await openThreadFrom(h);
  const column = threadOf(h);
  const row = column.querySelector(`.team-msg[data-message-id="${msgId(3)}"]`);
  assert.deepEqual(chipText(row.querySelector('.team-react')), ['🔥', '1']);
  assert.equal(row.querySelector('.team-pinmark').textContent.trim(), 'Pinned by Olive Owner');
  assert.equal(row.querySelector('button.team-msg__edited').textContent, 'edited');
  assert.equal(column.querySelector('.team-seen'), null, 'Seen by is never drawn in a thread');
  row.querySelector('[data-team-msg-action="more"]').click();
  assert.deepEqual(menuLabels(h).slice(0, 2), ['Add reaction', 'UnpinP'], 'a pinned reply');
  menuItem(h, 'Add reaction').click();
  assert.ok(picker(h), 'the picker opens in the thread');
});

test('a long message is not rendered again for a reaction: its body is keyed by text and edited_at', async (t) => {
  const { h } = await open({ messages: [message(1, { text: '**long** message ' + 'word '.repeat(200), rev: 1 })] });
  t.after(h.restore);
  const md = h.window.markdownUtils;
  const original = md.renderMarkdown;
  let renders = 0;
  md.renderMarkdown = (...args) => { renders += 1; return original.apply(md, args); };
  t.after(() => { md.renderMarkdown = original; });
  push(h, [message(1, { text: '**long** message ' + 'word '.repeat(200), rev: 2, reactions: { '👍': [ME] } })]);
  await flush();
  assert.equal(renders, 0, 'a reaction raises the rev and renders nothing again');
  push(h, [message(1, { text: 'edited text', rev: 3, edited_at: new Date().toISOString(), reactions: { '👍': [ME] } })]);
  await flush();
  assert.equal(renders, 1, 'an edit does');
});

test('the foot reads in order: chips, the replies link, Pinned by, Seen by, then the outbox words and a refusal', async (t) => {
  const stamp = new Date().toISOString();
  const { h } = await open({ messages: [message(1), message(2, { reactions: { '👍': [ME] }, reply_count: 2, last_reply_at: stamp, pinned: { by: ME, at: stamp } })],
    channel: { reads: [{ member_id: ME, seq: 2 }] } });
  t.after(h.restore);
  const row = rowOf(h, 2);
  assert.deepEqual([...foot(row).children].map((el) => el.className.split(' ')[0]), ['team-reacts', 'team-thread-link', 'team-pinmark', 'team-seen'], 'chips, replies link, pin mark, seen by');
  row.querySelector('[data-team-msg-action="more"]').click();
  assert.ok(menu(h));
  key(h, menu(h), 'Escape');
});

test('names and words from the host go through escapeHtml in the chips, the pin mark and the picker heading', async (t) => {
  const evil = chatMember(ME, '<img src=x onerror=alert(1)>', { role: 'owner' });
  const { h } = await open({ messages: [message(1, { reactions: { '👍': [ME] }, pinned: { by: ME, at: new Date().toISOString() } })], members: [evil, chatMember(DOT, 'Dot')] });
  t.after(h.restore);
  const row = rowOf(h, 1);
  assert.equal(row.querySelector('img'), null);
  assert.equal(row.querySelector('.team-pinmark').textContent.trim(), 'Pinned by <img src=x onerror=alert(1)>');
  assert.match(chips(row)[0].getAttribute('aria-label'), /^<img src=x onerror=alert\(1\)> reacted with 👍$/);
});

test('with the team flag off, nothing of reactions, pins, versions or Seen by loads; the Team tab list names every new script', async (t) => {
  const { harness: makeHarness, shell } = require('./helpers/team-settings-harness');
  const h = makeHarness({ show: false });
  t.after(h.restore);
  const s = shell(h, { flag: false });
  await flush();
  const mine = ['pop', 'marks', 'receipts', 'pins'].map((name) => `renderer/team/renderer-team-${name}.js`);
  assert.equal(mine.some((src) => s.requested.includes(src)), false, 'flag off: nothing requested');
  const manifest = require('../renderer/shell/renderer-settings-script-manifest');
  const tab = manifest.teamTab.map(([src]) => src);
  for (const src of mine) assert.ok(tab.includes(src), src + ' loads with the Team tab');
  for (const src of mine) assert.ok(tab.indexOf(src) < tab.indexOf('renderer/team/renderer-team-message-actions.js') || src.endsWith('pins.js'), src + ' before its user');
  assert.ok(tab.indexOf('renderer/team/renderer-team-pins.js') < tab.indexOf('renderer/team/renderer-team-tab-view.js'), 'the header button loads before the tab view');
  const chat = [...manifest.teamChat, ...manifest.teamStore, ...manifest.teamGate].map(([src]) => src);
  assert.equal(mine.some((src) => chat.includes(src)), false, 'not in the gate, store or chat lists');
});

// ---------------------------------------------------------------- fix round (orchestrator's list, items 4, 8, 10, 12, 13)

test('a greyed control sends nothing: offline, Pin from More and P; at 50 pins the greyed entry and P; at 20 reactions a greyed picker cell, also with its greying stripped', async (t) => {
  const offline = await open();
  t.after(offline.h.restore);
  offline.h.listeners.state({ teams: [memberTeam({ state: 'offline' })], host: { state: 'stopped' } });
  await flush();
  const row = rowOf(offline.h, 1);
  clickMore(offline.h, row);
  assert.equal(menuItem(offline.h, 'Pin').disabled, true);
  menuItem(offline.h, 'Pin').click();
  key(offline.h, menu(offline.h), 'Escape');
  row.focus();
  key(offline.h, row, 'p');
  await flush();
  assert.equal(offline.h.sent('chatPin').length, 0, 'offline: Pin from More and P send nothing');
  assert.equal(foot(row).querySelector('.team-failed').textContent, 'Not pinned. Needs the team online', 'P says why');

  const full = await open({ messages: [message(1)], channel: { pin_count: 50 } });
  t.after(full.h.restore);
  clickMore(full.h, rowOf(full.h, 1));
  menuItem(full.h, 'Pin').click();
  key(full.h, menu(full.h), 'Escape');
  rowOf(full.h, 1).focus();
  key(full.h, rowOf(full.h, 1), 'p');
  await flush();
  assert.equal(full.h.sent('chatPin').length, 0, 'at 50 pins: the greyed entry and P send nothing');
  assert.match(foot(rowOf(full.h, 1)).querySelector('.team-failed').textContent, /^Not pinned\. This channel has 50 pinned messages/);

  const twenty = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x1F600 + i));
  const cap = await open({ messages: [message(1, { reactions: Object.fromEntries(twenty.map((e) => [e, [ME]])) })], emoji: [twenty[0], '🙏'] });
  t.after(cap.h.restore);
  rowOf(cap.h, 1).querySelector('.team-react--add').click();
  const cell = pick(cap.h, '🙏');
  assert.equal(cell.disabled, true);
  cell.click();
  assert.equal(cap.h.sent('chatReact').length, 0, 'a click on the greyed cell sends nothing');
  cell.disabled = false; // the DOM's own greying removed: the module's own guard still holds
  cell.click();
  await flush();
  assert.equal(cap.h.sent('chatReact').length, 0, 'and so does a cell that lost its greying');
});

test('while the team\'s emoji list has not arrived, the smiley and More\'s Add reaction are greyed and say why', async (t) => {
  const { h } = await open({ emoji: [] });
  t.after(h.restore);
  const row = rowOf(h, 1);
  const smiley = row.querySelector('[data-team-msg-action="react-pick"]');
  assert.equal(smiley.disabled, true);
  assert.equal(smiley.title, 'Add reaction The emoji list has not arrived yet.');
  assert.equal(smiley.getAttribute('aria-label'), smiley.title);
  clickMore(h, row);
  assert.equal(menuItem(h, 'Add reaction').disabled, true);
  assert.match(menuItem(h, 'Add reaction').textContent, /The emoji list has not arrived yet\./);
  key(h, menu(h), 'Escape');
  h.listeners.chat({ team_id: OTHER, type: 'members', members: [chatMember(ME, 'Olive Owner', { role: 'owner' }), chatMember(DOT, 'Dot')] });
  await flush();
  assert.equal(row.querySelector('[data-team-msg-action="react-pick"]').disabled, true, 'a members push does not bring the list');
});

test('the rows of one pass read the block words and the emoji list once, not once per row', async (t) => {
  const messages = Array.from({ length: 60 }, (_, i) => message(i + 1));
  const { h } = await open({ messages });
  t.after(h.restore);
  const store = h.chat;
  const original = store.emoji;
  let reads = 0;
  store.emoji = (...args) => { reads += 1; return original.apply(store, args); };
  t.after(() => { store.emoji = original; });
  push(h, [message(30, { rev: 5, text: 'changed' })]);
  await flush();
  push(h, [message(31, { rev: 5, text: 'changed too' })]);
  await flush();
  assert.ok(reads <= 8, 'two passes over 60 rows read the list ' + reads + ' times');
});

test('Esc with a popover open closes only the popover: not the thread column, not an open edit', async (t) => {
  const { h } = await openThreadChat({ answers: {
    chatOverview: overview({ channels: [chatChannel()], reaction_emoji: EMOJI }), chatReact: { ok: true, rev: 99 } } });
  t.after(h.restore);
  await openThreadFrom(h);
  const column = threadOf(h);
  const replyRow = column.querySelector(`.team-msg[data-message-id="${msgId(3)}"]`);
  replyRow.querySelector('[data-team-msg-action="react-pick"]').click();
  assert.ok(picker(h), 'the picker is open in the column');
  key(h, picker(h).querySelector('.team-emoji__btn'), 'Escape');
  assert.equal(picker(h), null, 'Esc closed the picker');
  await flush();
  assert.ok(threadOf(h), 'and not the thread');
  replyRow.querySelector('[data-team-msg-action="react-pick"]').click();
  replyRow.focus();
  key(h, replyRow, 'Escape');
  assert.equal(picker(h), null, 'Esc on the row closes the picker too');
  await flush();
  assert.ok(threadOf(h), 'still not the thread');

  const edit = await open({ messages: [message(1, { author: { kind: 'member', member_id: DOT } }), message(2)] });
  t.after(edit.h.restore);
  const own = rowOf(edit.h, 1);
  own.focus();
  key(edit.h, own, 'e');
  assert.ok(own.querySelector('.team-edit__input'), 'the edit is open');
  rowOf(edit.h, 2).querySelector('[data-team-msg-action="react-pick"]').click();
  assert.ok(picker(edit.h));
  key(edit.h, picker(edit.h).querySelector('.team-emoji__btn'), 'Escape');
  assert.equal(picker(edit.h), null);
  assert.ok(rowOf(edit.h, 1).querySelector('.team-edit__input'), 'the edit stays open');
});

test('after the frame is disposed there is no popover node and no pointerdown listener left on the document', async (t) => {
  const { h } = await open();
  t.after(h.restore);
  const doc = h.window.document;
  const added = [];
  const removed = [];
  const add = doc.addEventListener;
  const remove = doc.removeEventListener;
  doc.addEventListener = function (type, fn, ...rest) { if (type === 'pointerdown') added.push(fn); return add.call(this, type, fn, ...rest); };
  doc.removeEventListener = function (type, fn, ...rest) { if (type === 'pointerdown') removed.push(fn); return remove.call(this, type, fn, ...rest); };
  t.after(() => { doc.addEventListener = add; doc.removeEventListener = remove; });
  rowOf(h, 1).querySelector('.team-react--add').click();
  assert.ok(picker(h));
  assert.equal(added.length, 1, 'one document listener while open');
  h.tab.hideTeamTab();
  assert.equal(doc.querySelector('.team-pop'), null, 'no popover node');
  assert.equal(added.filter((fn) => !removed.includes(fn)).length, 0, 'every pointerdown listener added was removed');
});

test('a refusal\'s words from the host are text: no markup comes out of a failed reaction or pin', async (t) => {
  const evil = { code: '<img src=x onerror=alert(1)>', reason: '<b>boom</b>' };
  const { h } = await open({ answers: { chatReact: { ok: false, error: evil }, chatPin: { ok: false, error: evil } } });
  t.after(h.restore);
  chips(rowOf(h, 1))[0].click();
  await flush();
  clickMore(h, rowOf(h, 1));
  menuItem(h, 'Pin').click();
  await flush();
  assert.equal(rowOf(h, 1).querySelector('.team-failed img, .team-failed b'), null);
  assert.ok(rowOf(h, 1).querySelector('.team-failed'));
});

test('the picker\'s openers toggle it shut with a real mouse (pointerdown, then click), also after a redraw replaced the row\'s nodes', async (t) => {
  const { h } = await open();
  t.after(h.restore);
  const press = (el) => { el.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true })); el.click(); };
  const smiley = () => rowOf(h, 1).querySelector('[data-team-msg-action="react-pick"]');
  const addChip = () => rowOf(h, 1).querySelector('.team-react--add');
  const old = smiley();
  press(old);
  assert.ok(picker(h), 'the smiley opens it');
  push(h, [message(1, { rev: 7, reactions: { '👍': [DOT, ME], '👀': [ME] } })]);
  await flush();
  assert.notEqual(smiley(), old, 'the redraw replaced the smiley');
  assert.ok(picker(h), 'the picker survives the redraw');
  press(smiley());
  assert.equal(picker(h), null, 'a real press on the new smiley closes it, it does not open it again');
  press(addChip());
  assert.ok(picker(h));
  press(addChip());
  assert.equal(picker(h), null, 'the add chip toggles too');
  press(smiley());
  press(addChip());
  assert.equal(picker(h), null, 'the other opener of the same message closes it as well');
});
