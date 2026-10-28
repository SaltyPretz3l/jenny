'use strict';

// Window-state writes (services/window-state-writer.js) through the service:
// unchanged states are skipped, async writes run one at a time, a synchronous
// close write wins, and a burst of moves keeps one debounce timer.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WINDOW_STATE_FILENAME,
  WINDOW_STATE_VERSION,
  WindowStateService,
} = require('../services/window-state-service');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const {
  FakeWindow,
  createScreen,
  createTimers,
  readState,
  tempUserData,
  writeState,
} = require('./helpers/window-state-fixtures');

test.afterEach(async () => cleanupTrackedResources());

function savedEvents(logs) {
  return logs.filter((entry) => entry.event === 'window.state_saved');
}

// Holds every fs.promises.writeFile until the test releases it, recording how
// many writes were in flight at once. Restored by the returned dispose().
function gateAsyncWrites() {
  const original = fs.promises.writeFile;
  const pending = [];
  let inFlight = 0;
  let maxInFlight = 0;
  fs.promises.writeFile = (...args) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve, reject) => {
      pending.push(() => original(...args).then(resolve, reject).finally(() => {
        inFlight -= 1;
      }));
    });
  };
  return {
    pendingCount: () => pending.length,
    maxInFlight: () => maxInFlight,
    async releaseNext() {
      const release = pending.shift();
      assert.ok(release, 'expected a gated async write');
      await release();
    },
    async waitForPending(count = 1) {
      // Bounded by time, not turns: the write reaches the gate after threadpool fs
      // work, which a loaded machine can delay past any fixed number of turns.
      const deadline = Date.now() + 5000;
      while (pending.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(pending.length, count, `expected ${count} gated async write(s)`);
    },
    dispose() {
      fs.promises.writeFile = original;
    },
  };
}

function tempFilesIn(userDataPath) {
  return fs.readdirSync(userDataPath).filter((name) => name.endsWith('.tmp'));
}

test('skips the write when bounds, maximized state and display are unchanged', async () => {
  const userDataPath = tempUserData();
  writeState(userDataPath, {
    version: WINDOW_STATE_VERSION,
    normalBounds: { x: 44, y: 55, width: 1280, height: 760 },
    isMaximized: false,
    displayId: 1,
    updatedAt: '2026-05-23T12:00:00.000Z',
  });
  const logs = [];
  const service = new WindowStateService({
    userDataPath,
    screen: createScreen(),
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  const windowRef = new FakeWindow({ x: 44, y: 55, width: 1280, height: 760 });

  // Identical to the persisted state: neither the sync nor the async path writes.
  assert.equal(service.flush(windowRef), true);
  assert.equal(savedEvents(logs).length, 0);
  assert.equal(await service.flushAsync(windowRef), true);
  assert.equal(savedEvents(logs).length, 0);
  assert.equal(readState(userDataPath).updatedAt, '2026-05-23T12:00:00.000Z');

  windowRef.setBounds({ x: 60 });
  assert.equal(service.flush(windowRef), true);
  assert.equal(service.flush(windowRef), true);
  windowRef.maximize();
  assert.equal(await service.flushAsync(windowRef), true);
  assert.equal(await service.flushAsync(windowRef), true);
  assert.equal(savedEvents(logs).length, 2, 'one write per real change, none for repeats');
  assert.equal(readState(userDataPath).isMaximized, true);
});

test('maximize writes asynchronously, one at a time, dropping superseded states', async () => {
  const userDataPath = tempUserData();
  const logs = [];
  const service = new WindowStateService({
    userDataPath,
    screen: createScreen(),
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  const windowRef = new FakeWindow({ x: 10, y: 20, width: 1300, height: 800 });
  service.attach(windowRef);
  const gate = gateAsyncWrites();
  try {
    windowRef.maximize();
    assert.equal(fs.existsSync(path.join(userDataPath, WINDOW_STATE_FILENAME)), false, 'maximize must not write synchronously');
    await gate.waitForPending(1);

    // Two more changes while the first write is in flight: only the newest survives.
    windowRef.unmaximize();
    windowRef._normalBounds = { x: 30, y: 40, width: 1200, height: 700 };
    windowRef.maximize();
    for (let spin = 0; spin < 20; spin += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(gate.pendingCount(), 1, 'a second write must wait for the first');

    await gate.releaseNext();
    await gate.waitForPending(1);
    await gate.releaseNext();
    await service.whenWritesSettled();

    assert.equal(gate.maxInFlight(), 1);
    assert.equal(savedEvents(logs).length, 2, 'the superseded unmaximize state is never written');
    assert.deepEqual(readState(userDataPath).normalBounds, { x: 30, y: 40, width: 1200, height: 700 });
    assert.equal(readState(userDataPath).isMaximized, true);
    assert.deepEqual(tempFilesIn(userDataPath), []);
  } finally {
    gate.dispose();
  }
});

test('a synchronous close write wins over an in-flight async write', async () => {
  const userDataPath = tempUserData();
  const service = new WindowStateService({ userDataPath, screen: createScreen() });
  const windowRef = new FakeWindow({ x: 10, y: 20, width: 1300, height: 800 });
  service.attach(windowRef);
  const gate = gateAsyncWrites();
  try {
    windowRef.maximize();
    await gate.waitForPending(1);

    windowRef.unmaximize();
    windowRef.setBounds({ x: 70, y: 80 });
    windowRef.close();
    assert.equal(readState(userDataPath).isMaximized, false, 'close writes synchronously');

    await gate.releaseNext();
    await service.whenWritesSettled();
    assert.equal(readState(userDataPath).isMaximized, false, 'the older async state must not land after close');
    assert.deepEqual(readState(userDataPath).normalBounds, { x: 70, y: 80, width: 1300, height: 800 });
    assert.deepEqual(tempFilesIn(userDataPath), []);
  } finally {
    gate.dispose();
  }
});

test('a burst of moves reuses one debounce timer and saves once after it settles', async () => {
  const userDataPath = tempUserData();
  const timers = createTimers();
  let setTimeoutCalls = 0;
  let nowMs = Date.parse('2026-05-23T12:00:00.000Z');
  const logs = [];
  const service = new WindowStateService({
    userDataPath,
    screen: createScreen(),
    setTimeoutImpl: (callback, ms) => {
      setTimeoutCalls += 1;
      return timers.setTimeout(callback, ms);
    },
    clearTimeoutImpl: timers.clearTimeout,
    nowProvider: () => new Date(nowMs),
    saveDebounceMs: 500,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  const windowRef = new FakeWindow({ x: 44, y: 55, width: 1280, height: 760 });
  service.attach(windowRef);

  for (let step = 0; step < 5; step += 1) {
    windowRef.setBounds({ x: 44 + step });
    windowRef.emit('move');
    nowMs += 100;
  }
  assert.equal(setTimeoutCalls, 1, 'events during the burst only push the deadline');

  // Fires early (the last move was 100 ms ago): re-arms once for the remainder.
  timers.runAll();
  assert.equal(setTimeoutCalls, 2);
  assert.equal(savedEvents(logs).length, 0);

  nowMs += 500;
  timers.runAll();
  await service.whenWritesSettled();
  assert.equal(timers.count(), 0);
  assert.equal(savedEvents(logs).length, 1);
  assert.equal(readState(userDataPath).normalBounds.x, 48);
});
