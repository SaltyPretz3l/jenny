'use strict';

// Tune > Engine copy for what the managed server actually runs: the context the
// memory plan served (services/backend/llama-server-memory-fit.js) and MTP
// drafted by the GGUF's own head (reason mtp_embedded).

const test = require('node:test');
const assert = require('node:assert/strict');

const engineUtils = require('../renderer/shell/renderer-model-tuning-engine-utils');

const MODEL = 'qwen3.8-27b-x-q6_k';
const catalog = {
  defaults: { vramHeadroomMb: 2048 },
  families: [{ family: 'qwen38', matchPrefixes: ['qwen3-8'], mtp: 'yes', vramHeadroomMb: 3072 }],
};

function deriveView(serverStatus) {
  return engineUtils.deriveEngineView({
    activeModelId: MODEL,
    engineType: 'openai-compatible',
    shellState: {},
    engineSettings: {
      localEngines: { openaiCompatible: { managed: { enabled: true, perModel: {
        [MODEL]: { engine: 'llama-server', modelPath: 'G:\\models\\q\\model.gguf', mtp: { mode: 'mtp' } },
      } } } },
      accelerationCatalog: catalog,
    },
    localGgufs: { entries: [{ tag: MODEL, dir: 'G:\\models\\q', mainGguf: 'model.gguf', drafterGguf: '', source: 'persisted' }] },
    serverStatus,
  });
}

test('a server drafting with the embedded head replaces the drafter-missing note', () => {
  const serving = deriveView({ state: 'ready', alias: MODEL, accelerationMode: 'mtp', accelerationReason: 'mtp_embedded' });
  assert.equal(serving.servingEmbeddedHead, true);
  assert.equal(engineUtils.engineNote(serving), 'Uses the MTP head built into this model');

  const stopped = deriveView(null);
  assert.equal(stopped.servingEmbeddedHead, false);
  assert.equal(engineUtils.engineNote(stopped), 'Drafter file missing \u00b7 falls back to plain decoding');

  const otherModel = deriveView({ state: 'ready', alias: 'other-model', accelerationMode: 'mtp', accelerationReason: 'mtp_embedded' });
  assert.equal(otherModel.servingEmbeddedHead, false);

  engineUtils.applyPickedGguf(serving, serving.draft, { path: 'G:\\models\\other\\model.gguf', dir: 'G:\\models\\other', drafterGguf: '' });
  assert.equal(serving.servingEmbeddedHead, false, 'a different file has not been served yet');
});

test('the Context window row names a context the memory plan capped; the serving line stays short', () => {
  const view = { serving: true };
  const status = {
    port: 8033, accelerationMode: 'mtp', accelerationReason: 'mtp_embedded',
    contextSize: 262144, servedContextSize: 166400,
  };
  assert.equal(engineUtils.engineStatusText(view, { mtp: true }, status), 'Serving on :8033 · MTP on');
  const k = (tokens) => Math.round(tokens / 1024) + 'K';
  assert.equal(engineUtils.servedContextNote(view, status, k), 'llama-server runs 163K so every layer fits on the GPU.');

  for (const servedContextSize of [262144, 0, undefined]) {
    assert.equal(engineUtils.servedContextNote(view, { ...status, servedContextSize }, k), '', String(servedContextSize));
  }
  assert.equal(engineUtils.servedContextNote({ serving: false }, status, k), '', 'not served: nothing to say');
  assert.equal(engineUtils.servedContextNote(null, status, k), '');
});
