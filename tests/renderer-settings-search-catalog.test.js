'use strict';

/* Settings search reaches the semantic catalog ("Search by meaning", Settings > Tools >
 * Knowledge folders) and flashes the whole row of a bare switch. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  buildSettingsSearchIndex,
  searchSettingsIndex,
  buildSettingsSearchBoxMarkup,
  createSettingsSearchController,
} = require('../renderer/shell/renderer-settings-search.js');
const searchInputDomId = 'settingsSearchInput';

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

test('Search by meaning is findable and lands on the catalog toggle in Tools', () => {
  const index = buildSettingsSearchIndex();
  for (const query of ['meaning', 'embedding', 'semantic']) {
    const hit = searchSettingsIndex(index, query).find((entry) => entry.id === 'knowledge-catalog-enabled');
    assert.ok(hit, `"${query}" finds the catalog toggle`);
    assert.equal(hit.sectionId, 'tools');
  }
});

test('a bare switch hit flashes its whole settings row, not only the switch', (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const { window } = app.dom;
  const documentRef = window.document;
  window.requestAnimationFrame = (cb) => { cb(); return 0; };
  documentRef.querySelector('.settings-nav-header').insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());
  documentRef.querySelector('.settings-card[data-settings-section="tools"]').innerHTML = '<div class="settings-field-row" id="catalogRow">'
    + '<span>Search by meaning</span><label class="inv-toggle inv-toggle--bare">'
    + '<button class="inv-toggle-track" data-inv-toggle="knowledge-catalog-enabled"></button></label></div>';
  const controller = createSettingsSearchController({
    documentRef, settingsNav: documentRef.querySelector('.settings-nav'), navigateToSection: () => {},
  });
  controller.bind();
  controller.runQuery('search by meaning');
  documentRef.getElementById(searchInputDomId)
    .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(documentRef.getElementById('catalogRow').getAttribute('data-search-hit'), 'true');
  controller.dispose();
});

test('Team and the Team-only density row are offered only while the Team flag is on, as it is when searching', (t) => {
  const app = buildNavDom();
  t.after(() => app.dispose());
  const documentRef = app.dom.window.document;
  documentRef.querySelector('.settings-nav-scroll').insertAdjacentHTML('beforeend',
    '<button class="settings-nav-item" data-settings-section="team" data-feature-flag="team" role="tab" hidden>Team</button>');
  documentRef.querySelector('.settings-nav-header').insertAdjacentHTML('beforeend', buildSettingsSearchBoxMarkup());
  const teamItem = documentRef.querySelector('[data-settings-section="team"]');
  const controller = createSettingsSearchController({
    documentRef, settingsNav: documentRef.querySelector('.settings-nav'), navigateToSection: () => {},
  });
  controller.bind();
  const ids = (query) => { controller.runQuery(query); return controller.getActiveHits().map((hit) => hit.id); };
  const index = buildSettingsSearchIndex();
  const density = index.find((entry) => entry.id === 'appearanceTeamDensitySelect');
  assert.equal(density && density.sectionId, 'chat', 'the density row is in the index, on Chat');
  assert.ok(ids('density').includes('appearanceTeamDensitySelect'), 'and it is found with the Team flag off: the row is greyed there, not hidden');
  for (const word of ['team', 'invite', 'host', 'server', 'members']) {
    const off = ids(word);
    assert.equal(off.includes('section:team'), false, `"${word}" offers no Team page with the flag off`);
    assert.equal(searchSettingsIndex(index, word).some((hit) => hit.id === 'section:team'), false, `"${word}": no flag source, no Team`);
  }
  // The flag turns on after the index was built and the controller bound: the next search sees it.
  teamItem.hidden = false;
  for (const word of ['team', 'invite', 'host', 'server', 'members']) {
    assert.ok(ids(word).includes('section:team'), `"${word}" finds the Team page with the flag on`);
  }
  assert.ok(ids('team').includes('appearanceTeamDensitySelect'), 'and the density row');
  assert.ok(searchSettingsIndex(index, 'members', () => true).some((hit) => hit.id === 'section:team'));
  teamItem.hidden = true;
  assert.equal(ids('members').includes('section:team'), false, 'the flag going off hides it again');
  controller.dispose();
});
