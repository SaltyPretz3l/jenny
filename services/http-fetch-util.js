'use strict';

// Shared main-process HTTP helper for the Home dashboard pollers (calendar
// feeds, link status). Follows the setup-service convention: injected fetchImpl
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
  consumeResponse = null,
} = {}) {
  const target = String(url || '').trim();
  if (!isHttpUrl(target)) {
    throw new Error(`requestWithTimeout requires an http(s) URL, got: ${target || '(empty)'}`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('requestWithTimeout requires a fetch implementation.');
  }
  const controller = new AbortController();
  let rejectTimeout;
  const deadline = new Promise((_resolve, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(
    () => {
      rejectTimeout(new Error('HTTP request timed out.'));
      controller.abort();
    },
    Math.max(Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS, 100)
  );
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  try {
    const operation = (async () => {
      const response = await fetchImpl(target, {
        method, headers, signal: controller.signal, redirect: 'follow',
      });
      return consumeResponse ? consumeResponse(response, controller.signal) : response;
    })();
    return await Promise.race([operation, deadline]);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseText(response, { maxBytes, signal } = {}) {
  const declaredLength = Number(response?.headers?.get?.('content-length'));
  if (declaredLength > maxBytes) {
    void response?.body?.cancel?.().catch(() => {});
    throw new Error('HTTP response exceeds size limit.');
  }
  const reader = response?.body?.getReader?.();
  if (!reader) {
    if (response?.body === null) return '';
    throw new Error('HTTP response body is not readable.');
  }
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error('HTTP request timed out.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) throw new Error('HTTP request timed out.');
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      totalBytes += value?.byteLength || 0;
      if (totalBytes > maxBytes) throw new Error('HTTP response exceeds size limit.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    void reader.cancel?.().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  isHttpUrl,
  requestWithTimeout,
  readBoundedResponseText,
};
