'use strict';

const { HOST_ERROR_CODES } = require('../backend/error-codes');

const HOST_MODE_DESKTOP = 'desktop';
const HOST_MODE_SERVER = 'server';

// Host choice is privileged composition input, never a browser preference.
// No wire-key aliases or permissive normalizers belong at this boundary.
function validateHostPortConfig(input = {}) {
  const invalid = (reason) => ({ ok: false, code: HOST_ERROR_CODES.INVALID, reason });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('invalid_host_config');
  if (Object.keys(input).some((key) => !['hostMode', 'credentialService'].includes(key))) {
    return invalid('invalid_host_config');
  }
  const mode = input.hostMode === undefined ? HOST_MODE_DESKTOP : input.hostMode;
  if (mode !== HOST_MODE_DESKTOP && mode !== HOST_MODE_SERVER) return invalid('unsupported_host_mode');
  const credentialService = input.credentialService ?? null;
  if (credentialService !== null && (typeof credentialService.get !== 'function'
      || typeof credentialService.getStatus !== 'function')) return invalid('invalid_credential_service');
  if (mode === HOST_MODE_SERVER && credentialService === null) return invalid('credential_service_required');
  return {
    ok: true,
    value: {
      mode, credentialService,
      engineLifecycle: mode === HOST_MODE_SERVER ? 'external' : 'managed',
      posture: {
        ownsEngineLifecycle: mode === HOST_MODE_DESKTOP,
        requiresCredentialService: mode === HOST_MODE_SERVER,
      },
    },
  };
}

function createHostPorts(input = {}) {
  const result = validateHostPortConfig(input);
  if (!result.ok) {
    const error = new TypeError(result.reason);
    error.code = result.code;
    error.reason = result.reason;
    throw error;
  }
  return Object.freeze({ ...result.value, posture: Object.freeze(result.value.posture) });
}

module.exports = { HOST_MODE_DESKTOP, HOST_MODE_SERVER, createHostPorts, validateHostPortConfig };
