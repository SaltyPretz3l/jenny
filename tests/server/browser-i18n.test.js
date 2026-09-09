'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { install, load } = require('../../renderer/browser/browser-i18n');

test('hosted language uses the saved preference, normalizes tags and falls back when catalogs fail', async () => {
  const calls = [];
  const scope = { localStorage: { getItem: () => 'ar-EG' }, navigator: { language: 'es' },
    document: { documentElement: {} }, AbortSignal,
    fetch: async (url) => { calls.push(url); return { ok: true, json: async () => ({ 'common.save': 'حفظ' }) }; } };
  install(scope);
  assert.equal(await load(scope), 'ar');
  assert.equal(scope.document.documentElement.dir, 'rtl');
  assert.equal(scope.jennyI18n.t('common.save', 'Save'), 'حفظ');
  assert.deepEqual(calls, ['/locales/ar.json']);
  install(scope);
  scope.fetch = async () => { throw new Error('offline'); };
  assert.equal(await load(scope), 'en');
  assert.equal(scope.document.documentElement.dir, 'ltr');
  assert.equal(scope.jennyI18n.t('common.save', 'Save'), 'Save');
});

test('the real hosted bundle translates login, composer and CMP-HOST errors before first render', async (t) => {
  const bundle = require('esbuild').buildSync({ entryPoints: [path.resolve(__dirname, '../../renderer/browser/app.js')],
    bundle: true, platform: 'browser', format: 'iife', write: false }).outputFiles[0].text;
  const dom = new JSDOM('<!doctype html><div id="browser-root"></div>', { url: 'https://jenny.test', runScripts: 'outside-only' });
  t.after(() => { dom.window.jennyHostedApp?.dispose(); dom.window.close(); });
  dom.window.localStorage.setItem('jenny.ui.language', 'es');
  dom.window.AbortSignal = AbortSignal;
  const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../locales/es.json'), 'utf8'));
  dom.window.fetch = async (url) => url === '/locales/es.json'
    ? { ok: true, json: async () => dom.window.JSON.parse(JSON.stringify(catalog)) }
    : new Response(JSON.stringify({ ok: false, error: { code: 'CMP-HOST-0002' } }), { status: 401 });
  dom.window.eval(bundle);
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  const app = dom.window.jennyHostedApp;
  assert.ok(app);
  assert.equal(dom.window.document.documentElement.lang, 'es');
  assert.ok(dom.window.document.body.textContent.includes(catalog['browserView.signInToYourJennyHost']));
  assert.equal(app.normalizeReason({ payload: { error: { code: 'CMP-HOST-0004', reason: 'revision_conflict' } } }), catalog['error.host.conflict']);
  app.state.authenticated = true;
  app.render();
  assert.ok(dom.window.document.body.textContent.includes(catalog['browserView.selectConversation']));
});

test('artifact CSP is invariant under a hostile translation catalog', () => {
  const vm = require('node:vm');
  const filename = path.resolve(__dirname, '../../renderer/browser/browser-view.js');
  const context = { module: { exports: {} }, require: require('node:module').createRequire(filename),
    jennyI18n: { t: (key, fallback) => key.includes('defaultSrc') ? '"/><script>bad()</script>' : fallback } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context);
  const dom = new JSDOM(context.module.exports.buildInertArtifactDocument('<p>Preview</p>'));
  assert.equal(dom.window.document.querySelector('script'), null);
  assert.match(dom.window.document.querySelector('meta').content, /default-src 'none'/);
  assert.match(dom.window.document.querySelector('meta').content, /base-uri 'none'; form-action 'none'/);
  dom.window.close();
});
