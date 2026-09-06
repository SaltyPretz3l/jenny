/* comet/behaviors/idle-drift.js – gentle Perlin-noise-like wandering behavior (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.cometBehaviorIdleDrift = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var DEFAULT_SPEED = 0.3;
  var DEFAULT_NOISE_SCALE = 0.0004;
  var MARGIN = 40;

  /* Simplex-style pseudo-noise using layered sine waves */
  function pseudoNoise(t, seed) {
    return (
      Math.sin(t * 1.0 + seed) * 0.5 +
      Math.sin(t * 2.3 + seed * 1.7) * 0.25 +
      Math.sin(t * 4.1 + seed * 0.3) * 0.125
    ) / 0.875;
  }

  function createIdleDrift(params) {
    var p = params || {};
    var speed = Number(p.speed) || DEFAULT_SPEED;
    var noiseScale = Number(p.noiseScale) || DEFAULT_NOISE_SCALE;
    var explicitCenterX = Number(p.centerX);
    var explicitCenterY = Number(p.centerY);
    var explicitRangeX = Number(p.rangeX);
    var explicitRangeY = Number(p.rangeY);
    var hasExplicitCenterX = isFinite(explicitCenterX);
    var hasExplicitCenterY = isFinite(explicitCenterY);
    var hasExplicitRangeX = isFinite(explicitRangeX);
    var hasExplicitRangeY = isFinite(explicitRangeY);
    var seedX = Math.random() * 1000;
    var seedY = Math.random() * 1000 + 500;
    var elapsed = 0;
    var pos = { x: 0, y: 0 };
    var centerX = 0;
    var centerY = 0;

    function enter(currentPos) {
      pos.x = currentPos.x;
      pos.y = currentPos.y;
      centerX = hasExplicitCenterX ? explicitCenterX : currentPos.x;
      centerY = hasExplicitCenterY ? explicitCenterY : currentPos.y;
      elapsed = Math.random() * 10000;
    }

    function update(dt, ctx) {
      elapsed += dt * speed;
      var t = elapsed * noiseScale;

      var bounds = ctx.bounds || { width: 800, height: 600 };
      var rangeX = hasExplicitRangeX ? explicitRangeX : (bounds.width - MARGIN * 2) * 0.3;
      var rangeY = hasExplicitRangeY ? explicitRangeY : (bounds.height - MARGIN * 2) * 0.3;

      var targetX = centerX + pseudoNoise(t, seedX) * rangeX;
      var targetY = centerY + pseudoNoise(t, seedY) * rangeY;

      /* soft clamp within bounds */
      targetX = Math.max(MARGIN, Math.min(bounds.width - MARGIN, targetX));
      targetY = Math.max(MARGIN, Math.min(bounds.height - MARGIN, targetY));

      /* time-aware exponential smoothing (frame-rate independent) */
      var smoothingRate = 0.003;
      var factor = 1 - Math.exp(-smoothingRate * dt);
      pos.x += (targetX - pos.x) * factor;
      pos.y += (targetY - pos.y) * factor;

      return { x: pos.x, y: pos.y };
    }

    function exit() { /* no cleanup needed */ }

    return { name: 'idle-drift', enter: enter, update: update, exit: exit };
  }

  return { createIdleDrift: createIdleDrift };
});
