'use strict';

// updateChatUiSettings lands a whole patch as ONE shell-config write: the
// file store rewrites the full file synchronously, so a multi-field patch
// must not fan out into one write (and one `changed` event) per field.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ShellConfigService } = require('../services/shell-config-service');

function createService(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-chat-ui-commit-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const service = new ShellConfigService({ userDataPath, env: {} });
  const writes = [];
  const write = service.store.write.bind(service.store);
  service.store.write = (value) => {
    writes.push(value);
    return write(value);
  };
  const events = [];
  service.on('changed', (_state, context) => events.push(context));
  return { service, userDataPath, writes, events };
}

test('a multi-field chat UI patch commits once with every sub-reason', (t) => {
  const { service, userDataPath, writes, events } = createService(t);

  const next = service.updateChatUiSettings({ safetyMode: 'paranoid', autoApproveStreakCap: 3 });

  assert.equal(writes.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'chat_ui_settings_updated');
  assert.deepEqual(events[0].reasons, ['safety_mode_updated', 'auto_approve_streak_cap_updated']);
  assert.equal(next.safetyMode, 'paranoid');
  assert.equal(next.autoApproveStreakCap, 3);
  const reloaded = new ShellConfigService({ userDataPath, env: {} }).getChatUiState();
  assert.equal(reloaded.safetyMode, 'paranoid');
  assert.equal(reloaded.autoApproveStreakCap, 3);
});

test('a patch spanning top-level fields and the chatUi section is one write', (t) => {
  const { service, writes, events } = createService(t);

  service.updateChatUiSettings({ use24HourTime: true, uiLanguage: 'ja', zoomPercent: 120 });

  assert.equal(writes.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'chat_ui_settings_updated');
  assert.deepEqual(events[0].reasons,
    ['time_format_updated', 'ui_language_updated', 'chat_ui_settings_updated']);
  const state = service.getChatUiState();
  assert.equal(state.use24HourTime, true);
  assert.equal(state.uiLanguage, 'ja');
  assert.equal(state.zoomPercent, 120);
});

test('a single-field chat UI patch keeps its specific reason', (t) => {
  const { service, writes, events } = createService(t);

  service.updateChatUiSettings({ unattendedGuardMinutes: 30 });
  service.updateDefaultRunMode('plan');

  assert.equal(writes.length, 2);
  assert.deepEqual(events.map((event) => event.reason),
    ['unattended_guard_minutes_updated', 'default_run_mode_updated']);
  assert.deepEqual(events.map((event) => event.reasons),
    [['unattended_guard_minutes_updated'], ['default_run_mode_updated']]);
});

test('an unchanged chat UI patch writes nothing and emits nothing', (t) => {
  const { service, writes, events } = createService(t);
  const current = service.getChatUiState();

  const result = service.updateChatUiSettings({
    use24HourTime: current.use24HourTime,
    defaultRunMode: current.defaultRunMode,
    uiLanguage: current.uiLanguage,
    safetyMode: current.safetyMode,
    unattendedGuardMinutes: current.unattendedGuardMinutes,
    autoApproveStreakCap: current.autoApproveStreakCap,
    zoomPercent: current.zoomPercent,
  });
  service.updateChatUiSettings({ safetyMode: ' NORMAL ' });
  service.updateUiLanguage('EN');

  assert.equal(writes.length, 0);
  assert.equal(events.length, 0);
  assert.deepEqual(result, current);
});
