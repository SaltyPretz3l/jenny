'use strict';

// One pinned file from Hugging Face to a caller-named partial path: resumable with
// HTTP Range, size-capped, sha256-checked over the whole file. It decides nothing
// about where files live and never places the finished file under a final name.
// A failed or cancelled call keeps the partial so the next call resumes it; a digest
// mismatch deletes it. Expected failures resolve { ok: false, reason }; the module
// does not log (the caller logs reason codes, never URLs or paths).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveHuggingFaceAssetUrl } = require('./ninfer-artifact-download');
const { removeFile } = require('./fs-remove-no-follow');

const REASONS = Object.freeze([
  'url_rejected', 'invalid_pin', 'partial_rejected', 'insufficient_space', 'redirect_host_rejected',
  'redirect_scheme_rejected', 'hf_gated', 'not_found', 'content_range_mismatch', 'size_mismatch',
  'byte_overflow', 'response_timeout', 'download_inactivity', 'sha256_mismatch', 'cancelled', 'download_failed',
]);
const REASON_SHAPE = /^[a-z][a-z0-9_]{0,79}$/;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ABORTED = Symbol('aborted');

class Fail extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function statusReason(status) {
  if (status === 401 || status === 403) return 'hf_gated';
  if (status === 404) return 'not_found';
  return 'download_failed';
}

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_error) { throw new Fail('url_rejected'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'huggingface.co' || parsed.port
    || parsed.username || parsed.password || !parsed.pathname.includes('/resolve/')) {
    throw new Fail('url_rejected');
  }
  return parsed.href;
}

// The partial's size, or 0 when absent. Anything but a regular file is refused (lstat sees links and junctions).
async function partialSizeOf(fsImpl, partialPath) {
  try {
    const stat = await fsImpl.promises.lstat(partialPath);
    if (!stat.isFile()) throw new Fail('partial_rejected');
    return stat.size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function freeBytes(statfsImpl, dir) {
  try {
    const stats = await statfsImpl(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (_error) {
    return null; // an unreadable volume does not block the download
  }
}

async function discard(response) {
  try { await response?.body?.cancel?.(); } catch (_error) { /* the reply is discarded */ }
}

// Exported for callers that check a file already on disk; `controller` is optional.
async function hashFile(fsImpl, file, controller = null) {
  const hash = crypto.createHash('sha256');
  const stream = fsImpl.createReadStream(file, { highWaterMark: 1024 * 1024 });
  try {
    for await (const chunk of stream) {
      if (controller?.signal.aborted) throw new Fail('cancelled');
      hash.update(chunk);
    }
  } finally {
    stream.destroy();
  }
  return hash.digest('hex');
}

// Validates the reply and returns the offset its body starts at (0 when the server ignored the Range).
function responseStart(response, partialSize, bytes) {
  const status = response?.status;
  if (status === 401 || status === 403 || status === 404) throw new Fail(statusReason(status));
  if (partialSize === 0 || status === 200) {
    if (status !== 200) throw new Fail('download_failed');
    return 0;
  }
  if (status !== 206) throw new Fail('download_failed');
  const match = CONTENT_RANGE.exec(String(response.headers?.get?.('content-range') || '').trim());
  if (!match || Number(match[1]) !== partialSize || Number(match[2]) !== bytes - 1 || Number(match[3]) !== bytes) {
    throw new Fail('content_range_mismatch');
  }
  return partialSize;
}

function checkContentLength(response, remaining) {
  const raw = response.headers?.get?.('content-length');
  if (raw === null || raw === undefined || raw === '') return;
  if (!/^\d+$/.test(String(raw).trim()) || Number(raw) !== remaining) throw new Fail('size_mismatch');
}

// Opens the partial for writing at `start` without following a symlink where the platform allows;
// on Windows the lstat just before the open is the guard.
async function openPartial(fsImpl, partialPath, partialSize, start) {
  try {
    const stat = await fsImpl.promises.lstat(partialPath);
    if (!stat.isFile()) throw new Fail('partial_rejected');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (partialSize > 0) throw new Fail('partial_rejected');
  }
  // No O_APPEND: on Windows it makes ftruncate fail, so writes carry explicit positions instead.
  const { O_WRONLY, O_CREAT, O_NOFOLLOW = 0 } = fs.constants;
  const handle = await fsImpl.promises.open(partialPath, O_WRONLY | O_CREAT | O_NOFOLLOW, 0o600);
  try {
    if (start === 0) await handle.truncate(0);
    else if ((await handle.stat()).size !== start) throw new Fail('partial_rejected');
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

// One chunk read, or ABORTED once the signal fires; the listener goes with the read
// (one long-lived race promise would collect a reaction per chunk).
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

async function downloadPinnedHfFile({
  url, partialPath, bytes, sha256, fetchImpl = globalThis.fetch, fsImpl = fs, statfsImpl = fs.promises.statfs,
  signal, onProgress, beforeOpen, progressIntervalMs = 250, responseStartTimeoutMs = 30_000, inactivityMs = 60_000,
  headroomBytes = 64 * 1024 * 1024, now = Date.now,
} = {}) {
  const controller = new AbortController();
  const state = { reason: null };
  // The first cause wins: a timeout or cancel that aborts the request names the result.
  const abortWith = (reason) => {
    if (!state.reason) state.reason = reason;
    controller.abort();
  };
  const onUserAbort = () => abortWith('cancelled');
  signal?.addEventListener?.('abort', onUserAbort, { once: true });
  try {
    const href = validateUrl(url);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      throw new Fail('invalid_pin');
    }
    if (typeof partialPath !== 'string' || !path.isAbsolute(partialPath)) throw new Fail('partial_rejected');
    if (signal?.aborted) throw new Fail('cancelled');
    return await runDownload({ href, partialPath, bytes, sha256, fetchImpl, fsImpl, statfsImpl, onProgress, beforeOpen,
      progressIntervalMs, responseStartTimeoutMs, inactivityMs, headroomBytes, now, controller, state, abortWith });
  } catch (error) {
    let reason = state.reason || (error instanceof Fail ? error.reason : null)
      || (signal?.aborted ? 'cancelled' : 'download_failed');
    if (!REASON_SHAPE.test(reason)) reason = 'download_failed';
    return { ok: false, reason };
  } finally {
    signal?.removeEventListener?.('abort', onUserAbort);
  }
}

async function runDownload(ctx) {
  const { href, partialPath, bytes, sha256, fsImpl, controller, state, abortWith } = ctx;
  let partialSize = await partialSizeOf(fsImpl, partialPath);
  if (partialSize > bytes) {
    await fsImpl.promises.truncate(partialPath, 0);
    partialSize = 0;
  }
  const progress = makeProgress(ctx);
  let resumed = partialSize > 0;
  if (partialSize < bytes) {
    const free = await freeBytes(ctx.statfsImpl, path.dirname(partialPath));
    if (free !== null && Number.isFinite(free) && free < bytes - partialSize + ctx.headroomBytes) {
      throw new Fail('insufficient_space');
    }
    resumed = (await fetchInto(ctx, href, partialSize, progress)) > 0;
  }
  progress.finish(bytes);
  const stat = await fsImpl.promises.lstat(partialPath);
  if (!stat.isFile() || stat.size !== bytes) throw new Fail('size_mismatch');
  const digest = await hashFile(fsImpl, partialPath, controller);
  if (state.reason) throw new Fail(state.reason);
  if (digest !== sha256) {
    await removeFile(partialPath, { fsImpl }).catch(() => {}); // still a checksum failure if the delete fails
    throw new Fail('sha256_mismatch');
  }
  return { ok: true, partialPath, resumed };
}

function makeProgress({ onProgress, progressIntervalMs, now, bytes }) {
  let lastEmit = -Infinity;
  let lastBytes = -1;
  const emit = (receivedBytes) => {
    lastBytes = receivedBytes;
    try { onProgress?.({ receivedBytes, totalBytes: bytes }); } catch (_error) { /* a broken listener never fails the download */ }
  };
  return {
    update(receivedBytes) {
      const at = now();
      if (at - lastEmit < progressIntervalMs) return;
      lastEmit = at;
      emit(receivedBytes);
    },
    finish(receivedBytes) { if (lastBytes !== receivedBytes) emit(receivedBytes); },
  };
}

// Runs a promise against the response-start timeout; the timeout aborts the request.
// Timers stay referenced (always cleared in finally) so a hung request cannot let the process exit unnoticed.
function withStartTimeout({ responseStartTimeoutMs, abortWith }, promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      abortWith('response_timeout');
      reject(new Fail('response_timeout'));
    }, responseStartTimeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function resolveAssetUrl(ctx, href) {
  let firstHopStatus = null;
  const fetchImpl = async (target, options) => {
    const response = await ctx.fetchImpl(target, options);
    if (options?.redirect === 'manual') firstHopStatus = response?.status;
    return response;
  };
  const resolved = await withStartTimeout(ctx, resolveHuggingFaceAssetUrl(href,
    { fetchImpl, abortController: ctx.controller }));
  if (resolved.ok) return resolved.url;
  if (resolved.reason === 'download_failed') throw new Fail(statusReason(firstHopStatus));
  throw new Fail(resolved.reason);
}

// Requests the asset and appends its body to the partial; returns the offset the body started at.
async function fetchInto(ctx, href, partialSize, progress) {
  const { partialPath, bytes, fsImpl, controller, state, abortWith, beforeOpen } = ctx;
  const assetUrl = await resolveAssetUrl(ctx, href);
  const headers = partialSize > 0 ? { Range: `bytes=${partialSize}-` } : {};
  const response = await withStartTimeout(ctx, ctx.fetchImpl(assetUrl,
    { method: 'GET', redirect: 'error', headers, signal: controller.signal }));
  let start;
  try {
    start = responseStart(response, partialSize, bytes);
    checkContentLength(response, bytes - start);
    if (typeof response.body?.[Symbol.asyncIterator] !== 'function') throw new Fail('download_failed');
  } catch (error) {
    await discard(response);
    throw error;
  }
  if (typeof beforeOpen === 'function') {
    // The caller's last check of the folder, right before the partial opens; its reason code passes through.
    try {
      beforeOpen();
    } catch (error) {
      await discard(response);
      throw new Fail(REASON_SHAPE.test(String(error?.reason || '')) ? error.reason : 'partial_rejected');
    }
  }
  const handle = await openPartial(fsImpl, partialPath, partialSize, start);
  const iterator = response.body[Symbol.asyncIterator]();
  let inactivityTimer = null;
  const resetInactivity = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => abortWith('download_inactivity'), ctx.inactivityMs);
  };
  let written = start;
  try {
    resetInactivity();
    for (;;) {
      const next = iterator.next();
      next.catch(() => {}); // a read that loses the race to an abort must not surface later
      const step = await raceAbort(next, controller.signal);
      if (step === ABORTED) throw new Fail(state.reason || 'cancelled');
      if (step.done) break;
      const value = step.value;
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (written + buffer.length > bytes) {
        abortWith('byte_overflow');
        throw new Fail('byte_overflow');
      }
      resetInactivity();
      for (let offset = 0; offset < buffer.length;) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, written + offset);
        if (!bytesWritten) throw new Fail('download_failed');
        offset += bytesWritten;
      }
      written += buffer.length;
      progress.update(written);
    }
    if (written !== bytes) throw new Fail('size_mismatch');
    await handle.sync();
  } catch (error) {
    // Overflowing bytes mean the server is not serving the pin: drop what this request added.
    if (state.reason === 'byte_overflow') await handle.truncate(start).catch(() => {});
    throw error;
  } finally {
    clearTimeout(inactivityTimer);
    Promise.resolve(iterator.return?.()).catch(() => {});
    await handle.close();
  }
  return start;
}

module.exports = { downloadPinnedHfFile, hashFile, freeBytes, REASONS };
