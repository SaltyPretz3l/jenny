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

  /* Top-level nav groups, in render order (row 133). `overview` has no label: the
   * rail renders no group heading for it and the picker lists its page ungrouped. */
  const SETTINGS_GROUP_DEFINITIONS = Object.freeze([
    { id: 'overview', label: '', order: 0 },
    { id: 'jenny', label: jt('settings.sections.jenny.title', 'Jenny'), order: 1 },
    { id: 'app', label: jt('settings.sections.app.title', 'App'), order: 2 },
    { id: 'work', label: jt('settings.sections.work.title', 'Work'), order: 3 },
    { id: 'system', label: jt('settings.sections.system.title', 'System'), order: 4 },
  ].map((group) => Object.freeze(group)));

  const SETTINGS_SECTION_DEFINITIONS = Object.freeze([
    // --- Overview: readiness reports on every group, so it sits above them. Status-only
    // (never dirty); the control-tower utils paint its nav-rail count badge from the
    // same model that renders the card, so the rail says when the page has something to say.
    {
      id: 'readiness',
      group: 'overview',
      order: -1,
      label: jt('settings.sections.readiness.title', 'Readiness'),
    },
    // Runs moved to Diagnostics › Runs (owner, 2026-10-03); a stored `runs`
    // section falls back to the default like any unknown id.
    // --- Jenny: what the model is, can use and remembers ---
    {
      id: 'models',
      group: 'jenny',
      label: jt('settings.sections.models.title', 'Models'),
      default: true,
      // The Model library grid lives in this card since 2026-09-21 and the Offline page
      // since row 133; keep their old names (and what people pull/add there) reachable from search.
      keywords: [jt('settings.sections.models.keywords.modelLibrary', 'model library'), 'library', 'pull', 'gguf',
        jt('settings.sections.models.keywords.offline', 'offline'), jt('settings.sections.models.keywords.localOnly', 'local only')],
    },
    {
      // Row 133: the Offline page is the "Local only" group of Models. It keeps its lazy
      // lifecycle; the Models host readies + refreshes it as a companion.
      id: 'offline',
      group: 'jenny',
      label: jt('settings.sections.offline.title', 'Offline'),
      lazy: true,
      hidden: true,
      mergedInto: 'models',
    },
    {
      // Row 133: what Jenny may do without asking (run mode default, safety mode, Auto limits,
      // saved approval rules), split out of Tools.
      id: 'permissions',
      group: 'jenny',
      label: jt('settings.sections.permissions.title', 'Permissions'),
      keywords: [jt('settings.sections.permissions.keywords.approval', 'approval'), jt('settings.sections.permissions.keywords.safetyMode', 'safety mode'),
        jt('settings.sections.permissions.keywords.runMode', 'run mode'), jt('settings.sections.permissions.keywords.auto', 'auto'),
        jt('settings.sections.permissions.keywords.alwaysAllow', 'always allow')],
    },
    {
      id: 'tools',
      group: 'jenny',
      label: jt('settings.sections.tools.title', 'Tools'),
    },
    {
      // Skill folders (the merged skills section) and standalone MCP servers.
      id: 'extensions',
      group: 'jenny',
      label: jt('settings.sections.extensions.title', 'Extensions'),
    },
    {
      id: 'skills',
      group: 'jenny',
      label: jt('settings.sections.skills.title', 'Skills'),
      navItemId: 'skillsSettingsNavItem',
      lazy: true,
      // Merged into Extensions as a subsection: skills keeps its full lazy
      // lifecycle (MCP discovery stays deferred) but no longer renders its own
      // nav item. The Extensions host readies + refreshes it as a companion on reveal.
      hidden: true,
      mergedInto: 'extensions',
    },
    {
      id: 'memories',
      group: 'jenny',
      label: jt('settings.sections.memories.title', 'Memory'),
      lazy: true,
    },
    {
      id: 'personality',
      group: 'jenny',
      label: jt('settings.sections.personality.title', 'Personality'),
      lazy: true,
    },
    // --- App: how the application behaves and looks ---
    {
      // Row 133: app-wide behaviour. Holds the Home page's Quick capture group for now.
      id: 'general',
      group: 'app',
      label: jt('settings.sections.general.title', 'General'),
      keywords: [jt('settings.sections.general.keywords.home', 'home'), jt('settings.sections.general.keywords.quickCapture', 'quick capture'),
        jt('settings.sections.general.keywords.profile', 'profile')],
    },
    {
      id: 'home',
      group: 'app',
      label: jt('settings.sections.home.title', 'Home'),
      hidden: true,
      mergedInto: 'general',
    },
    {
      id: 'appearance',
      group: 'app',
      label: jt('settings.sections.appearance.title', 'Appearance'),
    },
    {
      // Row 133: how chats behave. Takes in the Context, Jenny chat (row 86) and
      // Dictation (row 84) pages, which stay known as hidden companions.
      id: 'chat',
      group: 'app',
      label: jt('settings.sections.chat.title', 'Chat'),
      keywords: [jt('settings.sections.jennyChat.keywords.digest', 'digest'), jt('settings.sections.jennyChat.keywords.away', 'away'),
        jt('settings.sections.jennyChat.keywords.summary', 'summary'),
        jt('settings.sections.dictation.keywords.voice', 'voice'), jt('settings.sections.dictation.keywords.microphone', 'microphone'),
        jt('settings.sections.dictation.keywords.speech', 'speech'), jt('settings.sections.dictation.keywords.talk', 'talk')],
    },
    {
      id: 'context',
      group: 'app',
      label: jt('settings.sections.context.title', 'Context'),
      hidden: true,
      mergedInto: 'chat',
    },
    {
      id: 'jennyChat',
      group: 'app',
      label: jt('settings.sections.jennyChat.title', 'Jenny chat'),
      hidden: true,
      mergedInto: 'chat',
    },
    {
      id: 'dictation',
      group: 'app',
      label: jt('settings.sections.dictation.title', 'Dictation'),
      hidden: true,
      mergedInto: 'chat',
    },
    {
      id: 'editor',
      group: 'app',
      label: jt('settings.sections.editor.title', 'Editor'),
    },
    // --- App: Notifications (owner-approved 2026-09-27, placement A): desktop
    // toasts while Jenny is in the background, one switch per category. Quiet hours
    // moved here from Jenny chat in row 133.
    {
      id: 'notifications',
      group: 'app',
      label: jt('settings.sections.notifications.title', 'Notifications'),
      keywords: [jt('settings.sections.notifications.keywords.toast', 'toast'), jt('settings.sections.notifications.keywords.desktop', 'desktop'),
        jt('settings.sections.notifications.keywords.alerts', 'alerts'), jt('settings.sections.notifications.keywords.sound', 'sound'),
        jt('settings.sections.notifications.keywords.background', 'background'), jt('settings.sections.jennyChat.keywords.quietHours', 'quiet hours')],
    },
    {
      // Owner-approved 2026-09-20 (Projects v2): this section is the project list.
      // The id stays `runtime` so persisted/deep-linked section ids keep resolving.
      id: 'runtime',
      group: 'work',
      label: jt('settings.sections.projects.title', 'Projects'),
      lazy: true,
    },
    {
      // Team (row 123, slice 1g-1): host a team or join one. Shown only while the
      // `team` flag is on: the nav item renders hidden and the flag state shows it
      // (renderer-settings-nav-utils.js `syncFeatureFlaggedSettings`).
      id: 'team',
      group: 'work',
      label: jt('settings.sections.team.title', 'Team'),
      featureFlag: 'team',
      keywords: [jt('settings.sections.team.keywords.invite', 'invite'), jt('settings.sections.team.keywords.host', 'host'),
        jt('settings.sections.team.keywords.server', 'server'), jt('settings.sections.team.keywords.members', 'members')],
    },
    {
      id: 'usage',
      group: 'work',
      label: jt('settings.sections.usage.title', 'Usage'),
      navItemId: 'usageSettingsNavItem',
      lazy: true,
    },
    {
      // Row 133: the Profile page became Data & privacy (the profile name moved to General,
      // setup to Readiness, About to its own page). The id stays `account`.
      id: 'account',
      group: 'system',
      label: jt('settings.sections.dataAndPrivacy.title', 'Data & privacy'),
      keywords: [jt('settings.sections.dataAndPrivacy.keywords.backup', 'backup'), jt('settings.sections.dataAndPrivacy.keywords.restore', 'restore'),
        jt('settings.sections.dataAndPrivacy.keywords.archive', 'archive'), jt('settings.sections.dataAndPrivacy.keywords.uninstall', 'uninstall')],
    },
    {
      id: 'dataPrivacy',
      group: 'system',
      label: jt('settings.sections.dataPrivacy.title', 'Data & Privacy'),
      hidden: true,
      mergedInto: 'account',
    },
    {
      // Row 133: version, updates and the command-line tool, its own page again.
      id: 'aboutUpdates',
      group: 'system',
      label: jt('settings.sections.about.title', 'About'),
      keywords: [jt('settings.sections.about.keywords.version', 'version'), jt('settings.sections.about.keywords.updates', 'updates')],
    },
    // --- System: expert engine tuning (the Developer group until row 133) ---
    {
      id: 'advanced',
      group: 'system',
      label: jt('settings.sections.limits.title', 'Limits'),
      // ~28 numeric fields have no business on the boot path.
      lazy: true,
    },
    {
      // Runtime limits (moved out of the Projects page 2026-09-20; the work list
      // moved to Session › Runs 2026-09-27). Its scripts load lazily on first
      // bind, so this section spends no startup script slot.
      id: 'runtimeLimits',
      group: 'system',
      label: jt('settings.sections.runtimeLimits.title', 'Runtime limits'),
      hidden: true,
      mergedInto: 'advanced',
      lazy: true,
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
      navItemId: definition.navItemId ? String(definition.navItemId) : '',
      lazy: Boolean(definition.lazy),
      // A `hidden` section exists for lifecycle purposes but renders no nav item
      // (it has been merged into its `mergedInto` host as a subsection).
      hidden: Boolean(definition.hidden),
      mergedInto: definition.mergedInto ? String(definition.mergedInto) : '',
      // A feature flag key: the nav item and card show only while that flag is on.
      featureFlag: definition.featureFlag ? String(definition.featureFlag) : '',
      default: Boolean(definition.default),
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
      // An empty label stays empty: that group renders no heading in the rail.
      label: group.label === '' ? '' : String(group.label || id),
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
