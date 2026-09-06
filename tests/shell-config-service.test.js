const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONFIG_VERSION,
  DEFAULT_CODEX_CLI,
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
  ShellConfigService,
  normalizeState,
} = require('../services/shell-config-service');
const {
  ASSISTANT_AGENT_NAME_MAX_CHARS,
} = require('../services/shell-config-setup-state');
const {
  CONTEXT_LENGTH_STEPS,
} = require('../services/shell-config-compaction-tuning');
const { isToolsWorktreeEnabled } = require('../services/shell-config-state');
const { PROACTIVE_ERROR_CODES } = require('../services/backend/error-codes');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('updateHomeConfig merges partial patches without dropping sibling home fields', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-home-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath, env: {} });

  service.updateHomeConfig({
    widgets: { hidden: ['links'] },
    scratchpad: {
      notes: [
        { id: 'note-1', title: 'Note 1', text: 'first note', updatedAt: '2026-06-11T10:00:00.000Z' },
        { id: 'note-2', title: 'Ideas', text: 'brainstorm', updatedAt: '2026-06-11T11:00:00.000Z' },
      ],
      activeNoteId: 'note-1',
      settings: { rows: 8, font: 'mono', captureMode: 'append' },
    },
    focusMode: true,
  });
  // Partial patches: each touches one section/field and must not reset others.
  service.updateHomeConfig({ widgets: { order: ['calendar', 'open-loops'] } });
  // A pointer-only scratchpad patch must keep the notes array and settings.
  service.updateHomeConfig({ scratchpad: { activeNoteId: 'note-2' } });

  const home = service.getHomeConfig();
  assert.deepEqual(home.widgets, { order: ['calendar', 'open-loops'], hidden: ['links'] });
  assert.equal(home.scratchpad.notes.length, 2);
  assert.equal(home.scratchpad.activeNoteId, 'note-2');
  assert.equal(home.scratchpad.notes[0].text, 'first note');
  assert.equal(home.scratchpad.notes[1].title, 'Ideas');
  assert.deepEqual(home.scratchpad.settings, { rows: 8, font: 'mono', captureMode: 'append', markdown: false, globalCapture: true });
  assert.equal(home.focusMode, true);

  const reloaded = new ShellConfigService({ userDataPath, env: {} });
  assert.deepEqual(reloaded.getHomeConfig(), home);
});

test('shell config state interprets worktree tool enablement from canonical and legacy keys', () => {
  assert.equal(isToolsWorktreeEnabled({ tools: { worktree: true } }), true);
  assert.equal(isToolsWorktreeEnabled({ toolsWorktreeEnabled: true }), true);
  assert.equal(isToolsWorktreeEnabled({ tools_worktree_enabled: true }), true);
  assert.equal(isToolsWorktreeEnabled({ tools: { worktree: false } }), false);
});

test('shell config service seeds workspace root once and persists reminders', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({
    userDataPath,
    env: {
      JENNY_TOOLS_WORKSPACE_ROOT: 'C:/seed/workspace',
    },
  });

  assert.equal(service.getState().toolsWorkspaceRoot, 'C:/seed/workspace');
  assert.equal(service.getToolsWorkspaceRoot(), 'C:/seed/workspace');

  service.setToolsWorkspaceRoot('C:/saved/workspace');
  assert.equal(service.getToolsWorkspaceRoot(), 'C:/saved/workspace');
  service.updateFeatureSettings({ tools: { pythonRuntime: true } });
  const reminderState = service.upsertReminder({
    label: 'Daily check-in',
    prompt: 'Ask what matters most today.',
    scheduleType: 'daily_at',
    dailyAt: '09:15',
  });

  assert.equal(reminderState.proactive.reminders.length, 1);

  const reloaded = new ShellConfigService({
    userDataPath,
    env: {
      JENNY_TOOLS_WORKSPACE_ROOT: 'C:/ignored/workspace',
    },
  });

  const nextState = reloaded.getState();
  assert.equal(nextState.toolsWorkspaceRoot, 'C:/saved/workspace');
  assert.equal(nextState.tools.imageRead, false);
  assert.equal(nextState.tools.pythonRuntime, true);
  assert.equal(nextState.proactive.reminders.length, 1);
  assert.equal(nextState.proactive.reminders[0].dailyAt, '09:15');
});

test('shell config drops retired proactive settings on the next write and preserves reminders', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-proactive-retire-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: CONFIG_VERSION,
    proactive: {
      settings: {
        morningBriefingEnabled: true,
        remindersEnabled: true,
        resourceAlertsEnabled: true,
        resourceAlertCpuThreshold: 75,
        resourceAlertRamThreshold: 80,
        fileWatcherEnabled: true,
        watcherGlobs: ['src/**/*.js'],
      },
      reminders: [{ id: 'reminder-1', label: 'Remember', prompt: 'Call someone' }],
      lastMorningBriefingDate: '2026-08-23',
    },
  }));

  const service = new ShellConfigService({ userDataPath, env: {} });
  const normalized = service.getState();
  assert.equal(Object.hasOwn(normalized.proactive, 'settings'), false);
  assert.equal(Object.hasOwn(normalized.proactive, 'lastMorningBriefingDate'), false);
  assert.equal(normalized.proactive.reminders.length, 1);

  service.setToolsWorkspaceRoot('C:/saved/workspace');
  const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(Object.hasOwn(persisted.proactive, 'settings'), false);
  assert.equal(Object.hasOwn(persisted.proactive, 'lastMorningBriefingDate'), false);
  assert.equal(persisted.proactive.reminders[0].id, 'reminder-1');
});

test('shell config service refuses to seed a workspace root pointed at its own .jenny state dir', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-state-dir-seed-'));
  trackDirectory(userDataPath);
  const logs = [];

  const service = new ShellConfigService({
    userDataPath,
    env: {
      JENNY_TOOLS_WORKSPACE_ROOT: 'C:/dev/jenny/.jenny',
    },
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.equal(service.getState().toolsWorkspaceRoot, null);
  assert.equal(service.getToolsWorkspaceRoot(), null);
  assert.ok(logs.some((entry) => entry.event === 'shell_config.workspace_root_env_seed_rejected'));
});

test('shell config service rejects invalid reminder upserts', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-proactive-caps-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({
    userDataPath,
    env: {},
  });

  assert.throws(
    () => service.upsertReminder({
      label: 'L'.repeat(201),
      prompt: 'Prompt',
      scheduleType: 'daily_at',
      dailyAt: '09:00',
    }),
    (error) => error.code === PROACTIVE_ERROR_CODES.REMINDER_INVALID
  );

  for (let index = 0; index < 50; index += 1) {
    service.upsertReminder({
      id: `reminder-${index}`,
      label: `Reminder ${index}`,
      prompt: `Prompt ${index}`,
      scheduleType: 'daily_at',
      dailyAt: '09:00',
      createdAt: new Date(2026, 0, index + 1).toISOString(),
    });
  }
  assert.equal(service.getState().proactive.reminders.length, 50);
  assert.throws(
    () => service.upsertReminder({
      id: 'reminder-overflow',
      label: 'Overflow',
      prompt: 'Prompt',
      scheduleType: 'daily_at',
      dailyAt: '09:00',
    }),
    (error) => error.code === PROACTIVE_ERROR_CODES.REMINDER_INVALID
  );
});

test('shell config v20 exposes setup, assistant identity, and Codex CLI defaults', () => {
  const normalized = normalizeState({});

  assert.equal(CONFIG_VERSION, 51);
  assert.equal(normalized.workspaceIde.preferences.showGenerated, false);
  assert.deepEqual(normalized.codexCli, DEFAULT_CODEX_CLI);
  assert.deepEqual(normalized.setup, {
    seen: false,
    dismissed: false,
    setupComplete: false,
    firstRunCompleted: false,
    completedAt: '',
    updatedAt: '',
    steps: {
      workspaceRoot: 'pending',
      localModel: 'pending',
      endpoint: 'pending',
      personality: 'pending',
      skills: 'pending',
      capabilities: 'pending',
    },
  });
  assert.deepEqual(normalized.assistantIdentity, {
    agentName: 'Jenny',
    updatedAt: '',
  });
});

test('shell config v41 migrates and persists the durable memory suggestion preference', () => {
  assert.deepEqual(normalizeState({ version: 40 }).memory, { captureSuggestions: true });
  assert.deepEqual(normalizeState({ version: 40, memory: { captureSuggestions: false } }).memory, { captureSuggestions: false });
  for (const malformed of [null, 0, 'false', [], {}]) {
    const normalized = normalizeState({ version: 40, memory: { captureSuggestions: malformed } });
    assert.deepEqual(normalized.memory, { captureSuggestions: true });
  }
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-memory-v41-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  assert.equal(service.updateFeatureSettings({ memory: { captureSuggestions: false } }).memory.captureSuggestions, false);
  assert.equal(new ShellConfigService({ userDataPath, env: {} }).getState().memory.captureSuggestions, false);
});

test('shell config service persists setup and assistant identity contract updates', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-setup-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({
    userDataPath,
    env: {},
    nowProvider: () => new Date('2026-05-07T12:00:00.000Z'),
  });

  service.updateSetupState({
    seen: true,
    steps: {
      workspaceRoot: 'done',
      localModel: 'skipped',
    },
  });
  // Retired v46 keys on the patch are tolerated and dropped, not rejected.
  service.updateAssistantIdentity({ agentName: 'Juniper', profile: 'mentor', customText: 'Direct.' });
  service.markSetupComplete();

  const reloaded = new ShellConfigService({ userDataPath, env: {} });
  assert.equal(reloaded.getSetupState().setupComplete, true);
  assert.equal(reloaded.getSetupState().completedAt, '2026-05-07T12:00:00.000Z');
  assert.equal(reloaded.getSetupState().steps.workspaceRoot, 'done');
  assert.equal(reloaded.getSetupState().steps.localModel, 'skipped');
  assert.deepEqual(reloaded.getAssistantIdentity(), {
    agentName: 'Juniper',
    updatedAt: '2026-05-07T12:00:00.000Z',
  });

  reloaded.resetSetupState();
  assert.equal(reloaded.getSetupState().setupComplete, false);
  assert.equal(reloaded.getSetupState().completedAt, '');
});

test('shell config v47 drops the retired profile and custom text while keeping the name', () => {
  // Personality v3: tone moved into the user-owned PERSONALITY.md note. The
  // personality-workspace migration carries the old customText across; this
  // schema bump is what stops the shell config from re-serializing it.
  const identity = { agentName: 'Echo', profile: 'creative', customText: 'x'.repeat(2025) };
  const migrated = normalizeState({ version: 46, assistantIdentity: identity });

  assert.deepEqual(migrated.assistantIdentity, { agentName: 'Echo', updatedAt: '' });
  assert.equal(Object.prototype.hasOwnProperty.call(migrated.assistantIdentity, 'profile'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(migrated.assistantIdentity, 'customText'), false);
  assert.equal(
    normalizeState({ version: 46, assistantIdentity: { agentName: 'A'.repeat(200) } })
      .assistantIdentity.agentName.length,
    ASSISTANT_AGENT_NAME_MAX_CHARS
  );
});

test('normalizeState defensively clips and drops oversized persisted reminders', () => {
  const normalized = normalizeState({
    proactive: {
      settings: {},
      reminders: Array.from({ length: 60 }, (_entry, index) => ({
        id: `stored-${index}`,
        label: 'L'.repeat(250),
        prompt: 'P'.repeat(4500),
        scheduleType: 'daily_at',
        dailyAt: '09:00',
        createdAt: new Date(2026, 0, index + 1).toISOString(),
      })),
    },
  });

  assert.equal(normalized.proactive.reminders.length, 50);
  assert.equal(normalized.proactive.reminders[0].label.length, 200);
  assert.equal(normalized.proactive.reminders[0].prompt.length, 4000);
});

test('normalizeState defensively clips oversized persisted follow-up text', () => {
  const normalized = normalizeState({
    followUps: [
      {
        id: 'followup-oversized',
        label: 'L'.repeat(MAX_FOLLOW_UP_LABEL_CHARS + 50),
        body: 'B'.repeat(MAX_FOLLOW_UP_BODY_CHARS + 50),
      },
    ],
  });

  assert.equal(normalized.followUps[0].label.length, MAX_FOLLOW_UP_LABEL_CHARS);
  assert.equal(normalized.followUps[0].body.length, MAX_FOLLOW_UP_BODY_CHARS);
});

test('shell config service preserves in-memory state when disk write fails', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  service.setToolsWorkspaceRoot('C:/valid/workspace');
  assert.equal(service.getState().toolsWorkspaceRoot, 'C:/valid/workspace');

  const realWrite = service.store.write.bind(service.store);
  service.store.write = () => {
    throw new Error('simulated disk failure');
  };

  assert.throws(
    () => service.setToolsWorkspaceRoot('C:/should/not/persist'),
    /simulated disk failure/
  );

  assert.equal(service.getState().toolsWorkspaceRoot, 'C:/valid/workspace');

  service.store.write = realWrite;
});

test('shell config service preserves newer config files and blocks writes', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-future-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  const futurePayload = {
    version: CONFIG_VERSION + 1,
    toolsWorkspaceRoot: 'C:/future/workspace',
    tools: {
      pythonRuntime: true,
    },
    futureOnly: {
      keep: true,
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(futurePayload, null, 2));
  const logs = [];

  const service = new ShellConfigService({
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.equal(service.getState().toolsWorkspaceRoot, 'C:/future/workspace');
  const nextState = service.setToolsWorkspaceRoot('C:/should/not/persist');
  const workspaceState = service.updateWorkspaceState({
    activeSessionId: 'sess_future',
    openSessionIds: ['sess_future'],
  });
  assert.throws(() => service.updateHomeConfig({ showContextualTips: false }), {
    code: 'home_config_write_failed',
  });
  assert.throws(() => service.upsertReminder({ id: 'future-reminder', label: 'Keep', prompt: 'Blocked' }), {
    code: 'proactive_reminder_write_failed',
  });
  service.flushPendingWorkspaceWrite();

  assert.equal(nextState.toolsWorkspaceRoot, 'C:/future/workspace');
  assert.equal(service.getHomeConfig().showContextualTips, true);
  assert.deepEqual(workspaceState, {
    activeSessionId: null,
    openSessionIds: [],
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), futurePayload);
  assert.equal(
    logs.some((entry) =>
      entry.level === 'WARN'
      && entry.event === 'shell_config.newer_schema_detected'
      && entry.details?.observedVersion === CONFIG_VERSION + 1
      && entry.details?.expectedVersion === CONFIG_VERSION
    ),
    true
  );
  const writeBlockedLogs = logs.filter((entry) =>
    entry.level === 'WARN'
    && entry.event === 'shell_config.newer_schema_write_blocked'
    && entry.details?.observedVersion === CONFIG_VERSION + 1
    && entry.details?.expectedVersion === CONFIG_VERSION
  );
  assert.equal(writeBlockedLogs.length, 1);
});

test('shell config service routes corrupted config reads to the diagnostics logger', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-corrupt-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, '{not-json', 'utf8');
  const logs = [];

  const service = new ShellConfigService({
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.equal(service.getState().version, CONFIG_VERSION);
  assert.equal(
    logs.some((entry) =>
      entry.level === 'WARN'
      && entry.event === 'store.corrupted'
      && entry.details?.filePath === configPath
      && String(entry.details?.errorMessage || '').includes('JSON')
    ),
    true
  );
});

test('shell config service migrates offline intelligence config from v1 and persists updates', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-offline-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    tools_workspace_root: 'C:/saved/workspace',
    offline_intelligence: {
      mode: 'local_only',
      preferred_local_model: 'qwen3.5:9b',
    },
  }, null, 2));

  const service = new ShellConfigService({ userDataPath });
  assert.equal(service.getState().version, CONFIG_VERSION);
  assert.deepEqual(service.getState().offlineIntelligence, {
    mode: 'local_only',
    preferredLocalModel: 'qwen3.5:9b',
  });

  service.updateOfflineIntelligence({
    mode: 'disabled',
    preferredLocalModel: 'llava:7b',
  });

  const reloaded = new ShellConfigService({ userDataPath });
  assert.deepEqual(reloaded.getState().offlineIntelligence, {
    mode: 'disabled',
    preferredLocalModel: 'llava:7b',
  });
});

test('shell config service migrates workspace state to v3 and normalizes ids on load and write', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-workspace-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 2,
    workspace: {
      active_session_id: 'sess_missing',
      open_session_ids: [
        'sess_1',
        'sess_2',
        'sess_2',
        'sess_3',
        'sess_4',
        'sess_5',
        'sess_6',
        'sess_7',
        'sess_8',
        'sess_9',
      ],
    },
  }, null, 2));

  const validSessionIds = ['sess_1', 'sess_2', 'sess_3', 'sess_4', 'sess_5', 'sess_6', 'sess_7', 'sess_8'];
  const service = new ShellConfigService({
    userDataPath,
    getValidWorkspaceSessionIds: () => validSessionIds,
    workspaceWriteDelayMs: 20,
  });

  assert.equal(service.getState().version, CONFIG_VERSION);
  assert.deepEqual(service.getWorkspaceState(), {
    activeSessionId: null,
    openSessionIds: ['sess_1', 'sess_2', 'sess_3', 'sess_4', 'sess_5', 'sess_6', 'sess_7', 'sess_8'],
  });

  service.updateWorkspaceState({
    activeSessionId: 'sess_3',
    openSessionIds: ['sess_8', 'sess_8', 'sess_3', 'sess_2', 'sess_9', 'sess_1'],
  });
  assert.deepEqual(service.getWorkspaceState(), {
    activeSessionId: 'sess_3',
    openSessionIds: ['sess_8', 'sess_3', 'sess_2', 'sess_1'],
  });

  service.flushPendingWorkspaceWrite();
  service.flushPendingWorkspaceWrite();

  const reloaded = new ShellConfigService({
    userDataPath,
    getValidWorkspaceSessionIds: () => validSessionIds,
  });
  assert.deepEqual(reloaded.getWorkspaceState(), {
    activeSessionId: 'sess_3',
    openSessionIds: ['sess_8', 'sess_3', 'sess_2', 'sess_1'],
  });
});

test('shell config service migrates chat UI settings into v12 defaults', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-chat-ui-migrate-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 11,
    workspace: {
      activeSessionId: '',
      openSessionIds: [],
    },
  }, null, 2));

  const service = new ShellConfigService({ userDataPath });

  assert.equal(service.getState().version, CONFIG_VERSION);
  assert.deepEqual(service.getChatUiState(), {
    zoomPercent: 100,
    defaultRunMode: 'ask',
  });
});

test('shell config service clamps and persists chat UI zoom updates', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-chat-ui-save-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  service.updateChatUiSettings({
    zoomPercent: 141,
  });

  assert.deepEqual(service.getChatUiState(), {
    zoomPercent: 135,
    defaultRunMode: 'ask',
  });

  service.updateChatUiSettings({
    zoomPercent: 82,
  });

  assert.deepEqual(service.getChatUiState(), {
    zoomPercent: 85,
    defaultRunMode: 'ask',
  });

  const reloaded = new ShellConfigService({ userDataPath });
  assert.deepEqual(reloaded.getChatUiState(), {
    zoomPercent: 85,
    defaultRunMode: 'ask',
  });
});

test('shell config service clamps and persists overall app zoom updates', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-window-ui-save-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  assert.deepEqual(service.getWindowUiState(), { appZoomPercent: 100 });

  service.updateWindowUiSettings({ appZoomPercent: 999 });
  assert.deepEqual(service.getWindowUiState(), { appZoomPercent: 150 });

  service.updateWindowUiSettings({ appZoomPercent: 10 });
  assert.deepEqual(service.getWindowUiState(), { appZoomPercent: 80 });

  const reloaded = new ShellConfigService({ userDataPath });
  assert.deepEqual(reloaded.getWindowUiState(), { appZoomPercent: 80 });
});

test('shell config service migrates companion state to v4 and persists companion mode changes', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-companion-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 3,
    companion: {
      mode: 'listener',
    },
  }, null, 2));

  const service = new ShellConfigService({ userDataPath });
  assert.equal(service.getState().version, CONFIG_VERSION);
  assert.deepEqual(service.getState().companion, { mode: 'listener' });

  service.setCompanionMode('builder');

  const reloaded = new ShellConfigService({ userDataPath });
  assert.deepEqual(reloaded.getState().companion, { mode: 'builder' });
});

test('shell config service migrates skills and tips defaults in v6', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-guidance-migrate-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 5,
    companion: { mode: 'planner' },
  }, null, 2));

  const service = new ShellConfigService({ userDataPath });

  assert.equal(service.getState().version, CONFIG_VERSION);
  assert.deepEqual(service.getState().skills, {
    bundledEnabled: true,
    userEnabled: false,
    projectEnabled: false,
    disabledSkillIds: [], autoIndex: 'auto',
  });
  assert.deepEqual(service.getState().tips, { sessionCount: 0, historyByTipId: {} });
});

test('shell config service persists skills and tips updates', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-guidance-save-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  service.updateSkillsSettings({
    userEnabled: false,
    projectEnabled: false,
  });
  service.incrementTipsSessionCount();
  service.recordTipShown('workspace-root');
  service.updateTipsSettings({ enabled: false });

  const reloaded = new ShellConfigService({ userDataPath });

  assert.deepEqual(reloaded.getState().skills, {
    bundledEnabled: true,
    userEnabled: false,
    projectEnabled: false,
    disabledSkillIds: [], autoIndex: 'auto',
  });
  assert.equal(reloaded.getState().home.showContextualTips, false);
  assert.equal(Object.hasOwn(reloaded.getState().tips, 'enabled'), false);
  assert.equal(reloaded.getState().tips.sessionCount, 1);
  assert.equal(reloaded.getState().tips.historyByTipId['workspace-root'], 1);
});

test('normalizeState filters invalid follow-ups without ids', () => {
  const normalized = normalizeState({
    version: 5,
    followUps: [
      {
        id: '',
        label: 'Ignore me',
      },
      {
        id: 'followup-1',
        label: 'Keep me',
        body: 'Body text',
      },
    ],
  });

  assert.equal(normalized.followUps.length, 1);
  assert.equal(normalized.followUps[0].id, 'followup-1');
});

test('normalizeState reactivates malformed deferred follow-ups instead of hiding them', () => {
  const normalized = normalizeState({
    version: 10,
    followUps: [
      {
        id: 'followup-1',
        label: 'Deferred without timestamp',
        status: 'deferred',
        deferPreset: 'tomorrow',
        deferredUntil: 'not-a-date',
      },
    ],
  });

  assert.equal(normalized.followUps.length, 1);
  assert.equal(normalized.followUps[0].status, 'active');
  assert.equal(normalized.followUps[0].deferredUntil, '');
  assert.equal(normalized.followUps[0].deferPreset, '');
});

test('shell config service persists hidden python runtime enablement', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-python-runtime-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  assert.equal(service.getState().tools.pythonRuntime, false);

  service.updateFeatureSettings({ tools: { pythonRuntime: true } });

  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getState().tools.pythonRuntime, true);
});

test('shell config service persists hidden image read enablement', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-image-read-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  assert.equal(service.getState().tools.imageRead, false);

  service.updateFeatureSettings({ tools: { imageRead: true } });

  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getState().tools.imageRead, true);
});

test('shell config service retires the hidden Mermaid preference', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-mermaid-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  assert.equal(service.getState().tools.mermaid, undefined);

  service.updateFeatureSettings({ tools: { mermaid: false } });

  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getState().tools.mermaid, undefined);
});

test('normalizeState reads legacy telemetry consent and drops DSN-shaped metadata', () => {
  const normalized = normalizeState({
    telemetry: {
      crash_reporting_opt_in: true,
      telemetry_dsn: 'https://public@o123.ingest.sentry.io/456',
    },
  });

  assert.deepEqual(normalized.telemetry, {
    crashReportingOptIn: true,
  });
});

test('normalizeState lets canonical telemetry opt-out override legacy opt-in fields', () => {
  const normalized = normalizeState({
    crashReportingOptIn: true,
    crash_reporting_opt_in: true,
    telemetry: {
      crashReportingOptIn: false,
      telemetry_dsn: 'https://public@o123.ingest.sentry.io/456',
    },
  });

  assert.deepEqual(normalized.telemetry, {
    crashReportingOptIn: false,
  });
});

test('shell config service persists and normalizes maxBudgetUsd', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-max-budget-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  service.replaceState(
    {
      ...service.getState(),
      maxBudgetUsd: 12.5,
    },
    'max_budget_updated'
  );

  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getState().maxBudgetUsd, 12.5);
});

test('normalizeState reads snake_case max_budget_usd and rejects invalid values', () => {
  assert.equal(normalizeState({ max_budget_usd: 5.25 }).maxBudgetUsd, 5.25);
  assert.equal(normalizeState({ max_budget_usd: 0 }).maxBudgetUsd, null);
  assert.equal(normalizeState({ max_budget_usd: 2_000_000 }).maxBudgetUsd, null);
});

test('context length steps retain the Python ceiling twin', () => {
  // Twin: tests/sidecar/ai/test_model_generation_profile.py
  // ::test_context_ceiling_order_matches_renderer_config_and_ollama.
  assert.equal(Math.max(...CONTEXT_LENGTH_STEPS), 262144);
});

test('shell config service getCompactionTuning/setCompactionTuning persist, sanitize, and are idempotent', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-compaction-tuning-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  assert.deepEqual(service.getCompactionTuning(), {
    ratioByModel: {}, contextLengthByModel: {}, customPrompt: '',
  });

  const reasons = [];
  service.on('changed', (_snapshot, meta) => { reasons.push(meta?.reason); });

  const applied = service.setCompactionTuning({ modelId: 'qwen3:35b', ratio: 0.75 });
  assert.deepEqual(applied, {
    ratioByModel: { 'qwen3:35b': 0.75 }, contextLengthByModel: {}, customPrompt: '',
  });
  assert.ok(reasons.includes('compaction_tuning_updated'));

  // Out-of-range ratios are dropped rather than clamped.
  service.setCompactionTuning({ modelId: 'bad-model', ratio: 5 });
  assert.deepEqual(service.getCompactionTuning().ratioByModel, { 'qwen3:35b': 0.75 });

  service.setCompactionTuning({ modelId: 'qwen3:35b', contextLength: 131072 });
  assert.deepEqual(service.getCompactionTuning().contextLengthByModel, { 'qwen3:35b': 131072 });
  assert.equal(reasons.at(-1), 'context_length_tuning_updated');
  service.setCompactionTuning({ modelId: 'bad-model', contextLength: 12345 });
  assert.deepEqual(service.getCompactionTuning().contextLengthByModel, { 'qwen3:35b': 131072 });

  // A custom prompt persists independently of the per-model ratio map.
  service.setCompactionTuning({ customPrompt: 'Summarize tersely.' });
  assert.equal(service.getCompactionTuning().customPrompt, 'Summarize tersely.');
  assert.deepEqual(service.getCompactionTuning().ratioByModel, { 'qwen3:35b': 0.75 });
  assert.equal(reasons.at(-1), 'compaction_tuning_updated');

  // ratio: null removes the model's entry.
  service.setCompactionTuning({ modelId: 'qwen3:35b', ratio: null });
  assert.deepEqual(service.getCompactionTuning().ratioByModel, {});

  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getCompactionTuning().customPrompt, 'Summarize tersely.');
  assert.deepEqual(reloaded.getCompactionTuning().contextLengthByModel, { 'qwen3:35b': 131072 });
});

test('shell config service migrates v6 tool toggles and feature overrides into the v7 settings layer', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-feature-migrate-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 6,
    tools_web_enabled: true,
    tools_image_read_enabled: true,
    tools_python_runtime_enabled: false,
    tools_todo_enabled: true,
    feature_overrides: {
      cost_tracker: false,
      skills_system: true,
      ignored_flag: true,
    },
  }, null, 2));

  const service = new ShellConfigService({ userDataPath });
  const state = service.getState();

  assert.equal(state.version, CONFIG_VERSION);
  assert.deepEqual(state.tools, {
    web: true,
    imageRead: true,
    fileTools: true,
    pythonRuntime: false,
    bash: true,
    worktree: false,
    richFiles: true,
    subagents: true,
    lsp: false,
  });
  assert.equal(state.tools.todo, undefined);
  assert.equal(state.toolsWorktreeEnabled, false);
  assert.deepEqual(state.featureOverrides, { skills_system: true });
});

test('shell config service ignores the retired todo preference and persists feature overrides', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-feature-save-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  service.updateFeatureSettings({
    tools: {
      todo: true,
    },
    featureOverrides: {
      tips_surface: true,
    },
  });

  const reloaded = new ShellConfigService({ userDataPath });
  const state = reloaded.getState();
  assert.equal(state.tools.todo, undefined);
  assert.deepEqual(state.featureOverrides, {});
});

test('shell config service persists composer tool-toggle preferences (bash/fileTools) across restarts', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-tool-toggle-save-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  assert.equal(service.getState().tools.bash, true, 'bash preference defaults on');
  assert.equal(service.getState().tools.fileTools, true, 'fileTools preference defaults on');

  service.updateFeatureSettings({
    tools: {
      bash: false,
      fileTools: false,
    },
  });

  const reloaded = new ShellConfigService({ userDataPath });
  const state = reloaded.getState();
  assert.equal(state.tools.bash, false, 'bash=off survives restart');
  assert.equal(state.tools.fileTools, false, 'fileTools=off survives restart');
});

test('shell config service getState isolates nested follow-up sourceMeta and history entries', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-snapshot-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Check the plan',
    body: 'Review the saved plan.',
    sourceMeta: {
      task: {
        id: 'task-1',
        tags: ['planning'],
      },
    },
    history: [
      {
        kind: 'created',
        at: '2026-03-19T12:00:00.000Z',
        detail: 'Created open loop.',
      },
    ],
  });

  const firstState = service.getState();
  firstState.followUps[0].sourceMeta.task.id = 'mutated-task';
  firstState.followUps[0].sourceMeta.task.tags.push('mutated');
  firstState.followUps[0].history[0].detail = 'Mutated detail.';

  const nextState = service.getState();
  assert.equal(nextState.followUps[0].sourceMeta.task.id, 'task-1');
  assert.deepEqual(nextState.followUps[0].sourceMeta.task.tags, ['planning']);
  assert.notEqual(nextState.followUps[0].history[0].detail, 'Mutated detail.');
});

test('resetOnboarding commits setup and identity together while preserving workspace authority', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-onboarding-reset-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  service.setToolsWorkspaceRoot(userDataPath);
  service.updateSetupState({ seen: true, setupComplete: true, steps: { workspaceRoot: 'done' } });
  service.updateAssistantIdentity({ agentName: 'Echo', profile: 'creative' });

  const result = service.resetOnboarding();
  assert.equal(result.setup.setupComplete, false);
  assert.equal(result.assistantIdentity.agentName, 'Jenny');
  assert.equal(service.getToolsWorkspaceRoot(), userDataPath);

  const reloaded = new ShellConfigService({ userDataPath, env: {} });
  assert.equal(reloaded.getSetupState().setupComplete, false);
  assert.equal(reloaded.getAssistantIdentity().agentName, 'Jenny');
  assert.equal(reloaded.getToolsWorkspaceRoot(), userDataPath);
});

test('resetOnboarding reports a future-schema write block without changing in-memory state', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-onboarding-future-'));
  trackDirectory(userDataPath);
  fs.writeFileSync(path.join(userDataPath, 'shell-config.json'), JSON.stringify({
    version: CONFIG_VERSION + 1,
    setup: { seen: true, setupComplete: true },
    assistantIdentity: { agentName: 'Future', profile: 'mentor' },
  }));
  const service = new ShellConfigService({ userDataPath, env: {} });
  assert.throws(() => service.resetOnboarding(), { code: 'onboarding_reset_write_failed' });
  assert.equal(service.getSetupState().setupComplete, true);
  assert.equal(service.getAssistantIdentity().agentName, 'Future');
});

test('resetOnboarding reports a future-schema write block when the old snapshot already matches', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-onboarding-matching-future-'));
  trackDirectory(userDataPath);
  const nowProvider = () => new Date('2026-08-17T12:00:00.000Z');
  const baseline = new ShellConfigService({ userDataPath, env: {}, nowProvider });
  baseline.resetOnboarding();

  const configPath = path.join(userDataPath, 'shell-config.json');
  const futureState = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  futureState.version = CONFIG_VERSION + 1;
  fs.writeFileSync(configPath, JSON.stringify(futureState));

  const service = new ShellConfigService({ userDataPath, env: {}, nowProvider });
  assert.throws(() => service.resetOnboarding(), { code: 'onboarding_reset_write_failed' });
  assert.deepEqual(service.getSetupState(), baseline.getSetupState());
  assert.deepEqual(service.getAssistantIdentity(), baseline.getAssistantIdentity());
});
