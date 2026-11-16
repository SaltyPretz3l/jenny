'use strict';

// Holds "Open with Jenny" requests (row 137) from the moment main.js starts
// until the outside-file service exists: the cold launch's own argv, macOS
// 'open-file' events (they fire before 'ready' and must be claimed with
// preventDefault), and files a second launch hands over. attach() drains the
// buffer into the service; afterwards requests go straight through.
//
// Light on purpose: main.js creates it right after the compile cache, before
// the module graph loads.

const { extractOutsideFilePaths, readSecondLaunchPaths } = require('./outside-file-args');

const MAX_BUFFERED_REQUESTS = 32;

function createOutsideFileLaunchBuffer({ app, processRef = process, enabled = true } = {}) {
  const pending = [];
  let target = null;
  const platform = processRef.platform || process.platform;
  const isPackaged = Boolean(app && app.isPackaged);

  function deliver(paths, source) {
    const list = (Array.isArray(paths) ? paths : []).filter((entry) => typeof entry === 'string' && entry);
    if (!list.length) return;
    if (target) {
      Promise.resolve(target.intake(list, source)).catch(() => {});
      return;
    }
    if (pending.length >= MAX_BUFFERED_REQUESTS) pending.shift();
    pending.push({ paths: list, source });
  }

  if (enabled) {
    deliver(extractOutsideFilePaths(processRef.argv, {
      isPackaged,
      platform,
      cwd: typeof processRef.cwd === 'function' ? processRef.cwd() : undefined,
    }), 'launch');
    if (platform === 'darwin' && app && typeof app.on === 'function') {
      app.on('open-file', (event, filePath) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        deliver([filePath], 'launch');
      });
    }
  }

  // Wired to the single-instance 'second-instance' event (after the caller
  // has focused the window).
  function onSecondInstance(_event, argv, cwd, additionalData) {
    if (!enabled) return;
    deliver(readSecondLaunchPaths({ argv, cwd, additionalData, isPackaged, platform }), 'launch');
  }

  function attach(service) {
    if (!service || typeof service.intake !== 'function') return;
    target = service;
    const drained = pending.splice(0, pending.length);
    for (const request of drained) Promise.resolve(target.intake(request.paths, request.source)).catch(() => {});
  }

  return {
    attach,
    onSecondInstance,
    pendingCount: () => pending.length,
  };
}

module.exports = { MAX_BUFFERED_REQUESTS, createOutsideFileLaunchBuffer };
