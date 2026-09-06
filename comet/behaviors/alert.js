/* comet/behaviors/alert.js – quick dash to target position + pulse (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.cometBehaviorAlert = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var DEFAULT_DASH_SPEED = 0.5;
  var DEFAULT_PULSE_COUNT = 3;
  var PULSE_DURATION = 300;

  function createAlert(params) {
    var p = params || {};
    var targetX = Number(p.targetX) || 0;
    var targetY = Number(p.targetY) || 0;
    var dashSpeed = Number(p.dashSpeed) || DEFAULT_DASH_SPEED;
    var pulseCount = Math.round(Number(p.pulseCount) || DEFAULT_PULSE_COUNT);
    var onComplete = typeof p.onComplete === 'function' ? p.onComplete : null;

    var pos = { x: 0, y: 0 };
    var phase = 'dash';
    var pulsesRemaining = pulseCount;
    var pulseElapsed = 0;
    var completed = false;

    function enter(currentPos) {
      pos.x = currentPos.x;
      pos.y = currentPos.y;
      phase = 'dash';
      pulsesRemaining = pulseCount;
      pulseElapsed = 0;
      completed = false;
    }

    function update(dt, ctx) {
      if (phase === 'dash') {
        var dx = targetX - pos.x;
        var dy = targetY - pos.y;
        var dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 3) {
          pos.x = targetX;
          pos.y = targetY;
          phase = 'pulse';
          pulseElapsed = 0;
        } else {
          var step = dashSpeed * dt;
          var ratio = Math.min(1, step / dist);
          pos.x += dx * ratio;
          pos.y += dy * ratio;
        }
        return { x: pos.x, y: pos.y };
      }

      if (phase === 'pulse') {
        pulseElapsed += dt;
        if (pulseElapsed >= PULSE_DURATION) {
          pulsesRemaining--;
          pulseElapsed = 0;
          if (pulsesRemaining <= 0) {
            phase = 'done';
            if (onComplete && !completed) { completed = true; onComplete(); }
          }
        }
        /* small oscillation during pulse */
        var pulseT = pulseElapsed / PULSE_DURATION;
        var offset = Math.sin(pulseT * Math.PI * 2) * 4;
        return { x: targetX + offset, y: targetY };
      }

      /* done: hold at target */
      return { x: targetX, y: targetY };
    }

    function exit() { /* no cleanup needed */ }

    return { name: 'alert', enter: enter, update: update, exit: exit };
  }

  return { createAlert: createAlert };
});
