'use strict';

// Which managed server owns the sidecar's openai-compatible endpoint right
// now: llama-server, NInfer, Strata (row 200), or the team engine port (row 123
// slice 4b, a loopback port that forwards to the team's pooled GPUs). Each mints
// a per-launch api key that must travel only to the endpoint that IS that server
// (same local origin), and only that endpoint takes the server's alias as its
// model. The list is closed at these four. The resolution lives here, apart
// from managed-sidecar-config.js, so that file keeps one concern.

const { sameLocalOrigin } = require('../local-origin');

// A managed server's origin while its manager is `ready`, '' otherwise: the
// sidecar is pointed at NInfer (`http://127.0.0.1:8034`) or Strata (`:8035`)
// only while it serves, so a loading Strata's empty catalog never reaches
// load_model (G9).
function readyManagedOrigin(manager) {
  if (!manager || manager.getStatus?.()?.state !== 'ready') return '';
  const baseUrl = String(manager.getBaseUrl?.() || '');
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).origin;
  } catch (_error) {
    return '';
  }
}

function ninferManagedOrigin(service) {
  return readyManagedOrigin(service?.options?.getNinferManager?.() || null);
}

function strataManagedOrigin(service) {
  return readyManagedOrigin(service?.options?.getStrataManager?.() || null);
}

// The manager whose tracked server shares `apiUrl`'s local origin, as
// { kind, manager, status }; null when the endpoint is a user's own server.
function resolveManagedServerOwner(service, apiUrl) {
  const candidates = [
    ['strata', service?.options?.getStrataManager?.() || null],
    ['ninfer', service?.options?.getNinferManager?.() || null],
    ['llama-server', service?.options?.getLlamaServerManager?.() || null],
    // Reports no alias, so the configured model stays the model.
    ['team-engine', service?.options?.getTeamEnginePort?.() || null],
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

// The per-launch key for `apiUrl`, '' when no managed server owns it. The
// team engine port's key also waits for `ready`: a deliberate fail-closed check,
// since that key is minted per port launch and a port that is not serving must
// not have it handed out.
function managedServerApiKey(service, apiUrl) {
  const owner = resolveManagedServerOwner(service, apiUrl);
  if (!owner || typeof owner.manager.getApiKey !== 'function') return '';
  if (owner.kind === 'team-engine' && owner.status.state !== 'ready') return '';
  return String(owner.manager.getApiKey() || '');
}

module.exports = {
  managedServerAlias,
  managedServerApiKey,
  ninferManagedOrigin,
  resolveManagedServerOwner,
  strataManagedOrigin,
};
