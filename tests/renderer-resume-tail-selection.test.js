// Which assistant message owns the Resume affordance.
//
// The rule sits between the two ids the render pipeline already computes, and
// neither one works on its own:
//   - latestAssistantMessageId is stolen by rows that are APPENDED after a turn
//     ends (recap, proactive suggestion, question batch), which would hide
//     Resume exactly when the turn otherwise succeeded;
//   - latestReplyAssistantMessageId is complete-only, so a newer error or
//     cancelled terminal would NOT supersede an older budget stop and the button
//     would send `resume` at the end of the thread, far from where it was clicked.
//
// These live in their own file because tests/renderer-message-index-utils.test.js
// sits one line under the 1015-line ceiling.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeDerivedMessageState,
  resolveResumeTailAssistantMessageId,
} = require('../renderer/chat/renderer-message-index-utils');

test('the resume tail skips rows appended after a turn ends', () => {
  const stopped = { id: 'a1', role: 'assistant', status: 'complete', resumable_stop: 'tool_cap' };
  for (const trailingKind of [
    'interactive_round_recap',
    'slash_command_output',
    'proactive_suggestion',
    'question_batch',
  ]) {
    const messages = [
      stopped,
      { id: 'trailing', role: 'assistant', kind: trailingKind, status: 'complete' },
    ];
    assert.equal(
      resolveResumeTailAssistantMessageId(messages),
      'a1',
      `${trailingKind} must not steal the resume tail`
    );
  }
});

test('a newer assistant terminal supersedes an older budget stop regardless of status', () => {
  const stopped = { id: 'a1', role: 'assistant', status: 'complete', resumable_stop: 'tool_cap' };
  for (const status of ['complete', 'error', 'cancelled', 'streaming']) {
    const messages = [stopped, { id: 'a2', role: 'assistant', status }];
    assert.equal(resolveResumeTailAssistantMessageId(messages), 'a2', `status ${status}`);
  }
  // latestReplyAssistantMessageId answers 'a1' for the non-complete cases, which
  // is precisely why it is the wrong id for this affordance.
  assert.equal(
    computeDerivedMessageState([stopped, { id: 'a2', role: 'assistant', status: 'error' }])
      .latestReplyAssistantMessageId,
    'a1'
  );
});

test('the resume tail ignores trailing user messages and degrades to empty', () => {
  const stopped = { id: 'a1', role: 'assistant', status: 'complete' };
  assert.equal(
    resolveResumeTailAssistantMessageId([stopped, { id: 'u1', role: 'user' }]),
    'a1'
  );
  assert.equal(resolveResumeTailAssistantMessageId([]), '');
  assert.equal(resolveResumeTailAssistantMessageId(null), '');
  assert.equal(resolveResumeTailAssistantMessageId([{ id: 'u1', role: 'user' }]), '');
});
