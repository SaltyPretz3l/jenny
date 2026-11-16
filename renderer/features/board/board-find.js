/* renderer/features/board/board-find.js - find on a board (UMD), and the text a card is known by.
 *
 * `findCards(board, query)` is pure: the ids of the cards (and groups, by title) whose text holds the query,
 * case-insensitive, the query trimmed, in reading order. A card's text is the text the outline shows for it
 * (`cardParts`), and a note is searched by its whole text, not only its first line. `createBoardFind` is the
 * small box over the canvas or the outline: a text field, a count ("3 of 12 cards") and a close button. It
 * reports `onMatches(ids)` as the query changes and `onMatches(null)` when the box is empty or closed; Enter
 * walks the matches by calling `onMatches(ids, currentId)` again.
 *
 * The text helpers are shared with the outline view, which loads after this file. Nothing here runs before
 * `createBoardFind` is called; `dispose()` removes the box and its listeners. Board text reaches the DOM
 * only through textContent and the inventory primitives. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardFind = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const defaultJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const SVG_CLOSE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  function primitive(name, path) {
    if (globalThis[name]) return globalThis[name];
    if (typeof require === 'function') {
      try { return require(path); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }

  function baseName(path) {
    const parts = String(path || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function hostOf(url) {
    try { return new URL(String(url)).host; } catch (_error) { return ''; }
  }

  function firstLine(text) {
    const line = String(text || '').split(/\r\n|\r|\n/).map((part) => part.trim()).find(Boolean);
    return line || '';
  }

  /** The words a card is known by: [main, extra]; either may be empty. A note's main part is its first line. */
  function cardParts(card) {
    const data = (card && card.data) || {};
    switch (card && card.kind) {
      case 'note': return [firstLine(data.text), ''];
      case 'file': return [String(data.title || baseName(data.path)), data.path && data.path !== (data.title || baseName(data.path)) ? String(data.path) : ''];
      case 'link': {
        const host = hostOf(data.url);
        return [String(data.title || host || data.url || ''), data.title ? host : ''];
      }
      case 'image': return [String(data.alt || ''), ''];
      default: return [String(data.title || ''), '']; // chat and diagram
    }
  }

  function cardText(card) {
    return cardParts(card).filter(Boolean).join(' · ');
  }

  function aliasNumber(item) {
    const n = item && item.alias ? Number(String(item.alias).slice(1)) : Infinity;
    return Number.isFinite(n) ? n : Infinity;
  }

  /** Reading order: top to bottom, then left to right, then by alias and id so the order never wobbles. */
  function readingCompare(a, b) {
    return a.y - b.y || a.x - b.x || (aliasNumber(a) === aliasNumber(b) ? 0 : aliasNumber(a) < aliasNumber(b) ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  function findCards(board, query) {
    const needle = String(query === null || query === undefined ? '' : query).trim().toLowerCase();
    if (!board || !needle) return [];
    const hits = [];
    Object.values(board.cards || {}).forEach((card) => {
      const note = card.kind === 'note' ? String((card.data || {}).text || '') : '';
      if (`${cardText(card)}\n${note}`.toLowerCase().includes(needle)) hits.push(card);
    });
    Object.values(board.groups || {}).forEach((group) => {
      if (String(group.title || '').toLowerCase().includes(needle)) hits.push(group);
    });
    return hits.sort(readingCompare).map((item) => item.id);
  }

  function createBoardFind(deps) {
    const jt = deps.jt || defaultJt;
    const doc = deps.document;
    const actionButton = deps.actionButton || primitive('inventoryActionButton', '../../inventory/action-button');
    const textField = deps.textField || primitive('inventoryTextField', '../../inventory/text-field');
    const onMatches = typeof deps.onMatches === 'function' ? deps.onMatches : () => {};
    const getBoard = typeof deps.getBoard === 'function' ? deps.getBoard : () => null;

    const element = doc.createElement('div');
    element.className = 'board-find';
    element.setAttribute('role', 'search');
    element.setAttribute('aria-label', jt('board.find.label', 'Find on the board'));
    element.setAttribute('data-board-find', '');
    element.hidden = true;
    element.insertAdjacentHTML('beforeend', textField({
      ariaLabel: jt('board.find.field', 'Find cards'), placeholder: jt('board.find.placeholder', 'Find cards'), className: 'board-find__field', dataset: { 'board-find-input': '' },
    }));
    const count = doc.createElement('output');
    count.className = 'board-find__count';
    count.setAttribute('aria-live', 'polite');
    count.setAttribute('data-board-find-count', '');
    element.appendChild(count);
    element.insertAdjacentHTML('beforeend', actionButton({
      variant: 'ghost', size: 'sm', className: 'board-find__close', ariaLabel: jt('board.find.close', 'Close find'), title: jt('board.find.closeTitle', 'Close find (Escape)'),
      trustedHtml: SVG_CLOSE, dataset: { 'board-find-close': '' },
    }));
    const input = element.querySelector('[data-board-find-input]');

    let ids = [];
    let cursor = -1;
    let opener = null;
    let disposed = false;

    function total() {
      const board = getBoard();
      return board ? Object.keys(board.cards || {}).length : 0;
    }

    function showCount(query) {
      if (!query) { count.textContent = ''; return; }
      const all = total();
      if (!ids.length) { count.textContent = jt('board.find.none', 'No cards match'); return; }
      count.textContent = all === 1
        ? jt('board.find.countOne', '{matches} of 1 card', { matches: ids.length })
        : jt('board.find.count', '{matches} of {total} cards', { matches: ids.length, total: all });
    }

    function update() {
      const query = input.value.trim();
      cursor = -1;
      ids = query ? findCards(getBoard(), query) : [];
      showCount(query);
      onMatches(query ? ids.slice() : null);
    }

    function step(direction) {
      if (!ids.length) return;
      cursor = cursor < 0 ? (direction > 0 ? 0 : ids.length - 1) : (cursor + direction + ids.length) % ids.length;
      onMatches(ids.slice(), ids[cursor]);
    }

    function open() {
      if (disposed) return;
      if (element.hidden) opener = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
      element.hidden = false;
      input.focus({ preventScroll: true });
      if (typeof input.select === 'function') input.select();
      if (input.value.trim()) update();
    }

    function close() {
      if (disposed || element.hidden) return;
      element.hidden = true;
      input.value = '';
      ids = [];
      cursor = -1;
      showCount('');
      onMatches(null);
      const back = opener;
      opener = null;
      if (back && back.isConnected !== false && typeof back.focus === 'function') back.focus({ preventScroll: true });
    }

    function onKeyDown(event) {
      if (event.target !== input || event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
    }
    function onClick(event) {
      if (event.target && event.target.closest && event.target.closest('[data-board-find-close]')) close();
    }
    element.addEventListener('input', update);
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('click', onClick);

    return {
      element,
      open,
      close,
      isOpen: () => !element.hidden,
      dispose() {
        if (disposed) return;
        disposed = true;
        element.removeEventListener('input', update);
        element.removeEventListener('keydown', onKeyDown);
        element.removeEventListener('click', onClick);
        element.remove();
      },
    };
  }

  return { findCards, createBoardFind, cardParts, cardText, readingCompare };
});
