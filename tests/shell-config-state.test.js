const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONFIG_VERSION,
  DEFAULT_CODEX_CLI,
  WEB_SEARCH_PROVIDER_IDS,
  normalizeState,
  normalizeCodexCliSettings,
  normalizeSkillSettings,
  normalizeWebSearchSettings,
  normalizeWindowUiSettings,
  normalizeWindowUiZoomPercent,
  serializeState,
} = require('../services/shell-config-state');

test('shell config state migrates codex CLI defaults and drops active frontier config', () => {
  const state = normalizeState({
    version: 15,
    frontierDiagnostics: { enabled: true, model: 'gpt-5-mini' },
  });

  assert.equal(CONFIG_VERSION, 51);
  assert.deepEqual(state.codexCli, DEFAULT_CODEX_CLI);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'frontierDiagnostics'), false);
});

test('v44 revokes implicit personal and project skill trust once', () => {
  const migrated = normalizeState({
    version: 43,
    skills: { bundledEnabled: true, userEnabled: true, projectEnabled: true },
  });
  assert.deepEqual(migrated.skills, {
    bundledEnabled: true,
    userEnabled: false,
    projectEnabled: false,
    disabledSkillIds: [],
    autoIndex: 'auto',
  });
  const explicit = normalizeState({
    version: 44,
    skills: { bundledEnabled: true, userEnabled: true, projectEnabled: true },
  });
  assert.equal(explicit.skills.userEnabled, true);
  assert.equal(explicit.skills.projectEnabled, true);
});

test('skill settings normalize bounded ids and auto-index policy aliases', () => {
  const manyIds = Array.from({ length: 260 }, (_value, index) => `bundled/skill_${index}`);
  const normalized = normalizeSkillSettings({
    disabledSkillIds: [
      ' bundled/ops ',
      'bundled/ops',
      'user/team/review.v2',
      'project/a/b/c/d/e/f/g/h',
      'project/a/b/c/d/e/f/g/h/i',
      'workspace/nope',
      'bundled/.hidden',
      42,
      ...manyIds,
    ],
    autoIndex: 'on',
  });

  assert.deepEqual(normalized.disabledSkillIds.slice(0, 3), [
    'bundled/ops',
    'user/team/review.v2',
    'project/a/b/c/d/e/f/g/h',
  ]);
  assert.equal(normalized.disabledSkillIds.length, 256);
  assert.equal(normalized.autoIndex, 'on');
  const snakeCase = normalizeSkillSettings({
    disabled_skill_ids: ['project/nested/skill-name'],
    auto_index: 'off',
  });
  assert.deepEqual(snakeCase.disabledSkillIds, ['project/nested/skill-name']);
  assert.equal(snakeCase.autoIndex, 'off');
  assert.equal(normalizeSkillSettings({ autoIndex: 'sometimes' }).autoIndex, 'auto');
  assert.equal(normalizeSkillSettings({ disabledSkillIds: 'bundled/ops' }).disabledSkillIds.length, 0);
});

test('v51 skill policy migration adds defaults without rewriting other sections', () => {
  const migrated = normalizeState({
    version: 50,
    skills: { bundledEnabled: false, userEnabled: true, projectEnabled: true },
    companion: { mode: 'planner' },
    telemetry: { crashReportingOptIn: true },
  });

  assert.equal(migrated.version, CONFIG_VERSION);
  assert.deepEqual(migrated.skills, {
    bundledEnabled: false,
    userEnabled: true,
    projectEnabled: true,
    disabledSkillIds: [],
    autoIndex: 'auto',
  });
  assert.equal(migrated.companion.mode, 'planner');
  assert.equal(migrated.telemetry.crashReportingOptIn, true);
});

test('v45 folds the two legacy tips switches into one Home preference', () => {
  const enabled = normalizeState({
    version: 44,
    featureOverrides: { tips_surface: true },
    tips: { enabled: true, sessionCount: 3, historyByTipId: { one: 2 } },
  });
  assert.equal(enabled.home.showContextualTips, true);
  assert.deepEqual(enabled.featureOverrides, {});
  assert.deepEqual(enabled.tips, { sessionCount: 3, historyByTipId: { one: 2 } });
  assert.equal(normalizeState(enabled).home.showContextualTips, true);

  const muted = normalizeState({
    version: 44,
    featureOverrides: { tips_surface: true },
    tips: { enabled: false },
  });
  assert.equal(muted.home.showContextualTips, false);
});

test('v46 removes the legacy inline completion GPU preference without losing IDE settings', () => {
  const migrated = normalizeState({
    version: 45,
    workspaceIde: {
      schemaVersion: 1,
      preferences: { inlineSuggestUseGpu: true, fontSize: 16, wordWrap: 'on' },
      roots: {},
    },
  });
  assert.equal(migrated.version, CONFIG_VERSION);
  assert.equal(migrated.workspaceIde.preferences.fontSize, 16);
  assert.equal(migrated.workspaceIde.preferences.wordWrap, 'on');
  assert.equal('inlineSuggestUseGpu' in migrated.workspaceIde.preferences, false);
});

test('shell config state v20 migration drops legacy jen-e config without throwing', () => {
  const state = normalizeState({
    version: 19,
    jen_e: {
      enabled: true,
      input_hotkey: 'CommandOrControl+Shift+J',
    },
  });

  assert.equal(CONFIG_VERSION, 51);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'jenE'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'jen_e'), false);
});

test('shell config state v21 migration drops legacy local_speech config without throwing', () => {
  const state = normalizeState({
    version: 20,
    speech: {
      sttProvider: 'faster_whisper',
      ttsExecutablePath: 'C:/tools/piper/piper.exe',
    },
  });

  assert.equal(CONFIG_VERSION, 51);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'speech'), false);
});

test('v39 migration permanently removes retired memory and scheduler overrides', () => {
  const state = normalizeState({
    version: 38,
    feature_overrides: {
      memory_extraction: true,
      session_memory: false,
      cron_scheduler: true,
      token_budget: false,
    },
  });

  assert.equal(state.version, CONFIG_VERSION);
  assert.deepEqual(state.featureOverrides, { token_budget: false });
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'feature_overrides'), false);
});

test('v40 migration permanently discards the retired cost tracker override', () => {
  const state = normalizeState({
    version: 39,
    featureOverrides: { cost_tracker: true, tips_surface: true },
  });

  assert.equal(state.version, CONFIG_VERSION);
  assert.deepEqual(state.featureOverrides, {});
});

test('v42 migration drops user-facing prompt-cache and tool-search overrides', () => {
  const state = normalizeState({
    version: 41,
    featureOverrides: {
      prompt_cache: false,
      tool_search: false,
      token_budget: false,
    },
  });

  assert.equal(state.version, CONFIG_VERSION);
  assert.deepEqual(state.featureOverrides, { token_budget: false });
});

test('shell config state normalizes codex CLI settings', () => {
  assert.deepEqual(
    normalizeCodexCliSettings({
      enabled: true,
      command_path: ' C:/Tools/codex.exe ',
      models: [
        ' gpt-5.5 ',
        'codex-cli/o4-mini',
        'default',
        'codex-cli/default',
        'codex-cli',
        'codex-cli/',
        '',
        7,
      ],
      request_timeout_seconds: 900,
    }),
    {
      enabled: true,
      commandPath: 'C:/Tools/codex.exe',
      models: ['gpt-5.5', 'o4-mini'],
      requestTimeoutSeconds: 900,
    }
  );
  assert.deepEqual(
    normalizeCodexCliSettings({
      enabled: 'yes',
      commandPath: 42,
      models: 'bad',
      requestTimeoutSeconds: -1,
    }),
    DEFAULT_CODEX_CLI
  );
});

test('shell config serialization persists codex CLI settings without frontier diagnostics', () => {
  const state = normalizeState({
    codexCli: {
      enabled: true,
      commandPath: 'C:/Tools/codex.exe',
      models: ['gpt-5.5'],
      requestTimeoutSeconds: 900,
    },
  });
  const serialized = serializeState(state);

  assert.equal(Object.prototype.hasOwnProperty.call(serialized, 'frontierDiagnostics'), false);
  assert.deepEqual(serialized.codexCli, {
    enabled: true,
    commandPath: 'C:/Tools/codex.exe',
    models: ['gpt-5.5'],
    requestTimeoutSeconds: 900,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(serialized, 'jen_e'), false);
});

test('window UI app zoom defaults to 100% and round-trips through serialize', () => {
  const state = normalizeState({});
  assert.deepEqual(state.windowUi, { appZoomPercent: 100 });
  assert.deepEqual(serializeState(state).windowUi, { appZoomPercent: 100 });
});

test('v33 migration backfills the windowUi app zoom default for older configs', () => {
  const migrated = normalizeState({ version: 32 });
  assert.equal(migrated.version, CONFIG_VERSION);
  assert.deepEqual(migrated.windowUi, { appZoomPercent: 100 });
});

test('v34 migration defaults the workspace IDE column rulers to [] for older configs', () => {
  const migrated = normalizeState({ version: 33, workspaceIde: { fontSize: 16 } });
  assert.equal(migrated.version, CONFIG_VERSION);
  assert.deepEqual(migrated.workspaceIde.preferences.rulers, []);
  // Prior IDE state is untouched by the idempotent re-normalize.
  assert.equal(migrated.workspaceIde.preferences.fontSize, 16);
});

test('normalizeWindowUiZoomPercent clamps and steps the app zoom percent', () => {
  assert.equal(normalizeWindowUiZoomPercent(100), 100);
  assert.equal(normalizeWindowUiZoomPercent(125), 125);
  assert.equal(normalizeWindowUiZoomPercent(500), 150); // clamp high
  assert.equal(normalizeWindowUiZoomPercent(10), 80); // clamp low
  assert.equal(normalizeWindowUiZoomPercent(112), 110); // round to nearest step
  assert.equal(normalizeWindowUiZoomPercent('nope'), 100); // non-finite -> default
});

test('normalizeWindowUiSettings reads legacy and snake_case app zoom keys', () => {
  assert.deepEqual(normalizeWindowUiSettings({ appZoomPercent: 110 }), { appZoomPercent: 110 });
  assert.deepEqual(normalizeWindowUiSettings({ app_zoom_percent: 125 }), { appZoomPercent: 125 });
  assert.deepEqual(normalizeWindowUiSettings({}), { appZoomPercent: 100 });
});

test('normalizeWebSearchSettings defaults to duckduckgo with an empty searxng url', () => {
  assert.deepEqual(normalizeWebSearchSettings({}), { provider: 'duckduckgo', searxngUrl: '' });
  assert.deepEqual(normalizeWebSearchSettings(), { provider: 'duckduckgo', searxngUrl: '' });
});

test('normalizeWebSearchSettings accepts a known provider id', () => {
  for (const provider of WEB_SEARCH_PROVIDER_IDS) {
    assert.deepEqual(normalizeWebSearchSettings({ provider }), { provider, searxngUrl: '' });
  }
});

test('normalizeWebSearchSettings falls back to duckduckgo for an invalid provider', () => {
  assert.deepEqual(
    normalizeWebSearchSettings({ provider: 'not-a-real-provider' }),
    { provider: 'duckduckgo', searxngUrl: '' }
  );
  assert.deepEqual(
    normalizeWebSearchSettings({ provider: 42 }),
    { provider: 'duckduckgo', searxngUrl: '' }
  );
});

test('normalizeWebSearchSettings accepts the searxng_url snake_case alias and trims it', () => {
  assert.deepEqual(
    normalizeWebSearchSettings({ provider: 'searxng', searxng_url: '  http://127.0.0.1:8080  ' }),
    { provider: 'searxng', searxngUrl: 'http://127.0.0.1:8080' }
  );
  assert.deepEqual(
    normalizeWebSearchSettings({ provider: 'searxng', searxngUrl: '  http://localhost:9000  ' }),
    { provider: 'searxng', searxngUrl: 'http://localhost:9000' }
  );
});

test('normalizeWebSearchSettings falls back to defaults for non-object input', () => {
  assert.deepEqual(normalizeWebSearchSettings(null), { provider: 'duckduckgo', searxngUrl: '' });
  assert.deepEqual(normalizeWebSearchSettings('brave'), { provider: 'duckduckgo', searxngUrl: '' });
  assert.deepEqual(normalizeWebSearchSettings(['brave']), { provider: 'duckduckgo', searxngUrl: '' });
});

test('normalizeState output includes the webSearch slice with defaults', () => {
  const state = normalizeState({});
  assert.deepEqual(state.webSearch, { provider: 'duckduckgo', searxngUrl: '' });
});

test('normalizeState reads a configured webSearch slice and round-trips through serialize', () => {
  const state = normalizeState({
    webSearch: { provider: 'tavily', searxngUrl: 'http://127.0.0.1:8080' },
  });
  assert.deepEqual(state.webSearch, { provider: 'tavily', searxngUrl: 'http://127.0.0.1:8080' });
});
