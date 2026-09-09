'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { JSDOM } = require('jsdom');
const { createI18n } = require('../renderer/shared/i18n-utils');

function localizedModule(relative, i18n) {
  const filename = path.resolve(__dirname, '..', relative);
  const context = { module: { exports: {} }, require: createRequire(filename),
    jennyI18n: i18n, setTimeout, clearTimeout, Map };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context);
  return context.module.exports;
}

test('setup status translations remain inside their aria-label attributes', async (t) => {
  const hostile = 'Translated " data-injected="yes';
  const i18n = { t: (key, fallback) => ['setup.hub.pending', 'setup.hub.needsAttention', 'setup.hub.running'].includes(key) ? hostile : fallback };
  const sceneModule = localizedModule('renderer/features/setup-scenes/scene-setup-hub.js', i18n);
  const dom = new JSDOM('<div id="root"></div>');
  const host = dom.window.document.getElementById('root');
  const scene = sceneModule.createScene({ state: { steps: {} },
    setupService: { detectOllama: async () => ({ installed: true, running: true }) } });
  t.after(() => { scene.dispose(); dom.window.close(); });
  scene.mount(host);
  const glyph = () => host.querySelector('[data-setup-derived] .setup-hub-glyph');
  assert.equal(glyph().getAttribute('aria-label'), hostile);
  assert.equal(host.querySelector('[data-injected]'), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(glyph().getAttribute('aria-label'), hostile);
  assert.equal(host.querySelector('[data-injected]'), null);
});

test('outbox uses complete translated messages and locale plural rules', (t) => {
  const i18n = createI18n();
  const strings = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../locales/ru.json'), 'utf8'));
  i18n.load({ tag: 'ru', strings });
  const outbox = localizedModule('renderer/chat/renderer-send-outbox-render.js', i18n);
  const dom = new JSDOM('<div id="root"></div>');
  const host = dom.window.document.getElementById('root');
  t.after(() => { outbox.disposeSendOutboxRender(host); dom.window.close(); });
  for (const count of [1, 2, 5, 21]) {
    const items = Array.from({ length: count }, (_, index) => ({ id: String(index), prompt: 'Draft', status: 'failed' }));
    items.push({ id: 'sending', prompt: 'Sending draft', status: 'sending' });
    outbox.renderSendOutbox({ host, state: { currentSessionId: 's', sendOutboxBySession: new Map([['s', items]]) }, actions: { edit() {} } });
    assert.equal(host.querySelector('.send-outbox__summary').textContent,
      i18n.tn('chat.outbox.summaryWithProblems', count, { count, queued: count + 1 }));
    assert.equal(host.querySelector('.send-outbox__preview').getAttribute('aria-label'),
      i18n.t('chat.outbox.editMessage', '', { position: 1, prompt: 'Draft' }));
    assert.equal(host.querySelector('[data-outbox-item-id="sending"] .send-outbox__status').textContent,
      i18n.t('chat.send.sendingStatus', ''));
  }
});

test('browser slash autocomplete resolves the shared matcher after deferred scripts load', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../renderer/chat/renderer-slash-autocomplete.js'), 'utf8'), context);
  const calls = [];
  context.rendererCommandPaletteUtils = { scoreMatch(text, query) {
    calls.push([text, query]);
    return require('../renderer/shell/renderer-command-palette').scoreMatch(text, query);
  } };
  const entries = [{ name: '/context', description: 'Show context' }, { name: '/help', description: 'List commands' }];
  assert.equal(context.rendererSlashAutocomplete.searchCommands(entries, 'ctx')[0], entries[0]);
  assert.equal(calls.length, 2);
});
