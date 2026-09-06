'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { CONFIG_VERSION, normalizeState, serializeState } = require('../services/shell-config-state');
const {
  MAX_MODEL_TUNING_ENTRIES,
  normalizeGenerationProfile,
  normalizeModelTuning,
} = require('../services/shell-config-model-tuning');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

test('v38 auto-save migration preserves the preference unless the old effective flag was disabled', () => {
  const cases = [
    [{ workspace_auto_save: false }, true, false],
    [{ workspace_auto_save: false }, false, false],
    [{ workspace_auto_save: true }, true, true],
    [{ workspace_auto_save: true }, false, false],
    [{}, true, true],
    [{}, false, false],
  ];
  for (const [featureOverrides, preference, expected] of cases) {
    const state = normalizeState({
      version: 37,
      featureOverrides,
      workspaceIde: { autoSaveEnabled: preference },
    });
    assert.equal(state.workspaceIde.preferences.autoSaveEnabled, expected);
    assert.equal(Object.prototype.hasOwnProperty.call(state.featureOverrides, 'workspace_auto_save'), false);
  }
});

test('v38 retains only a valid non-default legacy timeout as a pending one-shot value', () => {
  assert.equal(normalizeState({ version: 37, chunkInactivitySeconds: 180 }).modelTuning.pendingLegacyStreamInactivitySeconds, 180);
  for (const value of [120, 4, 301, 10.5, 'bad', null]) {
    assert.equal(
      normalizeState({ version: 37, chunkInactivitySeconds: value }).modelTuning.pendingLegacyStreamInactivitySeconds,
      null
    );
  }
  const serialized = serializeState(normalizeState({ version: 37, preserveThinking: true, chunkInactivitySeconds: 180 }));
  assert.equal(Object.prototype.hasOwnProperty.call(serialized, 'preserveThinking'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(serialized, 'chunkInactivitySeconds'), false);
});

test('model tuning bounds ids, values, and map size', () => {
  const oversized = Object.fromEntries(Array.from({ length: 140 }, (_, index) => [`model-${index}`, 60 + (index % 4) * 60]));
  oversized['x'.repeat(241)] = 180;
  oversized.invalid = 4;
  const tuning = normalizeModelTuning({ streamInactivitySecondsByModel: oversized });
  assert.ok(Object.keys(tuning.streamInactivitySecondsByModel).length <= MAX_MODEL_TUNING_ENTRIES);
  assert.equal(tuning.streamInactivitySecondsByModel.invalid, undefined);
  // Both assertions above are satisfied by an EMPTY map, so pin the survivors:
  // 140 valid entries evict oldest-first down to the cap, leaving model-12..139.
  assert.equal(Object.keys(tuning.streamInactivitySecondsByModel).length, MAX_MODEL_TUNING_ENTRIES);
  assert.equal(tuning.streamInactivitySecondsByModel['model-12'], 60);
  assert.equal(tuning.streamInactivitySecondsByModel['model-139'], 240);
  assert.equal(tuning.streamInactivitySecondsByModel['x'.repeat(241)], undefined);
});

test('v43 generation profiles preserve valid per-model values and drop malformed fields independently', () => {
  const state = normalizeState({
    version: 42,
    modelTuning: {
      streamInactivitySecondsByModel: { 'gemma3:latest': 180 },
      generationProfilesByModel: {
        'gemma3:latest': { temperature: 0.6, topK: 20, maxOutputTokens: 4096, topP: 9 },
        broken: { temperature: 'hot' },
      },
    },
  });
  assert.equal(state.version, CONFIG_VERSION);
  assert.equal(state.modelTuning.streamInactivitySecondsByModel['gemma3:latest'], 180);
  assert.deepEqual(state.modelTuning.generationProfilesByModel, {
    'gemma3:latest': { temperature: 0.6, topK: 20, maxOutputTokens: 4096 },
  });
  assert.deepEqual(normalizeGenerationProfile({ topK: 1.5, temperature: -1 }), {});
});

test('generation profile updates are model-scoped and reset without changing stream timeout', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-generation-profile-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath });
  service.updateModelTuning({
    modelId: 'gemma3:latest',
    streamInactivitySeconds: 180,
    generationProfile: { temperature: 0.5, topP: 0.9 },
  });
  assert.deepEqual(service.getModelTuning().generationProfilesByModel['gemma3:latest'], {
    temperature: 0.5,
    topP: 0.9,
  });
  service.updateModelTuning({ modelId: 'gemma3:latest', resetGenerationProfile: true });
  assert.equal(service.getModelTuning().generationProfilesByModel['gemma3:latest'], undefined);
  assert.equal(service.getModelTuning().streamInactivitySecondsByModel['gemma3:latest'], 180);
});

test('first resolved model claims the legacy value once unless an override already exists', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-tuning-'));
  trackDirectory(userDataPath);
  fs.writeFileSync(path.join(userDataPath, 'shell-config.json'), JSON.stringify({
    version: 37,
    chunkInactivitySeconds: 180,
  }));
  const service = new ShellConfigService({ userDataPath });
  assert.deepEqual(service.resolveStreamInactivitySeconds('', { cloud: false }), { seconds: 120, automatic: true });
  assert.deepEqual(service.resolveStreamInactivitySeconds('gemma3:latest'), { seconds: 180, automatic: false });
  assert.equal(service.getModelTuning().pendingLegacyStreamInactivitySeconds, null);
  assert.deepEqual(service.resolveStreamInactivitySeconds('qwen3:latest', { cloud: true }), { seconds: 300, automatic: true });
  assert.deepEqual(service.resolveStreamInactivitySeconds('gemma3:latest'), { seconds: 180, automatic: false });
});

test('an existing override wins and consumes the one-shot legacy value', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-tuning-override-'));
  trackDirectory(userDataPath);
  fs.writeFileSync(path.join(userDataPath, 'shell-config.json'), JSON.stringify({
    version: 39,
    modelTuning: {
      streamInactivitySecondsByModel: { 'gemma3:latest': 60 },
      pendingLegacyStreamInactivitySeconds: 180,
    },
  }));
  const service = new ShellConfigService({ userDataPath });
  assert.deepEqual(service.resolveStreamInactivitySeconds('gemma3:latest'), { seconds: 60, automatic: false });
  assert.equal(service.getModelTuning().pendingLegacyStreamInactivitySeconds, null);
  assert.deepEqual(service.resolveStreamInactivitySeconds('qwen3:latest'), { seconds: 120, automatic: true });
});

test('explicit updates persist and null restores Automatic', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-tuning-update-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath });
  assert.deepEqual(service.updateModelTuning({ modelId: 'gemma3:latest', streamInactivitySeconds: 60 }).streamInactivitySecondsByModel, {
    'gemma3:latest': 60,
  });
  assert.deepEqual(service.resolveStreamInactivitySeconds('gemma3:latest'), { seconds: 60, automatic: false });
  service.updateModelTuning({ modelId: 'gemma3:latest', streamInactivitySeconds: null });
  assert.deepEqual(service.resolveStreamInactivitySeconds('gemma3:latest'), { seconds: 120, automatic: true });
});

test('Ollama bare and latest aliases resolve the same model override', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-tuning-alias-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath });
  service.updateModelTuning({ modelId: 'Gemma3:latest', streamInactivitySeconds: 60 });

  assert.deepEqual(
    service.resolveStreamInactivitySeconds('gemma3', { ollama: true }),
    { seconds: 60, automatic: false }
  );
  assert.deepEqual(
    service.resolveStreamInactivitySeconds('gemma3', { ollama: false }),
    { seconds: 120, automatic: true }
  );
});
