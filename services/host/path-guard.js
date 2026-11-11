'use strict';

// Reparse-point guard for the hosted stores. `durable-json.js` opens files
// without O_NOFOLLOW on Windows, so a junction or link would be followed
// silently. These checks read metadata only: they never recurse, repair or
// follow a link to decide that something is safe. A caller treats a path as
// untrusted until one of them returns.

const fs = require('node:fs');
const path = require('node:path');
const { HOST_ERROR_CODES } = require('../backend/error-codes');

function unsafePath(message) {
  return Object.assign(new Error(message), { code: HOST_ERROR_CODES.CONFLICT, reason: 'unsafe_path' });
}

function sameDirectory(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function lstatOrRefuse(target, message) {
  try { return fs.lstatSync(target); } catch (_error) { throw unsafePath(message); }
}

// The final component must be a real directory and the kernel's spelling of the
// whole path must be the resolved input, so a junction or link anywhere in it
// (not only the last component) is refused.
function assertSafeDirectory(directory) {
  if (typeof directory !== 'string' || directory === '') throw unsafePath('Directory is not a plain directory.');
  const resolved = path.resolve(directory);
  const stat = lstatOrRefuse(resolved, 'Directory is not a plain directory.');
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafePath('Directory is not a plain directory.');
  let real;
  try { real = fs.realpathSync.native(resolved); } catch (_error) { throw unsafePath('Directory could not be verified.'); }
  if (!sameDirectory(real, resolved)) throw unsafePath('Directory is reached through a link or junction.');
}

// An existing file must be a regular, unlinked, single-name file; a missing one
// is allowed (the store creates it). Its parent must pass the directory check.
function assertSafeFile(filePath) {
  if (typeof filePath !== 'string' || filePath === '') throw unsafePath('File is not a plain file.');
  const resolved = path.resolve(filePath);
  assertSafeDirectory(path.dirname(resolved));
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw unsafePath('File could not be verified.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unsafePath('File is not a plain file.');
}

module.exports = { assertSafeDirectory, assertSafeFile };
