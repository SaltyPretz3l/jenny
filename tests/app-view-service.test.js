'use strict';

// Row 94 P3: the port behind `app_view` (services/app-view-service.js): one push per request, outcomes only for
// issued ids, the layout read, and the project-file containment check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ACTIONS, ACTIVITY_PANES, CHAT_PANEL_SURFACES, CLOSE_PANES, SETTINGS_SECTIONS, createAppViewService,
} = require('../services/app-view-service');

const PRIMARY = 'sess_primary';

function harness({ flags = {}, hostMode = 'desktop', current = true, project = null, windowOpen = true } = {}) {
  const sent = [];
  const service = createAppViewService({
    sendBridgeEvent: (channel, payload) => sent.push([channel, payload]), isRendererAvailable: () => windowOpen,
    featureFlags: () => flags, primarySessionId: () => PRIMARY, hostMode: () => hostMode,
    projectService: () => ({ get: (id) => (project && id === project.id ? project : null) }),
    projectApplicationService: () => ({ isCurrentProject: async () => current }),
  });
  return { service, sent };
}

test('each action sends one push with only its closed fields', () => {
  const { service, sent } = harness();
  const cases = [
    ['settings', { section: 'notifications' }, { section: 'notifications' }],
    ['chat', { session_id: 'sess_a' }, { session_id: 'sess_a' }],
    ['file', { path: 'src/app.js', line: 42, extra: 'x' }, { path: 'src/app.js', line: 42 }],
    ['terminal', {}, {}],
    ['activity', { pane: 'permissions' }, { pane: 'permissions' }],
    ['chat_panel', { session_id: 'sess_a', surface: 'changes' }, { session_id: 'sess_a', surface: 'changes' }],
    ['close', { pane: 'split' }, { pane: 'split' }],
    ['split', { session_id: 'sess_b' }, { session_id: 'sess_b' }],
    ['sidebar', { collapsed: true }, { collapsed: true }],
  ];
  for (const [action, target, expected] of cases) {
    const answer = service.requestView({ session_id: PRIMARY, action, target });
    assert.equal(answer.ok, true, action);
    const [channel, payload] = sent.at(-1);
    assert.equal(channel, 'appView.onRequest');
    const { request_id: requestId, caller_session_id: sessionId, action: sentAction, ...rest } = payload;
    assert.equal(requestId, answer.request_id);
    assert.deepEqual([sessionId, sentAction, rest], [PRIMARY, action, expected], action);
  }
});

test('malformed targets, other chats, the kill switch and hosted mode send nothing', () => {
  const { service, sent } = harness();
  for (const [action, target] of [['settings', { section: 'secrets' }], ['file', { path: '../up.txt' }], ['file', { path: 'C:\\x.js' }],
    ['file', { path: '/etc/passwd' }], ['file', { path: 'a.js', line: 0 }], ['chat', { session_id: 'bad id' }], ['close', { pane: 'window' }],
    ['sidebar', { collapsed: 'yes' }], ['delete', {}]]) {
    assert.equal(service.requestView({ session_id: PRIMARY, action, target }).reason, 'invalid_input', `${action} ${JSON.stringify(target)}`);
  }
  assert.equal(service.requestView({ session_id: 'sess_other', action: 'terminal', target: {} }).reason, 'not_allowed');
  assert.equal(harness({ flags: { primary_app_view: false } }).service.requestView({ session_id: PRIMARY, action: 'terminal' }).reason, 'disabled');
  assert.equal(harness({ hostMode: 'server' }).service.requestView({ session_id: PRIMARY, action: 'terminal' }).reason, 'disabled');
  assert.deepEqual(sent, []);
  const closed = harness({ windowOpen: false });
  assert.equal(closed.service.requestView({ session_id: PRIMARY, action: 'terminal' }).reason, 'unavailable', 'no window, no push');
  assert.deepEqual(closed.sent, []);
  assert.deepEqual(service.admit({ session_id: PRIMARY }), { ok: true });
  assert.equal(service.admit({ session_id: 'sess_other' }).reason, 'not_allowed');
});

test('outcomes: only issued ids, prompted stays open, the note is read once', () => {
  const { service } = harness();
  const { request_id: first } = service.requestView({ session_id: PRIMARY, action: 'settings', target: { section: 'models' } });
  const { request_id: second } = service.requestView({ session_id: PRIMARY, action: 'file', target: { path: 'a.js', line: 3 } });
  assert.equal(service.recordOutcome({ request_id: 'apv-zz-99', decision: 'shown' }).ok, false);
  assert.equal(service.recordOutcome({ request_id: first, decision: 'made_up' }).ok, false);
  assert.equal(service.recordOutcome({ request_id: first, decision: 'constructor' }).ok, false, 'no prototype keys');
  assert.equal(service.recordOutcome({ request_id: first, decision: 'shown' }).ok, true);
  assert.equal(service.recordOutcome({ request_id: first, decision: 'shown' }).ok, false, 'a final decision closes the id');
  assert.equal(service.recordOutcome({ request_id: second, decision: 'prompted' }).ok, true);
  assert.equal(service.recordOutcome({ request_id: second, decision: 'shown_by_user' }).ok, true, 'Open on the chip still reports');
  const note = service.consumeOutcomeNote(PRIMARY);
  assert.match(note, /Settings > models: opened/);
  assert.match(note, /a\.js:3: held behind/);
  assert.match(note, /a\.js:3: opened after the user clicked Open/);
  assert.equal(service.consumeOutcomeNote(PRIMARY), '');
});

test('state answers the last layout, reduced to ids and booleans', () => {
  const { service } = harness();
  assert.equal(service.state({ session_id: PRIMARY }).reason, 'unavailable');
  service.reportLayout({ active_view: 'chat', current_session_id: 'sess_a', split_session_ids: ['sess_a', 'sess_b', 'sess_c', 'bad id'],
    sidebar_collapsed: true, preview_open: 'yes', title: 'secret' });
  assert.deepEqual(service.state({ session_id: PRIMARY }), { ok: true, layout: { active_view: 'chat', current_session_id: 'sess_a',
    split_session_ids: ['sess_a', 'sess_b'], sidebar_collapsed: true, chat_panel_open: false, preview_open: false } });
  service.reportLayout({ active_view: 'somewhere' });
  assert.equal(service.state({ session_id: PRIMARY }).layout.active_view, 'other');
  assert.equal(service.state({ session_id: 'sess_other' }).reason, 'not_allowed');
});

test('a project file must be a regular file inside the folder the IDE has open', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-view-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'app-view-out-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  let linked = true;
  try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); } catch (_error) { linked = false; }
  const project = { id: 'pr_1', root_path: root };
  const { service } = harness({ project });
  assert.deepEqual(await service.resolveProjectFile({ project_id: 'pr_1', path: 'src\\app.js' }), { ok: true, path: 'src/app.js' });
  assert.equal((await service.resolveProjectFile({ project_id: 'pr_1', path: 'src' })).reason, 'not_a_file');
  assert.equal((await service.resolveProjectFile({ project_id: 'pr_1', path: 'src/none.js' })).reason, 'missing');
  assert.equal((await service.resolveProjectFile({ project_id: 'pr_1', path: '../x' })).reason, 'invalid_input');
  if (linked) assert.equal((await service.resolveProjectFile({ project_id: 'pr_1', path: 'link/secret.txt' })).reason, 'outside_folder');
  assert.equal((await service.resolveProjectFile({ project_id: 'pr_9', path: 'a.js' })).reason, 'unknown_project');
  assert.equal((await harness({ project: { id: 'pr_1', root_path: null } }).service.resolveProjectFile({ project_id: 'pr_1', path: 'a.js' })).reason, 'no_folder');
  assert.equal((await harness({ project, current: false }).service.resolveProjectFile({ project_id: 'pr_1', path: 'src/app.js' })).reason, 'project_not_open');
});

test('the settings sections mirror the renderer registry', () => {
  const registry = require('../renderer/shell/renderer-settings-section-registry');
  assert.deepEqual([...SETTINGS_SECTIONS].sort(), registry.SETTINGS_SECTION_DEFINITIONS.map((def) => def.id).sort());
});

test('the closed lists agree across the service, the tool, the manifest and the renderer', () => {
  const params = require('../services/tools/tool-manifest.json').tools.find((tool) => tool.name === 'app_view').parameters.properties;
  const { TARGET_KEYS } = require('../services/tools/builtin/app-view-tool');
  const { ACTIONS: RENDERER_ACTIONS } = require('../renderer/shell/renderer-app-view-controller');
  const { SURFACES } = require('../renderer/features/renderer-chat-workspace-detail');
  const sorted = (list) => [...list].sort();
  assert.deepEqual(sorted([...ACTIONS, 'state']), sorted(Object.keys(TARGET_KEYS)));
  assert.deepEqual(sorted([...ACTIONS, 'state']), sorted(params.action.enum));
  assert.deepEqual(sorted(ACTIONS), sorted(RENDERER_ACTIONS));
  assert.deepEqual(sorted(SETTINGS_SECTIONS), sorted(params.section.enum));
  assert.deepEqual(sorted(CHAT_PANEL_SURFACES), sorted(params.surface.enum));
  assert.deepEqual(sorted(CHAT_PANEL_SURFACES), sorted(SURFACES));
  assert.deepEqual(sorted([...ACTIVITY_PANES, ...CLOSE_PANES]), sorted(params.pane.enum));
});
