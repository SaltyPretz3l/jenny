'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const notesRender = require('../renderer/features/renderer-project-notes-rail-render');
const markdown = require('../renderer/features/renderer-dashboard-scratchpad-markdown');
const actionButton = require('../renderer/inventory/action-button');
const { escapeHtml } = require('../renderer/shared/string-utils');

const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const helpers = {
  escapeHtml,
  actionButton,
  renderMarkdown: (text) => markdown.renderPreviewHtml(text, { escapeHtml }),
  now: NOW,
};

function note(overrides = {}) {
  return {
    projectId: 'project_alpha',
    text: '# Plan\n- one\n- two',
    revision: 3,
    updatedAt: '2026-10-06T11:59:00.000Z',
    updatedBy: 'assistant',
    journal: [],
    ...overrides,
  };
}

function model(overrides = {}) {
  return {
    projectId: 'project_alpha',
    projectName: 'Alpha',
    note: note(),
    loading: false,
    editing: false,
    draft: '',
    error: null,
    changeStrip: null,
    highlightLines: null,
    ...overrides,
  };
}

function dom(html) {
  const window = new JSDOM(`<body>${html}</body>`).window;
  return window.document;
}

function render(overrides, extraHelpers) {
  return notesRender.renderNotesRailSurface(model(overrides), { ...helpers, ...extraHelpers });
}

test('header names the project and offers Tasks and a pressed Notes button', () => {
  const doc = dom(render());
  assert.equal(doc.querySelector('.notes-rail__header b').textContent, 'Alpha');
  const tasks = doc.querySelector('[data-action="notes-rail-switch-tasks"]');
  assert.ok(tasks);
  assert.equal(tasks.getAttribute('aria-label'), 'Tasks');
  const pressed = doc.querySelector('.notes-rail__mode [aria-pressed="true"]');
  assert.ok(pressed);
  assert.equal(pressed.getAttribute('aria-label'), 'Notes');
  assert.equal(doc.querySelector('.notes-rail__mode').querySelectorAll('button').length, 2);
});

test('the project name is escaped', () => {
  const doc = dom(render({ projectName: '<img src=x onerror=alert(1)>' }));
  assert.equal(doc.querySelector('img'), null);
  assert.match(doc.querySelector('.notes-rail__header b').textContent, /<img/);
});

test('preview renders markdown line by line inside a keyboard-reachable edit target', () => {
  const doc = dom(render());
  const preview = doc.querySelector('.notes-rail__preview');
  assert.equal(preview.getAttribute('role'), 'button');
  assert.equal(preview.getAttribute('tabindex'), '0');
  assert.equal(preview.dataset.action, 'notes-rail-edit');
  assert.equal(preview.getAttribute('aria-label'), 'Click to edit');
  assert.equal(preview.querySelectorAll('.notes-rail__line').length, 3);
  assert.match(preview.querySelector('.dashboard-scratchpad__preview-heading').textContent, /Plan/);
  assert.equal(preview.querySelectorAll('.dashboard-scratchpad__preview-bullet').length, 2);
});

test('preview never emits note markup, and checklist rows stay inert text', () => {
  const doc = dom(render({ note: note({ text: '<img src=x onerror=alert(1)>\n- [ ] ship it' }) }));
  const preview = doc.querySelector('.notes-rail__preview');
  assert.equal(preview.querySelector('img'), null);
  assert.equal(preview.querySelector('button'), null, 'no nested interactive controls in the edit target');
  assert.match(preview.textContent, /ship it/);
});

test('highlighted lines carry the new-line class and their source index', () => {
  const doc = dom(render({ highlightLines: new Set([1, 2]) }));
  const lines = Array.from(doc.querySelectorAll('.notes-rail__line'));
  assert.deepEqual(lines.map((el) => el.classList.contains('notes-rail__line--new')), [false, true, true]);
  assert.deepEqual(lines.map((el) => el.dataset.line), ['0', '1', '2']);
});

test('blank lines render as spacing, not as the empty-preview message', () => {
  const doc = dom(render({ note: note({ text: 'a\n\nb' }) }));
  const lines = doc.querySelectorAll('.notes-rail__line');
  assert.equal(lines.length, 3);
  assert.equal(lines[1].textContent, '');
  assert.equal(doc.body.textContent.includes('Nothing to preview'), false);
});

test('an empty note shows the project-named empty copy inside the edit target', () => {
  const doc = dom(render({ note: note({ text: '' }) }));
  const preview = doc.querySelector('.notes-rail__preview');
  assert.match(preview.textContent, /No notes for Alpha yet\. Jenny keeps status and decisions here as she works, and you can write here too\./);
  assert.equal(preview.dataset.action, 'notes-rail-edit');
});

test('loading with no note yet shows a loading line, not the empty copy', () => {
  const doc = dom(render({ note: null, loading: true }));
  assert.equal(doc.querySelector('.notes-rail__preview'), null);
  assert.match(doc.querySelector('.notes-rail__loading').textContent, /Loading/);
});

test('editing renders the inventory textarea with the escaped draft and the editing footer', () => {
  const doc = dom(render({ editing: true, draft: 'a </textarea><b>x</b> & more' }));
  const editor = doc.querySelector('textarea[data-notes-editor]');
  assert.ok(editor);
  assert.equal(editor.value, 'a </textarea><b>x</b> & more');
  assert.equal(editor.getAttribute('maxlength'), '20000');
  assert.equal(editor.getAttribute('aria-label'), 'Project notes');
  assert.equal(doc.querySelector('.notes-rail__preview'), null);
  assert.equal(doc.querySelector('b').textContent, 'Alpha', 'the draft markup stayed text');
  assert.match(doc.querySelector('.notes-rail__footer').textContent, /Esc or click outside to finish/);
});

test('the preview footer explains click-to-edit', () => {
  const doc = dom(render());
  assert.equal(doc.querySelector('.notes-rail__footer').textContent, 'Click anywhere to edit · saved automatically · Markdown');
});

test('change strip: added, edited and removed verbs with a relative time and Undo', () => {
  const at = '2026-10-06T11:57:00.000Z';
  const cases = [
    [{ verb: 'added', lines: 3 }, 'Jenny added 3 lines'],
    [{ verb: 'added', lines: 1 }, 'Jenny added 1 line'],
    [{ verb: 'edited', lines: 2 }, 'Jenny edited 2 lines'],
    [{ verb: 'removed', lines: 4 }, 'Jenny removed 4 lines'],
  ];
  for (const [part, copy] of cases) {
    const doc = dom(render({ changeStrip: { entryId: 'e1', at, undoable: true, ...part } }));
    const strip = doc.querySelector('.notes-rail__strip');
    assert.ok(strip, copy);
    assert.match(strip.textContent, new RegExp(`${copy} · 3 min ago`));
    assert.ok(strip.querySelector('[data-action="notes-rail-hide-changes"]'));
    assert.equal(strip.querySelector('[data-action="notes-rail-undo"]').dataset.entryId, 'e1');
  }
});

test('change strip: Undo only when undoable; the user-edit variant has none', () => {
  const at = '2026-10-06T11:59:40.000Z';
  const noUndo = dom(render({ changeStrip: { entryId: 'e1', verb: 'added', lines: 2, at, undoable: false } }));
  assert.equal(noUndo.querySelector('[data-action="notes-rail-undo"]'), null);
  assert.ok(noUndo.querySelector('[data-action="notes-rail-hide-changes"]'));
  const generic = dom(render({ changeStrip: { entryId: 'e1', verb: 'generic', lines: 0, at, undoable: false } }));
  assert.match(generic.querySelector('.notes-rail__strip').textContent, /Jenny edited this note · just now/);
  assert.equal(generic.querySelector('[data-action="notes-rail-undo"]'), null);
});

test('no strip markup when there is none', () => {
  assert.equal(dom(render()).querySelector('.notes-rail__strip'), null);
});

test('error: stale offers Save mine and Use Jenny\'s', () => {
  const doc = dom(render({ editing: true, draft: 'mine', error: { kind: 'stale' } }));
  const error = doc.querySelector('.notes-rail__error');
  assert.match(error.textContent, /Jenny changed this note while you were editing\./);
  assert.ok(error.querySelector('[data-action="notes-rail-save-mine"]'));
  assert.ok(error.querySelector('[data-action="notes-rail-use-theirs"]'));
  assert.equal(error.getAttribute('role'), 'alert');
});

test('error: note_full, save_failed (Retry), load_failed (Retry) and unavailable', () => {
  const full = dom(render({ editing: true, draft: 'x', error: { kind: 'note_full' } }));
  assert.match(full.querySelector('.notes-rail__error').textContent, /20,000-character limit/);
  assert.equal(full.querySelector('.notes-rail__error button'), null);
  const failed = dom(render({ editing: true, draft: 'x', error: { kind: 'save_failed' } }));
  assert.match(failed.querySelector('.notes-rail__error').textContent, /Could not save\. Your draft is kept here\./);
  assert.ok(failed.querySelector('[data-action="notes-rail-retry"]'));
  const load = dom(render({ note: null, error: { kind: 'load_failed' } }));
  assert.match(load.querySelector('.notes-rail__error').textContent, /Could not load/);
  assert.ok(load.querySelector('[data-action="notes-rail-retry"]'));
  const gone = dom(render({ note: null, error: { kind: 'unavailable' } }));
  assert.match(gone.querySelector('.notes-rail__error').textContent, /Notes are unavailable in this build\./);
  assert.equal(gone.querySelector('.notes-rail__preview'), null);
  assert.equal(gone.querySelector('textarea'), null);
});

test('relativeTime buckets', () => {
  const at = (ms) => new Date(NOW - ms).toISOString();
  assert.equal(notesRender.relativeTime(at(5000), NOW), 'just now');
  assert.equal(notesRender.relativeTime(at(5 * 60000), NOW), '5 min ago');
  assert.equal(notesRender.relativeTime(at(3 * 3600000), NOW), '3 h ago');
  assert.notEqual(notesRender.relativeTime(at(3 * 86400000), NOW), '');
  assert.equal(notesRender.relativeTime('not a date', NOW), '');
});

test('diffLines trims the common prefix and suffix', () => {
  assert.deepEqual(notesRender.diffLines('a\nb', 'a\nb\nc\nd'), { start: 2, added: 2, removed: 0 });
  assert.deepEqual(notesRender.diffLines('a\nb\nc', 'a\nc'), { start: 1, added: 0, removed: 1 });
  assert.deepEqual(notesRender.diffLines('a\nb\nc', 'a\nX\nc'), { start: 1, added: 1, removed: 1 });
  assert.deepEqual(notesRender.diffLines('a\n', 'a\nnew'), { start: 1, added: 1, removed: 0 });
  assert.deepEqual(notesRender.diffLines('', 'x\ny'), { start: 0, added: 2, removed: 0 });
  assert.deepEqual(notesRender.diffLines('same', 'same'), { start: 1, added: 0, removed: 0 });
});

test('buildChangeStrip: the latest Jenny entry with the measured diff', () => {
  const journal = [
    { id: 'e1', at: '2026-10-06T11:00:00.000Z', op: 'append', summary: 's', undoable: false },
    { id: 'e2', at: '2026-10-06T11:58:00.000Z', op: 'append', summary: 's', undoable: true },
  ];
  const strip = notesRender.buildChangeStrip(note({ journal }), {
    now: NOW, diff: { entryId: 'e2', added: 3, removed: 0 },
  });
  assert.deepEqual(strip, { entryId: 'e2', verb: 'added', lines: 3, at: '2026-10-06T11:58:00.000Z', undoable: true });
  const edited = notesRender.buildChangeStrip(note({ journal }), { now: NOW, diff: { entryId: 'e2', added: 1, removed: 2 } });
  assert.deepEqual([edited.verb, edited.lines], ['edited', 2]);
  const removed = notesRender.buildChangeStrip(note({ journal }), { now: NOW, diff: { entryId: 'e2', added: 0, removed: 2 } });
  assert.deepEqual([removed.verb, removed.lines], ['removed', 2]);
});

test('buildChangeStrip: an undone entry shows no strip at all', () => {
  const journal = [{ id: 'e2', at: '2026-10-06T11:58:00.000Z', op: 'append', summary: 's', undoable: false, undone: true }];
  assert.equal(notesRender.buildChangeStrip(note({ journal, updatedBy: 'user' }), { now: NOW, diff: { entryId: 'e2', added: 3, removed: 0 } }), null);
});

test('buildChangeStrip: without a measured diff for that entry the verb is generic', () => {
  const journal = [{ id: 'e2', at: '2026-10-06T11:58:00.000Z', op: 'replace', summary: 's', undoable: true }];
  const strip = notesRender.buildChangeStrip(note({ journal }), { now: NOW, diff: { entryId: 'other', added: 9, removed: 0 } });
  assert.deepEqual([strip.verb, strip.undoable], ['generic', true]);
});

test('buildChangeStrip: the entry\'s recorded lines stand in for a measured diff', () => {
  const journal = [{ id: 'e2', at: '2026-10-06T11:58:00.000Z', op: 'append', summary: 's', undoable: true, lines: { added: 2, removed: 0, start: 1 } }];
  const strip = notesRender.buildChangeStrip(note({ journal }), { now: NOW });
  assert.deepEqual([strip.verb, strip.lines, strip.undoable], ['added', 2, true]);
  assert.equal(notesRender.buildChangeStrip(note({ journal }), { now: NOW, diff: { entryId: 'e2', added: 1, removed: 1 } }).verb, 'edited', 'a measured diff wins');
  assert.equal(notesRender.buildChangeStrip(note({ journal, updatedBy: 'user' }), { now: NOW }).verb, 'generic');
  assert.deepEqual([...notesRender.recordedHighlight(note({ journal }), { now: NOW })], [1, 2]);
  assert.equal(notesRender.recordedHighlight(note({ journal, updatedBy: 'user' }), { now: NOW }), null);
  assert.equal(notesRender.recordedHighlight(note({ journal }), { now: NOW, hiddenEntryId: 'e2' }), null);
});

test('buildChangeStrip: hidden, undone, empty, old and user-edited cases', () => {
  const entry = { id: 'e2', at: '2026-10-06T11:58:00.000Z', op: 'append', summary: 's', undoable: true };
  assert.equal(notesRender.buildChangeStrip(note({ journal: [] }), { now: NOW }), null);
  assert.equal(notesRender.buildChangeStrip(null, { now: NOW }), null);
  assert.equal(notesRender.buildChangeStrip(note({ journal: [entry] }), { now: NOW, hiddenEntryId: 'e2' }), null);
  // An undone entry (updatedBy assistant, no longer undoable) is not a change to report.
  assert.equal(notesRender.buildChangeStrip(note({ journal: [{ ...entry, undoable: false }] }), { now: NOW }), null);
  // Older than a day: stale news.
  assert.equal(notesRender.buildChangeStrip(note({ journal: [{ ...entry, at: '2026-10-04T11:58:00.000Z' }] }), { now: NOW }), null);
  // The user edited after Jenny: generic text, never Undo.
  const afterUser = notesRender.buildChangeStrip(note({ updatedBy: 'user', journal: [entry] }), { now: NOW });
  assert.deepEqual([afterUser.verb, afterUser.undoable], ['generic', false]);
  const sinceUser = notesRender.buildChangeStrip(note({ journal: [entry] }), {
    now: NOW, userEditedAfter: Date.parse('2026-10-06T11:59:00.000Z'),
  });
  assert.deepEqual([sinceUser.verb, sinceUser.undoable], ['generic', false]);
});
