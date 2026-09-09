'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createUpdateDialogController, deriveUpdateDialogViewModel, renderUpdateDialog } =
  require('../renderer/features/renderer-update-dialog-utils');
const { renderMarkdown } = require('../renderer/shared/markdown-utils');

test('release notes omit remote media even when the same source is in the normal markdown cache', () => {
  const notes = '## Fixes\n![tracker](https://evil.invalid/pixel)\n<img src="https://evil.invalid/other">\n<script>bad()</script>';
  assert.match(renderMarkdown(notes, { mermaid: 'plain' }), /<img/);
  const html = renderUpdateDialog({ status: 'manual', releaseNotesMarkdown: notes }, { renderMarkdown });
  assert.doesNotMatch(html, /<img|<script/i);
  assert.match(html, /Fixes/);
  assert.match(renderMarkdown(notes, { mermaid: 'plain' }), /<img/);
});

test('unchecked, ahead, manual and missing-package states never claim up to date', () => {
  for (const status of ['unchecked', 'ahead', 'manual', 'no-package', 'no-release']) {
    assert.doesNotMatch(deriveUpdateDialogViewModel({ status }).title, /up to date/i);
  }
  assert.equal(deriveUpdateDialogViewModel({ status: 'error', errorStage: 'download', canDownload: true })
    .actions[1].id, 'download');
  assert.equal(deriveUpdateDialogViewModel({ status: 'error', errorStage: 'install', canInstall: true })
    .actions[1].id, 'install');
});

test('progress retains DOM and keyboard focus; manual action always opens the fixed release page', async (t) => {
  const dom = new JSDOM('<div id="updateDialogMount"></div>');
  t.after(() => dom.window.close());
  let push;
  const opened = [];
  const windowRef = dom.window;
  windowRef.open = (...args) => opened.push(args);
  const controller = createUpdateDialogController({ windowRef, documentRef: windowRef.document,
    jennyShell: { updates: {
      onChanged(fn) { push = fn; return () => {}; },
      getState: async () => ({ status: 'unchecked' }),
    } } });
  t.after(() => controller.dispose());
  controller.bind();
  await Promise.resolve();
  const state = { status: 'downloading', latestVersion: '1.0.2', downloadProgress: { percent: 1 } };
  controller.open(state);
  const mount = windowRef.document.getElementById('updateDialogMount');
  const close = mount.querySelector('[data-step-modal-action="close"]');
  const progress = mount.querySelector('[role="progressbar"]');
  close.focus();
  push({ ...state, downloadProgress: { percent: 42 } });
  assert.equal(mount.querySelector('[role="progressbar"]'), progress);
  assert.equal(windowRef.document.activeElement, close);
  assert.equal(progress.getAttribute('aria-valuenow'), '42');
  assert.equal(mount.querySelector('.inv-step-modal-status').getAttribute('aria-live'), 'polite');
  push({ status: 'manual', releaseUrl: 'https://evil.invalid/', latestVersion: '1.0.2' });
  mount.querySelector('[data-step-modal-action="releases"]').click();
  assert.deepEqual(opened, [['https://github.com/SaltyPretz3l/jenny/releases', '_blank', 'noopener,noreferrer']]);
});
