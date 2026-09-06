'use strict';

const { normalizeString } = require('./backend/path-utils');
const { SETUP_ERROR_CODES } = require('./backend/error-codes');
const { sameLocalOrigin } = require('./local-origin');

const LOCAL_ENDPOINT_ENGINES = Object.freeze(['ollama', 'vllm', 'openai-compatible']);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CATALOG_BYTES = 1024 * 1024;
const LOCAL_ENDPOINT_SUFFIXES = Object.freeze([
  '.localhost', '.local', '.lan', '.internal', '.home.arpa',
]);

function normalizeEngineType(value) {
  const token = normalizeString(value).toLowerCase().replace(/_/g, '-');
  return LOCAL_ENDPOINT_ENGINES.includes(token) ? token : '';
}

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.max(Math.round(parsed), 1), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

function isPrivateIpv4(hostname) {
  const parts = String(hostname || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts;
  return first === 10 || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
    || (first === 100 && second >= 64 && second <= 127);
}

function isLoopbackHost(hostname) {
  const host = normalizeString(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1'
    || (isPrivateIpv4(host) && Number(host.split('.')[0]) === 127);
}

function isLocalEndpointHost(hostname) {
  const host = normalizeString(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (isLoopbackHost(host) || host === 'host.docker.internal' || host === 'gateway.docker.internal') {
    return true;
  }
  if (LOCAL_ENDPOINT_SUFFIXES.some((suffix) => host.endsWith(suffix)) || isPrivateIpv4(host)) {
    return true;
  }
  if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:'))) {
    return true;
  }
  return !host.includes('.') && !host.includes(':');
}

function normalizeBaseUrl(value, fallback) {
  try {
    const parsed = new URL(normalizeString(value) || fallback);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (_error) {
    return '';
  }
}

function openAICompatibleModelsUrl(apiUrl, fallback) {
  const baseUrl = normalizeBaseUrl(apiUrl, fallback);
  if (!baseUrl) return '';
  const parsed = new URL(baseUrl);
  const pathname = parsed.pathname.replace(/\/$/, '') || '/';
  if (pathname === '/' || pathname === '/v1') parsed.pathname = '/v1/models';
  else if (pathname !== '/v1/models') return '';
  return parsed.toString().replace(/\/$/, '');
}

function endpointUrlFor(engineType, apiUrl) {
  if (engineType === 'ollama') {
    const baseUrl = normalizeBaseUrl(apiUrl, 'http://127.0.0.1:11434');
    if (!baseUrl) return '';
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/$/, '') || '/';
    if (pathname === '/') parsed.pathname = '/api/tags';
    else if (pathname !== '/api/tags') return '';
    return parsed.toString().replace(/\/$/, '');
  }
  if (engineType === 'vllm') return openAICompatibleModelsUrl(apiUrl, 'http://127.0.0.1:8000/v1');
  if (engineType === 'openai-compatible') {
    return openAICompatibleModelsUrl(apiUrl, 'http://127.0.0.1:8033/v1');
  }
  return '';
}

function publicFailure(code, message, engineType = '', status = 0) {
  return {
    ok: false,
    engineType,
    status,
    code,
    error_code: code === 'request_timeout'
      ? SETUP_ERROR_CODES.ENDPOINT_TIMEOUT
      : SETUP_ERROR_CODES.ENDPOINT_INVALID,
    message,
    retryable: !['unsupported_engine', 'invalid_url', 'non_local_endpoint'].includes(code),
  };
}

async function readCatalog(response, limit = MAX_CATALOG_BYTES) {
  const declared = Number(response?.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declared) && declared > limit) throw new Error('catalog_too_large');
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const value = typeof response?.json === 'function' ? await response.json() : null;
    if (Buffer.byteLength(JSON.stringify(value ?? null), 'utf8') > limit) throw new Error('catalog_too_large');
    return value;
  }
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => null);
      throw new Error('catalog_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
}

function catalogHasModels(engineType, catalog) {
  const models = engineType === 'ollama' ? catalog?.models : catalog?.data;
  if (!Array.isArray(models)) return false;
  return models.some((model) => model && typeof model === 'object' && !Array.isArray(model)
    && normalizeString(engineType === 'ollama' ? model.name || model.model : model.id).length > 0);
}

function persistencePayload(engineType, checkedUrl) {
  const url = new URL(checkedUrl);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (engineType === 'ollama') return { engineType };
  if (engineType === 'vllm') return { engineType, port };
  const apiUrl = checkedUrl.replace(/\/models$/, '');
  return { engineType, port, apiUrl };
}

class SetupEndpointService {
  constructor({
    configService,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger = null,
    // Managed llama-server manager getter (may return null). Its keyed server
    // answers 401 to an anonymous probe, so validation of ITS origin — and
    // only its origin — carries the key.
    getLlamaServerManager = () => null,
  } = {}) {
    this.configService = configService || null;
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.timeoutMs = normalizeTimeoutMs(timeoutMs);
    this.logger = typeof logger === 'function' ? logger : null;
    this.getLlamaServerManager = typeof getLlamaServerManager === 'function' ? getLlamaServerManager : () => null;
  }

  _managedAuthorizationFor(checkedUrl) {
    try {
      const manager = this.getLlamaServerManager();
      const apiKey = typeof manager?.getApiKey === 'function' ? String(manager.getApiKey() || '') : '';
      if (apiKey && sameLocalOrigin(checkedUrl, manager.getBaseUrl?.())) {
        return { Authorization: `Bearer ${apiKey}` };
      }
    } catch (_error) {
      // A broken manager must not change validation of unrelated endpoints.
    }
    return {};
  }

  _log(level, event, details) {
    try {
      this.logger?.(level, event, details);
    } catch (_error) {
      // Diagnostics must not change endpoint validation behavior.
    }
  }

  async validate(payload = {}) {
    const engineType = normalizeEngineType(payload.engineType || payload.engine_type);
    if (!engineType) return publicFailure('unsupported_engine', 'Choose a supported local engine.');
    if (!this.fetchImpl) return publicFailure('fetch_unavailable', 'Endpoint validation is unavailable.', engineType);
    const checkedUrl = endpointUrlFor(engineType, payload.apiUrl || payload.api_url);
    if (!checkedUrl) return publicFailure('invalid_url', 'Enter a valid http:// or https:// endpoint URL.', engineType);
    const parsed = new URL(checkedUrl);
    const allowedHost = engineType === 'openai-compatible'
      ? isLocalEndpointHost(parsed.hostname)
      : isLoopbackHost(parsed.hostname);
    const canonicalOllama = engineType !== 'ollama'
      || (parsed.protocol === 'http:' && Number(parsed.port || 80) === 11434);
    if (!allowedHost || !canonicalOllama) {
      return publicFailure('non_local_endpoint', 'Use the supported loopback or private-network endpoint.', engineType);
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const response = await this.fetchImpl(checkedUrl, {
        method: 'GET',
        headers: { Accept: 'application/json', ...this._managedAuthorizationFor(checkedUrl) },
        ...(controller ? { signal: controller.signal } : {}),
      });
      const status = Number(response?.status || 0);
      if (response?.ok !== true) return publicFailure('http_error', `Endpoint returned HTTP ${status || 'error'}.`, engineType, status);
      let catalog;
      try {
        catalog = await readCatalog(response);
      } catch (error) {
        const code = error?.message === 'catalog_too_large' ? 'catalog_too_large' : 'malformed_catalog';
        return publicFailure(code, 'Endpoint returned an invalid model catalog.', engineType, status);
      }
      if (!catalogHasModels(engineType, catalog)) {
        return publicFailure('empty_catalog', 'Endpoint returned no usable models.', engineType, status);
      }
      return { ok: true, engineType, checkedUrl, status, code: 'ok', error_code: '', message: 'Endpoint is ready.', retryable: false };
    } catch (error) {
      if (error?.name === 'AbortError' || controller?.signal?.aborted) {
        return publicFailure('request_timeout', 'Endpoint validation timed out.', engineType);
      }
      this._log('WARN', 'setup.endpoint_validation_failed', { engine_type: engineType });
      return publicFailure('request_failed', 'Endpoint could not be reached.', engineType);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async save(payload = {}) {
    const validation = await this.validate(payload);
    if (!validation.ok) return validation;
    if (!this.configService || typeof this.configService.saveSetupEndpoint !== 'function') {
      return publicFailure('persistence_unavailable', 'Endpoint settings could not be saved.', validation.engineType);
    }
    try {
      const saved = this.configService.saveSetupEndpoint(
        persistencePayload(validation.engineType, validation.checkedUrl)
      );
      if (saved?.saved !== true) {
        return publicFailure('persistence_failed', 'Endpoint settings could not be saved.', validation.engineType);
      }
    } catch (_error) {
      return publicFailure('persistence_failed', 'Endpoint settings could not be saved.', validation.engineType);
    }
    return validation;
  }
}

module.exports = {
  LOCAL_ENDPOINT_ENGINES,
  SetupEndpointService,
  endpointUrlFor,
  isLocalEndpointHost,
  normalizeEngineType,
};
