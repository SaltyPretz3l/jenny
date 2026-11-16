/* renderer/chat/renderer-source-card.js
 * Row 154: one delegated controller for the source hover card (inline numbers and list titles rendered by
 * renderer-citation-chips-utils) and the "Also searched" toggle. data-source-* values are untrusted web
 * output: text goes in with textContent and only an http(s) url becomes an href.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSourceCard = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = globalThis.jennyI18n?.t || ((_key, fallback) => fallback);
  const CARD_ID = 'chatSourceCard';
  const TARGET = 'a.source-ref-link[data-source-url], a.source-list-title[data-source-url]';
  const GAP = 8;
  const EDGE = 12;

  function createSourceCardController(deps = {}) {
    const root = deps.root;
    if (!root?.ownerDocument) return { dispose() {} };
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    const writeClipboard = deps.clipboardWriteText
      || ((text) => (win.jennyShell?.clipboard || win.navigator.clipboard).writeText(text));
    const hideDelayMs = deps.hideDelayMs ?? 160;
    const copiedMs = deps.copiedMs ?? 1200;
    const abort = new win.AbortController(); // the document's own realm, so its EventTarget accepts the signal
    const listen = (target, type, handler, capture) => target.addEventListener(type, handler, { capture, signal: abort.signal });
    let card = null;
    let current = null; // { target, lit }
    let hideTimer = 0;
    let copyTimer = 0;
    let touchActive = false;
    let shownAt = 0;
    const copyLabel = () => jt('chat.sources.copyLink', 'Copy link');
    const clearHideTimer = () => win.clearTimeout(hideTimer);

    function ensureCard() {
      if (card) return card;
      card = doc.createElement('div');
      card.className = 'source-card';
      card.id = CARD_ID;
      card.setAttribute('role', 'tooltip');
      card.innerHTML = '<div class="source-card-title"></div><div class="source-card-site"></div>'
        + '<div class="source-card-actions"><a class="source-card-open" target="_blank" rel="noopener noreferrer"></a>'
        + globalThis.inventoryActionButton({ plain: true, className: 'source-card-copy', label: copyLabel() })
        + '</div>';
      card.querySelector('.source-card-open').textContent = jt('chat.sources.openInBrowser', 'Open in browser');
      listen(card, 'pointerover', clearHideTimer);
      listen(card, 'pointerout', onLeave);
      listen(card, 'focusout', onFocusOut);
      listen(card, 'click', onCopy);
      doc.body.appendChild(card);
      return card;
    }

    function position(target) {
      const { width, height } = card.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      const left = Math.max(EDGE, Math.min(rect.left - GAP, win.innerWidth - width - EDGE));
      let top = rect.bottom + GAP;
      if (top + height > win.innerHeight - EDGE) top = Math.max(EDGE, rect.top - GAP - height);
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
    }

    function resetCopyLabel() {
      win.clearTimeout(copyTimer);
      const button = card?.querySelector('.source-card-copy');
      if (button) button.textContent = copyLabel();
    }

    function show(target) {
      const url = target.getAttribute('data-source-url') || '';
      if (!/^https?:\/\//i.test(url)) return;
      clearHideTimer();
      if (current?.target === target) return;
      clear();
      ensureCard();
      const site = target.getAttribute('data-source-site') || '';
      const snippet = target.getAttribute('data-source-snippet') || '';
      card.querySelector('.source-card-title').textContent = target.getAttribute('data-source-title') || site;
      card.querySelector('.source-card-site').textContent = site;
      card.querySelector('.source-card-snippet')?.remove();
      if (snippet) {
        const line = doc.createElement('p');
        line.className = 'source-card-snippet';
        line.textContent = snippet;
        card.insertBefore(line, card.querySelector('.source-card-actions'));
      }
      card.querySelector('.source-card-open').href = url;
      card.dataset.sourceUrl = url;
      resetCopyLabel();
      target.setAttribute('aria-describedby', CARD_ID);
      // The hovered number lights its entry in the same turn's list.
      const ref = target.classList.contains('source-ref-link') ? target.getAttribute('data-source-ref') : '';
      const lit = /^\d{1,3}$/.test(ref || '')
        ? (target.closest('article') || root).querySelector(`.source-list-item[data-source-ref="${ref}"]`) : null;
      lit?.classList.add('is-lit');
      current = { target, lit };
      card.classList.add('is-open');
      shownAt = Date.now();
      position(target);
    }

    function clear() {
      if (!current) return;
      current.target.removeAttribute('aria-describedby');
      current.lit?.classList.remove('is-lit');
      current = null;
      card?.classList.remove('is-open');
    }

    function hide() {
      clearHideTimer();
      clear();
    }

    const insideShown = (node) => Boolean(node && current && (current.target.contains(node) || card?.contains(node)));

    function onLeave(event) {
      if (!current || insideShown(event.relatedTarget)) return;
      clearHideTimer();
      hideTimer = win.setTimeout(hide, hideDelayMs);
    }

    function onOver(event) {
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      const target = event.target.closest(TARGET);
      if (target) show(target);
    }

    function onOut(event) {
      if (current && event.target.closest(TARGET) === current.target) onLeave(event);
    }

    function onFocusIn(event) {
      const target = !touchActive && event.target.closest(TARGET);
      if (target) show(target);
    }

    function onFocusOut(event) {
      if (current && !insideShown(event.relatedTarget)) hide();
    }

    function onKeyDown(event) {
      touchActive = false;
      if (event.key !== 'Escape' || !current) return;
      const target = current.target;
      const focusInCard = card.contains(doc.activeElement);
      hide();
      if (focusInCard) target.focus();
    }

    function onCopy(event) {
      const button = event.target.closest('.source-card-copy');
      const url = card.dataset.sourceUrl;
      if (!button || !url) return;
      Promise.resolve()
        .then(() => writeClipboard(url))
        .then(() => {
          if (abort.signal.aborted) return;
          button.textContent = jt('chat.sources.copied', 'Copied');
          win.clearTimeout(copyTimer);
          copyTimer = win.setTimeout(() => { button.textContent = copyLabel(); }, copiedMs);
        })
        .catch((error) => deps.appendClientLog?.('WARN', 'chat.source_card_copy_failed', { message: String(error?.message || error).slice(0, 200) }));
    }

    // "Also searched N more": flipped in place; the open state lives in the chips module so re-renders keep it.
    function onClick(event) {
      const toggle = event.target.closest('[data-source-list-toggle]');
      if (!toggle) return;
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      deps.chipsUtils?.setSourceListOpen?.(toggle.getAttribute('data-source-list-toggle') || '', open);
      toggle.setAttribute('aria-expanded', String(open));
      const body = toggle.closest('.source-list')?.querySelector('.source-list-also');
      if (body) body.hidden = !open;
    }

    listen(root, 'pointerover', onOver);
    listen(root, 'pointerout', onOut);
    listen(root, 'pointerdown', (event) => { touchActive = event.pointerType === 'touch'; }, true);
    listen(root, 'focusin', onFocusIn);
    listen(root, 'focusout', onFocusOut);
    listen(root, 'click', onClick);
    listen(root, 'scroll', () => { if (Date.now() - shownAt > 150) hide(); }, true);
    listen(doc, 'keydown', onKeyDown);

    return {
      dispose() {
        if (abort.signal.aborted) return;
        abort.abort();
        win.clearTimeout(copyTimer);
        hide();
        card?.remove();
        card = null;
      },
    };
  }

  return { createSourceCardController };
});
