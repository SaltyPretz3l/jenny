'use strict';

/**
 * services/pinned-download.js
 *
 * Streams one pinned artifact to disk and returns its sha256. Shared by the
 * Ollama runtime installer and the PDF reading add-on so both enforce the same
 * contract:
 *  - a response-start timeout and a between-chunks inactivity timeout, both of
 *    which abort the request;
 *  - a byte cap equal to the pinned size (checked against Content-Length and
 *    again per chunk), and an exact-size check at the end;
 *  - `wx` on the destination, so an existing file is never overwritten;
 *  - the digest is computed while streaming; the caller compares it to the pin
 *    and deletes the file on mismatch.
 * Errors carry a stable `code`: response_timeout, download_failed,
 * byte_overflow, cancelled, download_inactivity, size_mismatch.
 */

const fs = require('fs');
const crypto = require('crypto');

function pinnedDownloadError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

async function downloadPinnedFile({
  url,
  destPath,
  expectedBytes,
  fetchImpl,
  fsImpl = fs,
  cryptoImpl = crypto,
  abortController = null,
  responseStartTimeoutMs,
  inactivityMs,
  fetchOptions = {},
  isCancelled = () => false,
  onProgress = null,
}) {
  const stopped = () => pinnedDownloadError(
    isCancelled() ? 'cancelled' : 'download_inactivity',
    'The download stopped.'
  );
  let responseTimer = null;
  const responseTimeout = new Promise((_, reject) => {
    responseTimer = setTimeout(() => {
      abortController?.abort();
      reject(pinnedDownloadError('response_timeout', 'The download server did not respond in time.'));
    }, responseStartTimeoutMs);
    responseTimer.unref?.();
  });
  let response;
  try {
    response = await Promise.race([
      fetchImpl(url, {
        ...fetchOptions,
        method: 'GET',
        ...(abortController ? { signal: abortController.signal } : {}),
      }),
      responseTimeout,
    ]);
  } finally {
    if (responseTimer) clearTimeout(responseTimer);
  }
  if (!response || response.ok !== true) {
    throw pinnedDownloadError('download_failed', `Download failed (HTTP ${response?.status || 0}).`);
  }
  const headerTotal = Number(response.headers?.get?.('content-length') || 0);
  if (headerTotal > expectedBytes) {
    abortController?.abort();
    throw pinnedDownloadError('byte_overflow', 'The download is larger than the pinned size.');
  }
  const hash = cryptoImpl.createHash('sha256');
  const out = fsImpl.createWriteStream(destPath, { flags: 'wx' });
  let downloaded = 0;
  let outputError = null;
  let inactivityTimer = null;
  let inactivityTriggered = false;
  const resetInactivity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      inactivityTriggered = true;
      abortController?.abort();
    }, inactivityMs);
    inactivityTimer.unref?.();
  };
  out?.on?.('error', (error) => { outputError = error; });
  const consumeChunk = async (chunk) => {
    if (outputError) throw outputError;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    downloaded += buffer.length;
    if (downloaded > expectedBytes) {
      abortController?.abort();
      throw pinnedDownloadError('byte_overflow', 'The download grew past the pinned size.');
    }
    resetInactivity();
    hash.update(buffer);
    if (out.write(buffer) === false) {
      await new Promise((resolve, reject) => {
        out.once?.('drain', resolve);
        out.once?.('error', reject);
      });
    }
    onProgress?.({ downloadedBytes: downloaded, totalBytes: expectedBytes });
  };
  let completed = false;
  try {
    resetInactivity();
    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response.body) {
        if (abortController?.signal?.aborted) throw stopped();
        await consumeChunk(chunk);
      }
    } else if (typeof response.arrayBuffer === 'function') {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (abortController?.signal?.aborted) throw stopped();
      await consumeChunk(buffer);
    } else {
      throw pinnedDownloadError('download_failed', 'Download response had no readable body.');
    }
    if (abortController?.signal?.aborted) throw stopped();
    if (downloaded !== expectedBytes) {
      throw pinnedDownloadError('size_mismatch', 'The download size did not match the pinned size.');
    }
    if (outputError) throw outputError;
    await new Promise((resolve, reject) => {
      out.on?.('error', reject);
      out.end(resolve);
    });
    completed = true;
  } catch (error) {
    if (inactivityTriggered && !isCancelled()) {
      throw pinnedDownloadError('download_inactivity', 'The download stalled.');
    }
    throw error;
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (!completed) out.destroy?.();
  }
  return hash.digest('hex');
}

module.exports = { downloadPinnedFile, pinnedDownloadError };
