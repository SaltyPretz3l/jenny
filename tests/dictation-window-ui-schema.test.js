'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_DICTATION_SETTINGS, MAX_DEVICE_ID_LENGTH, normalizeDictationSettings,
} = require('../services/shell-config-dictation-schema');
const { ShellConfigService } = require('../services/shell-config-service');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

test('the default is the system microphone and the defaults are frozen', () => {
  assert.deepEqual(normalizeDictationSettings(), { deviceId: '' });
  assert.deepEqual(DEFAULT_DICTATION_SETTINGS, { deviceId: '' });
  assert.ok(Object.isFrozen(DEFAULT_DICTATION_SETTINGS));
});

test('deviceId is trimmed, capped at 256 characters and non-strings fall back to empty', () => {
  assert.equal(normalizeDictationSettings({ deviceId: '  abc123  ' }).deviceId, 'abc123');
  assert.equal(normalizeDictationSettings({ deviceId: 'x'.repeat(MAX_DEVICE_ID_LENGTH) }).deviceId.length, 256);
  assert.equal(normalizeDictationSettings({ deviceId: 'x'.repeat(257) }).deviceId, '');
  for (const bad of [null, 7, true, {}, [], ['a']]) {
    assert.deepEqual(normalizeDictationSettings({ deviceId: bad }), { deviceId: '' });
  }
  for (const bad of [null, undefined, 'abc', 5, [], [{ deviceId: 'a' }]]) {
    assert.deepEqual(normalizeDictationSettings(bad), { deviceId: '' });
  }
});

test('the normalizer is idempotent, drops unknown fields and ignores inherited ones', () => {
  const once = normalizeDictationSettings({ deviceId: ' mic ', extra: 1 });
  assert.deepEqual(once, { deviceId: 'mic' });
  assert.deepEqual(normalizeDictationSettings(once), once);
  assert.deepEqual(normalizeDictationSettings(Object.create({ deviceId: 'inherited' })), { deviceId: '' });
});

test('windowUi.dictation persists through the shell config service beside the other window settings', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-dictation-ui-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath });
  assert.deepEqual(service.getWindowUiState().dictation, { deviceId: '' });
  const updated = service.updateWindowUiSettings({ dictation: { deviceId: '  usb-mic  ', bogus: true } });
  assert.deepEqual(updated.dictation, { deviceId: 'usb-mic' });
  // A patch that omits dictation keeps it; the nested object is otherwise replaced whole.
  service.updateWindowUiSettings({ appZoomPercent: 120 });
  assert.deepEqual(service.getWindowUiState().dictation, { deviceId: 'usb-mic' });
  service.updateWindowUiSettings({ dictation: {} });
  assert.deepEqual(service.getWindowUiState().dictation, { deviceId: '' });
  service.updateWindowUiSettings({ dictation: { deviceId: 'reloaded' } });
  const reloaded = new ShellConfigService({ userDataPath });
  assert.deepEqual(reloaded.getWindowUiState().dictation, { deviceId: 'reloaded' });
});
