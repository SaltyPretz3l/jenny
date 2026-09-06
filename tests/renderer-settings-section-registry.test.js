const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTION_DEFINITIONS,
  SETTINGS_GROUP_DEFINITIONS,
  createSettingsSectionRegistry,
  getSettingsSectionDefinition,
  getSettingsSections,
  getSettingsGroups,
  getSettingsCompanionSectionIds,
  normalizeSettingsSectionId,
} = require('../renderer/shell/renderer-settings-section-registry');

const listSectionIds = () => getSettingsSections().map((section) => section.id);

test('settings section registry preserves stable ordering and defaults', () => {
  assert.equal(DEFAULT_SETTINGS_SECTION, 'models');
  assert.deepEqual(listSectionIds(), [
    'readiness',
    'models',
    'modelLibrary',
    'context',
    'tools',
    'skills',
    'personality',
    'appearance',
    'memories',
    'editor',
    'home',
    'offline',
    'usage',
    'plugins',
    'account',
    'dataPrivacy',
    'aboutUpdates',
    'advanced',
  ]);
  assert.equal(normalizeSettingsSectionId('not-a-section'), 'models');
  assert.equal(normalizeSettingsSectionId(' tools '), 'tools');
  assert.equal(normalizeSettingsSectionId('cost'), 'usage');
});

test('settings section registry classifies lazy and advanced sections', () => {
  assert.deepEqual(getSettingsSections().filter((section) => section.lazy).map((section) => section.id), [
    'skills',
    'personality',
    'memories',
    'offline',
    'usage',
    'advanced',
  ]);
  assert.deepEqual(getSettingsSections().filter((section) => section.advanced).map((section) => section.id), ['advanced']);
  assert.equal(getSettingsSectionDefinition('diagnostics'), null);
  assert.equal(getSettingsSectionDefinition('harness'), null);
  assert.equal(getSettingsSectionDefinition('dev_diagnostics'), null);
  assert.equal(getSettingsSectionDefinition('tools').lazy, false);
});

test('settings section registry exposes the Developer group as a disclosure', () => {
  // The group was defined but empty for a long time, and getGroups() filters out
  // groups with no visible sections - so registering Advanced is what makes the
  // chevron appear at all.
  const groups = getSettingsGroups();
  assert.deepEqual(groups.map((group) => group.id), ['session', 'companion', 'app', 'developer']);
  assert.deepEqual(
    groups.map((group) => group.label),
    ['Session', 'Companion', 'App', 'Developer']
  );
  assert.deepEqual(groups.map((group) => group.disclosure), [false, false, false, true]);
  // The nav-facing group view excludes hidden (merged-away) sections; every other
  // section lands in exactly one group and they concatenate to the visible id list.
  const navIds = groups.flatMap((group) => group.sections.map((section) => section.id));
  assert.ok(!navIds.includes('skills'), 'skills is merged into tools, not a nav item');
  assert.ok(!navIds.includes('tips'), 'tips has no Settings section');
  assert.deepEqual(
    navIds,
    listSectionIds().filter((id) => getSettingsSectionDefinition(id).hidden !== true)
  );
  assert.deepEqual(groups.find((group) => group.id === 'session').sections.map((s) => s.id),
    ['readiness', 'models', 'modelLibrary', 'context', 'tools']);
  assert.deepEqual(groups.find((group) => group.id === 'companion').sections.map((s) => s.id),
    ['personality', 'appearance', 'memories']);
  // `plugins` sits before the always-visible trailing app sections: nav-utils derives its
  // keyboard boundary (LAST_NONADVANCED_SECTION) from this order at module
  // load and cannot see that `plugins` is hidden while its flag is off.
  assert.deepEqual(groups.find((group) => group.id === 'app').sections.map((s) => s.id),
    ['editor', 'home', 'offline', 'usage', 'plugins', 'account', 'dataPrivacy', 'aboutUpdates']);
  const memories = getSettingsSectionDefinition('memories');
  assert.equal(memories.label, 'Memory');
  assert.equal(memories.lazy, true);
  assert.equal(memories.advanced, false);
});

test('settings section registry merges skills into plugins and retires tips/proactive sections', () => {
  const skills = getSettingsSectionDefinition('skills');
  // Merged-away sections stay hidden-but-known and keep their lazy lifecycle so the
  // host card can ready + refresh them as companions (skills' MCP discovery stays deferred).
  assert.equal(skills.hidden, true);
  assert.equal(skills.mergedInto, 'plugins');
  assert.equal(skills.lazy, true);
  assert.equal(getSettingsSectionDefinition('tips'), null);
  assert.equal(getSettingsSectionDefinition('proactive'), null);
  assert.deepEqual(getSettingsCompanionSectionIds('plugins'), ['skills']);
  assert.deepEqual(getSettingsCompanionSectionIds('tools'), []);
  assert.deepEqual(getSettingsCompanionSectionIds('proactive'), []);
  assert.deepEqual(getSettingsCompanionSectionIds('models'), []);
  // A persisted/deep-linked hidden section resolves to its host (no blank panel).
  assert.equal(normalizeSettingsSectionId('skills'), 'plugins');
  assert.equal(normalizeSettingsSectionId('tips'), 'models');
});

test('settings section registry registers Home so it no longer redirects to models', () => {
  // Regression: `home` was historically absent from the registry, so
  // normalizeSettingsSectionId('home') silently fell back to the default ('models').
  assert.equal(normalizeSettingsSectionId('home'), 'home');
  const home = getSettingsSectionDefinition('home');
  assert.equal(home.group, 'app');
  assert.equal(home.lazy, false);
  assert.equal(home.label, 'Home');
});

test('settings section registry registers the flag-gated Plugins section in the app group', () => {
  // Stage 3B Plugin Manager (owner-approved 2026-07-31): registry-static like
  // every section — flag gating (featureFlags.plugins) happens at runtime via
  // the sibling controller's data-feature-gated stamp, not in the registry.
  assert.equal(normalizeSettingsSectionId('plugins'), 'plugins');
  const plugins = getSettingsSectionDefinition('plugins');
  assert.equal(plugins.group, 'app');
  assert.equal(plugins.label, 'Plugins & Extensions');
  assert.equal(plugins.lazy, false);
  assert.equal(plugins.hidden, false);
});

test('no runtime-hidden section may be the last non-advanced section', () => {
  // renderer-settings-nav-utils derives LAST_NONADVANCED_SECTION from this
  // registry ONCE at module load, and that derivation cannot see runtime
  // hiding. If a feature-gated section (Plugins, hidden while its flag is off
  // — the default) took the last slot, ArrowDown from the last VISIBLE nav
  // item would no longer jump to the Developer disclosure. Keep the terminal
  // non-advanced section one that is always present.
  const ids = listSectionIds().filter((id) => {
    const def = getSettingsSectionDefinition(id);
    return !def.advanced && !def.hidden;
  });
  const RUNTIME_HIDDEN_SECTIONS = new Set(['plugins']);
  assert.ok(
    !RUNTIME_HIDDEN_SECTIONS.has(ids[ids.length - 1]),
    `the last non-advanced section is "${ids[ids.length - 1]}", which is hidden at runtime`
  );
  assert.equal(ids[ids.length - 1], 'aboutUpdates');
});

test('settings section registry preserves special nav-item ids for show/hide consumers', () => {
  // These ids are resolved by bootstrap-dom and toggled by lazy renderers.
  assert.equal(getSettingsSectionDefinition('usage').navItemId, 'usageSettingsNavItem');
  assert.equal(getSettingsSectionDefinition('usage').label, 'Usage');
  assert.equal(getSettingsSectionDefinition('skills').navItemId, 'skillsSettingsNavItem');
  assert.equal(getSettingsSectionDefinition('models').navItemId, '');
});

test('settings group definitions are frozen', () => {
  assert.equal(Object.isFrozen(SETTINGS_GROUP_DEFINITIONS), true);
  assert.equal(Object.isFrozen(SETTINGS_GROUP_DEFINITIONS[0]), true);
});

test('settings section registry exports immutable canonical definitions', () => {
  assert.equal(Object.isFrozen(SETTINGS_SECTION_DEFINITIONS), true);
  assert.equal(Object.isFrozen(SETTINGS_SECTION_DEFINITIONS[0]), true);
});

test('settings section registry rejects duplicate ids', () => {
  assert.throws(
    () => createSettingsSectionRegistry([
      { id: 'models', label: 'Models' },
      { id: 'models', label: 'Duplicate models' },
    ]),
    /Duplicate settings section id: models/
  );
});

test('custom settings section registry falls back to its default section', () => {
  const registry = createSettingsSectionRegistry([
    { id: 'alpha', label: 'Alpha', default: true },
    { id: 'beta', label: 'Beta', advanced: true, lazy: true },
  ]);

  assert.equal(registry.defaultSectionId, 'alpha');
  const sections = registry.getSections();
  assert.deepEqual(sections.map((section) => section.id), ['alpha', 'beta']);
  assert.deepEqual(sections.filter((section) => section.advanced).map((section) => section.id), ['beta']);
  assert.deepEqual(sections.filter((section) => section.lazy).map((section) => section.id), ['beta']);
  assert.equal(registry.normalizeSectionId('missing'), 'alpha');
});

test('custom registry orders sections by order with input position as the tie-breaker', () => {
  const registry = createSettingsSectionRegistry([
    { id: 'late', label: 'Late', group: 'g', order: 2 },
    { id: 'early-a', label: 'Early A', group: 'g', order: 1 },
    { id: 'early-b', label: 'Early B', group: 'g', order: 1 },
  ], [
    { id: 'g', label: 'Group' },
  ]);

  assert.deepEqual(registry.getSections().map((section) => section.id), ['early-a', 'early-b', 'late']);
  assert.deepEqual(registry.getGroups()[0].sections.map((section) => section.id), ['early-a', 'early-b', 'late']);
});
