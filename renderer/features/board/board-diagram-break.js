/* renderer/features/board/board-diagram-break.js - turns a drawing's outline into board operations (UMD, global
 * rendererBoardDiagramBreak).
 *
 * "Break apart" on a diagram card makes the drawing's shapes ordinary note cards, its groups board groups and its arrows
 * connectors, which can then be edited one by one. The structure of a drawing comes only from the sketch frame (its `outline`
 * message, read by board-card-diagram-pictures.js); this module is the pure builder from that outline to one batch of the
 * model's existing operations, and nothing else: no DOM, no IO, no second parser.
 *
 *   buildParts({ card, outline, board, makeId, limits }) -> { ok: true, ops, selectIds } | { ok: false, reason }
 *
 * outline is { nodes: [{ id, label, group }], groups: [{ id, label, parent }], edges: [{ from, to, label, dashed }],
 * positions: { nodeId: { x, y } } | null } (positions are the top-left corners the frame laid the shapes out at). The batch
 * adds the groups, then the notes (each in its innermost group: the board has no nesting), then the connectors, and removes the
 * diagram card last, so one Undo brings the card back and removes every part. A drawing that is one chain of steps is laid
 * out as a row (services/boards/board-flow-layout.js, the layout an accepted proposal gets). The parts take the card's own
 * place when nothing else is in the way: they then stay in the card's group, which grows to hold them. Otherwise the cluster
 * goes to the right of everything already on the board, at the card's height. A connector that ended on the card is drawn
 * again to the part nearest its other end. Refusals: empty, too_many, invalid. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../../../services/boards/board-flow-layout'));
    return;
  }
  root.rendererBoardDiagramBreak = factory(root.jennyBoardFlowLayout);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (flow) {
  'use strict';

  // GAP, PAD and HEADER must stay equal to the constants of services/boards/board-placement.js.
  const GAP = 24;
  const PAD = 16;
  const HEADER = 40;
  const NOTE_W = 200;
  const NOTE_H = 88;
  const MARGIN = 96;
  const TITLE_MAX = 200;
  const LABEL_MAX = 200;
  const NOTE_MAX = 4000;
  const BATCH_OPS = 200;
  const SCALE_MAX = 30;
  const COORD_MAX = 1e6;
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fail = (reason) => ({ ok: false, reason });

  /* ---------------------------------------------------------------- text */

  // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
  const LINE_BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
  // eslint-disable-next-line no-control-regex -- a note keeps \n and \t only.
  const TEXT_BAD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

  function oneLine(value, max) {
    return typeof value === 'string' ? value.replace(LINE_BAD, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max).trim() : '';
  }
  function noteText(label, id) {
    const text = typeof label === 'string' ? label.replace(TEXT_BAD, '').trim().slice(0, NOTE_MAX).trim() : '';
    return text || oneLine(id, NOTE_MAX) || 'Note';
  }

  /* ---------------------------------------------------------------- geometry */

  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const near = (a, b) => a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;

  /** The drawing's corners scaled up until no two notes are closer than GAP, or null when that cannot be done. */
  function scaled(nodes, positions) {
    if (!isObj(positions) || !nodes.length) return null;
    const points = [];
    for (const node of nodes) {
      const p = has(positions, node.id) ? positions[node.id] : null;
      if (!isObj(p) || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > COORD_MAX || Math.abs(p.y) > COORD_MAX) return null;
      points.push(p);
    }
    let factor = 1;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const dx = Math.abs(points[i].x - points[j].x);
        const dy = Math.abs(points[i].y - points[j].y);
        const need = Math.min(dx === 0 ? Infinity : (NOTE_W + GAP) / dx, dy === 0 ? Infinity : (NOTE_H + GAP) / dy);
        if (need === Infinity) return null;
        factor = Math.max(factor, need);
      }
    }
    for (let attempt = 0; attempt < 6 && factor <= SCALE_MAX; attempt += 1, factor *= 1.02) {
      const rects = points.map((p) => ({ x: Math.round(p.x * factor), y: Math.round(p.y * factor), w: NOTE_W, h: NOTE_H }));
      if (rects.every((a, i) => rects.slice(i + 1).every((b) => !near(a, b)))) return rects;
    }
    return null;
  }

  function gridRects(count, columns) {
    const cols = columns || Math.max(1, Math.ceil(Math.sqrt(count)));
    return Array.from({ length: count }, (_, i) => ({ x: (i % cols) * (NOTE_W + GAP), y: Math.floor(i / cols) * (NOTE_H + GAP), w: NOTE_W, h: NOTE_H }));
  }

  function boxOf(rects) {
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    return { x: x - PAD, y: y - HEADER, w: Math.max(...rects.map((r) => r.x + r.w)) - x + 2 * PAD, h: Math.max(...rects.map((r) => r.y + r.h)) - y + PAD + HEADER };
  }

  /** `members[k]` lists the note indices of group k; true when a note or another group's box sits in a group's box. */
  function crowded(rects, members, boxes) {
    return boxes.some((box, k) => boxes.slice(k + 1).some((other) => overlap(box, other))
      || rects.some((rect, i) => !members[k].includes(i) && overlap(rect, box)));
  }

  /** Groups side by side as blocks, each holding its notes in a small grid, then the free notes in a grid after them. */
  function blocks(count, members) {
    const rects = new Array(count);
    let cursor = 0;
    const boxes = members.map((list) => {
      const cells = gridRects(list.length);
      cells.forEach((cell, n) => { rects[list[n]] = { x: cell.x + cursor + PAD, y: cell.y + HEADER, w: NOTE_W, h: NOTE_H }; });
      const box = boxOf(list.map((i) => rects[i]));
      cursor = box.x + box.w + GAP;
      return box;
    });
    const used = new Set(members.flat());
    const free = Array.from({ length: count }, (_, i) => i).filter((i) => !used.has(i));
    gridRects(free.length).forEach((cell, n) => { rects[free[n]] = { x: cell.x + cursor, y: cell.y, w: NOTE_W, h: NOTE_H }; });
    return { rects, boxes };
  }

  /** One chain of steps as a row, or null when the drawing is anything else. */
  function row(nodes, edges) {
    if (!flow || typeof flow.flowLayout !== 'function') return null;
    const laid = flow.flowLayout({ nodes: nodes.map((node) => ({ id: node.id, w: NOTE_W, h: NOTE_H })),
      edges: edges.map((e) => ({ from: e.from, to: e.to, soft: e.dashed === true })) });
    return laid.flows.length === 1 && nodes.every((node) => laid.rects[node.id]) ? nodes.map((node) => laid.rects[node.id]) : null;
  }

  function layout(nodes, members, positions, edges) {
    const chain = members.length ? null : row(nodes, edges);
    if (chain) return { rects: chain, boxes: [] };
    const placed = scaled(nodes, positions);
    if (placed) {
      const boxes = members.map((list) => boxOf(list.map((i) => placed[i])));
      if (!crowded(placed, members, boxes)) return { rects: placed, boxes };
    }
    if (!members.length) return { rects: gridRects(nodes.length), boxes: [] };
    return blocks(nodes.length, members);
  }

  /** The right edge of everything on the board (and of the diagram card), then MARGIN beyond it. */
  function originX(board, card) {
    let right = card.x + card.w;
    for (const map of [board.cards, board.groups]) {
      for (const id of Object.keys(map)) right = Math.max(right, map[id].x + map[id].w);
    }
    return right + MARGIN;
  }

  /** The card's own corner when the parts fit there, with the box its group then needs; else null. */
  function inPlace(board, card, all, grouped) {
    const left = Math.min(...all.map((r) => r.x));
    const top = Math.min(...all.map((r) => r.y));
    const box = { x: card.x, y: card.y, w: Math.max(...all.map((r) => r.x + r.w)) - left, h: Math.max(...all.map((r) => r.y + r.h)) - top };
    const home = typeof card.group_id === 'string' && has(board.groups, card.group_id) ? board.groups[card.group_id] : null;
    if (home && grouped) return null; // the board has no group inside a group
    let grown = null;
    if (home) {
      const w = Math.max(home.w, box.x + box.w + PAD - home.x);
      const h = Math.max(home.h, box.y + box.h + PAD - home.y);
      if (w > home.w || h > home.h) grown = { x: home.x, y: home.y, w, h };
    }
    for (const id of Object.keys(board.cards)) {
      const other = board.cards[id];
      if (id === card.id) continue;
      if (near(box, other) || (grown && other.group_id !== home.id && overlap(grown, other))) return null;
    }
    for (const id of Object.keys(board.groups)) {
      if (home && id === home.id) continue;
      if (overlap(grown || box, board.groups[id]) || overlap(box, board.groups[id])) return null;
    }
    return { dx: card.x - left, dy: card.y - top, home, grown };
  }

  /** A connector that ended on the card, drawn again to the part nearest its other end. */
  function reattached(board, card, parts, makeId) {
    const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const centres = parts.map(centre);
    const seen = new Set();
    const out = [];
    for (const id of Object.keys(board.connectors)) {
      const con = board.connectors[id];
      if (!isObj(con) || (con.from === card.id) === (con.to === card.id)) continue;
      const leaves = con.from === card.id; // the connector starts on the card
      const otherId = leaves ? con.to : con.from;
      if (!has(board.cards, otherId)) continue;
      const at = centre(board.cards[otherId]);
      let best = 0;
      centres.forEach((c, i) => { if (Math.hypot(c.x - at.x, c.y - at.y) < Math.hypot(centres[best].x - at.x, centres[best].y - at.y)) best = i; });
      const line = { id: '', from: leaves ? parts[best].id : otherId, to: leaves ? otherId : parts[best].id, label: oneLine(con.label, LABEL_MAX),
        style: con.style === 'dashed' ? 'dashed' : 'solid', ends: con.ends === 'both' || con.ends === 'none' ? con.ends : 'end' };
      if (typeof con.tone === 'string' && con.tone) line.tone = con.tone;
      const key = [line.from, line.to, line.label, line.style, line.ends].join('>');
      if (seen.has(key)) continue;
      seen.add(key);
      line.id = makeId();
      out.push({ op: 'connector.add', connector: line });
    }
    return out;
  }

  /* ---------------------------------------------------------------- the batch */

  function readNodes(list) {
    const seen = new Set();
    const nodes = [];
    for (const node of list) {
      if (!isObj(node) || typeof node.id !== 'string' || !node.id || seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push({ id: node.id, label: node.label, group: typeof node.group === 'string' ? node.group : '' });
    }
    return nodes;
  }

  function counts(board, limits, notes, groups, edges) {
    const cards = Object.keys(board.cards).length;
    const total = groups + notes + edges + 2; // the card's removal, and its group's new size when the parts stay in it
    return total > (limits.batch_ops || BATCH_OPS) || cards + notes > limits.cards
      || Object.keys(board.groups).length + groups > limits.groups || Object.keys(board.connectors).length + edges > limits.connectors;
  }

  function build(input) {
    if (!isObj(input) || !isObj(input.card) || input.card.kind !== 'diagram' || typeof input.card.id !== 'string' || !isObj(input.outline) || !isObj(input.board)
      || !isObj(input.board.cards) || !isObj(input.board.groups) || !isObj(input.board.connectors) || typeof input.makeId !== 'function' || !isObj(input.limits)) return fail('invalid');
    const { card, outline, board, makeId, limits } = input;
    if (!Array.isArray(outline.nodes) || !Array.isArray(outline.groups) || !Array.isArray(outline.edges)) return fail('invalid');
    const nodes = readNodes(outline.nodes);
    if (!nodes.length) return fail('empty');
    const groupIds = new Map(); // outline group id -> its readable title
    for (const group of outline.groups) if (isObj(group) && typeof group.id === 'string' && group.id) groupIds.set(group.id, group.label);
    const order = Array.from(new Set(nodes.map((node) => node.group).filter((id) => groupIds.has(id)))); // groups that hold a node, first use first
    order.sort((a, b) => Array.from(groupIds.keys()).indexOf(a) - Array.from(groupIds.keys()).indexOf(b));
    const members = order.map((id) => nodes.map((node, i) => (node.group === id ? i : -1)).filter((i) => i >= 0));
    const index = new Map(nodes.map((node, i) => [node.id, i]));
    const edges = outline.edges.filter((e) => isObj(e) && index.has(e.from) && index.has(e.to) && e.from !== e.to);
    const kept = Object.keys(board.connectors).filter((id) => isObj(board.connectors[id]) && (board.connectors[id].from === card.id || board.connectors[id].to === card.id)).length;
    if (counts(board, limits, nodes.length, order.length, edges.length + kept)) return fail('too_many');

    const laid = layout(nodes, members, outline.positions, edges);
    const all = laid.rects.concat(laid.boxes);
    const here = inPlace(board, card, all, order.length > 0);
    const dx = here ? here.dx : originX(board, card) - Math.min(...all.map((r) => r.x));
    const dy = here ? here.dy : card.y - Math.min(...all.map((r) => r.y));
    const at = (r) => ({ x: Math.round(r.x + dx), y: Math.round(r.y + dy), w: r.w, h: r.h });
    const noteIds = nodes.map(() => makeId());
    const groupOps = order.map((id, k) => ({ op: 'group.add', group: Object.assign({ id: makeId(), title: oneLine(groupIds.get(id), TITLE_MAX) || oneLine(id, TITLE_MAX) || 'Group' }, at(laid.boxes[k])) }));
    const noteOps = nodes.map((node, i) => {
      const k = order.indexOf(node.group);
      const note = Object.assign({ id: noteIds[i], kind: 'note', data: { text: noteText(node.label, node.id), tone: null } }, at(laid.rects[i]));
      if (k >= 0) note.group_id = groupOps[k].group.id;
      else if (here && here.home) note.group_id = here.home.id;
      return { op: 'card.add', card: note };
    });
    const connectorOps = edges.map((e) => ({ op: 'connector.add', connector: { id: makeId(), from: noteIds[index.get(e.from)], to: noteIds[index.get(e.to)],
      label: oneLine(e.label, LABEL_MAX), style: e.dashed === true ? 'dashed' : 'solid', ends: 'end' } }));
    const again = reattached(board, card, noteOps.map((op) => op.card), makeId);
    const grow = here && here.grown ? [{ op: 'group.place', id: here.home.id, w: here.grown.w, h: here.grown.h }] : [];
    const ops = groupOps.concat(noteOps, connectorOps, again, grow, [{ op: 'card.remove', id: card.id }]);
    return { ok: true, ops, selectIds: noteIds };
  }

  /** Never throws: anything unreadable is { ok: false, reason: 'invalid' }. */
  function buildParts(input) {
    try {
      return build(input);
    } catch (_error) {
      return fail('invalid');
    }
  }

  return { buildParts };
});
