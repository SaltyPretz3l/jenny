'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createSpellcheckSessionController,
} = require('../services/main/spellcheck-session-controller');

function createConfigService(initialOverrides = {}) {
  let featureOverrides = initialOverrides;
  const service = new EventEmitter();
  service.getState = () => ({ featureOverrides });
  return {
    service,
    setOverrides(value) {
      featureOverrides = value;
    },
  };
}

function createSessionRef(initialEnabled) {
  let enabled = initialEnabled;
  const calls = [];
  return {
    calls,
    isSpellCheckerEnabled() {
      return enabled;
    },
    setSpellCheckerEnabled(value) {
      calls.push(value);
      enabled = value;
    },
  };
}

test('default environment with no stored override enables Chromium spellcheck', () => {
  const { service } = createConfigService();
  const sessionRef = createSessionRef(false);
  const controller = createSpellcheckSessionController({
    sessionRef,
    getShellConfigService: () => service,
    env: {},
  });

  controller.apply();

  assert.deepEqual(sessionRef.calls, [true]);
});

test('environment rollback disables Chromium spellcheck when there is no stored override', () => {
  const { service } = createConfigService();
  const sessionRef = createSessionRef(true);
  const controller = createSpellcheckSessionController({
    sessionRef,
    getShellConfigService: () => service,
    env: { JENNY_ENABLE_TEXT_SPELLCHECK: '0' },
  });

  controller.apply();

  assert.deepEqual(sessionRef.calls, [false]);
});

test('stored false override disables Chromium spellcheck under the default environment', () => {
  const { service } = createConfigService({ text_spellcheck: false });
  const sessionRef = createSessionRef(true);
  const controller = createSpellcheckSessionController({
    sessionRef,
    getShellConfigService: () => service,
    env: {},
  });

  controller.apply();

  assert.deepEqual(sessionRef.calls, [false]);
});

test('stored true override wins over an environment default of false', () => {
  const { service } = createConfigService({ text_spellcheck: true });
  const sessionRef = createSessionRef(false);
  const controller = createSpellcheckSessionController({
    sessionRef,
    getShellConfigService: () => service,
    env: { JENNY_ENABLE_TEXT_SPELLCHECK: '0' },
  });

  controller.apply();

  assert.deepEqual(sessionRef.calls, [true]);
});

test('changed re-applies only when the resolved spellcheck value changes', () => {
  const config = createConfigService({ text_spellcheck: false });
  const sessionRef = createSessionRef(true);
  const controller = createSpellcheckSessionController({
    sessionRef,
    getShellConfigService: () => config.service,
    env: {},
  });

  controller.apply();
  config.setOverrides({ text_spellcheck: true });
  config.service.emit('changed');
  config.service.emit('changed');

  assert.deepEqual(sessionRef.calls, [false, true]);
  assert.equal(sessionRef.calls.length, 2, 'an unchanged resolved value is idempotent');
});

test('missing or throwing native session APIs warn exactly once and never throw', () => {
  for (const sessionRef of [
    null,
    { isSpellCheckerEnabled: () => false },
    {
      isSpellCheckerEnabled: () => false,
      setSpellCheckerEnabled() { throw new Error('native failure'); },
    },
  ]) {
    const { service } = createConfigService();
    const warnings = [];
    const controller = createSpellcheckSessionController({
      sessionRef,
      getShellConfigService: () => service,
      env: {},
      log: (level, event, details) => warnings.push({ level, event, details }),
    });

    assert.doesNotThrow(() => controller.apply());
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'WARN');
    assert.equal(warnings[0].event, 'spellcheck.session_apply_failed');
  }
});

test('dispose unsubscribes once and prevents later changed events from applying', () => {
  const config = createConfigService();
  const sessionRef = createSessionRef(false);
  const controller = createSpellcheckSessionController({
    sessionRef,
    getShellConfigService: () => config.service,
    env: {},
  });

  controller.apply();
  assert.doesNotThrow(() => controller.dispose());
  assert.doesNotThrow(() => controller.dispose());
  config.setOverrides({ text_spellcheck: false });
  config.service.emit('changed');

  assert.deepEqual(sessionRef.calls, [true]);
});
