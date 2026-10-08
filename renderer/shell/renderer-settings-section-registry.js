/* renderer/shell/renderer-settings-section-registry.js - Canonical Settings section + group metadata.
 *
 * This module is the SINGLE source of truth for the Settings nav: which sections
 * exist, what group/order they belong to, their labels, and lazy flags.
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
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const SETTINGS_STORAGE_KEY = 'jenny.settings.activeSection';
  const DEFAULT_SETTINGS_SECTION = 'models';
  const SETTINGS_SECTION_ALIASES = Object.freeze({
    cost: 'usage',
    // 2026-09-21: the Model library was folded into Models; stored deep links still name it.
    modelLibrary: 'models',
    // 2026-10-05: Plugins & Extensions became Extensions when the plugin platform was retired.
    plugins: 'extensions',
  });

  /* Top-level nav groups, in render order. */
  const SETTINGS_GROUP_DEFINITIONS = Object.freeze([
    { id: 'modelTools', label: jt('settings.sections.modelTools.title', 'Model & tools'), order: 0 },
    { id: 'work', label: jt('settings.sections.work.title', 'Work'), order: 1 },
    { id: 'context', label: jt('settings.sections.contextMemory.title', 'Context & memory'), order: 2 },
    { id: 'app', label: jt('settings.sections.app.title', 'App'), order: 3 },
    { id: 'system', label: jt('settings.sections.system.title', 'System'), order: 4 },
    { id: 'developer', label: jt('settings.sections.developer.title', 'Developer'), order: 5 },
  ].map((group) => Object.freeze(group)));

  const SETTINGS_SECTION_DEFINITIONS = Object.freeze([
    // --- Model & tools: readiness overview first. Status-only (never dirty); the
    // control-tower utils paint its nav-rail count badge from the same model
    // that renders the card, so the rail says when the page has something to say.
    {
      id: 'readiness',
      group: 'modelTools',
      order: -1,
      label: jt('settings.sections.readiness.title', 'Readiness'),
      domKey: 'readiness',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    // Runs moved to Diagnostics › Runs (owner, 2026-10-03); a stored `runs`
    // section falls back to the default like any unknown id.
    // --- Model & tools: per-conversation AI runtime ---
    {
      id: 'models',
      group: 'modelTools',
      label: jt('settings.sections.models.title', 'Models'),
      domKey: 'models',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
      default: true,
      // The Model library grid lives in this card since 2026-09-21; keep its
      // old name (and what people pull/add there) reachable from search.
      keywords: [jt('settings.sections.models.keywords.modelLibrary', 'model library'), 'library', 'pull', 'gguf'],
    },
    {
      id: 'offline',
      group: 'modelTools',
      label: jt('settings.sections.offline.title', 'Offline'),
      domKey: 'offline',
      lazy: true,
      refreshPolicy: 'offline',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'context',
      group: 'context',
      label: jt('settings.sections.context.title', 'Context'),
      domKey: 'context',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'tools',
      group: 'modelTools',
      label: jt('settings.sections.tools.title', 'Tools'),
      domKey: 'tools',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'skills',
      group: 'modelTools',
      label: jt('settings.sections.skills.title', 'Skills'),
      domKey: 'skills',
      navItemId: 'skillsSettingsNavItem',
      lazy: true,
      // Merged into Extensions as a subsection: skills keeps its full lazy
      // lifecycle (MCP discovery stays deferred) but no longer renders its own
      // nav item. The Extensions host readies + refreshes it as a companion on reveal.
      hidden: true,
      mergedInto: 'extensions',
      refreshPolicy: 'skills',
      diagnosticsLifecycle: 'none',
    },
    // --- Context & memory: Jenny's identity and memories ---
    {
      id: 'memories',
      group: 'context',
      label: jt('settings.sections.memories.title', 'Memory'),
      domKey: 'memories',
      lazy: true,
      refreshPolicy: 'memories',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'personality',
      group: 'context',
      label: jt('settings.sections.personality.title', 'Personality'),
      domKey: 'personality',
      lazy: true,
      refreshPolicy: 'personality',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'appearance',
      group: 'app',
      label: jt('settings.sections.appearance.title', 'Appearance'),
      domKey: 'appearance',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    // --- App: the application surfaces & your account ---
    {
      id: 'editor',
      group: 'app',
      label: jt('settings.sections.editor.title', 'Editor'),
      domKey: 'editor',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'home',
      group: 'app',
      label: jt('settings.sections.home.title', 'Home'),
      domKey: 'home',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    // --- App: Notifications (owner-approved 2026-09-27, placement A): desktop
    // toasts while Jenny is in the background, one switch per category.
    {
      id: 'notifications',
      group: 'app',
      label: jt('settings.sections.notifications.title', 'Notifications'),
      domKey: 'notifications',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
      keywords: [jt('settings.sections.notifications.keywords.toast', 'toast'), jt('settings.sections.notifications.keywords.desktop', 'desktop'),
        jt('settings.sections.notifications.keywords.alerts', 'alerts'), jt('settings.sections.notifications.keywords.sound', 'sound'),
        jt('settings.sections.notifications.keywords.background', 'background')],
    },
    {
      // Owner-approved 2026-09-20 (Projects v2): this section is the project list.
      // The id stays `runtime` so persisted/deep-linked section ids keep resolving.
      id: 'runtime',
      group: 'work',
      label: jt('settings.sections.projects.title', 'Projects'),
      domKey: 'runtime',
      lazy: true,
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'usage',
      group: 'work',
      label: jt('settings.sections.usage.title', 'Usage'),
      domKey: 'usage',
      navItemId: 'usageSettingsNavItem',
      lazy: true,
      refreshPolicy: 'usage',
      diagnosticsLifecycle: 'none',
    },
    {
      // Skill folders (the merged skills section) and standalone MCP servers.
      id: 'extensions',
      group: 'system',
      label: jt('settings.sections.extensions.title', 'Extensions'),
      domKey: 'extensions',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'account',
      group: 'system',
      label: jt('settings.sections.account.title', 'Profile, data & updates'),
      domKey: 'account',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'dataPrivacy',
      group: 'system',
      label: jt('settings.sections.dataPrivacy.title', 'Data & Privacy'),
      domKey: 'dataPrivacy',
      hidden: true,
      mergedInto: 'account',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    {
      id: 'aboutUpdates',
      group: 'system',
      label: jt('settings.sections.aboutUpdates.title', 'About & Updates'),
      domKey: 'aboutUpdates',
      hidden: true,
      mergedInto: 'account',
      refreshPolicy: 'render',
      diagnosticsLifecycle: 'none',
    },
    // --- Developer: expert engine tuning ---
    {
      id: 'advanced',
      group: 'developer',
      label: jt('settings.sections.advanced.title', 'Limits & budgets'),
      domKey: 'advanced',
      // ~28 numeric fields have no business on the boot path.
      lazy: true,
      refreshPolicy: 'advanced',
      diagnosticsLifecycle: 'none',
    },
    {
      // Runtime limits (moved out of the Projects page 2026-09-20; the work list
      // moved to Session › Runs 2026-09-27). Its scripts load lazily on first
      // bind, so this section spends no startup script slot.
      id: 'runtimeLimits',
      group: 'developer',
      label: jt('settings.sections.runtimeLimits.title', 'Runtime limits'),
      domKey: 'runtimeLimits',
      hidden: true,
      mergedInto: 'advanced',
      lazy: true,
      refreshPolicy: 'render',
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
      group: String(definition.group || 'app'),
      label: String(definition.label || id),
      domKey: String(definition.domKey || id),
      navItemId: definition.navItemId ? String(definition.navItemId) : '',
      lazy: Boolean(definition.lazy),
      // A `hidden` section exists for lifecycle purposes but renders no nav item
      // (it has been merged into its `mergedInto` host as a subsection).
      hidden: Boolean(definition.hidden),
      mergedInto: definition.mergedInto ? String(definition.mergedInto) : '',
      default: Boolean(definition.default),
      refreshPolicy: String(definition.refreshPolicy || 'render'),
      diagnosticsLifecycle: String(definition.diagnosticsLifecycle || 'none'),
      order: normalizeOrder(definition.order, index),
      // Extra search terms for renderer-settings-search.js (a folded-in
      // section's old name, what people do in the card). Plain strings.
      keywords: Object.freeze(Array.isArray(definition.keywords)
        ? definition.keywords.map((keyword) => String(keyword)).filter(Boolean)
        : []),
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
    isLazySettingsSection: registry.isLazySection,
  };
});
