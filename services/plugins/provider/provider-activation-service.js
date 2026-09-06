'use strict';

const PROVIDER_RECONFIGURE_TIMEOUT_MS = 8_000;

function providerReconfigureOptions(providerId = '') {
  return {
    requestedEngineType: providerId === 'chatgpt' ? 'chatgpt' : undefined,
    inactivityTimeoutMs: PROVIDER_RECONFIGURE_TIMEOUT_MS,
    absoluteTimeoutMs: PROVIDER_RECONFIGURE_TIMEOUT_MS,
  };
}

async function activateChatgptProvider(backendService, providerId) {
  const configService = backendService?.configService;
  if (providerId !== 'chatgpt' || typeof backendService?.refreshManagedConfig !== 'function'
    || typeof configService?.updatePreferredEngineType !== 'function') {
    return { ok: false, reason: 'provider_activation_unavailable' };
  }
  const previous = String(configService.getState?.()?.preferredEngineType || '');
  try {
    await Promise.resolve(configService.updatePreferredEngineType('chatgpt'));
    const result = await backendService.refreshManagedConfig(
      'plugin_provider_activated', providerReconfigureOptions(providerId)
    );
    if (result === null || result === undefined || result === false || result?.ok === false) {
      throw new Error('provider_activation_failed');
    }
    return { ok: true, value: { provider_id: providerId } };
  } catch (_error) {
    try { await Promise.resolve(configService.updatePreferredEngineType(previous)); } catch (_rollbackError) {
      return { ok: false, reason: 'provider_activation_rollback_failed' };
    }
    return { ok: false, reason: 'provider_activation_failed' };
  }
}

module.exports = { activateChatgptProvider, providerReconfigureOptions };
