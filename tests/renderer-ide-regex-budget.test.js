'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createIdeReplaceController } = require('../renderer/features/renderer-ide-replace-controller');
const { createRegexWorkerEvaluator } = require('../renderer/features/renderer-ide-regex-worker-client');
const { evaluateRegexTask } = require('../renderer/features/renderer-ide-regex-worker');

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.terminateCalls = 0;
  }

  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminateCalls += 1; return Promise.resolve(0); }
}

function timeoutError() {
  const error = new Error('regex deadline exceeded');
  error.code = 'REGEX_TIMEOUT';
  return error;
}

function createFindController({ evaluator, content = 'aaa', now, loadRegexClientModule } = {}) {
  const search = { query: '', results: [], busy: false };
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getWorkspaceFsApi: () => ({
      listAllFiles: async () => ({ files: ['a.txt'], truncated: false }),
      readFile: async () => ({ content }),
    }),
    regexFindEvaluator: evaluator,
    loadRegexClientModule,
    now,
    callbacks: { renderSearchPanel: () => {} },
  });
  return { controller, search };
}

test('regex find routes nested-quantifier evaluation through the isolated evaluator', async (t) => {
  const calls = [];
  const evaluator = {
    async evaluate(task, options) {
      calls.push({ task, options });
      return {
        results: [{
          path: task.path,
          line: 1,
          column: 1,
          preview: { text: 'aaa', matchStart: 0, matchEnd: 3 },
        }],
        matched: true,
      };
    },
    cancel() {},
    dispose() {},
  };
  const { controller } = createFindController({ evaluator, content: 'aaa' });
  t.after(() => controller.dispose());

  const result = await controller.runRegexFind({ query: '(a+)+$', caseSensitive: false });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].task.op, 'find');
  assert.equal(calls[0].task.query, '(a+)+$');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(result.results.length, 1);
});

test('per-file regex deadline returns explicit partial metadata and a specific UI error', async (t) => {
  const evaluator = {
    async evaluate() { throw timeoutError(); },
    cancel() {},
    dispose() {},
  };
  const { controller, search } = createFindController({ evaluator });
  t.after(() => controller.dispose());

  const result = await controller.runRegexFind({ query: '(a+)+$', caseSensitive: false });

  assert.equal(result.partial, true);
  assert.equal(result.reason, 'regex_timeout');
  assert.equal(result.limitHit, true);
  assert.match(search.error, /timed out/i);
  assert.deepEqual(search.results, []);
});

test('overlapping first-load finds share the evaluator created after the module await', async (t) => {
  const loadStarted = deferred();
  const moduleReady = deferred();
  let factoryCalls = 0;
  const evaluator = {
    async evaluate(task, { signal }) {
      if (signal.aborted) {
        const error = new Error('cancelled');
        error.code = 'REGEX_CANCELLED';
        throw error;
      }
      return { results: [], matched: task.path === 'a.txt' };
    },
    cancel() {},
    dispose() {},
  };
  const { controller } = createFindController({
    loadRegexClientModule: () => {
      loadStarted.resolve();
      return moduleReady.promise;
    },
  });
  t.after(() => controller.dispose());

  const first = controller.runRegexFind({ query: 'a+', caseSensitive: false });
  await loadStarted.promise;
  const second = controller.runRegexFind({ query: 'aa+', caseSensitive: false });
  moduleReady.resolve({
    createRegexWorkerEvaluator() {
      factoryCalls += 1;
      return evaluator;
    },
  });

  const [stale, current] = await Promise.all([first, second]);
  assert.deepEqual(stale, { results: [], fileCount: 0, limitHit: false });
  assert.equal(current.fileCount, 1);
  assert.equal(factoryCalls, 1);
});

test('aggregate regex deadline stops before evaluating another file', async (t) => {
  let nowValue = 0;
  const calls = [];
  const evaluator = {
    async evaluate(task) {
      calls.push(task.path);
      nowValue = 10_000;
      return { results: [], matched: false };
    },
    cancel() {},
    dispose() {},
  };
  const search = { query: '', results: [], busy: false };
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getWorkspaceFsApi: () => ({
      listAllFiles: async () => ({ files: ['a.txt', 'b.txt'] }),
      readFile: async ({ path }) => ({ content: path }),
    }),
    regexFindEvaluator: evaluator,
    now: () => nowValue,
    callbacks: { renderSearchPanel: () => {} },
  });
  t.after(() => controller.dispose());

  const result = await controller.runRegexFind({ query: 'a', caseSensitive: false });

  assert.deepEqual(calls, ['a.txt']);
  assert.equal(result.partial, true);
  assert.equal(result.reason, 'regex_budget');
  assert.equal(search.limitHit, true);
});

test('regex replace timeout fails closed before any file write', async (t) => {
  const writes = [];
  const search = { query: '(a+)+$', results: [{ path: 'a.txt' }], busy: false };
  const evaluator = {
    async evaluate() { throw timeoutError(); },
    cancel() {},
    dispose() {},
  };
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getWorkspaceFsApi: () => ({
      readFile: async () => ({ content: 'aaa', mtimeMs: 1 }),
      writeFile: async (payload) => { writes.push(payload); return { mtimeMs: 2 }; },
    }),
    regexReplaceEvaluator: evaluator,
    callbacks: { renderSearchPanel: () => {}, requestFindRefresh: () => {} },
  });
  t.after(() => controller.dispose());

  const result = await controller.replaceInFile('a.txt', {
    query: '(a+)+$',
    replaceText: 'x',
    useRegex: true,
  });

  assert.equal(result.error, 'regex_timeout');
  assert.deepEqual(writes, []);
  assert.match(search.replaceError, /timed out/i);
});

test('worker client deadline is timer-driven, typed, and terminates the stuck worker', async (t) => {
  const worker = new FakeWorker();
  let timer = null;
  const evaluator = createRegexWorkerEvaluator({
    createWorker: () => worker,
    setTimeoutImpl: (callback, ms) => { timer = { callback, ms }; return 1; },
    clearTimeoutImpl: () => {},
  });
  t.after(() => evaluator.dispose());

  const pending = evaluator.evaluate({ op: 'find', text: 'aaaaX', query: '(a+)+$' }, {
    deadlineMs: 321,
  });
  assert.equal(timer.ms, 321);
  timer.callback();

  await assert.rejects(pending, (error) => error?.code === 'REGEX_TIMEOUT');
  assert.equal(worker.terminateCalls, 1);
});

test('worker client rejects a clean exit that arrives before a response', async (t) => {
  const worker = new FakeWorker();
  const evaluator = createRegexWorkerEvaluator({
    createWorker: () => worker,
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
  });
  t.after(() => evaluator.dispose());

  const pending = evaluator.evaluate({ op: 'find', text: 'a', query: 'a' });
  worker.emit('exit', 0);

  await assert.rejects(pending, (error) => error?.code === 'REGEX_WORKER_FAILED');
  assert.equal(worker.terminateCalls, 1);
});

test('late failure from a terminated worker cannot reject the replacement worker request', async (t) => {
  const firstWorker = new FakeWorker();
  const secondWorker = new FakeWorker();
  const workers = [firstWorker, secondWorker];
  const timers = new Map();
  let nextTimerId = 1;
  const evaluator = createRegexWorkerEvaluator({
    createWorker: () => workers.shift(),
    setTimeoutImpl: (callback) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeoutImpl: (id) => timers.delete(id),
  });
  t.after(() => evaluator.dispose());

  const first = evaluator.evaluate({ op: 'find', text: 'aaaaX', query: '(a+)+$' }, {
    deadlineMs: 100,
  });
  timers.get(1)();
  await assert.rejects(first, (error) => error?.code === 'REGEX_TIMEOUT');

  let secondSettled = false;
  const second = evaluator.evaluate({ op: 'find', text: 'b', query: 'b' });
  second.finally(() => { secondSettled = true; });
  firstWorker.emit('error', new Error('late old-worker error'));
  firstWorker.emit('exit', 1);
  await Promise.resolve();
  assert.equal(secondSettled, false);

  secondWorker.emit('message', { id: 2, ok: true, result: { results: [], matched: true } });
  assert.deepEqual(await second, { results: [], matched: true });
  assert.equal(secondWorker.terminateCalls, 0);
});

test('root reset aborts a pending worker evaluation and blocks stale result publication', async (t) => {
  const started = deferred();
  let observedSignal = null;
  const evaluator = {
    evaluate(_task, { signal }) {
      observedSignal = signal;
      started.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.code = 'REGEX_CANCELLED';
          reject(error);
        }, { once: true });
      });
    },
    cancel() {},
    dispose() {},
  };
  const { controller, search } = createFindController({ evaluator });
  t.after(() => controller.dispose());

  const pending = controller.runRegexFind({ query: 'a+', caseSensitive: false });
  await started.promise;
  controller.resetForRoot();
  const result = await pending;

  assert.equal(observedSignal.aborted, true);
  assert.deepEqual(result, { results: [], fileCount: 0, limitHit: false });
  assert.deepEqual(search.results, []);
});

test('JCA-010: non-ASCII content is charged at its encoded size and refused when over budget', async (t) => {
  // ~3.1M UTF-16 code units (well under the 8 MiB budget by the old count)
  // but ~9.4M encoded bytes (over it): the file must never reach the worker.
  const calls = [];
  const evaluator = {
    async evaluate(task) { calls.push(task.path); return { results: [], matched: false }; },
    cancel() {},
    dispose() {},
  };
  const search = { query: '', results: [], busy: false };
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getWorkspaceFsApi: () => ({
      listAllFiles: async () => ({ files: ['euro.txt'] }),
      readFile: async () => ({ content: '€'.repeat(3 * 1024 * 1024) }),
    }),
    regexFindEvaluator: evaluator,
    callbacks: { renderSearchPanel: () => {} },
  });
  t.after(() => controller.dispose());

  const result = await controller.runRegexFind({ query: 'x', caseSensitive: false });

  assert.deepEqual(calls, [], 'the encoded-over-budget file never reaches the regex worker');
  assert.equal(result.partial, true);
  assert.equal(result.reason, 'regex_budget');
  assert.equal(search.limitHit, true);
});

test('JCA-010: a file crossing the remaining byte allowance is refused before evaluation', async (t) => {
  // 5 MiB fits; the next 4 MiB file would cross the 8 MiB aggregate budget and
  // used to be evaluated anyway ("check before read, evaluate regardless").
  const calls = [];
  const evaluator = {
    async evaluate(task) { calls.push(task.path); return { results: [], matched: false }; },
    cancel() {},
    dispose() {},
  };
  const search = { query: '', results: [], busy: false };
  const controller = createIdeReplaceController({
    getIde: () => ({ search }),
    getWorkspaceFsApi: () => ({
      listAllFiles: async () => ({ files: ['a.txt', 'b.txt'] }),
      readFile: async ({ path }) => ({
        content: 'a'.repeat(path === 'a.txt' ? 5 * 1024 * 1024 : 4 * 1024 * 1024),
      }),
    }),
    regexFindEvaluator: evaluator,
    callbacks: { renderSearchPanel: () => {} },
  });
  t.after(() => controller.dispose());

  const result = await controller.runRegexFind({ query: 'zzz', caseSensitive: false });

  assert.deepEqual(calls, ['a.txt'], 'only the in-budget file is evaluated; the crossing remainder is refused');
  assert.equal(result.partial, true);
  assert.equal(result.reason, 'regex_budget');
});

test('worker task preserves valid lookbehind and capture-group replacement semantics', () => {
  const found = evaluateRegexTask({
    op: 'find',
    path: 'a.txt',
    text: 'foobar',
    query: '(?<=foo)bar',
    caseSensitive: true,
  });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].column, 4);

  const replaced = evaluateRegexTask({
    op: 'replaceAll',
    rawText: 'a=1\nb=2\n',
    query: '([a-z])=(\\d)',
    replaceText: '$2:$1',
    caseSensitive: true,
  });
  assert.equal(replaced.newRaw, '1:a\n2:b\n');
  assert.equal(replaced.count, 2);
});
