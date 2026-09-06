// TTL-bounded per-service registry of stream IDs whose user turn is already persisted.

const USER_MESSAGE_PERSIST_REGISTRY_TTL_MS = 5 * 60_000;

function getPersistedUserStreamRegistry(service) {
  if (!(service._persistedUserStreamIds instanceof Map)) {
    service._persistedUserStreamIds = new Map();
  }
  return service._persistedUserStreamIds;
}

function prunePersistedUserStreamRegistry(registry) {
  const now = Date.now();
  for (const [streamId, expiresAt] of registry.entries()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      registry.delete(streamId);
    }
  }
}

function rememberPersistedUserStream(service, streamId) {
  const normalized = String(streamId || '').trim();
  if (!normalized) {
    return false;
  }
  const registry = getPersistedUserStreamRegistry(service);
  prunePersistedUserStreamRegistry(registry);
  if (registry.has(normalized)) {
    return false;
  }
  registry.set(normalized, Date.now() + USER_MESSAGE_PERSIST_REGISTRY_TTL_MS);
  return true;
}

function hasPersistedUserStream(service, streamId) {
  const normalized = String(streamId || '').trim();
  if (!normalized) {
    return false;
  }
  const registry = getPersistedUserStreamRegistry(service);
  prunePersistedUserStreamRegistry(registry);
  return registry.has(normalized);
}

module.exports = {
  USER_MESSAGE_PERSIST_REGISTRY_TTL_MS,
  getPersistedUserStreamRegistry,
  prunePersistedUserStreamRegistry,
  rememberPersistedUserStream,
  hasPersistedUserStream,
};
