/* Circuit Trace owns v3+ trace-advancement policy and injected gesture
 * schedulers. It reads no controller scope and attaches no listeners. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-circuit-trace-core.js'));
    return;
  }
  root.rendererCircuitTraceGestures = factory(root.rendererCircuitTraceCore || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  /* Scene trace advancement (moved from the controller via core so the hop
   * policy — ambient random walk, v3+ routing currents, rendezvous
   * convergence, fork transients — lives in one place). env carries frame
   * conditions: { qualityScale, speedFactor, pulseDecayMs, currentDirX,
   * currentDirY, currentStrength, rendezvousTargetIdx }. With the v3+ fields
   * at their neutral values the walk is bit-identical to the legacy loop. */
  function advanceTraces(entry, dtMs, rng, env) {
    var nodes = entry.graph.nodes;
    if (nodes.length === 0) { return; }
    var pulses = entry.nodePulses;
    var speedMul = entry.speedMul * (env.speedFactor || 1);
    var rendezvousTarget = typeof env.rendezvousTargetIdx === 'number' ? env.rendezvousTargetIdx : -1;
    var targetNode = rendezvousTarget >= 0 ? nodes[rendezvousTarget] : null;
    var currentStrength = env.currentStrength || 0;

    var activeTraceCount = Math.max(1, Math.ceil(entry.traces.length * env.qualityScale));
    for (var i = 0; i < activeTraceCount; i++) {
      var tr = entry.traces[i];
      var from = nodes[tr.fromIdx];
      var to = nodes[tr.toIdx];
      if (!from || !to) { continue; }

      tr.t += tr.speed * speedMul * (tr.forkSpeedMul || 1) * dtMs;
      while (tr.t >= 1) {
        tr.t -= 1;
        tr.prevIdx = tr.fromIdx;
        tr.fromIdx = tr.toIdx;
        if (pulses && tr.fromIdx >= 0 && tr.fromIdx < pulses.length) {
          var stacked = pulses[tr.fromIdx] + core.NODE_PULSE_STACK;
          pulses[tr.fromIdx] = stacked > 1 ? 1 : stacked;
        }
        if (tr.forkHopsLeft > 0) {
          tr.forkHopsLeft -= 1;
          if (tr.forkHopsLeft === 0) { tr.forkSpeedMul = 1; }
        }
        var landed = nodes[tr.fromIdx];
        var nextIdx = -1;
        if (targetNode && i < core.RENDEZVOUS_TRACE_LIMIT && tr.fromIdx !== rendezvousTarget) {
          nextIdx = core.pickNeighborToward(nodes, landed, tr.prevIdx, targetNode.x, targetNode.y);
        } else if (currentStrength > 0 && (i % 2 === 0) && rng() < currentStrength) {
          nextIdx = core.pickNeighborAligned(nodes, landed, tr.prevIdx, env.currentDirX || 0, env.currentDirY || 0);
        }
        if (nextIdx < 0) { nextIdx = core.pickNeighbor(landed, tr.prevIdx, rng); }
        if (nextIdx < 0) { tr.t = 0; break; }
        tr.toIdx = nextIdx;
        from = nodes[tr.fromIdx];
        to = nodes[tr.toIdx];
      }

      var te = core.easeInOutQuad(tr.t);
      var hx = from.x + (to.x - from.x) * te;
      var hy = from.y + (to.y - from.y) * te;
      core.pushTrailPoint(tr, hx, hy);
    }

    if (pulses) {
      var decay = Math.exp(-dtMs / (env.pulseDecayMs || 320));
      for (var j = 0; j < pulses.length; j++) {
        pulses[j] *= decay;
        if (pulses[j] < 1e-4) { pulses[j] = 0; }
      }
    }
  }

  /* Routing current: a deterministic grid direction that rotates on a
   * seed-jittered 13–21s period. `routing` is a controller-owned mutable
   * { periodMs, epoch, dirX, dirY }. Traces adopt the direction only at hop
   * boundaries, so transitions smear over seconds instead of snapping. */
  function updateRoutingCurrent(routing, seed, now) {
    if (!routing.periodMs) {
      routing.periodMs = core.ROUTING_PERIOD_BASE_MS
        + Math.floor(core.makeRng((seed ^ 0x9e3779b9) >>> 0)() * core.ROUTING_PERIOD_JITTER_MS);
    }
    var epoch = Math.floor(now / routing.periodMs);
    if (epoch === routing.epoch) { return; }
    routing.epoch = epoch;
    var dirIdx = Math.floor(core.makeRng((seed ^ Math.imul(epoch, 2654435761)) >>> 0)() * 6);
    var angle = (60 * dirIdx) * Math.PI / 180;
    routing.dirX = Math.cos(angle);
    routing.dirY = Math.sin(angle);
  }

  /* Rendezvous: every 25–45s of sustained activity, up to four traces
   * converge on one allowed node, pulse it on first arrival, and scatter.
   * `rendezvous` is a controller-owned mutable
   * { active, targetIdx, endAt, nextAt, counter }. */
  function updateRendezvous(entry, rendezvous, now, af, spawnAllowed) {
    if (rendezvous.active) {
      var pulses = entry.nodePulses;
      var count = Math.min(core.RENDEZVOUS_TRACE_LIMIT, entry.traces.length);
      for (var i = 0; i < count; i++) {
        if (entry.traces[i].fromIdx === rendezvous.targetIdx) {
          if (pulses && pulses[rendezvous.targetIdx] < core.RENDEZVOUS_PULSE) {
            pulses[rendezvous.targetIdx] = core.RENDEZVOUS_PULSE;
          }
          rendezvous.active = false;
          break;
        }
      }
      if (rendezvous.active && now >= rendezvous.endAt) { rendezvous.active = false; }
      return;
    }
    if (af < core.RENDEZVOUS_MIN_ACTIVITY) { rendezvous.nextAt = 0; return; }
    if (!rendezvous.nextAt) {
      rendezvous.counter += 1;
      var gapRng = core.makeRng((entry.seed ^ Math.imul(rendezvous.counter, 40503)) >>> 0);
      rendezvous.nextAt = now + core.RENDEZVOUS_GAP_BASE_MS + gapRng() * core.RENDEZVOUS_GAP_JITTER_MS;
      return;
    }
    if (now < rendezvous.nextAt) { return; }
    rendezvous.nextAt = 0;
    var pickRng = core.makeRng((entry.seed ^ Math.imul(rendezvous.counter, 2654435761)) >>> 0);
    var nodes = entry.graph.nodes;
    for (var attempt = 0; attempt < 8 && nodes.length > 0; attempt++) {
      var idx = Math.floor(pickRng() * nodes.length);
      var node = nodes[idx];
      if (node && spawnAllowed(node.x, node.y)) {
        rendezvous.active = true;
        rendezvous.targetIdx = idx;
        rendezvous.endAt = now + core.RENDEZVOUS_WINDOW_MS;
        break;
      }
    }
  }

  /* A charged hold dispatches 1–3 forked packet traces from the nearest node,
   * with charge selecting the branch count; otherwise the release falls back
   * to a local tap at `fallbackAmplitude`. Quick releases produce no expanding
   * shell. The controller seeds `rng`, so identical input sequences fork
   * identically. Returns the fork count (0 = tap). */
  function dischargeGesture(entry, fallbackAmplitude, rng) {
    var chargeValue = entry.charge.value;
    var forked = 0;
    if (chargeValue >= core.FORK_CHARGE_THRESHOLD) {
      var branches = 1
        + (chargeValue >= core.FORK_BRANCH_TIER_2 ? 1 : 0)
        + (chargeValue >= core.FORK_BRANCH_TIER_3 ? 1 : 0);
      var originIdx = core.nearestNodeIndex(entry.graph, entry.charge.x, entry.charge.y);
      if (originIdx >= 0) {
        forked = core.retaskTraceFork(
          entry, originIdx, branches, rng,
          entry.version >= 4 ? core.FORK_SPEED_MUL_V4 : core.FORK_SPEED_MUL,
          core.FORK_HOP_BUDGET,
        );
      }
    }
    if (!forked) {
      core.tapPulse(entry, entry.charge.x, entry.charge.y, fallbackAmplitude);
    }
    return forked;
  }

  /* Returns every trace to ambient speed/hop state (fork transients off). */
  function resetForkTransients(entry) {
    for (var i = 0; i < entry.traces.length; i++) {
      entry.traces[i].forkHopsLeft = 0;
      entry.traces[i].forkSpeedMul = 1;
    }
  }

  return {
    advanceTraces: advanceTraces,
    updateRoutingCurrent: updateRoutingCurrent,
    updateRendezvous: updateRendezvous,
    dischargeGesture: dischargeGesture,
    resetForkTransients: resetForkTransients,
  };
});
