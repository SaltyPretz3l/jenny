'use strict';

// Shared main-process HTTP helper for the Home dashboard pollers (weather,
// link status). Follows the setup-service convention: injected fetchImpl
// (defaults to the Electron main-process global fetch) + AbortController
// timeout. Only http(s) URLs are ever requested.

const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

function isHttpUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(String(value || '').trim());
}

async function requestWithTimeout(url, {
  method = 'GET',
  headers = undefined,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const target = String(url || '').trim();
  if (!isHttpUrl(target)) {
    throw new Error(`requestWithTimeout requires an http(s) URL, got: ${target || '(empty)'}`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('requestWithTimeout requires a fetch implementation.');
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS, 100)
  );
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  try {
    return await fetchImpl(target, {
      method,
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  isHttpUrl,
  requestWithTimeout,
};
