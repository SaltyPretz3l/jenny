'use strict';

/* showPathMenu: the shared Reveal / Copy menu for views that hold workspace-relative paths (session rail, Changes view). */

const test = require('node:test');
const assert = require('node:assert/strict');

const { showPathMenu } = require('../renderer/features/renderer-ide-path-menu');

function windowStub() {
  const shown = [];
  const toasts = [];
  return {
    shown,
    toasts,
    inventoryContextMenu: { show: (options) => shown.push(options) },
    rendererSuggestedChangesHost: { showToastMessage: (message, meta) => toasts.push({ message, meta }) },
    jennyShell: { workspaceFs: { revealInFolder: async () => { throw new Error('boom'); } } },
  };
}

test('a relative file path opens the menu without a leading separator; a directory drops Open in Default App', () => {
  const win = windowStub();
  assert.equal(showPathMenu({ windowRef: win, path: 'src/a.js', anchorX: 1, anchorY: 2 }), true);
  assert.equal(win.shown[0].items[0].separator, undefined);
  assert.equal(win.shown[0].anchorX, 1);
  assert.ok(win.shown[0].items.some((item) => item.label === 'Open in Default App'));

  assert.equal(showPathMenu({ windowRef: win, path: 'src', kind: 'dir' }), true);
  const labels = win.shown[1].items.filter((item) => !item.separator).map((item) => item.label);
  assert.deepEqual(labels, ['Reveal in File Explorer', 'Copy Path', 'Copy Relative Path', 'Copy Name']);
});

test('absolute, escaping and empty paths show nothing, and so does a missing menu service', () => {
  const win = windowStub();
  for (const path of ['', 'C:\\w\\a.txt', 'c:/w/a.txt', '/etc/passwd', '\\\\host\\share', 'a\\..\\..\\b', '../out.txt', 'a/../../b']) {
    assert.equal(showPathMenu({ windowRef: win, path }), false, `path ${path}`);
  }
  assert.equal(win.shown.length, 0);
  assert.equal(showPathMenu({ windowRef: { ...win, inventoryContextMenu: null }, path: 'a.js' }), false);
});

test('a failed Reveal toasts through the shared host and logs without the full path', async () => {
  const win = windowStub();
  const logs = [];
  showPathMenu({ windowRef: win, path: 'src/a.js', appendClientLog: (...args) => logs.push(args) });
  await win.shown[0].items.find((item) => item.label === 'Reveal in File Explorer').action();
  assert.equal(win.toasts.length, 1);
  assert.equal(win.toasts[0].meta.tone, 'danger');
  assert.ok(logs.every(([, , data]) => !JSON.stringify(data).includes('src/a.js')));
});

test('a failed OS action logs a bounded reason, never the bridge error message', async () => {
  const win = windowStub();
  win.jennyShell.workspaceFs.revealInFolder = async () => { throw Object.assign(new Error('ENOENT: C:\\Users\\me\\secret\\a.js'), { code: 'ENOENT' }); };
  const logs = [];
  showPathMenu({ windowRef: win, path: 'src/a.js', appendClientLog: (...args) => logs.push(args) });
  await win.shown[0].items.find((item) => item.label === 'Reveal in File Explorer').action();
  assert.deepEqual(logs.map(([level, event, data]) => [level, event, data]), [['WARN', 'ide.reveal_in_folder_failed', { reason: 'ENOENT' }]]);
});
