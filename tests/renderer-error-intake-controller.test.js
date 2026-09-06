/**
 * EH-W8 gate: flag-gated intake controller
 * (renderer/shell/renderer-error-intake-controller.js) — sink dispatch
 * per origin, flag-off identity, chat-stream toast suppression — plus
 * the lifecycle-composition wiring and index.html load order.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createErrorIntakeController } = require('../renderer/shell/renderer-error-intake-controller');

const TOAST_SOURCE = {
  sessionAction: 'shell.session-action',
  composerAction: 'shell.composer-action',
  shellAction: 'shell.action',
  settings: 'shell.settings',
};

function createHarness({ enabled = true, sinks = {} } = {}) {
  const calls = {
    showToastMessage: [],
    showShellErrorToast: [],
    showSessionActionError: [],
    showComposerActionError: [],
    banner: [],
    recorded: [],
    routed: [],
  };
  const controller = createErrorIntakeController({
    isEnabled: () => enabled,
    constants: { TOAST_SOURCE },
    toast: {
      showToastMessage: (message, options) => {
        calls.showToastMessage.push({ message, options });
        return `toast_${calls.showToastMessage.length}`;
      },
      showShellErrorToast: (message, options) => {
        calls.showShellErrorToast.push({ message, options });
        return 'raw_shell';
      },
      showSessionActionError: (error, title) => {
        calls.showSessionActionError.push({ error, title });
        return 'raw_session';
      },
      showComposerActionError: (error, title) => {
        calls.showComposerActionError.push({ error, title });
        return 'raw_composer';
      },
      toErrorMessage: (error, fallback) => String((error && error.message) || error || fallback || ''),
    },
    sinks: {
      showBanner: (envelope, banner) => calls.banner.push({ envelope, banner }),
      errorCenter: { record: (envelope) => calls.recorded.push(envelope) },
      onRouted: (route, toastId) => calls.routed.push({ route, toastId }),
      ...sinks,
    },
  });
  return { controller, calls };
}

test('flag-off identity: the three error wrappers delegate to the raw toast controller', () => {
  const { controller, calls } = createHarness({ enabled: false });

  const shellId = controller.showShellErrorToast('boom', { title: 'Custom' });
  const sessionId = controller.showSessionActionError(new Error('x'), 'Delete Failed');
  const composerId = controller.showComposerActionError(new Error('y'), 'Send Failed');

  assert.equal(shellId, 'raw_shell');
  assert.equal(sessionId, 'raw_session');
  assert.equal(composerId, 'raw_composer');
  assert.deepEqual(calls.showShellErrorToast, [{ message: 'boom', options: { title: 'Custom' } }]);
  assert.equal(calls.showSessionActionError[0].title, 'Delete Failed');
  assert.equal(calls.showComposerActionError[0].title, 'Send Failed');
  assert.equal(calls.showToastMessage.length, 0, 'no routed toast traffic when the flag is off');
  assert.equal(calls.recorded.length, 0, 'no error-center traffic when the flag is off');
});

test('flag-on: showShellErrorToast routes to a sticky danger toast preserving source/dedupe defaults', () => {
  const { controller, calls } = createHarness({ enabled: true });

  const toastId = controller.showShellErrorToast('rename exploded', { source: 'shell.memory' });

  assert.equal(toastId, 'toast_1');
  assert.equal(calls.showShellErrorToast.length, 0, 'raw wrapper bypassed');
  const toast = calls.showToastMessage[0];
  assert.equal(toast.message, 'rename exploded');
  assert.equal(toast.options.title, 'Action Failed');
  assert.equal(toast.options.tone, 'danger');
  assert.equal(toast.options.sticky, true);
  assert.equal(toast.options.source, 'shell.memory');
  assert.equal(toast.options.dedupeKey, 'shell.memory:error');
  assert.equal(calls.recorded.length, 1, 'danger errors land in the error center');
});

test('flag-on: a sourceless shell error defaults to the shellAction bucket, not composerAction', () => {
  const { controller, calls } = createHarness({ enabled: true });

  controller.showShellErrorToast('disk full');

  const toast = calls.showToastMessage[0];
  assert.equal(toast.options.source, TOAST_SOURCE.shellAction);
  assert.equal(toast.options.dedupeKey, `${TOAST_SOURCE.shellAction}:error`);
  assert.notEqual(toast.options.source, TOAST_SOURCE.composerAction);
});

test('flag-on: session/composer action errors keep their legacy titles, sources, and dedupe keys', () => {
  const { controller, calls } = createHarness({ enabled: true });

  controller.showSessionActionError(new Error('delete failed'), 'Delete Failed');
  controller.showComposerActionError(new Error('send failed'));

  const [session, composer] = calls.showToastMessage;
  assert.equal(session.message, 'delete failed');
  assert.equal(session.options.title, 'Delete Failed');
  assert.equal(session.options.source, TOAST_SOURCE.sessionAction);
  assert.equal(session.options.dedupeKey, `${TOAST_SOURCE.sessionAction}:error`);
  assert.equal(composer.options.title, 'Composer Action Failed');
  assert.equal(composer.options.dedupeKey, `${TOAST_SOURCE.composerAction}:error`);
});

test('showToastMessage stays a passthrough regardless of the flag', () => {
  for (const enabled of [true, false]) {
    const { controller, calls } = createHarness({ enabled });
    controller.showToastMessage('saved', { tone: 'success' });
    assert.deepEqual(calls.showToastMessage, [{ message: 'saved', options: { tone: 'success' } }]);
    assert.equal(calls.recorded.length, 0);
  }
});

test('reportError: chat-stream turn errors suppress the toast and record history', () => {
  const { controller, calls } = createHarness({ enabled: true });

  const { route, toastId } = controller.reportError(
    { stream_error: 'generation failed', error_code: 'CMP-AI-0005', status: 'runtime_error' },
    { origin: 'chat-stream', sessionId: 'sess-1' }
  );

  assert.equal(route.ruleId, 2);
  assert.equal(route.surface, 'timeline');
  assert.equal(toastId, '');
  assert.equal(calls.showToastMessage.length, 0, 'timeline rows never toast');
  assert.equal(calls.recorded.length, 1);
  assert.equal(calls.recorded[0].errorCode, 'CMP-AI-0005');
  assert.equal(calls.routed.length, 1);
});

test('reportError: sink dispatch per origin', () => {
  const { controller, calls } = createHarness({ enabled: true });

  const banner = controller.reportError(
    { phase: 'failed', detail: 'Backend exited' },
    { origin: 'backend-status' }
  );
  assert.equal(banner.route.surface, 'banner');
  assert.equal(calls.banner.length, 1);
  assert.deepEqual(calls.banner[0].banner, { tone: 'danger', sticky: true });

  const settings = controller.reportError(
    { message: 'Memory refresh failed' },
    { origin: 'settings-refresh', source: 'shell.settings', dedupeKey: 'settings-refresh:memory' }
  );
  assert.equal(settings.route.surface, 'toast');
  const toast = calls.showToastMessage.at(-1);
  assert.equal(toast.options.tone, 'warning');
  assert.equal(toast.options.sticky, false);
  assert.ok(toast.options.durationMs > 0, 'settings-refresh toasts auto-dismiss');

  const poll = controller.reportError({ message: 'poll failed' }, { origin: 'health-poll' });
  assert.equal(poll.route.surface, 'none');
  assert.equal(poll.toastId, '');

  const cancelled = controller.reportError(
    { recovery_class: 'cancelled' },
    { origin: 'chat-stream' }
  );
  assert.equal(cancelled.route.ruleId, 1);
  assert.equal(cancelled.toastId, '', 'cancelled never toasts');

  /* All four recorded (cancelled records explicitly, the rest by severity). */
  assert.equal(calls.recorded.length, 4);
});

test('reportError survives missing optional sinks', () => {
  const controller = createErrorIntakeController({
    isEnabled: () => true,
    constants: { TOAST_SOURCE },
    toast: { showToastMessage: () => 'toast_x' },
  });
  const banner = controller.reportError({ phase: 'failed' }, { origin: 'backend-status' });
  assert.equal(banner.route.surface, 'banner');
  assert.equal(banner.toastId, '');
  const toast = controller.reportError(new Error('boom'), { origin: 'shell-action' });
  assert.equal(toast.toastId, 'toast_x');
});

/* ── Composition wiring (source-level: the shim replaces the three
 * error wrapper names and leaves showToastMessage untouched) ── */

test('lifecycle composition wires the intake controller behind the flag', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'app', 'renderer-app-lifecycle-composition.js'),
    'utf8'
  );
  assert.match(source, /rendererErrorIntakeControllerUtils/);
  assert.match(source, /error_intake_routing === true/);
  assert.match(source, /showShellErrorToast: rawShowShellErrorToast/);
  assert.match(source, /showSessionActionError: rawShowSessionActionError/);
  assert.match(source, /showComposerActionError: rawShowComposerActionError/);
  assert.match(source, /showShellErrorToast = rawShowShellErrorToast/, 'flag-off fallback binding');
});

test('index.html loads the intake core after the classifier and the controller after toast-utils', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const classifierAt = html.indexOf('renderer/chat/renderer-error-recovery-utils.js');
  const intakeAt = html.indexOf('renderer/shared/error-intake.js');
  const toastAt = html.indexOf('renderer/shell/renderer-toast-utils.js');
  const controllerAt = html.indexOf('renderer/shell/renderer-error-intake-controller.js');
  assert.ok(classifierAt !== -1 && intakeAt !== -1 && toastAt !== -1 && controllerAt !== -1);
  assert.ok(classifierAt < intakeAt, 'intake core loads after the classifier module');
  assert.ok(toastAt < controllerAt, 'intake controller loads after toast-utils');
});

test('reportErrorWhenActive routes only when the flag is on (EH-W9 callsite seam)', () => {
  const on = createHarness({ enabled: true });
  const off = createHarness({ enabled: false });

  const offResult = off.controller.reportErrorWhenActive(new Error('x'), { origin: 'update-action' });
  assert.equal(offResult, null);
  assert.equal(off.calls.showToastMessage.length, 0);

  const onResult = on.controller.reportErrorWhenActive(new Error('x'), { origin: 'update-action' });
  assert.equal(onResult.route.ruleId, 7);
  assert.equal(on.calls.showToastMessage.length, 1);
  assert.equal(on.calls.showToastMessage[0].options.tone, 'danger');
});
