/* renderer/features/board/board-keyboard.js - the keyboard map of the board canvas (UMD).
 *
 * `attach(element)` puts ONE keydown listener on the canvas element; `dispose()` takes it and its live region
 * away. The canvas installs no key handler of its own (except inside its inline editor), so every key lives here:
 *
 *   Tab / Shift+Tab   the next / previous card in reading order (top to bottom, then left to right); past the last
 *                     card Tab leaves the canvas
 *   arrows            the nearest card in that direction (centre to centre, a 90 degree cone)
 *   Enter             edit the one selected item        Alt+arrows  nudge by 8 (Shift: 1)
 *   Ctrl+A / Z / Y / G / D / F, Ctrl+Shift+Z / G, Delete, Backspace, + - 0 1, Escape
 *   L                 with one card selected: connect mode. Arrows and Tab choose the target, Enter connects,
 *                     Escape leaves; a live region says what is going on.
 *
 * On macOS the same keys with Cmd in place of Ctrl. A key aimed at an input, textarea, select or editable text
 * is left alone, and so is Enter or Space on a button outside a card. A handled key calls preventDefault; an
 * unhandled one does not. Commands go to the board editor, canvas actions to `view` (focusItem, startEdit,
 * zoomBy, fit, actualSize). Nothing runs before attach(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardKeyboard = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const defaultJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const ZOOM_STEP = 1.2;
  const NUDGE = 8;
  const ARROW = Object.freeze({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] });

  function isMacPlatform() {
    const nav = globalThis.navigator;
    return Boolean(nav) && /Mac|iPhone|iPad/i.test(String(nav.platform || nav.userAgent || ''));
  }

  function leftAlone(target) {
    if (!target || !target.closest) return false;
    if (target.closest('input, textarea, select')) return true;
    const editable = target.closest('[contenteditable]');
    return Boolean(editable) && editable.getAttribute('contenteditable') !== 'false';
  }

  function readingOrder(a, b) {
    return a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  function centre(card) { return { x: card.x + card.w / 2, y: card.y + card.h / 2 }; }

  /** The nearest card whose centre lies within the 90 degree cone of `dir` from `from`; null when none. */
  function nearestInDirection(from, cards, dir) {
    const origin = centre(from);
    let best = null;
    let bestDistance = Infinity;
    cards.forEach((card) => {
      if (card.id === from.id) return;
      const c = centre(card);
      const dx = c.x - origin.x;
      const dy = c.y - origin.y;
      const along = dx * dir[0] + dy * dir[1];
      const across = Math.abs(dx * dir[1] - dy * dir[0]);
      if (along <= 0 || across > along) return;
      const distance = Math.hypot(dx, dy);
      if (distance < bestDistance || (distance === bestDistance && best && readingOrder(card, best) < 0)) { best = card; bestDistance = distance; }
    });
    return best;
  }

  function createBoardKeyboard(deps) {
    const jt = deps.jt || defaultJt;
    const editor = deps.editor;
    const view = deps.view || {};
    const openFind = typeof deps.openFind === 'function' ? deps.openFind : () => {};
    const mac = typeof deps.platform === 'string' ? /Mac|iPhone|iPad/i.test(deps.platform) : isMacPlatform();

    let element = null;
    let live = null;
    let lastFocused = '';
    let connect = null; // { from, target } while connect mode is on

    function cards() {
      const board = editor.getBoard();
      return board ? Object.values(board.cards || {}).sort(readingOrder) : [];
    }

    function nameOf(id) {
      const board = editor.getBoard();
      const card = board && board.cards ? board.cards[id] : null;
      return card ? (card.alias || card.kind) : '';
    }

    function say(text) { if (live) live.textContent = text; }

    function focusCard(id, select) {
      lastFocused = id;
      if (select) editor.select([id]);
      view.focusItem(id);
    }

    function currentId(event) {
      const holder = event.target && event.target.closest ? event.target.closest('[data-card-id]') : null;
      const fromTarget = holder ? holder.getAttribute('data-card-id') : '';
      if (fromTarget) return fromTarget;
      if (connect) return connect.target || connect.from;
      if (lastFocused) return lastFocused;
      const picked = editor.getSelection();
      return picked.length === 1 ? picked[0] : '';
    }

    function leaveConnect(message) {
      const from = connect && connect.from;
      connect = null;
      say(message || '');
      if (from) { lastFocused = from; view.focusItem(from); }
    }

    function startConnect() {
      const picked = editor.getSelection();
      const board = editor.getBoard();
      if (picked.length !== 1 || !board || !board.cards || !board.cards[picked[0]]) return false;
      connect = { from: picked[0], target: '' };
      say(jt('board.keyboard.connecting', 'Connecting from {name}. Choose a card and press Enter.', { name: nameOf(picked[0]) }));
      return true;
    }

    function confirmConnect() {
      if (!connect.target) return;
      const { from, target } = connect;
      const names = { from: nameOf(from), to: nameOf(target) };
      leaveConnect('');
      Promise.resolve(editor.connect(from, target)).then((result) => {
        if (!live) return;
        say(result && result.ok ? jt('board.keyboard.connected', 'Connected {from} to {to}.', names) : jt('board.keyboard.notConnected', 'Those cards could not be connected.'));
      }, () => {});
    }

    function move(event, step) {
      const list = cards();
      if (!list.length) return false;
      const here = list.find((card) => card.id === currentId(event));
      if (connect) {
        const pool = list.filter((card) => card.id !== connect.from);
        if (!pool.length) return false;
        const from = list.find((card) => card.id === (connect.target || connect.from));
        if (!from || !list.some((card) => card.id === connect.from)) { leaveConnect(jt('board.keyboard.connectCancelled', 'Connecting cancelled.')); return true; }
        const at = pool.findIndex((card) => card.id === connect.target);
        const next = step.dir
          ? nearestInDirection(from, pool, step.dir)
          : pool[at < 0 ? (step.order > 0 ? 0 : pool.length - 1) : (at + step.order + pool.length) % pool.length];
        if (!next) return Boolean(step.dir);
        connect.target = next.id;
        say(jt('board.keyboard.connectTarget', 'Connect {from} to {to}? Press Enter.', { from: nameOf(connect.from), to: nameOf(next.id) }));
        lastFocused = next.id;
        view.focusItem(next.id);
        return true;
      }
      if (step.dir) {
        const next = here ? nearestInDirection(here, list, step.dir) : list[0];
        if (!next) return true;
        focusCard(next.id, true);
        return true;
      }
      const index = here ? list.indexOf(here) : -1;
      const nextIndex = here ? index + step.order : (step.order > 0 ? 0 : list.length - 1);
      if (nextIndex < 0 || nextIndex >= list.length) return false; // past the ends Tab leaves the canvas
      focusCard(list[nextIndex].id, true);
      return true;
    }

    function run(promise) { void Promise.resolve(promise); return true; }

    function handle(event) {
      const key = event.key;
      const mod = mac ? event.metaKey : event.ctrlKey;
      const other = mac ? event.ctrlKey : event.metaKey;
      if (other) return false;
      const letter = typeof key === 'string' && key.length === 1 ? key.toLowerCase() : '';
      if (mod && !event.altKey) {
        switch (letter) {
          case 'a': return run(editor.selectAll());
          case 'z': return run(event.shiftKey ? editor.redo() : editor.undo());
          case 'y': return run(editor.redo());
          case 'g': return run(event.shiftKey ? editor.ungroupSelected() : editor.groupSelected());
          case 'd': return run(editor.duplicateSelected());
          case 'f': openFind(); return true;
          default: return false;
        }
      }
      if (mod) return false;
      if (event.altKey) {
        const dir = ARROW[key];
        if (!dir || event.ctrlKey) return false;
        const amount = event.shiftKey ? 1 : NUDGE;
        return run(editor.nudgeSelected(dir[0] * amount, dir[1] * amount));
      }
      if (ARROW[key] && !event.shiftKey) return move(event, { dir: ARROW[key] });
      switch (key) {
        case 'Tab': return event.shiftKey ? move(event, { order: -1 }) : move(event, { order: 1 });
        case 'Enter': {
          if (connect) { if (connect.target) confirmConnect(); return true; }
          const picked = editor.getSelection();
          if (picked.length !== 1) return false;
          view.startEdit(picked[0]);
          return true;
        }
        case 'Delete':
        case 'Backspace': return run(editor.removeSelected());
        case 'Escape':
          if (connect) { leaveConnect(jt('board.keyboard.connectCancelled', 'Connecting cancelled.')); return true; }
          editor.clearSelection();
          if (typeof editor.selectConnector === 'function' && editor.getSelectedConnector && editor.getSelectedConnector()) editor.selectConnector('');
          return true;
        case '+':
        case '=': view.zoomBy(ZOOM_STEP); return true;
        case '-': view.zoomBy(1 / ZOOM_STEP); return true;
        case '0': view.actualSize(); return true;
        case '1': view.fit(); return true;
        default:
      }
      if (letter === 'l' && !event.shiftKey) return startConnect();
      return false;
    }

    function onKeyDown(event) {
      if (event.defaultPrevented || event.isComposing || leftAlone(event.target)) return;
      const target = event.target;
      const onButton = Boolean(target && target.closest && target.closest('button, a[href]'));
      if (onButton && (event.key === 'Enter' || event.key === ' ')) return;
      // A button outside a card (the zoom bar) keeps Tab and the arrows for itself.
      if (onButton && !target.closest('[data-card-id]') && (event.key === 'Tab' || ARROW[event.key])) return;
      if (handle(event)) event.preventDefault();
    }

    return {
      attach(next) {
        if (element || !next) return;
        element = next;
        live = element.ownerDocument.createElement('div');
        live.className = 'sr-only';
        live.setAttribute('role', 'status');
        live.setAttribute('aria-live', 'polite');
        live.setAttribute('data-board-live', '');
        element.appendChild(live);
        element.addEventListener('keydown', onKeyDown);
      },
      dispose() {
        if (!element) return;
        element.removeEventListener('keydown', onKeyDown);
        if (live) live.remove();
        element = null;
        live = null;
        connect = null;
        lastFocused = '';
      },
    };
  }

  return { createBoardKeyboard, nearestInDirection };
});
