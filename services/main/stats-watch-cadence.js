'use strict';

const { CLOUD_ENGINE_TYPES } = require('../model-size-class');

const STATS_WATCHED_INTERVAL_MS = 2000;
const STATS_IDLE_INTERVAL_MS = 15000;

// Row 194 C12 (owner decision 2026-11-23, replacing the 15 s idle read of 2026-09-29): the CPU/RAM
// tick keeps its slow idle rate, but the graphics card is read only while a readout watches
// (system.setStatsWatch, by source) or a local model is writing a reply. Becoming wanted reads once at
// once: the tick is re-emitted with { resume: true } so the listener forces that read.
function createStatsWatchCadence(monitor, {
  watchedMs = STATS_WATCHED_INTERVAL_MS,
  idleMs = STATS_IDLE_INTERVAL_MS,
} = {}) {
  const watchers = new Set();
  let generating = false;
  monitor.setIntervalMs(idleMs);
  const wanted = () => watchers.size > 0 || generating;
  function change(apply) {
    const wasWatched = watchers.size > 0;
    const wasWanted = wanted();
    apply();
    if ((watchers.size > 0) !== wasWatched) monitor.setIntervalMs(watchers.size > 0 ? watchedMs : idleMs);
    // A stopped or hidden monitor (no timer) reads nothing; its restart takes the next tick.
    if (wanted() && !wasWanted && monitor.timer) monitor.emit('stats', monitor.sample(), { resume: true });
  }
  return {
    setWatched(source, watched) {
      const key = String(source || '').trim();
      if (key) change(() => (watched ? watchers.add(key) : watchers.delete(key)));
      return watchers.size > 0;
    },
    setGenerating(value) {
      change(() => { generating = value === true; });
      return generating;
    },
    isWatched: () => watchers.size > 0,
    isWanted: wanted,
    sources: () => [...watchers],
  };
}

// Returns a cheap sync() that tells the cadence whether a local model is writing (an active chat
// stream on a non-cloud engine). The backend is built after the composition, so the first call that
// sees it also listens to its chat stream; later events and every tick re-check.
function createLocalGenerationSync({ getBackendService, cadence }) {
  let source = null;
  function sync() {
    const backend = getBackendService();
    if (backend && backend !== source && typeof backend.on === 'function') {
      source = backend;
      backend.on('chat-stream', sync);
    }
    // A stream knows its own engine once its model is resolved (a Default chat runs locally under a cloud engine).
    const current = String(backend?.currentEngineType || '').trim().toLowerCase();
    const streams = backend?.activeStreams?.values ? [...backend.activeStreams.values()] : [];
    cadence.setGenerating(streams.some((stream) => !CLOUD_ENGINE_TYPES.has(String(stream?.engineType || current).toLowerCase())));
  }
  return sync;
}

module.exports = {
  STATS_IDLE_INTERVAL_MS,
  STATS_WATCHED_INTERVAL_MS,
  createLocalGenerationSync,
  createStatsWatchCadence,
};
