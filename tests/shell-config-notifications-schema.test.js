'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_CATEGORIES,
  normalizeNotificationSettings,
} = require('../services/shell-config-notifications-schema');

const FULL_DEFAULTS = {
  enabled: true,
  onlyWhenUnfocused: true,
  sound: true,
  replyPreview: false,
  categories: {
    replies: true,
    failures: true,
    permissions: true,
    questions: true,
    reminders: true,
  },
};

test('categories are the five ids in order and the defaults are frozen', () => {
  assert.deepEqual([...NOTIFICATION_CATEGORIES], [
    'replies', 'failures', 'permissions', 'questions', 'reminders',
  ]);
  assert.ok(Object.isFrozen(NOTIFICATION_CATEGORIES));
  assert.ok(Object.isFrozen(DEFAULT_NOTIFICATION_SETTINGS));
  assert.ok(Object.isFrozen(DEFAULT_NOTIFICATION_SETTINGS.categories));
  assert.deepEqual(DEFAULT_NOTIFICATION_SETTINGS, FULL_DEFAULTS);
});

test('missing input yields the full default object as a fresh copy', () => {
  const first = normalizeNotificationSettings();
  const second = normalizeNotificationSettings({});
  assert.deepEqual(first, FULL_DEFAULTS);
  assert.deepEqual(second, FULL_DEFAULTS);
  assert.notEqual(first, DEFAULT_NOTIFICATION_SETTINGS);
  assert.notEqual(first.categories, DEFAULT_NOTIFICATION_SETTINGS.categories);
  assert.ok(!Object.isFrozen(first));
});

test('a partial object keeps its booleans and fills every other field from defaults', () => {
  assert.deepEqual(
    normalizeNotificationSettings({ sound: false, categories: { failures: false } }),
    {
      ...FULL_DEFAULTS,
      sound: false,
      categories: { ...FULL_DEFAULTS.categories, failures: false },
    }
  );
  assert.deepEqual(
    normalizeNotificationSettings({ enabled: false, onlyWhenUnfocused: false, replyPreview: true }),
    { ...FULL_DEFAULTS, enabled: false, onlyWhenUnfocused: false, replyPreview: true }
  );
});

test('junk input and non-boolean fields fall back to defaults', () => {
  for (const junk of [null, undefined, 0, 1, 'yes', true, [], [true], () => {}]) {
    assert.deepEqual(normalizeNotificationSettings(junk), FULL_DEFAULTS, String(junk));
  }
  assert.deepEqual(
    normalizeNotificationSettings({
      enabled: 'false',
      onlyWhenUnfocused: 0,
      sound: null,
      replyPreview: 1,
      categories: ['replies'],
    }),
    FULL_DEFAULTS
  );
  assert.deepEqual(
    normalizeNotificationSettings({ categories: { replies: 'off', questions: 0 } }),
    FULL_DEFAULTS
  );
});

test('unknown top-level and category keys are dropped', () => {
  const normalized = normalizeNotificationSettings({
    enabled: false,
    extra: true,
    categories: { reminders: false, digest: false, __proto__: { replies: false } },
  });
  assert.deepEqual(normalized, {
    ...FULL_DEFAULTS,
    enabled: false,
    categories: { ...FULL_DEFAULTS.categories, reminders: false },
  });
  assert.deepEqual(Object.keys(normalized), [
    'enabled', 'onlyWhenUnfocused', 'sound', 'replyPreview', 'categories',
  ]);
  assert.deepEqual(Object.keys(normalized.categories), [...NOTIFICATION_CATEGORIES]);
});

test('normalization is idempotent', () => {
  const inputs = [
    undefined,
    { sound: false },
    { enabled: false, categories: { replies: false, permissions: false } },
    { replyPreview: true, onlyWhenUnfocused: false, junk: 1 },
  ];
  for (const input of inputs) {
    const once = normalizeNotificationSettings(input);
    const twice = normalizeNotificationSettings(once);
    assert.deepEqual(twice, once);
    assert.equal(JSON.stringify(twice), JSON.stringify(once));
  }
});
