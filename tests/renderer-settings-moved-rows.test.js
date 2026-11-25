'use strict';

// Row 133, slice 3: rows that moved page. Each one must render in its new card, write through its
// adapter from there, and resolve to its new page in search. mountSettingRow and bindSettingFields
// skip a missing section or mount without an error, so these tests find the rendered row.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { segmentedValue, chooseSegmented } = require('./helpers/segmented-control');

const card = (doc, id) => doc.querySelector(`.settings-card[data-settings-section="${id}"]`);

async function openSection(window, id) {
  const doc = window.document;
  if (window.__rendererState?.ui?.activeView !== 'settings') {
    doc.getElementById('settingsTopRailTab').click();
    await waitForUi(window, 20);
  }
  doc.querySelector(`.settings-nav-item[data-settings-section="${id}"]`).click();
  await waitForUi(window, 30);
}

// Flips a switch the way the inventory does: the event comes from the track itself.
async function flip(window, id, checked) {
  const track = window.document.querySelector(`[data-inv-toggle="${id}"]`);
  track.dispatchEvent(new window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id, checked } }));
  await waitForUi(window, 30);
}

test('Permissions: the four rows render in its card, in order, and a change writes through chatUi; a Tools row still writes', async (t) => {
  const chatUiPatches = [];
  const featurePatches = [];
  const { window, dispose } = await loadRendererApp({ shell: {
    chatUi: { async updateSettings(patch) { chatUiPatches.push({ ...patch }); return patch; } },
    features: {
      state: { tools: { fileTools: false } },
      async updateSettings(patch, { state }) {
        featurePatches.push(JSON.parse(JSON.stringify(patch)));
        Object.assign(state.featuresState.tools, patch.tools);
        return state.featuresState;
      },
    },
  } });
  t.after(dispose);
  const doc = window.document;
  await openSection(window, 'permissions');
  const permissions = card(doc, 'permissions');
  assert.ok(permissions.classList.contains('settings-section-active'));
  const rows = [...permissions.querySelectorAll('[data-setting-mount] > .settings-field--row')].map((row) => row.dataset.settingsField);
  assert.deepEqual(rows, ['defaultRunModeSelect', 'safetyModeSelect', 'unattendedGuardMinutesInput', 'autoApproveStreakCapInput']);
  const headings = [...permissions.querySelectorAll(':scope > .settings-group > .settings-group-heading')].map((h) => h.textContent);
  assert.deepEqual(headings, ['How much Jenny asks', 'While Auto runs', 'Saved rules']);
  assert.equal(card(doc, 'tools').querySelector('[data-settings-field="safetyModeSelect"]'), null, 'no row is drawn on two pages');

  chooseSegmented(doc, 'safetyModeSelect', 'strict');
  await waitForUi(window, 30);
  assert.deepEqual(chatUiPatches.at(-1), { safetyMode: 'strict' });
  assert.equal(segmentedValue(doc, 'safetyModeSelect'), 'strict');
  chooseSegmented(doc, 'defaultRunModeSelect', 'plan');
  await waitForUi(window, 30);
  assert.deepEqual(chatUiPatches.at(-1), { defaultRunMode: 'plan' });
  const cap = doc.getElementById('autoApproveStreakCapInput');
  assert.ok(permissions.contains(cap));
  cap.value = '75';
  cap.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);
  assert.deepEqual(chatUiPatches.at(-1), { autoApproveStreakCap: 75 });

  await openSection(window, 'tools');
  doc.querySelector('[data-settings-field="settings-tool-config-fileTools"] .settings-field-title').click();
  await waitForUi(window, 30);
  assert.deepEqual(featurePatches.at(-1), { tools: { fileTools: true } });
});

test('Permissions: saved rules render only while Permissions is open, and a rule can be removed there', async (t) => {
  const saved = { policies: { run_command: 'auto' }, rules: [] };
  const calls = [];
  const { window, dispose } = await loadRendererApp({ shell: {
    tools: { getPermissions() { calls.push('getPermissions'); return { policies: {}, saved }; } },
  } });
  t.after(dispose);
  const doc = window.document;
  window.jennyShell.tools.clearPermission = async (name) => { calls.push(`clear:${name}`); delete saved.policies[name]; return { cleared: true, toolName: name }; };
  await openSection(window, 'tools');
  assert.deepEqual(calls, [], 'Tools no longer reads the rules');
  await openSection(window, 'permissions');
  const list = doc.getElementById('toolsApprovalRulesList');
  assert.ok(card(doc, 'permissions').contains(list));
  assert.deepEqual(calls, ['getPermissions']);
  assert.equal(list.querySelectorAll('.tools-approval-rule').length, 1);
  list.querySelector('[data-action="tools-approval-rule-remove"]').click();
  await waitForUi(window, 40);
  assert.equal(calls.length, 1, 'Remove only opens the confirm strip; nothing is cleared yet');
  assert.equal(list.querySelectorAll('.tools-approval-rule').length, 1);
  list.querySelector('[data-action="tools-approval-rule-confirm"]').click();
  await waitForUi(window, 40);
  assert.equal(calls[1], 'clear:run_command');
  assert.equal(list.querySelectorAll('.tools-approval-rule').length, 0);
});

test('Chat: chat width and artifact auto-open render in its Layout and Side panel groups and write the appearance store', async (t) => {
  const { window, dispose } = await loadRendererApp();
  t.after(dispose);
  const doc = window.document;
  await openSection(window, 'chat');
  const chat = card(doc, 'chat');
  const groupOf = (id) => chat.querySelector(`[data-settings-field="${id}"]`)?.closest('.settings-group')?.querySelector('.settings-group-heading')?.textContent;
  assert.equal(groupOf('appearanceChatWidthSelect'), 'Layout');
  assert.equal(groupOf('transcriptViewDefaultSelect'), 'Layout');
  assert.equal(groupOf('appearanceArtifactAutoOpenToggle'), 'Side panel');
  assert.equal(groupOf('changePicturesToggle'), 'Side panel');
  const headings = [...chat.querySelectorAll(':scope > .settings-group > .settings-group-heading')].map((h) => h.textContent);
  assert.deepEqual(headings.slice(0, 2), ['Layout', 'Side panel'], 'the new groups come before the existing ones');

  chooseSegmented(doc, 'appearanceChatWidthSelect', 'narrow');
  await waitForUi(window, 30);
  assert.equal(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).chatWidthId, 'narrow');
  await flip(window, 'appearanceArtifactAutoOpenToggle', true);
  assert.equal(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).artifactAutoOpen, true);
  assert.equal(chat.querySelector('[data-inv-toggle="appearanceArtifactAutoOpenToggle"]').getAttribute('aria-checked'), 'true');
});

test('General: Language and the title-bar load switch render there and write; holo and startup animation stay on Appearance', async (t) => {
  const chatUiPatches = [];
  const { window, dispose } = await loadRendererApp({ shell: {
    chatUi: { async updateSettings(patch) { chatUiPatches.push({ ...patch }); return patch; } },
  } });
  t.after(dispose);
  const doc = window.document;
  await openSection(window, 'general');
  const general = card(doc, 'general');
  const headings = [...general.querySelectorAll(':scope > .settings-group > .settings-group-heading')].map((h) => h.textContent);
  assert.deepEqual(headings.filter((text) => text !== 'You'), ['Language and text', 'Quick capture', 'Machine status']);
  const language = doc.getElementById('uiLanguageSelect');
  assert.ok(general.contains(language));
  assert.ok(general.querySelector('[data-inv-toggle="use24HourTimeToggle"]'));
  assert.ok(general.querySelector('[data-inv-toggle="appearanceSpellcheckToggle"]'));
  language.value = 'de';
  language.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 30);
  assert.deepEqual(chatUiPatches.at(-1), { uiLanguage: 'de' });

  const titlebar = general.querySelector('[data-inv-toggle="appearanceTitlebarLoadToggle"]');
  assert.ok(titlebar);
  assert.equal(titlebar.closest('.settings-group').querySelector('.settings-group-heading').textContent, 'Machine status');
  await flip(window, 'appearanceTitlebarLoadToggle', true);
  assert.equal(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).titlebarLoad, true);

  // The health popover's custom event still writes the same switch.
  doc.dispatchEvent(new window.CustomEvent('jenny:titlebar-load-toggle', { detail: { enabled: false } }));
  await waitForUi(window, 30);
  assert.equal(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).titlebarLoad, false);

  const appearance = card(doc, 'appearance');
  for (const id of ['appearanceComposerHoloToggle', 'appearanceStartupAnimationToggle']) {
    assert.ok(appearance.querySelector(`[data-inv-toggle="${id}"]`), `${id} stays on Appearance`);
    assert.equal(general.querySelector(`[data-inv-toggle="${id}"]`), null);
  }
  await flip(window, 'appearanceComposerHoloToggle', false);
  assert.equal(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).composerHoloId, 'off');
});

test('search resolves one moved row per destination page to that page', () => {
  const search = require('../renderer/shell/renderer-settings-search');
  const index = search.buildSettingsSearchIndex();
  const pageOf = (id) => index.find((entry) => entry.id === id)?.sectionId;
  assert.equal(pageOf('safetyModeSelect'), 'permissions');
  assert.equal(pageOf('autoApproveStreakCapInput'), 'permissions');
  assert.equal(pageOf('uiLanguageSelect'), 'general');
  assert.equal(pageOf('appearanceTitlebarLoadToggle'), 'general');
  assert.equal(pageOf('performanceShowCounterToggle'), 'general');
  assert.equal(pageOf('saveLocalProfileButton'), 'general');
  assert.equal(pageOf('appearanceChatWidthSelect'), 'chat');
  assert.equal(pageOf('changePicturesToggle'), 'chat');
  assert.equal(pageOf('checkUpdatesButton'), 'aboutUpdates');
  assert.equal(pageOf('appearanceComposerHoloToggle'), 'appearance');
  assert.equal(pageOf('section:aboutUpdates'), 'aboutUpdates');
  assert.equal(pageOf('section:permissions'), 'permissions');
});

test('About is a page: its id stays its own, the rail has an item, and the command-line rows find their group', async (t) => {
  const registry = require('../renderer/shell/renderer-settings-section-registry');
  const cliPath = require('../renderer/shell/renderer-settings-cli-path');
  assert.equal(registry.normalizeSettingsSectionId('aboutUpdates'), 'aboutUpdates');
  const { window, dispose } = await loadRendererApp();
  t.after(dispose);
  const doc = window.document;
  const item = doc.querySelector('.settings-nav-item[data-settings-section="aboutUpdates"]');
  assert.ok(item);
  assert.equal(item.textContent.trim(), 'About');
  await openSection(window, 'aboutUpdates');
  const about = card(doc, 'aboutUpdates');
  assert.ok(about.classList.contains('settings-section-active'));
  const group = about.querySelector('[data-settings-merged-section="aboutUpdates"]');
  assert.equal(group.querySelector('.settings-group-heading').textContent, 'This copy of Jenny');
  for (const id of ['aboutVersionLine', 'checkUpdatesButton', 'updateSettingsSummary']) assert.ok(group.querySelector(`#${id}`), id);
  assert.equal(card(doc, 'account').querySelector('#checkUpdatesButton'), null);
  // The command-line tool rows append to the About group (a fresh mount, as the page composition does it).
  doc.getElementById('cliPathSettingsMount')?.remove();
  window.jennyShell.cli = { path: { getState: async () => ({ ok: true, supported: false }), install: async () => ({ ok: true }), remove: async () => ({ ok: true }) } };
  window.inventoryActionButton = window.inventoryActionButton || require('../renderer/inventory/action-button');
  const controller = cliPath.bindCliPathSettings(window, null);
  assert.ok(controller, 'the command-line rows found the About group');
  assert.equal(doc.getElementById('cliPathSettingsMount').parentElement, group);
  controller.dispose();
});

test('Data & privacy holds the conversation transfer, About and setup moved out, the profile name moved to General', async (t) => {
  const { window, dispose } = await loadRendererApp();
  t.after(dispose);
  const doc = window.document;
  const account = card(doc, 'account');
  assert.equal(account.querySelector('h3').textContent, 'Data & privacy');
  const transfer = doc.getElementById('conversationTransferHost');
  assert.ok(account.contains(transfer));
  assert.equal(transfer.parentElement.matches('.settings-group'), true);
  assert.equal(transfer.parentElement.parentElement, account, 'a top-level group of the card');
  assert.equal(transfer.parentElement.querySelector('.settings-group-heading').textContent, 'Copy a conversation');
  const headings = [...account.querySelectorAll(':scope > .settings-group > .settings-group-heading')].map((h) => h.textContent);
  assert.deepEqual(headings, ['Your data', 'Backup and restore', 'Copy a conversation', 'Remove Jenny']);
  assert.equal(card(doc, 'models').querySelector('#conversationTransferHost'), null);
  for (const id of ['localProfileSettingsMount', 'accountSummary']) assert.ok(card(doc, 'general').contains(doc.getElementById(id)), id);
  for (const id of ['setupSettingsSummary', 'setupSettingsActions', 'setupProgressContainer']) assert.ok(card(doc, 'readiness').contains(doc.getElementById(id)), id);
  await openSection(window, 'general');
  assert.ok(doc.getElementById('localProfileDisplayName'), 'the profile name field renders in General');
  assert.match(doc.getElementById('accountSummary').textContent, /Stored on this device as/);
});
