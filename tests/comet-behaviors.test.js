const test = require('node:test');
const assert = require('node:assert/strict');

const { createFollowCursor } = require('../comet/behaviors/follow-cursor');

function simulateFollowCursor(frameMs, frameCount, params = {}) {
  const behavior = createFollowCursor(params);
  behavior.enter({ x: 100, y: 100 });
  let position;
  for (let index = 0; index < frameCount; index += 1) {
    position = behavior.update(frameMs, {
      mouseX: 500,
      mouseY: 100,
      bounds: { width: 800, height: 600 },
    });
  }
  return position;
}

test('follow-cursor damping is stable across frame steps for equal elapsed time', () => {
  const at60Hz = simulateFollowCursor(1000 / 60, 60, { springK: 0.0001 });
  const at120Hz = simulateFollowCursor(1000 / 120, 120, { springK: 0.0001 });

  assert.ok(
    Math.abs(at60Hz.x - at120Hz.x) < 0.2,
    `expected equal-time positions within 0.2px, got ${at60Hz.x} and ${at120Hz.x}`
  );
  assert.equal(at60Hz.y, at120Hz.y);
});

// Safe to pin to the last digit: at dt === REFERENCE_FRAME_MS the exponent is exactly
// 1, and Math.pow is specified to RETURN THE BASE for an exponent of +1, so this path
// is bit-identical to the pre-fix multiply. The 120 Hz case above goes through a real
// pow and is compared with a tolerance for that reason.
test('follow-cursor preserves the existing 60 Hz motion', () => {
  assert.deepEqual(simulateFollowCursor(1000 / 60, 60), {
    x: 533.8912993801529,
    y: 100,
  });
});
