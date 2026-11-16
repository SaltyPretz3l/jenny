/* renderer/inventory/connector-layer.js
 *
 * One SVG that draws every connector between two rectangles, in board units. It
 * keeps one <g data-connector-id> per connector across renders: an unchanged
 * connector is not touched, a removed one is removed. Arrowheads are plain paths
 * (not markers) so they take the connector's colour. Labels are SVG text set
 * through textContent. The layer never takes pointer input: the caller asks
 * hitTest(boardX, boardY, tolerance) about a background click. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.inventoryConnectorLayer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ARROW_LENGTH = 9;
  var ARROW_HALF_ANGLE = Math.PI / 7;
  var CURVE_SAMPLES = 24;
  var MIN_HANDLE = 24;
  var HANDLE_RATIO = 0.4;
  var TONES = ['amber', 'blue', 'green', 'red'];
  var NORMALS = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

  function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
  function cleanRect(rect) {
    var source = rect || {};
    return { x: finite(source.x), y: finite(source.y), w: Math.max(0, finite(source.w)), h: Math.max(0, finite(source.h)) };
  }
  function anchors(rect) {
    return [
      { side: 'n', x: rect.x + rect.w / 2, y: rect.y },
      { side: 'e', x: rect.x + rect.w, y: rect.y + rect.h / 2 },
      { side: 's', x: rect.x + rect.w / 2, y: rect.y + rect.h },
      { side: 'w', x: rect.x, y: rect.y + rect.h / 2 },
    ];
  }
  function round(value) { return Math.round(value * 100) / 100; }
  function bezier(p0, p1, p2, p3, t) {
    var u = 1 - t;
    var a = u * u * u; var b = 3 * u * u * t; var c = 3 * u * t * t; var d = t * t * t;
    return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
  }

  /* The path between the nearest edge midpoints of two rectangles, as one cubic curve. */
  function connectorPath(fromRect, toRect) {
    var from = cleanRect(fromRect);
    var to = cleanRect(toRect);
    var best = null;
    anchors(from).forEach(function (a) {
      anchors(to).forEach(function (b) {
        var distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (!best || distance < best.distance - 1e-9) best = { a: a, b: b, distance: distance };
      });
    });
    var handle = Math.max(MIN_HANDLE, best.distance * HANDLE_RATIO);
    var na = NORMALS[best.a.side];
    var nb = NORMALS[best.b.side];
    var start = { x: best.a.x, y: best.a.y };
    var end = { x: best.b.x, y: best.b.y };
    var c1 = { x: start.x + na[0] * handle, y: start.y + na[1] * handle };
    var c2 = { x: end.x + nb[0] * handle, y: end.y + nb[1] * handle };
    var mid = bezier(start, c1, c2, end, 0.5);
    var d = 'M ' + round(start.x) + ' ' + round(start.y) + ' C ' + round(c1.x) + ' ' + round(c1.y) + ', '
      + round(c2.x) + ' ' + round(c2.y) + ', ' + round(end.x) + ' ' + round(end.y);
    return {
      d: d, start: start, end: end, mid: { x: mid.x, y: mid.y },
      // Internals for the layer: control points and the direction each end faces out of its rectangle.
      c1: c1, c2: c2, outStart: na, outEnd: nb,
    };
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
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'inv-board-connectors');
    svg.setAttribute('width', '1');
    svg.setAttribute('height', '1');
    svg.setAttribute('overflow', 'visible');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var entries = new Map(); // id -> { g, sig, points }
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

    function draw(g, item) {
      var geometry = connectorPath(item.from, item.to);
      var ends = item.ends === 'both' || item.ends === 'none' ? item.ends : 'end';
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
      line.setAttribute('d', geometry.d);

      var wanted = [];
      if (ends === 'end' || ends === 'both') wanted.push(['end', geometry.end, { x: geometry.c2.x - geometry.end.x, y: geometry.c2.y - geometry.end.y }]);
      if (ends === 'both') wanted.push(['start', geometry.start, { x: geometry.c1.x - geometry.start.x, y: geometry.c1.y - geometry.start.y }]);
      g.querySelectorAll('[data-connector-arrow]').forEach(function (arrow) {
        if (!wanted.some(function (entry) { return entry[0] === arrow.getAttribute('data-connector-arrow'); })) arrow.remove();
      });
      wanted.forEach(function (entry) {
        var arrow = g.querySelector('[data-connector-arrow="' + entry[0] + '"]');
        if (!arrow) {
          arrow = node('path', 'inv-board-conn-arrow');
          arrow.setAttribute('data-connector-arrow', entry[0]);
          g.appendChild(arrow);
        }
        arrow.setAttribute('d', arrowD(entry[1], entry[2]));
      });

      var label = item.label === undefined || item.label === null ? '' : String(item.label);
      var text = g.querySelector('text');
      if (label === '') {
        if (text) text.remove();
      } else {
        if (!text) { text = node('text', 'inv-board-conn-label'); text.setAttribute('text-anchor', 'middle'); g.appendChild(text); }
        text.setAttribute('x', String(round(geometry.mid.x)));
        text.setAttribute('y', String(round(geometry.mid.y)));
        text.textContent = label;
      }

      var points = [];
      for (var i = 0; i <= CURVE_SAMPLES; i += 1) points.push(bezier(geometry.start, geometry.c1, geometry.c2, geometry.end, i / CURVE_SAMPLES));
      return points;
    }

    function render(connectors) {
      if (disposed) return;
      var seen = new Set();
      (Array.isArray(connectors) ? connectors : []).forEach(function (item) {
        if (!item || item.id === undefined || item.id === null || !item.from || !item.to) return;
        var id = String(item.id);
        seen.add(id);
        var sig = signature(item);
        var entry = entries.get(id);
        if (entry && entry.sig === sig) return;
        if (!entry) {
          var g = node('g', 'inv-board-conn');
          g.setAttribute('data-connector-id', id);
          svg.appendChild(g);
          entry = { g: g, sig: '', points: [] };
          entries.set(id, entry);
        }
        entry.points = draw(entry.g, item);
        entry.sig = sig;
      });
      Array.from(entries.keys()).forEach(function (id) {
        if (seen.has(id)) return;
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

    return {
      element: svg,
      render: render,
      hitTest: hitTest,
      dispose: function () {
        if (disposed) return;
        disposed = true;
        entries.clear();
        svg.remove();
      },
    };
  }

  connectorLayer.connectorPath = function (fromRect, toRect) {
    var result = connectorPath(fromRect, toRect);
    return { d: result.d, start: result.start, end: result.end, mid: result.mid };
  };
  return connectorLayer;
});
