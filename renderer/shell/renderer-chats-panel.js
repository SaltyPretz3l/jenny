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

  var PAGE_SIZE = 100;
  var MAX_VISIBLE = 500;
  var SEARCH_LIMIT = 200;
  var SLOW_RENDER_MS = 32;
  var SLOW_LOG_INTERVAL_MS = 30000;
  var SCROLL_PRESERVE = 'preserve';
  var SCROLL_RESET = 'reset';
  var PHOTO_ICON_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><circle cx="6" cy="7" r="1" /><path d="M13 10.5 10.25 7.75 5.5 12.5" /></svg>';

  function normalizeInlineText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function escapeHtmlText(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function sessionTimestamp(session) {
    var value = session && (session.updated_at || session.created_at);
    var parsed = value ? new Date(value).valueOf() : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function compareSessions(left, right) {
    var pinDelta = Number(right && right.pinned === true) - Number(left && left.pinned === true);
    if (pinDelta) return pinDelta;
    var timeDelta = sessionTimestamp(right) - sessionTimestamp(left);
    if (timeDelta) return timeDelta;
    return String(left && left.id || '').localeCompare(String(right && right.id || ''));
  }

  function groupVisibleSessions(sessions, scope, nowValue) {
    var now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
    if (Number.isNaN(now.valueOf())) now = new Date();
    var keyPrefix = scope === 'archived' ? 'archived_' : 'recent_';
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var startOfYesterday = new Date(startOfToday);
    var previousSevenDays = new Date(startOfToday);
    var previousThirtyDays = new Date(startOfToday);
    startOfYesterday.setDate(startOfToday.getDate() - 1);
    previousSevenDays.setDate(startOfToday.getDate() - 7);
    previousThirtyDays.setDate(startOfToday.getDate() - 30);
    var groups = [
      { key: keyPrefix + 'pinned', label: jt('sidebar.chats.groups.pinned', 'Pinned'), items: [] },
      { key: keyPrefix + 'today', label: jt('sidebar.chats.groups.today', 'Today'), items: [] },
      { key: keyPrefix + 'yesterday', label: jt('sidebar.chats.groups.yesterday', 'Yesterday'), items: [] },
      { key: keyPrefix + 'previous_7_days', label: jt('sidebar.chats.groups.previous7Days', 'Previous 7 days'), items: [] },
      { key: keyPrefix + 'previous_30_days', label: jt('sidebar.chats.groups.previous30Days', 'Previous 30 days'), items: [] },
      { key: keyPrefix + 'older', label: jt('sidebar.chats.groups.older', 'Older'), items: [] },
    ];
    sessions.forEach(function (session) {
      if (session.pinned === true) {
        groups[0].items.push(session);
        return;
      }
      var timestamp = sessionTimestamp(session);
      var date = timestamp ? new Date(timestamp) : null;
      if (date && date >= startOfToday) groups[1].items.push(session);
      else if (date && date >= startOfYesterday) groups[2].items.push(session);
      else if (date && date >= previousSevenDays) groups[3].items.push(session);
      else if (date && date >= previousThirtyDays) groups[4].items.push(session);
      else groups[5].items.push(session);
    });
    return groups.filter(function (group) { return group.items.length > 0; });
  }

  function formatSessionTime(value, nowValue) {
    var parsed = value ? new Date(value) : null;
    if (!parsed || Number.isNaN(parsed.valueOf())) return '';
    var now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
    if (Number.isNaN(now.valueOf())) now = new Date();
    var minutes = Math.floor(Math.max(now.valueOf() - parsed.valueOf(), 0) / 60000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return minutes + 'm';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h';
    var options = { month: 'short', day: 'numeric' };
    if (parsed.getFullYear() !== now.getFullYear()) options.year = 'numeric';
    return parsed.toLocaleDateString(globalThis.jennyI18n?.tag?.(), options);
  }

  function buildChatsViewModel(options) {
    var o = options || {};
    var sessions = Array.isArray(o.sessions) ? o.sessions : [];
    var pendingDeletes = o.pendingDeleteIds instanceof Set
      ? o.pendingDeleteIds
      : new Set(Array.isArray(o.pendingDeleteIds) ? o.pendingDeleteIds : []);
    var scope = o.scope === 'archived' ? 'archived' : 'recent';
    var query = normalizeInlineText(o.query).toLowerCase();
    var recentTotal = 0;
    var archivedTotal = 0;
    var eligible = [];

    sessions.forEach(function (session) {
      if (!session || !session.id || pendingDeletes.has(session.id)) return;
      var archived = Boolean(session.archived_at);
      if (archived) archivedTotal += 1;
      else recentTotal += 1;
      if ((scope === 'archived') !== archived) return;
      if (query) {
        var title = normalizeInlineText(session.title).toLowerCase();
        if (!title || title === 'new chat') title += ' ' + jt('session.defaultTitle.chat', 'New Chat').toLowerCase();
        var preview = normalizeInlineText(session.last_message_preview).toLowerCase();
        if (!(title + ' ' + preview).includes(query)) return;
      }
      eligible.push(session);
    });

    eligible.sort(compareSessions);
    var matchedCount = eligible.length;
    var requestedLimit = Number.isFinite(o.visibleLimit) ? Math.max(PAGE_SIZE, o.visibleLimit) : PAGE_SIZE;
    var mountLimit = query ? SEARCH_LIMIT : Math.min(requestedLimit, MAX_VISIBLE);
    var visibleSessions = eligible.slice(0, mountLimit);
    var scopeTotal = scope === 'archived' ? archivedTotal : recentTotal;
    var hasMore = !query && visibleSessions.length < Math.min(matchedCount, MAX_VISIBLE);
    var capped = query ? matchedCount > SEARCH_LIMIT : matchedCount > MAX_VISIBLE && visibleSessions.length >= MAX_VISIBLE;
    var emptyKind = '';
    if (!visibleSessions.length) {
      if (query) emptyKind = 'search';
      else emptyKind = scope === 'archived' ? 'archived' : 'empty';
    }
    return {
      scope: scope,
      query: query,
      recentTotal: recentTotal,
      archivedTotal: archivedTotal,
      scopeTotal: scopeTotal,
      matchedCount: matchedCount,
      visibleCount: visibleSessions.length,
      visibleSessions: visibleSessions,
      groups: groupVisibleSessions(visibleSessions, scope, o.now),
      hasMore: hasMore,
      capped: capped,
      remaining: Math.max(Math.min(matchedCount, MAX_VISIBLE) - visibleSessions.length, 0),
      emptyKind: emptyKind,
    };
  }

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
    var escapeHtml = typeof callbacks.escapeHtml === 'function' ? callbacks.escapeHtml : escapeHtmlText;
    var rowById = new Map();
    var groupByKey = new Map();
    var visibleLimit = PAGE_SIZE;
    var scheduledFrame = 0;
    var pendingScrollPolicy = SCROLL_PRESERVE;
    var disposed = false;
    var lastSlowLogAt = 0;
    var lastScopeState = null;
    var rovingSessionId = '';

    function nowMs() {
      return windowRef.performance && typeof windowRef.performance.now === 'function'
        ? windowRef.performance.now()
        : Date.now();
    }

    function currentScope() {
      return state.ui && state.ui.sidebarArchivedView === true ? 'archived' : 'recent';
    }

    function pendingDeleteIds() {
      return new Set(Array.isArray(state.ui && state.ui.pendingSessionDeletes)
        ? state.ui.pendingSessionDeletes
        : []);
    }

    function formatRelativeTime(value) {
      return formatSessionTime(value);
    }

    function modelLabel(session) {
      var derive = globalThis.rendererShellRuntimeUtils && globalThis.rendererShellRuntimeUtils.deriveCanonicalSessionDisplayState;
      var displayState = typeof derive === 'function' ? derive(state, session.id) : null;
      var model = normalizeInlineText(displayState && displayState.model || session.last_model_used || session.preferred_model || 'pending');
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

    function rowSignature(session, active) {
      var outbox = state.sendOutboxBySession instanceof Map
        ? state.sendOutboxBySession.get(session.id) || []
        : [];
      return JSON.stringify({
        title: session.title === 'New Plugin Session' ? jt('session.defaultTitle.plugin', 'New Plugin Session') : (!session.title || session.title === 'New Chat' ? jt('session.defaultTitle.chat', 'New Chat') : session.title),
        updatedAt: session.updated_at || session.created_at || '',
        preview: session.last_message_preview || '',
        model: session.last_model_used || session.preferred_model || '',
        pinned: session.pinned === true,
        archived: Boolean(session.archived_at),
        active: active,
        type: session.session_type || '',
        provider: session.plugin_session && session.plugin_session.provider_name || '',
        icon: session.plugin_session && session.plugin_session.icon_token || '',
        lockdown: isOfflineLockdownVisible(session),
        outbox: outbox.map(function (item) { return [item && item.id, item && item.revision, item && item.status]; }),
      });
    }

    function buildRowContents(session, active, tabStop) {
      var title = normalizeInlineText(session.title); title = title === 'New Plugin Session' ? jt('session.defaultTitle.plugin', 'New Plugin Session') : (!title || title === 'New Chat' ? jt('session.defaultTitle.chat', 'New Chat') : title);
      var accessibleTitle = title.length <= 120 ? title : title.slice(0, 117).trim() + '...';
      var isPlugin = session.session_type === 'plugin';
      var provider = normalizeInlineText(session.plugin_session && session.plugin_session.provider_name).slice(0, 40);
      var usesPhoto = isPlugin && session.plugin_session && session.plugin_session.icon_token === 'image';
      var lockdown = isOfflineLockdownVisible(session);
      var sessionNoun = isPlugin ? jt('sidebar.chats.pluginSession', '{provider} session', { provider: provider || jt('sidebar.chats.pluginFallback', 'plugin') }) : jt('sidebar.chats.session', 'session');
      var timestamp = session.updated_at || session.created_at || '';
      var outbox = state.sendOutboxBySession instanceof Map ? state.sendOutboxBySession.get(session.id) || [] : [];
      var failed = outbox.filter(function (item) { return item && (item.status === 'failed' || item.status === 'needs_review'); }).length;
      var outboxMarkup = outbox.length
        ? '<span class="send-outbox-badge' + (failed ? ' send-outbox-badge--failed' : '') + '" aria-label="'
          + escapeHtml(failed ? jtn('sidebar.chats.queuedSendFailedCount', failed, { count: failed }, '{count} queued send failed', '{count} queued send failed') : jtn('sidebar.chats.queuedSendCount', outbox.length, { count: outbox.length }, '{count} queued send', '{count} queued sends')) + '">'
          + escapeHtml(failed ? failed + ' failed' : outbox.length + ' queued') + '</span>'
        : '';
      var pinMarkup = session.pinned === true
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
        title: lockdown ? jt('sidebar.chats.sessionTitleLockdown', '{preview}\nModel: {model}\nOffline lockdown', { preview: previewLabel(session), model: modelLabel(session) }) : jt('sidebar.chats.sessionTitle', '{preview}\nModel: {model}', { preview: previewLabel(session), model: modelLabel(session) }),
        tabIndex: tabStop ? 0 : -1,
        dataset: { 'session-open': session.id, 'session-id': session.id },
        trustedHtml: '<span class="session-row__selection" aria-hidden="true"></span><span class="session-row__dot" aria-hidden="true"></span>'
          + '<span class="conversation-title session-row__title">' + pinMarkup + typeMarkup + lockdownMarkup
          + '<span class="session-row__title-text">' + escapeHtml(title) + '</span>' + outboxMarkup + '</span>'
          + '<time class="session-row__time" datetime="' + escapeHtml(timestamp) + '">' + escapeHtml(formatRelativeTime(timestamp)) + '</time>',
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
      return openMarkup + menuMarkup;
    }

    function ensureRow(session, active, tabStop) {
      var row = rowById.get(session.id);
      if (!row) {
        row = documentRef.createElement('li');
        row.className = 'conversation-item session-row';
        row.dataset.sessionId = session.id;
        rowById.set(session.id, row);
      }
      var signature = rowSignature(session, active);
      var activeElement = documentRef.activeElement;
      var focusedControl = activeElement && row.contains(activeElement)
        ? (activeElement.matches('[data-session-action="menu"]') ? 'menu' : 'open')
        : '';
      var renameEditor = row.querySelector('.inv-inline-title-editor');
      if (row.dataset.renderSignature !== signature && !renameEditor) {
        row.dataset.renderSignature = signature;
        row.innerHTML = buildRowContents(session, active, tabStop);
        if (focusedControl) {
          var replacement = focusedControl === 'menu'
            ? row.querySelector('[data-session-action="menu"]')
            : row.querySelector('[data-session-open]');
          try { replacement && replacement.focus({ preventScroll: true }); }
          catch (_error) { replacement && replacement.focus(); }
        }
      }
      row.dataset.sessionPinned = session.pinned === true ? 'true' : 'false';
      row.dataset.sessionArchived = session.archived_at ? 'true' : 'false';
      row.dataset.sessionType = session.session_type === 'plugin' ? 'plugin' : 'chat';
      row.dataset.sessionLockdown = isOfflineLockdownVisible(session) ? 'true' : 'false';
      row.dataset.sessionProviderName = session.session_type === 'plugin'
        ? normalizeInlineText(session.plugin_session && session.plugin_session.provider_name)
        : '';
      row.classList.toggle('active', active);
      var openButton = row.querySelector('[data-session-open]');
      var menuButton = row.querySelector('[data-session-action="menu"]');
      openButton && openButton.setAttribute('tabindex', tabStop ? '0' : '-1');
      menuButton && menuButton.setAttribute('tabindex', tabStop && !row.classList.contains('sidebar-bulk-selecting') ? '0' : '-1');
      if (openButton) {
        if (active) openButton.setAttribute('aria-current', 'page');
        else openButton.removeAttribute('aria-current');
      }
      return row;
    }

    function ensureGroup(group) {
      var section = groupByKey.get(group.key);
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
      if (!dom.scopeSlot || typeof segmentedControl !== 'function') return;
      if (lastScopeState
        && lastScopeState.scope === model.scope
        && lastScopeState.recentTotal === model.recentTotal
        && lastScopeState.archivedTotal === model.archivedTotal) return;
      var focusedScope = documentRef.activeElement && dom.scopeSlot.contains(documentRef.activeElement)
        ? documentRef.activeElement.dataset && documentRef.activeElement.dataset.value
        : '';
      lastScopeState = {
        scope: model.scope,
        recentTotal: model.recentTotal,
        archivedTotal: model.archivedTotal,
      };
      dom.scopeSlot.innerHTML = segmentedControl({
        id: 'chats-scope',
        className: 'chats-scope-control',
        ariaLabel: jt('sidebar.chats.historyScope', 'Chat history scope'),
        value: model.scope,
        options: [
          { value: 'recent', label: jt('sidebar.chats.recent', 'Recent') },
          { value: 'archived', label: jt('sidebar.chats.archivedCount', 'Archived {count}', { count: model.archivedTotal }) },
        ],
      });
      if (focusedScope) {
        var selected = dom.scopeSlot.querySelector('[data-value="' + model.scope + '"]')
          || dom.scopeSlot.querySelector('[data-value="' + focusedScope + '"]');
        try { selected && selected.focus({ preventScroll: true }); }
        catch (_error) { selected && selected.focus(); }
      }
    }

    function emptyCopy(model) {
      if (model.emptyKind === 'search') {
        return [jt('sidebar.chats.searchEmptyTitle', 'No chats match your search.'), jt('sidebar.chats.searchEmptyDescription', 'Try a different title or preview term.')];
      }
      if (model.emptyKind === 'archived') {
        return [jt('sidebar.chats.archivedEmptyTitle', 'No archived chats.'), jt('sidebar.chats.archivedEmptyDescription', 'Archive a chat from its row menu and it will appear here.')];
      }
      return [jt('sidebar.chats.emptyTitle', 'No chats yet.'), jt('sidebar.chats.emptyDescription', 'Start a conversation and it will appear here.')];
    }

    function renderEmpty(model) {
      var empty = dom.conversationGroups.querySelector('[data-chats-empty]');
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
      empty.querySelector('.sidebar-empty-action-slot').innerHTML = actionButton({
        id: 'chats-empty-action',
        label: model.emptyKind === 'search'
          ? jt('sidebar.chats.clearSearch', 'Clear search') : (model.emptyKind === 'archived' ? jt('sidebar.chats.viewRecentChats', 'View recent chats') : jt('sidebar.chats.newChat', 'New chat')),
        variant: 'ghost', size: 'sm', className: 'sidebar-empty-action',
        dataset: { 'chats-empty-action': model.emptyKind },
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
      try { target.focus({ preventScroll: true }); }
      catch (_error) { target.focus(); }
    }

    function renderPagination(model) {
      var pagination = dom.conversationGroups.querySelector('[data-chats-pagination]');
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
      if (focusTarget && documentRef.activeElement !== focusTarget) {
        try { focusTarget.focus({ preventScroll: true }); }
        catch (_error) { focusTarget.focus(); }
      }
    }

    function survivingNeighborIds(snapshot, sourceIndex, ids) {
      var orderedIds = snapshot && snapshot.orderedIds || [];
      var index = Number.isInteger(sourceIndex) ? sourceIndex : -1;
      var nextId = '';
      var previousId = '';
      for (var next = index + 1; next < orderedIds.length; next += 1) {
        if (ids.has(orderedIds[next])) {
          nextId = orderedIds[next];
          break;
        }
      }
      for (var previous = Math.min(index - 1, orderedIds.length - 1); previous >= 0; previous -= 1) {
        if (ids.has(orderedIds[previous])) {
          previousId = orderedIds[previous];
          break;
        }
      }
      return { nextId: nextId, previousId: previousId };
    }

    function nearestSurvivingSessionId(snapshot, sourceIndex, ids) {
      var neighbors = survivingNeighborIds(snapshot, sourceIndex, ids);
      return neighbors.nextId || neighbors.previousId;
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
      var container = dom.conversationGroups;
      var top = Number(container.scrollTop) || 0;
      var clientHeight = Number(container.clientHeight) || 0;
      var scrollHeight = Number(container.scrollHeight) || 0;
      var snapshot = {
        top: top,
        bottomDistance: Math.max(scrollHeight - clientHeight - top, 0),
        atBottom: clientHeight > 0 && scrollHeight > clientHeight && scrollHeight - clientHeight - top <= 2,
        sessionId: '',
        anchorIndex: -1,
        offset: 0,
        orderedIds: [],
        focusedSessionId: '',
        focusedIndex: -1,
        focusedControl: '',
      };
      var rows = getVisibleSessionElements();
      snapshot.orderedIds = Array.from(rows, function (row) { return row.dataset.sessionId; });
      var activeElement = documentRef.activeElement;
      var focusedRow = activeElement && activeElement.closest && activeElement.closest('.conversation-item[data-session-id]');
      if (focusedRow && container.contains(focusedRow)) {
        snapshot.focusedSessionId = focusedRow.dataset.sessionId;
        snapshot.focusedIndex = snapshot.orderedIds.indexOf(snapshot.focusedSessionId);
        snapshot.focusedControl = activeElement.matches('[data-session-action="menu"]') ? 'menu' : 'open';
      }
      if (!clientHeight || typeof container.getBoundingClientRect !== 'function') return snapshot;
      var containerRect = container.getBoundingClientRect();
      for (var index = 0; index < rows.length; index += 1) {
        var rect = rows[index].getBoundingClientRect();
        if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
          snapshot.sessionId = rows[index].dataset.sessionId;
          snapshot.anchorIndex = index;
          snapshot.offset = rect.top - containerRect.top;
          break;
        }
      }
      return snapshot;
    }

    function restoreScrollAnchor(snapshot, scrollPolicy) {
      var container = dom.conversationGroups;
      if (scrollPolicy === SCROLL_RESET) {
        container.scrollTop = 0;
        return;
      }
      if (snapshot.atBottom) {
        container.scrollTop = Math.max((Number(container.scrollHeight) || 0) - (Number(container.clientHeight) || 0), 0);
        return;
      }
      var currentRows = Array.from(getVisibleSessionElements());
      var currentIds = currentRows.map(function (row) { return row.dataset.sessionId; });
      var ids = new Set(currentIds);
      var anchor = snapshot.sessionId && rowById.get(snapshot.sessionId);
      if (anchor) {
        var currentIndex = currentIds.indexOf(snapshot.sessionId);
        var neighbors = survivingNeighborIds(snapshot, snapshot.anchorIndex, ids);
        var crossedPrevious = neighbors.previousId
          && currentIds.indexOf(neighbors.previousId) > currentIndex;
        var crossedNext = neighbors.nextId
          && currentIds.indexOf(neighbors.nextId) < currentIndex;
        if (currentIndex < 0 || crossedPrevious || crossedNext) anchor = null;
      }
      if (!anchor && snapshot.anchorIndex >= 0) {
        var fallbackId = nearestSurvivingSessionId(snapshot, snapshot.anchorIndex, ids);
        anchor = fallbackId && rowById.get(fallbackId);
      }
      if (anchor && anchor.isConnected && typeof anchor.getBoundingClientRect === 'function') {
        var delta = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - snapshot.offset;
        container.scrollTop = Math.max(0, snapshot.top + delta);
        return;
      }
      var max = Math.max((Number(container.scrollHeight) || 0) - (Number(container.clientHeight) || 0), 0);
      var hasLayoutMetrics = Number(container.scrollHeight) > 0 || Number(container.clientHeight) > 0;
      container.scrollTop = hasLayoutMetrics ? Math.min(snapshot.top, max) : snapshot.top;
    }

    function restoreRemovedRowFocus(snapshot) {
      if (!snapshot.focusedSessionId || rowById.has(snapshot.focusedSessionId)) return;
      var targetRow = rovingSessionId && rowById.get(rovingSessionId);
      if (!targetRow) return;
      var target = snapshot.focusedControl === 'menu'
        ? targetRow.querySelector('[data-session-action="menu"]')
        : targetRow.querySelector('[data-session-open]');
      try { target && target.focus({ preventScroll: true }); }
      catch (_error) { target && target.focus(); }
    }

    function reconcileGroups(model, snapshot) {
      var usedGroups = new Set();
      var usedRows = new Set();
      var sectionCursor = dom.conversationGroups.firstElementChild;
      rovingSessionId = chooseRovingSession(model, snapshot);
      model.groups.forEach(function (group) {
        var section = ensureGroup(group);
        var list = section.querySelector('.group-items');
        var rowCursor = list.firstElementChild;
        usedGroups.add(group.key);
        if (section !== sectionCursor) dom.conversationGroups.insertBefore(section, sectionCursor);
        else sectionCursor = section.nextElementSibling;
        group.items.forEach(function (session) {
          var row = ensureRow(session, session.id === state.currentSessionId, session.id === rovingSessionId);
          usedRows.add(session.id);
          if (row !== rowCursor) list.insertBefore(row, rowCursor);
          else rowCursor = row.nextElementSibling;
        });
      });
      groupByKey.forEach(function (section, key) {
        if (!usedGroups.has(key)) {
          section.remove();
          groupByKey.delete(key);
        }
      });
      rowById.forEach(function (row, id) {
        if (!usedRows.has(id)) {
          row.remove();
          rowById.delete(id);
        }
      });
    }

    function renderNow() {
      if (disposed || !dom.conversationGroups) return null;
      scheduledFrame = 0;
      var scrollPolicy = pendingScrollPolicy;
      pendingScrollPolicy = SCROLL_PRESERVE;
      var startedAt = nowMs();
      var scrollAnchor = captureScrollAnchor();
      var model = buildChatsViewModel({
        sessions: state.sessions,
        pendingDeleteIds: pendingDeleteIds(),
        scope: currentScope(),
        query: dom.searchInput && dom.searchInput.value,
        visibleLimit: visibleLimit,
      });
      renderScopeControl(model);
      if (dom.conversationCount) {
        var totalChats = model.recentTotal + model.archivedTotal;
        dom.conversationCount.textContent = String(totalChats);
        dom.conversationCount.setAttribute('aria-label', jt('sidebar.chats.totalChats', '{count} total chats', { count: totalChats }));
      }
      reconcileGroups(model, scrollAnchor);
      renderEmpty(model);
      renderPagination(model);
      restoreScrollAnchor(scrollAnchor, scrollPolicy);
      if (dom.status) {
        dom.status.textContent = model.query
          ? jt('sidebar.chats.showingMatches', 'Showing {visible} of {total} matching chats.', { visible: model.visibleCount, total: model.matchedCount })
          : (model.scope === 'archived' ? jt('sidebar.chats.showingArchived', 'Showing {visible} of {total} archived chats.', { visible: model.visibleCount, total: model.scopeTotal }) : jt('sidebar.chats.showingRecent', 'Showing {visible} of {total} recent chats.', { visible: model.visibleCount, total: model.scopeTotal }));
      }
      callbacks.afterRenderSessions && callbacks.afterRenderSessions(
        getVisibleSessionElements(),
        model.visibleSessions
      );
      restoreRemovedRowFocus(scrollAnchor);
      if (typeof windowRef.Event === 'function') dom.conversationGroups.dispatchEvent(new windowRef.Event('sidebar-rendered'));
      var durationMs = nowMs() - startedAt;
      if (durationMs > SLOW_RENDER_MS && Date.now() - lastSlowLogAt >= SLOW_LOG_INTERVAL_MS) {
        lastSlowLogAt = Date.now();
        callbacks.appendClientLog && callbacks.appendClientLog('WARN', 'sidebar.render_slow', {
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
      scheduledFrame = requestFrame(renderNow);
    }

    function setScope(scope) {
      var archived = scope === 'archived';
      if (state.ui) state.ui.sidebarArchivedView = archived;
      visibleLimit = PAGE_SIZE;
      scheduleRender({ scrollPolicy: SCROLL_RESET });
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

    function loadMore() {
      visibleLimit = Math.min(visibleLimit + PAGE_SIZE, MAX_VISIBLE);
      scheduleRender();
    }

    function prepareForStripExpansion() {
      if (state.ui) state.ui.sidebarArchivedView = false;
      if (dom.searchInput) dom.searchInput.value = '';
      visibleLimit = PAGE_SIZE;
      scheduleRender({ scrollPolicy: SCROLL_RESET });
    }

    function setRovingSession(sessionId) {
      rovingSessionId = String(sessionId || '');
      getVisibleSessionElements().forEach(function (row) {
        var selected = row.dataset.sessionId === rovingSessionId;
        row.querySelector('[data-session-open]')?.setAttribute('tabindex', selected ? '0' : '-1');
        row.querySelector('[data-session-action="menu"]')?.setAttribute('tabindex', selected && !row.classList.contains('sidebar-bulk-selecting') ? '0' : '-1');
      });
    }

    function getVisibleSessionElements() {
      return dom.conversationGroups
        ? dom.conversationGroups.querySelectorAll('.conversation-item[data-session-id]')
        : [];
    }

    function patchRuntimeState() {
      if (disposed) return;
      callbacks.afterRenderSessions && callbacks.afterRenderSessions(getVisibleSessionElements());
    }

    function handlePanelClick(event) {
      var action = event.target && event.target.closest && event.target.closest('[data-chats-empty-action]');
      if (!action || !dom.conversationGroups.contains(action)) return;
      if (action.dataset.chatsEmptyAction === 'search') {
        if (dom.searchInput) dom.searchInput.value = '';
        visibleLimit = PAGE_SIZE;
        scheduleRender({ scrollPolicy: SCROLL_RESET });
        dom.searchInput && dom.searchInput.focus();
      } else if (action.dataset.chatsEmptyAction === 'archived') {
        setScope('recent');
      } else {
        callbacks.newChat && callbacks.newChat();
      }
    }

    function dispose() {
      disposed = true;
      if (scheduledFrame) {
        if (typeof windowRef.cancelAnimationFrame === 'function') windowRef.cancelAnimationFrame(scheduledFrame);
        else windowRef.clearTimeout && windowRef.clearTimeout(scheduledFrame);
      }
      scheduledFrame = 0;
      dom.scopeSlot && dom.scopeSlot.removeEventListener('inv-segmented-change', handleScopeChange);
      dom.conversationGroups && dom.conversationGroups.removeEventListener('click', handlePanelClick);
      if (dom.scopeSlot) dom.scopeSlot.replaceChildren();
      if (dom.conversationGroups) dom.conversationGroups.replaceChildren();
      if (dom.status) dom.status.textContent = '';
      rowById.clear();
      groupByKey.clear();
    }

    dom.scopeSlot && dom.scopeSlot.addEventListener('inv-segmented-change', handleScopeChange);
    dom.conversationGroups && dom.conversationGroups.addEventListener('click', handlePanelClick);

    return {
      renderSessions: scheduleRender,
      renderNow: renderNow,
      resetQuery: function () { visibleLimit = PAGE_SIZE; scheduleRender({ scrollPolicy: SCROLL_RESET }); },
      setScope: setScope,
      toggleScope: toggleScope,
      getScope: currentScope,
      loadMore: loadMore,
      prepareForStripExpansion: prepareForStripExpansion,
      setRovingSession: setRovingSession,
      getVisibleSessionElements: getVisibleSessionElements,
      patchRuntimeState: patchRuntimeState,
      dispose: dispose,
    };
  }

  return {
    PAGE_SIZE: PAGE_SIZE,
    MAX_VISIBLE: MAX_VISIBLE,
    SEARCH_LIMIT: SEARCH_LIMIT,
    compareSessions: compareSessions,
    groupVisibleSessions: groupVisibleSessions,
    formatSessionTime: formatSessionTime,
    buildChatsViewModel: buildChatsViewModel,
    createChatsPanelController: createChatsPanelController,
  };
});
