'use strict';

const fs = require('node:fs');

function requireBoundedInteger(value, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw Object.assign(new RangeError('invalid_host_limit'), { code: 'CMP-HOST-0001' });
  }
  return value;
}

const DISK_RESERVE_BYTES = 256 * 1024 * 1024;

function createDiskAdmission(paths, { statfs = fs.statfsSync, logger = () => {} } = {}) {
  const roots = [...new Set(paths.filter(Boolean))];
  return () => {
    try {
      const enough = roots.every((root) => {
        const stats = statfs(root);
        return Number(stats.bavail) * Number(stats.bsize) >= DISK_RESERVE_BYTES;
      });
      if (!enough) logger('WARN', 'host.disk_pressure');
      return enough;
    } catch { logger('WARN', 'host.disk_status_unavailable'); return false; }
  };
}

module.exports = { requireBoundedInteger, createDiskAdmission, DISK_RESERVE_BYTES };
