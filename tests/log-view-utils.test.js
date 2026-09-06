'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveLogSource, deriveLogSummary, formatRelativeTime } = require('../renderer/shared/log-view-utils');

test('compatibility log helpers retain safe source, summary, and relative-time formatting', () => {
  assert.equal(deriveLogSource({ layer: 'sidecar', event: 'runtime.ready' }), 'sidecar');
  assert.equal(deriveLogSummary({ message: 'Ready', details: {} }), 'Ready');
  assert.equal(typeof formatRelativeTime(new Date().toISOString()), 'string');
});
