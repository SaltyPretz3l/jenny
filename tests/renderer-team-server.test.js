'use strict';

// new-test-file: the stopped server's page (row 170) is a new surface with its own module
// (renderer/team/renderer-team-server.js); renderer-team-start.test.js and renderer-team-tab.test.js are near their caps.
//
// The Team tab's page for a server this PC hosts while it is not running, and its rows in Settings > Team (This server,
// the You rows), through the real shell, gate, stores and tab over a stubbed bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEAM, OTHER, flush, snapshot, memberTeam, hostState, NONE, harness, shell, heldAnswers } = require('./helpers/team-settings-harness');

const server = require('../renderer/team/renderer-team-server');
const manifest = () => require('../renderer/shell/renderer-settings-script-manifest');
const words = () => require('../renderer/shell/renderer-settings-team-strings');
const SERVER_SRC = 'renderer/team/renderer-team-server.js';

// The hosted team's row in a state the tab does not open as a channel, carrying the names saved with the membership.
const ROW = { team_id: TEAM, state: 'needs_repair', reason: 'team_client_file_unreadable', display_name: 'Olive Owner', label: 'Desk' };
const OLD_ID = '20261112093000123';
const OLD = { id: OLD_ID, team_name: 'Test team', set_aside_at: Date.UTC(2026, 10, 12, 12), projects: 2, bytes: 31_000_000 };
const summary = (over = {}) => ({ ok: true, summary: { members: 3, pending: 1, projects: 2, bytes: 148_000_000, last_ran: Date.UTC(2026, 10, 14, 12), ...over } });
const REFUSED = { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_open_failed' } };

const page = (h) => h.view.q('.team-srv');
const facts = (h) => h.view.q('[data-team-server="facts"]').textContent;
const row = (h, key) => h.view.q(`[data-team-server-row="${key}"]`);
const flat = (el) => [...el.querySelectorAll('.team-ov-fact__k, .team-ov-fact__main, .team-ov-fact__sub, button')].map((part) => part.textContent.trim()).filter(Boolean).join(' ');
const rowText = (h, key) => flat(row(h, key));
const act = (h, action) => h.view.q(`[data-team-tab-action="${action}"]`);
const toggle = (h) => h.view.q('[data-inv-toggle="teamTabSrvAuto"]');
const tabNote = (h, key) => h.view.q(`[data-team-server-note="${key}"]`)?.textContent || '';
const notes = (h) => h.view.qa('[data-team-server-note]').map((el) => el.dataset.teamServerNote);

async function openTab(t, options = {}) {
  const h = harness({ show: false, ...options });
  t.after(h.restore);
  const s = shell(h);
  await flush();
  s.press('6');
  await flush();
  return { h, s };
}
const stopped = (over = {}) => ({ host: hostState({ state: 'stopped', ...over }), teams: [ROW] });

// -------------------------------------------------------------- wiring

test('the script is in both lazy lists, before the modules that use it', () => {
  assert.equal(typeof server.create, 'function');
  const { teamTab, teamSection } = manifest();
  const list = (scripts) => scripts.map(([src]) => src);
  assert.ok(list(teamTab).includes(SERVER_SRC), 'the tab loads it');
  assert.ok(list(teamSection).includes(SERVER_SRC), 'the Settings page loads it');
  for (const user of ['renderer/team/renderer-team-tab-view.js', 'renderer/team/renderer-team-start.js']) {
    assert.ok(list(teamTab).indexOf(SERVER_SRC) < list(teamTab).indexOf(user), user);
  }
  assert.ok(list(teamSection).indexOf(SERVER_SRC) < list(teamSection).indexOf('renderer/shell/renderer-settings-team-section.js'));
});

// ---------------------------------------------------------- the facts line

test('the facts line leaves out what is not known, pluralises and adds the people waiting', () => {
  assert.equal(server.factsLine(null), '');
  assert.equal(server.factsLine(server.parseSummary({})), '');
  assert.equal(server.factsLine(server.parseSummary({ members: 1, projects: 1 })), '1 person · 1 project');
  assert.equal(server.factsLine(server.parseSummary({ members: 3, projects: 0, pending: 0 })), '3 people · 0 projects');
  assert.equal(server.factsLine(server.parseSummary({ members: 3, pending: 1, projects: null })), '3 people · 1 waiting');
  assert.match(server.factsLine(server.parseSummary({ members: 2, pending: 2, projects: 5, last_ran: Date.UTC(2020, 5, 3, 12) })), /^2 people · 2 waiting · 5 projects · last ran .*2020/);
  assert.deepEqual(server.parseSummary({ members: -1, pending: 1.5, projects: '3', bytes: 7, last_ran: null }), { members: null, pending: null, projects: null, bytes: 7, last_ran: null });
  assert.equal(server.parseSummary('nope'), null);
});

// ----------------------------------------------------------- the page

test('a stopped server draws its page: name, state, facts, Start and every row, and the old sentence is gone', async (t) => {
  const { h } = await openTab(t, { ...stopped(), answers: { hostSummary: summary() } });
  assert.ok(page(h));
  assert.equal(h.view.q('.team-srv h2').textContent, 'Studio');
  assert.equal(h.view.q('.team-state'), null);
  assert.match(h.view.q('.team-srv__state').textContent, /Stopped/);
  assert.match(facts(h), /^3 people · 1 waiting · 2 projects · last ran /);
  const start = act(h, 'start-server');
  assert.equal(start.textContent.trim(), 'Start');
  assert.equal(start.disabled, false);
  assert.equal(act(h, 'open-settings') === null || h.view.q('.team-srv__acts [data-team-tab-action="open-settings"]') === null, true, 'no Open Team settings beside an enabled Start');
  assert.deepEqual(h.view.qa('[data-team-server-row]').map((el) => el.dataset.teamServerRow), ['autostart', 'name', 'you', 'internet', 'folder']);
  assert.equal(h.view.q('[data-team-server="why"]'), null);
  assert.deepEqual(h.view.qa('.team-srv__more button').map((el) => el.textContent.trim()), ['Join another team', 'Start a new team', 'All team settings']);
  for (const link of h.view.qa('.team-srv__more button')) assert.equal(link.dataset.teamTabAction, 'open-settings');
  h.view.qa('.team-srv__more button')[2].click();
  assert.deepEqual(h.opened, ['team']);
  assert.equal(h.view.q('[data-team-server="earlier"]'), null, 'no earlier teams, no list');
});

test('the rows: Start with Jenny, the name, you, the internet, the team data', async (t) => {
  const { h } = await openTab(t, { ...stopped({ autostart: true, internet: { on: true } }), answers: { hostSummary: summary() } });
  assert.equal(toggle(h).getAttribute('aria-checked'), 'true');
  assert.equal(toggle(h).dataset.teamTabAction, 'server-autostart');
  assert.match(rowText(h, 'autostart'), /Start with Jenny On Start this server when Jenny starts\./);
  assert.match(rowText(h, 'name'), /Team name Studio Start the server to rename the team\. Rename/);
  const rename = act(h, 'server-rename');
  assert.equal(rename.disabled, true);
  assert.equal(rename.getAttribute('title'), 'Start the server to rename the team.');
  assert.match(rowText(h, 'you'), /You Olive Owner on Desk Start the server to change your name\. Change/);
  assert.equal(act(h, 'server-change').disabled, true);
  assert.equal(act(h, 'server-change').getAttribute('title'), 'Start the server to change your name.');
  assert.match(rowText(h, 'internet'), /Joining over the internet On People with an invite can join from anywhere\./);
  row(h, 'internet').querySelector('[data-team-tab-action="open-settings"]').click();
  assert.deepEqual(h.opened, ['team'], 'Change opens Settings > Team');
  assert.match(rowText(h, 'folder'), /Team data 148\s?MB Open folder/);
  assert.equal(act(h, 'server-open-folder').disabled, false);
});

test('joining over the internet reads Off and says who can join', async (t) => {
  const { h } = await openTab(t, stopped());
  assert.match(rowText(h, 'internet'), /Joining over the internet Off Only people on this network can join\./);
  assert.match(rowText(h, 'autostart'), /Start with Jenny Off/);
  assert.equal(toggle(h).getAttribute('aria-checked'), 'false');
});

test('a PC with no row for the team says it is not signed in; Start is greyed with why, and Open Team settings sits beside it', async (t) => {
  const { h } = await openTab(t, { host: hostState({ state: 'stopped' }), teams: [] });
  assert.match(rowText(h, 'you'), /You Not signed in on this PC/);
  assert.equal(act(h, 'start-server').disabled, true);
  assert.match(h.view.q('[data-team-server="why"]').textContent, /Jenny needs your name and this PC’s name/);
  h.view.q('.team-srv__acts [data-team-tab-action="open-settings"]').click();
  assert.deepEqual(h.opened, ['team']);
  assert.equal(h.sent('hostDeploy').length, 0);
});

test('a lost key and a platform that cannot host each say their own sentence', async (t) => {
  const lost = await openTab(t, stopped({ key: 'missing' }));
  assert.match(lost.h.view.q('[data-team-server="why"]').textContent, /key for the team is missing/);
  assert.equal(act(lost.h, 'start-server').disabled, true);
  const platform = await openTab(t, stopped({ reason: 'team_host_platform_unavailable' }));
  assert.equal(platform.h.view.q('[data-team-server="why"]').textContent, words().errorText({ reason: 'team_host_platform_unavailable' }));
});

test('Force local greys Start with the state line as its tooltip, and sends nothing', async (t) => {
  const { h } = await openTab(t, { ...stopped(), answers: { status: { ok: true, teams: [ROW], force_local: true } } });
  const start = act(h, 'start-server');
  assert.equal(start.disabled, true);
  assert.equal(start.getAttribute('title'), words().forceLocalText());
  start.click();
  await flush();
  assert.equal(h.sent('hostDeploy').length, 0);
});

test('starting and stopping draw the page with their state; Start waits and no sentence says it cannot start', async (t) => {
  const starting = await openTab(t, { host: hostState({ state: 'starting' }), teams: [ROW] });
  assert.match(starting.h.view.q('.team-srv__state').textContent, /Starting…/);
  assert.equal(act(starting.h, 'start-server').disabled, true);
  assert.equal(starting.h.view.q('[data-team-server="why"]'), null);
  assert.equal(starting.h.view.q('.team-srv__acts [data-team-tab-action="open-settings"]'), null);
  assert.equal(starting.h.sent('hostSummary').length, 0, 'nothing is read while it starts');
  const stopping = await openTab(t, { host: hostState({ state: 'stopping' }), teams: [ROW] });
  assert.match(stopping.h.view.q('.team-srv__state').textContent, /Stopping…/);
  assert.equal(act(stopping.h, 'start-server').disabled, true);
});

test('a failed server says Stopped with a problem and the reason, and Start is there', async (t) => {
  const { h } = await openTab(t, stopped({ state: 'failed', reason: 'team_host_exited' }));
  assert.match(h.view.q('.team-srv__state').textContent, /Stopped with a problem/);
  assert.equal(h.view.q('.team-srv__note').textContent, words().errorText({ code: 'CMP-TEAM-0006', reason: 'team_host_exited' }));
  assert.equal(act(h, 'start-server').disabled, false);
});

test('earlier teams: a line each with the name, date, projects and size; Show files asks main, Delete opens Settings', async (t) => {
  const unnamed = { ...OLD, id: '20261101080000999', team_name: null, projects: 1, bytes: 2_000 };
  const { h } = await openTab(t, { ...stopped({ old_teams: [OLD, unnamed, { ...OLD, id: 'not-an-id' }] }) });
  assert.equal(h.view.q('.team-srv__h').textContent, 'Earlier teams on this PC');
  const lines = h.view.qa('[data-team-server="earlier"] [data-team-server-row]');
  assert.equal(lines.length, 2, 'a row without a valid id is not drawn');
  assert.match(flat(lines[0]), /Test team Set aside .*2026 2 projects · 31\s?MB Show files Delete…/);
  assert.match(flat(lines[1]), /Unnamed team/);
  assert.match(flat(lines[1]), /1 project · 2\s?kB/);
  lines[0].querySelector('[data-team-tab-action="server-old-show"]').click();
  await flush();
  assert.deepEqual(h.sent('hostOldShow').map((call) => call.payload), [{ set_aside_id: OLD_ID }]);
  h.view.qa('[data-team-server="earlier"] [data-team-server-row]')[0].querySelector('[data-team-tab-action="open-settings"]').click();
  assert.deepEqual(h.opened, ['team']);
  assert.equal(h.sent('hostOldDelete').length, 0, 'nothing is deleted from here');
});

// ----------------------------------------------------------- the calls

test('the switch asks for the opposite, is greyed while the call runs, seeds the host and keeps the keyboard focus', async (t) => {
  const gate = heldAnswers();
  const { h } = await openTab(t, { ...stopped(), answers: { hostAutostart: gate.answer } });
  toggle(h).focus();
  toggle(h).click();
  assert.deepEqual(gate.calls, [{ enabled: true }]);
  assert.equal(toggle(h).disabled, true, 'greyed while the call is in flight');
  toggle(h).click();
  assert.equal(gate.calls.length, 1, 'one call at a time');
  gate.release({ ok: true, host: hostState({ state: 'stopped', autostart: true }) });
  await flush();
  assert.equal(h.store.snapshot().host.autostart, true, 'the answer\'s host is in the store');
  assert.equal(toggle(h).getAttribute('aria-checked'), 'true');
  assert.equal(toggle(h).disabled, false);
  assert.equal(h.window.document.activeElement, toggle(h), 'the focus stayed on the control that was used');
  toggle(h).click();
  assert.deepEqual(gate.calls[1], { enabled: false });
  gate.release({ ok: true, host: hostState({ state: 'stopped', autostart: false }) });
  await flush();
  assert.equal(toggle(h).getAttribute('aria-checked'), 'false');
});

test('a refused switch says its sentence under its own row and leaves the others quiet', async (t) => {
  const error = { code: 'CMP-TEAM-0011', reason: 'team_store_failed' };
  const { h } = await openTab(t, { ...stopped(), answers: { hostAutostart: { ok: false, error } } });
  toggle(h).click();
  await flush();
  assert.equal(tabNote(h, 'autostart'), words().errorText(error));
  assert.deepEqual(notes(h), ['autostart']);
  assert.equal(h.view.q('[data-team-server-note="autostart"]').getAttribute('role'), 'status');
  assert.equal(toggle(h).getAttribute('aria-checked'), 'false');
  assert.equal(toggle(h).disabled, false);
});

test('Open folder calls hostOpenFolder; a refusal lands under the Team data row only', async (t) => {
  const { h } = await openTab(t, { ...stopped(), answers: { hostOpenFolder: REFUSED } });
  act(h, 'server-open-folder').click();
  assert.equal(act(h, 'server-open-folder').disabled, true);
  await flush();
  assert.equal(h.sent('hostOpenFolder').length, 1);
  assert.equal(h.sent('hostOpenFolder')[0].argc, 0);
  assert.equal(tabNote(h, 'folder'), words().errorText(REFUSED.error));
  assert.deepEqual(notes(h), ['folder']);
  assert.equal(act(h, 'server-open-folder').disabled, false);
});

test('a refused Show files says why under that earlier team', async (t) => {
  const { h } = await openTab(t, { ...stopped({ old_teams: [OLD] }), answers: { hostOldShow: { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_old_not_found' } } } });
  act(h, 'server-old-show').click();
  await flush();
  assert.equal(tabNote(h, 'old:' + OLD_ID), words().errorText({ reason: 'team_old_not_found' }));
  assert.deepEqual(notes(h), ['old:' + OLD_ID]);
});

test('Start sends the saved names; a refusal shows in the Start note and the facts are read again', async (t) => {
  let refuse = true;
  const { h } = await openTab(t, { ...stopped(), answers: {
    hostSummary: summary(),
    hostDeploy: () => (refuse ? { ok: false, error: { code: 'CMP-TEAM-0006', reason: 'team_host_start_failed' } } : { ok: true, host: hostState() }),
  } });
  assert.equal(h.sent('hostSummary').length, 1);
  act(h, 'start-server').click();
  assert.equal(act(h, 'start-server').disabled, true);
  await flush();
  assert.deepEqual(h.sent('hostDeploy').map((call) => call.payload), [{ name: 'Studio', display_name: 'Olive Owner', label: 'Desk' }]);
  assert.equal(tabNote(h, 'start'), words().errorText({ code: 'CMP-TEAM-0006', reason: 'team_host_start_failed' }));
  assert.deepEqual(notes(h), ['start']);
  assert.equal(h.sent('hostSummary').length, 2, 'read again after the failure, once');
  h.listeners.host({ ...hostState({ state: 'stopped' }), since: 2 });
  await flush();
  assert.equal(h.sent('hostSummary').length, 2, 'a push that changes nothing reads nothing');
  refuse = false;
  act(h, 'start-server').click();
  await flush();
  assert.equal(h.sent('hostDeploy').length, 2);
});

// ------------------------------------------------------- the summary read

test('the facts are read once for the page, not by a push or a redraw, and again once the server stopped after starting', async (t) => {
  const { h, s } = await openTab(t, { ...stopped(), answers: { hostSummary: summary() } });
  assert.equal(h.sent('hostSummary').length, 1);
  assert.equal(h.sent('hostSummary')[0].argc, 0);
  h.listeners.host({ ...hostState({ state: 'stopped' }), since: 2 });
  h.listeners.state({ teams: [ROW] });
  await flush();
  assert.equal(h.sent('hostSummary').length, 1);
  h.listeners.host(hostState({ state: 'starting' }));
  await flush();
  assert.match(h.view.q('.team-srv__state').textContent, /Starting…/);
  assert.equal(h.sent('hostSummary').length, 1, 'not while it starts');
  h.listeners.host(hostState({ state: 'stopped', since: 3 }));
  await flush();
  assert.equal(h.sent('hostSummary').length, 2, 'it stopped again');
  s.press('2');
  await flush();
  assert.equal(h.sent('hostSummary').length, 2, 'never while the page is hidden');
  s.press('6');
  await flush();
  assert.equal(h.sent('hostSummary').length, 3, 'once more each time the page is shown');
});

test('a failed read leaves the facts and the size empty and says nothing', async (t) => {
  const { h } = await openTab(t, { ...stopped(), answers: { hostSummary: { ok: false, error: { code: 'CMP-TEAM-0001', reason: '' } } } });
  assert.equal(h.sent('hostSummary').length, 1);
  assert.equal(facts(h), '');
  assert.match(rowText(h, 'folder'), /^Team data Open folder$/);
  assert.deepEqual(notes(h), []);
  assert.equal(h.view.qa('[role="status"]').length, 0);
});

test('a facts line missing a part draws the rest, and the line keeps its place before any answer', async (t) => {
  const gate = heldAnswers();
  const { h } = await openTab(t, { ...stopped(), answers: { hostSummary: gate.answer } });
  assert.equal(h.view.q('[data-team-server="facts"]').textContent, '', 'the line is there, empty, before the answer');
  gate.release(summary({ members: null, pending: 0, last_ran: null, bytes: null }));
  await flush();
  assert.equal(facts(h), '2 projects');
});

test('reset drops the page\'s state: an answer that arrives after the page was left writes nothing', async (t) => {
  const gate = heldAnswers();
  const { h, s } = await openTab(t, { ...stopped(), answers: { hostSummary: gate.answer } });
  s.press('2');
  await flush();
  gate.release(summary({ members: 9 }));
  await flush();
  s.press('6');
  await flush();
  assert.equal(gate.calls.length, 2, 'asked again for the new show');
  assert.equal(facts(h), '', 'the late answer of the first show is not shown');
  gate.release(summary({ members: 4 }));
  await flush();
  assert.match(facts(h), /^4 people/);
});

test('the module state is dropped by reset', () => {
  const calls = [];
  const store = { snapshot: () => ({ host: hostState({ state: 'stopped' }), teams: [] }), call: (method) => { calls.push(method); return new Promise(() => {}); } };
  const instance = server.create('tab', { store });
  const doc = { querySelector: (selector) => (selector.includes('page') ? {} : null) };
  const render = () => {};
  instance.fill(doc, render);
  instance.fill(doc, render);
  assert.deepEqual(calls, ['hostSummary'], 'read once for the team');
  instance.reset();
  instance.fill(doc, render);
  assert.deepEqual(calls, ['hostSummary', 'hostSummary'], 'a reset page reads again');
});

// ------------------------------------------------------ Settings > Team

const group = (h, id) => h.q(`[data-team-group="${id}"]`);
const settingsToggle = (h) => h.q('[data-inv-toggle="teamSetSrvAuto"]');
const profileNote = (h) => h.q('[data-team-server-note^="profile:"]')?.textContent || '';
const save = (h) => h.q('[data-team-action="profile-save"]');
const nameField = (h) => h.q('#teamProfileName-0');
const pcField = (h) => h.q('#teamProfilePc-0');

test('Settings: This server is drawn only while a server is deployed here, before People', async (t) => {
  const none = harness({ host: NONE, teams: [] });
  t.after(none.restore);
  await flush();
  assert.equal(group(none, 'server'), null);
  for (const state of ['stopped', 'running']) {
    const h = harness({ host: hostState({ state }), teams: [snapshot({ label: 'Desk' })] });
    t.after(h.restore);
    await flush();
    assert.ok(group(h, 'server'), state);
    assert.equal(group(h, 'server').querySelector('.settings-group-heading').textContent, 'This server');
    const order = h.qa('[data-team-group]').map((el) => el.dataset.teamGroup);
    if (order.includes('people')) assert.ok(order.indexOf('server') < order.indexOf('people'), state);
  }
});

test('Settings: the switch and Team data use the same calls, the size is read when the page is shown, and a refusal says why under the row', async (t) => {
  const gate = heldAnswers();
  const h = harness({ host: hostState({ state: 'stopped' }), teams: [ROW], answers: { hostSummary: summary(), hostAutostart: gate.answer, hostOpenFolder: REFUSED } });
  t.after(h.restore);
  await flush();
  assert.equal(h.sent('hostSummary').length, 1);
  assert.match(group(h, 'server').textContent, /148\s?MB on this PC/);
  assert.match(group(h, 'server').textContent, /Start this server when Jenny starts\./);
  h.listeners.host({ ...hostState({ state: 'stopped' }), since: 2 });
  await flush();
  assert.equal(h.sent('hostSummary').length, 1, 'not on every render or push');
  settingsToggle(h).click();
  assert.deepEqual(gate.calls, [{ enabled: true }]);
  assert.equal(settingsToggle(h).disabled, true);
  gate.release({ ok: true, host: hostState({ state: 'stopped', autostart: true }) });
  await flush();
  assert.equal(settingsToggle(h).getAttribute('aria-checked'), 'true');
  assert.equal(h.store.snapshot().host.autostart, true);
  h.q('[data-team-action="server-open-folder"]').click();
  await flush();
  assert.equal(h.sent('hostOpenFolder').length, 1);
  assert.equal(h.q('[data-team-server-note="folder"]').textContent, words().errorText(REFUSED.error));
});

test('Settings: a You row has both names, Save only for a real change, and sends only the changed field', async (t) => {
  const h = harness({ host: hostState({ state: 'running' }), teams: [snapshot({ label: 'Desk' })] });
  t.after(h.restore);
  await flush();
  assert.ok(group(h, 'profile'), 'the You row');
  assert.equal(group(h, 'you'), null, 'the first-run group is not also drawn');
  assert.equal(nameField(h).value, 'Olive Owner');
  assert.equal(pcField(h).value, 'Desk');
  assert.equal(save(h).disabled, true, 'nothing differs');
  assert.equal(group(h, 'profile').querySelector('.settings-field-title'), null, 'one team: no team label');
  h.type('#teamProfileName-0', '   ');
  assert.equal(save(h).disabled, true, 'blank');
  h.type('#teamProfileName-0', 'x'.repeat(41));
  assert.equal(save(h).disabled, true, 'too long');
  h.type('#teamProfileName-0', '  Olive R  ');
  assert.equal(save(h).disabled, false);
  assert.equal(nameField(h).value, '  Olive R  ', 'what was typed stays');
  save(h).click();
  await flush();
  assert.deepEqual(h.sent('profileSet').map((call) => call.payload), [{ team_id: TEAM, display_name: 'Olive R' }]);
  assert.equal(nameField(h).value, 'Olive Owner', 'the draft is cleared after a success');
  assert.equal(save(h).disabled, true);
  h.type('#teamProfilePc-0', 'Laptop');
  h.type('#teamProfileName-0', 'Olive O');
  save(h).click();
  await flush();
  assert.deepEqual(h.sent('profileSet')[1].payload, { team_id: TEAM, display_name: 'Olive O', label: 'Laptop' });
  h.type('#teamProfilePc-0', 'Desk');
  h.type('#teamProfileName-0', 'Olive Owner');
  assert.equal(save(h).disabled, true, 'back to what is saved');
  assert.equal(h.sent('profileSet').length, 2);
});

test('Settings: a refused change says its sentence under the row, keeps what was typed and gives Save back', async (t) => {
  const error = { code: 'CMP-TEAM-0003', reason: 'team_display_name_taken' };
  const h = harness({ host: NONE, teams: [snapshot({ label: 'Desk' })], answers: { profileSet: { ok: false, error } } });
  t.after(h.restore);
  await flush();
  h.type('#teamProfileName-0', 'Dot');
  save(h).click();
  assert.equal(save(h).disabled, true, 'busy');
  await flush();
  assert.equal(profileNote(h), words().errorText(error));
  assert.equal(h.q('[data-team-server-note^="profile:"]').getAttribute('role'), 'status');
  assert.equal(nameField(h).value, 'Dot');
  assert.equal(save(h).disabled, false);
  for (const reason of ['team_display_name_invalid', 'team_label_invalid']) assert.ok(words().errorText({ reason }).length > 10, reason);
});

test('Settings: while the team is not online the names and Save are greyed with the reason', async (t) => {
  const h = harness({ host: NONE, teams: [snapshot({ label: 'Desk', state: 'offline' })] });
  t.after(h.restore);
  await flush();
  assert.equal(nameField(h).disabled, true);
  assert.equal(pcField(h).disabled, true);
  assert.equal(save(h).disabled, true);
  assert.equal(save(h).getAttribute('title'), 'Connect to the team to change this.');
  assert.match(group(h, 'profile').textContent, /Connect to the team to change this\./);
  assert.equal(h.sent('profileSet').length, 0);
});

test('Settings: several teams, a row each with the team\'s name; an unfilled device name is read from the device list', async (t) => {
  const h = harness({ host: NONE, teams: [snapshot(), memberTeam({ label: 'Laptop' })] });
  t.after(h.restore);
  await flush();
  const titles = h.qa('[data-team-group="profile"] .settings-field-title').map((el) => el.textContent);
  assert.deepEqual(titles, ['Studio', 'Dot lab']);
  assert.equal(h.q('#teamProfilePc-0').value, 'Desk', 'the device list names this PC');
  assert.equal(h.q('#teamProfilePc-1').value, 'Laptop');
  h.type('#teamProfileName-1', 'Dotty');
  assert.equal(h.qa('[data-team-action="profile-save"]').map((el) => el.disabled).join(), 'true,false');
  h.qa('[data-team-action="profile-save"]')[1].click();
  await flush();
  assert.deepEqual(h.sent('profileSet').map((call) => call.payload), [{ team_id: OTHER, display_name: 'Dotty' }]);
});

test('Settings: the first-run You group stays while no team exists', async (t) => {
  const h = harness({ host: NONE, teams: [] });
  t.after(h.restore);
  await flush();
  assert.ok(group(h, 'you'));
  assert.equal(group(h, 'profile'), null);
});

test('the activity log says a changed name in a sentence', () => {
  const who = (id) => (id === 'member_dot' ? 'Dot' : '');
  assert.equal(words().activityText({ kind: 'member_profile_changed', actor_member_id: 'member_dot' }, who), 'Dot changed their name or PC name.');
  assert.equal(words().activityText({ kind: 'member_profile_changed' }, who), 'Someone changed their name or PC name.');
});

// In the app the owner's membership loads at launch, so their row is there and only offline while their server is down.
test('the owner\'s offline row with the server stopped: the server page with a working Start; a running server shows the team', async (t) => {
  const row = snapshot({ state: 'offline', label: 'Desk' });
  const { h } = await openTab(t, { host: hostState({ state: 'stopped' }), teams: [row], answers: { hostSummary: summary() } });
  assert.ok(page(h), 'the server page, not the offline channel');
  assert.equal(act(h, 'start-server').disabled, false);
  assert.match(rowText(h, 'you'), /You Olive Owner on Desk/);
  h.listeners.host(hostState({ state: 'starting' }));
  await flush();
  assert.match(h.view.q('.team-srv__state').textContent, /Starting/);
  h.listeners.host(hostState());
  h.listeners.state({ teams: [snapshot({ label: 'Desk' })] });
  await flush();
  assert.equal(page(h), null, 'the team itself once its server runs');
});

test('a team hosted elsewhere that is offline keeps its channel while this PC\'s own server is stopped', async (t) => {
  const { h, s } = await openTab(t, { host: hostState({ state: 'stopped' }), teams: [snapshot({ state: 'offline', label: 'Desk' }), memberTeam({ state: 'offline' })] });
  assert.ok(page(h), 'the hosted team is selected first');
  assert.ok(s, 'the shell');
  assert.ok(h.view.q('#teamTabPanel'), 'the switcher is there to reach the other team');
});
