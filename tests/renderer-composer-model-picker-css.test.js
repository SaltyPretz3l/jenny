'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

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

test('composer model carrier shells remain hidden beneath author styles', () => {
  const css = readRepoFile('styles/chat-composer-shell-v2.css');

  assert.match(
    findRuleBody(css, '.composer-model-popover .composer-select-shell[hidden]'),
    /display:\s*none;/
  );
  assert.match(findRuleBody(css, '.composer-model-carriers[hidden]'), /display:\s*none;/);
  assert.doesNotMatch(
    css,
    /\.composer-model-popover \.composer-select-shell\s*\{[^}]*display:\s*flex;/s
  );
  assert.doesNotMatch(css, /\.composer-model-popover-source/);
});

test('composer model pill labels truncate within the rail', () => {
  const css = readRepoFile('styles/chat-composer-shell-v2.css');
  const body = findRuleBody(css, '.composer-model-pill .inv-chip-label');

  assert.match(body, /max-width:\s*[^;]+;/);
  assert.match(body, /text-overflow:\s*ellipsis;/);
});

test('composer model popover contains the picker before hidden select carriers', () => {
  const html = readRepoFile('index.html');
  const dom = new JSDOM(html);
  const popover = dom.window.document.getElementById('composerModelPopover');
  const children = Array.from(popover.children);

  assert.ok(children[0].matches('div.composer-model-picker[data-composer-model-picker]'));
  assert.ok(children[1].matches('div.composer-model-carriers[hidden]'));
  assert.ok(children[1].querySelector('#composerModelSelect'));
  assert.ok(children[1].querySelector('#composerEffortSelect'));
  for (const retired of [
    'composerModelSource',
    'composerEffortSource',
    'composer-model-popover-source',
  ]) {
    assert.doesNotMatch(html, new RegExp(retired));
  }

  dom.window.close();
});
