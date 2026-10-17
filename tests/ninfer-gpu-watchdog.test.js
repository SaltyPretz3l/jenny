'use strict';

// Opt-in GPU watchdog (row 54 Step 6b): trips only on three consecutive
// breaches of the user's thresholds, a good sample resets the count, it stops
// itself after one trip, and it never samples while disabled or stopped.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createNinferGpuWatchdog,
  createNvidiaSmiSampler,
  parseGpuSample,
  sampleBreaches,
} = require('../services/ninfer-gpu-watchdog');

function makeWatchdog({ settings = { enabled: true, maxWatts: 460, maxTempC: 83 }, samples = [] } = {}) {
  const trips = [];
  const sampled = [];
  const timers = [];
  const watchdog = createNinferGpuWatchdog({
    getSettings: () => settings,
    sample: async () => { const next = samples.shift(); sampled.push(next); return next ?? null; },
    onTrip: (trip) => trips.push(trip),
    setTimeoutImpl: (fn) => { timers.push(fn); return { unref() {} }; },
    clearTimeoutImpl: () => { timers.length = 0; },
  });
  return { watchdog, trips, sampled, timers };
}

test('parseGpuSample reads the first csv line and rejects garbage', () => {
  assert.deepEqual(parseGpuSample('123.45, 61\n'), { watts: 123.45, tempC: 61 });
  assert.deepEqual(parseGpuSample('\n 470.0 , 85 \n 30, 40'), { watts: 470, tempC: 85 });
  assert.equal(parseGpuSample('N/A, N/A'), null);
  assert.equal(parseGpuSample(''), null);
});

test('a breach is above the watt limit or at/above the temperature limit', () => {
  const settings = { maxWatts: 460, maxTempC: 83 };
  assert.equal(sampleBreaches({ watts: 460, tempC: 60 }, settings), false);
  assert.equal(sampleBreaches({ watts: 460.5, tempC: 60 }, settings), true);
  assert.equal(sampleBreaches({ watts: 300, tempC: 83 }, settings), true);
  assert.equal(sampleBreaches(null, settings), false);
});

test('three consecutive breaches trip once; a good sample resets the count', async () => {
  const { watchdog, trips, timers } = makeWatchdog({ samples: [
    { watts: 470, tempC: 60 }, { watts: 480, tempC: 60 }, { watts: 300, tempC: 60 },
    { watts: 470, tempC: 60 }, { watts: 470, tempC: 60 }, { watts: 465, tempC: 61 }, { watts: 999, tempC: 99 },
  ] });
  watchdog.start();
  assert.equal(watchdog.isRunning(), true);
  assert.equal((await watchdog.tick()).breaches, 1);
  assert.equal((await watchdog.tick()).breaches, 2);
  assert.equal((await watchdog.tick()).breaches, 0);
  assert.equal((await watchdog.tick()).breaches, 1);
  assert.equal((await watchdog.tick()).breaches, 2);
  const tripped = await watchdog.tick();
  assert.equal(tripped.tripped, true);
  assert.deepEqual(trips, [{ watts: 465, tempC: 61, maxWatts: 460, maxTempC: 83, strikes: 3 }]);
  assert.equal(watchdog.isRunning(), false);
  // Stopped: a further tick samples nothing and never trips again.
  assert.deepEqual(await watchdog.tick(), { sampled: false });
  assert.equal(trips.length, 1);
  assert.equal(timers.length, 0);
});

test('disabled settings sample nothing and reset the strike count; thresholds are read per sample', async () => {
  const settings = { enabled: false, maxWatts: 460, maxTempC: 83 };
  const { watchdog, sampled, trips } = makeWatchdog({ settings, samples: [
    { watts: 470, tempC: 60 }, { watts: 470, tempC: 60 }, { watts: 470, tempC: 60 }, { watts: 470, tempC: 60 },
  ] });
  watchdog.start();
  assert.deepEqual(await watchdog.tick(), { sampled: false });
  assert.deepEqual(sampled, []);
  settings.enabled = true;
  assert.equal((await watchdog.tick()).breaches, 1);
  assert.equal((await watchdog.tick()).breaches, 2);
  settings.enabled = false;
  assert.deepEqual(await watchdog.tick(), { sampled: false });
  settings.enabled = true;
  settings.maxWatts = 500;
  // A card limited higher: the same reading no longer breaches.
  assert.equal((await watchdog.tick()).breaches, 0);
  assert.deepEqual(trips, []);
});

test('an unreadable sample keeps the count and a temperature breach counts like a power one', async () => {
  const { watchdog, trips } = makeWatchdog({ samples: [
    { watts: 300, tempC: 84 }, null, { watts: 300, tempC: 90 }, { watts: 300, tempC: 83 },
  ] });
  watchdog.start();
  assert.equal((await watchdog.tick()).breaches, 1);
  assert.equal((await watchdog.tick()).breaches, 1);
  assert.equal((await watchdog.tick()).breaches, 2);
  assert.equal((await watchdog.tick()).tripped, true);
  assert.equal(trips[0].tempC, 83);
});

test('the nvidia-smi sampler queries power and temperature with a sanitized spawn and never throws', async () => {
  const calls = [];
  const sampler = createNvidiaSmiSampler({
    gpuIndex: 1,
    execFile: (file, args, options, callback) => { calls.push({ file, args, options }); callback(null, '412.3, 71\n'); },
  });
  assert.deepEqual(await sampler(), { watts: 412.3, tempC: 71 });
  assert.equal(calls[0].file, 'nvidia-smi');
  assert.deepEqual(calls[0].args, ['--query-gpu=power.draw,temperature.gpu', '--format=csv,noheader,nounits', '--id=1']);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(Object.getPrototypeOf(calls[0].options.env), null);
  const failing = createNvidiaSmiSampler({ execFile: (_file, _args, _options, callback) => callback(new Error('missing'), '') });
  assert.equal(await failing(), null);
  const throwing = createNvidiaSmiSampler({ execFile: () => { throw new Error('spawn'); } });
  assert.equal(await throwing(), null);
});
