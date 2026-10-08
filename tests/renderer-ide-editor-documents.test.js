'use strict';

/* Behaviour tests of the editor document store on its own (no editor instance,
 * no DOM): file/diff doc records, alt-version dirty tracking with a fake model,
 * markSaved keeping an edit made during an async write dirty, model disposal on
 * close, and eol conversion on the fallback buffer path. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEditorDocuments } = require('../renderer/features/renderer-ide-editor-documents');

function makeFakeModel(text) {
  const model = {
    value: String(text),
    altVersion: 1,
    disposed: false,
    eol: null,
    getValue() { return this.value; },
    setValue(next) { this.value = String(next); this.altVersion += 1; model.onSetValue?.(); },
    getAlternativeVersionId() { return this.altVersion; },
    setEOL(sequence) { this.eol = sequence; },
    dispose() { this.disposed = true; },
  };
  return model;
}

function makeFakeMonaco() {
  const models = [];
  return {
    models,
    api: {
      Uri: { parse: (value) => ({ toString: () => String(value) }) },
      editor: {
        EndOfLineSequence: { LF: 0, CRLF: 1 },
        getModel: () => null,
        createModel: (text, language) => {
          const model = makeFakeModel(text);
          model.language = language;
          models.push(model);
          return model;
        },
      },
    },
  };
}

function makeStore(extra = {}) {
  const dirtyEvents = [];
  const modelChanges = [];
  const store = createEditorDocuments({
    monacoUtils: {
      normalizeEditorLanguage: (extension) => (extension === 'js' ? 'javascript' : 'plaintext'),
      workspacePathToMonacoUriString: (path) => `jenny-workspace:///${path}`,
      classifyLargeFile: (text) => String(text).length > 100,
      fingerprintText: (text) => `fp:${String(text).length}:${String(text).slice(0, 8)}`,
      ...extra.monacoUtils,
    },
    onDirtyChange: (path, dirty) => dirtyEvents.push([path, dirty]),
    onModelChange: (path) => modelChanges.push(path),
  });
  return { store, dirtyEvents, modelChanges };
}

test('openFile creates a fallback-buffer doc with eol, mtime and large-file classification', () => {
  const { store } = makeStore();
  const doc = store.openFile({ path: 'src/a.js', content: 'one\r\ntwo', mtimeMs: 42, eol: 'crlf' });

  assert.equal(doc.kind, 'file');
  assert.equal(doc.buffer, 'one\r\ntwo');
  assert.equal(doc.savedBuffer, 'one\r\ntwo');
  assert.equal(doc.mtimeMs, 42);
  assert.equal(doc.largeFile, false);
  assert.equal(store.hasDocument('src/a.js'), true);
  assert.equal(store.getDocumentKind('src/a.js'), 'file');
  assert.equal(store.getEol('src/a.js'), 'crlf');
  assert.equal(store.getMtime('src/a.js'), 42);
  assert.equal(store.docText(doc), 'one\r\ntwo');
  assert.equal(store.docs.get('src/a.js'), doc, 'docs is the shared Map the host hands to the panes module');

  const large = store.openFile({ path: 'big.js', content: 'x'.repeat(200) });
  assert.equal(large.largeFile, true);
  assert.equal(store.getEol('missing'), 'lf');
  assert.equal(store.getDocumentKind('missing'), '');
});

test('openFile with Monaco creates a model, drops the buffer and records the saved version', () => {
  const { store } = makeStore();
  const fake = makeFakeMonaco();
  const doc = store.openFile({ path: 'a.js', content: 'hello', monacoApi: fake.api });

  assert.equal(fake.models.length, 1);
  assert.equal(doc.model, fake.models[0]);
  assert.equal(doc.model.language, 'javascript');
  assert.equal(doc.buffer, null);
  assert.equal(doc.savedBuffer, null);
  assert.equal(doc.savedAltVersionId, doc.model.getAlternativeVersionId());
  assert.equal(store.getAltVersionId('a.js'), doc.model.getAlternativeVersionId());
  assert.equal(store.getAltVersionId('nope'), null);
});

test('refreshing an open file sets the model value under the applying guard and clears dirty', () => {
  const { store, dirtyEvents } = makeStore();
  const fake = makeFakeMonaco();
  const doc = store.openFile({ path: 'a.js', content: 'hello', monacoApi: fake.api });
  const seenWhileApplying = [];
  doc.model.onSetValue = () => seenWhileApplying.push(store.isApplyingValue());

  doc.model.altVersion += 1; // user edit
  store.syncDirty('a.js');
  assert.equal(store.isDirty('a.js'), true);
  assert.deepEqual(dirtyEvents, [['a.js', true]]);

  const refreshed = store.openFile({ path: 'a.js', content: 'from disk', mtimeMs: 7, monacoApi: fake.api });
  assert.equal(refreshed, doc, 'refresh reuses the record');
  assert.equal(doc.model.getValue(), 'from disk');
  assert.deepEqual(seenWhileApplying, [true], 'the guard is raised only during setValue');
  assert.equal(store.isApplyingValue(), false);
  assert.equal(store.isDirty('a.js'), false);
  assert.deepEqual(dirtyEvents, [['a.js', true], ['a.js', false]]);
  assert.equal(store.getMtime('a.js'), 7);

  // Identical content does not touch the model at all.
  seenWhileApplying.length = 0;
  store.openFile({ path: 'a.js', content: 'from disk', monacoApi: fake.api });
  assert.deepEqual(seenWhileApplying, []);
});

test('dirty tracking follows the alternative version id (undo back to saved is clean)', () => {
  const { store, dirtyEvents } = makeStore();
  const fake = makeFakeMonaco();
  const doc = store.openFile({ path: 'a.js', content: 'x', monacoApi: fake.api });
  const savedVersion = doc.model.getAlternativeVersionId();

  doc.model.altVersion = savedVersion + 1;
  store.syncDirty('a.js');
  store.syncDirty('a.js'); // unchanged state fires nothing further
  doc.model.altVersion = savedVersion; // undo returns to the saved version
  store.syncDirty('a.js');

  assert.deepEqual(dirtyEvents, [['a.js', true], ['a.js', false]]);
  store.syncDirty('unknown'); // no doc: silently ignored
});

test('markSaved records the pre-write version so an edit made during the write stays dirty', () => {
  const { store, dirtyEvents } = makeStore();
  const fake = makeFakeMonaco();
  const doc = store.openFile({ path: 'a.js', content: 'x', monacoApi: fake.api });

  doc.model.altVersion += 1; // edit, then a save begins
  store.syncDirty('a.js');
  const writtenVersion = store.getAltVersionId('a.js');
  doc.model.altVersion += 1; // another edit lands DURING the async write
  store.syncDirty('a.js');

  store.markSaved('a.js', { mtimeMs: 99, savedVersionId: writtenVersion });
  assert.equal(doc.savedAltVersionId, writtenVersion);
  assert.equal(store.isDirty('a.js'), true, 'the in-flight edit is not marked saved');
  assert.equal(store.getMtime('a.js'), 99);

  store.markSaved('a.js', { mtimeMs: 100 }); // no snapshot: re-reads the live version
  assert.equal(store.isDirty('a.js'), false);
  assert.deepEqual(dirtyEvents.at(-1), ['a.js', false]);
});

test('markSaved on the buffer path honours the snapshot taken before the write', () => {
  const { store } = makeStore();
  store.openFile({ path: 'a.txt', content: 'one' });
  const doc = store.getDoc('a.txt');

  doc.buffer = 'one two';
  store.syncDirty('a.txt');
  assert.equal(store.isDirty('a.txt'), true);

  doc.buffer = 'one two three'; // edit during the write of 'one two'
  store.markSaved('a.txt', { savedContent: 'one two' });
  assert.equal(doc.savedBuffer, 'one two');
  assert.equal(store.isDirty('a.txt'), true);

  store.markSaved('a.txt', {});
  assert.equal(doc.savedBuffer, 'one two three');
  assert.equal(store.isDirty('a.txt'), false);
  store.markSaved('missing', {}); // no doc: no throw
});

test('openDiff creates a diff doc, refreshes it, and flips to inline for a large side', () => {
  const { store } = makeStore();
  const doc = store.openDiff({ id: 'diff://1', label: 'src/a.js', languagePath: 'src/a.js', original: 'a', modified: 'b' });

  assert.equal(doc.kind, 'diff');
  assert.equal(doc.label, 'src/a.js');
  assert.equal(doc.language, 'javascript');
  assert.equal(doc.original, 'a');
  assert.equal(doc.modified, 'b');
  assert.equal(doc.placeholderText, '');
  assert.equal(doc.inlineDiff, false);
  assert.equal(store.getDocumentKind('diff://1'), 'diff');

  const again = store.openDiff({ id: 'diff://1', original: 'a', modified: 'x'.repeat(200), placeholderText: 'hunks' });
  assert.equal(again, doc);
  assert.equal(doc.label, 'src/a.js', 'label survives a refresh without one');
  assert.equal(doc.inlineDiff, true);
  assert.equal(doc.placeholderText, 'hunks');

  const unlabeled = store.openDiff({ id: 'diff://2' });
  assert.equal(unlabeled.label, 'Diff');
});

test('openDiff on a doc whose models exist pushes text into them and drops the fallback strings', () => {
  const { store } = makeStore();
  const doc = store.openDiff({ id: 'diff://1', original: 'a', modified: 'b' });
  doc.originalModel = makeFakeModel('a');
  doc.modifiedModel = makeFakeModel('b');

  store.openDiff({ id: 'diff://1', original: 'a2', modified: 'b2' });
  assert.equal(doc.originalModel.getValue(), 'a2');
  assert.equal(doc.modifiedModel.getValue(), 'b2');
  assert.equal(doc.original, null);
  assert.equal(doc.modified, null);
});

test('disposeModels / deleteDocument / disposeAllModels release every model', () => {
  const { store } = makeStore();
  const fake = makeFakeMonaco();
  const fileDoc = store.openFile({ path: 'a.js', content: 'x', monacoApi: fake.api });
  const diffDoc = store.openDiff({ id: 'diff://1', original: 'a', modified: 'b' });
  diffDoc.originalModel = makeFakeModel('a');
  diffDoc.modifiedModel = makeFakeModel('b');
  const otherDoc = store.openFile({ path: 'b.js', content: 'y', monacoApi: fake.api });

  store.disposeModels(fileDoc);
  store.deleteDocument('a.js');
  assert.equal(fileDoc.model.disposed, true);
  assert.equal(store.hasDocument('a.js'), false);
  assert.equal(store.hasDocument('b.js'), true);

  store.disposeAllModels();
  assert.equal(diffDoc.originalModel.disposed, true);
  assert.equal(diffDoc.modifiedModel.disposed, true);
  assert.equal(otherDoc.model.disposed, true);
  assert.equal(store.docs.size, 2, 'sweeping models does not remove records');

  store.clear();
  assert.equal(store.docs.size, 0);
  store.disposeModels(null); // tolerated
});

test('setEol converts the fallback buffer, marks it dirty and reports a model change', () => {
  const { store, dirtyEvents, modelChanges } = makeStore();
  store.openFile({ path: 'a.txt', content: 'a\nb\nc', eol: 'lf' });

  assert.equal(store.setEol('a.txt', 'crlf'), true);
  assert.equal(store.getEol('a.txt'), 'crlf');
  assert.equal(store.getDoc('a.txt').buffer, 'a\r\nb\r\nc');
  assert.equal(store.isDirty('a.txt'), true);
  assert.deepEqual(dirtyEvents, [['a.txt', true]]);
  assert.deepEqual(modelChanges, ['a.txt']);

  assert.equal(store.setEol('a.txt', 'lf'), true);
  assert.equal(store.getDoc('a.txt').buffer, 'a\nb\nc');
  assert.equal(store.isDirty('a.txt'), false, 'converting back to the saved eol is clean again');

  assert.equal(store.setEol('missing', 'crlf'), false);
});

test('setEol under Monaco changes the model EOL sequence and leaves the buffer path alone', () => {
  const { store, modelChanges } = makeStore();
  const fake = makeFakeMonaco();
  const doc = store.openFile({ path: 'a.js', content: 'a\nb', monacoApi: fake.api });

  assert.equal(store.setEol('a.js', 'crlf', fake.api), true);
  assert.equal(doc.eol, 'crlf');
  assert.equal(doc.model.eol, fake.api.editor.EndOfLineSequence.CRLF);
  assert.deepEqual(modelChanges, [], 'the model fires its own change event; the store adds none');
});

test('withEol normalizes CRLF / lone CR / LF to the requested ending', () => {
  const { store } = makeStore();
  assert.equal(store.withEol('a\r\nb\rc\nd', 'lf'), 'a\nb\nc\nd');
  assert.equal(store.withEol('a\r\nb\rc\nd', 'crlf'), 'a\r\nb\r\nc\r\nd');
  assert.equal(store.withEol(null, 'crlf'), '');
});

test('languageForPath maps the extension through monacoUtils and defaults to plaintext', () => {
  const { store } = makeStore();
  assert.equal(store.languageForPath('src/a.js'), 'javascript');
  assert.equal(store.languageForPath('Makefile'), 'plaintext');
  const bare = createEditorDocuments({});
  assert.equal(bare.languageForPath('a.js'), 'plaintext');
});
