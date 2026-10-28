/* renderer/shell/renderer-chats-panel-model.js
 *
 * Pure view model of the Chats sidebar: eligibility (scope, project filter, search), the
 * linked-chat tree, and either the date groups or, in project mode (row 74), a Pinned group
 * followed by one section per project with per-project paging and collapse. No DOM; the panel
 * controller renders what this returns.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatsPanelModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var treeUi = globalThis.rendererChatsPanelTree || require('./renderer-chats-panel-tree');

  var PAGE_SIZE = 100;
  var MAX_VISIBLE = 500;
  var SEARCH_LIMIT = 200;
  var PROJECT_PAGE = 5;
  var PROJECT_PAGE_STEP = 50;
  var GENERAL_PROJECT_ID = treeUi.GENERAL_PROJECT_ID;

  var projectOf = treeUi.projectOf;
  var isPinnedRoot = treeUi.isPinnedRoot;
  var normalizeInlineText = treeUi.normalizeInline;
  var emitAll = treeUi.emitAll;

  // Lowercased search text per summary object. A summary patch replaces the object, so an entry
  // never outlives its title or preview; the locale tag guards the translated "New Chat" fallback.
  var searchTextCache = new WeakMap();
  function searchTextOf(session) {
    var tag = String(globalThis.jennyI18n && typeof globalThis.jennyI18n.tag === 'function' ? globalThis.jennyI18n.tag() : '');
    var cached = searchTextCache.get(session);
    if (cached && cached.tag === tag) return cached.text;
    var title = normalizeInlineText(session.title).toLowerCase();
    if (!title || title === 'new chat') title += ' ' + jt('session.defaultTitle.chat', 'New Chat').toLowerCase();
    var text = title + ' ' + normalizeInlineText(session.last_message_preview).toLowerCase();
    searchTextCache.set(session, { tag: tag, text: text });
    return text;
  }

  /** Distinct projects of the scope's unpinned chats (no project filter, no search). */
  function scopeProjectIds(sessions, pendingDeletes, scope) {
    var ids = new Set();
    sessions.forEach(function (session) {
      if (!session || !session.id || pendingDeletes.has(session.id) || isPinnedRoot(session)) return;
      if ((scope === 'archived') !== Boolean(session.archived_at)) return;
      ids.add(projectOf(session));
    });
    return ids;
  }

  function emptyKindOf(shownCount, primaryShown, ctx) {
    // The Jenny row alone is not history: the empty state still explains the filter under it.
    if (shownCount !== (primaryShown ? 1 : 0)) return '';
    if (ctx.query) return primaryShown ? '' : 'search'; // the Jenny row matched: that is the result
    if (ctx.sessionCount && ctx.projectId && ctx.scope !== 'archived') return 'project';
    return ctx.sessionCount && ctx.scope === 'archived' ? 'archived' : 'empty';
  }

  function buildChatsViewModel(options) {
    var o = options || {};
    var sessions = Array.isArray(o.sessions) ? o.sessions : [];
    var pendingDeletes = o.pendingDeleteIds instanceof Set
      ? o.pendingDeleteIds
      : new Set(Array.isArray(o.pendingDeleteIds) ? o.pendingDeleteIds : []);
    var scope = o.scope === 'archived' ? 'archived' : 'recent';
    var query = normalizeInlineText(o.query).toLowerCase();
    // Projects v2: '' = all projects; a chat without project_id is General. Every count follows the filter (D15).
    var projectId = String(o.projectId || '').trim();
    // The primary "Jenny" chat (row 69) stays visible under every project filter and
    // leaves the list only through the JENNY_ENABLE_PRIMARY_CHAT=0 kill switch.
    var primaryHidden = o.primaryChatEnabled === false;
    var primaryShown = false;
    var recentTotal = 0;
    var archivedTotal = 0;
    var eligible = [];

    sessions.forEach(function (session) {
      if (!session || !session.id || pendingDeletes.has(session.id)) return;
      var primary = treeUi.isPrimarySession(session);
      if (primary && primaryHidden) return;
      var inProject = !projectId || projectOf(session) === projectId;
      if (!inProject && !primary) return;
      var archived = Boolean(session.archived_at);
      if (inProject) {
        if (archived) archivedTotal += 1;
        else recentTotal += 1;
      }
      if ((scope === 'archived') !== archived) return;
      if (query && !searchTextOf(session).includes(query)) return;
      if (primary) primaryShown = true;
      eligible.push(session);
    });

    eligible = treeUi.sortSessions(eligible);
    var matchedCount = eligible.length;
    var base = {
      scope: scope,
      query: query,
      noHistory: !query && !sessions.some(function (s) { return s && s.id && !pendingDeletes.has(s.id) && !treeUi.isPrimarySession(s); }),
      projectId: projectId,
      recentTotal: recentTotal,
      archivedTotal: archivedTotal,
      scopeTotal: scope === 'archived' ? archivedTotal : recentTotal,
      matchedCount: matchedCount,
      groupByAvailable: scopeProjectIds(sessions, pendingDeletes, scope).size >= 2,
    };
    var emptyCtx = { query: query, projectId: projectId, scope: scope, sessionCount: sessions.length };
    if (o.groupMode === 'project' && !projectId && projectGroupingApplies(eligible, o, scope, query)) {
      return buildProjectModel(base, eligible, { options: o, sessions: sessions, pendingDeletes: pendingDeletes, primaryShown: primaryShown, emptyCtx: emptyCtx });
    }
    var requestedLimit = Number.isFinite(o.visibleLimit) ? Math.max(PAGE_SIZE, o.visibleLimit) : PAGE_SIZE;
    var mountLimit = query ? SEARCH_LIMIT : Math.min(requestedLimit, MAX_VISIBLE);
    var visibleSessions = eligible.slice(0, mountLimit);
    // Linked chats nest under a parent only when the parent is itself shown here.
    var tree = treeUi.buildSessionTree({ sessions: visibleSessions, allSessions: sessions, pendingDeletes: pendingDeletes, scope: scope, projectId: projectId, query: query, isActive: o.isActive });
    var layout = treeUi.layoutGroups(tree, scope, o.now);
    return Object.assign(base, {
      grouping: 'date',
      visibleCount: visibleSessions.length,
      visibleSessions: layout.rendered,
      nodes: tree.nodes,
      groups: layout.groups,
      hasMore: !query && visibleSessions.length < Math.min(matchedCount, MAX_VISIBLE),
      capped: query ? matchedCount > SEARCH_LIMIT : matchedCount > MAX_VISIBLE && visibleSessions.length >= MAX_VISIBLE,
      remaining: Math.max(Math.min(matchedCount, MAX_VISIBLE) - visibleSessions.length, 0),
      emptyKind: emptyKindOf(visibleSessions.length, primaryShown, emptyCtx),
    });
  }

  // ---- project mode (row 74) ----

  function showsCurrentProjectHeader(o, scope, query) {
    return scope === 'recent' && !query && Boolean(o.currentProjectId);
  }

  function projectGroupingApplies(eligible, o, scope, query) {
    var ids = new Set();
    eligible.forEach(function (session) {
      if (!isPinnedRoot(session)) ids.add(projectOf(session));
    });
    if (showsCurrentProjectHeader(o, scope, query)) ids.add(String(o.currentProjectId));
    return ids.size >= 2;
  }

  /** A collapsed project's roll-up dot: needs you (approval) > working (streaming) > unread. The panel
   *  repaints it with this same rule on streaming ticks, without a structural render. */
  function toneOf(ids, runtimeState, anyUnread) {
    var streaming = false;
    for (var i = 0; i < ids.length; i += 1) {
      var state = runtimeState(ids[i]);
      if (state === 'approval') return 'approval';
      if (state === 'streaming') streaming = true;
    }
    return streaming ? 'streaming' : (anyUnread ? 'unread' : '');
  }

  function defaultProjectName(id) {
    return id === GENERAL_PROJECT_ID ? jt('projects.switcher.generalName', 'General') : jt('projects.filter.project', 'Project');
  }

  /** Newest chat per project; only needed to order projects the switcher has not listed (first paint). */
  function newestByProject(sessions) {
    var newest = new Map();
    sessions.forEach(function (session) {
      var id = projectOf(session);
      newest.set(id, Math.max(newest.get(id) || 0, treeUi.sessionTimestamp(session)));
    });
    return newest;
  }

  /** Projects in display order: listed ones as given, unlisted by newest chat, General last. */
  function orderProjectIds(present, projects, sessions) {
    var listed = [];
    var seen = new Set();
    projects.forEach(function (project) {
      if (!project || !present.has(project.id) || project.id === GENERAL_PROJECT_ID || seen.has(project.id)) return;
      seen.add(project.id);
      listed.push(project.id);
    });
    var unlisted = Array.from(present).filter(function (id) { return !seen.has(id) && id !== GENERAL_PROJECT_ID; });
    if (unlisted.length > 1) {
      var newest = newestByProject(sessions);
      unlisted.sort(function (a, b) { return (newest.get(b) || 0) - (newest.get(a) || 0) || String(a).localeCompare(String(b)); });
    }
    var ordered = listed.concat(unlisted);
    if (present.has(GENERAL_PROJECT_ID)) ordered.push(GENERAL_PROJECT_ID);
    return ordered;
  }

  /** Buckets the unpinned roots by project; every chat under them counts. */
  function bucketProjects(roots, tree) {
    var buckets = new Map();
    roots.forEach(function (root) {
      var id = projectOf(root);
      if (!buckets.has(id)) buckets.set(id, { roots: [], ids: [] });
      var bucket = buckets.get(id);
      bucket.roots.push(root);
      bucket.ids.push(root.id);
      Array.prototype.push.apply(bucket.ids, tree.nodes.get(root.id).descendantIds);
    });
    return buckets;
  }

  function projectLimitOf(ctx, id) {
    if (ctx.query) return Infinity;
    var requested = ctx.projectLimits ? ctx.projectLimits.get(id) : 0;
    return Math.min(Number.isFinite(requested) && requested > 0 ? requested : PROJECT_PAGE, MAX_VISIBLE);
  }

  function projectGroup(id, bucket, tree, ctx) {
    var roots = bucket.roots;
    var collapsed = !ctx.query && Boolean(ctx.collapsedProjects && ctx.collapsedProjects[id] === true);
    var wanted = collapsed ? 0 : Math.min(projectLimitOf(ctx, id), roots.length);
    // Every open project shows its first page; pages past it share one MAX_VISIBLE budget across
    // projects, so expanding many projects cannot mount the whole history. Search is already bounded.
    var firstPage = Math.min(PROJECT_PAGE, wanted);
    var extra = ctx.query ? wanted - firstPage : Math.min(wanted - firstPage, ctx.budget.left);
    if (!ctx.query) ctx.budget.left -= extra;
    var shownRoots = firstPage + extra;
    if (shownRoots < wanted) ctx.budget.clipped = true;
    // Capped by the budget's slack once every project is placed (buildProjectModel).
    var remaining = collapsed || ctx.query ? 0 : Math.max(Math.min(roots.length, MAX_VISIBLE) - shownRoots, 0);
    var unread = collapsed && bucket.ids.some(ctx.unreadOf);
    return {
      key: ctx.keyPrefix + 'project:' + id,
      kind: 'project',
      projectId: id,
      label: ctx.labels.get(id) || ctx.projectName(id),
      count: bucket.ids.length,
      collapsed: collapsed,
      unread: unread,
      tone: collapsed ? toneOf(bucket.ids, ctx.runtimeState, unread) : '',
      current: id === ctx.current,
      sessionIds: bucket.ids,
      rootIds: roots.map(function (root) { return root.id; }),
      shownRoots: shownRoots,
      remaining: remaining,
      canShowLess: false,
      items: collapsed ? [] : emitAll(roots.slice(0, shownRoots), tree),
    };
  }

  function buildProjectModel(base, eligible, env) {
    var o = env.options;
    var scope = base.scope;
    var query = base.query;
    var sliced = query ? eligible.slice(0, SEARCH_LIMIT) : eligible;
    var tree = treeUi.buildSessionTree({ sessions: sliced, allSessions: env.sessions, pendingDeletes: env.pendingDeletes, scope: scope, projectId: '', query: query, isActive: o.isActive, sameProjectOnly: true });
    var pinnedRoots = tree.roots.filter(isPinnedRoot);
    var pinnedGroups = treeUi.groupVisibleSessions(pinnedRoots, scope, o.now);
    pinnedGroups.forEach(function (group) { group.items = emitAll(group.items, tree); });
    var buckets = bucketProjects(tree.roots.filter(function (root) { return !isPinnedRoot(root); }), tree);
    var current = String(o.currentProjectId || '');
    if (showsCurrentProjectHeader(o, scope, query) && !buckets.has(current)) buckets.set(current, { roots: [], ids: [] });
    var unreadIds = new Set(sliced.filter(treeUi.unreadOf).map(function (s) { return s.id; }));
    var projects = Array.isArray(o.projects) ? o.projects : [];
    var labels = new Map();
    projects.forEach(function (project) { if (project && project.id) labels.set(project.id, project.name); });
    var ctx = {
      query: query,
      current: current,
      keyPrefix: scope === 'archived' ? 'archived_' : 'recent_',
      collapsedProjects: o.collapsedProjects,
      projectLimits: o.projectLimits,
      labels: labels,
      projectName: typeof o.projectName === 'function' ? o.projectName : defaultProjectName,
      runtimeState: typeof o.runtimeState === 'function' ? o.runtimeState : function () { return ''; },
      unreadOf: function (id) { return unreadIds.has(id); },
      budget: { left: MAX_VISIBLE, clipped: false },
    };
    var groups = pinnedGroups.concat(orderProjectIds(new Set(buckets.keys()), projects, sliced).map(function (id) {
      return projectGroup(id, buckets.get(id), tree, ctx);
    }));
    // What every project may still add is the budget left after all of them: past the cap a project
    // stops offering more (and offers less) instead of a page that cannot grow or that shrinks another.
    groups.forEach(function (group) {
      if (group.kind !== 'project') return;
      if (!query) group.remaining = Math.min(group.remaining, Math.max(ctx.budget.left, 0));
      group.canShowLess = !group.collapsed && !query && group.remaining === 0 && group.shownRoots > PROJECT_PAGE;
    });
    var rendered = [].concat.apply([], groups.map(function (group) { return group.items; }));
    var hasProjectGroup = groups.some(function (group) { return group.kind === 'project'; });
    return Object.assign(base, {
      grouping: 'project',
      visibleCount: rendered.length,
      visibleSessions: rendered,
      nodes: tree.nodes,
      groups: groups,
      hasMore: false,
      capped: query ? base.matchedCount > SEARCH_LIMIT : ctx.budget.clipped,
      remaining: 0,
      emptyKind: hasProjectGroup ? '' : emptyKindOf(rendered.length, env.primaryShown, env.emptyCtx),
    });
  }

  /**
   * Where a chat sits in a project-grouped model: {projectId, roots} = its project section and the
   * root limit that shows it (its root's position + 1). null when it is not in a project section.
   */
  function projectPlacement(model, sessionId) {
    if (!model || model.grouping !== 'project') return null;
    var rootId = sessionId;
    for (var guard = 0; guard < 64; guard += 1) {
      var node = model.nodes.get(rootId);
      if (!node || !node.parentId) break;
      rootId = node.parentId;
    }
    for (var i = 0; i < model.groups.length; i += 1) {
      var group = model.groups[i];
      var index = group.kind === 'project' ? group.rootIds.indexOf(rootId) : -1;
      if (index >= 0) return { projectId: group.projectId, roots: index + 1 };
    }
    return null;
  }

  return {
    PAGE_SIZE: PAGE_SIZE,
    MAX_VISIBLE: MAX_VISIBLE,
    SEARCH_LIMIT: SEARCH_LIMIT,
    PROJECT_PAGE: PROJECT_PAGE,
    PROJECT_PAGE_STEP: PROJECT_PAGE_STEP,
    GENERAL_PROJECT_ID: GENERAL_PROJECT_ID,
    toneOf: toneOf,
    defaultProjectName: defaultProjectName,
    buildChatsViewModel: buildChatsViewModel,
    projectPlacement: projectPlacement,
  };
});
