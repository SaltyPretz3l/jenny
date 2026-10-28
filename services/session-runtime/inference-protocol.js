'use strict';

const { t } = require('../i18n-main');
const { RUNTIME_ERROR_CODES } = require('../backend/error-codes');
const {
  CHAT_WORKSPACE_VERSION, EMPTY_CHAT_WORKSPACE_CAPABILITIES, REQUESTED_CHAT_WORKSPACE_CAPABILITIES,
  SESSION_HANDOFF_CONTEXT_KIND, intersectCapabilities,
} = require('../backend/chat-workspace-capabilities');
const initializations = new WeakMap();
const RUNTIME_INFERENCE_ADMISSION_VERSION = 1;

function beginRuntimeInferenceInitialization(client) {
  const token = Object.freeze({});
  initializations.set(client, { token, process: client.process, version: null, toolVersion: null,
    continuationVersion: null, budgetVersion: null, commandProposalVersion: null, inferencePerformanceVersion: null,
    chatWorkspace: null });
  return token;
}

function completeRuntimeInferenceInitialization(client, token, result) {
  const state = initializations.get(client);
  if (!state || state.token !== token || state.process !== client.process || !client.process) return false;
  state.version = result?.runtime_inference_admission_version === RUNTIME_INFERENCE_ADMISSION_VERSION
    ? RUNTIME_INFERENCE_ADMISSION_VERSION : null;
  state.toolVersion = result?.runtime_tool_resource_admission_version === 1 ? 1 : null;
  state.budgetVersion = result?.runtime_inference_budget_version === 1 ? 1 : null;
  state.continuationVersion = result?.runtime_continuation_version === 1 ? 1 : null;
  state.commandProposalVersion = result?.command_proposal_version === 1 ? 1 : null;
  state.inferencePerformanceVersion = result?.inference_performance_version === 1 ? 1 : null;
  // Stored only for a versioned ack, and only as the closed intersection with what
  // Electron requested; an old sidecar (no version) negotiates nothing.
  state.chatWorkspace = result?.chat_workspace_version === CHAT_WORKSPACE_VERSION
    ? intersectCapabilities(REQUESTED_CHAT_WORKSPACE_CAPABILITIES, result.chat_workspace_capabilities) : null;
  return state.version !== null;
}

function invalidateRuntimeInferenceProtocol(client) {
  initializations.delete(client);
}

function assertRuntimeInferenceProtocol(client) {
  const state = client && initializations.get(client);
  if (state?.process && state.process === client.process
    && state.version === RUNTIME_INFERENCE_ADMISSION_VERSION) return true;
  const error = new Error(t('error.protocol.invalidRequest', 'Invalid JSON-RPC request.'));
  error.code = RUNTIME_ERROR_CODES.ADMISSION_REJECTED;
  error.reason = 'runtime_inference_protocol_required';
  error.retryable = false;
  throw error;
}

function assertRuntimeOperationsProtocol(client) {
  assertRuntimeInferenceProtocol(client);
  if (initializations.get(client).toolVersion === 1) return true;
  const error = new Error(t('error.protocol.invalidRequest', 'Invalid JSON-RPC request.'));
  error.code = RUNTIME_ERROR_CODES.ADMISSION_REJECTED;
  error.reason = 'runtime_tool_resource_protocol_required';
  error.retryable = false;
  throw error;
}

function assertRuntimeContinuationProtocol(client) {
  assertRuntimeOperationsProtocol(client);
  if (initializations.get(client).continuationVersion === 1) return true;
  const error = new Error(t('error.protocol.invalidRequest', 'Invalid JSON-RPC request.'));
  error.code = RUNTIME_ERROR_CODES.ADMISSION_REJECTED;
  error.reason = 'runtime_continuation_protocol_required';
  error.retryable = false;
  throw error;
}

function assertRuntimeBudgetProtocol(client) {
  assertRuntimeOperationsProtocol(client);
  if (initializations.get(client).budgetVersion === 1) return true;
  const error = new Error(t('error.protocol.invalidRequest', 'Invalid JSON-RPC request.'));
  error.code = RUNTIME_ERROR_CODES.ADMISSION_REJECTED;
  error.reason = 'runtime_inference_budget_protocol_required';
  error.retryable = false;
  throw error;
}

// The exact-command Run (`command.execute_proposal`) needs this process to have
// advertised command_proposal_version 1; an older sidecar fails the Run closed.
function assertCommandProposalProtocol(client) {
  const state = client && initializations.get(client);
  if (state?.process && state.process === client.process && state.commandProposalVersion === 1) return true;
  const error = new Error(t('error.protocol.invalidRequest', 'Invalid JSON-RPC request.'));
  error.code = RUNTIME_ERROR_CODES.ADMISSION_REJECTED;
  error.reason = 'command_proposal_protocol_required';
  error.retryable = false;
  throw error;
}

function supportsCommandProposalProtocol(client) {
  try { return assertCommandProposalProtocol(client) === true; } catch (_error) { return false; }
}

// The ephemeral `inference.performance` notification and the `chat.send` option field
// (row 59 cp6): only a process that advertised version 1; hosted sidecars never do.
function supportsInferencePerformanceProtocol(client) {
  const state = client && initializations.get(client);
  return Boolean(state?.process && state.process === client.process && state.inferencePerformanceVersion === 1);
}

// The chat-workspace capabilities this process acknowledged, bound to that process.
function negotiatedChatWorkspaceCapabilities(client) {
  const state = client && initializations.get(client);
  if (state?.process && state.process === client.process && state.chatWorkspace) return state.chatWorkspace;
  return EMPTY_CHAT_WORKSPACE_CAPABILITIES;
}

// Missing negotiation never falls back to user text or system overlays: callers
// admit no addressed mail and drop context rows from the wire history.
function supportsSessionMessageContext(client) {
  return negotiatedChatWorkspaceCapabilities(client).session_messages === true;
}

// Mid-turn mail (row 70 W2a): `session.mail_arrived` into a live turn of this process.
function supportsMidTurnMail(client) {
  return negotiatedChatWorkspaceCapabilities(client).mid_turn_mail === true;
}

// The first-turn handoff context kind (cp5a): without it the handoff turn fails closed.
function supportsSessionHandoffContext(client) {
  return negotiatedChatWorkspaceCapabilities(client).context_kinds.includes(SESSION_HANDOFF_CONTEXT_KIND);
}

// Producer tools (propose_session, complete_session_handoff) this process acknowledged.
function supportsProducerTool(client, name) {
  return negotiatedChatWorkspaceCapabilities(client).producer_tools.includes(name);
}

function supportsRuntimeContinuationProtocol(client) {
  try { return assertRuntimeContinuationProtocol(client) === true; } catch (_error) { return false; }
}

module.exports = { RUNTIME_INFERENCE_ADMISSION_VERSION, beginRuntimeInferenceInitialization,
  completeRuntimeInferenceInitialization, invalidateRuntimeInferenceProtocol, assertRuntimeInferenceProtocol,
  assertRuntimeOperationsProtocol, assertRuntimeContinuationProtocol, supportsRuntimeContinuationProtocol,
  assertRuntimeBudgetProtocol, assertCommandProposalProtocol, supportsCommandProposalProtocol,
  supportsInferencePerformanceProtocol,
  negotiatedChatWorkspaceCapabilities, supportsSessionMessageContext, supportsSessionHandoffContext,
  supportsProducerTool, supportsMidTurnMail };
