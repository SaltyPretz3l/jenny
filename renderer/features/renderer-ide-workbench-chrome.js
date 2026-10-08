/* renderer/features/renderer-ide-workbench-chrome.js - Workspace workbench chrome
 * markup (UMD): the stack header (tablist + actions), the vertical strip of a
 * collapsed row stack, the editor empty state, and the small element builders for
 * splits, cells and stacks. Pure string/DOM construction: no state, no listeners,
 * no layout logic. Buttons come from the inventory action-button primitive (passed
 * in), never from raw markup, so the raw-primitive ratchet stays flat. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeWorkbenchChrome = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SVG_OPEN = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">';
  const ICONS = Object.freeze({
    maximize: SVG_OPEN + '<path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"/></svg>',
    restore: SVG_OPEN + '<path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3"/></svg>',
    collapse: SVG_OPEN + '<path d="M4 6l4 4 4-4"/></svg>',
    more: SVG_OPEN + '<circle cx="3.5" cy="8" r="0.6"/><circle cx="8" cy="8" r="0.6"/><circle cx="12.5" cy="8" r="0.6"/></svg>',
  });

  const escapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  // A count badge, else (W6) an unread dot: something new arrived while the view was hidden.
  function countMarkup(count, unread) {
    const n = Number(count);
    if (Number.isFinite(n) && n > 0) return '<span class="wb-count" aria-hidden="true">' + Math.floor(n) + '</span>';
    return unread === true ? '<span class="wb-unread" aria-hidden="true"></span>' : '';
  }

  // The accessible name carries what the badge shows ("Git (5)", "Chat (new messages)").
  function nameWithCount(jt, label, count, unread) {
    const n = Number(count);
    if (typeof jt !== 'function') return String(label);
    if (Number.isFinite(n) && n > 0) return jt('ide.workbench.withCount', '{name} ({count})', { name: label, count: Math.floor(n) });
    return unread === true ? jt('ide.workbench.withUnread', '{name} (new messages)', { name: label }) : String(label);
  }

  // tab = { id, label, count, active }
  function tabMarkup(actionButton, tab, jt) {
    const name = nameWithCount(jt, tab.label, tab.count, tab.unread);
    return actionButton({
      plain: true,
      ariaLabel: name,
      title: name,
      className: 'wb-tab' + (tab.active ? ' wb-tab--active' : ''),
      role: 'tab',
      domId: 'wbTab-' + tab.id,
      ariaSelected: tab.active === true,
      ariaControls: 'wbView-' + tab.id,
      tabIndex: tab.active ? 0 : -1,
      dataset: { 'wb-tab': tab.id },
      trustedHtml: '<span class="wb-tab-label">' + escapeHtml(tab.label) + '</span>' + countMarkup(tab.count, tab.unread),
    });
  }

  function iconButton(actionButton, name, label, icon, extra) {
    return actionButton(Object.assign({
      variant: 'ghost',
      className: 'wb-action',
      ariaLabel: label,
      title: label,
      dataset: { 'wb-action': name },
      trustedHtml: icon,
    }, extra || {}));
  }

  // o = { actionButton, jt, tabs: [{ id, label, count, active }], tablistLabel,
  //       showMaximize, maximized, showCollapse, bound? { n, label } }. Returns the header's inner HTML.
  function headerMarkup(o) {
    const tabs = o.tabs.map(function (tab) { return tabMarkup(o.actionButton, tab, o.jt); }).join('');
    // W7c: a view in the stack is bound to editor group n; the badge opens the stack menu.
    const bound = o.bound ? iconButton(o.actionButton, 'bind', o.bound.label, String(Math.floor(o.bound.n)), {
      className: 'wb-action wb-bound', ariaHaspopup: 'menu',
    }) : '';
    const jt = o.jt;
    const actions = (o.viewActions || []).map(function (a) { return iconButton(o.actionButton, 'view:' + a.name, a.label, a.icon); });
    if (o.showMaximize) {
      const label = o.maximized
        ? jt('ide.workbench.restore', 'Restore panel size')
        : jt('ide.workbench.maximize', 'Maximize panel');
      actions.push(iconButton(o.actionButton, 'maximize', label, o.maximized ? ICONS.restore : ICONS.maximize));
    }
    if (o.showCollapse) {
      actions.push(iconButton(o.actionButton, 'collapse', jt('ide.workbench.collapse', 'Collapse'), ICONS.collapse));
    }
    actions.push(iconButton(o.actionButton, 'more', jt('ide.workbench.more', 'More actions'), ICONS.more, { ariaHaspopup: 'menu' }));
    return bound + '<div class="wb-tabs" role="tablist" aria-label="' + escapeHtml(o.tablistLabel) + '">' + tabs + '</div>'
      + '<div class="wb-stack-actions">' + actions.join('') + '</div>';
  }

  // W7c: the view a stack's badge speaks for: the active view when bound, else the first bound
  // view in tab order (null = unbound). The badge's click opens that view's menu.
  function boundView(ops, layout, stack) {
    if (!stack || !Array.isArray(stack.views)) return null;
    if (ops.bindingOf(layout, stack.active)) return stack.active;
    return stack.views.find(function (id) { return ops.bindingOf(layout, id); }) || null;
  }

  // Use the group's own number (the primary is 1, editor-N is N), not its place in the tree.
  function boundBadge(ops, layout, views, active, jt) {
    const stackId = ops.bindingOf(layout, boundView(ops, layout, { views: views, active: active }));
    const at = ops.listEditorGroups(layout).indexOf(stackId);
    const n = at < 0 ? 0 : at === 0 ? 1 : Number(stackId.slice(7)) || 0;
    return n > 0 ? { n: n, label: jt('ide.groups.boundBadge', 'Bound to editor group {n}', { n: n }) } : null;
  }

  // o = { actionButton, jt, views: [{ id, label, icon, count }] }. Returns the strip's inner HTML.
  function stripMarkup(o) {
    return o.views.map(function (view) {
      const fallback = escapeHtml(String(view.label || view.id).charAt(0).toUpperCase());
      const name = nameWithCount(o.jt, view.label, view.count, view.unread);
      return o.actionButton({
        plain: true,
        className: 'wb-strip-btn',
        ariaLabel: name,
        title: name,
        dataset: { 'wb-strip': view.id },
        trustedHtml: (typeof view.icon === 'string' && view.icon ? view.icon : fallback) + countMarkup(view.count, view.unread),
      });
    }).join('');
  }

  function emptyStateMarkup(o) {
    const jt = o.jt;
    return '<div class="wb-empty" role="status">'
      + escapeHtml(jt('ide.workbench.emptyEditor', 'Editor unavailable')) + '</div>';
  }

  /* ---------------------------------------------------------------- element builders */

  function createSplitEl(doc, node) {
    const el = doc.createElement('div');
    el.className = 'wb-split';
    el.setAttribute('data-wb-split', node.id);
    el.setAttribute('data-dir', node.dir);
    return el;
  }

  function createCellEl(doc, splitId, index) {
    const el = doc.createElement('div');
    el.className = 'wb-cell';
    el.setAttribute('data-wb-cell', splitId + ':' + index);
    return el;
  }

  // The stack shell: <section> + its body. The header or strip is slotted in by the patcher.
  function createStackEl(doc, node, axis) {
    const el = doc.createElement('section');
    const isEditor = node.kind === 'editor';
    el.className = isEditor ? 'wb-stack wb-stack--editor' : 'wb-stack';
    el.setAttribute('data-wb-stack', node.id);
    el.setAttribute('data-kind', node.kind);
    el.setAttribute('data-state', 'open');
    el.setAttribute('data-axis', axis);
    const body = doc.createElement('div');
    body.className = 'wb-stack-body';
    el.appendChild(body);
    return { el: el, body: body };
  }

  // kind 'header' -> <header class="wb-stack-header">; 'strip' -> the labelled vertical toolbar.
  function createChromeEl(doc, kind, html, label) {
    let el;
    if (kind === 'strip') {
      el = doc.createElement('div');
      el.className = 'wb-strip';
      el.setAttribute('role', 'toolbar');
      el.setAttribute('aria-orientation', 'vertical');
      el.setAttribute('aria-label', label);
    } else {
      el = doc.createElement('header');
      el.className = 'wb-stack-header';
    }
    el.innerHTML = html;
    return el;
  }

  // A view's label and count from the registry; a throwing provider never breaks chrome.
  function viewLabel(views, id) {
    try {
      const text = views[id] && typeof views[id].label === 'function' ? views[id].label() : null;
      return text == null ? String(id) : String(text);
    } catch (_error) {
      return String(id);
    }
  }

  function viewCount(views, id) {
    try {
      const n = Number(views[id] && typeof views[id].count === 'function' ? views[id].count() : 0);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch (_error) {
      return 0;
    }
  }

  // { count, unread } for a tab or strip button (views[id].unread(), W6).
  function viewBadge(views, id) {
    let unread;
    try {
      unread = Boolean(views[id] && typeof views[id].unread === 'function' && views[id].unread() === true);
    } catch (_error) {
      unread = false;
    }
    return { count: viewCount(views, id), unread: unread };
  }

  // The active view's own header actions (e.g. New Terminal): views[id].actions()
  // -> [{ name, label, icon }]; icons are the registry's trusted markup.
  const ACTION_NAME_RE = /^[a-z][a-z-]{0,31}$/;

  function viewActions(views, id) {
    try {
      const list = views[id] && typeof views[id].actions === 'function' ? views[id].actions() : [];
      return (Array.isArray(list) ? list : []).filter(function (a) {
        return a && ACTION_NAME_RE.test(String(a.name)) && typeof a.icon === 'string';
      }).map(function (a) { return { name: String(a.name), label: String(a.label || a.name), icon: a.icon }; });
    } catch (_error) {
      return [];
    }
  }

  function runViewAction(views, id, name) {
    try {
      if (views[id] && typeof views[id].onAction === 'function') views[id].onAction(name);
    } catch (_error) {
      /* a view's action must not break the workbench */
    }
  }

  return {
    ICONS: ICONS,
    viewActions: viewActions,
    runViewAction: runViewAction,
    viewLabel: viewLabel,
    viewCount: viewCount,
    viewBadge: viewBadge,
    escapeHtml: escapeHtml,
    countMarkup: countMarkup,
    tabMarkup: tabMarkup,
    headerMarkup: headerMarkup,
    boundBadge: boundBadge,
    boundView: boundView,
    stripMarkup: stripMarkup,
    emptyStateMarkup: emptyStateMarkup,
    createSplitEl: createSplitEl,
    createCellEl: createCellEl,
    createStackEl: createStackEl,
    createChromeEl: createChromeEl,
  };
});
