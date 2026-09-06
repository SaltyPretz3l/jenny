/* comet/behaviors/anchored-orbit.js – elliptical orbit around a dock anchor (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.cometBehaviorAnchoredOrbit = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /* Speed varies around the orbit like a comet under gravity — faster at one end,
     slower at the other. ECCENTRICITY controls the amplitude of that variation. */
  var ORBIT_ECCENTRICITY = 0.28;

  /* The orbit radius slowly breathes in and out over several orbits. */
  var RADIUS_PULSE_AMPLITUDE = 0.07;  /* 7% variation */
  var RADIUS_PULSE_RATE = 0.00065;    /* ~9.7 s period */

  function createAnchoredOrbit(params) {
    var anchorX = params.anchorX || 400;
    var anchorY = params.anchorY || 300;
    var radiusX = params.radiusX || 40;
    var radiusY = params.radiusY || 25;
    var speed = params.speed || 1;
    var angle = 0;
    var elapsed = 0;
    var pulsePhase = Math.random() * Math.PI * 2; /* random start keeps instances varied */

    return {
      name: 'anchored-orbit',
      enter: function (pos) {
        /* start angle from current comet position so the transition is seamless */
        var dx = (pos.x || 0) - anchorX;
        var dy = (pos.y || 0) - anchorY;
        angle = Math.atan2(dy, dx);
        elapsed = 0;
      },
      update: function (dt) {
        var deltaMs = Number(dt);
        if (!isFinite(deltaMs) || deltaMs < 0) { deltaMs = 16; }
        elapsed += deltaMs;

        /* Kepler-like angular speed: faster near angle=0, slower near angle=π */
        var speedMod = 1 + ORBIT_ECCENTRICITY * Math.cos(angle);
        angle += (deltaMs / 1000) * speed * 1.8 * speedMod;

        /* slow radius pulse adds a gentle breathing quality to the orbit */
        var pulseFactor = 1 + RADIUS_PULSE_AMPLITUDE * Math.sin(elapsed * RADIUS_PULSE_RATE + pulsePhase);

        return {
          x: anchorX + Math.cos(angle) * radiusX * pulseFactor,
          y: anchorY + Math.sin(angle) * radiusY * pulseFactor,
        };
      },
      exit: function () {},
    };
  }

  return { createAnchoredOrbit: createAnchoredOrbit };
});
