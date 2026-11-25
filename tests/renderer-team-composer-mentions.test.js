'use strict';

// Team composer mentions (team review fixes, H21.3): typing `@` opens the list, it filters as you type and a pick replaces
// what was typed; inside a direct conversation it offers only that conversation's other people and no @channel.
// Real modules over the harness bridge. In these tests this member is Dot (memberTeam).
// new-test-file: a new surface (the typed trigger and the DM scope of the mention list); tests/renderer-team-composer.test.js is at its line cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dmChannelId } = require('../services/host/team-chat-schema');
const { OTHER, ME, DOT, MAYA, flush, memberTeam, harness, layout, chatChannel, chatMember, message, overview, key, type } = require('./helpers/team-settings-harness');

const LENA = 'member_lena';
const DM_TWO = dmChannelId([DOT, ME]);
const DM_THREE = dmChannelId([DOT, MAYA, LENA]);
const PEOPLE = [chatMember(ME, 'Olive Owner', { role: 'owner' }), chatMember(DOT, 'Dot'), chatMember(MAYA, 'Maya'), chatMember(LENA, 'Lena')];
const dmRow = (id, participants) => chatChannel({ channel_id: id, kind: 'dm', participants: [...participants].sort(), notify: 'all' });

async function open() {
  const h = harness({ show: false, teams: [memberTeam()], answers: {
    chatOverview: overview({ channels: [chatChannel(), dmRow(DM_TWO, [DOT, ME]), dmRow(DM_THREE, [DOT, MAYA, LENA])], members: PEOPLE }),
    chatHistory: { ok: true, messages: [message(1)], has_more: false },
  } });
  layout(h);
  h.cleanups.push(h.chat.use());
  h.showTab();
  await flush();
  return h;
}
const input = (h) => h.view.q('.team-composer__input');
const list = (h) => h.view.q('.team-menu--mention');
const names = (h) => [...list(h).querySelectorAll('[role="option"] .team-row__name')].map((el) => el.textContent);
async function show(h, id) { h.view.q(`[data-team-channel="${id}"]`).click(); await flush(); }

test('typing @ opens the list with the people and @channel, and it stays closed for any other text', async (t) => {
  const h = await open();
  t.after(h.restore);
  assert.equal(list(h).hidden, true);
  type(h, 'hello');
  assert.equal(list(h).hidden, true, 'plain text opens nothing');
  type(h, 'hello @');
  assert.equal(list(h).hidden, false);
  assert.deepEqual(names(h), ['Olive Owner', 'Maya', 'Lena', '@channel']);
  assert.equal(h.view.q('[data-team-composer="mention"]').getAttribute('aria-expanded'), 'true');
  assert.equal(h.window.document.activeElement, input(h), 'the text area keeps the focus');
  type(h, 'mail me at a@');
  assert.equal(list(h).hidden, true, 'an @ inside a word is not a mention');
});

test('the list filters as you type; a pick replaces the typed text; no match or a space closes it', async (t) => {
  const h = await open();
  t.after(h.restore);
  type(h, 'thanks @ma');
  assert.deepEqual(names(h), ['Maya']);
  type(h, 'thanks @L');
  assert.deepEqual(names(h), ['Lena'], 'the start of a name, any case');
  type(h, 'thanks @ch');
  assert.deepEqual(names(h), ['@channel']);
  type(h, 'thanks @zzz');
  assert.equal(list(h).hidden, true, 'nothing matches: nothing is offered');
  type(h, 'thanks @ma');
  key(h, input(h), 'Enter');
  assert.equal(input(h).value, 'thanks @Maya ', 'the typed @ma becomes the name');
  assert.equal(list(h).hidden, true);
  assert.equal(h.sent('chatPost').length, 0, 'Enter in the list picks, it does not send');
  type(h, input(h).value + 'ok');
  key(h, input(h), 'Enter');
  await flush();
  assert.equal(h.sent('chatPost')[0].payload.text, 'thanks <@member_maya> ok', 'the picked name is a mention token');
  type(h, 'a @Ma');
  assert.equal(list(h).hidden, false);
  type(h, 'a @Ma ');
  assert.equal(list(h).hidden, true, 'a space ends the mention');
  type(h, 'again @Ma');
  key(h, input(h), 'Escape');
  assert.equal(list(h).hidden, true, 'Esc closes it');
});

test('in a direct conversation the list offers only its other people and no @channel', async (t) => {
  const h = await open();
  t.after(h.restore);
  await show(h, DM_TWO);
  type(h, '@');
  assert.deepEqual(names(h), ['Olive Owner'], 'one other person');
  type(h, '@x');
  assert.equal(list(h).hidden, true);
  await show(h, DM_THREE);
  type(h, '@');
  assert.deepEqual(names(h), ['Maya', 'Lena'], 'the two others, never Dot or the rest of the team');
  assert.ok(!names(h).includes('@channel'), 'no @channel in a conversation');
  type(h, '@ol');
  assert.equal(list(h).hidden, true, 'someone outside the conversation is not offered');
  input(h).value = '';
  h.view.q('[data-team-composer="mention"]').click();
  assert.deepEqual(names(h), ['Maya', 'Lena'], 'the Mention button offers the same people');
});
