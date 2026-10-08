'use strict';

/* Changes and Git, linked (row 40 W6, owner decision F8) at the controller: a Source
 * Control row Jenny changed carries a marker that opens Changes, and the Changes view
 * says whether her change is committed yet, with Open in Git for one that is not. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, settle, buildChangeTurn } = require('./helpers/renderer-ide-harness');

async function openIde(t, flags = {}) {
  const realDock = require('../renderer/features/renderer-ide-chat-dock');
  const opened = [];
  const turns = [buildChangeTurn({ turnId: 'turn-1', toolCallId: 'tool-1', path: 'a.txt', additions: 1 }),
    buildChangeTurn({ turnId: 'turn-2', toolCallId: 'tool-2', path: 'c.txt', additions: 1 })];
  const harness = createHarness({
    featureFlags: { ide_chat_dock: true, workspace_git: true, ...flags },
    turnViewModels: turns,
    bridgeOptions: {
      files: { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' },
      git: { branch: 'main', files: [{ path: 'a.txt', worktree: 'M', state: 'modified' }, { path: 'b.txt', worktree: 'M', state: 'modified' }] },
    },
    beforeController: () => {
      globalThis.rendererChangesView = require('../renderer/features/renderer-changes-view');
      // Records the turn and file the marker asks Changes to reveal.
      globalThis.rendererIdeChatDock = { ...realDock, createIdeChatDock(options) {
        const dock = realDock.createIdeChatDock(options);
        const openChanges = dock.openChanges;
        dock.openChanges = (target) => { opened.push(target); return openChanges(target); };
        return dock;
      } };
    },
  });
  t.after(() => { harness.dispose(); delete globalThis.rendererChangesView; });
  delete globalThis.rendererIdeChatDock;
  await harness.controller.activateIde();
  await settle(250); // the debounced git status refresh
  const doc = harness.dom.window.document;
  const q = (sel) => doc.querySelector(`#ideWorkbench ${sel}`);
  const click = (el) => el.dispatchEvent(new harness.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return { harness, doc, q, click, opened };
}

test('a Source Control row Jenny changed carries the marker, and it opens Changes', async (t) => {
  const { q, click, opened } = await openIde(t);
  click(q('[data-wb-tab="source-control"], [data-wb-strip="source-control"]'));
  await settle(50);
  const row = (path) => q(`[data-ide-scm-path="${path}"]`);
  assert.ok(row('a.txt'), 'the changed file is listed');
  const marker = row('a.txt').querySelector('[data-ide-scm-action="jenny-change"]');
  assert.ok(marker, "Jenny's file carries the marker");
  assert.equal(marker.textContent.trim(), 'Jenny');
  assert.equal(row('b.txt').querySelector('[data-ide-scm-action="jenny-change"]'), null, 'a file only the user changed does not');
  click(marker);
  await settle(50);
  assert.equal(q('[data-wb-tab="changes"]')?.getAttribute('aria-selected'), 'true', 'the Changes view is showing');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].turnId, 'turn-1', "Jenny's turn is the one revealed");
  assert.match(String(opened[0].fileKey), /a\.txt$/, 'and the file within it');
});

test('a later Jenny change to a listed file brings its marker without a git status change', async (t) => {
  const { harness, q, click } = await openIde(t);
  click(q('[data-wb-tab="source-control"], [data-wb-strip="source-control"]'));
  await settle(50);
  assert.equal(q('[data-ide-scm-path="b.txt"] [data-ide-scm-action="jenny-change"]'), null);
  harness.turnViewModels.push(buildChangeTurn({ turnId: 'turn-3', toolCallId: 'tool-3', path: 'b.txt', additions: 1 }));
  harness.controller.renderIde(); // a chat render: the dock sync re-checks the ledger (debounced)
  await settle(600);
  assert.ok(q('[data-ide-scm-path="b.txt"] [data-ide-scm-action="jenny-change"]'), 'the marker follows the ledger');
});

test('without the chat dock flag (no Changes view) no row carries the marker', async (t) => {
  const { q, click } = await openIde(t, { ide_chat_dock: false });
  click(q('[data-wb-tab="source-control"], [data-wb-strip="source-control"]'));
  await settle(50);
  assert.ok(q('[data-ide-scm-path="a.txt"]'), 'the changed file is listed');
  assert.equal(q('[data-ide-scm-action="jenny-change"]'), null);
});

test('the Changes view gets the git state, a git subscription and Open in Git from the controller', async (t) => {
  // The view renders these (tests/renderer-changes-view-git-status.test.js); here the
  // controller's mapping onto the git feature is checked through the deps it hands the dock.
  const realDock = require('../renderer/features/renderer-ide-chat-dock');
  let viewDeps = null;
  const turns = [buildChangeTurn({ turnId: 'turn-1', path: 'a.txt', additions: 1 })];
  const harness = createHarness({
    featureFlags: { ide_chat_dock: true, workspace_git: true },
    turnViewModels: turns,
    bridgeOptions: { files: { 'a.txt': 'a', 'c.txt': 'c' }, git: { branch: 'main', files: [{ path: 'a.txt', worktree: 'M', state: 'modified' }] } },
    beforeController: () => {
      globalThis.rendererIdeChatDock = { ...realDock, createIdeChatDock(options) { viewDeps = options.changesView.viewDeps; return realDock.createIdeChatDock(options); } };
    },
  });
  t.after(() => harness.dispose());
  delete globalThis.rendererIdeChatDock;
  await harness.controller.activateIde();
  await settle(250);
  assert.ok(viewDeps, 'the dock received the Changes view deps');
  assert.equal(viewDeps.getGitState('a.txt'), 'changed', 'a file in the git status is not committed yet');
  assert.equal(viewDeps.getGitState('c.txt'), 'clean', 'a file outside it is committed');
  const unsubscribe = viewDeps.subscribeGit(() => {});
  assert.equal(typeof unsubscribe, 'function', 'the subscription can be released');
  unsubscribe();
  assert.equal(typeof viewDeps.openInGit, 'function');
  viewDeps.openInGit('a.txt');
  await settle(50);
  const tab = harness.dom.window.document.querySelector('#ideWorkbench [data-wb-tab="source-control"]');
  assert.equal(tab?.getAttribute('aria-selected'), 'true', 'Open in Git shows Source Control');
  const focused = harness.dom.window.document.activeElement;
  assert.equal(focused?.closest?.('[data-ide-scm-path]')?.getAttribute('data-ide-scm-path'), 'a.txt', 'focus moves to the file row (row 40 gate)');
});
