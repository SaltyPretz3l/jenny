'use strict';

const crypto = require('node:crypto');
const semver = require('semver');
const { PLUGIN_ERROR_CODES } = require('../backend/error-codes');
const { PUBLISHER_ID_RE, PLUGIN_ID_RE } = require('./identity/authority-id');
const { readCommittedState } = require('./lifecycle/commit-sequence');
const { reverifyInstalledPackage } = require('./runtime/declarative-compiler');
const { bindingDraft, descriptorContent } = require('./remote-mcp/runtime-authority');
const { readNetworkConsent, setPluginNetworkConsent,
  brokerConsentFor } = require('./store/network-consent-store');
const { readRemoteMcpAuthorization } = require('./store/remote-mcp-authorization-store');
const { DEVELOPER_UNSIGNED_KEY_ID } = require('./package/distribution-package-intake');

const CONTRIBUTION_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SOURCE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CLIENT_REQUEST_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function operationId(prefix = 'stage5') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 64);
}

function refusal(reason, code = PLUGIN_ERROR_CODES.POLICY_BLOCKED, extra = {}) {
  return { ok: false, code, reason, retryable: false, ...extra };
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function identityFrom(payload) {
  if (!plainObject(payload)
    || !PUBLISHER_ID_RE.test(String(payload.publisher_id || ''))
    || !PLUGIN_ID_RE.test(String(payload.plugin_id || ''))
    || !CONTRIBUTION_ID_RE.test(String(payload.contribution_id || ''))) {
    return refusal('remote_descriptor_identity_invalid');
  }
  return {
    ok: true,
    publisherId: payload.publisher_id,
    pluginId: payload.plugin_id,
    contributionId: payload.contribution_id,
  };
}

function selectedPackageRequest({ inspected, committed, clientRequestId }) {
  const target = {
    publisher_id: inspected.publisher_id,
    plugin_id: inspected.plugin_id,
  };
  const current = committed?.generation?.plugins?.find((plugin) => (
    plugin.publisher_id === target.publisher_id && plugin.plugin_id === target.plugin_id
  ));
  if (!current) {
    return {
      ok: true,
      request: {
        operation_schema_version: 1,
        client_request_id: clientRequestId,
        operation: {
          kind: 'install',
          source_kind: 'local_package',
          source_locator: 'electron_native_picker',
          target,
        },
      },
    };
  }
  const expectedGenerationId = committed?.pointer?.generation_id;
  if (expectedGenerationId !== committed?.generation?.generation_id) {
    return refusal('selected_package_generation_unavailable');
  }
  if (!semver.valid(inspected.version) || !semver.valid(current.resolved_version)) {
    return refusal('selected_package_version_invalid');
  }
  if (!semver.gt(inspected.version, current.resolved_version)) {
    return refusal(semver.eq(inspected.version, current.resolved_version)
      ? 'selected_package_version_not_higher' : 'selected_package_downgrade_requires_consent');
  }
  return {
    ok: true,
    request: {
      operation_schema_version: 1,
      client_request_id: clientRequestId,
      operation: { kind: 'update', target, expected_generation_id: expectedGenerationId },
    },
  };
}

function createStage5ControlPlane({
  facade,
  baseDir = '',
  distributionController,
  remoteMcpRuntime,
  oauthFlowService,
  credentialBroker,
  loopbackAuthorization = null,
  verifyPackage,
  selectLocalPackage = null,
  readPackageAtPath = null,
  inspectLocalPackage = null,
  selectOfflineRoot = null,
  createDistributionContext = async () => ({}),
  safeMode = { active: false },
  now = () => new Date().toISOString(),
  log = () => {},
} = {}) {
  let disposed = false;

  function gate() {
    if (disposed) return refusal('service_disposed', PLUGIN_ERROR_CODES.FEATURE_DISABLED);
    if (safeMode?.active === true) return refusal('plugins_safe_mode', PLUGIN_ERROR_CODES.SAFE_MODE_ACTIVE);
    return { ok: true };
  }

  async function findDescriptor(payload) {
    const identity = identityFrom(payload);
    if (!identity.ok) return identity;
    const committed = await readCommittedState(facade, baseDir);
    const entry = committed.generation?.plugins?.find((item) => (
      item.publisher_id === identity.publisherId && item.plugin_id === identity.pluginId
    ));
    if (!entry) return refusal('plugin_not_installed');
    const reverified = await reverifyInstalledPackage({
      facade, baseDir, pluginEntry: entry, verifyPackage, now: now(),
    });
    if (!reverified.ok || reverified.verdict.manifest?.manifest_schema_version !== 3) {
      return refusal(reverified.reason || 'v3_package_required');
    }
    const contribution = reverified.verdict.manifest.contributions.find((item) => (
      item.contribution_id === identity.contributionId && item.kind === 'mcp_descriptor'
    ));
    const content = contribution
      ? descriptorContent(reverified.verdict, contribution.contribution_id) : null;
    if (!contribution || !content) return refusal('remote_descriptor_not_found');
    return {
      ok: true,
      entry,
      contribution,
      content,
      generation: committed.generation,
      pointer: committed.pointer,
    };
  }

  async function getDistributionState() {
    const allowed = gate();
    if (!allowed.ok) return allowed;
    const result = await distributionController.getDistributionState();
    return result.ok
      ? { ...result, network_counters: remoteMcpRuntime?.networkCounters?.() || {} }
      : result;
  }

  async function selectOfflineMirror(payload = {}) {
    let allowed = gate();
    if (!allowed.ok) return allowed;
    if (!SOURCE_ID_RE.test(String(payload.source_id || ''))
      || typeof selectOfflineRoot !== 'function') {
      return refusal('offline_mirror_selection_invalid');
    }
    const selected = await selectOfflineRoot();
    allowed = gate();
    if (!allowed.ok) return allowed;
    if (!selected?.ok || selected.canceled === true) return selected || refusal('offline_mirror_selection_failed');
    allowed = gate();
    if (!allowed.ok) return allowed;
    return distributionController.selectOfflineMirror({
      sourceId: payload.source_id,
      rootPath: selected.rootPath,
    });
  }

  async function startDistributionOperation(payload = {}) {
    let allowed = gate();
    if (!allowed.ok) return allowed;
    if (typeof selectLocalPackage !== 'function' || typeof inspectLocalPackage !== 'function'
      || !CLIENT_REQUEST_ID_RE.test(String(payload.client_request_id || ''))
      || Object.keys(payload).some((key) => key !== 'client_request_id')) {
      return refusal('distribution_request_invalid');
    }
    const selected = await selectLocalPackage();
    allowed = gate();
    if (!allowed.ok) return allowed;
    if (!selected?.ok || selected.canceled === true) return selected || refusal('package_picker_failed');
    const inspected = await inspectLocalPackage(selected);
    allowed = gate();
    if (!allowed.ok) return allowed;
    if (!inspected?.ok) return inspected || refusal('package_verification_failed');
    return installSelectedPackage(selected, inspected, payload.client_request_id);
  }

  async function installPackageFromPath(payload = {}) {
    let allowed = gate();
    if (!allowed.ok) return allowed;
    if (typeof readPackageAtPath !== 'function' || typeof inspectLocalPackage !== 'function'
      || !CLIENT_REQUEST_ID_RE.test(String(payload.client_request_id || ''))
      || typeof payload.path !== 'string' || payload.path.length < 1 || payload.path.length > 4096
      || Object.keys(payload).some((key) => !['client_request_id', 'path'].includes(key))) {
      return refusal('distribution_request_invalid');
    }
    const selected = await readPackageAtPath(payload.path);
    allowed = gate();
    if (!allowed.ok) return allowed;
    if (!selected?.ok) return selected || refusal('package_source_read_failed');
    const inspected = await inspectLocalPackage(selected);
    allowed = gate();
    if (!allowed.ok) return allowed;
    if (!inspected?.ok) return inspected || refusal('package_verification_failed');
    return installSelectedPackage(selected, inspected, payload.client_request_id);
  }

  async function installSelectedPackage(selected, inspected, clientRequestId) {
    let allowed = gate();
    if (!allowed.ok) return allowed;
    const committed = await readCommittedState(facade, baseDir);
    allowed = gate();
    if (!allowed.ok) return allowed;
    const selectedRequest = selectedPackageRequest({
      inspected, committed, clientRequestId,
    });
    if (!selectedRequest.ok) return selectedRequest;
    const { request } = selectedRequest;
    const developerProfile = inspected.publisher_key_id === DEVELOPER_UNSIGNED_KEY_ID
      && inspected.package_record?.signing_key_id === DEVELOPER_UNSIGNED_KEY_ID;
    const context = await createDistributionContext(request, {
      localPackage: selected, developerProfile,
    });
    allowed = gate();
    if (!allowed.ok) return allowed;
    if (!context?.ok) return context || refusal('distribution_context_unavailable');
    allowed = gate();
    if (!allowed.ok) return allowed;
    return distributionController.startDistributionOperation(request, {
      ...context.value,
      ...(request.operation.kind === 'update' ? { updateSourceKind: 'local_package' } : {}),
    });
  }

  async function installBundledPackage({ selected, client_request_id: clientRequestId,
    wait_for_completion: waitForCompletion = false } = {}) {
    let allowed = gate();
    if (!allowed.ok) return allowed;
    if (!selected?.ok || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(clientRequestId || ''))) {
      return refusal('bundled_distribution_request_invalid');
    }
    const inspected = await inspectLocalPackage(selected);
    allowed = gate();
    if (!allowed.ok) return allowed;
    if (!inspected?.ok) return inspected || refusal('package_verification_failed');
    if (!waitForCompletion) return installSelectedPackage(selected, inspected, clientRequestId);
    const request = {
      operation_schema_version: 1,
      client_request_id: clientRequestId,
      operation: { kind: 'install', source_kind: 'local_package',
        source_locator: 'electron_native_picker', target: {
          publisher_id: inspected.publisher_id, plugin_id: inspected.plugin_id,
        } },
    };
    const context = await createDistributionContext(request, { localPackage: selected });
    allowed = gate();
    if (!allowed.ok) return allowed;
    if (!context?.ok) return context || refusal('distribution_context_unavailable');
    allowed = gate();
    if (!allowed.ok) return allowed;
    return distributionController.startDistributionOperation(request, { ...context.value, detached: false });
  }

  async function cancelOperation(payload = {}) {
    const allowed = gate();
    if (!allowed.ok) return allowed;
    return distributionController.cancelOperation(String(payload.operation_id || ''));
  }

  async function setNetworkConsent(payload = {}) {
    const allowed = gate();
    if (!allowed.ok) return allowed;
    const descriptor = await findDescriptor(payload);
    if (!descriptor.ok) return descriptor;
    const endpoint = new URL(descriptor.content.payload.endpoint_url);
    const enabled = payload.enabled === true;
    const result = await setPluginNetworkConsent(facade, baseDir, {
      publisherId: descriptor.entry.publisher_id,
      pluginId: descriptor.entry.plugin_id,
      enabled,
      scopes: enabled ? [descriptor.content.payload.destination_scope] : [],
      destinations: enabled ? [endpoint.origin] : [],
    });
    log(result.ok ? 'INFO' : 'WARN', 'plugins.stage5.network_consent_changed', {
      publisher_id: descriptor.entry.publisher_id,
      plugin_id: descriptor.entry.plugin_id,
      enabled,
      reason: result.reason || 'updated',
    });
    return result;
  }

  async function beginRemoteMcpAuthorization(payload = {}) {
    const allowed = gate();
    if (!allowed.ok) return allowed;
    const descriptor = await findDescriptor(payload);
    if (!descriptor.ok) return descriptor;
    if (descriptor.content.payload.auth_policy !== 'oauth_2_1') {
      return refusal('remote_authorization_not_required');
    }
    const consent = await readNetworkConsent(facade, baseDir);
    if (!consent.ok) return consent;
    const destination = new URL(descriptor.content.payload.endpoint_url).origin;
    const brokerConsent = brokerConsentFor(consent.document, {
      publisherId: descriptor.entry.publisher_id,
      pluginId: descriptor.entry.plugin_id,
      destination,
      scope: descriptor.content.payload.destination_scope,
    });
    if (!brokerConsent.granted) {
      return refusal('remote_consent_required', PLUGIN_ERROR_CODES.CONSENT_REQUIRED);
    }
    const draft = bindingDraft({
      entry: descriptor.entry,
      contribution: descriptor.contribution,
      content: descriptor.content,
      generationId: descriptor.generation.generation_id,
      commitEpoch: descriptor.pointer?.commit_epoch || 0,
      consentDigest: consent.digest,
    });
    if (!draft.ok) return draft;
    const registration = {
      ...(typeof payload.client_id_metadata_document === 'string'
        ? { client_id_metadata_document: payload.client_id_metadata_document } : {}),
      allow_dcr: payload.allow_dcr === true,
    };
    if (!loopbackAuthorization || typeof loopbackAuthorization.begin !== 'function') {
      return refusal('oauth_loopback_unavailable');
    }
    return loopbackAuthorization.begin({
      binding: draft.binding,
      resource_url: draft.binding.endpoint_url,
      registration,
      previous_scopes: Array.isArray(payload.previous_scopes) ? payload.previous_scopes : [],
      context: {
        request_id: operationId('oauth_request'),
        operation_id: operationId('oauth'),
        deadline_epoch_ms: Date.now() + 120000,
        consent: brokerConsent,
      },
    });
  }

  async function revokeRemoteMcpAuthorization(payload = {}) {
    const allowed = gate();
    if (!allowed.ok) return allowed;
    const descriptor = await findDescriptor(payload);
    if (!descriptor.ok) return descriptor;
    const consent = await readNetworkConsent(facade, baseDir);
    if (!consent.ok) return consent;
    const draft = bindingDraft({
      entry: descriptor.entry,
      contribution: descriptor.contribution,
      content: descriptor.content,
      generationId: descriptor.generation.generation_id,
      commitEpoch: descriptor.pointer?.commit_epoch || 0,
      consentDigest: consent.digest,
    });
    if (!draft.ok) return draft;
    const stored = await readRemoteMcpAuthorization(facade, baseDir, draft.binding.auth_profile_ref);
    if (!stored.ok) return stored;
    const authorization = stored.authorization;
    return credentialBroker.revoke({
      publisher_id: draft.binding.publisher_id,
      plugin_id: draft.binding.plugin_id,
      contribution_id: draft.binding.contribution_id,
      descriptor_digest: draft.binding.descriptor_digest,
      resource_digest: authorization.resource_digest,
      issuer_digest: authorization.issuer_digest,
      auth_profile_ref: draft.binding.auth_profile_ref,
    });
  }

  async function executeRemoteTool(name, args, options = {}) {
    const allowed = gate();
    if (!allowed.ok) return allowed;
    return remoteMcpRuntime.execute(name, args, options);
  }

  async function dispose() {
    disposed = true;
    await distributionController?.dispose?.();
    oauthFlowService?.dispose?.();
    loopbackAuthorization?.dispose?.();
    remoteMcpRuntime?.dispose?.();
  }

  return Object.freeze({
    getDistributionState,
    selectOfflineMirror,
    startDistributionOperation,
    installPackageFromPath,
    installBundledPackage,
    cancelOperation,
    setNetworkConsent,
    beginRemoteMcpAuthorization,
    revokeRemoteMcpAuthorization,
    executeRemoteTool,
    waitForDistributionOperation: (operationId) => distributionController.waitForOperation(operationId),
    dispose,
  });
}

module.exports = {
  operationId,
  refusal,
  identityFrom,
  selectedPackageRequest,
  createStage5ControlPlane,
};
