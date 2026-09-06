'use strict';

const { PLUGIN_ERROR_CODES } = require('../backend/error-codes');
const { PUBLISHER_ID_RE, PLUGIN_ID_RE } = require('./identity/authority-id');
const { readCommittedState } = require('./lifecycle/commit-sequence');
const { runContributionOperation } = require('./lifecycle/contribution-operation');
const { writeSettingsState } = require('./store/settings-state-store');
const { reverifyInstalledPackage } = require('./runtime/declarative-compiler');

const CONTRIBUTION_PAYLOAD_KEYS = new Set([
  'publisher_id', 'plugin_id', 'contribution_id', 'enabled', 'expected_generation_id', 'client_request_id',
]);
const SETTINGS_PAYLOAD_KEYS = new Set([
  'publisher_id', 'plugin_id', 'contribution_id', 'values', 'expected_generation_id', 'client_request_id',
]);
const MAX_SETTINGS_FIELDS = 32;
const MAX_PLUGIN_PAYLOAD_BYTES = 64 * 1024;
const CLIENT_REQUEST_ID_RE = /^[\x20-\x7E]{1,120}$/;
const ACTIVATION_PAYLOAD_KEYS = new Set(['publisher_id', 'plugin_id', 'client_request_id']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readAuthority(payload) {
  const publisherId = payload.publisher_id ?? payload.publisherId;
  const pluginId = payload.plugin_id ?? payload.pluginId;
  if (typeof publisherId !== 'string' || !PUBLISHER_ID_RE.test(publisherId)) {
    return { ok: false, reason: 'invalid_publisher_id' };
  }
  if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
    return { ok: false, reason: 'invalid_plugin_id' };
  }
  return { ok: true, publisherId, pluginId };
}

function readMutationEnvelope(payload) {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload_not_an_object' };
  if ('operation_id' in payload || 'operationId' in payload) {
    return { ok: false, reason: 'caller_supplied_operation_id' };
  }
  const raw = payload.client_request_id ?? payload.clientRequestId ?? null;
  if (raw !== null && (typeof raw !== 'string' || !CLIENT_REQUEST_ID_RE.test(raw))) {
    return { ok: false, reason: 'invalid_client_request_id' };
  }
  return { ok: true, clientRequestId: raw };
}

function readInstallEnvelope(payload) {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload_not_an_object' };
  if (Object.keys(payload).some((key) => key !== 'client_request_id')) {
    return { ok: false, reason: 'install_payload_field_not_permitted' };
  }
  const raw = payload.client_request_id ?? null;
  if (raw !== null && (typeof raw !== 'string' || !CLIENT_REQUEST_ID_RE.test(raw))) {
    return { ok: false, reason: 'invalid_client_request_id' };
  }
  return { ok: true, clientRequestId: raw };
}

function readActivationEnvelope(payload) {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload_not_an_object' };
  if (Object.keys(payload).some((key) => !ACTIVATION_PAYLOAD_KEYS.has(key))) {
    return { ok: false, reason: 'activation_payload_field_not_permitted' };
  }
  const authority = readAuthority(payload);
  if (!authority.ok) return authority;
  const clientRequestId = payload.client_request_id ?? null;
  if (clientRequestId !== null
    && (typeof clientRequestId !== 'string' || !CLIENT_REQUEST_ID_RE.test(clientRequestId))) {
    return { ok: false, reason: 'invalid_client_request_id' };
  }
  return { ...authority, clientRequestId };
}

function readContributionEnvelope(payload, operation) {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload_not_an_object' };
  const permitted = operation === 'update_settings' ? SETTINGS_PAYLOAD_KEYS : CONTRIBUTION_PAYLOAD_KEYS;
  if (Object.keys(payload).some((key) => !permitted.has(key))) {
    return { ok: false, reason: 'contribution_payload_field_not_permitted' };
  }
  const base = readActivationEnvelope({
    publisher_id: payload.publisher_id,
    plugin_id: payload.plugin_id,
    ...(payload.client_request_id === undefined ? {} : { client_request_id: payload.client_request_id }),
  });
  if (!base.ok) return base;
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(String(payload.contribution_id || ''))) {
    return { ok: false, reason: 'invalid_contribution_id' };
  }
  if (!/^gen-[A-Za-z0-9._:-]{1,124}$/.test(String(payload.expected_generation_id || ''))) {
    return { ok: false, reason: 'invalid_expected_generation_id' };
  }
  if (operation === 'set_contribution' && typeof payload.enabled !== 'boolean') {
    return { ok: false, reason: 'invalid_enabled' };
  }
  if (operation === 'update_settings' && !isPlainObject(payload.values)) {
    return { ok: false, reason: 'invalid_settings_values' };
  }
  if (operation === 'update_settings') {
    if (Object.keys(payload.values).length > MAX_SETTINGS_FIELDS) {
      return { ok: false, reason: 'settings_values_too_many' };
    }
    try {
      if (Buffer.byteLength(JSON.stringify(payload.values), 'utf8') > MAX_PLUGIN_PAYLOAD_BYTES) {
        return { ok: false, reason: 'settings_values_too_large' };
      }
    } catch (_error) {
      return { ok: false, reason: 'invalid_settings_values' };
    }
  }
  return {
    ...base,
    contributionId: payload.contribution_id,
    expectedGenerationId: payload.expected_generation_id,
    ...(operation === 'set_contribution' ? { enabled: payload.enabled } : { values: payload.values }),
  };
}

function dependencyMapFor(contents) {
  const dependencies = new Map();
  for (const content of contents) {
    const found = new Set();
    if (content.payload.kind === 'command') found.add(content.payload.target_contribution_id);
    if (content.payload.kind === 'workflow') {
      for (const node of content.payload.nodes) {
        if (node.type === 'prompt') found.add(node.target_contribution_id);
        for (const binding of node.bindings) {
          if (binding.value.source === 'setting') found.add(binding.value.settings_contribution_id);
        }
      }
    }
    dependencies.set(content.contribution_id, [...found]);
  }
  return dependencies;
}

function createContributionMutations(deps) {
  const {
    facade, baseDir, run, serializeMutation, writableGate, refuse,
    verifyPackage, clock, newOperationId, safeMode, isDisposed, runtime, runtimeCoordinator,
    emptyPolicyGrantRef, getPolicyGrantRef = () => emptyPolicyGrantRef,
    controlPlaneStage, createForwardingProgressLog,
    settleAndPublishMutation,
  } = deps;

  async function readContext(envelope) {
    const committed = await readCommittedState(facade, baseDir);
    if (committed.generation?.generation_schema_version !== 2
      || committed.generation.generation_id !== envelope.expectedGenerationId) {
      return { ok: false, reason: 'stale_generation' };
    }
    const entry = committed.generation.plugins.find((item) => (
      item.publisher_id === envelope.publisherId && item.plugin_id === envelope.pluginId
    ));
    if (!entry) return { ok: false, reason: 'plugin_not_installed' };
    const contribution = entry.contributions.find((item) => item.contribution_id === envelope.contributionId);
    if (!contribution) return { ok: false, reason: 'contribution_not_found' };
    const reverified = await reverifyInstalledPackage({
      facade, baseDir, pluginEntry: entry, verifyPackage, now: clock(),
    });
    if (!reverified.ok || reverified.verdict.manifest?.manifest_schema_version !== 2) {
      return { ok: false, reason: reverified.reason || 'v2_package_required' };
    }
    const content = reverified.verdict.declarative_contents.find(
      (item) => item.contribution_id === envelope.contributionId
    );
    if (!content) return { ok: false, reason: 'contribution_content_missing' };
    return {
      ok: true, contribution, content,
      dependencyMap: dependencyMapFor(reverified.verdict.declarative_contents),
    };
  }

  async function mutate(operation, payload = {}) {
    return run(operation, () => serializeMutation(async () => {
      const writable = writableGate();
      if (!writable.ok) return writable;
      const envelope = readContributionEnvelope(payload, operation);
      if (!envelope.ok) return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, envelope.reason);
      const context = await readContext(envelope);
      if (!context.ok) return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, context.reason);
      if (operation === 'set_contribution'
        && context.contribution.kind === 'mcp_descriptor' && envelope.enabled === true) {
        return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, 'mcp_activation_forbidden');
      }
      if (operation === 'update_settings' && context.contribution.kind !== 'settings_schema') {
        return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, 'settings_schema_required');
      }
      const operationId = newOperationId();
      const timestamp = clock();
      let settingsRef;
      if (operation === 'update_settings') {
        const nextRevision = context.contribution.settings_ref?.kind === 'state'
          ? context.contribution.settings_ref.revision + 1 : 1;
        const written = await writeSettingsState(facade, baseDir, {
          publisherId: envelope.publisherId,
          pluginId: envelope.pluginId,
          contributionId: envelope.contributionId,
          schemaDigest: context.contribution.content_digest,
          revision: nextRevision,
          fields: context.content.payload.fields,
          values: envelope.values,
          now: timestamp,
        });
        if (!written.ok) return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, written.reason);
        settingsRef = { kind: 'state', digest: written.digest, revision: written.revision };
      }
      const outcome = await runContributionOperation(facade, baseDir, {
        operation,
        publisherId: envelope.publisherId,
        pluginId: envelope.pluginId,
        contributionId: envelope.contributionId,
        ...(operation === 'set_contribution' ? { enabled: envelope.enabled } : { settingsRef }),
        expectedGenerationId: envelope.expectedGenerationId,
        dependencyMap: context.dependencyMap,
        requireConsent: async () => ({ ok: true }),
        newOperationId: () => operationId,
        clientRequestId: envelope.clientRequestId,
        safeMode,
        now: timestamp,
        generationId: `gen-${operationId}`,
        policyGrantRef: getPolicyGrantRef(),
        dataSchemaRefs: [],
        progressLog: createForwardingProgressLog(operationId),
        isCanceled: isDisposed,
        compileCandidate: runtime.compileCandidate,
        runtimeCoordinator,
        stage: controlPlaneStage,
      });
      return settleAndPublishMutation(operation, outcome, timestamp, {
        publisher_id: envelope.publisherId, plugin_id: envelope.pluginId,
      });
    }));
  }

  return Object.freeze({
    setContributionEnabled: (payload = {}) => mutate('set_contribution', payload),
    updateSettings: (payload = {}) => mutate('update_settings', payload),
  });
}

module.exports = {
  MAX_SETTINGS_FIELDS,
  MAX_PLUGIN_PAYLOAD_BYTES,
  readAuthority,
  readMutationEnvelope,
  readInstallEnvelope,
  readActivationEnvelope,
  readContributionEnvelope,
  dependencyMapFor,
  createContributionMutations,
};
