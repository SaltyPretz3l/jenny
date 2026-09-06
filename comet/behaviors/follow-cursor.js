/* comet/behaviors/follow-cursor.js – spring-damper cursor attraction behavior (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.cometBehaviorFollowCursor = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var DEFAULT_FOLLOW_DISTANCE = 60;
  var DEFAULT_SPRING_K = 0.003;
  var DEFAULT_DAMPING = 0.92;
  var DEFAULT_MAX_SPEED = 0.8;
  var REFERENCE_FRAME_MS = 1000 / 60;

  function createFollowCursor(params) {
    var p = params || {};
    var followDistance = Number(p.followDistance) || DEFAULT_FOLLOW_DISTANCE;
    var springK = Number(p.springK) || DEFAULT_SPRING_K;
    var damping = Number(p.damping) || DEFAULT_DAMPING;
    var maxSpeed = Number(p.maxSpeed) || DEFAULT_MAX_SPEED;

    var pos = { x: 0, y: 0 };
    var vel = { x: 0, y: 0 };

    function enter(currentPos) {
      pos.x = currentPos.x;
      pos.y = currentPos.y;
      vel.x = 0;
      vel.y = 0;
    }

    function update(dt, ctx) {
      var mx = ctx.mouseX || 0;
      var my = ctx.mouseY || 0;

      var dx = mx - pos.x;
      var dy = my - pos.y;
      var dist = Math.sqrt(dx * dx + dy * dy);

      /* target point is followDistance away from cursor, along the line from comet to cursor */
      var targetX, targetY;
      if (dist > followDistance) {
        var ratio = (dist - followDistance) / dist;
        targetX = pos.x + dx * ratio;
        targetY = pos.y + dy * ratio;
      } else {
        targetX = pos.x;
        targetY = pos.y;
      }

      /* spring force toward target */
      var fx = (targetX - pos.x) * springK * dt;
      var fy = (targetY - pos.y) * springK * dt;

      var frameDamping = Math.pow(damping, dt / REFERENCE_FRAME_MS);
      vel.x = (vel.x + fx) * frameDamping;
      vel.y = (vel.y + fy) * frameDamping;

      /* clamp velocity */
      var speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
      if (speed > maxSpeed) {
        vel.x = (vel.x / speed) * maxSpeed;
        vel.y = (vel.y / speed) * maxSpeed;
      }

      pos.x += vel.x * dt;
      pos.y += vel.y * dt;

      /* soft clamp within bounds */
      var bounds = ctx.bounds || { width: 800, height: 600 };
      pos.x = Math.max(20, Math.min(bounds.width - 20, pos.x));
      pos.y = Math.max(20, Math.min(bounds.height - 20, pos.y));

      return { x: pos.x, y: pos.y };
    }

    function exit() {
      vel.x = 0;
      vel.y = 0;
    }

    return { name: 'follow-cursor', enter: enter, update: update, exit: exit };
  }

  return { createFollowCursor: createFollowCursor };
});
