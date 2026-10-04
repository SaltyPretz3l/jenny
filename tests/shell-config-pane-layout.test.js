'use strict';

// Split view W1-5: the pane layout persists in shell config beside the rail.
// The rules live in ONE place (renderer/shell/renderer-pane-model.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalizeWorkspaceState } = require('../services/shell-config-normalizers');
const { CONFIG_VERSION, normalizeState, serializeState } = require('../services/shell-config-state');
const { ShellConfigService } = require('../services/shell-config-service');
const paneModel = require('../renderer/shell/renderer-pane-model');
const { PANE_LAYOUT_PERSIST_DELAY_MS, createWorkspaceStateController } = require('../renderer/shell/renderer-workspace-state-utils');

const layoutOf = ({ panes, focusedPaneId, splitRatio }) => ({ panes, focusedPaneId, splitRatio });
const panesOf = (...sessionIds) => sessionIds.map((sessionId, paneId) => ({ paneId, sessionId }));
// The full stored workspace shape, in stored key order.
const full = (activeSessionId, openSessionIds, panes, focusedPaneId = 0, splitRatio = 0.5) => (
  { activeSessionId, openSessionIds, panes, focusedPaneId, splitRatio });
const clone = (value) => JSON.parse(JSON.stringify(value));

function makeUserData(t, config) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-pane-layout-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  if (config) fs.writeFileSync(path.join(userDataPath, 'shell-config.json'), JSON.stringify(config, null, 2), 'utf8');
  return userDataPath;
}

function readConfigFile(userDataPath) {
  return JSON.parse(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8'));
}

// --- 1. Normalizer ---

test('normalizer: a session in two panes stays in the first and the later pane blanks', () => {
  const workspace = normalizeWorkspaceState({
    activeSessionId: 'a', openSessionIds: ['a', 'b'], panes: [{ paneId: 0, sessionId: 'a' }, { paneId: 1, sessionId: 'a' }],
  });
  assert.deepEqual(workspace.panes, panesOf('a', ''));
});

test('normalizer: an unknown session blanks its pane when validSessionIds is given', () => {
  const workspace = normalizeWorkspaceState({ activeSessionId: 'a', openSessionIds: ['a', 'b', 'gone'], panes: ['a', 'gone'] }, ['a', 'b']);
  assert.deepEqual(workspace.openSessionIds, ['a', 'b']);
  assert.deepEqual(workspace.panes, panesOf('a', ''));
});

test('normalizer: a pane session that is not an open rail tab blanks and never grows the rail', () => {
  const workspace = normalizeWorkspaceState({ activeSessionId: 'a', openSessionIds: ['a'], panes: ['a', 'b'], focusedPaneId: 1 }, ['a', 'b']);
  assert.deepEqual(workspace.openSessionIds, ['a']);
  assert.deepEqual(workspace.panes, panesOf('a', ''));
  assert.equal(workspace.focusedPaneId, 1);
  // Focused pane is blank, so activeSessionId keeps its own normalized value.
  assert.equal(workspace.activeSessionId, 'a');
});

test('normalizer: splitRatio clamps to [0.2, 0.8] and blank or NaN falls back to 0.5', () => {
  const ratioFor = (splitRatio) => normalizeWorkspaceState({
    activeSessionId: 'a', openSessionIds: ['a', 'b'], panes: ['a', 'b'], splitRatio,
  }).splitRatio;
  assert.equal(ratioFor(0.95), 0.8);
  assert.equal(ratioFor(0.05), 0.2);
  assert.equal(ratioFor(0.35), 0.35);
  assert.equal(ratioFor('0.6'), 0.6);
  assert.equal(ratioFor(''), 0.5);
  assert.equal(ratioFor(Number.NaN), 0.5);
  assert.equal(ratioFor(undefined), 0.5);
  assert.equal(paneModel.MIN_SPLIT_RATIO, 0.2);
  assert.equal(paneModel.MAX_SPLIT_RATIO, 0.8);
});

test('normalizer: an out-of-range focusedPaneId falls back to pane 0', () => {
  for (const focusedPaneId of [2, 5, -1, 0.5, 'x', null]) {
    const workspace = normalizeWorkspaceState({
      activeSessionId: 'a', openSessionIds: ['a', 'b'], panes: ['a', 'b'], focusedPaneId,
    });
    assert.equal(workspace.focusedPaneId, 0, `focusedPaneId ${String(focusedPaneId)}`);
    assert.equal(workspace.activeSessionId, 'a');
  }
});

test('normalizer: activeSessionId follows the focused pane whenever that pane holds a session', () => {
  const focusedOnB = normalizeWorkspaceState({
    activeSessionId: 'a', openSessionIds: ['a', 'b'], panes: ['a', 'b'], focusedPaneId: 1,
  });
  assert.equal(focusedOnB.activeSessionId, 'b');

  const focusedBlank = normalizeWorkspaceState({
    activeSessionId: 'a', openSessionIds: ['a', 'b'], panes: ['b', ''], focusedPaneId: 1,
  });
  assert.equal(focusedBlank.activeSessionId, 'a');
  assert.deepEqual(focusedBlank.panes, panesOf('b', ''));
});

test('normalizer: absent panes seed one pane from activeSessionId; an explicit empty array is one blank pane', () => {
  assert.deepEqual(normalizeWorkspaceState({ activeSessionId: 'b', openSessionIds: ['a', 'b'] }), full('b', ['a', 'b'], panesOf('b')));
  assert.deepEqual(
    layoutOf(normalizeWorkspaceState({ activeSessionId: 'b', openSessionIds: ['a', 'b'], panes: null })),
    { panes: panesOf('b'), focusedPaneId: 0, splitRatio: 0.5 }
  );
  const explicitEmpty = normalizeWorkspaceState({ activeSessionId: 'b', openSessionIds: ['a', 'b'], panes: [] });
  assert.deepEqual(explicitEmpty.panes, panesOf(''));
  assert.equal(explicitEmpty.activeSessionId, 'b');
  // Seeding never invents a session: no active id, or an active id that is not
  // an open tab (today's behaviour keeps that id), seeds a blank pane.
  assert.deepEqual(normalizeWorkspaceState({}).panes, panesOf(''));
  assert.equal(normalizeWorkspaceState({}).activeSessionId, null);
  const activeNotOpen = normalizeWorkspaceState({ activeSessionId: 'x', openSessionIds: ['a'] });
  assert.deepEqual(activeNotOpen.panes, panesOf(''));
  assert.equal(activeNotOpen.activeSessionId, 'x');
});

test('normalizer: snake_case aliases are read and camelCase is written', () => {
  const workspace = normalizeWorkspaceState({
    active_session_id: 'a', open_session_ids: ['a', 'b'], panes: panesOf('a', 'b'), focused_pane_id: 1, split_ratio: 0.3,
  });
  assert.deepEqual(workspace, full('b', ['a', 'b'], panesOf('a', 'b'), 1, 0.3));
  const nested = normalizeWorkspaceState({
    activeSessionId: 'a', openSessionIds: ['a', 'b'], pane_layout: { panes: ['a', 'b'], focused_pane_id: 1, split_ratio: 0.7 },
  });
  assert.deepEqual(layoutOf(nested), { panes: panesOf('a', 'b'), focusedPaneId: 1, splitRatio: 0.7 });
  assert.deepEqual(Object.keys(workspace), ['activeSessionId', 'openSessionIds', 'panes', 'focusedPaneId', 'splitRatio']);
});

test('normalizer: output is plain objects, never the frozen pane-model value', () => {
  const workspace = normalizeWorkspaceState({ activeSessionId: 'a', openSessionIds: ['a', 'b'], panes: ['a', 'b'] });
  assert.equal(Object.isFrozen(workspace), false);
  assert.equal(Object.isFrozen(workspace.panes), false);
  assert.equal(workspace.panes.some((pane) => Object.isFrozen(pane)), false);
  workspace.panes[1].sessionId = 'mutated';
  assert.equal(workspace.panes[1].sessionId, 'mutated');
});

test('normalizer: ids are renumbered 0..N-1 after blanking and the pane count never changes', () => {
  const workspace = normalizeWorkspaceState({
    activeSessionId: 'c', openSessionIds: ['a', 'c'], focusedPaneId: 2,
    panes: [{ paneId: 4, sessionId: 'a' }, { paneId: 9, sessionId: 'b' }, { paneId: 2, sessionId: 'c' }],
  });
  assert.deepEqual(workspace.panes, panesOf('a', '', 'c'));
  assert.equal(workspace.focusedPaneId, 2);
  assert.equal(workspace.activeSessionId, 'c');
});

// --- 2. State migration 55 -> 56 ---

function buildV55Document() {
  // A realistic v55 file: the canonical serializer output for a lived-in
  // config, with the workspace block in the exact shape v55 wrote.
  const lived = serializeState(normalizeState({
    toolsWorkspaceRoot: 'C:/work/repo',
    uiLanguage: 'de',
    safetyMode: 'paranoid',
    defaultRunMode: 'plan',
    use24HourTime: true,
    chatUi: { zoomPercent: 110 },
    assistantIdentity: { agentName: 'Jen' },
    tips: { sessionCount: 4 },
    followUps: [{ id: 'fu-1', label: 'Check the build', body: 'Look at CI' }],
  }));
  return {
    ...clone(lived),
    version: 55,
    workspace: { activeSessionId: 'sess_b', openSessionIds: ['sess_a', 'sess_b', 'sess_c'] },
  };
}

function withoutVersionAndWorkspace(document) {
  const { version: _version, workspace: _workspace, ...rest } = document;
  return rest;
}

test('migration: CONFIG_VERSION is 58', () => {
  assert.equal(CONFIG_VERSION, 59);
});

test('migration: a v55 document gains one pane seeded from activeSessionId and nothing else moves', () => {
  const v55 = buildV55Document();
  const migrated = serializeState(normalizeState(clone(v55)));

  assert.equal(migrated.version, 59);
  assert.deepEqual(migrated.workspace, full('sess_b', ['sess_a', 'sess_b', 'sess_c'], [{ paneId: 0, sessionId: 'sess_b' }]));
  assert.deepEqual(clone(withoutVersionAndWorkspace(migrated)), withoutVersionAndWorkspace(v55));
});

test('migration: the legacy workspace_state alias migrates the same way', () => {
  const migrated = serializeState(normalizeState({
    version: 55, workspace_state: { active_session_id: 'sess_a', open_session_ids: ['sess_a'] },
  }));
  assert.deepEqual(migrated.workspace, full('sess_a', ['sess_a'], [{ paneId: 0, sessionId: 'sess_a' }]));
});

test('migration: a v56 document is a no-op, including a two-pane layout', () => {
  const v56 = clone(serializeState(normalizeState(buildV55Document())));
  assert.deepEqual(clone(serializeState(normalizeState(clone(v56)))), v56);

  const split = { ...v56, workspace: full('sess_c', ['sess_a', 'sess_b', 'sess_c'], panesOf('sess_a', 'sess_c'), 1, 0.35) };
  assert.deepEqual(clone(serializeState(normalizeState(clone(split)))), split);
});

test('migration: the serialized panes are fresh plain objects, not the state objects', () => {
  const state = normalizeState(buildV55Document());
  const serialized = serializeState(state);
  assert.notEqual(serialized.workspace.panes, state.workspace.panes);
  assert.notEqual(serialized.workspace.panes[0], state.workspace.panes[0]);
  assert.equal(Object.isFrozen(serialized.workspace.panes[0]), false);
});

// --- 3. Service round-trip ---

const VALID = ['a', 'b', 'c', 'd'];

function createService(t, workspace = { activeSessionId: 'a', openSessionIds: ['a', 'b', 'c'] }) {
  const userDataPath = makeUserData(t, { version: 55, workspace });
  const service = new ShellConfigService({ userDataPath, getValidWorkspaceSessionIds: () => VALID, workspaceWriteDelayMs: 5 });
  t.after(() => service.flushPendingWorkspaceWrite());
  return { service, userDataPath };
}

test('service: getWorkspaceState keeps its two-field shape while the layout is the implicit single pane', (t) => {
  const { service } = createService(t);
  assert.deepEqual(service.getWorkspaceState(), { activeSessionId: 'a', openSessionIds: ['a', 'b', 'c'] });
  assert.deepEqual(layoutOf(service.getState().workspace), { panes: panesOf('a'), focusedPaneId: 0, splitRatio: 0.5 });
});

test('service: each pane-layout patch shape round-trips through updateWorkspaceState', (t) => {
  const { service, userDataPath } = createService(t);

  service.updateWorkspaceState({ panes: [{ paneId: 0, sessionId: 'a' }, { paneId: 1, sessionId: 'b' }] });
  assert.deepEqual(service.getWorkspaceState(), full('a', ['a', 'b', 'c'], panesOf('a', 'b')));

  service.updateWorkspaceState({ splitRatio: 0.3 });
  assert.equal(service.getWorkspaceState().splitRatio, 0.3);

  const focused = service.updateWorkspaceState({ focusedPaneId: 1 });
  assert.deepEqual(focused, full('b', ['a', 'b', 'c'], panesOf('a', 'b'), 1, 0.3));

  service.flushPendingWorkspaceWrite();
  assert.deepEqual(readConfigFile(userDataPath).workspace, focused);
  const reloaded = new ShellConfigService({ userDataPath, getValidWorkspaceSessionIds: () => VALID });
  assert.deepEqual(reloaded.getWorkspaceState(), focused);
});

test('service: an unknown or not-open pane session is blanked, not stored', (t) => {
  const { service, userDataPath } = createService(t);
  const result = service.updateWorkspaceState({ panes: ['a', 'nope'], focusedPaneId: 1 });
  assert.deepEqual(result.panes, panesOf('a', ''));
  // Focused pane is blank: activeSessionId keeps its value.
  assert.equal(result.activeSessionId, 'a');

  // 'd' is a valid session but not an open rail tab.
  assert.deepEqual(service.updateWorkspaceState({ panes: ['a', 'd'] }).panes, panesOf('a', ''));
  assert.deepEqual(service.getWorkspaceState().openSessionIds, ['a', 'b', 'c']);
  service.flushPendingWorkspaceWrite();
  assert.equal(JSON.stringify(readConfigFile(userDataPath).workspace).includes('nope'), false);
});

test('service: a rail write moves the focused pane with activeSessionId (today\'s writers keep their meaning)', (t) => {
  const { service } = createService(t);
  service.updateWorkspaceState({ panes: ['a', 'b'], focusedPaneId: 1 });

  // Rail activates a session no pane holds: it lands in the focused pane.
  let workspace = service.updateWorkspaceState({ activeSessionId: 'c', openSessionIds: ['a', 'b', 'c'] });
  assert.deepEqual(layoutOf(workspace), { panes: panesOf('a', 'c'), focusedPaneId: 1, splitRatio: 0.5 });
  assert.equal(workspace.activeSessionId, 'c');

  // Rail activates a session another pane already shows: focus moves there.
  workspace = service.updateWorkspaceState({ activeSessionId: 'a', openSessionIds: ['a', 'b', 'c'] });
  assert.deepEqual(layoutOf(workspace), { panes: panesOf('a', 'c'), focusedPaneId: 0, splitRatio: 0.5 });
  assert.equal(workspace.activeSessionId, 'a');

  // Closing a tab blanks the pane that showed it.
  workspace = service.updateWorkspaceState({ activeSessionId: 'a', openSessionIds: ['a', 'b'] });
  assert.deepEqual(workspace.panes, panesOf('a', ''));

  // Closing everything leaves blank panes and no active session.
  workspace = service.updateWorkspaceState({ activeSessionId: null, openSessionIds: [] });
  assert.deepEqual(workspace.panes, panesOf('', ''));
  assert.equal(workspace.activeSessionId, null);
});

test('service: the single-pane rail path is unchanged from v55 behaviour', (t) => {
  const { service } = createService(t);
  for (const activeSessionId of ['b', 'c', 'a']) {
    assert.deepEqual(
      service.updateWorkspaceState({ activeSessionId, openSessionIds: ['a', 'b', 'c'] }),
      { activeSessionId, openSessionIds: ['a', 'b', 'c'] }
    );
    assert.deepEqual(service.getState().workspace.panes, panesOf(activeSessionId));
  }
  // An active id that is not an open tab is still stored as-is (v55 did too).
  assert.deepEqual(
    service.updateWorkspaceState({ activeSessionId: 'd', openSessionIds: ['a'] }),
    { activeSessionId: 'd', openSessionIds: ['a'] }
  );
});

test('service: getWorkspaceState hands back fresh copies', (t) => {
  const { service } = createService(t);
  service.updateWorkspaceState({ panes: ['a', 'b'] });
  const first = service.getWorkspaceState();
  first.panes[1].sessionId = 'mutated';
  first.panes.push({ paneId: 2, sessionId: 'c' });
  first.openSessionIds.push('z');
  assert.deepEqual(service.getWorkspaceState().panes, panesOf('a', 'b'));
  assert.deepEqual(service.getWorkspaceState().openSessionIds, ['a', 'b', 'c']);
});

test('service: serialize -> parse -> normalize is idempotent for a split layout', (t) => {
  const { service } = createService(t);
  service.updateWorkspaceState({ panes: ['a', 'c'], focusedPaneId: 1, splitRatio: 0.42 });
  const onDisk = clone(serializeState(service.getState()));
  const again = clone(serializeState(normalizeState(clone(onDisk), { validWorkspaceSessionIds: VALID })));
  assert.deepEqual(again, onDisk);
  assert.deepEqual(onDisk.workspace, full('c', ['a', 'b', 'c'], panesOf('a', 'c'), 1, 0.42));
});

test('service: a write while a newer config blocks writes returns the unchanged state', (t) => {
  const workspace = { activeSessionId: 'a', openSessionIds: ['a', 'b'] };
  const userDataPath = makeUserData(t, { version: CONFIG_VERSION + 1, workspace, futureOnly: { keep: true } });
  const before = fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8');
  const service = new ShellConfigService({ userDataPath, logger: () => {} });

  assert.deepEqual(service.updateWorkspaceState({ panes: ['a', 'b'], focusedPaneId: 1, splitRatio: 0.3 }), workspace);
  assert.deepEqual(service.getWorkspaceState(), workspace);
  service.flushPendingWorkspaceWrite();
  assert.equal(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8'), before);
});

// --- 4. Renderer seam ---

function createFakeTimers() {
  const timers = new Map();
  let nextId = 0;
  return {
    setTimeoutImpl: (fn, ms) => { nextId += 1; timers.set(nextId, { fn, ms }); return nextId; },
    clearTimeoutImpl: (id) => { timers.delete(id); },
    pending: () => [...timers.values()],
    runAll() {
      const due = [...timers.values()];
      timers.clear();
      due.forEach((timer) => timer.fn());
    },
  };
}

function createFakeWorkspace(initial = {}) {
  let stored = clone(initial);
  const updates = [];
  return {
    updates,
    shell: {
      workspace: {
        getState: async () => clone(stored),
        async updateState(patch) {
          updates.push(clone(patch));
          stored = { ...stored, ...clone(patch) };
          return clone(stored);
        },
      },
    },
  };
}

// Lets any queued mutation / flush promise settle.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('renderer: before any restore the layout is one blank pane at the default ratio', () => {
  const controller = createWorkspaceStateController({ paneModel });
  assert.deepEqual(controller.getPaneLayout(), { panes: panesOf(''), focusedPaneId: 0, splitRatio: 0.5 });
  assert.deepEqual(controller.getState(), { activeSessionId: '', openSessionIds: [] });
});

test('renderer: with no workspace bridge the fallback hydrates one pane holding the restored tab', async () => {
  const controller = createWorkspaceStateController({ paneModel });
  assert.deepEqual(await controller.restore(['a', 'b']), { activeSessionId: 'a', openSessionIds: ['a'] });
  assert.deepEqual(controller.getPaneLayout(), { panes: panesOf('a'), focusedPaneId: 0, splitRatio: 0.5 });
});

test('renderer: hydrate normalizes the stored layout through the pane model', async () => {
  const workspace = createFakeWorkspace({
    activeSessionId: 'b', openSessionIds: ['a', 'b'], focusedPaneId: 1, splitRatio: 0.95,
    panes: [{ paneId: 7, sessionId: 'a' }, { paneId: 3, sessionId: 'b' }, { paneId: 1, sessionId: 'a' }],
  });
  const controller = createWorkspaceStateController({ jennyShell: workspace.shell, paneModel });

  // The rail snapshot keeps its two-field shape.
  assert.deepEqual(await controller.restore(['a', 'b']), { activeSessionId: 'b', openSessionIds: ['a', 'b'] });
  const layout = controller.getPaneLayout();
  assert.deepEqual(layout, { panes: panesOf('a', 'b', ''), focusedPaneId: 1, splitRatio: 0.8 });
  assert.equal(Object.isFrozen(layout.panes), false);
  // The rail write is exactly what it was before W1-5.
  assert.deepEqual(workspace.updates, [{ activeSessionId: 'b', openSessionIds: ['a', 'b'] }]);
});

test('renderer: hydrate uses the window.rendererPaneModel global when no model is injected', async () => {
  const previous = globalThis.rendererPaneModel;
  globalThis.rendererPaneModel = paneModel;
  try {
    const workspace = createFakeWorkspace({
      activeSessionId: 'a', openSessionIds: ['a', 'b'], panes: ['a', 'b', 'b'], focusedPaneId: 9, splitRatio: 'x',
    });
    const controller = createWorkspaceStateController({ jennyShell: workspace.shell });
    await controller.restore(['a', 'b']);
    assert.deepEqual(controller.getPaneLayout(), { panes: panesOf('a', 'b', ''), focusedPaneId: 0, splitRatio: 0.5 });
  } finally {
    if (previous === undefined) delete globalThis.rendererPaneModel;
    else globalThis.rendererPaneModel = previous;
  }
});

test('renderer: a stored layout without panes seeds one pane from the restored active tab', async () => {
  const workspace = createFakeWorkspace({ activeSessionId: 'b', openSessionIds: ['a', 'b'] });
  const controller = createWorkspaceStateController({ jennyShell: workspace.shell, paneModel });
  await controller.restore(['a', 'b']);
  assert.deepEqual(controller.getPaneLayout(), { panes: panesOf('b'), focusedPaneId: 0, splitRatio: 0.5 });
});

test('renderer: persistPaneLayout called 5 times inside 250 ms issues ONE updateState with the last layout', async () => {
  const timers = createFakeTimers();
  const workspace = createFakeWorkspace({ activeSessionId: 'a', openSessionIds: ['a', 'b', 'c'] });
  const controller = createWorkspaceStateController({ jennyShell: workspace.shell, paneModel, ...timers });
  await controller.restore(['a', 'b', 'c']);
  const railWrites = workspace.updates.length;

  controller.persistPaneLayout({ panes: ['a', 'b'], focusedPaneId: 0, splitRatio: 0.5 });
  controller.persistPaneLayout({ splitRatio: 0.4 });
  controller.persistPaneLayout({ splitRatio: 0.35 });
  controller.persistPaneLayout({ splitRatio: 0.3 });
  const last = controller.persistPaneLayout({ panes: ['a', 'c'], splitRatio: 0.25 });

  assert.equal(PANE_LAYOUT_PERSIST_DELAY_MS, 250);
  assert.deepEqual(timers.pending().map((timer) => timer.ms), [250]);
  await settle();
  assert.equal(workspace.updates.length, railWrites, 'nothing is written before the window closes');
  assert.deepEqual(last, { panes: panesOf('a', 'c'), focusedPaneId: 0, splitRatio: 0.25 });

  timers.runAll();
  await settle();
  assert.deepEqual(workspace.updates.slice(railWrites), [{ panes: panesOf('a', 'c'), focusedPaneId: 0, splitRatio: 0.25 }]);

  // A later gesture opens a new window.
  controller.persistPaneLayout({ splitRatio: 0.6 });
  assert.equal(timers.pending().length, 1);
  timers.runAll();
  await settle();
  assert.deepEqual(workspace.updates.at(-1), { panes: panesOf('a', 'c'), focusedPaneId: 0, splitRatio: 0.6 });
});

test('renderer: dispose() flushes a pending pane-layout write and later calls are ignored', async () => {
  const timers = createFakeTimers();
  const workspace = createFakeWorkspace({ activeSessionId: 'a', openSessionIds: ['a', 'b'] });
  const controller = createWorkspaceStateController({ jennyShell: workspace.shell, paneModel, ...timers });
  await controller.restore(['a', 'b']);
  const railWrites = workspace.updates.length;

  controller.persistPaneLayout({ panes: ['a', 'b'], focusedPaneId: 0, splitRatio: 0.3 });
  await controller.dispose();
  assert.equal(timers.pending().length, 0);
  assert.deepEqual(workspace.updates.slice(railWrites), [{ panes: panesOf('a', 'b'), focusedPaneId: 0, splitRatio: 0.3 }]);

  controller.persistPaneLayout({ splitRatio: 0.7 });
  assert.equal(timers.pending().length, 0);
  await settle();
  assert.equal(workspace.updates.length, railWrites + 1);
});

test('renderer: focusing a pane through persistPaneLayout moves the rail active tab with it', async () => {
  const timers = createFakeTimers();
  const workspace = createFakeWorkspace({
    activeSessionId: 'a', openSessionIds: ['a', 'b'], panes: ['a', 'b'], focusedPaneId: 0,
  });
  const published = [];
  const controller = createWorkspaceStateController({
    jennyShell: workspace.shell, paneModel, ...timers, onStateChanged: (snapshot) => published.push(snapshot),
  });
  await controller.restore(['a', 'b']);
  published.length = 0;

  controller.persistPaneLayout({ focusedPaneId: 1 });
  assert.deepEqual(controller.getState(), { activeSessionId: 'b', openSessionIds: ['a', 'b'] });
  assert.deepEqual(published, [{ activeSessionId: 'b', openSessionIds: ['a', 'b'] }]);

  // A pane session that is not an open tab is blanked in memory, as the service would.
  const layout = controller.persistPaneLayout({ panes: ['a', 'zzz'] });
  assert.deepEqual(layout.panes, panesOf('a', ''));
  assert.equal(controller.getState().activeSessionId, 'b', 'a blank focused pane keeps the active tab');
});

test('renderer: promoting the focused pane session id rides the rail write, with no extra layout write', async () => {
  const timers = createFakeTimers();
  const workspace = createFakeWorkspace({ activeSessionId: 'local_1', openSessionIds: ['a', 'local_1'] });
  const controller = createWorkspaceStateController({ jennyShell: workspace.shell, paneModel, ...timers });
  await controller.restore(['a', 'local_1']);
  const writes = workspace.updates.length;

  await controller.rekeySession('local_1', 'real_1');
  assert.deepEqual(controller.getPaneLayout().panes, panesOf('real_1'));
  assert.equal(timers.pending().length, 0);
  assert.deepEqual(workspace.updates.slice(writes), [{ activeSessionId: 'real_1', openSessionIds: ['a', 'real_1'] }]);
});

test('renderer and service agree on the layout after every rail and pane write', async (t) => {
  const { service } = createService(t, { activeSessionId: 'a', openSessionIds: ['a', 'b'] });
  const timers = createFakeTimers();
  const bridge = { getState: async () => service.getWorkspaceState(), updateState: async (patch) => service.updateWorkspaceState(patch) };
  const controller = createWorkspaceStateController({ jennyShell: { workspace: bridge }, paneModel, ...timers });
  const storedLayout = () => layoutOf(service.getState().workspace);
  const agree = async (label) => {
    timers.runAll();
    await settle();
    assert.deepEqual(controller.getPaneLayout(), storedLayout(), label);
    assert.equal(controller.getState().activeSessionId, service.getWorkspaceState().activeSessionId || '', label);
  };

  await controller.restore(['a', 'b', 'c']);
  await agree('after restore');
  controller.persistPaneLayout({ panes: ['a', 'b'], focusedPaneId: 1, splitRatio: 0.4 });
  await agree('after open beside');
  await controller.openSession('c');
  await agree('after the rail opens c into the focused pane');
  await controller.openSession('a');
  await agree('after the rail activates the other pane\'s session');
  await controller.closeSession('c');
  await agree('after closing the non-focused pane\'s tab');
  controller.persistPaneLayout({ panes: ['a', 'b'], focusedPaneId: 0 });
  await agree('after refilling pane 1 with pane 0 focused');
  await controller.rekeySession('b', 'c');
  await agree('after promoting the non-focused pane\'s session id');
  assert.deepEqual(storedLayout().panes, panesOf('a', 'c'));
});
