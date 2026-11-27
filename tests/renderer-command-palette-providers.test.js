'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaletteProviders } = require('../renderer/shell/renderer-command-palette-providers');

test('prompt slash rows show the server tag without an action hint', () => {
  const calls = [];
  const providers = createPaletteProviders({ state: { ui: {}, sessions: [] }, callbacks: {
    listSlashCommands: () => [{ name: '/rea-investigate_feature', description: 'Plan · feature', tag: 'rea', available: true },
      { name: '/help', description: 'Help', available: true }],
    tryExecuteSlashCommand: command => calls.push(command),
  } });
  const items = providers.snapshot();
  const prompt = items.find(item => item.id === 'slash:/rea-investigate_feature');
  assert.equal(prompt.group, 'Slash commands');
  assert.equal(prompt.description, 'Plan · feature');
  assert.equal(prompt.tag, 'rea');
  assert.equal(Object.hasOwn(prompt, 'hint'), false);
  assert.equal(items.find(item => item.id === 'slash:/help').hint, 'Run');
  prompt.run(); assert.deepEqual(calls, ['/rea-investigate_feature']);
});

test('the palette cycles the focused session\'s transcript view and names the current and next view', (t) => {
  const previous = { controller: globalThis.rendererTranscriptViewController, utils: globalThis.rendererTranscriptViewUtils };
  const cycleCalls = [];
  globalThis.rendererTranscriptViewUtils = require('../renderer/chat/renderer-transcript-view-utils');
  globalThis.rendererTranscriptViewController = { getView: () => 'thinking', cycle: (...args) => cycleCalls.push(args) };
  t.after(() => { globalThis.rendererTranscriptViewController = previous.controller; globalThis.rendererTranscriptViewUtils = previous.utils; });
  const providers = createPaletteProviders({
    state: { ui: {}, sessions: [{ id: 'sess_a', title: 'A' }], currentSessionId: 'sess_a' },
    callbacks: { listSlashCommands: () => [], tryExecuteSlashCommand: () => {} },
  });
  const item = providers.snapshot().find((entry) => entry.id === 'action:transcript-view');
  assert.ok(item, 'the action exists for the focused session');
  assert.equal(item.group, 'Actions');
  assert.equal(item.label, 'Cycle transcript view');
  assert.equal(item.description, 'Now Thinking; next Everything');
  item.run();
  assert.deepEqual(cycleCalls, [['sess_a', { source: 'palette' }]]);

  globalThis.rendererTranscriptViewController = undefined;
  const without = createPaletteProviders({
    state: { ui: {}, sessions: [{ id: 'sess_a', title: 'A' }], currentSessionId: 'sess_a' },
    callbacks: { listSlashCommands: () => [], tryExecuteSlashCommand: () => {} },
  });
  assert.equal(without.snapshot().some((entry) => entry.id === 'action:transcript-view'), false, 'no controller, no action');
});

test('skill palette rows precede slash commands and attach through slash execution', () => {
  const calls = [];
  const providers = createPaletteProviders({
    state: { ui: {}, sessions: [] },
    callbacks: {
      listSlashCommands: () => [
        { name: '/help', action: 'run', actionLabel: 'Run', description: 'List commands', available: true },
        {
          name: '/verify', action: 'attach', actionLabel: 'Attach', description: 'Check evidence', available: true,
          skill: { id: 'bundled/verify', name: 'Verification specialist', scope: 'bundled', command: 'verify' },
        },
      ],
      tryExecuteSlashCommand: (prompt) => calls.push(prompt),
    },
  });
  const items = providers.snapshot();
  const skill = items.find((item) => item.id === 'skill:bundled/verify');
  const slash = items.find((item) => item.id === 'slash:/help');
  assert.deepEqual(
    { group: skill.group, label: skill.label, description: skill.description, hint: skill.hint },
    { group: 'Skills', label: '/verify', description: 'Verification specialist \u2014 Check evidence', hint: 'Attach' }
  );
  assert.ok(items.indexOf(skill) < items.indexOf(slash));
  skill.run();
  assert.deepEqual(calls, ['/verify']);
  assert.equal(items.some((item) => item.id === 'slash:/verify'), false);
});

test('"Reload window" runs the guarded reload (the removed title-bar tile\'s route)', async () => {
  const reloads = [];
  const globalRef = { rendererWindowControlsUtils: { reloadWindow: (options) => { reloads.push(options); return Promise.resolve(null); } } };
  const providers = createPaletteProviders({ state: { ui: {}, sessions: [] }, globalRef });
  const item = providers.snapshot().find((entry) => entry.id === 'action:reload-window');
  assert.ok(item, 'the palette lists the reload command');
  assert.deepEqual(
    { group: item.group, label: item.label, hint: item.hint },
    { group: 'Actions', label: 'Reload window', hint: 'Ctrl Shift R' },
  );
  item.run();
  assert.equal(reloads.length, 1);
  assert.equal(reloads[0].windowRef, globalRef, 'reloads the palette\'s own window');

  const without = createPaletteProviders({ state: { ui: {}, sessions: [] }, globalRef: {} }).snapshot();
  assert.equal(without.some((entry) => entry.id === 'action:reload-window'), false, 'absent-safe: no seam, no row');
});

test('the palette lists Team only while the Team flag is on, as it is at each open; the density row is always listed (it sits on Chat)', () => {
  const teamItem = { dataset: { featureFlag: 'team' }, hidden: true };
  const document = { querySelectorAll: () => [{ dataset: {}, hidden: false }, teamItem] };
  const globalRef = { rendererSettingsSearch: require('../renderer/shell/renderer-settings-search.js'), document };
  const providers = createPaletteProviders({ state: { ui: {}, sessions: [] }, globalRef });
  const ids = () => providers.snapshot().filter((item) => item.group === 'Settings').map((item) => item.id);
  const flagged = ['setting:section:team'];
  const off = ids();
  assert.ok(off.includes('setting:notificationsCategoryTeamToggle'), 'fix item 3: Settings search finds the greyed team switch with the flag off');
  assert.ok(off.includes('setting:section:models'), 'other settings are listed');
  assert.ok(off.includes('setting:appearanceTeamDensitySelect'), 'the density row is greyed on Chat with the flag off, so it is still found');
  for (const id of flagged) assert.equal(off.includes(id), false, `${id} is not offered with the flag off`);
  teamItem.hidden = false;
  const on = ids();
  for (const id of flagged) assert.ok(on.includes(id), `${id} is offered at the next open once the flag is on`);
  teamItem.hidden = true;
  for (const id of flagged) assert.equal(ids().includes(id), false, `${id} goes again with the flag`);
  const unknown = createPaletteProviders({ state: { ui: {}, sessions: [] }, globalRef: { rendererSettingsSearch: globalRef.rendererSettingsSearch } });
  for (const id of flagged) assert.equal(unknown.snapshot().some((item) => item.id === id), false, `${id}: no way to tell, not listed`);
});

// Row 123 slice 2a-6c: team rows, over the real team modules and the harness bridge.
const teamHarness = () => require('./helpers/team-settings-harness');
const teamProviders = (flag = true, sessions = []) => createPaletteProviders({ state: { ui: {}, sessions, features: { featureFlags: { team: flag } } },
  globalRef: { rendererTeamPalette: require('../renderer/team/renderer-team-palette') } });
const shape = (items) => JSON.stringify(items.map(({ id, group, label, description, hint, tag, icon, scopes, landing, queryOnly }) => ({ id, group, label, description, hint, tag, icon, scopes, landing, queryOnly })));

test('team rows: Team in Navigate, the Team group, unread conversations landing, people for one-to-one, no row for you', async (t) => {
  const { openChat, chatChannel, chatMember, ME, DOT, MAYA } = teamHarness();
  const DM = 'chan_dm_' + 'a'.repeat(64);
  const GROUP = 'chan_dm_' + 'b'.repeat(64);
  const channels = [chatChannel({ unread: 2, mention: true }), chatChannel({ channel_id: 'chan_jenny', kind: 'project' }),
    chatChannel({ channel_id: DM, kind: 'dm', participants: [DOT, MAYA], unread: 1 }), chatChannel({ channel_id: GROUP, kind: 'dm', participants: [DOT, MAYA, ME] })];
  const members = [chatMember(ME, 'Olive Owner', { role: 'owner' }), chatMember(DOT, 'Dot'), chatMember(MAYA, 'Maya')];
  const { h } = await openChat({ members, answers: { chatOverview: { ok: true, channels, outbox: [], members } } });
  t.after(h.restore);
  const items = teamProviders().snapshot();
  const team = items.filter((item) => item.group === 'Team');
  assert.ok(items.some((item) => item.id === 'nav:team' && item.group === 'Navigate' && item.hint === 'Ctrl 6'));
  const byLabel = Object.fromEntries(team.map((item) => [item.label, item]));
  assert.deepEqual(Object.keys(byLabel), ['Search messages', 'New message', '#team', '#jenny', 'Maya, Olive Owner', 'Olive Owner', 'Maya', 'Export this conversation', 'Export every conversation']);
  assert.deepEqual([byLabel['#team'].landing, byLabel['#team'].description, byLabel['#team'].tag, byLabel['#team'].scopes], [true, 'mentions you', 'Channel', ['chats']]);
  assert.deepEqual([byLabel.Maya.landing, byLabel.Maya.tag, byLabel.Maya.icon], [true, 'Person', 'person'], 'the one-to-one conversation is the person row');
  assert.equal(team.some((item) => item.id.endsWith(':' + DM)), false, 'no row of its own for a one-to-one conversation');
  assert.equal(team.some((item) => item.label === 'Dot'), false, 'you are not listed');
  for (const label of ['#jenny', 'Maya, Olive Owner', 'Olive Owner', 'Export this conversation']) assert.equal(byLabel[label].queryOnly, true, label + ': typed only');
  assert.equal(byLabel['Maya, Olive Owner'].tag, 'Direct');
  const bytes = shape(items);
  for (const secret of [ME, DOT, MAYA].map((id) => '"' + id + '"').concat(['jteam1_', 'device_'])) assert.equal(bytes.includes(secret), false, secret);
});

test('with no team, or the flag off, the palette lists exactly what it did before the team rows', async (t) => {
  const { harness } = teamHarness();
  const h = harness({ show: false, teams: [] });
  t.after(h.restore);
  const sessions = [{ id: 'sess_a', title: 'A' }];
  const base = shape(createPaletteProviders({ state: { ui: {}, sessions }, globalRef: {} }).snapshot());
  assert.equal(shape(teamProviders(true, sessions).snapshot()), base, 'in no team: byte for byte');
  assert.equal(shape(teamProviders(false, sessions).snapshot()), base, 'flag off: byte for byte');
});

// Fix list item 14: the palette with no team, pinned to the rows, groups and order of the palette before the team rows.
const BASE_ROWS = [['nav:home', 'Navigate'], ['nav:chat', 'Navigate'], ['nav:ide', 'Navigate'], ['nav:logs', 'Navigate'], ['nav:settings', 'Navigate'],
  ['action:new-chat', 'Actions'], ['action:search-recents', 'Actions'], ['action:workspace', 'Actions'], ['action:toggle-sidebar', 'Actions'],
  ['action:show-archived', 'Actions'], ['action:sweep-empty', 'Actions'], ['session:sess_a', 'Sessions'], ['help:keyboard', 'Help']];
const rowsOf = (items) => items.map((item) => [item.id, item.group]);

test('item 14: no team, or the flag off with a team present, lists exactly the palette from before the team rows', async (t) => {
  const sessions = [{ id: 'sess_a', title: 'A' }];
  const { harness } = teamHarness();
  const empty = harness({ show: false, teams: [] });
  assert.deepEqual(rowsOf(teamProviders(true, sessions).snapshot()), BASE_ROWS, 'in no team');
  empty.restore();
  const { openChat } = teamHarness();
  const { h } = await openChat();
  t.after(h.restore);
  assert.ok(teamProviders(true, sessions).snapshot().some((item) => item.group === 'Team'), 'the team is there');
  assert.deepEqual(rowsOf(teamProviders(false, sessions).snapshot()), BASE_ROWS, 'flag off with a team present');
});

// Fix list item 15: each row's `run`, through the real palette module and the real Team tab.
const teamItems = () => teamProviders().snapshot().filter((item) => item.group === 'Team');
const byId = (items, id) => items.find((item) => item.id === id);

test('item 15: a person with a one-to-one opens it, one without asks chatDmOpen; search, New message and both exports run in the tab', async (t) => {
  const { openChat, chatChannel, chatMember, flush, searchField, ME, DOT, MAYA, OTHER } = teamHarness();
  const DM = 'chan_dm_' + 'a'.repeat(64);
  const NEW_DM = 'chan_dm_' + 'd'.repeat(64);
  const members = [chatMember(ME, 'Olive Owner', { role: 'owner' }), chatMember(DOT, 'Dot'), chatMember(MAYA, 'Maya')];
  const channels = [chatChannel(), chatChannel({ channel_id: DM, kind: 'dm', participants: [DOT, MAYA] })];
  const { h } = await openChat({ members, answers: { chatOverview: { ok: true, channels, outbox: [], members }, chatDmOpen: { ok: true, channel_id: NEW_DM } } });
  t.after(h.restore);
  const notify = require('../renderer/team/renderer-team-notify');
  byId(teamItems(), 'team:person:' + OTHER + ':' + MAYA).run();
  await flush();
  assert.deepEqual([h.sent('chatDmOpen').length, notify.shownFrame().channelId], [0, DM], 'the existing one-to-one, no create call');
  byId(teamItems(), 'team:person:' + OTHER + ':' + ME).run();
  await flush();
  assert.deepEqual(h.sent('chatDmOpen').map((c) => c.payload), [{ team_id: OTHER, member_ids: [ME] }], 'no one-to-one yet: chatDmOpen, as the picker does');
  byId(teamItems(), 'team:new').run();
  await flush();
  assert.equal(notify.shownFrame().channelId, 'new', 'New message opens the picker');
  byId(teamItems(), 'team:search').run();
  await flush();
  assert.equal(h.window.document.activeElement, searchField(h), 'Search messages focuses the field');
  const exporter = globalThis.rendererTeamExport.getExporter();
  t.after(() => exporter.cancel());
  for (const [id, scope] of [['team:export-one', 'one'], ['team:export-all', 'all']]) {
    byId(teamItems(), id).run();
    await Promise.resolve();
    assert.deepEqual([exporter.running(), exporter.state().scope, exporter.state().teamId], [true, scope, OTHER], id);
    exporter.cancel();
    await flush();
  }
});

test('item 15: at most four unread conversations land, mentions first; two teams name the team; exports and New message only when they can run', async (t) => {
  const { openChat, chatChannel, memberTeam, snapshot } = teamHarness();
  const unreadSet = [chatChannel({ unread: 1 }), chatChannel({ channel_id: 'chan_a', kind: 'project', unread: 9 }), chatChannel({ channel_id: 'chan_b', kind: 'project', unread: 1, mention: true }),
    chatChannel({ channel_id: 'chan_c', kind: 'project', unread: 5 }), chatChannel({ channel_id: 'chan_d', kind: 'project', mention: true }), chatChannel({ channel_id: 'chan_e', kind: 'project', unread: 3 })];
  let { h } = await openChat({ answers: { chatOverview: { ok: true, channels: unreadSet, outbox: [] } } });
  const landing = teamItems().filter((item) => item.id.startsWith('team:chan:') && item.landing).map((item) => item.id.split(':').pop()).sort();
  assert.deepEqual(landing, ['chan_a', 'chan_b', 'chan_c', 'chan_d'], 'two mentions (one with nothing unread) before the most unread');
  h.restore();
  ({ h } = await openChat({ teams: [memberTeam(), snapshot()] }));
  const descriptions = teamItems().filter((item) => item.label === '#team').map((item) => item.description).sort();
  assert.deepEqual(descriptions, ['Dot lab', 'Studio'], 'each team\'s rows name their team');
  h.restore();
  ({ h } = await openChat({ teams: [memberTeam({ state: 'offline' })] }));
  assert.deepEqual(teamItems().filter((item) => item.id.startsWith('team:export')), [], 'offline: no export actions');
  h.restore();
  ({ h } = await openChat({ teams: [memberTeam({ role: 'read_only' })] }));
  t.after(h.restore);
  assert.equal(byId(teamItems(), 'team:new'), undefined, 'a read-only member is not offered New message');
  const saved = globalThis.rendererTeamExport;
  globalThis.rendererTeamExport = { getExporter: () => ({ running: () => true }) };
  try { assert.deepEqual(teamItems().filter((item) => item.id.startsWith('team:export')), [], 'one running: no export actions'); } finally { globalThis.rendererTeamExport = saved; }
});

// Row 150 slice B5: boards by name, from a module that loads on demand and only with `project_boards` on.
const BOARD_SRC = 'renderer/features/board/board-palette.js';
function boardHarness({ flag = true, loaded = true, boards = [{ id: 'board_a', name: 'Auth redesign' }, { id: 'board_b', name: 'Launch plan' }] } = {}) {
  const reads = [];
  const scripts = [];
  const views = [];
  const memory = new Map();
  const palette = require('../renderer/features/board/board-palette');
  palette.reset();
  const globalRef = {
    jennyShell: { boards: { list: (request) => { reads.push(request); return Promise.resolve({ ok: true, boards }); } } },
    localStorage: { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v) },
    scriptLoaderUtils: { ensureScript: ({ src, isReady }) => { scripts.push(src); if (src.endsWith('board-layout-store.js')) globalRef.rendererBoardLayoutStore = require('../renderer/features/board/board-layout-store'); return Promise.resolve(isReady()); } },
  };
  if (loaded) globalRef.rendererBoardPalette = palette;
  const getProjectSwitcher = async () => ({ currentProject: () => ({ id: 'project_alpha' }) });
  const callbacks = { setActiveView: (id) => views.push(['view', id]), focusDestinationView: (id) => views.push(['focus', id]), getProjectSwitcher };
  const providers = createPaletteProviders({ state: { ui: {}, sessions: [], features: { featureFlags: { project_boards: flag } } }, globalRef, callbacks });
  const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  return { providers, reads, scripts, views, memory, palette, settle, rows: () => providers.snapshot().filter((item) => item.id.startsWith('board:')) };
}

test('board rows: with the flag off nothing is listed, requested or read', async () => {
  const cold = boardHarness({ flag: false, loaded: false });
  assert.deepEqual(cold.rows(), []);
  assert.deepEqual(cold.scripts, [], 'the module is not even requested');
  const warm = boardHarness({ flag: false });
  assert.deepEqual(warm.rows(), []);
  await warm.settle();
  assert.deepEqual(warm.reads, [], 'nothing was read for the list');
  assert.deepEqual(rowsOf(warm.providers.snapshot()), rowsOf(createPaletteProviders({ state: { ui: {}, sessions: [] }, globalRef: {} }).snapshot()), 'the palette is exactly as without boards');
});

test('board rows: the first open with the flag on asks for the module and lists nothing; later opens list the project\'s boards by name', async () => {
  const cold = boardHarness({ loaded: false });
  assert.deepEqual(cold.rows(), []);
  assert.deepEqual(cold.scripts, [BOARD_SRC], 'the loader is asked for the one module');
  assert.deepEqual(cold.reads, [], 'nothing is read before the module is there');
  const h = boardHarness();
  assert.deepEqual(h.rows(), [], 'the first snapshot has no rows: the read starts now');
  await h.settle();
  assert.deepEqual(h.reads, [{ projectId: 'project_alpha' }], 'the current project\'s boards are read once');
  const rows = h.rows();
  assert.deepEqual(rows.map((row) => row.label), ['Auth redesign', 'Launch plan']);
  assert.deepEqual([rows[0].id, rows[0].group, rows[0].tag, rows[0].queryOnly], ['board:board_a', 'Boards', 'Board', true], 'typed only, in a group of its own');
  const others = h.providers.snapshot().filter((item) => !item.id.startsWith('board:'));
  assert.deepEqual(rowsOf(others), rowsOf(createPaletteProviders({ state: { ui: {}, sessions: [] }, globalRef: {} }).snapshot()), 'every other row is as before');
});

test('board rows: choosing one saves it as the project\'s open board and moves to the Board view', async () => {
  const h = boardHarness({ boards: [{ id: 'board_a', name: 'A <img src=x onerror=1>' }] });
  h.providers.snapshot();
  await h.settle();
  const [row] = h.rows();
  assert.equal(row.label, 'A <img src=x onerror=1>', 'a name stays a plain string');
  row.run();
  await h.settle();
  const { OPEN_KEY } = require('../renderer/features/board/board-layout-store');
  assert.deepEqual(JSON.parse(h.memory.get(OPEN_KEY)), { project_alpha: 'board_a' });
  assert.deepEqual(h.views, [['view', 'board'], ['focus', 'board']]);
});

// Row 175 F1: each listed project conversation of an online team, typed only, with its project's name; picking opens it.
test('row 175: project conversations are typed-only Team rows with the project name beside them; picking one opens it in the tab', async (t) => {
  const projects = require('./helpers/team-project-renderer-host');
  const { h } = await projects.openProjects();
  t.after(h.restore);
  const rows = teamItems().filter((item) => item.id.startsWith('team:conv:'));
  assert.deepEqual(rows.map((item) => [item.label, item.description, item.tag, item.queryOnly, item.landing]), [
    ['Palette loader cleanup', 'jenny-site', 'Project', true, undefined], ['Blog post draft', 'jenny-site', 'Project', true, undefined],
    ['Contrast checker', 'palette-tools', 'Project', true, undefined]]);
  assert.deepEqual(rows[0].scopes, ['chats']);
  rows[1].run();
  await projects.flush();
  assert.equal(require('../renderer/team/renderer-team-notify').shownFrame().channelId, 'conv:' + projects.S2);
});

test('row 175: at most 200 project conversation rows in all', async (t) => {
  const projects = require('./helpers/team-project-renderer-host');
  const many = Array.from({ length: 250 }, (_v, i) => projects.conversation('sess_' + String(i).padStart(32, '0'), projects.P1, 'Talk ' + i));
  const { h } = await projects.openProjects({ list: projects.listAnswer({ conversations: many }) });
  t.after(h.restore);
  assert.equal(teamItems().filter((item) => item.id.startsWith('team:conv:')).length, 200);
});

// Row 201 C10.3: from a project conversation, "Export this conversation" names it and exports that conversation, never #team.
test('row 201: Export this conversation from a project conversation names it and exports it; a project page offers none', async (t) => {
  const projects = require('./helpers/team-project-renderer-host');
  const { h } = await projects.openProjects();
  t.after(h.restore);
  h.view.qa('[data-team-tab-action="conv-open"]')[1].click();
  await projects.flush();
  const exporter = globalThis.rendererTeamExport.getExporter();
  const started = [];
  const real = exporter.start;
  exporter.start = (options) => { started.push(options); return Promise.resolve(false); };
  t.after(() => { exporter.start = real; });
  const one = byId(teamItems(), 'team:export-one');
  assert.equal(one.description, 'Blog post draft', 'a human name, never #conv:sess_…');
  assert.equal(byId(teamItems(), 'team:search').description, 'Blog post draft');
  one.run();
  await projects.flush();
  assert.deepEqual(started.map((o) => [o.teamId, o.scope, o.channelId]), [[projects.OTHER, 'one', 'conv:' + projects.S2]]);
  h.view.qa('[data-team-tab-action="project-open"]')[0].click();
  await projects.flush();
  assert.equal(byId(teamItems(), 'team:export-one'), undefined, 'nothing to export on a project page');
  assert.equal(byId(teamItems(), 'team:search').description, 'jenny-site', 'the project by its name');
});

// Row 201 (OD-8): a project channel's palette row is named by its project, through the channels module's one resolver.
test('row 201: a project channel is listed in the palette by its project\'s name, never its id', async (t) => {
  const projects = require('./helpers/team-project-renderer-host');
  const { h } = await projects.openProjects();
  t.after(h.restore);
  const row = byId(teamItems(), 'team:chan:' + projects.OTHER + ':chan_' + projects.P1);
  assert.equal(row.label, '#jenny-site');
});
