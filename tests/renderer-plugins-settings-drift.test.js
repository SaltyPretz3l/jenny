'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const test = require('node:test');

test('production loads inventory, drawer, catalog, details, and operations before plugin controllers', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const ordered = ['renderer/inventory/toggle-switch.js', 'renderer/inventory/drawer.js',
    'renderer/shell/renderer-plugin-catalog.js', 'renderer/shell/renderer-plugin-manager-details.js',
    'renderer/shell/renderer-plugin-manager-operations.js', 'renderer/shell/renderer-plugins-settings.js'];
  const positions = ordered.map((source) => html.indexOf(source));
  assert.equal(positions.every((position) => position >= 0), true);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.ok(html.indexOf('renderer/shell/renderer-mcp-servers.js') > html.indexOf('renderer/inventory/drawer.js'));
});

test('static plugin hosts have deterministic order and a single card-level h3', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('<section class="settings-card" data-settings-section="plugins"');
  const section = html.slice(start, html.indexOf('</section>', html.indexOf('id="pluginsSourcesHost"')) + 10);
  const ordered = ['id="pluginsSettingsHost"', 'id="skillsSettingsSection"',
    'id="mcpServersHost"', 'id="pluginsSourcesHost"'];
  const positions = ordered.map((marker) => section.indexOf(marker));
  assert.equal(positions.every((position) => position >= 0), true);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.equal((section.match(/<h3/g) || []).length, 1);
  assert.match(section, /<h4 class="settings-group-heading"[^>]*>Skills<\/h4>/);
  assert.doesNotMatch(section, /id="skillsBadge"|id="skillsStatus"|id="skillsSystemList"|id="skillsScopeList"/);

  // Full width comes from `.settings-card > * { grid-column: 1 / -1 }` (settings-grid.css),
  // so the hosts must stay DIRECT children of the card. `.settings-group--wide` on the
  // mounted groups is only a safety belt: as grandchildren of the card the `>` rules in
  // settings-grid.css never match them, so asserting that class alone proves nothing
  // about the layout.
  const card = new JSDOM(section).window.document
    .querySelector('.settings-card[data-settings-section="plugins"]');
  ['pluginsSettingsHost', 'skillsSettingsSection', 'mcpServersHost', 'pluginsSourcesHost'].forEach((hostId) => {
    assert.equal(card.querySelector('#' + hostId).parentElement, card,
      hostId + ' must be a direct child of the plugins card');
  });
});

test('compact rows keep uninstall in details and remove focus refresh and overflow chrome', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'shell',
    'renderer-plugins-settings.js'), 'utf8');
  const details = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'shell',
    'renderer-plugin-manager-details.js'), 'utf8');
  const installedMarkup = source.slice(source.indexOf('function installedMarkup'),
    source.indexOf('function installedGroupMarkup'));
  assert.match(details, /getDetails/);
  assert.match(details, /async function reload/);
  assert.match(details, /'plugins-settings-action': 'uninstall'/);
  assert.doesNotMatch(installedMarkup, /uninstall/);
  assert.match(installedMarkup, /open-view/);
  assert.doesNotMatch(source, /addEventListener\(['"]focus|onWindowFocus|plugin-manager-overflow/);
});
