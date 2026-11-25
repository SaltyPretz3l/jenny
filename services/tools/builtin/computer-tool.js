'use strict';

/* services/tools/builtin/computer-tool.js: `computer` (roadmap row 196)
 *
 * Electron owns the grants, the mouse and the owner's watch (services/computer-use/). This file is the
 * tool-shaped door onto them, as browser-tool.js is for the browser: check the call is live, refuse an
 * unattended turn and Plan or read-only mode, hand it to the chat's service and map the outcome. The model
 * reads the whole result; only the short step summary in `metadata` is ever saved.
 * Its description and parameters come from the manifest entry, as the browser's do. */

const { formatForModel, oneLine, ACTIONS, REFUSAL_CODES, stepSummary } = require('../../computer-use/result-format');
const { isPlainObject } = require('../../value-utils');
const { checkLiveCall } = require('./propose-tool-support');
const { manifestSchema } = require('./tool-result');
const { isUnattendedTurn } = require('./unattended-turn');

// Steps the model can answer or move on from. Everything else counts as a failure, so the loop's
// repeated-error stop still catches a model that keeps retrying a refused step.
const RECOVERABLE_STATUSES = new Set(['resumed', 'refused', 'declined', 'paused_by_user', 'busy', 'no_target', 'not_found', 'budget']);
// Why a step was refused, as a fixed code the chat turns into a short reason; never the helper's own words.
const REFUSAL_REASONS = new Set(REFUSAL_CODES);
const MAX_NAME_CHARS = 60;

// Only the action, and for open and focus the program's name: never typed text or a chord.
function summarize(input) {
  const action = isPlainObject(input) && typeof input.action === 'string' && ACTIONS.includes(input.action) ? input.action : '';
  if (!action) return 'Computer: invalid request';
  const name = (action === 'open' || action === 'focus') && typeof input.name === 'string' ? oneLine(input.name, MAX_NAME_CHARS) : '';
  return name ? `Computer: ${action} ${name}` : `Computer: ${action}`;
}

function failure(status, message) {
  return {
    content: message, summary: `Computer: ${status}`, isError: true,
    metadata: { result_kind: 'computer', status, step_summary: message },
  };
}

function toResult(outcome) {
  const status = String(outcome?.status || 'failed');
  const image = outcome?.image;
  return {
    content: formatForModel(outcome),
    summary: `Computer: ${status}`,
    isError: !(outcome?.ok === true || RECOVERABLE_STATUSES.has(status)),
    metadata: {
      result_kind: 'computer', status, step_summary: stepSummary(outcome),
      ...(status === 'refused' && REFUSAL_REASONS.has(outcome?.refusal) ? { refusal_reason: outcome.refusal } : {}),
      ...(outcome?.humanWaitMs > 0 ? { human_wait_ms: outcome.humanWaitMs } : {}),
    },
    ...(image?.buffer ? { previewImage: { buffer: image.buffer, width: image.width, height: image.height, mime_type: 'image/png' } } : {}),
  };
}

module.exports = {
  name: 'computer', ...manifestSchema('computer'), category: 'builtin', workspaceRequired: false,
  readOnly: false, sideEffecting: true,
  summarize,
  async execute(input, context = {}) {
    if (!isPlainObject(input)) return failure('invalid', 'The computer tool needs an action.');
    if (context.readOnly || context.planMode) {
      return failure('refused', 'Computer use is not available in Plan or read-only mode.');
    }
    const service = context.computerUseService;
    if (!service || typeof service.execute !== 'function') {
      return failure('unavailable', 'Computer use is not available in this chat.');
    }
    const live = checkLiveCall(context);
    if (!live.ok || !context.callId) return failure('stale', 'This computer step no longer belongs to a running turn.');
    if (isUnattendedTurn(context, live.sessionId)) {
      return failure('refused', 'The owner did not start this turn, so the computer cannot be used.');
    }
    try {
      const outcome = await service.execute(input, {
        sessionId: live.sessionId, turnId: live.turnId, callId: context.callId,
        abortSignal: context.abortSignal, authorize: context.authorize,
        suspendTurnClocks: context.suspendTurnClocks,
      });
      return toResult(outcome);
    } catch (_error) {
      return failure('failed', 'The computer step failed.');
    }
  },
};
