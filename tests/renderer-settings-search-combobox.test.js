'use strict';

// The Settings search box is a combobox: its results list closes on a pick or an outside
// press (it covered the section it opened) and reopens when the box regains focus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  buildSettingsSearchBoxMarkup,
  createSettingsSearchController,
} = require('../renderer/shell/renderer-settings-search.js');
const searchInputDomId = 'settingsSearchInput';
const searchResultsDomId = 'settingsSearchResults';

function buildNavDom() {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <nav class="settings-nav">
          <div class="settings-nav-header"></div>
          <div class="settings-nav-scroll">
            <button class="settings-nav-item" data-settings-section="models" role="tab" tabindex="0" aria-selected="true">Models</button>
            <button class="settings-nav-item" data-settings-section="context" role="tab" tabindex="-1" aria-selected="false">Context</button>
            <button class="settings-nav-item" data-settings-section="tools" role="tab" tabindex="-1" aria-selected="false">Tools</button>
            <button class="settings-nav-item" data-settings-section="account" role="tab" tabindex="-1" aria-selected="false">Account</button>
          </div>
        </nav>
        <div class="settings-content-scroll">
          <section class="settings-card" data-settings-section="models"></section>
          <section class="settings-card" data-settings-section="context">
            <div data-settings-field="contextHistoryScopeSelect"></div>
          </section>
          <section class="settings-card" data-settings-section="tools"></section>
          <section class="settings-card" data-settings-section="account"></section>
        </div>
      </body>
    </html>
  `, { pretendToBeVisual: true, url: 'http://localhost/' });

  const app = {
    dom,
    dispose() {
      dom.window.close();
    },
  };
  return app;
}

test('a pick or an outside click closes the results list; focusing the box with a query reopens it', (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const { window } = app.dom;
  const documentRef = window.document;
  window.requestAnimationFrame = (cb) => { cb(); return 0; };
  documentRef.querySelector('.settings-nav-header').insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());
  const settingsNav = documentRef.querySelector('.settings-nav');
  const controller = createSettingsSearchController({ documentRef, settingsNav, navigateToSection: () => {} });
  controller.bind();
  const input = documentRef.getElementById(searchInputDomId);
  const results = documentRef.getElementById(searchResultsDomId);

  input.value = 'history scope';
  controller.runQuery(input.value);
  assert.equal(results.hidden, false);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(results.hidden, true, 'the list no longer covers the section it opened');
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(input.value, 'history scope', 'the query stays');
  assert.equal(settingsNav.querySelector('[data-settings-section="models"]').classList.contains('settings-nav-item-search-hidden'), true, 'the nav filter stays');

  input.dispatchEvent(new window.FocusEvent('focus'));
  assert.equal(results.hidden, false, 'focusing the box with a query reopens the list');
  results.querySelector('.settings-search-result').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(results.hidden, false, 'pressing a result does not close the list before its click');
  documentRef.querySelector('.settings-content-scroll').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(results.hidden, true, 'a press outside the search box closes the list');

  controller.dispose();
});
