'use strict';

// new-test-file: tests/shell-config-pane-layout.test.js is at 549 lines and a test file may not pass 600.
// Row 190 Wave 3 (schema v60): which pane each open chat tab belongs to is
// persisted as a sparse `workspace.tabPanes` map (sessionId -> 1 for pane 1;
// every tab not in the map belongs to pane 0).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  mergeWorkspacePatch,
  normalizeWorkspaceState,
  workspaceStateView,
} = require('../services/shell-config-normalizers');
const { CONFIG_VERSION, normalizeState, serializeState } = require('../services/shell-config-state');
const { ShellConfigService } = require('../services/shell-config-service');
const { normalizeTabPanes } = require('../renderer/shell/renderer-pane-model');

const panesOf = (...sessionIds) => sessionIds.map((sessionId, paneId) => ({ paneId, sessionId }));
const clone = (value) => JSON.parse(JSON.stringify(value));
const twoPane = (tabPanes, extra = {}) => ({
  activeSessionId: 'a',
  openSessionIds: ['a', 'b', 'c'],
  panes: panesOf('a', 'b'),
  focusedPaneId: 0,
  splitRatio: 0.5,
  ...(tabPanes === undefined ? {} : { tabPanes }),
  ...extra,
});

// --- schema step ---

test('schema: CONFIG_VERSION is 60', () => {
  assert.equal(CONFIG_VERSION, 60);
});

test('migration v59 -> v60: a two-pane workspace seeds the pane-1 session into tabPanes', () => {
  const v59 = { version: 59, workspace: twoPane(undefined) };
  const migrated = serializeState(normalizeState(clone(v59)));
  assert.equal(migrated.version, 60);
  assert.deepEqual(migrated.workspace.tabPanes, { b: 1 });
  assert.deepEqual(migrated.workspace.panes, panesOf('a', 'b'));
  assert.deepEqual(migrated.workspace.openSessionIds, ['a', 'b', 'c']);
});

test('migration v59 -> v60: a one-pane workspace gains no tabPanes and the view omits it', () => {
  const v59 = { version: 59, workspace: { activeSessionId: 'a', openSessionIds: ['a', 'b'] } };
  const state = normalizeState(clone(v59));
  assert.deepEqual(state.workspace.tabPanes ?? {}, {});
  assert.equal(Object.prototype.hasOwnProperty.call(serializeState(state).workspace, 'tabPanes'), false);
  assert.deepEqual(workspaceStateView(state.workspace), { activeSessionId: 'a', openSessionIds: ['a', 'b'] });
});

test('migration v59 -> v60: a second pane that holds nothing seeds nothing, and other keys do not move', () => {
  const v59 = { version: 59, uiLanguage: 'en', workspace: twoPane(undefined, { panes: panesOf('a', '') }) };
  const migrated = serializeState(normalizeState(clone(v59)));
  assert.deepEqual(migrated.workspace.tabPanes ?? {}, {});
  assert.equal(migrated.uiLanguage, 'en');
});

test('migration v59 -> v60: a v60 document is a no-op and the step is idempotent', () => {
  const v60 = clone(serializeState(normalizeState({ version: 59, workspace: twoPane(undefined) })));
  assert.deepEqual(clone(serializeState(normalizeState(clone(v60)))), v60);
});

test('migration v59 -> v60: an unreadable stored second-pane session is not seeded', () => {
  const v59 = { version: 59, workspace: twoPane(undefined, { panes: panesOf('a', 'gone') }) };
  const migrated = serializeState(normalizeState(clone(v59), ['a', 'b', 'c']));
  assert.deepEqual(migrated.workspace.tabPanes ?? {}, {});
});

// --- shared normalizer ---

const open = ['a', 'b', 'c', 'd'];

test('normalizeTabPanes: junk input is an empty map, plus only the forced pane-1 session', () => {
  for (const junk of [null, undefined, 'b', 7, true, ['b'], [['b', 1]]]) {
    assert.deepEqual(normalizeTabPanes(junk, { openSessionIds: open, panes: panesOf('a', '') }), {}, String(junk));
    assert.deepEqual(normalizeTabPanes(junk, { openSessionIds: open, panes: panesOf('a', 'b') }), { b: 1 }, String(junk));
  }
});

test('normalizeTabPanes: fewer than two panes is always empty', () => {
  assert.deepEqual(normalizeTabPanes({ c: 1 }, { openSessionIds: open, panes: panesOf('a') }), {});
  assert.deepEqual(normalizeTabPanes({ c: 1 }, { openSessionIds: open, panes: [] }), {});
  assert.deepEqual(normalizeTabPanes({ c: 1 }, { openSessionIds: open }), {});
});

test('normalizeTabPanes: stale keys, zero values and non-1 values are dropped', () => {
  const result = normalizeTabPanes(
    { c: 1, gone: 1, d: 0, a: '1', b: 2 },
    { openSessionIds: open, panes: panesOf('a', '') }
  );
  assert.deepEqual(result, { c: 1 });
});

test('normalizeTabPanes: the pane-1 session is forced in and the pane-0 session forced out', () => {
  const result = normalizeTabPanes({ a: 1, c: 1 }, { openSessionIds: open, panes: panesOf('a', 'b') });
  assert.deepEqual(result, { b: 1, c: 1 });
});

test('normalizeTabPanes: keys follow openSessionIds order and the result is a fresh plain object', () => {
  const input = { d: 1, c: 1 };
  const result = normalizeTabPanes(input, { openSessionIds: open, panes: panesOf('a', 'b') });
  assert.deepEqual(Object.keys(result), ['b', 'c', 'd']);
  assert.notEqual(result, input);
  assert.equal(Object.isFrozen(result), false);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test('normalizeTabPanes: an every-tab-in-pane-1 map is kept as written, minus the pane-0 session', () => {
  const result = normalizeTabPanes({ a: 1, b: 1, c: 1 }, { openSessionIds: ['a', 'b', 'c'], panes: panesOf('a', 'b') });
  assert.deepEqual(result, { b: 1, c: 1 });
});

test('normalizeTabPanes: pane entries may be bare session ids', () => {
  assert.deepEqual(normalizeTabPanes({}, { openSessionIds: open, panes: ['a', 'b'] }), { b: 1 });
});

test('normalizeTabPanes: the map never outgrows the open tabs', () => {
  const many = {};
  for (let index = 0; index < 20; index += 1) many[`s${index}`] = 1;
  const ids = Array.from({ length: 8 }, (_, index) => `s${index}`);
  const result = normalizeTabPanes(many, { openSessionIds: ids, panes: panesOf('s0', 's1') });
  assert.equal(Object.keys(result).length <= ids.length, true);
  assert.deepEqual(Object.keys(result), ids.slice(1));
});

// --- workspace state, merge, view ---

test('normalizeWorkspaceState carries tabPanes, re-normalized against the open tabs and panes', () => {
  const workspace = normalizeWorkspaceState(twoPane({ c: 1, gone: 1, a: 1 }));
  assert.deepEqual(workspace.tabPanes, { b: 1, c: 1 });
});

test('normalizeWorkspaceState: closing a tab drops its entry', () => {
  const workspace = normalizeWorkspaceState(twoPane({ b: 1, c: 1 }, { openSessionIds: ['a', 'b'] }));
  assert.deepEqual(workspace.tabPanes, { b: 1 });
});

test('mergeWorkspacePatch: a patch may set tabPanes and a closed tab loses its entry', () => {
  const current = normalizeWorkspaceState(twoPane({ b: 1, c: 1 }));
  const set = mergeWorkspacePatch(current, { tabPanes: { b: 1, c: 1, a: 1 } });
  assert.deepEqual(set.tabPanes, { b: 1, c: 1 });
  const closed = mergeWorkspacePatch(current, { openSessionIds: ['a', 'b'] });
  assert.deepEqual(closed.tabPanes, { b: 1 });
});

test('workspaceStateView omits tabPanes when empty and hands out a fresh object otherwise', () => {
  const none = normalizeWorkspaceState(twoPane({}, { panes: panesOf('a', '') }));
  assert.equal(Object.prototype.hasOwnProperty.call(workspaceStateView(none), 'tabPanes'), false);

  const some = normalizeWorkspaceState(twoPane({ c: 1 }));
  const view = workspaceStateView(some);
  assert.deepEqual(view.tabPanes, { b: 1, c: 1 });
  assert.notEqual(view.tabPanes, some.tabPanes);
});

// --- state copy sites and the service ---

test('state: normalizeState/serializeState hand out fresh tabPanes objects', () => {
  const state = normalizeState({ version: 60, workspace: twoPane({ c: 1 }) });
  assert.deepEqual(state.workspace.tabPanes, { b: 1, c: 1 });
  const serialized = serializeState(state);
  assert.deepEqual(serialized.workspace.tabPanes, { b: 1, c: 1 });
  assert.notEqual(serialized.workspace.tabPanes, state.workspace.tabPanes);
});

function createService(t, workspace) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-tab-panes-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(userDataPath, 'shell-config.json'), JSON.stringify({ version: 59, workspace }), 'utf8');
  const service = new ShellConfigService({
    userDataPath,
    getValidWorkspaceSessionIds: () => ['a', 'b', 'c', 'd'],
    workspaceWriteDelayMs: 5,
  });
  t.after(() => service.flushPendingWorkspaceWrite());
  return { service, userDataPath };
}

test('service: a v59 two-pane file loads with tabPanes, state reads are fresh copies and writes persist', (t) => {
  const { service, userDataPath } = createService(t, twoPane(undefined));
  assert.deepEqual(service.getWorkspaceState().tabPanes, { b: 1 });

  const first = service.getState().workspace;
  first.tabPanes.zzz = 1;
  assert.deepEqual(service.getState().workspace.tabPanes, { b: 1 });
  service.getWorkspaceState().tabPanes.zzz = 1;
  assert.deepEqual(service.getWorkspaceState().tabPanes, { b: 1 });

  const patched = service.updateWorkspaceState({ tabPanes: { b: 1, c: 1 } });
  assert.deepEqual(patched.tabPanes, { b: 1, c: 1 });
  const closed = service.updateWorkspaceState({ openSessionIds: ['a', 'b'] });
  assert.deepEqual(closed.tabPanes, { b: 1 });

  service.flushPendingWorkspaceWrite();
  const disk = JSON.parse(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8'));
  assert.equal(disk.version, 60);
  assert.deepEqual(disk.workspace.tabPanes, { b: 1 });
});
