/* Aurora Ridge scene painter: a still night landscape for the Aurora theme
 * (the Aurora theme plan). Pure canvas2d drawing, no DOM and
 * no time: the same size and seed always give the same painting.
 *
 * Every thing has a light, half-tone and shade mix, and each brush dab picks
 * one by how lit its spot is. Light that is light (the aurora, the lamp) adds
 * up instead of covering. The idea is borrowed from patch.gg/blendi/oil-paint
 * (MIT); none of its code is used. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAuroraRidgeCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TAU = Math.PI * 2;
  var DEFAULT_AURORA_COLOR = '#46e3a0';
  var DEFAULT_LAMP_COLOR = '#ffb85c';
  // Three, four, six or eight digits; an alpha part is read and ignored.
  var HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  // A fixed phase for the aurora's curves: the painting is still, so this never advances.
  var AURORA_PHASE = 40;
  var AURORA_STRENGTH = 0.75;

  function makeRng(seed) {
    var a = seed | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(x, y) { var h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); }
  function valueNoise(x, y) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y) {
    return valueNoise(x, y) * 0.6 + valueNoise(x * 2.1 + 3.1, y * 2.1) * 0.3 + valueNoise(x * 4.3, y * 4.3 + 1.7) * 0.1;
  }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function smooth(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

  // A hex colour -> [r, g, b]; anything else gives the fallback colour.
  function parseHexColor(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    if (!HEX_PATTERN.test(text)) { text = fallback; }
    if (text.length < 6) { text = '#' + text[1] + text[1] + text[2] + text[2] + text[3] + text[3]; }
    return [parseInt(text.slice(1, 3), 16), parseInt(text.slice(3, 5), 16), parseInt(text.slice(5, 7), 16)];
  }
  function mixes(light, half, shade) {
    return [parseHexColor(light, light), parseHexColor(half, half), parseHexColor(shade, shade)];
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function scaled(c, k) { return [clamp(c[0] * k, 0, 255), clamp(c[1] * k, 0, 255), clamp(c[2] * k, 0, 255)]; }
  function css(c, alpha) {
    return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + (alpha == null ? 1 : alpha) + ')';
  }
  function jitter(c, rnd, amount) {
    var k = (rnd() - 0.5) * amount;
    return [
      clamp(c[0] + k + (rnd() - 0.5) * amount * 0.5, 0, 255),
      clamp(c[1] + k + (rnd() - 0.5) * amount * 0.5, 0, 255),
      clamp(c[2] + k + (rnd() - 0.5) * amount * 0.5, 0, 255),
    ];
  }
  // One of the three mixes by how lit the spot is; neighbours disagree a little.
  function pickMix(set, lit, r) { var v = lit + (r - 0.5) * 0.34; return v > 0.62 ? set[0] : v > 0.34 ? set[1] : set[2]; }

  var PAINT = {
    sky: mixes('#21436a', '#132a47', '#0a1729'),
    far: mixes('#6c8fb5', '#3a5878', '#1c2f48'),
    snow: mixes('#d3e4f1', '#86a6c6', '#43607f'),
    spruce: mixes('#2f5c66', '#183944', '#0b1e29'),
    log: mixes('#6a5140', '#42312a', '#221a19'),
    teal: parseHexColor('#3fc7d8', '#3fc7d8'),
    violet: parseHexColor('#8f6fe6', '#8f6fe6'),
    star: '#f2f7ff',
    fleck: '#eef6fc',
  };

  // One touch of a loaded brush: body, a lighter streak, a shaded lower edge.
  // Each ellipse carries its own rotation, so thousands of dabs need no
  // save/translate/rotate/restore. Both helpers leave globalAlpha at 1.
  function dab(ctx, x, y, len, wid, angle, c) {
    var cos = Math.cos(angle), sin = Math.sin(angle);
    var sx = -len * 0.05, sy = -wid * 0.2, ex = len * 0.04, ey = wid * 0.26;
    ctx.fillStyle = css(c);
    ctx.beginPath(); ctx.ellipse(x, y, len / 2, wid / 2, angle, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.5; ctx.fillStyle = css(scaled(c, 1.16));
    ctx.beginPath(); ctx.ellipse(x + sx * cos - sy * sin, y + sx * sin + sy * cos, len * 0.34, wid * 0.13, angle, 0, TAU); ctx.fill();
    ctx.fillStyle = css(scaled(c, 0.8));
    ctx.beginPath(); ctx.ellipse(x + ex * cos - ey * sin, y + ex * sin + ey * cos, len * 0.38, wid * 0.1, angle, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }
  // A flat touch: stars, flecks of snow, glow.
  function blob(ctx, x, y, len, wid, angle, style, alpha) {
    ctx.globalAlpha = alpha; ctx.fillStyle = style;
    ctx.beginPath(); ctx.ellipse(x, y, len / 2, wid / 2, angle, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }
  function field(ctx, rnd, o) {
    for (var i = 0; i < o.n; i += 1) {
      var x = rnd() * o.w, y = o.y0 + rnd() * (o.y1 - o.y0);
      if (o.mask && !o.mask(x, y)) { continue; }
      var c = jitter(pickMix(o.set, o.lit(x, y), rnd()), rnd, o.jitter);
      var s = 0.7 + rnd() * 0.7;
      dab(ctx, x, y, o.len * s, o.wid * s, o.angle(x, y) + (rnd() - 0.5) * 0.35, c);
    }
  }
  function underfill(ctx, w, h, ridge, colour) {
    ctx.fillStyle = css(colour);
    ctx.beginPath(); ctx.moveTo(0, h + 4);
    for (var x = 0; x <= w + 8; x += 8) { ctx.lineTo(x, ridge(x)); }
    ctx.lineTo(w + 8, h + 4); ctx.closePath(); ctx.fill();
  }

  // Where things stand. `unit` keeps dabs the same size relative to the window,
  // so a large window is not painted with thousands more of them.
  function layoutScene(w, h, seed) {
    var rnd = makeRng(seed);
    var unit = clamp(Math.sqrt(w * h) / 1140, 0.5, 2.2);
    var scene = { w: w, h: h, unit: unit };
    scene.far = function (x) {
      return h * 0.61 - h * 0.3 * Math.exp(-Math.pow((x - w * 0.7) / (w * 0.12), 2))
        - h * 0.1 * Math.exp(-Math.pow((x - w * 0.2) / (w * 0.2), 2)) - h * 0.07 * fbm(x * 0.005 / unit, 3.3);
    };
    scene.crest = function (x) {
      return h * 0.8 + h * 0.045 * Math.sin(x / w * 5 + 1) - h * 0.05 * fbm(x * 0.006 / unit, 9.1);
    };
    scene.trees = [];
    for (var i = 0; i < 13; i += 1) {
      var edge = rnd() * w * 0.27;
      var x = i < 10 ? (rnd() < 0.5 ? edge : w - edge) : rnd() * w;
      var near = rnd();
      scene.trees.push({ x: x, baseY: scene.crest(x) + near * h * 0.16, height: h * (0.16 + near * 0.3 + rnd() * 0.08) });
    }
    scene.trees.sort(function (a, b) { return a.baseY - b.baseY; });
    var cabinX = w * 0.815;
    scene.cabin = { x: cabinX, y: scene.crest(cabinX) + h * 0.012, s: clamp(h / 900, 0.6, 1.5) };
    return scene;
  }

  function paintSky(ctx, scene, rnd) {
    var w = scene.w, h = scene.h, u = scene.unit;
    var gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, css(PAINT.sky[2])); gradient.addColorStop(0.7, css(PAINT.sky[0]));
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
    field(ctx, rnd, {
      n: Math.round((w * h) / (300 * u * u)), w: w, y0: 0, y1: h * 0.8, len: 58 * u, wid: 19 * u, set: PAINT.sky, jitter: 10,
      angle: function (x) { return 0.16 * Math.sin(x / w * 3.1); },
      lit: function (x, y) { return 0.12 + 0.75 * (y / (h * 0.7)) + 0.2 * (fbm(x * 0.004 / u, y * 0.006 / u) - 0.5); },
    });
    for (var i = 0; i < 170; i += 1) {
      var s = (0.8 + rnd() * 1.8) * u;
      blob(ctx, rnd() * w, rnd() * h * 0.6, s * 1.6, s, rnd() * 3, PAINT.star, 0.25 + rnd() * 0.7);
    }
  }

  // The aurora: three curtains of upright rays, bright at the foot, violet at the top.
  function paintAurora(ctx, scene, colors) {
    var w = scene.w, h = scene.h, t = AURORA_PHASE;
    var count = Math.ceil((w + 80) / (11 * scene.unit)), step = (w + 80) / count;
    ctx.globalCompositeOperation = 'lighter';
    for (var r = 0; r < 3; r += 1) {
      for (var i = 0; i < count; i += 1) {
        var p = i / count, x = p * (w + 80) - 40;
        var foot = h * (0.15 + 0.095 * r) + h * 0.07 * Math.sin(p * 5 + t * 0.1 + r * 2.1) + h * 0.03 * Math.sin(p * 13 - t * 0.17 + r);
        var flow = valueNoise(p * 6 + r * 10 + t * 0.22, r * 3.7);
        var alpha = Math.min(0.9, AURORA_STRENGTH * (0.1 + 0.85 * Math.pow(flow, 1.7)));
        var len = h * (0.15 + 0.2 * valueNoise(p * 9 - t * 0.08, r + 5.5));
        var c = mix(mix(colors.aurora, PAINT.teal, flow), PAINT.violet, r * 0.22);
        var gradient = ctx.createLinearGradient(0, foot + 8, 0, foot - len);
        gradient.addColorStop(0, css(c, 0)); gradient.addColorStop(0.1, css(c, alpha));
        gradient.addColorStop(0.45, css(mix(c, PAINT.violet, 0.45), alpha * 0.45)); gradient.addColorStop(1, css(PAINT.violet, 0));
        ctx.fillStyle = gradient; ctx.fillRect(x, foot - len, step + 0.6, len + 8);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function paintFarRock(ctx, scene, rnd) {
    var w = scene.w, h = scene.h, u = scene.unit, far = scene.far;
    function slope(x) { return (far(x + 7 * u) - far(x - 7 * u)) / u; }
    underfill(ctx, w, h, far, PAINT.far[2]);
    field(ctx, rnd, {
      n: Math.round((w * h) / (210 * u * u)), w: w, y0: h * 0.2, y1: h * 0.86, len: 34 * u, wid: 13 * u, set: PAINT.far, jitter: 12,
      mask: function (x, y) { return y > far(x) - 3; },
      angle: function (x) { return Math.atan2(slope(x), 14) + 0.5; },
      lit: function (x, y) {
        return 0.6 - slope(x) * 0.04 + 0.35 * smooth(h * 0.07, 0, y - far(x)) - (y - far(x)) / (h * 0.5)
          + 0.3 * (fbm(x * 0.01 / u, y * 0.012 / u) - 0.5);
      },
    });
    // Mist lying between the far rock and the near snow.
    var mist = ctx.createLinearGradient(0, h * 0.6, 0, h * 0.86);
    mist.addColorStop(0, css(PAINT.far[0], 0)); mist.addColorStop(0.6, css(PAINT.far[0], 0.2)); mist.addColorStop(1, css(PAINT.far[0], 0));
    ctx.fillStyle = mist; ctx.fillRect(0, h * 0.6, w, h * 0.26);
  }

  function paintSnow(ctx, scene, rnd) {
    var w = scene.w, h = scene.h, u = scene.unit, crest = scene.crest;
    function slope(x) { return (crest(x + 8 * u) - crest(x - 8 * u)) / u; }
    underfill(ctx, w, h, crest, PAINT.snow[2]);
    field(ctx, rnd, {
      n: Math.round((w * h) / (260 * u * u)), w: w, y0: h * 0.7, y1: h + 10, len: 46 * u, wid: 14 * u, set: PAINT.snow, jitter: 9,
      mask: function (x, y) { return y > crest(x) - 2; },
      angle: function (x) { return Math.atan2(slope(x), 16); },
      lit: function (x, y) {
        return 0.8 - (y - crest(x)) / (h * 0.22) - slope(x) * 0.03 + 0.34 * (fbm(x * 0.008 / u, y * 0.02 / u) - 0.5);
      },
    });
  }

  function paintCabin(ctx, scene, rnd) {
    var c = scene.cabin, s = c.s, bw = 96 * s, bh = 50 * s;
    for (var j = 0; j < 7; j += 1) {
      for (var k = 0; k < 5; k += 1) {
        dab(ctx, c.x - bw / 2 + (k + 0.5) * bw / 5 + (rnd() - 0.5) * 6, c.y - (j + 0.5) * bh / 7, bw / 4.2, bh / 6,
          (rnd() - 0.5) * 0.06, jitter(pickMix(PAINT.log, 0.62 - k * 0.1, rnd()), rnd, 10));
      }
    }
    for (var side = -1; side <= 1; side += 2) {
      for (var n = 0; n < 9; n += 1) {
        var p = (n + 0.5) / 9;
        dab(ctx, c.x + side * p * bw * 0.62, c.y - bh - 30 * s * (1 - p) - 2, 26 * s, 11 * s, side * 0.5,
          jitter(side < 0 ? PAINT.snow[0] : PAINT.snow[1], rnd, 8));
      }
    }
    dab(ctx, c.x + bw * 0.24, c.y - bh - 26 * s, 10 * s, 22 * s, 0, PAINT.log[2]);
  }

  function paintSpruce(ctx, tree, rnd) {
    var tiers = 10, H = tree.height;
    dab(ctx, tree.x, tree.baseY - H * 0.06, H * 0.13, 7, 1.57, PAINT.spruce[2]);
    for (var j = 0; j < tiers; j += 1) {
      var f = j / tiers, tierY = tree.baseY - H * 0.08 - H * 0.92 * f, half = H * 0.2 * (1 - f) + 3;
      for (var k = 0; k < 9; k += 1) {
        var dx = (rnd() - 0.5) * 2 * half;
        dab(ctx, tree.x + dx, tierY - rnd() * H / tiers, half * 0.95 + 4, 6 + H * 0.014,
          (dx < 0 ? -1 : 1) * (0.42 + rnd() * 0.3), jitter(pickMix(PAINT.spruce, dx < 0 ? 0.62 : 0.3, rnd()), rnd, 12));
      }
      if (rnd() < 0.7) {
        dab(ctx, tree.x - rnd() * half * 0.7, tierY - H / tiers * 0.75 - rnd() * 3, Math.min(26, half * 0.3 + 3), 4, -0.5,
          jitter(pickMix(PAINT.snow, 0.45, rnd()), rnd, 8));
      }
    }
  }

  // The lit window, its glow, and the lamp light spilt on the snow.
  function paintLamp(ctx, scene, colors) {
    var c = scene.cabin, s = c.s, x = c.x - 20 * s, y = c.y - 27 * s;
    var lamp = css(colors.lamp);
    ctx.globalAlpha = 0.85; ctx.fillStyle = lamp; ctx.fillRect(x - 8 * s, y - 8 * s, 16 * s, 15 * s);
    ctx.globalCompositeOperation = 'lighter';
    for (var ring = 1; ring <= 6; ring += 1) { blob(ctx, x, y, ring * 18 * s, ring * 18 * s, 0, lamp, 0.07); }
    blob(ctx, x - 6 * s, c.y + 16 * s, 90 * s, 16 * s, 0.05, lamp, 0.16);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  function paintFlecks(ctx, scene, rnd) {
    for (var i = 0; i < 110; i += 1) {
      var s = (1.8 + rnd() * 2.6) * scene.unit;
      blob(ctx, rnd() * scene.w, rnd() * scene.h, s * 1.6, s, 0.5, PAINT.fleck, 0.4 + rnd() * 0.45);
    }
  }

  function resolveColors(colors) {
    var given = colors || {};
    return {
      aurora: parseHexColor(given.aurora, DEFAULT_AURORA_COLOR),
      lamp: parseHexColor(given.lamp, DEFAULT_LAMP_COLOR),
    };
  }

  // Paints the whole scene, back to front, in CSS pixels from (0, 0). The
  // caller sets the transform (device scale and any viewport offset).
  function paintScene(ctx, width, height, seed, colors) {
    if (!(width > 0) || !(height > 0)) { return null; }
    var scene = layoutScene(width, height, seed);
    var resolved = resolveColors(colors);
    paintSky(ctx, scene, makeRng(seed + 101));
    paintAurora(ctx, scene, resolved);
    paintFarRock(ctx, scene, makeRng(seed + 211));
    paintSnow(ctx, scene, makeRng(seed + 307));
    var rnd = makeRng(seed + 401);
    paintCabin(ctx, scene, rnd);
    scene.trees.forEach(function (tree) { paintSpruce(ctx, tree, rnd); });
    paintLamp(ctx, scene, resolved);
    paintFlecks(ctx, scene, makeRng(seed + 503));
    return scene;
  }

  return {
    DEFAULT_AURORA_COLOR: DEFAULT_AURORA_COLOR,
    DEFAULT_LAMP_COLOR: DEFAULT_LAMP_COLOR,
    parseHexColor: parseHexColor,
    layoutScene: layoutScene,
    paintScene: paintScene,
  };
});
