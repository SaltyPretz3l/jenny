const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const {
  SUPPORTED_TAGS,
  createI18n,
  dirForTag,
  interpolate,
  normalizeTag,
} = require('../renderer/shared/i18n-utils');

const I18N_SOURCE = fs.readFileSync(path.join(__dirname, '../renderer/shared/i18n-utils.js'), 'utf8');
const BOOTSTRAP_SOURCE = fs.readFileSync(path.join(__dirname, '../renderer/shared/i18n-bootstrap.js'), 'utf8');

function runBrowserBootstrap({ search = '', storedTag = null, throwOnWrite = false } = {}) {
  const writes = [];
  const listeners = {};
  const values = storedTag === null ? {} : { 'jenny.ui.language': storedTag };
  const document = {
    documentElement: {},
    readyState: 'loading',
    write(value) {
      if (throwOnWrite) throw new Error('catalog unavailable');
      writes.push(value);
    },
    addEventListener(name, listener) {
      listeners[name] = listener;
    },
    querySelectorAll() {
      return [];
    },
  };
  const localStorage = {
    getItem(key) {
      return values[key] || null;
    },
    setItem(key, value) {
      values[key] = value;
    },
  };
  const context = vm.createContext({ document, Intl, localStorage, location: { search }, URLSearchParams });
  vm.runInContext(I18N_SOURCE, context);
  vm.runInContext(BOOTSTRAP_SOURCE, context);
  return { context, document, listeners, values, writes };
}

test('normalizeTag resolves supported language tags and regional fallbacks', () => {
  const cases = [
    ['PT-pt', 'pt-BR'],
    ['zh-Hant-HK', 'zh-TW'],
    ['zh', 'zh-CN'],
    ['de-AT', 'de'],
    ['xx', 'en'],
    ['QPS-ploc', 'qps-ploc'],
    ['', 'en'],
    [null, 'en'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizeTag(input), expected, String(input));
  }
  assert.equal(SUPPORTED_TAGS.length, 19);
  assert.ok(Object.isFrozen(SUPPORTED_TAGS));
});

test('dirForTag recognizes current and future RTL language tags', () => {
  assert.equal(dirForTag('ar'), 'rtl');
  assert.equal(dirForTag('HE-il'), 'rtl');
  assert.equal(dirForTag('de'), 'ltr');
});

test('interpolate replaces present parameters and leaves missing tokens untouched', () => {
  assert.equal(interpolate('Hello, {name}; {missing}', { name: 'Jenny' }), 'Hello, Jenny; {missing}');
  assert.equal(interpolate('<b>{value}</b>', { value: '<script>alert(1)</script>' }), '<b><script>alert(1)</script></b>');
});

test('load, t, and catalog replacement preserve English fallbacks', () => {
  const i18n = createI18n();
  assert.equal(i18n.tag(), 'en');
  assert.equal(i18n.t('missing', 'Hello, {name}', { name: 'Jenny' }), 'Hello, Jenny');
  assert.equal(i18n.t('', 'Fallback {value}', { value: 3 }), 'Fallback 3');
  assert.equal(i18n.load(null), false);
  assert.equal(i18n.load('invalid'), false);
  assert.equal(i18n.load({ tag: 'es', version: '1.0.1', strings: [] }), false);
  assert.equal(i18n.load({
    tag: 'es',
    version: '1.0.1',
    strings: { greeting: 'Hola, {name}', stale: 'Anterior', ignored: 42 },
  }), true);
  assert.equal(i18n.tag(), 'es');
  assert.equal(i18n.t('greeting', 'Hello', { name: 'Jenny' }), 'Hola, Jenny');
  assert.equal(i18n.t('ignored', 'English'), 'English');

  assert.equal(i18n.load({ tag: 'es', version: '1.0.1', strings: { current: 'Actual' } }), true);
  assert.equal(i18n.t('stale', 'Old'), 'Old');
  assert.equal(i18n.t('current', 'Current'), 'Actual');
});

test('load updates the i18n direction getter without mutating the document direction', () => {
  const writes = [];
  const originalDocument = global.document;
  global.document = {
    documentElement: {
      get dir() { return 'ltr'; },
      set dir(value) { writes.push(value); },
    },
  };

  try {
    const i18n = createI18n();
    assert.equal(i18n.load({ tag: 'ar', version: '1.0.1', strings: {} }), true);
    assert.equal(i18n.dir(), 'rtl');
    assert.deepEqual(writes, []);
  } finally {
    if (originalDocument === undefined) {
      delete global.document;
    } else {
      global.document = originalDocument;
    }
  }
});

test('tn uses CLDR catalog categories and English fallback selection', () => {
  const i18n = createI18n();
  i18n.load({
    tag: 'ru',
    version: '1.0.1',
    strings: {
      'items#one': '{count} item-one',
      'items#few': '{count} item-few',
      'items#many': '{count} item-many',
    },
  });
  assert.equal(i18n.tn('items', 2, null, '{count} item', '{count} items'), '2 item-few');
  assert.equal(i18n.tn('items', 5, null, '{count} item', '{count} items'), '5 item-many');
  assert.equal(i18n.tn('items', 21, null, '{count} item', '{count} items'), '21 item-one');
  assert.equal(i18n.tn('missing', 21, null, '{count} item', '{count} items'), '21 items');

  i18n.load({
    tag: 'pl',
    version: '1.0.1',
    strings: { 'items#few': 'kilka', 'items#many': 'wiele' },
  });
  assert.equal(i18n.tn('items', 2, null, 'one', 'other'), 'kilka');
  assert.equal(i18n.tn('items', 5, null, 'one', 'other'), 'wiele');

  i18n.load({
    tag: 'ar',
    version: '1.0.1',
    strings: { 'items#zero': 'none', 'items#two': 'pair' },
  });
  assert.equal(i18n.tn('items', 0, null, 'one', 'other'), 'none');
  assert.equal(i18n.tn('items', 2, null, 'one', 'other'), 'pair');
  assert.equal(i18n.tn('items', 2, { count: 'two' }, 'one', 'other'), 'pair');
});

test('applyStaticNodes translates text and attributes and restores original English', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <span data-i18n="label">Run</span>
    <button data-i18n-title="title" title="Run title"></button>
    <button data-i18n-aria-label="aria" aria-label="Run aria"></button>
    <input data-i18n-placeholder="placeholder" placeholder="Run placeholder">
    <img data-i18n-alt="alt" alt="Run alt">
  </body>`);
  const document = dom.window.document;
  const i18n = createI18n();
  i18n.load({
    tag: 'es',
    version: '1.0.1',
    strings: {
      label: 'Ejecutar',
      title: 'Titulo',
      aria: 'Etiqueta',
      placeholder: 'Marcador',
      alt: 'Alternativa',
    },
  });

  assert.equal(i18n.applyStaticNodes(document), 5);
  assert.equal(document.querySelector('[data-i18n]').textContent, 'Ejecutar');
  assert.equal(document.querySelector('[data-i18n-title]').getAttribute('title'), 'Titulo');
  assert.equal(document.querySelector('[data-i18n-aria-label]').getAttribute('aria-label'), 'Etiqueta');
  assert.equal(document.querySelector('[data-i18n-placeholder]').getAttribute('placeholder'), 'Marcador');
  assert.equal(document.querySelector('[data-i18n-alt]').getAttribute('alt'), 'Alternativa');

  i18n.load({ tag: 'es', version: '1.0.1', strings: {} });
  assert.equal(i18n.applyStaticNodes(document), 5);
  assert.equal(document.querySelector('[data-i18n]').textContent, 'Run');
  assert.equal(document.querySelector('[data-i18n-title]').getAttribute('title'), 'Run title');
  assert.equal(document.querySelector('[data-i18n-aria-label]').getAttribute('aria-label'), 'Run aria');
  assert.equal(document.querySelector('[data-i18n-placeholder]').getAttribute('placeholder'), 'Run placeholder');
  assert.equal(document.querySelector('[data-i18n-alt]').getAttribute('alt'), 'Run alt');
  assert.equal(i18n.applyStaticNodes({}), 0);
});

test('applyStaticNodes preserves children under non-leaf data-i18n markers', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div data-i18n="parent" data-i18n-title="title" title="Parent title">Parent <span>Child text</span></div>
  </body>`);
  const document = dom.window.document;
  const i18n = createI18n();
  i18n.load({
    tag: 'es',
    version: '1.0.1',
    strings: { parent: 'Padre', title: 'Titulo' },
  });

  assert.equal(i18n.applyStaticNodes(document), 1);
  const parent = document.querySelector('[data-i18n]');
  assert.equal(parent.textContent.trim(), 'Parent Child text');
  assert.equal(parent.querySelector('span').textContent, 'Child text');
  assert.equal(parent.getAttribute('title'), 'Titulo');
});

test('browser globals expose the fallback and load the catalog script contract', () => {
  const context = vm.createContext({ Intl });
  vm.runInContext(I18N_SOURCE, context);
  assert.equal(context.jennyI18nFallback('key', 'Hello, {name}', { name: 'Jenny' }), 'Hello, Jenny');

  const fixture = `(function () { var catalog = { tag: 'es', version: '1.0.1', strings: { greeting: 'Hola' } }; if (globalThis.jennyI18n && typeof globalThis.jennyI18n.load === 'function') { globalThis.jennyI18n.load(catalog); } })();`;
  vm.runInContext(fixture, context);
  assert.equal(context.jennyI18n.tag(), 'es');
  assert.equal(context.jennyI18n.t('greeting', 'Hello'), 'Hola');
});

test('bootstrap projects a normalized tag and parser-blocking catalog before DOMContentLoaded', () => {
  const result = runBrowserBootstrap({ search: '?jennyUiLanguage=PT-pt' });
  assert.equal(result.values['jenny.ui.language'], 'pt-BR');
  assert.equal(result.document.documentElement.lang, 'pt-BR');
  assert.equal(result.document.documentElement.dir, 'ltr');
  assert.deepEqual(result.writes, ['<script src="locales/pt-BR.catalog.js"></script>']);
  assert.equal(typeof result.listeners.DOMContentLoaded, 'function');
  assert.doesNotThrow(() => result.listeners.DOMContentLoaded());
});

test('bootstrap does no catalog work for English and degrades when catalog insertion fails', () => {
  const english = runBrowserBootstrap();
  assert.deepEqual(english.writes, []);
  assert.equal(english.listeners.DOMContentLoaded, undefined);

  const arabic = runBrowserBootstrap({ storedTag: 'ar', throwOnWrite: true });
  assert.equal(arabic.document.documentElement.lang, 'ar');
  assert.equal(arabic.document.documentElement.dir, 'rtl');
  assert.equal(typeof arabic.listeners.DOMContentLoaded, 'function');
  assert.doesNotThrow(() => arabic.listeners.DOMContentLoaded());
});
