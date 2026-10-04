'use strict';

// ELC-04 / ELC-10 / ELC-11: start/stop serialization and the orphan sweep.
// Every process seam is injected; nothing real is spawned or signalled.
const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { OllamaProcessManager } = require('../services/backend/ollama-process-manager');
const { createDeferred } = require('./helpers/deferred');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('until() timed out');
    await sleep(2);
  }
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
  }
}

function memoryStore() {
  let value = null;
  return {
    read: () => value,
    write: (next) => { value = next; },
    delete: () => { value = null; },
  };
}

// A manager whose process world is a set of live pids. `ready` drives the
// health probe; the command resolves instantly unless a test replaces it.
function makeHarness({ platform = 'linux', firstPid = 900001, ...overrides } = {}) {
  const world = {
    alive: new Set(),
    spawned: [],
    children: [],
    kills: [],
    store: memoryStore(),
    ready: false,
    // A probe only reports ready for a child spawned after this many spawns.
    baseline: 0,
  };
  let nextPid = firstPid;
  const killPid = (pid) => { world.kills.push(pid); world.alive.delete(pid); };
  const manager = new OllamaProcessManager({
    platform,
    stateStore: world.store,
    detectTrayConflictImpl: () => null,
    clearOwnedOllamaStateImpl: () => {},
    listLocalOllamaProcessesImpl: () => [],
    spawnImpl: () => {
      const child = new FakeChild(nextPid);
      nextPid += 1;
      world.spawned.push(child.pid);
      world.children.push(child);
      world.alive.add(child.pid);
      return child;
    },
    isProcessAliveImpl: (pid) => world.alive.has(pid),
    killProcessTreeImpl: async (pid) => { killPid(pid); },
    waitForProcessExitImpl: async () => true,
    forceKillAnyRemainingLocalOllamaSyncImpl: ({ ownedPids = [] } = {}) => {
      ownedPids.forEach(killPid);
      return { discoveredPids: [...ownedPids], killedPids: [...ownedPids] };
    },
    getProcessCommandLineSyncImpl: (pid) => (world.alive.has(pid) ? 'ollama serve' : ''),
    ...overrides,
  });
  manager._resolveCommand = async () => 'ollama';
  manager._isRunning = async () => world.ready && world.spawned.length > world.baseline;
  return { manager, world };
}

test('concurrent start() calls coalesce: one spawn, nobody is killed, both callers get the same result', async () => {
  const { manager, world } = makeHarness();
  const first = manager.start();
  await until(() => world.spawned.length === 1);
  const second = manager.start();
  world.ready = true;
  const [resultA, resultB] = await Promise.all([first, second]);
  assert.deepEqual(world.spawned, [900001]);
  assert.deepEqual(world.kills, []);
  assert.deepEqual(resultA, { started: true, external: false });
  assert.deepEqual(resultB, resultA);
  assert.equal(second, first, 'a start during a flight of the same generation must reuse it');
  await manager.stop();
  assert.deepEqual(world.kills, [900001]);
});

test('start() after stop() is a new generation: not coalesced onto the cancelled flight, and it spawns', async () => {
  const { manager, world } = makeHarness();
  const gate = createDeferred();
  let resolveCalls = 0;
  manager._resolveCommand = async () => {
    resolveCalls += 1;
    if (resolveCalls === 1) await gate.promise;
    return 'ollama';
  };
  manager._isRunning = async () => world.spawned.length > 0;

  const cancelled = manager.start();
  await until(() => resolveCalls === 1);
  const stopped = manager.stop();
  const fresh = manager.start();
  assert.notEqual(fresh, cancelled);
  gate.resolve();

  assert.deepEqual(await cancelled, { started: false, external: false, cancelled: true });
  await stopped;
  assert.deepEqual(await fresh, { started: true, external: false });
  assert.deepEqual(world.spawned, [900001]);
});

for (const stage of ['health_probe', 'tray_check', 'resolve_command']) {
  test(`stop() issued while start() awaits ${stage} returns only after the start gave up, and nothing spawns`, async () => {
    const gate = createDeferred();
    const entered = createDeferred();
    const overrides = {};
    if (stage === 'tray_check') {
      overrides.detectTrayConflictImpl = async () => { entered.resolve(); await gate.promise; return null; };
    }
    const { manager, world } = makeHarness(overrides);
    if (stage === 'health_probe') {
      manager._isRunning = async () => { entered.resolve(); await gate.promise; return false; };
    } else if (stage === 'resolve_command') {
      manager._resolveCommand = async () => { entered.resolve(); await gate.promise; return 'ollama'; };
    }
    const events = [];
    const origSpawn = manager._spawn;
    manager._spawn = (...args) => { events.push('spawn'); return origSpawn(...args); };

    const pending = manager.start();
    await entered.promise;
    await sleep(10); // let the flight reach the awaited step before stopping
    const stopped = manager.stop({ scope: 'any_local' }).then(() => events.push('stop_returned'));
    await sleep(20);
    assert.deepEqual(events, [], 'stop() must wait for the pending start');
    gate.resolve();
    const [result] = await Promise.all([pending, stopped]);
    assert.deepEqual(result, { started: false, external: false, cancelled: true });
    assert.deepEqual(events, ['stop_returned']);
    assert.deepEqual(world.spawned, []);
    assert.equal(world.store.read(), null);
  });
}

test('stop() during the readiness wait cancels polling and cleans up that attempt\'s child', async () => {
  const { manager, world } = makeHarness();
  let polls = 0;
  manager._isRunning = async () => { polls += 1; return false; };
  const pending = manager.start();
  await until(() => world.spawned.length === 1 && polls >= 1);
  assert.notEqual(world.store.read(), null);

  await manager.stop();
  const result = await pending;
  assert.deepEqual(result, { started: false, external: false, cancelled: true });
  assert.deepEqual(world.kills, [900001]);
  assert.equal(world.store.read(), null);
  const pollsAtStop = polls;
  await sleep(400);
  assert.equal(polls, pollsAtStop, 'readiness polling must stop once cancelled');
});

test('a failed attempt cleans up its own pid and leaves a newer tracked child alone', async () => {
  const { manager, world } = makeHarness();
  world.alive.add(900001);
  world.alive.add(900002);
  const newer = new FakeChild(900002);
  manager._process = newer;
  manager._ownedProcess = true;
  manager._ownedPid = 900002;
  world.store.write({ pid: 900002, command: 'ollama', startedAt: '', app_owned: true });

  await manager._cleanupFailedStartup('startup_timeout', 900001);

  assert.deepEqual(world.kills, [900001]);
  assert.equal(manager._process, newer);
  assert.equal(manager._ownedPid, 900002);
  assert.equal(world.store.read().pid, 900002, 'the newer child\'s owned-state record survives');
});

for (const event of ['exit', 'error']) {
  test(`a late ${event} from an older child does not clobber the newer child's ownership`, async () => {
    const { manager, world } = makeHarness();
    world.ready = true;
    const older = manager.start();
    await older;
    // A later start supersedes the stale owned child and spawns its own.
    world.baseline = 1;
    await manager.start();
    assert.deepEqual(world.spawned, [900001, 900002]);
    assert.equal(world.store.read().pid, 900002);

    world.children[0].emit(event, event === 'error' ? new Error('late') : 0, null);

    assert.equal(world.store.read().pid, 900002, 'owned-state record belongs to the newer child');
    assert.equal(manager.mightHaveLocalOllamaResidue(), true);
    await manager.stop();
    assert.ok(world.kills.includes(900002));
  });
}

for (const platform of ['win32', 'linux']) {
  test(`${platform}: stop sweeps children of the owned root but never a foreign orphan`, async () => {
    const ROOT = 990100;
    const SNAPSHOT_CHILD = 990101;
    const LATE_CHILD = 990102;
    const FOREIGN = 990200;
    const DEAD_PARENT = 999999;
    const foreignParent = platform === 'win32' ? DEAD_PARENT : 1;
    let listCalls = 0;
    const { manager, world } = makeHarness({
      platform,
      firstPid: ROOT,
      listLocalOllamaProcessesImpl: () => {
        listCalls += 1;
        if (listCalls === 1) {
          return [
            { pid: ROOT, parentPid: 1 },
            { pid: SNAPSHOT_CHILD, parentPid: ROOT },
            { pid: FOREIGN, parentPid: foreignParent },
          ];
        }
        // After the root died: the snapshot child was reparented, another
        // child is still attached, and the foreign process is unchanged.
        return [
          { pid: SNAPSHOT_CHILD, parentPid: foreignParent },
          { pid: LATE_CHILD, parentPid: ROOT },
          { pid: FOREIGN, parentPid: foreignParent },
        ];
      },
      getProcessCommandLineSyncImpl: (pid) => (pid === ROOT ? 'ollama serve' : 'ollama runner --port 4001'),
    });
    world.ready = true;
    await manager.start();
    assert.deepEqual(world.spawned, [ROOT]);
    world.kills.length = 0;
    world.alive.add(FOREIGN);

    await manager.stop();

    assert.deepEqual(world.kills.slice().sort(), [ROOT, SNAPSHOT_CHILD, LATE_CHILD].sort());
    assert.ok(!world.kills.includes(FOREIGN), 'a foreign orphan must never be killed');
  });
}

test('a start() after the flight finished keeps the healthy owned daemon instead of killing it as stale', async () => {
  const { manager, world } = makeHarness();
  world.ready = true;
  assert.deepEqual(await manager.start(), { started: true, external: false });

  // e.g. an ensureRunning() whose own probe answered before the daemon was up.
  const again = await manager.start();

  assert.deepEqual(again, { started: false, external: false, ready: true });
  assert.deepEqual(world.kills, [], 'the daemon serving the first caller was killed');
  assert.deepEqual(world.spawned, [900001]);
  await manager.stop();
  assert.deepEqual(world.kills, [900001], 'it is still owned and still stopped on stop()');
});

test('a start() that finds its own child alive but not answering replaces it', async () => {
  const { manager, world } = makeHarness();
  world.ready = true;
  await manager.start();
  world.baseline = 1; // the first child stops answering; only a new one would

  const again = await manager.start();

  assert.deepEqual(again, { started: true, external: false });
  assert.deepEqual(world.kills, [900001]);
  assert.deepEqual(world.spawned, [900001, 900002]);
  await manager.stop();
});
