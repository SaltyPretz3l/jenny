'use strict';
// Row 82 G2: inline blame for the cursor line (renderer/features/renderer-ide-inline-blame.js):
// a 300 ms debounce, one workspaceGit.blameFile per (path, HEAD) mapped through the
// gutter's headLineFor, an `after` decoration in the muted text colour, cleared on a dirty
// line and when the pref is off. Cleanup wave G2: one blame per file, a shared in-flight
// request, and an abort on file switch.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeInlineBlame, formatBlameText } = require('../renderer/features/renderer-ide-inline-blame');
const { createFakeTimers } = require('./helpers/fake-timers');

function fakeModel(lines) {
  let ids = 0;
  const live = new Map();
  return {
    lines,
    version: 1,
    getLineCount: () => lines.length,
    getLineMaxColumn: (line) => String(lines[line - 1] || '').length + 1,
    deltaDecorations(oldIds, decorations) {
      for (const id of oldIds || []) live.delete(id);
      return decorations.map((decoration) => { ids += 1; const id = `d${ids}`; live.set(id, decoration); return id; });
    },
    live: () => [...live.values()],
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const COMMITTED = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', author: 'Ada Lovelace', dateISO: '2026-10-20T10:00:00.000Z', summary: 'Teach the engine to loop' };
// Every HEAD line 1..40 is committed; line n carries summary "commit n".
const blameLines = () => Array.from({ length: 40 }, (_v, i) => ({ ...COMMITTED, line: i + 1, summary: i === 1 ? COMMITTED.summary : `commit ${i + 1}` }));

function setup({ prefs = { inlineBlame: true }, headLine = (path, line) => line, blame, lines = 12, active = 'src/a.js' } = {}) {
  const timers = createFakeTimers();
  const models = {
    'src/a.js': fakeModel(Array.from({ length: lines }, (_v, i) => `line ${i + 1}`)),
    'src/b.js': fakeModel(['b one', 'b two']),
  };
  const model = models['src/a.js'];
  const calls = { blame: [], range: [], signals: [] };
  const ide = { ...prefs };
  const state = { active, head: ['line 1', 'line 2'] };
  const editorHost = {
    getActivePath: () => state.active,
    getModel: (path) => models[path] || null,
    getAltVersionId: (path) => (models[path] ? models[path].version : 0),
    getDocumentKind: () => 'file',
    isLargeFile: () => false,
  };
  const blamer = createIdeInlineBlame({
    editorHost,
    getIde: () => ide,
    headLineFor: headLine,
    headFor: () => state.head,
    gitClient: {
      blameFile: async (payload, options) => {
        calls.blame.push(payload);
        calls.signals.push(options && options.signal);
        return blame ? blame(payload, options) : { ok: true, found: true, lines: blameLines() };
      },
      // The pre-cleanup per-line read: counted so a regression to it shows.
      blameRange: async (payload) => {
        calls.range.push(payload);
        return { ok: true, found: true, lines: [{ ...COMMITTED, line: payload.startLine }] };
      },
    },
    nowFn: () => Date.parse('2026-10-26T10:00:00.000Z'),
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });
  return { blamer, timers, model, models, calls, ide, state };
}

const gitCalls = (calls) => calls.blame.length + calls.range.length;

test('the cursor on a committed line gets one after decoration with the author (debounced 300 ms)', async () => {
  const { blamer, timers, model, calls } = setup();
  blamer.handleCursor('src/a.js', 2);
  assert.deepEqual(timers.delays(), [300]);
  assert.equal(gitCalls(calls), 0, 'nothing before the debounce');
  timers.runPending();
  await settle();
  assert.deepEqual(calls.blame, [{ path: 'src/a.js' }]);
  const decorations = model.live();
  assert.equal(decorations.length, 1);
  const [decoration] = decorations;
  assert.equal(decoration.range.startLineNumber, 2);
  assert.equal(decoration.range.startColumn, 7, 'anchored at the end of the line');
  assert.equal(decoration.options.after.inlineClassName, 'ide-inline-blame');
  assert.match(decoration.options.after.content, /Ada Lovelace/);
  assert.match(decoration.options.after.content, /Teach the engine to loop/);
});

test('ten cursor moves across committed lines of one file call blame once', async () => {
  const { blamer, timers, calls, model } = setup();
  for (let line = 1; line <= 10; line += 1) {
    blamer.handleCursor('src/a.js', line);
    timers.runPending();
    await settle();
    assert.match(model.live()[0].options.after.content, line === 2 ? /Teach the engine/ : new RegExp(`commit ${line}\\b`));
  }
  assert.equal(gitCalls(calls), 1);
  model.version = 2;
  blamer.handleCursor('src/a.js', 3);
  timers.runPending();
  await settle();
  assert.equal(gitCalls(calls), 1, 'an edit keeps the per-HEAD blame (lines map through headLineFor)');
});

test('concurrent asks for one file share the in-flight blame', async () => {
  let release;
  const { blamer, timers, calls, model } = setup({ blame: () => new Promise((resolve) => { release = resolve; }) });
  blamer.handleCursor('src/a.js', 4);
  timers.runPending();
  blamer.handleCursor('src/a.js', 5);
  timers.runPending();
  assert.equal(calls.blame.length, 1);
  release({ ok: true, found: true, lines: blameLines() });
  await settle();
  assert.match(model.live()[0].options.after.content, /commit 5\b/);
});

test('a file switch aborts the pending blame', async () => {
  const { blamer, timers, calls, state, models } = setup({ blame: (_payload, options) => new Promise((resolve) => {
    options.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }));
  }) });
  blamer.handleCursor('src/a.js', 2);
  timers.runPending();
  assert.equal(calls.signals[0].aborted, false);
  state.active = 'src/b.js';
  blamer.handleCursor('src/b.js', 1);
  assert.equal(calls.signals[0].aborted, true);
  await settle();
  state.active = 'src/a.js';
  blamer.handleCursor('src/a.js', 2);
  timers.runPending();
  assert.equal(calls.blame.filter((call) => call.path === 'src/a.js').length, 2, 'an aborted blame is not cached');
  assert.equal(models['src/a.js'].live().length, 0);
});

test('a dirty line (no HEAD counterpart) clears the decoration and asks git nothing more', async () => {
  const { blamer, timers, calls, model } = setup({ headLine: (path, line) => (line === 3 ? null : line) });
  blamer.handleCursor('src/a.js', 2);
  timers.runPending();
  await settle();
  assert.equal(model.live().length, 1);
  blamer.handleCursor('src/a.js', 3);
  assert.equal(model.live().length, 0, 'moving off the line clears at once');
  timers.runPending();
  await settle();
  assert.equal(gitCalls(calls), 1);
  assert.equal(model.live().length, 0);
});

test('the blame line is the HEAD line, so edits above shift the entry shown', async () => {
  const { blamer, timers, model } = setup({ headLine: (path, line) => line + 4 });
  blamer.handleCursor('src/a.js', 2);
  timers.runPending();
  await settle();
  assert.match(model.live()[0].options.after.content, /commit 6\b/);
});

test('inlineBlame off renders nothing; refresh after a toggle re-evaluates the last cursor', async () => {
  const { blamer, timers, calls, model, ide } = setup({ prefs: { inlineBlame: false } });
  blamer.handleCursor('src/a.js', 2);
  timers.runPending();
  await settle();
  assert.equal(gitCalls(calls), 0);
  ide.inlineBlame = true;
  blamer.refresh();
  timers.runPending();
  await settle();
  assert.equal(model.live().length, 1);
  ide.inlineBlame = false;
  blamer.refresh();
  assert.equal(model.live().length, 0, 'turning it off clears at once');
});

test('a stale answer (cursor moved, file switched, failed blame) never paints', async () => {
  let release;
  const { blamer, timers, model } = setup({ blame: () => new Promise((resolve) => { release = resolve; }) });
  blamer.handleCursor('src/a.js', 2);
  timers.runPending();
  blamer.handleCursor('src/a.js', 1);
  release({ ok: true, found: true, lines: blameLines() });
  await settle();
  assert.equal(model.live().length, 0);
  const failing = setup({ blame: () => ({ ok: false }) });
  failing.blamer.handleCursor('src/a.js', 2);
  failing.timers.runPending();
  await settle();
  assert.equal(failing.model.live().length, 0);
  failing.blamer.handleCursor('src/a.js', 3);
  failing.timers.runPending();
  await settle();
  assert.equal(failing.calls.blame.length, 2, 'a failed blame is not cached');
});

test('invalidate keeps a blame whose HEAD text is unchanged (a git refresh that left the file alone)', async () => {
  const { blamer, timers, calls } = setup();
  blamer.handleCursor('src/a.js', 2);
  timers.runPending();
  await settle();
  for (let i = 0; i < 5; i += 1) {
    blamer.invalidate();
    timers.runPending();
    await settle();
  }
  assert.equal(calls.blame.length, 1, 'five status refreshes, one whole-file blame');
});

test('invalidate refetches once HEAD moved for the file, and dispose clears the decoration', async () => {
  const { blamer, timers, calls, model, state } = setup();
  blamer.handleCursor('src/a.js', 2);
  timers.runPending();
  await settle();
  state.head = ['line 1', 'line 2 (amended)'];
  blamer.invalidate();
  timers.runPending();
  await settle();
  assert.equal(calls.blame.length, 2);
  blamer.dispose();
  assert.equal(model.live().length, 0);
});

test('formatBlameText: author, relative time and a bounded summary', () => {
  const text = formatBlameText({ author: 'Ada', dateISO: '2026-10-25T10:00:00.000Z', summary: 'x'.repeat(200) }, Date.parse('2026-10-26T10:00:00.000Z'));
  assert.match(text, /^Ada, /);
  assert.ok(text.length < 140);
  assert.match(text, /…$/);
});
