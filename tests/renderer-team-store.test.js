'use strict';

// The shared team store (row 123, slice 1g-2): one instance per window behind the Settings Team
// page and the Team tab. It outlives the Settings page, keeps list reads single-flight, reads
// invites and the log only for a consumer that asks, never lets an older answer undo a push, bounds
// every bridge call, forgets a roster with the right to see it, and re-reads rosters on one timer
// (20 s for the team the Team view shows, 60 s for the owned hosted team, never while hidden).

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, OTHER, CODE, flush, pushed, micro, snapshot, memberTeam, hostState, NONE, ROSTER, harness } = require('./helpers/team-settings-harness');

const FAILED = { ok: false, error: { code: 'CMP-TEAM-0001', reason: '' } };

test('Settings and the tab share one store, and leaving Settings does not reset it', async (t) => {
  const h = harness({ host: hostState(), teams: [snapshot()] });
  t.after(h.restore);
  h.showTab();
  await flush();
  const storeModule = require('../renderer/team/renderer-team-store');
  assert.equal(storeModule.getTeamStore(), h.store);
  assert.match(h.text(), /Maya Okafor/);
  assert.match(h.view.text(), /Maya Okafor/);
  assert.ok(h.sent('inviteList').length >= 1 && h.sent('auditRead').length >= 1, 'Settings asked for the owner lists');
  h.section.leaveTeamSection();
  const data = h.store.snapshot();
  assert.equal(data.teams.length, 1);
  assert.equal(data.host.team_id, TEAM);
  assert.equal(data.lists[TEAM].roster.length, ROSTER.length);
  assert.equal(data.lists[TEAM].invites, undefined, 'the lists only Settings asked for are dropped with it');
  assert.equal(data.lists[TEAM].audit, undefined);
  assert.equal(typeof h.listeners.state, 'function', 'the pushes stay subscribed for the tab');
  const invites = h.sent('inviteList').length;
  h.listeners.state({ teams: [snapshot({ team_name: 'Renamed' })] });
  await pushed();
  assert.match(h.view.text(), /Renamed/);
  assert.equal(h.sent('inviteList').length, invites, 'and nothing reads invites for the tab');
  assert.equal(h.container.querySelector('#teamSettingsBody').innerHTML, '', 'the page left writes nothing');
});

// Fault: a needs_repair row with the hosted team's id read as the hosted team (by Settings or the tab).
test('a needs_repair row is never the hosted team', async (t) => {
  const h = harness({ host: hostState(), teams: [{ team_id: TEAM, state: 'needs_repair', reason: 'team_client_invalid' }] });
  t.after(h.restore);
  await flush();
  assert.equal(h.store.hostedTeam(), null);
});

test('with no consumer left the store drops its pushes and its timer', async (t) => {
  const h = harness({ host: hostState(), teams: [snapshot()] });
  t.after(h.restore);
  h.showTab();
  await flush();
  h.section.leaveTeamSection();
  h.tab.hideTeamTab();
  assert.equal(h.listeners.state, null);
  assert.equal(h.listeners.host, null);
  assert.equal(h.store._timerMs(), 0);
});

test('list reads are single-flight: requests during a run ask for exactly one more', async (t) => {
  const waiting = [];
  const h = harness({ show: false, host: hostState(), teams: [snapshot()], answers: {
    members: () => new Promise((resolve) => { waiting.push(() => resolve({ ok: true, members: ROSTER })); }) } });
  t.after(h.restore);
  h.showTab();
  await flush();
  assert.equal(h.sent('members').length, 1);
  void h.store.refreshLists();
  void h.store.refreshLists();
  void h.store.refreshLists();
  await flush();
  assert.equal(h.sent('members').length, 1, 'nothing starts while the first read is out');
  waiting.shift()();
  await flush();
  assert.equal(h.sent('members').length, 2, 'one more run for the three requests');
  waiting.shift()();
  await flush();
  assert.equal(h.sent('members').length, 2);
  assert.equal(waiting.length, 0);
});

test('the tab alone never reads invites, the log or devices', async (t) => {
  const h = harness({ show: false, host: hostState(), teams: [snapshot(), memberTeam()] });
  t.after(h.restore);
  h.showTab();
  await flush();
  h.listeners.state({ teams: [snapshot(), memberTeam()] });
  await pushed();
  assert.equal(h.sent('inviteList').length, 0);
  assert.equal(h.sent('auditRead').length, 0);
  assert.equal(h.sent('deviceList').length, 0);
  assert.deepEqual([...new Set(h.sent('members').map((call) => call.payload.team_id))].sort(), [TEAM, OTHER].sort());
});

test('a rejected call, a missing method and an answer with no ok all read as CMP-TEAM-0001', async (t) => {
  const h = harness({ show: false, answers: { members: () => Promise.reject(new Error('boom')), deviceList: 'nonsense' } });
  t.after(h.restore);
  assert.deepEqual(await h.store.call('members', { team_id: TEAM }), FAILED);
  assert.deepEqual(await h.store.call('deviceList', { team_id: TEAM }), FAILED);
  h.window.jennyShell = {};
  assert.deepEqual(await h.store.call('members', { team_id: TEAM }), FAILED);
});

// --------------------------------------------------------- answers and pushes

test('an older status or host answer does not overwrite a newer push', async (t) => {
  const waiting = { status: [], hostStatus: [] };
  const h = harness({ show: false, answers: {
    status: () => new Promise((resolve) => { waiting.status.push(resolve); }),
    hostStatus: () => new Promise((resolve) => { waiting.hostStatus.push(resolve); }),
  } });
  t.after(h.restore);
  t.after(h.store.use({ rosters: 'all' }));
  const run = h.store.refreshAll();
  await flush();
  // The member left and the server stopped while the two reads were out.
  h.listeners.state({ teams: [] });
  h.listeners.host(hostState({ state: 'stopped' }));
  waiting.status.shift()({ ok: true, teams: [memberTeam()] });
  waiting.hostStatus.shift()({ ok: true, host: hostState() });
  await run;
  assert.deepEqual(h.store.snapshot().teams, []);
  assert.equal(h.store.snapshot().host.state, 'stopped');
  assert.equal(h.sent('members').length, 0, 'and no roster is read for the team that is gone');
});

test('a seed counts like a push: an answer that started before it is dropped, a later one is taken', async (t) => {
  const waiting = [];
  const h = harness({ show: false, answers: { status: () => new Promise((resolve) => { waiting.push(resolve); }) } });
  t.after(h.restore);
  t.after(h.store.use({}));
  const first = h.store.refreshAll();
  await flush();
  h.store.seed({ teams: [memberTeam({ team_name: 'Seeded' })] });
  waiting.shift()({ ok: true, teams: [] });
  await first;
  assert.equal(h.store.snapshot().teams[0].team_name, 'Seeded');
  const second = h.store.refreshAll();
  await flush();
  waiting.shift()({ ok: true, teams: [memberTeam({ team_name: 'Read' })] });
  await second;
  assert.equal(h.store.snapshot().teams[0].team_name, 'Read');
});

test('an answer of the wrong shape is a failed read, and the tab keeps updating', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()], answers: {
    members: { ok: true, members: 'not a list' }, deviceList: { ok: true, devices: { length: 2 } }, inviteList: { ok: true, invites: 7 },
    hostStatus: { ok: true, host: 'running' },
  } });
  t.after(h.restore);
  t.after(h.store.use({ rosters: 'all', devices: true, ownerLists: true }));
  h.showTab();
  await flush();
  const lists = h.store.snapshot().lists[OTHER];
  assert.equal(lists.roster, undefined);
  assert.equal(lists.rosterRead.error.code, 'CMP-TEAM-0001');
  assert.equal(lists.devices, undefined);
  assert.equal(lists.invites, undefined);
  assert.equal(h.store.snapshot().host, null);
  assert.equal(h.view.q('.team-panel__title').textContent, 'Dot lab');
  h.listeners.state({ teams: [memberTeam({ team_name: 'Still alive' })] });
  await flush();
  assert.equal(h.view.q('.team-panel__title').textContent, 'Still alive', 'a bad roster answer did not stop the tab');
  h.listeners.state({ teams: 'nope' });
  h.listeners.state({ teams: [null, 4, { team_name: 'no id' }, memberTeam({ team_name: 'Only real one' })] });
  await flush();
  assert.deepEqual(h.store.snapshot().teams.map((team) => team.team_name), ['Only real one']);
});

for (const [name, next] of [['leaves the list', []], ['is revoked', [memberTeam({ state: 'revoked' })]], ['goes back to pending', [memberTeam({ state: 'pending' })]]]) {
  test(`a roster does not outlive the right to see it: the lists go when the team ${name}`, async (t) => {
    const h = harness({ show: false, teams: [memberTeam()] });
    t.after(h.restore);
    h.showTab();
    await flush();
    assert.equal(h.store.snapshot().lists[OTHER].roster.length, ROSTER.length);
    h.listeners.state({ teams: next });
    assert.equal(h.store.snapshot().lists[OTHER], undefined);
    assert.doesNotMatch(h.view.text(), /Olive Owner|Maya/);
  });
}

test('an offline team keeps the roster it read; coming back online reads it again', async (t) => {
  const h = harness({ show: false, teams: [memberTeam()] });
  t.after(h.restore);
  h.showTab();
  await flush();
  h.listeners.state({ teams: [memberTeam({ state: 'offline' })] });
  await pushed();
  assert.equal(h.store.snapshot().lists[OTHER].roster.length, ROSTER.length);
  assert.equal(h.sent('members').length, 1);
  h.listeners.state({ teams: [memberTeam()] });
  await pushed();
  assert.equal(h.sent('members').length, 2);
});

test('pushes are coalesced: several in a row start one list read, a quarter second after the last', async (t) => {
  const h = harness({ show: false, host: hostState(), teams: [snapshot(), memberTeam()] });
  t.after(h.restore);
  h.showTab();
  await flush();
  const before = h.sent('members').length;
  h.listeners.state({ teams: [snapshot(), memberTeam()] });
  h.listeners.host(hostState());
  h.listeners.state({ teams: [snapshot(), memberTeam({ team_name: 'Renamed' })] });
  await flush();
  assert.equal(h.sent('members').length, before, 'nothing is read at once');
  await pushed();
  assert.equal(h.sent('members').length, before + 2, 'one read per team for the three pushes');
});

// Two-PC findings, item B: the host controller re-sends an unchanged snapshot when the host's roster moved.
// Owner, 2026-11-16: main pushes on every bridge, node and GPU step, and a list read for each used up the host's limit.
test('a teams push with an unchanged snapshot re-reads the lists once after the settle time; more inside the gap share one read when it ends', async (t) => {
  const { h, tick } = timed(t, { host: hostState(), teams: [snapshot()] });
  h.showTab();
  await tick(0);
  const before = h.sent('members').length;
  h.listeners.state({ teams: [snapshot()] });
  await tick(249);
  assert.equal(h.sent('members').length, before, 'nothing is read before the settle time');
  await tick(1);
  assert.equal(h.sent('members').length, before + 1, 'one re-read for the unchanged push');
  for (let n = 0; n < 5; n += 1) { h.listeners.state({ teams: [snapshot()] }); await tick(300); }
  assert.equal(h.sent('members').length, before + 1, 'five unchanged pushes inside the gap: no read yet');
  await tick(3600); // the gap ends
  await tick(250);
  assert.equal(h.sent('members').length, before + 2, 'one read for the five, after the gap');
  h.listeners.state({ teams: [snapshot({ team_name: 'Renamed' })] });
  await tick(250);
  assert.equal(h.sent('members').length, before + 3, 'a team that changed is read for after the settle time, gap or not');
  h.listeners.host(hostState());
  await tick(250);
  assert.equal(h.sent('members').length, before + 3, 'the same host state inside the gap waits');
  h.listeners.host(hostState({ state: 'stopping' }));
  await tick(250);
  assert.equal(h.sent('members').length, before + 4, 'a host state that moved is read for after the settle time, gap or not');
});

test('showing the view re-reads the roster', async (t) => {
  const h = harness({ show: false, host: hostState(), teams: [snapshot()] });
  t.after(h.restore);
  h.showTab();
  await flush();
  const first = h.sent('members').length;
  h.tab.hideTeamTab();
  h.showTab();
  await flush();
  assert.equal(h.sent('members').length, first + 1);
});

// ------------------------------------------------------------------- timers

function timed(t, options) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = harness({ show: false, ...options });
  t.after(h.restore);
  let hidden = false;
  Object.defineProperty(h.window.document, 'hidden', { configurable: true, get: () => hidden });
  const setHidden = (value) => { hidden = value; h.window.document.dispatchEvent(new h.window.Event('visibilitychange')); };
  return { h, setHidden, tick: async (ms) => { t.mock.timers.tick(ms); await micro(); } };
}

test('a bridge call that never answers fails after 10 s; starting, stopping and joining get 60 s', async (t) => {
  const { h, tick } = timed(t, { answers: { members: () => new Promise(() => {}), join: () => new Promise(() => {}) } });
  const seen = {};
  void h.store.call('members', { team_id: TEAM }).then((answer) => { seen.members = answer; });
  void h.store.call('join', { invite: CODE, display_name: 'Dot', label: 'Desk' }).then((answer) => { seen.join = answer; });
  await tick(9_999);
  assert.equal(seen.members, undefined);
  await tick(1);
  assert.deepEqual(seen.members, FAILED);
  assert.equal(seen.join, undefined, 'a join is still running at 10 s');
  await tick(50_000);
  assert.deepEqual(seen.join, FAILED);
});

test('timer: every 20 s while the Team view shows the owned team hosted here; no other roster is polled', async (t) => {
  const { h, tick } = timed(t, { host: hostState(), teams: [snapshot(), memberTeam()] });
  h.showTab();
  await micro();
  assert.equal(h.store._timerMs(), 20_000);
  const before = h.sent('members').length;
  await tick(19_999);
  assert.equal(h.sent('members').length, before);
  await tick(1);
  const polled = h.sent('members').slice(before);
  assert.deepEqual(polled.map((call) => call.payload), [{ team_id: TEAM }], 'only that roster');
  await tick(20_000);
  assert.equal(h.sent('members').length, before + 2);
  assert.equal(h.sent('status').length, 1, 'the timer reads no status');
});

test('timer: a team hosted elsewhere is re-read every 20 s while the view shows it, and never in the background', async (t) => {
  const { h, tick } = timed(t, { teams: [memberTeam()] });
  h.showTab();
  await micro();
  assert.equal(h.store._timerMs(), 20_000);
  const before = h.sent('members').length;
  await tick(20_000);
  assert.deepEqual(h.sent('members').slice(before).map((call) => call.payload), [{ team_id: OTHER }]);
  t.after(h.store.use({}));
  h.tab.hideTeamTab();
  assert.equal(h.store._timerMs(), 0, 'the background read is for the owned hosted team only');
  await tick(180_000);
  assert.equal(h.sent('members').length, before + 1);
});

test('timer: with another team shown, the owned hosted team behind it is still read every 60 s', async (t) => {
  const { h, tick } = timed(t, { host: hostState(), teams: [snapshot(), memberTeam()] });
  t.after(h.store.use({ rosters: 'all' }));
  await h.store.refreshAll();
  h.store.setShownTeam(OTHER);
  await micro();
  assert.equal(h.store._timerMs(), 20_000);
  const before = h.sent('members').length;
  const polled = () => h.sent('members').slice(before).map((call) => call.payload.team_id);
  await tick(20_000);
  await tick(20_000);
  assert.deepEqual(polled(), [OTHER, OTHER]);
  await tick(20_000);
  assert.deepEqual(polled().sort(), [TEAM, OTHER, OTHER, OTHER].sort());
});

test('timer: every 60 s while another view shows, and it picks the pace up when the view changes', async (t) => {
  const { h, tick } = timed(t, { host: hostState(), teams: [snapshot()] });
  t.after(h.store.use({}));
  await h.store.refreshAll();
  await micro();
  assert.equal(h.store._timerMs(), 60_000);
  const before = h.sent('members').length;
  await tick(59_999);
  assert.equal(h.sent('members').length, before);
  await tick(1);
  assert.equal(h.sent('members').length, before + 1);
  h.showTab();
  await micro();
  assert.equal(h.store._timerMs(), 20_000);
  h.tab.hideTeamTab();
  assert.equal(h.store._timerMs(), 60_000);
});

test('timer: after three failed reads in a row the interval doubles, up to 5 minutes; a success resets it', async (t) => {
  let failing = false;
  const { h, tick } = timed(t, { teams: [memberTeam()], answers: {
    members: () => (failing ? { ok: false, error: { code: 'CMP-TEAM-0002', reason: 'team_unavailable' } } : { ok: true, members: ROSTER }) } });
  h.showTab();
  await micro();
  failing = true;
  await tick(20_000);
  await tick(20_000);
  assert.equal(h.store._timerMs(), 20_000, 'two failures change nothing');
  await tick(20_000);
  assert.equal(h.store._timerMs(), 40_000);
  await tick(40_000);
  assert.equal(h.store._timerMs(), 80_000);
  await tick(80_000);
  await tick(160_000);
  assert.equal(h.store._timerMs(), 300_000, 'capped at five minutes');
  await tick(300_000);
  assert.equal(h.store._timerMs(), 300_000);
  failing = false;
  await tick(300_000);
  assert.equal(h.store._timerMs(), 20_000);
});

test('timer: never while the document is hidden', async (t) => {
  const { h, tick, setHidden } = timed(t, { host: hostState(), teams: [snapshot()] });
  h.showTab();
  await micro();
  setHidden(true);
  assert.equal(h.store._timerMs(), 0);
  const before = h.sent('members').length;
  await tick(120_000);
  assert.equal(h.sent('members').length, before);
  setHidden(false);
  await micro();
  assert.equal(h.store._timerMs(), 20_000);
  assert.equal(h.sent('members').length, before + 1, 'and the roster is read once on coming back');
});

for (const [name, options] of [
  ['a member of someone else\'s team', { teams: [memberTeam()] }],
  ['an owner whose team is hosted elsewhere', { teams: [snapshot({ team_id: OTHER })] }],
  ['a team hosted here where you are a member', { host: hostState(), teams: [snapshot({ role: 'member' })] }],
  ['the owner while the server is stopped', { host: hostState({ state: 'stopped' }), teams: [snapshot({ state: 'offline' })] }],
]) {
  test(`timer: no background read for ${name}`, async (t) => {
    const { h, tick } = timed(t, options);
    t.after(h.store.use({}));
    await h.store.refreshAll();
    await micro();
    assert.equal(h.store._timerMs(), 0);
    const before = h.sent('members').length;
    await tick(180_000);
    assert.equal(h.sent('members').length, before);
  });
}

test('timer: none for a shown team that is not connected', async (t) => {
  const { h, tick } = timed(t, { host: NONE, teams: [memberTeam({ state: 'offline' })] });
  h.showTab();
  await micro();
  assert.equal(h.store._timerMs(), 0);
  await tick(180_000);
  assert.equal(h.sent('members').length, 0);
});

test('timer: cleared when the condition ends and when the last consumer leaves', async (t) => {
  const { h, tick } = timed(t, { host: hostState(), teams: [snapshot()] });
  h.showTab();
  await micro();
  assert.equal(h.store._timerMs(), 20_000);
  h.listeners.state({ teams: [snapshot({ state: 'reconnecting' })] });
  await micro();
  assert.equal(h.store._timerMs(), 0);
  h.listeners.state({ teams: [snapshot()] });
  await micro();
  assert.equal(h.store._timerMs(), 20_000);
  h.listeners.host(hostState({ state: 'stopping' }));
  await micro();
  assert.equal(h.store._timerMs(), 20_000, 'the shown team is still connected');
  h.tab.hideTeamTab();
  assert.equal(h.store._timerMs(), 0);
  const before = h.sent('members').length;
  await tick(180_000);
  assert.equal(h.sent('members').length, before);
});
