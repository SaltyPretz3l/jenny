const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const { SystemStatsMonitor } = require('../services/system-stats');

test('SystemStatsMonitor sample returns an isolated snapshot', () => {
  const monitor = new SystemStatsMonitor({
    powerMonitor: {
      isOnBatteryPower() {
        return true;
      },
    },
  });

  const first = monitor.sample();
  first.cpuPercent = 999;
  first.ramPercent = 999;
  first.battery = 'mutated';
  first.sampledAt = 'mutated';

  const next = monitor.getStats();
  assert.notEqual(next.cpuPercent, 999);
  assert.notEqual(next.ramPercent, 999);
  assert.equal(next.battery, 'Battery');
  assert.notEqual(next.sampledAt, 'mutated');
});

test('SystemStatsMonitor emits isolated stats payloads', () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let scheduledTick = null;

  global.setInterval = (callback) => {
    scheduledTick = callback;
    return {
      unref() {},
    };
  };
  global.clearInterval = () => {};

  try {
    const monitor = new SystemStatsMonitor({
      powerMonitor: {
        isOnBatteryPower() {
          return false;
        },
      },
    });
    monitor.on('stats', (payload) => {
      payload.battery = 'mutated';
      payload.cpuPercent = 999;
    });

    monitor.start();
    scheduledTick();

    const next = monitor.getStats();
    assert.equal(next.battery, 'AC');
    assert.notEqual(next.cpuPercent, 999);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

test('SystemStatsMonitor non-committing sample preserves the next committed CPU window', () => {
  const originalCpus = os.cpus;
  const monitor = new SystemStatsMonitor();
  monitor.previousCpu = { idle: 40, total: 100 };
  monitor.currentStats = { cpuPercent: 12.5, ramPercent: 20, battery: 'AC', sampledAt: 'prior' };
  let cpuTimes = { idle: 50, user: 70 };
  os.cpus = () => [{ times: cpuTimes }];

  try {
    const baselineBefore = { ...monitor.previousCpu };
    const statsBefore = { ...monitor.currentStats };
    const preview = monitor.sample({ advanceBaseline: false });
    assert.equal(preview.cpuPercent, 50);
    assert.deepEqual(monitor.previousCpu, baselineBefore);
    assert.deepEqual(monitor.currentStats, statsBefore);

    cpuTimes = { idle: 60, user: 100 };
    const committed = monitor.sample();
    assert.equal(committed.cpuPercent, 66.7);
  } finally {
    os.cpus = originalCpus;
  }
});

test('SystemStatsMonitor reuses the prior CPU percent for zero-delta samples', () => {
  const originalCpus = os.cpus;
  const monitor = new SystemStatsMonitor();
  monitor.previousCpu = { idle: 40, total: 100 };
  monitor.currentStats = { cpuPercent: 37.5, ramPercent: 20, battery: 'AC', sampledAt: 'prior' };
  os.cpus = () => [{ times: { idle: 40, user: 60 } }];

  try {
    assert.equal(monitor.sample({ advanceBaseline: false }).cpuPercent, 37.5);
    assert.equal(monitor.sample().cpuPercent, 37.5);
  } finally {
    os.cpus = originalCpus;
  }
});

test('SystemStatsMonitor getStats({ fresh: true }) reads live values without committing state', () => {
  const originalCpus = os.cpus;
  const originalTotalmem = os.totalmem;
  const originalFreemem = os.freemem;
  let onBattery = false;
  const monitor = new SystemStatsMonitor({
    powerMonitor: { isOnBatteryPower: () => onBattery },
  });
  monitor.previousCpu = { idle: 40, total: 100 };
  monitor.currentStats = { cpuPercent: 25, ramPercent: 30, battery: 'AC', sampledAt: 'prior' };
  os.cpus = () => [{ times: { idle: 50, user: 70 } }];
  os.totalmem = () => 100;
  os.freemem = () => 25;
  onBattery = true;

  try {
    const baselineBefore = { ...monitor.previousCpu };
    const statsBefore = { ...monitor.currentStats };
    const fresh = monitor.getStats({ fresh: true });
    assert.equal(fresh.cpuPercent, 50);
    assert.equal(fresh.ramPercent, 75);
    assert.equal(fresh.battery, 'Battery');
    assert.deepEqual(monitor.previousCpu, baselineBefore);
    assert.deepEqual(monitor.currentStats, statsBefore);
  } finally {
    os.cpus = originalCpus;
    os.totalmem = originalTotalmem;
    os.freemem = originalFreemem;
  }
});
