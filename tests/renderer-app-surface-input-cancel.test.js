'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSurfaceInputRouter,
} = require('../renderer/app/renderer-app-surface-input.js');

function makeSurface() {
  const listeners = new Map();
  return {
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    },
    fire(type, event) {
      listeners.get(type)({
        type,
        target: this,
        ...event,
        composedPath: () => [this],
      });
    },
  };
}

test('clearing Home touch and pen pointers preserves their cancellation metadata', () => {
  const homeView = makeSurface();
  const seen = [];
  const target = {
    controller: { handleInput: (payload) => seen.push(payload) },
    effectId: 'probe',
    generation: 1,
    inputDisabled: false,
    layout: {},
  };
  const router = createSurfaceInputRouter({
    windowRef: {
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      addEventListener() {},
      removeEventListener() {},
    },
    dom: { homeView },
    getInputTarget: () => target,
  });

  homeView.fire('pointerenter', {
    pointerId: 7,
    pointerType: 'touch',
    isPrimary: false,
    clientX: 20,
    clientY: 30,
  });
  homeView.fire('pointerenter', {
    pointerId: 8,
    pointerType: 'pen',
    isPrimary: true,
    clientX: 40,
    clientY: 50,
  });
  router.clearPointerState('test-clear');

  const cancels = seen
    .filter((payload) => payload.type === 'cancel')
    .map(({ pointerId, pointerType, isPrimary, surfaceRole, reason }) => ({
      pointerId, pointerType, isPrimary, surfaceRole, reason,
    }));
  assert.deepEqual(cancels, [
    { pointerId: 7, pointerType: 'touch', isPrimary: false, surfaceRole: 'home', reason: 'test-clear' },
    { pointerId: 8, pointerType: 'pen', isPrimary: true, surfaceRole: 'home', reason: 'test-clear' },
  ]);
});
