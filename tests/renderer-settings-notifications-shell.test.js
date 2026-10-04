'use strict';
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

function toggle(document, id) {
  return document.querySelector(`#notificationsSettingsSection [data-inv-toggle="${id}"]`);
}

test('Settings › Notifications renders its nine switches from the persisted windowUi block and writes the whole object back', async (t) => {
  const updateCalls = [];
  const { window, waitForSettingsRender } = await loadRendererTestApp(t, {
    shell: { windowUi: {
      getState: async () => ({
        appZoomPercent: 100,
        notifications: {
          enabled: true, onlyWhenUnfocused: true, sound: false, replyPreview: false,
          categories: { replies: true, failures: false, permissions: true, questions: true, reminders: true },
        },
      }),
      updateSettings: async (patch) => {
        updateCalls.push(JSON.parse(JSON.stringify(patch)));
        return { appZoomPercent: 100, ...patch };
      },
    } },
  });
  const { document } = window;
  if (typeof waitForSettingsRender === 'function') await waitForSettingsRender();
  await waitForUi(window, 0);

  const card = document.getElementById('notificationsSettingsSection');
  assert.ok(card, 'the Notifications card exists');
  assert.equal(card.getAttribute('data-settings-section'), 'notifications');
  assert.equal(card.querySelectorAll('[data-inv-toggle]').length, 9);
  // Persisted values (hydrated from windowUi.getState) drive the switches.
  assert.equal(toggle(document, 'notificationsSoundToggle').getAttribute('aria-checked'), 'false');
  assert.equal(toggle(document, 'notificationsCategoryFailuresToggle').getAttribute('aria-checked'), 'false');
  assert.equal(toggle(document, 'notificationsEnabledToggle').getAttribute('aria-checked'), 'true');
  // The nav lists the section in the App group after Home.
  const navIds = [...document.querySelectorAll('[data-settings-nav-section], [data-section-id]')]
    .map((node) => node.getAttribute('data-settings-nav-section') || node.getAttribute('data-section-id'));
  if (navIds.length) {
    assert.ok(navIds.indexOf('notifications') > navIds.indexOf('home'), `nav order: ${navIds.join(',')}`);
  }

  card.dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id: 'notificationsCategoryQuestionsToggle', checked: false },
  }));
  await waitForUi(window, 0);
  await waitForUi(window, 0);
  assert.deepEqual(updateCalls, [{
    notifications: {
      enabled: true, onlyWhenUnfocused: true, sound: false, replyPreview: false,
      categories: { replies: true, failures: false, permissions: true, questions: false, reminders: true },
    },
  }]);
  assert.equal(toggle(document, 'notificationsCategoryQuestionsToggle').getAttribute('aria-checked'), 'false');
  assert.equal(document.getElementById('notificationsStatus').dataset.state || '', '');
});
