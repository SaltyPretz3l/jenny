'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SidecarClient } = require('../../services/backend/sidecar-client');
const { beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization,
  assertRuntimeInferenceProtocol, assertRuntimeOperationsProtocol,
  assertRuntimeContinuationProtocol, assertRuntimeBudgetProtocol, assertCommandProposalProtocol,
  supportsCommandProposalProtocol, negotiatedChatWorkspaceCapabilities,
  supportsSessionMessageContext, supportsSessionHandoffContext, supportsProducerTool,
  supportsInferencePerformanceProtocol } = require('../../services/session-runtime/inference-protocol');
const { EMPTY_CHAT_WORKSPACE_CAPABILITIES, REQUESTED_CHAT_WORKSPACE_CAPABILITIES } = require('../../services/backend/chat-workspace-capabilities');

test('mandatory inference requires the current full-runtime acknowledgement', async () => {
  const client = new SidecarClient();
  client.process = {};
  assert.throws(() => assertRuntimeInferenceProtocol(client), error => error.reason === 'runtime_inference_protocol_required');
  for (const version of [1, undefined, '1', 2, null]) {
    client.request = async () => ({ runtime_inference_admission_version: version });
    await client.initialize();
    if (version === 1) assert.equal(assertRuntimeInferenceProtocol(client), true);
    else assert.throws(() => assertRuntimeInferenceProtocol(client));
  }
  client.request = async () => ({ runtime_inference_admission_version: 1 });
  await client.initialize();
  client.detachProcess();
  assert.throws(() => assertRuntimeInferenceProtocol(client));
});

test('an earlier initializer cannot overwrite a newer negotiated state', () => {
  const client = { process: {} };
  const first = beginRuntimeInferenceInitialization(client);
  const second = beginRuntimeInferenceInitialization(client);
  assert.equal(completeRuntimeInferenceInitialization(client, first, { runtime_inference_admission_version: 1 }), false);
  assert.throws(() => assertRuntimeInferenceProtocol(client));
  assert.equal(completeRuntimeInferenceInitialization(client, second, { runtime_inference_admission_version: 1 }), true);
  assert.equal(assertRuntimeInferenceProtocol(client), true);
  client.process = {};
  assert.throws(() => assertRuntimeInferenceProtocol(client));
});

test('tool dispatch requires the exact current resource protocol acknowledgement', () => {
  const client = { process: {} };
  for (const version of [undefined, '1', 2, null, 1]) {
    const token = beginRuntimeInferenceInitialization(client);
    completeRuntimeInferenceInitialization(client, token, {
      runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: version,
    });
    assert.equal(assertRuntimeInferenceProtocol(client), true);
    if (version === 1) assert.equal(assertRuntimeOperationsProtocol(client), true);
    else assert.throws(() => assertRuntimeOperationsProtocol(client),
      error => error.reason === 'runtime_tool_resource_protocol_required');
  }
  client.process = {};
  assert.throws(() => assertRuntimeOperationsProtocol(client));
});

test('continuations require current process and initializer acknowledgement in addition to resource protocols', () => {
  const client = { process: {} };
  for (const version of [undefined, true, '1', 2, null, 1]) {
    const token = beginRuntimeInferenceInitialization(client);
    completeRuntimeInferenceInitialization(client, token, {
      runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1,
      runtime_continuation_version: version,
    });
    assert.equal(assertRuntimeOperationsProtocol(client), true);
    if (version === 1) assert.equal(assertRuntimeContinuationProtocol(client), true);
    else assert.throws(() => assertRuntimeContinuationProtocol(client),
      error => error.reason === 'runtime_continuation_protocol_required');
  }
  const old = beginRuntimeInferenceInitialization(client);
  beginRuntimeInferenceInitialization(client);
  assert.equal(completeRuntimeInferenceInitialization(client, old, {
    runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1,
    runtime_continuation_version: 1,
  }), false);
  assert.throws(() => assertRuntimeContinuationProtocol(client));
  const token = beginRuntimeInferenceInitialization(client);
  completeRuntimeInferenceInitialization(client, token, { runtime_inference_admission_version: 1,
    runtime_tool_resource_admission_version: 1, runtime_continuation_version: 1 });
  client.process = {};
  assert.throws(() => assertRuntimeContinuationProtocol(client));
});


test('budget-required dispatch needs its own current-process acknowledgement', () => {
  const client = { process: {} };
  for (const version of [undefined, null, true, '1', 2, 1]) {
    const token = beginRuntimeInferenceInitialization(client);
    completeRuntimeInferenceInitialization(client, token, { runtime_inference_admission_version: 1,
      runtime_tool_resource_admission_version: 1, runtime_inference_budget_version: version });
    assert.equal(assertRuntimeOperationsProtocol(client), true);
    if (version === 1) assert.equal(assertRuntimeBudgetProtocol(client), true);
    else assert.throws(() => assertRuntimeBudgetProtocol(client),
      error => error.reason === 'runtime_inference_budget_protocol_required');
  }
  client.process = {};
  assert.throws(() => assertRuntimeBudgetProtocol(client));
});

test('the exact-command Run requires the current process to advertise command_proposal_version 1', async () => {
  const client = new SidecarClient();
  client.process = {};
  assert.equal(supportsCommandProposalProtocol(client), false, 'no negotiation yet');
  assert.throws(() => assertCommandProposalProtocol(client), error => error.reason === 'command_proposal_protocol_required'
    && error.retryable === false);
  for (const version of [undefined, true, '1', 2, 0, null, 1]) {
    client.request = async () => ({ runtime_inference_admission_version: 1, command_proposal_version: version });
    await client.initialize();
    assert.equal(supportsCommandProposalProtocol(client), version === 1, String(version));
    if (version === 1) assert.equal(assertCommandProposalProtocol(client), true);
  }
  // A sidecar that predates the field fails closed; it never falls back to chat.send.
  client.request = async () => ({ runtime_inference_admission_version: 1 });
  await client.initialize();
  assert.equal(supportsCommandProposalProtocol(client), false);
  client.request = async () => ({ runtime_inference_admission_version: 1, command_proposal_version: 1 });
  await client.initialize();
  assert.equal(supportsCommandProposalProtocol(client), true);
  client.process = {};
  assert.equal(supportsCommandProposalProtocol(client), false, 'bound to the process that negotiated it');
  assert.equal(supportsCommandProposalProtocol(null), false);
  client.request = async () => ({ runtime_inference_admission_version: 1, command_proposal_version: 1 });
  await client.initialize();
  client.detachProcess();
  assert.equal(supportsCommandProposalProtocol(client), false);
});

test('session-message context needs this process to acknowledge chat_workspace_version 1 with the closed shape', async () => {
  const client = new SidecarClient();
  client.process = {};
  const ack = { schema_version: 1, producer_tools: ['propose_session', 'complete_session_handoff'],
    context_kinds: ['session_message', 'session_handoff'], session_messages: true };
  const initializeWith = async result => {
    client.request = async () => ({ runtime_inference_admission_version: 1, ...result });
    await client.initialize();
  };
  assert.equal(supportsSessionMessageContext(client), false, 'no negotiation yet');
  assert.deepEqual(negotiatedChatWorkspaceCapabilities(client), EMPTY_CHAT_WORKSPACE_CAPABILITIES);
  for (const version of [undefined, true, '1', 2, 0, null]) {
    await initializeWith({ chat_workspace_version: version, chat_workspace_capabilities: ack });
    assert.equal(supportsSessionMessageContext(client), false, String(version));
  }
  // An old sidecar answers neither field; hosted answers the empty form.
  await initializeWith({});
  assert.equal(supportsSessionMessageContext(client), false);
  await initializeWith({ chat_workspace_version: 1, chat_workspace_capabilities: EMPTY_CHAT_WORKSPACE_CAPABILITIES });
  assert.equal(supportsSessionMessageContext(client), false);
  for (const malformed of [undefined, null, 'yes', [], {}, { ...ack, extra: 1 }, { ...ack, schema_version: 2 },
    { ...ack, session_messages: 'true' }, { ...ack, context_kinds: 'session_message' }]) {
    await initializeWith({ chat_workspace_version: 1, chat_workspace_capabilities: malformed });
    assert.equal(supportsSessionMessageContext(client), false, JSON.stringify(malformed));
  }
  await initializeWith({ chat_workspace_version: 1, chat_workspace_capabilities: ack });
  assert.equal(supportsSessionMessageContext(client), true);
  assert.deepEqual(negotiatedChatWorkspaceCapabilities(client), REQUESTED_CHAT_WORKSPACE_CAPABILITIES);
  assert.equal(Object.isFrozen(negotiatedChatWorkspaceCapabilities(client)), true);
  // The ack is intersected with the requested set: extra acknowledged values are never trusted.
  await initializeWith({ chat_workspace_version: 1, chat_workspace_capabilities: {
    ...ack, producer_tools: [...ack.producer_tools, 'propose_command'], context_kinds: [...ack.context_kinds, 'session_message_receipt'] } });
  assert.deepEqual(negotiatedChatWorkspaceCapabilities(client), REQUESTED_CHAT_WORKSPACE_CAPABILITIES);
  // session_messages without the session_message kind negotiates nothing for context.
  await initializeWith({ chat_workspace_version: 1, chat_workspace_capabilities: { ...ack, context_kinds: [] } });
  assert.equal(supportsSessionMessageContext(client), false);
  await initializeWith({ chat_workspace_version: 1, chat_workspace_capabilities: ack });
  client.process = {};
  assert.equal(supportsSessionMessageContext(client), false, 'bound to the process that negotiated it');
  assert.equal(supportsSessionMessageContext(null), false);
  await initializeWith({ chat_workspace_version: 1, chat_workspace_capabilities: ack });
  client.detachProcess();
  assert.equal(supportsSessionMessageContext(client), false);
});

test('the handoff context kind and the producer tools are negotiated per process and reset on detach', async () => {
  const client = new SidecarClient();
  client.process = {};
  const ack = { schema_version: 1, producer_tools: ['propose_session', 'complete_session_handoff'],
    context_kinds: ['session_message', 'session_handoff'], session_messages: true };
  const initializeWith = async capabilities => {
    client.request = async () => ({ runtime_inference_admission_version: 1, chat_workspace_version: 1, chat_workspace_capabilities: capabilities });
    await client.initialize();
  };
  assert.equal(supportsSessionHandoffContext(client), false, 'no negotiation yet');
  assert.equal(supportsProducerTool(client, 'propose_session'), false);
  await initializeWith(ack);
  assert.equal(supportsSessionHandoffContext(client), true);
  assert.equal(supportsProducerTool(client, 'propose_session'), true);
  assert.equal(supportsProducerTool(client, 'complete_session_handoff'), true);
  assert.equal(supportsProducerTool(client, 'propose_command'), false, 'never requested');
  await initializeWith({ ...ack, context_kinds: ['session_message'], producer_tools: ['propose_session'] });
  assert.equal(supportsSessionHandoffContext(client), false, 'an older sidecar acknowledges only the cp4 kind');
  assert.equal(supportsSessionMessageContext(client), true);
  assert.equal(supportsProducerTool(client, 'complete_session_handoff'), false);
  assert.equal(supportsProducerTool(client, 'propose_session'), true);
  await initializeWith(ack);
  client.process = {};
  assert.equal(supportsSessionHandoffContext(client), false, 'bound to the process that negotiated it');
  assert.equal(supportsProducerTool(client, 'propose_session'), false);
  assert.equal(supportsSessionHandoffContext(null), false);
  assert.equal(supportsProducerTool(undefined, 'propose_session'), false);
  await initializeWith(ack);
  client.detachProcess();
  assert.equal(supportsSessionHandoffContext(client), false);
  assert.equal(supportsProducerTool(client, 'propose_session'), false);
});

test('a new initialize resets a previously negotiated chat-workspace grant', async () => {
  const client = new SidecarClient();
  client.process = {};
  const ack = { schema_version: 1, producer_tools: [], context_kinds: ['session_message'], session_messages: true };
  client.request = async () => ({ runtime_inference_admission_version: 1, chat_workspace_version: 1, chat_workspace_capabilities: ack });
  await client.initialize();
  assert.equal(supportsSessionMessageContext(client), true);
  client.request = async () => { throw new Error('initialize failed'); };
  await assert.rejects(client.initialize());
  assert.equal(supportsSessionMessageContext(client), false);
});

test('initialize sends the requested chat-workspace capabilities only when supplied', async () => {
  const client = new SidecarClient();
  client.process = {};
  const sent = [];
  client.request = async (method, params) => { sent.push({ method, params }); return { runtime_inference_admission_version: 1 }; };
  await client.initialize({ config: {} });
  assert.equal('chat_workspace_capabilities' in sent[0].params, false);
  await client.initialize({ config: {}, chatWorkspaceCapabilities: REQUESTED_CHAT_WORKSPACE_CAPABILITIES });
  assert.deepEqual(sent[1].params.chat_workspace_capabilities, REQUESTED_CHAT_WORKSPACE_CAPABILITIES);
  assert.equal(sent[1].method, 'initialize');
});

test('the inference.performance protocol needs this process to advertise inference_performance_version 1', async () => {
  const client = new SidecarClient();
  client.process = {};
  assert.equal(supportsInferencePerformanceProtocol(client), false, 'no negotiation yet');
  for (const version of [undefined, true, '1', 2, 0, null, 1]) {
    client.request = async () => ({ runtime_inference_admission_version: 1, inference_performance_version: version });
    await client.initialize();
    assert.equal(supportsInferencePerformanceProtocol(client), version === 1, String(version));
  }
  // A sidecar that predates the field (or a hosted one that strips it) negotiates nothing.
  client.request = async () => ({ runtime_inference_admission_version: 1, command_proposal_version: 1 });
  await client.initialize();
  assert.equal(supportsInferencePerformanceProtocol(client), false);
  client.request = async () => ({ runtime_inference_admission_version: 1, inference_performance_version: 1 });
  await client.initialize();
  assert.equal(supportsInferencePerformanceProtocol(client), true);
  client.process = {};
  assert.equal(supportsInferencePerformanceProtocol(client), false, 'bound to the process that negotiated it');
  assert.equal(supportsInferencePerformanceProtocol(null), false);
  client.request = async () => ({ runtime_inference_admission_version: 1, inference_performance_version: 1 });
  await client.initialize();
  client.detachProcess();
  assert.equal(supportsInferencePerformanceProtocol(client), false);
});
