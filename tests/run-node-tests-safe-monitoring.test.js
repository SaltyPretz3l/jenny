'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const monitor = require('../scripts/run-node-tests-monitor');

test('safe runner heartbeat names every in-flight file with its elapsed time', () => {
  const heartbeat = monitor.formatInFlightHeartbeat({
    inFlightStartedAt: new Map([
      ['tests/slow-a.test.js', 1_000],
      ['tests/slow-b.test.js', 4_000],
    ]),
    completed: 7,
    startedAt: 0,
    now: 16_000,
  });

  assert.match(heartbeat, /HEARTBEAT elapsed=16\.0s completed=7/);
  assert.match(heartbeat, /tests\/slow-a\.test\.js \(15\.0s\)/);
  assert.match(heartbeat, /tests\/slow-b\.test\.js \(12\.0s\)/);
});
