'use strict';

const { createHash } = require('node:crypto');
const {
  captureRuntimeRoute,
  isRuntimeRoute,
} = require('../session-runtime/lanes');

const ENGINE_TOKEN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const REVISION_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const TRUSTED_STATE_KEYS = ['credential', 'route'];
const CREDENTIAL_KEYS = ['available', 'required', 'revision'];

const BUILTIN_ROUTES = Object.freeze({
  ollama: Object.freeze({ provider_id: 'ollama', resource_class: 'local', requires_gpu: true }),
  vllm: Object.freeze({ provider_id: 'vllm', resource_class: 'local', requires_gpu: true }),
  mock: Object.freeze({ provider_id: 'mock', resource_class: 'local', requires_gpu: false }),
  replay: Object.freeze({ provider_id: 'replay', resource_class: 'local', requires_gpu: false }),
  chatgpt: Object.freeze({ provider_id: 'chatgpt', resource_class: 'cloud', requires_gpu: false }),
  'codex-cli': Object.freeze({ provider_id: 'codex-cli', resource_class: 'cloud', requires_gpu: false }),
  // Jenny's persisted desktop settings explicitly own this under localEngines.
  // Hosted endpoints currently have no trusted locality field, so they remain
  // conservatively local regardless of their hostname.
  'openai-compatible': Object.freeze({
    provider_id: 'openai-compatible', resource_class: 'local', requires_gpu: true,
  }),
});

const capturedRoutes = new WeakMap();

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.join(',');
}

function routeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

function normalizeEngineType(value) {
  const engineType = String(value || '').trim().toLowerCase();
  if (!ENGINE_TOKEN.test(engineType)) {
    throw routeError('runtime_provider_unsupported', 'The selected provider is unavailable.');
  }
  return engineType;
}

function safeConfigIdentity(service, engineType) {
  const state = service?.configService?.getState?.() || {};
  const localEngines = state.localEngines || state.local_engines || {};
  const hosted = service?.hostMode === 'server' && service?.options?.modelEndpoint?.engine === engineType
    ? service.options.modelEndpoint : null;
  if (engineType === 'vllm') {
    return { engine_type: engineType, local_engine: localEngines.vllm || null };
  }
  if (engineType === 'openai-compatible') {
    return {
      engine_type: engineType,
      local_engine: localEngines.openaiCompatible || localEngines.openai_compatible || null,
      hosted_endpoint: hosted ? {
        engine: String(hosted.engine || ''),
        model: String(hosted.model || ''),
        api_url: String(hosted.apiUrl || ''),
      } : null,
    };
  }
  if (engineType === 'codex-cli') {
    return { engine_type: engineType, settings: state.codexCli || state.codex_cli || null };
  }
  if (hosted) {
    return {
      engine_type: engineType,
      hosted_endpoint: {
        engine: String(hosted.engine || ''),
        model: String(hosted.model || ''),
        api_url: String(hosted.apiUrl || ''),
      },
    };
  }
  return { engine_type: engineType };
}

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw routeError('runtime_provider_configuration_invalid', 'Provider configuration is invalid.');
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    throw routeError('runtime_provider_configuration_invalid', 'Provider configuration is invalid.');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = `[${value.map(item => canonicalJson(item, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  const result = `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`
  )).join(',')}}`;
  seen.delete(value);
  return result;
}

function configurationRevision(identity) {
  const encoded = canonicalJson(identity);
  if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) {
    throw routeError('runtime_provider_configuration_invalid', 'Provider configuration is invalid.');
  }
  return `cfg:${createHash('sha256').update(encoded).digest('hex')}`;
}

function builtinCredentialState(service, engineType) {
  if (engineType === 'chatgpt') {
    const auth = service?.chatgptAuthService;
    const authEpoch = auth?.getCredentialEpoch?.();
    const runtimeEpoch = service?._chatgptRuntimeCredentialEpoch;
    const validEpochs = Number.isSafeInteger(authEpoch) && Number.isSafeInteger(runtimeEpoch);
    return Object.freeze({
      required: true,
      available: Boolean(auth?.hasCredential?.()) && validEpochs && authEpoch === runtimeEpoch,
      revision: validEpochs ? `${authEpoch}:${runtimeEpoch}` : 'unavailable',
    });
  }
  if (engineType === 'codex-cli') {
    const state = service?.codexCliRuntimeService?.getState?.();
    const credentialEpoch = service?.codexCliAuthService?.getCredentialEpoch?.();
    const authType = String(state?.authType || state?.auth_type || '').trim().toLowerCase();
    const available = state?.status === 'ready' && authType === 'chatgpt'
      && Number.isSafeInteger(credentialEpoch);
    return Object.freeze({
      required: true,
      available,
      revision: available ? `auth:${credentialEpoch}` : 'unavailable',
    });
  }
  return Object.freeze({ required: false, available: true, revision: 'none' });
}

function validateTrustedState(state, engineType) {
  if (!exactKeys(state, TRUSTED_STATE_KEYS)
    || !exactKeys(state.route, ['configuration_revision', 'engine_type', 'provider_id', 'requires_gpu', 'resource_class'])
    || !exactKeys(state.credential, CREDENTIAL_KEYS)
    || normalizeEngineType(state.route.engine_type) !== engineType
    || typeof state.route.provider_id !== 'string'
    || !ENGINE_TOKEN.test(state.route.provider_id)
    || typeof state.route.configuration_revision !== 'string'
    || !REVISION_TOKEN.test(state.route.configuration_revision)
    || !['local', 'cloud'].includes(state.route.resource_class)
    || typeof state.route.requires_gpu !== 'boolean'
    || (state.route.resource_class === 'cloud' && state.route.requires_gpu)
    || typeof state.credential.required !== 'boolean'
    || typeof state.credential.available !== 'boolean'
    || typeof state.credential.revision !== 'string'
    || !REVISION_TOKEN.test(state.credential.revision)) {
    throw routeError('runtime_provider_metadata_invalid', 'Trusted provider metadata is invalid.');
  }
  return state;
}

function resolveProviderState(service, engineType) {
  const registry = service?.sessionRuntimeProviderRouteRegistry;
  if (registry !== undefined && registry !== null) {
    if (typeof registry.resolve !== 'function') {
      throw routeError('runtime_provider_metadata_invalid', 'Trusted provider metadata is invalid.');
    }
    const trusted = registry.resolve(engineType);
    if (trusted !== null && trusted !== undefined) {
      return validateTrustedState(trusted, engineType);
    }
  }
  const builtin = BUILTIN_ROUTES[engineType];
  if (!builtin) {
    throw routeError('runtime_provider_unsupported', 'The selected provider is unavailable.');
  }
  return {
    route: {
      engine_type: engineType,
      provider_id: builtin.provider_id,
      configuration_revision: configurationRevision(safeConfigIdentity(service, engineType)),
      resource_class: builtin.resource_class,
      requires_gpu: builtin.requires_gpu,
    },
    credential: builtinCredentialState(service, engineType),
  };
}

function bindProviderState(state, engineType) {
  const route = captureRuntimeRoute(state.route);
  capturedRoutes.set(route, Object.freeze({
    engine_type: engineType,
    configuration_revision: route.configuration_revision,
    credential_revision: state.credential.revision,
  }));
  return route;
}

// Capture comparison evidence before async force-local resolution without granting
// an unused provider authority or requiring its credentials. Only the effective
// selected candidate is validated and branded when the request is normalized.
function captureSessionRuntimeProviderSelection(service, selectedEngineType) {
  const candidates = new Map();
  for (const engine of new Set([selectedEngineType, 'ollama', 'vllm'])) {
    try { candidates.set(engine, { state: canonicalJson(resolveProviderState(service, engine)) }); }
    catch (error) { candidates.set(engine, { error }); }
  }
  return engine => {
    const captured = candidates.get(engine);
    if (!captured) throw routeError('runtime_provider_selection_changed', 'Provider selection changed.');
    if (captured.error) throw captured.error;
    const current = resolveProviderState(service, engine);
    if (canonicalJson(current) !== captured.state) {
      throw routeError('runtime_provider_configuration_changed', 'Provider configuration changed while the request was prepared.');
    }
    return bindProviderState(current, engine);
  };
}

function captureSessionRuntimeProviderRoute(service, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => key !== 'engineType')) {
    throw routeError('runtime_provider_capture_invalid', 'Provider route capture options are invalid.');
  }
  // engineType is an internal application-owner override for force-local
  // selection. No model id, prompt, or endpoint metadata is accepted here.
  const engineType = normalizeEngineType(
    Object.hasOwn(options, 'engineType') ? options.engineType : service?.currentEngineType
  );
  return bindProviderState(resolveProviderState(service, engineType), engineType);
}

function restoreSessionRuntimeProviderRoute(service, persistedRoute) {
  if (!exactKeys(
    persistedRoute,
    ['configuration_revision', 'engine_type', 'provider_id', 'requires_gpu', 'resource_class']
  )) {
    throw routeError('runtime_provider_route_invalid', 'The stored provider route is invalid.');
  }
  const engineType = normalizeEngineType(persistedRoute.engine_type);
  const state = resolveProviderState(service, engineType);
  if (Object.keys(state.route).some(key => state.route[key] !== persistedRoute[key])) {
    throw routeError('runtime_provider_configuration_changed', 'Provider configuration changed while the turn was paused.');
  }
  // Issue a fresh capability from the current trusted state. The persisted
  // object is comparison evidence only and is never passed to the route factory.
  return bindProviderState(state, engineType);
}

function assertSessionRuntimeProviderRouteCurrent(service, route) {
  const captured = capturedRoutes.get(route);
  if (!isRuntimeRoute(route) || !captured) {
    throw routeError('runtime_provider_route_untrusted', 'The provider route is not trusted.');
  }
  // Re-resolve the bound engine. A later UI/model selection is deliberately
  // irrelevant to the request that already captured this route.
  const current = resolveProviderState(service, captured.engine_type);
  if (current.route.engine_type !== route.engine_type
    || current.route.provider_id !== route.provider_id
    || current.route.resource_class !== route.resource_class
    || current.route.requires_gpu !== route.requires_gpu
    || current.route.configuration_revision !== captured.configuration_revision) {
    throw routeError('runtime_provider_configuration_changed', 'Provider configuration changed while the turn was waiting.');
  }
  if (current.credential.required && !current.credential.available) {
    throw routeError('runtime_provider_credentials_unavailable', 'Provider credentials are unavailable.');
  }
  if (current.credential.revision !== captured.credential_revision) {
    throw routeError('runtime_provider_credentials_changed', 'Provider credentials changed while the turn was waiting.');
  }
  return route;
}

module.exports = {
  captureSessionRuntimeProviderSelection,
  assertSessionRuntimeProviderRouteCurrent,
  captureSessionRuntimeProviderRoute,
  restoreSessionRuntimeProviderRoute,
};
