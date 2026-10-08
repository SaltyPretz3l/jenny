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

test('settings section registry preserves ids and defaults', () => {
  assert.equal(DEFAULT_SETTINGS_SECTION, 'models');
  assert.deepEqual(listSectionIds().sort(), [
    'readiness',
    'models',
    'context',
    'tools',
    'skills',
    'personality',
    'appearance',
    'memories',
    'editor',
    'home',
    'notifications',
    'offline',
    'usage',
    'runtime',
    'extensions',
    'account',
    'dataPrivacy',
    'aboutUpdates',
    'advanced',
    'runtimeLimits',
  ].sort());
  assert.equal(normalizeSettingsSectionId('not-a-section'), 'models');
  assert.equal(normalizeSettingsSectionId(' tools '), 'tools');
  assert.equal(normalizeSettingsSectionId('cost'), 'usage');
  assert.equal(normalizeSettingsSectionId('modelLibrary'), 'models');
});

test('settings section registry classifies lazy sections', () => {
  assert.deepEqual(getSettingsSections().filter((section) => section.lazy).map((section) => section.id).sort(), [
    'skills',
    'personality',
    'memories',
    'offline',
    'usage',
    'runtime',
    'advanced',
    'runtimeLimits',
  ].sort());
  assert.equal(getSettingsSectionDefinition('diagnostics'), null);
  assert.equal(getSettingsSectionDefinition('harness'), null);
  assert.equal(getSettingsSectionDefinition('dev_diagnostics'), null);
  assert.equal(getSettingsSectionDefinition('tools').lazy, false);
});

test('Runs lives in Diagnostics, not Settings (owner, 2026-10-03)', () => {
  assert.equal(getSettingsSectionDefinition('runs'), null);
  // A stored or deep-linked `runs` section opens the default section.
  assert.equal(normalizeSettingsSectionId('runs'), 'models');
  const work = getSettingsGroups().find((group) => group.id === 'work').sections.map((section) => section.id);
  assert.deepEqual(work, ['runtime', 'usage']);
  // Search no longer finds a Runs page in Settings.
  for (const section of getSettingsSections()) {
    assert.equal((section.keywords || []).some((keyword) => /^(runs|orchestration|subagents)$/i.test(String(keyword))), false, section.id);
  }
  // Deep links keep resolving: the Developer limits page and Projects keep their ids.
  assert.equal(getSettingsSectionDefinition('runtimeLimits').label, 'Runtime limits');
  assert.equal(getSettingsSectionDefinition('runtimeLimits').group, 'developer');
  assert.equal(normalizeSettingsSectionId('runtime'), 'runtime');
});

test('settings section registry exposes six uniform ordered groups', () => {
  const groups = getSettingsGroups();
  assert.deepEqual(groups.map(group => [group.id, group.label, group.sections.map(section => section.id)]), [
    ['modelTools', 'Model & tools', ['readiness', 'models', 'offline', 'tools']],
    ['work', 'Work', ['runtime', 'usage']],
    ['context', 'Context & memory', ['context', 'memories', 'personality']],
    ['app', 'App', ['appearance', 'editor', 'home', 'notifications']],
    ['system', 'System', ['extensions', 'account']],
    ['developer', 'Developer', ['advanced']],
  ]);
  assert.ok(groups.every(group => !group.disclosure));
  assert.equal(getSettingsSectionDefinition('account').label, 'Profile, data & updates');
  assert.equal(getSettingsSectionDefinition('advanced').label, 'Limits & budgets');
  assert.equal(getSettingsSectionDefinition('runtime').label, 'Projects');
  assert.equal(getSettingsSectionDefinition('memories').lazy, true);
});

test('merged pages normalize to hosts and retain companion lifecycle metadata', () => {
  for (const [id, host] of [['dataPrivacy', 'account'], ['aboutUpdates', 'account'], ['runtimeLimits', 'advanced']]) {
    assert.equal(normalizeSettingsSectionId(id), host);
    assert.equal(getSettingsSectionDefinition(id).hidden, true);
    assert.equal(getSettingsSectionDefinition(id).mergedInto, host);
  }
  assert.deepEqual(getSettingsCompanionSectionIds('account'), ['dataPrivacy', 'aboutUpdates']);
  assert.deepEqual(getSettingsCompanionSectionIds('advanced'), ['runtimeLimits']);
  assert.equal(getSettingsSectionDefinition('advanced').lazy, true);
  assert.equal(getSettingsSectionDefinition('runtimeLimits').lazy, true);
});

test('settings section registry merges skills into extensions and retires tips/proactive sections', () => {
  const skills = getSettingsSectionDefinition('skills');
  // Merged-away sections stay hidden-but-known and keep their lazy lifecycle so the
  // host card can ready + refresh them as companions (skills' MCP discovery stays deferred).
  assert.equal(skills.hidden, true);
  assert.equal(skills.mergedInto, 'extensions');
  assert.equal(skills.lazy, true);
  assert.equal(getSettingsSectionDefinition('tips'), null);
  assert.equal(getSettingsSectionDefinition('proactive'), null);
  assert.deepEqual(getSettingsCompanionSectionIds('extensions'), ['skills']);
  assert.deepEqual(getSettingsCompanionSectionIds('tools'), []);
  assert.deepEqual(getSettingsCompanionSectionIds('proactive'), []);
  assert.deepEqual(getSettingsCompanionSectionIds('models'), []);
  // A persisted/deep-linked hidden section resolves to its host (no blank panel).
  assert.equal(normalizeSettingsSectionId('skills'), 'extensions');
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

test('settings section registry registers Extensions in the System group and retires plugins', () => {
  assert.equal(normalizeSettingsSectionId('extensions'), 'extensions');
  const extensions = getSettingsSectionDefinition('extensions');
  assert.equal(extensions.group, 'system');
  assert.equal(extensions.label, 'Extensions');
  assert.equal(extensions.lazy, false);
  assert.equal(extensions.hidden, false);
  // The retired Plugins page has no definition; an old persisted id opens Extensions.
  assert.equal(getSettingsSectionDefinition('plugins'), null);
  assert.equal(normalizeSettingsSectionId('plugins'), 'extensions');
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
    { id: 'beta', label: 'Beta', lazy: true },
  ]);

  assert.equal(registry.defaultSectionId, 'alpha');
  const sections = registry.getSections();
  assert.deepEqual(sections.map((section) => section.id), ['alpha', 'beta']);
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
