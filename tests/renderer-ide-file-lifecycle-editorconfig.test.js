'use strict';

/* renderer-ide-file-lifecycle x .editorconfig (row 82 E2): the applier's call
 * order around the open path (after the user defaults, never holding the open),
 * background opens, image opens, the save-hygiene overrides and the
 * forget/reset/dispose lifecycle. Split out of renderer-ide-file-lifecycle.test.js
 * at the file-size ceiling. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ideState = require('../renderer/features/renderer-ide-state');
const { createIdeFileLifecycle } = require('../renderer/features/renderer-ide-file-lifecycle');

// ---- row 82 E2: .editorconfig wiring ------------------------------------

// A lifecycle over a tiny host; `config` is the workspace `.editorconfig` text (or null).
function makeEditorconfigLifecycle({ config = null, editorconfig, configThrows = false, saveHygiene = null } = {}) {
  const ide = ideState.createIdeUiState();
  const docs = new Map();
  const events = [];
  const configReads = [];
  const editorHost = {
    hasDocument: (p) => docs.has(p),
    openDocument: async (payload) => {
      if (typeof payload.shouldApply === 'function' && !payload.shouldApply()) return null;
      docs.set(payload.path, { kind: 'file', value: payload.content, mtime: payload.mtimeMs });
      payload.onApplied?.();
      return docs.get(payload.path);
    },
    openImageDocument: (payload) => { docs.set(payload.path, { kind: 'image', value: payload.base64 }); return true; },
    activateDocument: (p) => events.push(`activate:${p}`),
    closeDocument: (p) => docs.delete(p),
    showEmpty() {},
    getDocumentKind: (p) => docs.get(p)?.kind || null,
    getValue: (p) => docs.get(p)?.value,
    getAltVersionId: () => 1,
    getMtime: () => 0,
    isDirty: () => false,
    markSaved() {},
    setIndent: (p, indent) => events.push(`setIndent:${p}:${indent.insertSpaces === false ? 'tab' : 'space'}${indent.tabSize || ''}`),
    getEol: () => 'lf',
    setEol: (p, eol) => events.push(`setEol:${p}:${eol}`),
    getModel: () => ({ getLineCount: () => 1 }),
  };
  const api = {
    readText: async ({ path }) => {
      if (path.endsWith('.editorconfig')) {
        configReads.push(path);
        if (configThrows) throw new Error('bridge down');
        return config === null ? { ok: false, code: 'CMP-WORKSPACEFS-0004' } : { ok: true, content: config };
      }
      return {
        ok: true, path, pathKey: path, requestedPath: path, requestedPathKey: path, content: 'x\n', mtimeMs: 1,
        rootId: 'root-a', generation: 1, fileVersion: 'v1', encoding: 'utf-8', editable: true, truncated: false, eol: 'lf',
      };
    },
    readImage: async ({ path }) => ({
      ok: true, path, pathKey: path, requestedPath: path, requestedPathKey: path, base64: 'AAAA', mime: 'image/png',
      size: 3, mtimeMs: 1, rootId: 'root-a', generation: 1, fileVersion: 'v1', kind: 'image', representation: 'base64',
      editable: false, truncated: false,
    }),
    writeText: async (payload) => ({
      ok: true, path: payload.path, pathKey: payload.path, mtimeMs: 2, rootId: 'root-a', generation: 1, fileVersion: 'v2',
    }),
  };
  const lifecycle = createIdeFileLifecycle({
    getIde: () => ide,
    ideStateUtils: ideState,
    editorHost,
    getWorkspaceFsApi: () => api,
    chipPicker: { applyDefaults: (p) => events.push(`defaults:${p}`) },
    editorconfig,
    saveHygiene,
    gitFeature: { requestRefresh() {} },
    searchPanel: { isReplacing: () => false },
    renderTabs() {},
    schedulePersist() {},
  });
  return { ide, lifecycle, events, configReads, docs };
}

test('editorconfig indent reaches the document AFTER the user defaults ran, without holding the open', async () => {
  const ctx = makeEditorconfigLifecycle({ config: '[*]\nindent_style = tab\nindent_size = 4\n' });
  assert.equal(await ctx.lifecycle.openFile('src/a.js'), true);
  // The resolve runs off the open path (a root switch must never land mid-open); let it settle.
  await new Promise((resolve) => setImmediate(resolve));
  const activate = ctx.events.indexOf('activate:src/a.js');
  const defaults = ctx.events.indexOf('defaults:src/a.js');
  const indent = ctx.events.indexOf('setIndent:src/a.js:tab4');
  assert.ok(activate >= 0 && defaults > activate, 'defaults run on activation');
  assert.ok(indent > defaults, `setIndent must follow applyDefaults (events: ${ctx.events.join(', ')})`);
  assert.ok(ctx.configReads.includes('src/.editorconfig') && ctx.configReads.includes('.editorconfig'));
});

test('editorconfig EOL at open: a single-line document converts, nothing else is touched', async () => {
  const ctx = makeEditorconfigLifecycle({ config: '[*]\nend_of_line = crlf\n' });
  await ctx.lifecycle.openFile('a.txt');
  assert.ok(ctx.events.includes('setEol:a.txt:crlf'));
  assert.ok(!ctx.events.some((e) => e.startsWith('setIndent')), 'no indent keys, no indent call');
});

test('a background open applies editorconfig before its early return', async () => {
  const ctx = makeEditorconfigLifecycle({ config: '[*]\nindent_style = space\nindent_size = 2\n' });
  ctx.ide.openTabs.push({ path: 'b.js', kind: 'file', group: 'g2' });
  assert.equal(await ctx.lifecycle.openFile('b.js', { background: true }), true);
  assert.ok(ctx.events.includes('setIndent:b.js:space2'));
  assert.ok(!ctx.events.some((e) => e.startsWith('defaults:')), 'background opens skip applyDefaults');
});

test('image opens never read .editorconfig; a failing config read never blocks a text open', async () => {
  const images = makeEditorconfigLifecycle({ config: '[*]\nindent_size = 2\n' });
  assert.equal(await images.lifecycle.openFile('pic.png'), true);
  assert.equal(images.configReads.length, 0);
  const broken = makeEditorconfigLifecycle({ configThrows: true });
  assert.equal(await broken.lifecycle.openFile('a.js'), true);
  assert.ok(!broken.events.some((e) => e.startsWith('setIndent')));
});

test('saveFile hands the editorconfig hygiene overrides to applySaveHygiene', async () => {
  const calls = [];
  const ctx = makeEditorconfigLifecycle({
    config: '[*]\ntrim_trailing_whitespace = true\ninsert_final_newline = false\nend_of_line = crlf\n',
    saveHygiene: { applySaveHygiene: (path, overrides) => { calls.push([path, overrides]); } },
  });
  await ctx.lifecycle.openFile('a.js');
  assert.equal(await ctx.lifecycle.saveFile('a.js'), true);
  assert.deepEqual(calls, [['a.js', { trimTrailingWhitespace: true, insertFinalNewline: false, endOfLine: 'crlf' }]]);
  const plain = makeEditorconfigLifecycle({
    config: null, saveHygiene: { applySaveHygiene: (...args) => { calls.push(args); } },
  });
  await plain.lifecycle.openFile('b.js');
  await plain.lifecycle.saveFile('b.js');
  assert.deepEqual(calls.at(-1), ['b.js', undefined], 'no .editorconfig means no overrides');
});

test('closing a tab forgets its path, a root reset resets, and dispose disposes the applier', async () => {
  const seen = [];
  const editorconfig = {
    prepare: async () => null, apply: (p) => seen.push(`apply:${p}`), hygieneFor: () => null,
    forget: (p) => seen.push(`forget:${p}`), reset: () => seen.push('reset'), dispose: () => seen.push('dispose'),
  };
  const ctx = makeEditorconfigLifecycle({ editorconfig });
  await ctx.lifecycle.openFile('a.js');
  await new Promise((resolve) => setImmediate(resolve));
  // Once after the user defaults (cached settings) and once when the resolve settles.
  assert.deepEqual(seen, ['apply:a.js', 'apply:a.js']);
  ctx.lifecycle.closeTab('a.js');
  assert.ok(seen.includes('forget:a.js'));
  ctx.lifecycle.resetForRoot({});
  assert.ok(seen.includes('reset'));
  ctx.lifecycle.dispose();
  assert.ok(seen.includes('dispose'));
});
