const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRendererErrorLogSink,
  createRendererGlobalErrorBoundary,
  isBenignCancellationRejection,
  isHandledMonacoGlobalError,
  isKnownBenignGlobalError,
  normalizeGlobalErrorPayload,
} = require('../renderer/shell/renderer-lifecycle-error-utils');

function createFakeWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) {
        listeners.delete(type);
      }
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

test('lifecycle error utils normalize uncaught errors and promise rejections', () => {
  const error = new Error('boom');
  error.stack = 'stack-line';

  assert.deepEqual(normalizeGlobalErrorPayload('error', {
    message: 'Uncaught [object Event]',
    error,
    filename: 'renderer/app.js',
    lineno: 12,
    colno: 3,
  }), {
    category: 'uncaught_error',
    message: 'boom',
    stack: 'stack-line',
    file: 'renderer/app.js',
    line: 12,
    column: 3,
    error_code: 'CMP-RENDER-0001',
    retryable: true,
  });
  assert.equal(
    normalizeGlobalErrorPayload('unhandledrejection', { reason: new Error('async boom') }).error_code,
    'CMP-RENDER-0002'
  );
});

test('lifecycle error utils surface the real reason from a PromiseRejectionEvent prototype accessor', () => {
  // Reproduce the real DOM event shape: `reason` lives on the prototype, so
  // hasOwnProperty('reason') is false and String(event) is the useless
  // "[object PromiseRejectionEvent]". The fix must still recover the reason.
  const realError = new Error('mermaid runtime failed to load');
  realError.stack = 'mermaid-stack';
  const eventProto = { get reason() { return realError; } };
  eventProto[Symbol.toStringTag] = 'PromiseRejectionEvent';
  const errorEvent = Object.create(eventProto);
  assert.equal(Object.prototype.hasOwnProperty.call(errorEvent, 'reason'), false);
  assert.equal(String(errorEvent), '[object PromiseRejectionEvent]');

  const errorPayload = normalizeGlobalErrorPayload('unhandledrejection', errorEvent);
  assert.equal(errorPayload.error_code, 'CMP-RENDER-0002');
  assert.equal(errorPayload.message, 'mermaid runtime failed to load');
  assert.equal(errorPayload.stack, 'mermaid-stack');
  assert.notEqual(errorPayload.message, '[object PromiseRejectionEvent]');

  // A string reason (e.g. a bare throw) must come through verbatim, not as a tag.
  const stringProto = { get reason() { return 'bare string rejection'; } };
  stringProto[Symbol.toStringTag] = 'PromiseRejectionEvent';
  assert.equal(
    normalizeGlobalErrorPayload('unhandledrejection', Object.create(stringProto)).message,
    'bare string rejection'
  );
});

test('lifecycle error utils classify Monaco loader and benign resize observer noise', () => {
  assert.equal(isHandledMonacoGlobalError('error', {
    message: 'Uncaught [object Event]',
    filename: 'file:///node_modules/monaco-editor/min/vs/editor/editor.main.js',
  }), true);
  assert.equal(isHandledMonacoGlobalError('error', {
    message: 'Uncaught [object Event]',
    filename: 'file:///node_modules/monaco-editor/min/vs/editor/editor.main.js',
    error: new Error('real failure'),
  }), false);
  assert.equal(isKnownBenignGlobalError('error', {
    message: 'ResizeObserver loop completed with undelivered notifications.',
  }), true);
});

test('lifecycle error utils classify Monaco cancellation rejections as benign', () => {
  const canceled = new Error('Canceled');
  canceled.name = 'Canceled';
  assert.equal(isBenignCancellationRejection('unhandledrejection', { reason: canceled }), true);
  // Both fields must match the Monaco CancellationError signature.
  const namedOnly = new Error('worker request failed');
  namedOnly.name = 'Canceled';
  assert.equal(isBenignCancellationRejection('unhandledrejection', { reason: namedOnly }), false);
  assert.equal(isBenignCancellationRejection('unhandledrejection', { reason: new Error('Canceled') }), false);
  assert.equal(isBenignCancellationRejection('unhandledrejection', { reason: 'Canceled' }), false);
  assert.equal(isBenignCancellationRejection('error', { reason: canceled }), false);
});

test('lifecycle error boundary swallows Monaco cancellation rejections without logging', () => {
  const fakeWindow = createFakeWindow();
  const logs = [];
  const toasts = [];
  let prevented = 0;
  const boundary = createRendererGlobalErrorBoundary({
    window: fakeWindow,
    appendClientLog(level, event, payload) {
      logs.push({ level, event, payload });
    },
    showToastMessage(message) {
      toasts.push(message);
    },
  });
  boundary.attach();

  const canceled = new Error('Canceled');
  canceled.name = 'Canceled';
  fakeWindow.dispatch('unhandledrejection', {
    reason: canceled,
    preventDefault() { prevented += 1; },
  });
  assert.equal(logs.length, 0);
  assert.equal(toasts.length, 0);
  assert.equal(prevented, 1);

  // A real rejection still flows through unchanged.
  fakeWindow.dispatch('unhandledrejection', {
    reason: new Error('actual failure'),
    preventDefault() { prevented += 1; },
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].payload.message, 'actual failure');
  assert.equal(prevented, 1);
  boundary.detach();
});

test('lifecycle error boundary attaches once, logs every report, dedupes toasts, and detaches', () => {
  const fakeWindow = createFakeWindow();
  const logs = [];
  const toasts = [];
  const reports = [];
  let now = 1000;
  const boundary = createRendererGlobalErrorBoundary({
    window: fakeWindow,
    appendClientLog(level, event, payload) {
      logs.push({ level, event, payload });
    },
    showToastMessage(message, options) {
      toasts.push({ message, options });
    },
    reportRendererError(payload) {
      reports.push(payload);
      return Promise.resolve();
    },
    getNow: () => now,
    toastSource: 'chat',
  });

  boundary.attach();
  boundary.attach();
  assert.equal(fakeWindow.listenerCount(), 2);
  fakeWindow.dispatch('error', { message: 'boom', filename: 'renderer/app.js', lineno: 1, colno: 2 });
  now += 10;
  fakeWindow.dispatch('error', { message: 'boom', filename: 'renderer/app.js', lineno: 1, colno: 2 });
  boundary.detach();
  assert.equal(fakeWindow.listenerCount(), 0);

  assert.equal(logs.length, 2);
  assert.equal(reports.length, 2);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].options.dedupeKey, /renderer-global-error:/);
});

test('lifecycle error boundary suppresses a repeated error storm and summarizes the elapsed window', () => {
  const logs = [];
  const reports = [];
  const originalDateNow = Date.now;
  let now = 1000;
  Date.now = () => now;

  try {
    const boundary = createRendererGlobalErrorBoundary({
      appendClientLog(level, event, payload) {
        logs.push({ level, event, payload });
      },
      reportRendererError(payload) {
        reports.push(payload);
      },
    });
    const report = () => boundary.reportRendererGlobalError('error', {
      message: 'storm',
      filename: 'renderer/app.js',
      lineno: 1,
      colno: 2,
    });

    for (let index = 0; index < 100; index += 1) {
      report();
      now += 10;
    }
    assert.equal(logs.filter((entry) => entry.event === 'renderer.global_error').length, 5);
    assert.equal(logs.filter((entry) => entry.event === 'renderer.error_suppressed').length, 0);
    assert.equal(reports.length, 5, 'suppressed reports are not forwarded');

    now += 61_000;
    report();
    assert.equal(logs.length, 7);
    assert.deepEqual(logs.at(-2), {
      level: 'ERROR',
      event: 'renderer.error_suppressed',
      payload: {
        dedupe_key: logs[0].payload.dedupe_key,
        suppressed_count: 95,
        window_ms: 60_000,
      },
    });
    assert.equal(logs.at(-1).event, 'renderer.global_error');
    assert.equal(reports.length, 6);
  } finally {
    Date.now = originalDateNow;
  }
});

test('lifecycle error boundary counts interleaved dedupe keys independently', () => {
  const logs = [];
  let now = 1000;
  const boundary = createRendererGlobalErrorBoundary({
    appendClientLog(level, event, payload) {
      logs.push({ level, event, payload });
    },
    getNow: () => now,
  });

  for (let index = 0; index < 10; index += 1) {
    boundary.reportRendererGlobalError('error', { message: 'alpha' });
    boundary.reportRendererGlobalError('error', { message: 'beta' });
  }
  const errorLogs = logs.filter((entry) => entry.event === 'renderer.global_error');
  assert.equal(errorLogs.filter((entry) => entry.payload.message === 'alpha').length, 5);
  assert.equal(errorLogs.filter((entry) => entry.payload.message === 'beta').length, 5);

  now += 61_000;
  boundary.reportRendererGlobalError('error', { message: 'gamma' });
  const summaries = logs.filter((entry) => entry.event === 'renderer.error_suppressed');
  assert.deepEqual(summaries.map((entry) => entry.payload.suppressed_count), [5, 5]);
});

test('renderer error log sink never dedupes reports without a dedupe key', () => {
  const logs = [];
  const reports = [];
  const sink = createRendererErrorLogSink({
    appendClientLog(level, event, payload) {
      logs.push({ level, event, payload });
    },
    reportRendererError(payload) {
      reports.push(payload);
    },
    getNow: () => 1000,
  });

  for (let index = 0; index < 100; index += 1) {
    sink.report({ message: 'missing key' });
  }
  assert.equal(logs.length, 100);
  assert.ok(logs.every((entry) => entry.event === 'renderer.global_error'));
  assert.equal(reports.length, 100);
});

test('lifecycle error boundary bounds oldest signatures and clears dedupe state on detach', () => {
  const fakeWindow = createFakeWindow();
  const toasts = [];
  const boundary = createRendererGlobalErrorBoundary({
    window: fakeWindow,
    appendClientLog() {},
    showToastMessage(_message, options) { toasts.push(options.dedupeKey); },
    getNow: () => 1000,
  });
  const dispatch = (message) => fakeWindow.dispatch('error', {
    message,
    filename: 'renderer/app.js',
    lineno: 1,
    colno: 2,
  });

  boundary.attach();
  dispatch('oldest');
  for (let index = 0; index < 70; index += 1) dispatch(`unique-${index}`);
  dispatch('oldest');
  assert.equal(toasts.length, 72, 'the oldest signature is evicted once the bounded cache fills');

  boundary.detach();
  boundary.attach();
  dispatch('unique-69');
  assert.equal(toasts.length, 73, 'detach clears signatures before a later reattach');
  boundary.detach();
});

test('lifecycle error boundary routes through intake when active and keeps noise filters local (EH-W9)', () => {
  const fakeWindow = createFakeWindow();
  const toasts = [];
  const routed = [];
  const boundary = createRendererGlobalErrorBoundary({
    window: fakeWindow,
    appendClientLog() {},
    showToastMessage(message, options) {
      toasts.push({ message, options });
    },
    reportError(input, context) {
      routed.push({ input, context });
      return { route: { ruleId: 9, surface: 'toast' }, toastId: 'toast_1' };
    },
    getNow: () => 1000,
    toastSource: 'chat',
  });
  boundary.attach();

  fakeWindow.dispatch('error', { message: 'boom', filename: 'renderer/app.js', lineno: 1, colno: 2 });
  assert.equal(toasts.length, 0, 'routed errors never hit the raw toast path');
  assert.equal(routed.length, 1);
  assert.equal(routed[0].context.origin, 'global-boundary');
  assert.equal(routed[0].input.error_code, 'CMP-RENDER-0001');
  assert.match(routed[0].input.options.dedupeKey, /renderer-global-error:/);

  // Benign noise is filtered before intake ever sees it.
  fakeWindow.dispatch('error', { message: 'ResizeObserver loop limit exceeded' });
  assert.equal(routed.length, 1);
  boundary.detach();
});

test('lifecycle error boundary falls back to the raw toast when the intake route declines (flag off)', () => {
  const fakeWindow = createFakeWindow();
  const toasts = [];
  const boundary = createRendererGlobalErrorBoundary({
    window: fakeWindow,
    appendClientLog() {},
    showToastMessage(message, options) {
      toasts.push({ message, options });
    },
    reportError: () => null,
    getNow: () => 1000,
    toastSource: 'chat',
  });
  boundary.attach();
  fakeWindow.dispatch('error', { message: 'boom', filename: 'renderer/app.js', lineno: 1, colno: 2 });
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].options.tone, 'warning');
  boundary.detach();
});
