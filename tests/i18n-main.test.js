'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
