'use strict';

/* Row 82 slice R2: task problem matchers. Run output lines (tsc, eslint stylish, pytest,
 * Python tracebacks, node stacks) become Monaco markers with owner `task` on open models
 * and a side list for closed files; the same script's next run clears them. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeTimers } = require('./helpers/fake-timers');

const taskProblems = require('../renderer/features/renderer-ide-task-problems');
const { createIdeRunScripts } = require('../renderer/features/renderer-ide-run-scripts');

const ROOT = { rootPath: 'C:/ws' };

function fakeHost(openPaths = []) {
  const modelOf = (path) => { const m = { path, disposed: false, getLineCount: () => 100, getLineMaxColumn: () => 40 }; m.isDisposed = () => m.disposed; return m; };
  const models = new Map(openPaths.map((path) => [path, modelOf(path)]));
  const sets = [];
  const listeners = { create: [], dispose: [] };
  const monaco = {
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    editor: {
      setModelMarkers(model, owner, markers) { sets.push({ path: model.path, owner, markers }); },
      onDidCreateModel(cb) { listeners.create.push(cb); return { dispose() {} }; },
      onWillDisposeModel(cb) { listeners.dispose.push(cb); return { dispose() {} }; },
    },
  };
  return {
    sets,
    models,
    open(path) { models.set(path, modelOf(path)); listeners.create.forEach((cb) => cb()); },
    // Monaco passes the model to onWillDisposeModel; after it the model reports disposed.
    close(path) { const model = models.get(path); listeners.dispose.forEach((cb) => cb(model)); if (model) model.disposed = true; models.delete(path); },
    host: {
      getModel: (path) => models.get(path) || null,
      getMonaco: () => monaco,
    },
  };
}

function lastSetFor(sets, path) {
  return sets.filter((entry) => entry.path === path).pop() || null;
}

function make(openPaths) {
  const fake = fakeHost(openPaths);
  const timers = createFakeTimers();
  const problems = taskProblems.createIdeTaskProblems({ editorHost: fake.host, schedule: (fn) => timers.setTimeout(fn, 0) });
  const flushQueue = () => { while (timers.pending()) timers.runPending(); };
  return { ...fake, problems, flushQueue };
}

test('a tsc line becomes one task marker at its line and column on the open model', () => {
  const { host, sets } = fakeHost(['src/a.ts']);
  const problems = taskProblems.createIdeTaskProblems({ editorHost: host, schedule: (fn) => fn() });
  problems.beginRun('npm run build', { rootPath: 'C:/ws' });
  problems.push("src/a.ts(12,5): error TS2322: Type 'x' is not assignable to type 'y'.\n");
  problems.endRun();
  const set = lastSetFor(sets, 'src/a.ts');
  assert.ok(set, 'markers were set on the open model');
  assert.equal(set.owner, 'task');
  assert.equal(set.markers.length, 1);
  const [marker] = set.markers;
  assert.equal(marker.startLineNumber, 12);
  assert.equal(marker.startColumn, 5);
  assert.equal(marker.severity, 8);
  assert.equal(marker.code, 'TS2322');
  assert.match(marker.message, /^Type 'x' is not assignable/);
  assert.deepEqual(problems.getMarkers(), [], 'an open file is not repeated in the side list');
});

test('listeners hear only real changes: tab open/close with no task problems never refreshes Problems', () => {
  const fake = make(['src/a.ts']);
  let heard = 0;
  fake.problems.onChange(() => { heard += 1; });
  fake.problems.clearAll(); // root switch with nothing listed: no change
  fake.flushQueue();
  fake.open('src/b.ts');
  fake.close('src/b.ts');
  fake.flushQueue();
  assert.equal(heard, 0, 'no problems, no notifications');
  fake.problems.beginRun('build', ROOT);
  fake.problems.push('src/c.ts(1,1): error TS1: x\n');
  fake.flushQueue();
  assert.equal(heard, 1, 'a new problem notifies once');
  fake.open('src/c.ts');
  fake.flushQueue();
  assert.equal(heard, 2, 'the closed-file entry moving onto its open model notifies');
  fake.open('src/d.ts');
  fake.flushQueue();
  assert.equal(heard, 2, 'an unrelated tab open does not');
});

test('a run keeps at most 1,000 problems; later output is dropped', () => {
  const fake = make([]);
  fake.problems.beginRun('build', ROOT);
  const lines = [];
  for (let i = 1; i <= 1005; i += 1) lines.push(`src/a.ts(${i},1): error TS1: e${i}`);
  fake.problems.push(`${lines.join('\n')}\n`);
  fake.problems.endRun();
  assert.equal(fake.problems.getMarkers().length, 1000);
});

test('tsc pretty output, warnings and absolute paths inside the root parse; paths outside it never do', () => {
  const found = taskProblems.parseLines([
    'src/b.ts:3:9 - error TS2304: Cannot find name \'foo\'.',
    'C:\\ws\\src\\c.ts(7,1): warning TS6133: \'x\' is declared but never used.',
    'D:\\elsewhere\\d.ts(1,1): error TS1005: \';\' expected.',
    '../outside.ts(1,1): error TS1005: \';\' expected.',
    'Found 3 errors in 2 files.',
  ], ROOT);
  assert.deepEqual(found.map((p) => [p.path, p.line, p.column, p.severity, p.code, p.source]), [
    ['src/b.ts', 3, 9, 'error', 'TS2304', 'tsc'],
    ['src/c.ts', 7, 1, 'warning', 'TS6133', 'tsc'],
  ]);
});

test('eslint stylish: the file header carries to its rows, the rule id becomes the code', () => {
  const found = taskProblems.parseLines([
    '',
    'C:\\ws\\src\\app.js',
    '   3:10  error    \'unused\' is defined but never used  no-unused-vars',
    '  12:1   warning  Unexpected console statement        no-console',
    '  14:5   error    Parsing error: Unexpected token',
    '',
    'C:\\ws\\lib\\util.js',
    '  1:1  error  Missing "use strict" statement  strict',
    '',
    '\u2716 4 problems (3 errors, 1 warning)',
    '  2:2  error  orphan row after the summary  no-undef',
  ], ROOT);
  assert.deepEqual(found.map((p) => [p.path, p.line, p.column, p.severity, p.code, p.message]), [
    ['src/app.js', 3, 10, 'error', 'no-unused-vars', '\'unused\' is defined but never used'],
    ['src/app.js', 12, 1, 'warning', 'no-console', 'Unexpected console statement'],
    ['src/app.js', 14, 5, 'error', '', 'Parsing error: Unexpected token'],
    ['lib/util.js', 1, 1, 'error', 'strict', 'Missing "use strict" statement'],
  ]);
});

test('pytest: path:line: Error lines pick up the first E line; summary lines without a line number are skipped', () => {
  const found = taskProblems.parseLines([
    '    def test_add():',
    '>       assert add(1, 1) == 3',
    'E       assert 2 == 3',
    'E        +  where 2 = add(1, 1)',
    '',
    'tests/test_math.py:8: AssertionError',
    'FAILED tests/test_math.py::test_add - assert 2 == 3',
  ], ROOT);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].path, found[0].line, found[0].source, found[0].message],
    ['tests/test_math.py', 8, 'pytest', 'AssertionError: assert 2 == 3']);
});

test('a Python traceback lands on its deepest in-root frame with the exception line', () => {
  const found = taskProblems.parseLines([
    'Traceback (most recent call last):',
    '  File "C:\\ws\\app\\main.py", line 20, in <module>',
    '    run()',
    '  File "C:\\ws\\app\\jobs.py", line 7, in run',
    '    load()',
    '  File "C:\\ws\\.venv\\Lib\\site-packages\\lib\\core.py", line 99, in load',
    '    raise ValueError("bad")',
    '  File "C:\\Python312\\Lib\\json\\decoder.py", line 3, in decode',
    'ValueError: bad input',
  ], ROOT);
  assert.deepEqual(found.map((p) => [p.path, p.line, p.source, p.message]), [['app/jobs.py', 7, 'python', 'ValueError: bad input']]);
});

test('a node stack lands on its first in-root frame, skipping node: internals and node_modules', () => {
  const found = taskProblems.parseLines([
    'TypeError: Cannot read properties of undefined (reading \'x\')',
    '    at Object.<anonymous> (node:internal/modules/cjs/loader:1105:14)',
    '    at load (C:\\ws\\node_modules\\dep\\index.js:4:2)',
    '    at main (C:\\ws\\src\\server.js:42:13)',
    '    at start (C:\\ws\\src\\boot.js:3:1)',
    'Error: plain',
    '    at file:///C:/ws/src/esm.mjs:5:7',
  ], ROOT);
  assert.deepEqual(found.map((p) => [p.path, p.line, p.column, p.source, p.message]), [
    ['src/server.js', 42, 13, 'node', 'TypeError: Cannot read properties of undefined (reading \'x\')'],
    ['src/esm.mjs', 5, 7, 'node', 'Error: plain'],
  ]);
});

test('matchers are linear: 60 adversarial 4000-character lines parse in under 50 ms', () => {
  const shapes = [
    'a'.repeat(4000),
    'src/'.repeat(1000),
    ' '.repeat(3990) + '1:1 error',
    '  1:1  error  ' + 'x  '.repeat(1328),
    'E'.repeat(3995) + 'rror',
    'File "' + 'a'.repeat(3990),
    '(' + '1,'.repeat(1999),
    'a.ts' + ':1'.repeat(1998),
  ].map((line) => line.slice(0, 4000));
  const lines = [];
  for (let i = 0; i < 60; i += 1) lines.push(shapes[i % shapes.length]);
  lines.splice(0, 0, 'C:\\ws\\src\\app.js'); // an eslint header first, so the detail matcher runs too
  taskProblems.parseLines(lines, ROOT); // warm up the regex engine
  const started = process.hrtime.bigint();
  taskProblems.parseLines(lines, ROOT);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 50, `parsed in ${ms.toFixed(1)} ms`);
});

test('closed files sit in the side list and move to Monaco markers when opened, and back when closed', () => {
  const h = make([]);
  h.problems.beginRun('npm run lint', ROOT);
  h.problems.push('src/a.ts(1,2): error TS1: one\nsrc/b.ts(3');
  h.problems.push(',4): error TS2: two\n'); // a line split across chunks
  h.flushQueue();
  assert.deepEqual(h.problems.getMarkers().map((p) => [p.path, p.line, p.column]), [['src/a.ts', 1, 2], ['src/b.ts', 3, 4]]);
  assert.equal(h.sets.length, 0, 'no model is open');

  h.open('src/a.ts');
  h.flushQueue();
  assert.equal(lastSetFor(h.sets, 'src/a.ts').markers.length, 1);
  assert.deepEqual(h.problems.getMarkers().map((p) => p.path), ['src/b.ts']);

  h.close('src/a.ts');
  assert.deepEqual(lastSetFor(h.sets, 'src/a.ts').markers, [], 'cleared while the model is alive: Monaco keeps the markers of a disposed model');
  h.flushQueue();
  assert.deepEqual(h.problems.getMarkers().map((p) => p.path).sort(), ['src/a.ts', 'src/b.ts']);
});

test('the next run of the same script clears its problems; another script keeps its own; clearAll empties both', () => {
  const h = make(['src/a.ts']);
  const changes = [];
  h.problems.onChange(() => changes.push(1));
  h.problems.beginRun('npm run build', ROOT);
  h.problems.push('src/a.ts(1,1): error TS1: build\n');
  h.problems.endRun();
  h.problems.beginRun('npm run lint', ROOT);
  h.problems.push('src/z.ts(2,2): error TS2: lint\n');
  h.problems.endRun();
  assert.equal(lastSetFor(h.sets, 'src/a.ts').markers.length, 1);

  h.problems.beginRun('npm run build', ROOT);
  h.flushQueue();
  assert.deepEqual(lastSetFor(h.sets, 'src/a.ts').markers, [], 'the open model is cleared at the next build');
  assert.deepEqual(h.problems.getMarkers().map((p) => p.path), ['src/z.ts'], 'lint problems stay');
  h.problems.endRun();
  h.problems.clearAll();
  assert.deepEqual(h.problems.getMarkers(), []);
  assert.ok(changes.length > 0, 'listeners hear every change');
});

test('duplicates collapse and a run caps its problem count', () => {
  const h = make([]);
  h.problems.beginRun('t', ROOT);
  h.problems.push('src/a.ts(1,1): error TS1: same\nsrc/a.ts(1,1): error TS1: same\n');
  h.problems.endRun();
  assert.equal(h.problems.getMarkers().length, 1);
  h.problems.beginRun('t', ROOT);
  let text = '';
  for (let i = 1; i <= 1200; i += 1) text += `src/a.ts(${i},1): error TS1: n${i}\n`;
  h.problems.push(text);
  h.problems.endRun();
  assert.equal(h.problems.getMarkers().length, 1000);
});

test('run-scripts feeds its output to the matchers and the same script\'s rerun clears them', async () => {
  const listeners = { data: [], exit: [] };
  let counter = 0;
  const api = {
    onData(fn) { listeners.data.push(fn); return () => {}; },
    onExit(fn) { listeners.exit.push(fn); return () => {}; },
    async start() { counter += 1; return { ok: true, taskId: `run-${counter}`, cwd: 'C:/ws' }; },
    async kill() { return { killed: true, terminationConfirmed: true }; },
  };
  const emit = (kind, payload) => listeners[kind].forEach((fn) => fn(payload));
  const fake = fakeHost([]);
  const engine = createIdeRunScripts({
    editorHost: { ...fake.host, getActivePath: () => '', focus() {}, addEditorAction: () => ({ dispose() {} }) },
    getWorkspaceRunTaskApi: () => api,
    getWorkspaceFsApi: () => null,
    platform: 'linux',
  });
  const tasks = engine.getTaskProblems();
  assert.ok(tasks, 'the engine owns a task-problem collector');
  await engine.runScript('build');
  emit('data', { taskId: 'run-1', chunk: '\u001b[31msrc/a.ts(12,5): error TS2322: Type \'x\'\u001b[0m\n' });
  emit('exit', { taskId: 'run-1', code: 2, status: 'exited' });
  assert.deepEqual(tasks.getMarkers().map((p) => [p.path, p.line, p.column, p.code]), [['src/a.ts', 12, 5, 'TS2322']]);

  await engine.runScript('build');
  assert.deepEqual(tasks.getMarkers(), [], 'a rerun of the same script clears its problems');
  emit('exit', { taskId: 'run-2', code: 0, status: 'exited' });
  engine.dispose();
});

/* ---- Cleanup wave (row 82 deferred T8, T11, T13) ----------------------------- */

// A fresh task-problems module whose file-link detector counts findLinks calls.
function countedParser(options) {
  const detectPath = require.resolve('../renderer/shared/file-link-detect.js');
  const taskPath = require.resolve('../renderer/features/renderer-ide-task-problems');
  const real = require(detectPath);
  const counter = { calls: 0 };
  const saved = require.cache[detectPath].exports;
  require.cache[detectPath].exports = { ...real, findLinks: (...args) => { counter.calls += 1; return real.findLinks(...args); } };
  delete require.cache[taskPath];
  try {
    const fresh = require(taskPath);
    return { parser: fresh.createLineParser(options), counter };
  } finally {
    require.cache[detectPath].exports = saved;
    delete require.cache[taskPath];
  }
}

test('T8: one findLinks call per line, shared by the leading-link and eslint-header matchers', () => {
  const { parser, counter } = countedParser(ROOT);
  const lines = [
    'C:\\ws\\src\\app.js',
    '   3:10  error    \'unused\' is defined but never used  no-unused-vars',
    '',
    'src/b.ts(3,4): error TS2304: Cannot find name \'x\'.',
    'note: something happened (see above)',
    'C:/ws/lib/util.js',
  ];
  for (const text of lines) {
    const before = counter.calls;
    parser.line(text);
    assert.ok(counter.calls - before <= 1, `at most one findLinks call for ${JSON.stringify(text)} (got ${counter.calls - before})`);
  }
});

test('T13: an eslint file header with a space in its path is matched inside the root', () => {
  const found = taskProblems.parseLines([
    'C:\\ws\\src\\my file.ts',
    '  2:3  error  \'x\' is not defined  no-undef',
    '',
    'C:\\elsewhere\\other file.ts',
    '  4:1  error  outside the root  no-undef',
  ], ROOT);
  assert.deepEqual(found.map((p) => [p.path, p.line, p.column, p.code]), [['src/my file.ts', 2, 3, 'no-undef']]);
});

test('T11: a failed run start clears the script\'s previous problems', async () => {
  const listeners = { data: [], exit: [] };
  let counter = 0;
  let failNext = false;
  const api = {
    onData(fn) { listeners.data.push(fn); return () => {}; },
    onExit(fn) { listeners.exit.push(fn); return () => {}; },
    async start() {
      counter += 1;
      if (failNext) return { ok: false, message: 'spawn failed' };
      return { ok: true, taskId: `run-${counter}`, cwd: 'C:/ws' };
    },
    async kill() { return { killed: true, terminationConfirmed: true }; },
  };
  const emit = (kind, payload) => listeners[kind].forEach((fn) => fn(payload));
  const fake = fakeHost([]);
  const engine = createIdeRunScripts({
    editorHost: { ...fake.host, getActivePath: () => '', focus() {}, addEditorAction: () => ({ dispose() {} }) },
    getWorkspaceRunTaskApi: () => api,
    getWorkspaceFsApi: () => null,
    platform: 'linux',
    toast: () => {},
  });
  const tasks = engine.getTaskProblems();
  await engine.runScript('build');
  emit('data', { taskId: 'run-1', chunk: 'src/a.ts(12,5): error TS2322: Type \'x\'\n' });
  emit('exit', { taskId: 'run-1', code: 2, status: 'exited' });
  assert.equal(tasks.getMarkers().length, 1);

  failNext = true;
  await engine.runScript('build');
  assert.deepEqual(tasks.getMarkers(), [], 'the failed start leaves no stale problems from the last run');
  engine.dispose();
});
