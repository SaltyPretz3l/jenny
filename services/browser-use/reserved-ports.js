'use strict';

/**
 * The local ports a model-driven page may never reach: Jenny's own engines and
 * the debug port. Read per call because engine ports move at runtime.
 */

const FIXED_PORTS = Object.freeze([11434, 8033, 8034, 8000, 8080, 9222]);
const DEFAULT_PORTS = Object.freeze({ 'http:': 80, 'https:': 443 });
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function validPort(value) {
  const port = typeof value === 'string' && /^[0-9]{1,5}$/.test(value) ? Number(value) : value;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
}

function portOfBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw) return 0;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    return 0;
  }
  if (parsed.port) return validPort(parsed.port);
  // An engine on a bare loopback address uses the scheme's default port. A
  // remote URL's default port says nothing about this machine.
  return LOOPBACK_NAMES.has(parsed.hostname) ? DEFAULT_PORTS[parsed.protocol] || 0 : 0;
}

function* iterate(value) {
  if (typeof value === 'string') {
    yield value;
    return;
  }
  if (value && typeof value[Symbol.iterator] === 'function') yield* value;
}

function createReservedPortReader({ getBaseUrls, getDebugPort } = {}) {
  return function readReservedPorts() {
    const ports = new Set(FIXED_PORTS);
    try {
      for (const url of iterate(getBaseUrls?.())) {
        const port = portOfBaseUrl(url);
        if (port) ports.add(port);
      }
    } catch (_error) { /* a bad config read must not widen what the browser may reach */ }
    try {
      const debugPort = validPort(getDebugPort?.());
      if (debugPort) ports.add(debugPort);
    } catch (_error) { /* same */ }
    return ports;
  };
}

module.exports = { FIXED_PORTS, createReservedPortReader };
