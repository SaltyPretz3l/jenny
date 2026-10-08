(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-component-preservation-registry'));
    return;
  }
  root.rendererStreamDomPatchUtils = factory(root.rendererComponentPreservationRegistry);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (preservationModule) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const SCROLLABLE_CODE_SELECTOR = 'pre';
  const MORPH_KEY_ATTRIBUTES = Object.freeze([
    'data-thread-message-id',
    'data-message-id',
    'data-row-id',
    'data-tool-call-id',
    'data-call-id',
    'data-artifact-id',
    // Time-gap dividers are the sole producer of this target identity.
    'data-before-message-id',
  ]);
  const componentRegistry = preservationModule
    && typeof preservationModule.createComponentPreservationRegistry === 'function'
    ? preservationModule.createComponentPreservationRegistry()
    : null;

  function queryAllSafe(rootNode, selector) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return [];
    try { return Array.from(rootNode.querySelectorAll(selector)); } catch (_error) { return []; }
  }

  function collectSelfAndDescendants(rootNode, selector) {
    const elements = [];
    try {
      if (rootNode?.matches?.(selector)) elements.push(rootNode);
    } catch (_error) { /* constant selectors only */ }
    return elements.concat(queryAllSafe(rootNode, selector));
  }

  function captureCodeBlockScroll(rootNode) {
    const blocks = queryAllSafe(rootNode, SCROLLABLE_CODE_SELECTOR);
    const saved = [];
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      const left = Number(block.scrollLeft) || 0;
      const top = Number(block.scrollTop) || 0;
      if (left || top) saved.push({ index, left, top });
    }
    return saved;
  }

  function restoreCodeBlockScroll(rootNode, saved) {
    if (!saved || !saved.length) return;
    const blocks = queryAllSafe(rootNode, SCROLLABLE_CODE_SELECTOR);
    for (const entry of saved) {
      const block = blocks[entry.index];
      if (!block) continue;
      if (entry.left) block.scrollLeft = entry.left;
      if (entry.top) block.scrollTop = entry.top;
    }
  }

  function captureCodeBlockWrapState(rootNode) {
    const blocks = collectSelfAndDescendants(rootNode, '.markdown-code-block');
    const saved = [];
    for (let index = 0; index < blocks.length; index += 1) {
      if (blocks[index].classList?.contains('is-wrapped')) saved.push(index);
    }
    return saved;
  }

  function restoreCodeBlockWrapState(rootNode, saved) {
    if (!saved || !saved.length) return;
    const blocks = collectSelfAndDescendants(rootNode, '.markdown-code-block');
    for (const index of saved) {
      const block = blocks[index];
      if (!block) continue;
      block.classList.add('is-wrapped');
      block.querySelector('.inv-codeblock-wrap-toggle')?.setAttribute('aria-pressed', 'true');
    }
  }

  function captureCodeBlockExpandState(rootNode) {
    const blocks = collectSelfAndDescendants(rootNode, '.markdown-code-block');
    const saved = [];
    for (let index = 0; index < blocks.length; index += 1) {
      const classList = blocks[index].classList;
      if (classList?.contains('collapsible') && !classList.contains('collapsed')) saved.push(index);
    }
    return saved;
  }

  function restoreCodeBlockExpandState(rootNode, saved) {
    if (!saved || !saved.length) return;
    const blocks = collectSelfAndDescendants(rootNode, '.markdown-code-block');
    for (const index of saved) {
      const block = blocks[index];
      if (!block?.classList?.contains('collapsible')) continue;
      block.classList.remove('collapsed');
      const overlay = block.querySelector?.('.markdown-code-expand-overlay');
      overlay?.setAttribute('aria-expanded', 'true');
      overlay?.setAttribute('aria-label', jt('chat.streamPatch.showLessCode', 'Show less code'));
      const label = overlay?.querySelector?.('span');
      if (label) label.textContent = jt('chat.streamPatch.showLess', 'Show less');
    }
  }

  function getMorphKey(node) {
    if (!node || node.nodeType !== 1 || typeof node.getAttribute !== 'function') {
      return '';
    }
    const componentKey = componentRegistry?.getNodeKey?.(node) || '';
    if (componentKey) return componentKey;
    for (const attr of MORPH_KEY_ATTRIBUTES) {
      const value = String(node.getAttribute(attr) || '').trim();
      if (value) {
        return `${attr}:${value}`;
      }
    }
    return '';
  }

  function canMorphNode(currentNode, nextNode) {
    if (!currentNode || !nextNode || currentNode.nodeType !== nextNode.nodeType) {
      return false;
    }
    if (currentNode.nodeType !== 1) {
      return currentNode.nodeType === 3;
    }
    if (String(currentNode.tagName || '') !== String(nextNode.tagName || '')) {
      return false;
    }
    const currentKey = getMorphKey(currentNode);
    const nextKey = getMorphKey(nextNode);
    if (currentKey || nextKey) {
      return Boolean(currentKey && nextKey && currentKey === nextKey);
    }
    return true;
  }

  function syncElementAttributes(target, source) {
    if (!target || !source || target.nodeType !== 1 || source.nodeType !== 1) {
      return;
    }
    const nextNames = new Set();
    for (const attr of Array.from(source.attributes || [])) {
      nextNames.add(attr.name);
      if (target.getAttribute(attr.name) !== attr.value) {
        target.setAttribute(attr.name, attr.value);
      }
    }
    const preserveThreadRootStyle = target.classList?.contains?.('chat-thread-root')
      && !source.hasAttribute?.('style');
    for (const attr of Array.from(target.attributes || [])) {
      if (!nextNames.has(attr.name) && !(attr.name === 'style' && preserveThreadRootStyle)) {
        target.removeAttribute(attr.name);
      }
    }
  }

  function buildMorphKeyIndex(parent) {
    const keyIndex = new Map();
    for (const child of Array.from(parent?.childNodes || [])) {
      const key = getMorphKey(child);
      if (!key) {
        continue;
      }
      const list = keyIndex.get(key);
      if (list) {
        list.push(child);
      } else {
        keyIndex.set(key, [child]);
      }
    }
    return keyIndex;
  }

  function takeMorphKeyMatch(keyIndex, key, nextChild, consumed) {
    const candidates = keyIndex.get(key);
    if (!candidates) {
      return null;
    }
    while (candidates.length) {
      const child = candidates.shift();
      if (!consumed.has(child) && canMorphNode(child, nextChild)) {
        return child;
      }
    }
    return null;
  }

  function findMorphChild(nextChild, cursor, consumed, keyIndex) {
    if (!nextChild) {
      return null;
    }
    const nextKey = getMorphKey(nextChild);
    if (nextKey) {
      return takeMorphKeyMatch(keyIndex, nextKey, nextChild, consumed);
    }
    if (cursor && !consumed.has(cursor) && canMorphNode(cursor, nextChild)) {
      return cursor;
    }
    for (let child = cursor; child; child = child.nextSibling) {
      if (!consumed.has(child) && !getMorphKey(child) && canMorphNode(child, nextChild)) {
        return child;
      }
    }
    return null;
  }

  // `stats` (optional): a plain { reused, cloned, removed } accumulator for
  // the render-path telemetry diagnostics (Track A). Absent/undefined
  // => zero behavior change, nothing is read or written on it.
  function morphChildren(target, source, stats) {
    let cursor = target.firstChild;
    const consumed = new Set();
    const keyIndex = buildMorphKeyIndex(target);
    for (const nextChild of Array.from(source.childNodes || [])) {
      const match = findMorphChild(nextChild, cursor, consumed, keyIndex);
      let currentChild = match;
      if (currentChild) {
        consumed.add(currentChild);
        morphNode(currentChild, nextChild, stats);
        if (stats) stats.reused = (stats.reused || 0) + 1;
      } else {
        currentChild = nextChild.cloneNode(true);
        consumed.add(currentChild);
        if (stats) stats.cloned = (stats.cloned || 0) + 1;
      }
      if (currentChild !== cursor) {
        target.insertBefore(currentChild, cursor || null);
      }
      cursor = currentChild.nextSibling;
      while (cursor && consumed.has(cursor)) {
        cursor = cursor.nextSibling;
      }
    }
    for (const child of Array.from(target.childNodes || [])) {
      if (!consumed.has(child)) {
        child.remove();
        if (stats) stats.removed = (stats.removed || 0) + 1;
      }
    }
  }

  // The markup reconcileKeyedRowList last applied to a row element. Stamped
  // only by that helper and dropped by every other morph through this module,
  // so a present stamp means "this module's last write to this element was
  // exactly this markup" -- the invariant that lets an unchanged row be
  // skipped without parsing it.
  const lastAppliedRowMarkup = new WeakMap();

  function morphNode(target, source, stats) {
    if (!canMorphNode(target, source)) {
      return false;
    }
    if (target.nodeType === 3) {
      if (target.nodeValue !== source.nodeValue) {
        target.nodeValue = source.nodeValue;
      }
      return true;
    }
    if (componentRegistry?.shouldRetainNode?.(target, source)) {
      return true;
    }
    lastAppliedRowMarkup.delete(target);
    syncElementAttributes(target, source);
    // An article-level morph (the streaming article rewrite) reconciles its
    // turn row list per row instead of descending into every settled row.
    if (rowListMorphHook && isTurnRowList(target) && isTurnRowList(source)) {
      rowListMorphHook(target, source, stats);
      return true;
    }
    morphChildren(target, source, stats);
    return true;
  }

  function isTurnRowList(node) {
    return Boolean(node && node.nodeType === 1 && node.hasAttribute?.('data-turn-row-list'));
  }
  let rowListMorphHook = null;

  // Runs `run` with the per-row reconcile installed for the turn row list in
  // the article whose data-message-id is `hostId` (every row list when it is
  // empty); any other row list morphs as before. `onRecord` receives the
  // reconcile's { outcome, stats } when it ran. No segments = no hook.
  // `cutBody` (optional): the list body cut out of the parsed markup (see
  // cutRowListBody); a failed reconcile then morphs against it, parsed.
  function runWithRowListReconcile(segments, hostId, onRecord, run, cutBody) {
    const previousHook = rowListMorphHook;
    rowListMorphHook = segments ? (target, source, morphStats) => {
      if (hostId && target.closest?.('[data-message-id]')?.getAttribute('data-message-id') !== hostId) {
        morphChildren(target, source, morphStats);
        return;
      }
      let record;
      const reconciled = reconcileKeyedRowList(target, segments, { onOutcome: (result) => { record = result; } });
      onRecord({ outcome: String(record?.outcome || 'morph_unavailable'), stats: record?.stats });
      if (reconciled) return;
      const template = cutBody == null ? null : target.ownerDocument?.createElement?.('template');
      if (template) template.innerHTML = cutBody;
      morphChildren(target, template ? template.content : source, morphStats);
    } : null;
    try {
      return run();
    } finally {
      rowListMorphHook = previousHook;
    }
  }

  // timeline-perf 2026-10-04: a host row list reconciled per row never reads
  // its rows from the parsed markup, so only the shell -- the markup with
  // that list's body cut out -- is parsed. Null (parse it all) unless the
  // joined segments are found exactly once, right after a row-list open tag
  // and before its close, and the element holds exactly one host row list.
  function cutRowListBody(element, html, segments, hostId) {
    const body = segments.map((segment) => String(segment?.markup || '')).join('');
    const at = body ? html.indexOf(body) : -1;
    if (at <= 0 || html.indexOf(body, at + 1) !== -1 || !html.startsWith('</div>', at + body.length)) return null;
    const openTag = html.slice(html.lastIndexOf('<', at - 1), at);
    if (!openTag.endsWith('>') || !openTag.includes('data-turn-row-list')) return null;
    const hostLists = queryAllSafe(element, '[data-turn-row-list]').filter((list) => !hostId
      || list.closest?.('[data-message-id]')?.getAttribute('data-message-id') === hostId);
    return hostLists.length === 1 ? { shell: html.slice(0, at) + html.slice(at + body.length), body } : null;
  }

  function readRowListOptions(options) {
    const segments = Array.isArray(options?.rowListSegments) && options.rowListSegments.length ? options.rowListSegments : null;
    return { segments, hostId: String(options?.rowListHostId || '') };
  }

  // A lane that writes a row's DOM directly (the live tool patch) calls this
  // so the reconcile re-checks that row instead of trusting its stamp.
  function invalidateRowStamp(node) {
    if (!node || node.nodeType !== 1) return;
    const row = typeof node.closest === 'function' ? (node.closest('[data-row-id]') || node) : node;
    lastAppliedRowMarkup.delete(row);
  }

  // A row element that the surgical patch also writes: its stamp cannot be
  // trusted, so it is morphed on every reconcile. Both sides are checked (the
  // rendered element and the incoming markup) so a row entering or leaving the
  // live state is never skipped on the transition.
  // timeline-perf 2026-10-04: the element side used to query the subtree of
  // every stamped row on every reconcile. A stamped row can hold a live
  // descendant only if it had one when stamped or something wrote into it
  // since, so the query runs only for rows in `rowsWrittenSinceStamp`: set at
  // stamp time when live, and by noteRowSubtreeWrite, which every mutating
  // entry point of this module and the surgical bubble/reasoning writers call.
  const LIVE_ROW_MARKUP_RE = /data-streaming-row="true"|data-reasoning-live-tail="true"|data-streaming-bubble="true"/;
  const rowsWrittenSinceStamp = new WeakSet();
  function hasLiveDescendant(element) {
    try {
      return Boolean(element.querySelector('[data-reasoning-live-tail="true"], [data-streaming-bubble="true"]'));
    } catch (_error) {
      return true;
    }
  }
  function isLiveRowElement(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.getAttribute('data-streaming-row') === 'true') return true;
    if (!rowsWrittenSinceStamp.has(element)) return false;
    if (hasLiveDescendant(element)) return true;
    rowsWrittenSinceStamp.delete(element);
    return false;
  }
  function stampRow(row, markup) {
    lastAppliedRowMarkup.set(row, markup);
    if (LIVE_ROW_MARKUP_RE.test(markup) || hasLiveDescendant(row)) rowsWrittenSinceStamp.add(row);
    else rowsWrittenSinceStamp.delete(row);
  }
  // A write into `node`'s subtree from outside the reconcile: every stamped
  // row enclosing it (or `node` itself) re-checks its live descendants.
  function noteRowSubtreeWrite(node) {
    let current = node && node.nodeType === 1 ? node : node?.parentElement;
    for (; current; current = current.parentElement) {
      if (lastAppliedRowMarkup.has(current)) rowsWrittenSinceStamp.add(current);
    }
  }

  function segmentMorphKey(segment) {
    if (!segment || typeof segment !== 'object') return '';
    const id = String(segment.id || '').trim();
    if (!id) return '';
    if (segment.kind === 'divider') return `data-before-message-id:${id}`;
    return `data-row-id:${id}`;
  }

  // Per-row reconcile of a turn row list (timeline-perf 2026-09-30). The keyed
  // fallback used to re-parse the whole list and morph every node of every row
  // on each structural delta of a live turn -- 40% of the renderer's time on a
  // 119-row turn. `segments` is the list body split per top-level child
  // ({ kind: 'row' | 'divider', id, markup }, document order, from
  // renderer-turn-row-list-utils.js). For each segment: the existing child
  // with the same key is kept untouched when the markup last applied to it is
  // byte-identical and it is not a live row; otherwise that one segment is
  // parsed and morphed in place (component/code-block state preserved per
  // row); a missing child is inserted; order is reconciled by moving nodes;
  // leftover children are removed. Returns false only when the inputs are
  // unusable or the reconcile throws, so the caller can fall back to the
  // whole-list morph. `options.onOutcome` receives { outcome, stats } with
  // stats { kept, morphed, added, removed, reused, cloned } (reused/cloned are
  // the descendant morph counts of the rows that were morphed).
  function reconcileKeyedRowList(target, segments, options = {}) {
    const callbacks = options && typeof options === 'object' ? options : {};
    function report(outcome, stats) {
      if (typeof callbacks.onOutcome !== 'function') return;
      try { callbacks.onOutcome({ outcome, stats }); } catch (_error) { /* diagnostics only */ }
    }
    if (!target || target.nodeType !== 1) {
      report('no_element', undefined);
      return false;
    }
    if (!Array.isArray(segments) || !segments.length) {
      report('no_segments', undefined);
      return false;
    }
    const documentRef = target.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const template = documentRef?.createElement?.('template');
    if (!template) {
      report('parse_failed', undefined);
      return false;
    }
    const stats = { kept: 0, morphed: 0, added: 0, removed: 0, reused: 0, cloned: 0 };
    const touched = [];
    noteRowSubtreeWrite(target);
    try {
      const keyIndex = buildMorphKeyIndex(target);
      const consumed = new Set();
      const seenKeys = new Set();
      let cursor = target.firstChild;
      for (const segment of segments) {
        const key = segmentMorphKey(segment);
        const markup = String(segment?.markup || '');
        if (!key || !markup.trim()) continue;
        // A repeated key is a builder fault (two builds into one sink); the
        // first copy wins, a second must never land as an extra row.
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const candidates = keyIndex.get(key);
        let existing = null;
        while (candidates && candidates.length) {
          const candidate = candidates.shift();
          if (!consumed.has(candidate)) { existing = candidate; break; }
        }
        let current = existing;
        if (existing) {
          consumed.add(existing);
          const unchanged = lastAppliedRowMarkup.get(existing) === markup
            && !LIVE_ROW_MARKUP_RE.test(markup)
            && !isLiveRowElement(existing);
          if (unchanged) {
            stats.kept += 1;
          } else {
            template.innerHTML = markup.trim();
            const fresh = template.content.firstElementChild;
            if (!fresh) continue;
            const saved = captureCodeBlockScroll(existing);
            const wrapped = captureCodeBlockWrapState(existing);
            const expanded = captureCodeBlockExpandState(existing);
            const componentSnapshot = componentRegistry?.capture?.(existing) || null;
            if (morphNode(existing, fresh, stats)) {
              restoreCodeBlockScroll(existing, saved);
              restoreCodeBlockWrapState(existing, wrapped);
              restoreCodeBlockExpandState(existing, expanded);
              componentRegistry?.restore?.(existing, componentSnapshot);
            } else {
              // Same key, different element shape: replace the node outright.
              const replacement = fresh.cloneNode(true);
              existing.replaceWith(replacement);
              consumed.add(replacement);
              current = replacement;
              stats.cloned += 1;
            }
            stampRow(current, markup);
            stats.morphed += 1;
            touched.push(current);
          }
        } else {
          template.innerHTML = markup.trim();
          const fresh = template.content.firstElementChild;
          if (!fresh) continue;
          current = fresh.cloneNode(true);
          consumed.add(current);
          stampRow(current, markup);
          stats.added += 1;
          touched.push(current);
        }
        if (current !== cursor) {
          target.insertBefore(current, cursor || null);
        }
        cursor = current.nextSibling;
        while (cursor && consumed.has(cursor)) {
          cursor = cursor.nextSibling;
        }
      }
      for (const child of Array.from(target.childNodes || [])) {
        if (!consumed.has(child)) {
          child.remove();
          stats.removed += 1;
        }
      }
      if (typeof callbacks.onTouched === 'function') {
        try { callbacks.onTouched(touched); } catch (_error) { /* diagnostics only */ }
      }
      report('reconcile_applied', stats);
      return true;
    } catch (error) {
      if (typeof callbacks.onError === 'function') {
        try { callbacks.onError(error); } catch (_callbackError) { /* diagnostics only */ }
      }
      report('reconcile_threw', stats);
      return false;
    }
  }

  function parseReplacementElement(element, html) {
    // Callers must pass single-root markup; only the first element is parsed.
    const documentRef = element?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const template = documentRef?.createElement?.('template');
    if (!template) {
      return null;
    }
    template.innerHTML = String(html || '').trim();
    return template.content?.firstElementChild || null;
  }

  // `options.rowListSegments` / `options.rowListHostId`: as for
  // setOuterHtmlPreservingCodeScroll (the whole-timeline render passes the
  // active turn's segments so its rows keep their reconcile stamps).
  // `options.onOutcome` reports the SAME { outcome, stats } vocabulary
  // setOuterHtmlPreservingCodeScroll returns, so a container morph and an
  // element morph are diagnosable from one shape. The boolean return is
  // deliberately unchanged: every caller uses it as a did-it-take predicate,
  // and a record object would be truthy on failure.
  function setChildrenHtmlPreservingKeyedNodes(target, html, options = {}) {
    const callbacks = options && typeof options === 'object' ? options : {};
    function report(outcome, stats) {
      if (typeof callbacks.onOutcome !== 'function') {
        return;
      }
      try {
        callbacks.onOutcome({ outcome, stats });
      } catch (_callbackError) {
        // Ignore diagnostic callback failures; the DOM write already happened.
      }
    }
    if (!target) {
      report('no_element', undefined);
      return false;
    }
    noteRowSubtreeWrite(target);
    const documentRef = target?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const template = documentRef?.createElement?.('template');
    if (!template) {
      report('parse_failed', undefined);
      return false;
    }
    const stats = callbacks.collectStats ? { reused: 0, cloned: 0, removed: 0 } : undefined;
    try {
      const saved = captureCodeBlockScroll(target);
      const wrapped = captureCodeBlockWrapState(target);
      const expanded = captureCodeBlockExpandState(target);
      template.innerHTML = String(html || '').trim();
      const componentSnapshot = componentRegistry?.capture?.(target) || null;
      const rowListOptions = readRowListOptions(callbacks);
      runWithRowListReconcile(rowListOptions.segments, rowListOptions.hostId, () => {},
        () => morphChildren(target, template.content, stats));
      restoreCodeBlockScroll(target, saved);
      restoreCodeBlockWrapState(target, wrapped);
      restoreCodeBlockExpandState(target, expanded);
      componentRegistry?.restore?.(target, componentSnapshot, {
        onError(error, component) {
          if (typeof callbacks.onError === 'function') {
            callbacks.onError(error, `component:${component}`);
          }
        },
      });
      report('morph_applied', stats);
      return true;
    } catch (error) {
      if (typeof callbacks.onError === 'function') {
        try {
          callbacks.onError(error);
        } catch (_callbackError) {
          // Ignore diagnostic callback failures; the caller still falls back.
        }
      }
      report('morph_threw', stats);
      return false;
    }
  }

  // The stream-reveal structural fallback for a row-model turn: the per-row
  // reconcile when the builder supplied segments, else the whole-list keyed
  // morph. Returns what the caller records: the outcome/stats of the write,
  // the markup used (empty = nothing to apply) and the row counts.
  function applyRowListFallback(rowModelList, options = {}) {
    const segmentsResult = options.segmentsResult;
    const segments = Array.isArray(segmentsResult?.segments) ? segmentsResult.segments : [];
    const rowListMarkup = segmentsResult
      ? String(segmentsResult.html || '').trim()
      : (typeof options.buildMarkup === 'function' ? String(options.buildMarkup() || '').trim() : '');
    let outcome = 'no_row_list_markup';
    let stats;
    const onOutcome = (record) => {
      outcome = String(record?.outcome || 'morph_unavailable');
      stats = record?.stats;
    };
    const reconciled = Boolean(rowListMarkup) && segments.length > 0
      && reconcileKeyedRowList(rowModelList, segments, { onOutcome });
    const morphed = reconciled || (Boolean(rowListMarkup)
      && setChildrenHtmlPreservingKeyedNodes(rowModelList, rowListMarkup, {
        collectStats: options.collectStats === true,
        onOutcome,
      }));
    const rowsReused = reconciled ? Number(stats?.kept) || 0 : 0;
    const rowsRebuilt = reconciled
      ? (Number(stats?.morphed) || 0) + (Number(stats?.added) || 0)
      : (morphed ? Number(rowModelList?.childElementCount) || 0 : 0);
    return { morphed, reconciled, outcome, stats, rowListMarkup, rowsReused, rowsRebuilt };
  }

  function setInnerHtmlPreservingCodeScroll(target, html, options) {
    if (!target) return { outcome: 'no_element', stats: undefined };
    const callbacks = options && typeof options === 'object' ? options : {};
    let outcome;
    let stats;
    const morphed = setChildrenHtmlPreservingKeyedNodes(target, html, {
      collectStats: callbacks.collectStats,
      rowListSegments: callbacks.rowListSegments,
      rowListHostId: callbacks.rowListHostId,
      onError: callbacks.onError,
      onOutcome(record) {
        outcome = record?.outcome;
        stats = record?.stats;
      },
    });
    if (morphed) return { outcome, stats };
    const saved = captureCodeBlockScroll(target);
    const wrapped = captureCodeBlockWrapState(target);
    const expanded = captureCodeBlockExpandState(target);
    target.innerHTML = html;
    restoreCodeBlockScroll(target, saved);
    restoreCodeBlockWrapState(target, wrapped);
    restoreCodeBlockExpandState(target, expanded);
    return { outcome, stats };
  }

  // Reconcile a container of positional stream units (`[data-stream-unit-index]`)
  // against a freshly-rendered body, updating changed units in place and
  // appending new ones — instead of replacing the whole innerHTML each frame.
  // Generic over the unit class so both the answer bubble (`chat-stream-unit`,
  // inert markers) and reasoning (`reasoning-stream-unit`, live soft-landing
  // reveal) can share it. revealCap > 0 animates only the trailing N newly
  // *appended* units; in-place-grown units are never re-revealed (no throb).
  function reconcileStreamUnits(container, nextBody, doc, options = {}) {
    if (!container || !nextBody) return;
    noteRowSubtreeWrite(container);
    const ownerDoc = doc || container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const unitClassName = options.unitClassName || 'chat-stream-unit';
    const revealCap = Number.isFinite(options.revealCap) ? options.revealCap : 0;
    const staggerMs = Number(options.staggerMs) || 0;
    const nextUnits = queryAllSafe(nextBody, '[data-stream-unit-index]');
    // Settled / flat body (no units): bulk replace, no reveal.
    if (!nextUnits.length) {
      if (container.innerHTML !== nextBody.innerHTML) {
        setInnerHtmlPreservingCodeScroll(container, nextBody.innerHTML);
      }
      return;
    }
    const existing = queryAllSafe(container, '[data-stream-unit-index]');
    // Count desync (units removed/re-chunked) or no document: bulk fallback,
    // mirroring patchBubbleUnits' guard.
    if (existing.length > nextUnits.length || !ownerDoc) {
      setInnerHtmlPreservingCodeScroll(container, nextBody.innerHTML);
      return;
    }
    const revealFrom = revealCap ? Math.max(existing.length, nextUnits.length - revealCap) : Infinity;
    for (let i = 0; i < nextUnits.length; i += 1) {
      if (i < existing.length) {
        // Existing unit grew/changed: update text in place. NEVER touch the
        // reveal class here — re-adding it restarts the keyframe and makes the
        // trailing line throb as it streams.
        //
        // Fast path: both sides carry a `data-su-fp` fingerprint (stamped by
        // the reasoning builder), so compare that O(1) attribute instead of
        // serializing/diffing innerHTML for the unchanged prefix. Falls back
        // to today's innerHTML compare when either side lacks the attribute
        // (e.g. the response-bubble path, which never sets it).
        const nextFp = nextUnits[i].getAttribute('data-su-fp');
        const curFp = existing[i].getAttribute('data-su-fp');
        // Delay serialization so unchanged fingerprinted units stay O(1).
        const hasFingerprints = nextFp !== null && curFp !== null;
        const html = hasFingerprints && nextFp === curFp ? null : nextUnits[i].innerHTML;
        const changed = hasFingerprints ? nextFp !== curFp : existing[i].innerHTML !== html;
        if (changed) {
          setInnerHtmlPreservingCodeScroll(existing[i], html);
          if (nextFp !== null) {
            existing[i].setAttribute('data-su-fp', nextFp);
          }
        }
      } else {
        // Newly appended unit: only the trailing <=revealCap animate.
        const html = nextUnits[i].innerHTML;
        const el = ownerDoc.createElement('div');
        el.className = unitClassName;
        el.setAttribute('data-stream-unit-index', String(i));
        el.setAttribute('data-su-fp', nextUnits[i].getAttribute('data-su-fp') || '');
        el.innerHTML = html;
        if (i >= revealFrom) {
          el.classList.add('is-revealed');
          if (staggerMs) {
            el.style.animationDelay = `${(i - revealFrom) * staggerMs}ms`;
          }
        }
        container.appendChild(el);
      }
    }
  }

  // In-place child morph for a small already-parsed subtree (the reasoning
  // header, chat_stream_paint_v2): text nodes and attributes update in place,
  // so child element identity — and any running CSS animation on it — survives
  // a summary-only delta. Returns false when the inputs are unusable or the
  // morph throws, so callers can fall back to the historical innerHTML
  // replacement.
  function morphElementChildren(target, source) {
    if (!target || !source || target.nodeType !== 1 || source.nodeType !== 1) {
      return false;
    }
    noteRowSubtreeWrite(target);
    try {
      const componentSnapshot = componentRegistry?.capture?.(target) || null;
      morphChildren(target, source);
      componentRegistry?.restore?.(target, componentSnapshot);
      return true;
    } catch (_error) {
      return false;
    }
  }

  // The details shape every timeline DOM write reports, owned here because
  // this module owns the { outcome, stats } vocabulary all four render lanes
  // share. Each lane emits it through whichever rollout recorder it already
  // has -- one contract, no new logging seam.
  function describeDomWrite(lane, outcome, stats) {
    return {
      lane: String(lane || 'unknown'),
      outcome: String(outcome || 'unknown'),
      ...(stats ? {
        reused: stats.reused,
        cloned: stats.cloned,
        removed: stats.removed,
        // Per-row reconcile counts (reconcileKeyedRowList); absent on the
        // whole-list morph lanes.
        ...(stats.kept != null ? { kept: stats.kept, morphed: stats.morphed, added: stats.added } : {}),
      } : {}),
    };
  }

  // Returns { outcome, stats } for the render-path telemetry (Track A)
  // diagnostics: `outcome` is one of 'morph_applied' | 'root_key_mismatch' |
  // 'parse_failed' | 'morph_threw'; `stats` is the accumulated
  // { reused, cloned, removed } morph counts, present only when the caller opts
  // in via `options.collectStats` (otherwise undefined). The return value is
  // ignored by the historical callers, and `collectStats` off => no stats
  // allocation and morphChildren skips every counter, so a telemetry-off call
  // does no extra work on the hot path and its DOM behavior is unchanged.
  // `options.rowListSegments` (optional): the row segments of the turn row
  // list inside `element` ({ kind, id, markup }, from the row-list segment
  // sink). The morph then reconciles that list per row (reconcileKeyedRowList,
  // stamps kept) instead of descending into every settled row; the result
  // carries `rowList: { outcome, stats }` when it ran.
  // `options.rowListHostId` (optional): reconcile only the row list inside the
  // article with that data-message-id (an active turn root also holds the
  // user shell's own row list); every other row list morphs as before.
  function setOuterHtmlPreservingCodeScroll(element, html, options) {
    if (!element) return { outcome: 'no_element', stats: undefined };
    noteRowSubtreeWrite(element);
    const collectStats = !!(options && typeof options === 'object' && options.collectStats);
    const rowListOptions = readRowListOptions(options);
    let rowList;
    const parent = element.parentElement || null;
    const saved = captureCodeBlockScroll(element);
    const wrapped = captureCodeBlockWrapState(element);
    const expanded = captureCodeBlockExpandState(element);
    const componentSnapshot = componentRegistry?.capture?.(element) || null;
    const stats = collectStats ? { reused: 0, cloned: 0, removed: 0 } : undefined;
    let outcome;
    const cut = rowListOptions.segments
      ? cutRowListBody(element, String(html || ''), rowListOptions.segments, rowListOptions.hostId)
      : null;
    try {
      const replacementElement = parseReplacementElement(element, cut ? cut.shell : html);
      if (!replacementElement) {
        outcome = 'parse_failed';
      } else if (!canMorphNode(element, replacementElement)) {
        outcome = 'root_key_mismatch';
      } else {
        try {
          let hostReached = false;
          runWithRowListReconcile(rowListOptions.segments, rowListOptions.hostId, (record) => { rowList = record; hostReached = true; },
            () => morphNode(element, replacementElement, stats), cut?.body);
          // The shell carries no rows: a host list the reconcile never reached
          // (a re-created article) is finished from the whole markup.
          if (cut && !hostReached && !morphNode(element, parseReplacementElement(element, html), stats)) {
            throw new Error('row_list_shell_unfinished');
          }
          outcome = 'morph_applied';
        } catch (_morphError) {
          outcome = 'morph_threw';
        }
      }
    } catch (_error) {
      // parseReplacementElement/canMorphNode itself failed — historically
      // swallowed by one catch-all; bucket it with parse_failed so the
      // fallback path below (unchanged) still runs.
      outcome = 'parse_failed';
    }
    if (outcome === 'morph_applied') {
      restoreCodeBlockScroll(element, saved);
      restoreCodeBlockWrapState(element, wrapped);
      restoreCodeBlockExpandState(element, expanded);
      componentRegistry?.restore?.(element, componentSnapshot);
      return rowList ? { outcome, stats, rowList } : { outcome, stats };
    }
    if (!parent) {
      element.outerHTML = html;
      return { outcome, stats };
    }
    const index = Array.prototype.indexOf.call(parent.children, element);
    element.outerHTML = html;
    const replacement = index >= 0 ? parent.children[index] : null;
    if (replacement) {
      restoreCodeBlockScroll(replacement, saved);
      restoreCodeBlockWrapState(replacement, wrapped);
      restoreCodeBlockExpandState(replacement, expanded);
      componentRegistry?.restore?.(replacement, componentSnapshot);
    }
    return { outcome, stats };
  }

  return {
    applyRowListFallback,
    canMorphNode,
    captureCodeBlockExpandState,
    captureCodeBlockScroll,
    describeDomWrite,
    invalidateRowStamp,
    morphChildren(target, source, stats) {
      noteRowSubtreeWrite(target);
      return morphChildren(target, source, stats);
    },
    morphElementChildren,
    noteRowSubtreeWrite,
    collectSelfAndDescendants,
    queryAllSafe,
    reconcileKeyedRowList,
    reconcileStreamUnits,
    restoreCodeBlockExpandState,
    restoreCodeBlockScroll,
    setChildrenHtmlPreservingKeyedNodes,
    setInnerHtmlPreservingCodeScroll,
    setOuterHtmlPreservingCodeScroll,
    syncElementAttributes,
  };
});
