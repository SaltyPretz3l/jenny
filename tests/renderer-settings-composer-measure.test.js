const test = require('node:test');
const assert = require('node:assert/strict');

const { createComposerMeasure } = require('../renderer/shell/renderer-settings-composer-measure.js');

function createChatInput(scrollHeight, value) {
  return {
    value: typeof value === 'string' ? value : '',
    clientWidth: 400,
    scrollHeight,
    style: {},
  };
}

const MULTILINE = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10';

test('pretext branch keeps the composer scrollable when multi-line content exceeds the cap', (t) => {
  const previous = global.rendererPretextUtils;
  t.after(() => {
    global.rendererPretextUtils = previous;
  });

  let receivedOptions = null;
  // Mimics the pretext library: 'normal' whitespace collapses newlines and
  // under-predicts multi-line content; 'pre-wrap' preserves hard breaks and
  // reports the true (tall) height.
  global.rendererPretextUtils = {
    isEnabled() {
      return true;
    },
    resolveFontString() {
      return 'normal normal 400 15px sans-serif';
    },
    predictTextHeight(_cacheKey, _text, _font, _maxWidth, _lineHeight, options) {
      receivedOptions = options;
      const preWrap = options && options.whiteSpace === 'pre-wrap';
      return { height: preWrap ? 320 : 60 };
    },
  };

  const chatInput = createChatInput(320, MULTILINE);
  const { syncComposerInputHeight } = createComposerMeasure({ state: {}, chatInput });

  syncComposerInputHeight();

  assert.deepEqual(receivedOptions, { whiteSpace: 'pre-wrap' });
  assert.equal(chatInput.style.height, '144px', 'height clamped to the 144px cap');
  assert.equal(chatInput.style.overflowY, 'auto', 'tall content stays scrollable');
});

test('pretext branch hides overflow for short content', (t) => {
  const previous = global.rendererPretextUtils;
  t.after(() => {
    global.rendererPretextUtils = previous;
  });

  global.rendererPretextUtils = {
    isEnabled() {
      return true;
    },
    resolveFontString() {
      return 'normal normal 400 15px sans-serif';
    },
    predictTextHeight() {
      return { height: 40 };
    },
  };

  const chatInput = createChatInput(40, 'hi');
  const { syncComposerInputHeight } = createComposerMeasure({ state: {}, chatInput });

  syncComposerInputHeight();

  assert.equal(chatInput.style.height, '40px');
  assert.equal(chatInput.style.overflowY, 'hidden');
});

test('fallback branch bases overflow on the pre-clamp scrollHeight', (t) => {
  const previous = global.rendererPretextUtils;
  t.after(() => {
    global.rendererPretextUtils = previous;
  });

  // Pretext disabled -> fallback scrollHeight path.
  global.rendererPretextUtils = {
    isEnabled() {
      return false;
    },
  };

  const tall = createChatInput(500, MULTILINE);
  createComposerMeasure({ state: {}, chatInput: tall }).syncComposerInputHeight();
  assert.equal(tall.style.height, '144px');
  assert.equal(tall.style.overflowY, 'auto', 'fallback keeps tall content scrollable');

  const short = createChatInput(50, 'hi');
  createComposerMeasure({ state: {}, chatInput: short }).syncComposerInputHeight();
  assert.equal(short.style.height, '50px');
  assert.equal(short.style.overflowY, 'hidden');
});
