const test = require('node:test');
const assert = require('node:assert/strict');

const { createThinkingIndicator, SHIMMER_DELAY_MS, MIN_DISPLAY_MS, DURATION_FEEDBACK_MS } = require('../renderer/chat/renderer-thinking-indicator');
const { createFakeTimers } = require('./helpers/fake-timers');

function createTimedIndicator() {
  const timers = createFakeTimers();
  const indicator = createThinkingIndicator({
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { indicator, timers };
}

test('createThinkingIndicator returns correct API', () => {
  const indicator = createThinkingIndicator();
  assert.equal(typeof indicator.startIndicator, 'function');
  assert.equal(typeof indicator.updateIndicator, 'function');
  assert.equal(typeof indicator.completeIndicator, 'function');
  assert.equal(typeof indicator.getDisplayState, 'function');
  assert.equal(typeof indicator.resetIndicator, 'function');
  assert.equal(typeof indicator.dispose, 'function');
  indicator.dispose();
});

test('startIndicator sets mode and shouldShow', () => {
  const indicator = createThinkingIndicator();
  indicator.startIndicator('thinking');
  const state = indicator.getDisplayState();
  assert.equal(state.mode, 'thinking');
  assert.equal(state.shouldShow, true);
  assert.equal(state.shimmerActive, false);
  assert.ok(!(['is', 'Stalled'].join('') in state));
  indicator.dispose();
});

test('mode transitions update state', () => {
  const indicator = createThinkingIndicator();
  indicator.startIndicator('thinking');
  assert.equal(indicator.getDisplayState().mode, 'thinking');
  indicator.updateIndicator('responding');
  assert.equal(indicator.getDisplayState().mode, 'responding');
  indicator.updateIndicator('tool-use');
  assert.equal(indicator.getDisplayState().mode, 'tool-use');
  indicator.dispose();
});

test('shimmer activates after delay', () => {
  const { indicator, timers } = createTimedIndicator();
  indicator.startIndicator('thinking');
  assert.equal(indicator.getDisplayState().shimmerActive, false);
  timers.tick(SHIMMER_DELAY_MS);
  assert.equal(indicator.getDisplayState().shimmerActive, true);
  indicator.dispose();
});

test('2s min display prevents immediate hide', () => {
  const { indicator, timers } = createTimedIndicator();
  indicator.startIndicator('thinking');
  indicator.completeIndicator();
  const state = indicator.getDisplayState();
  assert.equal(state.shouldShow, true, 'shouldShow must remain true during min-display window');
  timers.tick(MIN_DISPLAY_MS);
  assert.equal(indicator.getDisplayState().shouldAutoHide, true);
  indicator.dispose();
});

test('completeIndicator computes duration', () => {
  const { indicator, timers } = createTimedIndicator();
  indicator.startIndicator('thinking');
  timers.tick(1500);
  indicator.completeIndicator();
  timers.tick(MIN_DISPLAY_MS - 1500);
  const state = indicator.getDisplayState();
  assert.ok(state.durationSeconds >= 1, `expected duration >= 1s, got ${state.durationSeconds}`);
  assert.match(state.durationText, /thought for \d+s/);
  indicator.dispose();
});

test('duration feedback hides after 2s', () => {
  const { indicator, timers } = createTimedIndicator();
  indicator.startIndicator('thinking');
  timers.tick(1500);
  indicator.completeIndicator();
  timers.tick(MIN_DISPLAY_MS - 1500);
  assert.ok(indicator.getDisplayState().durationText);
  timers.tick(DURATION_FEEDBACK_MS);
  assert.equal(indicator.getDisplayState().durationText, '');
  indicator.dispose();
});

test('completeIndicator settles to idle after duration feedback finishes', () => {
  const { indicator, timers } = createTimedIndicator();
  indicator.startIndicator('thinking');
  timers.tick(1500);
  indicator.completeIndicator();
  timers.tick(MIN_DISPLAY_MS - 1500);
  const settled = indicator.getDisplayState();
  assert.equal(settled.mode, 'idle');
  assert.equal(settled.shouldShow, true);
  timers.tick(DURATION_FEEDBACK_MS);
  const hidden = indicator.getDisplayState();
  assert.equal(hidden.mode, 'idle');
  assert.equal(hidden.shouldShow, false);
  indicator.dispose();
});

test('resetIndicator clears all state', () => {
  const indicator = createThinkingIndicator();
  indicator.startIndicator('thinking');
  indicator.resetIndicator();
  const state = indicator.getDisplayState();
  assert.equal(state.mode, 'idle');
  assert.equal(state.shouldShow, false);
  assert.equal(state.shimmerActive, false);
  indicator.dispose();
});

test('auto-hide triggers immediately after completion when duration < 1s', () => {
  const { indicator, timers } = createTimedIndicator();
  indicator.startIndicator('thinking');
  timers.tick(100);
  indicator.completeIndicator();
  timers.tick(MIN_DISPLAY_MS);
  assert.equal(indicator.getDisplayState().shouldAutoHide, true);
  indicator.dispose();
});

test('resetIndicator clears auto-hide after successful completion state', () => {
  const { indicator, timers } = createTimedIndicator();
  indicator.startIndicator('thinking');
  timers.tick(100);
  indicator.completeIndicator();
  timers.tick(MIN_DISPLAY_MS);
  indicator.resetIndicator();
  const state = indicator.getDisplayState();
  assert.equal(state.mode, 'idle');
  assert.equal(state.shouldShow, false);
  assert.equal(state.shouldAutoHide, false);
  indicator.dispose();
});

test('onStateChange callback fires on transitions', () => {
  const calls = [];
  const indicator = createThinkingIndicator({
    onStateChange: (s) => calls.push(s.mode),
  });
  indicator.startIndicator('thinking');
  indicator.updateIndicator('responding');
  assert.ok(calls.includes('thinking'));
  assert.ok(calls.includes('responding'));
  indicator.dispose();
});

test('exported constants match expected values', () => {
  assert.equal(SHIMMER_DELAY_MS, 400);
  assert.equal(MIN_DISPLAY_MS, 2000);
  assert.equal(DURATION_FEEDBACK_MS, 400);
});
