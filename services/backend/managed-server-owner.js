'use strict';

// Which managed server (llama-server or NInfer) owns the sidecar's
// openai-compatible endpoint right now. Both managers mint a per-launch api
// key that must travel only to the endpoint that IS that server (same local
// origin), and only that endpoint takes the server's alias as its model.
// managed-sidecar-config.js is at its size ceiling, so the two-manager
// resolution lives here.

const { sameLocalOrigin } = require('../local-origin');

// The NInfer origin (`http://127.0.0.1:8034`) while its manager is `ready`,
// '' otherwise: the sidecar is pointed at NInfer only when NInfer serves.
function ninferManagedOrigin(service) {
  const manager = service?.options?.getNinferManager?.() || null;
  if (!manager || manager.getStatus?.()?.state !== 'ready') return '';
  const baseUrl = String(manager.getBaseUrl?.() || '');
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).origin;
  } catch (_error) {
    return '';
  }
}

// The manager whose tracked server shares `apiUrl`'s local origin, as
// { kind, manager, status }; null when the endpoint is a user's own server.
function resolveManagedServerOwner(service, apiUrl) {
  const candidates = [
    ['ninfer', service?.options?.getNinferManager?.() || null],
    ['llama-server', service?.options?.getLlamaServerManager?.() || null],
  ];
  for (const [kind, manager] of candidates) {
    if (!manager || typeof manager.getBaseUrl !== 'function') continue;
    const baseUrl = String(manager.getBaseUrl() || '');
    if (baseUrl && sameLocalOrigin(apiUrl, baseUrl)) {
      return { kind, manager, status: manager.getStatus?.() || {} };
    }
  }
  return null;
}

// The alias a ready managed server reports for `apiUrl`, '' otherwise.
function managedServerAlias(service, apiUrl) {
  const owner = resolveManagedServerOwner(service, apiUrl);
  if (!owner || owner.status.state !== 'ready') return '';
  return String(owner.status.alias || '').trim();
}

// The per-launch key for `apiUrl`, '' when no managed server owns it.
function managedServerApiKey(service, apiUrl) {
  const owner = resolveManagedServerOwner(service, apiUrl);
  if (!owner || typeof owner.manager.getApiKey !== 'function') return '';
  return String(owner.manager.getApiKey() || '');
}

module.exports = {
  managedServerAlias,
  managedServerApiKey,
  ninferManagedOrigin,
  resolveManagedServerOwner,
};
