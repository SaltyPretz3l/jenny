/* renderer/shell/renderer-chats-panel-tree.js
 *
 * Sidebar ordering and linked-chat nesting for the chats panel (row 59 checkpoint 5a).
 * Pure helpers: date grouping, row ordering, the parent/child tree built only from the
 * sessions the panel already decided to show (project, archive, search and paging filters
 * are never bypassed), origin captions for children whose parent is not shown, and the
 * markup/collapse-write helpers the panel uses. The DOM stays flat: nested rows are plain
 * siblings in depth-first order and collapsed children are simply absent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatsPanelTree = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var stringUtils = (typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null);
  var escapeHtml = stringUtils.escapeHtml;
  var resolveDefaultTitle = stringUtils.resolveDefaultTitle;

  var GENERAL_PROJECT_ID = 'project_general';
  var MAX_INDENT_DEPTH = 4;
  var VIEW_SCHEMA_VERSION = 1;
  var RELATION_ID_PREFIX = 'session-relation-';
  var CHEVRON_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>';

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

  // Neighbours (in the pre-render DOM order) that still exist after a render.
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

  function normalizeInline(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /** The immutable originating-parent link on a summary, read defensively; null when absent or malformed. */
  function spawnedFromOf(session) {
    var link = session && session.spawned_from;
    if (!link || typeof link !== 'object') return null;
    var parentId = typeof link.parent_session_id === 'string' ? link.parent_session_id.trim() : '';
    if (!parentId || parentId === session.id) return null;
    return { parentId: parentId, createdAt: typeof link.created_at === 'string' ? link.created_at : '' };
  }

  function createdTimestamp(session) {
    var link = spawnedFromOf(session);
    var value = (link && link.createdAt) || (session && session.created_at) || '';
    var parsed = value ? new Date(value).valueOf() : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  // Children read oldest first by creation time, whatever their own activity dates are.
  function compareChildren(left, right) {
    var delta = createdTimestamp(left) - createdTimestamp(right);
    if (delta) return delta;
    return String(left.id).localeCompare(String(right.id));
  }

  function unreadOf(session) {
    var value = session && session.unread_message_count;
    return Number.isSafeInteger(value) && value > 0;
  }

  function projectOf(session) {
    return String(session && session.project_id || '').trim() || GENERAL_PROJECT_ID;
  }

  function sessionTitle(session) {
    return resolveDefaultTitle(normalizeInline(session && session.title));
  }

  // Why a child's parent is not rendered above it. Filters are never bypassed to nest it.
  function resolveOrigin(session, ctx) {
    var link = spawnedFromOf(session);
    if (!link) return null;
    var parent = ctx.allById.get(link.parentId);
    if (!parent || ctx.pendingDeletes.has(link.parentId)) return { kind: 'unavailable', parentTitle: '' };
    if (ctx.projectId && projectOf(parent) !== ctx.projectId) return { kind: 'project', parentTitle: '' };
    if (parent.archived_at && ctx.scope !== 'archived') return { kind: 'archived', parentTitle: '' };
    return { kind: 'parent', parentTitle: sessionTitle(parent) };
  }

  function originCaption(origin) {
    if (!origin) return '';
    if (origin.kind === 'archived') return jt('sidebar.linked.fromArchived', 'From an archived chat');
    if (origin.kind === 'project') return jt('sidebar.linked.fromOtherProject', 'From a chat in another project');
    if (origin.kind === 'parent') return jt('sidebar.linked.inParent', 'in {parent}', { parent: origin.parentTitle });
    return jt('sidebar.linked.unavailable', 'Original chat unavailable');
  }

  /**
   * Lays the shown sessions out as a forest.
   * options: {sessions (shown, in panel order), allSessions, pendingDeletes:Set, scope, projectId,
   *           query, isActive(id)}
   * Returns {roots, nodes:Map(id -> node), childrenOf:Map(id -> sessions)}; a node is
   * {id, depth, parentId, parentTitle, hasChildren, childCount, expanded, descendantActive,
   *  descendantUnread, last, through:number[], origin}.
   * Search results stay flat (a hit only shows "in {parent}").
   */
  function buildSessionTree(options) {
    var o = options || {};
    var sessions = Array.isArray(o.sessions) ? o.sessions : [];
    var isActive = typeof o.isActive === 'function' ? o.isActive : function () { return false; };
    var ctx = {
      allById: new Map((Array.isArray(o.allSessions) ? o.allSessions : sessions).filter(function (s) { return s && s.id; }).map(function (s) { return [s.id, s]; })),
      pendingDeletes: o.pendingDeletes instanceof Set ? o.pendingDeletes : new Set(),
      scope: o.scope === 'archived' ? 'archived' : 'recent',
      projectId: String(o.projectId || '').trim(),
    };
    var nodes = new Map();
    var childrenOf = new Map();
    var shown = new Map(sessions.map(function (s) { return [s.id, s]; }));
    var roots = [];

    function newNode(session) {
      var node = {
        id: session.id, depth: 0, parentId: '', parentTitle: '', hasChildren: false, childCount: 0, expanded: true,
        descendantActive: false, descendantUnread: false, descendantIds: [], last: true, through: [], origin: null,
      };
      nodes.set(session.id, node);
      return node;
    }

    if (o.query) {
      sessions.forEach(function (session) {
        var link = spawnedFromOf(session);
        var parent = link && ctx.allById.get(link.parentId);
        newNode(session).origin = link ? (parent && !ctx.pendingDeletes.has(link.parentId)
          ? { kind: 'parent', parentTitle: sessionTitle(parent) } : { kind: 'unavailable', parentTitle: '' }) : null;
        roots.push(session);
      });
      return { roots: roots, nodes: nodes, childrenOf: childrenOf };
    }

    sessions.forEach(function (session) {
      var link = spawnedFromOf(session);
      if (link && shown.has(link.parentId)) {
        if (!childrenOf.has(link.parentId)) childrenOf.set(link.parentId, []);
        childrenOf.get(link.parentId).push(session);
      } else {
        roots.push(session);
      }
    });
    childrenOf.forEach(function (list) { list.sort(compareChildren); });

    // ancestorOpen: the ancestor levels whose thread still runs through this row; the row's own
    // level runs through too unless it is the last sibling (which draws the elbow instead).
    function visit(session, depth, parentId, ancestorOpen, last) {
      var node = newNode(session);
      node.depth = depth;
      node.parentId = parentId;
      node.last = last;
      node.through = depth >= 1 && !last ? ancestorOpen.concat(depth) : ancestorOpen;
      // A parent cycle must not loop: a child already placed is skipped.
      var kids = (childrenOf.get(session.id) || []).filter(function (child) { return !nodes.has(child.id); });
      if (kids.length) childrenOf.set(session.id, kids);
      else childrenOf.delete(session.id);
      var count = 0;
      var active = false;
      var unread = false;
      var descendantIds = [];
      kids.forEach(function (child, index) {
        var sub = visit(child, depth + 1, session.id, node.through, index === kids.length - 1);
        count += 1 + sub.childCount;
        active = active || isActive(child.id) || sub.descendantActive;
        unread = unread || unreadOf(child) || sub.descendantUnread;
        descendantIds.push(child.id);
        Array.prototype.push.apply(descendantIds, sub.descendantIds);
      });
      node.hasChildren = kids.length > 0;
      node.childCount = count;
      node.descendantActive = active;
      node.descendantUnread = unread;
      node.descendantIds = descendantIds;
      node.expanded = session.children_expanded !== false;
      if (parentId) node.parentTitle = sessionTitle(shown.get(parentId));
      return node;
    }

    var rootList = [];
    roots.forEach(function (session) {
      var node = visit(session, 0, '', [], true);
      node.origin = resolveOrigin(session, ctx);
      rootList.push(session);
    });
    // A parent cycle leaves members unreachable from any root; surface them as roots.
    sessions.forEach(function (session) {
      if (nodes.has(session.id)) return;
      visit(session, 0, '', [], true);
      rootList.push(session);
    });
    return { roots: rootList, nodes: nodes, childrenOf: childrenOf };
  }

  /** Date groups of the roots, each group's items expanded depth-first with the visible descendants. */
  function layoutGroups(tree, scope, now) {
    var groups = groupVisibleSessions(tree.roots, scope, now);
    var rendered = [];
    function emit(session, items) {
      items.push(session);
      var node = tree.nodes.get(session.id);
      if (!node || !node.hasChildren || !node.expanded) return;
      tree.childrenOf.get(session.id).forEach(function (child) { emit(child, items); });
    }
    groups.forEach(function (group) {
      var items = [];
      group.items.forEach(function (session) { emit(session, items); });
      group.items = items;
      Array.prototype.push.apply(rendered, items);
    });
    return { groups: groups, rendered: rendered };
  }

  /** Part of a row's render signature that comes from the tree. */
  function nodeSignature(node) {
    if (!node) return '';
    return [node.depth, node.hasChildren, node.expanded, node.childCount, node.descendantActive, node.descendantUnread,
      node.parentTitle, node.origin && node.origin.kind, node.origin && node.origin.parentTitle].join('|');
  }

  function chipStateText(node) {
    var parts = [jtn('sidebar.linked.hiddenCount', node.childCount, { count: node.childCount }, '{count} linked chat hidden', '{count} linked chats hidden')];
    if (node.descendantActive) parts.push(jt('sidebar.linked.stateWorking', 'working'));
    if (node.descendantUnread) parts.push(jt('sidebar.linked.stateUnread', 'unread'));
    return parts.join(', ');
  }

  function toggleLabel(node, title) {
    return node.expanded
      ? jt('sidebar.linked.collapse', 'Hide linked chats of {title}', { title: title })
      : jt('sidebar.linked.expand', 'Show linked chats of {title}', { title: title });
  }

  function chipMarkup(node, title, actionButton) {
    var tone = node.descendantActive ? 'active' : (node.descendantUnread ? 'unread' : '');
    var label = toggleLabel(node, title);
    return actionButton({
      plain: true, className: 'session-row__children-chip', tabIndex: -1, ariaLabel: label, title: label, ariaExpanded: false,
      dataset: { 'session-toggle': node.id },
      trustedHtml: (tone ? '<span class="session-row__children-dot" data-tone="' + tone + '" aria-hidden="true"></span>' : '')
        + '<span class="session-row__children-count" aria-hidden="true">' + node.childCount + '</span>'
        + '<span class="sr-only">' + escapeHtml(chipStateText(node)) + '</span>',
    });
  }

  /**
   * Sibling controls of the open button: the count chip (collapsed only) and the chevron.
   * Neither is nested in the open button; both stay out of the Tab order (Left/Right on the row drive them).
   */
  function branchMarkup(node, title, actionButton) {
    if (!node || !node.hasChildren) return '';
    var button = typeof actionButton === 'function' ? actionButton : globalThis.inventoryActionButton;
    if (typeof button !== 'function') return '';
    var label = toggleLabel(node, title);
    return '<span class="session-row__branch">' + (node.expanded ? '' : chipMarkup(node, title, button))
      + button({
        plain: true, className: 'session-row__chevron', tabIndex: -1, ariaLabel: label, title: label, ariaExpanded: node.expanded === true,
        dataset: { 'session-toggle': node.id }, trustedHtml: CHEVRON_SVG,
      }) + '</span>';
  }

  /** The second caption line (origins) or a screen-reader-only relation (nested children), plus a collapsed
   *  parent's hidden-children state: the chip and chevron are out of the Tab order, so the row says it. */
  function relationMarkup(session, node) {
    if (!node) return '';
    var id = escapeHtml(RELATION_ID_PREFIX + session.id);
    var hidden = node.hasChildren && !node.expanded
      ? '<span class="sr-only session-row__parent-state">' + escapeHtml((node.origin || node.parentId ? ', ' : '') + chipStateText(node)) + '</span>' : '';
    if (node.origin) return '<span class="session-row__origin" id="' + id + '">' + escapeHtml(originCaption(node.origin)) + hidden + '</span>';
    if (!node.parentId) return hidden ? hidden.replace('<span class="sr-only', '<span id="' + id + '" class="sr-only') : '';
    return '<span class="sr-only" id="' + id + '">' + escapeHtml(jt('sidebar.linked.childOf', 'Linked chat of {parent}', { parent: node.parentTitle })) + hidden + '</span>';
  }

  /** Flat-DOM tree hooks on a keyed row (the keyboard and CSS read these). */
  function applyNodeToRow(row, node) {
    var depth = node ? node.depth : 0;
    row.dataset.treeDepth = String(depth);
    row.style.setProperty('--cw-depth', String(Math.min(depth, MAX_INDENT_DEPTH)));
    row.dataset.treeHasChildren = node && node.hasChildren ? 'true' : 'false';
    if (node && node.hasChildren) row.dataset.treeExpanded = node.expanded ? 'true' : 'false';
    else delete row.dataset.treeExpanded;
    if (node && node.parentId) row.dataset.treeParentId = node.parentId;
    else delete row.dataset.treeParentId;
    if (depth > 0) {
      row.dataset.treeLast = node.last ? 'true' : 'false';
      row.dataset.treeThrough = node.through.filter(function (level) { return level <= MAX_INDENT_DEPTH; }).join(' ');
    } else {
      delete row.dataset.treeLast;
      delete row.dataset.treeThrough;
    }
    if (node && node.origin) row.dataset.treeOrigin = node.origin.kind;
    else delete row.dataset.treeOrigin;
  }

  /** Streaming/approval can change without a structural render: refresh collapsed parents' chip dots. */
  function patchCollapsedChips(rows, nodes, isActive) {
    Array.prototype.forEach.call(rows, function (row) {
      var node = nodes.get(row.dataset.sessionId);
      if (!node || !node.hasChildren || node.expanded) return;
      var active = node.descendantIds.some(function (id) { return isActive(id); });
      if (active === node.descendantActive) return;
      node.descendantActive = active;
      var chip = row.querySelector('.session-row__children-chip');
      if (!chip) return;
      chip.querySelector('.sr-only').textContent = chipStateText(node);
      var state = row.querySelector('.session-row__parent-state');
      if (state) state.textContent = (node.origin || node.parentId ? ', ' : '') + chipStateText(node);
      var dot = chip.querySelector('.session-row__children-dot');
      var tone = active ? 'active' : (node.descendantUnread ? 'unread' : '');
      if (dot && tone) dot.setAttribute('data-tone', tone);
      else if (dot) dot.remove();
      else if (tone) {
        dot = row.ownerDocument.createElement('span');
        dot.className = 'session-row__children-dot';
        dot.setAttribute('aria-hidden', 'true');
        dot.setAttribute('data-tone', tone);
        chip.prepend(dot);
      }
    });
  }

  /**
   * Persists a parent's collapse state. Optimistic on the summary, one resend on a revision
   * conflict (after one summary refetch), reverted on any other failure.
   * ctx: {state, bridge (chatWorkspace), onChange(), chains:Map}
   */
  function writeChildrenExpanded(ctx, sessionId, expanded) {
    var summary = (ctx.state.sessions || []).find(function (item) { return item && item.id === sessionId; });
    var bridge = ctx.bridge;
    if (!summary) return Promise.resolve(false);
    var previous = { expanded: summary.children_expanded, revision: summary.coordination_revision };
    summary.children_expanded = expanded;
    ctx.onChange();
    // Without the bridge (no coordination store) the toggle stays a local view change.
    if (!bridge || typeof bridge.setView !== 'function') return Promise.resolve(true);
    function revisionOf(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
    function send(revision) {
      return Promise.resolve().then(function () {
        return bridge.setView({ schema_version: VIEW_SCHEMA_VERSION, session_id: sessionId, expected_revision: revision, patch: { children_expanded: expanded } });
      }).catch(function () { return null; });
    }
    // The conflict already carries the current revision; the full summary is only a fallback.
    function refetchRevision(conflict) {
      var current = conflict && conflict.current_revision;
      if (Number.isSafeInteger(current) && current >= 0) return Promise.resolve(current);
      if (typeof bridge.getSummary !== 'function') return Promise.resolve(0);
      return Promise.resolve().then(function () { return bridge.getSummary({ schema_version: VIEW_SCHEMA_VERSION, session_id: sessionId }); })
        .then(function (fresh) { return revisionOf(fresh && fresh.ok !== false ? fresh.coordination_revision : null); }, function () { return 0; });
    }
    var chain = (ctx.chains.get(sessionId) || Promise.resolve()).then(function () {
      return send(revisionOf(summary.coordination_revision)).then(function (response) {
        if (response && response.ok === false && response.reason === 'revision_conflict') {
          return refetchRevision(response).then(send);
        }
        return response;
      });
    }).then(function (response) {
      if (response && response.ok === true) {
        if (Number.isSafeInteger(response.coordination_revision)) summary.coordination_revision = response.coordination_revision;
        return true;
      }
      summary.children_expanded = previous.expanded;
      summary.coordination_revision = previous.revision;
      ctx.onChange();
      return false;
    });
    ctx.chains.set(sessionId, chain);
    return chain;
  }

  return {
    GENERAL_PROJECT_ID: GENERAL_PROJECT_ID,
    sessionTimestamp: sessionTimestamp,
    compareSessions: compareSessions,
    groupVisibleSessions: groupVisibleSessions,
    formatSessionTime: formatSessionTime,
    survivingNeighborIds: survivingNeighborIds,
    nearestSurvivingSessionId: nearestSurvivingSessionId,
    spawnedFromOf: spawnedFromOf,
    originCaption: originCaption,
    buildSessionTree: buildSessionTree,
    layoutGroups: layoutGroups,
    nodeSignature: nodeSignature,
    branchMarkup: branchMarkup,
    RELATION_ID_PREFIX: RELATION_ID_PREFIX,
    relationMarkup: relationMarkup,
    applyNodeToRow: applyNodeToRow,
    patchCollapsedChips: patchCollapsedChips,
    writeChildrenExpanded: writeChildrenExpanded,
  };
});
