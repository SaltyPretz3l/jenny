/**
 * renderer/features/renderer-sketch-frame-host.js: draws `sketch` code blocks in the sandboxed
 * sketch frame (the project board plan sections 5.2, 5.4, 5.8).
 *
 * Loaded on the first sketch block (renderer-mermaid-runtime-loader.js renderSketchBlocks), never
 * at startup. The markdown module leaves a ```sketch fence as an ordinary code block; this module
 * finds those blocks after they are in the page and, when one comes near the viewport, puts a
 * frame above the code, sends it the source and hides the code once the drawing is up.
 *
 * The frame draws model output, so nothing it posts is trusted: every message is matched to its
 * frame's window and request id, heights are clamped, problems are rebuilt from known codes and
 * reach the page as text nodes only. The drawing's SVG never enters this page.
 *
 * Actions on a drawing (open, export, mark up) live in their own lazy modules. Each is handed this
 * object once (`attach(host)`) and uses onDrawn, addAction, post and onMessage; a message reaches a
 * module only after renderer-sketch-frame-messages.js has read it.
 */
/* global window, document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSketchFrameHost = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const FRAME_URL = 'jenny-sketch://frame/sketch-frame.html';
  const STYLESHEET_HREF = 'styles/markdown-sketch.css';
  const BOUNDS = Object.freeze({ chars: 16384, lines: 400 });
  const LOAD_TIMEOUT_MS = 10000;
  const LAYOUT_TIMEOUT_MS = 5000;
  const INITIAL_HEIGHT_PX = 120;
  const MIN_HEIGHT_PX = 60;
  const MAX_HEIGHT_PX = 10000;
  const MAX_POSITIONS_CHARS = 65536;
  const MAX_EARLIER = 4;
  /** Each frame holds tens of MB (plan 5.2), so only this many stay up; see parkFarthest. */
  const MAX_LIVE_FRAMES = 8;
  const CODE_SELECTOR = 'pre > code.language-sketch';
  const RETRYABLE = new Set(['timeout', 'unavailable']);
  // The frame's messages, checked, and its problems as words. The loader brings it in first.
  const messages = globalThis.rendererSketchFrameMessages
    || (typeof require === 'function' ? require('./renderer-sketch-frame-messages') : null);
  const { readProblems, describeProblem, describeChip, buildFixText, failureNote } = messages;
  const CHIP_RESET_MS = 1600;
  const WARN_ICON = '<svg class="markdown-sketch-problems-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8 2.2 14.2 13H1.8Z"/><path d="M8 6.5v3M8 11.4v.1"/></svg>';
  // The page's theme as the frame's colours (plan 5.8).
  const { PALETTE_TOKENS, readPalette } = globalThis.rendererSketchFramePalette
    || (typeof require === 'function' ? require('./renderer-sketch-frame-palette') : {});

  /** block element -> its live state. A block that has the class but no entry was rebuilt from a string. */
  const live = new WeakMap();
  /** States with a frame in the page; the message listener walks this. */
  const framed = new Set();
  let requestSequence = 0;
  let lazyObserver = null;
  let observedBlocks = null;
  let themeObserver = null;
  let lastPaletteKey = '';
  let listeningWindow = null;

  /* ── What an action module uses ── */

  const drawnListeners = new Set();
  const messageHandlers = new Map();
  let earlierProvider = null;

  /** listener({ block, source, width, counts }) runs each time a block has been drawn. */
  function onDrawn(listener) {
    drawnListeners.add(listener);
    return function () { drawnListeners.delete(listener); };
  }

  /** handler(block, message) gets the checked messages of one type (readFrameMessage). One handler a type. */
  function onMessage(type, handler) {
    messageHandlers.set(type, handler);
    return function () { if (messageHandlers.get(type) === handler) messageHandlers.delete(type); };
  }

  /** provider(block, source) returns the earlier drawings of the same conversation, nearest first (plan 5.5). */
  function setEarlierProvider(provider) {
    earlierProvider = typeof provider === 'function' ? provider : null;
  }

  function earlierFor(block, source) {
    if (!earlierProvider) return [];
    try {
      const list = earlierProvider(block, source);
      return (Array.isArray(list) ? list : [])
        .filter((item) => item && typeof item.source === 'string' && !overBounds(item.source))
        .slice(0, MAX_EARLIER)
        .map((item) => ({ source: item.source, positions: readPositions(item.positions) }));
    } catch (_error) {
      return [];
    }
  }

  /** Sends a drawn block's frame a message, stamped with that frame's request id. False when there is no drawing. */
  function post(block, message) {
    const state = live.get(block);
    const target = state && !state.released && state.settled === 'drawn' && state.iframe ? state.iframe.contentWindow : null;
    if (!target) return false;
    try {
      target.postMessage(Object.assign({}, message, { requestId: state.requestId }), '*');
      return true;
    } catch (_error) {
      return false;
    }
  }

  /** The row under a drawing: the problems note on the left, the modules' actions on the right. Made when first needed. */
  function ensureRow(block) {
    let row = block.querySelector(':scope > .markdown-sketch-row');
    if (!row) {
      row = block.ownerDocument.createElement('div');
      row.className = 'markdown-sketch-row';
      row.appendChild(line(block.ownerDocument, 'markdown-sketch-actions', ''));
      block.appendChild(row);
    }
    return row;
  }

  /** Puts a control in a drawn block's action row; a lower `order` sits further left. */
  function addAction(block, element, order) {
    const state = live.get(block);
    if (!element || !state || state.released || state.settled !== 'drawn') return false;
    const actions = ensureRow(block).querySelector(':scope > .markdown-sketch-actions');
    element.setAttribute('data-sketch-order', String(order));
    const after = Array.from(actions.children).find((child) => Number(child.getAttribute('data-sketch-order')) > order);
    actions.insertBefore(element, after || null);
    return true;
  }

  function sourceOf(block) {
    const state = live.get(block);
    return state && typeof state.source === 'string' ? state.source : '';
  }

  function dispatch(state, payload) {
    const handler = state.settled === 'drawn' ? messageHandlers.get(payload.type) : null;
    const message = handler ? messages.readFrameMessage(payload) : null;
    if (!message) return;
    try { handler(state.block, message); } catch (_error) { logFailure('action'); }
  }

  /* ── Small DOM helpers ── */

  function button(ownerDocument, options) {
    const make = globalThis.inventoryActionButton
      || (typeof require === 'function' ? require('../inventory/action-button') : null);
    if (typeof make !== 'function') return null;
    const template = ownerDocument.createElement('template');
    template.innerHTML = make(Object.assign({ variant: 'ghost', size: 'sm' }, options));
    return template.content.firstElementChild;
  }

  function line(ownerDocument, className, text) {
    const node = ownerDocument.createElement('div');
    node.className = className;
    node.textContent = text;
    return node;
  }

  function ensureStylesheet(ownerDocument) {
    const head = ownerDocument.head || ownerDocument.documentElement;
    if (!head || ownerDocument.querySelector('link[data-jenny-sketch-styles]')) return;
    const link = ownerDocument.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLESHEET_HREF;
    link.setAttribute('data-jenny-sketch-styles', 'true');
    head.appendChild(link);
  }

  function logFailure(reason) {
    try {
      const logger = typeof globalThis !== 'undefined' ? globalThis.appendClientLog : null;
      if (typeof logger === 'function') logger('WARN', 'markdown.sketch_render_failed', { reason: String(reason || 'error').slice(0, 32) });
    } catch (_error) { /* diagnostics are best-effort */ }
  }

  function overBounds(source) {
    if (source.length > BOUNDS.chars) return 'too_long';
    let lines = 1;
    for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) {
      lines += 1;
      if (lines > BOUNDS.lines) return 'too_many_lines';
    }
    return '';
  }

  function clampHeight(value) {
    const height = Math.ceil(Number(value));
    return Number.isFinite(height) ? Math.max(MIN_HEIGHT_PX, Math.min(MAX_HEIGHT_PX, height)) : MIN_HEIGHT_PX;
  }

  function readPositions(value) {
    if (!value || typeof value !== 'object') return null;
    try {
      const text = JSON.stringify(value);
      return text.length <= MAX_POSITIONS_CHARS ? JSON.parse(text) : null;
    } catch (_error) {
      return null;
    }
  }

  /* ── One block ── */

  function clearTimer(state) {
    if (state.timer) {
      state.windowRef.clearTimeout(state.timer);
      state.timer = 0;
    }
  }

  function removeExtras(block) {
    for (const node of Array.from(block.querySelectorAll(':scope > .markdown-sketch-paper, :scope > .markdown-sketch-note, :scope > .markdown-sketch-row, :scope > .markdown-sketch-problems'))) {
      node.remove();
    }
  }

  /** Drops the frame and this module's hold on the block. The block's markup is left as it is. */
  function release(state) {
    if (state.released) return;
    state.released = true;
    clearTimer(state);
    framed.delete(state);
    if (live.get(state.block) === state) live.delete(state.block);
    if (!framed.size && listeningWindow) {
      listeningWindow.removeEventListener('message', handleMessage);
      listeningWindow = null;
    }
  }

  /** Puts a block back to the plain code block the markdown module made. */
  function resetBlock(block) {
    const state = live.get(block);
    if (state) release(state);
    live.delete(block);
    removeExtras(block);
    block.style.minHeight = '';
    block.classList.remove('markdown-sketch-block');
    block.removeAttribute('data-sketch-rendered');
    block.removeAttribute('role');
    block.removeAttribute('aria-label');
  }

  /** Puts text in the message box; nothing is sent. False when no composer took it. */
  function insertText(text) {
    const insert = globalThis.rendererComposerInsert && globalThis.rendererComposerInsert.insertIntoComposer;
    return typeof insert === 'function' ? insert({ text }) : false;
  }

  /** A refused drawing: the problems and Fix, listed under the note and above the source. */
  function showProblems(state, problems, reason) {
    const ownerDocument = state.block.ownerDocument;
    const fixText = buildFixText(problems, reason);
    if (!problems.length && !fixText) return;
    const list = ownerDocument.createElement('div');
    list.className = 'markdown-sketch-problems';
    for (const problem of problems) list.appendChild(line(ownerDocument, 'markdown-sketch-problem', describeProblem(problem)));
    const fix = fixText && button(ownerDocument, { className: 'markdown-sketch-fix', label: jt('markdown.sketch.fix', 'Fix'), title: jt('markdown.sketch.fixHint', 'Put these problems in the message box') });
    if (fix) {
      fix.addEventListener('click', function () {
        if (insertText(fixText) === false) fix.setAttribute('title', jt('markdown.sketch.fixNoComposer', 'Open a chat to send this'));
      });
      const holder = ownerDocument.createElement('div');
      holder.className = 'markdown-sketch-fix-row';
      holder.appendChild(fix);
      list.appendChild(holder);
    }
    state.block.insertBefore(list, state.after.nextSibling);
  }

  /** A drawn block: one chip at the head of the action row. Hover or focus shows the problems (the inventory
   *  tooltip reads its title); a click puts the redraw request in the message box and says so for a moment. */
  function showProblemsChip(state, problems) {
    const fixText = buildFixText(problems, '');
    if (!problems.length || !fixText) return;
    const ownerDocument = state.block.ownerDocument;
    const words = describeChip(problems);
    const chip = button(ownerDocument, {
      className: 'markdown-sketch-problems-chip', title: words.tooltip, ariaLabel: words.label, dataset: { tone: words.tone },
      trustedHtml: WARN_ICON + '<span class="markdown-sketch-problems-count">' + problems.length + '</span>',
    });
    if (!chip) return;
    const count = chip.querySelector('.markdown-sketch-problems-count');
    let timer = 0;
    chip.addEventListener('click', function () {
      const added = insertText(fixText) !== false;
      count.textContent = added ? jt('markdown.sketch.problemsAdded', 'Added to the message box') : jt('markdown.sketch.fixNoComposer', 'Open a chat to send this');
      const windowRef = ownerDocument.defaultView;
      if (!windowRef) return;
      windowRef.clearTimeout(timer);
      timer = windowRef.setTimeout(function () { count.textContent = String(problems.length); }, CHIP_RESET_MS);
    });
    const row = ensureRow(state.block);
    row.insertBefore(chip, row.firstChild);
  }

  function fail(state, reason, problems) {
    if (state.released || state.settled === 'failed') return;
    state.settled = 'failed';
    const block = state.block;
    const ownerDocument = block.ownerDocument;
    release(state);
    removeExtras(block);
    block.style.minHeight = '';
    block.setAttribute('data-sketch-rendered', 'failed');
    block.removeAttribute('role');
    block.removeAttribute('aria-label');
    const note = line(ownerDocument, 'markdown-sketch-note', failureNote(reason));
    note.setAttribute('role', 'status');
    if (RETRYABLE.has(reason)) {
      const retry = button(ownerDocument, { className: 'markdown-sketch-retry', label: jt('markdown.sketch.retry', 'Try again') });
      if (retry) {
        retry.addEventListener('click', function () {
          resetBlock(block);
          renderBlock(block);
        }, { once: true });
        note.appendChild(retry);
      }
    }
    block.insertBefore(note, block.firstChild);
    // The held state is gone, so a later scan leaves a failed block alone until its row is rebuilt.
    live.set(block, { block, released: true, settled: 'failed' });
    showProblems({ block, after: note }, problems || [], reason);
    logFailure(reason);
  }

  function succeed(state, payload) {
    clearTimer(state);
    state.iframe.style.height = clampHeight(payload.height) + 'px';
    state.positions = readPositions(payload.positions);
    if (state.settled === 'drawn') return;
    state.settled = 'drawn';
    const block = state.block;
    block.style.minHeight = '';
    block.setAttribute('data-sketch-rendered', 'true');
    block.setAttribute('role', 'figure');
    block.setAttribute('aria-label', jt('markdown.sketch.frameLabel', 'Diagram'));
    showProblemsChip(state, readProblems(payload.problems));
    const drawn = { block, source: state.source, width: Math.max(0, Math.ceil(Number(payload.width)) || 0), counts: payload.counts || null };
    for (const listener of Array.from(drawnListeners)) {
      try { listener(drawn); } catch (_error) { logFailure('action'); }
    }
    parkFarthest(state);
  }

  /**
   * Past MAX_LIVE_FRAMES, the drawing furthest from view (and at least a screen away) gives its frame back.
   * The block keeps its height and is drawn again when it comes near. One being marked up is left alone.
   */
  function parkFarthest(keep) {
    if (framed.size <= MAX_LIVE_FRAMES || !lazyObserver) return;
    const screen = keep.windowRef.innerHeight || 0;
    let farthest = null;
    let furthest = screen;
    for (const state of framed) {
      if (state === keep || state.settled !== 'drawn' || state.block.querySelector('[data-sketch-action="markup"][aria-pressed="true"]')) continue;
      const rect = state.block.getBoundingClientRect();
      const away = Math.max(rect.top - screen, -rect.bottom);
      if (away > furthest) {
        furthest = away;
        farthest = state;
      }
    }
    if (!farthest) return;
    const block = farthest.block;
    const height = Math.round(block.getBoundingClientRect().height);
    resetBlock(block);
    if (height > 0) block.style.minHeight = height + 'px';
    lazyObserver.observe(block);
    observedBlocks.add(block);
  }

  function startTimer(state, milliseconds, reason) {
    clearTimer(state);
    state.timer = state.windowRef.setTimeout(function () {
      state.timer = 0;
      fail(state, reason, []);
    }, milliseconds);
  }

  function sendRequest(state) {
    const target = state.iframe.contentWindow;
    if (!target) return;
    try {
      // The frame has an opaque origin (sandbox without allow-same-origin), so '*' is the only address.
      target.postMessage({ type: 'theme', palette: readPalette(state.block.ownerDocument) }, '*');
      target.postMessage({ type: 'render', requestId: state.requestId, source: state.source, previous: state.previous, earlier: state.earlier, options: {} }, '*');
    } catch (_error) {
      fail(state, 'error', []);
      return;
    }
    if (state.settled !== 'drawn') startTimer(state, LAYOUT_TIMEOUT_MS, 'timeout');
  }

  function prune() {
    for (const state of Array.from(framed)) {
      if (!state.block.isConnected || !state.iframe.isConnected) release(state);
    }
    if (lazyObserver && observedBlocks) {
      for (const block of Array.from(observedBlocks)) {
        if (!block.isConnected) {
          lazyObserver.unobserve(block);
          observedBlocks.delete(block);
        }
      }
    }
  }

  function handleMessage(event) {
    let state = null;
    for (const candidate of framed) {
      if (candidate.iframe.contentWindow === event.source) {
        state = candidate;
        break;
      }
    }
    if (!state || state.released) return;
    const payload = event.data && typeof event.data === 'object' ? event.data : null;
    if (!payload) return;
    if (payload.type === 'sketch-frame-ready') {
      sendRequest(state);
      return;
    }
    if (payload.requestId !== state.requestId) return;
    if (payload.type === 'height') {
      state.iframe.style.height = clampHeight(payload.height) + 'px';
      return;
    }
    if (payload.type !== 'rendered') {
      dispatch(state, payload);
      return;
    }
    if (payload.ok === true) succeed(state, payload);
    else fail(state, typeof payload.reason === 'string' ? payload.reason : 'error', readProblems(payload.problems));
  }

  function watchTheme(ownerDocument) {
    const view = ownerDocument.defaultView;
    const ObserverCtor = view && view.MutationObserver;
    if (themeObserver || typeof ObserverCtor !== 'function') return;
    lastPaletteKey = JSON.stringify(readPalette(ownerDocument));
    themeObserver = new ObserverCtor(function () { refreshTheme(ownerDocument); });
    themeObserver.observe(ownerDocument.documentElement, { attributes: true, attributeFilter: ['data-palette', 'data-theme', 'style'] });
  }

  /** Posts the page's colours to every live frame when they have changed; each frame redraws. */
  function refreshTheme(documentRef) {
    const ownerDocument = documentRef || (typeof document !== 'undefined' ? document : null);
    if (!ownerDocument) return false;
    const palette = readPalette(ownerDocument);
    const key = JSON.stringify(palette);
    if (key === lastPaletteKey) return false;
    lastPaletteKey = key;
    prune();
    for (const state of framed) {
      try { state.iframe.contentWindow.postMessage({ type: 'theme', palette }, '*'); } catch (_error) { /* a dying frame */ }
    }
    return true;
  }

  function renderBlock(block, options) {
    if (!block || live.has(block)) return;
    const code = block.querySelector(CODE_SELECTOR);
    const source = code ? String(code.textContent || '') : '';
    const ownerDocument = block.ownerDocument;
    const windowRef = ownerDocument && ownerDocument.defaultView;
    if (!source.trim() || !windowRef) return;
    ensureStylesheet(ownerDocument);
    const state = {
      block, source, windowRef, iframe: null, timer: 0, settled: '', released: false, positions: null,
      previous: (options && options.previous) || null,
      earlier: options && options.previous ? [] : earlierFor(block, source),
      requestId: 'sketch-' + (++requestSequence) + '-' + Math.random().toString(36).slice(2, 10),
    };
    live.set(block, state);
    block.classList.add('markdown-sketch-block');
    block.setAttribute('data-sketch-rendered', 'pending');
    const over = overBounds(source);
    if (over) {
      fail(state, over, []);
      return;
    }
    const paper = ownerDocument.createElement('div');
    paper.className = 'markdown-sketch-paper';
    const iframe = ownerDocument.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('title', jt('markdown.sketch.frameLabel', 'Diagram'));
    iframe.setAttribute('scrolling', 'no');
    iframe.style.height = INITIAL_HEIGHT_PX + 'px';
    iframe.src = (options && options.frameSrc) || FRAME_URL;
    state.iframe = iframe;
    framed.add(state);
    if (listeningWindow !== windowRef) {
      if (listeningWindow) listeningWindow.removeEventListener('message', handleMessage);
      windowRef.addEventListener('message', handleMessage);
      listeningWindow = windowRef;
    }
    watchTheme(ownerDocument);
    startTimer(state, LOAD_TIMEOUT_MS, 'unavailable');
    // Listener before append: a cached frame can announce itself while appendChild is on the stack.
    paper.appendChild(iframe);
    block.insertBefore(paper, block.firstChild);
  }

  /* ── Scanning ── */

  function findBlocks(container) {
    const blocks = [];
    for (const code of container.querySelectorAll(CODE_SELECTOR)) {
      const block = typeof code.closest === 'function' ? code.closest('.markdown-code-block') : null;
      // A Mermaid block keeps its source in a code block of its own; that one is Mermaid's.
      if (!block || blocks.includes(block) || block.closest('.reasoning-row-panel, .markdown-mermaid-block')) continue;
      blocks.push(block);
    }
    return blocks;
  }

  /**
   * Finds the sketch code blocks in `container` and draws each when it comes near the viewport. The
   * last block is left alone while its message is still streaming. A block whose markup was rebuilt
   * from a string (a row the timeline put back) starts again.
   */
  function renderInline(container, options) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    prune();
    const blocks = findBlocks(container);
    if (!blocks.length) return;
    const isStreaming = Boolean(options && options.isStreaming);
    const IOCtor = typeof globalThis !== 'undefined' ? globalThis.IntersectionObserver : null;
    if (typeof IOCtor === 'function' && !lazyObserver) {
      observedBlocks = new Set();
      lazyObserver = new IOCtor(function (entries) {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          lazyObserver.unobserve(entry.target);
          observedBlocks.delete(entry.target);
          renderBlock(entry.target);
        }
      }, { rootMargin: '200px 0px' });
    }
    blocks.forEach(function (block, index) {
      if (block.classList.contains('markdown-sketch-block') && !live.has(block)) resetBlock(block);
      if (live.has(block) || (isStreaming && index === blocks.length - 1)) return;
      if (!lazyObserver) {
        renderBlock(block);
        return;
      }
      lazyObserver.observe(block);
      observedBlocks.add(block);
    });
  }

  /** The positions of a drawn block's nodes, for a follow-up drawing (plan 5.5). */
  function getPositions(block) {
    const state = live.get(block);
    return state && state.positions ? state.positions : null;
  }

  function dispose() {
    for (const state of Array.from(framed)) release(state);
    if (lazyObserver) lazyObserver.disconnect();
    if (themeObserver) themeObserver.disconnect();
    lazyObserver = null;
    observedBlocks = null;
    themeObserver = null;
    lastPaletteKey = '';
    drawnListeners.clear();
    messageHandlers.clear();
    earlierProvider = null;
  }

  return {
    FRAME_URL,
    MAX_LIVE_FRAMES,
    PALETTE_TOKENS,
    renderInline,
    renderBlock,
    resetBlock,
    refreshTheme,
    readPalette,
    getPositions,
    onDrawn,
    onMessage,
    setEarlierProvider,
    post,
    addAction,
    sourceOf,
    dispose,
  };
});
