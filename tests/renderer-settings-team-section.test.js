'use strict';

// Settings > Team (row 123, slice 1g-1): with the `team` flag off nothing of the
// page exists (no nav item, no card, no script, no bridge call); with it on, the
// page renders each state from the host status and the joined teams, through
// the real inventory modules and a stubbed `window.jennyShell.team`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  TEAM, OTHER, ME, DOT, MAYA, DESK, NONE, CODE, flush, micro, snapshot, memberTeam, hostState, device, ROSTER, harness, shell, OWN_KEY_LINE, OWN_KEY_CASES,
} = require('./helpers/team-settings-harness');

// ------------------------------------------------------------------ flag off

test('Team off: no nav item, no card, no team script requested, no bridge call', () => {
  const dom = new JSDOM(`<!doctype html><body><div class="settings-nav"><div class="settings-nav-header"></div><div class="settings-nav-scroll"></div></div>
    <section class="settings-card" data-settings-section="team" data-feature-flag="team" id="teamSettingsSection" hidden><div id="teamSettingsBody"></div></section></body>`);
  const { window } = dom;
  const saved = { document: globalThis.document };
  globalThis.document = window.document;
  try {
    const nav = require('../renderer/shell/renderer-settings-nav-utils');
    assert.equal(nav.renderSettingsNav(window.document), true);
    const item = window.document.querySelector('[data-settings-section="team"].settings-nav-item');
    assert.ok(item, 'the registry renders the Team item');
    assert.equal(item.getAttribute('data-feature-flag'), 'team');
    assert.equal(item.hidden, true, 'hidden until the flag state says on');
    nav.syncFeatureFlaggedSettings(window.document, { team: false });
    assert.equal(item.hidden, true);
    assert.equal(window.document.getElementById('teamSettingsSection').hidden, true);
    const option = window.document.querySelector('#settingsNavPicker option[value="team"]');
    assert.equal(option.hidden, true);

    const requested = [];
    const touched = [];
    const windowRef = {
      document: window.document,
      scriptLoaderUtils: { ensureScript: ({ src }) => { requested.push(src); return Promise.resolve(true); } },
      jennyShell: { team: new Proxy({}, { get(_t, name) { touched.push(name); return () => Promise.resolve({ ok: true }); } }) },
    };
    const { syncTeamSettingsSection } = require('../renderer/shell/renderer-settings-utils');
    const state = { features: { featureFlags: { team: false } }, ui: { activeView: 'settings', activeSettingsSection: 'team' } };
    syncTeamSettingsSection({ state, windowRef, activeSection: 'team' });
    assert.deepEqual(requested, []);
    assert.deepEqual(touched, []);
    // A flag state that is missing reads as off.
    syncTeamSettingsSection({ state: { features: {}, ui: state.ui }, windowRef, activeSection: 'team' });
    assert.deepEqual(requested, []);
    assert.equal(item.hidden, true);
    assert.equal(window.document.querySelector('link[href="styles/team-settings.css"]'), null, 'no team stylesheet either');
  } finally {
    globalThis.document = saved.document;
  }
});

test('Team on: the nav item and card show, a stored team section resolves, and the team scripts load on first show', async () => {
  const dom = new JSDOM(`<!doctype html><body><div class="settings-nav"><div class="settings-nav-header"></div><div class="settings-nav-scroll"></div></div>
    <section class="settings-card" data-settings-section="team" data-feature-flag="team" id="teamSettingsSection" hidden><div id="teamSettingsBody"></div></section></body>`);
  const { window } = dom;
  const nav = require('../renderer/shell/renderer-settings-nav-utils');
  nav.renderSettingsNav(window.document);
  nav.syncFeatureFlaggedSettings(window.document, { team: true });
  assert.equal(window.document.querySelector('.settings-nav-item[data-settings-section="team"]').hidden, false);
  assert.equal(window.document.getElementById('teamSettingsSection').hidden, false);
  const order = [...window.document.querySelectorAll('.settings-nav-item')].map((item) => item.dataset.settingsSection);
  assert.equal(order[order.indexOf('runtime') + 1], 'team', 'Team follows Projects');

  const manifest = require('../renderer/shell/renderer-settings-script-manifest');
  assert.ok(Array.isArray(manifest.teamSection) && manifest.teamSection.length > 0);
  assert.equal(manifest.some(([src]) => src.includes('settings-team')), false, 'no team script in the always-loaded group');
  const requested = [];
  const windowRef = {
    document: window.document,
    scriptLoaderUtils: { ensureScript: ({ src }) => { requested.push(src); return Promise.resolve(false); } },
    jennyShell: { team: {} },
  };
  const { syncTeamSettingsSection } = require('../renderer/shell/renderer-settings-utils');
  const state = { features: { featureFlags: { team: true } }, ui: { activeView: 'settings', activeSettingsSection: 'team' } };
  syncTeamSettingsSection({ state, windowRef, activeSection: 'models' });
  assert.deepEqual(requested, [], 'not loaded while another section shows');
  syncTeamSettingsSection({ state, windowRef, activeSection: 'team' });
  await flush();
  assert.deepEqual(requested, manifest.teamSection.map(([src]) => src));
  syncTeamSettingsSection({ state, windowRef, activeSection: 'team' });
  await flush();
  const sheets = window.document.querySelectorAll('link[rel="stylesheet"][href="styles/team-settings.css"]');
  assert.equal(sheets.length, 1, 'the page stylesheet loads with the scripts, once');
});

// -------------------------------------------------------------- page states

test('no team: the You group, Host a team with Deploy, and Join a team', async (t) => {
  const h = harness();
  t.after(h.restore);
  await flush();
  assert.deepEqual(h.headings(), ['You', 'Host a team', 'Join a team']);
  assert.ok(h.q('#teamYourName') && h.q('#teamPcName') && h.q('#teamNewName') && h.q('#teamInviteCode'));
  assert.ok(h.q('[data-team-action="deploy"]'));
  assert.ok(h.q('[data-team-action="join"]'));
  assert.equal(h.q('.settings-page-status'), null, 'no status line before a team exists');
  assert.deepEqual(h.calls.map((call) => call.method).sort(), ['hostStatus', 'status']);
});

test('hosting alone: one status line with Stop, This server, a You row, owner groups, and no first-run names', async (t) => {
  const h = harness({ host: hostState(), teams: [snapshot()], answers: {
    members: { ok: true, team: { team_id: TEAM, name: 'Studio' }, members: [ROSTER[0]] } } });
  t.after(h.restore);
  await flush();
  const status = h.q('.settings-page-status');
  assert.match(status.textContent, /Server/);
  assert.match(status.textContent, /Running on this PC/);
  assert.match(status.textContent, /1 of 8 seats/);
  assert.ok(status.querySelector('[data-team-action="stop"]'));
  assert.deepEqual(h.headings(), ['This server', 'You', 'Invite someone', 'People', 'Your devices', 'Share this PC’s GPU', 'GPU use', 'Activity', 'Join another team',
    'Ownership and shutdown', 'Delete']);
  assert.match(h.text(), /Only you so far/);
  assert.equal(h.q('#teamYourName'), null, 'the names come from the team and this device: no first-run names, a You row for the team instead');
  assert.equal(h.q('#teamProfileName-0').value, 'Olive Owner');
  assert.equal(h.q('#teamTeamName').value, 'Studio');
});

test('hosting with people: the pending joiner comes first with Admit, Decline, the key and the hint', async (t) => {
  const h = harness({ host: hostState(), teams: [snapshot()] });
  t.after(h.restore);
  await flush();
  const rows = h.qa('[data-team-people] .team-set-person');
  assert.match(rows[0].textContent, /Maya Okafor/);
  assert.match(rows[0].textContent, /Maya laptop/);
  assert.match(rows[0].textContent, /7F3A 91C2 05/);
  assert.ok(rows[0].querySelector('[data-team-action="admit"]') && rows[0].querySelector('[data-team-action="decline"]'));
  assert.match(rows[0].textContent, /Check the name and the key with them before you admit them\. They see the same key on their screen\./);
  assert.match(rows[1].textContent, /Olive Owner \(you\)/);
  assert.match(rows[1].textContent, /Owner/);
  assert.equal(rows[1].querySelector('select'), null, 'no role picker on your own row');
  assert.match(rows[2].textContent, /Dot/);
  assert.equal(rows[2].querySelector('select').value, 'member');
  const more = rows[2].querySelector('[data-team-action="more"]');
  assert.equal(more.getAttribute('aria-label'), 'More for Dot');
  assert.equal(more.getAttribute('title'), 'More for Dot');
  assert.match(h.q('.settings-page-status').textContent, /3 of 8 seats/);
});

for (const [state, words] of [['starting', /Starting…/], ['stopping', /Stopping…/]]) {
  test(`host ${state}: the status line says so and offers no owner controls`, async (t) => {
    const h = harness({ host: hostState({ state }), teams: [snapshot({ state: 'reconnecting' })] });
    t.after(h.restore);
    await flush();
    assert.match(h.q('.settings-page-status').textContent, words);
    assert.equal(h.q('[data-team-action="invite-create"]'), null);
  });
}

const HOST_REASONS = {
  team_host_platform_unavailable: /This PC cannot host a team yet/,
  team_host_exit_unconfirmed: /old server has not finished closing/,
  team_host_start_timeout: /did not start in time/,
  team_host_exited: /server stopped unexpectedly/,
  team_host_spawn_failed: /could not start the server/,
  team_transport_down: /network connection/,
  team_transport_missing: /missing its team connection helper/,
  team_key_timeout: /server did not get its key/,
  team_host_key_mismatch: /key does not match/,
  team_store_failed: /could not save/,
};
for (const [reason, sentence] of Object.entries(HOST_REASONS)) {
  test(`host failed with ${reason}: the status line gives its sentence`, async (t) => {
    const h = harness({ host: hostState({ state: 'failed', reason }), teams: [snapshot({ state: 'offline' })] });
    t.after(h.restore);
    await flush();
    const status = h.q('.settings-page-status');
    assert.match(status.textContent, /Stopped with a problem/);
    assert.match(status.textContent, sentence);
    const start = status.querySelector('[data-team-action="start"]');
    if (reason === 'team_host_exit_unconfirmed' || reason === 'team_host_platform_unavailable') {
      assert.ok(!start || start.disabled, 'Start waits');
    } else {
      assert.equal(start.disabled, false);
    }
  });
}

test('server stopped (deployed before): Stopped, the note, Start, and the join group', async (t) => {
  const h = harness({ host: hostState({ state: 'stopped' }), teams: [snapshot({ state: 'offline' })] });
  t.after(h.restore);
  await flush();
  const status = h.q('.settings-page-status');
  assert.match(status.textContent, /Stopped/);
  assert.match(status.textContent, /Nobody can connect until you start it\. Nothing was deleted\./);
  assert.ok(status.querySelector('[data-team-action="start"]'));
  assert.ok(h.headings().includes('Join another team'));
  assert.equal(h.q('[data-team-action="deploy"]'), null, 'never "Host a team" for a team that exists');
});

test('never deployed beats a joined team where you are the owner: no Start, Host a team offered', async (t) => {
  const h = harness({ teams: [snapshot({ team_id: OTHER, state: 'offline' })] });
  t.after(h.restore);
  await flush();
  assert.equal(h.q('[data-team-action="start"]'), null);
  assert.ok(h.q('[data-team-action="deploy"]'));
});

test('lost owner access: host running with no membership of its team offers Reclaim ownership', async (t) => {
  const h = harness({ host: hostState(), teams: [] });
  t.after(h.restore);
  await flush();
  assert.ok(h.headings().includes('Get back in as the owner'));
  assert.ok(h.q('[data-team-action="recover"]'));
  assert.equal(h.q('[data-team-action="invite-create"]'), null, 'no owner controls');
  assert.ok(h.q('#teamYourName'), 'Reclaim needs the names');
});

const MEMBER_STATES = {
  connecting: /connecting/, online: /connected/, reconnecting: /reconnecting/, offline: /offline/,
  pending: /waiting for the owner to let you in/, revoked: /You no longer have access\. To come back, ask the owner for a new invite and paste it below\./, update_required: /update Jenny to connect/,
};
for (const [state, words] of Object.entries(MEMBER_STATES)) {
  test(`joined team ${state}: the row says so in plain words with its actions`, async (t) => {
    const h = harness({ teams: [snapshot({ team_id: OTHER, team_name: 'Dot lab', role: 'member', state })] });
    t.after(h.restore);
    await flush();
    assert.ok(h.headings().includes('Teams you have joined'));
    const row = h.q('[data-team-joined] .team-set-person');
    assert.match(row.textContent, /Dot lab/);
    assert.match(row.textContent, /Member/);
    assert.match(row.textContent, words);
    const actions = [...row.querySelectorAll('[data-team-action]')].map((button) => button.dataset.teamAction);
    if (state === 'pending') assert.deepEqual(actions, ['cancel-request']);
    else if (state === 'revoked') assert.deepEqual(actions, ['remove-team']);
    else if (state === 'update_required') assert.deepEqual(actions, []);
    else if (state === 'online') assert.deepEqual(actions, ['device-invite', 'leave']);
    else assert.deepEqual(actions, ['leave']);
  });
}
for (const [name, over, shown] of OWN_KEY_CASES) test(`joined team, own key ${name}: the line is ${shown ? 'shown' : 'not shown'}`, async (t) => {
  const h = harness({ teams: [snapshot({ team_id: OTHER, team_name: 'Dot lab', role: 'member', ...over })] }); t.after(h.restore);
  await flush();
  assert.deepEqual(h.qa('[data-team-joined] .team-set-person__hint').map((el) => el.textContent), shown ? [OWN_KEY_LINE] : []);
});

// Fault: a saved team that does not load hidden or drawn as an
// ordinary team (a role, a connection state, Leave), the wrong sentence for its reason, its id drawn as
// markup, or Remove sent without its confirm. The id is a directory name listTeamIds already checked
// (tests/team-client-file.test.js); a hostile one is still drawn as text.
const UNREADABLE_ROW = 'The saved file for this team cannot be read. Remove it from this PC, then join again with a new invite.';
const REPAIR_SENTENCES = {
  team_client_schema_unsupported: 'This team was saved by a newer Jenny. Update Jenny to use it, or remove it from this PC.',
  team_client_invalid: UNREADABLE_ROW,
  team_client_missing: UNREADABLE_ROW,
  team_recover_local_save_failed: 'The server accepted you, but this PC could not save it. Run Reclaim ownership again.',
};
for (const [reason, sentence] of Object.entries(REPAIR_SENTENCES)) {
  test(`a saved team that needs repair (${reason}): Needs repair, its sentence and Remove only, behind the confirm`, async (t) => {
    const teamId = 'team_RepairAAAAbbbbCCCCdd';
    const h = harness({ teams: [{ team_id: teamId, state: 'needs_repair', reason }] });
    t.after(h.restore);
    await flush();
    const row = h.q('[data-team-joined] .team-set-person');
    assert.equal(row.querySelector('.team-set-person__name').textContent, 'team_RepairAA…', 'the id\'s short form');
    assert.equal(row.querySelector('.team-set-person__fact').textContent, `Needs repair · ${sentence}`);
    assert.doesNotMatch(row.textContent, /Member|Owner|connected|unavailable|Unnamed/);
    const actions = () => [...row.querySelectorAll('[data-team-action]')].map((button) => button.dataset.teamAction);
    assert.deepEqual(actions(), ['remove-team']);
    h.click(`[data-team-action="remove-team"][data-team-id="${teamId}"]`);
    await flush();
    assert.equal(h.sent('removeTeam').length, 0, 'Remove asks first');
    assert.match(h.text(), /Remove team_RepairAA… from this PC\?/);
    h.click('[data-team-action="confirm-remove-team"]');
    await flush();
    assert.deepEqual(h.sent('removeTeam').map((call) => call.payload), [{ team_id: teamId }]);
  });
}

// Fault: the Remove confirm outliving the needs_repair state, so a team that healed meanwhile is removed.
test('the Remove confirm goes when the row heals, and a stale confirm click sends nothing', async (t) => {
  const teamId = 'team_RepairAAAAbbbbCCCCdd';
  const h = harness({ teams: [{ team_id: teamId, state: 'needs_repair', reason: 'team_client_invalid' }] });
  t.after(h.restore);
  await flush();
  h.click(`[data-team-action="remove-team"][data-team-id="${teamId}"]`);
  await flush();
  assert.ok(h.q('[data-team-action="confirm-remove-team"]'), 'the confirm is open');
  h.listeners.state({ teams: [snapshot({ team_id: teamId, team_name: 'Healed', role: 'member' })] });
  await flush();
  assert.equal(h.q('[data-team-action="confirm-remove-team"]'), null, 'no confirm for a healed team');
  const stale = h.window.document.createElement('button');
  stale.dataset.teamAction = 'confirm-remove-team';
  stale.dataset.teamId = teamId;
  h.q('[data-team-joined]').append(stale);
  stale.click();
  await flush();
  assert.deepEqual(h.sent('removeTeam'), [], 'a stale confirm click sends nothing');
});

// Fault: the names to reuse taken from a needs_repair row (it has none), so the page asks again.
test('the names to reuse come from the first team that does not need repair', async (t) => {
  const h = harness({ host: NONE, teams: [{ team_id: 'team_R1', state: 'needs_repair', reason: 'team_client_invalid' }, memberTeam()] });
  t.after(h.restore);
  await flush();
  assert.equal(h.q('#teamYourName'), null, 'the names are reused, not asked again');
});

// Fault: this PC's name read only from the device list, so it is asked again offline.
test("this PC's name comes from the team row while offline; with none anywhere the names are asked", async (t) => {
  for (const [over, asked] of [[{ label: 'Work laptop' }, false], [{}, true]]) {
    const h = harness({ host: NONE, teams: [memberTeam({ state: 'connecting', ...over })] });
    await flush();
    assert.equal(h.q('#teamYourName') !== null, asked, JSON.stringify(over));
    h.restore();
  }
});

test('a needs-repair row draws a hostile id as text', async (t) => {
  const teamId = 'team_<img src=x onerror=alert(1)>';
  const h = harness({ teams: [{ team_id: teamId, state: 'needs_repair', reason: 'team_client_invalid' }] });
  t.after(h.restore);
  await flush();
  assert.equal(h.q('[data-team-joined] img'), null, 'no markup drawn');
  assert.equal(h.q('[data-team-joined] .team-set-person__name').textContent, 'team_<img src…');
});

test('four teams: the join group is replaced by one line saying why', async (t) => {
  const ids = ['team_C1', 'team_C2', 'team_C3', 'team_C4'];
  const h = harness({ teams: ids.map((id) => snapshot({ team_id: id, team_name: id, role: 'member' })) });
  t.after(h.restore);
  await flush();
  assert.equal(h.q('#teamInviteCode'), null);
  assert.match(h.text(), /4 of 4/);
  assert.match(h.text(), /Jenny can be in four teams at once/);
});

test('four teams with one removed: the invite field stays, saying a removed team can still be replaced', async (t) => {
  const teams = ['team_C1', 'team_C2', 'team_C3', 'team_C4'].map((id, n) => snapshot({ team_id: id, team_name: id,
    role: 'member', ...(n === 2 ? { state: 'revoked' } : {}) }));
  const h = harness({ teams });
  t.after(h.restore);
  await flush();
  assert.ok(h.q('#teamInviteCode'), 'the field is shown');
  assert.match(h.text(), /You can still paste a new invite for a team you were removed from\./);
  const groups = [...h.container.querySelectorAll('[data-team-group]')].map((node) => node.dataset.teamGroup);
  assert.ok(groups.indexOf('joined') < groups.indexOf('join'), 'the field is below the joined list');
});

test('an unknown host state renders as unavailable, never as owner controls', async (t) => {
  const h = harness({ host: hostState({ state: 'weird' }), teams: [snapshot()] });
  t.after(h.restore);
  await flush();
  assert.match(h.q('.settings-page-status').textContent, /Unavailable/);
  assert.equal(h.q('[data-team-action="invite-create"]'), null);
  assert.equal(h.q('[data-team-action="stop"]'), null);
});

// ------------------------------------------------------- lifecycle (review round)

test('A2: switching the app view away from Settings leaves the page: code, pasted invite and both pushes are dropped', async (t) => {
  const h = harness({ host: hostState(), teams: [snapshot()] });
  t.after(h.restore);
  await flush();
  globalThis.rendererSettingsTeamSection = h.section;
  const settingsUtils = require('../renderer/shell/renderer-settings-utils');
  const realPage = settingsUtils.createSettingsRenderer({ state: { ui: {} }, constants: {}, dom: {}, callbacks: {} });
  const manifest = require('../renderer/shell/renderer-settings-script-manifest');
  const windowRef = {
    rendererSettingsScriptManifest: manifest,
    scriptLoaderUtils: { ensureScript({ src, isReady }) {
      const name = manifest.find(([entry]) => entry === src)[1];
      windowRef[name] = name === 'rendererSettingsUtils' ? { createSettingsRenderer: () => ({ renderSettings() {}, dispose: realPage.dispose }) } : {};
      return Promise.resolve(isReady());
    } },
  };
  const state = { ui: { activeView: 'settings' } };
  const chrome = require('../renderer/shell/renderer-settings-chrome').createSettingsRenderer({
    windowRef, state, dom: { composerModelSelect: { dataset: {}, innerHTML: '', value: '' }, composerEffortSelect: { dataset: {}, value: '' } },
    callbacks: { getCurrentRuntimePreferences: () => ({ preferredModel: '', reasoningEffort: '' }), buildModelOptionMarkup: () => '' },
  });
  t.after(() => chrome.dispose());
  chrome.renderSettings();
  await flush();
  assert.equal(chrome.isSettingsPageLoaded(), true);
  h.click('[data-team-action="invite-create"]');
  h.type('#teamInviteCode', 'jteam1_PASTEDBUTNOTSENT');
  await flush();
  assert.ok(h.section._live.reveal);
  const savedRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0;
  t.after(() => { globalThis.requestAnimationFrame = savedRaf; });
  const fwd = new Proxy({ renderSettings: () => chrome.renderSettings() }, { get: (target, name) => target[name] || (() => {}) });
  const navigation = require('../renderer/shell/renderer-lifecycle-navigation').createLifecycleNavigation({
    state, fwd, persistActiveView() {}, markStartupAudit() {}, appendClientLog() {}, refreshDiagnosticsWorkspace: () => Promise.resolve() });
  navigation.setActiveView('chat');
  assert.equal(h.section._live.reveal, null);
  assert.equal(h.section._live.drafts.invite, '');
  assert.equal(h.listeners.state, null);
  assert.equal(h.listeners.host, null);
  assert.equal(h.container.innerHTML.includes('jteam1_'), false);
});

function loaderWindow(document, { succeed }) {
  const manifest = require('../renderer/shell/renderer-settings-script-manifest');
  const requested = [];
  const shown = [];
  const windowRef = {
    document,
    jennyShell: { team: {} },
    scriptLoaderUtils: { ensureScript: ({ src }) => {
      requested.push(src);
      if (!succeed()) return Promise.resolve(false);
      const name = manifest.teamSection.find(([entry]) => entry === src)[1];
      windowRef[name] = name === 'rendererSettingsTeamSection' ? { showTeamSection: (options) => shown.push(options), leaveTeamSection() {} } : {};
      return Promise.resolve(true);
    } },
  };
  return { windowRef, requested, shown };
}

test('the script-load path reaches showTeamSection; a failed load is retried when Team is next entered, not on every render', async () => {
  const dom = new JSDOM(`<!doctype html><body><div class="settings-nav"><div class="settings-nav-header"></div><div class="settings-nav-scroll"></div></div>
    <section class="settings-card" data-settings-section="team" data-feature-flag="team" id="teamSettingsSection" hidden><div id="teamSettingsBody"></div></section></body>`);
  const document = dom.window.document;
  require('../renderer/shell/renderer-settings-nav-utils').renderSettingsNav(document);
  let ok = false;
  const { windowRef, requested, shown } = loaderWindow(document, { succeed: () => ok });
  const utilsPath = require.resolve('../renderer/shell/renderer-settings-utils');
  delete require.cache[utilsPath];
  const { syncTeamSettingsSection } = require(utilsPath);
  const state = { features: { featureFlags: { team: true } }, ui: { activeView: 'settings', activeSettingsSection: 'team' } };
  syncTeamSettingsSection({ state, windowRef, activeSection: 'team' });
  await flush();
  const firstTry = requested.length;
  assert.ok(firstTry > 0);
  syncTeamSettingsSection({ state, windowRef, activeSection: 'team' });
  syncTeamSettingsSection({ state, windowRef, activeSection: 'team' });
  await flush();
  assert.equal(requested.length, firstTry, 'render passes on Team do not retry a failed load');
  ok = true;
  syncTeamSettingsSection({ state: { ...state, ui: { ...state.ui, activeSettingsSection: 'models' } }, windowRef, activeSection: 'models' });
  syncTeamSettingsSection({ state, windowRef, activeSection: 'team' });
  await flush();
  assert.ok(requested.length > firstTry, 'entering Team again retries');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].container, document.getElementById('teamSettingsSection'));
  delete require.cache[utilsPath];
});

// ---------------------------------------------------------------- E50: no team data on disk

const GATE = require.resolve('../renderer/team/renderer-team-tab-gate');
const UTILS = require.resolve('../renderer/shell/renderer-settings-utils');
// Settings > Team entered with main's `teamData: false`, through the real section loader and top-nav shell.
function openNoData(t, options = {}) {
  delete require.cache[UTILS];
  delete require.cache[GATE];
  const h = harness({ show: false, ...options });
  t.after(() => { h.restore(); delete require.cache[UTILS]; });
  const s = shell(h, { teamData: false, activeView: 'settings' });
  s.state.ui.activeSettingsSection = 'team';
  enter(h, s, 'team');
  return { h, s };
}
// Settings showing `section` (leaving Team when it is another one), through the real section loader.
function enter(h, s, section) {
  require(UTILS).syncTeamSettingsSection({ state: s.state, windowRef: h.window, activeSection: section });
}
const reads = (h) => h.calls.map((call) => call.method).filter((m) => m === 'hostStatus' || m === 'status').sort();
const fillJoin = (h) => { h.type('#teamYourName', 'Olive'); h.type('#teamPcName', 'Desk'); h.type('#teamInviteCode', CODE); };

test('E50 no team data: the page draws Host and Join from the seed, loads its own scripts and style, and asks main nothing', async (t) => {
  const { h, s } = openNoData(t);
  await flush();
  assert.deepEqual(h.headings(), ['You', 'Host a team', 'Join a team']);
  assert.deepEqual(s.requested, require('../renderer/shell/renderer-settings-script-manifest').teamSection.map(([src]) => src));
  assert.equal(require.cache[GATE], undefined, 'the gate is not loaded');
  assert.ok(h.window.document.querySelector('link[href="styles/team-settings.css"]'));
  assert.deepEqual(h.calls, []);
  assert.equal(h.listeners.state, null);
  assert.equal(h.listeners.host, null);
  assert.deepEqual(h.store.snapshot().host, require('../renderer/team/renderer-team-store').EMPTY_HOST);
  enter(h, s, 'general');
  enter(h, s, 'team');
  await flush();
  assert.deepEqual(h.headings(), ['You', 'Host a team', 'Join a team'], 'entered again, still drawn from the seed');
  assert.deepEqual(h.calls, [], 'entered again, still nothing asked of main');
  assert.equal(h.listeners.state, null);
});

test('E50 no team data: Join is the first call; then the store subscribes and reads, the gate loads and the tab opens', async (t) => {
  let joined = false;
  const { h, s } = openNoData(t, { answers: { join: () => { joined = true; return { ok: true }; },
    status: () => ({ ok: true, teams: joined ? [memberTeam()] : [] }) } });
  await flush();
  fillJoin(h);
  h.click('[data-team-action="join"]');
  await flush();
  await flush();
  assert.equal(h.calls[0].method, 'join');
  assert.ok(h.listeners.state && h.listeners.host, 'the store follows the pushes');
  assert.ok(h.sent('status').length >= 1 && h.sent('hostStatus').length >= 1);
  assert.ok(require.cache[GATE], 'the gate loaded');
  assert.deepEqual(s.tabs(), ['home', 'chat', 'ide', 'team']);
  assert.equal(s.state.ui.activeView, 'team');
});

test('E50 no team data: a Deploy that succeeds wakes the store and loads the gate; the tab appears', async (t) => {
  let host = NONE;
  const { h, s } = openNoData(t, { answers: { hostDeploy: () => { host = hostState(); return { ok: true, host }; },
    hostStatus: () => ({ ok: true, host }) } });
  await flush();
  h.type('#teamYourName', 'Olive Owner');
  h.type('#teamPcName', 'Desk');
  h.type('#teamNewName', 'Studio');
  h.click('[data-team-action="deploy"]');
  await flush();
  await flush();
  assert.equal(h.calls[0].method, 'hostDeploy');
  assert.ok(h.listeners.host);
  assert.ok(require.cache[GATE]);
  assert.ok(s.tabs().includes('team'));
});

test('E50 no team data: a refused join ends the quiet state: the store follows the pushes and reads once, and no gate loads', async (t) => {
  const { h, s } = openNoData(t, { answers: { join: { ok: false, error: { code: 'CMP-TEAM-0003', reason: 'team_invite_expired' } } } });
  await flush();
  fillJoin(h);
  h.click('[data-team-action="join"]');
  await flush();
  assert.equal(h.calls[0].method, 'join');
  assert.deepEqual(reads(h), ['hostStatus', 'status'], 'one read of each');
  assert.ok(h.listeners.state && h.listeners.host, 'two listeners');
  assert.equal(require.cache[GATE], undefined, 'no gate');
  assert.deepEqual(s.tabs(), ['home', 'chat', 'ide', 'team'], 'row 168: the tab is in the rail, the gate not loaded');
  enter(h, s, 'general');
  enter(h, s, 'team');
  await flush();
  assert.deepEqual(reads(h), ['hostStatus', 'hostStatus', 'status', 'status'], 'entered again, the page reads as usual');
});

test('E50 no team data: a join that answers ok after the page was left still wakes the store and loads the gate', async (t) => {
  let release;
  let joined = false;
  const { h, s } = openNoData(t, { answers: { join: () => new Promise((resolve) => { release = resolve; }),
    status: () => ({ ok: true, teams: joined ? [memberTeam()] : [] }) } });
  await flush();
  fillJoin(h);
  h.click('[data-team-action="join"]');
  await flush();
  enter(h, s, 'general');
  joined = true;
  release({ ok: true });
  await flush();
  await flush();
  assert.ok(reads(h).includes('hostStatus') && reads(h).includes('status'), 'the store read from main');
  assert.ok(require.cache[GATE], 'the gate was asked for');
  assert.ok(s.tabs().includes('team'));
  const before = reads(h).length;
  enter(h, s, 'team');
  await flush();
  assert.ok(reads(h).length > before, 'entered again, the page is not quiet');
});

test('E50 no team data: a join that times out with no answer still wakes the store, which reads from main', async (t) => {
  const { h, s } = openNoData(t, { answers: { join: () => new Promise(() => {}) } });
  await flush();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fillJoin(h);
  h.click('[data-team-action="join"]');
  await micro();
  assert.deepEqual(reads(h), []);
  t.mock.timers.tick(60_000);
  await micro();
  assert.deepEqual(reads(h), ['hostStatus', 'status']);
  assert.ok(h.listeners.state && h.listeners.host);
  assert.equal(require.cache[GATE], undefined, 'nothing on disk said there is a team: no gate');
  t.mock.timers.reset();
  enter(h, s, 'general');
  enter(h, s, 'team');
  await flush();
  assert.equal(reads(h).length, 4, 'entered again, the page reads as usual');
});

// ------------------------------------------------------- row 193 C14

test('Team chat density is a row on the Team page, showing the applied density and with no heading of its own', async (t) => {
  const h = harness({ teams: [memberTeam()] });
  t.after(h.restore);
  h.window.document.documentElement.dataset.teamDensity = 'compact';
  await flush();
  const row = h.q('[data-settings-field="appearanceTeamDensitySelect"]');
  assert.ok(row, 'the density row is on the Team page');
  assert.equal(row.querySelector('.settings-field-title').textContent, 'Team chat density');
  assert.deepEqual([...row.querySelectorAll('[data-value]')].map((o) => o.dataset.value), ['comfortable', 'compact']);
  assert.equal(row.querySelector('[aria-checked="true"]').dataset.value, 'compact', 'it reads the density applied to the page');
  assert.equal(h.headings().includes('Team chat density'), false, 'a row, not a new group heading');
});
