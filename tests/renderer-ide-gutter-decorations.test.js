const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const vm = require('node:vm');

const {
  createIdeGutterDecorations,
  diffLineRegions,
  computeGutterDecorations,
  splitLines,
  GUTTER_CLASS,
} = require('../renderer/features/renderer-ide-gutter-decorations');

function loadPrivateDiffCore() {
  const modulePath = require.resolve('../renderer/features/renderer-ide-gutter-decorations');
  const source = fs.readFileSync(modulePath, 'utf8');
  const instrumented = source.replace(
    /( {2}return \{\r?\n)( {4}createIdeGutterDecorations,)/,
    '$1    diffCore,\n$2'
  );
  assert.notEqual(instrumented, source, 'diffCore test instrumentation must match the module export block');
  const moduleRef = { exports: {} };
  vm.runInNewContext(instrumented, {
    module: moduleRef,
    exports: moduleRef.exports,
    require: createRequire(modulePath),
  }, { filename: modulePath });
  return moduleRef.exports.diffCore;
}

const diffCore = loadPrivateDiffCore();

function referenceLcsLength(a, b) {
  const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = a[i - 1] === b[j - 1]
        ? rows[i - 1][j - 1] + 1
        : Math.max(rows[i - 1][j], rows[i][j - 1]);
    }
  }
  return rows[a.length][b.length];
}

function assertScriptReconstructs(a, b, ops, label) {
  const output = [];
  let aIndex = 0;
  let bIndex = 0;
  for (const op of ops) {
    if (op === 'equal') {
      assert.ok(aIndex < a.length && bIndex < b.length, `${label}: equal must consume both sides`);
      assert.equal(a[aIndex], b[bIndex], `${label}: equal must pair matching lines`);
      output.push(a[aIndex]);
      aIndex += 1;
      bIndex += 1;
    } else if (op === 'delete') {
      assert.ok(aIndex < a.length, `${label}: delete must consume an old line`);
      aIndex += 1;
    } else if (op === 'insert') {
      assert.ok(bIndex < b.length, `${label}: insert must consume a new line`);
      output.push(b[bIndex]);
      bIndex += 1;
    } else {
      assert.fail(`${label}: unknown op ${String(op)}`);
    }
  }
  assert.equal(aIndex, a.length, `${label}: script must consume all old lines`);
  assert.equal(bIndex, b.length, `${label}: script must consume all new lines`);
  assert.deepEqual(output, b, `${label}: script must reconstruct the new lines`);
}

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

// ── Pure diff: splitLines ──

test('splitLines normalizes CRLF/CR to LF and keeps the trailing-newline marker', () => {
  assert.deepEqual(splitLines('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b', '']);
  assert.deepEqual(splitLines(''), ['']);
  assert.deepEqual(splitLines(null), ['']);
});

test('diffCore scripts reconstruct the target and have an optimal equal count', () => {
  const random = createSeededRandom(0x5eed1234);
  for (let pair = 0; pair < 256; pair += 1) {
    const a = Array.from({ length: random() % 9 }, () => `line-${random() % 5}`);
    const b = Array.from({ length: random() % 9 }, () => `line-${random() % 5}`);
    const ops = diffCore(a, b);
    const label = `seeded pair ${pair}`;
    assertScriptReconstructs(a, b, ops, label);
    assert.equal(
      ops.filter((op) => op === 'equal').length,
      referenceLcsLength(a, b),
      `${label}: equal count must match the reference LCS`
    );
  }
});

test('diffCore keeps 1,999 equal lines around one change in a 2,000-line core', () => {
  const a = new Array(2000).fill('same');
  const b = a.slice();
  b[1000] = 'changed';
  const ops = diffCore(a, b);
  assertScriptReconstructs(a, b, ops, 'large changed core');
  assert.equal(ops.filter((op) => op === 'equal').length, 1999);
});

test('diffCore keeps the coarse delete-all then insert-all script past MAX_DIFF_LINES', () => {
  const a = Array.from({ length: 5001 }, (_, index) => `old-${index}`);
  const b = ['new'];
  const ops = diffCore(a, b);
  assert.deepEqual(Array.from(ops), new Array(5001).fill('delete').concat('insert'));
  assertScriptReconstructs(a, b, ops, 'coarse line-cap diff');
});

test('diffCore keeps the empty-side fast paths', () => {
  assert.deepEqual(Array.from(diffCore([], ['a', 'b'])), ['insert', 'insert']);
  assert.deepEqual(Array.from(diffCore(['a', 'b'], [])), ['delete', 'delete']);
});

// ── Pure diff: diffLineRegions classification ──

test('identical text produces no regions', () => {
  assert.deepEqual(diffLineRegions('a\nb\nc\n', 'a\nb\nc\n'), []);
});

test('a new file (no HEAD content) marks every line added', () => {
  assert.deepEqual(diffLineRegions('', 'x\ny\n'), [
    { type: 'added', startLine: 1, endLine: 2 },
  ]);
});

test('a pure insertion in the middle is one added region at the new lines', () => {
  // a, b, c -> a, NEW1, NEW2, b, c
  assert.deepEqual(diffLineRegions('a\nb\nc\n', 'a\nNEW1\nNEW2\nb\nc\n'), [
    { type: 'added', startLine: 2, endLine: 3 },
  ]);
});

test('a single-line replacement is one modified region', () => {
  assert.deepEqual(diffLineRegions('a\nb\nc\n', 'a\nB\nc\n'), [
    { type: 'modified', startLine: 2, endLine: 2 },
  ]);
});

test('a pure deletion is one deleted boundary marker', () => {
  // a, b, c, d -> a, d  (b and c removed; boundary lands on the line now there)
  const regions = diffLineRegions('a\nb\nc\nd\n', 'a\nd\n');
  assert.equal(regions.length, 1);
  assert.equal(regions[0].type, 'deleted');
  assert.equal(regions[0].startLine, regions[0].endLine);
});

test('collapsing a multi-line file to a single line yields exactly one deleted marker', () => {
  // old has a trailing newline (3 "lines"), new is one line with none: the
  // deletion of "a" and of the trailing empty both clamp to line 1 -> dedupe.
  const regions = diffLineRegions('a\nb\n', 'b');
  assert.deepEqual(regions, [{ type: 'deleted', startLine: 1, endLine: 1 }]);
});

test('a deletion at end-of-file clamps the boundary to the last line', () => {
  const regions = diffLineRegions('a\nb\nc\n', 'a\n');
  assert.equal(regions.length, 1);
  assert.equal(regions[0].type, 'deleted');
  assert.ok(regions[0].startLine >= 1);
});

test('mixed edit (replace + append) yields modified then added (the smoke scenario)', () => {
  const head = 'line1\nline2\nline3\n';
  const buffer = 'line1\nCHANGED\nline3\nADDED\n';
  assert.deepEqual(diffLineRegions(head, buffer), [
    { type: 'modified', startLine: 2, endLine: 2 },
    { type: 'added', startLine: 4, endLine: 4 },
  ]);
});

test('replacing more lines than removed still classifies as modified across the new span', () => {
  // a, OLD, z -> a, N1, N2, z : 1 removed + 2 inserted => modified over both new lines
  assert.deepEqual(diffLineRegions('a\nOLD\nz\n', 'a\nN1\nN2\nz\n'), [
    { type: 'modified', startLine: 2, endLine: 3 },
  ]);
});

test('a changed core past the line cap degrades to one coarse modified region', () => {
  // No common prefix/suffix, both sides over MAX_DIFF_LINES -> the LCS is
  // skipped and the whole new span is reported as one modified region.
  const oldText = Array.from({ length: 6000 }, (_, i) => `old${i}`).join('\n');
  const newText = Array.from({ length: 6000 }, (_, i) => `new${i}`).join('\n');
  assert.deepEqual(diffLineRegions(oldText, newText), [
    { type: 'modified', startLine: 1, endLine: 6000 },
  ]);
});

// ── Pure diff -> decoration mapping ──

test('computeGutterDecorations maps regions to Monaco line decorations with palette classes', () => {
  const decorations = computeGutterDecorations('line1\nline2\nline3\n', 'line1\nCHANGED\nline3\nADDED\n');
  assert.equal(decorations.length, 2);

  const [modified, added] = decorations;
  assert.equal(modified.options.linesDecorationsClassName, GUTTER_CLASS.modified);
  assert.deepEqual(modified.range, { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 });
  assert.equal(modified.options.description, 'jenny-gutter-change');

  assert.equal(added.options.linesDecorationsClassName, GUTTER_CLASS.added);
  assert.deepEqual(added.range, { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 1 });
});

test('the deleted class is distinct from added/modified', () => {
  const decorations = computeGutterDecorations('a\nb\nc\n', 'a\n');
  assert.equal(decorations.length, 1);
  assert.equal(decorations[0].options.linesDecorationsClassName, GUTTER_CLASS.deleted);
  assert.notEqual(GUTTER_CLASS.deleted, GUTTER_CLASS.added);
  assert.notEqual(GUTTER_CLASS.deleted, GUTTER_CLASS.modified);
});

// ── Factory: recompute lifecycle ──

function makeEditorHost(initial) {
  const state = {
    activePath: 'a.js',
    kind: 'file',
    value: '',
    large: false,
    ...(initial || {}),
  };
  const calls = [];
  return {
    state,
    calls,
    getActivePath: () => state.activePath,
    getDocumentKind: () => state.kind,
    getValue: () => state.value,
    setGutterDecorations: (path, decs) => {
      calls.push({ path, decs });
      return Array.isArray(decs) ? decs.length : 0;
    },
  };
}

function makeWindow(host) {
  const listeners = {};
  return {
    rendererIdeActiveEditorReader: { isLargeFile: () => host.state.large === true },
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    removeEventListener: (name, fn) => {
      listeners[name] = (listeners[name] || []).filter((cb) => cb !== fn);
    },
    dispatch: (name, detail) => { (listeners[name] || []).forEach((cb) => cb({ detail })); },
    listenerCount: (name) => (listeners[name] || []).length,
  };
}

function makeGitClient(responses) {
  const calls = [];
  return {
    calls,
    getFileAtHead: async ({ path }) => {
      calls.push(path);
      const value = responses[path];
      return typeof value === 'function' ? value() : value;
    },
  };
}

function setup(initial, responses) {
  const editorHost = makeEditorHost(initial);
  const windowRef = makeWindow(editorHost);
  const gitClient = makeGitClient(responses || {});
  const gutter = createIdeGutterDecorations({
    editorHost,
    windowRef,
    gitClient,
    clientUtils: {},
    setTimeoutFn: (cb) => cb, // not used by direct recompute() tests
    clearTimeoutFn: () => {},
  });
  return { editorHost, windowRef, gitClient, gutter };
}

const headFound = (content) => ({ ok: true, available: true, isRepo: true, found: true, content });
const headMissing = () => ({ ok: true, available: true, isRepo: true, found: false, reason: 'not_in_head' });

test('recompute applies computed decorations for the active tracked file', async () => {
  const { editorHost, gutter } = setup(
    { activePath: 'a.js', value: 'line1\nCHANGED\n' },
    { 'a.js': headFound('line1\nline2\n') }
  );
  await gutter.recompute('a.js');
  assert.equal(editorHost.calls.length, 1);
  assert.equal(editorHost.calls[0].path, 'a.js');
  assert.equal(editorHost.calls[0].decs.length, 1);
  assert.equal(editorHost.calls[0].decs[0].options.linesDecorationsClassName, GUTTER_CLASS.modified);
});

test('a file with no HEAD version renders as all-added', async () => {
  const { editorHost, gutter } = setup(
    { activePath: 'new.js', value: 'a\nb\n' },
    { 'new.js': headMissing() }
  );
  await gutter.recompute('new.js');
  assert.equal(editorHost.calls.length, 1);
  assert.equal(editorHost.calls[0].decs[0].options.linesDecorationsClassName, GUTTER_CLASS.added);
});

test('HEAD content is cached per path (one getFileAtHead across repeated recomputes)', async () => {
  const { gitClient, gutter } = setup(
    { activePath: 'a.js', value: 'x\n' },
    { 'a.js': headFound('y\n') }
  );
  await gutter.recompute('a.js');
  await gutter.recompute('a.js');
  assert.equal(gitClient.calls.length, 1);
});

test('refreshActive drops the HEAD cache so the next recompute refetches', async () => {
  const { gitClient, gutter } = setup(
    { activePath: 'a.js', value: 'x\n' },
    { 'a.js': headFound('y\n') }
  );
  await gutter.recompute('a.js');
  assert.equal(gitClient.calls.length, 1);
  gutter.refreshActive(); // clears the cache (and schedules, but the fake timer is inert here)
  await gutter.recompute('a.js');
  assert.equal(gitClient.calls.length, 2);
});

test('a pre-refresh HEAD read cannot overwrite the refreshed cache after resolving late', async () => {
  let resolveOld;
  let resolveCurrent;
  const reads = [
    new Promise((resolve) => { resolveOld = resolve; }),
    new Promise((resolve) => { resolveCurrent = resolve; }),
  ];
  let gitCalls = 0;
  const editorHost = makeEditorHost({ activePath: 'a.js', value: 'current\n' });
  const gutter = createIdeGutterDecorations({
    editorHost,
    windowRef: makeWindow(editorHost),
    gitClient: { getFileAtHead: async () => reads[gitCalls++] },
    clientUtils: {},
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  const stale = gutter.recompute('a.js');
  gutter.refreshActive();
  const fresh = gutter.recompute('a.js');
  resolveCurrent(headFound('current\n'));
  await fresh;
  resolveOld(headFound('old\n'));
  await stale;
  await gutter.recompute('a.js');

  assert.equal(gitCalls, 2);
  assert.deepEqual(editorHost.calls.at(-1).decs, []);
});

test('the HEAD cache is bounded: FIFO eviction past the cap', async () => {
  const responses = {};
  for (let i = 0; i < 70; i += 1) { responses[`f${i}.js`] = headFound(`v${i}\n`); }
  const { editorHost, gitClient, gutter } = setup({ activePath: 'f0.js', value: 'x\n' }, responses);
  for (let i = 0; i < 70; i += 1) {
    editorHost.state.activePath = `f${i}.js`;
    await gutter.recompute(`f${i}.js`);
  }
  assert.equal(gitClient.calls.length, 70, 'each distinct path fetched HEAD once');
  // The earliest entries were evicted (cap 64) -> refetching f0 hits git again.
  editorHost.state.activePath = 'f0.js';
  await gutter.recompute('f0.js');
  assert.equal(gitClient.calls.length, 71, 'an evicted path refetches HEAD');
});

test('large files are skipped: decorations are cleared, no diff computed', async () => {
  const { editorHost, gitClient, gutter } = setup(
    { activePath: 'big.min.js', value: 'x\n', large: true },
    { 'big.min.js': headFound('y\n') }
  );
  await gutter.recompute('big.min.js');
  assert.equal(gitClient.calls.length, 0, 'never reads HEAD for a large file');
  assert.equal(editorHost.calls.length, 1);
  assert.deepEqual(editorHost.calls[0].decs, []);
});

test('non-file documents (diff/image/preview) are cleared, not diffed', async () => {
  const { editorHost, gitClient, gutter } = setup(
    { activePath: 'diff://x', kind: 'diff', value: 'x\n' },
    {}
  );
  await gutter.recompute('diff://x');
  assert.equal(gitClient.calls.length, 0);
  assert.deepEqual(editorHost.calls[0].decs, []);
});

test('when git is unavailable, decorations clear and the negative result is cached', async () => {
  const { editorHost, gitClient, gutter } = setup(
    { activePath: 'a.js', value: 'x\n' },
    { 'a.js': () => ({ ok: false, available: false, reason: 'bridge_unavailable' }) }
  );
  await gutter.recompute('a.js');
  await gutter.recompute('a.js');
  assert.equal(gitClient.calls.length, 1, 'no-git result is cached, not retried each edit');
  assert.deepEqual(editorHost.calls[editorHost.calls.length - 1].decs, []);
});

test('recompute is a no-op when the requested path is no longer active', async () => {
  const { editorHost, gitClient, gutter } = setup(
    { activePath: 'a.js', value: 'x\n' },
    { 'b.js': headFound('y\n') }
  );
  await gutter.recompute('b.js');
  assert.equal(gitClient.calls.length, 0);
  assert.equal(editorHost.calls.length, 0);
});

// ── Factory: debounce + event lifecycle ──

test('schedule debounces: a re-schedule clears the prior timer', () => {
  const editorHost = makeEditorHost({ activePath: 'a.js' });
  const windowRef = makeWindow(editorHost);
  let sets = 0;
  let clears = 0;
  const gutter = createIdeGutterDecorations({
    editorHost,
    windowRef,
    gitClient: makeGitClient({}),
    clientUtils: {},
    setTimeoutFn: () => { sets += 1; return sets; },
    clearTimeoutFn: () => { clears += 1; },
  });
  gutter.schedule('a.js');
  gutter.schedule('a.js');
  assert.equal(sets, 2);
  assert.equal(clears, 1);
  gutter.dispose();
});

test('schedule honors maxWait: the debounce delay shrinks as the window drains and forces a run past it', () => {
  const editorHost = makeEditorHost({ activePath: 'a.js' });
  const windowRef = makeWindow(editorHost);
  const delays = [];
  let nowVal = 1000;
  const gutter = createIdeGutterDecorations({
    editorHost,
    windowRef,
    gitClient: makeGitClient({}),
    clientUtils: {},
    debounceMs: 200,
    maxWaitMs: 2000,
    nowFn: () => nowVal,
    setTimeoutFn: (_cb, delay) => { delays.push(delay); return delays.length; },
    clearTimeoutFn: () => {},
  });
  gutter.schedule('a.js');                 // elapsed 0 → full debounce
  assert.equal(delays[0], 200);
  nowVal = 2900;                           // elapsed 1900 → only 100 of the window left
  gutter.schedule('a.js');
  assert.equal(delays[1], 100, 'delay is capped to the remaining maxWait window');
  nowVal = 3100;                           // elapsed 2100 ≥ maxWait → fire immediately
  gutter.schedule('a.js');
  assert.equal(delays[2], 0, 'past the window the recompute is forced now');
  gutter.dispose();
});

test('the maxWait window resets after the timer fires so the next burst gets a full debounce', () => {
  const editorHost = makeEditorHost({ activePath: 'a.js' });
  const windowRef = makeWindow(editorHost);
  const delays = [];
  let nowVal = 1000;
  const gutter = createIdeGutterDecorations({
    editorHost,
    windowRef,
    gitClient: makeGitClient({}),
    clientUtils: {},
    debounceMs: 200,
    maxWaitMs: 2000,
    nowFn: () => nowVal,
    // Run the timer body synchronously so firstScheduledAt resets in-line.
    setTimeoutFn: (cb, delay) => { delays.push(delay); cb(); return delays.length; },
    clearTimeoutFn: () => {},
  });
  gutter.schedule('a.js');                 // fires → window resets
  nowVal = 9000;                           // far past the old window start
  gutter.schedule('a.js');
  assert.equal(delays[delays.length - 1], 200, 'a fresh burst starts a new full debounce window');
  gutter.dispose();
});

test('the ide:active-file-changed event schedules a recompute and dispose detaches it', () => {
  const editorHost = makeEditorHost({ activePath: 'a.js' });
  const windowRef = makeWindow(editorHost);
  let sets = 0;
  const gutter = createIdeGutterDecorations({
    editorHost,
    windowRef,
    gitClient: makeGitClient({}),
    clientUtils: {},
    setTimeoutFn: () => { sets += 1; return sets; },
    clearTimeoutFn: () => {},
  });
  assert.equal(windowRef.listenerCount('ide:active-file-changed'), 1);
  windowRef.dispatch('ide:active-file-changed', { path: 'a.js' });
  assert.equal(sets, 1);
  gutter.dispose();
  assert.equal(windowRef.listenerCount('ide:active-file-changed'), 0);
  windowRef.dispatch('ide:active-file-changed', { path: 'a.js' });
  assert.equal(sets, 1, 'no scheduling after dispose');
});
