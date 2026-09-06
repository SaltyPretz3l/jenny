'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chats-panel.css'), 'utf8');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} rule should exist`);
  return match[1];
}

test('chat group labels do not paint a sticky panel gradient', () => {
  const body = ruleBody('.group-label');
  assert.doesNotMatch(body, /position\s*:\s*sticky\b/);
  assert.doesNotMatch(body, /var\(--view-panel-bg\)/);
});

test('chat session rows do not restore per-row bottom dividers', () => {
  assert.doesNotMatch(ruleBody('.session-row'), /border-bottom\s*:/);
});
