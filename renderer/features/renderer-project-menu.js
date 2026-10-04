/* renderer/features/renderer-project-menu.js
 *
 * The one project menu (Projects v2, 2026-09-20; intents 2026-09-27). A
 * role=menu popover shared by the Workspace Explorer header, the Workspace
 * welcome page, the composer pill, the chat row menu and the Chats panel
 * filter, so there is one project list to learn. Each use names what picking
 * does in a small uppercase heading ("Open project", "Move this chat to",
 * "Show chats from") and may add a muted footnote. Consumers hand it rows;
 * it owns markup, positioning, keyboard (arrows, Home/End, Enter/Space,
 * Escape), outside-click dismissal and focus return. No custom motion beyond
 * the app's popover chrome.
 *
 * Project rows are menuitemradio (aria-checked) inside a scrolling list whose
 * height is bounded to the viewport; commands are menuitem rows kept fixed
 * below it with the footnote. A disabled row is aria-disabled, not natively
 * disabled, so the keyboard still reaches it and hears its reason.
 *
 * Lazily loaded on first open through scriptLoaderUtils.ensureScript (no
 * startup <script> slot). Rows render through the inventory action-button
 * primitive; menu roles are applied after paint because the primitive does
 * not emit role attributes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererProjectMenu = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  const MENU_ID = 'projectMenu';
  const GENERAL_PROJECT_ID = 'project_general';
  const ROW_SELECTOR = '[data-project-menu-item]';

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function resolveActionButton() {
    return (root && root.inventoryActionButton)
      || (typeof require === 'function' ? require('../inventory/action-button') : null)
      || null;
  }

  // Same folder identity the Settings > Projects page uses: separators and
  // trailing slashes normalized, case folded (Windows paths).
  function folderKey(path) {
    return String(path || '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function countChatsByProject(sessions) {
    const counts = {};
    (Array.isArray(sessions) ? sessions : []).forEach((session) => {
      if (!session || !session.id) return;
      const id = String(session.project_id || '').trim() || GENERAL_PROJECT_ID;
      counts[id] = (counts[id] || 0) + 1;
    });
    return counts;
  }

  function generalName() {
    return jt('projects.switcher.generalName', 'General');
  }

  function optionalBool(value) {
    return value === true ? true : (value === false ? false : null);
  }

  function normalizeProject(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    if (!id) return null;
    const rootPath = typeof raw.root_path === 'string' ? raw.root_path.trim() : '';
    // folder_exists / is_current come from main (null or absent on an older
    // backend); the empty authority key is the older "cannot probe" signal.
    const folderExists = optionalBool(raw.folder_exists);
    const revision = Number(raw.root_revision);
    return {
      id,
      // General is always named in the current language, never the stored
      // English record name (D16).
      name: id === GENERAL_PROJECT_ID ? generalName() : (String(raw.name || '').trim() || id),
      rootPath,
      folderExists,
      folderMissing: Boolean(rootPath) && (folderExists === false || (folderExists === null && raw.authority_key === '')),
      isCurrent: optionalBool(raw.is_current),
      rootRevision: Number.isFinite(revision) ? revision : null,
    };
  }

  function normalizeProjectList(payload) {
    const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.projects) ? payload.projects : []);
    return list.map(normalizeProject).filter(Boolean);
  }

  function sessionProjectId(session) {
    return String(session && session.project_id || '').trim() || GENERAL_PROJECT_ID;
  }

  // project id -> the newest chat's updated_at (ISO strings compare in order).
  function lastUsedByProject(sessions) {
    const latest = {};
    (Array.isArray(sessions) ? sessions : []).forEach((session) => {
      if (!session || !session.id) return;
      const stamp = String(session.updated_at || session.created_at || '');
      const id = sessionProjectId(session);
      if (stamp && (!latest[id] || stamp > latest[id])) latest[id] = stamp;
    });
    return latest;
  }

  // The one order every surface uses (D18): the current project first, then
  // most recently used (newest chat), then by name; General is never part of
  // it (callers append it last or leave it out).
  function sortProjectsForMenu(projects, currentId, sessions) {
    const used = lastUsedByProject(sessions);
    return (projects || [])
      .filter((project) => project && project.id !== GENERAL_PROJECT_ID)
      .slice()
      .sort((a, b) => {
        if (a.id === currentId) return -1;
        if (b.id === currentId) return 1;
        const ua = used[a.id] || '';
        const ub = used[b.id] || '';
        if (ua !== ub) return ua > ub ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
  }

  // sortProjectsForMenu plus General last (when listed).
  function orderProjects(projects, options) {
    const o = options || {};
    const list = Array.isArray(projects) ? projects : [];
    const general = list.find((project) => project && project.id === GENERAL_PROJECT_ID);
    const ordered = sortProjectsForMenu(list, o.currentId, o.sessions);
    if (general) ordered.push(general);
    return ordered;
  }

  function parentFolderName(rootPath) {
    const parts = String(rootPath || '').split(/[\\/]+/).filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2].replace(/:$/, '') : '';
  }

  // id -> the label a menu shows. Two projects may share a name (D17); those
  // read "name · parent folder" ("src · jenny") so the pick is unambiguous.
  function displayNames(projects) {
    const byName = {};
    (projects || []).forEach((project) => {
      if (!project) return;
      const nameKey = String(project.name || '').toLocaleLowerCase();
      byName[nameKey] = (byName[nameKey] || 0) + 1;
    });
    const labels = {};
    (projects || []).forEach((project) => {
      if (!project) return;
      const parent = parentFolderName(project.rootPath);
      labels[project.id] = byName[String(project.name || '').toLocaleLowerCase()] > 1 && parent
        ? project.name + ' · ' + parent
        : project.name;
    });
    return labels;
  }

  function chatCountLabel(count) {
    const n = Math.max(0, Number(count) || 0);
    return jtn('settings.projects.chatCount', n, { count: n }, '{count} chat', '{count} chats');
  }

  // A project row for the switcher / filter / move menus.
  function projectRow(project, options) {
    const o = options || {};
    return {
      id: project.id,
      label: o.label || project.name,
      detail: project.rootPath
        ? (project.folderMissing
          ? project.rootPath + ' · ' + jt('projects.switcher.folderMissing', 'folder missing')
          : project.rootPath)
        : '',
      danger: project.folderMissing,
      count: typeof o.count === 'number' ? o.count : null,
      selected: o.selected === true,
      disabled: o.disabled === true,
      reason: o.reason || '',
      title: o.title || '',
      kind: 'project',
    };
  }

  function rowHtml(actionButton, row, index) {
    const check = '<span class="project-menu-check" aria-hidden="true">' + (row.selected ? '✓' : '') + '</span>';
    const name = '<span class="project-menu-name' + (row.danger ? ' project-menu-name--danger' : '') + '">' + escapeHtml(row.label) + '</span>';
    const detail = row.detail
      ? '<span class="project-menu-detail' + (row.danger ? ' project-menu-detail--danger' : '') + '">' + escapeHtml(row.detail) + '</span>'
      : '';
    const count = row.count == null
      ? ''
      : '<span class="project-menu-count" aria-label="' + escapeHtml(chatCountLabel(row.count)) + '">' + escapeHtml(String(row.count)) + '</span>';
    // The reason a disabled row cannot be picked is its description, so the
    // keyboard hears it on focus (hidden nodes still feed aria-describedby).
    const reasonText = row.disabled === true ? String(row.reason || row.title || '').trim() : '';
    const reason = reasonText && reasonText !== String(row.detail || '').trim()
      ? '<span class="project-menu-reason" id="' + MENU_ID + 'Reason' + index + '" hidden>' + escapeHtml(reasonText) + '</span>'
      : '';
    return (row.separatorBefore ? '<div class="project-menu-separator" role="separator"></div>' : '')
      + actionButton({
        plain: true,
        className: 'project-menu-row' + (row.kind === 'action' ? ' project-menu-row--action' : ''),
        title: row.title || undefined,
        dataset: { 'project-menu-item': String(index) },
        trustedHtml: check + '<span class="project-menu-main">' + name + detail + '</span>' + count + reason,
      });
  }

  function isRowDisabled(rowEl) {
    return Boolean(rowEl) && (rowEl.disabled === true || rowEl.getAttribute('aria-disabled') === 'true');
  }

  function createProjectMenu(deps) {
    const d = deps || {};
    const windowRef = d.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    const documentRef = d.documentRef || windowRef.document || null;
    const actionButton = typeof d.actionButton === 'function' ? d.actionButton : resolveActionButton();
    let open = null; // { element, anchor, rows, onPick, onClose }

    function menuElement() {
      return documentRef && typeof documentRef.getElementById === 'function' ? documentRef.getElementById(MENU_ID) : null;
    }

    function rows() {
      const element = menuElement();
      return element ? Array.from(element.querySelectorAll(ROW_SELECTOR)) : [];
    }

    function enabledRows() {
      return rows().filter((row) => !isRowDisabled(row));
    }

    function position(element, anchor) {
      if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return;
      // Opened from the collapsed composer's settings list: it covers the list.
      let rail = root && root.rendererPaneComposerRail;
      if (!rail && typeof require === 'function') {
        try { rail = require('../chat/renderer-pane-composer-rail'); } catch (_error) { rail = null; }
      }
      const anchorGroup = rail && rail.resolveSettingsPopoverAnchor ? rail.resolveSettingsPopoverAnchor(anchor) : null;
      if (anchorGroup && rail.placePopoverOverAnchor(element, anchorGroup, { margin: 12 })) return;
      if (rail && rail.clearPopoverCover) rail.clearPopoverCover(element);
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = Number(windowRef.innerWidth) || 0;
      const viewportHeight = Number(windowRef.innerHeight) || 0;
      const width = element.offsetWidth || 0;
      const height = element.offsetHeight || 0;
      let left = rect.left;
      if (viewportWidth && width && left + width > viewportWidth - 12) left = Math.max(12, viewportWidth - width - 12);
      let top = rect.bottom + 4;
      if (viewportHeight && height && top + height > viewportHeight - 12 && rect.top - height - 4 >= 0) {
        top = rect.top - height - 4;
      }
      element.style.top = Math.max(0, Math.round(top)) + 'px';
      element.style.left = Math.max(0, Math.round(left)) + 'px';
    }

    function close(options) {
      const o = options || {};
      const current = open;
      if (!current) return false;
      open = null;
      if (documentRef && typeof documentRef.removeEventListener === 'function') {
        documentRef.removeEventListener('pointerdown', handleOutsidePointer, true);
        documentRef.removeEventListener('keydown', handleDocumentKeydown, true);
      }
      if (current.element && current.element.parentNode) current.element.parentNode.removeChild(current.element);
      if (o.restoreFocus !== false && current.anchor && typeof current.anchor.focus === 'function') {
        try { current.anchor.focus(); } catch (_error) { /* detached anchor */ }
      }
      if (current.anchor && typeof current.anchor.setAttribute === 'function') current.anchor.setAttribute('aria-expanded', 'false');
      if (typeof current.onClose === 'function') current.onClose();
      return true;
    }

    function handleOutsidePointer(event) {
      const current = open;
      if (!current) return;
      const target = event && event.target;
      if (current.element && target && typeof current.element.contains === 'function' && current.element.contains(target)) return;
      if (current.anchor && target && typeof current.anchor.contains === 'function' && current.anchor.contains(target)) return;
      close({ restoreFocus: false });
    }

    function handleDocumentKeydown(event) {
      if (open && event && event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    }

    // Arrow keys walk every row, disabled ones included (D19): a disabled row
    // is announced with its reason instead of being skipped silently.
    function focusRow(index) {
      const list = rows();
      if (!list.length) return;
      const clamped = ((index % list.length) + list.length) % list.length;
      list[clamped].focus();
    }

    function handleMenuKeydown(event) {
      const list = rows();
      const active = documentRef ? documentRef.activeElement : null;
      const current = list.indexOf(active);
      if (event.key === 'ArrowDown') { event.preventDefault(); focusRow(current + 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); focusRow(current - 1); }
      else if (event.key === 'Home') { event.preventDefault(); focusRow(0); }
      else if (event.key === 'End') { event.preventDefault(); focusRow(list.length - 1); }
      else if (event.key === 'Tab') { close(); }
    }

    function handleMenuClick(event) {
      const current = open;
      const target = event && event.target;
      if (!current || !target || typeof target.closest !== 'function') return;
      const rowEl = target.closest(ROW_SELECTOR);
      if (!rowEl) return;
      if (isRowDisabled(rowEl)) { event.preventDefault(); return; }
      event.preventDefault();
      const row = current.rows[Number(rowEl.getAttribute('data-project-menu-item'))];
      if (!row) return;
      close();
      if (typeof current.onPick === 'function') current.onPick(row);
    }

    // Project rows (kind 'project', or radio: true) go in the scrolling list;
    // commands stay fixed below it, then the footnote. Row indexes keep the
    // caller's order so a click maps back to the row it was given.
    function menuMarkup(o, list) {
      const listHtml = [];
      const commandHtml = [];
      list.forEach((row, index) => {
        (row.kind === 'action' ? commandHtml : listHtml).push(rowHtml(actionButton, row, index));
      });
      return (o.heading ? '<div class="project-menu-heading" id="' + MENU_ID + 'Heading">' + escapeHtml(o.heading) + '</div>' : '')
        + (listHtml.length ? '<div class="project-menu-list" role="group">' + listHtml.join('') + '</div>' : '')
        + commandHtml.join('')
        + (o.footnote ? '<div class="project-menu-footnote">' + escapeHtml(o.footnote) + '</div>' : '');
    }

    function applyRowRoles(element, list) {
      Array.from(element.querySelectorAll(ROW_SELECTOR)).forEach((rowEl) => {
        const index = Number(rowEl.getAttribute('data-project-menu-item'));
        const row = list[index] || {};
        const radio = row.kind !== 'action' || row.radio === true;
        rowEl.setAttribute('role', radio ? 'menuitemradio' : 'menuitem');
        if (radio) rowEl.setAttribute('aria-checked', row.selected ? 'true' : 'false');
        if (row.disabled === true) {
          rowEl.setAttribute('aria-disabled', 'true');
          const reason = rowEl.querySelector('.project-menu-reason');
          if (reason) rowEl.setAttribute('aria-describedby', reason.id);
        }
      });
    }

    // rows: [{ id, label, detail?, count?, selected?, disabled?, reason?,
    // danger?, title?, kind: 'project'|'action', radio?, separatorBefore? }]
    // heading / footnote: optional strings (what picking does, and its effect).
    function show(options) {
      const o = options || {};
      if (!documentRef || !documentRef.body || typeof actionButton !== 'function') return null;
      const anchor = o.anchor || null;
      if (open && open.anchor === anchor) { close(); return null; }
      close({ restoreFocus: false });
      const list = Array.isArray(o.rows) ? o.rows.filter(Boolean) : [];
      const element = documentRef.createElement('div');
      element.id = MENU_ID;
      element.className = 'composer-popover project-menu';
      element.setAttribute('role', 'menu');
      if (o.heading && !o.ariaLabel) element.setAttribute('aria-labelledby', MENU_ID + 'Heading');
      else element.setAttribute('aria-label', o.ariaLabel || jt('projects.switcher.ariaLabel', 'Projects'));
      element.tabIndex = -1;
      element.innerHTML = menuMarkup(o, list);
      applyRowRoles(element, list);
      element.addEventListener('keydown', handleMenuKeydown);
      element.addEventListener('click', handleMenuClick);
      documentRef.body.appendChild(element);
      open = { element, anchor, rows: list, onPick: o.onPick, onClose: o.onClose };
      if (anchor && typeof anchor.setAttribute === 'function') anchor.setAttribute('aria-expanded', 'true');
      position(element, anchor);
      documentRef.addEventListener('pointerdown', handleOutsidePointer, true);
      documentRef.addEventListener('keydown', handleDocumentKeydown, true);
      // Focus the checked row ("you are here"), else the first pickable one.
      const all = rows();
      const checked = all.findIndex((rowEl) => rowEl.getAttribute('aria-checked') === 'true');
      const firstEnabled = all.indexOf(enabledRows()[0]);
      focusRow(checked >= 0 ? checked : Math.max(0, firstEnabled));
      return element;
    }

    return {
      show,
      close,
      isOpen: () => Boolean(open),
      element: menuElement,
      dispose: () => close({ restoreFocus: false }),
    };
  }

  return {
    MENU_ID,
    GENERAL_PROJECT_ID,
    createProjectMenu,
    folderKey,
    countChatsByProject,
    normalizeProject,
    normalizeProjectList,
    sessionProjectId,
    sortProjectsForMenu,
    orderProjects,
    displayNames,
    parentFolderName,
    generalName,
    projectRow,
    chatCountLabel,
  };
});
