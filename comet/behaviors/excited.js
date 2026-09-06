/* comet/behaviors/excited.js – fast figure-8 / spiral celebration behavior (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.cometBehaviorExcited = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var DEFAULT_INTENSITY = 1;
  var DEFAULT_DURATION = 2500;
  var BASE_RADIUS = 30;
  var BASE_SPEED = 0.006;

  var CENTER_BLEND_DURATION = 500;

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function createExcited(params) {
    var p = params || {};
    var intensity = Number(p.intensity) || DEFAULT_INTENSITY;
    var duration = Number(p.duration) || DEFAULT_DURATION;
    var intendedCenterX = isFinite(Number(p.centerX)) ? Number(p.centerX) : 0;
    var intendedCenterY = isFinite(Number(p.centerY)) ? Number(p.centerY) : 0;

    var elapsed = 0;
    var startPos = { x: 0, y: 0 };
    var hasIntendedCenter = intendedCenterX !== 0 || intendedCenterY !== 0;

    function enter(currentPos) {
      startPos.x = currentPos.x;
      startPos.y = currentPos.y;
      if (!hasIntendedCenter) {
        intendedCenterX = currentPos.x;
        intendedCenterY = currentPos.y;
      }
      elapsed = 0;
    }

    function update(dt, ctx) {
      elapsed += dt;

      /* ease center from start position toward intended center over first 500ms */
      var centerBlend = easeInOutCubic(Math.min(1, elapsed / CENTER_BLEND_DURATION));
      var activeCenterX = startPos.x + (intendedCenterX - startPos.x) * centerBlend;
      var activeCenterY = startPos.y + (intendedCenterY - startPos.y) * centerBlend;

      /* decay intensity over duration */
      var progress = Math.min(1, elapsed / duration);
      var decay = 1 - progress * progress;
      var currentIntensity = intensity * decay;
      var radius = BASE_RADIUS * currentIntensity;

      /* figure-8 (lemniscate of Bernoulli, parameterized) */
      var t = elapsed * BASE_SPEED * intensity;
      var denom = 1 + Math.sin(t) * Math.sin(t);
      var x = activeCenterX + radius * Math.cos(t) / denom;
      var y = activeCenterY + radius * Math.sin(t) * Math.cos(t) / denom;

      /* blend toward center as energy decays */
      x = x * decay + activeCenterX * (1 - decay);
      y = y * decay + activeCenterY * (1 - decay);

      return { x: x, y: y };
    }

    function exit() { /* no cleanup needed */ }

    return { name: 'excited', enter: enter, update: update, exit: exit };
  }

  return { createExcited: createExcited };
});
