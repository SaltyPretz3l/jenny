'use strict';

/* global document, window, MutationObserver, requestAnimationFrame */

/**
 * Page-side action ops for the browser-use reader: probe, verify, typing focus, select, scroll,
 * status and the secret mask. Serialised with String(fn) and run in the page's isolated world
 * after installReaderCore; it may only touch page globals and S.
 */
function installReaderActions(S) {
  const SCROLL_FRACTION = 0.85;
  const MASK_ATTR = 'data-jenny-reader-secret';
  const MASK_STYLE_ID = 'jenny-reader-secret-style';
  const MASK_CSS = `[${MASK_ATTR}]{-webkit-text-security:disc !important;color:transparent !important;`
    + 'text-shadow:none !important;caret-color:transparent !important;}';
  const PAINT_CAP_MS = 120;
  const PAINT_CAP_LIMIT_MS = 1000;
  const MARK_MS = 600;
  const MARK_STYLE = 'all:initial;position:fixed;box-sizing:border-box;pointer-events:none;z-index:2147483647;'
    + 'outline:2px solid #4fc3d9;outline-offset:2px;border-radius:4px;box-shadow:0 0 0 5px rgba(79,195,217,0.25);';

  function drainMutations() {
    // Records not yet delivered to the observer callback (for example a type flip made just before this call).
    if (S.observer) S.noteMutations(S.observer.takeRecords());
  }

  function noteMutations(records) {
    if (!records.length) return;
    S.lastMutation = Date.now();
    for (const record of records) {
      if (record.type !== 'attributes' || record.attributeName !== 'type') continue;
      const target = record.target;
      const before = String(record.oldValue || '').trim().toLowerCase();
      const now = String(target.getAttribute('type') || '').trim().toLowerCase();
      if (before === 'password' || now === 'password') S.passwordSeen.add(target);
    }
  }

  // The ring is Jenny's own drawing, so it must not read as the page still changing.
  function outOfSettle(change) {
    S.drainMutations();
    change();
    if (S.observer) S.observer.takeRecords();
  }
  function clearMark() {
    clearTimeout(S.markTimer);
    const host = S.markHost;
    S.markHost = null;
    if (host) outOfSettle(() => host.remove());
  }
  // Best effort and purely visual: it must never get in the way of the action it marks.
  function placeMark(el) {
    try {
      clearMark();
      if (!S.layoutOf(el.ownerDocument)) return;
      const r = S.topRect(el);
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = MARK_STYLE;
      Object.assign(host.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      outOfSettle(() => document.documentElement.appendChild(host));
      S.markHost = host;
      S.markTimer = setTimeout(clearMark, MARK_MS);
    } catch (error) {
      S.markHost = null;
    }
  }

  function start() {
    S.lastMutation = Date.now();
    const known = document.querySelectorAll('input[type="password" i]');
    for (let i = 0; i < known.length; i += 1) S.passwordSeen.add(known[i]);
    if (typeof MutationObserver !== 'function') return;
    S.observer = new MutationObserver((records) => S.noteMutations(records));
    S.observer.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
  }

  function viewport(view) {
    return { w: view.innerWidth || 0, h: view.innerHeight || 0 };
  }
  function outsideViewport(el) {
    if (!S.layoutOf(el.ownerDocument)) return false;
    const r = S.topRect(el);
    const v = viewport(window);
    return r.bottom <= 0 || r.top >= v.h || (v.w > 0 && (r.right <= 0 || r.left >= v.w));
  }
  function bringIntoView(el) {
    if (!outsideViewport(el)) return;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    } catch (error) {
      // no layout engine
    }
  }

  function staleOf(a) {
    return { status: 'stale', ref: a.ref };
  }
  function probe(a) {
    const el = S.resolve(a.ref);
    if (!el) return staleOf(a);
    if (!S.isVisible(el)) return { status: 'not_visible', ref: a.ref };
    return S.facts(el, a.ref);
  }
  function frameActive(frame) {
    try {
      return frame.contentDocument ? frame.contentDocument.activeElement : null;
    } catch (error) {
      return null;
    }
  }
  function activeElementDeep() {
    let el = document.activeElement;
    for (let depth = 0; el && depth < 6; depth += 1) {
      if (el.shadowRoot && el.shadowRoot.activeElement) {
        el = el.shadowRoot.activeElement;
      } else if (el.localName === 'iframe' || el.localName === 'frame') {
        const inner = frameActive(el);
        if (!inner || inner.localName === 'body') return el;
        el = inner;
      } else {
        break;
      }
    }
    return el;
  }
  function probeFocused() {
    const el = activeElementDeep();
    if (!el || el === document.body || el === document.documentElement || el.localName === 'body') return { status: 'none' };
    return S.facts(el, S.assign(el));
  }

  function composedContains(outer, inner) {
    for (let node = inner, depth = 0; node && depth < 200; node = S.parentOf(node), depth += 1) {
      if (node === outer) return true;
    }
    return false;
  }
  function isRelatedHit(el, hit) {
    if (composedContains(el, hit) || composedContains(hit, el)) return true;
    if (el.labels && Array.from(el.labels).some((label) => composedContains(label, hit))) return true;
    const label = hit.closest ? hit.closest('label') : null;
    return Boolean(label && label.control === el);
  }
  function hitTest(el) {
    const doc = el.ownerDocument;
    const view = doc.defaultView || window;
    const root = el.getRootNode && el.getRootNode();
    const source = root && typeof root.elementFromPoint === 'function' ? root : doc;
    if (typeof source.elementFromPoint !== 'function' || !S.layoutOf(doc)) return null;
    const r = el.getBoundingClientRect();
    const c = S.visibleCenter({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, view);
    const hit = source.elementFromPoint(c.x, c.y);
    return hit && !isRelatedHit(el, hit) ? hit : null;
  }

  // Shared prologue of the ops that act on a remembered element: resolve, then compare fingerprints.
  function checkTarget(a) {
    const el = S.resolve(a.ref);
    if (!el) return { status: 'stale' };
    if (typeof a.fingerprint === 'string' && S.fingerprint(el) !== a.fingerprint) return { status: 'changed' };
    return { el };
  }
  // Chromium can drop a native press without an error, so the target's own window says whether it came.
  // A disabled control is sent no events at all, and that is not the press going missing.
  function watchPress(el) {
    const view = el.ownerDocument.defaultView || window;
    S.pressArrived = S.isDisabled(el);
    S.pressWatched = S.pressWatched || new WeakSet();
    if (S.pressWatched.has(view)) return;
    S.pressWatched.add(view);
    const note = (event) => { if (event.isTrusted) S.pressArrived = true; };
    view.addEventListener('pointerdown', note, true);
    view.addEventListener('mousedown', note, true);
  }
  // A new document has no record, and getting one means the press did its work.
  function pressSeen() {
    return { status: 'ok', seen: S.pressArrived !== false };
  }
  function verify(a) {
    const checked = checkTarget(a);
    if (!checked.el) return Object.assign(checked, { ref: a.ref });
    const el = checked.el;
    if (!S.isVisible(el)) return { status: 'changed', ref: a.ref };
    bringIntoView(el);
    const by = hitTest(el);
    if (by) return { status: 'obscured', ref: a.ref, by: S.describe(by) };
    if (a.watchPress === true) watchPress(el);
    placeMark(el);
    return { status: 'ready', rect: S.rectFacts(el) };
  }

  function selectContents(el) {
    if (typeof el.select === 'function') {
      el.select();
      return;
    }
    const view = el.ownerDocument.defaultView || window;
    const selection = view.getSelection && view.getSelection();
    if (!selection) return;
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function focusForTyping(a) {
    const checked = checkTarget(a);
    if (!checked.el) return checked;
    const el = checked.el;
    if (!S.isTextEntry(el)) return { status: 'not_editable' };
    bringIntoView(el);
    try {
      el.focus();
      if (a.clear === true) selectContents(el);
    } catch (error) {
      return { status: 'not_editable' };
    }
    // A focus handler can pass the focus on, and the text goes wherever it ends up.
    if (activeElementDeep() !== el) return { status: 'changed' };
    placeMark(el);
    return { status: 'ready' };
  }
  function focusIs(a) {
    const checked = checkTarget(a);
    if (!checked.el) return checked;
    return { status: activeElementDeep() === checked.el ? 'ready' : 'changed' };
  }

  function fire(el, type) {
    const view = el.ownerDocument.defaultView || window;
    el.dispatchEvent(new view.Event(type, { bubbles: true, composed: true }));
  }
  function optionLabelOf(opt) {
    return S.collapse(opt.label || opt.textContent);
  }
  function selectOption(el, wanted, secret) {
    const options = Array.from(el.options || []);
    const labels = options.map(optionLabelOf);
    const index = wanted === '' ? -1 : options.findIndex((opt, i) => !opt.disabled && (opt.value === wanted || labels[i] === wanted));
    if (index < 0) return { status: 'no_such_option', options: secret ? [] : labels.slice(0, 20) };
    el.selectedIndex = index;
    fire(el, 'input');
    fire(el, 'change');
    return { status: 'selected', value: secret ? '' : options[index].value };
  }
  function select(a) {
    const checked = checkTarget(a);
    if (!checked.el) return checked;
    const answer = applySelection(checked.el, a);
    if (answer.status === 'selected') placeMark(checked.el);
    return answer;
  }
  function applySelection(el, a) {
    const wanted = a.value === undefined || a.value === null ? '' : String(a.value);
    if (S.isDisabled(el)) return { status: 'not_selectable' };
    if (el.localName === 'select') return selectOption(el, wanted, S.isSecret(el));
    const type = S.inputType(el);
    if (type !== 'checkbox' && type !== 'radio') return { status: 'not_selectable' };
    if (wanted !== 'true' && wanted !== 'false') return { status: 'no_such_option', options: ['true', 'false'] };
    const want = wanted === 'true';
    if (type === 'radio' && !want) return { status: 'not_selectable' };
    if (el.checked !== want) el.click();
    return { status: 'selected', value: el.checked ? 'true' : 'false' };
  }

  function scrollerOf(el) {
    for (let node = el; node && node.nodeType === 1; node = S.parentOf(node)) {
      const cs = S.styleOf(node);
      if (cs && /auto|scroll|overlay/.test(`${cs.overflow || ''} ${cs.overflowY || ''}`) && node.scrollHeight > node.clientHeight + 1) return node;
    }
    return null;
  }
  // Instant, because a page's smooth scrolling would leave the old position in place when read back.
  function moveScroller(scroller, top) {
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior: 'instant' });
    else scroller.scrollTop = top;
  }
  function scroll(a) {
    const direction = a.direction === 'up' ? -1 : 1;
    let el = null;
    if (a.ref !== undefined && a.ref !== null && a.ref !== '') {
      el = S.resolve(a.ref);
      if (!el) return staleOf(a);
    }
    const scroller = el ? scrollerOf(el) : null;
    if (scroller) {
      const before = scroller.scrollTop;
      moveScroller(scroller, before + direction * Math.round(scroller.clientHeight * SCROLL_FRACTION));
      const after = scroller.scrollTop;
      const atEnd = direction > 0 ? after + scroller.clientHeight >= scroller.scrollHeight - 1 : after <= 0;
      return { status: 'scrolled', moved: Math.abs(Math.round(after - before)), atEnd };
    }
    const view = el ? el.ownerDocument.defaultView || window : window;
    const doc = view.document;
    const before = view.scrollY || 0;
    view.scrollBy({ top: direction * Math.round((view.innerHeight || 0) * SCROLL_FRACTION), behavior: 'instant' });
    const after = view.scrollY || 0;
    const total = Math.max(doc.documentElement.scrollHeight || 0, (doc.body && doc.body.scrollHeight) || 0);
    const atEnd = direction > 0 ? after + (view.innerHeight || 0) >= total - 1 : after <= 0;
    return { status: 'scrolled', moved: Math.abs(Math.round(after - before)), atEnd };
  }

  function status() {
    return { status: 'ok', readyState: document.readyState, msSinceMutation: Date.now() - S.lastMutation, url: S.clean(window.location.href) };
  }

  // Whether the page is still producing frames, from a world its scripts cannot fake. Two frames,
  // so a change made before this call is on screen by the time it answers yes.
  function paints(a) {
    return new Promise((resolve) => {
      const answer = (value) => resolve({ status: 'ok', paints: value });
      if (typeof requestAnimationFrame !== 'function') {
        answer(false);
        return;
      }
      const timer = setTimeout(() => answer(false), Math.min(Number(a.capMs) || PAINT_CAP_MS, PAINT_CAP_LIMIT_MS));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timer);
        answer(true);
      }));
    });
  }

  function secretMask(a) {
    let count = 0;
    if (a.on === true) clearMark();
    for (const doc of S.allDocs()) {
      const old = doc.getElementById(MASK_STYLE_ID);
      if (old) old.remove();
      for (const el of Array.from(doc.querySelectorAll(`[${MASK_ATTR}]`))) el.removeAttribute(MASK_ATTR);
      if (a.on !== true) continue;
      for (const el of Array.from(doc.querySelectorAll('input,textarea,select,[contenteditable]'))) {
        if (!S.isSecret(el)) continue;
        el.setAttribute(MASK_ATTR, '1');
        count += 1;
      }
      const style = doc.createElement('style');
      style.id = MASK_STYLE_ID;
      style.textContent = MASK_CSS;
      (doc.head || doc.documentElement).appendChild(style);
    }
    return { status: 'ok', count };
  }

  Object.assign(S, { start, noteMutations, drainMutations });
  Object.assign(S.ops, { probe, probeFocused, verify, pressSeen, focusForTyping, focusIs, select, scroll, status, paints, secretMask });
}

module.exports = { installReaderActions };
