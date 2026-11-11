'use strict';

// Network and cosmetic ad blocking for browser-use pages. The engine is data
// driven (EasyList + EasyPrivacy, no scriptlets) and lives in the main process.
// `@ghostery/adblocker` is required lazily so app startup never pays for it.

const fs = require('node:fs');
const path = require('node:path');

const FILTERS_PATH = path.join(__dirname, '..', '..', 'assets', 'ad-filters', 'filters.bin');

function defaultLoadBytes() {
  return fs.promises.readFile(FILTERS_PATH);
}

function defaultLoadEngineModule() {
  return require('@ghostery/adblocker');
}

function isHttp(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function toBytes(loaded) {
  return new Uint8Array(loaded.buffer, loaded.byteOffset, loaded.byteLength);
}

function createAdBlocker({
  loadBytes = defaultLoadBytes,
  loadEngineModule = defaultLoadEngineModule,
  logger,
} = {}) {
  let engine = null;
  let requestClass = null;
  let loading = null;

  function warn(message) {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(message);
    } catch { /* logging must never break loading */ }
  }

  async function load() {
    try {
      const mod = loadEngineModule();
      const bytes = toBytes(await loadBytes());
      engine = mod.FiltersEngine.deserialize(bytes);
      requestClass = mod.Request;
      return true;
    } catch {
      engine = null;
      requestClass = null;
      warn('ad filter engine unavailable; ad blocking is off');
      return false;
    }
  }

  function ready() {
    if (!loading) loading = load();
    return loading;
  }

  function shouldBlock(details) {
    if (!engine) return false;
    try {
      const { url, sourceUrl, type } = details || {};
      if (type === 'mainFrame' || !isHttp(url)) return false;
      const response = engine.match(requestClass.fromRawDetails({ url, sourceUrl, type }));
      return response.match === true && !response.exception;
    } catch {
      return false;
    }
  }

  function stylesFor(url) {
    if (!engine || !isHttp(url)) return '';
    try {
      const { hostname, domain } = requestClass.fromRawDetails({ url });
      const result = engine.getCosmeticsFilters({
        url,
        hostname,
        domain,
        getBaseRules: false,
        getInjectionRules: false,
        getExtendedRules: false,
        getRulesFromDOM: false,
        getRulesFromHostname: true,
      });
      return typeof result.styles === 'string' ? result.styles : '';
    } catch {
      return '';
    }
  }

  return { ready, shouldBlock, stylesFor };
}

module.exports = { createAdBlocker };
