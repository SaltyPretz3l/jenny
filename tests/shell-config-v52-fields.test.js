'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CONFIG_VERSION,
  SAFETY_MODES,
  UI_LANGUAGE_TAGS,
  UNATTENDED_GUARD_MINUTES_DEFAULT,
  UNATTENDED_GUARD_MINUTES_MAX,
  cloneState,
  normalizeSafetyMode,
  normalizeState,
  normalizeUiLanguage,
  normalizeUnattendedGuardMinutes,
  serializeState,
} = require('../services/shell-config-state');
const { ShellConfigService } = require('../services/shell-config-service');
const {
  normalizeSetupState,
  normalizeSetupSteps,
} = require('../services/shell-config-setup-state');
const { toSnakeSetupState } = require('../services/setup-service-helpers');

test('v52 field normalizers enforce canonical language, safety, and guard values', async (t) => {
  assert.equal(Object.isFrozen(UI_LANGUAGE_TAGS), true);
  assert.deepEqual(UI_LANGUAGE_TAGS, [
    'en', 'es', 'fr', 'de', 'it', 'pt-BR', 'nl', 'pl', 'ru', 'uk', 'tr', 'ar', 'hi',
    'id', 'vi', 'ja', 'ko', 'zh-CN', 'zh-TW',
  ]);
  for (const [input, expected] of [
    ['en', 'en'], ['PT-br', 'pt-BR'], ['ZH-cn', 'zh-CN'], ['zh-TW', 'zh-TW'],
    ['pt', 'en'], ['en-US', 'en'], [null, 'en'], [{}, 'en'],
  ]) {
    await t.test(`uiLanguage ${JSON.stringify(input)}`, () => {
      assert.equal(normalizeUiLanguage(input), expected);
    });
  }

  assert.equal(Object.isFrozen(SAFETY_MODES), true);
  assert.deepEqual(SAFETY_MODES, ['normal', 'strict', 'paranoid']);
  for (const [input, expected] of [
    ['normal', 'normal'], [' STRICT ', 'strict'], ['Paranoid', 'paranoid'],
    ['unsafe', 'normal'], [null, 'normal'], [{}, 'normal'],
  ]) {
    await t.test(`safetyMode ${JSON.stringify(input)}`, () => {
      assert.equal(normalizeSafetyMode(input), expected);
    });
  }

  assert.equal(UNATTENDED_GUARD_MINUTES_DEFAULT, 0);
  assert.equal(UNATTENDED_GUARD_MINUTES_MAX, 120);
  for (const [input, expected] of [
    [0, 0], ['0', 0], [1, 1], ['30.9', 30], [200, 120], [0.5, 1],
    [-1, 0], ['nope', 0], [NaN, 0], [null, 0], [undefined, 0], [{}, 0],
  ]) {
    await t.test(`unattendedGuardMinutes ${String(input)}`, () => {
      assert.equal(normalizeUnattendedGuardMinutes(input), expected);
    });
  }
});

test('v52 defaults and migration preserve valid forward values', () => {
  const defaults = normalizeState({});
  assert.equal(defaults.uiLanguage, 'en');
  assert.equal(defaults.safetyMode, 'normal');
  assert.equal(defaults.unattendedGuardMinutes, 0);

  const migrated = normalizeState({ version: 51 });
  assert.equal(migrated.version, 53);
  assert.equal(CONFIG_VERSION, 53);
  assert.equal(migrated.uiLanguage, 'en');
  assert.equal(migrated.safetyMode, 'normal');
  assert.equal(migrated.unattendedGuardMinutes, 0);

  const forward = normalizeState({
    version: 51,
    uiLanguage: 'ja',
    safetyMode: 'paranoid',
    unattendedGuardMinutes: 30,
  });
  assert.equal(forward.uiLanguage, 'ja');
  assert.equal(forward.safetyMode, 'paranoid');
  assert.equal(forward.unattendedGuardMinutes, 30);
});

test('cloneState and serializeState round-trip v52 fields', () => {
  const state = normalizeState({
    uiLanguage: 'PT-br',
    safetyMode: 'STRICT',
    unattendedGuardMinutes: '45.8',
  });
  const cloned = cloneState(state);
  const serialized = serializeState(cloned);
  assert.equal(cloned.uiLanguage, 'pt-BR');
  assert.equal(cloned.safetyMode, 'strict');
  assert.equal(cloned.unattendedGuardMinutes, 45);
  assert.equal(serialized.uiLanguage, 'pt-BR');
  assert.equal(serialized.safetyMode, 'strict');
  assert.equal(serialized.unattendedGuardMinutes, 45);
  assert.deepEqual(normalizeState(serialized), state);
});

test('ShellConfigService persists and exposes v52 chat UI settings idempotently', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-v52-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const service = new ShellConfigService({ userDataPath });
  const reasons = [];
  service.on('changed', (_state, meta) => reasons.push(meta.reason));

  service.updateChatUiSettings({
    uiLanguage: 'PT-br',
    safetyMode: 'STRICT',
    unattendedGuardMinutes: '30',
  });
  assert.equal(service.getUiLanguage(), 'pt-BR');
  assert.deepEqual(service.getChatUiState(), {
    zoomPercent: 100,
    use24HourTime: false,
    defaultRunMode: 'ask',
    uiLanguage: 'pt-BR',
    safetyMode: 'strict',
    unattendedGuardMinutes: 30,
  });
  assert.deepEqual(reasons, [
    'ui_language_updated',
    'safety_mode_updated',
    'unattended_guard_minutes_updated',
  ]);

  service.updateChatUiSettings({
    uiLanguage: 'pt-BR',
    safetyMode: 'strict',
    unattendedGuardMinutes: 30,
  });
  assert.equal(reasons.length, 3);
});

test('setup acknowledgement fields normalize and serialize camel and snake input', () => {
  const acknowledgedAt = '2026-09-07T15:30:00.000Z';
  const camel = normalizeSetupState({
    acknowledgedVersion: ' 1.0.1 ',
    acknowledgedAt,
    steps: { acknowledgement: 'done' },
  });
  assert.equal(camel.acknowledgedVersion, '1.0.1');
  assert.equal(camel.acknowledgedAt, acknowledgedAt);
  assert.equal(camel.steps.acknowledgement, 'done');

  const snake = normalizeSetupState({
    acknowledged_version: 'v'.repeat(45),
    acknowledged_at: acknowledgedAt,
    steps: { acknowledgement: 'skipped' },
  });
  assert.equal(snake.acknowledgedVersion, `${'v'.repeat(37)}...`);
  assert.equal(snake.acknowledgedAt, acknowledgedAt);
  assert.equal(normalizeSetupSteps({ acknowledgement: 'DONE' }).acknowledgement, 'done');
  assert.deepEqual(toSnakeSetupState(camel), {
    seen: false,
    dismissed: false,
    setup_complete: false,
    first_run_completed: false,
    completed_at: '',
    updated_at: '',
    acknowledged_version: '1.0.1',
    acknowledged_at: acknowledgedAt,
    steps: {
      acknowledgement: 'done',
      workspace_root: 'pending',
      local_model: 'pending',
      endpoint: 'pending',
      personality: 'pending',
      skills: 'pending',
      capabilities: 'pending',
    },
  });
});
