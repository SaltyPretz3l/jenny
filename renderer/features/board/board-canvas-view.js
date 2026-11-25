/* renderer/features/board/board-canvas-view.js - the Board's centre column: one board, drawn, and editable (UMD).
 *
 * Built from the canvas primitives (inventoryCanvasSurface, inventoryBoardCard, inventoryConnectorLayer):
 * cards and groups are board cards in the surface's layer, connectors are one SVG layer beneath. The person
 * can pan and zoom (the surface does that) and press Fit or 100%. This file owns the drawing; the editing
 * is handed in by setEditor(editor, { source, notify, modules }): the editor (board-editor.js) holds the
 * selection and runs the commands, and the view draws what it says (the selected and dimmed states, ports
 * and grips only while the board can be edited). The pointer work, the toolbar and the inline editors are
 * their own modules, built once an editor arrives. What a file, picture, chat or diagram card needs beyond
 * its title comes from the kind modules (board-card-kinds.js): extra props, a picture, what Enter does.
 * Every string from a document goes in through the primitives' textContent paths, never as markup.
 *
 * show(board) draws or updates the board in place: a card whose props did not change is not touched, a
 * removed one is removed, so an external change repaints only what moved. The first board shown (and
 * each other board opened) is fitted once, as soon as the column has a size. With an editor attached,
 * show() also hands it the document, and the view redraws on the editor's own changes (an optimistic
 * edit repaints before the store answers).
 *
 * Following the arrows: the card under the pointer (or the one selected card) keeps its connectors and the cards
 * they reach lit while the rest step back. When connected cards appear together on a board already shown (an
 * accepted proposal, a paste, an undo), they arrive in the order the arrows give and each line is drawn from its start, once.
 *
 * show(null, { message, actions }) puts buttons under the message (slice B11: a read-only board's Show file and Remove
 * from list): [{ id, label, title, disabled, onClick }]. While one runs, every button waits; a board or a new message clears them. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardCanvasView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const FIT_PADDING = 48;
  const HOVER_MS = 90; // the pointer rests this long on a card before its arrows light
  const ARRIVE_STEP_MS = 260; // between a card and the card it points at
  const ARRIVE_MAX_MS = 1500; // the last card of a long chain starts no later than this
  const ARRIVE_CLEAR_MS = 700;

  function baseName(path) {
    const parts = String(path || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function hostOf(url) {
    try { return new URL(String(url)).host; } catch (_error) { return ''; }
  }

  /** What boardCard draws for one stored card: title, text and meta by kind. Nothing is fetched here. */
  function cardProps(card) {
    const data = card.data || {};
    const props = { id: card.id, kind: card.kind, x: card.x, y: card.y, w: card.w, h: card.h, z: card.z };
    switch (card.kind) {
      case 'note':
        props.text = data.text;
        props.rich = true; // bold, italics, code, lists and web links (inventory/note-markup.js)
        props.tone = data.tone;
        break;
      case 'file':
        props.title = data.title || baseName(data.path);
        props.meta = data.path;
        break;
      case 'image':
        props.title = data.alt || '';
        props.meta = data.width && data.height ? `${data.width} × ${data.height}` : '';
        break;
      case 'link':
        props.title = data.title || hostOf(data.url) || data.url;
        props.meta = data.url;
        break;
      case 'chat':
        props.title = data.title || '';
        props.text = data.excerpt || '';
        break;
      default: // diagram: the picture is slice B8's
        props.title = data.title || '';
    }
    return props;
  }

  function groupProps(group) {
    return { id: group.id, kind: 'group', x: group.x, y: group.y, w: group.w, h: group.h, title: group.title, tone: group.tone };
  }

  function createBoardCanvasView(deps) {
    const doc = deps.document;
    const actionButton = deps.actionButton;
    // The surface reports gestures through these; the interactions module fills them in when an editor arrives.
    const gestures = { marquee: null, click: null, dblclick: null };
    const surface = deps.canvasSurface({
      document: doc,
      onMarquee: (box, options) => { if (gestures.marquee) gestures.marquee(box, options); },
      onBackgroundClick: (info) => { if (gestures.click) gestures.click(info); },
      onBackgroundDoubleClick: (info) => { if (gestures.dblclick) gestures.dblclick(info); },
    });
    const connectors = deps.connectorLayer({ document: doc });
    surface.underlay.appendChild(connectors.element);

    const element = doc.createElement('div');
    element.className = 'board-centre';
    element.setAttribute('data-board-centre', '');
    element.appendChild(surface.element);

    const hint = doc.createElement('p');
    hint.className = 'board-empty-hint';
    hint.setAttribute('data-board-empty', '');
    hint.hidden = true;
    hint.textContent = jt('board.canvas.emptyHint', 'Double-click to add a note, drop a file or picture here, or ask Jenny to lay something out.');
    element.appendChild(hint);

    const note = doc.createElement('div');
    note.className = 'board-note';
    note.setAttribute('data-board-note', '');
    note.hidden = true;
    const noteText = doc.createElement('p');
    noteText.className = 'board-note__text';
    noteText.setAttribute('role', 'status');
    const noteActions = doc.createElement('div');
    noteActions.className = 'board-note__actions';
    noteActions.setAttribute('data-board-note-actions', '');
    noteActions.hidden = true;
    note.append(noteText, noteActions);
    element.appendChild(note);
    let noteHandlers = new Map(); // action id -> onClick, for the buttons under the message

    const zoombar = doc.createElement('div');
    zoombar.className = 'board-zoombar';
    zoombar.setAttribute('role', 'group');
    zoombar.setAttribute('aria-label', jt('board.canvas.zoomGroup', 'Zoom'));
    zoombar.insertAdjacentHTML('beforeend',
      actionButton({ variant: 'ghost', size: 'sm', className: 'board-zoom-button', label: jt('board.canvas.fit', 'Fit'), title: jt('board.canvas.fitTitle', 'Fit the whole board in view'), dataset: { 'board-zoom': 'fit' } })
      + actionButton({ variant: 'ghost', size: 'sm', className: 'board-zoom-button', label: jt('board.canvas.actualSize', '100%'), title: jt('board.canvas.actualSizeTitle', 'Show the board at its real size'), dataset: { 'board-zoom': 'actual' } }));
    element.appendChild(zoombar);

    const items = new Map(); // id -> element, cards and groups alike
    let lastProps = new Map(); // id -> the props last given to the card, selected flag included
    let shownId = '';
    let model = null;
    let pendingFit = false;
    let disposed = false;
    let visible = true; // false while the page is parked
    // Parked (false) or shown again (true): the kinds and the gestures stop reacting meanwhile.
    function setShown(isShown) {
      visible = isShown !== false;
      if (kinds) kinds.setShown(visible);
      if (interactions) interactions.setShown(visible);
    }
    let editor = null;
    let unsubscribe = null;
    let interactions = null;
    let editing = null;
    let chrome = null;
    let kinds = null;
    let forwarding = false;
    let selected = new Set();
    let selectedConnector = '';
    let matches = null; // find: the ids that stay lit, or null
    let live = null; // id -> rect while a drag or resize is under way, so connectors follow
    let hovered = ''; // the card under the pointer
    let hoverTimer = 0;
    let arriveTimer = 0;
    let litKey = ''; // the lit connectors' ids, so a redraw with the same ones lit touches nothing
    const arriving = new Set(); // the card elements that carry the arriving mark
    const view = doc.defaultView || globalThis;

    function bounds() {
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      const take = (item) => {
        minX = Math.min(minX, item.x); minY = Math.min(minY, item.y);
        maxX = Math.max(maxX, item.x + item.w); maxY = Math.max(maxY, item.y + item.h);
      };
      if (model) {
        Object.values(model.cards).forEach(take);
        Object.values(model.groups).forEach(take);
      }
      return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
    }

    function sized() {
      const rect = surface.element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function fit() {
      if (!sized()) { pendingFit = true; return false; }
      pendingFit = false;
      surface.fit(bounds(), FIT_PADDING);
      return true;
    }

    function zoomBy(factor) {
      const rect = surface.element.getBoundingClientRect();
      surface.zoomAt({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, factor);
    }

    function actualSize() {
      zoomBy(1 / surface.getView().zoom);
    }

    /**
     * Pans so an item is in view and clear of the toolbar, which floats over the top of the surface; one already
     * there is left alone. (The first card of an empty board is placed at 0,0: the corner under the toolbar.)
     */
    function reveal(id) {
      const item = model && (model.cards[id] || model.groups[id]);
      if (!item || !sized()) return;
      const view = surface.getView();
      const rect = surface.element.getBoundingClientRect();
      const bar = chrome ? chrome.element.getBoundingClientRect() : null;
      const clear = bar && bar.height > 0 ? Math.max(0, bar.bottom - rect.top) : 0;
      const left = item.x * view.zoom + view.x;
      const top = item.y * view.zoom + view.y;
      if (left >= 0 && top >= clear && left + item.w * view.zoom <= rect.width && top + item.h * view.zoom <= rect.height) return;
      surface.setView({ x: rect.width / 2 - (item.x + item.w / 2) * view.zoom, y: rect.height / 2 - (item.y + item.h / 2) * view.zoom, zoom: view.zoom });
    }

    function setNote(text, actions) {
      noteText.textContent = text || '';
      note.hidden = !text;
      const list = text && Array.isArray(actions) ? actions : [];
      noteHandlers = new Map();
      noteActions.textContent = '';
      noteActions.insertAdjacentHTML('beforeend', list.map((action) => actionButton({ size: 'sm', label: action.label, title: action.title,
        disabled: action.disabled === true, dataset: { 'board-note-action': action.id } })).join(''));
      list.forEach((action) => { if (action.disabled !== true && typeof action.onClick === 'function') noteHandlers.set(action.id, action.onClick); });
      noteActions.hidden = list.length === 0;
    }

    // One action at a time: every live button waits until it settles, unless the message changed meanwhile.
    async function onNoteAction(event) {
      const button = event.target && event.target.closest ? event.target.closest('[data-board-note-action]') : null;
      const run = button && !button.disabled ? noteHandlers.get(button.getAttribute('data-board-note-action')) : null;
      if (!run) return;
      const handlers = noteHandlers;
      const waiting = Array.from(noteActions.querySelectorAll('button')).filter((node) => !node.disabled);
      waiting.forEach((node) => { node.disabled = true; });
      try { await run(); } catch (_error) { /* the page reports its own refusals */ } finally { if (noteHandlers === handlers) waiting.forEach((node) => { node.disabled = false; }); }
    }
    noteActions.addEventListener('click', onNoteAction);

    function applyDim() {
      items.forEach((el, id) => el.toggleAttribute('data-board-dim', matches !== null && !matches.has(id)));
    }

    function sync(wanted) {
      items.forEach((el, id) => {
        if (wanted.has(id)) return;
        el.remove();
        items.delete(id);
        if (kinds) kinds.release(id);
      });
      wanted.forEach((props, id) => {
        const existing = items.get(id);
        if (existing) { deps.boardCard.update(existing, props); return; }
        const el = deps.boardCard(props, { document: doc });
        items.set(id, el);
        surface.layer.appendChild(el);
      });
      lastProps = wanted;
      applyDim();
    }

    function rect(item) { return { x: item.x, y: item.y, w: item.w, h: item.h }; }

    function drawConnectors(board) {
      const list = [];
      const at = (card) => (live && live.get(card.id)) || rect(card);
      Object.values(board.connectors).forEach((connector) => {
        const from = board.cards[connector.from];
        const to = board.cards[connector.to];
        if (!from || !to) return;
        list.push({
          id: connector.id, from: at(from), to: at(to),
          label: connector.label, style: connector.style, tone: connector.tone, ends: connector.ends, selected: connector.id === selectedConnector,
        });
      });
      connectors.render(list, list.length ? Object.values(board.cards).map(at) : []); // a line goes round the other cards
    }

    /** Lights the connectors of the card under the pointer, or of the one selected card, and the cards they reach. */
    function applyFocus() {
      const one = selected.size === 1 ? selected.values().next().value : '';
      const at = model && !live ? (model.cards[hovered] ? hovered : model.cards[one] ? one : '') : '';
      const lines = [];
      const cards = new Set();
      if (at) {
        Object.values(model.connectors).forEach((connector) => {
          if ((connector.from !== at && connector.to !== at) || !model.cards[connector.from] || !model.cards[connector.to]) return;
          lines.push(connector.id);
          cards.add(connector.from).add(connector.to);
        });
      }
      const on = lines.length > 0;
      const key = lines.join(' ');
      if (key === litKey) return;
      litKey = key;
      connectors.setLit(on ? lines : null);
      element.toggleAttribute('data-board-focus', on);
      items.forEach((el, id) => el.toggleAttribute('data-board-lit', on && cards.has(id)));
    }

    function onHover(event) {
      const el = event.type === 'pointerover' && event.buttons === 0 && event.target && event.target.closest ? event.target.closest('[data-card-id]') : null;
      const id = el && el.getAttribute('data-card-kind') !== 'group' ? el.getAttribute('data-card-id') : '';
      if (id === hovered) return;
      hovered = id;
      view.clearTimeout(hoverTimer);
      hoverTimer = view.setTimeout(applyFocus, HOVER_MS);
    }
    surface.layer.addEventListener('pointerover', onHover);
    surface.layer.addEventListener('pointerleave', onHover);

    /** Cards that came together with arrows between them arrive in the arrows' order; each line is drawn after its source. */
    function arrive(board, had) {
      const fresh = new Set(Object.keys(board.cards).filter((id) => !had.has(id)));
      const lines = fresh.size > 1 ? Object.values(board.connectors).filter((c) => fresh.has(c.from) && fresh.has(c.to)) : [];
      if (!lines.length) return;
      const depth = new Map();
      let deepest = 0;
      for (let pass = 0, moved = true; moved && pass < 12; pass += 1) {
        moved = false;
        lines.forEach((c) => {
          const next = (depth.get(c.from) || 0) + 1;
          if ((depth.get(c.to) || 0) >= next || next > 12) return;
          depth.set(c.to, next);
          deepest = Math.max(deepest, next);
          moved = true;
        });
      }
      const step = Math.min(ARRIVE_STEP_MS, ARRIVE_MAX_MS / Math.max(1, deepest));
      const delays = {};
      fresh.forEach((id) => {
        const el = items.get(id);
        el.style.setProperty('--board-arrive-delay', `${Math.round((depth.get(id) || 0) * step)}ms`);
        el.setAttribute('data-board-arriving', '');
        arriving.add(el);
      });
      lines.forEach((c) => { delays[c.id] = Math.round((depth.get(c.from) || 0) * step + step / 2); });
      connectors.drawIn(delays);
      view.clearTimeout(arriveTimer);
      arriveTimer = view.setTimeout(() => { // one clean-up for every batch still marked: a second batch does not strand the first
        arriving.forEach((el) => { el.removeAttribute('data-board-arriving'); el.style.removeProperty('--board-arrive-delay'); });
        arriving.clear();
      }, deepest * step + ARRIVE_CLEAR_MS);
    }

    function readSelection() {
      selected = new Set(editor ? editor.getSelection() : []);
      selectedConnector = editor ? editor.getSelectedConnector() : '';
    }

    /** Repaints only the cards whose selected flag changed, and the connectors (one may be selected). */
    function repaintSelection() {
      readSelection();
      lastProps.forEach((props, id) => {
        const next = selected.has(id);
        const el = items.get(id);
        if (props.selected === next || !el) return;
        props.selected = next;
        deps.boardCard.update(el, props);
      });
      if (model) drawConnectors(model);
      applyFocus();
    }

    /** Draws a document. Ports and grips show only while the editor says the board can be edited. */
    function draw(board) {
      model = board;
      readSelection();
      const edit = editor !== null && editor.canEdit();
      let minZ = Infinity;
      Object.values(board.cards).forEach((card) => { if (card.z < minZ) minZ = card.z; });
      const wanted = new Map();
      const had = board.id === shownId ? new Set(items.keys()) : null; // what was drawn of this board before this change
      Object.values(board.groups).forEach((group) => wanted.set(group.id, Object.assign(groupProps(group), { selected: selected.has(group.id), resizable: edit })));
      // A card's z can be zero or below (after Send back); the primitive floors at 1, so the lowest card sits there.
      Object.values(board.cards).forEach((card) => wanted.set(card.id, Object.assign(cardProps(card), kinds ? kinds.props(card) : null, { z: card.z - minZ + 1, selected: selected.has(card.id), resizable: edit, connectable: edit })));
      sync(wanted);
      if (kinds) Object.values(board.cards).forEach((card) => kinds.decorate(items.get(card.id), card, { editable: edit }));
      drawConnectors(board);
      if (had) arrive(board, had);
      applyFocus();
      hint.hidden = wanted.size > 0;
      if (editing) editing.prune();
    }

    function focusItem(id) {
      const el = items.get(id);
      if (!el) return false;
      el.focus({ preventScroll: true });
      return true;
    }

    /** Enter or a double-click on a card with no inline editor: its kind module decides (open the file, the chat, the drawing). */
    function activate(id, origin) {
      const card = kinds && model ? model.cards[id] : null;
      return card ? kinds.activate(card, origin) : false;
    }

    function startEdit(id, options) { return (editing ? editing.start(id, options) : false) || activate(id, 'canvas'); }

    /** Draws or updates the board in place, or nothing and `message` when there is no board to draw. */
    function show(board, options) {
      if (disposed) return;
      const message = options && options.message ? options.message : '';
      if (editor) {
        // A document older than the one the editor holds (an answer that crossed an edit) is not drawn over it.
        const held = editor.getBoard();
        if (board && held && held.id === board.id && board.rev < held.rev) return;
        forwarding = true;
        try {
          editor.setBoard(board, { boardId: board ? board.id : '', readOnly: Boolean(options && options.readOnly), canUndo: options && options.canUndo, canRedo: options && options.canRedo });
        } finally { forwarding = false; }
      }
      if (chrome) { chrome.setVisible(Boolean(board)); chrome.refresh(); if (board) chrome.layout(); }
      if (!board) {
        model = null;
        shownId = '';
        readSelection();
        sync(new Map());
        connectors.render([]);
        hint.hidden = true;
        zoombar.hidden = true;
        setNote(message, options && options.actions);
        return;
      }
      draw(board);
      zoombar.hidden = false;
      setNote('');
      if (board.id !== shownId) {
        shownId = board.id;
        fit();
      }
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-board-zoom]') : null;
      if (!target) return;
      if (target.getAttribute('data-board-zoom') === 'fit') fit();
      else actualSize();
    }
    zoombar.addEventListener('click', onClick);

    function onEditorChange(change) {
      if (disposed || forwarding) return;
      if (change.kind === 'selection') repaintSelection();
      else if (editor.getBoard()) draw(editor.getBoard());
      if (chrome) chrome.refresh();
    }

    /**
     * Hands the view its editor, once. options: { source, notify, log, context, modules: { interactions, toolbar, cardEditing, cardKinds } }.
     * From then on the view owns the editor: dispose() disposes it.
     */
    function setEditor(next, options) {
      if (disposed || editor || !next) return;
      editor = next;
      const extra = options || {};
      const modules = extra.modules || {};
      const host = {
        itemElement: (id) => items.get(id) || null,
        getBoard: () => editor.getBoard(),
        setLive(map) {
          const changed = Boolean(live) !== Boolean(map);
          live = map;
          if (model) drawConnectors(model);
          if (changed) applyFocus(); // nothing is lit while a card is dragged
        },
        startEdit,
        focusItem,
        reveal,
        openConnectorLabel: () => (chrome ? chrome.editConnectorLabel() : false),
        redraw() { if (!disposed && editor && editor.getBoard()) draw(editor.getBoard()); },
      };
      if (modules.cardKinds) {
        kinds = modules.cardKinds.createBoardCardKinds({
          document: doc, windowRef: doc.defaultView, editor, source: extra.source, notify: extra.notify, log: extra.log, jt,
          actionButton, boardCard: deps.boardCard, surface, host, context: extra.context || {},
        });
      }
      if (modules.cardEditing) editing = modules.cardEditing.createBoardCardEditing({ document: doc, actionButton, editor, source: extra.source, host, notify: extra.notify, context: extra.context || {} });
      if (modules.interactions) {
        interactions = modules.interactions.createBoardCanvasInteractions({ document: doc, surface, connectors, editor, notify: extra.notify, host });
        gestures.marquee = interactions.onMarquee;
        gestures.click = interactions.onBackgroundClick;
        gestures.dblclick = interactions.onBackgroundDoubleClick;
      }
      if (modules.toolbar) {
        chrome = modules.toolbar.createBoardCanvasToolbar({ document: doc, actionButton, editor, host, tools: kinds ? kinds.tools() : [], context: extra.context || {} });
        chrome.setVisible(model !== null);
        element.appendChild(chrome.element);
      }
      unsubscribe = editor.onChange(onEditorChange);
      if (!visible) setShown(false);
      if (kinds && model) draw(model);
    }

    return {
      element,
      surface,
      show,
      fit,
      actualSize,
      zoomBy,
      focusItem,
      startEdit,
      activate,
      setEditor,
      reveal,
      setShown,
      // find: only these ids stay lit; null clears it.
      setMatches(ids) {
        matches = Array.isArray(ids) ? new Set(ids) : null;
        applyDim();
      },
      // The page calls this when the column's size changes: a fit that had to wait for a size happens now.
      resized() {
        if (disposed) return;
        if (chrome) chrome.layout();
        if (pendingFit) fit();
      },
      // The toolbar's room changed without the column's size changing (the view switch moved into or out of its slot).
      layoutToolbar() { if (chrome && !disposed) chrome.layout(); },
      cardIds: () => Array.from(items.keys()),
      dispose() {
        if (disposed) return;
        disposed = true;
        if (typeof unsubscribe === 'function') unsubscribe();
        unsubscribe = null;
        if (interactions) interactions.dispose();
        if (editing) editing.dispose();
        if (chrome) chrome.dispose();
        if (kinds) kinds.dispose();
        if (editor) editor.dispose();
        view.clearTimeout(hoverTimer);
        view.clearTimeout(arriveTimer);
        surface.layer.removeEventListener('pointerover', onHover);
        surface.layer.removeEventListener('pointerleave', onHover);
        zoombar.removeEventListener('click', onClick);
        noteActions.removeEventListener('click', onNoteAction);
        connectors.dispose();
        surface.dispose();
        items.clear();
        element.remove();
      },
    };
  }

  return { createBoardCanvasView, cardProps, groupProps };
});
