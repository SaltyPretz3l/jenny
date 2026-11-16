/* services/boards/board-placement.js – where new board cards and groups go (UMD)
 *
 * Plan PROJECT_BOARD_2026-11-13 section 6.1: Jenny never writes coordinates. A new card goes inside
 * its named group (which grows to hold it), else next to the first card it connects to, else in free
 * space to the right of the board's content. The group comes first so a member always sits inside its
 * group's box. Deterministic, and never on top of an existing card except at the edge of the
 * coordinate range, where a spot is pulled back inside it.
 * A person's placement is never moved: placement only picks spots for items that have none.
 *
 * Pure geometry: no DOM, no IO. `placeOne` reads a working state ({ cards, groups, run }) that the
 * caller owns; `run` carries the free-space column across one batch so free adds stack downwards.
 * Loaded directly by board-model.js, which re-exports `placeNewCards`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBoardPlacement = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var GAP = 24;
  var PAD = 16;
  var HEADER = 40;
  var NEAR_STEPS = 20;
  var GROUP_ROWS_MAX = 600;
  var FREE_STEPS_MAX = 10000;
  var ADDS_MAX = 2000;
  var SIZE_MIN = 8;
  var SIZE_MAX = 1e6;
  var COORD_MAX = 1e6; // board-model.js refuses a stored coordinate past this
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var hasOwn = Object.prototype.hasOwnProperty;

  var DEFAULT_SIZES = Object.freeze({
    note: Object.freeze({ w: 240, h: 160 }),
    file: Object.freeze({ w: 260, h: 72 }),
    image: Object.freeze({ w: 320, h: 240 }),
    link: Object.freeze({ w: 260, h: 72 }),
    chat: Object.freeze({ w: 280, h: 140 }),
    diagram: Object.freeze({ w: 360, h: 260 }),
    group: Object.freeze({ w: 480, h: 320 }),
  });

  function own(map, key) {
    return map && typeof key === 'string' && hasOwn.call(map, key) ? map[key] : undefined;
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  function firstHit(rect, list) {
    for (var i = 0; i < list.length; i++) if (overlaps(rect, list[i])) return list[i];
    return null;
  }

  function rects(map) {
    var out = [];
    for (var key in map) if (hasOwn.call(map, key)) out.push(map[key]);
    return out;
  }

  function contentBox(list) {
    if (!list.length) return null;
    var right = -Infinity;
    var top = Infinity;
    for (var i = 0; i < list.length; i++) {
      right = Math.max(right, list[i].x + list[i].w);
      top = Math.min(top, list[i].y);
    }
    return { right: right, top: top };
  }

  function nearSpot(anchor, size, cards) {
    var right = anchor.x + anchor.w + GAP;
    var below = anchor.y + anchor.h + GAP;
    var tries = [
      [right, anchor.y],
      [anchor.x, below],
      [anchor.x - GAP - size.w, anchor.y],
      [anchor.x, anchor.y - GAP - size.h],
    ];
    for (var k = 1; k <= NEAR_STEPS; k++) {
      tries.push([right, anchor.y + k * (size.h + GAP)]);
      tries.push([anchor.x + k * (size.w + GAP), below]);
    }
    for (var i = 0; i < tries.length; i++) {
      var rect = { x: tries[i][0], y: tries[i][1], w: size.w, h: size.h };
      if (!firstHit(rect, cards)) return rect;
    }
    return null;
  }

  function groupSpot(group, size, cards) {
    var ox = group.x + PAD;
    var oy = group.y + HEADER;
    var cols = Math.max(1, Math.floor((group.w - 2 * PAD + GAP) / (size.w + GAP)));
    for (var r = 0; r < GROUP_ROWS_MAX; r++) {
      for (var c = 0; c < cols; c++) {
        var rect = { x: ox + c * (size.w + GAP), y: oy + r * (size.h + GAP), w: size.w, h: size.h };
        if (!firstHit(rect, cards)) return rect;
      }
    }
    return null;
  }

  function freeSpot(run, size, all) {
    if (!run.col) {
      var box = contentBox(all);
      run.col = { x: box ? box.right + 2 * GAP : 0, y: box ? box.top : 0 };
    }
    var rect = { x: run.col.x, y: run.col.y, w: size.w, h: size.h };
    for (var i = 0; i < FREE_STEPS_MAX; i++) {
      var hit = firstHit(rect, all);
      if (!hit) break;
      rect.y = hit.y + hit.h + GAP;
    }
    run.col.y = rect.y + size.h + GAP;
    return rect;
  }

  function growFor(group, rect) {
    var w = Math.max(group.w, rect.x + rect.w + PAD - group.x);
    var h = Math.max(group.h, rect.y + rect.h + PAD - group.y);
    return w > group.w || h > group.h ? { id: group.id, w: Math.min(w, SIZE_MAX), h: Math.min(h, SIZE_MAX) } : null;
  }

  /** One spot for one new item. item: { w, h, group_id?, near? } (a group passes neither). */
  function placeOne(state, item) {
    var size = { w: item.w, h: item.h };
    var cards = rects(state.cards);
    var group = item.group_id ? own(state.groups, item.group_id) : undefined;
    var spot = group ? groupSpot(group, size, cards) : null;
    if (spot) return inRange(spot, growFor(group, spot));
    var anchor = item.near ? own(state.cards, item.near) : undefined;
    if (anchor) spot = nearSpot(anchor, size, cards);
    if (spot) return inRange(spot, null);
    return inRange(freeSpot(state.run, size, cards.concat(rects(state.groups))), null);
  }

  function inRange(spot, grow) {
    var clamp = function (v) { return Math.max(-COORD_MAX, Math.min(COORD_MAX, v)); };
    return { x: clamp(spot.x), y: clamp(spot.y), grow: grow };
  }

  function sizeOr(value, fallback) {
    return typeof value === 'number' && isFinite(value) && value >= SIZE_MIN && value <= SIZE_MAX ? value : fallback;
  }

  /**
   * Positions for items about to be added, in order, each seeing the ones before it.
   * adds: [{ id, kind } | { id, type: 'group' }, with optional w, h, group_id (cards) and near (a card id)].
   * Returns { ok, positions: { id: {x,y,w,h} }, grown: { groupId: {x,y,w,h} } } or { ok: false, reason }.
   */
  function placeNewCards(board, adds) {
    if (!board || typeof board !== 'object' || !board.cards || !board.groups || !Array.isArray(adds) || adds.length > ADDS_MAX) {
      return { ok: false, reason: 'invalid' };
    }
    var state = { cards: Object.assign({}, board.cards), groups: Object.assign({}, board.groups), run: { col: null } };
    var positions = {};
    var grown = {};
    for (var i = 0; i < adds.length; i++) {
      var add = adds[i];
      if (!add || typeof add !== 'object' || typeof add.id !== 'string' || !UUID_RE.test(add.id)) return { ok: false, reason: 'invalid' };
      var isGroup = add.type === 'group';
      var def = isGroup ? DEFAULT_SIZES.group : own(DEFAULT_SIZES, add.kind);
      if (!def || add.kind === 'group') return { ok: false, reason: 'invalid' };
      var w = sizeOr(add.w, def.w);
      var h = sizeOr(add.h, def.h);
      var p = placeOne(state, { w: w, h: h, group_id: isGroup ? null : add.group_id, near: isGroup ? null : add.near });
      var rect = { id: add.id, x: p.x, y: p.y, w: w, h: h };
      positions[add.id] = { x: p.x, y: p.y, w: w, h: h };
      if (isGroup) state.groups[add.id] = rect;
      else state.cards[add.id] = rect;
      if (p.grow) {
        var g = state.groups[p.grow.id];
        state.groups[g.id] = Object.assign({}, g, { w: p.grow.w, h: p.grow.h });
        grown[g.id] = { x: g.x, y: g.y, w: p.grow.w, h: p.grow.h };
      }
    }
    return { ok: true, positions: positions, grown: grown };
  }

  return {
    DEFAULT_SIZES: DEFAULT_SIZES,
    placeOne: placeOne,
    placeNewCards: placeNewCards,
  };
});
