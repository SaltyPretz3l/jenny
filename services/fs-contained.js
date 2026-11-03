'use strict';

// Containment and removal primitives shared by the "Your data" clear (row 95)
// and the chat-delete purges. The renderer never names a path: every target is
// a base the service owns plus fixed segments it derived, resolved here on real
// paths. A link anywhere in the chain, or a real path that leaves its parent,
// refuses the target. Nothing follows a link: lstat decides,
// removeTree/removeFile never enter one.

const fs = require('node:fs');
const path = require('node:path');
const { removeFile, removeTree } = require('./fs-remove-no-follow');

class ContainedTargetError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function safeSegment(segment) {
  return typeof segment === 'string' && segment !== '' && segment !== '.' && segment !== '..'
    && !/[\\/\0]/.test(segment) && !segment.endsWith('.') && !segment.endsWith(' ');
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw new ContainedTargetError(String(error?.code || 'inspection_failed').slice(0, 40));
  }
}

function singleSegmentBelow(realParent, realChild) {
  const relative = path.relative(realParent, realChild);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(path.sep);
}

// Walks `segments` below `baseRoot`, requiring each step to be a plain entry
// (directories for every step but the last) whose real path is a direct child
// of the previous real path. Returns null when the final target is absent,
// else { path, stat }. Throws ContainedTargetError with a bounded reason.
function resolveContained(baseRoot, segments) {
  const base = path.resolve(String(baseRoot || ''));
  if (!base || base === path.parse(base).root) throw new ContainedTargetError('unsafe_root');
  const baseStat = lstatOrNull(base);
  if (!baseStat) return null;
  if (!baseStat.isDirectory()) throw new ContainedTargetError('unsafe_root');
  // The base itself may be reached through a relocated-profile link; only what is below it is checked.
  let realCurrent = fs.realpathSync.native(base);
  let current = base;
  let stat = baseStat;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!safeSegment(segment)) throw new ContainedTargetError('unsafe_target');
    const next = path.join(current, segment);
    const nextStat = lstatOrNull(next);
    if (!nextStat) return null;
    if (nextStat.isSymbolicLink()) throw new ContainedTargetError('reparse_or_symlink');
    if (index < segments.length - 1 && !nextStat.isDirectory()) throw new ContainedTargetError('unsafe_target');
    let realNext;
    try {
      realNext = fs.realpathSync.native(next);
    } catch (error) {
      throw new ContainedTargetError(String(error?.code || 'inspection_failed').slice(0, 40));
    }
    if (!singleSegmentBelow(realCurrent, realNext)) throw new ContainedTargetError('escapes_root');
    current = next;
    realCurrent = realNext;
    stat = nextStat;
  }
  return { path: current, stat };
}

function boundedReason(error, fallback) {
  return String(error?.reason || error?.code || fallback).slice(0, 40);
}

// Removes one contained entry. Resolves { removed: boolean }; a missing entry is
// already gone. Throws ContainedTargetError / fs errors; callers map to a reason.
async function removeContained(baseRoot, segments) {
  const resolved = resolveContained(baseRoot, segments);
  if (!resolved) return { removed: false };
  if (resolved.stat.isDirectory()) await removeTree(resolved.path);
  else await removeFile(resolved.path);
  return { removed: true };
}

// Empties a log without deleting it (a writer holds it open). The opened handle
// must be the file lstat saw, so a swap for a link between the two is refused.
async function truncateContained(baseRoot, segments) {
  const resolved = resolveContained(baseRoot, segments);
  if (!resolved) return { removed: false };
  if (!resolved.stat.isFile()) throw new ContainedTargetError('not_a_file');
  const handle = await fs.promises.open(resolved.path, 'r+');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== resolved.stat.ino || opened.dev !== resolved.stat.dev) {
      throw new ContainedTargetError('changed_during_clear');
    }
    await handle.truncate(0);
  } finally {
    await handle.close();
  }
  return { removed: true };
}

module.exports = {
  ContainedTargetError,
  boundedReason,
  removeContained,
  resolveContained,
  truncateContained,
};
