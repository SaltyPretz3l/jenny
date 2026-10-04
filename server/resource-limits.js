'use strict';

const fs = require('node:fs');

function requireBoundedInteger(value, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw Object.assign(new RangeError('invalid_host_limit'), { code: 'CMP-HOST-0001' });
  }
  return value;
}

const DISK_RESERVE_BYTES = 256 * 1024 * 1024;
// Room for the session index rewrite that a deletion needs. The receipt store
// is rewritten whole as well, so its admission adds `rewriteHeadroom` on top.
const DELETE_RESERVE_BYTES = 8 * 1024 * 1024;

// Twice the current size of a file an admitted command rewrites atomically.
function rewriteHeadroom(filePath, { stat = fs.statSync } = {}) {
  try { return 2 * Number(stat(filePath).size); } catch { return 0; }
}

function createDiskAdmission(paths, {
  statfs = fs.statfsSync, logger = () => {}, reserveBytes = DISK_RESERVE_BYTES, extraBytes = () => 0,
} = {}) {
  requireBoundedInteger(reserveBytes, Number.MAX_SAFE_INTEGER);
  const roots = [...new Set(paths.filter(Boolean))];
  return () => {
    try {
      const needed = reserveBytes + Math.max(0, Number(extraBytes()) || 0);
      const enough = roots.every((root) => {
        const stats = statfs(root);
        return Number(stats.bavail) * Number(stats.bsize) >= needed;
      });
      if (!enough) logger('WARN', 'host.disk_pressure');
      return enough;
    } catch { logger('WARN', 'host.disk_status_unavailable'); return false; }
  };
}

module.exports = {
  requireBoundedInteger, createDiskAdmission, rewriteHeadroom, DISK_RESERVE_BYTES, DELETE_RESERVE_BYTES,
};
