'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG_VERSION, normalizeState } = require('../services/shell-config-state');
const { registerWorkspaceIpcHandlers } = require('../services/main/workspace-ipc-registration');
const { workspaceIdeMethods } = require('../services/shell-config-workspace-ide');
const { workspaceRootId } = require('../services/workspace-root-identity');

function rootId(index) {
  return `root_${String(index).padStart(24, '0')}`;
}

function createTarget(state) {
  const events = [];
  const logs = [];
  const target = {
    state,
    events,
    logs,
    _logger(level, event, details) { logs.push({ level, event, details }); },
    _workspaceWriteDirty: false,
    _shouldBlockConfigWrite: () => false,
    _normalizeState(value) { return value; },
    _persistState() { this._workspaceWriteDirty = false; return true; },
    _clearPendingWorkspaceTimer() {},
    _scheduleWorkspaceWrite() { events.push('scheduled'); },
    emit(name, _state, details) { events.push([name, details]); },
    getState() { return this.state; },
  };
  Object.assign(target, workspaceIdeMethods);
  return target;
}

test('v35 flat IDE state migrates into global preferences and the configured root bucket', () => {
  const root = 'C:/dev/jenny';
  const state = normalizeState({
    version: 35,
    toolsWorkspaceRoot: root,
    workspaceIde: {
      openTabs: [{ path: 'same.txt', pinned: true }],
      activeTabPath: 'same.txt',
      expandedDirs: ['src'],
      activeStageSurface: 'preview',
      previewPath: 'same.txt',
      fontSize: 17,
      railSide: 'right',
    },
  });
  const id = workspaceRootId(root);

  assert.equal(state.version, CONFIG_VERSION);
  assert.deepEqual(state.workspaceIde.rootLru, [id]);
  assert.equal(state.workspaceIde.preferences.fontSize, 17);
  assert.equal(state.workspaceIde.preferences.railSide, 'right');
  assert.deepEqual(state.workspaceIde.roots[id].openTabs, [
    { path: 'same.txt', pinned: true },
  ]);
  assert.equal(state.workspaceIde.roots[id].previewPath, 'same.txt');
});

test('v35 root-local paths are not assigned when no root was configured', () => {
  const state = normalizeState({
    version: 35,
    workspaceIde: { openTabs: ['private.txt'], expandedDirs: ['private'], fontSize: 19 },
  });
  assert.deepEqual(state.workspaceIde.rootLru, []);
  assert.deepEqual(Object.keys(state.workspaceIde.roots), []);
  assert.equal(state.workspaceIde.preferences.fontSize, 19);
});

test('malformed versions take the full migration path instead of skipping v36', () => {
  const root = 'C:/dev/malformed-version';
  const state = normalizeState({
    version: 'not-a-version',
    toolsWorkspaceRoot: root,
    workspaceIde: { openTabs: ['kept.txt'], fontSize: 18 },
  });
  const id = workspaceRootId(root);

  assert.equal(state.version, CONFIG_VERSION);
  assert.deepEqual(state.workspaceIde.roots[id].openTabs.map((tab) => tab.path), ['kept.txt']);
  assert.equal(state.workspaceIde.preferences.fontSize, 18);
});

test('an already-structured v35 IDE store normalizes idempotently', () => {
  const retained = rootId(4);
  const state = normalizeState({
    version: 35,
    toolsWorkspaceRoot: 'C:/dev/different-root',
    workspaceIde: {
      preferences: { fontSize: 17 },
      rootLru: [retained],
      roots: { [retained]: { openTabs: ['retained.txt'] } },
    },
  });

  assert.deepEqual(state.workspaceIde.rootLru, [retained]);
  assert.deepEqual(state.workspaceIde.roots[retained].openTabs.map((tab) => tab.path), ['retained.txt']);
  assert.equal(state.workspaceIde.preferences.fontSize, 17);
});

test('root buckets isolate same-relative paths while global preferences remain shared', () => {
  const target = createTarget(normalizeState({}));
  target.updateWorkspaceIdeState(rootId(1), {
    openTabs: [{ path: 'same.txt' }],
    activeTabPath: 'same.txt',
    previewPath: 'same.txt',
    fontSize: 18,
  });
  target.updateWorkspaceIdeState(rootId(2), {
    openTabs: [{ path: 'other.txt' }],
    activeTabPath: 'other.txt',
    previewPath: 'other.txt',
  });

  const first = target.getWorkspaceIdeState(rootId(1));
  const second = target.getWorkspaceIdeState(rootId(2));
  assert.deepEqual(first.openTabs.map((tab) => tab.path), ['same.txt']);
  assert.deepEqual(second.openTabs.map((tab) => tab.path), ['other.txt']);
  assert.equal(first.fontSize, 18);
  assert.equal(second.fontSize, 18);
});

test('explorer sort mode is normalized and shared as a global preference', () => {
  assert.equal(CONFIG_VERSION, 51);
  const target = createTarget(normalizeState({}));
  target.updateWorkspaceIdeState(rootId(1), { explorerSortMode: 'type' });
  assert.equal(target.getWorkspaceIdeState(rootId(1)).explorerSortMode, 'type');
  assert.equal(target.getWorkspaceIdeState(rootId(2)).explorerSortMode, 'type');
  target.updateWorkspaceIdeState(rootId(2), { explorerSortMode: 'garbage' });
  assert.equal(target.getWorkspaceIdeState(rootId(1)).explorerSortMode, 'name');
  assert.equal(target.getWorkspaceIdeStore().preferences.explorerSortMode, 'name');
});

test('the eleventh root evicts exactly the least-recent root bucket', () => {
  const target = createTarget(normalizeState({}));
  for (let index = 1; index <= 11; index += 1) {
    target.updateWorkspaceIdeState(rootId(index), { openTabs: [`${index}.txt`] });
  }
  const store = target.getWorkspaceIdeStore();
  assert.equal(store.rootLru.length, 10);
  assert.equal(store.rootLru[0], rootId(11));
  assert.equal(store.rootLru.includes(rootId(1)), false);
  assert.equal(Object.prototype.hasOwnProperty.call(store.roots, rootId(1)), false);
  assert.equal(Object.prototype.hasOwnProperty.call(store.roots, rootId(2)), true);
});

test('runtime root eviction logs only a count and the hydration state carries that count', () => {
  const roots = Object.create(null);
  const rootLru = [];
  for (let index = 1; index <= 10; index += 1) {
    const id = rootId(index);
    rootLru.push(id);
    roots[id] = { openTabs: [`${index}.txt`] };
  }
  const state = normalizeState({ version: CONFIG_VERSION, workspaceIde: { preferences: {}, rootLru, roots } });
  const touched = createTarget(state);
  const handlers = new Map();
  registerWorkspaceIpcHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, touched, { getRootContext: () => ({
    rootPath: 'G:/eleventh', rootId: rootId(11), generation: 1, phase: 'ready',
  }) });

  const payload = handlers.get('workspace-ide:get-state')();

  assert.equal(payload.evictedRootCount, 1);
  assert.deepEqual(touched.logs, [{
    level: 'WARN', event: 'workspace_ide.root_lru_evicted', details: { evicted: 1 },
  }]);
  assert.equal(JSON.stringify(touched.logs).includes(rootId(1)), false, 'no root id or path is logged');

  const updated = createTarget(state);
  updated.updateWorkspaceIdeState(rootId(11), { openTabs: ['11.txt'] });
  assert.deepEqual(updated.logs, [{
    level: 'WARN', event: 'workspace_ide.root_lru_evicted', details: { evicted: 1 },
  }]);
});

test('malformed root entries are isolated without suppressing valid siblings', () => {
  const valid = rootId(7);
  const target = createTarget(normalizeState({
    version: 36,
    workspaceIde: {
      preferences: { fontSize: 15 },
      rootLru: ['__proto__', valid],
      roots: {
        __proto__: { openTabs: ['escape.txt'] },
        [valid]: { openTabs: ['valid.txt'], activeTabPath: 'valid.txt' },
      },
    },
  }));
  assert.deepEqual(target.getWorkspaceIdeState(valid).openTabs.map((tab) => tab.path), ['valid.txt']);
  assert.equal(target.getWorkspaceIdeState(valid).fontSize, 15);
  assert.deepEqual(target.getWorkspaceIdeStore().rootLru, [valid]);
});

test('malformed MRU entries do not consume the ten-root retention budget', () => {
  const roots = Object.create(null);
  const validIds = [];
  for (let index = 1; index <= 10; index += 1) {
    const id = rootId(index);
    validIds.push(id);
    roots[id] = { openTabs: [`${index}.txt`] };
  }
  const malformedId = rootId(99);
  roots[malformedId] = null;
  const target = createTarget(normalizeState({
    version: 36,
    workspaceIde: {
      preferences: {},
      rootLru: [malformedId, ...validIds],
      roots,
    },
  }));

  const store = target.getWorkspaceIdeStore();
  assert.deepEqual(store.rootLru, validIds);
  assert.equal(Object.keys(store.roots).length, 10);
});
