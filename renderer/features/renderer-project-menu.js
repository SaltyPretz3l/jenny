/* renderer/features/renderer-project-menu.js
 *
 * The one project menu (Projects v2, 2026-09-20). A plain listbox popover
 * shared by the Workspace Explorer header, the Workspace welcome page, the
 * line above the composer and the Chats panel filter, so there is one project
 * list to learn. Consumers hand it rows; it owns markup, positioning,
 * keyboard (arrows, Home/End, Enter/Space, Escape), outside-click dismissal
 * and focus return. No custom motion beyond the app's popover chrome.
 *
 * Lazily loaded on first open through scriptLoaderUtils.ensureScript (no
 * startup <script> slot). Rows render through the inventory action-button
 * primitive; option roles are applied after paint because the primitive does
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

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

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

  function normalizeProject(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    if (!id) return null;
    const rootPath = typeof raw.root_path === 'string' ? raw.root_path.trim() : '';
    return {
      id,
      name: String(raw.name || '').trim() || id,
      rootPath,
      // The authority key is empty when the folder cannot be probed.
      folderMissing: Boolean(rootPath) && raw.authority_key === '',
    };
  }

  function normalizeProjectList(payload) {
    const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.projects) ? payload.projects : []);
    return list.map(normalizeProject).filter(Boolean);
  }

  // Current project first, then alphabetical; General is never a switch row.
  function sortProjectsForMenu(projects, currentId) {
    return (projects || [])
      .filter((project) => project && project.id !== GENERAL_PROJECT_ID)
      .slice()
      .sort((a, b) => {
        if (a.id === currentId) return -1;
        if (b.id === currentId) return 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
  }

  function chatCountLabel(count) {
    const n = Math.max(0, Number(count) || 0);
    return jtn('settings.projects.chatCount', n, { count: n }, '{count} chat', '{count} chats');
  }

  // A project row for the switcher / filter menus.
  function projectRow(project, options) {
    const o = options || {};
    return {
      id: project.id,
      label: project.name,
      detail: project.rootPath
        ? (project.folderMissing
          ? project.rootPath + ' · ' + jt('projects.switcher.folderMissing', 'folder missing')
          : project.rootPath)
        : '',
      danger: project.folderMissing,
      count: typeof o.count === 'number' ? o.count : null,
      selected: o.selected === true,
      disabled: o.disabled === true,
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
    return (row.separatorBefore ? '<div class="project-menu-separator" role="separator"></div>' : '')
      + actionButton({
        plain: true,
        className: 'project-menu-row' + (row.kind === 'action' ? ' project-menu-row--action' : ''),
        disabled: row.disabled === true,
        title: row.title || undefined,
        dataset: { 'project-menu-item': String(index) },
        trustedHtml: check + '<span class="project-menu-main">' + name + detail + '</span>' + count,
      });
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
      return rows().filter((row) => !row.disabled);
    }

    function position(element, anchor) {
      if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return;
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

    function focusRow(index) {
      const list = enabledRows();
      if (!list.length) return;
      const clamped = ((index % list.length) + list.length) % list.length;
      list[clamped].focus();
    }

    function handleMenuKeydown(event) {
      const list = enabledRows();
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
      if (!rowEl || rowEl.disabled) return;
      event.preventDefault();
      const row = current.rows[Number(rowEl.getAttribute('data-project-menu-item'))];
      if (!row) return;
      close();
      if (typeof current.onPick === 'function') current.onPick(row);
    }

    // rows: [{ id, label, detail?, count?, selected?, disabled?, danger?,
    // title?, kind: 'project'|'action', separatorBefore? }]
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
      element.setAttribute('role', 'listbox');
      element.setAttribute('aria-label', o.ariaLabel || jt('projects.switcher.ariaLabel', 'Projects'));
      element.tabIndex = -1;
      element.innerHTML = (o.heading ? '<div class="project-menu-heading">' + escapeHtml(o.heading) + '</div>' : '')
        + list.map((row, index) => rowHtml(actionButton, row, index)).join('');
      Array.from(element.querySelectorAll(ROW_SELECTOR)).forEach((rowEl) => {
        const row = list[Number(rowEl.getAttribute('data-project-menu-item'))];
        rowEl.setAttribute('role', 'option');
        rowEl.setAttribute('aria-selected', row && row.selected ? 'true' : 'false');
      });
      element.addEventListener('keydown', handleMenuKeydown);
      element.addEventListener('click', handleMenuClick);
      documentRef.body.appendChild(element);
      open = { element, anchor, rows: list, onPick: o.onPick, onClose: o.onClose };
      if (anchor && typeof anchor.setAttribute === 'function') anchor.setAttribute('aria-expanded', 'true');
      position(element, anchor);
      documentRef.addEventListener('pointerdown', handleOutsidePointer, true);
      documentRef.addEventListener('keydown', handleDocumentKeydown, true);
      const selectedIndex = enabledRows().findIndex((rowEl) => rowEl.getAttribute('aria-selected') === 'true');
      focusRow(selectedIndex >= 0 ? selectedIndex : 0);
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
    sortProjectsForMenu,
    projectRow,
    chatCountLabel,
  };
});
