/* renderer/features/board/board-card-diagram.js - the diagram card kind of the Board (UMD, global
 * rendererBoardCardDiagram). It registers itself with the card kinds seam (board-card-kinds.js) when it loads.
 *
 * A diagram card holds a drawing written in the short `sketch` language: { scene, title }.
 *   Picture   a still image in the card's media slot, drawn by the sketch frame and shown as an <img> from a blob URL
 *             (board-card-diagram-pictures.js). The drawing's SVG never enters the page as markup.
 *   Open      Enter or a double-click opens the drawing live in the full-window viewer (rendererSketchOpen.openLarge).
 *             It works on a board that cannot be changed.
 *   Edit      while the board can be edited, an "Edit source" button in the card opens the source by hand: a title line
 *             and the scene. Ctrl+Enter saves, Esc cancels, leaving the editor saves. A refusal keeps it open and
 *             says why. One editor is open at a time (opening another saves the first).
 *   Break     a "Break apart" button turns the drawing into note cards, groups and connectors in one batch (one Undo
 *             brings the diagram card back). The structure comes from the sketch frame (pictures.outline), the batch from
 *             board-diagram-break.js, and nothing is removed unless the whole batch applied.
 *   Add       the toolbar button "Diagram" adds a card with a small starter drawing and opens its source.
 * Everything a document holds reaches the DOM as a value or textContent. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(typeof require === 'function' ? require('./board-card-kinds') : null, typeof require === 'function' ? require('./board-card-diagram-pictures') : null,
      typeof require === 'function' ? require('./board-diagram-break') : null);
    return;
  }
  root.rendererBoardCardDiagram = factory(root.rendererBoardCardKinds, root.rendererBoardCardDiagramPictures, root.rendererBoardDiagramBreak);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (kinds, picturesModule, breakModule) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const SCENE_CHARS = 16384;
  const TITLE_CHARS = 200;
  const STARTER_SCENE = 'a Idea\nb Result\na -> b';

  function limitText(limit) {
    switch (limit) {
      case 'diagram_chars': return jt('board.diagram.limitChars', 'This drawing is too long: it can hold at most 16,384 characters.');
      case 'diagram_lines': return jt('board.diagram.limitLines', 'This drawing has too many lines: at most 400.');
      case 'diagram_nodes': return jt('board.diagram.limitNodes', 'This drawing has too many shapes: at most 120.');
      default: return '';
    }
  }

  function modelLimits() {
    if (globalThis.jennyBoardModel && globalThis.jennyBoardModel.LIMITS) return globalThis.jennyBoardModel.LIMITS;
    try { return require('../../../services/boards/board-model').LIMITS; } catch (_error) { return null; }
  }

  /** deps (all optional, for tests): loadHost, setTimer, clearTimer, makeUrl, revokeUrl, getOpen, makeId, limits. */
  function createDiagramPart(ctx, deps) {
    const own = deps || {};
    const doc = ctx.document;
    const win = ctx.windowRef || doc.defaultView;
    const pictures = picturesModule.createDiagramPictures({
      document: doc, windowRef: win, log: ctx.log,
      loadHost: own.loadHost || (() => {
        // The sketch kill switch (flag sketch_blocks) covers the board's drawings too.
        const state = ctx.context && ctx.context.state;
        const flags = state && state.features && state.features.featureFlags;
        if (flags && flags.sketch_blocks === false) return Promise.resolve(null);
        const loader = win.rendererMermaidRuntimeLoader || globalThis.rendererMermaidRuntimeLoader;
        if (loader && typeof loader.ensureSketchHost === 'function') return loader.ensureSketchHost();
        return Promise.resolve(win.rendererSketchFrameHost || globalThis.rendererSketchFrameHost || null);
      }),
      setTimer: own.setTimer, clearTimer: own.clearTimer, makeUrl: own.makeUrl, revokeUrl: own.revokeUrl,
    });
    const shown = new Map(); // card id -> { id, slot, img, note, edit, title }
    const sessions = new Set();
    const breaking = new Set(); // card ids being broken apart
    let gone = false;

    function tell(message, tone) {
      if (typeof ctx.notify === 'function') { try { ctx.notify(message, { tone }); } catch (_error) { /* a toast is best-effort */ } }
    }

    /* ---------------------------------------------------------------- the picture */

    function say(status) {
      switch (status) {
        case 'problem': return jt('board.diagram.problem', 'This drawing has a problem');
        case 'failed': return jt('board.diagram.failed', 'Could not draw this');
        case 'unavailable': return jt('board.diagram.unavailable', 'Drawings are not available');
        default: return jt('board.diagram.drawing', 'Drawing…');
      }
    }

    function paint(record, state) {
      if (shown.get(record.id) !== record) return;
      if (state.status === 'ready' && state.url) {
        record.note.remove();
        record.img.setAttribute('alt', record.title || jt('board.diagram.alt', 'Diagram'));
        if (record.img.getAttribute('src') !== state.url) record.img.setAttribute('src', state.url);
        if (!record.img.parentNode) record.slot.insertBefore(record.img, record.slot.firstChild);
        return;
      }
      record.img.remove();
      record.img.removeAttribute('src');
      record.note.textContent = state.status === 'empty' ? jt('board.diagram.empty', 'Empty diagram') : say(state.status);
      if (!record.note.parentNode) record.slot.insertBefore(record.note, record.slot.firstChild);
    }

    function makeRecord(id, slot) {
      const img = doc.createElement('img');
      img.className = 'board-diagram__picture';
      img.setAttribute('draggable', 'false');
      const note = doc.createElement('p');
      note.className = 'board-diagram__note';
      slot.classList.add('board-diagram__media');
      return { id, slot, img, note, edit: null, brk: null, title: '' };
    }

    function ensureEditButton(record, editable) {
      if (!editable) {
        if (record.edit) { record.edit.remove(); record.edit = null; }
        return;
      }
      if (record.edit) return;
      record.slot.insertAdjacentHTML('beforeend', ctx.actionButton({
        variant: 'ghost', size: 'sm', className: 'board-diagram__edit', label: jt('board.diagram.editSource', 'Edit source'),
        title: jt('board.diagram.editSourceTitle', 'Edit the source of this drawing'), dataset: { 'board-diagram-edit': '' },
      }));
      const button = record.slot.querySelector('[data-board-diagram-edit]');
      record.edit = button;
      if (!button) return;
      // A press on the button is not a press on the card: no drag, no selection, no double-click open.
      ['pointerdown', 'pointerup', 'dblclick'].forEach((type) => button.addEventListener(type, (event) => event.stopPropagation()));
      button.addEventListener('click', (event) => { event.stopPropagation(); openEditor(record.id); });
    }

    /* ---------------------------------------------------------------- break apart */

    function paintBreak(record, editable, hasScene) {
      const button = record.brk;
      if (!button) return;
      const busy = breaking.has(record.id);
      button.disabled = busy || !editable || !hasScene;
      button.textContent = busy ? jt('board.diagram.breaking', 'Breaking apart…') : jt('board.diagram.break', 'Break apart');
      if (!editable) button.title = jt('board.error.readOnly', 'This board cannot be changed.');
      else if (!hasScene) button.title = jt('board.diagram.breakEmpty', 'This drawing has nothing to break apart.');
      else button.title = jt('board.diagram.breakTitle', 'Turn this drawing into separate notes and arrows');
    }

    function ensureBreakButton(record, editable, hasScene) {
      if (!record.brk) {
        if (typeof ctx.actionButton !== 'function') return;
        record.slot.insertAdjacentHTML('beforeend', ctx.actionButton({
          variant: 'ghost', size: 'sm', className: 'board-diagram__break', label: jt('board.diagram.break', 'Break apart'),
          title: jt('board.diagram.breakTitle', 'Turn this drawing into separate notes and arrows'), dataset: { 'board-diagram-break': '' },
        }));
        record.brk = record.slot.querySelector('[data-board-diagram-break]');
        if (!record.brk) return;
        const button = record.brk;
        ['pointerdown', 'pointerup', 'dblclick'].forEach((type) => button.addEventListener(type, (event) => event.stopPropagation()));
        button.addEventListener('click', (event) => { event.stopPropagation(); void breakApart(record.id); });
      }
      paintBreak(record, editable, hasScene);
    }

    function setBreaking(id, on) {
      if (on) breaking.add(id); else breaking.delete(id);
      const record = shown.get(id);
      const card = ctx.editor.getBoard() && ctx.editor.getBoard().cards[id];
      if (record) paintBreak(record, ctx.editor.canEdit(), Boolean(card && card.data && String(card.data.scene || '').trim()));
    }

    async function breakApart(id) {
      if (breaking.has(id) || gone || !ctx.editor.canEdit() || !breakModule) return;
      const card = ctx.editor.getBoard().cards[id];
      const scene = card && card.kind === 'diagram' ? String(card.data.scene || '') : '';
      if (!scene.trim()) return;
      const failed = () => tell(jt('board.diagram.breakFailed', 'This drawing could not be read, so it was not broken apart.'), 'warning');
      setBreaking(id, true);
      try {
        const outline = await pictures.outline(scene);
        if (gone) return;
        if (!outline.ok) {
          if (outline.reason === 'unavailable') tell(say('unavailable'), 'warning'); else failed();
          return;
        }
        const board = ctx.editor.getBoard();
        const now = board && board.cards[id];
        if (!now || now.kind !== 'diagram') return; // the card went while the drawing was read
        if (now.data.scene !== scene) { failed(); return; }
        const built = breakModule.buildParts({ card: now, outline, board, limits: own.limits || modelLimits() || {}, makeId: own.makeId || (() => globalThis.crypto.randomUUID()) });
        if (!built.ok) {
          if (built.reason === 'empty') tell(jt('board.diagram.breakEmpty', 'This drawing has nothing to break apart.'), 'warning');
          else if (built.reason === 'too_many') tell(jt('board.diagram.breakTooMany', 'This drawing is too large to break apart on this board.'), 'warning');
          else failed();
          return;
        }
        const result = await ctx.editor.applyParts(built.ops, built.selectIds); // a refusal is told by the editor
        if (result && result.ok && !gone && built.selectIds.length) ctx.host.reveal(built.selectIds[0]);
      } finally {
        setBreaking(id, false);
      }
    }

    function decorate(element, card, state) {
      const slot = ctx.boardCard.media(element);
      if (!slot) return;
      let record = shown.get(card.id);
      if (!record || record.slot !== slot) {
        record = makeRecord(card.id, slot);
        shown.set(card.id, record);
      }
      const data = card.data || {};
      const scene = typeof data.scene === 'string' ? data.scene : '';
      record.title = typeof data.title === 'string' ? data.title : '';
      ensureEditButton(record, Boolean(state && state.editable));
      ensureBreakButton(record, Boolean(state && state.editable), Boolean(scene.trim()));
      if (!scene.trim()) {
        pictures.release(card.id);
        paint(record, { status: 'empty', url: '' });
        return;
      }
      paint(record, pictures.hold(card.id, scene, (next) => paint(record, next)));
    }

    function release(id) {
      pictures.release(id);
      shown.delete(id);
      sessions.forEach((session) => { if (session.id === id) close(session, false); });
    }

    /* ---------------------------------------------------------------- open live */

    function openLive(card, origin) {
      const data = card.data || {};
      const returnFocus = origin === 'outline' ? null : ctx.host.itemElement(card.id);
      const unavailable = () => tell(jt('board.diagram.openUnavailable', 'The live drawing is not available right now.'), 'warning');
      const api = () => {
        const found = own.getOpen ? own.getOpen() : (win.rendererSketchOpen || globalThis.rendererSketchOpen);
        return found && typeof found.openLarge === 'function' ? found : null;
      };
      const open = (viewer) => {
        let ok;
        try { ok = viewer.openLarge({ source: String(data.scene || ''), title: String(data.title || ''), returnFocus }); } catch (_error) { ok = false; }
        if (ok === false) unavailable();
      };
      const now = api();
      if (now) { open(now); return; }
      // The viewer comes with the sketch host, which loads on first use.
      pictures.ensureHost().then(() => { const later = api(); if (later) open(later); else unavailable(); });
    }

    /* ---------------------------------------------------------------- the source editor */

    function field(session, name) { return session.wrapper.querySelector(`[data-board-field="${name}"]`); }
    function setStatus(session, text) {
      session.status.textContent = text || '';
      session.status.hidden = !text;
    }

    function makeField(name, label, value, maxLength, single) {
      const el = doc.createElement('textarea');
      el.className = single ? 'board-card-editor__field' : 'board-card-editor__field board-diagram-editor__source';
      el.setAttribute('data-board-field', name);
      el.setAttribute('aria-label', label);
      el.setAttribute('spellcheck', 'false');
      el.setAttribute('wrap', single ? 'soft' : 'off');
      el.rows = single ? 1 : 8;
      el.maxLength = maxLength;
      el.value = value;
      if (single) el.setAttribute('data-board-single-line', '');
      return el;
    }

    function build(session, card) {
      const w = session.wrapper;
      w.className = 'board-card-editor board-card-editor--diagram';
      w.setAttribute('data-board-editor', '');
      w.setAttribute('data-editing', session.id);
      w.appendChild(makeField('title', jt('board.diagram.titleLabel', 'Drawing title'), card.data.title || '', TITLE_CHARS, true));
      w.appendChild(makeField('scene', jt('board.diagram.sourceLabel', 'Drawing source'), card.data.scene || '', SCENE_CHARS, false));
      session.status = doc.createElement('p');
      session.status.className = 'board-card-editor__status';
      session.status.setAttribute('role', 'status');
      session.status.hidden = true;
      w.appendChild(session.status);
      const hint = doc.createElement('p');
      hint.className = 'board-card-editor__hint';
      hint.textContent = jt('board.diagram.hint', 'Ctrl+Enter saves. Esc cancels.');
      w.appendChild(hint);
    }

    function close(session, refocus) {
      if (!sessions.delete(session)) return;
      session.wrapper.remove();
      if (refocus && typeof ctx.host.focusItem === 'function') ctx.host.focusItem(session.id);
    }

    function refusalText(result) {
      return limitText(result && result.limit) || (result && result.message) || jt('board.diagram.saveFailed', 'The drawing could not be saved. Try again.');
    }

    async function commit(session, origin) {
      if (!sessions.has(session) || session.busy) return;
      const board = ctx.editor.getBoard();
      const card = board && board.cards[session.id];
      if (!card) { close(session, false); return; }
      const data = {};
      const scene = field(session, 'scene').value;
      const title = field(session, 'title').value.trim();
      if (scene !== card.data.scene) data.scene = scene;
      if (title !== card.data.title) data.title = title;
      if (!Object.keys(data).length) { close(session, origin === 'key'); return; }
      session.busy = true;
      const result = await ctx.editor.editCard(session.id, data, session.base);
      session.busy = false;
      if (!sessions.has(session)) return;
      if (result && result.ok) { close(session, origin === 'key'); return; }
      setStatus(session, refusalText(result));
      if (origin === 'key') field(session, 'scene').focus({ preventScroll: true });
    }

    function wire(session) {
      const w = session.wrapper;
      const stop = (event) => event.stopPropagation();
      ['pointerdown', 'pointerup', 'dblclick', 'wheel', 'keyup', 'click'].forEach((type) => w.addEventListener(type, stop));
      w.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(session, true); return; }
        const single = event.target && event.target.hasAttribute && event.target.hasAttribute('data-board-single-line');
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || (single && !event.shiftKey))) {
          event.preventDefault();
          void commit(session, 'key');
        }
      });
      w.addEventListener('input', (event) => {
        setStatus(session, '');
        const target = event.target;
        if (target && target.hasAttribute && target.hasAttribute('data-board-single-line') && /[\r\n]/.test(target.value)) target.value = target.value.replace(/[\r\n]+/g, ' ');
      });
      w.addEventListener('focusout', (event) => {
        if (event.relatedTarget && w.contains(event.relatedTarget)) return;
        void commit(session, 'blur');
      });
    }

    /** Opens the source editor of a diagram card; false when the board cannot be edited or the card is not drawn. */
    function openEditor(id) {
      if (!ctx.editor.canEdit()) return false;
      const board = ctx.editor.getBoard();
      const card = board && board.cards[id];
      const element = ctx.host.itemElement(id);
      if (!card || card.kind !== 'diagram' || !element) return false;
      for (const open of sessions) {
        if (open.id === id) { field(open, 'scene').focus({ preventScroll: true }); return true; }
        void commit(open, 'switch');
      }
      const session = { id, wrapper: doc.createElement('div'), status: null, busy: false, base: { rev: card.content_rev } };
      build(session, card);
      sessions.add(session);
      wire(session);
      element.appendChild(session.wrapper);
      const source = field(session, 'scene');
      source.focus({ preventScroll: true });
      source.setSelectionRange(source.value.length, source.value.length);
      return true;
    }

    /* ---------------------------------------------------------------- adding one */

    async function addDiagram() {
      const result = await ctx.editor.addCard({ kind: 'diagram', data: { scene: STARTER_SCENE, title: '' } });
      if (!result || !result.ok) return;
      ctx.host.reveal(result.id);
      openEditor(result.id);
    }

    return {
      kind: 'diagram',
      decorate,
      release,
      activate(card, origin) { openLive(card, origin); return true; },
      shown: pictures.shown, // a parked page sweeps a theme change once it is back
      tools: [{ id: 'diagram', label: jt('board.diagram.tool', 'Diagram'), title: jt('board.diagram.toolTitle', 'Add a diagram'), order: 40, run: addDiagram }],
      dispose() {
        gone = true;
        breaking.clear();
        Array.from(sessions).forEach((session) => close(session, false));
        pictures.dispose();
        shown.clear();
      },
    };
  }

  if (kinds && typeof kinds.register === 'function') kinds.register('diagram', (ctx) => createDiagramPart(ctx));

  return { createDiagramPart, STARTER_SCENE };
});
