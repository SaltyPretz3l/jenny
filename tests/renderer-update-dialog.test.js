'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderStepModal } = require('../renderer/inventory/step-modal');
const {
  createUpdateDialogController,
  deriveUpdateDialogViewModel,
  renderUpdateDialog,
} = require('../renderer/features/renderer-update-dialog-utils');

function makeMountElement() {
  const listeners = new Map();
  return {
    innerHTML: '',
    listeners,
    addEventListener(name, listener) {
      const bucket = listeners.get(name) || [];
      bucket.push(listener);
      listeners.set(name, bucket);
    },
    removeEventListener(name, listener) {
      const bucket = listeners.get(name) || [];
      const next = bucket.filter((entry) => entry !== listener);
      if (next.length === 0) {
        listeners.delete(name);
      } else {
        listeners.set(name, next);
      }
    },
  };
}

function makeFakeDocument(mountId, mount) {
  return {
    getElementById(id) {
      return id === mountId ? mount : null;
    },
    createElement: () => mount,
    body: { appendChild() {} },
  };
}

function makeFakeUpdatesShell({ initialState = { status: 'idle' } } = {}) {
  const subscribers = [];
  return {
    subscribers,
    initialState,
    onChanged(handler) {
      subscribers.push(handler);
      return () => {
        const index = subscribers.indexOf(handler);
        if (index >= 0) {
          subscribers.splice(index, 1);
        }
      };
    },
    getState() {
      return Promise.resolve(initialState);
    },
  };
}

test('step modal shell escapes chrome text while allowing sanitized body HTML', () => {
  const html = renderStepModal({
    id: 'update-dialog',
    title: 'Update <script>',
    eyebrow: 'Release <0.2.0>',
    status: 'Ready',
    bodyHtml: '<p><strong>Release notes</strong></p>',
    actions: [{ id: 'download', label: 'Download' }],
  });

  assert.match(html, /data-step-modal="update-dialog"/);
  assert.match(html, /Update &lt;script&gt;/);
  assert.match(html, /Release &lt;0\.2\.0&gt;/);
  assert.match(html, /<strong>Release notes<\/strong>/);
  assert.match(html, /<button[^>]+data-step-modal-action="download"/);
});

test('update dialog view model maps updater states to compact actions', () => {
  assert.deepEqual(
    deriveUpdateDialogViewModel({ status: 'disabled', reason: 'Not packaged' }).actions
      .map((action) => action.id),
    ['close']
  );
  assert.deepEqual(
    deriveUpdateDialogViewModel({ status: 'idle' }).actions.map((action) => action.id),
    ['close', 'check']
  );
  assert.deepEqual(
    deriveUpdateDialogViewModel({ status: 'error', reason: 'Feed unreachable' }).actions
      .map((action) => action.id),
    ['close', 'check']
  );
  assert.deepEqual(
    deriveUpdateDialogViewModel({ status: 'available', latestVersion: '0.2.0' }).actions
      .map((action) => action.id),
    ['close', 'skip', 'download']
  );
  assert.deepEqual(
    deriveUpdateDialogViewModel({ status: 'downloading', latestVersion: '0.2.0' }).actions
      .map((action) => action.id),
    ['close']
  );
  assert.deepEqual(
    deriveUpdateDialogViewModel({ status: 'downloaded', latestVersion: '0.2.0' }).actions
      .map((action) => action.id),
    ['close', 'install']
  );
});

test('update dialog renders release notes through the supplied markdown sanitizer', () => {
  const html = renderUpdateDialog(
    {
      status: 'available',
      latestVersion: '0.2.0',
      releaseNotesMarkdown: '## Notes\n\n<script>alert(1)</script>\n\n- Fixed',
    },
    {
      renderMarkdown(markdown) {
        assert.match(markdown, /Fixed/);
        return '<h2>Notes</h2><p>Fixed</p>';
      },
    }
  );

  assert.match(html, /Jenny 0\.2\.0 is ready/);
  assert.match(html, /<h2>Notes<\/h2><p>Fixed<\/p>/);
  assert.doesNotMatch(html, /<script>/);
});

test('update dialog controller subscribes on bind and disposal is final and symmetric', async () => {
  const mountId = 'updateDialogMount';
  const mount = makeMountElement();
  const documentRef = makeFakeDocument(mountId, mount);
  const updates = makeFakeUpdatesShell({
    initialState: { status: 'available', latestVersion: '0.2.0', currentVersion: '0.1.0' },
  });
  const windowRef = {};

  const controller = createUpdateDialogController({
    windowRef,
    documentRef,
    jennyShell: { updates },
    mountId,
    renderMarkdown: (markdown) => `<p>${markdown}</p>`,
    renderStepModal,
  });

  assert.equal(updates.subscribers.length, 0);
  controller.bind();
  assert.equal(updates.subscribers.length, 1);
  assert.equal(mount.listeners.has('click'), true);
  assert.equal(windowRef.jennyUpdateDialog, controller);

  await Promise.resolve();
  await Promise.resolve();
  assert.match(mount.innerHTML, /Jenny 0\.2\.0 is ready/);

  updates.subscribers[0]({
    status: 'downloaded',
    latestVersion: '0.2.0',
    currentVersion: '0.1.0',
  });
  assert.match(mount.innerHTML, /data-step-modal-action="install"/);

  controller.dispose();
  assert.equal(updates.subscribers.length, 0);
  assert.equal(mount.listeners.has('click'), false);
  assert.equal(mount.innerHTML, '');
  assert.equal(windowRef.jennyUpdateDialog, null);

  controller.bind();
  assert.equal(updates.subscribers.length, 0, 'a disposed controller cannot be rebound');
  assert.equal(mount.listeners.has('click'), false);
});


test('update dialog action failures route through intake with a legacy tone fallback (EH-W9)', async () => {
  const mountId = 'updateDialogMount';

  async function clickFailingDownload({ reportError, showToastMessage }) {
    const mount = makeMountElement();
    const updates = makeFakeUpdatesShell({
      initialState: { status: 'available', latestVersion: '0.2.0' },
    });
    updates.download = () => Promise.reject(new Error('download exploded'));
    const windowRef = {};
    const controller = createUpdateDialogController({
      windowRef,
      documentRef: makeFakeDocument(mountId, mount),
      jennyShell: { updates },
      mountId,
      showToastMessage,
      reportError,
    });
    controller.bind();
    await Promise.resolve();
    const clickHandler = mount.listeners.get('click')[0];
    clickHandler({
      preventDefault() {},
      target: {
        closest: () => ({ getAttribute: () => 'download' }),
      },
    });
    /* drain the runAction rejection through the catch handler */
    await new Promise((resolve) => setImmediate(resolve));
    controller.dispose();
  }

  /* Intake active: routed with the update-action origin, raw toast skipped. */
  const routed = [];
  const routedToasts = [];
  await clickFailingDownload({
    reportError(input, context) {
      routed.push({ input, context });
      return { route: { ruleId: 7, surface: 'toast' }, toastId: 'toast_1' };
    },
    showToastMessage(message, options) {
      routedToasts.push({ message, options });
    },
  });
  assert.equal(routed.length, 1);
  assert.equal(routed[0].context.origin, 'update-action');
  assert.equal(routed[0].input.message, 'download exploded');
  assert.equal(routed[0].input.options.title, 'Update Failed');
  assert.equal(routedToasts.length, 0, 'no raw toast when the intake route succeeds');

  /* Intake declined (flag off): fallback uses the valid danger tone. */
  const legacyToasts = [];
  await clickFailingDownload({
    reportError: () => null,
    showToastMessage(message, options) {
      legacyToasts.push({ message, options });
    },
  });
  assert.equal(legacyToasts.length, 1);
  assert.equal(legacyToasts[0].message, 'download exploded');
  assert.equal(legacyToasts[0].options.tone, 'danger');
});

test('available update can be deferred without immediately auto-opening again', async () => {
  const mount = makeMountElement();
  const updates = makeFakeUpdatesShell({ initialState: { status: 'available', latestVersion: '0.2.0' } });
  const controller = createUpdateDialogController({
    windowRef: {},
    documentRef: makeFakeDocument('updateDialogMount', mount),
    jennyShell: { updates },
    renderStepModal,
  });
  controller.bind();
  await Promise.resolve();
  await Promise.resolve();
  const clickHandler = mount.listeners.get('click')[0];
  clickHandler({
    preventDefault() {},
    target: { closest: () => ({ disabled: false, getAttribute: () => 'close' }) },
  });
  assert.equal(mount.innerHTML, '', 'Later suppresses the current version/status signature');
  controller.dispose();
});

test('a late initial updater snapshot cannot overwrite a newer subscription event', async () => {
  const mount = makeMountElement();
  let resolveInitial;
  const initialGate = new Promise((resolve) => { resolveInitial = resolve; });
  const updates = makeFakeUpdatesShell();
  updates.getState = () => initialGate;
  const controller = createUpdateDialogController({
    windowRef: {},
    documentRef: makeFakeDocument('updateDialogMount', mount),
    jennyShell: { updates },
    renderStepModal,
  });

  controller.bind();
  updates.subscribers[0]({ status: 'downloaded', latestVersion: '0.3.0' });
  assert.match(mount.innerHTML, /Jenny 0\.3\.0/);
  assert.match(mount.innerHTML, /data-step-modal-action="install"/);

  resolveInitial({ status: 'available', latestVersion: '0.2.0' });
  await Promise.resolve();
  await Promise.resolve();
  assert.match(mount.innerHTML, /Jenny 0\.3\.0/, 'newer subscription state remains authoritative');
  assert.match(mount.innerHTML, /data-step-modal-action="install"/);
  controller.dispose();
});

test('update action latch rejects rapid duplicate downloads and late getState after disposal', async () => {
  const mount = makeMountElement();
  let resolveDownload;
  const downloadGate = new Promise((resolve) => { resolveDownload = resolve; });
  let downloadCalls = 0;
  const updates = makeFakeUpdatesShell({ initialState: { status: 'available', latestVersion: '0.2.0' } });
  updates.download = () => { downloadCalls += 1; return downloadGate; };
  const controller = createUpdateDialogController({
    windowRef: {},
    documentRef: makeFakeDocument('updateDialogMount', mount),
    jennyShell: { updates },
    renderStepModal,
  });
  controller.bind();
  await Promise.resolve();
  await Promise.resolve();
  const clickHandler = mount.listeners.get('click')[0];
  const event = {
    preventDefault() {},
    target: { closest: () => ({ disabled: false, getAttribute: () => 'download' }) },
  };
  clickHandler(event);
  clickHandler(event);
  assert.equal(downloadCalls, 1);
  controller.dispose();
  resolveDownload({ status: 'downloading', latestVersion: '0.2.0' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mount.innerHTML, '', 'late action continuation cannot render after disposal');
});

test('disposing during install preflight prevents a late updates.install call', async () => {
  const mount = makeMountElement();
  let releasePreflight;
  let installCalls = 0;
  const updates = makeFakeUpdatesShell({ initialState: { status: 'downloaded', latestVersion: '0.2.0' } });
  updates.install = async () => { installCalls += 1; return { status: 'installing' }; };
  const controller = createUpdateDialogController({
    windowRef: {},
    documentRef: makeFakeDocument('updateDialogMount', mount),
    jennyShell: { updates },
    renderStepModal,
    preflightExit() {
      return new Promise((resolve) => { releasePreflight = resolve; });
    },
  });
  controller.bind();
  await Promise.resolve();
  await Promise.resolve();

  const clickHandler = mount.listeners.get('click')[0];
  clickHandler({
    preventDefault() {},
    target: { closest: () => ({ disabled: false, getAttribute: () => 'install' }) },
  });
  assert.equal(typeof releasePreflight, 'function');

  controller.dispose();
  releasePreflight({ proceed: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(installCalls, 0);
});

test('update dialog delegates focus, Escape, and inert ownership to the step-modal lifecycle', async () => {
  const mount = makeMountElement();
  mount.querySelector = () => null;
  mount.querySelectorAll = () => [];
  const calls = [];
  let lifecycleOpen = false;
  const updates = makeFakeUpdatesShell({ initialState: { status: 'available', latestVersion: '0.2.0' } });
  const controller = createUpdateDialogController({
    windowRef: {},
    documentRef: makeFakeDocument('updateDialogMount', mount),
    jennyShell: { updates },
    renderStepModal,
    createStepModalLifecycle() {
      return {
        isOpen: () => lifecycleOpen,
        open: () => { lifecycleOpen = true; calls.push('open'); },
        close: () => { lifecycleOpen = false; calls.push('close'); },
        dispose: () => { lifecycleOpen = false; calls.push('dispose'); },
      };
    },
  });
  controller.bind();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['open']);
  controller.close();
  assert.deepEqual(calls, ['open', 'close']);
  controller.dispose();
  assert.deepEqual(calls, ['open', 'close', 'dispose']);
});
