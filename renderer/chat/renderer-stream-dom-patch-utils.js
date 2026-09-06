(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-component-preservation-registry'));
    return;
  }
  root.rendererStreamDomPatchUtils = factory(root.rendererComponentPreservationRegistry);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (preservationModule) {
  'use strict';

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
      overlay?.setAttribute('aria-label', 'Show less code');
      const label = overlay?.querySelector?.('span');
      if (label) label.textContent = 'Show less';
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
  // the chat_timeline_render_telemetry diagnostics (Track A). Absent/undefined
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
    syncElementAttributes(target, source);
    morphChildren(target, source, stats);
    return true;
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
      morphChildren(target, template.content, stats);
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

  function setInnerHtmlPreservingCodeScroll(target, html, options) {
    if (!target) return { outcome: 'no_element', stats: undefined };
    const callbacks = options && typeof options === 'object' ? options : {};
    let outcome;
    let stats;
    const morphed = setChildrenHtmlPreservingKeyedNodes(target, html, {
      collectStats: callbacks.collectStats,
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
      } : {}),
    };
  }

  // Returns { outcome, stats } for chat_timeline_render_telemetry (Track A)
  // diagnostics: `outcome` is one of 'morph_applied' | 'root_key_mismatch' |
  // 'parse_failed' | 'morph_threw'; `stats` is the accumulated
  // { reused, cloned, removed } morph counts, present only when the caller opts
  // in via `options.collectStats` (otherwise undefined). The return value is
  // ignored by the historical callers, and `collectStats` off => no stats
  // allocation and morphChildren skips every counter, so a telemetry-off call
  // does no extra work on the hot path and its DOM behavior is unchanged.
  function setOuterHtmlPreservingCodeScroll(element, html, options) {
    if (!element) return { outcome: 'no_element', stats: undefined };
    const collectStats = !!(options && typeof options === 'object' && options.collectStats);
    const parent = element.parentElement || null;
    const saved = captureCodeBlockScroll(element);
    const wrapped = captureCodeBlockWrapState(element);
    const expanded = captureCodeBlockExpandState(element);
    const componentSnapshot = componentRegistry?.capture?.(element) || null;
    const stats = collectStats ? { reused: 0, cloned: 0, removed: 0 } : undefined;
    let outcome;
    try {
      const replacementElement = parseReplacementElement(element, html);
      if (!replacementElement) {
        outcome = 'parse_failed';
      } else if (!canMorphNode(element, replacementElement)) {
        outcome = 'root_key_mismatch';
      } else {
        try {
          morphNode(element, replacementElement, stats);
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
      return { outcome, stats };
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
    canMorphNode,
    captureCodeBlockExpandState,
    captureCodeBlockScroll,
    describeDomWrite,
    morphChildren,
    morphElementChildren,
    collectSelfAndDescendants,
    queryAllSafe,
    reconcileStreamUnits,
    restoreCodeBlockExpandState,
    restoreCodeBlockScroll,
    setChildrenHtmlPreservingKeyedNodes,
    setInnerHtmlPreservingCodeScroll,
    setOuterHtmlPreservingCodeScroll,
    syncElementAttributes,
  };
});
