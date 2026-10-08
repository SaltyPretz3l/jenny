/* Composer tool-family state and serialized current-chat preference writes. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-composer-v2-model'));
    return;
  }
  root.rendererComposerV2Toggle = factory(root.rendererComposerV2Model);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
  'use strict';
  const { SURFACE_FAMILY_UI, normalizeToolEntry, familyLabel, familyDescription } = model;
  const jt = (...args) => (globalThis.jennyI18n?.t || globalThis.jennyI18nFallback || ((key, fallback) => fallback))(...args);
  const lockdownTooltip = () => jt('composer.toggle.offlineLockdown', 'Offline lockdown is on for this session');
  const isMap = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

  function sessionToolOverrideEchoMatches(persisted, sessionId, requested = {}) {
    const equalMap = (actual, expected = {}) => isMap(actual) && isMap(expected)
      && Object.keys(actual).length === Object.keys(expected).length
      && Object.keys(expected).every((key) => Object.hasOwn(actual, key) && actual[key] === expected[key]);
    return String(persisted?.id || '').trim() === String(sessionId || '').trim()
      && equalMap(persisted?.tool_category_overrides, requested.tool_category_overrides)
      && equalMap(persisted?.tool_connection_overrides, requested.tool_connection_overrides);
  }

  function createComposerV2ToggleController(deps = {}) {
    const state = deps.state || {};
    const getSessionId = () => String(deps.getCurrentSessionId?.() || state.currentSessionId || '').trim();
    const families = new Map();
    const connections = new Map();
    const defaults = new Map();
    let generation = 0;
    let persistenceQueue = Promise.resolve(true);
    let context = makeContext(getSessionId());

    function committedMaps(categoryOverrides, connectionOverrides) {
      const categories = {};
      const connected = {};
      for (const family of SURFACE_FAMILY_UI) {
        if (typeof categoryOverrides?.[family.id] === 'boolean') categories[family.id] = categoryOverrides[family.id];
      }
      // Preserve the backend's legacy local_browser preference when writing a full map.
      if (typeof categoryOverrides?.local_browser === 'boolean') categories.local_browser = categoryOverrides.local_browser;
      for (const [id, value] of Object.entries(isMap(connectionOverrides) ? connectionOverrides : {})) {
        if (id.startsWith('mcp:') && typeof value === 'boolean') connected[id] = value;
      }
      return { tool_category_overrides: categories, tool_connection_overrides: connected };
    }

    function makeContext(sessionId, categoryOverrides, connectionOverrides) {
      const committed = committedMaps(categoryOverrides, connectionOverrides);
      return { sessionId, generation: ++generation, revision: 0, revisions: new Map(), pending: [], committed,
        overrides: { tool_category_overrides: { ...committed.tool_category_overrides },
          tool_connection_overrides: { ...committed.tool_connection_overrides } } };
    }

    function isLockdown() {
      return state.features?.featureFlags?.session_offline_lockdown === true
        && state.sessions?.find((session) => String(session?.id || '').trim() === getSessionId())?.lockdown === true;
    }

    function setAvailableTools(entries) {
      families.clear();
      connections.clear();
      for (const raw of Array.isArray(entries) ? entries : []) {
        const entry = normalizeToolEntry(raw);
        if (!entry.name) continue;
        const member = { name: entry.name, available: entry.available, reason: entry.reason,
          approvalDefault: entry.approvalDefault, lockdownAvailable: entry.lockdownAvailable };
        if (SURFACE_FAMILY_UI.some((family) => family.id === entry.surfaceFamily)) {
          if (!families.has(entry.surfaceFamily)) families.set(entry.surfaceFamily, { members: [] });
          families.get(entry.surfaceFamily).members.push(member);
        }
        if (entry.connectionId.startsWith('mcp:')) {
          if (!connections.has(entry.connectionId)) connections.set(entry.connectionId, {
            label: entry.serverName || entry.connectionId.slice(4),
            kind: 'mcp', members: [],
          });
          connections.get(entry.connectionId).members.push(member);
        }
      }
    }

    function hydrateFromToolSettings(settings) {
      for (const family of SURFACE_FAMILY_UI) {
        defaults.set(family.id, family.configKey && typeof settings?.[family.configKey] === 'boolean' ? settings[family.configKey] : true);
      }
    }

    function hydrateForSession(sessionId, categoryOverrides, connectionOverrides) {
      const id = String(sessionId || '').trim();
      if (id !== context.sessionId) {
        context = makeContext(id, categoryOverrides, connectionOverrides);
        return;
      }
      // Same chat: a summary refresh (our own save's echo included) must not drop queued
      // writes; adopt the stored maps only once the queue has drained.
      if (context.pending.length) return;
      context.committed = committedMaps(categoryOverrides, connectionOverrides);
      rebuildOptimistic(context);
    }

    function applyOperation(maps, operation) {
      if (operation.id === 'reset') return { tool_category_overrides: {}, tool_connection_overrides: {} };
      return { ...maps, [operation.map]: { ...maps[operation.map], [operation.id]: operation.enabled } };
    }

    function rebuildOptimistic(target) {
      target.overrides = target.pending.reduce(applyOperation, target.committed);
    }

    function enqueue(operation) {
      const target = context;
      const sessionId = getSessionId();
      const revision = ++target.revision;
      target.revisions.set(operation.id, revision);
      target.pending.push(operation);
      rebuildOptimistic(target);
      const persist = async () => {
        const requested = applyOperation(target.committed, operation);
        let success = false;
        let failure;
        try {
          await deps.persistSessionToolPreference?.(requested, sessionId);
          target.committed = requested;
          success = true;
        } catch (error) {
          failure = error;
        }
        target.pending = target.pending.filter((item) => item !== operation);
        // Replay newer revisions over the acknowledged maps, including after rollback.
        rebuildOptimistic(target);
        const isCurrent = target.generation === context.generation && sessionId === getSessionId();
        if (failure) deps.onPersistError?.(failure, operation.id, { isCurrent,
          revision: target.revisions.get(operation.id) });
        return success;
      };
      const result = persistenceQueue.then(persist, persist);
      persistenceQueue = result;
      return result;
    }

    function setToggle(id, enabled) {
      const group = families.get(id) || connections.get(id);
      if (!group || (isLockdown() && !group.members.some((member) => member.lockdownAvailable))) return Promise.resolve(false);
      return enqueue({ id, enabled: enabled === true,
        map: families.has(id) ? 'tool_category_overrides' : 'tool_connection_overrides' });
    }

    function resetToDefaults() {
      return enqueue({ id: 'reset' });
    }

    function effective(id, connection = false) {
      const overrides = context.overrides[connection ? 'tool_connection_overrides' : 'tool_category_overrides'];
      if (connection) return overrides[id] ?? true;
      // Legacy coverage: Files off also keeps Artifacts off unless the chat set Artifacts itself.
      if (id === 'artifacts' && !Object.hasOwn(overrides, id) && overrides.files === false) return false;
      return overrides[id] ?? defaults.get(id) ?? true;
    }

    // The send payload is this chat's stored overrides as they stand optimistically; the
    // resolver owns defaults and legacy coverage, and config gates own Settings-off tools.
    function getToggleStates() {
      return { families: { ...context.overrides.tool_category_overrides },
        connections: { ...context.overrides.tool_connection_overrides } };
    }

    function describe(id, group, connection, lockdown) {
      const members = group.members.map((member) => ({ name: member.name,
        usable: member.available && (!lockdown || member.lockdownAvailable),
        reason: lockdown && !member.lockdownAvailable ? lockdownTooltip() : member.reason,
        asksFirst: member.approvalDefault === 'ask' }));
      const usable = members.filter((member) => member.usable).length;
      const on = effective(id, connection);
      return { id, on, overridden: Object.hasOwn(context.overrides[connection ? 'tool_connection_overrides' : 'tool_category_overrides'], id),
        usable, total: members.length, state: usable === 0 ? 'blocked' : on ? 'on' : 'off',
        reason: usable === 0 ? (members[0]?.reason || (lockdown ? lockdownTooltip() : '')) : '',
        members, approval: members.some((member) => member.asksFirst) ? 'some' : 'none' };
    }

    function getViewModel() {
      const lockdown = isLockdown();
      return { lockdown, sections: ['project', 'create', 'reach'].map((id) => ({ id,
        families: SURFACE_FAMILY_UI.filter((family) => family.section === id && families.has(family.id)).map((family) => ({
          ...describe(family.id, families.get(family.id), false, lockdown),
          label: familyLabel(family.id), description: familyDescription(family.id), icon: family.icon,
        })),
      })), connections: [...connections].map(([id, group]) => {
        const { members, approval, ...row } = describe(id, group, true, lockdown);
        return { ...row, label: group.label, kind: group.kind };
      }), hasOverrides: Object.values(context.overrides).some((map) => Object.keys(map).length > 0) };
    }

    function getToolsChipCount() {
      const vm = getViewModel();
      const rows = [...vm.sections.flatMap((section) => section.families), ...vm.connections];
      const on = rows.filter((row) => row.on && row.usable > 0).length;
      return { on, present: rows.length, text: String(on) };
    }

    hydrateFromToolSettings({});
    return { setAvailableTools, hydrateFromToolSettings, hydrateForSession, setToggle, resetToDefaults,
      getToggleStates, getToolsChipCount, getViewModel };
  }
  return { createComposerV2ToggleController, sessionToolOverrideEchoMatches };
});
