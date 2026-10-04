'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const fieldCopy = require('../renderer/shell/renderer-settings-field-copy.js');
const descriptors = require('../renderer/shell/renderer-settings-field-descriptors');
const support = require('../renderer/shell/renderer-settings-support.js');
const registry = require('../renderer/shell/renderer-settings-section-registry.js');
const { toggleSwitch } = require('../renderer/inventory/toggle-switch');

test('every static Settings toggle id has descriptive copy', () => {
  const shellDir = path.join(__dirname, '..', 'renderer', 'shell');
  const copyFile = 'renderer-settings-field-copy.js';
  const toggleIdPattern = /\bid:\s*'([A-Za-z0-9]+Toggle)'/g;
  const matches = [];

  for (const relativeFile of fs.readdirSync(shellDir, { recursive: true })) {
    if (!relativeFile.endsWith('.js') || relativeFile === copyFile) continue;
    const source = fs.readFileSync(path.join(shellDir, relativeFile), 'utf8');
    for (const match of source.matchAll(toggleIdPattern)) {
      matches.push({ id: match[1], file: relativeFile });
    }
  }

  // Wave 1 moved most switches onto descriptors (checked below); a few literal ids remain.
  assert.ok(matches.length >= 3, `expected the remaining literal Settings toggle ids, found ${matches.length}`);
  for (const descriptor of descriptors.listSettingDescriptors()) {
    if (descriptor.kind === 'boolean') matches.push({ id: descriptor.controlId, file: 'renderer-settings-field-descriptors.js' });
  }
  const projection = new Map(fieldCopy.listSettingsSearchEntries().map((entry) => [entry.id, entry]));
  const missing = matches.filter(({ id }) => {
    const copy = fieldCopy.getSettingsFieldCopy(id) || projection.get(id);
    return !copy || !copy.description || !copy.description.trim();
  });
  assert.deepEqual(
    missing,
    [],
    `Settings toggle ids missing descriptive copy:\n${missing.map(({ id, file }) => `${id} (${file})`).join('\n')}`
  );
});

test('every field-copy entry carries a non-empty label, description, and known section id', () => {
  const entries = fieldCopy.listSettingsFieldCopyEntries();
  assert.ok(entries.length >= 20, `expected a populated copy map, got ${entries.length} entries`);
  const knownSections = new Set(registry.getSettingsSections().map((section) => section.id));
  for (const entry of entries) {
    assert.ok(entry.id, 'entry id present');
    assert.ok(entry.label && entry.label.trim(), `${entry.id}: label must be non-empty`);
    assert.ok(
      entry.description && entry.description.trim().length >= 10,
      `${entry.id}: description must be a real sentence`
    );
    assert.ok(
      knownSections.has(entry.sectionId),
      `${entry.id}: sectionId "${entry.sectionId}" must be a registry section id`
    );
  }
});

test('getSettingsFieldCopy returns entries by id and null for unknown ids', () => {
  const entry = fieldCopy.getSettingsFieldCopy('contextCompactionToggle');
  assert.ok(entry);
  assert.equal(entry.sectionId, 'context');
  assert.equal(fieldCopy.getSettingsFieldCopy('nope-not-a-field'), null);
  assert.equal(fieldCopy.getSettingsFieldCopy(''), null);
  assert.equal(fieldCopy.getSettingsFieldCopy(null), null);
});

test('chat UI settings fields carry searchable copy in their owning sections', () => {
  const expectedSections = {
    uiLanguageSelect: 'appearance',
    safetyModeSelect: 'tools',
    unattendedGuardMinutesInput: 'tools',
    autoApproveStreakCapInput: 'tools',
  };
  for (const [id, sectionId] of Object.entries(expectedSections)) {
    const entry = fieldCopy.getSettingsFieldCopy(id);
    assert.ok(entry, `${id}: copy entry exists`);
    assert.ok(entry.description.length >= 10, `${id}: description is useful`);
    assert.equal(entry.sectionId, sectionId);
  }
});

test('toggle-list builders inherit descriptions from the copy map', () => {
  const lists = support.buildContextToggleListsMarkup({
    toggleSwitch,
    contextPreferences: { includePersonality: true },
    featureFlags: { context_compaction: true },
  });
  assert.ok(lists.sources && lists.runtime, 'both context lists render');
  const doc = new JSDOM(`<!doctype html><body>${lists.sources}${lists.runtime}</body>`).window.document;
  const rows = doc.querySelectorAll('.settings-field--row');
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const id = row.querySelector('[data-inv-toggle]').getAttribute('data-inv-toggle');
    const copy = fieldCopy.getSettingsFieldCopy(id);
    assert.ok(copy, `${id}: context toggle ids must exist in the copy map`);
    assert.equal(row.querySelector('.settings-field-help').textContent, copy.description, `${id}: builder passes the description through`);
  }
});

test('call-site descriptions win over the copy-map baseline', () => {
  const markup = support.buildSettingsToggleListMarkup({
    toggleSwitch,
    fields: [
      { id: 'contextCompactionToggle', description: 'Dynamic override text.' },
    ],
  });
  const row = new JSDOM(`<!doctype html><body>${markup}</body>`).window.document.querySelector('.settings-field--row');
  assert.equal(row.querySelector('.settings-field-help').textContent, 'Dynamic override text.');
  assert.equal(
    row.querySelector('.settings-field-title').textContent,
    fieldCopy.getSettingsFieldCopy('contextCompactionToggle').label,
    'label falls back to the copy map when the call site omits it'
  );
});
