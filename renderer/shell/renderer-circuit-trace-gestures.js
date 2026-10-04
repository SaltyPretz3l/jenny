/* Circuit Trace live layer: the hover probe, the click chain (current runs
 * along the line to a node, dwells, then moves on to the nearest next node)
 * and the few idle packets. State lives in one plain object the controller
 * owns: advance it once per frame, draw it once per host. Reads no
 * controller scope, attaches no listeners, never reacts to the model. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-circuit-trace-core.js'));
    return;
  }
  root.rendererCircuitTraceGestures = factory(root.rendererCircuitTraceCore || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  var TWO_PI = Math.PI * 2;
  // Hover probe: the current key rises, earlier keys each fade on their own.
  var PROBE_IN_MS = 160, PROBE_OUT_MS = 280, PROBE_QUIET_MS = 80, PROBE_SLOTS = 4, PROBE_EPS = 0.004;
  var PROBE_ALPHA = 0.9, PROBE_WIDTH = 1.8, NODE_GROW = 1.12;
  // Pick radii at the default pitch; they scale with it.
  var HOVER_R = 14, HOVER_KEEP_R = 20, CLICK_R = 18;
  // After a click the probe stays quiet until the pointer moves this far.
  var QUIET_PX = 8;
  // Click chain.
  var CHAIN_SPEED = 0.42, HOP_MIN_MS = 170, DWELL_NODE = 110, DWELL_CHIP = 210;
  var MAX_HOPS = 5, MAX_PATHS = 2, FORK_P = 0.15, CHIP_EXIT_PENALTY = 400;
  var LIT_DECAY_MS = 420, LIT_MIN_ALPHA = 0.02, HEAD_PX = 12;
  var FLASH_STRONG_MS = 900, FLASH_WEAK_MS = 450, POP_MS = 240, RING_MS = 340, CHIP_PULSE_MS = 800;
  // Idle: one bus group at a time plus a few net packets; quiet during a chain and a second after.
  var IDLE_QUIET_AFTER_MS = 1000, KILL_MS = 160, FADE_IN_MS = 120, DIVE_MS = 150;
  var BUS_V = 0.07, NET_V = 0.06, BUS_LEN = 16, NET_LEN = 14, INNER_LEN = 11, INNER_SPEED = 0.6;
  var BUS_GAP_MS = 3200, BUS_GAP_JITTER_MS = 3000, NET_GAP_MS = 1100, NET_GAP_JITTER_MS = 1500;
  var NET_HOPS = 3, NET_MAX = 2, FIRST_BUS_MS = 800, FIRST_NET_MS = 400;

  function clamp(v, lo, hi) {
    if (v < lo) { return lo; }
    if (v > hi) { return hi; }
    return v;
  }

  function smooth(t) {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  }

  function easeInOut(t) {
    t = clamp(t, 0, 1);
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
  }

  function createLiveState(rng) {
    var live = {
      t: 0, rng: typeof rng === 'function' ? rng : Math.random,
      probes: [], probeKey: '', probeMoving: false,
      packets: [], lit: [], flashes: [], chipPulses: [], pinned: null,
      nextBus: 0, nextNet: 0, quietUntil: 0,
      pointerOn: false, pointerX: 0, pointerY: 0, quietX: -1e9, quietY: 0,
    };
    resetLive(live, live.rng);
    return live;
  }

  /* Drop every transient (a rebuilt board invalidates trace references). The
   * clock keeps running so scheduled times stay monotonic. */
  function resetLive(live, rng) {
    live.probes.length = 0;
    live.packets.length = 0;
    live.lit.length = 0;
    live.flashes.length = 0;
    live.chipPulses.length = 0;
    live.probeKey = '';
    live.probeMoving = false;
    live.pinned = null;
    live.quietX = -1e9;
    live.quietUntil = 0;
    live.nextBus = live.t + FIRST_BUS_MS;
    live.nextNet = live.t + FIRST_NET_MS;
    if (typeof rng === 'function') { live.rng = rng; }
  }

  function keyOf(t) {
    return t.bus >= 0 ? 'b' + t.bus : 't' + t.id;
  }

  function setPointer(live, x, y) {
    live.pointerOn = true;
    live.pointerX = x;
    live.pointerY = y;
  }

  function clearPointer(live) {
    live.pointerOn = false;
    live.pinned = null;
  }

  /* The trace a hover at (x, y) probes, or null. A probed signal keeps its
   * hold out to the wider keep radius, so the probe doesn't flicker at its edge. */
  function hoverHit(live, board, x, y, out) {
    var s = board.s || 1;
    var hit = core.nearestTrace(board, x, y, HOVER_KEEP_R * s, out);
    if (hit && hit.d > HOVER_R * s && keyOf(hit.t) !== live.probeKey) { return null; }
    return hit;
  }

  function clickHit(board, x, y, out) {
    return core.nearestTrace(board, x, y, CLICK_R * (board.s || 1), out);
  }

  function addEnd(ends, id) {
    if (ends.indexOf(id) < 0) { ends.push(id); }
  }

  /* Point the probe at hit's signal (a whole bus when it is one). A key whose
   * slot has faded away gets a fresh slot. */
  function setProbe(live, board, hit) {
    var key = hit ? keyOf(hit.t) : '';
    live.probeKey = key;
    if (!key) { return; }
    for (var i = 0; i < live.probes.length; i++) {
      if (live.probes[i].key === key) { return; }
    }
    var list = hit.t.bus >= 0 ? board.buses[hit.t.bus].traces : [hit.t.id], ends = [];
    for (i = 0; i < list.length; i++) {
      addEnd(ends, board.traces[list[i]].a);
      addEnd(ends, board.traces[list[i]].b);
    }
    live.probes.push({ key: key, list: list, ends: ends, fade: 0 });
    if (live.probes.length > PROBE_SLOTS) { live.probes.shift(); }
  }

  function isDeadEnd(n) {
    return n.chip < 0 && n.traces.length <= 1;
  }

  function dist2(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  // Head for the nearer end, unless it goes nowhere.
  function startTowardB(board, hit) {
    var t = hit.t, deadA = isDeadEnd(board.nodes[t.a]), deadB = isDeadEnd(board.nodes[t.b]);
    return deadA !== deadB ? deadA : t.len - hit.s < hit.s;
  }

  function byScore(a, b) {
    return a.score - b.score;
  }

  /* Where current can go next from node n, nearest first. Through a part it
   * leaves by the closest pin on another net (never back down the same bus);
   * at a via it stays on top copper if it can and dives otherwise. */
  function nextFrom(board, n, arrived, visited) {
    var out = [], nodes = board.nodes, traces = board.traces;
    if (n.chip >= 0) {
      var ch = board.chips[n.chip];
      for (var i = 0; i < ch.pins.length; i++) {
        var p = ch.pins[i], q = nodes[p];
        if (p === n.id || !q.traces.length || visited[p]) { continue; }
        var tr = traces[q.traces[0]];
        if (visited[core.farNode(tr, p)] || (arrived.bus >= 0 && tr.bus === arrived.bus)) { continue; }
        var pen = ch.kind === 'soic' && q.dir === n.dir ? CHIP_EXIT_PENALTY : 0;
        out.push({ t: tr, from: p, score: dist2(q, n) + pen * pen });
      }
    } else {
      for (var k = 0; k < n.traces.length; k++) {
        var id = n.traces[k], t = traces[id];
        if (id === arrived.id || t.layer < 0 || visited[core.farNode(t, n.id)]) { continue; }
        out.push({ t: t, from: n.id, score: (t.layer === 1 ? 1e6 : 0) + (t.layer === 2 ? 0 : t.len) });
      }
    }
    out.sort(byScore);
    return out;
  }

  /* Plan the whole chain at click time: each hop's trace interval, start
   * time (relative to the click), arrival node, dwell and exit pin. The
   * animation schedules the plan; reduced motion draws the same plan at once.
   * speed is the speed token (1 = 0.42 px/ms). */
  function planChain(board, hit, rng, speed) {
    var pxPerMs = CHAIN_SPEED * (speed > 0 ? speed : 1);
    var t = hit.t, toB = startTowardB(board, hit), visited = {}, segs = [], queue = [], paths = 1, nodes = board.nodes;
    function add(tr, s0, s1, start, hop, exitNode) {
      var dur = Math.max(HOP_MIN_MS, Math.abs(s1 - s0) / pxPerMs), node = nodes[s1 >= tr.len ? tr.b : tr.a];
      visited[node.id] = true;
      var seg = { t: tr, s0: s0, s1: s1, t0: start, dur: dur, node: node, dwell: node.chip >= 0 ? DWELL_CHIP : DWELL_NODE, exit: exitNode };
      segs.push(seg);
      queue.push({ seg: seg, hop: hop });
    }
    var bus = t.bus >= 0 ? board.buses[t.bus] : null;
    if (bus && bus.pair) {
      // a differential pair carries its current on both lanes together
      bus.traces.forEach(function (id) {
        var tr = board.traces[id];
        visited[toB ? tr.a : tr.b] = true;
        add(tr, clamp(hit.s, 0, tr.len), toB ? tr.len : 0, 0, MAX_HOPS - 1, null);
      });
    } else {
      visited[toB ? t.a : t.b] = true;
      add(t, hit.s, toB ? t.len : 0, 0, 0, null);
    }
    while (queue.length) {
      var q = queue.shift(), hop = q.hop + 1;
      if (hop >= MAX_HOPS) { continue; }
      var n = q.seg.node, leave = q.seg.t0 + q.seg.dur + q.seg.dwell;
      var opts = nextFrom(board, n, q.seg.t, visited), take = Math.min(1, opts.length);
      // forks only where the copper really branches, never out of a part
      if (n.chip < 0 && opts.length > 1 && paths < MAX_PATHS && rng() < FORK_P) { take = 2; paths += 1; }
      // Two options can reach the same node (a via's top and inner traces):
      // a fork takes distinct destinations, so no node is arrived at twice.
      for (var i = 0, taken = 0; i < opts.length && taken < take; i++) {
        var o = opts[i];
        if (visited[core.farNode(o.t, o.from)]) { continue; }
        taken += 1;
        visited[o.from] = true;
        var fromA = o.t.a === o.from;
        add(o.t, fromA ? 0 : o.t.len, fromA ? o.t.len : 0, leave, hop, o.from !== n.id ? nodes[o.from] : null);
      }
    }
    return segs;
  }

  /* Schedule a planned chain from now. Idle packets step aside. */
  function activate(live, board, segs) {
    var base = live.t, end = base;
    for (var i = 0; i < live.packets.length; i++) {
      if (!live.packets[i].kill) { live.packets[i].kill = base; }
    }
    for (i = 0; i < segs.length; i++) {
      var sg = segs[i], arriveAt = base + sg.t0 + sg.dur;
      live.lit.push({ t: sg.t, s0: sg.s0, s1: sg.s1, t0: base + sg.t0, dur: sg.dur });
      live.flashes.push({ n: sg.node, t: arriveAt, strong: true, idle: false });
      if (sg.node.chip >= 0) { live.chipPulses.push({ ch: board.chips[sg.node.chip], t: arriveAt }); }
      // the exit pin lights as the current leaves
      if (sg.exit) { live.flashes.push({ n: sg.exit, t: base + sg.t0, strong: false, idle: false }); }
      end = Math.max(end, arriveAt + sg.dwell);
    }
    live.quietUntil = Math.max(live.quietUntil, end + IDLE_QUIET_AFTER_MS);
  }

  /* A click at (x, y): quiets the probe until the pointer moves on, then
   * returns the planned chain (or null when no trace is near). */
  function click(live, board, x, y, rng, out, speed) {
    live.quietX = x;
    live.quietY = y;
    var hit = clickHit(board, x, y, out);
    return hit ? planChain(board, hit, rng, speed) : null;
  }

  function makePacket(t, fromA, born, v, len, bus, hops, dive, cont) {
    return {
      t: t, s: fromA ? 0 : t.len, dir: fromA ? 1 : -1, born: born, v: v, len: len,
      bus: bus, done: false, hops: hops, dive: dive, cont: cont, kill: 0,
    };
  }

  function spawnIdle(live, board, s, netMax) {
    var busLive = false, netLive = 0, packets = live.packets, tm = live.t, rng = live.rng, i;
    for (i = 0; i < packets.length; i++) {
      if (packets[i].bus) { busLive = true; } else { netLive++; }
    }
    if (tm > live.nextBus && board.buses.length && !busLive) {
      // one launch, one speed: a length-matched group lands together
      var bus = board.buses[Math.floor(rng() * board.buses.length)], fwd = rng() >= 0.5;
      for (i = 0; i < bus.traces.length; i++) {
        packets.push(makePacket(board.traces[bus.traces[i]], fwd, tm, BUS_V, BUS_LEN * s, true, NET_HOPS, 0, false));
      }
      live.nextBus = tm + BUS_GAP_MS + rng() * BUS_GAP_JITTER_MS;
    }
    if (tm > live.nextNet && board.nets.length && netLive < netMax) {
      var st = board.traces[board.nets[Math.floor(rng() * board.nets.length)]];
      packets.push(makePacket(st, rng() < 0.5, tm, NET_V, NET_LEN * s, false, 0, 0, false));
      live.nextNet = tm + NET_GAP_MS + rng() * NET_GAP_JITTER_MS;
    }
  }

  // A net packet reaching its end hops onward (at most NET_HOPS times) or
  // dives through a via and resurfaces on the inner layer.
  function onPacketEnd(live, board, p, s) {
    var tm = live.t, rng = live.rng, nodes = board.nodes, traces = board.traces;
    var endNode = nodes[p.dir > 0 ? p.t.b : p.t.a];
    live.flashes.push({ n: endNode, t: tm, strong: false, idle: true });
    if (p.bus || endNode.chip >= 0) { return; }
    var onward = [], innerId = -1;
    for (var i = 0; i < endNode.traces.length; i++) {
      var id = endNode.traces[i];
      if (id === p.t.id) { continue; }
      if (traces[id].layer === 0) { onward.push(id); } else if (traces[id].layer === 1 && innerId < 0) { innerId = id; }
    }
    if (endNode.kind === 'via' && p.t.layer === 0 && innerId >= 0 && (!onward.length || rng() < 0.5)) {
      var it = traces[innerId];
      live.packets.push(makePacket(it, it.a === endNode.id, tm - 200, p.v, INNER_LEN * s, false, NET_HOPS, tm, false));
    } else if (onward.length && p.hops < NET_HOPS) {
      var nx = traces[onward[Math.floor(rng() * onward.length)]];
      live.packets.push(makePacket(nx, nx.a === endNode.id, tm - 200, p.v, p.len, false, p.hops + 1, 0, true));
      p.cont = true;
    }
  }

  /* One frame of state: probe fades, idle spawns, packet travel, and expiry
   * of everything scheduled. env: { speed, reducedMotion, netMax }. Entries
   * appended while a pass runs survive it. */
  function advanceLive(live, board, dtMs, env) {
    var dt = dtMs > 0 ? dtMs : 0, s = board.s || 1, i, w, n;
    live.t += dt;
    var tm = live.t;
    var quiet = Math.abs(live.pointerX - live.quietX) + Math.abs(live.pointerY - live.quietY) < QUIET_PX;
    var moving = false;
    for (i = live.probes.length - 1; i >= 0; i--) {
      var slot = live.probes[i], want = live.pointerOn && !quiet && slot.key === live.probeKey ? 1 : 0;
      if (env.reducedMotion) {
        slot.fade = want;
      } else {
        slot.fade += (want - slot.fade) * (1 - Math.exp(-dt / (want ? PROBE_IN_MS : quiet ? PROBE_QUIET_MS : PROBE_OUT_MS)));
      }
      if (!want && slot.fade < PROBE_EPS) {
        live.probes.splice(i, 1);
      } else if (Math.abs(want - slot.fade) > PROBE_EPS) {
        moving = true;
      }
    }
    live.probeMoving = moving;
    if (env.reducedMotion) { return; }

    if (tm > live.quietUntil) { spawnIdle(live, board, s, env.netMax === undefined ? NET_MAX : env.netMax); }
    var speed = env.speed > 0 ? env.speed : 1;
    var packets = live.packets;
    n = packets.length;
    for (i = 0, w = 0; i < n; i++) {
      var p = packets[i];
      p.s += p.dir * p.v * speed * dt * (p.t.layer === 1 ? INNER_SPEED : 1);
      var over = p.dir > 0 ? p.s - p.t.len : -p.s;
      if (over >= 0 && !p.done) {
        p.done = true;
        if (!p.kill) { onPacketEnd(live, board, p, s); } else { p.cont = false; }
      }
      if (over > p.len || (p.kill && tm - p.kill > KILL_MS)) { continue; }
      packets[w++] = p;
    }
    for (; i < packets.length; i++) { packets[w++] = packets[i]; }
    packets.length = w;

    var lit = live.lit;
    for (i = 0, w = 0; i < lit.length; i++) {
      var L = lit[i];
      if (tm - L.t0 > L.dur && Math.exp(-(tm - L.t0 - L.dur) / LIT_DECAY_MS) < LIT_MIN_ALPHA) { continue; }
      lit[w++] = L;
    }
    lit.length = w;
    var pulses = live.chipPulses;
    for (i = 0, w = 0; i < pulses.length; i++) {
      if (tm - pulses[i].t > CHIP_PULSE_MS) { continue; }
      pulses[w++] = pulses[i];
    }
    pulses.length = w;
    var flashes = live.flashes;
    for (i = 0, w = 0; i < flashes.length; i++) {
      if (tm - flashes[i].t >= (flashes[i].strong ? FLASH_STRONG_MS : FLASH_WEAK_MS)) { continue; }
      flashes[w++] = flashes[i];
    }
    flashes.length = w;
  }

  // Something the user can see is moving: a probe fading, a packet, the chain.
  function isResponding(live) {
    return live.probeMoving || live.packets.length > 0 || live.lit.length > 0
      || live.flashes.length > 0 || live.chipPulses.length > 0;
  }

  function drawProbeSlot(ctx, board, slot, color, s) {
    ctx.globalAlpha = PROBE_ALPHA * slot.fade;
    ctx.strokeStyle = color;
    ctx.lineWidth = PROBE_WIDTH;
    ctx.beginPath();
    for (var i = 0; i < slot.list.length; i++) {
      var t = board.traces[slot.list[i]];
      core.tracePath(ctx, t, 0, t.len);
    }
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    for (i = 0; i < slot.ends.length; i++) { core.nodeShape(ctx, board.nodes[slot.ends[i]], s, NODE_GROW); }
    ctx.fill();
  }

  /* Reduced motion: the planned chain, drawn at once. */
  function drawPlan(ctx, board, segs, color) {
    var s = board.s || 1;
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.9;
    ctx.beginPath();
    for (var i = 0; i < segs.length; i++) { core.tracePath(ctx, segs[i].t, segs[i].s0, segs[i].s1); }
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    for (i = 0; i < segs.length; i++) {
      core.nodeShape(ctx, segs[i].node, s, NODE_GROW);
      if (segs[i].exit) { core.nodeShape(ctx, segs[i].exit, s, NODE_GROW); }
    }
    ctx.fill();
  }

  var headPoint = { x: 0, y: 0, i: 1 };

  /* Draw the live layer (the caller has set the transform and cleared).
   * colors: { line, glow } token strings. */
  function drawLive(ctx, live, board, colors, reducedMotion) {
    var s = board.s || 1, tm = live.t, i;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (i = 0; i < live.probes.length; i++) {
      if (live.probes[i].fade > PROBE_EPS) { drawProbeSlot(ctx, board, live.probes[i], colors.line, s); }
    }
    if (reducedMotion) {
      if (live.pinned) { drawPlan(ctx, board, live.pinned, colors.glow); }
      ctx.globalAlpha = 1;
      return;
    }

    // idle packets: path-following trails that fade in, and out over their last trail length
    ctx.strokeStyle = colors.line;
    for (i = 0; i < live.packets.length; i++) {
      var p = live.packets[i], inner = p.t.layer === 1;
      var over = p.dir > 0 ? p.s - p.t.len : -p.s;
      var head = clamp(p.s, 0, p.t.len), tail = clamp(p.s - p.dir * p.len, 0, p.t.len);
      if (Math.abs(head - tail) < 0.5) { continue; }
      var a = smooth((tm - p.born) / FADE_IN_MS) * (p.cont ? 1 : 1 - smooth(over / p.len)) * (inner ? 0.5 : 1);
      if (p.kill) { a *= 1 - smooth((tm - p.kill) / KILL_MS); }
      if (p.dive) { a *= 0.5 + 0.5 * smooth((tm - p.dive) / DIVE_MS); }
      if (a <= 0) { continue; }
      ctx.beginPath();
      core.tracePath(ctx, p.t, tail, head);
      ctx.globalAlpha = 0.18 * a;
      ctx.lineWidth = inner ? 2.6 : 4;
      ctx.stroke();
      ctx.globalAlpha = 0.85 * a;
      ctx.lineWidth = inner ? 1.1 : 1.6;
      ctx.stroke();
    }

    // click chain: each planned hop travels, eased in and out of its nodes, on its schedule
    ctx.strokeStyle = colors.glow;
    ctx.fillStyle = colors.glow;
    for (i = 0; i < live.lit.length; i++) {
      var L = live.lit[i], k = (tm - L.t0) / L.dur;
      if (k < 0) { continue; }
      var sh = L.s0 + (L.s1 - L.s0) * easeInOut(k);
      var la = k < 1 ? 1 : Math.exp(-(tm - L.t0 - L.dur) / LIT_DECAY_MS);
      var innerL = L.t.layer === 1, part = L.t.layer === 2;
      ctx.beginPath();
      core.tracePath(ctx, L.t, L.s0, sh);
      ctx.globalAlpha = la * (innerL ? 0.45 : part ? 0.5 : 0.9);
      ctx.lineWidth = innerL ? 1.2 : part ? 4 : 1.9;
      ctx.stroke();
      if (k < 1) {
        // the bright head never reaches back past where the current started
        var hTail = L.s1 > L.s0 ? Math.max(L.s0, sh - HEAD_PX * s) : Math.min(L.s0, sh + HEAD_PX * s);
        ctx.beginPath();
        core.tracePath(ctx, L.t, hTail, sh);
        ctx.globalAlpha = innerL ? 0.6 : 1;
        ctx.lineWidth = innerL ? 1.8 : 2.6;
        ctx.stroke();
        core.pointAt(L.t, sh, headPoint);
        ctx.beginPath();
        ctx.arc(headPoint.x, headPoint.y, (innerL ? 1.7 : 2.3) * s, 0, TWO_PI);
        ctx.fill();
      }
    }

    // a part the current passes through: a restrained outline pulse
    ctx.lineWidth = 1.2;
    for (i = 0; i < live.chipPulses.length; i++) {
      var cp = live.chipPulses[i], age = tm - cp.t;
      if (age < 0) { continue; }
      ctx.globalAlpha = 0.4 * smooth(age / 90) * (1 - smooth((age - 90) / 710));
      ctx.beginPath();
      core.chipOutline(ctx, cp.ch, s, 0.5);
      ctx.stroke();
    }

    // node arrivals: the solid node lights with a small pop, one faint ring settles outward
    for (i = 0; i < live.flashes.length; i++) {
      var f = live.flashes[i], fage = tm - f.t;
      if (fage < 0) { continue; }
      var node = f.n, color = f.idle ? colors.line : colors.glow;
      var fill = f.strong ? 1 - smooth((fage - 200) / 700) : 0.7 * (1 - smooth(fage / FLASH_WEAK_MS));
      var pop = 1 + (f.strong ? 0.22 : 0.12) * Math.sin(Math.PI * clamp(fage / POP_MS, 0, 1));
      ctx.globalAlpha = fill * (node.kind === 'inner' ? 0.5 : 1);
      ctx.fillStyle = color;
      ctx.beginPath();
      core.nodeShape(ctx, node, s, pop);
      ctx.fill();
      if (f.strong && fage < RING_MS) {
        var q = fage / RING_MS, e = 1 - Math.pow(1 - q, 3);
        ctx.globalAlpha = 0.28 * (1 - q);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, core.nodeRadius(node, s) + (1.5 + 5 * e) * s, 0, TWO_PI);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  return {
    QUIET_PX: QUIET_PX,
    MAX_HOPS: MAX_HOPS,
    MAX_PATHS: MAX_PATHS,
    createLiveState: createLiveState,
    resetLive: resetLive,
    setPointer: setPointer,
    clearPointer: clearPointer,
    hoverHit: hoverHit,
    clickHit: clickHit,
    setProbe: setProbe,
    planChain: planChain,
    activate: activate,
    click: click,
    advanceLive: advanceLive,
    isResponding: isResponding,
    drawLive: drawLive,
    drawPlan: drawPlan,
  };
});
