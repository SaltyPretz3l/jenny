'use strict';

// The Notes rail while a draft is live: the lease rule, the editor node surviving
// saves, project stamping, Escape ownership, Undo guards and the cold-open tint.

const test = require('node:test');
const assert = require('node:assert/strict');

const { openedRig, editing, flush, makeNote } = require('./helpers/project-notes-rail-rig');

test('the lease follows the work: renewed near a keystroke, released when the open editor idles, retaken on typing', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r); // t=0: the lease is taken on entering edit
  r.type('line one\nline two\nx');
  r.scheduler.advanceBy(7000); // saved at 0.6 s
  await flush();
  r.type('line one\nline two\nxy'); // keystroke at 7 s
  r.scheduler.advanceBy(3000); // 10 s heartbeat: the keystroke is 3 s old, renew
  await flush();
  r.scheduler.advanceBy(10000); // 20 s heartbeat: saved and 13 s idle, release while the editor stays open
  await flush();
  assert.ok(r.editor(), 'the editor stays open');
  assert.deepEqual(r.callsOf('lease').map((call) => call[2]), [true, true, false]);
  r.type('line one\nline two\nxyz');
  assert.deepEqual(r.callsOf('lease').map((call) => call[2]), [true, true, false, true], 'the next keystroke takes the lease back');
  r.keydown(r.editor(), 'Escape');
  await flush();
  r.scheduler.advanceBy(30000);
  await flush();
  assert.deepEqual(r.callsOf('lease').map((call) => call[2]), [true, true, false, true, false], 'released once editing ended');
});

test('a save never replaces the live textarea; only the strip and the error line change', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  const next = r.store.jennyAppends('project_alpha', 'new fact');
  r.store.emit({ projectId: 'project_alpha', revision: next.revision, updatedBy: 'assistant', journalEntryId: 'e2', reason: 'append' });
  await flush();
  const el = await editing(r);
  assert.ok(r.q('[data-action="notes-rail-undo"]'), 'Undo is offered until a draft exists');
  r.type('line one\nline two\nnew fact\nmine');
  r.scheduler.advanceBy(600);
  await flush();
  assert.equal(r.callsOf('save').length, 1);
  assert.equal(r.editor(), el, 'the same textarea node after the save');
  assert.match(r.q('.notes-rail__strip').textContent, /Jenny edited this note/);
  assert.equal(r.q('[data-action="notes-rail-undo"]'), null);
  r.store.api.save = async () => { throw new Error('boom'); };
  r.type('line one\nline two\nnew fact\nmine!');
  r.scheduler.advanceBy(600);
  await flush();
  assert.equal(r.editor(), el, 'a failed save keeps the node too');
  assert.match(r.q('.notes-rail__error').textContent, /Could not save/);
  assert.equal(r.editor().value, 'line one\nline two\nnew fact\nmine!');
});

test('a cold open describes and tints the latest Jenny write from the journal', async (t) => {
  const r = await openedRig({ notes: { project_alpha: makeNote({
    text: 'line one\nline two\nnew fact', revision: 2, updatedBy: 'assistant',
    journal: [{ id: 'e2', at: '2026-10-06T12:00:00.000Z', op: 'append', summary: 'x', undoable: true, lines: { added: 1, removed: 0, start: 2 } }],
  }) } });
  t.after(() => r.controller.dispose());
  assert.match(r.q('.notes-rail__strip').textContent, /Jenny added 1 line/);
  const lines = Array.from(r.host.querySelectorAll('.notes-rail__line'));
  assert.deepEqual(lines.map((el) => el.classList.contains('notes-rail__line--new')), [false, false, true]);
  assert.ok(r.q('[data-action="notes-rail-undo"]'));
});

test('a keystroke that lands after the chat moved to another project is dropped and repaints', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  const el = await editing(r);
  assert.equal(el.dataset.notesProject, 'project_alpha');
  r.state.currentSessionId = 's2'; // the panel has not repainted yet
  el.value = 'typed into the wrong note';
  el.dispatchEvent(new r.window.Event('input', { bubbles: true }));
  await flush();
  assert.equal(r.q('.notes-rail__header b').textContent, 'project_beta');
  r.scheduler.advanceBy(1000);
  await flush();
  assert.equal(r.callsOf('save').length, 0, 'neither note was saved');
});

test('Escape in the editor is claimed before the panel-level Escape handler can act on it', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  let collapsed = false; // the artifact review rail's own handler, bound on the same element
  r.panel.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !event.defaultPrevented) collapsed = true; });
  await editing(r);
  r.keydown(r.editor(), 'Escape');
  await flush();
  assert.equal(r.editor(), null, 'editing ended');
  assert.equal(collapsed, false);
  assert.equal(r.panel.ownerDocument.activeElement?.dataset?.action, 'notes-rail-edit', 'focus returns to the note (row 21 gate)');
});

test('Undo is ignored under an unsaved draft and runs one at a time', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  const next = r.store.jennyAppends('project_alpha', 'new fact');
  r.store.emit({ projectId: 'project_alpha', revision: next.revision, updatedBy: 'assistant', journalEntryId: 'e2', reason: 'append' });
  await flush();
  await editing(r);
  r.type('line one\nline two\nnew fact\ndraft');
  r.q('[data-action="notes-rail-undo"]').click();
  await flush();
  assert.equal(r.callsOf('undo').length, 0, 'an unsaved draft blocks Undo');
  const r2 = await openedRig();
  t.after(() => r2.controller.dispose());
  const second = r2.store.jennyAppends('project_alpha', 'new fact');
  r2.store.emit({ projectId: 'project_alpha', revision: second.revision, updatedBy: 'assistant', journalEntryId: 'e2', reason: 'append' });
  await flush();
  let release = null;
  r2.store.api.undo = (pid, entryId) => { r2.store.calls.push(['undo', pid, entryId]); return new Promise((resolve) => { release = resolve; }); };
  r2.q('[data-action="notes-rail-undo"]').click();
  r2.q('[data-action="notes-rail-undo"]').click();
  await flush();
  assert.equal(r2.callsOf('undo').length, 1, 'a double-click is one undo');
  release({ ok: false });
  await flush();
  assert.deepEqual(r2.log.toasts, ['That change can no longer be undone.']);
});

test('a change seen mid-edit is loaded when editing ends by switching away', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  const next = r.store.jennyAppends('project_alpha', 'sneaky');
  r.store.emit({ projectId: 'project_alpha', revision: next.revision, updatedBy: 'assistant', journalEntryId: 'e2', reason: 'append' });
  await flush();
  r.state.currentSessionId = 's2';
  r.paint();
  await flush();
  r.state.currentSessionId = 's1';
  r.paint();
  await flush();
  assert.match(r.q('.notes-rail__preview').textContent, /sneaky/, 'the pending change was fetched, not served from the stale cache');
});

test('disposing with a draft still inside the debounce saves it best-effort instead of dropping it', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  r.type('line one\nline two\nhalf typed');
  assert.equal(r.callsOf('save').length, 0);
  r.controller.dispose();
  await flush();
  assert.deepEqual(r.callsOf('save').at(-1), ['save', 'project_alpha', 'line one\nline two\nhalf typed', 1]);
  assert.deepEqual(r.callsOf('lease').at(-1), ['lease', 'project_alpha', false]);
});

test('a panel re-render or a repeated open while typing patches around the live textarea', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  const el = await editing(r);
  r.type('line one\nline two\nmid-wor');
  r.paint(); // the chat pipeline's renderArtifactReviewPanel on a timeline render
  assert.equal(r.editor(), el, 'the pull path keeps the node');
  const gets = r.callsOf('get').length;
  r.controller.open(); // the chat row's Open while the rail is already open
  await flush();
  assert.equal(r.editor(), el);
  assert.equal(r.callsOf('get').length, gets, 'no refetch under a live editor');
  assert.equal(r.editor().value, 'line one\nline two\nmid-wor');
});

test('Escape during an in-flight save waits for it and then leaves the editor', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  await editing(r);
  let release = null;
  r.store.api.save = (pid, text, base) => { r.store.calls.push(['save', pid, text, base]); return new Promise((resolve) => { release = resolve; }); };
  r.type('line one\nline two\nslow');
  r.scheduler.advanceBy(600);
  await flush();
  assert.equal(r.callsOf('save').length, 1, 'the save is in flight');
  r.keydown(r.editor(), 'Escape');
  await flush();
  assert.ok(r.editor(), 'still editing until the save answers');
  release({ ok: true, note: makeNote({ text: 'line one\nline two\nslow', revision: 2 }) });
  await flush();
  assert.equal(r.editor(), null, 'editing ended once the save settled');
  assert.match(r.q('.notes-rail__preview').textContent, /slow/);
  assert.equal(r.callsOf('save').length, 1, 'nothing changed since, so no second save');
});

test('a change that landed while another project was showing is tinted on the way back', async (t) => {
  const r = await openedRig();
  t.after(() => r.controller.dispose());
  r.state.currentSessionId = 's2';
  r.paint();
  await flush();
  const next = r.store.jennyAppends('project_alpha', 'while away');
  r.store.notes.get('project_alpha').journal.at(-1).lines = { added: 1, removed: 0, start: 2 };
  r.store.emit({ projectId: 'project_alpha', revision: next.revision, updatedBy: 'assistant', journalEntryId: 'e2', reason: 'append' });
  await flush();
  r.state.currentSessionId = 's1';
  r.paint();
  await flush();
  assert.match(r.q('.notes-rail__strip').textContent, /Jenny added 1 line/);
  const lines = Array.from(r.host.querySelectorAll('.notes-rail__line'));
  assert.deepEqual(lines.map((el) => el.classList.contains('notes-rail__line--new')), [false, false, true]);
});

for (const action of ['notes-rail-use-theirs', 'notes-rail-save-mine']) {
  test(`${action} keeps keyboard focus in the editor, not on <body>`, async (t) => {
    const r = await openedRig();
    t.after(() => r.controller.dispose());
    await editing(r);
    r.store.jennyAppends('project_alpha', 'from jenny');
    r.type('my draft');
    r.scheduler.advanceBy(600);
    await flush();
    const button = r.q(`[data-action="${action}"]`);
    button.focus(); // a pointer click focuses the button before the repaint removes it
    button.click();
    await flush();
    assert.equal(r.panel.ownerDocument.activeElement, r.editor(), 'focus returns to the editor (row 21 gate 2026-10-07)');
  });
}
