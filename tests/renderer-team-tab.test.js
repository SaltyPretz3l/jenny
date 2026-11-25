'use strict';

// Team tab view (row 123, slice 1g-2; the main area is the team's channel since slice 2a-5a): the
// left column (switcher, Wants to join, people) and the main area for every connection state,
// through the real view, controller, shared stores and inventory modules over a stubbed
// `window.jennyShell.team`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, OTHER, ME, DOT, MAYA, flush, pushed, micro, snapshot, memberTeam, hostState, ROSTER, harness, chatMember, overview, OWN_KEY_LINE, OWN_KEY_CASES,
  openChat, chatPush, chatChannel } = require('./helpers/team-settings-harness');

// What a non-owner is sent: active members only, no devices.
const MEMBER_ROSTER = ROSTER.filter((member) => member.state === 'active').map(({ devices: _devices, ...member }) => member);
const tone = (el) => el.getAttribute('data-status-tone');
// The switcher's menu is the inventory context menu: it floats on the document body, not inside the view.
const menuOf = (h) => h.window.document.querySelector('.inv-context-menu.team-switch-menu');

async function open(options) {
  const h = harness({ show: false, ...options });
  h.showTab();
  await flush();
  return h;
}

// ------------------------------------------------------------ member states

test('online member: the column, the people in order, the channel header, and nothing that opens Settings in the main area', async (t) => {
  const roster = [
    { member_id: 'm3', display_name: 'Zed', role: 'read_only', state: 'active' },
    { member_id: DOT, display_name: 'Dot', role: 'member', state: 'active' },
    { member_id: 'm4', display_name: 'arjun', role: 'member', state: 'active' },
    { member_id: ME, display_name: 'Olive Owner', role: 'owner', state: 'active' },
  ];
  const members = roster.map((member) => chatMember(member.member_id, member.display_name, { role: member.role }));
  const h = await open({ teams: [memberTeam()], answers: { members: { ok: true, members: roster }, chatOverview: overview({ members }) } });
  t.after(h.restore);
  const nav = h.view.q('nav.team-panel');
  assert.equal(nav.getAttribute('aria-label'), 'Team and people', 'named for what it holds, not after the tab');
  assert.equal(h.view.q('.team-panel__title').textContent, 'Dot lab');
  assert.equal(h.view.q('#teamTabSwitch').getAttribute('aria-label'), 'Dot lab, switch team');
  // The connection is the inventory status row: one tone dot, then the word.
  const fact = h.view.q('.team-panel__host');
  assert.ok(fact.classList.contains('inv-status-row'));
  assert.equal(fact.textContent.trim(), 'connected');
  assert.equal(tone(fact), 'success');
  assert.equal(h.view.q('[data-team-wants]'), null);
  const rows = h.view.qa('[data-team-presence="online"] .team-row--member');
  assert.deepEqual(rows.map((row) => row.querySelector('.team-row__name').textContent), ['Olive Owner', 'arjun', '\u2068Dot\u2069 (you)', 'Zed']);
  assert.deepEqual(rows.map((row) => row.querySelector('.team-row__meta').textContent), ['Owner', '', '', 'Read-only']);
  assert.match(h.view.q('.team-people .team-panel__label').textContent, /Online\s*4/);
  assert.equal(h.view.q('.team-head__name').textContent, '#team');
  assert.equal(h.view.q('.team-head__sub').textContent, 'Everyone on this team · 4 people');
  assert.equal(h.view.q('.team-banner'), null);
  assert.equal(h.view.q('.team-home'), null);
  assert.equal(h.view.q('.team-main [data-team-tab-action="open-settings"]'), null, 'Invite and Team settings live in the team menu');
  assert.equal(h.sent('leave').length, 0, 'nothing destructive runs from the tab');
  assert.equal(h.sent('inviteList').length + h.sent('auditRead').length, 0);
});

test('connecting: the head and one Connecting line, and no list is read', async (t) => {
  const h = await open({ teams: [memberTeam({ state: 'connecting' })] });
  t.after(h.restore);
  assert.equal(h.view.q('.team-head__name').textContent, '#team');
  assert.equal(h.view.q('.team-panel__title').textContent, 'Dot lab');
  const banner = h.view.q('.team-banner');
  assert.equal(banner.textContent.trim(), 'Connecting…');
  assert.ok(banner.classList.contains('inv-status-row'));
  assert.equal(banner.getAttribute('role'), 'status');
  assert.equal(tone(banner), 'warning');
  assert.equal(tone(h.view.q('.team-panel__host')), 'warning');
  // The composer reads its draft (a local read in main, slice 2a-5b), so typing never overwrites it.
  assert.deepEqual(h.methodNames(), ['chatDraftGet', 'hostStatus', 'status']);
});

test('reconnecting, then offline: one banner line, no Try again, and the people last read stay', async (t) => {
  const h = await open({ teams: [memberTeam()], answers: { members: { ok: true, members: MEMBER_ROSTER } } });
  t.after(h.restore);
  assert.equal(h.view.qa('.team-people .team-row--member').length, 2);
  h.listeners.state({ teams: [memberTeam({ state: 'reconnecting' })] });
  await pushed();
  assert.equal(h.view.q('.team-banner').textContent.trim(), 'Reconnecting…');
  assert.match(h.view.q('.team-panel__host').textContent, /reconnecting/);
  const since = Date.UTC(2026, 10, 9, 13, 20);
  h.listeners.state({ teams: [memberTeam({ state: 'offline', since })] });
  await pushed();
  const banner = h.view.q('.team-banner');
  assert.match(banner.textContent, /Offline since /);
  assert.match(banner.textContent, /2026/);
  assert.equal(banner.querySelector('button'), null);
  assert.equal(tone(banner), 'danger');
  assert.equal(tone(h.view.q('.team-panel__host')), 'danger');
  assert.equal(h.view.qa('.team-people .team-row--member').length, 2, 'the people read earlier are still shown');
  assert.equal(h.sent('members').length, 1, 'and is not read while offline');
});

const GATES = {
  pending: { heading: /^Waiting to be let in$/, copy: /Dot lab/, action: 'cancel-request', method: 'leave' },
  revoked: { heading: /^You no longer have access to Dot lab$/, copy: /new invite/, action: 'remove-team', method: 'removeTeam' },
  update_required: { heading: /^Update Jenny to open Dot lab$/, copy: /newer version/, action: null },
};
for (const [state, gate] of Object.entries(GATES)) {
  test(`${state}: one heading, one paragraph, at most one button, and no list call`, async (t) => {
    const h = await open({ teams: [memberTeam({ state })] });
    t.after(h.restore);
    assert.equal(h.view.q('.team-shell').dataset.teamState, state);
    assert.equal(h.view.q('nav.team-panel'), null, 'nothing from the team is shown');
    assert.equal(h.view.qa('.team-state h2').length, 1);
    assert.match(h.view.q('.team-state h2').textContent, gate.heading);
    assert.equal(h.view.qa('.team-state p').length, 1);
    assert.match(h.view.q('.team-state p').textContent, gate.copy);
    const buttons = h.view.qa('.team-state button');
    assert.equal(buttons.length, gate.action ? 1 : 0);
    assert.deepEqual(h.methodNames(), ['hostStatus', 'status']);
    if (!gate.action) return;
    assert.equal(buttons[0].dataset.teamTabAction, gate.action);
    buttons[0].click();
    buttons[0].click();
    await flush();
    assert.equal(h.sent(gate.method).length, 1, 'one click, once');
    assert.deepEqual(h.sent(gate.method)[0].payload, { team_id: OTHER });
    assert.deepEqual(h.methodNames().filter((name) => !['hostStatus', 'status', gate.method].includes(name)), []);
  });
}

test('a pending team with no name yet still reads as a sentence', async (t) => {
  const h = await open({ teams: [memberTeam({ state: 'pending', team_name: '' })] });
  t.after(h.restore);
  assert.match(h.view.q('.team-state p').textContent, /Your invite to this team was accepted/);
});

// Two-PC findings: the joiner reads the characters the owner reads beside their "wants to join" row.
for (const [name, over, shown] of OWN_KEY_CASES) {
  test(`own key, ${name}: the line under the paragraph is ${shown ? 'shown, formatted' : 'not shown'}`, async (t) => {
    const h = await open({ teams: [memberTeam(over)] });
    t.after(h.restore);
    assert.equal(h.view.text().includes('7F3A 91C2 05'), shown);
    if (over.state !== 'pending') return;
    const lines = h.view.qa('.team-state p').map((el) => el.textContent);
    assert.deepEqual(lines.slice(1), shown ? [OWN_KEY_LINE] : []);
  });
}

test('a failed Cancel request prints one sentence', async (t) => {
  const h = await open({ teams: [memberTeam({ state: 'pending' })], answers: { leave: { ok: false, error: { reason: 'team_unavailable' } } } });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="cancel-request"]').click();
  await flush();
  assert.equal(h.view.qa('.team-set-note').length, 1);
  assert.match(h.view.q('.team-set-note').textContent, /not answering/);
});

test('lost owner access: this PC runs the server but this Jenny is not in its team', async (t) => {
  const h = await open({ host: hostState(), teams: [] });
  t.after(h.restore);
  assert.equal(h.view.q('.team-shell').dataset.teamState, 'lost_owner');
  assert.equal(h.view.qa('.team-state h2').length, 1);
  assert.match(h.view.q('.team-state p').textContent, /Studio/);
  const buttons = h.view.qa('.team-state button');
  assert.deepEqual(buttons.map((button) => button.textContent), ['Open Team settings']);
  buttons[0].click();
  assert.deepEqual(h.opened, ['team']);
  assert.equal(h.sent('members').length, 0);
});

// -------------------------------------------------------------- owner flow

test('owner of the team hosted here: the notice with the key, Admit once under a double click, then People', async (t) => {
  let admitted = false;
  const h = await open({ host: hostState(), teams: [snapshot()], answers: {
    memberAdmit: () => { admitted = true; return { ok: true }; },
    members: () => ({ ok: true, members: admitted ? ROSTER.map((member) => ({ ...member, state: 'active' })) : ROSTER }),
  } });
  t.after(h.restore);
  const row = h.view.q('.team-notice .inv-toast');
  assert.match(row.textContent, /Maya Okafor/);
  assert.match(row.textContent, /Maya laptop/);
  assert.match(row.textContent, /7F3A 91C2 05/);
  assert.match(row.textContent, /They see the same key on their screen/);
  assert.equal(h.view.q('[data-team-wants]'), null);
  assert.deepEqual(h.view.qa('.team-people .team-row__name').map((el) => el.textContent), ['\u2068Olive Owner\u2069 (you)', 'Dot']);
  const admit = h.view.q('[data-team-action="admit"]');
  admit.click();
  h.view.q('[data-team-action="admit"]').click();
  await flush();
  assert.equal(h.sent('memberAdmit').length, 1);
  assert.deepEqual(h.sent('memberAdmit')[0].payload, { team_id: TEAM, member_id: MAYA });
  assert.equal(h.view.q('.team-notice .inv-toast'), null);
  assert.ok(h.view.qa('.team-people .team-row__name').some((el) => el.textContent === 'Maya Okafor'), 'listed before the next overview');
  assert.equal(h.sent('inviteList').length + h.sent('auditRead').length, 0, 'the tab never reads invites or the log');
});

test('a failed Admit prints one sentence and gives the control back; Decline calls memberRevoke', async (t) => {
  const h = await open({ host: hostState(), teams: [snapshot()], answers: {
    memberAdmit: { ok: false, error: { code: 'invalid_request', reason: 'team_member_limit' } } } });
  t.after(h.restore);
  h.view.q('[data-team-action="admit"]').click();
  await flush();
  const notes = h.view.qa('.team-notice .team-notice__error');
  assert.equal(notes.length, 1);
  assert.match(notes[0].textContent, /The team is full/);
  assert.equal(h.view.q('[data-team-action="admit"]').disabled, false);
  h.view.q('[data-team-action="decline"]').click();
  await flush();
  assert.deepEqual(h.sent('memberRevoke').map((call) => call.payload), [{ team_id: TEAM, member_id: MAYA }]);
});

test('an Admit that never answers gives the button back with one sentence after 10 s', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = harness({ show: false, host: hostState(), teams: [snapshot()], answers: { memberAdmit: () => new Promise(() => {}) } });
  t.after(h.restore);
  h.showTab();
  await micro();
  h.view.q('[data-team-action="admit"]').click();
  await micro();
  assert.equal(h.view.q('[data-team-action="admit"]').disabled, true);
  t.mock.timers.tick(10_000);
  await micro();
  assert.equal(h.view.q('[data-team-action="admit"]').disabled, false);
  const notes = h.view.qa('.team-notice .team-notice__error');
  assert.equal(notes.length, 1);
  assert.match(notes[0].textContent, /could not be reached/);
});

test('keyboard focus survives a redraw: a failed Admit gets it back, a finished one hands it to a control that is still there', async (t) => {
  let fail = true;
  let admitted = false;
  const h = await open({ host: hostState(), teams: [snapshot()], answers: {
    memberAdmit: () => (fail ? { ok: false, error: { reason: 'team_member_limit' } } : ((admitted = true), { ok: true })),
    members: () => ({ ok: true, members: admitted ? ROSTER.map((member) => ({ ...member, state: 'active' })) : ROSTER }),
  } });
  t.after(h.restore);
  const doc = h.window.document;
  const admit = () => h.view.q(`[data-team-action="admit"][data-member-id="${MAYA}"]`);
  admit().focus();
  admit().click();
  await flush();
  assert.equal(doc.activeElement, admit(), 'back on Admit after the failure');
  fail = false;
  admit().click();
  await flush();
  assert.equal(admit(), null);
  assert.notEqual(doc.activeElement, doc.body, 'not dropped to the page');
  assert.equal(doc.activeElement, h.view.q('#teamTabSwitch'));
  // Focus the user moved elsewhere is left alone.
  const outside = doc.getElementById('topRail');
  outside.tabIndex = -1;
  outside.focus();
  h.listeners.state({ teams: [snapshot({ team_name: 'Renamed' })] });
  await flush();
  assert.equal(doc.activeElement, outside);
});

test('a redraw keeps the People column where it was scrolled', async (t) => {
  const h = await open({ teams: [memberTeam()] });
  t.after(h.restore);
  h.view.q('.team-panel').scrollTop = 37;
  h.listeners.state({ teams: [memberTeam({ team_name: 'Renamed' })] });
  await flush();
  assert.equal(h.view.q('.team-panel__title').textContent, 'Renamed');
  assert.equal(h.view.q('.team-panel').scrollTop, 37);
});

for (const [name, options] of [
  ['a member of a team hosted here', { host: hostState(), teams: [snapshot({ role: 'member', member_id: DOT })] }],
  ['an owner whose team is hosted elsewhere', { teams: [snapshot({ team_id: OTHER })] }],
  ['an owner who is not connected to the team hosted here', { host: hostState(), teams: [snapshot({ state: 'reconnecting' })] }],
  ['an owner whose server is not running', { host: hostState({ state: 'stopping' }), teams: [snapshot()] }],
]) {
  test(`no Wants to join controls for ${name}, even when the roster answer carries a pending person`, async (t) => {
    const h = await open(options);
    t.after(h.restore);
    assert.equal(h.view.q('[data-team-wants]'), null);
    assert.equal(h.view.q('.team-notice .inv-toast'), null);
    assert.equal(h.view.q('[data-team-action="admit"]'), null);
    assert.equal(h.view.q('[data-team-action="decline"]'), null);
    assert.equal(h.view.qa('.team-people .team-row__name').some((el) => /Maya/.test(el.textContent)), false, 'a pending person is not listed under People');
  });
}

// ---------------------------------------------------------------- switcher

function fourTeams() {
  return [
    memberTeam({ team_id: 'team_C1', team_name: 'Alpha' }),
    snapshot(),
    memberTeam({ team_id: 'team_C3', team_name: 'Gamma', role: 'read_only' }),
    memberTeam({ team_id: 'team_C4', team_name: 'Delta', state: 'offline' }),
    memberTeam({ team_id: 'team_C5', team_name: 'Fifth' }),
  ];
}

test('switcher: up to four teams, the hosted one first selected, facts in words, and switching disconnects nothing', async (t) => {
  const h = await open({ host: hostState(), teams: fourTeams() });
  t.after(h.restore);
  assert.equal(h.view.q('.team-panel__title').textContent, 'Studio', 'the hosted team is shown first');
  const toggle = h.view.q('[data-team-tab-action="switch"]');
  assert.equal(toggle.getAttribute('aria-haspopup'), 'menu');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(menuOf(h), null);
  toggle.click();
  const menu = menuOf(h);
  assert.equal(menu.getAttribute('role'), 'menu');
  assert.equal(menu.getAttribute('aria-label'), 'Switch team');
  assert.equal(h.view.q('[data-team-tab-action="switch"]').getAttribute('aria-expanded'), 'true');
  const rows = [...menu.querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(rows.map((row) => row.querySelector('.inv-context-menu-text > span').textContent), ['Alpha', 'Studio', 'Gamma', 'Delta']);
  assert.deepEqual(rows.map((row) => row.querySelector('.inv-context-menu-description').textContent), ['Member', 'Owner · hosted here', 'Read-only', 'offline']);
  assert.deepEqual(rows.map((row) => row.getAttribute('aria-checked')), ['false', 'true', 'false', 'false']);
  assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].slice(-2).map((row) => row.textContent.trim()), ['Join a team with an invite', 'Export›'], 'Export ends the menu (2a-6c)');
  rows[2].click();
  await flush();
  assert.equal(menuOf(h), null);
  assert.equal(h.view.q('[data-team-tab-action="switch"]').getAttribute('aria-expanded'), 'false');
  assert.equal(h.view.q('.team-panel__title').textContent, 'Gamma');
  assert.equal(h.sent('leave').length + h.sent('removeTeam').length + h.sent('hostStop').length, 0);
  h.tab.hideTeamTab();
  h.showTab();
  await flush();
  assert.equal(h.view.q('.team-panel__title').textContent, 'Gamma', 'the choice is kept for the session');
});

test('switcher keyboard: arrows move through the rows, Esc closes and returns focus, the invite row opens Settings', async (t) => {
  const h = await open({ host: hostState(), teams: fourTeams().slice(0, 2) });
  t.after(h.restore);
  const doc = h.window.document;
  const key = (name) => doc.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  h.view.q('[data-team-tab-action="switch"]').focus();
  key('ArrowDown');
  const items = () => [...menuOf(h).querySelectorAll('[role^="menuitem"]')];
  assert.equal(items().length, 7, 'two teams, Invite someone, Share this PC’s GPU…, Team settings, Join, Export');
  assert.equal(doc.activeElement, items()[1], 'opens on the selected team');
  key('ArrowDown');
  assert.equal(doc.activeElement, items()[2]);
  key('ArrowUp');
  key('ArrowUp');
  assert.equal(doc.activeElement, items()[0]);
  key('ArrowUp');
  assert.equal(doc.activeElement, items()[6], 'wraps');
  key('Escape');
  assert.equal(menuOf(h), null);
  assert.equal(doc.activeElement, h.view.q('[data-team-tab-action="switch"]'));
  assert.equal(doc.activeElement.getAttribute('aria-expanded'), 'false');
  h.view.q('[data-team-tab-action="switch"]').click();
  menuOf(h).querySelector('[data-value="join-invite"]').click();
  assert.deepEqual(h.opened, ['team']);
  assert.equal(menuOf(h), null);
  h.view.q('[data-team-tab-action="switch"]').click();
  h.view.q('[data-team-tab-action="switch"]').click();
  assert.equal(menuOf(h), null, 'a second click on the switcher closes its menu');
});

test('2a-6c: Export in the team menu opens its two choices; the export line runs in the tab and Cancel closes it; offline greys it out', async (t) => {
  let release;
  const h = await open({ host: hostState(), teams: [snapshot()], answers: { chatHistory: () => new Promise((resolve) => { release = resolve; }) } });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="switch"]').click();
  const exportRow = [...menuOf(h).querySelectorAll('[role="menuitem"]')].at(-1);
  assert.deepEqual([exportRow.getAttribute('aria-haspopup'), exportRow.disabled], ['menu', false]);
  exportRow.click();
  const sub = h.window.document.querySelector('.inv-context-menu--sub');
  assert.deepEqual([...sub.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent.trim()), ['This conversation…', 'Every conversation…']);
  sub.querySelectorAll('[role="menuitem"]')[1].click();
  await flush();
  const slot = h.view.q('[data-team-region="export"]');
  assert.match(slot.textContent, /Exporting: 0 of 1 conversations done, 0 messages so far/);
  assert.equal(h.window.document.querySelector('.inv-context-menu'), null, 'the menu closed');
  [...slot.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel').click();
  await flush();
  assert.equal(slot.textContent.trim(), '', 'Cancel closes the line and saves nothing');
  release({ ok: true, messages: [], has_more: false });
  await flush();
  assert.equal(slot.textContent.trim(), '', 'a late answer after Cancel changes nothing');
  h.listeners.state({ teams: [snapshot({ state: 'offline' })] });
  await pushed();
  h.view.q('[data-team-tab-action="switch"]').click();
  const offline = [...menuOf(h).querySelectorAll('[role="menuitem"]')].at(-1);
  assert.equal(offline.disabled, true);
  assert.match(offline.textContent, /Needs the team online/);
  const reads = h.sent('chatOverview').length;
  offline.click();
  await flush();
  assert.deepEqual([h.window.document.querySelector('.inv-context-menu--sub'), slot.textContent.trim(), h.sent('chatOverview').length], [null, '', reads],
    'clicking it offline opens no choices and starts nothing');
});

// Fix list item 20: the done, stopped and failed lines with their buttons; an export from elsewhere draws nothing here.
test('2a-6c: the export line says done, stopped and failed with their buttons, and only for an export started from this tab', async (t) => {
  let history = { ok: true, messages: [], has_more: false };
  const h = await open({ host: hostState(), teams: [snapshot()], answers: { chatHistory: () => history } });
  t.after(h.restore);
  let save = async () => ({ canceled: false, path: 'C:\\x.md' });
  h.window.jennyShell.dialog = { saveFile: (payload) => save(payload) };
  const exporter = globalThis.rendererTeamExport.getExporter();
  const slot = h.view.q('[data-team-region="export"]');
  const buttons = () => [...slot.querySelectorAll('[data-team-export-action]')].map((b) => [b.textContent.trim(), b.dataset.teamExportAction]);
  const toneOf = () => (slot.querySelector('[data-status-tone]') || { getAttribute: () => '' }).getAttribute('data-status-tone');
  const run = async (origin = 'tab') => { await exporter.start({ teamId: TEAM, scope: 'all', origin }); await flush(); };
  await run();
  assert.match(slot.textContent, /Exported 0 messages from 1 conversations to C:\\x\.md/);
  assert.deepEqual([buttons(), toneOf()], [[['Close', 'close']], 'success']);
  slot.querySelector('[data-team-export-action="close"]').click();
  await flush();
  assert.equal(slot.textContent.trim(), '', 'Close closes the line');
  save = async () => { throw new Error('disk full'); };
  await run();
  assert.match(slot.textContent, /Export failed\. Try again\./);
  assert.deepEqual([buttons(), toneOf()], [[['Try again', 'retry'], ['Close', 'close']], 'danger']);
  save = async () => ({ canceled: false, path: 'C:\\y.md' });
  slot.querySelector('[data-team-export-action="retry"]').click();
  await flush();
  assert.match(slot.textContent, /to C:\\y\.md/, 'Try again runs it again');
  exporter.dismiss();
  history = { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } };
  await run();
  assert.match(slot.textContent, /The export stopped: Studio went offline\. Nothing was saved\./);
  assert.deepEqual([buttons(), toneOf()], [[['Try again', 'retry'], ['Close', 'close']], 'warning']);
  exporter.dismiss();
  history = { ok: true, messages: [], has_more: false };
  await run('leave');
  assert.equal(exporter.state().phase, 'done');
  assert.equal(slot.textContent.trim(), '', 'an export started by Leave says nothing in the tab');
  exporter.dismiss();
});

test('a change under the open switcher menu closes it, and hiding the tab takes the menu with it', async (t) => {
  const h = await open({ host: hostState(), teams: fourTeams().slice(0, 2) });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="switch"]').click();
  assert.ok(menuOf(h));
  h.listeners.state({ teams: fourTeams().slice(0, 2).map((team) => ({ ...team, team_name: `${team.team_name} 2` })) });
  await flush();
  assert.equal(menuOf(h), null);
  assert.equal(h.view.q('.team-panel__title').textContent, 'Studio 2');
  h.view.q('[data-team-tab-action="switch"]').click();
  h.tab.hideTeamTab();
  assert.equal(menuOf(h), null);
});

// Row 201 H23.2: a presence or unread push writes the column only; a menu whose own anchor did not change stays open.
test('presence and unread pushes redraw the column under an open switcher or notify menu without closing it', async (t) => {
  const { h } = await openChat();
  t.after(h.restore);
  const doc = h.window.document;
  const pushes = (state, unread) => {
    chatPush(h, { type: 'presence', member_id: ME, state, last_seen_at: null });
    chatPush(h, { type: 'channels', partial: true, channels: [chatChannel({ unread, last_seq: unread })] });
  };
  for (const [action, className] of [['switch', 'team-switch-menu'], ['notify', 'team-notify-menu']]) {
    h.view.q(`[data-team-tab-action="${action}"]`).click();
    const menu = () => doc.querySelector('.inv-context-menu.' + className);
    assert.ok(menu(), action + ' opens');
    const focused = doc.activeElement;
    pushes(action === 'switch' ? 'offline' : 'online', action === 'switch' ? 3 : 0);
    await flush();
    assert.ok(menu(), action + ': the menu stays open');
    assert.equal(doc.activeElement, focused, action + ': the focus stays');
    assert.equal(h.view.q(`[data-team-tab-action="${action}"]`).getAttribute('aria-expanded'), 'true', action + ': its button still says so');
    const offline = h.view.q('[data-team-presence="offline"]');
    assert.equal(Boolean(offline && offline.textContent.includes('Olive Owner')), action === 'switch', action + ': the people column follows the push');
    h.view.q(`[data-team-tab-action="${action}"]`).click();
    await flush();
    assert.equal(menu(), null, action + ': its own button closes it');
  }
});

// ------------------------------------------------------------- narrow, life

test('a hidden tab writes nothing and drops its listeners; showing it again re-reads', async (t) => {
  const h = await open({ teams: [memberTeam()] });
  t.after(h.restore);
  h.tab.hideTeamTab();
  const before = h.teamView.innerHTML;
  const reads = h.sent('status').length;
  h.store.seed({ teams: [memberTeam({ team_name: 'Renamed' })] });
  await flush();
  assert.equal(h.teamView.innerHTML, before);
  h.teamView.querySelector('[data-team-tab-action="switch"]')?.click();
  assert.equal(h.teamView.innerHTML, before, 'clicks are not handled while hidden');
  h.showTab();
  await flush();
  assert.ok(h.sent('status').length > reads);
});

// Fault: a saved team that needs repair offered by the Team tab
// (selected, or listed in the switcher), or anything read for it.
test('a saved team that needs repair is never offered: not selected, not in the switcher, nothing read for it', async (t) => {
  const repair = { team_id: 'team_R1', state: 'needs_repair', reason: 'team_client_invalid' };
  const h = await open({ teams: [repair, memberTeam({ team_id: 'team_C1', team_name: 'Alpha' })] });
  t.after(h.restore);
  assert.equal(h.view.q('.team-panel__title').textContent, 'Alpha');
  h.view.q('[data-team-tab-action="switch"]').click();
  const rows = [...menuOf(h).querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(rows.map((row) => row.querySelector('.inv-context-menu-text > span').textContent), ['Alpha']);
  assert.equal(h.calls.some((call) => call.payload?.team_id === 'team_R1'), false, 'nothing read for it');
  const alone = await open({ teams: [repair] });
  t.after(alone.restore);
  assert.equal(alone.view.q('.team-panel__title')?.textContent === 'team_R1', false);
  assert.equal(alone.calls.some((call) => call.payload?.team_id === 'team_R1'), false);
  // Not even as the team hosted here: the store's hostedTeam() never answers a needs_repair row.
  const hosted = await open({ host: hostState({ team_id: 'team_R1' }), teams: [memberTeam({ team_id: 'team_C1', team_name: 'Alpha' }), repair] });
  t.after(hosted.restore);
  assert.equal(hosted.view.q('.team-panel__title').textContent, 'Alpha');
  assert.equal(hosted.calls.some((call) => call.payload?.team_id === 'team_R1'), false);
});

test('no markup rule is broken: no raw side bar classes, one nav, one main, one heading per level', async (t) => {
  const h = await open({ host: hostState(), teams: [snapshot()] });
  t.after(h.restore);
  assert.equal(h.view.qa('nav').length, 1);
  assert.equal(h.view.qa('.team-main').length, 1);
  assert.equal(h.view.qa('h2').length, 1);
  assert.equal(h.teamView.querySelector('[style]'), null, 'no inline styles');
});
