/* renderer/shell/renderer-settings-section-registry.js - Canonical Settings section + group metadata.
 *
 * This module is the SINGLE source of truth for the Settings nav: which sections
 * exist, what group/order they belong to, their labels, and lazy/advanced flags.
 * The left-rail nav is rendered FROM this registry (see renderer-settings-nav-utils.js
 * `renderSettingsNav`), so editing the information architecture is a registry-only edit.
 * A parity test (tests/renderer-settings-section-registry.test.js) locks the shape.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsSectionRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SETTINGS_STORAGE_KEY = 'jenny.settings.activeSection';
  const DEFAULT_SETTINGS_SECTION = 'models';
  const SETTINGS_SECTION_ALIASES = Object.freeze({ cost: 'usage' });

  /* Top-level nav groups, in render order. `disclosure: true` renders the group
   * behind the collapsible "Developer" chevron instead of as an always-visible block. */
  const SETTINGS_GROUP_DEFINITIONS = Object.freeze([
    { id: 'session', label: 'Session', order: 0 },
    { id: 'companion', label: 'Companion', order: 1 },
    { id: 'app', label: 'App', order: 2 },
    { id: 'developer', label: 'Developer', order: 3, disclosure: true },
  ].map((group) => Object.freeze(group)));

  const SETTINGS_SECTION_DEFINITIONS = Object.freeze([
    // --- Session: readiness overview first. Status-only (never dirty); the
    // control-tower utils paint its nav-rail count badge from the same model
    // that renders the card, so the rail says when the page has something to say.
    {
      id: 'readiness',
      group: 'session',
      order: -1,
      label: 'Readiness',
      domKey: 'readiness',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    // --- Session: per-conversation AI runtime ---
    {
      id: 'models',
      group: 'session',
      label: 'Models',
      domKey: 'models',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
      default: true,
    },
    {
      id: 'modelLibrary',
      group: 'session',
      label: 'Model library',
      domKey: 'modelLibrary',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'context',
      group: 'session',
      label: 'Context',
      domKey: 'context',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'tools',
      group: 'session',
      label: 'Tools',
      domKey: 'tools',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'skills',
      group: 'session',
      label: 'Skills',
      domKey: 'skills',
      navItemId: 'skillsSettingsNavItem',
      lazy: true,
      // Merged into Plugins & Extensions as a subsection: skills keeps its full lazy
      // lifecycle (MCP discovery stays deferred) but no longer renders its own
      // nav item. The Plugins host readies + refreshes it as a companion on reveal.
      hidden: true,
      mergedInto: 'plugins',
      refreshPolicy: 'skills',
      diagnosticsLifecycle: 'none',
    },
    // --- Companion: Jenny's identity, look & proactivity ---
    {
      id: 'personality',
      group: 'companion',
      label: 'Personality',
      domKey: 'personality',
      lazy: true,
      refreshPolicy: 'personality',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'appearance',
      group: 'companion',
      label: 'Appearance',
      domKey: 'appearance',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'memories',
      group: 'companion',
      label: 'Memory',
      domKey: 'memories',
      lazy: true,
      refreshPolicy: 'memories',
      diagnosticsLifecycle: 'none',
    },
    // --- App: the application surfaces & your account ---
    {
      id: 'editor',
      group: 'app',
      label: 'Editor',
      domKey: 'editor',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'home',
      group: 'app',
      label: 'Home',
      domKey: 'home',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'offline',
      group: 'app',
      label: 'Offline',
      domKey: 'offline',
      lazy: true,
      refreshPolicy: 'offline',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'usage',
      group: 'app',
      label: 'Usage',
      domKey: 'usage',
      navItemId: 'usageSettingsNavItem',
      lazy: true,
      refreshPolicy: 'usage',
      diagnosticsLifecycle: 'none',
    },
    {
      // Plugin Manager (Stage 3B, owner-approved 2026-07-31): body group mounts
      // dynamically from renderer-plugins-settings.js. The nav item is
      // feature-gated at runtime (featureFlags.plugins,
      // default-off): the controller stamps data-feature-gated + hidden on it,
      // and renderer-settings-nav-utils resolveSectionId falls back to the
      // default section while it is hidden, so flag-off keeps the section absent.
      //
      // Ordered BEFORE `account` deliberately. nav-utils derives
      // LAST_NONADVANCED_SECTION from this registry at module load, and that
      // derivation cannot see runtime hiding — so a default-hidden section in
      // the last slot would leave the ArrowDown-to-Developer-disclosure jump
      // anchored to an item that is not on screen.
      id: 'plugins',
      group: 'app',
      label: 'Plugins & Extensions',
      domKey: 'plugins',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'account',
      group: 'app',
      label: 'Profile & Setup',
      domKey: 'account',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'dataPrivacy',
      group: 'app',
      label: 'Data & Privacy',
      domKey: 'dataPrivacy',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'aboutUpdates',
      group: 'app',
      label: 'About & Updates',
      domKey: 'aboutUpdates',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    // --- Developer: expert engine tuning, behind the Advanced disclosure ---
    {
      // `advanced: true` is load-bearing, not decorative. Group `disclosure`
      // renders the chevron, but nav-utils derives FIRST_ADVANCED_SECTION from
      // the SECTION-level flag - without it, ArrowDown off the last ordinary
      // section calls setActiveSection('') and lands nowhere. Keeping this entry
      // last also leaves LAST_NONADVANCED_SECTION correctly at `aboutUpdates`.
      id: 'advanced',
      group: 'developer',
      label: 'Advanced',
      domKey: 'advanced',
      advanced: true,
      // ~28 numeric fields have no business on the boot path.
      lazy: true,
      refreshPolicy: 'advanced',
      diagnosticsLifecycle: 'none',
    },
  ].map((definition) => Object.freeze(definition)));

  function normalizeOrder(rawValue, fallback) {
    const numeric = Number(rawValue);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function normalizeDefinition(definition, index) {
    const id = String(definition?.id || '').trim();
    if (!id) {
      throw new Error('Settings section id is required.');
    }
    return Object.freeze({
      id,
      group: String(definition.group || 'session'),
      label: String(definition.label || id),
      domKey: String(definition.domKey || id),
      navItemId: definition.navItemId ? String(definition.navItemId) : '',
      advanced: Boolean(definition.advanced),
      lazy: Boolean(definition.lazy),
      // A `hidden` section exists for lifecycle purposes but renders no nav item
      // (it has been merged into its `mergedInto` host as a subsection).
      hidden: Boolean(definition.hidden),
      mergedInto: definition.mergedInto ? String(definition.mergedInto) : '',
      default: Boolean(definition.default),
      refreshPolicy: String(definition.refreshPolicy || 'render'),
      diagnosticsLifecycle: String(definition.diagnosticsLifecycle || 'none'),
      order: normalizeOrder(definition.order, index),
    });
  }

  function normalizeGroup(group, index) {
    const id = String(group?.id || '').trim();
    if (!id) {
      throw new Error('Settings group id is required.');
    }
    return Object.freeze({
      id,
      label: String(group.label || id),
      disclosure: Boolean(group.disclosure),
      order: normalizeOrder(group.order, index),
    });
  }

  function createSettingsSectionRegistry(definitions, groupDefinitions, aliases = {}) {
    const normalized = [];
    const byId = new Map();
    const originalIndexById = new Map();
    const source = Array.isArray(definitions) ? definitions : [];
    for (let index = 0; index < source.length; index += 1) {
      const definition = normalizeDefinition(source[index], index);
      if (byId.has(definition.id)) {
        throw new Error(`Duplicate settings section id: ${definition.id}`);
      }
      normalized.push(definition);
      byId.set(definition.id, definition);
      originalIndexById.set(definition.id, index);
    }
    normalized.sort((a, b) => a.order - b.order
      || originalIndexById.get(a.id) - originalIndexById.get(b.id));

    const normalizedGroups = [];
    const groupById = new Map();
    const groupSource = Array.isArray(groupDefinitions) ? groupDefinitions : [];
    for (let index = 0; index < groupSource.length; index += 1) {
      const group = normalizeGroup(groupSource[index], index);
      if (groupById.has(group.id)) {
        throw new Error(`Duplicate settings group id: ${group.id}`);
      }
      normalizedGroups.push(group);
      groupById.set(group.id, group);
    }
    normalizedGroups.sort((a, b) => a.order - b.order);
    const aliasById = new Map(Object.entries(aliases || {}).map(([from, to]) => [
      String(from || '').trim(),
      String(to || '').trim(),
    ]));

    // Groups and their member sections are static once normalized — build the frozen
    // view once so getGroups() returns a stable reference instead of re-allocating.
    // Hidden (merged-away) sections are excluded from the nav-facing group view; they
    // remain reachable via getSectionDefinition/byId for their host's lifecycle.
    const frozenGroups = Object.freeze(normalizedGroups
      .map((group) => Object.freeze({
        ...group,
        sections: Object.freeze(
          normalized.filter((definition) => definition.group === group.id && !definition.hidden)
        ),
      }))
      .filter((group) => group.sections.length > 0));

    const defaultDefinition = normalized.find((definition) => definition.default) || normalized[0] || null;
    const defaultSectionId = defaultDefinition?.id || DEFAULT_SETTINGS_SECTION;

    function getSections() {
      return normalized.slice();
    }

    function getSectionDefinition(sectionId) {
      return byId.get(String(sectionId || '').trim()) || null;
    }

    function hasSection(sectionId) {
      return byId.has(String(sectionId || '').trim());
    }

    function normalizeSectionId(sectionId) {
      const requestedId = String(sectionId || '').trim();
      const id = aliasById.get(requestedId) || requestedId;
      const definition = byId.get(id);
      if (!definition) {
        return defaultSectionId;
      }
      // A hidden merged section resolves to its configured host instead of a blank panel.
      if (definition.hidden && definition.mergedInto && byId.has(definition.mergedInto)) {
        return definition.mergedInto;
      }
      return id;
    }

    /* Ordered groups, each carrying its (nav-visible) sections in registry order. Drives nav rendering. */
    function getGroups() {
      return frozenGroups;
    }

    /* Ids of hidden sections merged into the given host section. The host readies +
     * refreshes these companions when it is shown (see the shell controller). */
    function getCompanionSectionIds(hostId) {
      const host = String(hostId || '').trim();
      if (!host) {
        return [];
      }
      return normalized
        .filter((definition) => definition.mergedInto === host)
        .map((definition) => definition.id);
    }

    return Object.freeze({
      defaultSectionId,
      getSections,
      getSectionDefinition,
      hasSection,
      normalizeSectionId,
      getGroups,
      getCompanionSectionIds,
      isAdvancedSection(sectionId) {
        return Boolean(getSectionDefinition(sectionId)?.advanced);
      },
      isLazySection(sectionId) {
        return Boolean(getSectionDefinition(sectionId)?.lazy);
      },
    });
  }

  const registry = createSettingsSectionRegistry(
    SETTINGS_SECTION_DEFINITIONS,
    SETTINGS_GROUP_DEFINITIONS,
    SETTINGS_SECTION_ALIASES
  );

  return {
    SETTINGS_STORAGE_KEY,
    DEFAULT_SETTINGS_SECTION,
    SETTINGS_SECTION_ALIASES,
    SETTINGS_SECTION_DEFINITIONS,
    SETTINGS_GROUP_DEFINITIONS,
    createSettingsSectionRegistry,
    getSettingsSections: registry.getSections,
    getSettingsSectionDefinition: registry.getSectionDefinition,
    getSettingsGroups: registry.getGroups,
    getSettingsCompanionSectionIds: registry.getCompanionSectionIds,
    getDefaultSettingsSection() {
      return registry.defaultSectionId;
    },
    normalizeSettingsSectionId: registry.normalizeSectionId,
    isAdvancedSettingsSection: registry.isAdvancedSection,
    isLazySettingsSection: registry.isLazySection,
  };
});
