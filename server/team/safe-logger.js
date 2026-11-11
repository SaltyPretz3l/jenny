'use strict';

/**
 * Wraps a caller's log function. Logging never decides anything: a missing
 * logger is a no-op and a throwing one is ignored. Arguments pass through as
 * given, so each owner keeps its own (level, event, fields) or (event, fields) shape.
 */
function safeLogger(logger) {
  if (typeof logger !== 'function') return () => {};
  return (...args) => {
    try {
      logger(...args);
    } catch (_error) {
      // Logging is non-authoritative.
    }
  };
}

module.exports = { safeLogger };
