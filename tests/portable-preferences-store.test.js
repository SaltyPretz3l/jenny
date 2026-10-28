const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PORTABLE_SHELL_CONFIG_VERSION,
  PortablePreferencesStore,
  normalizePortablePreferences,
  projectPortableShellConfig,
} = require('../services/data-lifecycle/portable-preferences-store');
const {
  projectRestoredPreference,
} = require('../services/data-lifecycle/restore-preferences');
const {
  DEFAULT_SESSION_RUNTIME,
} = require('../services/shell-config-session-runtime');
const { CONFIG_VERSION } = require('../services/shell-config-state');

function withTempDir(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-portable-preferences-'));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('PortablePreferencesStore', () => {
  it('keeps the startup-animation and title-bar-load switches across launches', () => withTempDir((root) => {
    const store = new PortablePreferencesStore(root);
    store.sync({ appearance: { paletteId: 'luma', startupAnimation: false, titlebarLoad: true } });
    assert.deepEqual(new PortablePreferencesStore(root).read().appearance,
      { paletteId: 'luma', startupAnimation: false, titlebarLoad: true });
  }));

  it('persists only the bounded allowlisted projection', () => withTempDir((root) => {
    const store = new PortablePreferencesStore(root);
    const saved = store.sync({
      appearance: { paletteId: 'luma', explicitMotion: false, secret: 'nope' },
      chatZoomPercent: 121,
      preferredModel: '  qwen3  ',
      authToken: 'never',
    });

    assert.deepEqual(saved.appearance, { paletteId: 'luma', explicitMotion: false });
    assert.equal(saved.chatZoomPercent, 120);
    assert.equal(saved.preferredModel, 'qwen3');
    assert.equal(Object.hasOwn(saved, 'authToken'), false);
    assert.deepEqual(store.read(), saved);
  }));

  it('returns null for missing, corrupt, and future-version state', () => withTempDir((root) => {
    const store = new PortablePreferencesStore(root);
    assert.equal(store.read(), null);
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, '{bad', 'utf8');
    assert.equal(store.read(), null);
    fs.writeFileSync(store.filePath, JSON.stringify({ schema_version: 99 }), 'utf8');
    assert.equal(store.read(), null);
    const futureBytes = fs.readFileSync(store.filePath, 'utf8');
    assert.throws(() => store.sync({ preferredModel: 'do-not-write' }), /version_unsupported/);
    assert.equal(fs.readFileSync(store.filePath, 'utf8'), futureBytes);
  }));

  it('merges partial renderer updates without erasing an archived model preference', () => withTempDir((root) => {
    const store = new PortablePreferencesStore(root);
    store.sync({ preferredModel: 'qwen3', appearance: { paletteId: 'paper' } });
    const saved = store.sync({ appearance: { paletteId: 'obsidian' }, chatZoomPercent: 115 });
    assert.equal(saved.preferredModel, 'qwen3');
    assert.deepEqual(saved.appearance, { paletteId: 'obsidian' });
    assert.equal(saved.chatZoomPercent, 115);
  }));

  it('drops the retired timelineStyleId from an older archive', () => {
    const result = normalizePortablePreferences({
      appearance: { paletteId: 'paper', timelineStyleId: 'default' },
    });
    assert.deepEqual(result.appearance, { paletteId: 'paper' });
  });

  it('normalizes malformed input to safe defaults', () => {
    const result = normalizePortablePreferences({ appearance: [], chatZoomPercent: -4 });
    assert.deepEqual(result.appearance, {});
    assert.equal(result.chatZoomPercent, 85);
  });

  it('bounds and validates portable preference timestamps', () => {
    const result = normalizePortablePreferences({ updated_at: 'x'.repeat(10_000) });
    assert.equal(result.updated_at.length <= 64, true);
    assert.equal(Number.isFinite(Date.parse(result.updated_at)), true);
  });

  it('projects reminders, scratchpad, zoom, and local engine without machine or secret fields', () => {
    const result = projectPortableShellConfig({
      preferredEngineType: 'vllm',
      chatUi: { zoomPercent: 123 },
      proactive: {
        reminders: [{ id: 'one', label: 'Remember', prompt: 'Call someone', token: 'nope' }],
      },
      home: { scratchpad: { text: 'portable note' }, secret: 'nope' },
      toolsWorkspaceRoot: 'C:\\private',
      secureState: { token: 'never' },
    });
    assert.equal(result.preferredEngineType, 'vllm');
    assert.equal(result.version, PORTABLE_SHELL_CONFIG_VERSION);
    assert.deepEqual(result.session_runtime, DEFAULT_SESSION_RUNTIME);
    assert.equal(result.chatUi.zoomPercent, 125);
    assert.equal(result.proactive.reminders[0].id, 'one');
    assert.equal(result.proactive.reminders[0].prompt, 'Call someone');
    assert.equal(result.proactive.reminders[0].enabled, true);
    assert.equal(Object.hasOwn(result.proactive.reminders[0], 'token'), false);
    assert.deepEqual(Object.keys(result.proactive), ['reminders']);
    // The legacy single-text scratchpad is upgraded by the canonical home normalizer.
    assert.equal(result.home.scratchpad.notes[0].text, 'portable note');
    assert.equal(Object.hasOwn(result.home, 'secret'), false);
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(JSON.stringify(result).includes('token'), false);
  });

  it('keeps each reminder schedule, source and timestamps through the projection', () => {
    const reminders = [
      { id: 'a', label: 'Daily', prompt: 'p', scheduleType: 'daily_at', dailyAt: '07:30',
        createdAt: '2026-01-02T03:04:05.000Z', lastFiredAt: '2026-02-03T04:05:06.000Z' },
      { id: 'b', label: 'Every', prompt: 'p', scheduleType: 'interval_minutes', intervalMinutes: 45, enabled: false },
      { id: 'c', label: 'Once', prompt: 'p', scheduleType: 'once_at', onceAt: '2030-05-06T07:08',
        sourceKind: 'assistant', sourceId: 'evt-1' },
      { id: '', label: 'No id' },
    ];
    const projected = projectPortableShellConfig({ proactive: { reminders } }).proactive.reminders;
    assert.deepEqual(projected.map((item) => item.id), ['a', 'b', 'c']);
    assert.equal(projected[0].scheduleType, 'daily_at');
    assert.equal(projected[0].dailyAt, '07:30');
    assert.equal(projected[0].createdAt, '2026-01-02T03:04:05.000Z');
    assert.equal(projected[0].lastFiredAt, '2026-02-03T04:05:06.000Z');
    assert.equal(projected[1].scheduleType, 'interval_minutes');
    assert.equal(projected[1].intervalMinutes, 45);
    assert.equal(projected[1].enabled, false);
    assert.equal(projected[2].scheduleType, 'once_at');
    assert.equal(projected[2].onceAt, '2030-05-06T07:08');
    assert.equal(projected[2].sourceKind, 'assistant');
    assert.equal(projected[2].sourceId, 'evt-1');
    const many = Array.from({ length: 80 }, (_, index) => ({ id: `r${index}`, label: 'L' }));
    assert.equal(projectPortableShellConfig({ proactive: { reminders: many } }).proactive.reminders.length, 50);
  });

  it('keeps an unset preferred engine unset and drops a non-local engine instead of forcing ollama', () => {
    assert.equal(projectPortableShellConfig({ preferredEngineType: '' }).preferredEngineType, '');
    assert.equal(projectPortableShellConfig({}).preferredEngineType, '');
    assert.equal(projectPortableShellConfig({ preferredEngineType: 'chatgpt' }).preferredEngineType, '');
    assert.equal(projectPortableShellConfig({ preferredEngineType: 'ollama' }).preferredEngineType, 'ollama');
  });

  it('reads zoom from the canonical chatUi value, then the legacy top level, else 100', () => {
    const zoom = (source) => projectPortableShellConfig(source).chatUi.zoomPercent;
    assert.equal(zoom({ chatUi: { zoomPercent: 120 }, chatZoomPercent: 90 }), 120);
    assert.equal(zoom({ chatZoomPercent: 110 }), 110);
    assert.equal(zoom({ chatUi: {}, chatZoomPercent: 130 }), 130);
    assert.equal(zoom({ chatUi: { zoomPercent: null }, chatZoomPercent: null }), 100);
    assert.equal(zoom({}), 100);
    assert.equal(normalizePortablePreferences({ chatZoomPercent: null }).chatZoomPercent, undefined);
    assert.equal(normalizePortablePreferences({ chatZoomPercent: '120' }).chatZoomPercent, undefined);
  });

  it('skips the write when synced appearance, model and zoom are unchanged', () => withTempDir((root) => {
    const store = new PortablePreferencesStore(root);
    const first = store.sync({ appearance: { paletteId: 'luma' }, chatZoomPercent: 110, preferredModel: 'qwen3' });
    const bytes = fs.readFileSync(store.filePath, 'utf8');
    const again = store.sync({ appearance: { paletteId: 'luma' }, chatZoomPercent: 110, preferredModel: 'qwen3' });
    assert.equal(again.updated_at, first.updated_at);
    assert.equal(fs.readFileSync(store.filePath, 'utf8'), bytes);
    const changed = store.sync({ chatZoomPercent: 115 });
    assert.equal(changed.chatZoomPercent, 115);
    assert.notEqual(fs.readFileSync(store.filePath, 'utf8'), bytes);
  }));

  it('leaves last-used model targets out of the portable projection', () => {
    const result = projectPortableShellConfig({
      preferredEngineType: 'ollama',
      lastChatgptModel: 'gpt-6-luna',
      localEngines: { openaiCompatible: { managed: { lastUsedTag: 'ornith-9b' } } },
    });
    assert.equal(Object.hasOwn(result, 'lastChatgptModel'), false);
    assert.equal(Object.hasOwn(result, 'localEngines'), false);
    assert.equal(JSON.stringify(result).includes('gpt-6-luna'), false);
    assert.equal(JSON.stringify(result).includes('ornith-9b'), false);
  });

  it('round-trips allowlisted v54 session runtime limits', () => {
    const projected = projectPortableShellConfig({
      sessionRuntime: {
        local: { runnable_turns: 2, inference_requests: 3, descendants: 4, descendant_depth: 1 },
        cloud: { runnable_turns: 5, inference_requests: 6, descendants: 7, descendant_depth: 2 },
        resources: { tool_operations: 8, native_processes: 9, tests: 3 },
      },
    });
    assert.deepEqual(projected.session_runtime, {
      local: { runnable_turns: 2, inference_requests: 3, descendants: 4, descendant_depth: 1 },
      cloud: { runnable_turns: 5, inference_requests: 6, descendants: 7, descendant_depth: 2 },
      resources: { tool_operations: 8, native_processes: 9, tests: 3 },
    });
    assert.deepEqual(projectPortableShellConfig(projected).session_runtime,
      projected.session_runtime);
  });

  it('normalizes malformed portable runtime limits to bounded defaults', () => {
    const projected = projectPortableShellConfig({
      session_runtime: {
        local: { runnable_turns: 0, inference_requests: '4', descendants: -1 },
        cloud: [],
        resources: { tests: 99, sandbox_commands: 4 },
      },
    });
    assert.deepEqual(projected.session_runtime, DEFAULT_SESSION_RUNTIME);
    assert.equal(Object.hasOwn(projected.session_runtime.resources, 'sandbox_commands'), false);
  });

  it('accepts a current desktop shell-config export on restore', () => withTempDir((root) => {
    // The portable version is the shell-config schema version: a lagging
    // constant refused every export written by the current desktop build.
    assert.equal(PORTABLE_SHELL_CONFIG_VERSION, CONFIG_VERSION);
    const shellPath = path.join(root, 'shell.json');
    fs.writeFileSync(shellPath, JSON.stringify({ version: CONFIG_VERSION, preferredEngineType: 'vllm' }));
    const restored = JSON.parse(projectRestoredPreference({
      logical_path: 'preferences/shell-config.json',
    }, shellPath).toString('utf8'));
    assert.equal(restored.version, CONFIG_VERSION);
    assert.equal(restored.preferredEngineType, 'vllm');
  }));

  it('restore projection refuses future portable and shell preference versions', () => withTempDir((root) => {
    const portablePath = path.join(root, 'portable.json');
    const shellPath = path.join(root, 'shell.json');
    fs.writeFileSync(portablePath, JSON.stringify({ schema_version: 2 }));
    fs.writeFileSync(shellPath, JSON.stringify({ version: PORTABLE_SHELL_CONFIG_VERSION + 1 }));

    assert.throws(() => projectRestoredPreference({
      logical_path: 'preferences/portable-preferences.json',
    }, portablePath), /newer schema version/);
    assert.throws(() => projectRestoredPreference({
      logical_path: 'preferences/shell-config.json',
    }, shellPath), /newer schema version/);
  }));
});
