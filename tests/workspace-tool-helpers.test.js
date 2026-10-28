'use strict';

/* The workspace-relative path and failure helpers shared by workspace_present,
 * preview_test and the presentation service (services/shared/workspace-tool-helpers.js). */

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extensionOf,
  realpathSafe,
  toRelativePosix,
} = require('../services/shared/workspace-tool-helpers');

test('toRelativePosix keeps only safe workspace-relative POSIX paths', () => {
  assert.equal(toRelativePosix(' ./docs/./a.md '), 'docs/a.md');
  assert.equal(toRelativePosix(['docs', 'a.md'].join(String.fromCharCode(92))), 'docs/a.md');
  for (const unsafe of ['', '/etc/passwd', 'C:/x.md', 'a/../b.md', 'a\0b', 'file:a', 7, null]) {
    assert.equal(toRelativePosix(unsafe), '', String(unsafe));
  }
});

test('extensionOf reads the last segment and ignores dotfiles', () => {
  assert.equal(extensionOf('site/Index.HTML'), 'html');
  assert.equal(extensionOf('a.b/readme'), '');
  assert.equal(extensionOf('.env'), '');
});

test('realpathSafe falls back to a resolved path when realpath fails', async () => {
  assert.equal(await realpathSafe({ realpath: async () => '/real' }, 'x'), '/real');
  assert.equal(await realpathSafe({ realpath: async () => { throw new Error('gone'); } }, 'x'), path.resolve('x'));
});

