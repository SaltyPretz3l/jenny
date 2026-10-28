'use strict';

// Diff controller (renderer-ide-diff-controller): the safety writes (whole-file
// revert, per-hunk reject) refuse a file with mixed line endings. Split from
// renderer-ide-diff-controller.test.js at its file-size ceiling.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildJennyChangeLedgerFromTurnViewModels } = require('../renderer/chat/renderer-jenny-change-ledger');
const { createHarness, buildChangeTurn, settle } = require('./helpers/renderer-ide-harness');

function confirmButton(harness, action) {
  return harness.dom.window.document.body.querySelector(`[data-ide-confirm-action="${action}"]`);
}

// The sidecar structured-diff wire fixture for the a/b/c -> a/B/c edit.
function hunksFor() {
  return [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }];
}

async function activateIde(harness) {
  await harness.controller.activateIde();
  await settle();
}

async function openLedgerChange(harness, index = 0) {
  const ledger = buildJennyChangeLedgerFromTurnViewModels(harness.turnViewModels, {
    sessionId: String(harness.state.currentSessionId || ''),
    workspaceId: String(harness.state.workspaceRoot?.rootId || ''),
  });
  const change = ledger.changes[index];
  assert.ok(change?.changeId, 'the fixture yields a ledger change');
  await harness.controller.openLedgerChangeById(change.changeId);
  await settle();
  return change;
}

// Whole-file revert's UI path: the change diff tab's toolbar Revert action.
async function clickToolbarRevert(harness) {
  await openLedgerChange(harness);
  const revertEl = harness.getDom().ideDiffToolbar.querySelector('[data-ide-diff-revert]');
  assert.ok(revertEl && !revertEl.disabled, 'the change diff toolbar offers Revert');
  revertEl.click();
  await settle();
}

function diffToolbar(harness) {
  return harness.getDom().ideDiffToolbar;
}

// Mixed line endings: restoreEol(detectEol(raw)) rewrote EVERY line ending,
// and one stray lone CR turned the whole file into CR. A mixed-EOL file now
// refuses the safety write through the existing failure toast.
test('revert refuses a mixed-EOL file instead of rewriting every line ending', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\r\nB\nc\r\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', additions: 1, deletions: 1 }),
    ],
  });
  t.after(() => harness.dispose());
  await activateIde(harness);
  await clickToolbarRevert(harness);
  confirmButton(harness, 'confirm')?.click();
  await settle();
  assert.equal(harness.bridge.calls.writeFile.length, 0, 'no write over mixed line endings');
  assert.equal(harness.bridge.state.files['src/app.js'], 'a\r\nB\nc\r\n');
});

test('per-hunk reject refuses a file with a stray lone CR', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\nB\nc\r' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', hunks: hunksFor('a\nb\nc\n', 'a\nB\nc\n') }),
    ],
  });
  t.after(() => harness.dispose());
  await activateIde(harness);
  await openLedgerChange(harness);
  const toggle = diffToolbar(harness).querySelector('[data-ide-diff-hunk-toggle]');
  assert.ok(toggle, 'per-hunk is offered (the LF view matches Jenny\'s version)');
  toggle.click();
  await settle();
  assert.equal(harness.bridge.state.files['src/app.js'], 'a\nB\nc\r', 'the file is never rewritten to all-CR');
});
