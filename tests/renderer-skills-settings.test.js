'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSkillsManager } = require('../renderer/features/renderer-skills-utils');
const { createSettingsSectionBinders } = require('../renderer/shell/renderer-settings-section-binders');

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
  const auto = doc.querySelector('[data-inv-toggle="skillsAutoIndexToggle"]');
  assert.equal(auto.getAttribute('aria-checked'), 'false', 'auto policy reads unchecked');
  assert.match(auto.closest('.settings-field-row').textContent,
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
      updateSkillsSettings: (patch) => calls.updateSkillsSettings.push(patch),
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
  function fireToggle(detail) {
    doc.getElementById('skillsSettingsSection').dispatchEvent(
      new dom.window.CustomEvent('inv-toggle-change', { bubbles: true, detail })
    );
  }
  return { dom, doc, state, calls, fireToggle };
}

test('per-skill switch adds and removes disabledSkillIds without losing other ids', () => {
  const h = bindHarness({ disabledSkillIds: ['bundled/verify', 'user/keep-off'] });
  h.fireToggle({ id: 'skillToggle:bundled/verify', checked: true });
  assert.deepEqual(h.calls.updateSkillsSettings[0], { disabledSkillIds: ['user/keep-off'] });
  h.state.skills.settings.disabledSkillIds = ['user/keep-off'];
  h.fireToggle({ id: 'skillToggle:bundled/verify', checked: false });
  assert.deepEqual(h.calls.updateSkillsSettings[1],
    { disabledSkillIds: ['user/keep-off', 'bundled/verify'] });
});

test('auto-index switch emits explicit on/off and folder scope switches retain their settings keys', () => {
  const h = bindHarness();
  h.fireToggle({ id: 'skillsAutoIndexToggle', checked: true });
  h.fireToggle({ id: 'skillsAutoIndexToggle', checked: false });
  h.fireToggle({ id: 'skillsUserToggle', checked: false });
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
