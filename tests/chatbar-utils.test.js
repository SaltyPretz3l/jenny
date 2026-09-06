const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatTokenUsageDisplay,
  normalizeReasoningEffort,
  resolveComposerModelSelectWidth,
} = require('../renderer/chat/chatbar-utils');

test('formatTokenUsageDisplay returns an estimated label and width percentage when limit is known', () => {
  const payload = formatTokenUsageDisplay(2048, 8192, '8K');

  assert.equal(payload.label, 'Est. tokens: 2,048 / 8K');
  assert.equal(payload.widthPercent, 25);
  assert.equal(payload.showProgress, true);
});

test('formatTokenUsageDisplay hides progress when the limit is unknown', () => {
  const payload = formatTokenUsageDisplay(128, null, '');

  assert.equal(payload.label, 'Est. tokens: 128 / -');
  assert.equal(payload.widthPercent, 0);
  assert.equal(payload.showProgress, false);
});

test('normalizeReasoningEffort falls back to default for unsupported values', () => {
  assert.equal(normalizeReasoningEffort('HIGH'), 'high');
  assert.equal(normalizeReasoningEffort('xhigh'), 'xhigh');
  assert.equal(normalizeReasoningEffort('extra high'), 'xhigh');
  assert.equal(normalizeReasoningEffort('weird'), 'default');
  assert.equal(normalizeReasoningEffort(''), 'default');
});

test('resolveComposerModelSelectWidth clamps dynamic model widths for desktop and narrow layouts', () => {
  assert.equal(resolveComposerModelSelectWidth(44, 1280), 96);
  assert.equal(resolveComposerModelSelectWidth(180, 1280), 214);
  assert.equal(resolveComposerModelSelectWidth(320, 1280), 240);
  assert.equal(resolveComposerModelSelectWidth(220, 820), 184);
});
