'use strict';

const fs = require('fs');
const path = require('path');

const { interpolate, normalizeTag } = require('../renderer/shared/i18n-utils');

let mainTranslator = null;

function registerMainTranslator(instance) {
  mainTranslator = instance;
}

function t(key, englishDefault, params) {
  return mainTranslator
    ? mainTranslator.t(key, englishDefault, params)
    : interpolate(englishDefault, params);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mapAppLocaleToUiLanguage(locale) {
  return normalizeTag(locale);
}

function resolveUiLanguage({ env = process.env, shellConfigService } = {}) {
  const override = typeof env?.JENNY_UI_LANGUAGE === 'string'
    ? env.JENNY_UI_LANGUAGE.trim()
    : '';
  if (override) return normalizeTag(override);
  return shellConfigService?.getUiLanguage?.() || 'en';
}

function createI18nMain({
  localesDir = path.join(__dirname, '..', 'locales'),
  readFileSync = fs.readFileSync,
  log = () => {},
} = {}) {
  const catalogCache = new Map();
  let activeLocale = 'en';
  let activeStrings = null;

  function setLocale(tag) {
    activeLocale = normalizeTag(tag);
    if (activeLocale === 'en') {
      activeStrings = null;
      return activeLocale;
    }
    if (!catalogCache.has(activeLocale)) {
      try {
        const catalog = JSON.parse(readFileSync(path.join(localesDir, `${activeLocale}.json`), 'utf8'));
        if (!isPlainObject(catalog)) throw new Error('invalid catalog');
        // The shipped locales/<tag>.json is a flat key-to-text object; a
        // wrapped { tag, strings } catalog is accepted when it names this tag
        // (the same two shapes scripts/i18n/build-catalogs.js parses).
        const wrapped = Object.prototype.hasOwnProperty.call(catalog, 'strings');
        const source = wrapped ? catalog.strings : catalog;
        if (!isPlainObject(source) || (wrapped && normalizeTag(catalog.tag) !== activeLocale)) {
          throw new Error('invalid catalog');
        }
        const strings = Object.create(null);
        for (const [key, value] of Object.entries(source)) {
          if (typeof value === 'string') strings[key] = value;
        }
        catalogCache.set(activeLocale, strings);
      } catch (_error) {
        catalogCache.set(activeLocale, null);
        log('WARN', 'i18n_main.catalog_unavailable', { tag: activeLocale });
      }
    }
    activeStrings = catalogCache.get(activeLocale);
    return activeLocale;
  }

  function locale() {
    return activeLocale;
  }

  function t(key, englishDefault, params) {
    const template = activeStrings && typeof key === 'string'
      && Object.prototype.hasOwnProperty.call(activeStrings, key)
      ? activeStrings[key]
      : englishDefault;
    return interpolate(template, params);
  }

  return { setLocale, locale, t };
}

module.exports = {
  createI18nMain,
  mapAppLocaleToUiLanguage,
  registerMainTranslator,
  resolveUiLanguage,
  t,
};
