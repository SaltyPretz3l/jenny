'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeCloseOrchestrator } = require('../renderer/features/renderer-ide-close-orchestrator');

test('Save-on-close commits when the save itself bumps the revision (hygiene / format-on-save edits)', async () => {
  const closed = [];
  const revision = { 'a.js': 1, 'b.js': 7 };
  const dirty = new Set(['a.js']);
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }, { path: 'b.js' }] }),
    isDirty: (p) => dirty.has(p),
    forceClose: (p) => closed.push(p),
    getDocumentRevision: (p) => revision[p],
    // trimTrailingWhitespace / formatOnSave edit the model before the write.
    saveFile: (p) => { revision[p] += 1; dirty.delete(p); return Promise.resolve(true); },
    confirmClose: () => Promise.resolve('save'),
  });
  const result = await orch.requestCloseAll();
  assert.equal(result.committed, true, JSON.stringify(result));
  assert.deepEqual(closed, ['a.js', 'b.js']);
});

test('an edit to a NON-saved path during the prompt still blocks the commit', async () => {
  const closed = [];
  const revision = { 'a.js': 1, 'b.js': 7 };
  const dirty = new Set(['a.js']);
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }, { path: 'b.js' }] }),
    isDirty: (p) => dirty.has(p),
    forceClose: (p) => closed.push(p),
    getDocumentRevision: (p) => revision[p],
    saveFile: (p) => { revision[p] += 1; dirty.delete(p); revision['b.js'] += 1; return Promise.resolve(true); },
    confirmClose: () => Promise.resolve('save'),
  });
  const result = await orch.requestCloseAll();
  assert.equal(result.committed, false);
  assert.deepEqual(result.changedPaths, ['b.js']);
  assert.deepEqual(closed, []);
});

test('typing into the saved path during the save keeps it dirty and blocks the commit', async () => {
  const closed = [];
  const revision = { 'a.js': 1 };
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: [{ path: 'a.js' }] }),
    // The write lands but a keystroke after it leaves the model dirty.
    isDirty: () => true,
    forceClose: (p) => closed.push(p),
    getDocumentRevision: (p) => revision[p],
    saveFile: (p) => { revision[p] += 2; return Promise.resolve(true); },
    confirmClose: () => Promise.resolve('save'),
  });
  const result = await orch.requestCloseAll();
  assert.equal(result.committed, false);
  assert.deepEqual(result.changedPaths, ['a.js']);
  assert.deepEqual(closed, []);
});
