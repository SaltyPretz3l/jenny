/* renderer/shell/renderer-chats-panel-projects.js
 *
 * Chats grouped by project (row 74, owner pick 2026-10-21). The project header row markup (a folder
 * that turns into a chevron, the name, the chat count, a collapsed project's roll-up dot, and the
 * hover "+" / "..." buttons), the "Show N more" / "Show less" control, the persisted view preference
 * (localStorage `jenny.chats.projectGroups.v1`) and the panel-side controller that owns the project
 * sections. The view model lives in renderer-chats-panel-model.js; styles in
 * styles/chats-panel-projects.css.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatsPanelProjects = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var stringUtils = (typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null);
  var escapeHtml = stringUtils.escapeHtml;
  var modelUi = globalThis.rendererChatsPanelModel || require('./renderer-chats-panel-model');
  var scrollUi = globalThis.rendererChatsPanelScroll || require('./renderer-chats-panel-scroll');
  var PROJECT_PAGE = modelUi.PROJECT_PAGE;
  var PROJECT_PAGE_STEP = modelUi.PROJECT_PAGE_STEP;
  var GENERAL_PROJECT_ID = modelUi.GENERAL_PROJECT_ID;
  var PREFS_KEY = 'jenny.chats.projectGroups.v1';
  var MAX_PREF_IDS = 200;
  var MAX_PREF_TEXT = 200;
  var CARET_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>';
  var CLICK_SELECTOR = '[data-project-toggle],[data-project-new],[data-project-menu],[data-project-more],[data-project-less]';
  var HEADER_FOCUS = ['[data-project-toggle]', '[data-project-new]', '[data-project-menu]'];
  var MORE_SELECTOR = '.project-group__more';

  var FOLDER_SVG = '<svg class="project-header__folder" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" /></svg>';
  var CHEVRON_SVG = '<svg class="project-header__chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>';
  var PLUS_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>';
  var DOTS_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.25" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.75" cy="8" r="1.25" /></svg>';

  function toneText(tone) {
    if (tone === 'approval') return jt('sidebar.chats.projects.stateNeedsYou', 'needs you');
    if (tone === 'streaming') return jt('sidebar.linked.stateWorking', 'working');
    if (tone === 'unread') return jt('sidebar.linked.stateUnread', 'unread');
    return '';
  }

  /** The toggle's accessible name: "jenny, 7 chats" plus a collapsed project's state ("needs you"). */
  function toggleLabel(group) {
    var label = group.count > 0
      ? jtn('sidebar.chats.projects.toggleLabel', group.count, { name: group.label, count: group.count }, '{name}, {count} chat', '{name}, {count} chats')
      : group.label;
    var tone = group.collapsed ? toneText(group.tone) : '';
    return tone ? label + ', ' + tone : label;
  }

  /**
   * Header row of one project section. group: a project group from the view model
   * ({projectId, label, count, collapsed, tone}). actionButton: the inventory button primitive.
   * The toggle is a Tab stop; "+" and "..." are not (the project menu and its keyboard entry cover them).
   */
  function projectHeaderMarkup(group, actionButton) {
    var id = String(group.projectId);
    var name = String(group.label || '');
    var label = toggleLabel(group);
    // The title also shows a name the header truncates.
    var toggle = actionButton({
      plain: true,
      className: 'project-header__toggle',
      ariaLabel: label,
      title: label,
      ariaExpanded: !group.collapsed,
      tabIndex: 0,
      dataset: { 'project-toggle': id },
      trustedHtml: '<span class="project-header__icon" aria-hidden="true">' + FOLDER_SVG + CHEVRON_SVG + '</span>'
        + '<span class="project-header__name">' + escapeHtml(name) + '</span>',
    });
    var dot = group.collapsed && group.tone
      ? '<span class="project-header__dot" data-tone="' + escapeHtml(group.tone) + '" aria-hidden="true"></span>'
      : '';
    var count = group.count > 0
      ? '<span class="project-header__count" aria-hidden="true">' + escapeHtml(String(group.count)) + '</span>'
      : '';
    var newLabel = jt('sidebar.chats.newChatIn', 'New chat in {name}', { name: name });
    var newButton = actionButton({
      plain: true,
      className: 'project-header__new',
      ariaLabel: newLabel,
      title: newLabel,
      tabIndex: -1,
      dataset: { 'project-new': id },
      trustedHtml: PLUS_SVG,
    });
    var menuButton = actionButton({
      plain: true,
      className: 'project-header__menu',
      ariaLabel: jt('sidebar.chats.projects.actionsFor', 'Actions for project {name}', { name: name }),
      ariaHaspopup: 'menu',
      title: jt('sidebar.chats.projects.actions', 'Project actions'),
      tabIndex: -1,
      dataset: { 'project-menu': id },
      trustedHtml: DOTS_SVG,
    });
    return toggle + dot + count + newButton + menuButton;
  }

  /** "Show N more" (N = the next page, at most `step`) or "Show less"; '' when neither applies. */
  function moreButtonMarkup(group, actionButton, step) {
    var id = String(group.projectId);
    if (group.collapsed) return '';
    if (group.remaining > 0) {
      var next = Math.min(group.remaining, step);
      return actionButton({
        plain: true,
        className: 'project-group__more',
        dataset: { 'project-more': id },
        label: jtn('sidebar.chats.projects.showMore', next, { count: next }, 'Show {count} more', 'Show {count} more'),
      });
    }
    if (group.canShowLess) {
      return actionButton({
        plain: true,
        className: 'project-group__more',
        dataset: { 'project-less': id },
        label: jt('sidebar.chats.projects.showLess', 'Show less'),
      });
    }
    return '';
  }

  // ---- persisted view preference (localStorage `jenny.chats.projectGroups.v1`) ----

  function isPrefId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= MAX_PREF_TEXT && id !== '__proto__';
  }
  function pickCollapsed(value) { return value === true ? true : undefined; }
  function pickName(value) { return (typeof value === 'string' && value.trim().slice(0, MAX_PREF_TEXT)) || undefined; }

  /** Own, safe ids only; at most MAX_PREF_IDS, keeping the newest (last inserted). */
  function boundedMap(source, pick) {
    var out = {};
    var picked = [];
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      Object.keys(source).forEach(function (id) {
        var value = isPrefId(id) ? pick(source[id]) : undefined;
        if (value !== undefined) picked.push([id, value]);
      });
    }
    picked.slice(-MAX_PREF_IDS).forEach(function (pair) { out[pair[0]] = pair[1]; });
    return out;
  }

  function normalizePrefs(value) {
    var known = value && typeof value === 'object' && !Array.isArray(value) && (value.v === undefined || value.v === 1);
    var v = known ? value : {};
    var prefs = { v: 1, mode: v.mode === 'date' ? 'date' : 'project', collapsed: boundedMap(v.collapsed, pickCollapsed), names: boundedMap(v.names, pickName) };
    Object.freeze(prefs.collapsed);
    Object.freeze(prefs.names);
    return Object.freeze(prefs);
  }

  // Per storage object: the raw string last seen or written and what it parsed to, so repeated reads are
  // cheap, a read after a write is consistent (even when the write was refused) and a change made
  // elsewhere to the stored value is still picked up.
  var prefsCache = new WeakMap();

  function rawOf(storage) {
    try {
      var raw = storage.getItem(PREFS_KEY);
      return typeof raw === 'string' ? raw : '';
    } catch (_error) { return ''; }
  }

  function readPrefs(storage) {
    if (!storage || (typeof storage !== 'object' && typeof storage !== 'function')) return normalizePrefs(null);
    var raw = rawOf(storage);
    var cached = prefsCache.get(storage);
    if (cached && cached.raw === raw) return cached.prefs;
    var parsed;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (_error) { parsed = null; }
    var prefs = normalizePrefs(parsed);
    prefsCache.set(storage, { raw: raw, prefs: prefs });
    return prefs;
  }

  function writePrefs(storage, prefs) {
    var next = normalizePrefs(prefs);
    if (!storage || (typeof storage !== 'object' && typeof storage !== 'function')) return next;
    var raw = JSON.stringify(next);
    try {
      storage.setItem(PREFS_KEY, raw);
      prefsCache.set(storage, { raw: raw, prefs: next });
    } catch (_error) { prefsCache.set(storage, { raw: rawOf(storage), prefs: next }); }
    return next;
  }

  /** mutate(draft) edits a copy and returns false when nothing changed (no write). */
  function updatePrefs(storage, mutate) {
    var current = readPrefs(storage);
    var draft = { v: 1, mode: current.mode, collapsed: Object.assign({}, current.collapsed), names: Object.assign({}, current.names) };
    return mutate(draft) === false ? current : writePrefs(storage, draft);
  }

  function setProjectsCollapsed(storage, projectIds, collapsed) {
    return updatePrefs(storage, function (draft) {
      var changed = false;
      Array.from(projectIds || []).forEach(function (id) {
        var has = Object.prototype.hasOwnProperty.call(draft.collapsed, id);
        if (!isPrefId(id) || has === Boolean(collapsed)) return;
        if (collapsed) draft.collapsed[id] = true;
        else delete draft.collapsed[id];
        changed = true;
      });
      return changed;
    });
  }
  function setProjectCollapsed(storage, projectId, collapsed) { return setProjectsCollapsed(storage, [projectId], collapsed); }

  function setGroupMode(storage, mode) {
    var wanted = mode === 'date' ? 'date' : 'project';
    return updatePrefs(storage, function (draft) {
      if (draft.mode === wanted) return false;
      draft.mode = wanted;
      return true;
    });
  }

  function rememberNames(storage, namesById) {
    return updatePrefs(storage, function (draft) {
      var changed = false;
      Object.keys(namesById || {}).forEach(function (id) {
        var name = pickName(namesById[id]);
        if (!isPrefId(id) || name === undefined || draft.names[id] === name) return;
        draft.names[id] = name;
        changed = true;
      });
      return changed;
    });
  }

  function pruneProjects(storage, knownIds) {
    var known = new Set(Array.from(knownIds || [], String));
    known.add(GENERAL_PROJECT_ID);
    return updatePrefs(storage, function (draft) {
      var changed = false;
      ['collapsed', 'names'].forEach(function (field) {
        Object.keys(draft[field]).filter(function (id) { return !known.has(id); }).forEach(function (id) {
          delete draft[field][id];
          changed = true;
        });
      });
      return changed;
    });
  }

  function storageOf(windowRef) {
    try { return windowRef && windowRef.localStorage || null; } catch (_error) { return null; }
  }

  /** True unless the user chose "By date". The project switcher asks this on a Workspace switch. */
  function prefersProjectGroups(windowRef) { return readPrefs(storageOf(windowRef)).mode !== 'date'; }
  function expandProject(windowRef, projectId) { setProjectCollapsed(storageOf(windowRef), projectId, false); }

  // ---- panel-side controller ----

  function attempt(fn) { return new Promise(function (resolve) { resolve(fn()); }); }
  function headerSignature(group) { return JSON.stringify([group.label, group.count, group.collapsed, group.tone]); }
  function moreSignature(group) { return JSON.stringify([group.collapsed, group.remaining, group.canShowLess]); }

  /**
   * Owns the project sections of the Chats list: header rows, the "Show more" control, clicks, the project
   * and group-by menus, the persisted preference and a collapsed project's roll-up dot. The panel passes
   * its own seams in `deps` (see renderer-chats-panel.js) and stays the only writer of the list.
   */
  function createProjectGroupsController(deps) {
    var documentRef = deps.documentRef;
    var actionButton = deps.actionButton;
    var windowRef = deps.windowRef || globalThis;
    var memoryValue = null; // stands in for localStorage when the window refuses it
    var memoryStorage = { getItem: function () { return memoryValue; }, setItem: function (_key, next) { memoryValue = String(next); } };
    var entries = new WeakMap(); // section -> { section, header, list, more, group, headerSig, moreSig }
    var limits = new Map(); // project id -> root limit (session-only)
    var labelById = new Map(); // project id -> the label its header shows (disambiguated)
    var lastModel = null;
    // A show-more control appeared, went or changed since the panel last asked (it shifts the rows below).
    var layoutChanged = false;
    var prunedSignature = '';
    var disposed = false;

    function storage() { return storageOf(windowRef) || memoryStorage; }
    function prefs() { return readPrefs(storage()); }
    function groupMode() { return prefs().mode; }
    function render(options) { if (!disposed) deps.scheduleRender(options); }
    function projectGroups() { return (lastModel ? lastModel.groups : []).filter(function (group) { return group.kind === 'project'; }); }
    function projectGroupOf(projectId) { return projectGroups().filter(function (group) { return group.projectId === projectId; })[0] || null; }

    function logFailure(action, error) {
      var message = String(error && error.message || error).slice(0, 120);
      deps.appendClientLog && deps.appendClientLog('WARN', 'sessions.project_group_action_failed', { action: action, message: message });
    }

    function fallbackName(id) {
      return prefs().names[id] || modelUi.defaultProjectName(id);
    }

    /** The disambiguated label a project's header shows; '' until the project list has loaded. */
    function labelOf(id) {
      return labelById.get(id) || '';
    }

    /** The switcher's ordered projects with disambiguated labels; empty until the list has loaded. */
    function projectInputs(mode) {
      var switcher = deps.getSwitcher();
      var list = switcher && typeof switcher.getProjects === 'function' ? switcher.getProjects() : null;
      if (!Array.isArray(list) || !list.length) {
        if (!switcher && mode === 'project') deps.requestSwitcher();
        return { projects: [], currentProjectId: '' };
      }
      var menu = windowRef.rendererProjectMenu || globalThis.rendererProjectMenu;
      var labels = menu && typeof menu.displayNames === 'function' ? menu.displayNames(list) : {};
      var projects = list.map(function (project) { return { id: project.id, name: labels[project.id] || project.name }; });
      var names = {};
      labelById.clear();
      var ids = projects.map(function (project) { names[project.id] = project.name; labelById.set(project.id, project.name); return project.id; });
      rememberNames(storage(), names);
      if (ids.join('|') !== prunedSignature) {
        prunedSignature = ids.join('|');
        pruneProjects(storage(), ids);
      }
      var current = typeof switcher.currentProject === 'function' ? switcher.currentProject() : null;
      return { projects: projects, currentProjectId: current && current.id || GENERAL_PROJECT_ID };
    }

    function modelOptions() {
      var current = prefs();
      var inputs = projectInputs(current.mode);
      return {
        groupMode: current.mode,
        collapsedProjects: current.collapsed,
        projectLimits: limits,
        projects: inputs.projects,
        currentProjectId: inputs.currentProjectId,
        projectName: fallbackName,
      };
    }

    function refocus(container, selector) {
      scrollUi.focusQuiet(selector && container.querySelector(selector));
    }

    function createEntry(group) {
      var section = documentRef.createElement('section');
      section.className = 'conversation-group project-group';
      section.dataset.chatsGroup = group.key;
      var header = documentRef.createElement('div');
      header.className = 'project-header';
      var list = documentRef.createElement('ul');
      list.className = 'group-items';
      section.append(header, list);
      var entry = { section: section, header: header, list: list, more: null, group: group, headerSig: '', moreSig: '' };
      entries.set(section, entry);
      return entry;
    }

    function syncHeader(entry, group) {
      if (entry.headerSig === headerSignature(group)) return;
      var focused = scrollUi.focusedSelector(entry.header, HEADER_FOCUS);
      entry.header.innerHTML = projectHeaderMarkup(group, actionButton);
      entry.headerSig = headerSignature(group);
      refocus(entry.header, focused);
    }

    function syncMore(entry, group) {
      if (entry.moreSig === moreSignature(group)) return;
      layoutChanged = true;
      var focused = entry.more ? scrollUi.focusedSelector(entry.more, [MORE_SELECTOR]) : '';
      var markup = moreButtonMarkup(group, actionButton, PROJECT_PAGE_STEP);
      if (entry.more) entry.more.remove();
      entry.more = null;
      if (markup) {
        var holder = documentRef.createElement('div');
        holder.innerHTML = markup;
        entry.more = holder.firstElementChild;
        entry.list.after(entry.more);
      }
      entry.moreSig = moreSignature(group);
      if (focused) refocus(entry.section, MORE_SELECTOR);
    }

    /** The project section (header, rows, more) of a project group: `section` from the last render, or a new one. */
    function ensureSection(section, group) {
      var entry = section && entries.get(section) || createEntry(group);
      entry.section.dataset.projectId = group.projectId;
      entry.section.dataset.collapsed = group.collapsed ? 'true' : 'false';
      entry.group = group;
      syncHeader(entry, group);
      syncMore(entry, group);
      return entry.section;
    }

    /** After each structural render: remember the model (menus and runtime repaints read it). */
    function afterModel(model) {
      lastModel = model;
    }

    /** Runtime state changed: repaint a collapsed project's dot (and its spoken state), no structural render. */
    function patchTones(runtimeState) {
      if (disposed) return;
      projectGroups().forEach(function (group) {
        var section = group.collapsed ? deps.sectionOf(group.key) : null;
        var entry = section ? entries.get(section) : null;
        var tone = entry ? modelUi.toneOf(group.sessionIds, runtimeState, group.unread) : '';
        if (!entry || tone === entry.group.tone) return;
        entry.group = Object.assign({}, entry.group, { tone: tone });
        syncHeader(entry, entry.group);
      });
    }

    /** Opens a project far enough to show `roots` of its chats; true when that changed anything. */
    function reveal(projectId, roots) {
      var changed = prefs().collapsed[projectId] === true;
      if (changed) setProjectCollapsed(storage(), projectId, false);
      if (roots > (limits.get(projectId) || PROJECT_PAGE)) {
        limits.set(projectId, roots);
        changed = true;
      }
      return changed;
    }

    function switcherOrRequest() { return deps.getSwitcher() || deps.requestSwitcher(); }

    function startChat(projectId) {
      return attempt(switcherOrRequest).then(function (switcher) {
        if (!switcher || typeof switcher.newChatInProject !== 'function') throw new Error('project switcher unavailable');
        setProjectCollapsed(storage(), projectId, false);
        render();
        return switcher.newChatInProject(projectId);
      });
    }

    function collapseAllItem() {
      var ids = projectGroups().map(function (group) { return group.projectId; });
      var collapsed = prefs().collapsed;
      var all = ids.length > 0 && ids.every(function (id) { return collapsed[id] === true; });
      return {
        label: all ? jt('sidebar.chats.projects.expandAll', 'Expand all projects') : jt('sidebar.chats.projects.collapseAll', 'Collapse all projects'),
        action: function () { setProjectsCollapsed(storage(), ids, !all); render(); },
      };
    }

    function showOnly(projectId) {
      deps.setProjectFilter(projectId);
      var switcher = deps.getSwitcher();
      if (switcher && typeof switcher.setChatsFilter === 'function') switcher.setChatsFilter(projectId);
    }

    function projectMenuItems(projectId) {
      var group = projectGroupOf(projectId);
      var name = group ? group.label : fallbackName(projectId);
      var switcher = deps.getSwitcher();
      var items = [{ label: jt('sidebar.chats.newChatIn', 'New chat in {name}', { name: name }), action: function () { return startChat(projectId); } }];
      if (switcher && typeof switcher.openProjectAsWorkspace === 'function' && projectId !== GENERAL_PROJECT_ID && !(group && group.current)) {
        items.push({
          label: jt('sidebar.chats.projects.openAsWorkspace', 'Open as Workspace folder'),
          action: function () { return attempt(function () { return switcher.openProjectAsWorkspace(projectId); }); },
        });
      }
      items.push({ label: jt('sidebar.chats.projects.showOnly', 'Show only this project'), action: function () { showOnly(projectId); } });
      return items.concat(copyMenuItems(projectId, name), [{ separator: true }, collapseAllItem()]);
    }

    // Copy project name / path: the shared sidebar helper, once renderer-session-actions.js has loaded it.
    var copyItems = null;
    function copyMenuItems(projectId, name) {
      var copyModule = windowRef.rendererSidebarCopyItems;
      copyItems = copyItems || (copyModule ? copyModule.createSidebarCopyItems({ windowRef: windowRef, getSwitcher: switcherOrRequest, showToastMessage: deps.showToastMessage, appendClientLog: deps.appendClientLog }) : null);
      return copyItems ? copyItems.projectMenuItems(projectId, name) : [];
    }

    function showMenu(button, name, menuOptions) {
      var menu = deps.contextMenu;
      if (!menu || typeof menu.show !== 'function') return;
      var rect = button.getBoundingClientRect();
      menu.show(Object.assign({
        rootEl: documentRef.body,
        anchorX: rect.left,
        anchorY: rect.bottom,
        restoreFocusTo: button,
        onActionError: function (error) { logFailure(name, error); },
      }, menuOptions));
    }

    function openGroupByMenu(button) {
      var mode = groupMode();
      function pick(next) { return function () { setGroupMode(storage(), next); render({ scrollPolicy: 'reset' }); }; }
      showMenu(button, 'group_by_menu', {
        focusChecked: true,
        items: [
          { label: jt('sidebar.chats.groupBy.menuProject', 'Group by project'), checked: mode === 'project', action: pick('project') },
          { label: jt('sidebar.chats.groupBy.menuDate', 'Group by date'), checked: mode === 'date', action: pick('date') },
        ],
      });
    }

    /** The "By project" / "By date" button at the end of the project filter row; '' when it cannot apply. */
    function groupByMarkup(model) {
      if (!model || model.projectId || (!model.groupByAvailable && model.grouping !== 'project')) return '';
      var mode = groupMode();
      var modeLabel = mode === 'date' ? jt('sidebar.chats.groupBy.date', 'By date') : jt('sidebar.chats.groupBy.project', 'By project');
      var label = jt('sidebar.chats.groupBy.label', 'Group chats');
      return actionButton({
        plain: true,
        className: 'chats-project-filter chats-group-by',
        ariaHaspopup: 'menu',
        ariaLabel: label + ': ' + modeLabel, // the visible words are part of the accessible name
        title: label,
        dataset: { 'chats-group-by': mode },
        trustedHtml: '<span class="chats-project-filter-name">' + escapeHtml(modeLabel) + '</span>' + CARET_SVG,
      });
    }

    function toggleProject(projectId) {
      if (lastModel && lastModel.query) return; // search forces every section open; there is nothing to flip
      setProjectCollapsed(storage(), projectId, prefs().collapsed[projectId] !== true);
      render();
    }

    /** Click delegation for the project sections; true when the click was one of theirs. */
    function handleClick(event) {
      var target = event.target && event.target.closest && event.target.closest(CLICK_SELECTOR);
      if (!target) return false;
      event.preventDefault();
      var data = target.dataset;
      if (data.projectToggle !== undefined) {
        toggleProject(data.projectToggle);
      } else if (data.projectNew !== undefined) {
        startChat(data.projectNew).catch(function (error) { logFailure('project_new_chat', error); });
      } else if (data.projectMenu !== undefined) {
        showMenu(target, 'project_menu', { items: projectMenuItems(data.projectMenu) });
      } else {
        if (data.projectMore !== undefined) {
          var shown = projectGroups().find(function (group) { return group.projectId === data.projectMore; });
          limits.set(data.projectMore, shown && shown.remaining > 0
            ? shown.shownRoots + Math.min(PROJECT_PAGE_STEP, shown.remaining)
            : (limits.get(data.projectMore) || PROJECT_PAGE) + PROJECT_PAGE_STEP);
        }
        else limits.delete(data.projectLess);
        render();
      }
      return true;
    }

    /** Right-click on a project header opens its project menu at the pointer; true when the event was one of theirs. */
    function handleContextMenu(event) {
      var header = event.target && event.target.closest && event.target.closest('.project-header');
      var section = header && header.closest('.project-group');
      var projectId = section && section.dataset.projectId;
      if (!projectId) return false;
      event.preventDefault();
      // The keyboard menu key reports no pointer: anchor on the "..." button, as its keydown path does.
      var pointer = event.clientX || event.clientY;
      var trigger = pointer && header.querySelector('[data-project-toggle]') || header.querySelector('[data-project-menu]');
      if (!trigger) return true;
      showMenu(trigger, 'project_menu', Object.assign({ items: projectMenuItems(projectId) }, pointer ? { anchorX: event.clientX, anchorY: event.clientY } : {}));
      return true;
    }

    return {
      modelOptions: modelOptions,
      ensureSection: ensureSection,
      afterModel: afterModel,
      takeLayoutChange: function () { var changed = layoutChanged; layoutChanged = false; return changed; },
      handleClick: handleClick,
      handleContextMenu: handleContextMenu,
      groupByMarkup: groupByMarkup,
      openGroupByMenu: openGroupByMenu,
      groupMode: groupMode,
      patchTones: patchTones,
      reveal: reveal,
      labelOf: labelOf,
      resetLimits: function () { limits.clear(); },
      dispose: function () { disposed = true; limits.clear(); labelById.clear(); lastModel = null; },
    };
  }

  return {
    PREFS_KEY: PREFS_KEY,
    readPrefs: readPrefs,
    writePrefs: writePrefs,
    setProjectCollapsed: setProjectCollapsed,
    setProjectsCollapsed: setProjectsCollapsed,
    setGroupMode: setGroupMode,
    rememberNames: rememberNames,
    pruneProjects: pruneProjects,
    prefersProjectGroups: prefersProjectGroups,
    expandProject: expandProject,
    createProjectGroupsController: createProjectGroupsController,
  };
});
