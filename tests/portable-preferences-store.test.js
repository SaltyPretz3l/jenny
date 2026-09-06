const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PortablePreferencesStore,
  normalizePortablePreferences,
  projectPortableShellConfig,
} = require('../services/data-lifecycle/portable-preferences-store');

function withTempDir(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-portable-preferences-'));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('PortablePreferencesStore', () => {
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
  }));

  it('merges partial renderer updates without erasing an archived model preference', () => withTempDir((root) => {
    const store = new PortablePreferencesStore(root);
    store.sync({ preferredModel: 'qwen3', appearance: { paletteId: 'paper' } });
    const saved = store.sync({ appearance: { paletteId: 'obsidian' }, chatZoomPercent: 115 });
    assert.equal(saved.preferredModel, 'qwen3');
    assert.deepEqual(saved.appearance, { paletteId: 'obsidian' });
    assert.equal(saved.chatZoomPercent, 115);
  }));

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
    assert.equal(result.chatUi.zoomPercent, 125);
    assert.deepEqual(result.proactive.reminders[0], {
      id: 'one', label: 'Remember', prompt: 'Call someone', enabled: true,
    });
    assert.deepEqual(Object.keys(result.proactive), ['reminders']);
    assert.deepEqual(result.home, { scratchpad: { text: 'portable note' } });
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(JSON.stringify(result).includes('token'), false);
  });
});
