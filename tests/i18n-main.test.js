'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createI18nMain,
  mapAppLocaleToUiLanguage,
  registerMainTranslator,
  resolveUiLanguage,
  t,
} = require('../services/i18n-main');

const FIXTURES_DIR = path.join(__dirname, 'i18n-main-fixtures');

test('process-wide translator falls back before registration and delegates at call time', () => {
  assert.equal(t('greeting', 'Hello, {name}!', { name: 'Ada' }), 'Hello, Ada!');

  const qps = createI18nMain({
    readFileSync: () => JSON.stringify({
      tag: 'qps-ploc',
      strings: { greeting: '[Héllö, {name}!]'},
    }),
  });
  qps.setLocale('qps-ploc');
  registerMainTranslator(qps);
  assert.equal(t('greeting', 'Hello, {name}!', { name: 'Ada' }), '[Héllö, Ada!]');

  const replacement = createI18nMain({ localesDir: FIXTURES_DIR });
  replacement.setLocale('es');
  registerMainTranslator(replacement);
  assert.equal(t('greeting', 'Hello, {name}!', { name: 'Ada' }), 'Hola, Ada!');
});

test('main-process translations fall back to English and interpolate without a catalog', () => {
  const i18n = createI18nMain({ localesDir: FIXTURES_DIR });

  assert.equal(i18n.locale(), 'en');
  assert.equal(i18n.t('greeting', 'Hello, {name}!', { name: 'Ada' }), 'Hello, Ada!');
});

test('setLocale loads, translates, and interpolates a valid catalog', () => {
  const i18n = createI18nMain({ localesDir: FIXTURES_DIR });

  assert.equal(i18n.setLocale('es'), 'es');
  assert.equal(i18n.locale(), 'es');
  assert.equal(i18n.t('greeting', 'Hello, {name}!', { name: 'Ada' }), 'Hola, Ada!');
});

test('setLocale loads a shipped catalog, which is a flat key-to-text object', () => {
  // The fixtures are wrapped as { tag, strings }; locales/<tag>.json is not, and
  // a loader that only took the wrapped shape left every main-process string English.
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'de.json'), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(shipped, 'strings'), false);
  const logs = [];
  const i18n = createI18nMain({ log: (...args) => logs.push(args) });

  i18n.setLocale('de');

  assert.notEqual(shipped['activity.close'], 'Close');
  assert.equal(i18n.t('activity.close', 'Close'), shipped['activity.close']);
  assert.deepEqual(logs, []);
});

test('a flat catalog keeps only string values and a wrapped one must name its own tag', () => {
  const flat = createI18nMain({ readFileSync: () => JSON.stringify({ greeting: 'Hallo', broken: 3 }) });
  flat.setLocale('de');
  assert.equal(flat.t('greeting', 'Hello'), 'Hallo');
  assert.equal(flat.t('broken', 'Broken'), 'Broken');

  const mislabeled = createI18nMain({
    readFileSync: () => JSON.stringify({ tag: 'fr', strings: { greeting: 'Bonjour' } }),
  });
  mislabeled.setLocale('de');
  assert.equal(mislabeled.t('greeting', 'Hello'), 'Hello');
});

test('invalid catalog falls back to English and logs once per tag', () => {
  const logs = [];
  const i18n = createI18nMain({
    localesDir: FIXTURES_DIR,
    log: (...args) => logs.push(args),
  });

  i18n.setLocale('ja');
  assert.equal(i18n.t('greeting', 'Hello, {name}!', { name: 'Ada' }), 'Hello, Ada!');
  i18n.setLocale('ja');
  assert.deepEqual(logs, [[
    'WARN',
    'i18n_main.catalog_unavailable',
    { tag: 'ja' },
  ]]);
});

test('setLocale en clears the active catalog and restores English defaults', () => {
  const i18n = createI18nMain({ localesDir: FIXTURES_DIR });
  i18n.setLocale('es');

  i18n.setLocale('en');

  assert.equal(i18n.locale(), 'en');
  assert.equal(i18n.t('greeting', 'Hello, {name}!', { name: 'Ada' }), 'Hello, Ada!');
});

test('mapAppLocaleToUiLanguage delegates locale normalization to the shared mapping', async (t) => {
  for (const [input, expected] of [
    ['en-US', 'en'],
    ['pt-PT', 'pt-BR'],
    ['zh-Hant-TW', 'zh-TW'],
    ['zh', 'zh-CN'],
    ['xx', 'en'],
    ['', 'en'],
  ]) {
    await t.test(`${JSON.stringify(input)} maps to ${expected}`, () => {
      assert.equal(mapAppLocaleToUiLanguage(input), expected);
    });
  }
});

test('resolveUiLanguage normalizes a non-empty env override ahead of shell config', () => {
  const shellConfigService = { getUiLanguage: () => 'ja' };

  assert.equal(resolveUiLanguage({
    env: { JENNY_UI_LANGUAGE: ' PT-pt ' },
    shellConfigService,
  }), 'pt-BR');
  assert.equal(resolveUiLanguage({ env: {}, shellConfigService }), 'ja');
});

test('resolveUiLanguage passes the qps-ploc development override through', () => {
  assert.equal(resolveUiLanguage({
    env: { JENNY_UI_LANGUAGE: 'qps-ploc' },
    shellConfigService: { getUiLanguage: () => 'en' },
  }), 'qps-ploc');
});
