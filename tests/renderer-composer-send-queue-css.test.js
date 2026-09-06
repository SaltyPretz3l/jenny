'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function findRuleBody(css, selector) {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorList = match[1].replace(/\/\*[\s\S]*?\*\//g, '');
    if (selectorList.split(',').map((item) => item.trim()).includes(selector)) return match[2];
  }
  return '';
}

// The queue-state send pill ("Queue - runs in Ask") is width:auto in
// chat-composer.css at specificity (0,2,0). The IDE chat dock and the narrow
// chat-view media query set the send button back to a 44px circle with the
// SAME specificity from later stylesheets, which clipped the label. Each of
// those sheets must carry a higher-specificity auto-width override.
test('queue-state send pill keeps auto width in the IDE dock and narrow chat view', () => {
  const dock = readRepoFile('styles/ide-chat-dock.css');
  const narrow = readRepoFile('styles/chat-media-queries.css');
  assert.match(findRuleBody(dock, '.ide-chat-dock-body .composer-send.composer-send-queue'), /width:\s*auto;/);
  assert.match(findRuleBody(narrow, '.chat-view .composer-send.composer-send-queue'), /width:\s*auto;/);
});

test('queue-state send pill can shrink and clips with an ellipsis instead of overflowing', () => {
  const body = findRuleBody(readRepoFile('styles/chat-composer.css'), '.composer-send.composer-send-queue');
  assert.match(body, /width:\s*auto;/);
  assert.match(body, /min-width:\s*0;/);
  assert.match(body, /overflow:\s*hidden;/);
  assert.match(body, /text-overflow:\s*ellipsis;/);
});
