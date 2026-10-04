'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { normalizeNotificationSettings } = require('../services/shell-config-notifications-schema');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createService(label) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-shell-config-${label}-`));
  trackDirectory(userDataPath);
  return { userDataPath, service: new ShellConfigService({ userDataPath }) };
}

test('a fresh service exposes the default notifications block under windowUi', () => {
  const { service } = createService('notify-defaults');
  assert.deepEqual(service.getWindowUiState(), {
    appZoomPercent: 110,
    notifications: normalizeNotificationSettings(),
  });
});

test('a partial notifications patch is filled from defaults and persists beside app zoom', () => {
  const { userDataPath, service } = createService('notify-patch');
  service.updateWindowUiSettings({ appZoomPercent: 125 });
  const updated = service.updateWindowUiSettings({
    notifications: { sound: false, categories: { failures: false }, bogus: true },
  });
  const expected = {
    appZoomPercent: 125,
    notifications: normalizeNotificationSettings({ sound: false, categories: { failures: false } }),
  };
  assert.deepEqual(updated, expected);
  assert.deepEqual(service.getWindowUiState(), expected);

  // The whole nested object is replaced by the shallow merge: a later patch
  // that omits sound resolves it from defaults again, never from the old value.
  service.updateWindowUiSettings({ notifications: { enabled: false } });
  assert.deepEqual(
    service.getWindowUiState().notifications,
    normalizeNotificationSettings({ enabled: false })
  );

  const reloaded = new ShellConfigService({ userDataPath });
  assert.deepEqual(reloaded.getWindowUiState(), {
    appZoomPercent: 125,
    notifications: normalizeNotificationSettings({ enabled: false }),
  });
});

test('getWindowUiState hands out a copy that cannot mutate stored state', () => {
  const { service } = createService('notify-copy');
  const snapshot = service.getWindowUiState();
  snapshot.notifications.categories.replies = false;
  snapshot.notifications.enabled = false;
  assert.equal(service.getWindowUiState().notifications.categories.replies, true);
  assert.equal(service.getWindowUiState().notifications.enabled, true);
});

test('a junk notifications patch normalizes to defaults instead of throwing', () => {
  const { service } = createService('notify-junk');
  for (const junk of [null, 'on', 42, [], { categories: 'all' }]) {
    service.updateWindowUiSettings({ notifications: junk });
    assert.deepEqual(service.getWindowUiState().notifications, normalizeNotificationSettings());
  }
});
