/* comet/behaviors/settle.js – move toward anchor point and hover gently (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.cometBehaviorSettle = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var DEFAULT_HOVER_RADIUS = 14;
  var DEFAULT_APPROACH_RATE = 0.006; /* per-ms exponential smoothing rate */
  var MICRO_DRIFT_SPEED = 0.0015;

  function createSettle(params) {
    var p = params || {};
    var anchorX = Number(p.anchorX) || 0;
    var anchorY = Number(p.anchorY) || 0;
    var hoverRadius = Number(p.hoverRadius) || DEFAULT_HOVER_RADIUS;
    var approachRate = Number(p.approachRate) || DEFAULT_APPROACH_RATE;

    var pos = { x: 0, y: 0 };
    var elapsed = 0;
    var settled = false;
    var phaseX = Math.random() * Math.PI * 2;
    var phaseY = Math.random() * Math.PI * 2;

    function enter(currentPos) {
      pos.x = currentPos.x;
      pos.y = currentPos.y;
      elapsed = 0;
      settled = false;
    }

    function update(dt, ctx) {
      elapsed += dt;
      var t = elapsed * MICRO_DRIFT_SPEED;

      /* approach anchor */
      var dx = anchorX - pos.x;
      var dy = anchorY - pos.y;
      var dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > hoverRadius * 2) {
        /* time-aware exponential approach (frame-rate independent) */
        var approachFactor = 1 - Math.exp(-approachRate * dt);
        pos.x += dx * approachFactor;
        pos.y += dy * approachFactor;
        settled = false;
      } else {
        settled = true;
      }

      /* layered sinusoidal micro-drift around anchor once settled */
      var driftX = Math.sin(t * 2.1 + phaseX) * hoverRadius
                 + Math.sin(t * 3.7 + phaseX * 1.3) * hoverRadius * 0.25;
      var driftY = Math.cos(t * 1.7 + phaseY) * hoverRadius * 0.6
                 + Math.cos(t * 2.9 + phaseY * 0.7) * hoverRadius * 0.15;

      if (settled) {
        return {
          x: anchorX + driftX,
          y: anchorY + driftY,
        };
      }

      /* blend drift in as we get closer */
      var blend = Math.max(0, 1 - dist / (hoverRadius * 4));
      return {
        x: pos.x + driftX * blend,
        y: pos.y + driftY * blend,
      };
    }

    function setAnchor(x, y) {
      anchorX = x;
      anchorY = y;
      settled = false;
    }

    function exit() { /* no cleanup needed */ }

    return {
      name: 'settle',
      enter: enter,
      update: update,
      exit: exit,
      setAnchor: setAnchor,
    };
  }

  return { createSettle: createSettle };
});
