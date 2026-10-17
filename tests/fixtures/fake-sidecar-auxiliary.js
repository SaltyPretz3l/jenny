'use strict';

// Opt-in (`--hold-auxiliary-until-cancel`) auxiliary producer for the managed
// fake sidecar. It mirrors the sidecar's auxiliary-cancel contract: an
// auxiliary request admits one inference attempt over `runtime.operation`, then
// holds until `chat.cancel {request_id}` names it; the attempt is settled
// (cancelled, cleanup confirmed) and only then is the request answered with
// JSON-RPC -32000 `data.reason = "auxiliary_cancelled"`.

const API_VERSION = '2026-10-15';
const JSONRPC_VERSION = '2.0';
const AUXILIARY_METHODS = new Set(['suggestions.generate', 'commit.generate_message', 'chat.compact', 'memory.reflect']);
const enabled = process.argv.includes('--hold-auxiliary-until-cancel');
const held = new Map();
const reverse = new Map();
let nextReverseId = 90000;

function createAuxiliaryHandler(writeMessage) {
  function operation(entry, phase, extra, onResult) {
    const id = nextReverseId;
    nextReverseId += 1;
    reverse.set(id, onResult);
    const context = entry.context;
    writeMessage({ jsonrpc: JSONRPC_VERSION, api_version: API_VERSION, id, method: 'runtime.operation',
      params: { api_version: API_VERSION, schema_version: 1, kind: 'inference', phase,
        request_id: context.request_id, session_id: context.session_id,
        authority_revision: context.authority_revision, operation_id: 'aux_attempt_1', ...extra } });
  }

  function answerCancelled(entry) {
    held.delete(entry.context.request_id);
    writeMessage({ jsonrpc: JSONRPC_VERSION, api_version: API_VERSION, id: entry.id,
      error: { code: -32000, message: 'Auxiliary request cancelled.',
        data: { reason: 'auxiliary_cancelled', request_id: entry.context.request_id } } });
  }

  function settle(entry) {
    operation(entry, 'settle', { status: 'cancelled', cleanup: 'confirmed', consumption: 'unknown',
      charge_consumption: true }, () => answerCancelled(entry));
  }

  return function handleAuxiliaryMessage(message) {
    if (!enabled) return false;
    if (!message.method && reverse.has(message.id)) {
      const onResult = reverse.get(message.id);
      reverse.delete(message.id);
      onResult(message.result || {});
      return true;
    }
    if (AUXILIARY_METHODS.has(message.method) && message.params?.inference_context) {
      const entry = { id: message.id, context: message.params.inference_context, admitted: false, cancelled: false };
      held.set(entry.context.request_id, entry);
      operation(entry, 'admit', { engine_type: entry.context.engine_type }, result => {
        entry.admitted = result.status === 'granted';
        if (!entry.admitted) answerCancelled(entry);
        else if (entry.cancelled) settle(entry);
      });
      return true;
    }
    if (message.method === 'chat.cancel') {
      const entry = held.get(String(message.params?.request_id || '').trim());
      if (!entry) return false;
      writeMessage({ jsonrpc: JSONRPC_VERSION, api_version: API_VERSION, id: message.id,
        result: { request_id: entry.context.request_id, status: 'cancel_requested', tombstone_hit: false } });
      if (!entry.cancelled) {
        entry.cancelled = true;
        if (entry.admitted) settle(entry);
      }
      return true;
    }
    return false;
  };
}

module.exports = { createAuxiliaryHandler };
