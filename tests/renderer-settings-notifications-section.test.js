'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const section = require('../renderer/shell/renderer-settings-notifications-section');
const toggleSwitchModule = require('../renderer/inventory/toggle-switch');

const CARD = [
  '<section id="card">',
  '<div id="status"></div>',
  '<div id="notificationsGeneralList"></div>',
  '<div id="notificationsCategoryList"></div>',
  '<div id="notificationsContentList"></div>',
  '</section>',
].join('');

// Awaits the callback so an async test keeps its window/inventory globals
// until it finishes (a sync finally would restore them at the first await).
async function withGlobals(run) {
  const previous = { window: globalThis.window, inventory: globalThis.inventory };
  globalThis.inventory = { toggleSwitch: toggleSwitchModule.toggleSwitch };
  try { return await run(); } finally { globalThis.window = previous.window; globalThis.inventory = previous.inventory; }
}
function harness() {
  const dom = new JSDOM(CARD);
  const document = dom.window.document;
  return { dom, container: document.getElementById('card'), status: document.getElementById('status') };
}
function registerListener(target, name, handler, options) { target.addEventListener(name, handler, options); }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function toggle(container, id) {
  return container.querySelector(`[data-inv-toggle="${id}"]`);
}
function fire(dom, container, id, checked) {
  container.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id, checked } }));
}
function settingsWith(overrides = {}) {
  return section.normalizeNotificationSettings({ ...section.DEFAULT_NOTIFICATION_SETTINGS, ...overrides });
}

test('normalizeNotificationSettings is total, fills partial input and drops unknown keys', () => {
  assert.deepEqual(section.normalizeNotificationSettings(undefined), {
    enabled: true, onlyWhenUnfocused: true, sound: true, replyPreview: false,
    categories: { replies: true, failures: true, permissions: true, questions: true, reminders: true },
  });
  const partial = section.normalizeNotificationSettings({ enabled: 'no', sound: false, categories: { replies: false, bogus: true }, extra: 1 });
  assert.equal(partial.enabled, true);
  assert.equal(partial.sound, false);
  assert.deepEqual(Object.keys(partial.categories), [...section.NOTIFICATION_CATEGORIES]);
  assert.equal(partial.categories.replies, false);
  assert.equal('extra' in partial, false);
  assert.deepEqual(section.normalizeNotificationSettings(partial), partial);
  assert.deepEqual(section.normalizeNotificationSettings([]), section.normalizeNotificationSettings(null));
});

test('render lists every switch with its persisted value and disables dependents when the master is off', () => {
  return withGlobals(() => {
    const { container } = harness();
    const state = { ui: { notifications: settingsWith({ sound: false, categories: { ...section.DEFAULT_NOTIFICATION_SETTINGS.categories, failures: false } }) } };
    section.renderNotificationsSection({ container, state });
    assert.equal(toggle(container, 'notificationsEnabledToggle').getAttribute('aria-checked'), 'true');
    assert.equal(toggle(container, 'notificationsSoundToggle').getAttribute('aria-checked'), 'false');
    assert.equal(toggle(container, 'notificationsCategoryFailuresToggle').getAttribute('aria-checked'), 'false');
    assert.equal(toggle(container, 'notificationsCategoryRepliesToggle').getAttribute('aria-checked'), 'true');
    assert.equal(toggle(container, 'notificationsReplyPreviewToggle').getAttribute('aria-checked'), 'false');
    assert.equal(toggle(container, 'notificationsCategoryRepliesToggle').hasAttribute('disabled'), false);
    assert.equal(container.querySelectorAll('[data-inv-toggle]').length, 9);
    // Every row carries its help line.
    assert.ok(container.querySelector('#notificationsSoundToggleDescription').textContent.length > 0);

    state.ui.notifications = settingsWith({ enabled: false });
    section.renderNotificationsSection({ container, state });
    assert.equal(toggle(container, 'notificationsEnabledToggle').hasAttribute('disabled'), false);
    assert.equal(toggle(container, 'notificationsBackgroundOnlyToggle').hasAttribute('disabled'), true);
    assert.equal(toggle(container, 'notificationsCategoryQuestionsToggle').hasAttribute('disabled'), true);
    assert.equal(toggle(container, 'notificationsReplyPreviewToggle').hasAttribute('disabled'), true);

    // The reply preview only matters while reply notifications are on.
    state.ui.notifications = settingsWith({ categories: { ...section.DEFAULT_NOTIFICATION_SETTINGS.categories, replies: false } });
    section.renderNotificationsSection({ container, state });
    assert.equal(toggle(container, 'notificationsReplyPreviewToggle').hasAttribute('disabled'), true);
    assert.equal(toggle(container, 'notificationsCategoryFailuresToggle').hasAttribute('disabled'), false);
  });
});

test('render tolerates a missing state slice and a missing toggle primitive', () => {
  return withGlobals(() => {
    const { container } = harness();
    section.renderNotificationsSection({ container, state: {} });
    assert.equal(toggle(container, 'notificationsEnabledToggle').getAttribute('aria-checked'), 'true');
    globalThis.inventory = {};
    const { container: bare } = harness();
    section.renderNotificationsSection({ container: bare, state: {} });
    assert.equal(bare.querySelectorAll('[data-inv-toggle]').length, 0);
    section.renderNotificationsSection({});
  });
});

test('a switch change writes the whole object through windowUi.updateSettings and adopts the acknowledgement', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    const patches = [];
    dom.window.jennyShell = { windowUi: { async updateSettings(patch) {
      patches.push(patch);
      return { appZoomPercent: 100, notifications: patch.notifications };
    } } };
    const state = { ui: { notifications: settingsWith() } };
    let renders = 0;
    section.bindNotificationsSection({ container, status, state, renderSettings: () => { renders += 1; }, registerListener });
    fire(dom, container, 'notificationsCategoryPermissionsToggle', false);
    // Optimistic flip before the write lands.
    assert.equal(state.ui.notifications.categories.permissions, false);
    assert.equal(renders, 1);
    await flush();
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0], { notifications: settingsWith({ categories: { ...section.DEFAULT_NOTIFICATION_SETTINGS.categories, permissions: false } }) });
    assert.equal(state.ui.notifications.categories.permissions, false);
    assert.equal(status.dataset.state, '');
    assert.equal(renders, 2);

    fire(dom, container, 'notificationsEnabledToggle', false);
    fire(dom, container, 'notificationsSoundToggle', false);
    await flush();
    await flush();
    assert.equal(patches.length, 3);
    // Writes queue in order and each carries the previous result forward.
    assert.equal(patches[2].notifications.enabled, false);
    assert.equal(patches[2].notifications.sound, false);
    assert.equal(patches[2].notifications.categories.permissions, false);
    assert.equal(state.ui.notifications.sound, false);
  });
});

test('a refused or mismatched write restores the previous value and reports it', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    let mode = 'throw';
    dom.window.jennyShell = { windowUi: { async updateSettings(patch) {
      if (mode === 'throw') throw new Error('disk');
      return { notifications: { ...patch.notifications, sound: !patch.notifications.sound } };
    } } };
    const state = { ui: { notifications: settingsWith() } };
    section.bindNotificationsSection({ container, status, state, renderSettings: () => {}, registerListener });
    fire(dom, container, 'notificationsBackgroundOnlyToggle', false);
    assert.equal(state.ui.notifications.onlyWhenUnfocused, false);
    await flush();
    assert.equal(state.ui.notifications.onlyWhenUnfocused, true);
    assert.equal(status.dataset.state, 'error');
    assert.ok(status.textContent.length > 0);

    mode = 'mismatch';
    fire(dom, container, 'notificationsSoundToggle', false);
    await flush();
    assert.equal(state.ui.notifications.sound, true);
    assert.equal(status.dataset.state, 'error');
  });
});

test('toggles during an in-flight write coalesce into one follow-up write and only the newest result touches the UI', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    const pending = [];
    dom.window.jennyShell = { windowUi: { updateSettings(patch) {
      return new Promise((resolve, reject) => { pending.push({ patch, resolve, reject }); });
    } } };
    const state = { ui: { notifications: settingsWith() } };
    section.bindNotificationsSection({ container, status, state, renderSettings: () => {}, registerListener });
    fire(dom, container, 'notificationsSoundToggle', false);
    fire(dom, container, 'notificationsReplyPreviewToggle', true);
    fire(dom, container, 'notificationsCategoryFailuresToggle', false);
    await flush();
    // One write in flight; the two later toggles wait for it.
    assert.equal(pending.length, 1);
    assert.equal(pending[0].patch.notifications.sound, false);
    assert.equal(pending[0].patch.notifications.replyPreview, false);
    assert.equal(state.ui.notifications.replyPreview, true);
    assert.equal(state.ui.notifications.categories.failures, false);

    // The stale acknowledgement advances the baseline without clobbering the newer optimistic state.
    pending[0].resolve({ notifications: pending[0].patch.notifications });
    await flush();
    assert.equal(state.ui.notifications.replyPreview, true);
    assert.equal(state.ui.notifications.categories.failures, false);
    assert.equal(pending.length, 2);
    assert.deepEqual(pending[1].patch.notifications, settingsWith({
      sound: false,
      replyPreview: true,
      categories: { ...section.DEFAULT_NOTIFICATION_SETTINGS.categories, failures: false },
    }));

    // The follow-up write fails: only the unacknowledged changes revert; the acknowledged sound=false stays.
    pending[1].reject(new Error('disk'));
    await flush();
    assert.equal(state.ui.notifications.sound, false);
    assert.equal(state.ui.notifications.replyPreview, false);
    assert.equal(state.ui.notifications.categories.failures, true);
    assert.equal(status.dataset.state, 'error');
    assert.equal(pending.length, 2);
  });
});

test('a failed write is not re-applied by the next write, and consecutive failures each restore the acknowledged baseline', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    const patches = [];
    let fail = true;
    dom.window.jennyShell = { windowUi: { async updateSettings(patch) {
      patches.push(patch.notifications);
      if (fail) throw new Error('disk');
      return { notifications: patch.notifications };
    } } };
    const state = { ui: { notifications: settingsWith() } };
    section.bindNotificationsSection({ container, status, state, renderSettings: () => {}, registerListener });
    fire(dom, container, 'notificationsEnabledToggle', false);
    await flush();
    assert.equal(state.ui.notifications.enabled, true);
    assert.equal(status.dataset.state, 'error');
    fire(dom, container, 'notificationsSoundToggle', false);
    await flush();
    assert.equal(patches.length, 2);
    // The refused enabled=false is not smuggled into the second write.
    assert.equal(patches[1].enabled, true);
    assert.equal(patches[1].sound, false);
    assert.equal(state.ui.notifications.sound, true);
    assert.equal(state.ui.notifications.enabled, true);

    fail = false;
    fire(dom, container, 'notificationsSoundToggle', false);
    await flush();
    assert.equal(patches.length, 3);
    assert.deepEqual(patches[2], settingsWith({ sound: false }));
    assert.equal(state.ui.notifications.sound, false);
    assert.equal(status.dataset.state, '');
  });
});

test('a missing bridge restores the previous value; unknown toggle ids and missing deps are ignored', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    dom.window.jennyShell = {};
    const state = { ui: {} };
    section.bindNotificationsSection({ container, status, state, registerListener });
    fire(dom, container, 'notificationsReplyPreviewToggle', true);
    await flush();
    assert.equal(state.ui.notifications.replyPreview, false);
    assert.equal(status.dataset.state, 'error');
    fire(dom, container, 'someOtherToggle', true);
    await flush();
    assert.equal(state.ui.notifications.replyPreview, false);
    section.bindNotificationsSection({ container, state });
    section.bindNotificationsSection({});
  });
});

test('an echo missing a written field is a refusal, never read as that field\'s default', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    dom.window.jennyShell = { windowUi: { async updateSettings() { return { notifications: {} }; } } };
    const state = { ui: { notifications: settingsWith({ sound: false }) } };
    section.bindNotificationsSection({ container, status, state, renderSettings: () => {}, registerListener });
    // Back to the default: an empty echo normalizes to the same object and used to pass.
    fire(dom, container, 'notificationsSoundToggle', true);
    await flush();
    assert.equal(state.ui.notifications.sound, false, 'restored: the empty echo confirmed nothing');
    assert.equal(status.dataset.state, 'error');
  });
});

test('a binding replaced while its write is in flight settles against the same coordinator as the new binding', async () => {
  await withGlobals(async () => {
    const first = harness();
    const second = harness();
    globalThis.window = first.dom.window;
    const pending = [];
    const bridge = { windowUi: { updateSettings(patch) {
      return new Promise((resolve, reject) => { pending.push({ patch, resolve, reject }); });
    } } };
    first.dom.window.jennyShell = bridge;
    second.dom.window.jennyShell = bridge;
    const state = { ui: { notifications: settingsWith() } };
    section.bindNotificationsSection({ container: first.container, status: first.status, state, renderSettings: () => {}, registerListener });
    fire(first.dom, first.container, 'notificationsSoundToggle', false);
    await flush();
    assert.equal(pending.length, 1);
    // Settings closed and reopened: a new binding over the same state.
    globalThis.window = second.dom.window;
    section.bindNotificationsSection({ container: second.container, status: second.status, state, renderSettings: () => {}, registerListener });
    fire(second.dom, second.container, 'notificationsBackgroundOnlyToggle', false);
    await flush();
    assert.equal(pending.length, 1, 'the new binding queues behind the old write instead of racing it');
    pending[0].reject(new Error('disk'));
    await flush();
    assert.equal(state.ui.notifications.sound, true, 'the refused write rolled back its own key');
    assert.equal(state.ui.notifications.onlyWhenUnfocused, false, 'the newer edit survived the older rollback');
    assert.equal(pending.length, 2);
    assert.equal(pending[1].patch.notifications.sound, true);
    assert.equal(pending[1].patch.notifications.onlyWhenUnfocused, false);
    pending[1].resolve({ notifications: pending[1].patch.notifications });
    await flush();
    assert.equal(state.ui.notifications.onlyWhenUnfocused, false);
    assert.equal(second.status.dataset.state, '', 'the outcome reports on the current binding');
  });
});
