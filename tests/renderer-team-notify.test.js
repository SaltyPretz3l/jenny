'use strict';

// new-test-file: the team desktop-notification subscriber is a new surface (row 123, slice 2a-6c): it reads the
// `team.onChat` pushes for channels no timeline holds, applies the level, mention, follow, own-message and
// on-screen rules, builds the approved words, and opens the Team tab at the message on a click. Real modules
// over the harness bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { OTHER, CHAN, DOT, ME, MAYA, CODE, flush, msgId, message, memberTeam, snapshot, chatChannel, chatMember, openChat, chatPush, searchField, harness, shell }
  = require('./helpers/team-settings-harness');

const MEMBERS = [chatMember(ME, 'Olive Owner', { role: 'owner' }), chatMember(DOT, 'Dot'), chatMember(MAYA, 'Maya')];
const DM = 'chan_dm_' + 'a'.repeat(64);
const GROUP = 'chan_dm_' + 'b'.repeat(64);
const dmRow = (id, participants, over = {}) => chatChannel({ channel_id: id, kind: 'dm', participants, notify: 'all', ...over });
const fromMaya = (seq, over = {}) => message(seq, { author: { kind: 'member', member_id: MAYA }, ...over });
const push = (h, messages, channel = CHAN) => chatPush(h, { type: 'messages', channel_id: channel, reset: false, messages });
const note = (h) => (h.view.q('.team-thread-gone') || { textContent: '' }).textContent;
const jumped = (h) => h.view.qa('[data-jumped="true"]').map((el) => el.dataset.messageId);

// The chat open in the Team tab, and a notifier over a fake desktop-notifications controller.
async function setup({ channel = {}, channels = null, ui = { activeView: 'chat' }, teams, answers = {} } = {}) {
  const { h, box } = await openChat({ members: MEMBERS, channel: { notify: 'mentions', last_seq: 5, ...channel }, messages: [1, 2, 3, 4, 5].map((s) => message(s)), teams,
    answers: { ...(channels ? { chatOverview: { ok: true, channels, outbox: [], members: MEMBERS } } : {}), ...answers } });
  const sent = [];
  let openHandler = null;
  const controller = { notifyTeam: (c) => { sent.push(c); return c; }, setTeamOpenHandler: (fn) => { openHandler = fn; } };
  const state = { ui };
  const notifier = require('../renderer/team/renderer-team-notify').createNotifier({ windowRef: h.window, state, store: h.store, controller: () => controller });
  h.cleanups.push(() => notifier.stop());
  return { h, box, sent, state, open: (payload) => openHandler(payload), handler: () => openHandler };
}

test('a mention in a channel raises one candidate with the approved words, the first line as preview and only routing ids', async (t) => {
  const { h, sent } = await setup();
  t.after(h.restore);
  push(h, [fromMaya(6, { mentions: [DOT], text: `<@${DOT}> can you look before lunch?\nsecond line` })]);
  assert.equal(sent.length, 1);
  const [candidate] = sent;
  assert.deepEqual(candidate, { category: 'team', key: 'team:' + msgId(6), teamId: OTHER, channelId: CHAN, messageId: msgId(6), seq: 6,
    title: 'Maya in #team', body: 'Mentioned you', sender: 'Maya', conversation: '#team', preview: '@Dot can you look before lunch?' });
  // The byte search: no member id, invite, key or device id in what goes to main.
  const bytes = JSON.stringify(candidate);
  for (const secret of [DOT, MAYA, CODE, 'jteam1_', 'device_', 'fingerprint']) assert.equal(bytes.includes(secret), false, secret);
  push(h, [fromMaya(6, { mentions: [DOT], rev: 7, edited_at: new Date().toISOString() })]);
  assert.equal(sent.length, 1, 'an edit or a message seen before never raises another');
});

test('levels, own messages, deletions and edits: who is told follows the channel and the spec', async (t) => {
  const { h, sent } = await setup();
  t.after(h.restore);
  push(h, [fromMaya(6)]);
  assert.equal(sent.length, 0, 'mentions only: a plain message says nothing');
  push(h, [message(7, { mentions: [DOT] })]);
  assert.equal(sent.length, 0, 'your own message never raises one');
  push(h, [fromMaya(8, { mentions: ['channel'] })]);
  assert.equal(sent.at(-1).body, 'Mentioned you', 'a mention of the channel is a mention');
  push(h, [fromMaya(9, { mentions: [DOT], deleted: { by: MAYA, at: 'x' } }), fromMaya(10, { mentions: [DOT], edited_at: 'x' })]);
  assert.equal(sent.length, 1, 'a deleted or edited record raises nothing');
  chatPush(h, { type: 'channels', partial: true, channels: [chatChannel({ notify: 'all', last_seq: 10 })] });
  push(h, [fromMaya(11)]);
  assert.equal(sent.at(-1).body, 'New message', 'All messages: every message');
  chatPush(h, { type: 'channels', partial: true, channels: [chatChannel({ notify: 'none', last_seq: 11 })] });
  push(h, [fromMaya(12, { mentions: [DOT] })]);
  assert.equal(sent.length, 2, 'a muted channel never raises one');
});

test('a reply raises one only in a thread you follow or when it mentions you', async (t) => {
  const { h, sent } = await setup({ channel: { notify: 'all' } });
  t.after(h.restore);
  push(h, [fromMaya(6, { thread_root_id: msgId(3) })]);
  assert.equal(sent.length, 0, 'a thread this member never wrote in');
  push(h, [message(7, { thread_root_id: msgId(3) })]); // this member replies: now follows it
  push(h, [fromMaya(8, { thread_root_id: msgId(3) })]);
  assert.deepEqual([sent.at(-1).title, sent.at(-1).body, sent.at(-1).threadRootId], ['Maya in #team', 'Replied in a thread you follow', msgId(3)]);
  push(h, [message(9)]); // a root this member started
  push(h, [fromMaya(10, { thread_root_id: msgId(9) })]);
  assert.equal(sent.at(-1).threadRootId, msgId(9));
  push(h, [fromMaya(11, { thread_root_id: msgId(4), mentions: [DOT] })]);
  assert.equal(sent.at(-1).body, 'Mentioned you');
  assert.equal(sent.length, 3);
});

test('direct conversations: the name alone, then "{sender}, with {names}", "Direct message", default level all', async (t) => {
  const channels = [chatChannel(), dmRow(DM, [DOT, MAYA], { notify: undefined }), dmRow(GROUP, [DOT, MAYA, ME])];
  const { h, sent } = await setup({ channels });
  t.after(h.restore);
  push(h, [fromMaya(1, { channel_id: DM })], DM);
  push(h, [fromMaya(2, { channel_id: GROUP })], GROUP);
  assert.deepEqual(sent.map((c) => [c.title, c.body, c.conversation]), [['Maya', 'Direct message', 'Maya'], ['Maya, with Olive Owner', 'Direct message', 'Maya, Olive Owner']]);
});

test('in two teams the channel title names the team', async (t) => {
  const { h, sent } = await setup({ teams: [memberTeam(), snapshot({ team_name: 'Studio' })] });
  t.after(h.restore);
  push(h, [fromMaya(6, { mentions: [DOT] })]);
  assert.equal(sent[0].title, 'Maya in #team · Dot lab');
});

test('the conversation on screen at its latest in the focused window raises nothing; another one does', async (t) => {
  const channels = [chatChannel({ notify: 'all', last_seq: 5 }), dmRow(DM, [DOT, MAYA])];
  const { h, box, sent, state } = await setup({ channels, ui: { activeView: 'team' } });
  t.after(h.restore);
  push(h, [fromMaya(6)]);
  assert.equal(sent.length, 0, '#team is shown at its latest messages');
  push(h, [fromMaya(1, { channel_id: DM })], DM);
  assert.equal(sent.length, 1, 'a conversation that is not shown');
  box.setFocus(false);
  push(h, [fromMaya(7)]);
  assert.equal(sent.length, 2, 'the window is not focused');
  box.setFocus(true);
  state.ui.activeView = 'chat';
  push(h, [fromMaya(8)]);
  assert.equal(sent.length, 3, 'another view is shown');
});

test('a click opens the tab at the channel and tints the message; a reply asks its thread; a deleted one says so', async (t) => {
  const history = (p) => ({ ok: true, messages: p.before_seq === 5 ? [message(4, { deleted: { by: DOT, at: 'x' } })] : [1, 2, 3, 4, 5].map((s) => message(s)), has_more: false });
  const thread = { ok: true, root: message(3, { reply_count: 1 }), replies: [fromMaya(8, { thread_root_id: msgId(3) })], has_more: false };
  const { h, open, handler } = await setup({ answers: { chatHistory: history, chatThread: thread } });
  t.after(h.restore);
  assert.equal(typeof handler(), 'function', 'the notifier registers the team opener');
  open({ category: 'team', teamId: OTHER, channelId: CHAN, messageId: msgId(3), seq: 3 });
  await flush();
  assert.deepEqual(jumped(h), [msgId(3)]);
  assert.deepEqual(h.sent('chatHistory').at(-1).payload, { team_id: OTHER, channel_id: CHAN, before_seq: 4, limit: 1 });
  open({ category: 'team', teamId: OTHER, channelId: CHAN, messageId: msgId(8), threadRootId: msgId(3), seq: 8 });
  await flush();
  assert.deepEqual(h.sent('chatThread')[0].payload, { team_id: OTHER, channel_id: CHAN, root_id: msgId(3), after_seq: 7, limit: 1 });
  assert.ok(h.view.q('aside.team-thread'), 'a reply opens its thread');
  open({ category: 'team', teamId: OTHER, channelId: CHAN, messageId: msgId(4), seq: 4 });
  await flush();
  assert.equal(note(h), 'That message was deleted.');
  open({ category: 'team', teamId: 'team_GONEGONEGONEGONEGONEGO', channelId: CHAN, messageId: msgId(3), seq: 3 });
  await flush();
  assert.equal(note(h), 'You are no longer in that team.');
});

test('a person picked in the palette: an existing one-to-one opens with no create call; someone never written to gets chatDmOpen, as the picker does', async (t) => {
  const ANN = 'member_ann';
  const NEW_DM = 'chan_dm_' + 'c'.repeat(64);
  const members = [...MEMBERS, chatMember(ANN, 'Ann')];
  const channels = [chatChannel(), dmRow(DM, [DOT, MAYA])];
  const { h } = await openChat({ members, channel: { last_seq: 5 }, messages: [1, 2, 3, 4, 5].map((s) => message(s)), answers: {
    chatOverview: { ok: true, channels, outbox: [], members }, chatDmOpen: { ok: true, channel_id: NEW_DM } } });
  t.after(h.restore);
  const notify = require('../renderer/team/renderer-team-notify');
  notify.request({ kind: 'person', teamId: OTHER, memberId: MAYA });
  await flush();
  assert.equal(h.sent('chatDmOpen').length, 0, 'the one-to-one with Maya exists: nothing is created');
  assert.equal(notify.shownFrame().channelId, DM);
  notify.request({ kind: 'person', teamId: OTHER, memberId: ANN });
  await flush();
  assert.deepEqual(h.sent('chatDmOpen').map((c) => c.payload), [{ team_id: OTHER, member_ids: [ANN] }]);
  assert.equal(notify.shownFrame().channelId, NEW_DM);
});

test('stop forgets the pushes and the opener', async (t) => {
  const { h, sent, handler } = await setup();
  t.after(h.restore);
  h.cleanups.splice(0).forEach((fn) => fn());
  assert.equal(handler(), null);
  push(h, [fromMaya(6, { mentions: [DOT] })]);
  assert.equal(sent.length, 0);
});

// Fix list items 5, 7 and 8 (2a-6c review).
const GONE = 'team_GONEGONEGONEGONEGONEGO';
function hiddenTab(h) {
  h.tab.hideTeamTab();
  const opens = [];
  globalThis.rendererTopNavShellController = { openTeamView: () => { opens.push(1); h.showTab(); return true; } };
  return opens;
}

test('item 5: an intent asked while the tab is hidden runs once the tab has drawn: search focuses its field, a left team says so', async (t) => {
  const { h } = await setup();
  t.after(h.restore);
  const notify = require('../renderer/team/renderer-team-notify');
  const opens = hiddenTab(h);
  assert.equal(notify.request({ kind: 'search' }), true);
  await flush();
  assert.deepEqual([opens.length, h.window.document.activeElement], [1, searchField(h)]);
  hiddenTab(h);
  notify.request({ kind: 'open', teamId: GONE, channelId: CHAN });
  await flush();
  assert.equal(note(h), 'You are no longer in that team.');
});

test('item 7: an intent waits at most 10 seconds for the tab, and none waits when opening throws', async (t) => {
  const { h } = await setup();
  t.after(h.restore);
  const notify = require('../renderer/team/renderer-team-notify');
  h.tab.hideTeamTab();
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  globalThis.rendererTopNavShellController = { openTeamView: () => true }; // the tab never attaches (its scripts failed)
  assert.equal(notify.request({ kind: 'export', teamId: OTHER, scope: 'all' }), true);
  now += 10_001;
  const ran = [];
  const detach = notify.attachTab({ exportStart: () => ran.push('export'), focusSearch: () => ran.push('search'), hasTeam: () => true, shown: () => null });
  await flush();
  detach();
  assert.deepEqual(ran, [], 'an intent older than 10 s is dropped, never run at an unrelated open');
  globalThis.rendererTopNavShellController = { openTeamView: () => { throw new Error('no view'); } };
  assert.equal(notify.request({ kind: 'search' }), false);
  const later = notify.attachTab({ focusSearch: () => ran.push('search'), hasTeam: () => true, shown: () => null });
  await flush();
  later();
  assert.deepEqual(ran, [], 'a failed open leaves nothing waiting');
});

test('item 8: a record with no author is skipped and the rest of the push still counts', async (t) => {
  const channels = [chatChannel(), dmRow(DM, [DOT, MAYA, 'member_ann'])];
  const { h, sent } = await setup({ channels });
  t.after(h.restore);
  push(h, [{ id: msgId(1), seq: 1, channel_id: DM, text: 'x', mentions: [] }, null, fromMaya(2, { channel_id: DM })], DM);
  assert.ok(sent.some((c) => c.messageId === msgId(2)), 'the message after the bad one raises its toast');
});

// Fix list item 16: a request with the tab hidden waits, then runs when the tab attaches; the gate owns the notifier.
test('item 16: a request while the tab is hidden waits and runs once when the tab attaches within 10 seconds', async (t) => {
  const { h } = await setup();
  t.after(h.restore);
  const notify = require('../renderer/team/renderer-team-notify');
  h.tab.hideTeamTab();
  globalThis.rendererTopNavShellController = { openTeamView: () => true };
  assert.equal(notify.shownFrame(), null, 'no tab attached');
  assert.equal(notify.request({ kind: 'export', teamId: OTHER, scope: 'one' }), true, 'pending');
  const ran = [];
  const api = { exportStart: (teamId, scope) => ran.push([teamId, scope]), hasTeam: () => true, shown: () => null };
  const detach = notify.attachTab(api);
  await flush();
  assert.deepEqual(ran, [[OTHER, 'one']], 'run at attach');
  detach();
  notify.attachTab(api)();
  await flush();
  assert.equal(ran.length, 1, 'run once, not again at the next attach');
});

test('item 16: the gate starts the notifier with the chat store and stops it when the flag goes off', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  const made = [];
  let stopped = 0;
  h.window.rendererTeamNotify = { createNotifier: (options) => { made.push(options); return { stop: () => { stopped += 1; } }; } };
  t.after(() => { delete h.window.rendererTeamNotify; });
  const s = shell(h);
  await flush();
  assert.equal(made.length, 1, 'started once the chat store loads');
  assert.equal(made[0].store, h.store, 'over the shared team store');
  s.state.features = { featureFlags: { team: false }, availabilityResolved: true };
  s.controller.applyViewChrome();
  await flush();
  assert.equal(stopped, 1, 'stopped with the flag');
});

// Fix list item 19: the log has a height here (the harness layout gives `.team-scroll` 400 px), so scrolled up and a
// timeline with newer messages not loaded are both told apart from "at its latest".
test('item 19: scrolled up from the latest, or with newer messages not loaded, the shown conversation still raises one', async (t) => {
  const seqs = Array.from({ length: 30 }, (_v, i) => i + 1);
  const { h } = await openChat({ members: MEMBERS, channel: { notify: 'all', last_seq: 30 }, messages: seqs.map((s) => message(s)) });
  t.after(h.restore);
  const sent = [];
  const controller = { notifyTeam: (c) => { sent.push(c); return c; }, setTeamOpenHandler: () => {} };
  const notifier = require('../renderer/team/renderer-team-notify').createNotifier({ windowRef: h.window, state: { ui: { activeView: 'team' } }, store: h.store, controller: () => controller });
  h.cleanups.push(() => notifier.stop());
  const log = require('../renderer/team/renderer-team-notify').shownFrame().log;
  assert.ok(log.clientHeight > 0 && log.scrollHeight > log.clientHeight + 200, 'a log taller than its box');
  log.scrollTop = log.scrollHeight;
  push(h, [fromMaya(31)]);
  assert.equal(sent.length, 0, 'at its latest: nothing');
  log.scrollTop = 0;
  push(h, [fromMaya(32)]);
  assert.equal(sent.length, 1, 'scrolled up: one');
  log.scrollTop = log.scrollHeight;
  h.chat.timeline(OTHER, CHAN).hasNewer = true;
  push(h, [fromMaya(40)]);
  assert.equal(sent.length, 2, 'newer messages not loaded: one');
});
