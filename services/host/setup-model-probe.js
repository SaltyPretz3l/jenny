'use strict';

const MAX_BYTES = 1024 * 1024;
const MAX_MODELS = 100;

async function boundedJson(response) {
  if (!response.body?.getReader) throw new Error('invalid_body');
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new Error('body_too_large');
      parts.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Setup-only metadata query. No model pull, generation, lifecycle or cloud fallback.
async function probeModels(endpoint, { apiKey = '', fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = new URL(endpoint.apiUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
      || base.search || base.hash || !['ollama', 'openai-compatible'].includes(endpoint.engine)) {
      return { ok: false, reason: 'endpoint_invalid' };
    }
    const suffix = endpoint.engine === 'ollama' ? 'api/tags' : 'models';
    const url = new URL(base.href.replace(/\/$/u, '') + '/' + suffix);
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal,
      headers: endpoint.engine === 'openai-compatible' && apiKey ? { Authorization: 'Bearer ' + apiKey } : {} });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      return { ok: false, reason: [401, 403].includes(response.status)
        ? 'endpoint_auth_required' : 'endpoint_http_error' };
    }
    const value = await boundedJson(response);
    const entries = endpoint.engine === 'ollama' ? value.models : value.data;
    if (!Array.isArray(entries)) return { ok: false, reason: 'endpoint_invalid_response' };
    const models = [...new Set(entries.map((entry) => endpoint.engine === 'ollama'
      ? entry?.name || entry?.model : entry?.id).filter((id) => typeof id === 'string'
      && id.length > 0 && id.length <= 240 && !/\p{Cc}/u.test(id)))].slice(0, MAX_MODELS);
    return models.length ? { ok: true, models } : { ok: false, reason: 'endpoint_no_models' };
  } catch (_error) {
    return { ok: false, reason: controller.signal.aborted ? 'endpoint_timeout' : 'endpoint_unreachable' };
  } finally { clearTimeout(timer); }
}

async function probePrivateHttps(origin, { fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL('/healthz', origin), {
      redirect: 'error', signal: controller.signal, headers: { Origin: origin },
    });
    const body = response.ok ? await boundedJson(response) : null;
    if (!response.ok) await response.body?.cancel?.().catch(() => {});
    return body?.alive === true;
  } catch (_error) { return false; }
  finally { clearTimeout(timer); }
}

// The setup container's loopback is not the app. Reach the fixed Compose
// service and retain the exact browser Host/Origin security checks.
function probeLocalHost(config, { requestImpl = require('node:http').request, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    let request;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      request = requestImpl({ hostname: 'jenny', port: config.port, path: '/healthz', method: 'GET',
        headers: { Host: new URL(config.canonicalOrigin).host, Origin: config.canonicalOrigin } }, (response) => {
        if (response.statusCode !== 200) { response.resume(); finish(false); return; }
        let bytes = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 4096) { finish(false); return; }
          chunks.push(chunk);
        });
        response.once('error', () => finish(false));
        response.once('end', () => {
          try { finish(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))).alive === true); }
          catch { finish(false); }
        });
      });
      request.once('error', () => finish(false));
      request.end();
    } catch { finish(false); }
  });
}

module.exports = { probeModels, probePrivateHttps, probeLocalHost };
