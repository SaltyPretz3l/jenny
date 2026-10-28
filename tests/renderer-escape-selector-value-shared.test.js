'use strict';

// The app-wide escapeSelectorValue comes from the surface-state pipeline; it
// must be the one stream-dom-patch implementation, not a weaker copy that left
// newlines unescaped and turned a missing id into the text "null".

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSurfaceStatePipeline } = require('../renderer/chat/renderer-render-pipeline-surface-state');
const domPatchUtils = require('../renderer/chat/renderer-stream-dom-patch-utils');

test('the surface-state escapeSelectorValue is the shared dom-patch implementation', () => {
  const pipeline = createSurfaceStatePipeline({});
  assert.equal(pipeline.escapeSelectorValue, domPatchUtils.escapeSelectorValue);
  for (const value of ['plain-id', 'a"b\\c', 'line\nbreak', null, undefined]) {
    assert.equal(pipeline.escapeSelectorValue(value), domPatchUtils.escapeSelectorValue(value));
  }
  assert.equal(pipeline.escapeSelectorValue(null), '');
  assert.doesNotMatch(pipeline.escapeSelectorValue('line\nbreak'), /\n/u);
});
