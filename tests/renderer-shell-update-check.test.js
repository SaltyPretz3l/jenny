const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

test('check-for-updates row fills the version note and runs a user-initiated check', async (t) => {
  let checkCalls = 0;
  const { window } = await loadRendererTestApp(t, {
    shell: {
      updates: {
        state: { currentVersion: '9.9.9-test' },
        async check() {
          checkCalls += 1;
          return { status: 'idle', reason: 'Jenny is up to date.' };
        },
      },
    },
  });
  const doc = window.document;
  await waitForUi(window, 20);

  const summary = doc.getElementById('updateSettingsSummary');
  assert.ok(summary, 'update settings summary note exists');
  assert.match(summary.textContent, /Jenny 9\.9\.9-test/);

  // No startup polling: the check must not run until the user asks.
  assert.equal(checkCalls, 0);

  doc.getElementById('checkUpdatesButton').click();
  await waitForUi(window, 20);
  assert.equal(checkCalls, 1);

  const mount = doc.getElementById('updateDialogMount');
  assert.ok(mount, 'update dialog mount exists');
  assert.match(mount.innerHTML, /up to date/i);
});

test('disabled dev-install state paints the reason, and the click flow stays closable', async (t) => {
  const disabledPayload = {
    status: 'disabled',
    reason: 'Automatic updates are disabled until Jenny is running from a packaged install.',
  };
  let checkCalls = 0;
  const { window } = await loadRendererTestApp(t, {
    shell: {
      updates: {
        state: { currentVersion: '9.9.9-test' },
        async getState() {
          return disabledPayload;
        },
        async check() {
          checkCalls += 1;
          return disabledPayload;
        },
      },
    },
  });
  const doc = window.document;
  await waitForUi(window, 20);

  const summary = doc.getElementById('updateSettingsSummary');
  assert.match(summary.textContent, /Updates unavailable/);

  doc.getElementById('checkUpdatesButton').click();
  await waitForUi(window, 20);
  assert.equal(checkCalls, 1);

  const mount = doc.getElementById('updateDialogMount');
  assert.ok(mount, 'update dialog mount exists');
  assert.match(mount.innerHTML, /Updates unavailable/);

  const closeButton = mount.querySelector('[data-step-modal-action="close"]');
  assert.ok(closeButton, 'disabled dialog renders a close action');
  closeButton.click();
  await waitForUi(window, 20);
  assert.equal(mount.innerHTML, '', 'close dismisses the dialog');
});


test('Settings reflects pushed download state and reopens it without another check', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: { updates: { state: { currentVersion: '1.0.1', status: 'unchecked' } } },
  });
  await waitForUi(window, 20);
  await window.jennyShell.__emitUpdatesState({ status: 'downloaded', currentVersion: '1.0.1',
    latestVersion: '1.0.2', canCheck: false, canInstall: true,
    lastCheckedAt: '2026-09-09T00:00:00Z', downloadProgress: { percent: 100 } });
  const summary = window.document.getElementById('updateSettingsSummary');
  assert.match(summary.textContent, /1\.0\.2.*ready to install/);
  assert.match(summary.textContent, /Last checked/);
  window.jennyUpdateDialog.close();
  let checks = 0;
  window.jennyShell.updates.check = async () => { checks += 1; };
  window.document.getElementById('checkUpdatesButton').click();
  await waitForUi(window, 20);
  assert.equal(checks, 0);
  assert.ok(window.document.querySelector('[data-step-modal-action="install"]'));
});

test('a late check response cannot replace newer updater events in Settings or its dialog', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: { updates: { state: { currentVersion: '1.0.1', status: 'unchecked' } } },
  });
  await waitForUi(window, 20);
  let finish;
  window.jennyShell.updates.check = () => new Promise((resolve) => { finish = resolve; });
  window.document.getElementById('checkUpdatesButton').click();
  await waitForUi(window, 20);
  await window.jennyShell.__emitUpdatesState({ status: 'downloaded', currentVersion: '1.0.1',
    latestVersion: '1.0.2', canCheck: false, canInstall: true, downloadProgress: { percent: 100 } });
  finish({ status: 'available', latestVersion: '1.0.2', canDownload: true });
  await waitForUi(window, 20);
  assert.match(window.document.getElementById('updateSettingsSummary').textContent, /ready to install/);
  assert.ok(window.document.querySelector('[data-step-modal-action="install"]'));
});
