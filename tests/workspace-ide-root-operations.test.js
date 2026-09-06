'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const { WorkspaceIdeService } = require('../services/workspace-ide-service');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/workspace-ide-errors');
const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createCoordinator(rootPath, extra = {}) {
  return new WorkspaceRootCoordinator({
    initialRootPath: rootPath,
    normalizeRootPath: (value) => String(value || ''),
    rootIdFactory: (value) => value ? `root:${String(value).toLowerCase()}` : null,
    ...extra,
  });
}

function createService(workspaceRoot, extra = {}) {
  const rootCoordinator = extra.rootCoordinator || createCoordinator(workspaceRoot);
  return new WorkspaceIdeService({
    configService: {
      getToolsWorkspaceRoot: () => workspaceRoot,
      getState: () => ({ toolsWorkspaceRoot: workspaceRoot }),
      getWorkspaceRootStatus: () => ({ state: workspaceRoot ? 'ready' : 'missing', message: '' }),
    },
    rootContextProvider: () => rootCoordinator,
    ...extra,
  });
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('mutation lease blocks a root commit until the pinned write settles', async () => {
  const rootA = createTrackedTempDir('jenny-ide-root-a-');
  const rootB = createTrackedTempDir('jenny-ide-root-b-');
  const enteredMutation = deferred();
  const finishMutation = deferred();
  const coordinator = createCoordinator(rootA);
  const service = createService(rootA, {
    rootCoordinator: coordinator,
    hooks: {
      async beforeLeafMutation({ operation }) {
        assert.equal(operation.context.rootPath, rootA);
        enteredMutation.resolve();
        await finishMutation.promise;
      },
    },
  });

  const writePromise = service.createFile({ path: 'same.txt', expectedGeneration: 0 });
  const firstEvent = await Promise.race([
    enteredMutation.promise.then(() => 'hook_entered'),
    writePromise.then(() => 'write_completed'),
  ]);
  assert.equal(firstEvent, 'hook_entered', 'mutation must acquire a lease before its final write');

  const prepared = await coordinator.prepareTarget(rootB);
  const commitPromise = coordinator.commit({ transitionId: prepared.transitionId });
  let commitSettled = false;
  void commitPromise.then(() => { commitSettled = true; });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(coordinator.captureContext().phase, 'transitioning');
  assert.equal(commitSettled, false, 'root commit must wait for the mutation lease to drain');
  finishMutation.resolve();

  const [writeResult, commitResult] = await Promise.all([writePromise, commitPromise]);
  assert.equal(writeResult.path, 'same.txt');
  assert.equal(commitResult.committed, true);
  assert.equal(fs.existsSync(path.join(rootA, 'same.txt')), true);
  assert.equal(fs.existsSync(path.join(rootB, 'same.txt')), false);
});

test('stale expectedGeneration is rejected without changing bytes', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  const target = path.join(root, 'same.txt');
  fs.writeFileSync(target, 'original', 'utf8');
  const service = createService(root);

  await assert.rejects(
    service.writeFile({ path: 'same.txt', content: 'stale', expectedGeneration: 99 }),
    (error) => {
      assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.STALE_GENERATION);
      return true;
    }
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});

test('mutators fail closed when the coordinator owner is unavailable', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  const service = new WorkspaceIdeService({
    configService: {
      getToolsWorkspaceRoot: () => root,
      getState: () => ({ toolsWorkspaceRoot: root }),
      getWorkspaceRootStatus: () => ({ state: 'ready', message: '' }),
    },
  });

  await assert.rejects(service.createFile({ path: 'blocked.txt' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING);
    assert.equal(error.details.reason, 'root_context_unavailable');
    return true;
  });
  assert.equal(fs.existsSync(path.join(root, 'blocked.txt')), false);
});

test('missing parents are created one verified component at a time', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  const mkdirOptions = [];
  const instrumentedFs = {
    ...fsPromises,
    async mkdir(target, options) {
      mkdirOptions.push({ target, options });
      return fsPromises.mkdir(target, options);
    },
  };
  const service = createService(root, { fs: instrumentedFs });

  await service.createFile({ path: 'one/two/three.txt' });

  assert.equal(fs.readFileSync(path.join(root, 'one', 'two', 'three.txt'), 'utf8'), '');
  assert.ok(mkdirOptions.length >= 2);
  assert.equal(
    mkdirOptions.some(({ options }) => options?.recursive === true),
    false,
    'recursive mkdir can cross a swapped parent and must not be used'
  );
});

test('configured-root identity replacement is rejected before leaf mutation', async () => {
  const container = createTrackedTempDir('jenny-ide-container-');
  const root = path.join(container, 'workspace');
  const displaced = path.join(container, 'workspace-old');
  fs.mkdirSync(root);
  let hookCalls = 0;
  const service = createService(root, {
    hooks: {
      async beforeLeafMutation() {
        hookCalls += 1;
        fs.renameSync(root, displaced);
        fs.mkdirSync(root);
      },
    },
  });

  await assert.rejects(service.createFile({ path: 'new.txt' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.ROOT_INVALID);
    assert.equal(error.details.reason, 'root_identity_changed');
    return true;
  });
  assert.equal(hookCalls, 1);
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
  assert.equal(fs.existsSync(path.join(displaced, 'new.txt')), false);
});

test('a deleted configured root is refused after validation and never recreated', async () => {
  const container = createTrackedTempDir('jenny-ide-container-');
  const root = path.join(container, 'workspace');
  fs.mkdirSync(root);
  const service = createService(root, {
    hooks: {
      async beforeLeafMutation() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    },
  });

  await assert.rejects(service.createDirectory({ path: 'nested/new-dir' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.ROOT_INVALID);
    return true;
  });
  assert.equal(fs.existsSync(root), false);
});

test('a parent junction swap is rejected without touching its target', async (t) => {
  const root = createTrackedTempDir('jenny-ide-');
  const outside = createTrackedTempDir('jenny-ide-outside-');
  const parent = path.join(root, 'src');
  const displaced = path.join(root, 'src-original');
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside', 'utf8');
  try {
    const probe = path.join(root, 'probe-junction');
    fs.symlinkSync(outside, probe, process.platform === 'win32' ? 'junction' : 'dir');
    fs.unlinkSync(probe);
  } catch (error) {
    t.skip(`directory-link race oracle unavailable: ${error.code || error.message}`);
    return;
  }
  const service = createService(root, {
    hooks: {
      async beforeLeafMutation() {
        fs.renameSync(parent, displaced);
        fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
      },
    },
  });

  await assert.rejects(service.createFile({ path: 'src/escaped.txt' }), (error) => {
    assert.ok(
      error.code === WORKSPACE_FS_ERROR_CODES.PATH_OUTSIDE_ROOT
        || error.code === WORKSPACE_FS_ERROR_CODES.ROOT_INVALID,
      `unexpected error: ${error.code} ${error.message}`
    );
    return true;
  });
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside');
  assert.equal(fs.existsSync(path.join(outside, 'escaped.txt')), false);
});

test('a failed mutation lease is released exactly once', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  let releaseCalls = 0;
  const context = Object.freeze({ rootPath: root, rootId: 'root:test', generation: 4, phase: 'ready' });
  const coordinator = {
    acquireOperation: () => ({
      acquired: true,
      context,
      signal: new AbortController().signal,
      isCurrent: () => true,
      release: () => {
        releaseCalls += 1;
        return releaseCalls === 1;
      },
    }),
  };
  const service = createService(root, {
    rootContextProvider: () => coordinator,
    hooks: {
      async beforeLeafMutation() {
        throw new Error('injected mutation failure');
      },
    },
  });

  await assert.rejects(service.createFile({ path: 'failure.txt', expectedGeneration: 4 }), /injected mutation failure/);
  assert.equal(releaseCalls, 1);
  assert.equal(fs.existsSync(path.join(root, 'failure.txt')), false);
});

test('every active legacy mutator owns one coordinator mutation lease', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.writeFileSync(path.join(root, 'rename-me.txt'), 'rename', 'utf8');
  fs.writeFileSync(path.join(root, 'trash-me.txt'), 'trash', 'utf8');
  const base = createCoordinator(root);
  const acquiredKinds = [];
  let releaseCalls = 0;
  const coordinator = {
    acquireOperation(options) {
      acquiredKinds.push(options.kind);
      const lease = base.acquireOperation(options);
      const release = lease.release;
      return {
        ...lease,
        release() {
          const released = release();
          if (released) releaseCalls += 1;
          return released;
        },
      };
    },
  };
  const service = createService(root, {
    rootContextProvider: () => coordinator,
    trashItemImpl: async () => {},
  });

  await service.writeFile({ path: 'written.txt', content: 'written' });
  await service.createFile({ path: 'created.txt' });
  await service.createDirectory({ path: 'created-dir' });
  await service.rename({ from: 'rename-me.txt', to: 'renamed.txt' });
  await service.delete({ path: 'trash-me.txt' });

  assert.deepEqual(acquiredKinds, ['mutation', 'mutation', 'mutation', 'mutation', 'mutation']);
  assert.equal(releaseCalls, 5);
});

test('a released failed mutation cannot strand a coordinator rollback generation', async () => {
  const rootA = createTrackedTempDir('jenny-ide-root-a-');
  const rootB = createTrackedTempDir('jenny-ide-root-b-');
  let rejectMutation = true;
  const coordinator = createCoordinator(rootA, {
    applyRootPath: async () => {
      throw new Error('injected persistence failure');
    },
  });
  const service = createService(rootA, {
    rootCoordinator: coordinator,
    hooks: {
      async beforeLeafMutation() {
        if (rejectMutation) throw new Error('injected mutation failure');
      },
    },
  });

  await assert.rejects(service.createFile({ path: 'failed.txt' }), /injected mutation failure/);
  const prepared = await coordinator.prepareTarget(rootB);
  const transition = await coordinator.commit({ transitionId: prepared.transitionId });
  assert.equal(transition.rolledBack, true);
  assert.equal(transition.context.rootPath, rootA);
  assert.equal(transition.context.generation, 1);
  assert.equal(transition.context.phase, 'ready');

  rejectMutation = false;
  const created = await service.createFile({ path: 'after-rollback.txt', expectedGeneration: 1 });
  assert.equal(created.path, 'after-rollback.txt');
  assert.equal(fs.existsSync(path.join(rootA, 'after-rollback.txt')), true);
  assert.equal(fs.existsSync(path.join(rootB, 'after-rollback.txt')), false);
});
