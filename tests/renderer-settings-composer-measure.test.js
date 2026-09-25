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

test('pretext branch lets the browser determine overflow for short content', (t) => {
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
  assert.equal(chatInput.style.overflowY, 'auto');
});

test('fallback branch leaves scrolling available at every measured height', (t) => {
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
  assert.equal(short.style.overflowY, 'auto');
});

test('CSS-capped and underestimated drafts remain scrollable below the JS height cap', (t) => {
  const previous = global.rendererPretextUtils;
  t.after(() => { global.rendererPretextUtils = previous; });

  for (const pretextEnabled of [false, true]) {
    global.rendererPretextUtils = {
      isEnabled: () => pretextEnabled,
      resolveFontString: () => 'normal normal 400 15px sans-serif',
      predictTextHeight: () => ({ height: 130 }),
    };
    // The dock's CSS caps the actual box at 120px, below the 144px JS cap.
    // A prediction can also underestimate the real content height.
    const input = createChatInput(pretextEnabled ? 200 : 130, MULTILINE);
    input.clientHeight = 120;
    const measure = createComposerMeasure({ state: {}, chatInput: input });
    measure.syncComposerInputHeight();

    assert.equal(input.style.height, '130px');
    assert.ok(input.scrollHeight > input.clientHeight);
    assert.equal(input.style.overflowY, 'auto', `scrolling available with pretext=${pretextEnabled}`);
  }
});
