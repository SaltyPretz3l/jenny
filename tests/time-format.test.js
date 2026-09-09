const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ShellConfigService } = require('../services/shell-config-service');
const { normalizeState, serializeState } = require('../services/shell-config-state');
const { createI18n } = require('../renderer/shared/i18n-utils');
const clock = require('../renderer/features/renderer-dashboard-widgets-core');
const { formatArtifactTimestamp } = require('../renderer/features/renderer-artifacts-projection');
const { JSDOM } = require('jsdom');
const timeField = require('../renderer/inventory/time-field');

test('time preference defaults off, validates strictly, and persists across reloads', (t) => {
  for (const value of [undefined, false, 'true', 1, {}, null]) {
    assert.equal(normalizeState({ use24HourTime: value }).use24HourTime, false);
  }
  assert.equal(serializeState(normalizeState({ version: 52, use24HourTime: true })).use24HourTime, true);
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-time-format-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const service = new ShellConfigService({ userDataPath });
  assert.equal(service.getChatUiState().use24HourTime, false);
  const reasons = [];
  service.on('changed', (_snapshot, meta) => reasons.push(meta.reason));
  service.updateChatUiSettings({ use24HourTime: true });
  service.updateChatUiSettings({ use24HourTime: true });
  assert.deepEqual(reasons, ['time_format_updated']);
  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getChatUiState().use24HourTime, true);
  reloaded.updateChatUiSettings({ use24HourTime: false });
  assert.equal(new ShellConfigService({ userDataPath }).getChatUiState().use24HourTime, false);
});

test('clock, calendar and localized timestamps use 00–23 hours and revert live', (t) => {
  const previous = global.jennyI18n;
  const i18n = createI18n();
  global.jennyI18n = i18n;
  t.after(() => { global.jennyI18n = previous; });
  const midnight = new Date(2026, 8, 8, 0, 0);
  const afternoon = new Date(2026, 8, 8, 13, 5);
  assert.equal(clock.formatClockTime(afternoon), '1:05 PM');
  i18n.setTimeFormat(true);
  assert.equal(clock.formatClockTime(midnight), '00:00');
  assert.equal(clock.formatTimeShort(midnight), '00:00');
  assert.equal(clock.formatClockTime(afternoon), '13:05');
  assert.equal(clock.formatTimeShort(new Date(2026, 8, 8, 12)), '12:00');
  assert.match(formatArtifactTimestamp(afternoon.toISOString()), /13:05/);
  assert.match(formatArtifactTimestamp(midnight.toISOString()), /00:00/);
  for (const locale of ['en-US', 'en-GB', 'de-DE']) {
    assert.equal(midnight.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...i18n.timeOptions() }), '00:00');
  }
  i18n.setTimeFormat(false);
  assert.equal(clock.formatTimeShort(midnight), '12 AM');
  assert.deepEqual(i18n.timeOptions(), {});
});

test('24-hour time entry shows HH:MM independently of the OS and rejects invalid hours', (t) => {
  const previous = global.jennyI18n;
  const i18n = createI18n();
  global.jennyI18n = i18n;
  t.after(() => { global.jennyI18n = previous; });
  i18n.setTimeFormat(true);
  const dom = new JSDOM(timeField({ id: 'start', label: 'Start', value: '13:05' }));
  t.after(() => dom.window.close());
  const input = dom.window.document.querySelector('input');
  assert.equal(input.type, 'text');
  assert.equal(input.value, '13:05');
  assert.equal(input.checkValidity(), true);
  for (const invalid of ['24:00', '13:60', '1 PM']) {
    input.value = invalid;
    assert.equal(input.checkValidity(), false);
  }
  input.value = '00:00';
  assert.equal(input.checkValidity(), true);
  i18n.setTimeFormat(false);
  assert.match(timeField({ value: '13:05' }), /type="time"/);
});
