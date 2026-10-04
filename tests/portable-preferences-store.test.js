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
    assert.deepEqual(result.proactive.reminders[0], {
      id: 'one', label: 'Remember', prompt: 'Call someone', enabled: true,
    });
    assert.deepEqual(Object.keys(result.proactive), ['reminders']);
    assert.deepEqual(result.home, { scratchpad: { text: 'portable note' } });
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(JSON.stringify(result).includes('token'), false);
  });

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
