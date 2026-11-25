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

// The send button is sized once, by --composer-primary-control-size. The IDE
// chat dock and the narrow chat-view media query used to size it from later
// stylesheets; density now only changes the token, so neither sheet may size
// the send button (row 192: the queue state keeps that same size).
test('the IDE dock and narrow chat view size Send only through the control-size token', () => {
  const dock = readRepoFile('styles/ide-chat-dock.css');
  const narrow = readRepoFile('styles/chat-media-queries.css');
  assert.doesNotMatch(findRuleBody(dock, '.ide-chat-dock-body .composer-send'), /width:/);
  assert.doesNotMatch(findRuleBody(narrow, '.chat-view .composer-send'), /width:/);
  assert.match(findRuleBody(dock, '.ide-chat-dock-body .composer'), /--composer-primary-control-size:/);
  assert.match(findRuleBody(narrow, '.chat-view .composer'), /--composer-primary-control-size:/);
});

// Row 192 C11: Queue keeps Send's round shape and size (an icon, no label), so the toolbar never refits for it.
test('the queue-state send button keeps Send\'s size and round shape', () => {
  const css = readRepoFile('styles/chat-composer.css');
  assert.equal(findRuleBody(css, '.composer-send.composer-send-queue'), '', 'the text pill rule is gone');
  const body = findRuleBody(css, '.composer-send.composer-send-queue.composer-send-queue--icon');
  assert.match(body, /width:\s*var\(--composer-primary-control-size\);/);
  assert.match(body, /border-radius:\s*50%;/);
});
