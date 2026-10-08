'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { rig, openedRig, editing, flush, makeNote } = require('./helpers/project-notes-rail-rig');

test('opening paints the current project note from get', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  assert.deepEqual(r.callsOf('get'), [['get', 'project_alpha']]);
  assert.match(r.q('.notes-rail__preview').textContent, /line one/);
  assert.equal(r.q('.notes-rail__header b').textContent, 'project_alpha');
  assert.equal(r.q('.notes-rail__header').textContent.includes('Tasks'), false, 'mode buttons are icon-only');
  assert.deepEqual(r.log.seen.at(-1), ['project_alpha', 1], 'a fetch while open marks the note seen');
});

test('the project name comes from the switcher; General has its own copy', async (t) => {
  const switcher = { refresh: async () => {}, projectById: (id) => (id === 'project_alpha' ? { name: 'Alpha App' } : null) };
  const r = await openedRig({ switcher });
  t.after(() => r.controller.dispose());
  assert.equal(r.q('.notes-rail__header b').textContent, 'Alpha App');
  r.state.currentSessionId = 's3';
  r.paint();
  await flush();
  assert.equal(r.q('.notes-rail__header b').textContent, 'General');
});

test('a click on the preview opens the editor with the text and takes the lease', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  const el = await editing(r);
  assert.ok(el);
  assert.equal(el.value, 'line one\nline two');
  assert.equal(r.window.document.activeElement, el);
  assert.equal(el.selectionStart, el.value.length);
  assert.deepEqual(r.callsOf('lease'), [['lease', 'project_alpha', true]]);
  assert.equal(r.q('.notes-rail__preview'), null);
});

test('Enter on the focused preview also starts editing', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  r.keydown(r.q('.notes-rail__preview'), 'Enter');
  await flush();
  assert.ok(r.editor());
});

test('typing saves after the 600 ms debounce with the base revision', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  r.type('line one\nline two\nthree');
  r.scheduler.advanceBy(599);
  assert.equal(r.callsOf('save').length, 0);
  r.type('line one\nline two\nthree!');
  r.scheduler.advanceBy(599);
  assert.equal(r.callsOf('save').length, 0, 'each keystroke restarts the debounce');
  r.scheduler.advanceBy(1);
  await flush();
  assert.deepEqual(r.callsOf('save'), [['save', 'project_alpha', 'line one\nline two\nthree!', 1]]);
  assert.equal(r.store.notes.get('project_alpha').revision, 2);
  assert.equal(r.q('.notes-rail__error'), null);
  assert.equal(r.editor().value, 'line one\nline two\nthree!');
});

test('a stale save keeps the draft and offers two ways out', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  r.store.jennyAppends('project_alpha', 'from jenny');
  r.type('my draft');
  r.scheduler.advanceBy(600);
  await flush();
  assert.equal(r.editor().value, 'my draft', 'the draft stays in the editor');
  assert.ok(r.q('[data-action="notes-rail-save-mine"]'));
  assert.ok(r.q('[data-action="notes-rail-use-theirs"]'));
  assert.match(r.q('.notes-rail__error').textContent, /Jenny changed this note while you were editing/);
  // Typing more during the decision does not autosave over Jenny's text.
  r.type('my draft, longer');
  r.scheduler.advanceBy(1000);
  await flush();
  assert.equal(r.callsOf('save').length, 1);
  assert.equal(r.editor().value, 'my draft, longer');
});

test('Save mine saves against the current revision', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  r.store.jennyAppends('project_alpha', 'from jenny');
  r.type('my draft');
  r.scheduler.advanceBy(600);
  await flush();
  r.q('[data-action="notes-rail-save-mine"]').click();
  await flush();
  assert.deepEqual(r.callsOf('save').at(-1), ['save', 'project_alpha', 'my draft', 2]);
  assert.equal(r.store.notes.get('project_alpha').text, 'my draft');
  assert.equal(r.q('.notes-rail__error'), null);
});

test("Use Jenny's replaces the draft and clears the error", async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  r.store.jennyAppends('project_alpha', 'from jenny');
  r.type('my draft');
  r.scheduler.advanceBy(600);
  await flush();
  r.q('[data-action="notes-rail-use-theirs"]').click();
  await flush();
  assert.equal(r.editor().value, 'line one\nline two\nfrom jenny');
  assert.equal(r.q('.notes-rail__error'), null);
  // The next keystroke saves against Jenny's revision.
  r.type('line one\nline two\nfrom jenny!');
  r.scheduler.advanceBy(600);
  await flush();
  assert.deepEqual(r.callsOf('save').at(-1), ['save', 'project_alpha', 'line one\nline two\nfrom jenny!', 2]);
});

test('a throwing or failing save shows Retry, keeps the draft and logs only the reason', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  r.store.api.save = async () => { throw new Error('secret note text leaked?'); };
  r.type('private draft');
  r.scheduler.advanceBy(600);
  await flush();
  assert.match(r.q('.notes-rail__error').textContent, /Could not save/);
  assert.equal(r.editor().value, 'private draft');
  const failed = r.log.logs.find((entry) => entry[1] === 'project_notes.save_failed');
  assert.ok(failed);
  assert.equal(JSON.stringify(failed).includes('private draft'), false);
  assert.equal(JSON.stringify(r.log.logs).includes('leaked'), false);
  r.store.api.save = async (projectId, text, base) => ({ ok: true, note: makeNote({ projectId, text, revision: base + 1 }) });
  r.q('[data-action="notes-rail-retry"]').click();
  await flush();
  assert.equal(r.q('.notes-rail__error'), null);
});

test('note_full keeps the draft and says why', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  r.store.api.save = async () => ({ ok: false, reason: 'note_full' });
  r.type('x'.repeat(50));
  r.scheduler.advanceBy(600);
  await flush();
  assert.match(r.q('.notes-rail__error').textContent, /20,000-character limit/);
  assert.equal(r.editor().value.length, 50);
});

test('Esc flushes a pending save, returns to preview, and the lease is released after 5 s', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  r.scheduler.advanceBy(100);
  r.type('edited text');
  r.keydown(r.editor(), 'Escape');
  await flush();
  assert.deepEqual(r.callsOf('save').at(-1), ['save', 'project_alpha', 'edited text', 1], 'flushed without waiting for the debounce');
  assert.equal(r.editor(), null);
  assert.match(r.q('.notes-rail__preview').textContent, /edited text/);
  assert.equal(r.callsOf('lease').filter((call) => call[2] === false).length, 0, 'still held right after Esc');
  r.scheduler.advanceBy(4900);
  await flush();
  assert.equal(r.callsOf('lease').filter((call) => call[2] === false).length, 0);
  r.scheduler.advanceBy(200);
  await flush();
  assert.deepEqual(r.callsOf('lease').at(-1), ['lease', 'project_alpha', false]);
});

test('Esc on an unsaved stale draft keeps the editor open', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  r.store.jennyAppends('project_alpha', 'from jenny');
  r.type('mine');
  r.scheduler.advanceBy(600);
  await flush();
  r.keydown(r.editor(), 'Escape');
  await flush();
  assert.equal(r.editor().value, 'mine');
  assert.ok(r.q('[data-action="notes-rail-use-theirs"]'));
});

test('a lease release waits for an in-flight save', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  let finish;
  r.store.api.save = (projectId, text, base) => new Promise((resolve) => {
    finish = () => resolve({ ok: true, note: makeNote({ projectId, text, revision: base + 1 }) });
  });
  r.type('slow');
  r.keydown(r.editor(), 'Escape');
  await flush();
  r.scheduler.advanceBy(6000);
  await flush();
  assert.equal(r.callsOf('lease').filter((call) => call[2] === false).length, 0, 'held while the save is in flight');
  finish();
  await flush();
  r.scheduler.advanceBy(1);
  await flush();
  assert.deepEqual(r.callsOf('lease').at(-1), ['lease', 'project_alpha', false]);
});

test('focus leaving the editor for outside the rail ends editing; focus moving inside does not', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  const inside = r.window.document.createElement('span');
  r.q('.notes-rail__footer').appendChild(inside);
  r.editor().dispatchEvent(new r.window.FocusEvent('focusout', { bubbles: true, relatedTarget: inside }));
  await flush();
  assert.ok(r.editor(), 'still editing');
  r.leaveEditor();
  await flush();
  assert.equal(r.editor(), null);
  assert.ok(r.q('.notes-rail__preview'));
});

test('a change while previewing refetches and shows the strip with highlighted lines', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  const next = r.store.jennyAppends('project_alpha', 'new fact\nsecond new');
  r.store.emit({ projectId: 'project_alpha', revision: next.revision, updatedBy: 'assistant', journalEntryId: 'e2', reason: 'append' });
  await flush();
  assert.match(r.q('.notes-rail__strip').textContent, /Jenny added 2 lines/);
  const lines = Array.from(r.host.querySelectorAll('.notes-rail__line'));
  assert.deepEqual(lines.map((el) => el.classList.contains('notes-rail__line--new')), [false, false, true, true]);
  assert.ok(r.q('[data-action="notes-rail-undo"]'));
  // Hide removes the strip and the highlight.
  r.q('[data-action="notes-rail-hide-changes"]').click();
  await flush();
  assert.equal(r.q('.notes-rail__strip'), null);
  assert.equal(r.host.querySelectorAll('.notes-rail__line--new').length, 0);
});

test('a change while editing does nothing until the user finishes', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  const before = r.callsOf('get').length;
  const next = r.store.jennyAppends('project_alpha', 'sneaky');
  r.store.emit({ projectId: 'project_alpha', revision: next.revision, updatedBy: 'assistant', journalEntryId: 'e2', reason: 'append' });
  await flush();
  assert.equal(r.callsOf('get').length, before);
  assert.equal(r.editor().value, 'line one\nline two');
  r.keydown(r.editor(), 'Escape');
  await flush();
  assert.match(r.q('.notes-rail__preview').textContent, /sneaky/, 'the pending change lands after exit');
});

test('our own save echo does not refetch', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  r.type('mine');
  r.scheduler.advanceBy(600);
  await flush();
  const before = r.callsOf('get').length;
  r.store.emit({ projectId: 'project_alpha', revision: 2, updatedBy: 'user', journalEntryId: '', reason: 'save' });
  await flush();
  assert.equal(r.callsOf('get').length, before);
});

test('a user edit clears the highlight and turns the strip generic without Undo', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  const next = r.store.jennyAppends('project_alpha', 'new fact');
  r.store.emit({ projectId: 'project_alpha', revision: next.revision, updatedBy: 'assistant', journalEntryId: 'e2', reason: 'append' });
  await flush();
  await editing(r);
  r.type('line one\nline two\nnew fact!');
  r.keydown(r.editor(), 'Escape');
  await flush();
  assert.equal(r.host.querySelectorAll('.notes-rail__line--new').length, 0);
  assert.match(r.q('.notes-rail__strip').textContent, /Jenny edited this note/);
  assert.equal(r.q('[data-action="notes-rail-undo"]'), null);
});

test('Undo that the service refuses toasts; an accepted undo repaints without a strip', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  const next = r.store.jennyAppends('project_alpha', 'new fact');
  r.store.emit({ projectId: 'project_alpha', revision: next.revision, updatedBy: 'assistant', journalEntryId: 'e2', reason: 'append' });
  await flush();
  r.q('[data-action="notes-rail-undo"]').click();
  await flush();
  assert.deepEqual(r.callsOf('undo').at(-1), ['undo', 'project_alpha', 'e2']);
  assert.deepEqual(r.log.toasts, ['That change can no longer be undone.']);
  r.store.api.undo = async (projectId) => ({
    ok: true,
    note: makeNote({ projectId, text: 'line one\nline two', revision: 3, updatedBy: 'assistant', journal: [{ id: 'e2', at: '2026-10-06T12:00:00.000Z', op: 'append', summary: 'x', undoable: false }] }),
  });
  r.q('[data-action="notes-rail-undo"]').click();
  await flush();
  assert.equal(r.q('.notes-rail__strip'), null);
  assert.equal(r.host.querySelectorAll('.notes-rail__line--new').length, 0);
});

test('switching to a chat in another project repaints that project and drops the highlight', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  const next = r.store.jennyAppends('project_alpha', 'new fact');
  r.store.emit({ projectId: 'project_alpha', revision: next.revision, updatedBy: 'assistant', journalEntryId: 'e2', reason: 'append' });
  await flush();
  assert.equal(r.host.querySelectorAll('.notes-rail__line--new').length, 1);
  r.state.currentSessionId = 's2';
  r.paint();
  await flush();
  assert.match(r.q('.notes-rail__preview').textContent, /beta text/);
  assert.equal(r.q('.notes-rail__header b').textContent, 'project_beta');
  r.state.currentSessionId = 's1';
  r.paint();
  await flush();
  assert.equal(r.host.querySelectorAll('.notes-rail__line--new').length, 0, 'the highlight did not survive a project switch');
});

test('switching projects mid-edit saves the draft and releases the old lease', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  r.type('half written');
  r.state.currentSessionId = 's2';
  r.paint();
  await flush();
  assert.deepEqual(r.callsOf('save').at(-1), ['save', 'project_alpha', 'half written', 1]);
  r.scheduler.advanceBy(6000);
  await flush();
  assert.deepEqual(r.callsOf('lease').at(-1), ['lease', 'project_alpha', false]);
  assert.equal(r.editor(), null);
});

test('no current chat paints the open-a-chat line and still claims the surface', async (t) => {
  const r = rig();
  t.after(() => r.controller.dispose());
  r.state.currentSessionId = '';
  assert.equal(r.paint(), true);
  assert.match(r.host.textContent, /Open a chat to see its project notes\./);
});

test('without jennyShell.projectNotes the rail says notes are unavailable', async (t) => {
  const r = rig({ noApi: true });
  t.after(() => r.controller.dispose());
  r.paint();
  await flush();
  assert.match(r.q('.notes-rail__error').textContent, /Notes are unavailable in this build\./);
  assert.equal(r.q('.notes-rail__preview'), null);
});

test('a failed load shows Retry and recovers', async (t) => {
  const r = rig();
  t.after(() => r.controller.dispose());
  const original = r.store.api.get;
  r.store.api.get = async () => ({ ok: false, reason: 'write_failed' });
  r.paint();
  await flush();
  assert.match(r.q('.notes-rail__error').textContent, /Could not load/);
  r.store.api.get = original;
  r.q('[data-action="notes-rail-retry"]').click();
  await flush();
  assert.ok(r.q('.notes-rail__preview'));
  assert.equal(r.q('.notes-rail__error'), null);
});

test('open, toggle, close and isOpen drive the shared panel', async (t) => {
  const r = rig();
  t.after(() => r.controller.dispose());
  r.state.ui.artifactReview = { mode: 'artifact', enabled: false, collapsed: false };
  assert.equal(r.controller.isOpen(), false);
  assert.equal(r.controller.open(), true);
  assert.deepEqual(r.log.opens, ['notes']);
  assert.ok(r.log.renders >= 1);
  r.state.ui.artifactReview.enabled = true;
  assert.equal(r.controller.isOpen(), true);
  r.controller.toggle();
  assert.equal(r.log.toggles, 1, 'toggle closes when open');
  assert.equal(r.controller.isOpen(), false);
  r.controller.toggle();
  assert.deepEqual(r.log.opens, ['notes', 'notes']);
  // Another mode in the panel is not "open".
  r.state.ui.artifactReview = { mode: 'tasks', enabled: true, collapsed: false };
  assert.equal(r.controller.isOpen(), false);
});

test('switchToTasks opens the Tasks rail', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  r.q('[data-action="notes-rail-switch-tasks"]').click();
  assert.deepEqual(r.log.opens, ['tasks']);
});

test('refresh refetches and repaints', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  r.store.jennyAppends('project_alpha', 'later');
  await r.controller.refresh();
  assert.match(r.q('.notes-rail__preview').textContent, /later/);
});

test('dispose unsubscribes, releases a held lease and stops reacting to the panel', async (t) => {
  const r = await openedRig();
  await editing(r);
  r.controller.dispose();
  assert.equal(r.store.hasListener(), false);
  assert.deepEqual(r.callsOf('lease').at(-1), ['lease', 'project_alpha', false]);
  assert.equal(r.panel.dataset.notesRailBound, undefined);
  const before = r.store.calls.length;
  r.scheduler.advanceBy(60000);
  await flush();
  assert.equal(r.store.calls.length, before);
});

test('_getModelForTests exposes the paint model', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  const model = r.controller._getModelForTests();
  assert.equal(model.projectId, 'project_alpha');
  assert.equal(model.view, 'preview');
  assert.equal(model.note.revision, 1);
});
