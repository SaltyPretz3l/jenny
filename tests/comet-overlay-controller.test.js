'use strict';
// tests/comet-overlay-controller.test.js
// Behavioral unit tests for services/main/comet-overlay-controller.js
// Uses node:test + node:assert/strict — no Electron, no jsdom needed.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleCometOverlayToggle,
  isOverlayWindowAlive,
  normalizeCometOverlayPresencePayload,
} = require('../services/main/comet-overlay-controller');

// ---------------------------------------------------------------------------
// normalizeCometOverlayPresencePayload
// ---------------------------------------------------------------------------

test('normalizeCometOverlayPresencePayload — valid camelCase payload round-trips correctly', (t) => {
  const result = normalizeCometOverlayPresencePayload({
    state: 'LISTENING',
    phaseKind: 'reasoning',
    terminalStatus: 'completed',
    terminalSubcode: 'X'.repeat(80),
  });
  assert.equal(result.state, 'listening');
  assert.equal(result.phaseKind, 'reasoning');
  assert.equal(result.terminalStatus, 'completed');
  assert.equal(result.terminalSubcode.length, 64, 'terminalSubcode must be clamped to 64 chars');
  assert.equal(result.terminalSubcode, 'x'.repeat(64), 'terminalSubcode must be lowercased');
});

test('normalizeCometOverlayPresencePayload — snake_case keys are read correctly', (t) => {
  const result = normalizeCometOverlayPresencePayload({
    state: 'thinking',
    phase_kind: 'tool_use',
    terminal_status: 'denied',
    terminal_subcode: 'CODE_42',
  });
  assert.equal(result.state, 'thinking');
  assert.equal(result.phaseKind, 'tool_use');
  assert.equal(result.terminalStatus, 'denied');
  assert.equal(result.terminalSubcode, 'code_42');
});

test('normalizeCometOverlayPresencePayload — invalid state falls back to idle, invalid phaseKind to empty string', (t) => {
  const result = normalizeCometOverlayPresencePayload({ state: 'bogus', phaseKind: 'nope' });
  assert.equal(result.state, 'idle');
  assert.equal(result.phaseKind, '');
});

test('normalizeCometOverlayPresencePayload — no payload defaults to idle state', (t) => {
  const result = normalizeCometOverlayPresencePayload();
  assert.equal(result.state, 'idle');
  assert.equal(result.phaseKind, '');
  assert.equal(result.terminalStatus, '');
  assert.equal(result.terminalSubcode, '');
});

test('normalizeCometOverlayPresencePayload — terminalSubcode within 64 chars is not truncated', (t) => {
  const sub = 'abc123';
  const result = normalizeCometOverlayPresencePayload({ state: 'idle', terminal_subcode: sub });
  assert.equal(result.terminalSubcode, sub.toLowerCase());
});

test('normalizeCometOverlayPresencePayload — all allowed states are accepted without fallback', (t) => {
  const allowed = ['idle', 'listening', 'thinking', 'responding', 'tool-use', 'alert', 'happy', 'concerned'];
  for (const s of allowed) {
    const result = normalizeCometOverlayPresencePayload({ state: s });
    assert.equal(result.state, s, `state '${s}' should be accepted as-is`);
  }
});

// ---------------------------------------------------------------------------
// isOverlayWindowAlive
// ---------------------------------------------------------------------------

test('isOverlayWindowAlive — null returns false', (t) => {
  assert.equal(isOverlayWindowAlive(null), false);
});

test('isOverlayWindowAlive — undefined returns false', (t) => {
  assert.equal(isOverlayWindowAlive(undefined), false);
});

test('isOverlayWindowAlive — ref with isDestroyed()===true returns false', (t) => {
  const ref = { window: { isDestroyed: () => true } };
  assert.equal(isOverlayWindowAlive(ref), false);
});

test('isOverlayWindowAlive — ref with isDestroyed()===false returns true', (t) => {
  const ref = { window: { isDestroyed: () => false } };
  assert.equal(isOverlayWindowAlive(ref), true);
});

test('isOverlayWindowAlive — ref with no window property returns true', (t) => {
  // No window sub-object → isDestroyed defaults to false → alive
  assert.equal(isOverlayWindowAlive({}), true);
});

// ---------------------------------------------------------------------------
// handleCometOverlayToggle
// ---------------------------------------------------------------------------

test('handleCometOverlayToggle (a) — enabled:false disposes existing overlay and returns null', (t) => {
  let disposeCalls = 0;
  const currentOverlayRef = { dispose: () => { disposeCalls++; } };

  const result = handleCometOverlayToggle({
    data: { enabled: false },
    currentOverlayRef,
    isOverlayEnabled: () => true,
    createOverlay: () => ({}),
  });

  assert.equal(result, null, 'result must be null when disabling');
  assert.equal(disposeCalls, 1, 'dispose() must be called exactly once on the existing overlay');
});

test('handleCometOverlayToggle (b) — enabled:true but isOverlayEnabled()===false returns sentinel unchanged, no create', (t) => {
  let createCalls = 0;
  const sentinel = { window: { isDestroyed: () => false }, tag: 'sentinel' };

  const result = handleCometOverlayToggle({
    data: { enabled: true },
    currentOverlayRef: sentinel,
    isOverlayEnabled: () => false,
    createOverlay: () => { createCalls++; return {}; },
  });

  assert.equal(result, sentinel, 'must return the existing sentinel ref unchanged');
  assert.equal(createCalls, 0, 'createOverlay must NOT be called when overlay feature is disabled');
});

test('handleCometOverlayToggle (c) — enabled:true, feature on, but mainWindow destroyed — returns current ref, no create', (t) => {
  let createCalls = 0;
  const currentOverlayRef = { window: { isDestroyed: () => false }, tag: 'existing' };

  const result = handleCometOverlayToggle({
    data: { enabled: true },
    currentOverlayRef,
    isOverlayEnabled: () => true,
    mainWindowRef: { isDestroyed: () => true },
    createOverlay: () => { createCalls++; return {}; },
  });

  assert.equal(result, currentOverlayRef, 'must return current overlay ref when main window is destroyed');
  assert.equal(createCalls, 0, 'createOverlay must NOT be called when main window is destroyed');
});

test('handleCometOverlayToggle (d) — enabled:true, feature on, main window alive, no current overlay — creates new overlay', (t) => {
  let createCalls = 0;
  const createArgs = [];
  const madeOverlay = { window: { isDestroyed: () => false }, tag: 'new' };
  const mainWindowRef = { isDestroyed: () => false };

  const result = handleCometOverlayToggle({
    data: { enabled: true },
    currentOverlayRef: null,
    isOverlayEnabled: () => true,
    mainWindowRef,
    createOverlay: (win, opts) => {
      createCalls++;
      createArgs.push([win, opts]);
      return madeOverlay;
    },
  });

  assert.equal(result, madeOverlay, 'must return the newly created overlay');
  assert.equal(createCalls, 1, 'createOverlay must be called exactly once');
  assert.equal(createArgs[0][0], mainWindowRef, 'createOverlay first arg must be mainWindowRef');
  assert.equal(typeof createArgs[0][1].onDispose, 'function', 'createOverlay second arg must have onDispose function');
});

test('handleCometOverlayToggle (e) — enabled:true, feature on, main window alive, current overlay alive — returns same ref, no create', (t) => {
  let createCalls = 0;
  const aliveOverlay = { window: { isDestroyed: () => false }, tag: 'already-alive' };

  const result = handleCometOverlayToggle({
    data: { enabled: true },
    currentOverlayRef: aliveOverlay,
    isOverlayEnabled: () => true,
    mainWindowRef: { isDestroyed: () => false },
    createOverlay: () => { createCalls++; return {}; },
  });

  assert.equal(result, aliveOverlay, 'must return the already-alive overlay ref unchanged');
  assert.equal(createCalls, 0, 'createOverlay must NOT be called when current overlay is already alive');
});

test('handleCometOverlayToggle — enabled:false with null currentOverlayRef still returns null (no crash)', (t) => {
  const result = handleCometOverlayToggle({
    data: { enabled: false },
    currentOverlayRef: null,
  });
  assert.equal(result, null);
});
