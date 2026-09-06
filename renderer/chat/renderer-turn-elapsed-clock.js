/* renderer/chat/renderer-turn-elapsed-clock.js - 1s ticker for live transcript durations. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnElapsedClock = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INTERVAL_MS = 1000;
  const ELAPSED_SELECTOR = '[data-turn-elapsed][data-elapsed-started-at]';

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatElapsedLabel(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) {
      return '';
    }
    const total = Math.floor(value / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours > 0
      ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
      : `${minutes}:${pad2(seconds)}`;
  }

  function createTurnElapsedClock(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const getRoot = typeof opts.getRoot === 'function' ? opts.getRoot : function noRoot() { return null; };
    const getNow = typeof opts.getNow === 'function' ? opts.getNow : function defaultNow() { return Date.now(); };
    const timers = opts.timers && typeof opts.timers === 'object' ? opts.timers : null;
    const setIntervalFn = timers && typeof timers.setInterval === 'function'
      ? timers.setInterval
      : (typeof setInterval === 'function' ? setInterval : null);
    const clearIntervalFn = timers && typeof timers.clearInterval === 'function'
      ? timers.clearInterval
      : (typeof clearInterval === 'function' ? clearInterval : null);
    let handle = null;

    function findNodes() {
      try {
        const rootNode = getRoot();
        if (!rootNode || typeof rootNode.querySelectorAll !== 'function') {
          return [];
        }
        return Array.from(rootNode.querySelectorAll(ELAPSED_SELECTOR) || []);
      } catch (_error) {
        return [];
      }
    }

    function writeNode(node, now) {
      if (!node || typeof node.getAttribute !== 'function') {
        return;
      }
      const rawAnchor = node.getAttribute('data-elapsed-started-at');
      if (rawAnchor == null || String(rawAnchor).trim() === '') {
        return;
      }
      const anchor = Number(rawAnchor);
      if (!Number.isFinite(anchor)) {
        return;
      }
      const label = formatElapsedLabel(now - anchor);
      if (node.textContent !== label) {
        node.textContent = label;
      }
    }

    function stop() {
      if (handle === null) {
        return;
      }
      if (clearIntervalFn && handle !== true) {
        clearIntervalFn(handle);
      }
      handle = null;
    }

    function tick() {
      const nodes = findNodes();
      if (nodes.length === 0) {
        stop();
        return;
      }
      const now = Number(getNow());
      for (const node of nodes) {
        writeNode(node, now);
      }
    }

    function start() {
      if (handle !== null || !setIntervalFn) {
        return;
      }
      handle = setIntervalFn(tick, INTERVAL_MS);
      if (handle === undefined) {
        handle = true;
      }
    }

    function sync() {
      const nodes = findNodes();
      if (nodes.length === 0) {
        stop();
        return;
      }
      const now = Number(getNow());
      for (const node of nodes) {
        writeNode(node, now);
      }
      start();
    }
    return {
      sync,
      stop,
      isRunning: function isRunning() { return handle !== null; },
    };
  }

  return {
    createTurnElapsedClock,
    formatElapsedLabel,
  };
});
