/* Hosted localization shares the desktop catalog runtime and language preference. */
'use strict';

const { createI18n, normalizeTag, dirForTag } = require('../shared/i18n-utils');

function install(scope) {
  const i18n = createI18n();
  scope.jennyI18n = i18n;
  return i18n;
}

async function load(scope) {
  const i18n = scope.jennyI18n;
  let preference;
  try { preference = scope.localStorage?.getItem('jenny.ui.language'); } catch { /* Storage may be disabled. */ }
  const tag = normalizeTag(preference || scope.navigator?.language || 'en');
  let loadedTag = 'en';
  if (tag !== 'en') {
    try {
      const response = await scope.fetch(`/locales/${tag}.json`, { signal: scope.AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('catalog_unavailable');
      const strings = await response.json();
      if (i18n.load({ tag, strings })) loadedTag = tag;
    } catch { /* A missing catalog must leave the English login usable. */ }
  }
  scope.document.documentElement.lang = loadedTag;
  scope.document.documentElement.dir = dirForTag(loadedTag);
  return loadedTag;
}

module.exports = { install, load };
