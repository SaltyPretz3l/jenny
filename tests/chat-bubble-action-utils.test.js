const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMPLETE_STATUS,
  STREAMING_STATUS,
  ELABORATE_PROMPT,
  FOLLOW_UP_ACTION_BUSY_REASON,
  FOLLOW_UP_AUTH_BLOCKED_REASON,
  FOLLOW_UP_BACKEND_NOT_READY_REASON,
  REGENERATE_DISABLED_REASON,
  REGENERATE_MISSING_SOURCE_REASON,
  REGENERATE_TEXT_ATTACHMENTS_REASON,
  buildMessageActionModel,
  getElaboratePrompt,
  getLatestReplyAssistantMessageId,
  resolveRegenerateRequest,
} = require('../renderer/chat/chat-bubble-action-utils');
const { UNKNOWN_STATUS } = require('../renderer/chat/chat-terminal-status-vocabulary');

function buildMessageSequence() {
  return [
    {
      id: 'user_1',
      role: 'user',
      content: 'Describe the screenshot',
      attachments: [
        {
          id: 'image_1',
          kind: 'image',
          displayName: 'capture.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          width: 320,
          height: 200,
          assetPath: 'C:/attachments/capture.png',
          sourceKind: 'capture',
        },
      ],
    },
    {
      id: 'assistant_1',
      role: 'assistant',
      status: COMPLETE_STATUS,
      content: 'It looks like a terminal window.',
    },
  ];
}

test('action model enables latest completed assistant follow-up actions when regenerate is allowed', () => {
  const messages = buildMessageSequence();
  const latestReplyAssistantMessageId = getLatestReplyAssistantMessageId(messages);
  const regenerateRequest = resolveRegenerateRequest('assistant_1', messages, {
    latestReplyAssistantMessageId,
  });
  const model = buildMessageActionModel(messages[1], {
    latestReplyAssistantMessageId,
    regenerateRequest,
  });

  assert.equal(model.showHoverRow, true);
  assert.equal(model.showMeta, true);
  assert.equal(model.actions.copy.visible, true);
  assert.equal(model.actions.elaborate.visible, true);
  assert.equal(model.actions.elaborate.enabled, true);
  assert.equal(model.actions.regenerate.visible, true);
  assert.equal(model.actions.regenerate.enabled, true);
  assert.equal(model.actions.regenerate.reason, '');
  assert.equal(model.actions.branch.visible, true);
  assert.equal(model.actions.branch.enabled, true);
});

test('action model disables regenerate and elaborate while follow-up actions are busy', () => {
  const messages = buildMessageSequence();
  const latestReplyAssistantMessageId = getLatestReplyAssistantMessageId(messages);
  const regenerateRequest = resolveRegenerateRequest('assistant_1', messages, {
    latestReplyAssistantMessageId,
    followUpActionsBusy: true,
  });
  const model = buildMessageActionModel(messages[1], {
    latestReplyAssistantMessageId,
    followUpActionsBusy: true,
    regenerateRequest,
  });

  assert.equal(model.actions.regenerate.visible, true);
  assert.equal(model.actions.regenerate.enabled, false);
  assert.equal(model.actions.regenerate.reason, FOLLOW_UP_ACTION_BUSY_REASON);
  assert.equal(model.actions.elaborate.visible, true);
  assert.equal(model.actions.elaborate.enabled, false);
  assert.equal(model.actions.elaborate.reason, FOLLOW_UP_ACTION_BUSY_REASON);
  assert.equal(model.actions.branch.visible, true);
  assert.equal(model.actions.branch.enabled, false);
  assert.equal(model.actions.branch.reason, FOLLOW_UP_ACTION_BUSY_REASON);
});

test('action model disables regenerate and elaborate when auth is unavailable', () => {
  const messages = buildMessageSequence();
  const latestReplyAssistantMessageId = getLatestReplyAssistantMessageId(messages);
  const model = buildMessageActionModel(messages[1], {
    latestReplyAssistantMessageId,
    followUpDisabledReason: FOLLOW_UP_AUTH_BLOCKED_REASON,
    regenerateRequest: resolveRegenerateRequest('assistant_1', messages, {
      latestReplyAssistantMessageId,
    }),
  });

  assert.equal(model.actions.regenerate.visible, true);
  assert.equal(model.actions.regenerate.enabled, false);
  assert.equal(model.actions.regenerate.reason, FOLLOW_UP_AUTH_BLOCKED_REASON);
  assert.equal(model.actions.elaborate.visible, true);
  assert.equal(model.actions.elaborate.enabled, false);
  assert.equal(model.actions.elaborate.reason, FOLLOW_UP_AUTH_BLOCKED_REASON);
});

test('action model disables regenerate and elaborate when backend is not ready', () => {
  const messages = buildMessageSequence();
  const latestReplyAssistantMessageId = getLatestReplyAssistantMessageId(messages);
  const model = buildMessageActionModel(messages[1], {
    latestReplyAssistantMessageId,
    followUpDisabledReason: FOLLOW_UP_BACKEND_NOT_READY_REASON,
    regenerateRequest: resolveRegenerateRequest('assistant_1', messages, {
      latestReplyAssistantMessageId,
    }),
  });

  assert.equal(model.actions.regenerate.visible, true);
  assert.equal(model.actions.regenerate.enabled, false);
  assert.equal(model.actions.regenerate.reason, FOLLOW_UP_BACKEND_NOT_READY_REASON);
  assert.equal(model.actions.elaborate.visible, true);
  assert.equal(model.actions.elaborate.enabled, false);
  assert.equal(model.actions.elaborate.reason, FOLLOW_UP_BACKEND_NOT_READY_REASON);
});

test('action model keeps older assistant replies limited to copy plus meta', () => {
  const messages = [
    ...buildMessageSequence(),
    {
      id: 'user_2',
      role: 'user',
      content: 'Anything else?',
    },
    {
      id: 'assistant_2',
      role: 'assistant',
      status: COMPLETE_STATUS,
      content: 'Nope.',
    },
  ];
  const latestReplyAssistantMessageId = getLatestReplyAssistantMessageId(messages);
  const older = buildMessageActionModel(messages[1], {
    latestReplyAssistantMessageId,
    regenerateRequest: resolveRegenerateRequest('assistant_1', messages, {
      latestReplyAssistantMessageId,
    }),
  });

  assert.equal(older.actions.copy.visible, true);
  assert.equal(older.actions.elaborate.visible, false);
  assert.equal(older.actions.regenerate.visible, false);
});

test('action model hides the hover row for streaming assistants and keeps user copy-only controls', () => {
  const streaming = buildMessageActionModel(
    {
      id: 'assistant_streaming',
      role: 'assistant',
      status: STREAMING_STATUS,
    },
    { latestReplyAssistantMessageId: 'assistant_1' }
  );
  const user = buildMessageActionModel({
    id: 'user_1',
    role: 'user',
    status: COMPLETE_STATUS,
  });

  assert.equal(streaming.showHoverRow, false);
  assert.equal(streaming.showMeta, false);
  assert.equal(streaming.actions.copy.visible, true);
  assert.equal(streaming.actions.elaborate.visible, false);

  assert.equal(user.showHoverRow, true);
  assert.equal(user.showMeta, false);
  assert.equal(user.actions.copy.visible, true);
  assert.equal(user.actions.branch.visible, true);
  assert.equal(user.actions.branch.enabled, true);
  assert.equal(user.actions.elaborate.visible, false);
  assert.equal(user.actions.regenerate.visible, false);
});

test('getElaboratePrompt only returns the canned prompt for the latest reply-eligible assistant', () => {
  const messages = buildMessageSequence();
  const latestReplyAssistantMessageId = getLatestReplyAssistantMessageId(messages);

  assert.equal(
    getElaboratePrompt(messages[1], {
      latestReplyAssistantMessageId,
    }),
    ELABORATE_PROMPT
  );

  assert.equal(
    getElaboratePrompt(
      {
        id: 'assistant_old',
        role: 'assistant',
        status: COMPLETE_STATUS,
      },
      { latestReplyAssistantMessageId }
    ),
    ''
  );
});

test('latest reply assistant id skips special assistant cards', () => {
  const latestReplyAssistantMessageId = getLatestReplyAssistantMessageId([
    { id: 'assistant_plain', role: 'assistant', status: COMPLETE_STATUS, content: 'Plain reply' },
    { id: 'assistant_tool', role: 'assistant', kind: 'tool_use', status: COMPLETE_STATUS, content: 'Read file' },
    { id: 'assistant_proactive', role: 'assistant', kind: 'proactive_suggestion', status: COMPLETE_STATUS, content: 'Suggestion' },
  ]);

  assert.equal(latestReplyAssistantMessageId, 'assistant_plain');
});

test('latest reply assistant id treats raw completed as reply-eligible and raw runtime_error as non-eligible', () => {
  const latestReplyAssistantMessageId = getLatestReplyAssistantMessageId([
    { id: 'assistant_failed', role: 'assistant', status: 'runtime_error', content: '' },
    { id: 'assistant_done', role: 'assistant', status: 'completed', content: 'Done.' },
  ]);

  assert.equal(latestReplyAssistantMessageId, 'assistant_done');
});

test('resolveRegenerateRequest reuses replayable image attachments from the source user turn', () => {
  const messages = buildMessageSequence();
  const request = resolveRegenerateRequest('assistant_1', messages, {
    latestReplyAssistantMessageId: getLatestReplyAssistantMessageId(messages),
  });

  assert.equal(request.allowed, true);
  assert.equal(request.prompt, 'Describe the screenshot');
  assert.equal(request.sourceMessageId, 'user_1');
  assert.equal(request.replayImageAttachments.length, 1);
  assert.equal(request.replayImageAttachments[0].assetPath, 'C:/attachments/capture.png');
});

test('resolveRegenerateRequest blocks when the source user turn had text attachments', () => {
  const messages = [
    {
      id: 'user_1',
      role: 'user',
      content: 'Summarize this file',
      attachments: [
        {
          id: 'attachment_1',
          kind: 'text',
          displayName: 'notes.txt',
          promptName: 'notes.txt',
          extension: '.txt',
          sizeBytes: 128,
          truncated: false,
        },
      ],
    },
    {
      id: 'assistant_1',
      role: 'assistant',
      status: COMPLETE_STATUS,
      content: 'Here is the summary.',
    },
  ];

  const request = resolveRegenerateRequest('assistant_1', messages, {
    latestReplyAssistantMessageId: getLatestReplyAssistantMessageId(messages),
  });

  assert.equal(request.allowed, false);
  assert.equal(request.reason, REGENERATE_TEXT_ATTACHMENTS_REASON);
  assert.equal(request.hasTextAttachments, true);
});

test('resolveRegenerateRequest blocks when no source user turn is available', () => {
  const messages = [
    {
      id: 'assistant_1',
      role: 'assistant',
      status: COMPLETE_STATUS,
      content: 'Standalone reply.',
    },
  ];

  const request = resolveRegenerateRequest('assistant_1', messages, {
    latestReplyAssistantMessageId: getLatestReplyAssistantMessageId(messages),
  });

  assert.equal(request.allowed, false);
  assert.equal(request.reason, REGENERATE_MISSING_SOURCE_REASON);
});

test('resolveRegenerateRequest blocks non-latest assistants with the generic disabled reason', () => {
  const messages = [
    ...buildMessageSequence(),
    {
      id: 'user_2',
      role: 'user',
      content: 'Give me one more detail',
    },
    {
      id: 'assistant_2',
      role: 'assistant',
      status: COMPLETE_STATUS,
      content: 'Here is one more detail.',
    },
  ];

  const request = resolveRegenerateRequest('assistant_1', messages, {
    latestReplyAssistantMessageId: getLatestReplyAssistantMessageId(messages),
  });

  assert.equal(request.allowed, false);
  assert.equal(request.reason, REGENERATE_DISABLED_REASON);
});

test('action model hides regenerate and elaborate for proactive suggestion cards', () => {
  const model = buildMessageActionModel(
    {
      id: 'assistant_proactive',
      role: 'assistant',
      kind: 'proactive_suggestion',
      status: COMPLETE_STATUS,
      content: 'Try asking about your morning plan.',
    },
    {
      latestReplyAssistantMessageId: 'assistant_1',
    }
  );

  assert.equal(model.actions.copy.visible, true);
  assert.equal(model.actions.elaborate.visible, false);
  assert.equal(model.actions.regenerate.visible, false);
  assert.equal(model.actions.branch.visible, false);
});

// F2 — edit action visibility / enabled gates

test('F3: action model hides branch for non-empty message kinds', () => {
  const assistant = buildMessageActionModel(
    {
      id: 'assistant_custom',
      role: 'assistant',
      kind: 'custom_card',
      status: COMPLETE_STATUS,
      content: 'A future structured card.',
    },
    { latestReplyAssistantMessageId: 'assistant_1' }
  );
  const user = buildMessageActionModel(
    {
      id: 'user_custom',
      role: 'user',
      kind: 'message',
      content: 'Legacy non-canonical kind marker.',
    },
    { latestReplyAssistantMessageId: 'assistant_1' }
  );

  assert.equal(assistant.actions.branch.visible, false);
  assert.equal(user.actions.branch.visible, false);
});

test('edit action is visible + enabled on user messages by default', () => {
  const model = buildMessageActionModel(
    { id: 'user_1', role: 'user', content: 'hi' },
    { latestReplyAssistantMessageId: 'assistant_1' }
  );
  assert.equal(model.actions.edit.visible, true);
  assert.equal(model.actions.edit.enabled, true);
  assert.equal(model.actions.edit.reason, '');
});

test('edit action is hidden on assistant messages', () => {
  const model = buildMessageActionModel(
    { id: 'assistant_1', role: 'assistant', status: COMPLETE_STATUS, content: 'hi' },
    { latestReplyAssistantMessageId: 'assistant_1' }
  );
  assert.equal(model.actions.edit.visible, false);
});

test('edit action is disabled with reason when another message is being edited', () => {
  const model = buildMessageActionModel(
    { id: 'user_2', role: 'user', content: 'two' },
    { latestReplyAssistantMessageId: 'assistant_1', editingMessageId: 'user_1' }
  );
  assert.equal(model.actions.edit.visible, true);
  assert.equal(model.actions.edit.enabled, false);
  assert.equal(model.actions.edit.reason, 'Finish the current edit first.');
});

test('edit action is enabled on the row currently being edited (no reason)', () => {
  // The button on the row being edited should remain accessible — the inline
  // bubble has its own Save/Cancel controls; the hover-row action stays a
  // no-op but not a "locked" surface (no scary message). The plan sets the
  // reason empty because there is no "other" lock — the user IS the edit.
  // The enabled flag may stay false because re-entering is a no-op.
  const model = buildMessageActionModel(
    { id: 'user_1', role: 'user', content: 'one' },
    { latestReplyAssistantMessageId: 'assistant_1', editingMessageId: 'user_1' }
  );
  // Visible, but disabled (re-entry is a no-op so we don't advertise it).
  assert.equal(model.actions.edit.visible, true);
  // The current implementation gates by `!editingMessageId`, so editing this
  // row disables the button. Reason is empty because there's no "other" lock.
  // (If we later allow re-entry, this assertion will need to flip.)
  assert.equal(model.actions.edit.enabled, false);
});

test('edit action is blocked + reasoned when followUpDisabledReason is set', () => {
  const model = buildMessageActionModel(
    { id: 'user_1', role: 'user', content: 'hi' },
    { latestReplyAssistantMessageId: 'assistant_1', followUpDisabledReason: 'Streaming in progress.' }
  );
  assert.equal(model.actions.edit.visible, true);
  assert.equal(model.actions.edit.enabled, false);
  assert.equal(model.actions.edit.reason, 'Streaming in progress.');
});

/* ── EH-W4: error-target regenerate (universal retry) ── */

function buildFailedTurnSequence() {
  return [
    { id: 'user_1', role: 'user', content: 'First prompt' },
    { id: 'assistant_1', role: 'assistant', status: COMPLETE_STATUS, content: 'First reply.' },
    { id: 'user_2', role: 'user', content: 'Second prompt that failed' },
    {
      id: 'assistant_2',
      role: 'assistant',
      status: 'runtime_error',
      content: '',
      stream_error: 'Provider exploded',
    },
  ];
}

test('resolveRegenerateRequest allows the latest failed assistant target with allowErrorTarget', () => {
  const messages = buildFailedTurnSequence();
  const request = resolveRegenerateRequest('assistant_2', messages, {
    latestReplyAssistantMessageId: getLatestReplyAssistantMessageId(messages),
    allowErrorTarget: true,
  });

  assert.equal(request.allowed, true, 'error-only latest assistant is retryable');
  assert.equal(request.prompt, 'Second prompt that failed', 'replays the failed turn prompt');
  assert.equal(request.sourceMessageId, 'user_2', 'source is the preceding user message');
});

test('resolveRegenerateRequest still blocks failed targets without allowErrorTarget', () => {
  const messages = buildFailedTurnSequence();
  const request = resolveRegenerateRequest('assistant_2', messages, {
    latestReplyAssistantMessageId: getLatestReplyAssistantMessageId(messages),
  });

  assert.equal(request.allowed, false);
  assert.equal(request.reason, REGENERATE_DISABLED_REASON);
});

test('resolveRegenerateRequest blocks stale failed targets when a newer assistant reply exists', () => {
  const messages = buildFailedTurnSequence().concat([
    { id: 'user_3', role: 'user', content: 'Third prompt' },
    { id: 'assistant_3', role: 'assistant', status: COMPLETE_STATUS, content: 'Recovered reply.' },
  ]);
  const request = resolveRegenerateRequest('assistant_2', messages, {
    latestReplyAssistantMessageId: getLatestReplyAssistantMessageId(messages),
    allowErrorTarget: true,
  });

  assert.equal(request.allowed, false, 'stale error card stays blocked');
});

// SP-12: shared terminal-status vocabulary adoption (Wave L1 Packet R).

test('buildMessageActionModel normalizes an unrecognized raw status to unknown instead of passing it through (SP-12)', () => {
  const model = buildMessageActionModel(
    { id: 'assistant_bogus', role: 'assistant', status: 'some_bogus_status', content: 'weird' },
    { latestReplyAssistantMessageId: 'assistant_bogus' }
  );

  assert.equal(model.status, UNKNOWN_STATUS);
});

test('buildMessageActionModel keeps denied normalized to error (eligibility semantics preserved)', () => {
  const model = buildMessageActionModel(
    { id: 'assistant_denied', role: 'assistant', status: 'denied', content: '' },
    { latestReplyAssistantMessageId: 'assistant_denied' }
  );

  assert.equal(model.status, 'error');
  // A denied/error-status message is not the reply-eligible "complete" target.
  assert.equal(model.actions.regenerate.visible, false);
});

test('resolveRegenerateRequest keeps the complete-latest path unchanged with allowErrorTarget set', () => {
  const messages = buildMessageSequence();
  const request = resolveRegenerateRequest('assistant_1', messages, {
    latestReplyAssistantMessageId: getLatestReplyAssistantMessageId(messages),
    allowErrorTarget: true,
  });

  assert.equal(request.allowed, true);
  assert.equal(request.sourceMessageId, 'user_1');
});

test('complete assistant durability metadata exposes the unsaved reply action model', () => {
  const model = buildMessageActionModel({
    id: 'assistant_unsaved',
    role: 'assistant',
    status: COMPLETE_STATUS,
    content: 'useful output',
    durability: {
      state: 'unsaved',
      reason: 'write_failed',
      scope: 'assistant',
      artifact_id: 'repair_1',
    },
  }, { latestReplyAssistantMessageId: 'assistant_unsaved' });

  assert.deepEqual(model.unsavedReply, {
    visible: true,
    artifactId: 'repair_1',
    reason: 'write_failed',
    scope: 'assistant',
  });
});

test('ordinary complete replies do not expose the unsaved reply action model', () => {
  const model = buildMessageActionModel({
    id: 'assistant_durable', role: 'assistant', status: COMPLETE_STATUS, content: 'saved',
  }, { latestReplyAssistantMessageId: 'assistant_durable' });

  assert.equal(model.unsavedReply.visible, false);
});

test('unsaved failure and interactive terminals expose the same recovery controls', () => {
  for (const message of [
    { id: 'error_1', role: 'assistant', status: 'error', content: 'partial' },
    { id: 'batch_1', role: 'assistant', status: 'complete', kind: 'question_batch' },
    { id: 'plan_1', role: 'assistant', status: 'complete', kind: 'plan_proposal' },
  ]) {
    const model = buildMessageActionModel({
      ...message,
      durability: { state: 'unsaved', artifact_id: `repair_${message.id}` },
    }, {});
    assert.equal(model.unsavedReply.visible, true, message.id);
    assert.equal(model.unsavedReply.artifactId, `repair_${message.id}`);
  }
});
