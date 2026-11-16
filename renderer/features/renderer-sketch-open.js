/**
 * renderer/features/renderer-sketch-open.js: a drawing's file nodes, and "Open large" (row 149, slice S5;
 * the project board plan section 5.6).
 *
 * An action module of the sketch frame host (renderer-sketch-frame-host.js): the loader calls attach(host) once.
 *
 * Open a file. A node written with `file=<path>` posts `open-file`; the path is model output. This module asks the
 * main process (jennyShell.sketch.openFile) whether it may open, sending the session of the chat the block sits in
 * (its pane's session, never "the active chat"; a block outside a local chat sends none). The main process checks
 * the path against that session's own project root and answers a relative path or a reason. On a yes the file opens
 * through the Workspace's existing project-file open (the cancelable `ide:open-file-at-line` event with a projectId,
 * claimed by renderer-chat-path-open.js), which switches the Workspace to that project and view and reads the file.
 * On a no one toast says why. One open at a time for a block. Logs carry the reason code only.
 *
 * Open large. Order 10 in a drawing's action row. openLarge({ source, title, returnFocus }) shows one full-window
 * viewer (the inventory help overlay under its own host id, widened in styles/markdown-sketch.css): a header with
 * the title and a close button, and below it the same drawing drawn again by the same host, so every other action
 * module adds its actions to it. Escape and the close button close it, focus stays inside while it is open and goes
 * back to `returnFocus`; closing releases the viewer's frame. A later slice calls openLarge for a board card.
 */
/* global window, document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSketchOpen = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const OPEN_LARGE_ORDER = 10;
  const VIEWER_HOST_ID = 'sketchViewerOverlay';
  const VIEWER_TITLE_ID = 'sketchViewerTitle';
  const OPEN_FILE_EVENT = 'ide:open-file-at-line';
  const LOCAL_CHAT_SELECTOR = '.chat-pane[data-pane-id] .chat-timeline';
  // Docked beside the Workspace or a board, the transcript sits in the dock, outside its pane.
  const DOCKED_CHAT_SELECTOR = '#ideChatDock .chat-timeline';
  const FOCUSED_PANE_SELECTOR = '#chatView > .chat-pane[data-pane-focused="true"][data-pane-id]';
  const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
  const REASONS = new Set(['no_session', 'no_root', 'outside', 'link', 'not_found', 'not_file', 'disabled']);
  const MAX_TITLE = 200;
  const MAX_PATH = 1024;
  const EXPAND_ICON = '<svg class="markdown-sketch-large-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor"'
    + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>';

  let host = null;
  let stops = [];
  let generation = 0;
  let pending = new WeakSet();
  let lastDocument = null;
  /** The "Open large" buttons this module put in rows, removed on detach. */
  const actions = new Set();
  /** Blocks built for the viewer, and the chat session a viewer opened from a chat carries. */
  const viewerBlocks = new WeakSet();
  const viewerSessions = new WeakMap();
  let overlay = null;
  let overlayDocument = null;
  let current = null; // { block, returnFocus, restore }

  function actionButton() {
    return globalThis.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
  }

  function helpOverlay() {
    return globalThis.inventoryHelpOverlay || (typeof require === 'function' ? require('../inventory/help-overlay') : null);
  }

  function frameMessages() {
    return globalThis.rendererSketchFrameMessages || (typeof require === 'function' ? require('./renderer-sketch-frame-messages') : null);
  }

  /* ── Open a file ── */

  function refusalText(reason) {
    switch (reason) {
      case 'outside': return jt('markdown.sketch.openOutside', 'This file is outside the chat\'s project folder.');
      case 'no_root':
      case 'no_session': return jt('markdown.sketch.openNoFolder', 'This chat has no project folder on this computer.');
      case 'not_found': return jt('markdown.sketch.openNotFound', 'That file is not there any more.');
      case 'not_file': return jt('markdown.sketch.openNotFile', 'That is a folder, not a file.');
      case 'link': return jt('markdown.sketch.openLink', 'That file is reached through a link, so it was not opened.');
      case 'disabled': return jt('markdown.sketch.openDisabled', 'Opening files from drawings is turned off.');
      default: return jt('markdown.sketch.openFailed', 'Could not open that file.');
    }
  }

  // The shell's toast controller has no global of its own; this host is the one global that hands it out.
  function toast(message) {
    try {
      const shellHost = globalThis.rendererSuggestedChangesHost;
      const show = shellHost && shellHost.showToastMessage;
      if (typeof show === 'function') {
        show(message, { title: jt('markdown.sketch.openTitle', 'Open file'), tone: 'danger', dedupeKey: 'markdown:sketch-open-file' });
      }
    } catch (_error) { /* a toast is best-effort */ }
  }

  function logReason(reason) {
    try {
      const logger = globalThis.appendClientLog;
      if (typeof logger === 'function') logger('INFO', 'markdown.sketch_open_file', { reason });
    } catch (_error) { /* diagnostics are best-effort */ }
  }

  /** The session of the local chat a block's message belongs to, docked or not, or '' (Team tab, preview, a board's viewer). */
  function sessionIdOf(block) {
    if (viewerSessions.has(block)) return viewerSessions.get(block);
    if (!block || typeof block.closest !== 'function') return '';
    let pane = block.closest(LOCAL_CHAT_SELECTOR) ? block.closest('.chat-pane[data-pane-id]') : null;
    // The docked chat is the focused pane's: the dock takes that pane's transcript and puts it back there.
    if (!pane && block.closest(DOCKED_CHAT_SELECTOR)) pane = block.ownerDocument.querySelector(FOCUSED_PANE_SELECTOR);
    if (!pane) return '';
    const paneId = Number(pane.getAttribute('data-pane-id'));
    const owner = globalThis.rendererAppPaneComposition;
    const panes = owner && typeof owner.getPaneComposition === 'function' ? owner.getPaneComposition() : null;
    const id = panes && typeof panes.getPaneSessionId === 'function' && Number.isInteger(paneId) ? panes.getPaneSessionId(paneId) : '';
    return typeof id === 'string' && SESSION_ID_RE.test(id) ? id : '';
  }

  function isRelativeInside(relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || relativePath.length > MAX_PATH) return false;
    if (/^[\\/]|^[A-Za-z]:|\\/.test(relativePath)) return false;
    for (let index = 0; index < relativePath.length; index += 1) {
      if (relativePath.charCodeAt(index) < 32) return false;
    }
    return relativePath.split('/').every((segment) => segment !== '..');
  }

  // The Workspace's own open path: true only when its listener claimed the event.
  function openInWorkspace(block, answer) {
    const view = block.ownerDocument && block.ownerDocument.defaultView;
    if (!view || typeof view.CustomEvent !== 'function') return false;
    const detail = { path: answer.relativePath, line: Number.isInteger(answer.line) && answer.line > 0 ? answer.line : null, column: null, preferIde: true };
    if (typeof answer.projectId === 'string' && answer.projectId) detail.projectId = answer.projectId;
    try {
      return view.dispatchEvent(new view.CustomEvent(OPEN_FILE_EVENT, { detail, bubbles: true, cancelable: true })) === false;
    } catch (_error) {
      return false;
    }
  }

  function settle(block, answer, mine) {
    pending.delete(block);
    if (mine !== generation) return; // detached while the main process answered
    if (answer && answer.ok === true && isRelativeInside(answer.relativePath)) {
      const opened = openInWorkspace(block, answer);
      logReason(opened ? 'ok' : 'unclaimed');
      if (!opened) toast(refusalText(''));
      return;
    }
    const reason = answer && answer.ok === false && REASONS.has(answer.reason) ? answer.reason : 'error';
    logReason(reason);
    toast(refusalText(reason));
  }

  function handleOpenFile(block, message) {
    if (!host || !block || pending.has(block)) return;
    const shell = globalThis.jennyShell;
    const openFile = shell && shell.sketch && shell.sketch.openFile;
    if (typeof openFile !== 'function') {
      logReason('error');
      toast(refusalText(''));
      return;
    }
    const request = {};
    const sessionId = sessionIdOf(block);
    if (sessionId) request.sessionId = sessionId;
    request.path = message.path;
    request.line = message.line;
    pending.add(block);
    const mine = generation;
    Promise.resolve()
      .then(function () { return openFile(request); })
      .then(function (answer) { settle(block, answer, mine); }, function () { settle(block, null, mine); });
  }

  /* ── Open large ── */

  function inViewer(block) {
    return viewerBlocks.has(block) || Boolean(typeof block.closest === 'function' && block.closest('#' + VIEWER_HOST_ID));
  }

  function titleFor(title, source) {
    const given = typeof title === 'string' ? title.trim() : '';
    if (given) return given.slice(0, MAX_TITLE);
    const match = /^[ \t]*title[ \t]+(\S.*)$/m.exec(source);
    const fromSource = match ? match[1].trim().slice(0, MAX_TITLE) : '';
    return fromSource || jt('markdown.sketch.frameLabel', 'Diagram');
  }

  function buildBlock(ownerDocument, source) {
    const block = ownerDocument.createElement('div');
    block.className = 'markdown-code-block markdown-sketch-viewer-block';
    const pre = ownerDocument.createElement('pre');
    const code = ownerDocument.createElement('code');
    code.className = 'language-sketch';
    code.textContent = source;
    pre.appendChild(code);
    block.appendChild(pre);
    return block;
  }

  // The host draws nothing for an empty source; the viewer still says so, in the host's own words.
  function showCouldNotDraw(block) {
    const messages = frameMessages();
    const note = block.ownerDocument.createElement('div');
    note.className = 'markdown-sketch-note';
    note.setAttribute('role', 'status');
    note.textContent = messages && typeof messages.failureNote === 'function'
      ? messages.failureNote('error')
      : jt('markdown.sketch.couldNotDraw', 'Could not draw this.');
    block.insertBefore(note, block.firstChild);
  }

  function ensureOverlay(ownerDocument) {
    if (overlay && overlayDocument === ownerDocument) return overlay;
    if (overlay) overlay.destroy();
    const primitive = helpOverlay();
    overlay = primitive && typeof primitive.createHelpOverlay === 'function'
      ? primitive.createHelpOverlay({ document: ownerDocument, hostId: VIEWER_HOST_ID })
      : null;
    overlayDocument = overlay ? ownerDocument : null;
    return overlay;
  }

  function viewerClosed(record) {
    if (current === record) current = null;
    if (record.block && host) {
      try { host.resetBlock(record.block); } catch (_error) { /* the frame is gone with the overlay */ }
    }
    const target = record.returnFocus;
    if (record.restore && target && target.isConnected !== false) {
      try { target.focus(); } catch (_error) { /* focus is best-effort */ }
    }
  }

  function closeViewer(restore) {
    const record = current;
    if (!record) return;
    record.restore = restore !== false;
    if (overlay && overlay.isOpen()) overlay.close();
    else viewerClosed(record);
  }

  function openViewer(options) {
    if (!host) return false;
    const o = options || {};
    const returnFocus = o.returnFocus && typeof o.returnFocus.focus === 'function' ? o.returnFocus : null;
    const ownerDocument = (returnFocus && returnFocus.ownerDocument)
      || (typeof document !== 'undefined' ? document : null) || lastDocument;
    if (!ownerDocument) return false;
    closeViewer(false); // one viewer at a time: a second open replaces the first
    const viewer = ensureOverlay(ownerDocument);
    if (!viewer) return false;
    const source = typeof o.source === 'string' ? o.source : '';
    const record = { block: null, returnFocus, restore: true };
    viewer.open({
      title: titleFor(o.title, source),
      titleId: VIEWER_TITLE_ID,
      bodyHtml: '',
      closeLabel: jt('markdown.sketch.closeLarge', 'Close'),
      onClose: function () { viewerClosed(record); },
    });
    const body = ownerDocument.querySelector('#' + VIEWER_HOST_ID + ' .inv-help-overlay-body');
    if (!body) return false;
    current = record;
    const block = buildBlock(ownerDocument, source);
    record.block = block;
    viewerBlocks.add(block);
    if (typeof o.sessionId === 'string' && o.sessionId) viewerSessions.set(block, o.sessionId);
    body.appendChild(block);
    host.renderBlock(block);
    if (!block.hasAttribute('data-sketch-rendered')) showCouldNotDraw(block);
    return true;
  }

  /** Shows a drawing in the full-window viewer. A board card calls this; it carries no chat session. */
  function openLarge(options) {
    const o = options || {};
    return openViewer({ source: o.source, title: o.title, returnFocus: o.returnFocus });
  }

  function handleDrawn(drawn) {
    const block = drawn && drawn.block;
    if (!host || !block || inViewer(block)) return;
    lastDocument = block.ownerDocument;
    const make = actionButton();
    if (typeof make !== 'function') return;
    const label = jt('markdown.sketch.openLarge', 'Open large');
    const escape = make.escapeHtml || String;
    const template = block.ownerDocument.createElement('template');
    template.innerHTML = make({
      variant: 'ghost', size: 'sm', className: 'markdown-sketch-open-large', label, title: label,
      trustedHtml: EXPAND_ICON + '<span>' + escape(label) + '</span>',
    });
    const button = template.content.firstElementChild;
    if (!button) return;
    button.addEventListener('click', function () {
      openViewer({ source: host ? host.sourceOf(block) : '', returnFocus: button, sessionId: sessionIdOf(block) });
    });
    for (const added of Array.from(actions)) if (!added.isConnected) actions.delete(added);
    if (host.addAction(block, button, OPEN_LARGE_ORDER)) actions.add(button);
  }

  /* ── attach ── */

  function detachCurrent() {
    closeViewer(false);
    for (const stop of stops) {
      try { stop(); } catch (_error) { /* a host that already went */ }
    }
    stops = [];
    for (const button of Array.from(actions)) button.remove();
    actions.clear();
    if (overlay) overlay.destroy();
    overlay = null;
    overlayDocument = null;
    pending = new WeakSet();
    host = null;
    generation += 1;
  }

  /** Called once by the loader with the frame host; returns detach(). */
  function attach(nextHost) {
    if (host) detachCurrent();
    if (!nextHost || typeof nextHost.onMessage !== 'function' || typeof nextHost.onDrawn !== 'function') return function () {};
    host = nextHost;
    generation += 1;
    const mine = generation;
    stops = [nextHost.onMessage('open-file', handleOpenFile), nextHost.onDrawn(handleDrawn)];
    return function detach() {
      if (mine === generation && host === nextHost) detachCurrent();
    };
  }

  return { attach, openLarge };
});
