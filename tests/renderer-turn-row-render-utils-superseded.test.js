'use strict';

/**
 * tests/renderer-turn-row-render-utils-superseded.test.js
 *
 * Live recheck 2026-10-05: an assistant_error notice is superseded once a
 * newer assistant reply (the resume tail) sits below it, so its card stops
 * offering Resume / Run again. The fallback notice id and the tail itself are
 * never superseded. Lives beside renderer-turn-row-render-utils.test.js and
 * renderer-error-card-markup.test.js, which are at their line caps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const errorRecoveryUtils = require('../renderer/chat/renderer-error-recovery-utils');

function errorRow(primaryMessageId) {
  return {
    row_id: 'row:error', turn_id: 'turn_old', kind: 'system_notice',
    ...(primaryMessageId ? { primary_message_id: primaryMessageId } : {}),
    payload: {
      subkind: 'assistant_error', stream_error: 'Jenny closed before this reply finished.',
      recovery_class: 'app_restart_rerun', recovery_actions: [{ id: 'rerun_interrupted_reply', label: 'Run again' }],
    },
  };
}

const failed = {
  id: 'assistant_old', role: 'assistant', status: 'error', turn_id: 'turn_old',
  stream_error: 'Jenny closed before this reply finished.', recovery_class: 'app_restart_rerun',
};
const rerun = { id: 'assistant_new', role: 'assistant', status: 'complete', turn_id: 'turn_new', content: 'Done.' };

test('an assistant error notice is stamped superseded only when a newer reply is the resume tail', () => {
  let renderedMessage = null;
  const renderer = createTurnRowRenderUtils({
    renderAssistantFailureNotice(message) {
      renderedMessage = message;
      return '<div class="inv-error-recovery"></div>';
    },
  });

  renderer.buildTurnRowListMarkup([errorRow('assistant_old')], [failed, rerun], { resumeTailMessageId: 'assistant_new' });
  assert.equal(renderedMessage.superseded, true, 'a newer reply below settles the card');

  renderer.buildTurnRowListMarkup([errorRow('assistant_old')], [failed], { resumeTailMessageId: 'assistant_old' });
  assert.equal(renderedMessage.superseded, undefined, 'the failed reply is still the tail: live card');

  renderer.buildTurnRowListMarkup([errorRow('assistant_old')], [failed, rerun], {});
  assert.equal(renderedMessage.superseded, undefined, 'no resume tail known: live card');

  renderer.buildTurnRowListMarkup([errorRow('')], [rerun], { resumeTailMessageId: 'assistant_new' });
  assert.equal(renderedMessage.superseded, undefined, 'a notice with the fallback id is never settled');
});

test('the settled card reaches the timeline markup without a live button', () => {
  const renderer = createTurnRowRenderUtils({
    renderAssistantFailureNotice: (message) => errorRecoveryUtils.renderTimelineErrorCard(message),
  });
  const live = renderer.buildTurnRowListMarkup([errorRow('assistant_old')], [failed], { resumeTailMessageId: 'assistant_old' });
  assert.ok(live.includes('data-inv-error-action="rerun_interrupted_reply"'), 'the live card offers Run again');
  const settled = renderer.buildTurnRowListMarkup([errorRow('assistant_old')], [failed, rerun], { resumeTailMessageId: 'assistant_new' });
  assert.ok(settled.includes('data-error-settled="true"'));
  assert.equal(/data-inv-error-action=/.test(settled), false, 'no live button once the rerun exists');
  assert.match(settled, /The reply continues below\./);
});

/* Live recheck 2026-10-05: a card whose turn was rerun or resumed keeps its
 * navigation but no retry-like action; the click guard would only refuse it. */
test('a superseded danger card drops retry_turn, keeps View in logs and never synthesizes a retry', () => {
  const message = {
    id: 'msg_old', session_id: 'sess_7', stream_id: 'stream_old',
    stream_error: 'Sidecar exited unexpectedly', error_code: 'CMP-SIDECAR-0003',
    recovery_class: 'sidecar_transport', next_action: 'retry_turn', retryable: true,
    recovery_actions: [{ id: 'retry_turn', label: 'Retry turn' }, { id: 'open_logs', label: 'View in logs' }],
  };
  const live = errorRecoveryUtils.renderTimelineErrorCard(message);
  assert.ok(live.includes('data-inv-error-action="retry_turn"'), 'the live card still retries');
  assert.equal(/data-error-settled/.test(live), false);

  const settled = errorRecoveryUtils.renderTimelineErrorCard({ ...message, superseded: true });
  assert.ok(settled.includes('data-error-settled="true"'));
  assert.ok(settled.includes('chat-error-card--settled'));
  assert.equal(/data-inv-error-action="retry_turn"/.test(settled), false, 'retry_turn dropped');
  assert.equal(/data-inv-error-action="retry"/.test(settled), false, 'no universal retry either');
  assert.ok(settled.includes('data-inv-error-action="open_logs"'), 'navigation stays');
  assert.ok(settled.includes('data-error-severity="danger"'), 'a danger card stays danger');
  assert.equal(/The reply continues below/.test(settled), false, 'the settled note is for the calm card alone');
});
