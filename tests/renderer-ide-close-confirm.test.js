'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeCloseOrchestrator,
} = require('../renderer/features/renderer-ide-close-orchestrator');
const { createHarness, settle } = require('./helpers/renderer-ide-harness');
const { createDeferred } = require('./helpers/deferred');

function confirmButton(harness, action) {
  return harness.dom.window.document.body.querySelector(`[data-ide-confirm-action="${action}"]`);
}

function makeActiveDirty(harness, value) {
  const textarea = harness.getDom().ideEditorFallback;
  textarea.value = value;
  textarea.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
}

function closeActiveViaX(harness, path) {
  harness.getDom().ideTabStrip.querySelector(`[data-ide-tab-close="${path}"]`).click();
}

// ── Orchestrator unit (fakes for confirm + save) ─────────────────────────────

test('orchestrator closes a clean tab immediately without prompting', async () => {
  const closed = [];
  let prompts = 0;
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }] }),
    isDirty: () => false,
    forceClose: (p) => closed.push(p),
    confirmClose: () => { prompts += 1; return Promise.resolve('discard'); },
  });
  await orch.requestClose('a.js');
  assert.deepEqual(closed, ['a.js']);
  assert.equal(prompts, 0, 'a clean tab must not prompt');
});

test('orchestrator cancel aborts the whole batch', async () => {
  const closed = [];
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }, { path: 'b.js' }] }),
    isDirty: () => true,
    forceClose: (p) => closed.push(p),
    confirmClose: () => Promise.resolve('cancel'),
  });
  await orch.requestCloseAll();
  assert.deepEqual(closed, [], 'cancel leaves every tab open');
});

test('orchestrator save failure cancels the whole close mutation', async () => {
  const closed = [];
  const saved = [];
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }, { path: 'b.js' }] }),
    isDirty: () => true,
    forceClose: (p) => closed.push(p),
    saveFile: (p) => { saved.push(p); return Promise.resolve(p !== 'b.js'); }, // b.js save fails
    confirmClose: () => Promise.resolve('save'),
  });
  const result = await orch.requestCloseAll();
  assert.deepEqual(saved, ['a.js', 'b.js']);
  assert.deepEqual(closed, [], 'a failed save leaves the whole batch open');
  assert.equal(result.committed, false);
  assert.equal(result.code, 'save_failed');
  assert.equal(result.failedPath, 'b.js');
});

test('orchestrator preflight is non-destructive and discard happens only on explicit commit', async () => {
  const closed = [];
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }, { path: 'b.js' }] }),
    isDirty: () => true,
    forceClose: (path) => closed.push(path),
    confirmClose: () => Promise.resolve('discard'),
  });

  const plan = await orch.preflight(['a.js', 'b.js']);

  assert.equal(plan.ready, true);
  assert.equal(plan.decision, 'discard');
  assert.deepEqual(closed, [], 'preflight must not enact discard');

  const result = orch.commit(plan);
  assert.equal(result.committed, true);
  assert.deepEqual(closed, ['a.js', 'b.js']);

  const replay = orch.commit(plan);
  assert.equal(replay.committed, false, 'a preflight plan is single-use');
  assert.equal(replay.code, 'invalid_preflight');
});

test('orchestrator rejects save and discard plans when a document revision changes after preflight', async () => {
  for (const decision of ['save', 'discard']) {
    let revision = 1;
    const closed = [];
    const orch = createIdeCloseOrchestrator({
      getIde: () => ({ openTabs: [{ path: 'a.js' }] }),
      isDirty: () => true,
      getDocumentRevision: () => revision,
      forceClose: (path) => closed.push(path),
      saveFile: () => Promise.resolve(true),
      confirmClose: () => Promise.resolve(decision),
    });

    const plan = await orch.preflight(['a.js']);
    revision += 1;
    const result = orch.commit(plan);
    assert.equal(result.committed, false, `${decision} plan must reject a newer buffer revision`);
    assert.equal(result.code, 'document_changed');
    assert.deepEqual(closed, [], `${decision} plan leaves the edited tab open`);
  }
});

test('orchestrator cancel never creates a committable discard plan', async () => {
  const closed = [];
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }] }),
    isDirty: () => true,
    forceClose: (path) => closed.push(path),
    confirmClose: () => Promise.resolve('cancel'),
  });

  const plan = await orch.preflight(['a.js']);
  assert.equal(plan.ready, false);
  assert.equal(plan.canceled, true);
  assert.equal(orch.commit(plan).committed, false);
  assert.deepEqual(closed, []);
});

test('orchestrator holds the mutation during a deferred save and blocks a second preflight', async () => {
  const save = createDeferred();
  const closed = [];
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }] }),
    isDirty: () => true,
    forceClose: (path) => closed.push(path),
    saveFile: () => save.promise,
    confirmClose: () => Promise.resolve('save'),
  });

  const first = orch.preflight(['a.js']);
  await Promise.resolve();
  const second = await orch.preflight(['a.js']);

  assert.equal(second.ready, false);
  assert.equal(second.blocked, true);
  assert.equal(second.code, 'close_preflight_in_progress');
  assert.deepEqual(closed, []);

  save.resolve(true);
  const plan = await first;
  assert.equal(plan.ready, true);
  assert.deepEqual(closed, [], 'a successful save still does not close before commit');
});

test('orchestrator requestCloseSaved never prompts and skips dirty/diff tabs', async () => {
  const closed = [];
  let prompts = 0;
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'clean.js' }, { path: 'dirty.js' }, { path: 'diff://x' }] }),
    isDirty: (p) => p === 'dirty.js',
    isDiffTabId: (p) => String(p).startsWith('diff://'),
    forceClose: (p) => closed.push(p),
    confirmClose: () => { prompts += 1; return Promise.resolve('discard'); },
  });
  await orch.requestCloseSaved();
  assert.deepEqual(closed, ['clean.js']);
  assert.equal(prompts, 0);
});

test('orchestrator Close All / Close Others spare pinned tabs', async () => {
  const closed = [];
  const ide = {
    openTabs: [
      { path: 'pin.js', pinned: true },
      { path: 'a.js' },
      { path: 'b.js' },
    ],
  };
  const orch = createIdeCloseOrchestrator({
    getIde: () => ide,
    isDirty: () => false,
    forceClose: (p) => closed.push(p),
    confirmClose: () => Promise.resolve('discard'),
  });

  await orch.requestCloseAll();
  assert.deepEqual(closed, ['a.js', 'b.js'], 'Close All keeps the pinned tab');

  closed.length = 0;
  await orch.requestCloseOthers('a.js');
  assert.deepEqual(closed, ['b.js'], 'Close Others keeps its target AND spares pinned tabs');
});

// ── Integration through the controller + real inventory dialog ───────────────

test('closing a clean tab does not prompt', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'one' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js');
  await settle();

  closeActiveViaX(harness, 'a.js');
  await settle();
  assert.equal(confirmButton(harness, 'discard'), null, 'a clean close shows no dialog');
  assert.equal(harness.state.ui.ide.openTabs.length, 0);
});

test('closing a dirty tab prompts; Cancel keeps it, then Don’t Save discards it', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'one' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js');
  await settle();
  makeActiveDirty(harness, 'edited');

  closeActiveViaX(harness, 'a.js');
  await settle();
  assert.ok(confirmButton(harness, 'cancel'), 'a dirty close prompts');

  confirmButton(harness, 'cancel').click();
  await settle();
  assert.deepEqual(harness.state.ui.ide.openTabs.map((t2) => t2.path), ['a.js'], 'cancel keeps the tab');
  assert.equal(harness.bridge.calls.writeFile.length, 0);

  closeActiveViaX(harness, 'a.js');
  await settle();
  confirmButton(harness, 'discard').click();
  await settle();
  assert.equal(harness.state.ui.ide.openTabs.length, 0, 'discard closes without saving');
  assert.equal(harness.bridge.calls.writeFile.length, 0);
});

test('Save on a dirty close writes the file then closes the tab', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'one' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js');
  await settle();
  makeActiveDirty(harness, 'saved-content');

  closeActiveViaX(harness, 'a.js');
  await settle();
  confirmButton(harness, 'save').click();
  await settle();

  assert.equal(harness.bridge.calls.writeFile.length, 1);
  assert.equal(harness.bridge.calls.writeFile[0].path, 'a.js');
  assert.equal(harness.bridge.calls.writeFile[0].content, 'saved-content');
  assert.equal(harness.state.ui.ide.openTabs.length, 0);
});

test('Close All with multiple dirty tabs shows ONE batched prompt', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'one', 'b.js': 'two' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js');
  await settle();
  makeActiveDirty(harness, 'a-edited');
  await harness.controller.openFile('b.js');
  await settle();
  makeActiveDirty(harness, 'b-edited');

  const doc = harness.dom.window.document;
  const strip = harness.getDom().ideTabStrip;
  strip.querySelector('[data-ide-tab-path="b.js"]').dispatchEvent(
    new harness.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 })
  );
  [...doc.body.querySelectorAll('.inv-context-menu-item')]
    .find((item) => item.textContent.includes('Close All'))
    .click();
  await settle();

  // Exactly one confirm overlay, listing both dirty files, with a "Save All".
  assert.equal(doc.body.querySelectorAll('[data-ide-confirm-action]').length, 3, 'one dialog, three actions');
  assert.match(doc.body.querySelector('[data-ide-confirm-action="save"]').textContent, /Save All/);

  doc.body.querySelector('[data-ide-confirm-action="save"]').click();
  await settle();
  assert.equal(harness.bridge.calls.writeFile.length, 2, 'both dirty files saved');
  assert.equal(harness.state.ui.ide.openTabs.length, 0);
});
