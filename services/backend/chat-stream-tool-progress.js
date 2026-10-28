'use strict';

// `tool_progress` chat-stream events are live-only, like `tool_output_chunk`:
// they are never persisted or journaled, and the paired tool.result stays
// authoritative. image_generate reports its render phase, sampling step and
// newest preview frame through them.

const { MAX_PREVIEW_BYTES } = require('../image-render-preview');

// Live render phases in order; the tool never reports one before an earlier one.
const PROGRESS_PHASES = Object.freeze(['gpu', 'load', 'sample', 'decode']);
const MAX_STEPS = 1000;
const PREVIEW_PREFIX = 'data:image/png;base64,';
const MAX_PREVIEW_CHARS = Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 + PREVIEW_PREFIX.length;
const PREVIEW_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

/** Re-bound one progress report at this trust boundary and forward it. */
function emitToolProgress(service, eventBase, { callId, toolName, progress } = {}) {
  const id = String(callId || '').trim();
  if (!id || !progress || !PROGRESS_PHASES.includes(progress.phase) || typeof service?.emit !== 'function') return false;
  const event = { type: 'tool_progress', ...eventBase, callId: id, toolName: String(toolName || '').trim(), phase: progress.phase };
  const { step, steps } = progress;
  if (progress.phase === 'sample' && Number.isSafeInteger(step) && Number.isSafeInteger(steps)
    && step >= 0 && steps > 0 && step <= steps && steps <= MAX_STEPS) {
    event.step = step;
    event.steps = steps;
  }
  const preview = progress.preview;
  if (typeof preview === 'string' && preview.length <= MAX_PREVIEW_CHARS && PREVIEW_DATA_URL.test(preview)) {
    event.preview = preview;
  }
  service.emit('chat-stream', event);
  return true;
}

module.exports = { MAX_PREVIEW_CHARS, PROGRESS_PHASES, emitToolProgress };
