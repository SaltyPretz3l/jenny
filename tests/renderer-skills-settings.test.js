'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSkillsManager } = require('../renderer/features/renderer-skills-utils');
const { createSettingsSectionBinders } = require('../renderer/shell/renderer-settings-section-binders');
const segmentedControl = require('../renderer/inventory/segmented-control');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function skill(id, name, overrides = {}) {
  return { id, enabled: true, scope: id.split('/')[0], name, command: name.toLowerCase(),
    description: `${name} description`, allowedTools: [], ...overrides };
}

function skillsPayload(overrides = {}) {
  return {
    featureEnabled: true,
    settings: { bundledEnabled: true, userEnabled: true, projectEnabled: false,
      disabledSkillIds: [], autoIndex: 'auto' },
    scopes: [
      { scope: 'bundled', label: 'Bundled', enabled: true, status: 'ready', path: 'G:\\bundled',
        entries: [skill('bundled/verify', 'Verify', { allowedTools: ['read_file', 'grep_search'] })], warnings: [] },
      { scope: 'user', label: 'User', enabled: true, status: 'ready', path: 'C:\\Users\\me\\.companion\\skills',
        entries: [skill('user/notes', 'Notes', { enabled: false })], warnings: [] },
      { scope: 'project', label: 'Project', enabled: false, status: 'blocked', blocked: true, path: '',
        entries: [], warnings: [] },
    ],
    warnings: [],
    ...overrides,
  };
}

function renderHarness(payload = skillsPayload()) {
  const dom = new JSDOM(`<!doctype html><body>
    <section id="skillsSettingsSection">
      <div id="skillsRowsHost"></div>
      <div id="skillsFoldersHost"></div>
    </section>
  </body>`);
  const state = {};
  const manager = createSkillsManager({
    state,
    constants: { TOAST_SOURCE: { settings: 'settings' } },
    dom: { skillsSettingsSection: dom.window.document.getElementById('skillsSettingsSection') },
    callbacks: {
      escapeHtml,
      renderSettings() {},
      showToastMessage() {},
      showShellErrorToast() {},
      toErrorMessage(_error, fallback) { return fallback; },
    },
  });
  manager.applySkillsPayload(payload);
  manager.renderSkillsManager();
  return { dom, doc: dom.window.document, state, manager };
}

test('skills render as ordered flat rows with per-skill switches and no legacy card markup', () => {
  const { doc } = renderHarness();
  const rows = [...doc.querySelectorAll('#skillsRowsHost [data-skill-id]')];
  assert.deepEqual(rows.map((row) => row.dataset.skillId), ['bundled/verify', 'user/notes']);
  assert.match(rows[0].textContent, /\/verify · Verify description · 2 tools/);
  assert.equal(rows[0].querySelector('[data-inv-toggle="skillToggle:bundled/verify"]')
    .getAttribute('aria-checked'), 'true');
  assert.equal(rows[1].classList.contains('settings-field-row--muted'), true);
  assert.equal(rows[1].querySelector('[data-inv-toggle="skillToggle:user/notes"]')
    .getAttribute('aria-checked'), 'false');
  assert.equal(doc.querySelector('.approved-memory-item'), null);
  assert.equal(doc.querySelector('.settings-badge'), null);
});

test('auto-index and folder rows reflect saved policy and disclose folder controls in place', () => {
  const { doc } = renderHarness();
  const auto = doc.querySelector('[data-inv-segmented="skillsAutoIndexToggle"]');
  assert.equal(auto.querySelector('[aria-checked="true"]').dataset.value, 'auto', 'auto policy reads Auto');
  assert.match(auto.closest('[data-settings-field="skillsAutoIndexToggle"]').textContent,
    /Auto: on for cloud models, off for local models/);
  const manage = doc.querySelector('[data-skills-action="toggle-folders"]');
  const disclosure = doc.querySelector('[data-skills-folders-region]');
  assert.equal(manage.getAttribute('aria-expanded'), 'false');
  assert.equal(disclosure.hidden, true);
  manage.click();
  assert.equal(disclosure.hidden, true, 'the settings binder owns click delegation');
  assert.match(doc.querySelector('.skills-folders-summary').textContent,
    /\.companion\\skills · on · no workspace root · off/);
  assert.ok(disclosure.querySelector('[data-inv-toggle="skillsUserToggle"]'));
  assert.equal(disclosure.querySelector('[data-skills-scope="project"]').disabled, true);
});

test('skipped files collapse to one bounded warning and kill-switch off has no master toggle', () => {
  const warningPayload = skillsPayload({ warnings: [
    { message: 'First warning' }, { message: 'Second warning' },
  ] });
  const warned = renderHarness(warningPayload).doc;
  assert.equal(warned.querySelectorAll('[data-skills-warning]').length, 1);
  assert.equal(warned.querySelector('[data-skills-warning]').textContent,
    '2 skill files skipped: First warning');

  const off = renderHarness(skillsPayload({ featureEnabled: false })).doc;
  assert.match(off.getElementById('skillsRowsHost').textContent,
    /JENNY_ENABLE_SKILLS_SYSTEM kill switch/);
  assert.equal(off.querySelector('[data-inv-toggle]'), null);
  assert.equal(off.getElementById('skillsFoldersHost').textContent, '');
});

function bindHarness({ disabledSkillIds = ['bundled/verify'] } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <section id="skillsSettingsSection">
      <button data-skills-action="toggle-folders" aria-expanded="false">Manage</button>
      <div data-skills-folders-region hidden>
        <button data-skills-action="open-folder" data-skills-scope="user">Open folder</button>
        <button data-skills-action="open-folder" data-skills-scope="project" disabled>Open folder</button>
      </div>
    </section>
  </body>`);
  const doc = dom.window.document;
  const state = { skills: { settings: { disabledSkillIds } } };
  const calls = { updateSkillsSettings: [], openSkillsScopeFolder: [] };
  const binders = createSettingsSectionBinders({
    state,
    constants: {},
    callbacks: {
      // Like the skills controller: apply the echoed settings, resolve nothing.
      updateSkillsSettings: (patch) => {
        calls.updateSkillsSettings.push(patch);
        state.skills.settings = { ...state.skills.settings, ...patch };
        return Promise.resolve();
      },
      openSkillsScopeFolder: (scope) => calls.openSkillsScopeFolder.push(scope),
    },
    getLazySectionDom: (id) => (id === 'skills'
      ? { skillsSettingsSection: doc.getElementById('skillsSettingsSection') }
      : {}),
  });
  binders.bindSection('skills', {
    registerSectionListener: (target, eventName, handler) => target?.addEventListener(eventName, handler),
    finalizeSectionBindings: () => {},
  });
  function fire(type, detail) {
    doc.getElementById('skillsSettingsSection').dispatchEvent(
      new dom.window.CustomEvent(type, { bubbles: true, detail })
    );
  }
  const fireToggle = (detail) => fire('inv-toggle-change', detail);
  const fireSegmented = (detail) => fire('inv-segmented-change', detail);
  return { dom, doc, state, calls, fireToggle, fireSegmented };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/* The rendered skills manager and the section binder together, with an
 * updateSkillsSettings that behaves like the skills controller: apply the
 * echoed settings, repaint, hand the payload back. `echo` decides what comes
 * back; `drop` names settings the payload leaves out. */
function autoIndexHarness({ autoIndex = 'auto', echo = (patch) => patch, drop = [] } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <section id="skillsSettingsSection">
      <div id="skillsRowsHost"></div>
      <div id="skillsFoldersHost"></div>
    </section>
  </body>`);
  const doc = dom.window.document;
  segmentedControl.initSegmentedHandlers(doc);
  const section = doc.getElementById('skillsSettingsSection');
  const state = {};
  const calls = [];
  let manager = null;
  const renderSettings = () => manager.renderSkillsManager();
  manager = createSkillsManager({
    state,
    constants: { TOAST_SOURCE: { settings: 'settings' } },
    dom: { skillsSettingsSection: section },
    callbacks: { escapeHtml, renderSettings, showToastMessage() {}, showShellErrorToast() {},
      toErrorMessage(_error, fallback) { return fallback; } },
  });
  const base = skillsPayload();
  manager.applySkillsPayload({ ...base, settings: { ...base.settings, autoIndex } });
  renderSettings();
  const binders = createSettingsSectionBinders({
    state,
    constants: {},
    callbacks: {
      renderSettings,
      updateSkillsSettings: async (patch) => {
        calls.push(patch);
        const settings = { ...state.skills.settings, ...echo(patch) };
        drop.forEach((key) => { delete settings[key]; });
        const payload = { ...base, settings };
        manager.applySkillsPayload(payload);
        renderSettings();
        return payload;
      },
    },
    getLazySectionDom: (id) => (id === 'skills' ? { skillsSettingsSection: section } : {}),
  });
  binders.bindSection('skills', {
    registerSectionListener: (target, eventName, handler) => target?.addEventListener(eventName, handler),
    finalizeSectionBindings: () => {},
  });
  const row = () => doc.querySelector('[data-settings-field="skillsAutoIndexToggle"]');
  const selected = () => row().querySelector('[data-inv-segmented="skillsAutoIndexToggle"] [aria-checked="true"]')?.dataset.value;
  const choose = (value) => row().querySelector(`.inv-segmented-option[data-value="${value}"]`).click();
  return { doc, state, calls, row, selected, choose };
}

test('stored auto renders Auto selected and choosing On then Auto writes on then auto', async () => {
  const h = autoIndexHarness();
  assert.equal(h.selected(), 'auto');
  assert.equal(h.row().querySelector('.settings-field-meta-modified').hidden, true);
  assert.equal(h.row().querySelector('[data-setting-revert]'), null);
  h.choose('on');
  await settle();
  assert.equal(h.selected(), 'on');
  assert.match(h.row().textContent, /Modified/);
  h.choose('auto');
  await settle();
  assert.deepEqual(h.calls, [{ autoIndex: 'on' }, { autoIndex: 'auto' }]);
  assert.equal(h.selected(), 'auto');
  assert.equal(h.state.skills.settings.autoIndex, 'auto');
  // A stored value outside the three hydrates as Auto.
  assert.equal(autoIndexHarness({ autoIndex: 'sometimes' }).selected(), 'auto');
});

test('an auto-index save the controller does not echo returns the control to the acknowledged option', async () => {
  const h = autoIndexHarness({ autoIndex: 'off', echo: () => ({}) });
  h.choose('on');
  await settle();
  assert.deepEqual(h.calls, [{ autoIndex: 'on' }]);
  assert.equal(h.selected(), 'off');
  assert.equal(h.state.skills.settings.autoIndex, 'off');
  assert.equal(h.row().dataset.state, 'error');
  assert.match(h.row().querySelector('.settings-field-error').textContent, /could not be confirmed/);
  assert.equal(h.row().querySelector('.inv-segmented-option[data-value="on"]').disabled, false, 'not left busy');
});

test('a Revert answered without the setting is refused, not read as the default', async () => {
  const h = autoIndexHarness({ autoIndex: 'on', drop: ['autoIndex'] });
  h.row().querySelector('[data-setting-revert="skillsAutoIndexToggle"]').click();
  await settle();
  assert.deepEqual(h.calls, [{ autoIndex: 'auto' }]);
  assert.equal(h.selected(), 'on');
  assert.equal(h.state.skills.settings.autoIndex, 'on');
  assert.equal(h.row().dataset.state, 'error');
});

test('Revert on a stored off writes auto', async () => {
  const h = autoIndexHarness({ autoIndex: 'off' });
  assert.match(h.row().textContent, /Modified/);
  h.row().querySelector('[data-setting-revert="skillsAutoIndexToggle"]').click();
  await settle();
  assert.deepEqual(h.calls, [{ autoIndex: 'auto' }]);
  assert.equal(h.selected(), 'auto');
  assert.equal(h.row().querySelector('[data-setting-revert]'), null);
});

test('per-skill switch adds and removes disabledSkillIds without losing other ids', async () => {
  const h = bindHarness({ disabledSkillIds: ['bundled/verify', 'user/keep-off'] });
  h.fireToggle({ id: 'skillToggle:bundled/verify', checked: true });
  assert.deepEqual(h.calls.updateSkillsSettings[0], { disabledSkillIds: ['user/keep-off'] });
  await settle();
  h.fireToggle({ id: 'skillToggle:bundled/verify', checked: false });
  assert.deepEqual(h.calls.updateSkillsSettings[1],
    { disabledSkillIds: ['user/keep-off', 'bundled/verify'] });
});

/* The rendered rows and the section binder with a skills controller whose
 * acknowledgements the test releases by hand (or fails). */
function skillSwitchHarness() {
  const dom = new JSDOM(`<!doctype html><body>
    <section id="skillsSettingsSection">
      <div id="skillsRowsHost"></div>
      <div id="skillsFoldersHost"></div>
    </section>
  </body>`);
  const doc = dom.window.document;
  const section = doc.getElementById('skillsSettingsSection');
  const state = {};
  const pending = [];
  let manager = null;
  const renderSettings = () => manager.renderSkillsManager();
  manager = createSkillsManager({
    state,
    constants: { TOAST_SOURCE: { settings: 'settings' } },
    dom: { skillsSettingsSection: section },
    callbacks: { escapeHtml, renderSettings, showToastMessage() {}, showShellErrorToast() {},
      toErrorMessage(_error, fallback) { return fallback; } },
  });
  const base = skillsPayload({ scopes: [
    { scope: 'bundled', label: 'Bundled', enabled: true, status: 'ready', path: 'G:\\bundled',
      entries: [skill('bundled/verify', 'Verify'), skill('bundled/plan', 'Plan')], warnings: [] },
  ] });
  function payloadFor(disabledSkillIds) {
    return { ...base, settings: { ...base.settings, disabledSkillIds },
      scopes: base.scopes.map((scope) => ({ ...scope, entries: scope.entries.map((entry) => (
        { ...entry, enabled: !disabledSkillIds.includes(entry.id) })) })) };
  }
  manager.applySkillsPayload(payloadFor([]));
  renderSettings();
  const binders = createSettingsSectionBinders({
    state,
    constants: {},
    callbacks: {
      renderSettings,
      // Like the skills controller: apply and repaint on success, resolve
      // nothing on a failure it has already toasted.
      updateSkillsSettings: (patch) => new Promise((resolve) => {
        pending.push({ patch, ok: () => {
          const payload = payloadFor(patch.disabledSkillIds);
          manager.applySkillsPayload(payload);
          renderSettings();
          resolve(payload);
        }, fail: () => resolve(undefined) });
      }),
    },
    getLazySectionDom: (id) => (id === 'skills' ? { skillsSettingsSection: section } : {}),
  });
  binders.bindSection('skills', {
    registerSectionListener: (target, eventName, handler) => target?.addEventListener(eventName, handler),
    finalizeSectionBindings: () => {},
  });
  // What the inventory switch does on a click: flip, then announce.
  function flip(skillId) {
    const control = doc.querySelector(`[data-inv-toggle="skillToggle:${skillId}"]`);
    const checked = control.getAttribute('aria-checked') !== 'true';
    control.setAttribute('aria-checked', String(checked));
    section.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
      bubbles: true, detail: { id: `skillToggle:${skillId}`, checked },
    }));
  }
  const shown = (skillId) => doc.querySelector(`[data-inv-toggle="skillToggle:${skillId}"]`)
    .getAttribute('aria-checked');
  return { state, pending, flip, shown };
}

test('two quick per-skill switches both land: the second write builds on the first', async () => {
  const h = skillSwitchHarness();
  h.flip('bundled/verify');
  h.flip('bundled/plan');
  assert.deepEqual(h.pending.map((write) => write.patch), [{ disabledSkillIds: ['bundled/verify'] }],
    'the second write waits for the first acknowledgement');
  h.pending[0].ok();
  await settle();
  assert.deepEqual(h.pending[1].patch, { disabledSkillIds: ['bundled/verify', 'bundled/plan'] });
  h.pending[1].ok();
  await settle();
  assert.deepEqual(h.state.skills.settings.disabledSkillIds, ['bundled/verify', 'bundled/plan']);
  assert.equal(h.shown('bundled/verify'), 'false');
  assert.equal(h.shown('bundled/plan'), 'false');
});

test('a per-skill switch whose save fails returns to the saved state', async () => {
  const h = skillSwitchHarness();
  h.flip('bundled/verify');
  assert.equal(h.shown('bundled/verify'), 'false');
  h.pending[0].fail();
  await settle();
  assert.equal(h.shown('bundled/verify'), 'true');
  assert.deepEqual(h.state.skills.settings.disabledSkillIds, []);
  // The queue is not stuck behind the failure.
  h.flip('bundled/plan');
  assert.deepEqual(h.pending[1].patch, { disabledSkillIds: ['bundled/plan'] });
});

test('auto-index choice emits explicit values and folder scope switches retain their settings keys', async () => {
  const h = bindHarness();
  // Every skills preference shares one adapter: each write waits for the
  // previous acknowledgement.
  h.fireSegmented({ id: 'skillsAutoIndexToggle', value: 'on' });
  await settle();
  h.fireSegmented({ id: 'skillsAutoIndexToggle', value: 'off' });
  await settle();
  h.fireToggle({ id: 'skillsUserToggle', checked: false });
  await settle();
  h.fireToggle({ id: 'skillsProjectToggle', checked: true });
  assert.deepEqual(h.calls.updateSkillsSettings, [
    { autoIndex: 'on' },
    { autoIndex: 'off' },
    { userEnabled: false },
    { projectEnabled: true },
  ]);
});

test('folder Manage disclosure and Open folder use section-level delegation', () => {
  const h = bindHarness();
  const manage = h.doc.querySelector('[data-skills-action="toggle-folders"]');
  const disclosure = h.doc.querySelector('[data-skills-folders-region]');
  manage.click();
  assert.equal(disclosure.hidden, false);
  assert.equal(manage.getAttribute('aria-expanded'), 'true');
  // open-folder is dispatched by the settings-view listener in
  // renderer-settings-event-utils.js, not by the section binder.
  h.doc.querySelector('[data-skills-scope="user"]').click();
  assert.deepEqual(h.calls.openSkillsScopeFolder, []);
  assert.equal(h.doc.querySelector('[data-skills-scope="project"]').disabled, true);
  manage.click();
  assert.equal(disclosure.hidden, true);
  assert.equal(manage.getAttribute('aria-expanded'), 'false');
});
