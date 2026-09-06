'use strict';

const nodePath = require('node:path');
const crypto = require('node:crypto');
const { PLUGIN_ERROR_CODES } = require('../backend/error-codes');
const { classifyOperation } = require('./consent/high-consequence');
const { validateDisplayString } = require('./identity/display-strings');

const PLUGIN_STORE_ROOT_DIRNAME = 'plugins';
const NEUTRAL_DISPLAY_NAME = '(unnamed plugin)';
const LIFECYCLE_TO_CONSENT_OPERATION = Object.freeze({
  install: 'install_local_package', uninstall: 'uninstall', enable: 'enable', disable: 'disable',
});

function resolvePluginStoreRoot(userDataPath) {
  return nodePath.join(String(userDataPath), PLUGIN_STORE_ROOT_DIRNAME);
}
function defaultNow() { return new Date().toISOString(); }
function defaultNewOperationId() { return crypto.randomUUID(); }
function defaultRequireConsent({ operation }) {
  return classifyOperation(LIFECYCLE_TO_CONSENT_OPERATION[operation] || operation) === 'ordinary'
    ? { ok: true }
    : { ok: false, code: PLUGIN_ERROR_CODES.CONSENT_REQUIRED, reason: 'consent_surface_unavailable' };
}
function unavailablePackageReader() {
  return { ok: false, code: PLUGIN_ERROR_CODES.INTEGRITY_FAILED, reason: 'package_source_unavailable' };
}
function unavailableVerifier() {
  return { ok: false, code: PLUGIN_ERROR_CODES.INTEGRITY_FAILED, reason: 'package_verifier_unavailable' };
}
function safeDisplayName(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  const validated = validateDisplayString(rawValue);
  return validated.ok ? validated.value : NEUTRAL_DISPLAY_NAME;
}
function buildControlPlanePosture(featureEnabled, safeMode, stage) {
  return {
    stage,
    disabled_only: false,
    activation_scope: stage >= 5 ? 'stage5_remote_mcp' : 'first_party_skill_prompt',
    restricted_host_scope: stage >= 6 ? 'stage6_restricted_host' : 'unavailable',
    enabled: featureEnabled === true,
    safe_mode_active: safeMode?.active === true,
    safe_mode_source: String(safeMode?.source || 'none'),
  };
}

module.exports = { PLUGIN_STORE_ROOT_DIRNAME, NEUTRAL_DISPLAY_NAME,
  LIFECYCLE_TO_CONSENT_OPERATION, resolvePluginStoreRoot, defaultNow,
  defaultNewOperationId, defaultRequireConsent, unavailablePackageReader,
  unavailableVerifier, safeDisplayName, buildControlPlanePosture };
