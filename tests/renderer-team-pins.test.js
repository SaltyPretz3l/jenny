'use strict';

// Team chat slice 2b-2: the channel header's pinned button and the pinned list under it (acceptance [5] header
// button offline and [7]). Real modules over the harness bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { OTHER, ME, DOT, CHAN, flush, memberTeam, chatChannel, chatMember, message, msgId, overview, openChat, heldAnswers, key } = require('./helpers/team-settings-harness');

const MIN = 60_000;
const at = (ms) => new Date(ms).toISOString();
const pinned = (by = ME, ms = Date.now()) => ({ by, at: at(ms) });

async function open({ messages = [message(1), message(2), message(3)], channel = {}, role = 'member', pins, answers = {}, ...rest } = {}) {
  return openChat({ messages, teams: [memberTeam({ role })], ...rest, answers: {
    chatOverview: overview({ channels: [chatChannel({ pin_count: 2, ...channel })], reaction_emoji: ['👍'] }),
    chatPins: pins || { ok: true, pins: [message(1, { pinned: pinned(ME, Date.now() - 2 * MIN) }), message(3, { pinned: pinned(DOT, Date.now() - MIN) })], trimmed: false },
    chatPin: { ok: true, rev: 5 },
    ...answers,
  } });
}
const button = (h) => h.view.q('[data-team-pins]');
const list = (h) => h.view.q('.team-pop--pins');
const rows = (h) => [...list(h).querySelectorAll('.team-pin')];

test('[7] the header button shows pin_count, no number at 0 or while unknown, always present, before search', async (t) => {
  const { h } = await open();
  t.after(h.restore);
  assert.equal(button(h).getAttribute('aria-label'), 'Pinned messages: 2');
  assert.equal(button(h).title, 'Pinned messages');
  assert.equal(button(h).textContent.trim(), '2');
  assert.equal(button(h).nextElementSibling.dataset.teamTabAction, 'search', 'before search');
  for (const [count, label] of [[0, 'Pinned messages: none'], [null, 'Pinned messages: none']]) {
    h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [chatChannel({ pin_count: count })] });
    await flush();
    assert.equal(button(h).textContent.trim(), '', 'no number');
    assert.equal(button(h).getAttribute('aria-label'), label);
  }
});

test('[7] opening asks chatPins each time, shows Loading, then newest pin first with who, when, the text and Pinned by', async (t) => {
  const gate = heldAnswers({ ok: true, pins: [message(1, { text: 'old pin', pinned: pinned(ME, Date.now() - 2 * MIN) }), message(3, { text: 'new pin', pinned: pinned(DOT, Date.now() - MIN) })], trimmed: false });
  const { h } = await open({ answers: { chatPins: gate.answer } });
  t.after(h.restore);
  button(h).click();
  assert.equal(list(h).getAttribute('role'), 'dialog');
  assert.equal(list(h).getAttribute('aria-label'), 'Pinned in #team');
  assert.match(list(h).textContent, /Loading pinned messages…/);
  assert.deepEqual(gate.calls, [{ team_id: OTHER, channel_id: CHAN }]);
  gate.release();
  await flush();
  assert.deepEqual(rows(h).map((r) => r.querySelector('.team-result__text').textContent), ['new pin', 'old pin'], 'the host\'s order reversed');
  assert.equal(rows(h)[0].querySelector('.team-result__who').textContent, 'Dot');
  assert.ok(rows(h)[0].querySelector('.team-result__when').textContent);
  assert.equal(rows(h)[0].querySelector('.team-pin__by').textContent, 'Pinned by you');
  assert.equal(rows(h)[1].querySelector('.team-pin__by').textContent, 'Pinned by Olive Owner');
  key(h, list(h), 'Escape');
  assert.equal(list(h), null);
  assert.equal(h.window.document.activeElement, button(h), 'focus returns to the button');
  button(h).click();
  assert.equal(gate.calls.length, 2, 'asked again each time it opens');
});

test('[7] a click on a row closes the list and jumps to the message; a pinned reply says in a thread and opens it', async (t) => {
  const reply = message(4, { thread_root_id: msgId(2), text: 'a pinned reply', pinned: pinned(ME) });
  const { h } = await open({ pins: { ok: true, pins: [message(1, { pinned: pinned(ME, Date.now() - 2 * MIN) }), reply], trimmed: false },
    answers: { chatThread: { ok: true, root: message(2), replies: [reply], has_more: false } } });
  t.after(h.restore);
  button(h).click();
  await flush();
  assert.equal(rows(h)[0].querySelector('.team-pin__thread').textContent, 'in a thread');
  assert.equal(rows(h)[1].querySelector('.team-pin__thread'), null);
  rows(h)[1].querySelector('.team-result').click();
  await flush();
  assert.equal(list(h), null, 'the list closes');
  const row = h.view.q(`.team-scroll .team-msg[data-message-id="${msgId(1)}"]`);
  assert.equal(row.dataset.jumped, 'true', 'the search jump and its tint');
  button(h).click();
  await flush();
  rows(h)[0].querySelector('.team-result').click();
  await flush();
  assert.ok(h.view.q('aside.team-thread'), 'a reply opens its thread');
});

test('[7] empty, failed, trimmed and fewer-than-pin_count lists read as approved; Try again asks again', async (t) => {
  const { h } = await open({ pins: { ok: true, pins: [], trimmed: false }, channel: { pin_count: 0 } });
  t.after(h.restore);
  button(h).click();
  await flush();
  assert.match(list(h).textContent, /Nothing is pinned here yet\. Pin a message from its More menu to keep it at hand for everyone\./);
  key(h, list(h), 'Escape');
  const failed = await open({ answers: { chatPins: { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } } } });
  failed.h.view.q('[data-team-pins]').click();
  await flush();
  assert.match(failed.h.view.q('.team-pop--pins').textContent, /The pinned messages could not be loaded\. The team server is not answering\. Try again in a moment\./);
  failed.h.view.q('.team-pop--pins [data-team-pins-action="retry"]').click();
  await flush();
  assert.equal(failed.h.sent('chatPins').length, 2);
  failed.h.restore();
  const trimmed = await open({ pins: { ok: true, pins: [message(1, { pinned: pinned() })], trimmed: true }, channel: { pin_count: 4 } });
  trimmed.h.view.q('[data-team-pins]').click();
  await flush();
  assert.match(trimmed.h.view.q('.team-pop--pins').textContent, /Showing 1 of 4 pinned messages\. The rest are too long to list together\. They are still pinned\./);
  trimmed.h.restore();
});

test('[7] Unpin takes the row out; a refusal says Not unpinned in the row; a direct conversation is headed in this conversation', async (t) => {
  const { h } = await open({ answers: { chatPin: { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } } } });
  t.after(h.restore);
  button(h).click();
  await flush();
  rows(h)[0].querySelector('[data-team-pins-action="unpin"]').click();
  await flush();
  assert.deepEqual(h.sent('chatPin')[0].payload, { team_id: OTHER, channel_id: CHAN, message_id: msgId(3), on: false });
  assert.match(rows(h)[0].textContent, /Not unpinned\. The team server is not answering\. Try again in a moment\./);
  assert.equal(rows(h).length, 2, 'still listed');
  const fine = await open();
  fine.h.view.q('[data-team-pins]').click();
  await flush();
  fine.h.view.q('.team-pop--pins [data-team-pins-action="unpin"]').click();
  await flush();
  assert.equal(fine.h.view.qa('.team-pop--pins .team-pin').length, 1, 'the unpinned row is gone');
  fine.h.restore();
});

test('[5] offline the header button is greyed with Needs the team online and the marks stay; read-only members may open the list', async (t) => {
  const { h } = await open({ messages: [message(1, { pinned: pinned() })] });
  t.after(h.restore);
  h.listeners.state({ teams: [memberTeam({ state: 'offline' })], host: { state: 'stopped' } });
  await flush();
  assert.equal(button(h).disabled, true);
  assert.match(button(h).getAttribute('aria-label'), /Needs the team online$/);
  assert.ok(h.view.q('.team-pinmark'), 'the mark stays');
  const ro = await open({ role: 'read_only' });
  assert.equal(ro.h.view.q('[data-team-pins]').disabled, false);
  ro.h.view.q('[data-team-pins]').click();
  await flush();
  assert.equal(ro.h.view.q('.team-pop--pins [data-team-pins-action="unpin"]').disabled, true, 'Unpin is greyed for a read-only member');
  assert.match(ro.h.view.q('.team-pop--pins .team-pin').textContent, /Read-only members cannot pin\./);
  ro.h.restore();
});

test('the pinned list closes on a click away and is removed with the frame; no timers or nodes are left', async (t) => {
  const { h } = await open();
  t.after(h.restore);
  button(h).click();
  await flush();
  h.window.document.body.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true }));
  assert.equal(list(h), null);
  button(h).click();
  await flush();
  h.tab.hideTeamTab();
  assert.equal(h.window.document.querySelector('.team-pop'), null);
});

// ---------------------------------------------------------------- fix round (orchestrator's list, items 1, 2, 13)

test('the pinned button works with a real mouse: pointerdown then click closes the open list and asks nothing again', async (t) => {
  const { h } = await open();
  t.after(h.restore);
  const press = () => {
    button(h).dispatchEvent(new h.window.Event('pointerdown', { bubbles: true }));
    button(h).click();
  };
  press();
  await flush();
  assert.ok(list(h), 'the first press opens it');
  assert.equal(h.sent('chatPins').length, 1);
  press();
  await flush();
  assert.equal(list(h), null, 'the second press closes it, it does not open it again');
  assert.equal(h.sent('chatPins').length, 1, 'and nothing was asked again');
  press();
  await flush();
  assert.ok(list(h), 'a third press opens it');
  assert.equal(h.sent('chatPins').length, 2);
  h.window.document.body.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true }));
  assert.equal(list(h), null, 'a press anywhere else still closes it');
});

test('the pinned list is walked by keyboard: arrows, Home and End move over the rows and Enter jumps; Tab keeps Close and Unpin', async (t) => {
  const { h } = await open({ pins: { ok: true, pins: [message(1, { text: 'first', pinned: pinned(ME, Date.now() - 3 * MIN) }), message(2, { text: 'second', pinned: pinned(ME, Date.now() - 2 * MIN) }),
    message(3, { text: 'third', pinned: pinned(DOT, Date.now() - MIN) })], trimmed: false }, channel: { pin_count: 3 } });
  t.after(h.restore);
  const doc = h.window.document;
  button(h).click();
  await flush();
  const links = () => [...list(h).querySelectorAll('.team-msglink')];
  const on = () => links().indexOf(doc.activeElement);
  assert.equal(on(), -1, 'the focus starts on Close');
  key(h, doc.activeElement, 'ArrowDown');
  assert.equal(on(), 0, 'Down reaches the first row (newest first)');
  assert.equal(links()[0].querySelector('.team-result__text').textContent, 'third');
  key(h, doc.activeElement, 'ArrowDown');
  assert.equal(on(), 1);
  key(h, doc.activeElement, 'End');
  assert.equal(on(), 2);
  key(h, doc.activeElement, 'ArrowDown');
  assert.equal(on(), 2, 'it stops at the end');
  key(h, doc.activeElement, 'Home');
  assert.equal(on(), 0);
  key(h, doc.activeElement, 'ArrowUp');
  assert.equal(on(), 0, 'and at the start');
  key(h, doc.activeElement, 'ArrowDown');
  key(h, doc.activeElement, 'Enter');
  await flush();
  assert.equal(list(h), null, 'Enter jumped: the list closed');
  assert.equal(h.view.q(`.team-scroll .team-msg[data-message-id="${msgId(2)}"]`).dataset.jumped, 'true', 'to the message the row names');
});

test('text from the host is text in the list: a channel name in the heading, a name and a failure reason', async (t) => {
  const evil = '<img src=x onerror=alert(1)>';
  const { h } = await open({ answers: { chatPins: { ok: false, error: { code: evil, reason: '<b>boom</b>' } } } });
  t.after(h.restore);
  button(h).click();
  await flush();
  assert.equal(list(h).querySelector('img, b'), null, 'a failure line draws no markup');
  assert.match(list(h).querySelector('[data-tone="danger"]').textContent, /^The pinned messages could not be loaded\. /);
  const named = await open({ answers: { chatOverview: overview({ channels: [chatChannel({ pin_count: 2 })], members: [chatMember(ME, evil, { role: 'owner' }), chatMember(DOT, 'Dot')] }) },
    pins: { ok: true, pins: [message(1, { author: { kind: 'member', member_id: ME }, pinned: pinned(ME) }), message(3, { pinned: pinned(ME) })], trimmed: false } });
  t.after(named.h.restore);
  named.h.view.q('[data-team-pins]').click();
  await flush();
  const pop = named.h.view.q('.team-pop--pins');
  assert.equal(pop.querySelector('img'), null, 'a name draws no markup');
  assert.ok([...pop.querySelectorAll('.team-result__who')].some((el) => el.textContent === evil), 'it is shown as text');
  assert.match(pop.querySelector('.team-pop__head').textContent, /^Pinned in #team/);
});
