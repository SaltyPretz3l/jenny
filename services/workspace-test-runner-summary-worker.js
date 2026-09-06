'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { parseSummary } = require('./workspace-test-runner-summary');

if (parentPort) {
  const payload = workerData && typeof workerData === 'object' ? workerData : {};
  parentPort.postMessage(parseSummary(payload.stdoutTail, payload.summaryRegex));
}
