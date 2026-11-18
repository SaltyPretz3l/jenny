/* Team tab: the transcript popover's DOM patcher and focus keeper (row 175, B1-B4). `patchChildren(el, fragment)` makes
 * el's children match the fragment while keeping every node it can: siblings are matched by key (a row id, a pop key,
 * an approval id, a question ref, the prompt article's message id) or else by place and tag; a kept element gets the new
 * attributes in place and its children patched the same way, and an element holding text of its own is synced node by
 * node (the channel's `sync`), so the streaming bubble, a capped reasoning body (and its inner scroll), a picked radio,
 * a half-typed answer and a focused control survive a repaint. A reasoning panel mid auto-collapse keeps the classes,
 * hidden flag and inline height the collapse owns. `captureFocus` / `restoreFocus` hand focus to a replaced element's
 * replacement, else to a fallback, so focus never drops to body. No conversation state lives here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamTurnPopPatch = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEY_ATTRS = ['data-pop-key', 'data-row-id', 'data-approval-id', 'data-question-ref', 'data-pop-action'];
  // What an in-flight collapse (renderer-reasoning-autocollapse-utils.js) owns on its panel.
  const COLLAPSE_OWNED = new Set(['class', 'hidden', 'style', 'data-collapsing']);

  function ownKey(el) {
    for (const name of KEY_ATTRS) {
      const value = el.getAttribute(name);
      if (value) return name + '=' + value;
    }
    return el.tagName === 'ARTICLE' && el.getAttribute('data-message-id') ? 'article=' + el.getAttribute('data-message-id') : '';
  }
  // A question's form wrapper has no key of its own: it takes its card's.
  function keyOf(el) {
    const own = ownKey(el);
    if (own || el.tagName !== 'FORM' || !el.firstElementChild) return own;
    const inner = ownKey(el.firstElementChild);
    return inner ? 'form>' + inner : '';
  }
  // Keys that repeat among siblings match by place instead.
  function keysOf(list) {
    const keys = list.map(keyOf);
    const counts = new Map();
    for (const k of keys) if (k) counts.set(k, (counts.get(k) || 0) + 1);
    return keys.map((k) => (k && counts.get(k) === 1 ? k : ''));
  }
  const holdsText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim());

  function syncAttributes(old, nu) {
    const collapsing = old.getAttribute('data-collapsing') === 'true';
    const owned = (name) => collapsing && COLLAPSE_OWNED.has(name);
    for (const name of old.getAttributeNames()) if (!nu.hasAttribute(name) && !owned(name)) old.removeAttribute(name);
    for (const name of nu.getAttributeNames()) {
      if (!owned(name) && old.getAttribute(name) !== nu.getAttribute(name)) old.setAttribute(name, nu.getAttribute(name));
    }
  }

  function createPatcher() {
    // The markup each kept element was last drawn from: an unchanged element is skipped without reading the live DOM
    // (which carries runtime state such as a collapse in flight or the live box's marker).
    const sigs = new WeakMap();
    const fresh = (nu) => { sigs.set(nu, nu.outerHTML); return nu; };

    function patchNode(old, nu) {
      const html = nu.outerHTML;
      if ((sigs.has(old) ? sigs.get(old) : old.outerHTML) === html) return old;
      syncAttributes(old, nu);
      if (holdsText(old) || holdsText(nu)) syncNodes(old, nu); else patchChildren(old, nu);
      sigs.set(old, html);
      return old;
    }
    // Node by node, text included, by place: a node whose type and name stay is kept.
    function syncNodes(to, from) {
      const want = Array.from(from.childNodes);
      want.forEach((next, i) => {
        const have = to.childNodes[i];
        if (!have) { to.appendChild(next.nodeType === 1 ? fresh(next) : next); return; }
        if (have.nodeType !== next.nodeType || have.nodeName !== next.nodeName) { to.replaceChild(next.nodeType === 1 ? fresh(next) : next, have); return; }
        if (have.nodeType === 1) patchNode(have, next);
        else if (have.nodeValue !== next.nodeValue) have.nodeValue = next.nodeValue;
      });
      while (to.childNodes.length > want.length) to.removeChild(to.lastChild);
    }
    function matchOld(olds, oldKeys, byKey, used, nu, k, index) {
      const old = k ? byKey.get(k) : olds[index];
      if (!old || used.has(old) || old.tagName !== nu.tagName || oldKeys.get(old) !== k) return null;
      return old;
    }
    function patchChildren(parent, source) {
      const olds = Array.from(parent.children);
      const oldKeys = new Map();
      const byKey = new Map();
      keysOf(olds).forEach((k, i) => { oldKeys.set(olds[i], k); if (k) byKey.set(k, olds[i]); });
      const kids = Array.from(source.children);
      const newKeys = keysOf(kids);
      const used = new Set();
      const next = kids.map((nu, index) => {
        const old = matchOld(olds, oldKeys, byKey, used, nu, newKeys[index], index);
        if (!old) return fresh(nu);
        used.add(old);
        return patchNode(old, nu);
      });
      // Leavers go first, so a kept node is never moved past one (a move drops focus and inner scroll).
      for (const el of olds) if (!used.has(el)) el.remove();
      next.forEach((node, index) => { const at = parent.children[index]; if (at !== node) parent.insertBefore(node, at || null); });
    }
    return { patchChildren };
  }

  // ------------------------------------------------------------ focus

  function findBy(container, attr, value, rowId) {
    const scope = rowId ? Array.from(container.querySelectorAll('[data-row-id]')).find((n) => n.getAttribute('data-row-id') === rowId) : container;
    if (!scope) return null;
    return Array.from(scope.querySelectorAll('[' + attr + ']')).find((n) => n.getAttribute(attr) === value) || null;
  }
  // How to find the focused element again: a reasoning toggle by its row (its id carries the message id, which changes
  // at the first save), a tool toggle by its row key, else its id, pop key or action.
  function describe(el) {
    if (el.hasAttribute('data-reasoning-toggle')) {
      const row = el.closest('[data-row-id]');
      return { attr: 'data-phase-key', value: el.getAttribute('data-phase-key') || '', rowId: row ? row.getAttribute('data-row-id') : '' };
    }
    for (const attr of ['data-tool-row-key', 'id', 'data-pop-key', 'data-pop-action', 'data-row-id']) {
      const value = el.getAttribute(attr);
      if (value) return { attr, value, rowId: '' };
    }
    return null;
  }

  /** The focused element inside `container` and how to find it again, or null when focus is elsewhere. */
  function captureFocus(container) {
    const doc = container && container.ownerDocument;
    const el = doc && doc.activeElement;
    if (!el || el === doc.body || !container.contains(el)) return null;
    return { el, key: describe(el) };
  }

  /** Focus back on the captured element, its replacement, or `fallback`; nothing when focus was not inside. */
  function restoreFocus(container, captured, fallback) {
    if (!captured || !container) return;
    const doc = container.ownerDocument;
    let target = captured.el.isConnected && container.contains(captured.el) ? captured.el : null;
    if (!target && captured.key) target = findBy(container, captured.key.attr, captured.key.value, captured.key.rowId);
    const focus = (el) => { if (el && doc.activeElement !== el && typeof el.focus === 'function') el.focus({ preventScroll: true }); };
    focus(target);
    // A replacement that cannot take focus hands it to the fallback.
    if (!target || doc.activeElement !== target) focus(fallback);
  }

  return { createPatcher, captureFocus, restoreFocus, keyOf };
});
