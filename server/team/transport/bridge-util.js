'use strict';

// The pieces the host supervisor, the member supervisor and the member's HTTP client share.

/** True for a TCP port number, 1..65535. */
const isPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;

/** `defaults` overlaid with `overrides`; every limit must be a positive integer. */
function resolveLimits(defaults, overrides) {
  const limits = { ...defaults, ...(overrides || {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`limits.${name} must be a positive integer`);
  }
  return limits;
}

module.exports = { isPort, resolveLimits };
