const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// Eleven main-process services subscribe to 'changed' at composition time
// (2026-09-15: calendar, links, scheduler, skills, tips, weather, spellcheck,
// backend wiring, remote wiring, runtime composition, reminder notifier). Node
// warns past its default cap of 10, so the service has to raise the cap with
// headroom for the next subscriber.
test('the changed-listener cap clears the main-process subscriber count without a warning', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-listeners-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  assert.ok(
    service.getMaxListeners() >= 16,
    `changed-listener cap ${service.getMaxListeners()} leaves no headroom above eleven subscribers`
  );

  const warnings = [];
  const onWarning = (warning) => warnings.push(String(warning?.name || ''));
  const listeners = Array.from({ length: 12 }, () => () => {});
  process.on('warning', onWarning);
  try {
    for (const listener of listeners) service.on('changed', listener);
    // process.emitWarning delivers on a later tick.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    for (const listener of listeners) service.removeListener('changed', listener);
    process.removeListener('warning', onWarning);
  }
  assert.deepEqual(warnings.filter((name) => name === 'MaxListenersExceededWarning'), []);
});
