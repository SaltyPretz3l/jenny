'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MAX_IMAGE_ATTACHMENTS } = require('../renderer/chat/renderer-composer-vision-gate');

test('renderer image cap matches the sidecar vision attachment cap', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'ai', 'engines', 'vision_input.py'), 'utf8');
  const match = source.match(/MAX_VISION_ATTACHMENTS\s*=\s*(\d+)/);
  assert.ok(match, 'sidecar MAX_VISION_ATTACHMENTS constant is present');
  assert.equal(MAX_IMAGE_ATTACHMENTS, Number(match[1]));
});
