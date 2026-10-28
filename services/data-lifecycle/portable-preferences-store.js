'use strict';

const path = require('path');
const { preserveCorruptFile } = require('../backend/corrupt-file-preserve');
const { isPlainObject } = require('../backend/journaled-json-files');
const { FileJsonStore } = require('../backend/file-json-store');
const { CONFIG_VERSION, normalizeState } = require('../shell-config-state');
const { MAX_PROACTIVE_REMINDERS, normalizeReminder } = require('../shell-config-followups-schema');
const { AUTO_APPROVE_STREAK_CAP_DEFAULT } = require('../shell-config-normalizers');
const { normalizeChatUiZoomPercent } = require('../shell-config-zoom-state');

const PORTABLE_PREFERENCES_VERSION = 1;
// The projection below is stamped with the live shell-config schema version so a
// current desktop export restores; a pinned literal lagged and refused v55+ exports.
const PORTABLE_SHELL_CONFIG_VERSION = CONFIG_VERSION;
const PORTABLE_PREFERENCES_RELATIVE_PATH = path.join('data-lifecycle', 'portable-preferences.json');
const APPEARANCE_KEYS = Object.freeze([
  'paletteId',
  'typographyId',
  'motionId',
  'surfaceEffectId',
  'composerHoloId',
  'spriteHoloId',
  'threadStyleId',
  'fontScaleId',
  'chatWidthId',
  'typeScaleVersion',
  'explicitMotion',
  'startupAnimation',
  'titlebarLoad',
  'artifactAutoOpen',
]);
const LOCAL_ENGINE_TYPES = Object.freeze(['ollama', 'vllm']);
const MAX_PORTABLE_SCRATCHPAD_BYTES = 64 * 1024;
// Safety switches a restore may turn on but never off: an archive is outside input,
// so a restore can tighten the safety posture but not loosen it below the defaults.
const SAFETY_FEATURE_OVERRIDES = Object.freeze(['shell_security', 'unattended_guard']);

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

// Every top-level key of the live shell-config state is classified here; a guard
// test fails when a new key is in neither list. A restore writes only the
// PORTABLE sections, each through its canonical shell-config normalizer, and the
// EXCLUDED keys and sub-keys come back as defaults on the restored profile.
// Credentials never live in shell-config (they are in the safeStorage store).
const SHELL_CONFIG_PORTABILITY = deepFreeze({
  portable: {
    commandSandbox: 'Safety preference; fails closed where Docker is unavailable.',
    sessionRuntime: 'Session concurrency limits, written as session_runtime.',
    subagentRouting: 'Subagent model, effort and allowlist choices.',
    maxBudgetUsd: 'Read mirror of engineTuning.maxBudgetUsd.',
    modelTuning: 'Per-model stream timeouts and generation profiles.',
    engineTuning: 'Advanced loop, tool and timeout caps (schema-bounded numbers).',
    compactionTuning: 'Per-model compaction ratios and the custom compaction prompt.',
    tools: 'Tool on/off switches.',
    toolsWorktreeEnabled: 'Read mirror of tools.worktree.',
    webSearch: 'Search provider and the SearXNG URL; provider keys stay in the secure store.',
    chatUi: 'Chat zoom and the default transcript view.',
    windowUi: 'Desktop notification preferences.',
    featureOverrides: 'Feature switches; a restore never turns a safety switch off.',
    assistantIdentity: 'Assistant name.',
    preferredEngineType: 'Local engine preference: ollama or vllm, otherwise unset.',
    defaultRunMode: 'Default run mode.',
    uiLanguage: 'Interface language.',
    use24HourTime: 'Clock format.',
    safetyMode: 'Safety mode.',
    autoApproveStreakCap: 'Auto-approve streak cap, never restored above the default.',
    unattendedGuardMinutes: 'Unattended guard minutes.',
    companion: 'Companion mode.',
    home: 'Home scratchpad (64 KB bound), widgets, calendar view, focus and tips switches.',
    skills: 'Bundled skills switch, disabled skill ids and auto-index mode.',
    memory: 'Memory switches, including when note taking last turned on.',
    proactive: 'Reminders (capped at the reminder limit).',
    workspaceIde: 'Editor and panel preferences shared by every workspace.',
  },
  excluded: {
    version: 'Schema marker; the projection stamps the current CONFIG_VERSION.',
    performanceTelemetry: 'GPU warning and counter settings belong to this machine.',
    primaryChat: 'Jenny chat pause state and standing launch permissions belong to this machine.',
    apiProviders: 'API-key provider instances are bound to keys in the secure store of this machine; restored without keys they would be dead providers.',
    toolsWorkspaceRoot: 'Absolute workspace root path.',
    telemetry: 'Crash-reporting consent is given per install.',
    setup: 'Onboarding progress, including the machine-bound workspace and model steps.',
    offlineIntelligence: 'Offline mode names a locally installed model.',
    localEngines: 'Engine ports, model and runtime paths, managed servers and GPU watchdog.',
    lastChatgptModel: 'Last-used model target recorded by this machine.',
    chatgptModelsEnabled: 'Retired-plugin migration marker (null until migrated).',
    codexCli: 'CLI command path and install-dependent enablement.',
    followUps: 'Follow-up records with free-form source metadata, not preferences.',
    workspace: 'Open chat tabs and split panes of this window.',
  },
  excludedSubkeys: {
    'windowUi.appZoomPercent': 'Display scaling chosen for this monitor.',
    'windowUi.dictation': 'The microphone picked on this computer (a per-device id).',
    'home.links': 'Auto-polled link and site-monitor URLs that may carry credentials.',
    'home.calendar.feeds': 'Auto-polled ICS feed URLs, often private secret links.',
    'home.layout': 'Home rail pixel width (window geometry).',
    'modelTuning.pendingLegacyStreamInactivitySeconds': 'One-shot migration carry-over.',
    'compactionTuning.contextLengthByModel': 'Context lengths sized to this GPU memory.',
    'skills.userEnabled': 'Trust grant for personal skill bodies, given per machine.',
    'skills.projectEnabled': 'Trust grant for project skill bodies, given per machine.',
    'workspaceIde.roots': 'Per-workspace state keyed by ids derived from absolute paths.',
    'workspaceIde.rootLru': 'Order of the per-workspace state above.',
    'workspaceIde.preferences.railWidth': 'Pane pixel width (window geometry).',
    'workspaceIde.preferences.secondaryWidth': 'Pane pixel width (window geometry).',
    'workspaceIde.preferences.chatDockWidth': 'Pane pixel width (window geometry).',
    'workspaceIde.preferences.bottomPanelHeight': 'Pane pixel height (window geometry).',
    'workspaceIde.preferences.workbenchLayout': 'Saved pane layout geometry.',
  },
});
// The on-disk spelling the shell-config file uses for a state key.
const PORTABLE_FILE_KEYS = Object.freeze({ sessionRuntime: 'session_runtime' });

function pickJsonScalar(source, key) {
  const value = source?.[key];
  if (typeof value === 'string') return value.slice(0, 128);
  if (typeof value === 'boolean') return value;
  if (Number.isFinite(value)) return value;
  return undefined;
}

function normalizeAppearance(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const key of APPEARANCE_KEYS) {
    const normalized = pickJsonScalar(source, key);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function normalizePortablePreferences(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  // Only a real number counts: Number(null) is 0 and would clamp to the minimum.
  const chatZoomPercent = typeof source.chatZoomPercent === 'number' ? source.chatZoomPercent : NaN;
  const updatedAt = typeof source.updated_at === 'string'
    && source.updated_at.length <= 64
    && Number.isFinite(Date.parse(source.updated_at))
    ? source.updated_at
    : new Date().toISOString();
  return {
    schema_version: PORTABLE_PREFERENCES_VERSION,
    updated_at: updatedAt,
    appearance: normalizeAppearance(source.appearance),
    ...(Number.isFinite(chatZoomPercent)
      ? { chatZoomPercent: normalizeChatUiZoomPercent(chatZoomPercent) }
      : {}),
    ...(typeof source.preferredModel === 'string' && source.preferredModel.trim()
      ? { preferredModel: source.preferredModel.trim().slice(0, 160) }
      : {}),
  };
}

function pickBoundedText(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function omitPath(target, dottedPath) {
  const parts = dottedPath.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    node = node?.[part];
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  }
  delete node[parts.at(-1)];
}

// Reminders without an id or label are dropped rather than given a fresh id.
function projectReminders(source) {
  return Array.isArray(source.proactive?.reminders)
    ? source.proactive.reminders.slice(0, MAX_PROACTIVE_REMINDERS)
      .filter((item) => pickBoundedText(item?.id, 160) && pickBoundedText(item?.label, 160))
      .map((item) => normalizeReminder({ ...item, id: pickBoundedText(item.id, 160) }))
    : [];
}

// normalizeState runs the shell-config migrations and canonical normalizers, so an
// older archive is upgraded before its PORTABLE sections are copied. Absent keys
// read as defaults on load, so an archive written before a key existed still restores.
function projectPortableShellConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const state = normalizeState(source);
  const result = { version: PORTABLE_SHELL_CONFIG_VERSION };
  for (const key of Object.keys(SHELL_CONFIG_PORTABILITY.portable)) {
    result[PORTABLE_FILE_KEYS[key] || key] = JSON.parse(JSON.stringify(state[key] ?? null));
  }
  for (const dottedPath of Object.keys(SHELL_CONFIG_PORTABILITY.excludedSubkeys)) {
    omitPath(result, dottedPath);
  }
  // '' stays unset (infer from the model); a cloud or unknown engine is machine-specific.
  if (!LOCAL_ENGINE_TYPES.includes(result.preferredEngineType)) result.preferredEngineType = '';
  for (const flag of SAFETY_FEATURE_OVERRIDES) {
    if (result.featureOverrides[flag] === false) delete result.featureOverrides[flag];
  }
  result.autoApproveStreakCap = Math.min(result.autoApproveStreakCap, AUTO_APPROVE_STREAK_CAP_DEFAULT);
  result.proactive = { reminders: projectReminders(source) };
  const scratchpad = JSON.stringify(result.home.scratchpad);
  if (Buffer.byteLength(scratchpad, 'utf8') > MAX_PORTABLE_SCRATCHPAD_BYTES) {
    delete result.home.scratchpad;
  }
  return result;
}

function portableContentKey(preferences) {
  const { updated_at: _ignored, ...content } = preferences;
  return JSON.stringify(content);
}

class PortablePreferencesStore {
  constructor(userDataPath, { store = null, logger = null } = {}) {
    if (!String(userDataPath || '').trim()) {
      throw new TypeError('PortablePreferencesStore requires userDataPath.');
    }
    this.filePath = path.join(path.resolve(userDataPath), PORTABLE_PREFERENCES_RELATIVE_PATH);
    this.store = store || new FileJsonStore(this.filePath, { logger });
    this._logger = logger;
  }

  read() {
    const state = this.store.readWithStatus(null);
    if (state.missing) return null;
    if (state.corrupted || state.unreadable || !state.value
      || state.value.schema_version > PORTABLE_PREFERENCES_VERSION) {
      return null;
    }
    return normalizePortablePreferences(state.value);
  }

  sync(preferences) {
    const patch = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
      ? preferences
      : {};
    const state = this.store.readWithStatus(null);
    if (state.unreadable) throw new Error('portable_preferences_unreadable');
    if (!state.missing && !state.corrupted
      && Number(state.value?.schema_version) > PORTABLE_PREFERENCES_VERSION) {
      throw new Error('portable_preferences_version_unsupported');
    }
    const damaged = !state.missing && (state.corrupted || !isPlainObject(state.value));
    // The mirror can hold the only copy of renderer-side preferences: damaged
    // bytes move aside before a regenerated file replaces them, or stay put.
    if (damaged) {
      const outcome = preserveCorruptFile(this.filePath, { logger: this._logger });
      if (!outcome.preserved && outcome.reason !== 'missing') throw new Error('portable_preferences_damaged');
    }
    const current = state.missing || damaged
      ? {}
      : normalizePortablePreferences(state.value);
    const next = normalizePortablePreferences({
      ...current,
      ...patch,
      appearance: Object.hasOwn(patch, 'appearance')
        ? patch.appearance
        : current.appearance,
      updated_at: new Date().toISOString(),
    });
    // Skip the synchronous fsync write when nothing portable changed.
    const hasCurrent = !state.missing && !damaged;
    if (hasCurrent && portableContentKey(current) === portableContentKey(next)) return current;
    this.store.writeImmediate(next);
    return next;
  }
}

module.exports = {
  PORTABLE_PREFERENCES_VERSION,
  PORTABLE_SHELL_CONFIG_VERSION,
  PortablePreferencesStore,
  SHELL_CONFIG_PORTABILITY,
  normalizePortablePreferences,
  projectPortableShellConfig,
};
