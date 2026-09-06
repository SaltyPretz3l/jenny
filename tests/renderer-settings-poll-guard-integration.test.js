// UIUX-009: "A 15-second Settings refresh replaces live controls and erases
// in-progress input" -- renderer-app-shell-bindings.js:720-723 polls every
// 15s; every successful poll rerenders Settings through
// renderer/shell/renderer-lifecycle-utils.js -> renderer-settings-utils.js,
// which repaints the compaction custom-prompt textarea and the web-search
// provider/API-key fields via innerHTML from last-known-persisted state.
//
// These tests drive the REAL Settings DOM (via the full app harness) to
// prove the guard wired in renderer-settings-shell-controller.js /
// renderer-settings-utils.js actually protects those two subtrees. Rather
// than waiting a real 15 seconds for the literal poll timer (the isolated
// createSnapshotPoller unit tests in renderer-settings-snapshot-poll.test.js
// already cover that timer contract deterministically with mocked time),
// these tests trigger an EQUIVALENT unrelated Settings re-render the same
// way applyFeatureSettings() does after any tools/feature toggle commits
// (renderer-settings-event-utils.js: `await refreshFeatureState(patch);
// renderSettings();`). renderSettings() is a single function -- the guard is
// wired inside it (renderer/shell/renderer-settings-utils.js `if
// (contextCompactionTuning && shouldPatchSection('compactionPrompt'))` /
// `if (toolsConfigFieldList && shouldPatchSection('toolsConfig'))`), so any
// call into it -- poll-driven or action-driven -- exercises the exact same
// protected code path the audit finding is about.
//
// RED-FIRST: at HEAD before this slice, renderSettings() rebuilds these two
// subtrees unconditionally on every call, so an unrelated toggle click while
// the user is mid-edit reproduces the reported bug directly.
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

async function openSettings(window) {
  const doc = window.document;
  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
}

async function openSettingsSection(window, sectionId) {
  const doc = window.document;
  doc.querySelector(`.settings-nav-item[data-settings-section="${sectionId}"]`).click();
  await waitForUi(window, 20);
}

// Fires an unrelated Settings re-render the same way a real 15s snapshot
// poll would (a fresh renderSettings() call), without waiting on the literal
// timer: clicking any Context runtime feature toggle runs applyFeatureSettings(), which
// awaits the (stubbed, effectively synchronous) persistence call and then
// calls renderSettings() directly -- same function, same guarded subtrees.
async function triggerUnrelatedSettingsRerender(window) {
  const doc = window.document;
  const toggle = doc.querySelector('[data-inv-toggle="contextTokenBudgetToggle"]');
  assert.ok(toggle, 'precondition: a Context runtime toggle exists to drive an unrelated rerender');
  assert.equal(toggle.disabled, false, 'precondition: the toggle is enabled');
  toggle.click();
  await waitForUi(window, 30);
}

test('typing in the compaction custom prompt textarea survives an unrelated Settings re-render', async (t) => {
  const { window } = await loadRendererTestApp(t, {});
  const doc = window.document;
  await openSettings(window);
  await openSettingsSection(window, 'context');

  const field = doc.querySelector('[data-compaction-field="customPrompt"]');
  assert.ok(field, 'precondition: the compaction custom-prompt field is rendered');
  field.focus();
  field.value = 'a prompt the user is still typing';
  field.setSelectionRange(5, 11);

  await triggerUnrelatedSettingsRerender(window);

  assert.equal(doc.querySelector('[data-compaction-field="customPrompt"]'), field, 'node identity survives');
  assert.equal(field.value, 'a prompt the user is still typing', 'in-progress value survives');
  assert.equal(doc.activeElement, field, 'focus survives');
  assert.equal(field.selectionStart, 5, 'selection start survives');
  assert.equal(field.selectionEnd, 11, 'selection end survives');
});

test('typing into a web-search API key password field survives an unrelated Settings re-render', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      features: {
        state: {
          featureFlags: { web_search_providers: true },
          webSearch: { provider: 'brave' },
        },
      },
    },
  });
  const doc = window.document;
  await openSettings(window);
  await openSettingsSection(window, 'tools');

  const field = doc.querySelector('[data-web-search-key-field="brave"]');
  assert.ok(field, 'precondition: the web-search API key field is rendered');
  assert.equal(field.type, 'password');
  field.focus();
  field.value = 'sk-in-progress-key';

  await triggerUnrelatedSettingsRerender(window);

  assert.equal(doc.querySelector('[data-web-search-key-field="brave"]'), field, 'node identity survives');
  assert.equal(field.value, 'sk-in-progress-key', 'in-progress key text survives');
  assert.equal(doc.activeElement, field, 'focus survives');
});

test('an uncommitted web-search provider select pick survives an unrelated Settings re-render (dirty draft, not focused)', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      features: {
        state: {
          featureFlags: { web_search_providers: true },
          webSearch: { provider: 'duckduckgo' },
        },
      },
    },
  });
  const doc = window.document;
  await openSettings(window);
  await openSettingsSection(window, 'tools');

  const select = doc.querySelector('[data-web-search-field="provider"]');
  assert.ok(select, 'precondition: the provider select is rendered');
  assert.equal(select.value, 'duckduckgo');
  // Simulate the user picking a new option but not yet committing it (no
  // 'change' event dispatched) and moving focus away -- an in-flight,
  // uncommitted selection, same class of state as an <select> left open.
  select.value = 'tavily';
  select.blur?.();

  await triggerUnrelatedSettingsRerender(window);

  assert.equal(
    doc.querySelector('[data-web-search-field="provider"]').value,
    'tavily',
    'the uncommitted pick is not reverted back to the last-persisted provider'
  );
});

test('a dirty-but-blurred compaction prompt draft is not clobbered by an unrelated Settings re-render', async (t) => {
  const { window } = await loadRendererTestApp(t, {});
  const doc = window.document;
  await openSettings(window);
  await openSettingsSection(window, 'context');

  const field = doc.querySelector('[data-compaction-field="customPrompt"]');
  field.focus();
  field.value = 'typed, then blurred without saving';
  field.blur();
  assert.notEqual(doc.activeElement, field, 'precondition: focus has left the field');

  await triggerUnrelatedSettingsRerender(window);

  assert.equal(
    doc.querySelector('[data-compaction-field="customPrompt"]').value,
    'typed, then blurred without saving',
    'the dirty-but-blurred draft is preserved'
  );
});

test('an unrelated re-render is a zero-DOM-write no-op for a guarded section when nothing changed, focused, or dirty', async (t) => {
  const { window } = await loadRendererTestApp(t, {});
  const doc = window.document;
  await openSettings(window);
  await openSettingsSection(window, 'context');

  const fieldBefore = doc.querySelector('[data-compaction-field="customPrompt"]');
  assert.ok(fieldBefore);
  const containerBefore = doc.getElementById('contextCompactionTuning');

  await triggerUnrelatedSettingsRerender(window);

  assert.equal(
    doc.getElementById('contextCompactionTuning'),
    containerBefore,
    'the guarded container is not rebuilt at all when its signature is unchanged'
  );
  assert.equal(
    doc.querySelector('[data-compaction-field="customPrompt"]'),
    fieldBefore,
    'the field node identity is preserved (no redundant innerHTML write)'
  );
});

test('a real upstream change to the compaction prompt patches through when nothing is focused or dirty', async (t) => {
  const { window } = await loadRendererTestApp(t, {});
  const doc = window.document;
  await openSettings(window);
  await openSettingsSection(window, 'context');

  assert.equal(doc.querySelector('[data-compaction-field="customPrompt"]').value, '');

  // Simulate the backend pushing a real change (e.g. a poll fetched a fresh
  // compaction tuning snapshot) with nobody editing the field.
  window.__rendererState.compactionTuning = {
    ...(window.__rendererState.compactionTuning || {}),
    customPrompt: 'pushed from elsewhere',
  };

  await triggerUnrelatedSettingsRerender(window);

  assert.equal(
    doc.querySelector('[data-compaction-field="customPrompt"]').value,
    'pushed from elsewhere',
    'an unguarded, unfocused, non-dirty section still patches through a real change'
  );
});
