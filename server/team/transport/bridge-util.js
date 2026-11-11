'use strict';

// The piece the host supervisor and the member supervisor share.

/** `defaults` overlaid with `overrides`; every limit must be a positive integer. */
function resolveLimits(defaults, overrides) {
  const limits = { ...defaults, ...(overrides || {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`limits.${name} must be a positive integer`);
  }
  return limits;
}

module.exports = { resolveLimits };
