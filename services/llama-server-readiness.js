'use strict';

// Readiness and reuse probing for the managed llama-server: is something
// already answering on the port, is it OUR model, and when does a freshly
// spawned child start serving. Split out of llama-server-lifecycle.js so the
// spawn/stop/pid-identity module stays under the complexity ratchet.

const http = require('http');

const { isPortOpen, wait } = require('./backend/process-utils');

const DEFAULT_READINESS_TIMEOUT_MS = 90_000;
const DEFAULT_READINESS_POLL_INTERVAL_MS = 300;
const DEFAULT_EXISTING_PROBE_TIMEOUT_MS = 750;

function normalizeLogger(logger) {
  return typeof logger === 'function' ? logger : () => {};
}

function stripLatestTag(modelTag) {
  return String(modelTag || '').trim().replace(/:latest$/i, '');
}

function hasExpectedModel(payload, expectedModelId) {
  if (!payload || payload.object !== 'list' || !Array.isArray(payload.data)) {
    return false;
  }
  const expected = stripLatestTag(expectedModelId);
  if (!expected) {
    return true;
  }
  return payload.data.some((entry) => String(entry && entry.id || '').trim() === expected);
}

// GET {baseUrl}/models; true only for a 2xx OpenAI-style model list that
// carries expectedModelId (when given). `statusRef.statusCode` lets a caller
// tell an unauthorized server (401/403) from a dead or foreign one.
function probeHealth(baseUrl, {
  timeoutMs = DEFAULT_EXISTING_PROBE_TIMEOUT_MS,
  expectedModelId = '',
  apiKey = '',
  statusRef = null,
} = {}) {
  return new Promise((resolve) => {
    const normalized = String(baseUrl || '').replace(/\/+$/, '');
    const url = `${normalized}/models`;
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    try {
      const requestOptions = { timeout: timeoutMs };
      if (typeof apiKey === 'string' && apiKey) {
        requestOptions.headers = { Authorization: `Bearer ${apiKey}` };
      }
      const request = http.get(url, requestOptions, (response) => {
        const statusCode = response.statusCode || 0;
        if (statusRef && typeof statusRef === 'object') {
          statusRef.statusCode = statusCode;
        }
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          finish(false);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += String(chunk || '');
          if (body.length > 1024 * 1024) {
            request.destroy();
            finish(false);
          }
        });
        response.on('end', () => {
          try {
            finish(hasExpectedModel(JSON.parse(body), expectedModelId));
          } catch (_error) {
            finish(false);
          }
        });
      });
      request.on('timeout', () => {
        request.destroy();
        finish(false);
      });
      request.on('error', () => finish(false));
    } catch (_error) {
      finish(false);
    }
  });
}

async function probeExistingServer({
  baseUrl,
  host = '127.0.0.1',
  port = 8033,
  timeoutMs = DEFAULT_EXISTING_PROBE_TIMEOUT_MS,
  expectedModelId = '',
  logger,
} = {}) {
  const portOpen = await isPortOpen(port, host);
  if (!portOpen) {
    return false;
  }
  const statusRef = { statusCode: 0 };
  const reusable = await probeHealth(baseUrl || `http://${host}:${port}/v1`, {
    timeoutMs,
    expectedModelId,
    statusRef,
  });
  if (!reusable && (statusRef.statusCode === 401 || statusRef.statusCode === 403)) {
    // A keyed server on our port cannot be reused (its key is not ours to
    // know). If it is a stale Jenny server the pid-record reap handles it;
    // anything else keeps the port and the spawn will fail to bind.
    normalizeLogger(logger)('WARN', 'llama.server.existing_server_requires_auth', {
      host,
      port,
      statusCode: statusRef.statusCode,
    });
  }
  return reusable;
}

async function waitForReadiness({
  baseUrl,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_READINESS_POLL_INTERVAL_MS,
  abortSignal = null,
  childExitedRef = { exited: false },
  apiKey = '',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (abortSignal && abortSignal.aborted) {
      throw new Error('readiness_aborted');
    }
    if (childExitedRef.exited) {
      throw new Error('child_exited_before_ready');
    }
    if (await probeHealth(baseUrl, { timeoutMs: 1500, apiKey })) {
      return true;
    }
    await wait(pollIntervalMs);
  }
  return false;
}

module.exports = {
  DEFAULT_EXISTING_PROBE_TIMEOUT_MS,
  DEFAULT_READINESS_POLL_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  normalizeLogger,
  probeExistingServer,
  probeHealth,
  stripLatestTag,
  waitForReadiness,
};
