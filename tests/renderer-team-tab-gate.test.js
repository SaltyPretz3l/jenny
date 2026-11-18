'use strict';

// Team tab gate (row 123, slice 1g-2): the rail tab exists only with the `team` flag on and a
// joined or hosted team, through the real top rail, top-nav shell, gate, shared store and app
// shortcuts over a stubbed `window.jennyShell.team`. Also the tab's count, Ctrl+6, "joining ends in
// the tab", and the real view switch (lifecycle navigation and the chrome pipeline's renderLayout).

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, OTHER, MAYA, CHAN, flush, micro, snapshot, memberTeam, hostState, ROSTER, harness, shell, chatChannel, overview } = require('./helpers/team-settings-harness');

const manifest = () => require('../renderer/shell/renderer-settings-script-manifest');
const srcs = (...lists) => lists.flatMap((list) => list.map(([src]) => src));
const BASE = ['home', 'chat', 'ide'];
const WITH_TEAM = ['home', 'chat', 'ide', 'team'];
const TAB_SCRIPT = 'renderer/team/renderer-team-tab.js';

test('flag off: no tab, no team script (not even the gate), no team call and no listener', async (t) => {
  const h = harness({ show: false, host: hostState(), teams: [snapshot()] });
  t.after(h.restore);
  const s = shell(h, { flag: false });
  await flush();
  assert.deepEqual(s.tabs(), BASE);
  assert.deepEqual(s.requested, []);
  assert.deepEqual(h.calls, []);
  assert.equal(h.listeners.state, null);
  assert.equal(h.listeners.host, null);
  assert.equal(s.controller.isTeamTabAvailable(), false);
  assert.equal(s.controller.openTeamView(), false);
});

test('flag on, team data on disk but no team and nothing deployed: the tab is there, one status and one hostStatus, only the gate and the store load', async (t) => {
  const h = harness({ show: false });
  t.after(h.restore);
  const s = shell(h);
  await flush();
  assert.deepEqual(s.tabs(), WITH_TEAM, 'row 168: the tab opens on the start page');
  assert.deepEqual(h.methods(), ['hostStatus', 'status']);
  assert.deepEqual(s.requested, srcs(manifest().teamGate, manifest().teamStore));
  assert.equal(h.window.document.querySelector('link[rel="stylesheet"]'), null);
  // Slice 2c: the files modules ride in the lazy Team tab list, so with no membership neither loads.
  for (const src of ['renderer/team/renderer-team-files.js', 'renderer/team/renderer-team-attach.js']) assert.ok(srcs(manifest().teamTab).includes(src) && !s.requested.includes(src), src);
});

for (const [name, options] of [['a joined team', { teams: [memberTeam()] }], ['a team deployed on this PC', { host: hostState({ state: 'stopped' }) }]]) {
  test(`${name}: the Team tab sits last, after Workspace, and the view's scripts wait until it opens`, async (t) => {
    const h = harness({ show: false, ...options });
    t.after(h.restore);
    const s = shell(h);
    await flush();
    assert.deepEqual(s.tabs(), WITH_TEAM);
    const tab = s.teamTab();
    assert.equal(tab.getAttribute('role'), 'tab');
    assert.equal(tab.getAttribute('aria-controls'), 'teamView');
    assert.equal(tab.querySelector('.toprail-tab__label').textContent, 'Team');
    // A membership also loads the chat store (the tab's number counts mentions, slice 2a-5a); a deployed host alone does not.
    const chat = options.teams ? srcs(manifest().teamChat) : [];
    assert.deepEqual(s.requested, srcs(manifest().teamGate, manifest().teamStore).concat(chat));
    assert.equal(h.sent('inviteList').length + h.sent('auditRead').length, 0);
    assert.equal(h.sent('status').length, 1, 'one reader for status: the store');
    assert.equal(h.sent('hostStatus').length, 1);
  });
}

test('the boot seed has no team key: no tab, no script and no call until the real flags merge, then the tab appears', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  const s = shell(h, { flag: null, resolved: false });
  await flush();
  assert.deepEqual(s.tabs(), BASE);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(s.requested, []);
  s.state.features = { featureFlags: { team: true }, availabilityResolved: true };
  s.controller.applyViewChrome();
  await flush();
  assert.deepEqual(s.tabs(), WITH_TEAM);
  assert.equal(s.requested[0], manifest().teamGate[0][0], 'the gate is the first team script, loaded through the script loader');
});

test('the last team removed: the tab stays and the open Team view shows the start page; a deployed host shows its state', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  const s = shell(h);
  await flush();
  s.press('6');
  await flush();
  assert.equal(s.state.ui.activeView, 'team');
  h.listeners.state({ teams: [] });
  await flush();
  assert.deepEqual(s.tabs(), WITH_TEAM);
  assert.equal(s.state.ui.activeView, 'team');
  assert.ok(h.view.q('.team-start'), 'the start page');
  h.listeners.host(hostState({ state: 'stopped' }));
  await flush();
  assert.equal(h.view.q('.team-start'), null);
  assert.equal(h.view.q('.team-srv h2').textContent, 'Studio', 'the stopped server page');
  assert.equal(h.view.q('.team-state'), null);
});

test('a saved team view with no team shows the start page once the answer is known', async (t) => {
  const h = harness({ show: false });
  t.after(h.restore);
  const s = shell(h, { activeView: 'team' });
  await flush();
  assert.equal(s.state.ui.activeView, 'team');
  assert.ok(s.requested.includes(TAB_SCRIPT));
  assert.ok(h.view.q('.team-start'));
});

test('a saved team view with the flag off shows Chat', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  const s = shell(h, { flag: false, activeView: 'team' });
  await flush();
  assert.equal(s.state.ui.activeView, 'chat');
  assert.deepEqual(h.calls, []);
});

test('a saved team view with a team opens the view: its scripts and stylesheets load once', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  const s = shell(h, { activeView: 'team' });
  await flush();
  assert.equal(s.state.ui.activeView, 'team');
  for (const [src] of manifest().teamTab) assert.ok(s.requested.includes(src), `${src} loaded`);
  assert.match(h.view.text(), /Dot lab/);
  s.controller.applyViewChrome();
  await flush();
  const doc = h.window.document;
  assert.equal(doc.querySelectorAll('link[rel="stylesheet"][href="styles/team-tab.css"]').length, 1);
  assert.equal(doc.querySelectorAll('link[rel="stylesheet"][href="styles/team-settings.css"]').length, 1);
});

// ------------------------------------------------- calls and loads that fail

test('a status that never answers: a saved Team view waits blank, then shows the start page when the call times out', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = harness({ show: false, answers: { status: () => new Promise(() => {}) } });
  t.after(h.restore);
  const s = shell(h, { activeView: 'team' });
  await micro();
  assert.equal(s.state.ui.activeView, 'team', 'not decided yet');
  assert.equal(h.view.q('.team-start, .team-state'), null, 'nothing is said before the answer');
  t.mock.timers.tick(10_000);
  await micro();
  assert.equal(s.state.ui.activeView, 'team');
  assert.deepEqual(s.tabs(), WITH_TEAM);
  assert.ok(h.view.q('.team-start'));
});

test('a failed load of the view scripts goes back to Chat, and the next open tries again', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  const s = shell(h);
  await flush();
  s.failing.add(TAB_SCRIPT);
  s.press('6');
  await flush();
  assert.equal(s.state.ui.activeView, 'chat', 'no blank Team view');
  assert.equal(h.teamView.innerHTML, '');
  assert.deepEqual(s.tabs(), WITH_TEAM, 'the tab is still there');
  const tries = s.requested.filter((src) => src === TAB_SCRIPT).length;
  s.failing.clear();
  s.press('6');
  await flush();
  assert.equal(s.requested.filter((src) => src === TAB_SCRIPT).length, tries + 1);
  assert.equal(s.state.ui.activeView, 'team');
  assert.match(h.view.text(), /Dot lab/);
});

test('a failed load of the gate script: no tab, a saved Team view shows Chat, and render passes do not retry', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  const gate = manifest().teamGate[0][0];
  const s = shell(h, { activeView: 'team', failing: [gate] });
  await flush();
  assert.equal(s.state.ui.activeView, 'chat');
  assert.deepEqual(s.tabs(), BASE);
  s.controller.applyViewChrome();
  s.controller.syncTeamTab();
  await flush();
  assert.equal(s.requested.filter((src) => src === gate).length, 1);
  s.failing.clear();
  assert.equal(s.press('6').defaultPrevented, false, 'Ctrl+6 does nothing yet, and asks for the gate again');
  await flush();
  assert.deepEqual(s.tabs(), WITH_TEAM);
});

// -------------------------------------------------------------------- keys

test('Ctrl+6 and Ctrl+Alt+6 open Team with the flag on, team or not; Ctrl+1..5 keep their views', async (t) => {
  const h = harness({ show: false });
  t.after(h.restore);
  const s = shell(h);
  await flush();
  assert.equal(s.press('6').defaultPrevented, true, 'no team: the start page');
  assert.equal(s.state.ui.activeView, 'team');
  s.press('2');
  assert.equal(s.press('6', { alt: true }).defaultPrevented, true);
  assert.equal(s.state.ui.activeView, 'team');
  s.press('2');
  h.listeners.state({ teams: [memberTeam()] });
  await flush();
  assert.equal(s.press('6').defaultPrevented, true);
  assert.equal(s.state.ui.activeView, 'team');
  s.press('2');
  assert.equal(s.state.ui.activeView, 'chat');
  assert.equal(s.press('6', { alt: true }).defaultPrevented, true);
  assert.equal(s.state.ui.activeView, 'team');
  const order = ['home', 'chat', 'ide', 'logs', 'settings'];
  order.forEach((view, index) => {
    s.press(String(index + 1));
    assert.equal(s.state.ui.activeView, view, `Ctrl+${index + 1}`);
  });
  assert.equal(h.window.document.getElementById('settingsTopRailTab').getAttribute('title'), 'Settings (Ctrl+5)');
});

// ------------------------------------------------------------------- count

for (const [action, method] of [['admit', 'memberAdmit'], ['decline', 'memberRevoke']]) {
  test(`count: one person waiting on a team you own shows 1 with its text label, and clears after ${action}`, async (t) => {
    let done = false;
    const after = action === 'admit' ? ROSTER.map((member) => ({ ...member, state: 'active' })) : ROSTER.filter((member) => member.member_id !== MAYA);
    const h = harness({ show: false, host: hostState(), teams: [snapshot()], answers: {
      [method]: () => { done = true; return { ok: true }; },
      members: () => ({ ok: true, team: { team_id: TEAM, name: 'Studio' }, members: done ? after : ROSTER }),
    } });
    t.after(h.restore);
    const s = shell(h);
    await flush();
    const tab = s.teamTab();
    assert.equal(s.count(), '1');
    assert.equal(tab.getAttribute('aria-label'), 'Team: 1 person wants to join');
    assert.equal(tab.querySelector('.toprail-tab__count').getAttribute('aria-hidden'), 'true');
    s.press('6');
    await flush();
    // A view switch redraws the rail (as it always has); the count survives it.
    const shown = s.teamTab();
    assert.equal(s.count(), '1');
    assert.equal(shown.getAttribute('aria-label'), 'Team: 1 person wants to join');
    h.view.q(`[data-team-action="${action}"]`).click();
    await flush();
    assert.equal(h.sent(method).length, 1);
    assert.equal(s.count(), '');
    assert.equal(s.teamTab().getAttribute('aria-label'), null);
    assert.equal(s.teamTab(), shown, 'the count is patched in place, the rail is not rebuilt');
  });
}

test('count: two people waiting use the plural label', async (t) => {
  const two = ROSTER.concat([{ ...ROSTER[2], member_id: 'member_lena', display_name: 'Lena' }]);
  const h = harness({ show: false, host: hostState(), teams: [snapshot()], answers: { members: { ok: true, members: two } } });
  t.after(h.restore);
  const s = shell(h);
  await flush();
  assert.equal(s.count(), '2');
  assert.equal(s.teamTab().getAttribute('aria-label'), 'Team: 2 people want to join');
});

test('count: a member of someone else\'s team never sees one, and no roster is read for it', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()], answers: { members: { ok: true, members: ROSTER } } });
  t.after(h.restore);
  const s = shell(h);
  await flush();
  assert.equal(s.count(), '');
  assert.equal(s.teamTab().getAttribute('aria-label'), null);
  assert.equal(h.sent('members').length, 0);
});

// ------------------------------------------------- chat (slice 2a-5a, E39)

const chatSrcs = () => srcs(manifest().teamChat);
const chatCalls = (h) => h.calls.filter((call) => String(call.method).startsWith('chat'));

test('flag off, or no membership: no chat script is asked for and no chat call is made', async (t) => {
  for (const [flag, options] of [[false, { teams: [memberTeam()] }], [true, {}], [true, { host: hostState({ state: 'stopped' }) }]]) {
    const h = harness({ show: false, ...options });
    const s = shell(h, { flag });
    await flush();
    assert.equal(chatSrcs().some((src) => s.requested.includes(src)), false, `flag ${flag}: no chat script`);
    assert.deepEqual(chatCalls(h), []);
    assert.equal(h.listeners.chat, null);
    h.restore();
  }
  t.diagnostic('flag off, no team, and a deployed host with no membership');
});

test('count: mentions in two teams plus two people waiting read 4, both parts in the label and tooltip; a pending team is never asked', async (t) => {
  const two = ROSTER.concat([{ ...ROSTER[2], member_id: 'member_lena', display_name: 'Lena' }]);
  const h = harness({ show: false, host: hostState(), teams: [snapshot(), memberTeam(), memberTeam({ team_id: 'team_PENDING', state: 'pending' })], answers: {
    members: { ok: true, members: two },
    chatOverview: overview({ channels: [chatChannel({ mention: true, unread: 3 })] }),
  } });
  t.after(h.restore);
  const s = shell(h);
  await flush();
  assert.equal(s.count(), '4');
  const label = 'Team: 2 channels mention you, 2 people want to join';
  assert.equal(s.teamTab().getAttribute('aria-label'), label);
  assert.equal(s.teamTab().getAttribute('title'), label);
  assert.deepEqual(h.sent('chatOverview').map((call) => call.payload.team_id).sort(), [TEAM, OTHER].sort());
  assert.ok(chatSrcs().every((src) => s.requested.includes(src)), 'the chat store loads with the gate');
  assert.equal(s.requested.includes(TAB_SCRIPT), false, 'the tab itself is still closed');
  const before = s.teamTab();
  h.listeners.chat({ team_id: OTHER, type: 'channels', partial: true, channels: [chatChannel({ mention: false, unread: 1 })] });
  await flush();
  assert.equal(s.state.ui.activeView, 'chat');
  assert.equal(s.count(), '3', 'changes while the Team tab is closed');
  assert.equal(s.teamTab().getAttribute('aria-label'), 'Team: 1 channel mentions you, 2 people want to join');
  assert.equal(s.teamTab(), before, 'patched in place');
});

test('count: mentions alone use their own label; zero draws nothing', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()], answers: { chatOverview: overview({ channels: [chatChannel({ mention: true, unread: 1 })] }) } });
  t.after(h.restore);
  const s = shell(h);
  await flush();
  assert.equal(s.count(), '1');
  assert.equal(s.teamTab().getAttribute('aria-label'), 'Team: 1 channel mentions you');
  h.listeners.chat({ team_id: OTHER, type: 'channels', channels: [chatChannel({ channel_id: CHAN })] });
  await flush();
  assert.equal(s.count(), '');
  assert.equal(s.teamTab().getAttribute('aria-label'), null);
  assert.equal(s.teamTab().getAttribute('title'), null);
});

test('a rail rebuild for the tab keeps keyboard focus on the focused tab', async (t) => {
  const h = harness({ show: false });
  t.after(h.restore);
  shell(h);
  await flush();
  const doc = h.window.document;
  doc.getElementById('chatTopRailTab').focus();
  h.listeners.state({ teams: [memberTeam()] });
  await flush();
  assert.equal(doc.activeElement, doc.getElementById('chatTopRailTab'));
});

// -------------------------------------------------------------------- join

test('after a successful Join on the Settings Team page the active view becomes team', async (t) => {
  let joined = false;
  const h = harness({ answers: {
    join: () => { joined = true; return { ok: true }; },
    status: () => ({ ok: true, teams: joined ? [memberTeam({ state: 'pending' })] : [] }),
  } });
  t.after(h.restore);
  const s = shell(h, { activeView: 'settings' });
  await flush();
  assert.deepEqual(s.tabs(), WITH_TEAM);
  h.type('#teamYourName', 'Olive');
  h.type('#teamPcName', 'Desk');
  h.type('#teamInviteCode', 'jteam1_SOMEINVITE');
  h.click('[data-team-action="join"]');
  await flush();
  await flush();
  assert.equal(h.sent('join').length, 1);
  assert.deepEqual(s.tabs(), WITH_TEAM);
  assert.equal(s.state.ui.activeView, 'team');
  assert.match(h.view.text(), /Waiting to be let in/);
});

test('a failed Join stays on Settings', async (t) => {
  const h = harness({ answers: { join: { ok: false, error: { code: 'CMP-TEAM-0003', reason: 'team_invite_malformed' } } } });
  t.after(h.restore);
  const s = shell(h, { activeView: 'settings' });
  await flush();
  h.type('#teamYourName', 'Olive');
  h.type('#teamPcName', 'Desk');
  h.type('#teamInviteCode', 'jteam1_SOMEINVITE');
  h.click('[data-team-action="join"]');
  await flush();
  assert.equal(s.state.ui.activeView, 'settings');
});

// -------------------------------- the real view switch (navigation + layout)

const panelState = (h) => ({ offscreen: h.teamView.classList.contains('view-offscreen'), active: h.teamView.classList.contains('active-view'),
  inert: h.teamView.inert === true, hidden: h.teamView.getAttribute('aria-hidden') });
const OFF = { offscreen: true, active: false, inert: true, hidden: 'true' };
const ON = { offscreen: false, active: true, inert: false, hidden: 'false' };

test('layout: the Team panel is on screen, live and exposed only while the Team view is active', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  const s = shell(h, { layout: true });
  await flush();
  assert.deepEqual(panelState(h), OFF);
  s.press('6');
  await flush();
  assert.equal(s.state.ui.activeView, 'team');
  assert.deepEqual(panelState(h), ON);
  assert.deepEqual(s.persisted, ['team'], 'team is a view that is saved');
  s.press('2');
  assert.deepEqual(panelState(h), OFF);
});

test('layout: a saved Team view with no team stays, on screen and in what is saved', async (t) => {
  const h = harness({ show: false });
  t.after(h.restore);
  const s = shell(h, { activeView: 'team', layout: true });
  await flush();
  assert.equal(s.state.ui.activeView, 'team');
  assert.deepEqual(s.persisted, []);
  assert.deepEqual(panelState(h), ON);
  assert.ok(h.view.q('.team-start'));
});

test('layout: the flag going off while the Team view is open ends in Chat from a layout pass alone', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  const s = shell(h, { activeView: 'team', layout: true });
  await flush();
  assert.deepEqual(panelState(h), ON);
  assert.match(h.view.text(), /Dot lab/);
  s.state.features = { featureFlags: { team: false }, availabilityResolved: true };
  s.renderLayout(); // no chrome pass: the layout asks the shell first
  assert.equal(s.state.ui.activeView, 'chat');
  assert.deepEqual(s.persisted, ['chat']);
  assert.deepEqual(panelState(h), OFF);
  assert.deepEqual(s.tabs(), BASE);
  assert.equal(h.listeners.state, null, 'and the team listeners are gone');
});

test('layout: with the flags not resolved yet a saved Team view is kept, then decided by the real flags', async (t) => {
  for (const team of [true, false]) {
    const h = harness({ show: false, teams: [memberTeam()] });
    const s = shell(h, { flag: null, resolved: false, activeView: 'team', layout: true });
    await flush();
    assert.equal(s.state.ui.activeView, 'team', 'not thrown away on the boot seed');
    assert.deepEqual(s.persisted, []);
    assert.deepEqual(h.calls, []);
    s.state.features = { featureFlags: { team }, availabilityResolved: true };
    s.renderLayout();
    await flush();
    assert.equal(s.state.ui.activeView, team ? 'team' : 'chat');
    assert.deepEqual(panelState(h), team ? ON : OFF);
    if (team) assert.match(h.view.text(), /Dot lab/);
    h.restore();
  }
  t.diagnostic('both flag outcomes checked');
});

test('the flag going off drops what the chat store holds; on again asks the overview again', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()], answers: { chatOverview: overview({ channels: [chatChannel({ mention: true, unread: 1 })] }) } });
  t.after(h.restore);
  const s = shell(h);
  await flush();
  assert.equal(s.count(), '1');
  assert.equal(h.sent('chatOverview').length, 1);
  s.state.features = { featureFlags: { team: false }, availabilityResolved: true };
  s.controller.applyViewChrome();
  await flush();
  assert.equal(h.chat.team(OTHER), null, 'nothing kept while the flag is off');
  assert.equal(h.listeners.chat, null);
  s.state.features = { featureFlags: { team: true }, availabilityResolved: true };
  s.controller.applyViewChrome();
  await flush();
  assert.equal(h.sent('chatOverview').length, 2, 'asked again');
  assert.equal(s.count(), '1');
  assert.equal(typeof h.listeners.chat, 'function', 'subscribed again');
});

// ------------------------------------------------------------------ presence (2a-5b)

const presence = () => require('../renderer/team/renderer-team-presence');
const IDLE_MS = 10 * 60 * 1000;
// A window and a team store for the presence reporter alone: the calls it makes and its listeners.
function presenceRig(teams) {
  const calls = [];
  const added = [];
  const removed = [];
  const subscribers = new Set();
  const win = new EventTarget();
  const add = win.addEventListener.bind(win);
  const remove = win.removeEventListener.bind(win);
  win.addEventListener = (type, fn, options) => { added.push([type, options]); add(type, fn, options); };
  win.removeEventListener = (type, fn, options) => { removed.push(type); remove(type, fn, options); };
  const rig = { teams, calls, added, removed, subscribers, win };
  rig.store = { snapshot: () => ({ teams: rig.teams }), call: (method, payload) => { calls.push([method, payload]); return Promise.resolve({ ok: true }); },
    subscribe: (fn) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; } };
  rig.input = (type = 'keydown') => win.dispatchEvent(new Event(type));
  return rig;
}

test('presence: idle once after 10 minutes without input, active once when input comes back, only for connected teams', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const rig = presenceRig([snapshot(), memberTeam({ state: 'offline' }), memberTeam({ team_id: 'team_P', state: 'pending' })]);
  const reporter = presence().createPresence({ windowRef: rig.win, store: rig.store });
  t.after(() => reporter.stop());
  assert.ok(rig.added.length > 0 && rig.added.every(([, options]) => options && options.passive === true), 'passive listeners');
  rig.input();
  assert.deepEqual(rig.calls, [], 'already active: nothing to say');
  t.mock.timers.tick(IDLE_MS - 1);
  assert.deepEqual(rig.calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(rig.calls, [['presenceSet', { team_id: TEAM, state: 'idle' }]], 'only the connected team');
  t.mock.timers.tick(IDLE_MS);
  assert.equal(rig.calls.length, 1, 'one call per transition');
  rig.input('pointerdown');
  rig.input('keydown');
  assert.deepEqual(rig.calls.slice(1), [['presenceSet', { team_id: TEAM, state: 'active' }]]);
  t.mock.timers.tick(IDLE_MS - 60_000);
  rig.input();
  t.mock.timers.tick(IDLE_MS - 60_000);
  assert.equal(rig.calls.length, 2, 'input keeps it active');
});

test('presence: nothing for a team that is not connected; listeners and timer gone after stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const rig = presenceRig([memberTeam({ state: 'reconnecting' }), memberTeam({ team_id: 'team_R', state: 'revoked' })]);
  const reporter = presence().createPresence({ windowRef: rig.win, store: rig.store });
  t.mock.timers.tick(IDLE_MS);
  rig.input();
  assert.deepEqual(rig.calls, []);
  reporter.stop();
  assert.equal(rig.removed.length, rig.added.length, 'every listener removed');
  assert.equal(rig.subscribers.size, 0);
  rig.teams = [snapshot()];
  t.mock.timers.tick(IDLE_MS * 2);
  rig.input();
  assert.deepEqual(rig.calls, [], 'nothing after stop');
});

test('the gate starts presence with the chat store and stops it when the flag goes off', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  let started = 0;
  let stopped = 0;
  h.window.rendererTeamPresence = { createPresence: () => { started += 1; return { stop: () => { stopped += 1; } }; } };
  t.after(() => { delete h.window.rendererTeamPresence; });
  const s = shell(h);
  await flush();
  assert.ok(srcs(manifest().teamChat).includes('renderer/team/renderer-team-presence.js'), 'loaded with the chat store');
  assert.equal(started, 1);
  s.state.features = { featureFlags: { team: false }, availabilityResolved: true };
  s.controller.applyViewChrome();
  await flush();
  assert.equal(stopped, 1);
});

test('presence: a refused report is told again on the next store change, once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const rig = presenceRig([snapshot()]);
  let refuse = true;
  rig.store.call = (method, payload) => { rig.calls.push([method, payload]); return Promise.resolve(refuse ? { ok: false, error: { code: '', reason: 'team_not_connected' } } : { ok: true }); };
  const reporter = presence().createPresence({ windowRef: rig.win, store: rig.store });
  t.after(() => reporter.stop());
  t.mock.timers.tick(IDLE_MS);
  assert.equal(rig.calls.length, 1);
  for (let i = 0; i < 3; i += 1) await null;
  refuse = false;
  const change = () => { for (const fn of [...rig.subscribers]) fn(); };
  change();
  assert.deepEqual(rig.calls.slice(1), [['presenceSet', { team_id: TEAM, state: 'idle' }]], 'told again');
  for (let i = 0; i < 3; i += 1) await null;
  change();
  t.mock.timers.tick(IDLE_MS);
  assert.equal(rig.calls.length, 2, 'once, and never on a timer');
});

// E50: with the flag on and no team data on disk (main's `teamData: false`) nothing team-related loads until the
// Team tab is opened (row 168: a saved Team view opens it); then the start page asks main nothing.
test('E50 no team data on disk: the tab is there; a saved Team view loads the tab quietly: no call, no listener', async (t) => {
  const h = harness({ show: false });
  t.after(h.restore);
  const s = shell(h, { teamData: false, activeView: 'team' });
  await flush();
  assert.equal(s.state.ui.activeView, 'team');
  assert.deepEqual(s.tabs(), WITH_TEAM);
  assert.ok(s.requested.includes(TAB_SCRIPT) && h.view.q('.team-start'));
  assert.equal(s.controller.openTeamView(), true);
  await flush();
  assert.deepEqual(h.calls, []);
  assert.equal(h.listeners.state, null);
  assert.equal(h.listeners.host, null);
});

test('E50 no team data: the first join (openTeamView with wait) loads and starts the gate, and the tab appears and opens', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  const s = shell(h, { teamData: false, activeView: 'settings' });
  await flush();
  assert.equal(s.controller.openTeamView({ wait: true }), true, 'row 168: the view opens at once; the gate loads for it');
  await flush();
  assert.deepEqual(s.requested.slice(0, 2), srcs(manifest().teamGate, manifest().teamStore));
  assert.deepEqual(h.methodNames().filter((m) => m === 'hostStatus' || m === 'status'), ['hostStatus', 'status']);
  assert.deepEqual(s.tabs(), WITH_TEAM);
  assert.equal(s.state.ui.activeView, 'team');
});

test('E50 team data on disk: a join that ends in the tab while the gate is still loading opens it once the gate is there', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  const s = shell(h, { teamData: true, activeView: 'settings' });
  assert.equal(s.controller.openTeamView({ wait: true }), true, 'the gate is still loading: row 168 opens the view at once');
  await flush();
  assert.equal(s.state.ui.activeView, 'team');
});
