/* renderer/shell/renderer-command-palette-providers.js — UMD
 *
 * Owns every result source for the ⌘K / Ctrl+K palette and the scope table that
 * decides which groups a scope shows.
 *
 * snapshot() is called ONCE per open(), not per keystroke: nothing any provider
 * reads can change while the palette is up (it closes before running an item).
 *
 * Absent-safe throughout: a missing callback, a missing globalThis seam, or a
 * throwing provider yields [] for that source rather than breaking the palette.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCommandPaletteProviders = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ── Scopes ──
     `groups: null` means "every group". Tab cycles this list in order; the
     prefix characters below jump straight to one. */
  const SCOPES = [
    { id: 'all', label: '', groups: null },
    { id: 'chats', label: 'Chats', groups: ['Sessions'] },
    {
      id: 'commands',
      label: 'Commands',
      groups: ['Undo', 'Navigate', 'Actions', 'Workspace', 'Plugins', 'Skills', 'Slash commands', 'Help'],
    },
    { id: 'settings', label: 'Settings', groups: ['Settings'] },
  ];

  const SCOPE_PREFIXES = { '#': 'chats', '>': 'commands', '@': 'settings' };

  // Empty-query display order. Also the group order for the grouped view.
  const GROUP_ORDER = [
    'Undo', 'Navigate', 'Actions', 'Workspace', 'Plugins', 'Sessions', 'Settings', 'Skills', 'Slash commands', 'Help',
  ];

  // Row type word shown on the trailing edge. Sentence case, singular.
  const GROUP_TAGS = {
    Undo: 'Undo',
    Navigate: 'View',
    Actions: 'Action',
    Workspace: 'Command',
    Plugins: 'Plugin',
    Sessions: 'Chat',
    Settings: 'Setting',
    Skills: 'Skill',
    'Slash commands': 'Slash',
    Help: 'Help',
  };

  const GROUP_ICONS = {
    Undo: 'undo',
    Navigate: 'arrow',
    Actions: 'action',
    Workspace: 'code',
    Plugins: 'plug',
    Sessions: 'chat',
    Settings: 'gear',
    Skills: 'action',
    'Slash commands': 'slash',
    Help: 'help',
  };

  function groupOrder(groupName) {
    const index = GROUP_ORDER.indexOf(groupName);
    return index < 0 ? GROUP_ORDER.length : index;
  }

  function scopeAllows(scope, groupName) {
    if (!scope || !scope.groups) return true;
    return scope.groups.indexOf(groupName) !== -1;
  }

  function decorate(item) {
    const group = item.group || 'Actions';
    return Object.assign({}, item, {
      group,
      tag: item.tag || GROUP_TAGS[group] || '',
      icon: item.icon || GROUP_ICONS[group] || 'action',
    });
  }

  function safeList(fn) {
    try {
      const value = fn();
      return Array.isArray(value) ? value : [];
    } catch (_err) {
      return [];
    }
  }

  function createPaletteProviders(deps) {
    const {
      state = {},
      callbacks = {},
      globalRef = (typeof globalThis !== 'undefined' ? globalThis : {}),
    } = deps || {};

    const {
      setActiveView = function noop() {},
      focusDestinationView = function noop() {},
      activateWorkspaceSession = async function noop() {},
      listSlashCommands = function noop() { return []; },
      tryExecuteSlashCommand = function noop() { return false; },
      insertSlashCommand = function noop() { return false; },
      clickNewChat = function noop() {},
      focusConversationSearch = function noop() {},
      toggleSidebarCollapsed = function noop() {},
      togglePinActiveSession = function noop() {},
      toggleArchiveActiveSession = function noop() {},
      toggleArchivedView = function noop() {},
      sweepEmptyChats = function noop() {},
      listPendingUndos = function noop() { return []; },
      getIdeCommandItems = function noop() { return []; },
      getPluginCommandItems = function noop() { return []; },
      openKeyboardShortcuts = function noop() {},
      openSettingsSection = function noop() {},
    } = callbacks;

    // Built once on first use, then reused: the settings index is derived from
    // the static section registry + field-copy map, neither of which changes
    // at runtime (see renderer-settings-search.js's own header).
    let settingsIndexCache = null;

    // Every palette navigation must pair setActiveView with the UIUX-020 focus
    // landing; building the pair here means one can't drift from the other.
    function navigateTo(viewId) {
      return () => { setActiveView(viewId); focusDestinationView(viewId); };
    }

    function getNavigateItems() {
      return [
        { id: 'nav:home', group: 'Navigate', label: 'Home', description: 'Companion home view', hint: 'Ctrl 1', run: navigateTo('home') },
        { id: 'nav:chat', group: 'Navigate', label: 'Chat', description: 'Active conversation', hint: 'Ctrl 2', run: navigateTo('chat') },
        { id: 'nav:ide', group: 'Navigate', label: 'Workspace', description: 'File editor and Jenny change review', hint: 'Ctrl 3', run: navigateTo('ide') },
        { id: 'nav:logs', group: 'Navigate', label: 'Logs', description: 'Client and backend logs', hint: 'Ctrl 4', run: navigateTo('logs') },
        { id: 'nav:settings', group: 'Navigate', label: 'Settings', description: 'Models, personality, features', hint: 'Ctrl 5', run: navigateTo('settings') },
      ];
    }

    function getActionItems() {
      const items = [
        { id: 'action:new-chat', group: 'Actions', label: 'New chat', description: 'Start a fresh session', hint: null, run: () => { try { clickNewChat(); } catch (_err) { /* noop */ } } },
        { id: 'action:search-recents', group: 'Actions', label: 'Search recent chats', description: 'Focus the sidebar search input', hint: null, run: () => { try { focusConversationSearch(); } catch (_err) { /* noop */ } } },
        { id: 'action:workspace', group: 'Actions', label: 'Open workspace', description: 'Jump to the Workspace editor', hint: null, run: navigateTo('ide') },
        { id: 'action:toggle-sidebar', group: 'Actions', label: 'Toggle sidebar', description: 'Collapse or expand the sidebar rail', hint: null, run: () => { try { toggleSidebarCollapsed(); } catch (_err) { /* noop */ } } },
      ];
      // Labels resolve against live state at snapshot time, so Pin/Unpin and
      // Archive/Unarchive stay truthful for the session the palette opened over.
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      const currentSession = sessions.find((session) => session && session.id === state.currentSessionId) || null;
      if (currentSession) {
        items.push({
          id: 'action:pin-session',
          group: 'Actions',
          label: currentSession.pinned === true ? 'Unpin current chat' : 'Pin current chat',
          description: currentSession.pinned === true ? 'Drop the active chat out of PINNED' : 'Keep the active chat at the top of the panel',
          hint: null,
          run: () => { try { togglePinActiveSession(); } catch (_err) { /* noop */ } },
        });
        items.push({
          id: 'action:archive-session',
          group: 'Actions',
          label: currentSession.archived_at ? 'Unarchive current chat' : 'Archive current chat',
          description: currentSession.archived_at ? 'Bring the active chat back to recents' : 'Move the active chat into Archived',
          hint: null,
          run: () => { try { toggleArchiveActiveSession(); } catch (_err) { /* noop */ } },
        });
      }
      items.push({
        id: 'action:show-archived',
        group: 'Actions',
        label: (state.ui && state.ui.sidebarArchivedView === true) ? 'Back to recent chats' : 'Show archived chats',
        description: 'Toggle the archived view in the chats panel',
        hint: null,
        run: () => { try { toggleArchivedView(); } catch (_err) { /* noop */ } },
      });
      items.push({
        id: 'action:sweep-empty',
        group: 'Actions',
        label: 'Sweep empty chats',
        description: 'Clean up untitled chats with no messages (confirms first)',
        hint: null,
        run: () => { try { sweepEmptyChats(); } catch (_err) { /* noop */ } },
      });
      // Quick-settings modal resolves off the same absent-safe globalThis seam
      // the shell stashes it on; no controller means the row never appears.
      const quickSettings = globalRef.rendererQuickSettingsModalController || null;
      if (quickSettings && typeof quickSettings.toggle === 'function') {
        items.push({
          id: 'action:quick-settings',
          group: 'Actions',
          label: 'Open quick settings',
          description: 'Theme, model, and display settings in a compact overlay',
          hint: null,
          run: () => { try { quickSettings.toggle(); } catch (_err) { /* noop */ } },
        });
      }
      return items;
    }

    function getSlashItems() {
      return safeList(listSlashCommands).filter((entry) => entry.action !== 'attach').map((entry) => ({
        id: 'slash:' + String(entry.name || ''),
        group: 'Slash commands',
        label: String(entry.name || ''),
        description: entry.available === false
          ? String(entry.description || '') + ' — ' + String(entry.unavailableReason || 'Command unavailable.')
          : String(entry.description || ''),
        hint: entry.action === 'insert' ? 'Insert' : 'Run',
        disabled: entry.available === false,
        unavailableReason: String(entry.unavailableReason || 'Command unavailable.'),
        run: () => { try { (entry.action === 'insert' ? insertSlashCommand : tryExecuteSlashCommand)(String(entry.name || '')); } catch (_err) { /* noop */ } },
      }));
    }

    function getSkillItems() {
      return safeList(listSlashCommands).filter((entry) => entry.action === 'attach' && entry.skill).map((entry) => ({
        id: 'skill:' + String(entry.skill.id || ''),
        group: 'Skills',
        label: String(entry.name || ''),
        description: [entry.skill.name, entry.description].filter(Boolean).join(' \u2014 '),
        hint: 'Attach',
        run: () => { try { tryExecuteSlashCommand(String(entry.name || '')); } catch (_err) { /* noop */ } },
      }));
    }

    /* Every loaded session, not a pre-filtered slice. The old code sorted by
       updated_at and sliced to 8 BEFORE any query ran, so a chat outside the
       eight most recent was unreachable by title — the headline "go anywhere"
       use case. state.sessions already holds the full list (the sidebar
       filters the same array), so the cap belongs on the RENDER, not here. */
    function getSessionItems() {
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      const sorted = sessions
        .filter((session) => session && session.id)
        .slice()
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
      return sorted.map((session) => {
        const preview = String(session.last_message_preview || '').slice(0, 140);
        return {
          id: 'session:' + String(session.id),
          group: 'Sessions',
          label: String(session.title || 'Untitled chat'),
          description: session.archived_at ? (preview ? preview + ' · archived' : 'archived') : preview,
          hint: null,
          recencyTimestamp: session.updated_at || session.created_at || '',
          run: () => { Promise.resolve().then(() => activateWorkspaceSession(session.id)).catch(() => {}); },
        };
      });
    }

    function getPendingUndoItems() {
      const pendings = safeList(listPendingUndos);
      return pendings.map((pending) => ({
        id: 'undo:' + String(pending.kind || 'pending') + ':' + String(pending.key || ''),
        group: 'Undo',
        label: 'Undo: ' + String(pending.label || 'recent action'),
        // No countdown: it was computed once at render and never ticked, so it
        // was wrong the moment it was read.
        description: 'Reverse this action',
        hint: null,
        run: () => { try { if (typeof pending.undo === 'function') pending.undo(); } catch (_err) { /* noop */ } },
      }));
    }

    /* Settings sections and fields, off the pure index renderer-settings-search
       already builds for the Settings page search box. Navigation reuses the
       shell's openSettingsSection seam rather than re-implementing the jump. */
    function getSettingsItems() {
      if (settingsIndexCache === null) {
        const search = globalRef.rendererSettingsSearch || null;
        settingsIndexCache = (search && typeof search.buildSettingsSearchIndex === 'function')
          ? safeList(() => search.buildSettingsSearchIndex())
          : [];
      }
      return settingsIndexCache.map((entry) => ({
        id: 'setting:' + String(entry.id || ''),
        group: 'Settings',
        label: String(entry.label || ''),
        description: String(entry.sectionLabel || entry.description || ''),
        hint: null,
        run: () => { try { openSettingsSection(String(entry.sectionId || '')); } catch (_err) { /* noop */ } },
      }));
    }

    /* One array, built once per open. Order here is only the tie-break for
       equal-scoring rows; display order comes from groupOrder()/the ranking. */
    function snapshot() {
      return []
        .concat(getPendingUndoItems())
        .concat(getNavigateItems())
        .concat(getActionItems())
        .concat(safeList(getIdeCommandItems))
        .concat(safeList(getPluginCommandItems))
        .concat(getSessionItems())
        .concat(getSettingsItems())
        .concat(getSkillItems())
        .concat(getSlashItems())
        .concat([{
          id: 'help:keyboard',
          group: 'Help',
          label: 'Keyboard shortcuts',
          description: 'Quick reference for hotkeys across Jenny',
          hint: null,
          run: () => { try { openKeyboardShortcuts(); } catch (_err) { /* noop */ } },
        }])
        .map(decorate);
    }

    return { snapshot };
  }

  return {
    createPaletteProviders,
    GROUP_ORDER,
    GROUP_TAGS,
    GROUP_ICONS,
    SCOPES,
    SCOPE_PREFIXES,
    groupOrder,
    scopeAllows,
  };
});
