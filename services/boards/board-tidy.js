/* services/boards/board-tidy.js – arranging board cards in an even grid (UMD, global jennyBoardTidy)
 *
 * Row 150 slice B9. `tidyOps(board, target)` answers { ok: true, ops } or { ok: false, reason } and never throws or touches
 * the board. The operations are only `card.place` and `group.place`, carrying only the fields that change, so they go through
 * the model's applyBatch like any other batch and one undo puts everything back. The renderer's Tidy tool and (through another
 * slice) an accepted `tidy` proposal call this same function.
 *
 *   { groupId }  the cards of that group in a grid inside it; the group is resized to fit them (its x and y stay)
 *   { ids }      the same grid for chosen cards, from the top-left corner of their box; cards that belong to a group are left
 *                out unless every listed card sits in one group: those are arranged where they are (from their own corner,
 *                so members that were not listed are not covered from the group's corner) and the group is resized
 *   {}           every group tidied, then groups and loose cards packed as blocks into rows
 *
 * Reading order is top to bottom, then left to right: cards whose tops are within half a card height share a row.
 * Pure geometry: no DOM, no IO, no clock. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBoardTidy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // These three must stay equal to GAP, PAD and HEADER of board-placement.js (a test pins them against a group the model placed).
  var GAP = 24;
  var PAD = 16;
  var HEADER = 40;
  var BATCH_OPS = 200; // LIMITS.batch_ops of board-model.js
  var ROW_WIDTH = 1600;
  var COORD_MAX = 1e6;

  function fail(reason) { return { ok: false, reason: reason }; }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function num(v) { return typeof v === 'number' && isFinite(v) && Math.abs(v) <= COORD_MAX; }
  function size(v) { return typeof v === 'number' && isFinite(v) && v > 0 && v <= COORD_MAX; }
  function key(v) { return typeof v === 'string' && v.length > 0 && v.length <= 200 && v !== '__proto__'; }

  /** Reads the board's cards and groups into plain lists, or null when anything about them is unreadable. */
  function read(board) {
    if (!isObj(board) || !isObj(board.cards) || !isObj(board.groups)) return null;
    var cards = Object.create(null);
    var groups = Object.create(null);
    var ids = Object.keys(board.groups);
    for (var g = 0; g < ids.length; g++) {
      var group = board.groups[ids[g]];
      if (!key(ids[g]) || !isObj(group) || group.id !== ids[g] || !num(group.x) || !num(group.y) || !size(group.w) || !size(group.h)) return null;
      groups[ids[g]] = { id: group.id, alias: group.alias, x: group.x, y: group.y, w: group.w, h: group.h };
    }
    ids = Object.keys(board.cards);
    for (var c = 0; c < ids.length; c++) {
      var card = board.cards[ids[c]];
      if (!key(ids[c]) || !isObj(card) || card.id !== ids[c] || !num(card.x) || !num(card.y) || !size(card.w) || !size(card.h)) return null;
      var groupId = typeof card.group_id === 'string' && groups[card.group_id] ? card.group_id : null;
      cards[ids[c]] = { id: card.id, alias: card.alias, x: card.x, y: card.y, w: card.w, h: card.h, group_id: groupId };
    }
    return { cards: cards, groups: groups };
  }

  function aliasNumber(item) {
    var m = typeof item.alias === 'string' ? /^[a-z](\d{1,9})$/.exec(item.alias) : null;
    return m ? Number(m[1]) : Infinity;
  }
  function byId(a, b) {
    var d = aliasNumber(a) - aliasNumber(b);
    if (d !== 0 && !isNaN(d)) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  /** Items in reading order: rows by top edge (a row holds the tops within half the first item's height), each row left to right. */
  function reading(items) {
    var sorted = items.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x || byId(a, b); });
    var out = [];
    var i = 0;
    while (i < sorted.length) {
      var anchor = sorted[i];
      var row = [anchor];
      i++;
      while (i < sorted.length && sorted[i].y < anchor.y + anchor.h / 2) row.push(sorted[i++]);
      row.sort(function (a, b) { return a.x - b.x || a.y - b.y || byId(a, b); });
      out = out.concat(row);
    }
    return out;
  }

  /** A grid for `items` (reading order) from (ox, oy): { at: { id: {x, y} }, w, h }. Cells fit the widest and tallest. */
  function grid(items, ox, oy) {
    var list = reading(items);
    var cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
    var colW = [];
    var rowH = [];
    list.forEach(function (item, i) {
      var c = i % cols;
      var r = Math.floor(i / cols);
      colW[c] = Math.max(colW[c] || 0, Math.ceil(item.w));
      rowH[r] = Math.max(rowH[r] || 0, Math.ceil(item.h));
    });
    var colX = [];
    var x = 0;
    colW.forEach(function (w, c) { colX[c] = x; x += w + GAP; });
    var rowY = [];
    var y = 0;
    rowH.forEach(function (h, r) { rowY[r] = y; y += h + GAP; });
    var at = Object.create(null);
    list.forEach(function (item, i) { at[item.id] = { x: Math.round(ox + colX[i % cols]), y: Math.round(oy + rowY[Math.floor(i / cols)]) }; });
    return { at: at, w: Math.max(0, x - GAP), h: Math.max(0, y - GAP) };
  }

  /** Where a group's cards go (`only`: the listed ones, the rest stay) and the box that then holds every member. */
  function groupLayout(model, group, only) {
    var members = Object.keys(model.cards).map(function (id) { return model.cards[id]; }).filter(function (card) { return card.group_id === group.id; });
    var chosen = only ? members.filter(function (card) { return only[card.id] === true; }) : members;
    if (!members.length) return { at: Object.create(null), box: { x: group.x, y: group.y, w: group.w, h: group.h } };
    var ox = group.x + PAD;
    var oy = group.y + HEADER;
    if (only && chosen.length) {
      ox = Math.max(ox, Math.min.apply(null, chosen.map(function (card) { return card.x; })));
      oy = Math.max(oy, Math.min.apply(null, chosen.map(function (card) { return card.y; })));
    }
    var laid = grid(chosen, ox, oy);
    var right = group.x;
    var bottom = group.y;
    members.forEach(function (card) {
      var spot = laid.at[card.id] || card;
      right = Math.max(right, spot.x + card.w);
      bottom = Math.max(bottom, spot.y + card.h);
    });
    return { at: laid.at, box: { x: group.x, y: group.y, w: Math.ceil(right + PAD - group.x), h: Math.ceil(bottom + PAD - group.y) } };
  }

  function moveOps(ops, model, at) {
    Object.keys(at).forEach(function (id) {
      var card = model.cards[id];
      if (card.x !== at[id].x || card.y !== at[id].y) ops.push({ op: 'card.place', id: id, x: at[id].x, y: at[id].y });
    });
  }

  function boxOp(group, box) {
    var op = { op: 'group.place', id: group.id };
    if (group.x !== box.x || group.y !== box.y) { op.x = box.x; op.y = box.y; }
    if (group.w !== box.w || group.h !== box.h) { op.w = box.w; op.h = box.h; }
    return Object.keys(op).length > 2 ? op : null;
  }

  function tidyGroup(model, groupId, only) {
    var group = model.groups[groupId];
    var laid = groupLayout(model, group, only);
    var ops = [];
    moveOps(ops, model, laid.at);
    var place = boxOp(group, laid.box);
    if (place) ops.push(place);
    return ops;
  }

  function tidyCards(model, listed) {
    var cards = listed.map(function (id) { return model.cards[id]; });
    var first = cards[0].group_id;
    if (first !== null && cards.every(function (card) { return card.group_id === first; })) {
      var only = Object.create(null);
      cards.forEach(function (card) { only[card.id] = true; });
      return tidyGroup(model, first, only);
    }
    var loose = cards.filter(function (card) { return card.group_id === null; });
    if (!loose.length) return [];
    var ox = Math.min.apply(null, loose.map(function (card) { return card.x; }));
    var oy = Math.min.apply(null, loose.map(function (card) { return card.y; }));
    var ops = [];
    moveOps(ops, model, grid(loose, ox, oy).at);
    return ops;
  }

  /** Every group tidied, then groups and loose cards packed into rows from the top-left corner of the board's content. */
  function tidyBoard(model) {
    var groups = Object.keys(model.groups).map(function (id) { return model.groups[id]; });
    var cards = Object.keys(model.cards).map(function (id) { return model.cards[id]; });
    if (!groups.length && !cards.length) return [];
    var ox = Infinity;
    var oy = Infinity;
    groups.concat(cards).forEach(function (item) { ox = Math.min(ox, item.x); oy = Math.min(oy, item.y); });
    var blocks = [];
    var layouts = Object.create(null);
    groups.forEach(function (group) {
      var laid = groupLayout(model, group, null);
      layouts[group.id] = laid;
      blocks.push({ id: group.id, group: group, x: group.x, y: group.y, w: laid.box.w, h: laid.box.h, alias: group.alias });
    });
    cards.filter(function (card) { return card.group_id === null; }).forEach(function (card) {
      blocks.push({ id: card.id, card: card, x: card.x, y: card.y, w: Math.ceil(card.w), h: Math.ceil(card.h), alias: card.alias });
    });
    var width = Math.max(ROW_WIDTH, Math.max.apply(null, blocks.map(function (block) { return block.w; })));
    var ops = [];
    var cx = ox;
    var cy = oy;
    var rowH = 0;
    reading(blocks).forEach(function (block) {
      if (cx > ox && cx + block.w > ox + width) { cx = ox; cy += rowH + GAP; rowH = 0; }
      var spot = { x: Math.round(cx), y: Math.round(cy) };
      if (block.card) {
        if (block.card.x !== spot.x || block.card.y !== spot.y) ops.push({ op: 'card.place', id: block.id, x: spot.x, y: spot.y });
      } else {
        var laid = layouts[block.id];
        var dx = spot.x - block.group.x;
        var dy = spot.y - block.group.y;
        var at = Object.create(null);
        Object.keys(laid.at).forEach(function (id) { at[id] = { x: laid.at[id].x + dx, y: laid.at[id].y + dy }; });
        moveOps(ops, model, at);
        var place = boxOp(block.group, { x: spot.x, y: spot.y, w: laid.box.w, h: laid.box.h });
        if (place) ops.push(place);
      }
      cx += block.w + GAP;
      rowH = Math.max(rowH, block.h);
    });
    return ops;
  }

  function targetOps(model, target) {
    var keys = Object.keys(target);
    if (!keys.length) return { ops: tidyBoard(model) };
    if (keys.length !== 1) return { error: fail('invalid') };
    if (keys[0] === 'groupId') {
      if (!key(target.groupId)) return { error: fail('invalid') };
      return model.groups[target.groupId] ? { ops: tidyGroup(model, target.groupId, null) } : { error: fail('not_found') };
    }
    if (keys[0] !== 'ids' || !Array.isArray(target.ids) || !target.ids.length || target.ids.length > 1000 || !target.ids.every(key)) return { error: fail('invalid') };
    var listed = [];
    var seen = Object.create(null);
    target.ids.forEach(function (id) {
      if (model.cards[id] && !seen[id]) { seen[id] = true; listed.push(id); }
    });
    return listed.length ? { ops: tidyCards(model, listed) } : { error: fail('not_found') };
  }

  /** The operations that tidy `board` as `target` asks, or a refusal: invalid, not_found or too_many. */
  function tidyOps(board, target) {
    try {
      var model = read(board);
      if (!model || !isObj(target)) return fail('invalid');
      var out = targetOps(model, target);
      if (out.error) return out.error;
      return out.ops.length > BATCH_OPS ? fail('too_many') : { ok: true, ops: out.ops };
    } catch (e) {
      return fail('invalid');
    }
  }

  return { tidyOps: tidyOps, GAP: GAP, PAD: PAD, HEADER: HEADER };
});
