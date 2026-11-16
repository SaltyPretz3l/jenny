'use strict';

// Direct messages between team members (row 123, slice 2d renderer; TEAM_CHAT_SPEC "2d renderer as built").
//
// Member side, through the real desktop client against the real host composition (tests/helpers/team-client-host.js
// with the real host chat dispatcher, tests/helpers/team-chat-hook.js): chatDmOpen opens a conversation and answers
// once the cached row with its `participants` is there; a post in it reaches the other participant and nobody else;
// the host's refusal reaches the renderer as its own sentence.

const assert = require('node:assert/strict');
const test = require('node:test');

const strings = require('../renderer/shell/renderer-settings-team-strings');
const { attachTeamChat, commandAs } = require('./helpers/team-chat-hook');
const { createTeamClientHost, joinAs, waitUntil } = require('./helpers/team-client-host');

const DM_ID = /^chan_dm_[a-f0-9]{64}$/u;

// A member online on a host with the owner and a third member, Pat, both active.
async function memberWithPeers(t) {
  const host = await createTeamClientHost(t);
  const chat = await attachTeamChat(t, host);
  const owner = await host.ownerDirect();
  const pushes = [];
  const service = host.createService({ sendChat: (payload) => pushes.push(JSON.parse(JSON.stringify(payload))) });
  const me = await joinAs(host, service, { owner });
  const pat = await host.env.redeemDirect({ actor: owner.member_id, name: 'Pat Peer' });
  assert.equal((await host.env.store.admit({ actorMemberId: owner.member_id, memberId: pat.member_id })).ok, true);
  await host.waitForState(me.teamId, 'online');
  const call = (method, payload = {}) => service.handle(method, { team_id: me.teamId, ...payload });
  assert.equal((await call('chatOverview')).ok, true);
  return { host, chat, owner, pat, me, service, call, pushes };
}

test('member side: chatDmOpen answers the id once the row with its participants is cached, and again for the same people', async (t) => {
  const s = await memberWithPeers(t);
  const opened = await s.call('chatDmOpen', { member_ids: [s.owner.member_id] });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.match(opened.channel_id, DM_ID);
  assert.deepEqual(Object.keys(opened).sort(), ['channel_id', 'ok']);
  const row = (await s.call('chatOverview')).channels.find((c) => c.channel_id === opened.channel_id);
  assert.ok(row, 'the overview lists the new conversation at once');
  assert.equal(row.kind, 'dm');
  assert.deepEqual(row.participants, [s.me.member_id, s.owner.member_id].sort());
  assert.ok(s.pushes.some((push) => push.type === 'channels' && push.channels.some((c) => c.channel_id === opened.channel_id
    && Array.isArray(c.participants))), 'the renderer heard of the row with its participants');
  const team = (await s.call('chatOverview')).channels.find((c) => c.channel_id === 'chan_team');
  assert.equal(Object.hasOwn(team, 'participants'), false, 'the team channel carries none');
  const again = await s.call('chatDmOpen', { member_ids: [s.owner.member_id] });
  assert.deepEqual(again, opened, 'the same people open the same conversation');
});

test('member side: a post in a conversation reaches the other participant and nobody else', async (t) => {
  const s = await memberWithPeers(t);
  const { channel_id: dm } = await s.call('chatDmOpen', { member_ids: [s.owner.member_id] });
  assert.equal((await s.call('chatHistory', { channel_id: dm })).ok, true);
  // The owner writes to this member: the message arrives on the push channel.
  assert.equal((await commandAs(s.host, s.owner, 'team.chat.post', { channel_id: dm, text: 'just us two' })).ok, true);
  assert.ok(await waitUntil(() => s.pushes.some((push) => push.type === 'messages' && push.channel_id === dm
    && push.messages.some((m) => m.text === 'just us two'))), 'the other participant hears the post');
  // This member writes back; the owner reads it, Pat cannot.
  assert.equal((await s.call('chatPost', { channel_id: dm, text: 'reply in private' })).ok, true);
  assert.ok(await waitUntil(async () => {
    const page = await commandAs(s.host, s.owner, 'team.chat.history', { channel_id: dm, limit: 10 });
    return page.ok && page.messages.some((m) => m.text === 'reply in private');
  }), 'the post reached the host and the other participant');
  // (Pat's own read is refused by the host's router, which `commandAs` does not pass: tests/server/team-chat-dm.test.js.)
  // A conversation between the owner and Pat: nothing of it reaches this member.
  const theirs = await commandAs(s.host, s.owner, 'team.chat.dm_open', { member_ids: [s.pat.member_id] });
  assert.equal(theirs.ok, true);
  assert.equal((await commandAs(s.host, s.owner, 'team.chat.post', { channel_id: theirs.channel_id, text: 'not for Mika' })).ok, true);
  assert.equal((await commandAs(s.host, s.owner, 'team.chat.post', { channel_id: 'chan_team', text: 'marker' })).ok, true);
  assert.equal((await s.call('chatHistory', { channel_id: 'chan_team' })).ok, true);
  assert.ok(await waitUntil(() => s.pushes.some((push) => push.type === 'messages' && push.messages.some((m) => m.text === 'marker'))));
  const seen = JSON.stringify(s.pushes) + JSON.stringify(await s.call('chatOverview'));
  assert.equal(seen.includes(theirs.channel_id), false, 'their conversation is not listed or pushed');
  assert.equal(seen.includes('not for Mika'), false);
  // The positive beside it: a conversation the owner opens with this member and Pat is announced to this member,
  // who lists it without asking.
  const ours = await commandAs(s.host, s.owner, 'team.chat.dm_open', { member_ids: [s.me.member_id, s.pat.member_id] });
  assert.equal(ours.ok, true);
  assert.ok(await waitUntil(async () => {
    const view = await s.call('chatOverview');
    return view.ok && JSON.stringify(view).includes(ours.channel_id);
  }), 'the created announcement reaches a participant');
  const after = JSON.stringify(s.pushes) + JSON.stringify(await s.call('chatOverview'));
  assert.equal(after.includes(theirs.channel_id), false, 'still nothing of their conversation');
});

test('member side: the host refusal reaches the renderer as its sentence, never as a raw reason', async (t) => {
  const s = await memberWithPeers(t);
  const refused = await s.call('chatDmOpen', { member_ids: [s.me.member_id] });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.error, { code: 'CMP-TEAM-0009', reason: 'team_chat_dm_members_invalid' });
  const sentence = strings.errorText(refused.error);
  assert.equal(sentence, 'Someone you picked is no longer on the team. Pick again.');
  const offline = await s.call('chatDmOpen', { member_ids: ['member_nobodyHere01'] });
  assert.equal(offline.error.reason, 'team_chat_dm_members_invalid', 'an unknown id is the same refusal');
  assert.equal(JSON.stringify(s.pushes).includes('chan_dm_'), false, 'a refused open lists nothing');
});

// ---------------------------------------------------------------- renderer
//
// Through the real tab, view, channels module, picker, timeline, composer, search, team store, chat store and
// inventory over the harness bridge (tests/helpers/team-settings-harness.js). This member is Dot (memberTeam).

const { dmChannelId } = require('../services/host/team-chat-schema');
const {
  OTHER, ME, DOT, MAYA, CHAN, flush, memberTeam, harness, layout, shell, chatChannel, chatMember, message, overview, key, msgId, searchField,
} = require('./helpers/team-settings-harness');

const LENA = 'member_lena';
const DM_TWO = dmChannelId([DOT, ME]);
const DM_THREE = dmChannelId([DOT, MAYA, LENA]);
const PEOPLE = [chatMember(ME, 'Olive Owner', { role: 'owner' }), chatMember(DOT, 'Dot'), chatMember(MAYA, 'Maya', { state: 'away' }),
  chatMember(LENA, 'Lena', { state: 'offline', last_seen_at: '2026-11-11T07:00:00.000Z' })];
const dmRow = (id, participants, over = {}) => chatChannel({ channel_id: id, kind: 'dm', participants: [...participants].sort(), ...over });
const TWO = dmRow(DM_TWO, [DOT, ME], { unread: 2, last_seq: 2 });
const THREE = dmRow(DM_THREE, [DOT, MAYA, LENA]);
const STANDING = 'The team’s host can read direct messages.';
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function openDm({ channels = [chatChannel(), TWO, THREE], teams = [memberTeam()], answers = {} } = {}) {
  const h = harness({ show: false, teams, answers: {
    chatOverview: overview({ channels, members: PEOPLE }),
    chatHistory: (p) => ({ ok: true, messages: p.channel_id === CHAN ? [message(1)] : [message(1, { channel_id: p.channel_id, text: 'private hello' })], has_more: false }),
    chatSearch: { ok: true, matches: [], next_cursor: null },
    ...answers,
  } });
  layout(h);
  h.cleanups.push(h.chat.use());
  h.showTab();
  await flush();
  return h;
}
const dmRows = (h) => h.view.qa('.team-dm-row');
const rowFor = (h, id) => h.view.q(`[data-team-channel="${id}"]`);
const headName = (h) => h.view.q('[data-team-region="head"] .team-head__name');
const standing = (h) => h.view.q('[data-team-region="head"] [data-standing="true"]');
async function show(h, id) { rowFor(h, id).click(); await flush(); }
async function search(h, text) {
  const field = searchField(h);
  field.value = text;
  field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  await wait(350);
  await flush();
  return field;
}

test('the list: a two-person and a three-person conversation with names, count and presence, never this member', async (t) => {
  const h = await openDm();
  t.after(h.restore);
  const label = h.view.q('[data-team-directs] .team-panel__label');
  assert.equal(label.querySelector('span').textContent, 'Direct messages');
  assert.equal(label.querySelector('[data-team-tab-action="dm-new"]').getAttribute('title'), 'New message');
  const rows = dmRows(h);
  assert.deepEqual(rows.map((r) => r.querySelector('.team-row__name').textContent), ['Lena, Maya', 'Olive Owner'], 'names in order, never Dot');
  assert.equal(rows[0].querySelector('.team-row__glyph').textContent, '3', 'several people show their number');
  assert.equal(rows[0].querySelector('.team-dot'), null);
  assert.equal(rows[1].querySelector('.team-dot').dataset.p, 'online', 'one person shows a presence dot');
  assert.equal(rows[1].querySelector('.team-count').textContent, '2');
  assert.equal(rows[1].getAttribute('aria-label'), 'Olive Owner, 2 unread');
  assert.deepEqual(rows.map((r) => r.getAttribute('aria-current')), ['false', 'false']);
  // Column order: Channels, Direct messages, then the people.
  const order = [...h.view.q('[data-team-region="lists"]').children].map((el) => el.className.split(' ')[0]);
  assert.deepEqual(order, ['team-channels', 'team-directs', 'team-people']);
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [{ ...TWO, unread: 150, unread_capped: true }] });
  await flush();
  assert.equal(rowFor(h, DM_TWO).querySelector('.team-count').textContent, '99+');
});

test('selecting a conversation scopes the timeline, composer, typing line and search to it; #team again restores it', async (t) => {
  const h = await openDm();
  t.after(h.restore);
  await show(h, DM_TWO);
  assert.equal(rowFor(h, DM_TWO).getAttribute('aria-current'), 'true');
  assert.equal(rowFor(h, CHAN).getAttribute('aria-current'), 'false');
  assert.ok(h.sent('chatHistory').some((c) => c.payload.channel_id === DM_TWO), 'the timeline opened the conversation');
  assert.match(h.view.q('[data-team-region="timeline"]').textContent, /private hello/u);
  assert.equal(headName(h).textContent, 'Olive Owner');
  assert.equal(headName(h).getAttribute('title'), 'Olive Owner');
  assert.equal(h.view.q('[data-team-region="head"] .team-dot').getAttribute('title'), 'online', 'the dot says the presence');
  assert.equal(standing(h).textContent, STANDING);
  assert.equal(h.view.q('.team-composer__input').getAttribute('placeholder'), 'Message Olive Owner');
  h.listeners.chat({ team_id: OTHER, type: 'typing', channel_id: DM_TWO, thread_root_id: null, member_id: ME });
  await flush();
  assert.match(h.view.q('.team-typing').textContent, /Olive Owner/u);
  const field = await search(h, 'hello');
  assert.equal(h.sent('chatSearch').at(-1).payload.channel_id, DM_TWO, 'search is scoped to the conversation');
  key(h, field, 'Escape');
  await flush();
  // A three-person conversation: no dot, the names, the same standing line.
  await show(h, DM_THREE);
  assert.equal(headName(h).textContent, 'Lena, Maya');
  assert.equal(h.view.q('[data-team-region="head"] .team-dot'), null);
  assert.equal(standing(h).textContent, STANDING);
  await show(h, CHAN);
  assert.equal(headName(h).textContent, '#team');
  assert.equal(standing(h), null, 'no standing line in #team');
  assert.equal(h.view.q('.team-composer__input').getAttribute('placeholder'), 'Message #team');
  await search(h, 'again');
  assert.equal(Object.hasOwn(h.sent('chatSearch').at(-1).payload, 'channel_id'), false, '#team searches as before');
});

test('a conversation that leaves the overview falls back to #team', async (t) => {
  const h = await openDm();
  t.after(h.restore);
  await show(h, DM_TWO);
  assert.equal(headName(h).textContent, 'Olive Owner');
  h.listeners.chat({ team_id: OTHER, type: 'channels', channels: [chatChannel(), THREE] });
  await flush();
  assert.equal(headName(h).textContent, '#team');
  assert.equal(rowFor(h, CHAN).getAttribute('aria-current'), 'true');
  assert.equal(rowFor(h, DM_TWO), null);
});

test('the standing line is in every direct conversation and nowhere in #team', async (t) => {
  const h = await openDm();
  t.after(h.restore);
  assert.equal(standing(h), null);
  assert.equal(h.view.text().includes(STANDING), false);
  for (const id of [DM_TWO, DM_THREE]) {
    await show(h, id);
    assert.equal(standing(h).textContent, STANDING, id);
  }
});

test('the tab number: an unread conversation raises it by one, muting lowers it, an @-mention still counts', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()], answers: { chatOverview: overview({ members: PEOPLE,
    channels: [chatChannel({ mention: true, unread: 1 }), TWO, THREE] }) } });
  t.after(h.restore);
  const s = shell(h);
  await flush();
  assert.equal(s.count(), '2');
  assert.equal(s.teamTab().getAttribute('aria-label'), 'Team: 1 channel mentions you, 1 unread conversation');
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [{ ...TWO, notify: 'none' }] });
  await flush();
  assert.equal(s.count(), '1', 'a muted conversation does not count');
  assert.equal(s.teamTab().getAttribute('aria-label'), 'Team: 1 channel mentions you');
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [chatChannel({ mention: false }), { ...THREE, unread: 4 }] });
  await flush();
  assert.equal(s.count(), '1');
  assert.equal(s.teamTab().getAttribute('aria-label'), 'Team: 1 unread conversation');
});

test('a read-only member sees no control that starts a conversation', async (t) => {
  const h = await openDm({ teams: [memberTeam({ role: 'read_only' })] });
  assert.equal(h.view.q('[data-team-tab-action="dm-new"]'), null);
  assert.equal(dmRows(h).length, 2, 'the conversations they are in are still listed');
  h.restore();
  const none = await openDm({ teams: [memberTeam({ role: 'read_only' })], channels: [chatChannel()] });
  t.after(none.restore);
  assert.equal(none.view.q('[data-team-directs]'), null, 'with none, no Direct messages at all');
  assert.equal(none.view.q('[data-team-tab-action="dm-new"]'), null);
});

test('no Copy link in a direct conversation; a reference to one renders as text', async (t) => {
  const ref = (channel) => `jenny-team:${OTHER}/${channel}/1/${msgId(1)}`;
  const h = await openDm({ answers: { chatHistory: (p) => ({ ok: true, has_more: false,
    messages: [message(1, { channel_id: p.channel_id, text: `see ${ref(DM_TWO)} and ${ref(CHAN)}` })] }) } });
  t.after(h.restore);
  const timeline = () => h.view.q('[data-team-region="timeline"]');
  assert.ok(timeline().querySelector('[data-team-msg-action="copy-link"]'), '#team offers Copy link');
  const chips = [...timeline().querySelectorAll('.team-msglink')].map((chip) => chip.dataset.linkChannel);
  assert.deepEqual(chips, [CHAN], 'only the #team reference is a chip');
  assert.ok(timeline().textContent.includes(ref(DM_TWO)), 'the conversation reference stays as text');
  await show(h, DM_TWO);
  assert.equal(timeline().querySelector('[data-team-msg-action="copy-link"]'), null, 'no Copy link in a conversation');
  key(h, timeline().querySelector('.team-msg'), 'l');
  await flush();
  assert.deepEqual(h.copied, [], 'L copies nothing there');
});

test('New message: the picker lists the others, filters, picks, says when the conversation exists and opens it', async (t) => {
  const h = await openDm({ answers: { chatDmOpen: (p) => ({ ok: true, channel_id: dmChannelId([DOT, ...p.member_ids]) }) } });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="dm-new"]').click();
  await flush();
  assert.equal(headName(h).textContent, 'New message');
  assert.equal(h.view.q('[data-team-region="timeline"]'), null, 'it takes the timeline and composer place');
  const field = h.view.q('.team-to__field .inv-text-field-control');
  assert.equal(h.window.document.activeElement, field);
  const names = () => h.view.qa('.team-pick__row .team-row__name').map((el) => el.textContent);
  assert.deepEqual(names(), ['Lena', 'Maya', 'Olive Owner'], 'every other member, never Dot');
  assert.deepEqual(h.view.qa('.team-pick__row .team-row__meta').map((el) => el.textContent.length > 0), [true, true, false], 'a fact for anyone not online');
  const hint = () => h.view.q('.team-pick__hint').textContent;
  const startButton = () => h.view.q('[data-dm="start"]');
  assert.equal(hint(), 'Pick one person or several.');
  assert.equal(startButton().disabled, true);
  field.value = 'ol';
  field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.deepEqual(names(), ['Olive Owner']);
  key(h, field, 'Enter');
  assert.deepEqual(h.view.qa('.team-to__chip > span').map((el) => el.textContent), ['Olive Owner'], 'Enter picks the first match');
  assert.equal(hint(), 'You already have this conversation. Start opens it.');
  h.view.q('[data-dm-pick="member_maya"]').click();
  assert.equal(hint(), STANDING);
  key(h, field, 'Backspace');
  assert.equal(h.view.qa('.team-to__chip').length, 1, 'Backspace in the empty field removes the last chip');
  assert.equal(startButton().disabled, false);
  key(h, field, 'Enter');
  await flush();
  assert.deepEqual(h.sent('chatDmOpen').map((c) => c.payload), [{ team_id: OTHER, member_ids: [ME] }]);
  assert.equal(headName(h).textContent, 'Olive Owner', 'the existing conversation is shown');
  assert.equal(rowFor(h, DM_TWO).getAttribute('aria-current'), 'true');
});

test('New message: a refusal shows its sentence and keeps the picks; Esc closes back to the channel shown', async (t) => {
  const h = await openDm({ answers: { chatDmOpen: { ok: false, error: { code: 'CMP-TEAM-0009', reason: 'team_chat_dm_members_invalid' } } } });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="dm-new"]').click();
  await flush();
  h.view.q('[data-dm-pick="member_lena"]').click();
  h.view.q('[data-dm="start"]').click();
  await flush();
  assert.equal(h.view.q('.team-pick__error').textContent, 'Someone you picked is no longer on the team. Pick again.');
  assert.equal(h.view.qa('.team-to__chip').length, 1, 'the picks stay');
  key(h, h.view.q('.team-to__field .inv-text-field-control'), 'Escape');
  await flush();
  assert.equal(headName(h).textContent, '#team');
  assert.equal(h.view.q('[data-team-region="picker"]'), null);
});

test('New message: a new conversation is shown with its names before its row arrives, and stays when it does', async (t) => {
  const fresh = dmChannelId([DOT, LENA]);
  const h = await openDm({ answers: { chatDmOpen: { ok: true, channel_id: fresh } } });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="dm-new"]').click();
  await flush();
  h.view.q('[data-dm-pick="member_lena"]').click();
  h.view.q('[data-dm="start"]').click();
  await flush();
  assert.equal(headName(h).textContent, 'Lena');
  assert.equal(standing(h).textContent, STANDING);
  assert.equal(h.window.document.activeElement, h.view.q('.team-composer__input'), 'the composer has the focus');
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [dmRow(fresh, [DOT, LENA])] });
  await flush();
  assert.equal(headName(h).textContent, 'Lena');
  assert.equal(rowFor(h, fresh).getAttribute('aria-current'), 'true');
});

test('Alt+Up and Alt+Down move through channel rows and conversation rows as one list', async (t) => {
  const h = await openDm();
  t.after(h.restore);
  rowFor(h, CHAN).focus();
  key(h, rowFor(h, CHAN), 'ArrowDown', { altKey: true });
  assert.equal(h.window.document.activeElement, rowFor(h, DM_THREE));
  key(h, rowFor(h, DM_THREE), 'ArrowDown', { altKey: true });
  assert.equal(h.window.document.activeElement, rowFor(h, DM_TWO));
  key(h, rowFor(h, DM_TWO), 'ArrowUp', { altKey: true });
  assert.equal(h.window.document.activeElement, rowFor(h, DM_THREE));
});

// ---------------------------------------------------------------- review fixes (fix list 2d renderer)

const fs = require('node:fs');
const path = require('node:path');
const { heldAnswers, chatPush } = require('./helpers/team-settings-harness');

const ALPHA = 'team_AlphaAAAAAAAAAAAAAA';
const toField = (h) => h.view.q('.team-to__field .inv-text-field-control');
const active = (h) => h.window.document.activeElement;
async function openNew(h) { h.view.q('[data-team-tab-action="dm-new"]').click(); await flush(); }
async function switchTo(h, name) {
  h.view.q('[data-team-tab-action="switch"]').click();
  const rowsOf = [...h.window.document.querySelectorAll('.inv-context-menu.team-switch-menu [role="menuitemradio"]')];
  rowsOf.find((row) => row.textContent.includes(name)).click();
  await flush();
}
function typeTo(h, text) {
  toField(h).value = text;
  toField(h).dispatchEvent(new h.window.Event('input', { bubbles: true }));
}

test('fix 1: the standing line never shrinks (the names give way) and takes its own row under 720 px', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'team-chat.css'), 'utf8');
  const narrowAt = css.indexOf('@container teamview (max-width: 720px)');
  assert.ok(narrowAt > 0);
  const wide = css.slice(0, narrowAt);
  const narrow = css.slice(narrowAt);
  assert.match(wide, /\.team-head__name\[title\] \{ flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/u, 'the names truncate');
  assert.match(wide, /\.team-head__sub\[data-standing="true"\] \{ flex: 0 0 auto; min-width: max-content; overflow: visible; \}/u,
    'the line keeps its whole sentence: no shrink, its own width as the floor');
  assert.match(narrow, /\.team-head:has\(> \.team-head__sub\[data-standing="true"\]\) \{ flex-wrap: wrap;/u);
  assert.match(narrow, /\.team-head__sub\[data-standing="true"\] \{ display: inline; order: 1; flex-basis: 100%; min-width: 0; white-space: normal; \}/u,
    'under 720 px it is shown on a row of its own and wraps rather than cut');
});

test('fix 2: a redraw keeps the focused row and Start, the hint is one element, a refusal focuses Start', async (t) => {
  const h = await openDm({ answers: { chatDmOpen: { ok: false, error: { code: 'CMP-TEAM-0009', reason: 'team_chat_dm_members_invalid' } } } });
  t.after(h.restore);
  await openNew(h);
  const hint = h.view.q('.team-pick__hint');
  h.view.q('[data-dm-pick="member_maya"]').focus();
  chatPush(h, { type: 'presence', member_id: LENA, state: 'online', last_seen_at: null });
  await flush();
  assert.equal(active(h).dataset.dmPick, 'member_maya', 'the same person row keeps the focus');
  h.view.q('[data-dm-pick="member_lena"]').click();
  const start = h.view.q('[data-dm="start"]');
  start.focus();
  chatPush(h, { type: 'presence', member_id: MAYA, state: 'online', last_seen_at: null });
  await flush();
  assert.equal(active(h), start, 'Start keeps the focus across a redraw');
  assert.equal(h.view.q('.team-pick__hint'), hint, 'the live hint persists; only its text changes');
  start.click();
  await flush();
  assert.equal(h.view.q('.team-pick__error').textContent, 'Someone you picked is no longer on the team. Pick again.');
  assert.equal(active(h), h.view.q('[data-dm="start"]'), 'after a refused Start the focus is back on Start');
});

test('fix 3: a late answer after Esc changes nothing; after a team switch the first team is left on its channel', async (t) => {
  const gate = heldAnswers({ ok: true, channel_id: dmChannelId([DOT, LENA]) });
  const h = await openDm({ teams: [memberTeam(), memberTeam({ team_id: ALPHA, team_name: 'Alpha' })], answers: { chatDmOpen: gate.answer } });
  t.after(h.restore);
  const first = h.view.q('.team-panel__title').textContent;
  await openNew(h);
  h.view.q('[data-dm-pick="member_lena"]').click();
  h.view.q('[data-dm="start"]').click();
  key(h, toField(h), 'Escape');
  await flush();
  assert.equal(headName(h).textContent, '#team');
  gate.release();
  await flush();
  assert.equal(headName(h).textContent, '#team', 'a closed picker\'s answer does not pull the person in');
  // Start, then another team: the answer moves nothing, and the first team is back on its channel.
  await openNew(h);
  h.view.q('[data-dm-pick="member_lena"]').click();
  h.view.q('[data-dm="start"]').click();
  await switchTo(h, 'Alpha');
  gate.release();
  await flush();
  assert.equal(h.view.q('.team-panel__title').textContent, 'Alpha');
  assert.notEqual(headName(h).textContent, 'Lena');
  await switchTo(h, first);
  assert.equal(headName(h).textContent, '#team', 'the first team shows the channel shown before, not the New message view');
});

test('fix 4: a refused Start for the rate limit or the disk says a true sentence, no retry promised', async (t) => {
  for (const [reason, code, sentence] of [
    ['team_chat_rate_limit', 'CMP-TEAM-0007', 'Too many new conversations at once. Try again in a moment.'],
    ['disk_pressure', 'CMP-TEAM-0007', 'The team’s host is out of room. Try again later.'],
  ]) {
    const h = await openDm({ answers: { chatDmOpen: { ok: false, error: { code, reason } } } });
    await openNew(h);
    h.view.q('[data-dm-pick="member_lena"]').click();
    h.view.q('[data-dm="start"]').click();
    await flush();
    assert.equal(h.view.q('.team-pick__error').textContent, sentence, reason);
    assert.equal(h.view.q('.team-pick__error').textContent.includes('Jenny will send'), false);
    h.restore();
  }
  t.diagnostic('two refusals checked');
});

test('fix 5: Enter only picks, does nothing inside an IME composition, and the cap says so', async (t) => {
  const many = Array.from({ length: 8 }, (_, i) => chatMember(`member_p${i}`, `Pat ${i}`));
  const h = await openDm({ answers: { chatOverview: overview({ channels: [chatChannel()], members: [...PEOPLE, ...many] }) } });
  t.after(h.restore);
  await openNew(h);
  const chips = () => h.view.qa('.team-to__chip > span').map((el) => el.textContent);
  typeTo(h, 'lena');
  key(h, toField(h), 'Enter');
  assert.deepEqual(chips(), ['Lena']);
  typeTo(h, 'lena');
  key(h, toField(h), 'Enter');
  assert.deepEqual(chips(), ['Lena'], 'Enter on a match already picked keeps it picked');
  assert.equal(toField(h).value, '', 'and clears the field');
  typeTo(h, 'maya');
  const composing = key(h, toField(h), 'Enter', { isComposing: true });
  assert.deepEqual(chips(), ['Lena'], 'Enter while composing picks nothing');
  assert.equal(composing.defaultPrevented, false);
  typeTo(h, '');
  for (const i of [0, 1, 2, 3, 4, 5]) h.view.q(`[data-dm-pick="member_p${i}"]`).click();
  assert.equal(chips().length, 7);
  assert.equal(h.view.q('.team-pick__hint').textContent, 'You can pick up to 7 people.');
  h.view.q('[data-dm-pick="member_p6"]').click();
  assert.equal(chips().length, 7, 'an eighth pick does nothing');
  assert.equal(h.view.q('.team-pick__hint').textContent, 'You can pick up to 7 people.');
});

test('fix 5: at the cap the hint says so also when a conversation with those people exists', async (t) => {
  const seven = Array.from({ length: 7 }, (_, i) => `member_q${i}`);
  const big = dmRow(dmChannelId([DOT, ...seven]), [DOT, ...seven]);
  const h = await openDm({ answers: { chatOverview: overview({ channels: [chatChannel(), big],
    members: [...PEOPLE, ...seven.map((id, i) => chatMember(id, `Quinn ${i}`))] }) } });
  t.after(h.restore);
  await openNew(h);
  for (const id of seven) h.view.q(`[data-dm-pick="${id}"]`).click();
  assert.equal(h.view.q('.team-pick__hint').textContent, 'You can pick up to 7 people.');
});

test('fix 6: a refusal sentence goes when the picks change', async (t) => {
  const h = await openDm({ answers: { chatDmOpen: { ok: false, error: { code: 'CMP-TEAM-0009', reason: 'team_chat_dm_members_invalid' } } } });
  t.after(h.restore);
  await openNew(h);
  h.view.q('[data-dm-pick="member_lena"]').click();
  h.view.q('[data-dm="start"]').click();
  await flush();
  assert.equal(h.view.q('.team-pick__error').hidden, false);
  h.view.q('[data-dm-pick="member_maya"]').click();
  assert.equal(h.view.q('.team-pick__error').hidden, true);
  assert.equal(h.view.q('.team-pick__error').textContent, '');
});

test('fix 7: leaving the tab or the team does not keep the New message view', async (t) => {
  const h = await openDm({ teams: [memberTeam(), memberTeam({ team_id: ALPHA, team_name: 'Alpha' })] });
  t.after(h.restore);
  const first = h.view.q('.team-panel__title').textContent;
  await show(h, DM_TWO);
  await openNew(h);
  h.tab.hideTeamTab();
  h.showTab();
  await flush();
  assert.equal(headName(h).textContent, 'Olive Owner', 'back on the conversation shown before');
  await openNew(h);
  await switchTo(h, 'Alpha');
  await switchTo(h, first);
  assert.equal(headName(h).textContent, 'Olive Owner');
  assert.equal(h.view.q('[data-team-region="picker"]'), null);
});

test('fix 8 and 9: the header dot has a name; the note sits outside the listbox; no bell until the row is here', async (t) => {
  const fresh = dmChannelId([DOT, LENA]);
  const h = await openDm({ answers: { chatDmOpen: { ok: true, channel_id: fresh } } });
  t.after(h.restore);
  await show(h, DM_TWO);
  const dot = h.view.q('[data-team-region="head"] .team-dot');
  assert.equal(dot.getAttribute('role'), 'img');
  assert.equal(dot.getAttribute('aria-label'), 'online');
  assert.equal(h.view.q('#teamNotifyButton').disabled, false);
  await openNew(h);
  typeTo(h, 'zz');
  const note = h.view.q('.team-pick__note');
  assert.equal(note.hidden, false);
  assert.equal(note.closest('[role="listbox"]'), null, 'the note is outside the listbox');
  typeTo(h, '');
  h.view.q('[data-dm-pick="member_lena"]').click();
  h.view.q('[data-dm="start"]').click();
  await flush();
  assert.equal(headName(h).textContent, 'Lena');
  assert.equal(h.view.q('#teamNotifyButton').disabled, true, 'no bell before the row arrives');
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [dmRow(fresh, [DOT, LENA])] });
  await flush();
  assert.equal(h.view.q('#teamNotifyButton').disabled, false, 'the bell once it is here');
});

test('E77: the New message view says old direct messages are pruned with the rest, beside its standing statement', async (t) => {
  const h = await openDm();
  t.after(h.restore);
  h.view.q('[data-team-tab-action="dm-new"]').click();
  await flush();
  const words = h.view.q('.team-to').parentElement.textContent.replace(/\s+/g, ' ');
  assert.ok(words.includes('When the team’s chat storage is full, the oldest messages are removed, direct messages included.'), words);
  h.view.q('[data-dm-pick="member_maya"]').click();
  assert.equal(h.view.q('.team-pick__hint').textContent, STANDING, 'the standing statement is unchanged');
});
