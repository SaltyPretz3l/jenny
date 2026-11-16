/**
 * Model Library › services registry (UMD). Settings > Models > "Engines and providers".
 *
 * One table of the engines and providers that run or serve models, grouped
 * Chat engines / Image engines / Cloud providers, with one status column and
 * exactly one action per row. Every row opens the same shared drawer; the
 * owner of a row (the engine blocks, Ollama health, the cloud-model and the
 * API-provider controllers) registers `{ id, kind, order, name, what, getStatus,
 * renderDrawer, onDrawerClose }` and keeps its own controls: the registry
 * owns the table, the drawer shell and focus return, nothing else.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.modelLibraryServices = factory(root);
  // Owners that rendered before this lazily loaded module arrived register their rows now.
  if (root.document && typeof root.CustomEvent === 'function') {
    try { root.document.dispatchEvent(new root.CustomEvent(root.modelLibraryServices.READY_EVENT)); } catch (_error) { /* they register on their next render */ }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var HOST_ID = 'modelServicesHost';
  var DRAWER_ID = 'modelServicesDrawer';
  // Dispatched on the document once this lazily loaded module is exposed (see the wrapper above).
  var READY_EVENT = 'model-library-services-ready';
  var KINDS = ['chat', 'image', 'cloud'];
  var TONES = { ready: true, warn: true, off: true, busy: true };
  var FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  var memo = new WeakMap();

  function kindLabel(kind) {
    if (kind === 'image') return jt('settings.models.services.kind.image', 'Image engines');
    if (kind === 'cloud') return jt('settings.models.services.kind.cloud', 'Cloud providers');
    return jt('settings.models.services.kind.chat', 'Chat engines');
  }

  // A row with `inSummary: false` (the "Add provider…" row) is drawn but never counted.
  function summaryText(items) {
    var rows = items.filter(function (item) { return item.entry.inSummary !== false; });
    var set = rows.filter(function (entry) { return entry.status.set; }).length;
    if (rows.length && set === rows.length) return jt('settings.models.services.summary.ready', '{n} ready', { n: set });
    if (set > 0) return jt('settings.models.services.summary.someSetUp', '{set} of {n} set up', { set: set, n: rows.length });
    return jt('settings.models.services.summary.noneSetUp', 'None set up');
  }

  // deps: { documentRef, windowRef, drawerModule, overlayManager, actionButton }
  function createModelLibraryServices(deps) {
    var d = deps || {};
    var windowRef = d.windowRef || root;
    var documentRef = d.documentRef || windowRef.document || null;
    var actionButton = d.actionButton || root.inventoryActionButton
      || (typeof require === 'function' ? require('../../inventory/action-button') : null);
    var drawerModule = d.drawerModule || root.inventoryDrawer
      || (typeof require === 'function' ? require('../../inventory/drawer') : null);
    var overlayManager = d.overlayManager || root.rendererOverlayManagerController || null;
    var escapeHtml = actionButton.escapeHtml;
    var entries = new Map();
    var rendered = new Map(); // id -> the row markup on screen, so an unchanged refresh touches nothing
    var drawer = null;
    var openedId = null;
    var openAnchor = null;
    var switching = false;
    var boundHost = null;
    var renderQueued = false;
    var disposed = false;

    function hostEl() {
      return documentRef && documentRef.getElementById ? documentRef.getElementById(HOST_ID) : null;
    }

    function readStatus(entry) {
      var status;
      try { status = typeof entry.getStatus === 'function' ? entry.getStatus() : null; } catch (_error) { status = null; }
      if (!status || typeof status !== 'object') {
        return { text: jt('settings.models.services.statusUnavailable', 'Status unavailable'), tone: 'off', set: false };
      }
      return { text: String(status.text == null ? '' : status.text), tone: TONES[status.tone] ? status.tone : 'off', set: status.set === true };
    }

    function snapshot(entry) {
      return { entry: entry, status: readStatus(entry) };
    }

    function rowHtml(item) {
      var entry = item.entry;
      var status = item.status;
      var name = String(entry.name == null ? entry.id : entry.name);
      var label = status.set
        ? jt('settings.models.services.manage', 'Manage')
        : String(entry.actionLabel || jt('settings.models.services.setUp', 'Set up…'));
      var full = jt('settings.models.services.actionFor', '{action}: {name}', { action: label, name: name });
      var button = actionButton({
        label: label, variant: status.set ? 'ghost' : 'secondary', size: 'sm', ariaLabel: full, title: full,
        dataset: { 'model-service-action': 'open', 'service-id': entry.id },
      });
      return '<div class="mrow srow" data-service-id="' + escapeHtml(entry.id) + '"><div class="mrow-main"><div class="mrow-title"><span class="mrow-name">'
        + escapeHtml(name) + '</span></div><div class="mrow-meta">' + escapeHtml(entry.what || '') + '</div></div>'
        + '<div class="srow-status"><span class="settings-page-status-dot mp-dot" data-tone="' + status.tone + '" aria-hidden="true"></span><span>'
        + escapeHtml(status.text) + '</span></div><div class="mrow-actions">' + button + '</div></div>';
    }

    function itemsOfKind(kind) {
      return Array.from(entries.values())
        .filter(function (entry) { return entry.kind === kind; })
        .sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0); })
        .map(snapshot);
    }

    function render() {
      var host = hostEl();
      if (disposed || !host) return;
      bindHost(host);
      rendered.clear();
      var active = documentRef.activeElement;
      var focusedId = active && host.contains(active) && active.closest('[data-service-id]') ? active.closest('[data-service-id]').getAttribute('data-service-id') : null;
      var html = '';
      KINDS.forEach(function (kind) {
        var items = itemsOfKind(kind);
        if (!items.length) return;
        html += '<div class="srow-head"><span>' + escapeHtml(kindLabel(kind)) + '</span><small data-service-summary="' + kind + '">'
          + escapeHtml(summaryText(items)) + '</small></div>';
        items.forEach(function (item) {
          var markup = rowHtml(item);
          rendered.set(item.entry.id, markup);
          html += markup;
        });
      });
      host.innerHTML = html ? '<div class="mrow-list srow-list">' + html + '</div>' : '';
      var again = focusedId === null ? null : rowButton(focusedId);
      if (again) again.focus();
    }

    function scheduleRender() {
      if (renderQueued || disposed) return;
      renderQueued = true;
      Promise.resolve().then(function () {
        renderQueued = false;
        render();
      });
    }

    function findRow(host, id) {
      var rows = host.querySelectorAll('.srow[data-service-id]');
      for (var i = 0; i < rows.length; i += 1) if (rows[i].getAttribute('data-service-id') === id) return rows[i];
      return null;
    }

    function refresh(id) {
      var entry = entries.get(id);
      var host = hostEl();
      if (disposed || !entry || !host) return;
      var current = findRow(host, id);
      if (!current) { scheduleRender(); return; } // registered this tick: the queued render paints it
      var markup = rowHtml(snapshot(entry));
      if (rendered.get(id) !== markup) {
        var scratch = documentRef.createElement('div');
        scratch.innerHTML = markup;
        var next = scratch.firstElementChild;
        var hadFocus = current.contains(documentRef.activeElement);
        current.replaceWith(next);
        rendered.set(id, markup);
        if (hadFocus) { var again = next.querySelector('button'); if (again) again.focus(); }
        // The section summary depends only on the rows' state, which is in their markup.
        var summary = host.querySelector('[data-service-summary="' + entry.kind + '"]');
        var text = summary ? summaryText(itemsOfKind(entry.kind)) : '';
        if (summary && summary.textContent !== text) summary.textContent = text;
      }
    }

    function register(entry) {
      if (disposed || !entry || !entry.id) return;
      entries.set(String(entry.id), Object.assign({}, entry, { id: String(entry.id), kind: KINDS.indexOf(entry.kind) >= 0 ? entry.kind : 'chat' }));
      scheduleRender();
    }

    function has(id) { return entries.has(id); }

    function unregister(id) {
      if (!entries.has(id)) return;
      if (openedId === id) close();
      entries.delete(id);
      rendered.delete(id);
      if (entries.size === 0) idle();
      scheduleRender();
    }

    // No owner left: nothing may hold a listener or a drawer host.
    function idle() {
      close();
      if (drawer) { drawer.dispose(); drawer = null; }
      unbindHost();
    }

    function drawerBody() {
      if (openedId === null || !documentRef) return null;
      return documentRef.querySelector('#' + DRAWER_ID + ' .inv-drawer-body');
    }

    function rowButton(id) {
      var host = hostEl();
      var current = host ? findRow(host, id) : null;
      return current ? current.querySelector('[data-model-service-action]') : null;
    }

    // Owners repaint their drawer controls with innerHTML. While the drawer is open, a repaint that drops
    // keyboard focus to <body> puts it back on the equivalent control (same id, or the same data-* attributes).
    var stopKeeper = null;
    function focusKey(el) {
      var quote = function (value) { return '"' + String(value).replace(/["\\]/g, '\\$&') + '"'; };
      if (!el || !el.attributes) return '';
      if (el.id) return '[id=' + quote(el.id) + ']';
      var attrs = Array.prototype.filter.call(el.attributes, function (attr) { return attr.name.indexOf('data-') === 0; });
      return attrs.length ? el.tagName.toLowerCase() + attrs.map(function (attr) { return '[' + attr.name + '=' + quote(attr.value) + ']'; }).join('') : '';
    }
    function keepFocus(body) {
      var win = documentRef.defaultView;
      if (!body || !win || typeof win.MutationObserver !== 'function') return;
      var key = '';
      var onFocusIn = function (event) { key = focusKey(event.target); };
      var observer = new win.MutationObserver(function () {
        var active = documentRef.activeElement;
        if (!key || (active && active !== documentRef.body)) return;
        var next;
        try { next = body.querySelector(key); } catch (_error) { next = null; }
        if (next && typeof next.focus === 'function') next.focus();
      });
      body.addEventListener('focusin', onFocusIn);
      observer.observe(body, { childList: true, subtree: true });
      stopKeeper = function () { observer.disconnect(); body.removeEventListener('focusin', onFocusIn); stopKeeper = null; };
    }

    function handleClosed() {
      if (stopKeeper) stopKeeper();
      var id = openedId;
      var anchor = openAnchor;
      openedId = null;
      openAnchor = null;
      var entry = id === null ? null : entries.get(id);
      if (entry && typeof entry.onDrawerClose === 'function') {
        try { entry.onDrawerClose(); } catch (_error) { /* a faulty owner never traps the drawer */ }
      }
      if (switching || id === null) return;
      var target = anchor && anchor.isConnected ? anchor : rowButton(id);
      if (target && typeof target.focus === 'function') target.focus();
    }

    function ensureDrawer() {
      if (!drawer) {
        drawer = drawerModule.createDrawer({ documentRef: documentRef, id: DRAWER_ID, overlayManager: overlayManager, onClose: handleClosed });
      }
      return drawer;
    }

    function open(id, anchorEl) {
      var entry = entries.get(id);
      if (disposed || !entry) return false;
      if (openedId !== null) {
        switching = true;
        try { close(); } finally { switching = false; }
      }
      var panel = ensureDrawer();
      openedId = id;
      openAnchor = anchorEl || rowButton(id);
      var opened = panel.open({ title: String(entry.drawerTitle || entry.name || id), bodyHtml: '', restoreFocusTo: openAnchor });
      if (!opened) { openedId = null; openAnchor = null; return false; }
      var body = drawerBody();
      if (body && typeof entry.renderDrawer === 'function') {
        try { entry.renderDrawer(body); } catch (_error) { /* the drawer stays open on its title */ }
      }
      keepFocus(body);
      var first = body ? body.querySelector(FOCUSABLE) : null;
      if (first) first.focus();
      return true;
    }

    function close() {
      if (drawer) drawer.close();
    }

    function onClick(event) {
      var target = event && event.target;
      var button = target && typeof target.closest === 'function' ? target.closest('[data-model-service-action="open"]') : null;
      if (!button || !boundHost || !boundHost.contains(button)) return;
      event.preventDefault();
      open(button.getAttribute('data-service-id'), button);
    }

    function bindHost(host) {
      if (boundHost === host) return;
      unbindHost();
      boundHost = host;
      host.addEventListener('click', onClick);
    }

    function unbindHost() {
      if (boundHost) boundHost.removeEventListener('click', onClick);
      boundHost = null;
    }

    function dispose() {
      if (disposed) return;
      close();
      disposed = true;
      if (drawer) { drawer.dispose(); drawer = null; }
      unbindHost();
      entries.clear();
      rendered.clear();
      if (documentRef && memo.get(documentRef) === api) memo.delete(documentRef);
    }

    var api = {
      register: register, unregister: unregister, has: has, render: render, refresh: refresh,
      open: open, close: close, openId: function () { return openedId; }, drawerBody: drawerBody, dispose: dispose,
    };
    return api;
  }

  // One instance per document: every owner of a row calls this at render time.
  function shared(deps) {
    var d = deps || {};
    var documentRef = d.documentRef || (d.windowRef && d.windowRef.document) || null;
    if (!documentRef) return null;
    var existing = memo.get(documentRef);
    if (existing) return existing;
    var created = createModelLibraryServices(d);
    memo.set(documentRef, created);
    return created;
  }

  return { shared: shared, createModelLibraryServices: createModelLibraryServices, HOST_ID: HOST_ID, DRAWER_ID: DRAWER_ID, READY_EVENT: READY_EVENT };
});
