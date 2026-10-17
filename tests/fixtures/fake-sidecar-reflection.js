'use strict';

// Reflection methods (agentic memory v2, row 58 W2) for the managed fake
// sidecar: memory.reflection_state, memory.policy_epoch, memory.reflect and
// memory.apply, with the contract's epoch and cursor fences. memory.reflect
// admits and settles one inference attempt over `runtime.operation` before it
// answers; with `--hold-auxiliary-until-cancel` the auxiliary fixture holds it
// instead (fake-sidecar-auxiliary.js), so a chat admission can preempt it.

const API_VERSION = '2026-10-15';
const JSONRPC_VERSION = '2.0';
const cursors = new Map();
const latestEpochs = new Map();
const reverse = new Map();
let nextReverseId = 95000;
let nextMemoryId = 1;

function createReflectionHandler(writeMessage) {
  const answer = (id, result) => writeMessage({ jsonrpc: JSONRPC_VERSION, api_version: API_VERSION, id, result });

  function operation(context, phase, extra, onResult) {
    const id = nextReverseId;
    nextReverseId += 1;
    reverse.set(id, onResult);
    writeMessage({ jsonrpc: JSONRPC_VERSION, api_version: API_VERSION, id, method: 'runtime.operation',
      params: { api_version: API_VERSION, schema_version: 1, kind: 'inference', phase,
        request_id: context.request_id, session_id: context.session_id,
        authority_revision: context.authority_revision, operation_id: 'reflect_attempt_1', ...extra } });
  }

  // One preference proposal per new user message that states one.
  function reflectResult(params) {
    const proposals = (params.messages || [])
      .filter(message => (params.new_user_ids || []).includes(message.id) && /\bprefer\b/iu.test(message.content))
      .slice(0, 5)
      .map(message => ({ text: message.content.slice(0, 240), kind: 'preference',
        source_message_id: message.id, digest: `fake:${message.id}` }));
    return { proposals, recap: '', window_fingerprint: params.window_fingerprint,
      dropped: { schema: 0, attribution: 0, kind: 0, length: 0, suppressed: 0, duplicate: 0, unsafe: 0 },
      model: 'mock-v1', elapsed_ms: 1 };
  }

  function reflect(message) {
    const context = message.params.inference_context;
    operation(context, 'admit', { engine_type: context.engine_type }, admitted => {
      if (admitted.status !== 'granted') {
        writeMessage({ jsonrpc: JSONRPC_VERSION, api_version: API_VERSION, id: message.id,
          error: { code: -32000, message: 'Inference was not admitted.', data: { reason: 'inference_not_admitted' } } });
        return;
      }
      operation(context, 'settle', { status: 'succeeded', cleanup: 'confirmed', consumption: 'unknown',
        charge_consumption: true }, () => answer(message.id, reflectResult(message.params)));
    });
  }

  function apply(params) {
    const refused = reason => ({ status: 'refused', reason, saved: [], queued: 0, skipped: 0 });
    if (params.policy_epoch < (latestEpochs.get(params.epoch_source) ?? -1)) return refused('policy_stale');
    const stored = cursors.get(params.session_id)?.window_fingerprint ?? null;
    if (stored !== (params.expected_fingerprint ?? null)) return refused('cursor_moved');
    cursors.set(params.session_id, { ...params.cursor, project_id: params.project_id, updated_at: new Date().toISOString() });
    const fp16 = String(params.cursor.window_fingerprint).slice(7, 23);
    if (params.capture === 'ask') return { status: 'applied', saved: [], queued: params.proposals.length, skipped: 0 };
    const saved = params.proposals.map((proposal, index) => ({ memory_id: nextMemoryId++,
      operation_id: `reflect:${params.session_id}:${fp16}:${index}`, kind: proposal.kind,
      text_preview: proposal.text.slice(0, 80), undoable: true }));
    return { status: 'applied', saved, queued: 0, skipped: 0 };
  }

  return function handleReflectionMessage(message) {
    if (!message.method && reverse.has(message.id)) {
      const onResult = reverse.get(message.id);
      reverse.delete(message.id);
      onResult(message.result || {});
      return true;
    }
    const params = message.params || {};
    if (message.method === 'memory.reflection_state') {
      answer(message.id, { cursor: cursors.get(params.session_id) || null, purged: false });
      return true;
    }
    if (message.method === 'memory.policy_epoch') {
      const latest = Math.max(latestEpochs.get(params.epoch_source) ?? 0, params.policy_epoch);
      latestEpochs.set(params.epoch_source, latest);
      answer(message.id, { latest });
      return true;
    }
    if (message.method === 'memory.reflect' && params.inference_context) {
      reflect(message);
      return true;
    }
    if (message.method === 'memory.apply') {
      answer(message.id, apply(params));
      return true;
    }
    return false;
  };
}

module.exports = { createReflectionHandler };
