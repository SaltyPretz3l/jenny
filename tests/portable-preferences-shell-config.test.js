const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SHELL_CONFIG_PORTABILITY,
  projectPortableShellConfig,
} = require('../services/data-lifecycle/portable-preferences-store');
const { projectRestoredPreference } = require('../services/data-lifecycle/restore-preferences');
const {
  DEFAULT_TOOLS,
  cloneState,
  normalizeState,
  serializeState,
} = require('../services/shell-config-state');

const FILE_KEY_ALIASES = Object.freeze({ session_runtime: 'sessionRuntime' });
const ROOT_ID = `root_${'a'.repeat(24)}`;
// Values that must never reach the portable projection: paths, credential-like URLs,
// machine picks and per-window state.
const EXCLUDED_MARKERS = Object.freeze([
  'fake-root', 'fake-mic-device', 'FAKE-SECRET-LINK', 'FAKE-ICS-TOKEN', 'fake-models', 'fake-offline-model',
  '10.0.0.5', 'gpt-fake-last', 'fake-tools', 'fake-followup', 'sess_fake_open', 'fake-expanded-dir',
]);

function readPath(target, dottedPath) {
  return dottedPath.split('.').reduce((node, part) => node?.[part], target);
}

function writePath(target, dottedPath, value) {
  const parts = dottedPath.split('.');
  const parent = readPath(target, parts.slice(0, -1).join('.'));
  if (value === undefined) delete parent[parts.at(-1)];
  else parent[parts.at(-1)] = value;
}

function populatedLiveState() {
  return cloneState(normalizeState({
    version: normalizeState({}).version,
    commandSandbox: { enabled: true },
    session_runtime: {
      local: { runnable_turns: 2, inference_requests: 3, descendants: 4, descendant_depth: 1 },
      cloud: { runnable_turns: 5, inference_requests: 6, descendants: 7, descendant_depth: 2 },
      resources: { tool_operations: 8, native_processes: 9, tests: 3 },
    },
    subagentRouting: {
      chatgpt: { defaultModel: 'gpt-6-luna', defaultEffort: 'high', maxEffort: 'xhigh',
        preferredModels: ['gpt-6-luna'], allowedModels: ['gpt-6-luna', 'gpt-6-astra'] },
    },
    engineTuning: { maxToolsPerTurn: 7, maxBudgetUsd: 5 },
    modelTuning: {
      streamInactivitySecondsByModel: { 'qwen3:8b': 90 },
      generationProfilesByModel: { 'qwen3:8b': { temperature: 0.4, topK: 30 } },
      pendingLegacyStreamInactivitySeconds: 60,
    },
    compactionTuning: {
      ratioByModel: { 'qwen3:8b': 0.7 },
      contextLengthByModel: { 'qwen3:8b': 32768 },
      customPrompt: 'Keep every decision.',
    },
    tools: Object.fromEntries(Object.entries(DEFAULT_TOOLS).map(([key, value]) => [key, !value])),
    webSearch: { provider: 'searxng', searxngUrl: 'https://search.example.org' },
    chatUi: { zoomPercent: 120, transcriptViewDefault: 'everything' },
    windowUi: {
      appZoomPercent: 130,
      notifications: { enabled: false, sound: false, categories: { replies: false } },
      dictation: { deviceId: 'fake-mic-device' },
    },
    featureOverrides: { command_palette: false, text_spellcheck: true },
    assistantIdentity: { agentName: 'Nova', updatedAt: '2026-10-01T00:00:00.000Z' },
    preferredEngineType: 'vllm',
    defaultRunMode: 'propose',
    uiLanguage: 'ja',
    use24HourTime: true,
    safetyMode: 'strict',
    autoApproveStreakCap: 12,
    unattendedGuardMinutes: 30,
    companion: { mode: 'listener' },
    home: {
      links: [{ name: 'Mine', tiles: [{ name: 'x', href: 'https://user:FAKE-SECRET-LINK@example.com/' }] }],
      widgets: { order: ['clock'], hidden: ['news'] },
      scratchpad: {
        notes: [{ id: 'ideas', title: 'Ideas', text: 'portable note' }],
        activeNoteId: 'ideas',
        settings: { rows: 10, font: 'mono' },
        pins: ['ideas'],
      },
      calendar: {
        feeds: [{ name: 'Private', url: 'https://calendar.example.com/FAKE-ICS-TOKEN/basic.ics' }],
        viewMode: 'week',
      },
      layout: { railWidth: 500 },
      focusMode: true,
      showContextualTips: false,
    },
    skills: {
      bundledEnabled: false, userEnabled: true, projectEnabled: true,
      disabledSkillIds: ['bundled/review'], autoIndex: 'off',
    },
    memory: {
      takeNotes: true, askBeforeSaving: true, pauseSaving: true, useInChats: false,
      takeNotesSince: '2026-09-01T00:00:00.000Z',
    },
    proactive: {
      reminders: [{ id: 'r1', label: 'Stretch', prompt: 'Stand up', scheduleType: 'interval_minutes',
        intervalMinutes: 45, createdAt: '2026-01-01T00:00:00.000Z' }],
    },
    workspaceIde: {
      preferences: { fontSize: 16, tabSize: 4, minimap: false, wordWrap: 'on', railWidth: 400, chatDockOpen: true },
      rootLru: [ROOT_ID],
      roots: { [ROOT_ID]: { expandedDirs: ['fake-expanded-dir'] } },
    },
    // EXCLUDED values below.
    toolsWorkspaceRoot: 'C:\\fake-root\\workspace',
    telemetry: { crashReportingOptIn: true },
    setup: { setupComplete: true, steps: { workspaceRoot: 'done' } },
    offlineIntelligence: { mode: 'local_only', preferredLocalModel: 'fake-offline-model' },
    localEngines: {
      openaiCompatible: { apiUrl: 'http://10.0.0.5:9999/v1', managed: { lastPickDir: 'C:\\fake-models' } },
      embedding: { modelPath: 'C:\\fake-models\\embed.gguf' },
    },
    lastChatgptModel: 'gpt-fake-last',
    chatgptModelsEnabled: false,
    codexCli: { enabled: true, commandPath: 'C:\\fake-tools\\codex.exe' },
    followUps: [{ id: 'f1', label: 'fake-followup', sourceMeta: { path: 'C:\\fake-followup' },
      createdAt: '2026-01-01T00:00:00.000Z' }],
    workspace: { activeSessionId: 'sess_fake_open', openSessionIds: ['sess_fake_open'] },
    performanceTelemetry: { showCounter: true, gpuWarningsEnabled: false },
  }));
}

function restoreThroughArchive(projected) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-portable-shell-config-'));
  try {
    const filePath = path.join(root, 'shell-config.json');
    fs.writeFileSync(filePath, JSON.stringify(projected, null, 2));
    const bytes = projectRestoredPreference({ logical_path: 'preferences/shell-config.json' }, filePath);
    return { bytes, loaded: normalizeState(JSON.parse(bytes.toString('utf8'))) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('portable shell-config classification', () => {
  it('classifies every live shell-config key as PORTABLE or EXCLUDED exactly once', () => {
    const { portable, excluded } = SHELL_CONFIG_PORTABILITY;
    const state = normalizeState({});
    const liveKeys = new Set([
      ...Object.keys(state),
      ...Object.keys(serializeState(state)).map((key) => FILE_KEY_ALIASES[key] || key),
    ]);
    const unclassified = [...liveKeys].filter((key) => !Object.hasOwn(portable, key) && !Object.hasOwn(excluded, key));
    assert.deepEqual(unclassified, [], 'classify each new shell-config key in SHELL_CONFIG_PORTABILITY');
    assert.deepEqual(Object.keys(portable).filter((key) => Object.hasOwn(excluded, key)), []);
    const stale = [...Object.keys(portable), ...Object.keys(excluded)].filter((key) => !liveKeys.has(key));
    assert.deepEqual(stale, []);
    for (const dottedPath of Object.keys(SHELL_CONFIG_PORTABILITY.excludedSubkeys)) {
      assert.equal(Object.hasOwn(portable, dottedPath.split('.')[0]), true, dottedPath);
      assert.notEqual(readPath(state, dottedPath), undefined, `${dottedPath} is not a live sub-key`);
    }
    assert.equal(Object.isFrozen(SHELL_CONFIG_PORTABILITY.portable), true);
    assert.equal(Object.isFrozen(SHELL_CONFIG_PORTABILITY.excluded), true);
  });

  it('round-trips every PORTABLE value through the restore path and load normalization', () => {
    const state = populatedLiveState();
    const defaults = normalizeState({});
    for (const key of Object.keys(SHELL_CONFIG_PORTABILITY.portable)) {
      assert.notDeepEqual(state[key], defaults[key], `fixture leaves ${key} at its default`);
    }
    const projected = projectPortableShellConfig(state);
    const { bytes, loaded } = restoreThroughArchive(projected);

    const expected = JSON.parse(JSON.stringify(state));
    for (const dottedPath of Object.keys(SHELL_CONFIG_PORTABILITY.excludedSubkeys)) {
      writePath(expected, dottedPath, readPath(defaults, dottedPath));
    }
    for (const key of Object.keys(SHELL_CONFIG_PORTABILITY.portable)) {
      assert.deepEqual(loaded[key], expected[key], key);
    }
    for (const dottedPath of Object.keys(SHELL_CONFIG_PORTABILITY.excludedSubkeys)) {
      assert.deepEqual(readPath(loaded, dottedPath), readPath(defaults, dottedPath), dottedPath);
    }
    for (const key of Object.keys(SHELL_CONFIG_PORTABILITY.excluded)) {
      assert.deepEqual(loaded[key], defaults[key], key);
    }
    for (const serialized of [JSON.stringify(projected), bytes.toString('utf8')]) {
      for (const marker of EXCLUDED_MARKERS) {
        assert.equal(serialized.includes(marker), false, `${marker} leaked into the projection`);
      }
    }
    // The projection is idempotent, so an exported projection restores unchanged.
    assert.deepEqual(projectPortableShellConfig(projected), projected);
  });

  it('restores an older archive without the new keys to defaults', () => {
    const { loaded } = restoreThroughArchive({ version: 50, chatUi: { zoomPercent: 110 } });
    const defaults = normalizeState({});
    assert.equal(loaded.chatUi.zoomPercent, 110);
    for (const key of ['tools', 'memory', 'subagentRouting', 'webSearch', 'featureOverrides',
      'safetyMode', 'defaultRunMode', 'uiLanguage', 'use24HourTime', 'unattendedGuardMinutes']) {
      assert.deepEqual(loaded[key], defaults[key], key);
    }
    assert.deepEqual(loaded.windowUi.notifications, defaults.windowUi.notifications);
  });

  it('lets a restore tighten safety but never loosen it below the defaults', () => {
    const defaults = normalizeState({});
    const loose = projectPortableShellConfig({
      featureOverrides: { shell_security: false, unattended_guard: false, strict_auto_run: true },
      autoApproveStreakCap: 500,
    });
    assert.deepEqual(loose.featureOverrides, { strict_auto_run: true });
    assert.equal(loose.autoApproveStreakCap, defaults.autoApproveStreakCap);
    const { loaded } = restoreThroughArchive({ ...loose, featureOverrides: { shell_security: false } });
    assert.equal(Object.hasOwn(loaded.featureOverrides, 'shell_security'), false);
    const tight = projectPortableShellConfig({ autoApproveStreakCap: 5, safetyMode: 'paranoid' });
    assert.equal(tight.autoApproveStreakCap, 5);
    assert.equal(tight.safetyMode, 'paranoid');
  });

  it('drops an oversized scratchpad but keeps the other home preferences', () => {
    const notes = Array.from({ length: 8 }, (_, index) => ({
      id: `n${index}`, title: `N${index}`, text: '\u4e2d'.repeat(4000),
    }));
    const projected = projectPortableShellConfig({ home: { scratchpad: { notes }, focusMode: true } });
    assert.equal(Object.hasOwn(projected.home, 'scratchpad'), false);
    assert.equal(projected.home.focusMode, true);
  });
});
