/* renderer/shell/renderer-chats-panel.js
 *
 * Compact, bounded chats-history controller. It owns the request-local
 * Recent/Archived scope, full-history search, progressive mounting, keyed DOM
 * reconciliation, and structural-render diagnostics. Runtime badges remain a
 * separate patch pass so streaming chrome updates never rebuild the list.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatsPanel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  // 50 ms is the browser long-task line; boot contention alone put renders at
  // 32-56 ms (2026-09-22 diagnostics), so only a clear stall warns.
  var SLOW_RENDER_MS = 50;
  var STALLED_RENDER_MS = 100;
  var SLOW_LOG_INTERVAL_MS = 30000;
  var SCROLL_PRESERVE = 'preserve';
  var SCROLL_RESET = 'reset';
  var PHOTO_ICON_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><circle cx="6" cy="7" r="1" /><path d="M13 10.5 10.25 7.75 5.5 12.5" /></svg>';
  // Four-point spark: the mark of the primary "Jenny" chat (row 69).
  var PRIMARY_MARK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5c.6 3.6 2.9 5.9 6.5 6.5-3.6.6-5.9 2.9-6.5 6.5-.6-3.6-2.9-5.9-6.5-6.5C5.1 7.4 7.4 5.1 8 1.5z" /></svg>';

  const { escapeHtml, resolveDefaultTitle } = (typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null);
  var treeUi = globalThis.rendererChatsPanelTree || require('./renderer-chats-panel-tree');
  var scrollUi = globalThis.rendererChatsPanelScroll || require('./renderer-chats-panel-scroll');
  var normalizeInlineText = treeUi.normalizeInline;
  var focusQuiet = scrollUi.focusQuiet;
  var unreadUi = globalThis.rendererSessionUnread || (typeof require === 'function' ? require('./renderer-session-unread') : { count: function () { return 0; }, titleClass: function () { return ''; }, markup: function () { return ''; } });

  var modelUi = globalThis.rendererChatsPanelModel || require('./renderer-chats-panel-model');
  var PAGE_SIZE = modelUi.PAGE_SIZE;
  var MAX_VISIBLE = modelUi.MAX_VISIBLE;
  var SEARCH_LIMIT = modelUi.SEARCH_LIMIT;
  var buildChatsViewModel = modelUi.buildChatsViewModel;
  var projectsUi = globalThis.rendererChatsPanelProjects || require('./renderer-chats-panel-projects');
  var formatSessionTime = treeUi.formatSessionTime;
  var nearestSurvivingSessionId = scrollUi.nearestSurvivingSessionId;

  var GENERAL_PROJECT_ID = treeUi.GENERAL_PROJECT_ID;
  var ROW_FOCUS_SELECTORS = ['[data-session-action="menu"]', '[data-session-toggle]', '[data-session-open]'];

  function createChatsPanelController(deps) {
    var state = deps.state;
    // Rows/sections are built with createElement and inserted into
    // dom.conversationGroups, a host this module receives rather than owns --
    // so they must be created in the document that OWNS that host. An ambient
    // global that points at a DIFFERENT document (or none) yields nodes that
    // never render, with no error. Ambient/injected is only the fallback for
    // callers that pass no groups container.
    var documentRef = (deps.dom && deps.dom.conversationGroups && deps.dom.conversationGroups.ownerDocument)
      || deps.documentRef
      || (typeof document !== 'undefined' ? document : null);
    var windowRef = deps.windowRef || documentRef && documentRef.defaultView || globalThis;
    var dom = deps.dom || {};
    var callbacks = deps.callbacks || {};
    var actionButton = deps.inventory && deps.inventory.actionButton || globalThis.inventoryActionButton;
    var segmentedControl = deps.inventory && deps.inventory.segmentedControl || globalThis.inventorySegmentedControl;
    var rowById = new Map();
    // Per row: the markup signature it was built from, and the signature plus key its attributes were last written for.
    var rowKeys = new WeakMap();
    var groupByKey = new Map();
    var visibleLimit = PAGE_SIZE;
    var scheduledFrame = 0;
    var pendingScrollPolicy = SCROLL_PRESERVE;
    var disposed = false;
    var lastSlowLogAt = 0;
    var lastScopeSignature = '';
    var rovingSessionId = '';
    // The active chat last brought into view: a project the user collapses afterwards stays collapsed.
    var revealedActiveId = '';
    // A render while the list is not displayed (collapsed panel, other view) only marks it stale;
    // the list catches up once it has a size again. Without ResizeObserver every render runs.
    var listShown = true;
    var staleWhileHidden = false;
    var sizeObserver = null;
    var lastNodes = new Map();
    // Mounted rows whose linked children are folded: the only rows a runtime pass repaints.
    var collapsedParentIds = [];
    var treeChains = new Map();
    // Projects v2 filter: the shared project switcher (lazy) names projects
    // and opens the one project menu; cached once it resolves.
    var projectSwitcher = null;
    var projectSwitcherPromise = null;
    // Chats grouped by project (row 74): project sections, their menus, the group-by control and the saved view.
    var projectsCtl = projectsUi.createProjectGroupsController({
      documentRef: documentRef,
      windowRef: windowRef,
      actionButton: actionButton,
      contextMenu: deps.inventory && deps.inventory.contextMenu || windowRef.inventoryContextMenu,
      getSwitcher: function () { return projectSwitcher; },
      sectionOf: function (key) { return groupByKey.get(key) || null; },
      requestSwitcher: requestProjectSwitcher,
      scheduleRender: scheduleRender,
      setProjectFilter: setProjectFilter,
      appendClientLog: callbacks.appendClientLog,
      showToastMessage: callbacks.showToastMessage,
    });

    function nowMs() {
      return windowRef.performance && typeof windowRef.performance.now === 'function'
        ? windowRef.performance.now()
        : Date.now();
    }

    function currentScope() {
      return state.ui && state.ui.sidebarArchivedView === true ? 'archived' : 'recent';
    }

    function currentProjectFilter() {
      return String(state.ui && state.ui.chatsProjectFilter || '').trim();
    }

    // One request in flight; a failed or empty load clears it so a later render asks again.
    function requestProjectSwitcher() {
      if (projectSwitcher) return Promise.resolve(projectSwitcher);
      if (typeof callbacks.getProjectSwitcher !== 'function') return Promise.resolve(null);
      if (projectSwitcherPromise) return projectSwitcherPromise;
      projectSwitcherPromise = Promise.resolve().then(callbacks.getProjectSwitcher).then(function (switcher) {
        projectSwitcherPromise = null;
        if (disposed || !switcher) return null;
        projectSwitcher = switcher;
        // An already-loaded list paints now; the refresh (and its jenny:projects-changed) paints the rest.
        if (typeof switcher.getProjects === 'function' && switcher.getProjects().length) scheduleRender();
        if (typeof switcher.refresh === 'function') Promise.resolve(switcher.refresh()).then(function () { scheduleRender(); }).catch(function () {});
        return switcher;
      }, function () {
        projectSwitcherPromise = null;
        return null;
      });
      return projectSwitcherPromise;
    }

    // The label a group header shows, so a filter and a header never name one project differently.
    function projectFilterName(projectId) {
      if (!projectId) return jt('projects.filter.all', 'All projects');
      if (!projectSwitcher) requestProjectSwitcher();
      var project = projectSwitcher && typeof projectSwitcher.projectById === 'function' ? projectSwitcher.projectById(projectId) : null;
      return projectsCtl.labelOf(projectId) || (project && project.name) || modelUi.defaultProjectName(projectId);
    }

    // The filtered project can vanish (deleted in Settings): fall back to all.
    function reconcileProjectFilter() {
      var projectId = currentProjectFilter();
      if (!projectId || projectId === GENERAL_PROJECT_ID || !projectSwitcher) return projectId;
      if (projectSwitcher.getProjects().length && !projectSwitcher.projectById(projectId)) {
        state.ui.chatsProjectFilter = '';
        return '';
      }
      return projectId;
    }

    function isCurrentWorkspaceProject(projectId) {
      if (!projectSwitcher) return false;
      var current = projectSwitcher.currentProject();
      return current ? current.id === projectId : projectId === GENERAL_PROJECT_ID;
    }

    function pendingDeleteIds() {
      return new Set(Array.isArray(state.ui && state.ui.pendingSessionDeletes)
        ? state.ui.pendingSessionDeletes
        : []);
    }

    // The same model the canonical display state reports (last used, else preferred), read off the row's own summary.
    function modelLabel(session) {
      var model = normalizeInlineText(session.last_model_used || session.preferred_model || jt('sidebar.chats.modelPending', 'pending'));
      return model.length <= 26 ? model : model.slice(0, 23).trim() + '...';
    }

    function previewLabel(session) {
      var preview = normalizeInlineText(session.last_message_preview || jt('sidebar.chats.noMessagesYet', 'No messages yet.'));
      return preview.length <= 180 ? preview : preview.slice(0, 177).trim() + '...';
    }

    function isOfflineLockdownVisible(session) {
      return state.features?.featureFlags?.session_offline_lockdown === true
        && session?.lockdown === true;
    }

    function prefersReducedMotion() {
      return windowRef.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    }

    function outcomeFor(id) {
      var outcome = state.awayDigest?.digest?.outcomeBySession?.[id];
      return outcome ? [outcome, state.awayDigest?.digest?.latestTerminalBySession?.[id]] : null;
    }

    // Streaming or waiting-for-approval chats: a collapsed parent signals them on its chip, a collapsed project on its dot.
    function runtimeStates() {
      var streams = windowRef.rendererMultiStreamController;
      function read(name) {
        var ids = new Set();
        try { (streams && typeof streams[name] === 'function' ? streams[name]() : []).forEach(function (id) { ids.add(String(id)); }); } catch (_error) { /* best effort */ }
        return ids;
      }
      var streaming = read('getStreamingSessionIds');
      var approval = read('getApprovalPendingSessionIds');
      return {
        active: new Set(Array.from(streaming).concat(Array.from(approval))),
        stateOf: function (id) { return approval.has(id) ? 'approval' : (streaming.has(id) ? 'streaming' : ''); },
      };
    }

    function toggleChildren(sessionId) {
      var node = lastNodes.get(sessionId);
      if (!node || !node.hasChildren) return;
      treeUi.writeChildrenExpanded({ state: state, bridge: windowRef.jennyShell && windowRef.jennyShell.chatWorkspace, chains: treeChains, onChange: scheduleRender }, sessionId, !node.expanded);
    }

    function rowSignature(session, active, node) {
      var outbox = state.sendOutboxBySession instanceof Map ? state.sendOutboxBySession.get(session.id) || [] : [];
      return JSON.stringify({
        unread: unreadUi.count(session),
        title: resolveDefaultTitle(session.title),
        updatedAt: session.updated_at || session.created_at || '',
        preview: session.last_message_preview || '',
        model: session.last_model_used || session.preferred_model || '',
        pinned: session.pinned === true,
        role: session.session_role || '',
        archived: Boolean(session.archived_at),
        active: active,
        type: session.session_type || '',
        provider: session.plugin_session && session.plugin_session.provider_name || '',
        icon: session.plugin_session && session.plugin_session.icon_token || '',
        lockdown: isOfflineLockdownVisible(session),
        outcome: outcomeFor(session.id),
        outbox: outbox.map(function (item) { return [item && item.id, item && item.revision, item && item.status]; }),
        paused: treeUi.isPrimarySession(session) && state.ui && state.ui.primaryChat && state.ui.primaryChat.paused === true ? 1 : 0,
        tree: treeUi.nodeSignature(node),
      });
    }

    function buildRowContents(session, active, tabStop, node) {
      var title = resolveDefaultTitle(normalizeInlineText(session.title));
      var accessibleTitle = title.length <= 120 ? title : title.slice(0, 117).trim() + '...';
      var isPlugin = session.session_type === 'plugin';
      var provider = normalizeInlineText(session.plugin_session && session.plugin_session.provider_name).slice(0, 40);
      var usesPhoto = isPlugin && session.plugin_session && session.plugin_session.icon_token === 'image';
      var lockdown = isOfflineLockdownVisible(session);
      var primary = treeUi.isPrimarySession(session);
      var sessionNoun = primary ? jt('sidebar.chats.primarySession', 'your Jenny chat') : isPlugin ? jt('sidebar.chats.pluginSession', '{provider} session', { provider: provider || jt('sidebar.chats.pluginFallback', 'plugin') }) : jt('sidebar.chats.session', 'session');
      var timestamp = session.updated_at || session.created_at || '';
      var outcome = outcomeFor(session.id);
      var when = outcome && formatSessionTime(outcome[1]);
      var outcomeLine = outcome ? '\n' + (outcome[0] === 'failed' ? jt('sidebar.chats.lastRunFailed', 'Last run failed · {when}', { when: when }) : jt('sidebar.chats.lastRunFinished', 'Finished · {when}', { when: when })) : '';
      var outbox = state.sendOutboxBySession instanceof Map ? state.sendOutboxBySession.get(session.id) || [] : [];
      var failed = outbox.filter(function (item) { return item && (item.status === 'failed' || item.status === 'needs_review'); }).length;
      var outboxMarkup = outbox.length
        ? '<span class="send-outbox-badge' + (failed ? ' send-outbox-badge--failed' : '') + '" aria-label="'
          + escapeHtml(failed ? jtn('sidebar.chats.queuedSendFailedCount', failed, { count: failed }, '{count} queued send failed', '{count} queued send failed') : jtn('sidebar.chats.queuedSendCount', outbox.length, { count: outbox.length }, '{count} queued send', '{count} queued sends')) + '">'
          + escapeHtml(failed ? jt('sidebar.chats.outboxFailedShort', '{count} failed', { count: failed }) : jt('sidebar.chats.outboxQueuedShort', '{count} queued', { count: outbox.length })) + '</span>'
        : '';
      var pausedMarkup = primary && state.ui && state.ui.primaryChat && state.ui.primaryChat.paused === true
        ? '<span class="session-row__paused">' + escapeHtml(jt('sidebar.chats.paused', 'Paused')) + '</span>' : '';
      var pinMarkup = primary
        ? '<span class="session-row__primary-mark" aria-hidden="true">' + PRIMARY_MARK_SVG + '</span>'
        : session.pinned === true
        ? '<span class="session-row__pin" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M9.5 2 14 6.5l-3 .75-2.25 3.5L8 12 4 8l1.25-.75 3.5-2.25z" /><path d="M5.5 10.5 2.5 13.5" /></svg></span>'
        : '';
      var typeMarkup = usesPhoto
        ? '<span class="session-row__type-icon" aria-hidden="true">' + PHOTO_ICON_SVG + '</span>'
        : '';
      var lockdownMarkup = lockdown
        ? '<span class="session-offline-lockdown-badge session-row__lockdown-badge'
          + (prefersReducedMotion() ? '' : ' session-offline-lockdown-badge--fade')
          + '" title="' + escapeHtml(jt('sidebar.chats.offlineLockdown', 'Offline lockdown')) + '" aria-hidden="true">'
          + '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="7" rx="1.5"></rect><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"></path></svg>'
          + '</span>'
        : '';
      var openMarkup = actionButton({
        id: 'open-session',
        plain: true,
        className: 'session-row__open',
        ariaLabel: lockdown ? jt('sidebar.chats.openSessionLockdown', 'Open {session} {title}, Offline lockdown', { session: sessionNoun, title: accessibleTitle }) : jt('sidebar.chats.openSession', 'Open {session} {title}', { session: sessionNoun, title: accessibleTitle }),
        title: (primary ? jt('sidebar.chats.primaryChatTitle', 'Your Jenny chat: ask what you were working on, what remains and what is next in any project.\nModel: {model}', { model: modelLabel(session) })
          : lockdown ? jt('sidebar.chats.sessionTitleLockdown', '{preview}\nModel: {model}\nOffline lockdown', { preview: previewLabel(session), model: modelLabel(session) }) : jt('sidebar.chats.sessionTitle', '{preview}\nModel: {model}', { preview: previewLabel(session), model: modelLabel(session) })) + outcomeLine,
        tabIndex: tabStop ? 0 : -1,
        dataset: { 'session-open': session.id, 'session-id': session.id },
        trustedHtml: '<span class="session-row__selection" aria-hidden="true"></span><span class="session-row__dot" aria-hidden="true"></span>'
          + '<span class="conversation-title session-row__title' + unreadUi.titleClass(session) + '">' + pinMarkup + typeMarkup + lockdownMarkup
          + '<span class="session-row__title-text">' + escapeHtml(title) + '</span>' + pausedMarkup + outboxMarkup + '</span>'
          + unreadUi.markup(session) + '<time class="session-row__time" datetime="' + escapeHtml(timestamp) + '">' + escapeHtml(formatSessionTime(timestamp)) + '</time>'
          + treeUi.relationMarkup(session, node),
      });
      var menuMarkup = actionButton({
        id: 'session-menu',
        plain: true,
        className: 'conversation-action-button session-row__menu',
        ariaLabel: jt('sidebar.chats.actionsFor', 'Actions for {title}', { title: accessibleTitle }),
        ariaHaspopup: 'menu',
        title: jt('sidebar.chats.chatActions', 'Chat actions'),
        tabIndex: tabStop ? 0 : -1,
        dataset: { 'session-action': 'menu', 'session-id': session.id },
        trustedHtml: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.25" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.75" cy="8" r="1.25" /></svg>',
      });
      return openMarkup + treeUi.branchMarkup(node, accessibleTitle, actionButton) + menuMarkup;
    }

    function ensureRow(session, active, tabStop, node) {
      var row = rowById.get(session.id);
      if (!row) {
        row = documentRef.createElement('li');
        row.className = 'conversation-item session-row';
        row.dataset.sessionId = session.id;
        rowById.set(session.id, row);
      }
      var signature = rowSignature(session, active, node);
      var keys = rowKeys.get(row);
      if (!keys) rowKeys.set(row, keys = { signature: '', attrsSignature: '', attrs: '' });
      if (keys.signature !== signature && !row.querySelector('.inv-inline-title-editor')) {
        var focusedControl = scrollUi.focusedSelector(row, ROW_FOCUS_SELECTORS);
        keys.signature = signature;
        row.innerHTML = buildRowContents(session, active, tabStop, node);
        var relation = row.querySelector('[id^="' + treeUi.RELATION_ID_PREFIX + '"]');
        if (relation) row.querySelector('[data-session-open]').setAttribute('aria-describedby', relation.id);
        if (focusedControl) focusQuiet(row.querySelector(focusedControl));
      }
      // The attributes below read the signature plus the Tab stop and the thread lines; an unchanged
      // row (the common case on every refresh) skips the writes and the style invalidation they cause.
      // A row kept by an open title editor stays stale, so it never records a key.
      var current = keys.signature === signature;
      var attrKey = tabStop + '|' + (node ? node.last + ':' + node.through.join(',') + ':' + node.parentId : '');
      if (current && keys.attrsSignature === signature && keys.attrs === attrKey) return row;
      keys.attrsSignature = current ? signature : '';
      keys.attrs = attrKey;
      row.dataset.sessionPinned = session.pinned === true ? 'true' : 'false';
      if (treeUi.isPrimarySession(session)) row.dataset.sessionRole = 'primary';
      else delete row.dataset.sessionRole;
      row.classList.toggle('session-row--primary', treeUi.isPrimarySession(session));
      row.dataset.sessionArchived = session.archived_at ? 'true' : 'false';
      row.dataset.sessionType = session.session_type === 'plugin' ? 'plugin' : 'chat';
      row.dataset.sessionLockdown = isOfflineLockdownVisible(session) ? 'true' : 'false';
      row.dataset.sessionProviderName = session.session_type === 'plugin'
        ? normalizeInlineText(session.plugin_session && session.plugin_session.provider_name)
        : '';
      row.classList.toggle('active', active);
      treeUi.applyNodeToRow(row, node);
      var openButton = row.querySelector('[data-session-open]');
      var menuButton = row.querySelector('[data-session-action="menu"]');
      openButton && openButton.setAttribute('tabindex', tabStop ? '0' : '-1');
      menuButton && menuButton.setAttribute('tabindex', tabStop ? '0' : '-1');
      if (openButton) {
        if (active) openButton.setAttribute('aria-current', 'page');
        else openButton.removeAttribute('aria-current');
      }
      return row;
    }

    function ensureGroup(group) {
      var section = groupByKey.get(group.key);
      if (group.kind === 'project') {
        section = projectsCtl.ensureSection(section, group);
        groupByKey.set(group.key, section);
        return section;
      }
      if (!section) {
        section = documentRef.createElement('section');
        section.className = 'conversation-group';
        section.dataset.chatsGroup = group.key;
        var heading = documentRef.createElement('h3');
        heading.className = 'group-label';
        var list = documentRef.createElement('ul');
        list.className = 'group-items';
        section.append(heading, list);
        groupByKey.set(group.key, section);
      }
      section.querySelector('.group-label').textContent = group.label;
      return section;
    }

    function renderScopeControl(model) {
      if (!dom.scopeSlot) return;
      var filterLabel = projectFilterName(model.projectId);
      var signature = JSON.stringify([model.scope, model.recentTotal, model.archivedTotal, model.projectId, model.grouping,
        model.groupByAvailable, projectsCtl.groupMode(), filterLabel]);
      if (signature === lastScopeSignature) return;
      var focusedScope = documentRef.activeElement && dom.scopeSlot.contains(documentRef.activeElement)
        ? documentRef.activeElement.dataset && documentRef.activeElement.dataset.value
        : '';
      var filterHost = dom.projectRow || dom.scopeSlot;
      var focusedFilter = scrollUi.focusedSelector(filterHost, ['[data-chats-project-filter]', '[data-chats-group-by]']);
      lastScopeSignature = signature;
      var filterMarkup = typeof callbacks.getProjectSwitcher === 'function'
        ? actionButton({
          plain: true,
          className: 'chats-project-filter' + (model.projectId ? ' chats-project-filter--set' : ''),
          ariaHaspopup: 'menu',
          ariaLabel: jt('sidebar.chats.projectFilterLabel', 'Filter chats by project: {name}', { name: filterLabel }),
          title: jt('sidebar.chats.projectFilterTitle', 'Filter by project'),
          dataset: { 'chats-project-filter': model.projectId || 'all' },
          trustedHtml: '<svg class="chats-project-filter-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>'
            + '<span class="chats-project-filter-name">' + escapeHtml(filterLabel) + '</span>'
            + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>',
        })
        : '';
      // The filter lives on its own row above the tabs (index.html #chatsProjectRow);
      // a host without that row (the unit harnesses) keeps it in the scope slot.
      var groupByMarkup = projectsCtl.groupByMarkup(model);
      if (dom.projectRow) dom.projectRow.innerHTML = filterMarkup + groupByMarkup;
      dom.scopeSlot.innerHTML = (dom.projectRow ? '' : filterMarkup + groupByMarkup) + segmentedControl({
        id: 'chats-scope',
        className: 'chats-scope-control',
        ariaLabel: jt('sidebar.chats.historyScope', 'Chat history scope'),
        value: model.scope,
        options: [
          { value: 'recent', label: jt('sidebar.chats.recent', 'Recent') },
          { value: 'archived', label: model.archivedTotal === 0 ? jt('sidebar.chats.archived', 'Archived') : jt('sidebar.chats.archivedCount', 'Archived {count}', { count: model.archivedTotal }) },
        ],
      });
      if (focusedScope) {
        focusQuiet(dom.scopeSlot.querySelector('[data-value="' + model.scope + '"]')
          || dom.scopeSlot.querySelector('[data-value="' + focusedScope + '"]'));
      } else if (focusedFilter) {
        focusQuiet(filterHost.querySelector(focusedFilter));
      }
    }

    // The filtered project is empty. Offer a new chat there only when that is
    // where a new chat would truthfully land (the current Workspace project);
    // otherwise offer the way back to every project.
    function projectEmptyAction(model) {
      var name = projectFilterName(model.projectId);
      return isCurrentWorkspaceProject(model.projectId)
        ? { label: jt('sidebar.chats.newChatIn', 'New chat in {name}', { name: name }), action: 'project-new' }
        : { label: jt('sidebar.chats.showAllProjects', 'Show all projects'), action: 'project-all' };
    }

    function emptyCopy(model) {
      if (model.emptyKind === 'search') {
        return [jt('sidebar.chats.searchEmptyTitle', 'No chats match your search.'), jt('sidebar.chats.searchEmptyDescription', 'Try a different title or preview term.')];
      }
      if (model.emptyKind === 'archived') {
        return [jt('sidebar.chats.archivedEmptyTitle', 'No archived chats.'), jt('sidebar.chats.archivedEmptyDescription', 'Archive a chat from its row menu and it will appear here.')];
      }
      if (model.emptyKind === 'project') {
        var name = projectFilterName(model.projectId);
        return [
          jt('sidebar.chats.projectEmptyTitle', 'No chats in {name} yet.', { name: name }),
          isCurrentWorkspaceProject(model.projectId)
            ? jt('sidebar.chats.projectEmptyDescription', 'Start one and it will appear here.')
            : jt('sidebar.chats.projectEmptyElsewhere', 'New chats start in the current Workspace project.'),
        ];
      }
      return [jt('sidebar.chats.emptyTitle', 'No chats yet.'), model.noHistory ? '' : jt('sidebar.chats.emptyDescription', 'Start a conversation and it will appear here.')];
    }

    /** A marked direct child of the list (empty state, pagination): no scan of every row. */
    function listChild(attribute) {
      var children = dom.conversationGroups.children;
      for (var index = children.length - 1; index >= 0; index -= 1) {
        if (children[index].hasAttribute(attribute)) return children[index];
      }
      return null;
    }

    /** What the empty state and pagination currently say: a change there shifts the list's bottom. */
    function tailKey() {
      var empty = listChild('data-chats-empty');
      var pagination = listChild('data-chats-pagination');
      return (empty ? empty.textContent : '') + '\u0000' + (pagination ? pagination.textContent : '');
    }

    function renderEmpty(model) {
      var empty = listChild('data-chats-empty');
      if (!model.emptyKind) {
        empty && empty.remove();
        return;
      }
      if (!empty) {
        empty = documentRef.createElement('div');
        empty.className = 'empty-state sidebar-empty-state';
        empty.dataset.chatsEmpty = 'true';
        empty.innerHTML = '<div class="sidebar-empty-title"></div><div class="sidebar-empty-copy"></div>'
          + '<div class="sidebar-empty-action-slot"></div>';
        dom.conversationGroups.appendChild(empty);
      }
      var copy = emptyCopy(model);
      empty.dataset.emptyKind = model.emptyKind;
      empty.querySelector('.sidebar-empty-title').textContent = copy[0];
      empty.querySelector('.sidebar-empty-copy').textContent = copy[1];
      var projectAction = model.emptyKind === 'project' ? projectEmptyAction(model) : null;
      empty.querySelector('.sidebar-empty-action-slot').innerHTML = model.noHistory && empty.closest('.view-panel')?.querySelector('.new-chat-button:not([hidden]):not(.hidden)') ? '' : actionButton({
        id: 'chats-empty-action',
        label: projectAction ? projectAction.label : (model.emptyKind === 'search'
          ? jt('sidebar.chats.clearSearch', 'Clear search') : (model.emptyKind === 'archived' ? jt('sidebar.chats.viewRecentChats', 'View recent chats') : jt('sidebar.chats.newChat', 'New chat'))),
        variant: 'ghost', size: 'sm', className: 'sidebar-empty-action',
        dataset: { 'chats-empty-action': projectAction ? projectAction.action : model.emptyKind },
      });
      dom.conversationGroups.appendChild(empty);
    }

    function focusFirstNewSession(model, previousVisibleCount) {
      if (!model.visibleSessions.length) return;
      var targetIndex = Math.min(
        Math.max(Number.isFinite(previousVisibleCount) ? previousVisibleCount : 0, 0),
        model.visibleSessions.length - 1
      );
      var targetId = model.visibleSessions[targetIndex] && model.visibleSessions[targetIndex].id;
      var targetRow = targetId && rowById.get(targetId);
      var target = targetRow && targetRow.querySelector('[data-session-open]');
      if (!target) return;
      setRovingSession(targetId);
      focusQuiet(target);
    }

    function renderPagination(model) {
      var pagination = listChild('data-chats-pagination');
      var paginationHadFocus = Boolean(
        pagination && documentRef.activeElement && pagination.contains(documentRef.activeElement)
      );
      var previousVisibleCount = pagination
        ? Number(pagination.dataset.visibleCount)
        : model.visibleCount;
      var focusTarget = null;
      if (!model.hasMore && !model.capped) {
        pagination && pagination.remove();
        if (paginationHadFocus) focusFirstNewSession(model, previousVisibleCount);
        return;
      }
      if (!pagination) {
        pagination = documentRef.createElement('div');
        pagination.className = 'chats-panel-pagination';
        pagination.dataset.chatsPagination = 'true';
        dom.conversationGroups.appendChild(pagination);
      }
      if (model.hasMore) {
        var label = jt('sidebar.chats.loadMore', 'Load {count} more', { count: Math.min(PAGE_SIZE, model.remaining) });
        var loadMoreButton = pagination.querySelector('[data-chats-load-more]');
        if (!loadMoreButton) {
          pagination.innerHTML = actionButton({
            id: 'chats-load-more',
            label: label,
            variant: 'ghost',
            size: 'sm',
            className: 'chats-panel-load-more',
            dataset: { 'chats-load-more': 'true' },
          });
          loadMoreButton = pagination.querySelector('[data-chats-load-more]');
        } else {
          loadMoreButton.textContent = label;
        }
        if (paginationHadFocus) focusTarget = loadMoreButton;
        pagination.removeAttribute('tabindex');
      } else {
        pagination.textContent = model.query
          ? jt('sidebar.chats.searchLimitNotice', 'Showing the first 200 matches. Refine your search to narrow the list.')
          : jt('sidebar.chats.historyLimitNotice', 'Showing the newest 500 chats. Search to find older chats.');
        pagination.tabIndex = -1;
        if (paginationHadFocus) focusTarget = pagination;
      }
      pagination.dataset.visibleCount = String(model.visibleCount);
      if (pagination !== dom.conversationGroups.lastElementChild) {
        dom.conversationGroups.appendChild(pagination);
      }
      if (focusTarget && documentRef.activeElement !== focusTarget) focusQuiet(focusTarget);
    }

    function chooseRovingSession(model, snapshot) {
      var ids = new Set(model.visibleSessions.map(function (session) { return session.id; }));
      if (snapshot && snapshot.focusedSessionId) {
        if (ids.has(snapshot.focusedSessionId)) return snapshot.focusedSessionId;
        var focusedFallback = nearestSurvivingSessionId(snapshot, snapshot.focusedIndex, ids);
        if (focusedFallback) return focusedFallback;
      }
      if (ids.has(rovingSessionId)) return rovingSessionId;
      var priorIndex = snapshot && snapshot.anchorIndex;
      var nearest = nearestSurvivingSessionId(snapshot, priorIndex, ids);
      if (nearest) return nearest;
      if (ids.has(state.currentSessionId)) return state.currentSessionId;
      return model.visibleSessions[0] && model.visibleSessions[0].id || '';
    }

    function captureScrollAnchor() {
      return scrollUi.captureScrollAnchor(dom.conversationGroups, getVisibleSessionElements(), documentRef.activeElement);
    }

    function restoreScrollAnchor(snapshot, scrollPolicy) {
      if (scrollPolicy === SCROLL_RESET) dom.conversationGroups.scrollTop = 0;
      else scrollUi.restoreScrollAnchor(dom.conversationGroups, snapshot, getVisibleSessionElements(), rowById);
    }

    function restoreRemovedRowFocus(snapshot) {
      if (!snapshot.focusedSessionId || rowById.has(snapshot.focusedSessionId)) return;
      var targetRow = rovingSessionId && rowById.get(rovingSessionId);
      if (!targetRow) return;
      focusQuiet(snapshot.focusedControl === 'menu'
        ? targetRow.querySelector('[data-session-action="menu"]')
        : targetRow.querySelector('[data-session-open]'));
    }

    /** Keyed reconcile; true when it moved, added, removed or rebuilt anything (heights may have changed). */
    function reconcileGroups(model, snapshot) {
      var usedGroups = new Set();
      var usedRows = new Set();
      var sectionCursor = dom.conversationGroups.firstElementChild;
      var moved = false;
      rovingSessionId = chooseRovingSession(model, snapshot);
      model.groups.forEach(function (group) {
        var section = ensureGroup(group);
        var list = section.querySelector('.group-items');
        var rowCursor = list.firstElementChild;
        usedGroups.add(group.key);
        if (section !== sectionCursor) {
          dom.conversationGroups.insertBefore(section, sectionCursor);
          moved = true;
        } else sectionCursor = section.nextElementSibling;
        group.items.forEach(function (session) {
          var before = rowById.get(session.id);
          var signature = before && rowKeys.get(before) && rowKeys.get(before).signature;
          var row = ensureRow(session, session.id === state.currentSessionId, session.id === rovingSessionId, model.nodes.get(session.id));
          if (row !== before || rowKeys.get(row).signature !== signature) moved = true;
          usedRows.add(session.id);
          if (row !== rowCursor) {
            list.insertBefore(row, rowCursor);
            moved = true;
          } else rowCursor = row.nextElementSibling;
        });
      });
      groupByKey.forEach(function (section, key) {
        if (!usedGroups.has(key)) {
          section.remove();
          groupByKey.delete(key);
          moved = true;
        }
      });
      rowById.forEach(function (row, id) {
        if (!usedRows.has(id)) {
          row.remove();
          rowById.delete(id);
          moved = true;
        }
      });
      return moved;
    }

    function cancelFrame(id) {
      if (typeof windowRef.cancelAnimationFrame === 'function') windowRef.cancelAnimationFrame(id);
      else windowRef.clearTimeout && windowRef.clearTimeout(id);
    }

    function buildModel(runtime) {
      return buildChatsViewModel({
        ...projectsCtl.modelOptions(),
        runtimeState: runtime.stateOf,
        isActive: function (id) { return runtime.active.has(id); },
        sessions: state.sessions,
        pendingDeleteIds: pendingDeleteIds(),
        scope: currentScope(),
        projectId: reconcileProjectFilter(),
        query: dom.searchInput && dom.searchInput.value,
        visibleLimit: visibleLimit,
        primaryChatEnabled: state.features?.featureFlags?.primary_chat !== false,
      });
    }

    // The active chat must have a row: when it changes to one inside a collapsed project, or past
    // its project's shown page, open the project that far once (a later collapse is respected).
    function revealActive(model, runtime) {
      var activeId = String(state.currentSessionId || '');
      if (!activeId || activeId === revealedActiveId || model.query) return model;
      if (model.visibleSessions.some(function (session) { return session.id === activeId; })) {
        revealedActiveId = activeId;
        return model;
      }
      // Not in this model at all (sessions still loading, other scope, filtered out, date grouping):
      // try again on a later render rather than spending the reveal.
      var placement = modelUi.projectPlacement(model, activeId);
      if (!placement) return model;
      revealedActiveId = activeId;
      return projectsCtl.reveal(placement.projectId, placement.roots) ? buildModel(runtime) : model;
    }

    function renderNow() {
      // Clear the latch before any early return: a frame that fired while the
      // groups node was gone left scheduleRender wedged on its stale id. A
      // direct call also cancels the pending frame so nothing paints twice.
      if (scheduledFrame) cancelFrame(scheduledFrame);
      scheduledFrame = 0;
      if (disposed || !dom.conversationGroups) return null;
      staleWhileHidden = false;
      var scrollPolicy = pendingScrollPolicy;
      pendingScrollPolicy = SCROLL_PRESERVE;
      var startedAt = nowMs();
      var scrollAnchor = captureScrollAnchor();
      var runtime = runtimeStates();
      var model = revealActive(buildModel(runtime), runtime);
      var panelRoot = dom.conversationGroups.closest('.view-panel');
      if (panelRoot && model.noHistory) panelRoot.dataset.chatsHistory = 'none';
      else if (panelRoot) delete panelRoot.dataset.chatsHistory;
      renderScopeControl(model);
      if (dom.conversationCount) {
        var totalChats = model.recentTotal + model.archivedTotal;
        dom.conversationCount.textContent = String(totalChats);
        dom.conversationCount.setAttribute('aria-label', jt('sidebar.chats.totalChats', '{count} total chats', { count: totalChats }));
        // The rail holds at most 8 tabs; say how the two numbers relate.
        var openTabs = state.workspace && Array.isArray(state.workspace.openSessionIds) ? state.workspace.openSessionIds.length : 0;
        dom.conversationCount.setAttribute('title', openTabs > 0
          ? jt('sidebar.chats.countOpenAsTabs', '{count} chats · {open} open as tabs', { count: totalChats, open: openTabs })
          : jt('sidebar.chats.countChats', '{count} chats', { count: totalChats }));
      }
      lastNodes = model.nodes;
      var tailBefore = tailKey();
      var moved = reconcileGroups(model, scrollAnchor);
      if (projectsCtl.takeLayoutChange()) moved = true;
      collapsedParentIds = model.visibleSessions.filter(function (session) {
        var node = model.nodes.get(session.id);
        return node && node.hasChildren && !node.expanded;
      }).map(function (session) { return session.id; });
      projectsCtl.afterModel(model);
      renderEmpty(model);
      renderPagination(model);
      if (tailKey() !== tailBefore) moved = true;
      // Nothing moved or changed height: leave scrollTop alone and skip the forced layout of a re-measure.
      if (moved || scrollPolicy === SCROLL_RESET) restoreScrollAnchor(scrollAnchor, scrollPolicy);
      if (dom.status) {
        dom.status.textContent = model.query
          ? jt('sidebar.chats.showingMatches', 'Showing {visible} of {total} matching chats.', { visible: model.visibleCount, total: model.matchedCount })
          : (model.scope === 'archived' ? jt('sidebar.chats.showingArchived', 'Showing {visible} of {total} archived chats.', { visible: model.visibleCount, total: model.scopeTotal }) : jt('sidebar.chats.showingRecent', 'Showing {visible} of {total} recent chats.', { visible: model.visibleCount, total: model.scopeTotal }));
      }
      callbacks.afterRenderSessions && callbacks.afterRenderSessions(
        model.visibleSessions.map(function (session) { return rowById.get(session.id); }),
        model.visibleSessions
      );
      restoreRemovedRowFocus(scrollAnchor);
      announceRendered();
      var durationMs = nowMs() - startedAt;
      if (durationMs > SLOW_RENDER_MS && Date.now() - lastSlowLogAt >= SLOW_LOG_INTERVAL_MS) {
        lastSlowLogAt = Date.now();
        callbacks.appendClientLog && callbacks.appendClientLog(durationMs > STALLED_RENDER_MS ? 'WARN' : 'INFO', 'sidebar.render_slow', {
          durationMs: Math.round(durationMs * 10) / 10,
          sessionCount: Array.isArray(state.sessions) ? state.sessions.length : 0,
          visibleCount: model.visibleCount,
        });
      }
      return model;
    }

    function requestFrame(callback) {
      return typeof windowRef.requestAnimationFrame === 'function'
        ? windowRef.requestAnimationFrame(callback)
        : windowRef.setTimeout(callback, 0);
    }

    function scheduleRender(options) {
      if (disposed) return;
      if (options && options.resetLimit === true) visibleLimit = PAGE_SIZE;
      if (options && (options.scrollPolicy === SCROLL_RESET || options.resetLimit === true)) {
        pendingScrollPolicy = SCROLL_RESET;
      }
      if (scheduledFrame) return;
      scheduledFrame = requestFrame(renderWhenShown);
    }

    // Listeners (the composer's project pill) read state, so a render deferred while hidden announces too.
    function announceRendered() {
      if (typeof windowRef.Event === 'function') dom.conversationGroups.dispatchEvent(new windowRef.Event('sidebar-rendered'));
    }

    // A scheduled render of a list that is not displayed only marks it stale; the badge, strip and
    // inbox pass still runs on the rows that are there, since the collapsed strip shows that state.
    function renderWhenShown() {
      if (listShown || disposed || !dom.conversationGroups) return renderNow();
      scheduledFrame = 0;
      staleWhileHidden = true;
      callbacks.afterRenderSessions && callbacks.afterRenderSessions(getVisibleSessionElements());
      announceRendered();
      return null;
    }

    function observeListSize() {
      if (!dom.conversationGroups || typeof windowRef.ResizeObserver !== 'function') return;
      sizeObserver = new windowRef.ResizeObserver(function (entries) {
        var box = entries[entries.length - 1].contentRect;
        listShown = box.width > 0 || box.height > 0;
        if (listShown && staleWhileHidden) scheduleRender();
      });
      sizeObserver.observe(dom.conversationGroups);
    }

    /** Back to the first page everywhere (date list and every project), list scrolled to the top. */
    function resetPaging() {
      visibleLimit = PAGE_SIZE;
      projectsCtl.resetLimits();
      scheduleRender({ scrollPolicy: SCROLL_RESET });
    }

    function setScope(scope) {
      var archived = scope === 'archived';
      if (state.ui) state.ui.sidebarArchivedView = archived;
      resetPaging();
      callbacks.appendClientLog && callbacks.appendClientLog('INFO', 'sessions.archived_view_toggled', { visible: archived });
    }

    function toggleScope() {
      setScope(currentScope() === 'archived' ? 'recent' : 'archived');
    }

    function handleScopeChange(event) {
      if (event && event.detail && event.detail.id === 'chats-scope') {
        setScope(event.detail.value);
      }
    }

    // Window-scoped, not persisted: the filter follows a Workspace switch (the
    // switcher sets state.ui.chatsProjectFilter) and can go back to all any time.
    function setProjectFilter(projectId) {
      if (!state.ui) state.ui = {};
      var next = String(projectId || '').trim();
      if (next === currentProjectFilter()) return;
      state.ui.chatsProjectFilter = next;
      resetPaging();
      callbacks.appendClientLog && callbacks.appendClientLog('INFO', 'sessions.project_filter_set', { projectId: next });
    }

    // Clicks on the filter row and the scope slot (the listener sits on each, so a match is inside it).
    function handleFilterControlsClick(event) {
      var groupBy = event.target && event.target.closest && event.target.closest('[data-chats-group-by]');
      if (groupBy) {
        event.preventDefault();
        projectsCtl.openGroupByMenu(groupBy);
        return;
      }
      var button = event.target && event.target.closest && event.target.closest('[data-chats-project-filter]');
      if (!button) return;
      event.preventDefault();
      requestProjectSwitcher().then(function (switcher) {
        if (!switcher || disposed) return;
        return switcher.openFilterMenu({ anchor: button, selectedId: currentProjectFilter(), onPick: setProjectFilter });
      }).catch(function () {});
    }

    function handleProjectsChanged() {
      if (!disposed) scheduleRender();
    }

    function loadMore() {
      visibleLimit = Math.min(visibleLimit + PAGE_SIZE, MAX_VISIBLE);
      scheduleRender();
    }

    /** No search, no project filter, the given scope, first page; the list counts as shown. */
    function clearFilters(archived) {
      if (state.ui) {
        state.ui.sidebarArchivedView = archived;
        state.ui.chatsProjectFilter = '';
      }
      if (dom.searchInput) dom.searchInput.value = '';
      listShown = true; // the frame renders before the size observer reports the expanded list
      resetPaging();
    }

    // The strip lists the newest chats of every project, so the panel it expands into does too.
    function prepareForStripExpansion() {
      clearFilters(false);
    }

    /**
     * Brings one chat's row into the list ("Show in Chats"): no search, its own scope, every project,
     * then its project opened far enough (grouped) or the date list paged far enough. Renders
     * synchronously; true when the row is mounted.
     */
    function revealSession(sessionId) {
      var id = String(sessionId || '');
      var session = (state.sessions || []).find(function (item) { return item && item.id === id; });
      if (!session || disposed) return false;
      clearFilters(Boolean(session.archived_at));
      var model = renderNow();
      if (!model || rowById.has(id)) return rowById.has(id);
      var placement = modelUi.projectPlacement(model, id);
      if (placement) {
        projectsCtl.reveal(placement.projectId, placement.roots);
        renderNow();
      }
      while (!placement && !rowById.has(id) && visibleLimit < MAX_VISIBLE) {
        visibleLimit = Math.min(visibleLimit + PAGE_SIZE, MAX_VISIBLE);
        renderNow();
      }
      return rowById.has(id);
    }

    function setRovingSession(sessionId) {
      rovingSessionId = String(sessionId || '');
      getVisibleSessionElements().forEach(function (row) {
        var selected = row.dataset.sessionId === rovingSessionId;
        var open = row.querySelector('[data-session-open]');
        // The Tab stop moved outside a render: the row's recorded attribute key no longer matches its DOM.
        var keys = rowKeys.get(row);
        if (keys && open && open.getAttribute('tabindex') !== (selected ? '0' : '-1')) keys.attrs = '';
        open?.setAttribute('tabindex', selected ? '0' : '-1');
        row.querySelector('[data-session-action="menu"]')?.setAttribute('tabindex', selected ? '0' : '-1');
      });
    }

    function getVisibleSessionElements() {
      return dom.conversationGroups
        ? dom.conversationGroups.querySelectorAll('.conversation-item[data-session-id]')
        : [];
    }

    // Runtime-only chrome pass (streaming/approval ticks): collapsed parents' chips and collapsed
    // projects' dots. Row badges have their own pass, so this never calls afterRenderSessions.
    function patchRuntimeState() {
      if (disposed) return;
      var runtime = runtimeStates();
      var parents = collapsedParentIds.map(function (id) { return rowById.get(id); }).filter(Boolean);
      if (parents.length) treeUi.patchCollapsedChips(parents, lastNodes, function (id) { return runtime.active.has(id); });
      projectsCtl.patchTones(runtime.stateOf);
    }

    function handlePanelClick(event) {
      if (projectsCtl.handleClick(event)) return;
      var toggle = event.target && event.target.closest && event.target.closest('[data-session-toggle]');
      if (toggle && dom.conversationGroups.contains(toggle)) {
        event.preventDefault();
        toggleChildren(toggle.dataset.sessionToggle);
        return;
      }
      if (event.target && event.target.closest && event.target.closest('[data-chats-load-more]')) {
        loadMore();
        return;
      }
      var action = event.target && event.target.closest && event.target.closest('[data-chats-empty-action]');
      if (!action || !dom.conversationGroups.contains(action)) return;
      if (action.dataset.chatsEmptyAction === 'search') {
        if (dom.searchInput) dom.searchInput.value = '';
        resetPaging();
        dom.searchInput && dom.searchInput.focus();
      } else if (action.dataset.chatsEmptyAction === 'archived') {
        setScope('recent');
      } else if (action.dataset.chatsEmptyAction === 'project-all') {
        setProjectFilter('');
      } else {
        callbacks.newChat && callbacks.newChat();
      }
    }

    function dispose() {
      disposed = true;
      if (scheduledFrame) cancelFrame(scheduledFrame);
      scheduledFrame = 0;
      if (sizeObserver) sizeObserver.disconnect();
      sizeObserver = null;
      dom.scopeSlot && dom.scopeSlot.removeEventListener('inv-segmented-change', handleScopeChange);
      dom.scopeSlot && dom.scopeSlot.removeEventListener('click', handleFilterControlsClick);
      dom.projectRow && dom.projectRow.removeEventListener('click', handleFilterControlsClick);
      if (typeof callbacks.getProjectSwitcher === 'function') windowRef.removeEventListener('jenny:projects-changed', handleProjectsChanged);
      dom.conversationGroups && dom.conversationGroups.removeEventListener('click', handlePanelClick);
      dom.conversationGroups && dom.conversationGroups.removeEventListener('contextmenu', projectsCtl.handleContextMenu);
      if (dom.scopeSlot) dom.scopeSlot.replaceChildren();
      if (dom.projectRow) dom.projectRow.replaceChildren();
      if (dom.conversationGroups) dom.conversationGroups.replaceChildren();
      if (dom.status) dom.status.textContent = '';
      rowById.clear();
      groupByKey.clear();
      projectsCtl.dispose();
    }

    dom.scopeSlot && dom.scopeSlot.addEventListener('inv-segmented-change', handleScopeChange);
    dom.scopeSlot && dom.scopeSlot.addEventListener('click', handleFilterControlsClick);
    dom.projectRow && dom.projectRow.addEventListener('click', handleFilterControlsClick);
    if (typeof callbacks.getProjectSwitcher === 'function') windowRef.addEventListener('jenny:projects-changed', handleProjectsChanged);
    dom.conversationGroups && dom.conversationGroups.addEventListener('click', handlePanelClick);
    dom.conversationGroups && dom.conversationGroups.addEventListener('contextmenu', projectsCtl.handleContextMenu);
    observeListSize();

    return {
      renderSessions: scheduleRender,
      renderNow: renderNow,
      revealSession: revealSession,
      setScope: setScope,
      toggleScope: toggleScope,
      setProjectFilter: setProjectFilter,
      loadMore: loadMore,
      prepareForStripExpansion: prepareForStripExpansion,
      setRovingSession: setRovingSession,
      getVisibleSessionElements: getVisibleSessionElements,
      patchRuntimeState: patchRuntimeState,
      dispose: dispose,
    };
  }

  return {
    buildChatsViewModel: buildChatsViewModel,
    createChatsPanelController: createChatsPanelController,
  };
});
