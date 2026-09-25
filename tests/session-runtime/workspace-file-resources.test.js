'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { VersionedWorkspaceFileService } = require('../../services/versioned-workspace-file-service');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');
const { ResourceBroker, filesystemResource } = require('../../services/session-runtime/resource-broker');
const { cleanupTrackedResources, createTrackedTempDir } = require('../helpers/resource-cleanup');

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createRootContext(rootPath) {
  let context = Object.freeze({ rootPath, rootId: `root:${path.basename(rootPath)}`,
    generation: 1, phase: 'ready' });
  let sequence = 0;
  let releases = 0;
  const rootContext = {
    captureContext: () => context,
    acquireOperation({ kind, cancellable }) {
      const acquiredContext = context;
      const controller = new AbortController();
      let released = false;
      return {
        acquired: true,
        operationId: `operation-${++sequence}`,
        context: acquiredContext,
        signal: controller.signal,
        kind,
        cancellable,
        isCurrent: () => rootContext.isCurrent(acquiredContext),
        release() {
          if (released) return false;
          released = true;
          releases += 1;
          return true;
        },
      };
    },
    isCurrent(candidate) {
      return Boolean(candidate && context.phase === 'ready'
        && candidate.rootId === context.rootId && candidate.generation === context.generation);
    },
    update(patch) {
      context = Object.freeze({ ...context, ...patch });
    },
    get releaseCount() { return releases; },
  };
  return rootContext;
}

function createRuntime() {
  let leaseId = 0;
  const broker = new ResourceBroker({ createId: () => `lease-${++leaseId}` });
  const pathResolver = new PhysicalPathResolver();
  return { broker, pathResolver, provider: () => ({ broker, pathResolver }) };
}

function createService(root, runtime, options = {}) {
  const rootContext = options.rootContext || createRootContext(root);
  return { rootContext, service: new VersionedWorkspaceFileService({
    rootContext,
    resourceAdmissionProvider: runtime?.provider,
    ...options,
  }) };
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('same-file IO serializes while a disjoint file proceeds', async () => {
  const root = createTrackedTempDir('jenny-file-resources-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b');
  const runtime = createRuntime();
  const baseline = await createService(root, runtime).service.readText({ path: 'a.txt' });
  const entered = deferred();
  const resume = deferred();
  const first = createService(root, runtime, { hooks: { afterTargetOpen: async () => {
    entered.resolve();
    await resume.promise;
  } } }).service;
  const second = createService(root, runtime).service;
  const disjoint = createService(root, runtime).service;

  const firstRead = first.readText({ path: 'a.txt' });
  await entered.promise;
  const secondWrite = second.writeText({
    path: 'a.txt',
    content: 'updated',
    expectedGeneration: baseline.generation,
    expectedFileVersion: baseline.fileVersion,
  });
  await nextTurn();
  assert.equal(runtime.broker.snapshot().waiter_count, 1);

  const disjointResult = await disjoint.readText({ path: 'b.txt' });
  assert.equal(disjointResult.content, 'b');
  assert.equal(runtime.broker.snapshot().waiter_count, 1);

  resume.resolve();
  await Promise.all([firstRead, secondWrite]);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'updated');
  assert.equal(runtime.broker.snapshot().lease_count, 0);
});

test('a workspace claim blocks its files without blocking another workspace', async () => {
  const base = createTrackedTempDir('jenny-root-resources-');
  const blockedRoot = path.join(base, 'blocked');
  const freeRoot = path.join(base, 'free');
  fs.mkdirSync(blockedRoot);
  fs.mkdirSync(freeRoot);
  fs.writeFileSync(path.join(blockedRoot, 'file.txt'), 'blocked');
  fs.writeFileSync(path.join(freeRoot, 'file.txt'), 'free');
  const runtime = createRuntime();
  const rootClaim = await runtime.broker.acquire({
    ownerId: 'model-root-claim',
    resources: [filesystemResource(runtime.pathResolver.resolve(blockedRoot))],
  });

  const blockedRead = createService(blockedRoot, runtime).service.readText({ path: 'file.txt' });
  await nextTurn();
  assert.equal(runtime.broker.snapshot().waiter_count, 1);
  const freeRead = await createService(freeRoot, runtime).service.readText({ path: 'file.txt' });
  assert.equal(freeRead.content, 'free');

  runtime.broker.release(rootClaim, { producerSettled: true });
  assert.equal((await blockedRead).content, 'blocked');
  assert.equal(runtime.broker.snapshot().lease_count, 0);
});

test('a root generation change while waiting rejects before file IO', async () => {
  const root = createTrackedTempDir('jenny-stale-file-resource-');
  const target = path.join(root, 'file.txt');
  fs.writeFileSync(target, 'content');
  const runtime = createRuntime();
  const holder = await runtime.broker.acquire({
    ownerId: 'holder', resources: [filesystemResource(runtime.pathResolver.resolve(target))],
  });
  const rootContext = createRootContext(root);
  let opens = 0;
  const fsAdapter = { ...fsPromises, open: async (...args) => {
    opens += 1;
    return fsPromises.open(...args);
  } };
  const pending = createService(root, runtime, { rootContext, fs: fsAdapter })
    .service.readText({ path: 'file.txt' });
  await nextTurn();
  assert.equal(runtime.broker.snapshot().waiter_count, 1);

  rootContext.update({ generation: 2 });
  runtime.broker.release(holder, { producerSettled: true });
  await assert.rejects(pending, /failed safely/);
  assert.equal(opens, 0);
  assert.equal(rootContext.releaseCount, 1);
  assert.equal(runtime.broker.snapshot().lease_count, 0);
});

test('an uncertain file close quarantines only that physical resource', async () => {
  const root = createTrackedTempDir('jenny-uncertain-file-resource-');
  const target = path.join(root, 'uncertain.txt');
  fs.writeFileSync(target, 'content');
  fs.writeFileSync(path.join(root, 'free.txt'), 'free');
  const runtime = createRuntime();
  const fsAdapter = { ...fsPromises, async open(filePath, flags, mode) {
    const handle = await fsPromises.open(filePath, flags, mode);
    if (path.resolve(filePath) !== path.resolve(target) || flags !== 'r') return handle;
    return {
      read: (...args) => handle.read(...args),
      stat: (...args) => handle.stat(...args),
      async close() {
        await handle.close();
        throw Object.assign(new Error('uncertain close'), { code: 'EIO' });
      },
    };
  } };

  await assert.rejects(
    createService(root, runtime, { fs: fsAdapter }).service.readText({ path: 'uncertain.txt' }),
    /failed safely/
  );
  assert.equal(runtime.broker.snapshot().quarantined_count, 1);
  const freeRead = await createService(root, runtime).service.readText({ path: 'free.txt' });
  assert.equal(freeRead.content, 'free');
  assert.equal(runtime.broker.snapshot().lease_count, 1);
});

test('a declared but unavailable admission provider fails before file IO', async () => {
  const root = createTrackedTempDir('jenny-missing-admission-');
  fs.writeFileSync(path.join(root, 'file.txt'), 'content');
  const rootContext = createRootContext(root);
  let opens = 0;
  const service = new VersionedWorkspaceFileService({
    rootContext,
    resourceAdmissionProvider: () => null,
    fs: { ...fsPromises, open: async (...args) => { opens += 1; return fsPromises.open(...args); } },
  });

  await assert.rejects(service.readText({ path: 'file.txt' }), /failed safely/);
  assert.equal(opens, 0);
  assert.equal(rootContext.releaseCount, 1);
});

test('a junction retarget during root preparation cannot escape the admitted file identity', async (t) => {
  const root = createTrackedTempDir('jenny-admitted-link-');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(first, 'file.txt'), 'A');
  fs.writeFileSync(path.join(second, 'file.txt'), 'B');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(first, alias, linkType);
  } catch (error) {
    t.skip(`directory-link creation unavailable: ${error.code || error.message}`);
    return;
  }

  const runtime = createRuntime();
  const heldSecond = await runtime.broker.acquire({
    ownerId: 'held-second-file',
    resources: [filesystemResource(runtime.pathResolver.resolve(path.join(second, 'file.txt')))],
  });
  let swapped = false;
  let opens = 0;
  const fsAdapter = { ...fsPromises,
    async stat(filePath, ...args) {
      const result = await fsPromises.stat(filePath, ...args);
      if (!swapped && path.resolve(filePath) === path.resolve(root)) {
        swapped = true;
        if (process.platform === 'win32') fs.rmdirSync(alias);
        else fs.unlinkSync(alias);
        fs.symlinkSync(second, alias, linkType);
      }
      return result;
    },
    async open(...args) {
      opens += 1;
      return fsPromises.open(...args);
    },
  };
  const service = createService(root, runtime, { fs: fsAdapter }).service;

  await assert.rejects(service.readText({ path: 'alias/file.txt' }), /failed safely/);
  assert.equal(swapped, true);
  assert.equal(opens, 0);
  assert.equal(runtime.broker.snapshot().lease_count, 1);
  assert.equal(runtime.broker.snapshot().waiter_count, 0);
  assert.equal(fs.readFileSync(path.join(second, 'file.txt'), 'utf8'), 'B');
  runtime.broker.release(heldSecond, { producerSettled: true });
});
