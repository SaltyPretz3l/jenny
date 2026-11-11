'use strict';

/* The workspace-relative path and failure helpers shared by workspace_present,
 * preview_test and the presentation service (services/shared/workspace-tool-helpers.js). */

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extensionOf,
  realpathSafe,
  resolveWorkspaceRelative,
  toRelativePosix,
  unsafePathMessage,
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


test('resolveWorkspaceRelative accepts an absolute path inside the root and a leading-slash path that exists in it', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsrel-'));
  try {
    fs.mkdirSync(path.join(root, 'site'));
    fs.writeFileSync(path.join(root, 'site', 'index.html'), '<p>x</p>');
    const resolve = (value) => resolveWorkspaceRelative(value, { root });
    assert.equal(await resolve(path.join(root, 'site', 'index.html')), 'site/index.html');
    assert.equal(await resolve(path.join(root, 'site', 'index.html').replace(/\\/g, '/')), 'site/index.html');
    assert.equal(await resolve('/site/index.html'), 'site/index.html');
    assert.equal(await resolve(['', 'site', 'index.html'].join(String.fromCharCode(92))), 'site/index.html');
    assert.equal(await resolve('site/index.html'), 'site/index.html', 'a relative path is unchanged');
    // Everything else keeps the refusal.
    assert.equal(await resolve('/nowhere/else.html'), '', 'leading slash that does not exist under the root');
    assert.equal(await resolve(path.join(path.dirname(root), 'elsewhere', 'x.html')), '', 'absolute outside the root');
    assert.equal(await resolve(root), '', 'the root itself is not a file');
    assert.equal(await resolve(`${root}/../escape.html`), '', 'an absolute path that climbs out');
    assert.equal(await resolve('/site/../../x.html'), '');
    assert.equal(await resolve('//server/share/x.html'), '');
    assert.equal(await resolve(7), '');
    assert.equal(await resolveWorkspaceRelative('/site/index.html', {}), '', 'no root, no help');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsafePathMessage gives an example and never echoes the path', () => {
  const message = unsafePathMessage('/abs/elsewhere/x.html');
  assert.match(message, /relative to the workspace root, such as src\/index\.html\.$/);
  assert.doesNotMatch(message, /elsewhere/);
});
