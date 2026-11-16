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
    'jennyChat',
    'dictation',
    'offline',
    'usage',
    'runtime',
    'extensions',
    'account',
    'dataPrivacy',
    'aboutUpdates',
    'advanced',
    'runtimeLimits',
    'team',
    'general',
    'chat',
    'permissions',
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
  assert.deepEqual(work, ['runtime', 'team', 'usage']);
  // Search no longer finds a Runs page in Settings.
  for (const section of getSettingsSections()) {
    assert.equal((section.keywords || []).some((keyword) => /^(runs|orchestration|subagents)$/i.test(String(keyword))), false, section.id);
  }
  // Deep links keep resolving: the Developer limits page and Projects keep their ids.
  assert.equal(getSettingsSectionDefinition('runtimeLimits').label, 'Runtime limits');
  assert.equal(getSettingsSectionDefinition('runtimeLimits').group, 'system');
  assert.equal(normalizeSettingsSectionId('runtime'), 'runtime');
});

test('settings section registry exposes the five rail groups of row 133 (overview unlabelled)', () => {
  const groups = getSettingsGroups();
  assert.deepEqual(groups.map(group => [group.id, group.label, group.sections.map(section => section.id)]), [
    ['overview', '', ['readiness']],
    ['jenny', 'Jenny', ['models', 'permissions', 'tools', 'extensions', 'memories', 'personality']],
    ['app', 'App', ['general', 'appearance', 'chat', 'editor', 'notifications']],
    ['work', 'Work', ['runtime', 'team', 'usage']],
    ['system', 'System', ['account', 'aboutUpdates', 'advanced']],
  ]);
  assert.ok(groups.every(group => !group.disclosure));
  assert.equal(getSettingsSectionDefinition('account').label, 'Data & privacy');
  assert.equal(getSettingsSectionDefinition('dataPrivacy').label, 'Data & Privacy', 'the old key stays with its companion');
  assert.equal(getSettingsSectionDefinition('aboutUpdates').label, 'About');
  assert.equal(getSettingsSectionDefinition('permissions').label, 'Permissions');
  assert.equal(getSettingsSectionDefinition('permissions').lazy, false);
  assert.equal(getSettingsSectionDefinition('advanced').label, 'Limits');
  assert.equal(getSettingsSectionDefinition('general').label, 'General');
  assert.equal(getSettingsSectionDefinition('chat').label, 'Chat');
  for (const id of ['general', 'chat', 'permissions', 'aboutUpdates']) {
    assert.equal(getSettingsSectionDefinition(id).hidden, false, id);
    assert.equal(normalizeSettingsSectionId(id), id);
  }
  assert.equal(getSettingsSectionDefinition('runtime').label, 'Projects');
  assert.equal(getSettingsSectionDefinition('memories').lazy, true);
});

test('Team page (row 123, slice 1g-1) follows Projects and is shown only with the team flag', () => {
  const section = getSettingsSectionDefinition('team');
  assert.equal(section.label, 'Team');
  assert.equal(section.group, 'work');
  assert.equal(section.featureFlag, 'team');
  assert.equal(Boolean(section.lazy), false);
  assert.equal(getSettingsSectionDefinition('runtime').featureFlag, '', 'no other section is gated');
  for (const word of ['invite', 'host', 'server', 'members']) assert.ok(section.keywords.includes(word), word);
});

test('row 133 merged pages keep their old search words on the host page', () => {
  const words = (id) => getSettingsSectionDefinition(id).keywords;
  for (const word of ['digest', 'away', 'voice', 'microphone', 'speech', 'talk']) assert.ok(words('chat').includes(word), word);
  assert.ok(words('notifications').includes('quiet hours'));
  for (const word of ['home', 'quick capture']) assert.ok(words('general').includes(word), word);
  for (const word of ['offline', 'local only']) assert.ok(words('models').includes(word), word);
  assert.equal(words('jennyChat').includes('quiet hours'), false);
  for (const word of ['approval', 'safety mode', 'run mode', 'auto']) assert.ok(words('permissions').includes(word), word);
  assert.deepEqual(words('tools').filter((word) => /approv|safety|run mode|^auto$/i.test(word)), []);
});

test('About is its own page and Permissions sits after Models (row 133, slice 3)', () => {
  assert.equal(normalizeSettingsSectionId('aboutUpdates'), 'aboutUpdates');
  assert.equal(normalizeSettingsSectionId('permissions'), 'permissions');
  assert.equal(getSettingsSectionDefinition('aboutUpdates').mergedInto, '');
  assert.equal(getSettingsSectionDefinition('permissions').group, 'jenny');
  assert.deepEqual(getSettingsCompanionSectionIds('aboutUpdates'), []);
  assert.deepEqual(getSettingsCompanionSectionIds('permissions'), []);
});

test('merged pages normalize to hosts and retain companion lifecycle metadata', () => {
  for (const [id, host] of [
    ['dataPrivacy', 'account'], ['runtimeLimits', 'advanced'],
    ['offline', 'models'], ['home', 'general'], ['dictation', 'chat'], ['context', 'chat'], ['jennyChat', 'chat'],
  ]) {
    assert.equal(normalizeSettingsSectionId(id), host);
    assert.equal(getSettingsSectionDefinition(id).hidden, true);
    assert.equal(getSettingsSectionDefinition(id).mergedInto, host);
    assert.equal(getSettingsSectionDefinition(id).group, getSettingsSectionDefinition(host).group, id);
  }
  assert.deepEqual(getSettingsCompanionSectionIds('account'), ['dataPrivacy']);
  assert.deepEqual(getSettingsCompanionSectionIds('advanced'), ['runtimeLimits']);
  assert.deepEqual(getSettingsCompanionSectionIds('models'), ['offline']);
  assert.deepEqual(getSettingsCompanionSectionIds('general'), ['home']);
  assert.deepEqual(getSettingsCompanionSectionIds('chat'), ['context', 'jennyChat', 'dictation']);
  assert.equal(getSettingsSectionDefinition('offline').lazy, true);
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
  // A persisted/deep-linked hidden section resolves to its host (no blank panel).
  assert.equal(normalizeSettingsSectionId('skills'), 'extensions');
  assert.equal(normalizeSettingsSectionId('tips'), 'models');
});

test('settings section registry keeps Home known so it opens General, not the default', () => {
  // Regression: `home` was historically absent from the registry, so
  // normalizeSettingsSectionId('home') silently fell back to the default ('models').
  assert.equal(normalizeSettingsSectionId('home'), 'general');
  const home = getSettingsSectionDefinition('home');
  assert.equal(home.group, 'app');
  assert.equal(home.lazy, false);
  assert.equal(home.label, 'Home');
});

test('settings section registry registers Extensions in the Jenny group and retires plugins', () => {
  assert.equal(normalizeSettingsSectionId('extensions'), 'extensions');
  const extensions = getSettingsSectionDefinition('extensions');
  assert.equal(extensions.group, 'jenny');
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
