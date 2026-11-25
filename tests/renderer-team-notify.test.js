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

test('C10.3: an export intent carries its channel to the tab: the waiting intent and tabIntents.exportStart both pass the channel id', async (t) => {
  const { h } = await setup();
  t.after(h.restore);
  const notify = require('../renderer/team/renderer-team-notify');
  h.tab.hideTeamTab();
  globalThis.rendererTopNavShellController = { openTeamView: () => true };
  assert.equal(notify.request({ kind: 'export', teamId: OTHER, scope: 'one', channelId: 'chan_project_alpha' }), true, 'pending');
  const ran = [];
  notify.attachTab({ exportStart: (...args) => ran.push(args), hasTeam: () => true, shown: () => null })();
  await flush();
  assert.deepEqual(ran, [[OTHER, 'one', 'chan_project_alpha']], 'the channel the palette named reaches the tab');
  const tabRan = [];
  const intents = notify.tabIntents({ frame: () => null, teams: () => [], exportStart: (...args) => tabRan.push(args) });
  intents.exportStart(OTHER, 'one', 'chan_project_alpha');
  assert.deepEqual(tabRan, [[OTHER, 'one', 'chan_project_alpha']], 'tabIntents passes it on to the tab');
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

// OD-8: a project channel is named by its project in a toast, never by its id.
test('OD-8: a message in a project channel raises a candidate that names the project', async (t) => {
  const before = globalThis.rendererTeamProjectStore;
  globalThis.rendererTeamProjectStore = { getProjectStore: () => ({ project: (teamId, id) => (teamId === OTHER && id === 'project_site' ? { id, name: 'Site plan', role: 'writer' } : null) }) };
  t.after(() => { if (before === undefined) delete globalThis.rendererTeamProjectStore; else globalThis.rendererTeamProjectStore = before; });
  const site = 'chan_project_site';
  const { h, sent } = await setup({ channels: [chatChannel({ notify: 'mentions', last_seq: 5 }), chatChannel({ channel_id: site, kind: 'project', notify: 'all', last_seq: 1 })] });
  t.after(h.restore);
  push(h, [fromMaya(2, { channel_id: site })], site);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].title, sent[0].conversation, sent[0].channelId], ['Maya in #Site plan', '#Site plan', site]);
});

// H22.2: a log that is not laid out measures 0; it is not on screen, so the message still raises one.
test('H22.2: the shown channel on the list screen of a narrow window (its log not laid out) still raises a candidate', async (t) => {
  const { h } = await openChat({ members: MEMBERS, channel: { notify: 'all', last_seq: 5 }, messages: [1, 2, 3, 4, 5].map((s) => message(s)), narrow: true });
  t.after(h.restore);
  const sent = [];
  const controller = { notifyTeam: (c) => { sent.push(c); return c; }, setTeamOpenHandler: () => {} };
  const notifier = require('../renderer/team/renderer-team-notify').createNotifier({ windowRef: h.window, state: { ui: { activeView: 'team' } }, store: h.store, controller: () => controller });
  h.cleanups.push(() => notifier.stop());
  const log = require('../renderer/team/renderer-team-notify').shownFrame().log;
  assert.ok(log.clientHeight > 0, 'on the channel screen the log is laid out');
  push(h, [fromMaya(6)]);
  assert.equal(sent.length, 0, 'shown at its latest: nothing');
  h.view.q('[data-team-tab-action="back"]').click();
  assert.equal(log.clientHeight, 0, 'the list screen hides the log');
  push(h, [fromMaya(7)]);
  assert.equal(sent.length, 1, 'a hidden log is not "on screen"');
});

// Row 175 F1: a project conversation reachable from outside its tab.
test('F1: a conversation intent opens the Team tab on that project conversation; one no longer listed says so', async (t) => {
  const projects = require('./helpers/team-project-renderer-host');
  const { h } = await projects.openProjects();
  t.after(h.restore);
  const notify = require('../renderer/team/renderer-team-notify');
  notify.request({ kind: 'conversation', teamId: OTHER, projectId: projects.P1, sessionId: projects.S1 });
  await flush();
  assert.equal(notify.shownFrame().channelId, 'conv:' + projects.S1, 'the conversation page is shown');
  assert.deepEqual(h.sent('conversationOpen').map((c) => c.payload.session_id), [projects.S1]);
  notify.request({ kind: 'conversation', teamId: OTHER, projectId: projects.P1, sessionId: 'sess_' + 'z'.repeat(32) });
  await flush();
  assert.equal(h.view.q('[data-team-head-note]').textContent, 'That conversation is no longer here.', 'said on the page shown');
  assert.equal(notify.shownFrame().channelId, 'conv:' + projects.S1, 'what was shown stays');
});

// Row 175 F2 (D1, D2): main's project notices become teamProject candidates; the waiting approvals count for the tab.
test('F2: a project notice is one teamProject candidate (title and a fixed sentence); Project activity off sends none; a click opens it', async (t) => {
  const projects = require('./helpers/team-project-renderer-host');
  const { h, push } = await projects.openProjects();
  t.after(h.restore);
  const sent = [];
  let openHandler = null;
  let told = 0;
  const controller = { notifyTeam: (c) => { sent.push(c); return c; }, setTeamOpenHandler: (fn) => { openHandler = fn; } };
  const state = { ui: { notifications: { enabled: true, categories: { team: true } } } };
  const notify = require('../renderer/team/renderer-team-notify');
  const notifier = notify.createNotifier({ windowRef: h.window, state, store: h.store, controller: () => controller, onWaiting: () => { told += 1; } });
  h.cleanups.push(() => notifier.stop());
  const notice = (over = {}) => push({ kind: 'project_notice', session_id: projects.S1, project_id: projects.P1, title: 'Palette loader cleanup', notice: 'finished', notice_id: '1', ...over });
  notice();
  assert.deepEqual(sent, [{ category: 'teamProject', key: 'teamProject:' + projects.S1 + ':1', teamId: OTHER, sessionId: projects.S1, projectId: projects.P1,
    title: 'Palette loader cleanup', body: 'Jenny finished your turn.' }]);
  notice({ notice: 'unattended', notice_id: '2', title: '<b>' + 'x'.repeat(200) });
  notice({ notice: 'question', notice_id: '3', title: '' });
  assert.deepEqual(sent.slice(1).map((c) => [c.body, Array.from(c.title).length]),
    [['An approval is waiting. Nobody who can answer is viewing.', 80], ['Jenny has a question for you.', 'A project conversation'.length]]);
  notice({ notice: 'text', notice_id: '4' });
  notice({ notice_id: 'x' });
  state.ui.notifications.categories.teamProject = false;
  notice({ notice_id: '5' });
  assert.equal(sent.length, 3, 'an unknown word or id, and Project activity off, send nothing');
  push({ kind: 'project_waiting', session_id: projects.S1, count: 2 });
  push({ kind: 'project_waiting', session_id: projects.S2, count: 1 });
  push({ kind: 'project_waiting', session_id: projects.S2, count: 1 });
  assert.deepEqual([notifier.waitingCount(), told], [3, 2], 'a count that did not move tells nobody');
  assert.equal(openHandler({ category: 'teamProject', teamId: OTHER, sessionId: projects.S1, projectId: projects.P1 }), true);
  await flush();
  assert.equal(notify.shownFrame().channelId, 'conv:' + projects.S1, 'the click opens the conversation');
  push({ kind: 'team_gone' });
  assert.equal(notifier.waitingCount(), 0, 'a team gone takes its count');
});

test('F1: a conversation message link exists only for a listed conversation of the shown team; its chip opens the conversation', async (t) => {
  const projects = require('./helpers/team-project-renderer-host');
  const { h } = await projects.openProjects();
  t.after(h.restore);
  const link = require('../renderer/team/renderer-team-link');
  const token = link.build({ teamId: OTHER, sessionId: projects.S1, messageId: 'm2' });
  const gone = `jenny-team:${OTHER}/conv/sess_${'z'.repeat(32)}/m1`;
  assert.equal(token, `jenny-team:${OTHER}/conv/${projects.S1}/m2`);
  assert.deepEqual([link.build({ teamId: OTHER, sessionId: 'sess_' + 'z'.repeat(32), messageId: 'm1' }), link.build({ teamId: OTHER, sessionId: projects.S1, messageId: 'm 2' })], ['', '']);
  const box = h.window.document.createElement('div');
  box.innerHTML = `<p>see ${token}, ${gone} and <code>${token}</code></p>`;
  link.markLinks(box, { teamId: OTHER, listed: () => true }, () => { throw new Error('the channel label is not asked'); });
  const chips = [...box.querySelectorAll('.team-msglink')];
  assert.equal(chips.length, 1, 'one chip: not the unlisted one, not in code');
  assert.equal(chips[0].textContent, 'Palette loader cleanup · message');
  assert.deepEqual(link.chipTarget(chips[0]), { session_id: projects.S1, message_id: 'm2' });
  assert.equal(link.linkKey(`x ${token}`, { teamId: 'team_another', listed: () => true }, () => ({ where: '', text: '' })), '', 'another team: no chip');
  const jumper = link.createJumper({ chat: h.chat, teamId: OTHER, channelId: 'chan_team', call: async () => ({ ok: false }), timeline: () => null,
    openThread: () => null, showScreen: () => {}, holdEdit: () => false, rowOf: () => null });
  jumper.jump(link.chipTarget(chips[0]));
  await flush();
  assert.equal(require('../renderer/team/renderer-team-notify').shownFrame().channelId, 'conv:' + projects.S1);
});

test('D2: the Team tab number counts the project approvals waiting for this member, with its own words', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  let made = null;
  let waiting = 0;
  h.window.rendererTeamNotify = { createNotifier: (options) => { made = options; return { stop: () => {}, waitingCount: () => waiting }; } };
  t.after(() => { delete h.window.rendererTeamNotify; });
  const s = shell(h);
  await flush();
  waiting = 2;
  made.onWaiting();
  assert.equal(s.teamTab().getAttribute('aria-label'), 'Team: 2 approvals wait for you');
  waiting = 0;
  made.onWaiting();
  assert.equal(s.teamTab().getAttribute('aria-label'), null);
});

// Row 175 F10 (D16): what waits on this member and what finished, for Home, the Needs-you inbox and the away digest.
async function attentionSetup(over = {}) {
  const projects = require('./helpers/team-project-renderer-host');
  const { h, push } = await projects.openProjects();
  const state = { ui: { activeView: 'chat', notifications: { enabled: true, categories: { team: true, teamProject: true } } } };
  const clock = { at: Date.now() };
  const notify = require('../renderer/team/renderer-team-notify');
  const notifier = notify.createNotifier({ windowRef: h.window, state, store: h.store, controller: () => null, now: () => clock.at, ...over });
  h.cleanups.push(() => notifier.stop());
  let id = 0;
  const notice = (word, extra = {}) => { id += 1; push({ kind: 'project_notice', session_id: projects.S1, project_id: projects.P1, title: 'Palette loader cleanup', notice: word, notice_id: String(id), ...extra }); };
  const told = [];
  h.window.addEventListener(notify.ATTENTION_EVENT, () => told.push(notify.attention().key));
  return { h, push, state, clock, notify, notifier, notice, told, projects };
}

test('F10: an approval, a question and an unattended approval wait as rows in arrival order, with a name, and each change is announced', async (t) => {
  const { h, push, notify, notice, told, projects } = await attentionSetup();
  t.after(h.restore);
  assert.deepEqual(notify.attention().waiting, [], 'nothing waits at first');
  notice('approval');
  notice('question', { session_id: projects.S2, title: '<b>Q</b>' });
  const { waiting, notices, key } = notify.attention();
  assert.deepEqual(waiting.map((row) => [row.kind, row.unattended, row.sessionId, row.title, row.projectId, row.count, row.onScreen]),
    [['approval', false, projects.S1, 'Palette loader cleanup', projects.P1, 1, false], ['question', false, projects.S2, '<b>Q</b>', projects.P1, 1, false]]);
  assert.deepEqual(notices, []);
  assert.equal(told.length, 2, 'one announcement per change');
  notice('unattended');
  assert.deepEqual(notify.attention().waiting.map((row) => [row.kind, row.unattended]), [['question', false], ['approval', true]], 'the same conversation re-queues at the end');
  assert.notEqual(notify.attention().key, key);
  push({ kind: 'project_waiting', session_id: projects.S1, count: 1 });
  assert.equal(notify.attention().waiting.length, 2, 'a count above 0 keeps the row');
  push({ kind: 'project_waiting', session_id: projects.S1, count: 0 });
  assert.deepEqual(notify.attention().waiting.map((row) => row.kind), ['question'], 'the approval leaves when its count goes to 0');
  assert.equal(told.length, 4);
  push({ kind: 'project_waiting', session_id: projects.S1, count: 1 });
  assert.deepEqual(notify.attention().waiting.map((row) => row.kind), ['question', 'approval'], 'a resync sends 0 then the seeded count: the row comes back');
});

test('F10: a finished or failed turn is a digest notice and ends the question of its conversation; a team gone takes everything', async (t) => {
  const { h, push, notify, notice, projects } = await attentionSetup();
  t.after(h.restore);
  notice('question');
  notice('finished');
  notice('failed', { session_id: projects.S2, title: 'Other' });
  const { waiting, notices } = notify.attention();
  assert.deepEqual(waiting, [], 'a finished turn ends its conversation\'s question');
  assert.deepEqual(notices.map((row) => [row.notice, row.sessionId, row.title, row.id]), [['finished', projects.S1, 'Palette loader cleanup', '2'], ['failed', projects.S2, 'Other', '3']]);
  assert.equal(typeof notices[0].at, 'number');
  notice('approval');
  push({ kind: 'team_gone' });
  assert.deepEqual(notify.attention(), { key: '', waiting: [], notices: [] }, 'the team went away');
});

test('F10: Project activity off, or Team off, shows nothing and shows it again when switched back; notices of 24 hours at most', async (t) => {
  const { h, notify, notice, state, clock } = await attentionSetup();
  t.after(h.restore);
  notice('approval');
  notice('finished');
  state.ui.notifications.categories.teamProject = false;
  assert.deepEqual(notify.attention().waiting.concat(notify.attention().notices), [], 'Project activity off');
  state.ui.notifications.categories.teamProject = true;
  state.ui.notifications.categories.team = false;
  assert.equal(notify.attention().key, '', 'Team off');
  state.ui.notifications.categories.team = true;
  assert.equal(notify.attention().waiting.length + notify.attention().notices.length, 2);
  clock.at += 24 * 60 * 60 * 1000 + 1000;
  assert.equal(notify.attention().key, '', 'a day later they are gone, never shown stale');
});

test('F10: opening the conversation from anywhere takes its rows; at most 50 of each are kept; the names come from the project, then the team', async (t) => {
  const { h, notify, notice, told, projects } = await attentionSetup();
  t.after(h.restore);
  notice('approval');
  notice('question');
  const teamName = h.store.snapshot().teams.find((team) => team.team_id === OTHER).team_name;
  assert.ok(teamName, 'the host names its team');
  assert.equal(notify.attention().waiting[0].where, teamName, 'no project store loaded yet: the team name');
  h.window.rendererTeamProjectStore = { getProjectStore: () => ({ project: (teamId, projectId) => (teamId === OTHER && projectId === projects.P1 ? { name: 'jenny-site' } : null) }) };
  assert.equal(notify.attention().waiting[0].where, 'jenny-site', 'the Team tab loaded: the project name');
  notify.request({ kind: 'conversation', teamId: OTHER, projectId: projects.P1, sessionId: projects.S1 });
  await flush();
  assert.deepEqual(notify.attention().waiting, [], 'opened: the approval and the question leave');
  assert.equal(told.at(-1), '', 'and the views are told');
  for (let n = 0; n < 60; n += 1) { notice('approval', { session_id: 'sess_' + String(n).padStart(32, '0') }); notice('finished', { session_id: 'sess_' + String(n).padStart(32, '1') }); }
  const { waiting, notices } = notify.attention();
  assert.deepEqual([waiting.length, notices.length], [50, 50]);
  assert.equal(waiting.at(-1).sessionId, 'sess_' + '59'.padStart(32, '0'), 'the newest are kept');
});

test('F10: the notifier stopped takes its rows, tells the views, and the accessor then answers empty', async (t) => {
  const { h, notify, notifier, notice, told } = await attentionSetup();
  t.after(h.restore);
  notice('approval');
  const before = told.length;
  notifier.stop();
  assert.equal(notify.attention().key, '');
  assert.ok(told.length > before);
});

test('F16: the Team tab says which conversation it shows, so its row on Home reads "on screen" and no other does', async (t) => {
  const { h, notify, notice, state, projects } = await attentionSetup();
  t.after(h.restore);
  state.ui.activeView = 'team';
  notify.request({ kind: 'conversation', teamId: OTHER, projectId: projects.P1, sessionId: projects.S1 });
  await flush();
  assert.deepEqual([notify.shownFrame().channelId, notify.shownFrame().sessionId], ['conv:' + projects.S1, projects.S1]);
  notice('unattended');
  notice('unattended', { session_id: projects.S2, title: 'Other' });
  assert.deepEqual(notify.attention().waiting.map((row) => [row.sessionId, row.onScreen]), [[projects.S1, true], [projects.S2, false]]);
  state.ui.activeView = 'chat';
  assert.deepEqual(notify.attention().waiting.map((row) => row.onScreen), [false, false], 'another view is shown: none is on screen');
});

test('F13: an asked notice toasts who asked and where, every time, also while that conversation is shown; a click opens it; no Needs-you row', async (t) => {
  const sent = [];
  let openHandler = null;
  const controller = { notifyTeam: (c) => { sent.push(c); return c; }, setTeamOpenHandler: (fn) => { openHandler = fn; } };
  const { h, notify, notice, state, projects, told } = await attentionSetup({ controller: () => controller });
  t.after(h.restore);
  state.ui.activeView = 'team';
  notify.request({ kind: 'conversation', teamId: OTHER, projectId: projects.P1, sessionId: projects.S1 });
  await flush();
  const before = told.length;
  notice('asked', { asker_member_id: MAYA });
  notice('asked', { asker_member_id: MAYA, approval_id: 'approval_x' });
  notice('asked', { asker_member_id: '<b>' });
  assert.deepEqual(sent.map((c) => [c.category, c.sessionId, c.title, c.body]), [
    ['teamProject', projects.S1, 'Palette loader cleanup', 'Maya asked you to look at Palette loader cleanup'],
    ['teamProject', projects.S1, 'Palette loader cleanup', 'Maya asked you to decide an approval in Palette loader cleanup'],
  ], 'told while it is shown; an asker that is no member id tells nothing');
  assert.deepEqual([notify.attention().waiting, notify.attention().notices, told.length], [[], [], before], 'no Needs-you row, no digest notice');
  state.ui.activeView = 'chat';
  assert.equal(openHandler({ category: 'teamProject', teamId: OTHER, sessionId: projects.S1, projectId: projects.P1 }), true);
  await flush();
  assert.equal(notify.shownFrame().sessionId, projects.S1, 'the click opens the conversation');
});
