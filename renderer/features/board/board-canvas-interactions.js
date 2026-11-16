/* renderer/features/board/board-canvas-interactions.js - the pointer work on the board canvas (UMD).
 *
 * Select (click, Shift+click, marquee, a click on a connector), move (one batch on pointer-up, the DOM following the
 * pointer meanwhile), resize (the card's grip), connect (drag from a port to another card, with a preview line) and
 * double-click (add a note on empty canvas, edit a note, a link or a group title). Every change goes through the
 * editor; this module only reads the pointer and moves elements. Escape during a gesture puts everything back and
 * sends nothing. The only key handler here is that Escape, on the document, for the life of the gesture.
 *
 * It listens on the surface's element once, for every card (events are delegated), so nothing is added per card. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardCanvasInteractions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DRAG_THRESHOLD = 3;
  const CLICK_TOLERANCE = 8; // screen pixels around a connector line
  const MIN_SIZE = { w: 48, h: 32 };
  const MAX_SIZE = 1e6; // the model's own ceiling
  const NOTE_SIZE = { w: 240, h: 160 }; // the model's default note, so a double-click centres it

  function intersects(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }
  function contains(outer, inner) { return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h; }
  function rectOf(item) { return { x: item.x, y: item.y, w: item.w, h: item.h }; }

  /** The middle of one edge of a rectangle: where a connector from that port starts. */
  function portPoint(rect, side) {
    switch (side) {
      case 'n': return { x: rect.x + rect.w / 2, y: rect.y };
      case 's': return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
      case 'w': return { x: rect.x, y: rect.y + rect.h / 2 };
      default: return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
    }
  }

  /**
   * deps: { document, surface, connectors, editor, notify, host }.
   * host: { itemElement(id), getBoard(), setLive(Map | null), startEdit(id), openConnectorLabel() }.
   */
  function createBoardCanvasInteractions(deps) {
    const { surface, connectors, editor, host } = deps;
    const doc = deps.document;
    const notify = typeof deps.notify === 'function' ? deps.notify : () => {};
    const element = surface.element;
    let gesture = null;
    let preview = null;
    let disposed = false;

    function zoom() { return surface.getView().zoom || 1; }
    function boardPoint(event) { return surface.toBoard(event.clientX, event.clientY); }

    /** The topmost card (not a group) under a board point. */
    function cardAt(point) {
      const board = host.getBoard();
      if (!board) return null;
      let best = null;
      Object.values(board.cards).forEach((card) => {
        if (point.x < card.x || point.y < card.y || point.x > card.x + card.w || point.y > card.y + card.h) return;
        if (!best || card.z >= best.z) best = card;
      });
      return best;
    }

    /* ---------------------------------------------------------------- live moves */

    function placeElement(item, x, y, w, h) {
      const el = host.itemElement(item.id);
      if (!el) return;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
    /** Puts every element the gesture touched back where the board says it is. */
    function restore() {
      if (!gesture || !gesture.movers) return;
      gesture.movers.forEach((mover) => placeElement(mover.item, mover.item.x, mover.item.y, mover.item.w, mover.item.h));
      host.setLive(null);
    }
    function showLive() {
      const live = new Map();
      gesture.movers.forEach((mover) => {
        const rect = { x: mover.x, y: mover.y, w: mover.w, h: mover.h };
        placeElement(mover.item, rect.x, rect.y, rect.w, rect.h);
        live.set(mover.item.id, rect);
      });
      host.setLive(live);
    }

    function moversFor(board) {
      const ids = new Set(editor.getSelection().filter((id) => board.cards[id] || board.groups[id]));
      Object.values(board.cards).forEach((card) => { if (card.group_id && ids.has(card.group_id)) ids.add(card.id); });
      return Array.from(ids).map((id) => ({ item: board.cards[id] || board.groups[id], x: 0, y: 0, w: 0, h: 0 }));
    }

    /* ---------------------------------------------------------------- the connect preview */

    function showPreview(from, to) {
      if (!preview) {
        const svg = doc.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'inv-board-connectors board-connect-preview');
        svg.setAttribute('width', '1');
        svg.setAttribute('height', '1');
        svg.setAttribute('overflow', 'visible');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('data-board-connect-preview', '');
        const path = doc.createElementNS(SVG_NS, 'path');
        path.setAttribute('class', 'board-connect-preview__line');
        svg.appendChild(path);
        surface.underlay.appendChild(svg);
        preview = svg;
      }
      preview.firstChild.setAttribute('d', `M ${from.x} ${from.y} L ${to.x} ${to.y}`);
    }
    function clearPreview() {
      if (preview) preview.remove();
      preview = null;
      element.querySelectorAll('[data-board-connect-target]').forEach((el) => el.removeAttribute('data-board-connect-target'));
    }
    function markTarget(card, from) {
      element.querySelectorAll('[data-board-connect-target]').forEach((el) => el.removeAttribute('data-board-connect-target'));
      if (!card || card.id === from) return;
      const el = host.itemElement(card.id);
      if (el) el.setAttribute('data-board-connect-target', '');
    }

    /* ---------------------------------------------------------------- gestures */

    function release(event) {
      try { if (typeof element.hasPointerCapture === 'function' && element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId); } catch (_error) { /* gone already */ }
    }
    function end() { gesture = null; clearPreview(); }
    function cancel() {
      if (!gesture) return;
      restore();
      end();
    }

    function begin(event, kind, extra) {
      gesture = Object.assign({ kind, pointerId: event.pointerId, x0: event.clientX, y0: event.clientY, started: false, shift: event.shiftKey === true }, extra);
      try { if (typeof element.setPointerCapture === 'function') element.setPointerCapture(event.pointerId); } catch (_error) { /* a synthetic pointer */ }
    }

    function onPointerDown(event) {
      // Space held means the surface is panning, whatever lies under the pointer.
      if (disposed || gesture || event.button !== 0 || event.isPrimary === false || element.hasAttribute('data-space')) return;
      const target = event.target && event.target.closest ? event.target : null;
      if (!target || target.closest('[data-board-editor]')) return;
      const cardEl = target.closest('[data-card-id]');
      if (!cardEl || !surface.layer.contains(cardEl)) return;
      const id = cardEl.getAttribute('data-card-id');
      const board = host.getBoard();
      const item = board && (board.cards[id] || board.groups[id]);
      if (!item) return;
      const port = target.closest('[data-card-connect]');
      if (port && board.cards[id]) {
        if (editor.canEdit()) begin(event, 'connect', { id, side: port.getAttribute('data-card-connect') });
        return;
      }
      if (target.closest('[data-card-resize]')) {
        if (!editor.canEdit()) return;
        if (!editor.isSelected(id)) editor.select([id]);
        begin(event, 'resize', { id, w0: item.w, h0: item.h });
        return;
      }
      const was = editor.isSelected(id);
      if (event.shiftKey) { if (!was) editor.select([id], { add: true }); } else if (!was) editor.select([id]);
      // A press on a web link in a note (inventory/note-markup.js): released without a drag, it opens the link.
      begin(event, 'move', { id, was, link: event.shiftKey ? null : target.closest('a[data-note-link]') });
    }

    function startMove() {
      const board = host.getBoard();
      if (!board || !editor.canEdit()) { gesture.blocked = true; return; }
      gesture.movers = moversFor(board);
    }

    function onPointerMove(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const dx = event.clientX - gesture.x0;
      const dy = event.clientY - gesture.y0;
      if (!gesture.started) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        gesture.started = true;
        if (gesture.kind === 'move') startMove();
        if (gesture.kind === 'resize') gesture.movers = [{ item: host.getBoard().cards[gesture.id] || host.getBoard().groups[gesture.id], x: 0, y: 0, w: 0, h: 0 }];
        if (gesture.kind === 'connect') showPreview(portPoint(rectOf(host.getBoard().cards[gesture.id]), gesture.side), boardPoint(event));
      }
      const k = zoom();
      if (gesture.kind === 'move' && !gesture.blocked) {
        gesture.dx = Math.round(dx / k);
        gesture.dy = Math.round(dy / k);
        gesture.movers.forEach((mover) => {
          mover.x = mover.item.x + gesture.dx; mover.y = mover.item.y + gesture.dy; mover.w = mover.item.w; mover.h = mover.item.h;
        });
        showLive();
      } else if (gesture.kind === 'resize') {
        const mover = gesture.movers[0];
        gesture.w = Math.min(MAX_SIZE, Math.max(MIN_SIZE.w, Math.round(gesture.w0 + dx / k)));
        gesture.h = Math.min(MAX_SIZE, Math.max(MIN_SIZE.h, Math.round(gesture.h0 + dy / k)));
        mover.x = mover.item.x; mover.y = mover.item.y; mover.w = gesture.w; mover.h = gesture.h;
        showLive();
      } else if (gesture.kind === 'connect') {
        const point = boardPoint(event);
        const card = cardAt(point);
        showPreview(portPoint(rectOf(host.getBoard().cards[gesture.id]), gesture.side), point);
        markTarget(card, gesture.id);
      }
    }

    async function finishMove(done) {
      const moved = done.movers && (done.dx || done.dy);
      if (!moved) { restore(); end(); return; }
      host.setLive(null);
      const items = done.movers.filter((mover) => editor.isSelected(mover.item.id)).map((mover) => ({ id: mover.item.id, x: mover.x, y: mover.y }));
      end();
      const result = await editor.placeItems(items);
      if (!result.ok) done.movers.forEach((mover) => placeElement(mover.item, mover.item.x, mover.item.y, mover.item.w, mover.item.h));
    }

    function onPointerUp(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const done = gesture;
      release(event);
      if (done.kind === 'move') {
        if (!done.started) {
          // A click: on an already selected card it narrows the selection (or, with Shift, drops the card from it).
          if (done.shift && done.was) editor.toggle(done.id);
          else if (!done.shift && done.was && editor.getSelection().length > 1) editor.select([done.id]);
          end();
          if (done.link) openLink(done.link);
          return;
        }
        void finishMove(done);
        return;
      }
      if (done.kind === 'resize' && done.started) {
        const board = host.getBoard();
        const item = board.cards[done.id] || board.groups[done.id];
        host.setLive(null);
        end();
        void editor.placeItems([{ id: done.id, x: item.x, y: item.y, w: done.w, h: done.h }]).then((result) => {
          if (!result.ok) placeElement(item, item.x, item.y, item.w, item.h);
        });
        return;
      }
      if (done.kind === 'connect' && done.started) {
        const target = cardAt(boardPoint(event));
        end();
        if (target && target.id !== done.id) {
          void editor.connect(done.id, target.id).then((result) => {
            if (result.ok) editor.selectConnector(result.id);
            else if (result.reason === 'exists') notify(jt('board.connect.exists', 'Those two cards are already connected.'), { tone: 'info' });
          });
        }
        return;
      }
      end();
    }

    // Only a web address leaves, through window.open: the main window's guard hands it to the system browser and
    // opens no window. The link's own click does nothing (the pointer is captured, so it may never come anyway).
    function openLink(anchor) {
      const href = String(anchor.getAttribute('href') || '');
      const view = doc.defaultView;
      if (!/^https?:\/\//i.test(href) || !view || typeof view.open !== 'function') return;
      try { view.open(href, '_blank', 'noopener,noreferrer'); } catch (_error) { /* nothing opens */ }
    }
    function onLinkClick(event) {
      if (event.target && event.target.closest && event.target.closest('a[data-note-link]')) event.preventDefault();
    }

    function onPointerCancel(event) {
      if (gesture && event.pointerId === gesture.pointerId) { release(event); cancel(); }
    }

    function onEscape(event) {
      if (event.key !== 'Escape' || !gesture) return;
      if (gesture.started) event.preventDefault();
      cancel();
    }

    function onDoubleClick(event) {
      if (disposed) return;
      const target = event.target && event.target.closest ? event.target : null;
      if (!target || target.closest('[data-board-editor]') || target.closest('[data-card-resize], [data-card-connect]')) return;
      const cardEl = target.closest('[data-card-id]');
      if (!cardEl || !surface.layer.contains(cardEl)) return;
      // The inline editor refuses a read-only board itself; a kind with no editor opens what the card names.
      host.startEdit(cardEl.getAttribute('data-card-id'));
    }

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerCancel);
    element.addEventListener('dblclick', onDoubleClick);
    element.addEventListener('click', onLinkClick, true);
    element.addEventListener('auxclick', onLinkClick, true);
    doc.addEventListener('keydown', onEscape, true);

    /* ---------------------------------------------------------------- what the surface reports */

    return {
      /** surface.onMarquee: cards the box touches, groups it holds whole. */
      onMarquee(box, options) {
        const board = host.getBoard();
        if (disposed || !board) return;
        const ids = Object.values(board.cards).filter((card) => intersects(box, rectOf(card))).map((card) => card.id)
          .concat(Object.values(board.groups).filter((group) => contains(box, rectOf(group))).map((group) => group.id));
        if (!ids.length && !(options && options.additive)) { editor.clearSelection(); return; }
        editor.select(ids, { add: Boolean(options && options.additive) });
      },
      /** surface.onBackgroundClick: a connector under the point is selected, empty canvas clears. */
      onBackgroundClick(info) {
        if (disposed) return;
        const id = connectors.hitTest(info.x, info.y, CLICK_TOLERANCE / zoom());
        if (id) editor.selectConnector(id);
        else if (!(info.event && info.event.shiftKey)) editor.clearSelection();
      },
      /** surface.onBackgroundDoubleClick: a note appears there and opens for typing; a connector's label opens instead. */
      async onBackgroundDoubleClick(info) {
        if (disposed || !editor.canEdit()) return;
        const hit = connectors.hitTest(info.x, info.y, CLICK_TOLERANCE / zoom());
        if (hit) { editor.selectConnector(hit); host.openConnectorLabel(); return; }
        const result = await editor.addNote({ x: Math.round(info.x - NOTE_SIZE.w / 2), y: Math.round(info.y - NOTE_SIZE.h / 2) });
        if (result.ok && !disposed) host.startEdit(result.id, { fresh: true });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        cancel();
        element.removeEventListener('pointerdown', onPointerDown);
        element.removeEventListener('pointermove', onPointerMove);
        element.removeEventListener('pointerup', onPointerUp);
        element.removeEventListener('pointercancel', onPointerCancel);
        element.removeEventListener('dblclick', onDoubleClick);
        element.removeEventListener('click', onLinkClick, true);
        element.removeEventListener('auxclick', onLinkClick, true);
        doc.removeEventListener('keydown', onEscape, true);
      },
    };
  }

  return { createBoardCanvasInteractions };
});
