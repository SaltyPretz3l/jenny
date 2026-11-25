'use strict';

// The live run view's services (row 197). Re-exports only; nothing here starts anything.

const { BUILD_TAIL_CHARS, BUILD_TIMEOUT_MS } = require('./build-step');
const { createRunCommandStore, normalizeRunCommand } = require('./run-command-store');
const { createRunGpuMemoryStore } = require('./run-gpu-memory');
const { createRestartAfterChanges } = require('./restart-after-changes');
const { createRunService } = require('./run-service');
const { RUN_VIEW_CHANNELS, createRunViewIpcHandlers } = require('./run-view-ipc');
const {
  CLOSE_TIMEOUT_MS, NO_WINDOW_TIMEOUT_MS, STATES, initialRunState, transition,
} = require('./run-state');

module.exports = {
  BUILD_TAIL_CHARS,
  BUILD_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
  NO_WINDOW_TIMEOUT_MS,
  RUN_VIEW_CHANNELS,
  STATES,
  createRestartAfterChanges,
  createRunCommandStore,
  createRunGpuMemoryStore,
  createRunService,
  createRunViewIpcHandlers,
  initialRunState,
  normalizeRunCommand,
  transition,
};
