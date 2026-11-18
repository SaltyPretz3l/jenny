'use strict';

// new-test-file: shared projects in the Team tab's left column (row 123 slice 3-10, picks_3-10.md "Left column"): the
// Projects section by role, fold state, running and the counts from pushes, create in place, the owner's muted row,
// the admin's request count on the row and in the Team tab number with its tooltip, hostile names, and nothing left
// behind. A new surface: renderer-team-tab.test.js is at its size and pins the chat column.

const test = require('node:test');
const assert = require('node:assert/strict');

const { P1, P2, P3, S1, S2, OTHER, project, listAnswer, rulesAnswer, openProjects, projectRow, region, flush, memberTeam } = require('./helpers/team-project-renderer-host');
const { shell, heldAnswers, chatPush, chatChannel } = require('./helpers/team-settings-harness');

const sectionOrder = (h) => [...h.view.q('[data-team-region="lists"]').children].map((el) => el.className.split(' ')[0]);
const kids = (h, id) => h.view.q(`[data-team-project="${id}"]`);
const label = (el) => el.getAttribute('aria-label');

test('a writer: Projects sits between direct messages and the people; the first project is open with its channel, conversations and New conversation', async (t) => {
  const { h } = await openProjects();
  t.after(h.restore);
  const order = sectionOrder(h);
  assert.ok(order.indexOf('team-projects') > order.indexOf('team-channels') && order.indexOf('team-projects') < order.indexOf('team-people'), order.join(','));
  assert.ok(h.view.q('.team-projects [data-team-tab-action="project-new"]'), 'a member may create a project');
  assert.equal(h.view.q('.team-projects [data-team-tab-action="project-new"]').getAttribute('title'), 'New project');
  assert.equal(kids(h, P1).dataset.open, 'true', 'the first project is open');
  assert.equal(kids(h, P2).dataset.open, 'false', 'the others are folded');
  const p1 = kids(h, P1);
  assert.ok(p1.querySelector(`[data-team-channel="chan_${P1}"]`).textContent.includes('jenny-site'), 'the project channel, named by the project');
  assert.deepEqual([...p1.querySelectorAll('[data-team-tab-action="conv-open"]')].map((el) => el.textContent), ['Palette loader cleanup', 'Blog post draft']);
  assert.ok(p1.querySelector('[data-team-tab-action="conv-new"]'), 'a writer starts conversations');
  for (const button of h.view.qa('.team-projects button')) assert.ok(button.getAttribute('title'), 'every button has a tooltip: ' + button.outerHTML.slice(0, 80));
});

test('a reader in a read-only team: no plus, no New conversation; the project and its conversations are listed', async (t) => {
  const { h } = await openProjects({ team: memberTeam({ role: 'read_only' }), list: listAnswer({ projects: [project(P1, 'jenny-site', 'reader')] }) });
  t.after(h.restore);
  assert.equal(h.view.q('[data-team-tab-action="project-new"]'), null, 'a read-only member does not see the plus');
  assert.equal(h.view.q('[data-team-tab-action="conv-new"]'), null, 'a reader starts no conversation');
  assert.equal(h.view.qa('[data-team-tab-action="conv-open"]').length, 2);
});

test('fold and unfold are kept per project across redraws', async (t) => {
  const { h, push } = await openProjects();
  t.after(h.restore);
  h.view.q(`[data-team-tab-action="project-fold"][data-project-id="${P2}"]`).click();
  h.view.q(`[data-team-tab-action="project-fold"][data-project-id="${P1}"]`).click();
  assert.equal(kids(h, P2).dataset.open, 'true');
  assert.equal(kids(h, P1).dataset.open, 'false');
  assert.equal(h.view.q(`[data-team-tab-action="project-fold"][data-project-id="${P1}"]`).getAttribute('title'), 'Unfold jenny-site');
  push({ kind: 'projects', ...listAnswer() });
  await flush();
  assert.equal(kids(h, P2).dataset.open, 'true', 'a list push keeps the folds');
  assert.equal(kids(h, P1).dataset.open, 'false');
});

test('running and the approval count come from the activity push, in words and as a count', async (t) => {
  const { h, push } = await openProjects();
  t.after(h.restore);
  const row = () => h.view.q(`[data-session-id="${S1}"]`);
  assert.equal(label(row()), 'Palette loader cleanup', 'nothing after an app start');
  push({ kind: 'activity', session_id: S1, running: true, approvals: 0 });
  assert.equal(label(row()), 'Palette loader cleanup, running');
  push({ kind: 'activity', session_id: S1, running: true, approvals: 2 });
  assert.equal(label(row()), 'Palette loader cleanup, running, 2 approvals waiting');
  assert.equal(row().querySelector('.team-count').textContent, '2');
  push({ kind: 'activity', session_id: S1, running: false, approvals: 0 });
  assert.equal(label(row()), 'Palette loader cleanup');
  assert.equal(row().querySelector('.team-count'), null);
});

test('an admin\'s waiting requests: read once per admin project, kept by the push, on the row and in the Team tab number', async (t) => {
  const { h, push } = await openProjects({ show: false, answers: { projectRules: (p) => rulesAnswer({ project_id: p.project_id, open_request_count: p.project_id === P2 ? 3 : 0 }) } });
  t.after(h.restore);
  const s = shell(h, { activeView: 'team' });
  await flush();
  await flush();
  assert.deepEqual(h.sent('projectRules').map((c) => c.payload.project_id), [P2], 'only the project this member administers');
  assert.equal(label(projectRow(h, P2)), 'palette-tools, 3 always-allow requests wait for you');
  assert.equal(s.count(), '3');
  assert.equal(s.teamTab().getAttribute('aria-label'), 'Team: 3 always-allow requests wait for you');
  push({ kind: 'rule_requests', project_id: P2, open_count: 1 });
  await flush();
  assert.equal(label(projectRow(h, P2)), 'palette-tools, 1 always-allow request waits for you');
  assert.equal(s.teamTab().getAttribute('title'), 'Team: 1 always-allow request waits for you');
  push({ kind: 'rule_requests', project_id: P1, open_count: 5 });
  await flush();
  assert.equal(s.count(), '1', 'a project this member does not administer is not counted');
  assert.equal(h.sent('projectRules').length, 1, 'the push keeps it; nothing is read again');
});

test('the tab number\'s label: any mix reads as one sentence, the landed labels unchanged', () => {
  const { badgeLabel } = require('../renderer/team/renderer-team-tab-gate');
  assert.equal(badgeLabel(2, 1, 0), 'Team: 2 channels mention you, 1 person wants to join');
  assert.equal(badgeLabel(1, 0, 1), 'Team: 1 channel mentions you, 1 unread conversation');
  assert.equal(badgeLabel(0, 0, 0, 2), 'Team: 2 always-allow requests wait for you');
  assert.equal(badgeLabel(1, 2, 1, 1), 'Team: 1 channel mentions you, 1 unread conversation, 1 always-allow request waits for you, 2 people want to join');
});

test('create in place: the plus opens a field, Enter creates, the new project opens on its empty page', async (t) => {
  const { h, push } = await openProjects({ answers: { projectCreate: (p) => ({ ok: true, project_id: P3, name: p.name, channel: true }) } });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="project-new"]').click();
  const field = h.view.q('#teamProjectNewName');
  assert.equal(h.window.document.activeElement, field, 'the field has the focus');
  field.value = 'docs-rewrite';
  field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  field.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(h.sent('projectCreate').map((c) => c.payload), [{ team_id: OTHER, name: 'docs-rewrite' }]);
  assert.equal(h.view.q('#teamProjectNewName'), null, 'the field closed');
  assert.ok(region(h), 'the page frame is shown before the list names it');
  push({ kind: 'projects', ...listAnswer({ projects: [project(P3, 'docs-rewrite', 'admin'), ...listAnswer().projects] }) });
  await flush();
  assert.match(region(h).textContent, /A new project starts empty/);
  assert.match(region(h).textContent, /No files yet\./);
  assert.equal(h.view.q('.team-head__name').textContent, 'docs-rewrite');
});

test('create refused: the sentence stays under the field; an empty name sends nothing', async (t) => {
  const { h } = await openProjects({ answers: { projectCreate: { ok: false, error: { reason: 'team_project_exists' } } } });
  t.after(h.restore);
  h.view.q('[data-team-tab-action="project-new"]').click();
  h.view.q('[data-team-tab-action="project-create"]').click();
  await flush();
  assert.equal(h.sent('projectCreate').length, 0);
  assert.match(h.view.q('.team-projects').textContent, /Use 1 to 80 characters/);
  const field = h.view.q('#teamProjectNewName');
  field.value = 'jenny-site';
  field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.view.q('[data-team-tab-action="project-create"]').click();
  await flush();
  assert.match(h.view.q('.team-projects').textContent, /That project already exists/);
});

test('the team owner not in a project: a muted row with its tooltip, and Add myself joins as an admin', async (t) => {
  const { h, push } = await openProjects({ team: memberTeam({ role: 'owner' }), answers: { projectUnjoined: { ok: true, projects: [{ project_id: P3, name: 'release-notes' }], truncated: false } } });
  t.after(h.restore);
  const row = projectRow(h, P3);
  assert.equal(row.getAttribute('title'), 'You are not in this project');
  assert.equal(row.querySelector('.team-row__name').dataset.muted, 'true');
  assert.equal(kids(h, P3).querySelector('[data-team-tab-action="project-fold"]'), null, 'no chevron, nothing under it');
  row.click();
  await flush();
  assert.match(region(h).textContent, /You are not in this project, so its conversations/);
  region(h).querySelector('[data-project-action="join"]').click();
  await flush();
  assert.deepEqual(h.sent('projectJoin').map((c) => c.payload), [{ team_id: OTHER, project_id: P3, role: 'admin' }]);
  push({ kind: 'projects', ...listAnswer({ projects: [...listAnswer().projects, project(P3, 'release-notes', 'admin')] }) });
  await flush();
  assert.ok(region(h).querySelector('[data-team-project-section="members"]'), 'the member page follows');
});

test('hostile names: markup, bidi controls and 500 characters are drawn as cleaned, cut text', async (t) => {
  const evil = '<img src=x onerror="globalThis.pwned=1">‮evil' + 'x'.repeat(500);
  const { h } = await openProjects({ list: listAnswer({ projects: [project(P1, evil, 'admin')], conversations: [{ session_id: S1, project_id: P1, title: evil }] }) });
  t.after(h.restore);
  assert.equal(h.view.q('.team-projects').querySelector('img, [onerror], [onclick], [src]'), null, 'no element or attribute from a name');
  for (const el of [projectRow(h, P1).querySelector('.team-row__name'), h.view.q(`[data-session-id="${S1}"] .team-row__name`)]) {
    assert.ok(el.textContent.startsWith('<img src=x'), 'drawn as text');
    assert.ok(!el.textContent.includes('‮'), 'bidi control removed');
    assert.ok(Array.from(el.textContent).length <= 80, 'cut: ' + el.textContent.length);
    assert.equal(el.getAttribute('dir'), 'auto');
  }
  projectRow(h, P1).click();
  await flush();
  assert.equal(region(h).querySelector('img, [onerror], [onclick], [src]'), null);
  assert.equal(globalThis.pwned, undefined);
});

test('nothing left behind: hiding the tab drops the push subscription and the store\'s holds; a chat push repaints no project page', async (t) => {
  const { h, subscribers } = await openProjects();
  t.after(h.restore);
  projectRow(h, P1).click();
  await flush();
  const mutations = [];
  const observer = new h.window.MutationObserver((list) => mutations.push(...list));
  observer.observe(region(h), { childList: true, subtree: true, characterData: true, attributes: true });
  h.listeners.chat({ team_id: OTHER, type: 'typing', channel_id: 'chan_team', member_id: 'member_maya' });
  h.listeners.chat({ team_id: OTHER, type: 'presence', members: [] });
  await flush();
  observer.disconnect();
  assert.equal(mutations.length, 0, 'the project page was not touched by chat pushes');
  assert.equal(subscribers(), 1);
  const store = require('../renderer/team/renderer-team-project-store').getProjectStore();
  h.tab.hideTeamTab();
  assert.equal(subscribers(), 0, 'no push subscription after hiding');
  assert.deepEqual(store.resources(), { teams: 0, subscribed: false, listeners: 0, holds: 0, retries: 0 });
});

test('leaving the team drops its projects and the shown page', async (t) => {
  const { h, push } = await openProjects();
  t.after(h.restore);
  projectRow(h, P1).click();
  await flush();
  assert.ok(region(h));
  push({ kind: 'team_gone' });
  await flush();
  assert.equal(region(h), null, 'the page closed');
  assert.equal(h.view.q('.team-projects'), null, 'the section went with the team\'s projects');
  void S2;
});

// ------------------------------------------------------------------ fix list (3-10)

test('fix list S7: a failed list read is tried again after 5 s doubling to 60 s, and tells the views only when its sentence changes', async (t) => {
  let fail = 'team_offline';
  const { h } = await openProjects({ show: false, answers: { projectList: () => (fail ? { ok: false, error: { reason: fail } } : listAnswer()) } });
  t.after(h.restore);
  const armed = [];
  const timers = { set: (fn, ms) => { armed.push({ fn, ms }); return armed.length; }, clear: () => {} };
  const { createProjectStore } = require('../renderer/team/renderer-team-project-store');
  const store = createProjectStore({ windowRef: h.window, teams: () => [memberTeam()], timers });
  const changes = [];
  store.subscribe((change) => changes.push(change.type));
  t.after(store.use());
  await flush();
  for (let i = 0; i < 6; i += 1) { store.sync(); armed[armed.length - 1].fn(); await flush(); }
  assert.deepEqual(armed.map((a) => a.ms), [5000, 10000, 20000, 40000, 60000, 60000, 60000], 'sync() does not read again while a retry is armed');
  assert.equal(h.sent('projectList').filter((c) => c.payload).length >= 7, true);
  assert.deepEqual(changes, ['projects'], 'the same refusal seven times tells the views once');
  fail = 'team_unreachable';
  armed[armed.length - 1].fn();
  await flush();
  assert.deepEqual(changes, ['projects', 'projects'], 'a new sentence tells them');
  fail = '';
  armed[armed.length - 1].fn();
  await flush();
  assert.equal(store.team(OTHER).projects.length, 2);
  assert.equal(store.resources().retries, 0);
  store.dispose();
});

test('fix list S8: at most three request counts are read at a time; a failed one is read again 30 s later', async (t) => {
  const admin = ['a', 'b', 'c', 'd', 'e'].map((n) => project('project_' + n.repeat(12), 'p-' + n, 'admin'));
  const held = heldAnswers();
  let clock = 1000;
  const { h } = await openProjects({ show: false, list: listAnswer({ projects: admin, conversations: [] }), answers: { projectRules: held.answer } });
  t.after(h.restore);
  const { createProjectStore } = require('../renderer/team/renderer-team-project-store');
  const store = createProjectStore({ windowRef: h.window, teams: () => [memberTeam()], now: () => clock });
  t.after(store.use());
  await flush();
  assert.equal(held.calls.length, 3, 'three at a time');
  held.release({ ok: false, error: { reason: 'team_offline' } });
  await flush();
  assert.equal(held.calls.length, 4, 'a finished read starts the next');
  for (let i = 0; i < 4; i += 1) { held.release(rulesAnswer({ open_request_count: 1 })); await flush(); }
  assert.equal(held.calls.length, 5);
  assert.equal(store.requestCount(), 4, 'the failed one is not counted as read');
  store.sync();
  await flush();
  assert.equal(held.calls.length, 5, 'not again within 30 s');
  clock += 30_000;
  store.sync();
  await flush();
  assert.equal(held.calls.length, 6, 'read again after 30 s');
  assert.equal(held.calls[5].project_id, held.calls[0].project_id);
  held.release(rulesAnswer({ open_request_count: 2 }));
  await flush();
  assert.equal(store.requestCount(), 6);
  store.dispose();
});

test('fix list S7/S9: a repeated activity push tells nobody; activity, requests and list pushes redraw the lists and keep the notify menu open', async (t) => {
  const { h, push } = await openProjects();
  t.after(h.restore);
  const store = require('../renderer/team/renderer-team-project-store').getProjectStore();
  const changes = [];
  t.after(store.subscribe((change) => changes.push(change.type)));
  push({ kind: 'activity', session_id: S1, running: true, approvals: 0 });
  push({ kind: 'activity', session_id: S1, running: true, approvals: 0 });
  assert.deepEqual(changes, ['activity'], 'the same activity twice is one change');
  h.view.q('[data-team-tab-action="notify"]').click();
  await flush();
  const menu = () => h.window.document.querySelector('.inv-context-menu.team-notify-menu');
  assert.ok(menu(), 'the menu is open');
  push({ kind: 'activity', session_id: S1, running: true, approvals: 1 });
  push({ kind: 'rule_requests', project_id: P2, open_count: 2 });
  push({ kind: 'projects', ...listAnswer({ projects: [project(P1, 'jenny-site', 'writer'), project(P2, 'palette-tools', 'admin', { root_revision: 5 })] }) });
  await flush();
  assert.ok(menu(), 'still open after the pushes');
  assert.equal(label(h.view.q(`[data-session-id="${S1}"]`)), 'Palette loader cleanup, running, 1 approval waiting', 'the lists were redrawn');
});

test('fix list S14: a project gone from the list loses its fold; back again it folds as new', async (t) => {
  const { h, push } = await openProjects();
  t.after(h.restore);
  h.view.q(`[data-team-tab-action="project-fold"][data-project-id="${P2}"]`).click();
  assert.equal(kids(h, P2).dataset.open, 'true');
  push({ kind: 'projects', ...listAnswer({ projects: [project(P1, 'jenny-site', 'writer')] }) });
  await flush();
  assert.equal(kids(h, P2), null);
  push({ kind: 'projects', ...listAnswer() });
  await flush();
  assert.equal(kids(h, P2).dataset.open, 'false', 'its fold was dropped with it');
});

test('fix list S15/T6: Alt+Down skips the rows of a folded project; F6 reaches the project region', async (t) => {
  const { h } = await openProjects();
  t.after(h.restore);
  const doc = h.window.document;
  const press = (key, init = {}) => doc.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  h.view.q(`[data-team-tab-action="project-fold"][data-project-id="${P1}"]`).click();
  projectRow(h, P1).focus();
  press('ArrowDown', { altKey: true });
  assert.equal(doc.activeElement, projectRow(h, P2), 'over the folded project\'s rows to the next project');
  press('ArrowUp', { altKey: true });
  assert.equal(doc.activeElement, projectRow(h, P1));
  projectRow(h, P2).click();
  await flush();
  projectRow(h, P2).focus();
  let reached = false;
  for (let i = 0; i < 6 && !reached; i += 1) { press('F6'); reached = region(h).contains(doc.activeElement); }
  assert.ok(reached, 'F6 reaches the project page');
});

test('fix list T6: Force local with a page open closes the page', async (t) => {
  const { h } = await openProjects();
  t.after(h.restore);
  projectRow(h, P1).click();
  await flush();
  assert.ok(region(h));
  h.listeners.state({ teams: [memberTeam({ state: 'force_local', role: null, member_state: null, reason: 'team_force_local' })], force_local: true });
  await flush();
  assert.equal(region(h), null, 'the page closed');
});

test('fix list T6: the narrow layout (E43): a project or conversation opens the second screen; Back returns to the list', async (t) => {
  const { h } = await openProjects();
  t.after(h.restore);
  const screen = () => h.view.q('.team-shell').dataset.screen;
  projectRow(h, P1).click();
  await flush();
  assert.equal(screen(), 'channel', 'the page is the second screen');
  region(h).querySelector('[data-team-tab-action="back"]').click();
  await flush();
  assert.equal(screen(), 'list');
  h.view.q(`[data-session-id="${S1}"]`).click();
  await flush();
  assert.equal(screen(), 'channel');
});

// Owner report (team overview B3): a project channel the chat rows do not hold yet would open #team; it is drawn, not
// as a link, until the rows hold it.
test('a project channel the chat rows do not hold is drawn as a row that is not a link, then a normal row once listed', async (t) => {
  const { h } = await openProjects();
  t.after(h.restore);
  const loading = () => kids(h, P2).querySelector(`[data-team-channel-loading="chan_${P2}"]`);
  assert.equal(kids(h, P2).querySelector(`[data-team-channel="chan_${P2}"]`), null, 'no link to a channel that cannot open');
  assert.equal(loading().getAttribute('aria-disabled'), 'true');
  assert.equal(loading().getAttribute('title'), 'This channel is still loading.');
  assert.ok(loading().textContent.includes('palette-tools'), 'named by the project');
  const shown = () => h.view.q('[data-team-channel][aria-current="true"]')?.dataset.teamChannel ?? null;
  const before = shown();
  loading().click();
  await flush();
  assert.equal(shown(), before, 'a click opens nothing');
  chatPush(h, { type: 'channels', channels: [chatChannel(), chatChannel({ channel_id: 'chan_' + P1, kind: 'project' }),
    chatChannel({ channel_id: 'chan_' + P2, kind: 'project' })] });
  await flush();
  assert.ok(kids(h, P2).querySelector(`[data-team-channel="chan_${P2}"]`), 'a normal row once the chat rows hold it');
  assert.equal(loading(), null);
});

test('row 175 F9: the counts main seeded from the host list show at the first draw; question batches are kept per conversation', async (t) => {
  const { h, push } = await openProjects({ list: listAnswer({ activity: { [S1]: { approvals: 2, running: false, questions: 1 } } }) });
  t.after(h.restore);
  const row = () => h.view.q(`[data-session-id="${S1}"]`);
  assert.equal(label(row()), 'Palette loader cleanup, 2 approvals waiting', 'known before any event');
  const { getProjectStore } = require('../renderer/team/renderer-team-project-store');
  assert.deepEqual(getProjectStore().team(OTHER).activity[S1], { approvals: 2, running: false, questions: 1 });
  push({ kind: 'activity', session_id: S1, running: false, approvals: 0, questions: 1 });
  assert.deepEqual(getProjectStore().team(OTHER).activity[S1], { running: false, approvals: 0, questions: 1 });
  push({ kind: 'activity', session_id: S1, running: false, approvals: 0 });
  assert.equal(getProjectStore().team(OTHER).activity[S1], undefined);
});
