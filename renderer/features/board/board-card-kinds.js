/* renderer/features/board/board-card-kinds.js - how a card kind adds its own parts to the board (UMD, global
 * rendererBoardCardKinds).
 *
 * The canvas, the toolbar and the outline know notes, links and groups. Everything a file, picture, chat or
 * diagram card needs beyond a title and a line of text (a picture in the card, what Enter does, a toolbar button,
 * paste and drop) comes from a kind module that registers here when it loads:
 *
 *   rendererBoardCardKinds.register('image', (ctx) => ({ kind: 'image', decorate(element, card, state) {...} }));
 *
 * The page builds the parts once per board page, when the editor exists (createBoardCardKinds(ctx)). ctx is
 *   { document, windowRef, editor, source, notify, log, jt, actionButton, boardCard, surface, host, context }
 * where `host` is the canvas's { itemElement(id), getBoard(), focusItem(id), reveal(id), startEdit(id), redraw() }
 * and `context` is the page's { state, getProjectId() }.
 *
 * What a part may have, all optional:
 *   kind                       the one card kind decorate, props and activate are called for; without it, every kind
 *   props(card)                extra boardCard props for this card (for example { missing: true }); call
 *                              host.redraw() when the answer changes
 *   decorate(element, card, state)  the card's element was drawn or its content, size or editability changed.
 *                              state is { editable }. Put a picture in boardCard.media(element)
 *   release(id)                that card left the canvas (it may be one the part never decorated)
 *   activate(card, origin)     Enter or a double-click on a card that has no inline editor; origin is 'canvas'
 *                              or 'outline'. Return true when handled
 *   tools                      toolbar buttons: [{ id, label, title, order, run() }], sorted by order. A button is
 *                              disabled while the board cannot be changed
 *   shown(isShown)             the page was hidden (false) or shown again (true): stop and catch up
 *   dispose()                  the page is going away: remove listeners, revoke object URLs
 *
 * A part that throws costs only itself: the call is logged and the others still run.
 *
 * On a team board (row 151 slice T7: `ctx.context.getTeamSource()` answers the source) every card's root carries a tooltip saying who
 * added it and, when another member changed it last, who did. Nothing is added on a board of one's own. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardCardKinds = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const factories = new Map(); // name -> factory, in registration order
  const fallbackJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  /** A kind module calls this once when it loads. Registering a name again replaces the earlier factory. */
  function register(name, factory) {
    if (typeof name !== 'string' || !name || typeof factory !== 'function') return false;
    factories.set(name, factory);
    return true;
  }

  function createBoardCardKinds(ctx) {
    const context = ctx || {};
    const log = typeof context.log === 'function' ? context.log : () => {};
    const failed = (name, step) => log('WARN', 'board.card_kind_failed', { name, step });
    const parts = [];
    (context.factories || factories).forEach((factory, name) => {
      try {
        const part = factory(context);
        if (part && typeof part === 'object') parts.push({ name, part });
      } catch (_error) { failed(name, 'create'); }
    });
    const drawn = new Map(); // card id -> what decorate last saw
    let disposed = false;
    let visible = true;
    const jt = typeof context.jt === 'function' ? context.jt : fallbackJt;
    const page = context.context || {};

    // The tooltip of a team board's card: who added it, and who changed it last when that is someone else ('' off a team board).
    function attribution(card) {
      const team = typeof page.getTeamSource === 'function' ? page.getTeamSource() : null;
      if (!team) return '';
      const you = jt('board.team.youLower', 'you');
      const who = (id) => {
        // A card this page just made (before the host echoes it) and this member's own id: asked by id, never by a name.
        if (id === 'owner' || (typeof page.isSelfMember === 'function' && page.isSelfMember(id) === true)) return { self: true, name: you };
        const name = typeof page.nameOfMember === 'function' ? String(page.nameOfMember(id) || '') : '';
        return { self: false, name: name || jt('board.team.formerMember', 'a former member') };
      };
      const added = who(card.created_by);
      const other = who(card.updated_by);
      const changed = card.updated_by && card.updated_by !== card.created_by && !(added.self && other.self);
      return changed ? jt('board.team.addedByChanged', 'Added by {name}. Last changed by {other}.', { name: added.name, other: other.name }) : jt('board.team.addedBy', 'Added by {name}', { name: added.name });
    }

    const marked = new Set(); // ids of the cards that carry the tooltip
    function markBy(element, id, tip) {
      if (tip) {
        if (element.getAttribute('title') !== tip) element.setAttribute('title', tip);
        marked.add(id);
      } else if (marked.delete(id)) {
        element.removeAttribute('title');
      }
    }

    function call(entry, method, args) {
      if (typeof entry.part[method] !== 'function') return undefined;
      try { return entry.part[method](...args); } catch (_error) { failed(entry.name, method); return undefined; }
    }
    const takes = (entry, card) => !entry.part.kind || entry.part.kind === card.kind;

    const tools = [];
    parts.forEach((entry) => {
      const list = Array.isArray(entry.part.tools) ? entry.part.tools : [];
      list.forEach((tool) => {
        if (!tool || typeof tool.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(tool.id) || typeof tool.run !== 'function') return;
        if (tools.some((known) => known.id === tool.id)) return;
        tools.push({
          id: tool.id, label: String(tool.label || tool.id), title: String(tool.title || tool.label || tool.id),
          order: Number.isFinite(tool.order) ? tool.order : 100,
          run: () => { try { return Promise.resolve(tool.run()).catch(() => { failed(entry.name, `tool:${tool.id}`); }); } catch (_error) { failed(entry.name, `tool:${tool.id}`); return Promise.resolve(); } },
        });
      });
    });
    tools.sort((a, b) => a.order - b.order);

    return {
      /** Extra boardCard props for a card, from the parts of its kind. */
      props(card) {
        const extra = {};
        if (disposed || !card) return extra;
        parts.forEach((entry) => {
          const own = takes(entry, card) ? call(entry, 'props', [card]) : null;
          if (own && typeof own === 'object') Object.assign(extra, own);
        });
        return extra;
      },
      /** Called on every draw; a card whose content, size and editability did not change is skipped. */
      decorate(element, card, state) {
        if (disposed || !element || !card) return;
        const editable = Boolean(state && state.editable);
        const tip = attribution(card);
        const key = `${card.kind}|${card.content_rev}|${card.w}|${card.h}|${editable ? 1 : 0}${tip ? `|${tip}` : ''}`;
        if (drawn.get(card.id) === key) return;
        drawn.set(card.id, key);
        markBy(element, card.id, tip);
        parts.forEach((entry) => { if (takes(entry, card)) call(entry, 'decorate', [element, card, { editable }]); });
      },
      release(id) {
        if (disposed || !drawn.delete(id)) return;
        marked.delete(id);
        parts.forEach((entry) => call(entry, 'release', [id]));
      },
      activate(card, origin) {
        if (disposed || !card) return false;
        return parts.some((entry) => takes(entry, card) && call(entry, 'activate', [card, origin || 'canvas']) === true);
      },
      /** The page was hidden or shown again; a repeat of the current value is ignored. */
      setShown(isShown) {
        const next = isShown !== false;
        if (disposed || next === visible) return;
        visible = next;
        parts.forEach((entry) => call(entry, 'shown', [next]));
      },
      tools: () => tools.slice(),
      names: () => parts.map((entry) => entry.name),
      dispose() {
        if (disposed) return;
        disposed = true;
        parts.forEach((entry) => call(entry, 'dispose', []));
        drawn.clear();
      },
    };
  }

  return { register, createBoardCardKinds };
});
