const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
const { normalizeNotificationSettings } = require('../services/shell-config-notifications-schema');
const { ShellConfigService } = require('../services/shell-config-service');

test('shell config state migrates codex CLI defaults and drops active frontier config', () => {
  const state = normalizeState({
    version: 15,
    frontierDiagnostics: { enabled: true, model: 'gpt-5-mini' },
  });

  assert.equal(CONFIG_VERSION, 59);
  assert.deepEqual(state.codexCli, DEFAULT_CODEX_CLI);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'frontierDiagnostics'), false);
});

test('lastChatgptModel is an optional persisted id that defaults empty and rejects bad shapes', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-chatgpt-model-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));

  const service = new ShellConfigService({ userDataPath, env: {} });
  assert.equal(service.getState().lastChatgptModel, '');
  service.updateLastChatgptModel(' gpt-6-luna ');
  assert.equal(service.getState().lastChatgptModel, 'gpt-6-luna');
  // An empty or malformed id never clears or replaces the remembered model.
  service.updateLastChatgptModel('');
  service.updateLastChatgptModel('bad id/with spaces');
  assert.equal(service.getState().lastChatgptModel, 'gpt-6-luna');

  const reloaded = new ShellConfigService({ userDataPath, env: {} });
  assert.equal(reloaded.getState().lastChatgptModel, 'gpt-6-luna');
  assert.equal(serializeState(reloaded.getState()).lastChatgptModel, 'gpt-6-luna');
  assert.equal(reloaded.getState().version, CONFIG_VERSION);

  // A v58 file without the field reads as empty: additive, no migration needed.
  assert.equal(normalizeState({ version: 58 }).lastChatgptModel, '');
  assert.equal(normalizeState({ version: 58, lastChatgptModel: 42 }).lastChatgptModel, '');
  assert.equal(normalizeState({ version: 58, lastChatgptModel: '-leading' }).lastChatgptModel, '');
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
  assert.equal(Object.hasOwn(enabled, 'tips'), false);
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

test('a current-version profile drops the removed inline-suggestion preferences on read', () => {
  // Removed 2026-10-01 without a CONFIG_VERSION step: preferences are rebuilt
  // from the known keys, so normalizing (and the next write) forgets them.
  const stored = {
    version: CONFIG_VERSION,
    workspaceIde: {
      schemaVersion: 1,
      preferences: { inlineSuggestEnabled: false, inlineSuggestModel: 'qwen2.5-coder:1.5b-base', fontSize: 16, minimap: false },
      roots: {},
    },
  };
  const loaded = normalizeState(stored);
  assert.equal(loaded.version, CONFIG_VERSION);
  assert.equal(loaded.workspaceIde.preferences.fontSize, 16);
  assert.equal(loaded.workspaceIde.preferences.minimap, false);
  for (const state of [loaded, normalizeState(serializeState(loaded))]) {
    assert.equal('inlineSuggestEnabled' in state.workspaceIde.preferences, false);
    assert.equal('inlineSuggestModel' in state.workspaceIde.preferences, false);
  }
});

test('shell config state v20 migration drops legacy jen-e config without throwing', () => {
  const state = normalizeState({
    version: 19,
    jen_e: {
      enabled: true,
      input_hotkey: 'CommandOrControl+Shift+J',
    },
  });

  assert.equal(CONFIG_VERSION, 59);
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

  assert.equal(CONFIG_VERSION, 59);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'speech'), false);
});

test('v39 migration permanently removes retired memory and scheduler overrides', () => {
  const state = normalizeState({
    version: 38,
    feature_overrides: {
      memory_extraction: true,
      session_memory: false,
      cron_scheduler: true,
      skills_system: false,
    },
  });

  assert.equal(state.version, CONFIG_VERSION);
  assert.deepEqual(state.featureOverrides, { skills_system: false });
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
      skills_system: false,
    },
  });

  assert.equal(state.version, CONFIG_VERSION);
  assert.deepEqual(state.featureOverrides, { skills_system: false });
});

test('retired comet overrides in a current-version file load and drop without a migration', () => {
  // Sweep S9 (2026-09-25) removed the comet companion. A config written before
  // the removal still carries its two overrides; they are tolerated on load and
  // disappear on the next save, with no CONFIG_VERSION bump.
  const state = normalizeState({
    version: CONFIG_VERSION,
    featureOverrides: { comet_personality: true, comet_overlay: true, token_budget: false },
  });

  assert.equal(state.version, CONFIG_VERSION);
  assert.deepEqual(state.featureOverrides, { token_budget: false });
  assert.equal(JSON.stringify(serializeState(state)).includes('comet'), false);
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

test('window UI app zoom defaults to 110% and round-trips through serialize', () => {
  const state = normalizeState({});
  const notifications = normalizeNotificationSettings();
  assert.deepEqual(state.windowUi, { appZoomPercent: 110, notifications });
  assert.deepEqual(serializeState(state).windowUi, { appZoomPercent: 110, notifications });
});

test('v33 migration backfills the windowUi app zoom default for older configs', () => {
  const migrated = normalizeState({ version: 32 });
  assert.equal(migrated.version, CONFIG_VERSION);
  assert.deepEqual(migrated.windowUi, {
    appZoomPercent: 110,
    notifications: normalizeNotificationSettings(),
  });
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
  assert.equal(normalizeWindowUiZoomPercent('nope'), 110); // non-finite -> default
});

test('normalizeWindowUiSettings reads legacy and snake_case app zoom keys', () => {
  const zoomOf = (value) => normalizeWindowUiSettings(value).appZoomPercent;
  assert.equal(zoomOf({ appZoomPercent: 110 }), 110);
  assert.equal(zoomOf({ app_zoom_percent: 125 }), 125);
  assert.equal(zoomOf({}), 110);
});

test('windowUi always carries a full notifications block without a CONFIG_VERSION bump', () => {
  const defaults = normalizeNotificationSettings();
  assert.deepEqual(normalizeWindowUiSettings({}), { appZoomPercent: 110, notifications: defaults });
  assert.deepEqual(normalizeWindowUiSettings(null).notifications, defaults);
  // A current-version file written before the block existed gains the defaults.
  const current = normalizeState({ version: CONFIG_VERSION, windowUi: { appZoomPercent: 120 } });
  assert.equal(current.version, CONFIG_VERSION);
  assert.deepEqual(current.windowUi, { appZoomPercent: 120, notifications: defaults });
  // An old (pre-windowUi) config migrates to the same full shape.
  const migrated = normalizeState({ version: 32, appZoomPercent: 90 });
  assert.deepEqual(migrated.windowUi, { appZoomPercent: 90, notifications: defaults });
  // Stored partial/junk values normalize and survive a serialize round trip.
  const stored = normalizeState({
    version: CONFIG_VERSION,
    windowUi: { notifications: { enabled: false, categories: { reminders: false, extra: false } } },
  });
  const expected = normalizeNotificationSettings({ enabled: false, categories: { reminders: false } });
  assert.deepEqual(stored.windowUi.notifications, expected);
  const reloaded = normalizeState(JSON.parse(JSON.stringify(serializeState(stored))));
  assert.deepEqual(reloaded.windowUi.notifications, expected);
  // Idempotent: normalizing a normalized block changes nothing.
  assert.deepEqual(normalizeWindowUiSettings(stored.windowUi), stored.windowUi);
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

test('a current-version config that still carries the retired tips block loads cleanly and drops it on save', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-retired-tips-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: CONFIG_VERSION,
    home: { showContextualTips: false },
    skills: { bundledEnabled: true, userEnabled: true, projectEnabled: false },
    tips: { sessionCount: 7, historyByTipId: { 'workspace-root': 6 } },
  }, null, 2));

  const service = new ShellConfigService({ userDataPath });
  assert.equal(service.getState().version, CONFIG_VERSION);
  assert.equal(Object.hasOwn(service.getState(), 'tips'), false);
  assert.equal(service.getState().home.showContextualTips, false);
  assert.equal(service.getState().skills.userEnabled, true);

  service.updateSkillsSettings({ userEnabled: false });
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.version, CONFIG_VERSION);
  assert.equal(Object.hasOwn(saved, 'tips'), false);
  assert.equal(saved.skills.userEnabled, false);
  assert.equal(new ShellConfigService({ userDataPath }).getState().skills.userEnabled, false);
  assert.equal(Object.hasOwn(serializeState(normalizeState({ tips: { sessionCount: 2 } })), 'tips'), false);
});

const RETIRED_ENGINE_TUNING = Object.freeze({
  maxLoopIterations: 16,
  tokenBudgetReservedForSummary: 4096,
  tokenBudgetToolOverhead: 250,
  tokenBudgetAutoCompactRatio: 0.8,
});

test('v58 migration deletes the stored token_budget override and keeps the others', () => {
  const state = normalizeState({
    version: 57,
    featureOverrides: { token_budget: false, skills_system: false },
  });
  assert.equal(state.version, 59);
  assert.equal(Object.hasOwn(state.featureOverrides, 'token_budget'), false);
  assert.equal(state.featureOverrides.skills_system, false);
});

test('v58 migration deletes the four retired engine-tuning overrides only', () => {
  const state = normalizeState({
    version: 57,
    engineTuning: { ...RETIRED_ENGINE_TUNING, tokenBudgetWarningRatio: 0.75, maxBudgetUsd: 5 },
  });
  assert.equal(state.version, 59);
  assert.deepEqual(state.engineTuning, { tokenBudgetWarningRatio: 0.75, maxBudgetUsd: 5 }, 'the spend cap is not a retired key');
  assert.equal(state.maxBudgetUsd, 5);
  assert.deepEqual(normalizeState(state), state, 'a migrated state loads unchanged');
});

test('v58 migration also clears the snake_case engine tuning container', () => {
  const state = normalizeState({
    version: 57,
    engine_tuning: { ...RETIRED_ENGINE_TUNING, tokenBudgetWarningRatio: 0.75 },
  });
  assert.deepEqual(state.engineTuning, { tokenBudgetWarningRatio: 0.75 });
});

test('v58 migration changes only the version when no retired key is stored', () => {
  const state = normalizeState({
    version: 57,
    featureOverrides: { skills_system: false },
    engineTuning: { tokenBudgetWarningRatio: 0.75 },
  });
  assert.equal(state.version, 59);
  assert.deepEqual(state.featureOverrides, { skills_system: false });
  assert.deepEqual(state.engineTuning, { tokenBudgetWarningRatio: 0.75 });
});

test('v58 migration tolerates missing or malformed containers', () => {
  for (const stored of [{}, { featureOverrides: null, engineTuning: 'x' }, { featureOverrides: [], engineTuning: [] }]) {
    const state = normalizeState({ version: 57, ...stored });
    assert.equal(state.version, 59);
    assert.deepEqual(state.featureOverrides, {});
    assert.deepEqual(state.engineTuning, {});
  }
});

test('a state already at v58 keeps its stored token_budget override', () => {
  const state = normalizeState({
    version: 58,
    featureOverrides: { token_budget: false },
  });
  assert.equal(state.featureOverrides.token_budget, false);
  assert.equal(state.version, 59);
});

test('a state already at v58 keeps stored engine-tuning keys', () => {
  const state = normalizeState({ version: 58, engineTuning: { ...RETIRED_ENGINE_TUNING } });
  assert.deepEqual(state.engineTuning, RETIRED_ENGINE_TUNING);
});
