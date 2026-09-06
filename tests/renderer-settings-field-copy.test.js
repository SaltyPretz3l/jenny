'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const fieldCopy = require('../renderer/shell/renderer-settings-field-copy.js');
const support = require('../renderer/shell/renderer-settings-support.js');
const registry = require('../renderer/shell/renderer-settings-section-registry.js');

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

  assert.ok(matches.length >= 12, `expected at least 12 Settings toggle ids, found ${matches.length}`);
  const missing = matches.filter(({ id }) => {
    const copy = fieldCopy.getSettingsFieldCopy(id);
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
  const entry = fieldCopy.getSettingsFieldCopy('contextTokenBudgetToggle');
  assert.ok(entry);
  assert.equal(entry.sectionId, 'context');
  assert.equal(fieldCopy.getSettingsFieldCopy('nope-not-a-field'), null);
  assert.equal(fieldCopy.getSettingsFieldCopy(''), null);
  assert.equal(fieldCopy.getSettingsFieldCopy(null), null);
});

test('toggle-list builders inherit descriptions from the copy map', () => {
  const seen = [];
  const stubToggleSwitch = (opts) => {
    seen.push(opts);
    return `<span data-stub="${opts.id}"></span>`;
  };
  const lists = support.buildContextToggleListsMarkup({
    toggleSwitch: stubToggleSwitch,
    contextPreferences: { includePersonality: true },
    featureFlags: { token_budget: true },
  });
  assert.ok(lists.sources && lists.runtime, 'both context lists render');
  assert.equal(seen.length, 4);
  for (const opts of seen) {
    const copy = fieldCopy.getSettingsFieldCopy(opts.id);
    assert.ok(copy, `${opts.id}: context toggle ids must exist in the copy map`);
    assert.ok(
      opts.description && opts.description.trim(),
      `${opts.id}: builder must pass a description through to the switch`
    );
  }
});

test('call-site descriptions win over the copy-map baseline', () => {
  const seen = [];
  const stubToggleSwitch = (opts) => {
    seen.push(opts);
    return '';
  };
  support.buildSettingsToggleListMarkup({
    toggleSwitch: stubToggleSwitch,
    fields: [
      { id: 'contextTokenBudgetToggle', description: 'Dynamic override text.' },
    ],
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].description, 'Dynamic override text.');
  assert.equal(
    seen[0].label,
    fieldCopy.getSettingsFieldCopy('contextTokenBudgetToggle').label,
    'label falls back to the copy map when the call site omits it'
  );
});
