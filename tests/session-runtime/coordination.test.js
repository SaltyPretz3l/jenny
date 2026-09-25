'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PhysicalPathResolver,
  physicalPathsConflict,
} = require('../../services/session-runtime/physical-paths');
const {
  DEFAULT_RESOURCE_LIMITS,
  ResourceBroker,
  buildOperationResources,
  capacityResource,
  filesystemResource,
} = require('../../services/session-runtime/resource-broker');

function enoent() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function fakeWindowsResolver({
  identities = new Map(), realpaths = new Map(), links = new Map(),
} = {}) {
  return new PhysicalPathResolver({
    platform: 'win32',
    pathImpl: path.win32,
    fsImpl: {
      realpathSync(value) {
        const key = path.win32.normalize(value).toLowerCase();
        if (!realpaths.has(key)) throw enoent();
        return realpaths.get(key);
      },
      lstatSync(value) {
        const key = path.win32.normalize(value).toLowerCase();
        if (!links.has(key)) throw enoent();
        return { isSymbolicLink: () => true };
      },
      readlinkSync(value) {
        const key = path.win32.normalize(value).toLowerCase();
        if (!links.has(key)) throw enoent();
        return links.get(key);
      },
      statSync(value) {
        const key = path.win32.normalize(value).toLowerCase();
        const identity = identities.get(key);
        if (!identity) throw enoent();
        return { dev: identity.dev, ino: identity.ino,
          isDirectory: () => identity.directory === true };
      },
    },
  });
}

function identity(comparisonPath, { dev = null, ino = null, directory = false } = {}) {
  return new PhysicalPathResolver({
    platform: 'posix',
    pathImpl: path.posix,
    fsImpl: {
      realpathSync: (value) => value,
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readlinkSync: () => { throw enoent(); },
      statSync: () => ({
        dev: dev === null ? 0n : BigInt(dev),
        ino: ino === null ? 0n : BigInt(ino),
        isDirectory: () => directory,
      }),
    },
  }).resolve(comparisonPath);
}

function createBroker(options = {}) {
  let nextId = 0;
  return new ResourceBroker({ ...options, createId: () => `lease-${++nextId}`, now: () => 100 });
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('physical paths collapse Windows case, symlink, and UNC aliases', () => {
  const realpaths = new Map([
    ['c:\\alias\\file.txt', 'C:\\Work\\File.txt'],
    ['c:\\work\\file.txt', 'C:\\Work\\File.txt'],
    ['\\\\server\\share\\root', '\\\\Server\\Share\\Root'],
  ]);
  const identities = new Map([
    ['c:\\work\\file.txt', { dev: 7n, ino: 11n }],
    ['\\\\server\\share\\root', { dev: 0n, ino: 0n, directory: true }],
  ]);
  const resolver = fakeWindowsResolver({ identities, realpaths });
  const alias = resolver.resolve('C:\\ALIAS\\File.txt');
  const canonical = resolver.resolve('c:\\work\\file.txt');
  const uncUpper = resolver.resolve('\\\\SERVER\\SHARE\\ROOT');
  const uncLower = resolver.resolve('\\\\server\\share\\root');

  assert.equal(alias.identity_key, 'filesystem:c:/work/file.txt:inode:7:11');
  assert.equal(alias.identity_key, canonical.identity_key);
  assert.equal(alias.comparison_path, 'c:/work/file.txt');
  assert.equal(uncUpper.identity_key, uncLower.identity_key);
  assert.equal(uncUpper.identity_complete, false);
});

test('new targets use the resolved parent plus basename when inode identity is unavailable', () => {
  const resolver = fakeWindowsResolver({
    realpaths: new Map([['c:\\alias', 'D:\\Physical']]),
  });
  const target = resolver.resolve('C:\\alias\\New.txt');

  assert.equal(target.exists, false);
  assert.equal(target.resolved_path, 'D:\\Physical\\New.txt');
  assert.equal(target.comparison_path, 'd:/physical/new.txt');
  assert.equal(target.identity_complete, false);
});

test('dangling directory aliases resolve through their target instead of minting an alias key', () => {
  const resolver = fakeWindowsResolver({
    realpaths: new Map([['d:\\', 'D:\\']]),
    links: new Map([['c:\\alias', 'D:\\Physical']]),
  });
  const aliasTarget = resolver.resolve('C:\\alias\\new.txt');
  const directTarget = resolver.resolve('D:\\Physical\\new.txt');

  assert.equal(aliasTarget.resolved_path, 'D:\\Physical\\new.txt');
  assert.equal(aliasTarget.identity_key, directTarget.identity_key);
});

test('valid inode identity detects hardlinks while fallback explicitly remains path-only', () => {
  const first = identity('/workspace/a.txt', { dev: '3', ino: '9' });
  const hardlink = identity('/workspace/b.txt', { dev: '3', ino: '9' });
  const fallbackA = identity('/workspace/a.txt');
  const fallbackB = identity('/workspace/b.txt');

  assert.equal(physicalPathsConflict(first, hardlink), true);
  assert.equal(physicalPathsConflict(fallbackA, fallbackB), false);
  assert.equal(physicalPathsConflict(identity('/', { directory: true }), fallbackA), true);
  assert.equal(fallbackA.identity_complete, false);
});

test('real junction or symlink aliases resolve to one physical directory', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-resource-path-'));
  const target = path.join(tempRoot, 'target');
  const alias = path.join(tempRoot, 'alias');
  fs.mkdirSync(target);
  try {
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    t.skip(`junction creation unavailable: ${error.code || error.message}`);
    return;
  }
  try {
    const resolver = new PhysicalPathResolver();
    const canonical = resolver.resolve(target);
    const linked = resolver.resolve(alias);
    assert.equal(physicalPathsConflict(canonical, linked), true);
    assert.equal(linked.comparison_path, canonical.comparison_path);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('broker acquires every capacity atomically and skips an ineligible waiter', async () => {
  const broker = createBroker({ limits: { tool_operations: 2, tests: 1 } });
  const heldTest = await broker.acquire({
    ownerId: 'test-holder', resources: [capacityResource('tests')],
  });
  let combinedSettled = false;
  const combinedPromise = broker.acquire({
    ownerId: 'combined',
    resources: [capacityResource('tests'), capacityResource('tool_operations', 2)],
  }).then((lease) => { combinedSettled = true; return lease; });
  await nextTurn();
  const independent = await broker.acquire({
    ownerId: 'independent', resources: [capacityResource('tool_operations')],
  });

  assert.equal(combinedSettled, false);
  assert.equal(broker.snapshot().capacity.tool_operations, 1);
  broker.release(heldTest, { producerSettled: true });
  await nextTurn();
  assert.equal(combinedSettled, false);
  broker.release(independent, { producerSettled: true });
  const combined = await combinedPromise;
  assert.equal(broker.snapshot().capacity.tool_operations, 2);
  broker.release(combined, { producerSettled: true });
});

test('tryAcquire returns waiting without retaining a waiter or partial resource', () => {
  const broker = createBroker({ limits: { tool_operations: 2, tests: 1 } });
  const held = broker.tryAcquire({ ownerId: 'holder', resources: [capacityResource('tests')] });
  assert.equal(held.status, 'granted');
  const blocked = broker.tryAcquire({ ownerId: 'blocked',
    resources: [capacityResource('tests'), capacityResource('tool_operations', 2)] });

  assert.deepEqual(blocked, { status: 'waiting', reason: 'resource_capacity' });
  assert.equal(broker.snapshot().waiter_count, 0);
  assert.equal(broker.snapshot().lease_count, 1);
  assert.equal(broker.snapshot().capacity.tool_operations, 0);
  broker.release(held.lease, { producerSettled: true });
});

test('tryAcquire revalidates synchronously immediately before its atomic grant', () => {
  const broker = createBroker({ limits: { tool_operations: 1 } });
  let validations = 0;
  const stale = broker.tryAcquire({ ownerId: 'stale',
    resources: [capacityResource('tool_operations')], validate: () => {
      validations += 1;
      return false;
    } });
  assert.deepEqual(stale, { status: 'rejected', reason: 'resource_authority_stale' });
  assert.equal(validations, 1);
  assert.equal(broker.snapshot().lease_count, 0);
});

test('opted-in waits name the actually saturated resource without holding partial capacity', () => {
  const broker = createBroker({ limits: { native_processes: 1, tool_operations: 2 } });
  const held = broker.tryAcquire({ ownerId: 'holder', resources: [capacityResource('tool_operations', 2)] });
  const blocked = broker.tryAcquire({ ownerId: 'pending', includeWaitingResource: true,
    resources: [capacityResource('native_processes'), capacityResource('tool_operations')] });
  assert.deepEqual(blocked, { status: 'waiting', reason: 'resource_capacity',
    resource_class: 'tool_operations', dependency_id: null });
  assert.equal(broker.snapshot().capacity.native_processes, 0);
  broker.release(held.lease, { producerSettled: true });
  const root = broker.tryAcquire({ ownerId: 'root', resources: [filesystemResource(identity('/workspace', { directory: true }))] });
  assert.deepEqual(broker.tryAcquire({ ownerId: 'file', includeWaitingResource: true,
    resources: [filesystemResource(identity('/workspace/file.txt'))] }), {
    status: 'waiting', reason: 'resource_capacity', resource_class: 'filesystem', dependency_id: null,
  });
  broker.release(root.lease, { producerSettled: true });
});

test('lease record pressure does not invent a physical resource dependency', () => {
  const broker = createBroker({ maxLeases: 1 });
  broker.tryAcquire({ ownerId: 'holder', resources: [capacityResource('tests')] });
  assert.deepEqual(broker.tryAcquire({ ownerId: 'pending', includeWaitingResource: true,
    resources: [capacityResource('native_processes')] }), { status: 'waiting', reason: 'resource_capacity' });
});

test('broker accepts only identities minted by the canonical path resolver', async () => {
  const broker = createBroker();
  await assert.rejects(broker.acquire({
    ownerId: 'forged',
    resources: [filesystemResource(Object.freeze({
      type: 'filesystem', identity_key: 'filesystem:/forged:path-only',
      comparison_path: '/forged',
    }))],
  }), /identity is invalid/);
  assert.equal(broker.snapshot().lease_count, 0);
});

test('filesystem hierarchy excludes a directory and child but permits disjoint paths', async () => {
  const broker = createBroker();
  const directory = await broker.acquire({ ownerId: 'directory',
    resources: [filesystemResource(identity('/workspace', { directory: true }))] });
  let childSettled = false;
  const childPromise = broker.acquire({ ownerId: 'child',
    resources: [filesystemResource(identity('/workspace/src/a.js'))] })
    .then((lease) => { childSettled = true; return lease; });
  const disjoint = await broker.acquire({ ownerId: 'disjoint',
    resources: [filesystemResource(identity('/other/src/b.js'))] });

  assert.equal(childSettled, false);
  assert.equal(broker.snapshot().lease_count, 2);
  broker.release(directory, { producerSettled: true });
  const child = await childPromise;
  assert.equal(childSettled, true);
  broker.release(child, { producerSettled: true });
  broker.release(disjoint, { producerSettled: true });
});

test('cancellation removes a waiter without disturbing the active lease', async () => {
  const broker = createBroker({ limits: { tests: 1 } });
  const held = await broker.acquire({ ownerId: 'holder', resources: [capacityResource('tests')] });
  const controller = new AbortController();
  const pending = broker.acquire({ ownerId: 'cancelled', resources: [capacityResource('tests')],
    signal: controller.signal });
  controller.abort(new Error('stop waiting'));

  await assert.rejects(pending, /stop waiting/);
  assert.equal(broker.snapshot().waiter_count, 0);
  assert.equal(broker.snapshot().lease_count, 1);
  broker.release(held, { producerSettled: true });
});

test('cancelling an acquired producer quarantines rather than releasing capacity', async () => {
  const broker = createBroker({ limits: { tests: 1 } });
  const controller = new AbortController();
  const lease = await broker.acquire({ ownerId: 'active', resources: [capacityResource('tests')],
    signal: controller.signal });
  controller.abort(new Error('producer cancellation requested'));

  assert.equal(broker.snapshot().quarantined_count, 1);
  assert.equal(broker.snapshot().capacity.tests, 1);
  assert.equal(broker.confirmCleanup(lease), true);
});

test('backend-restart cleanup confirms every quarantined lease and drains waiters', async () => {
  const broker = createBroker({ limits: { tool_operations: 1 } });
  const abandoned = await broker.acquire({ ownerId: 'abandoned',
    resources: [capacityResource('tool_operations')] });
  assert.equal(broker.release(abandoned), false);
  const active = await broker.acquire({ ownerId: 'active', resources: [filesystemResource(identity('/live'))] });
  let nextSettled = false;
  const next = broker.acquire({ ownerId: 'next', resources: [capacityResource('tool_operations')] })
    .then((lease) => { nextSettled = true; return lease; });
  await nextTurn();
  assert.equal(nextSettled, false);

  assert.equal(broker.confirmQuarantinedCleanup(), 1);
  await nextTurn();
  assert.equal(nextSettled, true);
  assert.equal(broker.snapshot().quarantined_count, 0);
  assert.equal(broker.snapshot().lease_count, 2);
  assert.equal(broker.confirmQuarantinedCleanup(), 0);
  assert.equal(broker.confirmCleanup(abandoned), false);
  broker.release(active, { producerSettled: true });
  broker.release(await next, { producerSettled: true });
  assert.equal(broker.snapshot().lease_count, 0);
});

test('authority is revalidated after a wait and a failed check leaks no lease', async () => {
  const broker = createBroker();
  const resource = filesystemResource(identity('/workspace'));
  const held = await broker.acquire({ ownerId: 'holder', resources: [resource] });
  let validations = 0;
  const pending = broker.acquire({ ownerId: 'stale', resources: [resource], validate: () => {
    validations += 1;
    return false;
  } });
  broker.release(held, { producerSettled: true });

  await assert.rejects(pending, /authority changed/);
  assert.equal(validations, 1);
  assert.equal(broker.snapshot().lease_count, 0);
});

test('uncertain cleanup quarantines capacity until producer settlement is confirmed', async () => {
  const broker = createBroker({ limits: { tool_operations: 1 } });
  const held = await broker.acquire({ ownerId: 'producer',
    resources: [capacityResource('tool_operations')] });
  assert.equal(broker.release(held), false);
  assert.equal(broker.snapshot().quarantined_count, 1);
  let nextSettled = false;
  const nextPromise = broker.acquire({ ownerId: 'next',
    resources: [capacityResource('tool_operations')] })
    .then((lease) => { nextSettled = true; return lease; });
  await nextTurn();
  assert.equal(nextSettled, false);

  assert.equal(broker.confirmCleanup(held), true);
  const next = await nextPromise;
  broker.release(next, { producerSettled: true });
});

test('a released lease token cannot release a new producer after ID reuse', async () => {
  const broker = new ResourceBroker({
    limits: { tool_operations: 1 },
    createId: () => 'reused-id',
  });
  const first = await broker.acquire({ ownerId: 'first',
    resources: [capacityResource('tool_operations')] });
  assert.equal(broker.release(first, { producerSettled: true }), true);
  const second = await broker.acquire({ ownerId: 'second',
    resources: [capacityResource('tool_operations')] });

  assert.equal(broker.confirmCleanup(first), false);
  assert.equal(broker.snapshot().lease_count, 1);
  assert.equal(broker.confirmCleanup(second), true);
});

test('unknown command and test effects claim the workspace and trusted downstream capacity', () => {
  const resolved = [];
  const pathResolver = { resolve(value) {
    resolved.push(value);
    return identity(`/physical/${path.basename(value)}`, { directory: true });
  } };
  const unknownCommand = buildOperationResources({
    operationType: 'command', workspacePath: '/workspace', sandboxCommands: true, pathResolver,
  });
  const nativeCommand = buildOperationResources({
    operationType: 'command', workspacePath: '/workspace', pathResolver,
  });
  const knownTest = buildOperationResources({
    operationType: 'test', workspacePath: '/workspace', declaredPaths: ['/workspace/a.test.js'],
    effectsKnown: true, pathResolver,
  });
  const control = buildOperationResources({
    operationType: 'control', workspacePath: '/workspace', pathResolver,
  });

  assert.deepEqual(DEFAULT_RESOURCE_LIMITS, {
    tool_operations: 2, native_processes: 2, tests: 1, sandbox_commands: 1,
  });
  assert.deepEqual(resolved, ['/workspace', '/workspace', '/workspace/a.test.js']);
  assert.deepEqual(unknownCommand.filter((item) => item.type === 'capacity').map((item) => item.key),
    ['tool_operations', 'native_processes', 'sandbox_commands']);
  assert.equal(unknownCommand.at(-1).identity.comparison_path, '/physical/workspace');
  assert.deepEqual(nativeCommand.filter((item) => item.type === 'capacity').map((item) => item.key),
    ['tool_operations', 'native_processes']);
  assert.deepEqual(knownTest.filter((item) => item.type === 'capacity').map((item) => item.key),
    ['tool_operations', 'native_processes', 'tests']);
  assert.equal(knownTest.at(-1).identity.comparison_path, '/physical/a.test.js');
  assert.deepEqual(control, []);
});
