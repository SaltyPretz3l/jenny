const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STREAMING_STATUS,
  COMPLETE_STATUS,
  ERROR_STATUS,
  REASONING_STATUS_NONE,
  REASONING_STATUS_STREAMING,
  REASONING_STATUS_COMPLETE,
  REASONING_SOURCE_NONE,
  REASONING_SOURCE_PROVIDER,
  normalizeChatMessage,
  normalizeChatMessages,
  getLatestAssistantMessageId,
  buildAssistantMetaLabel,
  mergeReasoningEntries,
  normalizeInteractiveRoundRecap,
} = require('../renderer/chat/chat-message-utils');
const { getThinkingSummary } = require('../renderer/chat/chat-thinking-utils');

test('normalizeChatMessage marks historical assistant replies complete and finalizes at timestamp', () => {
  const message = normalizeChatMessage(
    {
      id: 'assistant_hist_1',
      role: 'assistant',
      content: 'Completed reply.',
      timestamp: '2026-03-12T14:15:09.000Z',
    },
    { fallbackIdPrefix: 'session_hist' }
  );

  assert.equal(message.status, COMPLETE_STATUS);
  assert.equal(message.finalizedAt, '2026-03-12T14:15:09.000Z');
});

test('normalizeChatMessage preserves streaming assistant replies without finalizedAt', () => {
  const message = normalizeChatMessage(
    {
      id: 'assistant_stream_1',
      role: 'assistant',
      content: 'Still responding',
      timestamp: '2026-03-12T14:20:00.000Z',
      status: STREAMING_STATUS,
    },
    { fallbackIdPrefix: 'session_stream' }
  );

  assert.equal(message.status, STREAMING_STATUS);
  assert.equal(message.finalizedAt, null);
  assert.equal(message.reasoning.status, REASONING_STATUS_STREAMING);
  assert.equal(message.reasoning.available, false);
});

test('normalizeChatMessages ignores legacy pending field (iteration system removed)', () => {
  const [message] = normalizeChatMessages(
    [
      {
        id: 'assistant_pending_1',
        role: 'assistant',
        content: 'Working on it',
        timestamp: '2026-03-12T14:21:00.000Z',
        pending: true,
      },
    ],
    { fallbackIdPrefix: 'session_pending' }
  );

  // pending: true no longer overrides status — the removed iteration system
  // used this to keep messages in streaming state across verification loops.
  assert.equal(message.status, COMPLETE_STATUS);
  assert.equal(typeof message.finalizedAt, 'string');
});

test('getLatestAssistantMessageId returns the newest assistant reply target', () => {
  const messages = normalizeChatMessages(
    [
      { id: 'user_1', role: 'user', content: 'Hi', timestamp: '2026-03-12T14:00:00.000Z' },
      { id: 'assistant_1', role: 'assistant', content: 'Hello', timestamp: '2026-03-12T14:00:02.000Z' },
      { id: 'user_2', role: 'user', content: 'Try again', timestamp: '2026-03-12T14:01:00.000Z' },
      {
        id: 'assistant_2',
        role: 'assistant',
        content: 'Retrying now',
        timestamp: '2026-03-12T14:01:02.000Z',
        status: ERROR_STATUS,
        finalizedAt: '2026-03-12T14:01:08.000Z',
      },
    ],
    { fallbackIdPrefix: 'session_target' }
  );

  assert.equal(getLatestAssistantMessageId(messages), 'assistant_2');
});

test('getLatestAssistantMessageId skips recap-only assistant artifacts', () => {
  const messages = normalizeChatMessages(
    [
      { id: 'assistant_1', role: 'assistant', content: 'Main reply', timestamp: '2026-03-12T14:00:02.000Z' },
      {
        id: 'assistant_recap_1',
        role: 'assistant',
        kind: 'interactive_round_recap',
        content: 'Asked 1 question',
        timestamp: '2026-03-12T14:00:03.000Z',
      },
    ],
    { fallbackIdPrefix: 'session_target' }
  );

  assert.equal(getLatestAssistantMessageId(messages), 'assistant_1');
});

test('getLatestAssistantMessageId treats interactive question batches as the latest visible assistant turn', () => {
  const messages = normalizeChatMessages(
    [
      { id: 'assistant_1', role: 'assistant', content: 'Main reply', timestamp: '2026-03-12T14:00:02.000Z' },
      {
        id: 'assistant_batch_1',
        role: 'assistant',
        kind: 'question_batch',
        content: 'A couple quick questions so I can help better.',
        timestamp: '2026-03-12T14:00:03.000Z',
      },
    ],
    { fallbackIdPrefix: 'session_target' }
  );

  assert.equal(getLatestAssistantMessageId(messages), 'assistant_batch_1');
});

test('buildAssistantMetaLabel formats terminal states and hides streaming metadata', () => {
  const formatTime = (value) => `@ ${value}`;
  const completeMessage = normalizeChatMessage({
    id: 'assistant_complete_1',
    role: 'assistant',
    content: 'All set',
    timestamp: '2026-03-12T14:22:00.000Z',
  });
  const errorMessage = normalizeChatMessage({
    id: 'assistant_error_1',
    role: 'assistant',
    content: 'Stream failed: timeout',
    timestamp: '2026-03-12T14:23:00.000Z',
    status: ERROR_STATUS,
    finalizedAt: '2026-03-12T14:23:04.000Z',
  });
  const streamingMessage = normalizeChatMessage({
    id: 'assistant_streaming_2',
    role: 'assistant',
    content: 'Still going',
    timestamp: '2026-03-12T14:24:00.000Z',
    status: STREAMING_STATUS,
  });

  assert.equal(
    buildAssistantMetaLabel(completeMessage, formatTime),
    'Completed @ 2026-03-12T14:22:00.000Z'
  );
  assert.equal(
    buildAssistantMetaLabel(errorMessage, formatTime),
    'Failed @ 2026-03-12T14:23:04.000Z'
  );
  assert.equal(buildAssistantMetaLabel(streamingMessage, formatTime), '');
  assert.equal(
    buildAssistantMetaLabel(
      normalizeChatMessage({
        id: 'assistant_recap_1',
        role: 'assistant',
        kind: 'interactive_round_recap',
        content: 'Asked 1 question',
        timestamp: '2026-03-12T14:25:00.000Z',
      }),
      formatTime
    ),
    ''
  );
});

test('normalizeChatMessage hydrates legacy messages with empty reasoning metadata', () => {
  const message = normalizeChatMessage({
    id: 'assistant_legacy_1',
    role: 'assistant',
    content: 'Legacy reply',
    timestamp: '2026-03-12T15:00:00.000Z',
  });

  assert.deepEqual(message.reasoning, {
    available: false,
    status: REASONING_STATUS_NONE,
    source: REASONING_SOURCE_NONE,
    entries: [],
  });
});

test('normalizeChatMessage preserves provider reasoning entries and derives summary from the latest one', () => {
  const message = normalizeChatMessage({
    id: 'assistant_reasoning_1',
    role: 'assistant',
    content: 'Answer ready.',
    timestamp: '2026-03-12T15:03:00.000Z',
    reasoning: {
      source: REASONING_SOURCE_PROVIDER,
      entries: [
        { id: 'reason_1', text: 'Checking the request intent.', timestamp: '2026-03-12T15:02:58.000Z' },
        { id: 'reason_2', text: 'Forming a concise answer.', timestamp: '2026-03-12T15:02:59.000Z' },
      ],
    },
  });

  assert.equal(message.reasoning.available, true);
  assert.equal(message.reasoning.status, REASONING_STATUS_COMPLETE);
  assert.equal(message.reasoning.source, REASONING_SOURCE_PROVIDER);
  assert.equal(getThinkingSummary(message), 'Forming a concise answer.');
});

test('normalizeChatMessage derives reasoning and reasoning phases from persisted phase-aware transcript fields', () => {
  const message = normalizeChatMessage({
    id: 'assistant_phase_persisted',
    role: 'assistant',
    content: 'Final answer.',
    timestamp: '2026-04-13T10:00:00.000Z',
    phases: [
      {
        phase_id: 'phase_reasoning_pre',
        phase_kind: 'reasoning',
        iteration: 1,
        thinking_id: 'think_pre',
        render_collapsed: false,
        started_at: '2026-04-13T09:59:58.000Z',
        completed_at: '2026-04-13T09:59:59.000Z',
        entries: [
          {
            id: 'reason_pre',
            text: 'Gathering context.',
            timestamp: '2026-04-13T09:59:58.500Z',
            thinkingId: 'think_pre',
          },
        ],
      },
      {
        phase_id: 'phase_text_main',
        phase_kind: 'text',
        iteration: 1,
        started_at: '2026-04-13T10:00:00.000Z',
        completed_at: '2026-04-13T10:00:00.500Z',
      },
      {
        phase_id: 'phase_reasoning_post',
        phase_kind: 'reasoning',
        iteration: 1,
        thinking_id: 'think_post',
        render_collapsed: true,
        started_at: '2026-04-13T10:00:00.600Z',
        completed_at: '2026-04-13T10:00:01.000Z',
        entries: [
          {
            id: 'reason_post',
            text: 'Double-checking the wrap-up.',
            timestamp: '2026-04-13T10:00:00.800Z',
            thinkingId: 'think_post',
          },
        ],
      },
    ],
  });

  assert.equal(message.reasoning.available, true);
  assert.deepEqual(
    message.reasoning.entries.map((entry) => entry.id),
    ['reason_pre', 'reason_post']
  );
  assert.deepEqual(
    message.reasoning_phases.map((phase) => [phase.phaseId, phase.renderCollapsed]),
    [
      ['phase_reasoning_pre', false],
      ['phase_reasoning_post', true],
    ]
  );
});

test('normalizeChatMessage derives compatibility content from persisted visible segments', () => {
  const message = normalizeChatMessage({
    id: 'assistant_visible_segments',
    role: 'assistant',
    content: 'Stale preview',
    timestamp: '2026-04-13T10:05:00.000Z',
    visible_segments: [
      {
        segment_id: 'segment_1',
        phase_id: 'phase_text_main',
        text: 'Final ',
      },
      {
        segment_id: 'segment_2',
        phase_id: 'phase_text_main',
        text: 'answer.',
      },
    ],
  });

  assert.equal(message.content, 'Final answer.');
});

test('normalizeChatMessage preserves legacy reasoning phase summary metadata', () => {
  const message = normalizeChatMessage({
    id: 'assistant_legacy_phase_summary',
    role: 'assistant',
    status: 'streaming',
    timestamp: '2026-05-16T21:49:00.000Z',
    reasoning_phases: [
      {
        phaseId: 'phase_live',
        phaseKind: 'reasoning',
        thinkingId: 'think_live',
        summary: 'Reading context',
      },
    ],
  });

  assert.equal(message.reasoning_phases[0].summary, 'Reading context');
});

test('mergeReasoningEntries replaces live reasoning blocks by id instead of duplicating them', () => {
  const merged = mergeReasoningEntries(
    [
      { id: 'reason_live', text: '## Analyze\n\n- first item', timestamp: '2026-03-12T15:02:58.000Z' },
    ],
    [
      { id: 'reason_live', text: '## Analyze\n\n- first item\n- second item', timestamp: '2026-03-12T15:02:59.000Z' },
    ]
  );

  assert.deepEqual(merged, [
    {
      id: 'reason_live',
      text: '## Analyze\n\n- first item\n- second item',
      timestamp: '2026-03-12T15:02:59.000Z',
    },
  ]);
});

test('mergeReasoningEntries preserves same-text reasoning blocks when thinkingId changes', () => {
  const merged = mergeReasoningEntries(
    [
      {
        id: 'reason_live_iter1',
        text: 'Repeated summary',
        timestamp: '2026-03-12T15:02:58.000Z',
        thinkingId: 'think_iter1',
      },
    ],
    [
      {
        id: 'reason_live_iter2',
        text: 'Repeated summary',
        timestamp: '2026-03-12T15:02:58.000Z',
        thinkingId: 'think_iter2',
      },
    ]
  );

  assert.deepEqual(merged, [
    {
      id: 'reason_live_iter1',
      text: 'Repeated summary',
      timestamp: '2026-03-12T15:02:58.000Z',
      thinkingId: 'think_iter1',
    },
    {
      id: 'reason_live_iter2',
      text: 'Repeated summary',
      timestamp: '2026-03-12T15:02:58.000Z',
      thinkingId: 'think_iter2',
    },
  ]);
});

test('normalizeChatMessage keeps stream errors separate from assistant content', () => {
  const message = normalizeChatMessage({
    id: 'assistant_error_separate',
    role: 'assistant',
    content: '',
    stream_error: 'Model returned no visible assistant text.',
    timestamp: '2026-03-12T15:04:00.000Z',
    status: ERROR_STATUS,
  });

  assert.equal(message.content, '');
  assert.equal(message.stream_error, 'Model returned no visible assistant text.');
  assert.equal(message.status, ERROR_STATUS);
});

test('normalizeChatMessage maps raw Batch 3 terminal statuses to UI error while preserving terminal metadata', () => {
  const message = normalizeChatMessage({
    id: 'assistant_runtime_terminal',
    role: 'assistant',
    content: '',
    status: 'runtime_error',
    terminal_subcode: 'protocol_violation',
    timestamp: '2026-03-12T15:05:00.000Z',
  });

  assert.equal(message.status, ERROR_STATUS);
  assert.equal(message.terminal_status, 'runtime_error');
  assert.equal(message.terminal_subcode, 'protocol_violation');
});

// SP-12: shared terminal-status vocabulary adoption (Wave L1 Packet R).
// These pin the three named behavior changes for chat-message-utils.js.

test('normalizeChatMessage fails closed to unknown for a present but unrecognized status (SP-12)', () => {
  const message = normalizeChatMessage({
    id: 'assistant_unrecognized_status',
    role: 'assistant',
    content: 'Something odd happened.',
    timestamp: '2026-07-13T10:00:00.000Z',
    status: 'some_bogus_status',
  });

  assert.equal(message.status, 'unknown');
});

test('normalizeChatMessage renders an unknown-status assistant message without crashing (minimal label)', () => {
  const message = normalizeChatMessage({
    id: 'assistant_unrecognized_status_label',
    role: 'assistant',
    content: 'Something odd happened.',
    timestamp: '2026-07-13T10:01:00.000Z',
    status: 'some_bogus_status',
  });

  assert.equal(message.status, 'unknown');
  assert.equal(typeof message.finalizedAt, 'string');
  assert.deepEqual(message.reasoning, {
    available: false,
    status: REASONING_STATUS_NONE,
    source: REASONING_SOURCE_NONE,
    entries: [],
  });
  // Deeper unknown-status UX is deferred to wave L5 -- for now the label must
  // simply not crash; it falls back to the non-error ("Completed") wording.
  assert.equal(
    buildAssistantMetaLabel(message, (value) => value),
    `Completed ${message.finalizedAt}`
  );
});

test('normalizeChatMessage normalizes denied to terminal error status (SP-12)', () => {
  const message = normalizeChatMessage({
    id: 'assistant_denied',
    role: 'assistant',
    content: '',
    status: 'denied',
    timestamp: '2026-07-13T10:02:00.000Z',
  });

  assert.equal(message.status, ERROR_STATUS);
  assert.equal(message.terminal_status, 'denied');
});

test('normalizeChatMessage treats one-l canceled as terminal like cancelled (SP-12)', () => {
  const message = normalizeChatMessage({
    id: 'assistant_canceled_one_l',
    role: 'assistant',
    content: '',
    status: 'canceled',
    timestamp: '2026-07-13T10:03:00.000Z',
  });

  assert.equal(message.status, ERROR_STATUS);
  assert.equal(message.terminal_status, 'canceled');
});

test('normalizeChatMessage keeps the legacy-hydration default of complete for absent status', () => {
  const message = normalizeChatMessage({
    id: 'assistant_absent_status',
    role: 'assistant',
    content: 'Legacy row with no persisted status.',
    timestamp: '2026-07-13T10:04:00.000Z',
  });

  assert.equal(message.status, COMPLETE_STATUS);
});

// SP-25: reasoning-merge unification (Wave L1 Packet R). These reproduce the
// verified id-replace bug in the pre-fix algorithm: replacing an entry by id
// never updated the content-key index, causing false drops (a later distinct
// entry matching the replaced entry's OLD content) and false duplicates (the
// replaced entry's NEW content missing from the index, so an identical later
// entry is appended as a duplicate).

test('mergeReasoningEntries does not false-drop a later distinct entry matching a replaced entry\'s old content (SP-25)', () => {
  const merged = mergeReasoningEntries(
    [
      { id: 'r1', text: 'Content X', timestamp: 't1' },
    ],
    [
      { id: 'r1', text: 'Content Y', timestamp: 't2' },
      { id: 'r2', text: 'Content X', timestamp: 't1' },
    ]
  );

  assert.deepEqual(
    merged.map((entry) => [entry.id, entry.text, entry.timestamp]),
    [
      ['r1', 'Content Y', 't2'],
      ['r2', 'Content X', 't1'],
    ]
  );
});

test('mergeReasoningEntries does not false-duplicate an entry matching a replaced entry\'s new content (SP-25)', () => {
  const merged = mergeReasoningEntries(
    [
      { id: 'r1', text: 'Content X', timestamp: 't1' },
    ],
    [
      { id: 'r1', text: 'Content Y', timestamp: 't2' },
      { id: 'r3', text: 'Content Y', timestamp: 't2' },
    ]
  );

  assert.deepEqual(
    merged.map((entry) => [entry.id, entry.text, entry.timestamp]),
    [
      ['r1', 'Content Y', 't2'],
    ]
  );
});

test('normalizeInteractiveRoundRecap preserves collapsed state and filters invalid items', () => {
  const recap = normalizeInteractiveRoundRecap({
    round_index: 2,
    answer_count: 3,
    collapsed: false,
    items: [
      { question_id: 'q1', prompt: 'What kind of pace feels right?', answer_label: 'Steady' },
      { question_id: '', prompt: 'Missing id', answer_label: 'Nope' },
    ],
  });

  assert.deepEqual(recap, {
    round_index: 2,
    answer_count: 3,
    collapsed: false,
    items: [
      { question_id: 'q1', prompt: 'What kind of pace feels right?', answer_label: 'Steady' },
    ],
  });
});

