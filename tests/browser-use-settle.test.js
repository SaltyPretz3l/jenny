'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSettler } = require('../services/browser-use/settle');
const { createCallLog, createFakeWebContents, logNames } = require('./helpers/fake-web-contents-view');

function virtualClock(log) {
  const clock = {
    t: 0,
    sleeps: [],
    now: () => clock.t,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      if (log) log.push({ who: 'clock', name: 'sleep', args: [ms] });
      clock.t += ms;
    },
  };
  return clock;
}

// statuses: one entry per reader.call('status'); the last repeats. An Error
// entry is thrown, a function entry is invoked.
function scriptedReader(statuses, log) {
  let index = 0;
  return {
    calls: 0,
    async call(op) {
      if (log) log.push({ who: 'reader', name: op, args: [] });
      assert.equal(op, 'status');
      this.calls += 1;
      const entry = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      if (entry instanceof Error) throw entry;
      if (typeof entry === 'function') return entry();
      return { msSinceMutation: entry };
    },
  };
}

function build({ statuses, loading = false, log }) {
  const clock = virtualClock(log);
  const webContents = createFakeWebContents({ loading, log });
  const reader = scriptedReader(statuses, log);
  const settler = createSettler({ webContents, reader, sleep: clock.sleep, now: clock.now });
  return { clock, webContents, reader, settler };
}

test('waits 150 ms before the first look at the page', async () => {
  const log = createCallLog();
  const { settler, clock } = build({ statuses: [1000], log });
  const result = await settler.waitForSettle({ mode: 'action' });
  assert.deepEqual(result, { settled: true, reason: 'quiet' });
  assert.deepEqual(clock.sleeps, [150]);
  const names = logNames(log);
  assert.equal(names[0], 'clock.sleep');
  assert.ok(names.indexOf('reader.status') > 0);
});

test('polls every 120 ms until the page has been quiet for 350 ms', async () => {
  const { settler, clock } = build({ statuses: [0, 100, 349, 350] });
  const result = await settler.waitForSettle({ mode: 'action' });
  assert.deepEqual(result, { settled: true, reason: 'quiet' });
  assert.deepEqual(clock.sleeps, [150, 120, 120, 120]);
});

test('a loading page is not settled even when the DOM is quiet', async () => {
  const { settler, clock, webContents } = build({ statuses: [5000], loading: true });
  let polls = 0;
  const original = webContents.isLoading.bind(webContents);
  webContents.isLoading = () => {
    polls += 1;
    if (polls === 3) webContents.state.loading = false;
    return original();
  };
  const result = await settler.waitForSettle({ mode: 'navigation' });
  assert.deepEqual(result, { settled: true, reason: 'quiet' });
  assert.deepEqual(clock.sleeps, [150, 120, 120]);
});

test('action mode gives up after 3000 ms', async () => {
  const { settler, clock } = build({ statuses: [0] });
  const result = await settler.waitForSettle({ mode: 'action' });
  assert.deepEqual(result, { settled: false, reason: 'cap' });
  assert.equal(clock.t, 3000);
});

test('navigation mode gives up after 30000 ms', async () => {
  const { settler, clock } = build({ statuses: [0], loading: true });
  const result = await settler.waitForSettle({ mode: 'navigation' });
  assert.deepEqual(result, { settled: false, reason: 'cap' });
  assert.equal(clock.t, 30000);
});

test('a loaded page that never goes quiet costs 3 seconds, not the navigation cap', async () => {
  const { settler, clock } = build({ statuses: [0], loading: false });
  const result = await settler.waitForSettle({ mode: 'navigation' });
  assert.deepEqual(result, { settled: false, reason: 'cap' });
  assert.ok(clock.t <= 3200, String(clock.t));
});

test('a redirect restarts the quiet allowance while the navigation cap still holds', async () => {
  const { settler, clock, webContents } = build({ statuses: [0], loading: false });
  let polls = 0;
  const realIsLoading = webContents.isLoading;
  webContents.isLoading = () => {
    polls += 1;
    if (polls === 8) webContents.state.loading = true;
    if (polls === 14) webContents.state.loading = false;
    return realIsLoading();
  };
  await settler.waitForSettle({ mode: 'navigation' });
  assert.ok(clock.t > 3200, String(clock.t));
  assert.ok(clock.t < 30000, String(clock.t));
});

test('a reader failure counts as still loading, not as a failure', async () => {
  const { settler, reader } = build({
    statuses: [new Error('document replaced'), new Error('document replaced'), 900],
  });
  const result = await settler.waitForSettle({ mode: 'action' });
  assert.deepEqual(result, { settled: true, reason: 'quiet' });
  assert.equal(reader.calls, 3);
});

test('a reader that only ever fails ends at the cap', async () => {
  const { settler } = build({ statuses: [new Error('gone')] });
  const result = await settler.waitForSettle({ mode: 'action' });
  assert.deepEqual(result, { settled: false, reason: 'cap' });
});

test('an aborted signal rejects before any wait', async () => {
  const { settler, clock } = build({ statuses: [1000] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    settler.waitForSettle({ mode: 'action', signal: controller.signal }),
    { name: 'AbortError' }
  );
  assert.deepEqual(clock.sleeps, []);
});

test('abort during the wait rejects with AbortError', async () => {
  const controller = new AbortController();
  const clock = virtualClock();
  const settler = createSettler({
    webContents: createFakeWebContents(),
    reader: scriptedReader([0]),
    now: clock.now,
    sleep: async (ms) => {
      await clock.sleep(ms);
      if (clock.sleeps.length === 2) controller.abort();
    },
  });
  await assert.rejects(
    settler.waitForSettle({ mode: 'action', signal: controller.signal }),
    { name: 'AbortError' }
  );
  assert.equal(clock.sleeps.length, 2);
});

test('abort while the reader is still answering rejects with AbortError', async () => {
  const controller = new AbortController();
  const clock = virtualClock();
  const reader = { call: () => new Promise(() => {}) };
  const settler = createSettler({
    webContents: createFakeWebContents(),
    reader,
    now: clock.now,
    sleep: clock.sleep,
  });
  const pending = settler.waitForSettle({ mode: 'action', signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { name: 'AbortError' });
});

test('defaults to real timers', async () => {
  const webContents = createFakeWebContents();
  const reader = { call: async () => ({ msSinceMutation: 10_000 }) };
  const settler = createSettler({ webContents, reader });
  const started = Date.now();
  // The settler's own timers are unref'd, so hold the loop open for the test.
  const keepAlive = setTimeout(() => {}, 1000);
  const result = await settler.waitForSettle({ mode: 'action' });
  clearTimeout(keepAlive);
  assert.deepEqual(result, { settled: true, reason: 'quiet' });
  assert.ok(Date.now() - started >= 140);
});
