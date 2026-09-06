'use strict';

// Stage 7 provider-auth facade. It intentionally delegates credential ownership
// to the existing safeStorage-backed service so migration never copies or
// rewrites OAuth material and an older Stage 6 build can use the same record.
function createPluginProviderAuthService({ chatgptAuthService, isProviderActive = () => false,
  onAuthChanged = async () => {}, log = () => {} } = {}) {
  function supported(providerId) { return providerId === 'chatgpt'; }
  function reject() { return { ok: false, reason: 'provider_not_available', retryable: false }; }
  function available(providerId) { return supported(providerId) && Boolean(chatgptAuthService); }
  async function notifyAuthChanged(providerId, reason) {
    try {
      await onAuthChanged({ provider_id: providerId, reason });
    } catch (_error) {
      // Credential mutation already committed at this point. A provider
      // reconfiguration failure degrades that provider, but must not turn a
      // successful sign-in/sign-out into a false auth failure in the view.
      log('plugin.provider.reconfigure_failed', {
        provider_id: providerId,
        operation: reason,
        reason_code: 'provider_reconfigure_failed',
      });
    }
  }
  return Object.freeze({
    status(providerId) {
      if (!available(providerId)) return reject();
      return { ok: true, provider_id: providerId, active: isProviderActive(providerId),
        auth: chatgptAuthService.getStatus() };
    },
    async start(providerId, options) {
      if (!available(providerId)) return reject();
      const auth = await chatgptAuthService.start(options);
      await notifyAuthChanged(providerId, 'provider_auth_started');
      return { ok: true, provider_id: providerId, auth };
    },
    cancel(providerId) {
      if (!available(providerId)) return reject();
      chatgptAuthService.cancel();
      return { ok: true, provider_id: providerId, auth: chatgptAuthService.getStatus() };
    },
    async signOut(providerId) {
      if (!available(providerId)) return reject();
      const auth = await chatgptAuthService.signOut();
      await notifyAuthChanged(providerId, 'provider_auth_signed_out');
      return { ok: true, provider_id: providerId, auth };
    },
    getAccessToken(providerId, options) {
      return available(providerId) ? chatgptAuthService.getAccessToken(options) : Promise.resolve('');
    },
    hasCredential: (providerId) => available(providerId) && chatgptAuthService.hasCredential(),
    onStatusChange: (callback) => available('chatgpt')
      ? chatgptAuthService.onStatusChange(callback) : () => {},
  });
}

module.exports = { createPluginProviderAuthService };
