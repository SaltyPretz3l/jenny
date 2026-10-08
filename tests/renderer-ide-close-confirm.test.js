'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeCloseOrchestrator,
} = require('../renderer/features/renderer-ide-close-orchestrator');
const { createIdeConfirmDialog } = require('../renderer/features/renderer-ide-confirm-dialog');
const actionButton = require('../renderer/inventory/action-button');
const { JSDOM } = require('jsdom');
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

test('orchestrator commit reports every changed path and still closes nothing', async () => {
  const revisions = new Map([['a.js', 1], ['b.js', 1], ['c.js', 1]]);
  const closed = [];
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }] }),
    isDirty: () => true,
    getDocumentRevision: (path) => revisions.get(path),
    forceClose: (path) => closed.push(path),
    confirmClose: () => Promise.resolve('discard'),
  });

  const plan = await orch.preflight(['a.js', 'b.js', 'c.js']);
  revisions.set('a.js', 2);
  revisions.set('c.js', 2);
  const result = orch.commit(plan);

  assert.equal(result.committed, false);
  assert.equal(result.code, 'document_changed');
  assert.equal(result.changedPath, 'a.js');
  assert.deepEqual(result.changedPaths, ['a.js', 'c.js']);
  assert.deepEqual(result.closedPaths, []);
  assert.deepEqual(closed, [], 'all-or-nothing: the unchanged tab is not closed either');
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

test('orchestrator tab close sends only the dirty paths to the prompt (no intent)', async () => {
  const prompts = [];
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }] }),
    isDirty: () => true,
    confirmClose: (payload) => { prompts.push(payload); return Promise.resolve('discard'); },
  });
  await orch.requestClose('a.js');
  assert.deepEqual(prompts, [{ dirtyPaths: ['a.js'] }]);
});

test('orchestrator window preflight prompts for registered surfaces even with clean buffers', async () => {
  const prompts = [];
  const saved = [];
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }] }),
    isDirty: () => false,
    saveFile: (p) => { saved.push(p); return Promise.resolve(true); },
    confirmClose: (payload) => { prompts.push(payload); return Promise.resolve('save'); },
  });
  const surfaces = [{ id: 'memory-notes', label: 'Long-term notes' }];
  const plan = await orch.preflight(['a.js'], { intent: 'reload', surfaces });

  assert.deepEqual(prompts, [{ dirtyPaths: [], intent: 'reload', surfaces }]);
  assert.equal(plan.ready, true);
  assert.equal(plan.decision, 'save');
  assert.deepEqual(saved, [], 'clean buffers are not rewritten');
  orch.cancel(plan);
});

test('orchestrator window preflight passes the intent with dirty buffers and cancels on Cancel', async () => {
  const prompts = [];
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }] }),
    isDirty: () => true,
    confirmClose: (payload) => { prompts.push(payload); return Promise.resolve('cancel'); },
  });
  const plan = await orch.preflight(['a.js'], { intent: 'update-restart' });

  assert.deepEqual(prompts, [{ dirtyPaths: ['a.js'], intent: 'update-restart' }]);
  assert.equal(plan.ready, false);
  assert.equal(plan.canceled, true);
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

// ── Action-aware confirm copy (fake overlay rendering into a real jsdom doc) ──

function makeDialog() {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const opened = [];
  const helpOverlayFactory = () => ({
    open: (cfg) => { opened.push(cfg); host.innerHTML = cfg.bodyHtml; },
    close: () => { host.innerHTML = ''; },
    destroy: () => { host.remove(); },
  });
  const dialog = createIdeConfirmDialog({ document: doc, actionButton, helpOverlayFactory });
  const text = (action) => doc.body.querySelector(`[data-ide-confirm-action="${action}"]`).textContent.trim();
  const message = () => doc.body.querySelector('.ide-confirm-message').textContent;
  const listItems = () => [...doc.body.querySelectorAll('.ide-confirm-list li')].map((li) => li.textContent);
  return { dialog, doc, text, message, listItems };
}

test('editor-tab close keeps today’s copy', async () => {
  const ui = makeDialog();
  const pending = ui.dialog.confirmClose({ dirtyPaths: ['docs/NOTES.md'] });
  assert.equal(ui.message(), '“NOTES.md” has unsaved changes. Save before closing?');
  assert.equal(ui.text('save'), 'Save');
  assert.equal(ui.text('discard'), 'Don’t Save');
  assert.equal(ui.text('cancel'), 'Cancel');
  ui.doc.body.querySelector('[data-ide-confirm-action="cancel"]').click();
  assert.equal(await pending, 'cancel');
});

const INTENT_COPY = [
  ['close', 'Save before closing Jenny?', 'Save and close', 'Close without saving'],
  ['reload', 'Save before reloading Jenny?', 'Save and reload', 'Reload without saving'],
  ['update-restart', 'Save before restarting to update?', 'Save and restart', 'Restart without saving'],
];

for (const [intent, question, saveLabel, discardLabel] of INTENT_COPY) {
  test(`the ${intent} intent says what is about to happen`, async () => {
    const ui = makeDialog();
    const pending = ui.dialog.confirmClose({ dirtyPaths: ['docs/NOTES.md'], intent });
    assert.equal(ui.message(), `“NOTES.md” has unsaved changes. ${question}`);
    assert.equal(ui.text('save'), saveLabel);
    assert.equal(ui.text('discard'), discardLabel);
    assert.equal(ui.text('cancel'), 'Cancel');
    ui.doc.body.querySelector('[data-ide-confirm-action="save"]').click();
    assert.equal(await pending, 'save');
  });
}

test('a window prompt lists files and non-file surfaces together', async () => {
  const ui = makeDialog();
  const pending = ui.dialog.confirmClose({
    dirtyPaths: ['docs/NOTES.md'],
    surfaces: [{ id: 'memory-notes', label: 'Long-term notes' }, { id: 'personality', label: 'Personality' }],
    intent: 'reload',
  });
  assert.equal(ui.message(), '3 items have unsaved changes. Save before reloading Jenny?');
  assert.deepEqual(ui.listItems(), ['NOTES.md', 'Long-term notes', 'Personality']);
  ui.doc.body.querySelector('[data-ide-confirm-action="discard"]').click();
  assert.equal(await pending, 'discard');
});

test('a single dirty surface is named by its label', async () => {
  const ui = makeDialog();
  const pending = ui.dialog.confirmClose({ dirtyPaths: [], surfaces: [{ id: 'memory-notes', label: 'Long-term notes' }], intent: 'close' });
  assert.equal(ui.message(), '“Long-term notes” has unsaved changes. Save before closing Jenny?');
  ui.doc.body.querySelector('[data-ide-confirm-action="cancel"]').click();
  assert.equal(await pending, 'cancel');
});

test('choose renders the labelled actions plus Cancel and resolves the clicked one', async () => {
  const ui = makeDialog();
  const pending = ui.dialog.choose({
    title: 'Leave Propose?',
    message: 'Some suggested changes are still waiting.',
    choices: [
      { action: 'keep', label: 'Keep them', variant: 'primary' },
      { action: 'discard', label: 'Discard them', variant: 'danger' },
      { action: 'cancel', label: 'Not allowed to shadow Cancel' },
      { action: 'Bad Action!', label: 'Dropped' },
    ],
  });
  assert.equal(ui.message(), 'Some suggested changes are still waiting.');
  assert.deepEqual([...ui.doc.body.querySelectorAll('[data-ide-confirm-action]')].map((node) => node.getAttribute('data-ide-confirm-action')),
    ['keep', 'discard', 'cancel']);
  assert.equal(ui.text('discard'), 'Discard them');
  assert.equal(ui.text('cancel'), 'Cancel');
  ui.doc.body.querySelector('[data-ide-confirm-action="discard"]').click();
  assert.equal(await pending, 'discard');
});

test('choose without any valid choice resolves cancel without opening', async () => {
  const ui = makeDialog();
  assert.equal(await ui.dialog.choose({ choices: [{ action: 'cancel' }] }), 'cancel');
  assert.equal(ui.doc.body.querySelector('[data-ide-confirm-action]'), null);
});
