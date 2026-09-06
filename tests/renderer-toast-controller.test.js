const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createToastStore } = require('../renderer/shared/toast-utils');
const { createToastController } = require('../renderer/shell/renderer-toast-utils');

const TOAST_SOURCE = {
  sessionAction: 'shell.session',
  composerAction: 'shell.composer',
  shellAction: 'shell.action',
  memory: 'shell.memory',
};

// The store and the controller were each correct in isolation while production
// was broken between them, so these tests always drive the controller's public
// API and read the store record it actually produced.
function mount() {
  const dom = new JSDOM('<!doctype html><body><div class="toast-viewport" id="toastViewport"></div></body>');
  const previous = { window: global.window, document: global.document };
  global.window = dom.window;
  global.document = dom.window.document;

  const toastViewport = dom.window.document.getElementById('toastViewport');
  const toastStore = createToastStore({ maxVisible: 4 });
  const toastActionHandlers = new Map();
  const controller = createToastController({
    toastStore,
    toastActionHandlers,
    constants: { TOAST_SOURCE },
    dom: { toastViewport },
  });
  const unbind = controller.installToastViewportListeners();
  const unsubscribe = toastStore.subscribe(() => { controller.renderToastViewport(); });

  return {
    ...controller,
    dom,
    window: dom.window,
    toastStore,
    toastActionHandlers,
    toastViewport,
    record: (id) => toastStore.getSnapshot().find((toast) => toast.id === id),
    nodes: () => [...toastViewport.querySelectorAll('.inv-toast')],
    dispose() {
      unsubscribe();
      unbind();
      // Non-sticky toasts hold a REFERENCED auto-dismiss timer inside the store
      // (setTimeoutFn in renderer/shared/toast-utils.js); unbinding the viewport
      // listeners does not touch them, so this file kept the event loop alive
      // ~8.5s past its last assertion. dismissAll() is the store's own public
      // clear -- it calls clearTimeoutFn on every armed handle.
      toastStore.dismissAll();
      global.window = previous.window;
      global.document = previous.document;
      dom.window.close();
    },
  };
}

test('showToastMessage lets the per-tone defaults through instead of forcing sticky:false', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  const warningId = app.showToastMessage('File watching is unavailable.', { tone: 'warning' });
  const warning = app.record(warningId);
  assert.equal(warning.sticky, false);
  assert.equal(
    warning.durationMs,
    8000,
    'a warning must carry its tone default, not the durationMs: 0 that made it permanent'
  );

  const dangerId = app.showToastMessage('Streaming failed.', { tone: 'danger' });
  const danger = app.record(dangerId);
  assert.equal(danger.sticky, true, 'danger reports a failed action and stays until acknowledged');
  assert.equal(danger.durationMs, 0);

  const infoId = app.showToastMessage('Draft restored.', { tone: 'info' });
  assert.equal(app.record(infoId).durationMs, 5000);

  const successId = app.showToastMessage('Endpoint saved.', { tone: 'success' });
  assert.equal(app.record(successId).durationMs, 4000);
});

test('an explicit sticky or durationMs from the caller still wins', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  const pinnedId = app.showToastMessage('Read me.', { tone: 'info', sticky: true });
  assert.equal(app.record(pinnedId).sticky, true);
  assert.equal(app.record(pinnedId).durationMs, 0);

  const briefId = app.showToastMessage('Copied.', { tone: 'warning', durationMs: 1500 });
  assert.equal(app.record(briefId).sticky, false);
  assert.equal(app.record(briefId).durationMs, 1500);

  const forcedId = app.showToastMessage('Transient failure.', { tone: 'danger', sticky: false });
  assert.equal(app.record(forcedId).sticky, false);
});

test('showShellErrorToast keeps distinct failures apart and coalesces true repeats', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  app.showShellErrorToast('Export failed: EPERM', { source: TOAST_SOURCE.sessionAction });
  app.showShellErrorToast('Delete failed: file is open', { source: TOAST_SOURCE.sessionAction });
  assert.equal(
    app.toastStore.getSnapshot().length,
    2,
    'a source-only dedupe key made the second error silently replace the first'
  );

  app.showShellErrorToast('Export failed: EPERM', { source: TOAST_SOURCE.sessionAction });
  const snapshot = app.toastStore.getSnapshot();
  assert.equal(snapshot.length, 2, 'the same message coalesces rather than stacking');
  assert.equal(snapshot[0].message, 'Export failed: EPERM');
  assert.equal(snapshot[0].repeatCount, 2);
  assert.match(app.nodes()[0].textContent, /Export failed: EPERM ×2/);
});

test('showSessionActionError and showComposerActionError scope their dedupe by message too', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  app.showSessionActionError(new Error('Could not switch chats.'));
  app.showSessionActionError(new Error('Could not rename the chat.'));
  app.showComposerActionError(new Error('Attachment rejected.'));
  assert.equal(app.toastStore.getSnapshot().length, 3);
});

test('a re-render reuses surviving nodes rather than rebuilding the stack', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  const firstId = app.showToastMessage('First.', { tone: 'info' });
  const firstNode = app.toastViewport.querySelector(`[data-toast-id="${firstId}"]`);
  assert.ok(firstNode);

  app.showToastMessage('Second.', { tone: 'info' });
  app.showToastMessage('Third.', { tone: 'info' });

  assert.equal(
    app.toastViewport.querySelector(`[data-toast-id="${firstId}"]`),
    firstNode,
    'the surviving node keeps its identity, so its entrance animation does not replay'
  );
  assert.deepEqual(
    app.nodes().map((node) => node.querySelector('.inv-toast__message').textContent),
    ['Third.', 'Second.', 'First.'],
    'newest first'
  );
});

test('a deduplicated toast reuses its node while synchronizing tone mark and dismiss control', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  const toastId = app.showToastMessage('First.', {
    tone: 'info',
    dedupeKey: 'same-toast',
    dismissible: true,
  });
  const node = app.nodes()[0];
  const infoPaths = [...node.querySelectorAll('.inv-toast__mark path')].map((path) => path.getAttribute('d'));

  const replacementId = app.showToastMessage('Second.', {
    tone: 'danger',
    dedupeKey: 'same-toast',
    dismissible: false,
  });

  assert.equal(replacementId, toastId);
  assert.equal(app.nodes()[0], node, 'dedupe preserves the outer toast node');
  assert.notDeepEqual(
    [...node.querySelectorAll('.inv-toast__mark path')].map((path) => path.getAttribute('d')),
    infoPaths,
    'the mark changes with the replacement tone'
  );
  assert.equal(node.querySelector('.inv-toast__dismiss'), null, 'non-dismissible replacement removes the old control');

  app.showToastMessage('Third.', { tone: 'success', dedupeKey: 'same-toast', dismissible: true });
  const dismiss = node.querySelector('.inv-toast__dismiss');
  assert.ok(dismiss, 'a later dismissible replacement restores the control');
  assert.equal(dismiss.dataset.toastDismiss, toastId);
  assert.equal(dismiss.getAttribute('title'), 'Dismiss notification');
});

test('keyboard focus inside a toast survives an unrelated toast arriving', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  app.showToastMessage('Quit the tray app to stop the restarts.', {
    tone: 'warning',
    title: 'Ollama Tray App',
    sticky: true,
    actions: [{ id: 'quit', label: 'Quit tray app', kind: 'primary', onClick() {} }],
  });

  const actionButton = app.toastViewport.querySelector('.inv-toast__action');
  assert.ok(actionButton);
  actionButton.focus();
  assert.equal(app.window.document.activeElement, actionButton);

  app.showToastMessage('Endpoint saved.', { tone: 'success' });

  assert.equal(
    app.window.document.activeElement,
    actionButton,
    'an innerHTML rebuild would have dropped focus to <body> mid-interaction'
  );
});

test('generic error titles render no eyebrow; real ones do', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  app.showShellErrorToast('Copy failed: clipboard unavailable', { source: TOAST_SOURCE.shellAction });
  const generic = app.nodes()[0];
  assert.equal(generic.querySelector('.inv-toast__eyebrow'), null, '"Action Failed" only restates the message');
  assert.equal(generic.querySelector('.inv-toast__message').textContent, 'Copy failed: clipboard unavailable');

  app.showToastMessage('Added 2 attachments.', { tone: 'success', title: 'Attachments' });
  const named = app.nodes()[0];
  assert.equal(named.querySelector('.inv-toast__eyebrow').textContent, 'Attachments');
});

test('tone drives the ARIA role and the mark, not the surface', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  app.showToastMessage('Draft restored.', { tone: 'info' });
  assert.equal(app.nodes()[0].getAttribute('role'), 'status');

  app.showToastMessage('Streaming failed.', { tone: 'danger' });
  const danger = app.nodes()[0];
  assert.equal(danger.getAttribute('role'), 'alert');
  assert.ok(danger.classList.contains('inv-toast--danger'));
  assert.equal(danger.querySelector('.inv-toast__mark').getAttribute('aria-hidden'), 'true');
});

test('toast content is set as text, never parsed as markup', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  const hostile = 'Save failed for <img src=x onerror="alert(1)">report.md';
  app.showToastMessage(hostile, { tone: 'danger' });

  const message = app.nodes()[0].querySelector('.inv-toast__message');
  assert.equal(message.textContent, hostile);
  assert.equal(message.querySelector('img'), null);
});

test('the queued remainder is surfaced instead of silently dropped', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  for (let index = 1; index <= 6; index += 1) {
    app.showToastMessage(`Failure ${index}`, { tone: 'danger' });
  }

  assert.equal(app.nodes().length, 4);
  assert.equal(app.toastViewport.querySelector('.toast-viewport__overflow').textContent, '2 more notifications');

  app.dismissToast(app.toastStore.getSnapshot()[0].id);
  assert.equal(app.toastViewport.querySelector('.toast-viewport__overflow').textContent, '1 more notification');

  app.dismissToast(app.toastStore.getSnapshot()[0].id);
  assert.equal(app.toastViewport.querySelector('.toast-viewport__overflow'), null);
});

test('hovering the viewport pauses every countdown and leaving resumes it', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  let paused = 0;
  let resumed = 0;
  const realPause = app.toastStore.pauseAll;
  const realResume = app.toastStore.resumeAll;
  app.toastStore.pauseAll = () => { paused += 1; realPause(); };
  app.toastStore.resumeAll = () => { resumed += 1; realResume(); };

  app.showToastMessage('Endpoint saved.', { tone: 'success' });
  app.toastViewport.dispatchEvent(new app.window.Event('pointerenter'));
  assert.equal(paused, 1);
  app.toastViewport.dispatchEvent(new app.window.Event('pointerleave'));
  assert.equal(resumed, 1);

  app.toastViewport.dispatchEvent(new app.window.FocusEvent('focusin', { bubbles: true }));
  assert.equal(paused, 2, 'tabbing in holds the countdown the same way hovering does');
});

test('Escape inside the stack dismisses the focused toast', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  app.showToastMessage('Streaming failed.', { tone: 'danger' });
  app.showToastMessage('Export failed.', { tone: 'danger' });
  assert.equal(app.nodes().length, 2);

  const dismissButton = app.nodes()[0].querySelector('.inv-toast__dismiss');
  dismissButton.focus();
  dismissButton.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  assert.equal(app.nodes().length, 1);
  assert.equal(app.nodes()[0].querySelector('.inv-toast__message').textContent, 'Streaming failed.');
});

test('a non-dismissible toast renders no dismiss control', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  app.showToastMessage('Working…', { tone: 'info', dismissible: false });
  assert.equal(app.nodes()[0].querySelector('.inv-toast__dismiss'), null);
  assert.equal(app.record(app.toastStore.getSnapshot()[0].id).dismissible, false);
});

test('action handlers stay wired to the ids the click delegation looks up', (t) => {
  const app = mount();
  t.after(() => app.dispose());

  let clicked = 0;
  const toastId = app.showToastMessage('Restart the engine?', {
    tone: 'warning',
    sticky: true,
    actions: [{ id: 'restart', label: 'Restart', kind: 'primary', onClick() { clicked += 1; } }],
  });

  const button = app.toastViewport.querySelector('.inv-toast__action');
  assert.equal(button.dataset.toastId, toastId);
  assert.equal(button.dataset.toastActionId, 'restart');

  app.toastActionHandlers.get(toastId).get('restart')();
  assert.equal(clicked, 1);

  app.dismissToast(toastId);
  assert.equal(app.toastActionHandlers.has(toastId), false, 'handlers are released with the toast');
});
