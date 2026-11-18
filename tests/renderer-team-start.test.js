'use strict';

// new-test-file: the Team tab's start page (row 168, slice S3) is a new surface with its own module
// (renderer/team/renderer-team-start.js), and renderer-team-tab.test.js is near its line cap.
//
// The Team tab with no team: the rail tab is there whenever the `team` flag is on, the start page hosts or joins a
// team, and with no team data on disk (E50) nothing loads or asks main anything until the person opens the tab, then
// presses Start the team or Join. Through the real top rail, shell, gate, stores and tab over a stubbed bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, flush, snapshot, memberTeam, hostState, NONE, harness, shell } = require('./helpers/team-settings-harness');

const manifest = () => require('../renderer/shell/renderer-settings-script-manifest');
const words = () => require('../renderer/shell/renderer-settings-team-strings');
const srcs = (...lists) => lists.flatMap((list) => list.map(([src]) => src));
const START_SRC = 'renderer/team/renderer-team-start.js';
const HEADING = 'Work with people you trust';

const startPage = (h) => h.view.q('.team-start');
const heading = (h) => h.view.q('.team-start h2')?.textContent;
const field = (h, id) => h.view.q('#' + id);
function type(h, id, value) {
  const input = field(h, id);
  input.value = value;
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
}
const button = (h, action) => h.view.q(`[data-team-tab-action="${action}"]`);
const note = (h, place) => h.view.q(`[data-team-start-note="${place}"]`)?.textContent || '';
function fillNames(h, name = 'Olive Owner', pc = 'Desk') { type(h, 'teamStartName', name); type(h, 'teamStartPc', pc); }

// The Team tab opened with Ctrl+6 over a shell with the flag on.
async function openTab(t, options = {}, shellOptions = {}) {
  const h = harness({ show: false, ...options });
  t.after(h.restore);
  const s = shell(h, shellOptions);
  await flush();
  s.press('6');
  await flush();
  return { h, s };
}

// ------------------------------------------------------------ availability

test('E50 no team data: nothing at startup; the tab is in the rail; opening it loads the tab and shows the start page with no bridge call', async (t) => {
  const h = harness({ show: false });
  t.after(h.restore);
  const s = shell(h, { teamData: false });
  await flush();
  assert.deepEqual(s.requested, [], 'no team script at startup');
  assert.deepEqual(h.calls, []);
  assert.equal(h.listeners.state, null);
  assert.equal(h.listeners.host, null);
  assert.ok(s.tabs().includes('team'), 'the Team tab is in the rail');
  assert.equal(s.press('6').defaultPrevented, true, 'Ctrl+6 opens it');
  await flush();
  assert.equal(s.state.ui.activeView, 'team');
  for (const src of srcs(manifest().teamGate, manifest().teamStore, manifest().teamTab)) assert.ok(s.requested.includes(src), src);
  assert.ok(srcs(manifest().teamTab).includes(START_SRC), 'the start page loads with the tab');
  assert.equal(heading(h), HEADING);
  assert.equal(h.view.q('.team-shell').dataset.column, 'none');
  assert.deepEqual(h.calls, [], 'still no bridge call');
  assert.equal(h.listeners.state, null);
  assert.equal(h.listeners.host, null);
  assert.equal(h.listeners.chat, null, 'no chat push listener before a first Start or Join');
});

test('team data but no team: the tab opens on the start page after the one hostStatus and status read', async (t) => {
  const { h, s } = await openTab(t);
  assert.equal(s.state.ui.activeView, 'team');
  assert.deepEqual(h.calls.slice(0, 2).map((call) => call.method).sort(), ['hostStatus', 'status']);
  assert.deepEqual(h.methodNames(), ['hostStatus', 'status']);
  assert.equal(heading(h), HEADING);
  assert.match(h.view.text(), /Host a team on this PC or join someone else’s/);
  for (const id of ['teamStartName', 'teamStartPc', 'teamStartTeam']) assert.equal(field(h, id).getAttribute('maxlength'), '40', id);
  assert.equal(field(h, 'teamStartInvite').getAttribute('maxlength'), '512');
  assert.equal(field(h, 'teamStartInvite').getAttribute('placeholder'), 'jteam2_…');
  assert.equal(button(h, 'start-host').textContent.trim(), 'Start the team');
  assert.equal(button(h, 'start-join').textContent.trim(), 'Join');
  button(h, 'open-settings').click();
  assert.deepEqual(h.opened, ['team'], 'Restore a team from a file opens Settings > Team');
});

test('the flag off: no tab, no script and no bridge call', async (t) => {
  const h = harness({ show: false });
  t.after(h.restore);
  const s = shell(h, { flag: false });
  await flush();
  assert.equal(s.tabs().includes('team'), false);
  assert.equal(s.press('6').defaultPrevented, false);
  await flush();
  assert.deepEqual(s.requested, []);
  assert.deepEqual(h.calls, []);
});

// ---------------------------------------------------------------- actions

test('Start the team sends exactly hostDeploy with the trimmed names, then shows the hosted team', async (t) => {
  let deployed = false;
  const { h } = await openTab(t, { answers: {
    hostDeploy: () => { deployed = true; return { ok: true, host: hostState() }; },
    hostStatus: () => ({ ok: true, host: deployed ? hostState() : NONE }),
    status: () => ({ ok: true, teams: deployed ? [snapshot()] : [] }),
  } });
  fillNames(h, '  Olive Owner ', ' Desk  ');
  type(h, 'teamStartTeam', '  Studio ');
  button(h, 'start-host').click();
  button(h, 'start-host').click();
  await flush();
  await flush();
  assert.equal(h.sent('hostDeploy').length, 1, 'one call');
  assert.deepEqual(h.sent('hostDeploy')[0].payload, { name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
  assert.equal(startPage(h), null, 'the start page is gone');
  assert.ok(h.view.q('nav.team-panel'), 'the hosted team\'s view');
  assert.match(h.view.text(), /Studio/);
  assert.ok(h.view.q('[data-team-region="overview"]'), 'the tab opens on Overview right after Start the team, though the roster is not alone');
});

test('Start the team with no team name, or no names, sends nothing and says why under its own column', async (t) => {
  const { h } = await openTab(t);
  fillNames(h);
  button(h, 'start-host').click();
  await flush();
  assert.equal(h.sent('hostDeploy').length, 0);
  assert.equal(note(h, 'host'), words().errorText({ reason: 'team_name_invalid' }));
  assert.equal(note(h, 'join'), '');
  type(h, 'teamStartTeam', 'Studio');
  type(h, 'teamStartName', '   ');
  button(h, 'start-host').click();
  await flush();
  assert.equal(h.sent('hostDeploy').length, 0);
  assert.equal(note(h, 'you'), words().errorText({ reason: 'team_display_name_invalid' }));
  assert.equal(field(h, 'teamStartTeam').value, 'Studio', 'the typed team name survives the rewrite');
  assert.equal(field(h, 'teamStartPc').value, 'Desk');
});

test('Join sends exactly join with the code and names, then shows Waiting to be let in', async (t) => {
  let joined = false;
  const { h } = await openTab(t, { answers: {
    join: () => { joined = true; return { ok: true }; },
    status: () => ({ ok: true, teams: joined ? [memberTeam({ state: 'pending', member_state: 'pending' })] : [] }),
  } });
  fillNames(h);
  type(h, 'teamStartInvite', ' jteam2_SOMEINVITE ');
  button(h, 'start-join').click();
  await flush();
  await flush();
  assert.equal(h.sent('join').length, 1);
  assert.deepEqual(h.sent('join')[0].payload, { invite: 'jteam2_SOMEINVITE', display_name: 'Olive Owner', label: 'Desk' });
  assert.equal(h.view.q('.team-state h2').textContent, 'Waiting to be let in');
});

test('a refused Join says its sentence under Join, gives the button back and keeps the typed code', async (t) => {
  const error = { code: 'CMP-TEAM-0003', reason: 'team_invite_malformed' };
  const { h } = await openTab(t, { answers: { join: { ok: false, error } } });
  fillNames(h);
  type(h, 'teamStartInvite', 'jteam2_WRONG');
  button(h, 'start-join').click();
  assert.equal(button(h, 'start-join').disabled, true, 'busy while the call runs');
  await flush();
  assert.equal(note(h, 'join'), words().errorText(error));
  assert.equal(button(h, 'start-join').disabled, false);
  assert.equal(field(h, 'teamStartInvite').value, 'jteam2_WRONG');
  assert.equal(heading(h), HEADING);
  type(h, 'teamStartInvite', '');
  button(h, 'start-join').click();
  await flush();
  assert.equal(h.sent('join').length, 1, 'an empty code sends nothing');
  assert.equal(note(h, 'join'), words().errorText({ reason: 'team_invite_malformed' }));
});

test('typed text is still in its field after a store push redraws the view', async (t) => {
  const { h } = await openTab(t);
  fillNames(h, 'Olive', 'Desk');
  type(h, 'teamStartTeam', 'Studio');
  type(h, 'teamStartInvite', 'jteam2_HALF');
  const before = field(h, 'teamStartName');
  h.listeners.state({ teams: [] });
  h.listeners.host({ ...NONE, since: 2 });
  await flush();
  assert.equal(field(h, 'teamStartName'), before, 'the markup did not change, so it was not rewritten');
  assert.deepEqual(['teamStartName', 'teamStartPc', 'teamStartTeam', 'teamStartInvite'].map((id) => field(h, id).value), ['Olive', 'Desk', 'Studio', 'jteam2_HALF']);
});

test('drafts are cleared when the view is hidden', async (t) => {
  const { h, s } = await openTab(t);
  type(h, 'teamStartTeam', 'Studio');
  s.press('2');
  s.press('6');
  await flush();
  assert.equal(field(h, 'teamStartTeam').value, '');
});

test('Force local: both buttons are greyed with the state line, said once on the page, and nothing is sent', async (t) => {
  const { h } = await openTab(t, { answers: { status: { ok: true, teams: [], force_local: true } } });
  const line = words().forceLocalText();
  for (const action of ['start-host', 'start-join']) {
    assert.equal(button(h, action).disabled, true, action);
    assert.equal(button(h, action).getAttribute('title'), line, action);
  }
  assert.equal(h.view.text().split(line).length - 1, 1, 'the sentence once');
  fillNames(h);
  type(h, 'teamStartTeam', 'Studio');
  type(h, 'teamStartInvite', 'jteam2_X');
  button(h, 'start-host').click();
  button(h, 'start-join').click();
  await flush();
  assert.equal(h.sent('hostDeploy').length + h.sent('join').length, 0);
});

test('E50: the first Join on the start page ends the quiet state: the store follows the pushes and reads, and the gate learns of team data', async (t) => {
  let joined = false;
  const { h, s } = await openTab(t, { answers: {
    join: () => { joined = true; return { ok: true }; },
    status: () => ({ ok: true, teams: joined ? [memberTeam({ state: 'pending', member_state: 'pending' })] : [] }),
  } }, { teamData: false });
  assert.deepEqual(h.calls, []);
  fillNames(h);
  type(h, 'teamStartInvite', 'jteam2_SOMEINVITE');
  button(h, 'start-join').click();
  await flush();
  await flush();
  assert.equal(h.calls[0].method, 'join');
  assert.ok(h.listeners.state && h.listeners.host, 'the store follows the pushes');
  assert.ok(h.sent('status').length >= 1 && h.sent('hostStatus').length >= 1);
  assert.equal(h.view.q('.team-state h2').textContent, 'Waiting to be let in');
  assert.equal(s.state.ui.activeView, 'team');
  assert.ok(s.tabs().includes('team'));
});

// ---------------------------------------------------------- stopped server

test('a stopped server with known names: Start sends hostDeploy with them; a failure says why in the state\'s note', async (t) => {
  // The team row of the hosted team, carrying the names saved with the membership, in a state the tab does not offer.
  const row = { team_id: TEAM, state: 'needs_repair', reason: 'team_client_file_unreadable', display_name: 'Olive Owner', label: 'Desk' };
  let refuse = true;
  const { h } = await openTab(t, { host: hostState({ state: 'stopped' }), teams: [row], answers: {
    hostDeploy: () => (refuse ? { ok: false, error: { code: 'CMP-TEAM-0006', reason: 'team_host_start_failed' } } : { ok: true, host: hostState() }),
  } });
  assert.equal(h.view.q('.team-srv h2').textContent, 'Studio');
  assert.deepEqual(h.view.qa('.team-srv__acts button').map((el) => el.textContent.trim()), ['Start']);
  button(h, 'start-server').click();
  assert.equal(button(h, 'start-server').disabled, true);
  await flush();
  assert.deepEqual(h.sent('hostDeploy').map((call) => call.payload), [{ name: 'Studio', display_name: 'Olive Owner', label: 'Desk' }]);
  assert.ok(h.view.q('.team-srv [data-team-server-note="start"]').textContent.length > 0,'one sentence in the state\'s note');
  assert.equal(button(h, 'start-server').disabled, false);
  refuse = false;
  button(h, 'start-server').click();
  await flush();
  assert.equal(h.sent('hostDeploy').length, 2);
});

test('a stopped server without the names: Start greyed with its reason, and Open Team settings', async (t) => {
  const { h } = await openTab(t, { host: hostState({ state: 'stopped' }), teams: [] });
  assert.equal(h.view.q('.team-srv h2').textContent, 'Studio');
  assert.equal(button(h, 'start-server').disabled, true, 'Start is there, greyed, with its reason');
  assert.deepEqual(h.view.qa('.team-srv__acts button').map((el) => el.textContent.trim()), ['Start', 'Open Team settings']);
  assert.ok(h.view.q('[data-team-server="why"]').textContent.length > 0);
});

test('a stopped server whose key is lost, or under Force local, has no working Start', async (t) => {
  const row = { team_id: TEAM, state: 'needs_repair', reason: 'team_client_file_unreadable', display_name: 'Olive Owner', label: 'Desk' };
  const lost = await openTab(t, { host: hostState({ state: 'stopped', key: 'missing' }), teams: [row] });
  assert.equal(button(lost.h, 'start-server').disabled, true, 'greyed, not hidden');
  const held = await openTab(t, { host: hostState({ state: 'stopped' }), teams: [row], answers: { status: { ok: true, teams: [row], force_local: true } } });
  const start = button(held.h, 'start-server');
  assert.ok(start === null || start.disabled === true, 'never pressable while Force local is on');
});
