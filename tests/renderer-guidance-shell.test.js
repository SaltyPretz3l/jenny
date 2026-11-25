const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
  openSettingsView,
} = require('./helpers/renderer-shell-harness');

test('renderer shows skills in Extensions and retires the Tips settings section', async (t) => {
  const { window } = await loadRendererApp({
    shell: {
      skills: {
        async getState() {
          return {
            featureEnabled: true,
            settings: {
              bundledEnabled: true,
              userEnabled: true,
              projectEnabled: false,
            },
            scopes: [],
            counts: { total: 2, always: 1 },
          };
        },
      },
    },
  });
  t.after(async () => {
    await window.close();
  });

  await waitForUi(window, 40);

  // Skills remains merged into Extensions. Tips moved to one Home
  // preference and no longer owns a Settings section.
  assert.equal(window.document.getElementById('skillsSettingsNavItem'), null);
  assert.equal(window.document.getElementById('skillsSettingsSection').hidden, false);
  assert.equal(window.document.getElementById('tipsSettingsNavItem'), null);
  assert.equal(window.document.getElementById('tipsSettingsSection'), null);
  assert.equal(window.document.getElementById('promptGrid'), null);
});

test('renderer keeps Tools settings navigation available without a workspace tip chip', async (t) => {
  const { window } = await loadRendererApp();
  t.after(async () => {
    await window.close();
  });

  await waitForUi(window, 40);

  assert.equal(window.document.querySelector('[data-tip-settings]'), null);
  window.document.querySelector('nav.settings-nav [data-settings-section="tools"]').click();
  await waitForUi(window, 40);

  const activeSection = window.document.querySelector('.settings-section-active');
  assert.equal(activeSection?.dataset.settingsSection, 'tools');
});

test('renderer keeps Home navigation and skill actions available without tip chips', async (t) => {
  const skillActions = [];
  const { window } = await loadRendererApp({
    shell: {
      skills: {
        async getState() {
          return {
            featureEnabled: true,
            settings: {
              bundledEnabled: true,
              userEnabled: true,
              projectEnabled: true,
            },
            scopes: [
              {
                scope: 'user',
                label: 'User',
                path: 'C:/Users/test/.companion/skills',
                enabled: true,
                status: 'ready',
                message: '1 skill available.',
                entries: [
                  {
                    scope: 'user',
                    name: 'My Skill',
                    description: 'Local guidance.',
                    whenToUse: 'When I need personal workflow rules.',
                    allowedTools: ['read_file'],
                    always: false,
                    path: 'C:/Users/test/.companion/skills/my-skill/SKILL.md',
                    relPath: 'my-skill/SKILL.md',
                  },
                ],
              },
            ],
            counts: { total: 1, always: 0 },
          };
        },
        async openScopeFolder(scope) {
          skillActions.push(scope);
          return {
            featureEnabled: true,
            settings: {
              bundledEnabled: true,
              userEnabled: true,
              projectEnabled: true,
            },
            scopes: [],
            counts: { total: 1, always: 0 },
          };
        },
      },
    },
  });
  t.after(async () => {
    await window.close();
  });
  await openSettingsView(window);

  await waitForUi(window, 40);

  assert.equal(window.document.querySelector('[data-tip-settings]'), null);
  // Row 133: Home's Quick capture group lives on General.
  window.document.querySelector('nav.settings-nav [data-settings-section="general"]').click();
  await waitForUi(window, 40);

  const activeSection = window.document.querySelector('.settings-section-active');
  assert.equal(activeSection?.dataset.settingsSection, 'general');

  // Skills opens via its Plugins host (the standalone skills nav item is gone); its
  // disclosed folder actions still call through to the shell.
  window.document.querySelector('nav.settings-nav [data-settings-section="extensions"]').click();
  await waitForUi(window, 30);
  window.document.querySelector('[data-skills-action="toggle-folders"]').click();
  window.document.querySelector('[data-skills-action="open-folder"][data-skills-scope="user"]').click();
  await waitForUi(window, 30);

  assert.ok(skillActions.length > 0);
  assert.deepEqual([...new Set(skillActions)], ['user']);
});

test('renderer shows an error toast when opening a skill folder fails', async (t) => {
  const { window } = await loadRendererApp({
    shell: {
      skills: {
        async getState() {
          return {
            featureEnabled: true,
            settings: {
              bundledEnabled: true,
              userEnabled: true,
              projectEnabled: true,
            },
            scopes: [
              {
                scope: 'user',
                label: 'User',
                path: 'C:/Users/test/.companion/skills',
                enabled: true,
                status: 'empty',
                message: 'No skills found in this folder yet.',
                entries: [],
              },
            ],
            counts: { total: 0, always: 0, warnings: 0 },
          };
        },
        async openScopeFolder() {
          throw new Error('simulated shell.openPath failure');
        },
      },
    },
  });
  t.after(async () => {
    await window.close();
  });
  await openSettingsView(window);

  await waitForUi(window, 40);
  // Skills opens via its Tools host now (the standalone skills nav item is gone).
  window.document.querySelector('nav.settings-nav [data-settings-section="tools"]').click();
  await waitForUi(window, 30);
  window.document.querySelector('[data-skills-action="open-folder"]').click();
  await waitForUi(window, 30);

  const toastViewport = window.document.getElementById('toastViewport');
  assert.match(toastViewport.textContent, /skills folder failed/i);
  assert.match(toastViewport.textContent, /simulated shell\.openPath failure/i);
});

test('renderer refreshes skills without rendering tip chips', async (t) => {
  const { window, shell } = await loadRendererApp({
    shell: {
      skills: {
        async getState() {
          return {
            featureEnabled: true,
            settings: {
              bundledEnabled: true,
              userEnabled: true,
              projectEnabled: true,
            },
            scopes: [],
            warnings: [],
            counts: { total: 0, always: 0, warnings: 0 },
          };
        },
      },
    },
  });
  t.after(async () => {
    await window.close();
  });
  await openSettingsView(window);

  await waitForUi(window, 40);
  assert.equal(window.document.getElementById('promptGrid'), null);

  await shell.__emitSkillsChanged({
    featureEnabled: true,
    settings: {
      bundledEnabled: true,
      userEnabled: true,
      projectEnabled: true,
    },
    scopes: [],
    warnings: [
      {
        scope: 'user',
        code: 'skill_load_failed',
        path: 'C:/Users/test/.companion/skills/broken/SKILL.md',
        message: 'Simulated load warning.',
      },
    ],
    counts: { total: 1, always: 0, warnings: 1 },
  });
  await waitForUi(window, 40);

  assert.match(
    window.document.querySelector('#skillsRowsHost [data-skills-warning]')?.textContent || '',
    /1 skill file skipped: Simulated load warning\./i,
  );
  assert.equal(window.document.getElementById('tipsCurrentPreview'), null);
  assert.equal(window.__rendererState.tips, undefined, 'the retired tips cache is gone');
  assert.equal(window.document.getElementById('promptGrid'), null);
});

test('renderer exposes consolidated salvage feature controls in settings', async (t) => {
  const { window } = await loadRendererApp({
    shell: {
      skills: {
        async getState() {
          return {
            featureEnabled: true,
            settings: {
              bundledEnabled: true,
              userEnabled: true,
              projectEnabled: false,
            },
            scopes: [
              {
                scope: 'bundled',
                label: 'Bundled',
                path: 'resources/skills',
                enabled: true,
                status: 'ready',
                entries: [
                  {
                    id: 'bundled:salvage-skill',
                    scope: 'bundled',
                    name: 'Salvage Skill',
                    command: 'salvage-skill',
                    description: 'Test skill control.',
                    enabled: true,
                    allowedTools: [],
                  },
                ],
              },
            ],
            warnings: [],
          };
        },
      },
      features: {
        async getState() {
          return {
            tools: {
              web: true,
              mermaid: true,
              imageRead: true,
              pythonRuntime: true,
              todo: false,
            },
            featureFlags: {
              tips_surface: true,
              token_budget: true,
              context_compaction: false,
              api_retry: true,
              prompt_cache: true,
              tool_search: false,
              skills_system: true,
              shell_security: true,
              git_tracking: false,
            },
            featureOverrides: {
              context_compaction: false,
              tool_search: false,
              git_tracking: false,
            },
            availability: {
              runtime: {
                managedSidecarActive: true,
                windowsOnly: true,
                workspaceRootStatus: {
                  state: 'ready',
                  message: 'Workspace root is configured.',
                },
              },
              tools: {
                web: { enabled: true, managedSidecarRequired: true },
                mermaid: { enabled: true, managedSidecarRequired: true },
                imageRead: { enabled: true, managedSidecarRequired: true },
                pythonRuntime: { enabled: true, managedSidecarRequired: true, windowsOnly: true },
                todo: { enabled: true, managedSidecarRequired: true, workspaceRootRequired: true },
                glob_files: { enabled: true, managedSidecarRequired: true, workspaceRootRequired: true },
                grep_search: { enabled: true, managedSidecarRequired: true, workspaceRootRequired: true },
                edit_file: { enabled: true, managedSidecarRequired: true, workspaceRootRequired: true },
                shell: { enabled: true, managedSidecarRequired: true, workspaceRootRequired: true },
                background_shell: { enabled: true, managedSidecarRequired: true, workspaceRootRequired: true },
                checkpoint_backups: { enabled: true, electronOnly: true, workspaceRootRequired: true },
              },
              featureFlags: {},
            },
          };
        },
      },
    },
  });
  t.after(async () => {
    await window.close();
  });
  await openSettingsView(window);

  await waitForUi(window, 50);

  const toolToggle = (key) =>
    window.document.querySelector(`[data-inv-toggle="settings-tool-config-${key}"]`);

  assert.equal(window.document.getElementById('usageSettingsNavItem').hidden, false);
  assert.equal(toolToggle('web')?.getAttribute('aria-checked'), 'true');
  assert.equal(toolToggle('mermaid'), null, 'Mermaid is always on and hidden');
  assert.equal(toolToggle('imageRead')?.getAttribute('aria-checked'), 'true');
  assert.equal(toolToggle('pythonRuntime')?.getAttribute('aria-checked'), 'true');
  assert.equal(toolToggle('todo'), null, 'Todo is always on and hidden');
  assert.equal(window.document.querySelector('[data-inv-toggle="contextCompactionToggle"]')?.getAttribute('aria-checked'), 'false');
  assert.equal(window.document.querySelector('[data-inv-toggle="contextToolSearchToggle"]'), null);
  assert.equal(window.document.querySelector('[data-inv-toggle="skillToggle:bundled:salvage-skill"]')?.getAttribute('aria-checked'), 'true');
  assert.equal(window.document.querySelector('[data-inv-toggle="costTrackingToggle"]'), null);
  assert.match(window.document.getElementById('usageSettingsSection').textContent, /Usage/);
  assert.equal(window.document.querySelector('[data-inv-toggle="tipsSurfaceToggle"]'), null);
  assert.equal(window.document.getElementById('toolsStatusList'), null, 'core status belongs to Diagnostics');
});

test('renderer tools settings shows a workspace-root CTA when workspace-aware tools are blocked', async (t) => {
  const { window } = await loadRendererApp({
    shell: {
      workspaceRoot: {
        async getState() {
          return {
            workspaceRoot: '',
            workspaceRootStatus: {
              state: 'missing',
              message: 'No workspace root is configured yet.',
            },
          };
        },
      },
      features: {
        async getState() {
          return {
            availability: {
              runtime: {
                managedSidecarActive: true,
                windowsOnly: true,
                workspaceRootStatus: {
                  state: 'missing',
                  message: 'No workspace root is configured yet.',
                },
              },
              tools: {
                glob_files: { enabled: false, managedSidecarRequired: true, workspaceRootRequired: true },
                grep_search: { enabled: false, managedSidecarRequired: true, workspaceRootRequired: true },
                edit_file: { enabled: false, managedSidecarRequired: true, workspaceRootRequired: true },
                shell: { enabled: false, managedSidecarRequired: true, workspaceRootRequired: true },
                background_shell: { enabled: false, managedSidecarRequired: true, workspaceRootRequired: true },
                checkpoint_backups: { enabled: false, electronOnly: true, workspaceRootRequired: true },
              },
              featureFlags: {},
            },
          };
        },
      },
    },
  });
  t.after(async () => {
    await window.close();
  });
  await openSettingsView(window);

  await waitForUi(window, 40);

  assert.equal(window.document.getElementById('toolsWorkspaceChooseButton').textContent, 'Open Workspace');
  assert.match(window.document.getElementById('toolsWorkspaceStatus').textContent, /unlock workspace-aware tools/i);
  assert.equal(window.document.getElementById('toolsStatusList'), null);
});

test('tools card keeps authority and internal guardrail controls out of Settings', async (t) => {
  const { window } = await loadRendererApp();
  t.after(async () => {
    await window.close();
  });
  await waitForUi(window, 40);
  const doc = window.document;
  const card = doc.querySelector('section.settings-card[data-settings-section="tools"]');

  const groups = card.querySelectorAll('#toolsConfigFieldList > .settings-group');
  assert.deepEqual(Array.from(groups, (group) => group.getAttribute('aria-labelledby')), [
    'toolsFilesHeading', 'toolsWebHeading', 'toolsComputerHeading', 'toolsCodeHeading',
  ]);
  for (const group of groups) {
    assert.equal(group.getAttribute('role'), 'group');
    const headingId = group.getAttribute('aria-labelledby');
    assert.ok(headingId && doc.getElementById(headingId), `group heading ${headingId} resolves`);
  }

  assert.equal(doc.getElementById('toolsApprovalList'), null);
  assert.equal(doc.getElementById('toolsFeatureList'), null);
  assert.equal(doc.querySelector('[data-inv-toggle="toolsShellSecurityToggle"]'), null);
  assert.equal(doc.querySelector('[data-inv-toggle="toolsGitTrackingToggle"]'), null);
});

test('personality card groups canonical profile and advanced identity documents', async (t) => {
  const { window } = await loadRendererApp();
  t.after(async () => {
    await window.close();
  });
  await waitForUi(window, 40);
  const doc = window.document;
  const card = doc.querySelector('section.settings-card[data-settings-section="personality"]');
  assert.ok(card);

  // Personality v3 is one flat card: no nested settings-group, no <details>,
  // no badge -- one form host, one status line, one footer.
  assert.equal(card.querySelectorAll(':scope > .settings-group').length, 0);
  assert.equal(card.querySelectorAll('details').length, 0);
  assert.equal(card.querySelector('.settings-badge'), null);
  assert.ok(doc.getElementById('personalityFormHost'));
  assert.ok(doc.getElementById('personalityActions'));
  assert.equal(doc.getElementById('personalityStatus').getAttribute('aria-live'), 'polite');
  assert.equal(doc.getElementById('personalityPresetSelect'), null);
  assert.equal(doc.getElementById('personalityTabs'), null);
});

test('General keeps Home as one labelled Quick capture group and retires layout settings', async (t) => {
  const { window } = await loadRendererApp();
  t.after(async () => {
    await window.close();
  });
  await waitForUi(window, 40);
  const doc = window.document;
  // Row 133: the Home card is General's Quick capture group, beside Language and text, You and Machine status.
  const card = doc.querySelector('section.settings-card[data-settings-section="general"]');
  assert.ok(card);
  assert.equal(doc.querySelector('section.settings-card[data-settings-section="home"]'), null);

  const groups = card.querySelectorAll(':scope > .settings-group');
  assert.deepEqual([...groups].map(group => group.getAttribute('data-settings-merged-section')), [null, null, 'home', null]);
  const homeGroup = groups[2];
  assert.equal(doc.getElementById(homeGroup.getAttribute('aria-labelledby'))?.textContent.trim(), 'Quick capture');
  assert.ok(homeGroup.querySelector('#homeSettingsFieldList'));
  for (const group of groups) {
    assert.equal(group.getAttribute('role'), 'group');
    const headingId = group.getAttribute('aria-labelledby');
    assert.ok(headingId && doc.getElementById(headingId), `group heading ${headingId} resolves`);
  }
  assert.equal(card.querySelector('#settingsSidebarToggleList'), null);
  assert.equal(card.querySelector('#scratchpadFontSelect'), null);
});

test('Local use is one labelled group on Models: two switch rows, the readiness in the help line', async (t) => {
  const { window } = await loadRendererApp();
  t.after(async () => {
    await window.close();
  });
  await waitForUi(window, 40);
  const doc = window.document;
  assert.equal(doc.querySelector('section.settings-card[data-settings-section="offline"]'), null);
  const card = doc.querySelector('section.settings-card[data-settings-section="models"]');
  const group = card.querySelector(':scope > .settings-group[data-settings-merged-section="offline"]');
  assert.ok(group);
  assert.equal(group.getAttribute('role'), 'group');
  const headingId = group.getAttribute('aria-labelledby');
  assert.equal(doc.getElementById(headingId)?.textContent, 'Local use');
  assert.ok(group.querySelector('#offlineLocalOnlyList') && group.querySelector('#modelStartupLoadList'));
  for (const id of ['offlineSummary', 'offlineStatus', 'offlineModelStatus']) assert.equal(group.querySelector(`#${id}`), null, id);
  assert.equal(group.querySelector('.settings-group-copy'), null, 'the boundary sits behind the row\'s ?');
  assert.equal(doc.querySelector('[data-action="openOfflineModelLibrary"]'), null);
  assert.equal(doc.getElementById('offlineLocalModelSelect'), null);
  assert.equal(doc.getElementById('localEnginesContainer'), null);
});

test('the local profile editor is General\'s labelled You group; data, setup and updates sit on their own pages', async (t) => {
  const { window } = await loadRendererApp();
  t.after(async () => {
    await window.close();
  });
  await openSettingsView(window);
  await waitForUi(window, 40);
  const doc = window.document;
  // Row 133 split the old Profile page: the profile editor is General > You, setup is on Readiness,
  // About & updates has its own page, and the `account` card is Data & privacy.
  const card = doc.querySelector('section.settings-card[data-settings-section="account"]');
  assert.ok(card);

  const groups = card.querySelectorAll(':scope > .settings-group');
  assert.deepEqual([...groups].map(group => group.getAttribute('data-settings-merged-section')), [null, 'dataPrivacy', null, null]);
  // Row 93 added the Your data group; the settings live review (2026-10-03) gave uninstall its own closing group.
  assert.ok(groups[0].querySelector('#dataStorageMount'));
  assert.ok(groups[1].querySelector('#dataLifecycleSettingsMount'));
  assert.ok(groups[3].querySelector('#dataLifecycleRemoveMount'));
  assert.equal(doc.querySelector('.settings-card[data-settings-section="dataPrivacy"]'), null, 'a folded-in section has no card of its own');
  const aboutCard = doc.querySelector('section.settings-card[data-settings-section="aboutUpdates"]');
  assert.ok(aboutCard.querySelector('#checkUpdatesButton'));
  assert.equal(card.querySelector('#checkUpdatesButton'), null);

  const profileGroup = doc.getElementById('localProfileDisplayName').closest('.settings-group');
  assert.equal(profileGroup.closest('section.settings-card').getAttribute('data-settings-section'), 'general');
  assert.equal(profileGroup.getAttribute('role'), 'group');
  const headingId = profileGroup.getAttribute('aria-labelledby');
  assert.equal(doc.getElementById(headingId)?.textContent.trim(), 'You');
  assert.ok(profileGroup.querySelector('[data-action="save-local-profile"]'));
  assert.equal(card.querySelector('#localProfileDisplayName'), null);
  assert.equal(doc.getElementById('openAuthButton'), null);
  assert.equal(doc.getElementById('settingsLogoutButton'), null);
  const readinessCard = doc.querySelector('section.settings-card[data-settings-section="readiness"]');
  assert.ok(readinessCard.querySelector('.settings-setup-row #setupSettingsActions'));
  assert.equal(card.querySelector('#setupSettingsActions'), null);
  assert.equal(doc.getElementById('accountSummary').getAttribute('aria-live'), 'polite');
});

test('profile copy states local-profile truth, not the old cloud-features claim', async (t) => {
  const { window } = await loadRendererApp();
  t.after(async () => {
    await window.close();
  });
  await waitForUi(window, 40);
  const doc = window.document;
  // Row 133: the profile copy lives in General's You group.
  const card = doc.getElementById('localProfileSettingsMount').closest('.settings-group');
  assert.ok(card);
  const cardText = card.textContent;

  assert.match(cardText, /runs locally/i);
  assert.match(cardText, /without an account/i);
  assert.match(cardText, /stored on this device/i);
  assert.doesNotMatch(cardText, /cloud models/i);
  assert.doesNotMatch(cardText, /streaming chat/i);
  assert.doesNotMatch(cardText, /connect a backend account to turn on cloud features/i);
});
