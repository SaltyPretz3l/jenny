'use strict';

// Removal that never traverses a link. Node's fs.rm / fs.promises.rm / fs.rmSync (recursive or not)
// share an internal rimraf whose Windows EPERM fallback stat()s THROUGH a junction and then empties the
// junction's target, so one transient lock on a planted junction deletes files outside the tree being
// removed. Here lstat decides at every level: a link (symlink or junction, file or directory) is unlinked
// and never entered; only real directories are listed. The target's parent chain is resolved normally,
// so a relocated profile reached through a junction still works. libuv's unlink and rmdir clear a
// read-only attribute on the opened entry themselves, so there is no path-based chmod (chmod follows links).
//
// removeTree matches rm(target, { recursive: true, force: true }): a missing target is not an error.
// removeFile matches non-recursive rm(target, { force: true }): a real directory fails ERR_FS_EISDIR, and
// only unlink is ever attempted, so a directory that replaces the file after the lstat is never emptied.
//
// Residual: a local process racing to swap a real directory for a junction between the lstat that
// precedes each listing and the readdir is outside this guard, as is a reparse point that libuv cannot
// read as a link (a volume mount point or an unsupported tag), which lstat reports as a plain directory.
//
// Synchronous callers run on the Electron main thread, so sync retries do not sleep unless the caller
// passes retryDelayMs (a CLI may); async retries back off 100, 200, 300 ms by default.

const fs = require('node:fs');
const path = require('node:path');

const RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE'];
const NOT_EMPTY_CODES = ['ENOTEMPTY', 'EEXIST'];
const DEFAULT_RETRIES = 3;

function promisesOf(fsImpl) {
  return fsImpl.promises || fsImpl;
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ignoreMissing(error) {
  if (error.code !== 'ENOENT') throw error;
}

function isRealDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function settings(options, defaultDelayMs) {
  return {
    retries: Number.isSafeInteger(options.retries) && options.retries >= 0 ? options.retries : DEFAULT_RETRIES,
    retryDelayMs: Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0
      ? options.retryDelayMs : defaultDelayMs,
  };
}

async function unlinkWithRetry(fsp, target, { retries, retryDelayMs }) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await fsp.unlink(target); }
    catch (error) {
      if (error.code === 'ENOENT') return undefined;
      if (attempt >= retries || !RETRY_CODES.includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }
}

function unlinkWithRetrySync(fsImpl, target, { retries, retryDelayMs }) {
  for (let attempt = 0; ; attempt += 1) {
    try { return fsImpl.unlinkSync(target); }
    catch (error) {
      if (error.code === 'ENOENT') return undefined;
      if (attempt >= retries || !RETRY_CODES.includes(error.code)) throw error;
      sleepSync(retryDelayMs * (attempt + 1));
    }
  }
}

async function removeTree(target, options = {}) {
  const fsp = promisesOf(options.fsImpl || fs);
  const tuning = settings(options, 100);
  const remove = async (entry) => {
    let stat;
    try { stat = await fsp.lstat(entry); } catch (error) { return ignoreMissing(error); }
    if (!isRealDirectory(stat)) return unlinkWithRetry(fsp, entry, tuning);
    // rmdir first, as Node does, so an empty directory that cannot be listed is still removable. Only
    // retries after the directory was emptied count, since a writer that is still closing can add an
    // entry after a pass. Each listing re-checks the entry, so a directory swapped for a link during a
    // backoff is unlinked instead of entered.
    for (let attempt = 0, emptied = false; ;) {
      try { return await fsp.rmdir(entry); }
      catch (error) {
        if (error.code === 'ENOENT') return undefined;
        if (!NOT_EMPTY_CODES.includes(error.code) && !RETRY_CODES.includes(error.code)) throw error;
        if (emptied) {
          if (attempt >= tuning.retries) throw error;
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, tuning.retryDelayMs * attempt));
        }
      }
      try { stat = await fsp.lstat(entry); } catch (error) { return ignoreMissing(error); }
      if (!isRealDirectory(stat)) return unlinkWithRetry(fsp, entry, tuning);
      let names;
      try { names = await fsp.readdir(entry); } catch (error) { return ignoreMissing(error); }
      for (const name of names) await remove(path.join(entry, name));
      emptied = true;
    }
  };
  await remove(path.resolve(String(target)));
}

function removeTreeSync(target, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const tuning = settings(options, 0);
  const remove = (entry) => {
    let stat;
    try { stat = fsImpl.lstatSync(entry); } catch (error) { return ignoreMissing(error); }
    if (!isRealDirectory(stat)) return unlinkWithRetrySync(fsImpl, entry, tuning);
    for (let attempt = 0, emptied = false; ;) {
      try { return fsImpl.rmdirSync(entry); }
      catch (error) {
        if (error.code === 'ENOENT') return undefined;
        if (!NOT_EMPTY_CODES.includes(error.code) && !RETRY_CODES.includes(error.code)) throw error;
        if (emptied) {
          if (attempt >= tuning.retries) throw error;
          attempt += 1;
          sleepSync(tuning.retryDelayMs * attempt);
        }
      }
      try { stat = fsImpl.lstatSync(entry); } catch (error) { return ignoreMissing(error); }
      if (!isRealDirectory(stat)) return unlinkWithRetrySync(fsImpl, entry, tuning);
      let names;
      try { names = fsImpl.readdirSync(entry); } catch (error) { return ignoreMissing(error); }
      for (const name of names) remove(path.join(entry, name));
      emptied = true;
    }
  };
  remove(path.resolve(String(target)));
}

// The message carries no path (some callers never log absolute paths); error.path has it.
function directoryError(target) {
  return Object.assign(new Error('Path is a directory: rm returned EISDIR (is a directory)'), {
    code: 'ERR_FS_EISDIR', errno: 21, syscall: 'rm', path: target,
  });
}

async function removeFile(target, options = {}) {
  const fsp = promisesOf(options.fsImpl || fs);
  const resolved = path.resolve(String(target));
  let stat;
  try { stat = await fsp.lstat(resolved); } catch (error) { return ignoreMissing(error); }
  if (isRealDirectory(stat)) throw directoryError(target);
  return unlinkWithRetry(fsp, resolved, settings(options, 100));
}

function removeFileSync(target, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const resolved = path.resolve(String(target));
  let stat;
  try { stat = fsImpl.lstatSync(resolved); } catch (error) { return ignoreMissing(error); }
  if (isRealDirectory(stat)) throw directoryError(target);
  return unlinkWithRetrySync(fsImpl, resolved, settings(options, 0));
}

module.exports = { removeFile, removeFileSync, removeTree, removeTreeSync };
