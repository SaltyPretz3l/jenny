'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-thread.css'), 'utf8');

function getRuleBody(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing ${selector} rule`);
  return match[1];
}

test('only the thread column owns the viewport-height floor', () => {
  const columnRule = getRuleBody('.chat-thread-column');
  const timelineRule = getRuleBody('.chat-timeline');

  assert.match(columnRule, /min-height:\s*100%\s*;/);
  assert.doesNotMatch(
    timelineRule,
    /min-height:\s*100%\s*;/,
    'a nested viewport floor creates empty scroll range after the latest timeline row'
  );
});
