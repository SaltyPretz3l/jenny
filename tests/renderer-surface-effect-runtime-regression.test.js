const test = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../renderer/shell/renderer-surface-effect-runtime');

test('clearCanvasOcclusions preserves an effective backing-store DPR below one', () => {
  const transforms = [];
  const context = {
    save() {},
    restore() {},
    setTransform(...args) { transforms.push(args); },
    clearRect() {},
  };
  const effectiveDpr = runtime.computeEffectiveDpr({
    deviceDpr: 2,
    dprCap: 1.75,
    maxBackingPixels: 4000000,
    cssWidth: 4000,
    cssHeight: 4000,
  });

  assert.equal(effectiveDpr, 0.5);
  assert.equal(runtime.clearCanvasOcclusions(context, [
    { left: 0, top: 0, width: 10, height: 10 },
  ], effectiveDpr), 1);
  assert.deepEqual(transforms, [[0.5, 0, 0, 0.5, 0, 0]]);
});
