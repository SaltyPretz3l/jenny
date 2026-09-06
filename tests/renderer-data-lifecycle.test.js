'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const utils = require('../renderer/features/renderer-data-lifecycle-utils');

test('data lifecycle UI utilities produce bounded summary copy', () => {
  assert.equal(utils.formatCount(1, 'chat', 'chats'), '1 chat');
  assert.equal(utils.formatCount(2, 'chat', 'chats'), '2 chats');
  assert.equal(utils.formatBytes(1536), '1.5 KB');
  assert.deepEqual(utils.normalizeOverview({
    ok: true,
    counts: { chats: -1, attachments: 2, memory: 3, workspace: 4 },
    workspace: { available: true, name: 'Project' },
    appearance: { paletteId: 'paper' },
  }), {
    chats: 0,
    attachments: 2,
    memory: 3,
    workspace: 4,
    workspaceAvailable: true,
    workspaceName: 'Project',
    defaultArchiveRoot: '',
    appearance: { paletteId: 'paper' },
  });
});

test('assistant markup contains the outcome-first and confirmation contracts without raw controls', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'uninstall.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'uninstall', 'renderer-uninstall-assistant.js'), 'utf8');
  assert.doesNotMatch(html, /<(?:button|input|select|textarea)\b/i);
  assert.match(renderer, /Before Jenny leaves this device/);
  assert.match(renderer, /Keep a recoverable archive/);
  assert.match(renderer, /Remove app only and leave Jenny data in place/);
  assert.match(renderer, /Permanently remove everything/);
  assert.match(renderer, /REMOVE JENNY/);
  assert.doesNotMatch(renderer, /lastArchiveOptions/);
  assert.doesNotMatch(renderer, /\u00c2\u00b7/);
  assert.match(renderer, /if \(!result \|\| !result\.ok\)/);
  assert.match(renderer, /if \(state\.view === 'error'\) state\.view = 'archive'/);
  assert.match(renderer, /previewWorkspaceArchive/);
  assert.match(renderer, /workspaceReviewId/);
  assert.match(renderer, /state\.workspaceReview = null;\s*await prepareRemoval/);
  assert.match(renderer, /state\.includeWorkspace = false/);
});

test('Settings archive and restore surfaces expose privacy and workspace choices', () => {
  const fs = require('fs');
  const path = require('path');
  const renderer = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'features', 'renderer-data-lifecycle.js'),
    'utf8'
  );
  assert.match(renderer, /Encrypted \(recommended\)/);
  assert.match(renderer, /<summary>Advanced<\/summary>/);
  assert.match(renderer, /Use readable plain archive/);
  assert.match(renderer, /Plain archives have no password protection/);
  assert.match(renderer, /settings-restore-workspace/);
  assert.match(renderer, /checked: false/);
  assert.match(renderer, /previewWorkspaceArchive/);
  assert.match(renderer, /previewWorkspaceRestore/);
  assert.match(renderer, /delete context\.element\.dataset\.workspaceReviewId/);
  assert.match(renderer, /function isCurrentModal/);
  assert.match(renderer, /finally \{/);
  assert.match(renderer, /beforeunload/);
  assert.doesNotMatch(renderer, /\u00c2\u00b7/);
  assert.match(renderer, /if \(!modal && candidate/);
});
