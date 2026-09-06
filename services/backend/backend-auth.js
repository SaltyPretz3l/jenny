const AUTOMATIC_LOCAL_USER = Object.freeze({
  user_id: 'usr_local',
  email: 'local@jenny.local',
  display_name: 'Local User',
});
const LOCAL_PROFILE_NAME_MAX_CHARS = 80;

function readLocalUser(service) {
  try {
    const parsed = JSON.parse(service.secureStore.get('user_json') || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function emitAutomaticLocalProfileFallbackWarning(service) {
  if (service._localProfileFallbackWarningEmitted) {
    return;
  }
  let status;
  try {
    status = service.secureStore?.getStatus?.();
  } catch (_error) {
    return;
  }
  if (!status || status.status !== 'unavailable') {
    return;
  }
  service._localProfileFallbackWarningEmitted = true;
  try {
    service._emitServiceLog?.('WARN', 'auth.local_profile_fallback', {
      credentialStoreStatus: 'unavailable',
      storageBackend: String(status.storageBackend || '').slice(0, 64),
    });
  } catch (_error) {
    // Observability must not prevent the non-secret automatic profile fallback.
  }
}

function resolveManagedLocalUser(service) {
  const persistedUser = readLocalUser(service);
  if (persistedUser) {
    return persistedUser;
  }
  emitAutomaticLocalProfileFallbackWarning(service);
  return AUTOMATIC_LOCAL_USER;
}

function persistLocalAuthState(service, user) {
  service.accessToken = user ? 'local-session' : '';
  if (user) {
    service.secureStore.set('user_json', JSON.stringify(user));
  } else {
    service.secureStore.delete('user_json');
  }
  const state = getAuthState(service);
  service.emit('auth-state', state);
  return state;
}

function getAuthState(service) {
  const localUser = resolveManagedLocalUser(service);
  service.accessToken = 'local-session';
  return {
    authenticated: true,
    user: localUser,
  };
}

async function restoreAuthState(service) {
  const state = getAuthState(service);
  service.emit('auth-state', state);
  return state;
}

function updateLocalProfile(service, { displayName } = {}) {
  const normalizedName = String(displayName || '').trim();
  if (!normalizedName || normalizedName.length > LOCAL_PROFILE_NAME_MAX_CHARS) {
    throw new Error(`Profile name must be between 1 and ${LOCAL_PROFILE_NAME_MAX_CHARS} characters.`);
  }
  const current = resolveManagedLocalUser(service);
  return persistLocalAuthState(service, {
    user_id: String(current?.user_id || AUTOMATIC_LOCAL_USER.user_id),
    email: String(current?.email || AUTOMATIC_LOCAL_USER.email),
    display_name: normalizedName,
  });
}

module.exports = {
  getAuthState,
  restoreAuthState,
  updateLocalProfile,
  readLocalUser,
  persistLocalAuthState,
};
