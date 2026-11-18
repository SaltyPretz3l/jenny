/* renderer/inventory/connector-layer.js
 *
 * One SVG that draws every connector between two rectangles, in board units. It
 * keeps one <g data-connector-id> per connector across renders: an unchanged
 * connector is not touched, a removed one is removed. Arrowheads are plain paths
 * (not markers) so they take the connector's colour. A label is SVG text, set
 * through textContent, on a pill. The layer never takes pointer input: the
 * caller asks hitTest(boardX, boardY, tolerance) about a background click.
 *
 * A connector is straight runs joined by rounded corners. It leaves by the side
 * that faces the other card and arrives by the side that faces back: across the
 * wider gap first, then across the other, then round one corner. The turn is in
 * the middle of the gap, so connectors from one card to a row of cards level with
 * each other share their first run and read as one line that splits. Two cards
 * too close for a corner get one straight line between their nearest sides.
 *
 * render(connectors, obstacles): `obstacles` are the rectangles of the cards on
 * the board. Of the ways above, the first that passes through none of them (its
 * own two cards aside) is taken; when every way is blocked, the first.
 *
 * setLit(ids): the connectors that stay lit while the rest step back (null: none
 * do). A lit connector carries a second path (data-connector-trace="flow") that
 * the stylesheet sends along it. drawIn(delays): { id: ms } draws those lines
 * once from their start, each after its delay. The motion itself is CSS. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.inventoryConnectorLayer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ARROW_LENGTH = 11;
  var ARROW_HALF_ANGLE = Math.PI / 7.5;
  var HEAD_BACK = 5; // the line stops this far short of an arrowhead's tip
  var ROOM = 16; // the least gap between two facing sides for a corner
  var CORNER = 12;
  var STRAIGHTEN = 24; // facing sides this close to level are joined by one straight run
  var CELL = 256; // the obstacle grid, in board units
  var CELLS_MAX = 4096;
  var LABEL_CHAR = 6.6;
  var LABEL_H = 20;
  var DRAW_MS = 700; // a drawn-in line is cleared this long after its delay
  var TONES = ['amber', 'blue', 'green', 'red'];

  function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
  function cleanRect(rect) {
    var source = rect || {};
    return { x: finite(source.x), y: finite(source.y), w: Math.max(0, finite(source.w)), h: Math.max(0, finite(source.h)) };
  }
  function anchors(rect) {
    return [
      { x: rect.x + rect.w / 2, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h / 2 },
      { x: rect.x + rect.w / 2, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h / 2 },
    ];
  }
  function round(value) { return Math.round(value * 100) / 100; }
  function sameRect(a, b) { return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h; }

  /* The obstacles by the grid cells they touch, so a point is tested against the few cards near it. A rectangle that
     would fill more than CELLS_MAX cells is kept in `wide` and tested against every point. */
  function indexRects(rects) {
    var index = { cells: new Map(), wide: [] };
    rects.forEach(function (rect) {
      var x0 = Math.floor(rect.x / CELL); var x1 = Math.floor((rect.x + rect.w) / CELL);
      var y0 = Math.floor(rect.y / CELL); var y1 = Math.floor((rect.y + rect.h) / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > CELLS_MAX) { index.wide.push(rect); return; }
      for (var cx = x0; cx <= x1; cx += 1) {
        for (var cy = y0; cy <= y1; cy += 1) {
          var list = index.cells.get(cx + ',' + cy);
          if (!list) { list = []; index.cells.set(cx + ',' + cy, list); }
          list.push(rect);
        }
      }
    });
    return index.cells.size || index.wide.length ? index : null;
  }

  /* True when the run from (x0, y0) to (x1, y1), level or upright, passes through one of the rectangles (its own two aside). */
  function crosses(rects, x0, y0, x1, y1, from, to) {
    for (var r = 0; r < rects.length; r += 1) {
      var rect = rects[r];
      if (x1 > rect.x + 1 && x0 < rect.x + rect.w - 1 && y1 > rect.y + 1 && y0 < rect.y + rect.h - 1 && !sameRect(rect, from) && !sameRect(rect, to)) return true;
    }
    return false;
  }

  /* True when the runs pass through an indexed rectangle other than their own two (a run along an edge does not count).
     Each run is tested whole against the rectangles of the grid cells it passes: the cost does not grow with its length
     the way sampling it did. */
  function blocked(points, index, from, to) {
    for (var i = 1; i < points.length; i += 1) {
      var x0 = Math.min(points[i - 1].x, points[i].x); var x1 = Math.max(points[i - 1].x, points[i].x);
      var y0 = Math.min(points[i - 1].y, points[i].y); var y1 = Math.max(points[i - 1].y, points[i].y);
      if (crosses(index.wide, x0, y0, x1, y1, from, to)) return true;
      for (var cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx += 1) {
        for (var cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy += 1) {
          var near = index.cells.get(cx + ',' + cy);
          if (near && crosses(near, x0, y0, x1, y1, from, to)) return true;
        }
      }
    }
    return false;
  }

  /* From one side of `from` to the facing side of `to`, across the gap between them on one axis: straight when the two
     sides are near level, else out to the middle of the gap, over, and in. `u` is the axis the gap is on. */
  function facing(from, to, across) {
    var u = across ? 'x' : 'y'; var v = across ? 'y' : 'x'; var us = across ? 'w' : 'h'; var vs = across ? 'h' : 'w';
    var forward = to[u] >= from[u];
    var start = {}; var end = {};
    start[u] = forward ? from[u] + from[us] : from[u];
    end[u] = forward ? to[u] : to[u] + to[us];
    start[v] = from[v] + from[vs] / 2;
    end[v] = to[v] + to[vs] / 2;
    var level = (start[v] + end[v]) / 2;
    var fits = function (r) { return level >= r[v] + Math.min(8, r[vs] / 2) && level <= r[v] + r[vs] - Math.min(8, r[vs] / 2); };
    if (Math.abs(start[v] - end[v]) <= STRAIGHTEN && fits(from) && fits(to)) {
      start[v] = level; end[v] = level;
      return [start, end];
    }
    var m1 = {}; var m2 = {};
    m1[u] = m2[u] = (start[u] + end[u]) / 2;
    m1[v] = start[v]; m2[v] = end[v];
    return [start, m1, m2, end];
  }

  /* Out of a side of `from`, round one corner, into a side of `to`: out sideways and in from above or below when
     `sideways`, the other way about when not. Null when `to` is not far enough round the corner. */
  function corner(from, to, sideways) {
    var u = sideways ? 'x' : 'y'; var v = sideways ? 'y' : 'x'; var us = sideways ? 'w' : 'h'; var vs = sideways ? 'h' : 'w';
    var fromMid = from[v] + from[vs] / 2;
    var toMid = to[u] + to[us] / 2;
    var out = toMid > from[u] + from[us] + ROOM ? 1 : toMid < from[u] - ROOM ? -1 : 0;
    var into = to[v] > fromMid + ROOM ? 1 : to[v] + to[vs] < fromMid - ROOM ? -1 : 0;
    if (!out || !into) return null;
    var start = {}; var bend = {}; var end = {};
    start[u] = out > 0 ? from[u] + from[us] : from[u];
    start[v] = fromMid;
    bend[u] = toMid; bend[v] = fromMid;
    end[u] = toMid;
    end[v] = into > 0 ? to[v] : to[v] + to[vs];
    return [start, bend, end];
  }

  function nearest(from, to) {
    var best = null;
    anchors(from).forEach(function (a) {
      anchors(to).forEach(function (b) {
        var distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (!best || distance < best.distance - 1e-9) best = { distance: distance, points: [a, b] };
      });
    });
    return best.points;
  }

  /* The runs as a path: corners rounded, and the two ends pulled back by `trimStart` and `trimEnd` (room for a head). */
  function pathD(points, trimStart, trimEnd) {
    var pts = points.map(function (p) { return { x: p.x, y: p.y }; });
    var pull = function (end, towards, by) {
      var length = Math.hypot(towards.x - end.x, towards.y - end.y);
      if (by > 0 && length > by * 2) { end.x += (towards.x - end.x) / length * by; end.y += (towards.y - end.y) / length * by; }
    };
    pull(pts[0], pts[1], trimStart);
    pull(pts[pts.length - 1], pts[pts.length - 2], trimEnd);
    var d = 'M ' + round(pts[0].x) + ' ' + round(pts[0].y);
    for (var i = 1; i < pts.length - 1; i += 1) {
      var a = pts[i - 1]; var c = pts[i]; var b = pts[i + 1];
      var la = Math.hypot(c.x - a.x, c.y - a.y); var lb = Math.hypot(b.x - c.x, b.y - c.y);
      var r = Math.min(CORNER, la / 2, lb / 2);
      if (r < 1) { d += ' L ' + round(c.x) + ' ' + round(c.y); continue; }
      d += ' L ' + round(c.x - (c.x - a.x) / la * r) + ' ' + round(c.y - (c.y - a.y) / la * r)
        + ' Q ' + round(c.x) + ' ' + round(c.y) + ', ' + round(c.x + (b.x - c.x) / lb * r) + ' ' + round(c.y + (b.y - c.y) / lb * r);
    }
    var last = pts[pts.length - 1];
    return d + ' L ' + round(last.x) + ' ' + round(last.y);
  }

  /* The path between two rectangles: of the ways a line may run, the first clear of the indexed obstacles. */
  function route(fromRect, toRect, index) {
    var from = cleanRect(fromRect);
    var to = cleanRect(toRect);
    var gapX = Math.max(to.x - (from.x + from.w), from.x - (to.x + to.w));
    var gapY = Math.max(to.y - (from.y + from.h), from.y - (to.y + to.h));
    var ways = [];
    var acrossFirst = gapX > 0 && (gapY <= 0 || gapX >= gapY);
    [acrossFirst, !acrossFirst].forEach(function (across) { if ((across ? gapX : gapY) >= ROOM) ways.push(facing(from, to, across)); });
    [acrossFirst, !acrossFirst].forEach(function (sideways) {
      var bent = corner(from, to, sideways);
      if (bent) ways.push(bent);
    });
    var points = ways[0] || nearest(from, to);
    for (var i = 0; index && i < ways.length; i += 1) {
      if (!blocked(ways[i], index, from, to)) { points = ways[i]; break; }
    }
    var g = { points: points, start: points[0], end: points[points.length - 1] };
    // Every way that was or could be tried stays inside this box: a card that moves outside it changes nothing here.
    g.box = { x: Math.min(from.x, to.x) - ROOM, y: Math.min(from.y, to.y) - ROOM };
    g.box.w = Math.max(from.x + from.w, to.x + to.w) + ROOM - g.box.x;
    g.box.h = Math.max(from.y + from.h, to.y + to.h) + ROOM - g.box.y;
    var longest = -1;
    for (var k = 1; k < points.length; k += 1) { // the label sits on the middle of the longest run
      var length = Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
      if (length > longest) { longest = length; g.mid = { x: (points[k].x + points[k - 1].x) / 2, y: (points[k].y + points[k - 1].y) / 2 }; }
    }
    g.d = pathD(points, 0, 0);
    return g;
  }

  function arrowD(tip, towards) {
    // `towards` points from the tip back along the line; the head opens that way.
    var length = Math.hypot(towards.x, towards.y);
    var ux = length > 1e-9 ? towards.x / length : 0;
    var uy = length > 1e-9 ? towards.y / length : -1;
    var points = [tip];
    [ARROW_HALF_ANGLE, -ARROW_HALF_ANGLE].forEach(function (angle) {
      var cos = Math.cos(angle); var sin = Math.sin(angle);
      points.push({
        x: tip.x + (ux * cos - uy * sin) * ARROW_LENGTH,
        y: tip.y + (ux * sin + uy * cos) * ARROW_LENGTH,
      });
    });
    return 'M ' + round(points[0].x) + ' ' + round(points[0].y) + ' L ' + round(points[1].x) + ' ' + round(points[1].y)
      + ' L ' + round(points[2].x) + ' ' + round(points[2].y) + ' Z';
  }

  function distanceToSegment(px, py, a, b) {
    var dx = b.x - a.x; var dy = b.y - a.y;
    var lengthSq = dx * dx + dy * dy;
    var t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lengthSq)) : 0;
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  function connectorLayer(options) {
    var doc = (options && options.document) || globalThis.document;
    var view = doc.defaultView || globalThis;
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'inv-board-connectors');
    svg.setAttribute('width', '1');
    svg.setAttribute('height', '1');
    svg.setAttribute('overflow', 'visible');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var entries = new Map(); // id -> { g, sig, base, box, points, d, timer, lit, trace, traceKind }
    var lastRects = [];
    var lit = null; // the ids that stay lit, or null
    var disposed = false;

    function node(tag, className) {
      var el = doc.createElementNS(SVG_NS, tag);
      if (className) el.setAttribute('class', className);
      return el;
    }
    function flag(el, name, on) {
      if (on) { if (!el.hasAttribute(name)) el.setAttribute(name, ''); } else if (el.hasAttribute(name)) el.removeAttribute(name);
    }
    function signature(item) {
      return JSON.stringify([
        cleanRect(item.from), cleanRect(item.to), item.label === undefined || item.label === null ? '' : String(item.label),
        item.style, item.tone, item.ends, item.selected === true, item.ghost === true,
      ]);
    }

    /* The second path of a connector: `kind` 'flow' while it is lit, 'draw' while it is drawn in, '' for none. */
    function trace(entry, kind) {
      entry.traceKind = kind;
      if (!kind) {
        if (entry.trace) entry.trace.remove();
        entry.trace = null;
        return;
      }
      if (!entry.trace) {
        entry.trace = node('path', 'inv-board-conn-trace');
        entry.trace.setAttribute('pathLength', '100');
        entry.g.appendChild(entry.trace);
      }
      entry.trace.setAttribute('data-connector-trace', kind);
      entry.trace.setAttribute('d', entry.d);
    }

    function draw(entry, item, geometry) {
      var g = entry.g;
      var ends = item.ends === 'both' || item.ends === 'none' ? item.ends : 'end';
      var points = geometry.points;
      var last = points.length - 1;
      g.setAttribute('data-style', item.style === 'dashed' ? 'dashed' : 'solid');
      if (TONES.indexOf(item.tone) >= 0) g.setAttribute('data-tone', item.tone); else g.removeAttribute('data-tone');
      flag(g, 'data-selected', item.selected === true);
      flag(g, 'data-ghost', item.ghost === true);

      var line = g.querySelector('[data-connector-line]');
      if (!line) {
        line = node('path', 'inv-board-conn-line');
        line.setAttribute('data-connector-line', '');
        g.insertBefore(line, g.firstChild);
      }
      entry.d = pathD(points, ends === 'both' ? HEAD_BACK : 0, ends === 'none' ? 0 : HEAD_BACK);
      line.setAttribute('d', entry.d);
      if (entry.trace) entry.trace.setAttribute('d', entry.d);

      var wanted = [];
      if (ends === 'end' || ends === 'both') wanted.push(['end', points[last], { x: points[last - 1].x - points[last].x, y: points[last - 1].y - points[last].y }]);
      if (ends === 'both') wanted.push(['start', points[0], { x: points[1].x - points[0].x, y: points[1].y - points[0].y }]);
      g.querySelectorAll('[data-connector-arrow]').forEach(function (arrow) {
        if (!wanted.some(function (want) { return want[0] === arrow.getAttribute('data-connector-arrow'); })) arrow.remove();
      });
      wanted.forEach(function (want) {
        var arrow = g.querySelector('[data-connector-arrow="' + want[0] + '"]');
        if (!arrow) {
          arrow = node('path', 'inv-board-conn-arrow');
          arrow.setAttribute('data-connector-arrow', want[0]);
          g.appendChild(arrow);
        }
        arrow.setAttribute('d', arrowD(want[1], want[2]));
      });

      var label = item.label === undefined || item.label === null ? '' : String(item.label);
      var text = g.querySelector('text');
      var pill = g.querySelector('[data-connector-pill]');
      if (label === '') {
        if (text) text.remove();
        if (pill) pill.remove();
      } else {
        if (!pill) {
          pill = node('rect', 'inv-board-conn-pill');
          pill.setAttribute('data-connector-pill', '');
          pill.setAttribute('height', String(LABEL_H));
          pill.setAttribute('rx', String(LABEL_H / 2));
          g.appendChild(pill);
        }
        if (!text) {
          text = node('text', 'inv-board-conn-label');
          text.setAttribute('text-anchor', 'middle');
          text.setAttribute('dy', '0.32em');
          g.appendChild(text);
        }
        var width = Math.round(label.length * LABEL_CHAR + 18); // measured by the letter: no layout is read
        pill.setAttribute('width', String(width));
        pill.setAttribute('x', String(round(geometry.mid.x - width / 2)));
        pill.setAttribute('y', String(round(geometry.mid.y - LABEL_H / 2)));
        text.setAttribute('x', String(round(geometry.mid.x)));
        text.setAttribute('y', String(round(geometry.mid.y)));
        text.textContent = label;
      }
      entry.points = points;
    }

    function light(entry, id) {
      var on = lit !== null && lit.has(id);
      if (entry.lit === on) return;
      entry.lit = on;
      flag(entry.g, 'data-lit', on);
      if (on && !entry.traceKind) trace(entry, 'flow');
      else if (!on && entry.traceKind === 'flow') trace(entry, '');
    }

    function render(connectors, obstacles) {
      if (disposed) return;
      var seen = new Set();
      var rects = Array.isArray(obstacles) ? obstacles.map(cleanRect) : [];
      var index = null; // built once, and only when a path has to be worked out
      // The rectangles that moved since the last render, old place and new; null when cards came or went.
      var moved = rects.length === lastRects.length ? [] : null;
      for (var r = 0; moved && r < rects.length; r += 1) if (!sameRect(rects[r], lastRects[r])) moved.push(rects[r], lastRects[r]);
      lastRects = rects;
      function near(box) { // could a moved card change the way round for a connector with this box?
        return !moved || moved.some(function (m) { return m.x < box.x + box.w && m.x + m.w > box.x && m.y < box.y + box.h && m.y + m.h > box.y; });
      }
      (Array.isArray(connectors) ? connectors : []).forEach(function (item) {
        if (!item || item.id === undefined || item.id === null || !item.from || !item.to) return;
        var id = String(item.id);
        seen.add(id);
        var base = signature(item);
        var entry = entries.get(id);
        if (entry && entry.base === base && !near(entry.box)) return;
        if (rects.length && !index) index = indexRects(rects);
        var geometry = route(item.from, item.to, index);
        var sig = base + geometry.d;
        if (entry && entry.sig === sig) { entry.box = geometry.box; return; }
        if (!entry) {
          var g = node('g', 'inv-board-conn');
          g.setAttribute('data-connector-id', id);
          svg.appendChild(g);
          entry = { g: g, sig: '', base: '', box: null, points: [], d: '', timer: 0, lit: false, trace: null, traceKind: '' };
          entries.set(id, entry);
          light(entry, id);
        }
        draw(entry, item, geometry);
        entry.sig = sig;
        entry.base = base;
        entry.box = geometry.box;
      });
      Array.from(entries.keys()).forEach(function (id) {
        if (seen.has(id)) return;
        view.clearTimeout(entries.get(id).timer);
        entries.get(id).g.remove();
        entries.delete(id);
      });
    }

    function hitTest(boardX, boardY, tolerance) {
      var limit = typeof tolerance === 'number' && tolerance >= 0 ? tolerance : 6;
      var bestId = null;
      var bestDistance = Infinity;
      entries.forEach(function (entry, id) {
        for (var i = 1; i < entry.points.length; i += 1) {
          var distance = distanceToSegment(boardX, boardY, entry.points[i - 1], entry.points[i]);
          if (distance <= limit && distance < bestDistance) { bestDistance = distance; bestId = id; }
        }
      });
      return bestId;
    }

    function setLit(ids) {
      if (disposed) return;
      lit = Array.isArray(ids) ? new Set(ids.map(String)) : null;
      flag(svg, 'data-focus', lit !== null);
      entries.forEach(light);
    }

    function drawIn(delays) {
      if (disposed || !delays) return;
      Object.keys(delays).forEach(function (id) {
        var entry = entries.get(id);
        if (!entry) return;
        var delay = Math.max(0, finite(delays[id]));
        view.clearTimeout(entry.timer);
        entry.g.style.setProperty('--board-arrive-delay', delay + 'ms');
        entry.g.setAttribute('data-arriving', '');
        trace(entry, 'draw');
        entry.timer = view.setTimeout(function () {
          entry.g.removeAttribute('data-arriving');
          entry.g.style.removeProperty('--board-arrive-delay');
          trace(entry, entry.lit ? 'flow' : '');
        }, delay + DRAW_MS);
      });
    }

    return {
      element: svg,
      render: render,
      hitTest: hitTest,
      setLit: setLit,
      drawIn: drawIn,
      dispose: function () {
        if (disposed) return;
        disposed = true;
        entries.forEach(function (entry) { view.clearTimeout(entry.timer); });
        entries.clear();
        svg.remove();
      },
    };
  }

  connectorLayer.connectorPath = function (fromRect, toRect, obstacles) {
    var result = route(fromRect, toRect, Array.isArray(obstacles) ? indexRects(obstacles.map(cleanRect)) : null);
    return { d: result.d, start: result.start, end: result.end, mid: result.mid };
  };
  return connectorLayer;
});
