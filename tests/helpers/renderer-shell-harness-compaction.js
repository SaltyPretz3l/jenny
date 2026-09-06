'use strict';

const CONTEXT_LENGTH_STEPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];

function createDefaultTuning() {
  return {
    ratioByModel: {},
    contextLengthByModel: {},
    contextLengthSteps: CONTEXT_LENGTH_STEPS,
    customPrompt: '',
  };
}

function updateModelMap(current, payload, field, mapName) {
  const next = { ...current[mapName] };
  const modelId = String(payload?.modelId || '').trim();
  if (!modelId || !Object.prototype.hasOwnProperty.call(payload || {}, field)) return next;
  if (payload[field] === null) delete next[modelId];
  else next[modelId] = Number(payload[field]);
  return next;
}

function createCompactionStub({ options, state }) {
  const ensureTuning = () => {
    state.compactionTuningState = state.compactionTuningState || createDefaultTuning();
    return state.compactionTuningState;
  };
  return {
    async getTuning() {
      ensureTuning();
      return typeof options.compaction?.getTuning === 'function'
        ? options.compaction.getTuning({ state }) : state.compactionTuningState;
    },
    async setTuning(payload) {
      const current = ensureTuning();
      state.compactionSetTuningCalls = state.compactionSetTuningCalls || [];
      state.compactionSetTuningCalls.push(payload);
      if (typeof options.compaction?.setTuning === 'function') {
        return options.compaction.setTuning(payload, { state });
      }
      state.compactionTuningState = {
        ratioByModel: updateModelMap(current, payload, 'ratio', 'ratioByModel'),
        contextLengthByModel: updateModelMap(
          current, payload, 'contextLength', 'contextLengthByModel'
        ),
        contextLengthSteps: current.contextLengthSteps,
        customPrompt: payload?.customPrompt === undefined
          ? current.customPrompt : String(payload.customPrompt || ''),
      };
      return { status: 'applied', state: state.compactionTuningState };
    },
  };
}

module.exports = { CONTEXT_LENGTH_STEPS, createCompactionStub };
