'use strict';

const crypto = require('node:crypto');
const semver = require('semver');
const { PLUGIN_ERROR_CODES } = require('../backend/error-codes');
const { readCommittedState } = require('./lifecycle/commit-sequence');
const { DEVELOPER_UNSIGNED_KEY_ID } = require('./package/distribution-package-intake');

const CLIENT_REQUEST_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function operationId(prefix = 'stage5') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 64);
}

function refusal(reason, code = PLUGIN_ERROR_CODES.POLICY_BLOCKED, extra = {}) {
  return { ok: false, code, reason, retryable: false, ...extra };
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
  selectLocalPackage = null,
  readPackageAtPath = null,
  inspectLocalPackage = null,
  createDistributionContext = async () => ({}),
  safeMode = { active: false },
} = {}) {
  let disposed = false;

  function gate() {
    if (disposed) return refusal('service_disposed', PLUGIN_ERROR_CODES.FEATURE_DISABLED);
    if (safeMode?.active === true) return refusal('plugins_safe_mode', PLUGIN_ERROR_CODES.SAFE_MODE_ACTIVE);
    return { ok: true };
  }

  async function getDistributionState() {
    const allowed = gate();
    if (!allowed.ok) return allowed;
    const result = await distributionController.getDistributionState();
    return result;
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

  async function dispose() {
    disposed = true;
    await distributionController?.dispose?.();
  }

  return Object.freeze({
    getDistributionState,
    startDistributionOperation,
    installPackageFromPath,
    installBundledPackage,
    cancelOperation,
    waitForDistributionOperation: (operationId) => distributionController.waitForOperation(operationId),
    dispose,
  });
}

module.exports = {
  operationId,
  refusal,
  selectedPackageRequest,
  createStage5ControlPlane,
};
