'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  WorktreeRegistryService,
  WORKTREE_REGISTRY_SCHEMA_VERSION,
  defaultRegistryPath,
} = require('../services/worktree-registry-service');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

function createTempStore() {
  const dir = createTrackedTempDir('jenny-worktree-');
  const filePath = path.join(dir, 'worktrees.json');
  return { service: new WorktreeRegistryService(filePath), filePath };
}

function createLogCollector() {
  const entries = [];
  return {
    entries,
    logger: (level, event, details = {}) =>
      entries.push({ level, event, details }),
  };
}

const SAMPLE_ENTRY = Object.freeze({
  id: 'wt_alpha',
  repository_root: 'C:/dev/jenny',
  worktree_path: 'C:/dev/jenny-worktrees/alpha',
  branch: 'codex/alpha',
  base_ref: 'main',
  owner: { session_id: 'sess_1', task_id: 'tool_call_42' },
  status: 'available',
  created_at: '2026-05-16T12:00:00.000Z',
  last_checked_at: '2026-05-16T12:00:00.000Z',
});

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('WorktreeRegistryService / basics', () => {
  test('listAll returns empty array on a fresh store', () => {
    const { service } = createTempStore();
    assert.deepEqual(service.listAll(), []);
  });

  test('add then listAll round-trips an entry', () => {
    const { service } = createTempStore();
    service.add(SAMPLE_ENTRY);
    const list = service.listAll();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'wt_alpha');
    assert.equal(list[0].branch, 'codex/alpha');
    assert.equal(list[0].status, 'available');
  });

  test('add rejects duplicate ids', () => {
    const { service } = createTempStore();
    service.add(SAMPLE_ENTRY);
    assert.throws(() => service.add(SAMPLE_ENTRY), /duplicate worktree id/);
  });

  test('getById finds an existing entry', () => {
    const { service } = createTempStore();
    service.add(SAMPLE_ENTRY);
    const entry = service.getById('wt_alpha');
    assert.ok(entry);
    assert.equal(entry?.worktree_path, 'C:/dev/jenny-worktrees/alpha');
  });

  test('getById returns null for unknown id', () => {
    const { service } = createTempStore();
    assert.equal(service.getById('nope'), null);
  });

  test('removeById drops the entry', () => {
    const { service } = createTempStore();
    service.add(SAMPLE_ENTRY);
    service.removeById('wt_alpha');
    assert.deepEqual(service.listAll(), []);
  });
});

describe('WorktreeRegistryService / persistence', () => {
  test('entries survive a new service instance pointed at the same file', () => {
    const { service, filePath } = createTempStore();
    service.add(SAMPLE_ENTRY);
    const second = new WorktreeRegistryService(filePath);
    const list = second.listAll();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'wt_alpha');
  });
});

describe('WorktreeRegistryService / corruption + forward-version recovery', () => {
  test('corrupt JSON recovers to empty state and emits a warning', () => {
    const dir = createTrackedTempDir('jenny-worktree-corrupt-');
    const filePath = path.join(dir, 'worktrees.json');
    fs.writeFileSync(filePath, '{not valid', 'utf8');
    const logs = createLogCollector();
    const service = new WorktreeRegistryService(filePath, { logger: logs.logger });
    assert.deepEqual(service.listAll(), []);
    // FileJsonStore emits store.corrupted; we don't require an additional
    // worktree-specific warning for this path.
    const entry = logs.entries.find((item) => item.event === 'store.corrupted');
    assert.ok(entry);
  });

  test('forward-version files return empty state and log warning', () => {
    const dir = createTrackedTempDir('jenny-worktree-future-');
    const filePath = path.join(dir, 'worktrees.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: WORKTREE_REGISTRY_SCHEMA_VERSION + 99,
        worktrees: [{ id: 'wt_future', repository_root: 'X', worktree_path: 'Y' }],
      }),
      'utf8'
    );
    const logs = createLogCollector();
    const service = new WorktreeRegistryService(filePath, { logger: logs.logger });
    assert.deepEqual(service.listAll(), []);
    const entry = logs.entries.find(
      (item) => item.event === 'worktree_registry.forward_version'
    );
    assert.ok(entry, 'forward_version warning should be logged');
    assert.equal(entry.level, 'WARN');
  });

  test('entries with missing required fields are silently dropped', () => {
    const dir = createTrackedTempDir('jenny-worktree-partial-');
    const filePath = path.join(dir, 'worktrees.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: WORKTREE_REGISTRY_SCHEMA_VERSION,
        worktrees: [
          { id: 'ok', repository_root: '/r', worktree_path: '/r/wt' },
          { id: 'no_path', repository_root: '/r' }, // missing worktree_path
          { worktree_path: '/r/wt2', repository_root: '/r' }, // missing id
        ],
      }),
      'utf8'
    );
    const service = new WorktreeRegistryService(filePath);
    const list = service.listAll();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'ok');
  });

  test('saveAll rejects arrays containing duplicate ids', () => {
    const { service } = createTempStore();
    assert.throws(
      () =>
        service.saveAll([
          SAMPLE_ENTRY,
          { ...SAMPLE_ENTRY, worktree_path: '/different/path' },
        ]),
      /duplicate worktree id/
    );
  });
});

describe('defaultRegistryPath', () => {
  test('lands under <userData>/.jenny/worktrees.json', () => {
    const computed = defaultRegistryPath('/home/user/jenny-userdata');
    // Use platform-neutral comparison.
    assert.ok(computed.endsWith(path.join('.jenny', 'worktrees.json')));
    assert.ok(computed.startsWith(path.join('/home/user/jenny-userdata')));
  });
});
