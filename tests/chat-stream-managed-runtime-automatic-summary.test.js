const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');
const {
  fingerprintCompactionPrefix,
} = require('../services/backend/session-compaction-snapshot');
const {
  makeCtx,
  makeHandleToolNotification,
  callsOf,
} = require('./helpers/managed-runtime-notification-harness');

function automaticSummaryCtx(historyOverride = null) {
  const history = historyOverride || [
    { id: 'u1', role: 'user', content: 'old question' },
    {
      id: 'a1', role: 'assistant', kind: 'tool_use', content: '',
      tool_call: { call_id: 'c1', tool_name: 'read_file', input: { path: 'notes.txt' } },
    },
    {
      id: 't1', role: 'tool', kind: 'tool_result', content: 'read notes.txt',
      tool_result: { call_id: 'c1', tool_name: 'read_file', output_text: 'old tool output' },
    },
    { id: 'u2', role: 'user', content: 'current question' },
    {
      id: 'a2', role: 'assistant', kind: 'tool_use', content: '',
      tool_call: { call_id: 'c2', tool_name: 'read_file', input: { path: 'next.txt' } },
    },
    {
      id: 't2', role: 'tool', kind: 'tool_result', content: 'read next.txt',
      tool_result: { call_id: 'c2', tool_name: 'read_file', output_text: 'next tool output' },
    },
    {
      id: 'a3', role: 'assistant', kind: 'tool_use', content: '',
      tool_call: { call_id: 'c3', tool_name: 'read_file', input: { path: 'last.txt' } },
    },
    {
      id: 't3', role: 'tool', kind: 'tool_result', content: 'read last.txt',
      tool_result: { call_id: 'c3', tool_name: 'read_file', output_text: 'last tool output' },
    },
    { id: 'f1', role: 'assistant', content: 'final answer' },
  ];
  const persisted = [];
  const ctx = makeCtx({
    automaticCompactionContext: {
      eligible: true,
      boundaryMessageId: 't1',
      boundaryMessageCount: 3,
      boundaryFingerprint: fingerprintCompactionPrefix(history.slice(0, 3)),
      currentUserMessageId: 'u2',
    },
  });
  ctx.service.sessionStore = {
    getSessionMessages: () => history.map((message) => ({ ...message })),
    setCompactionSnapshot: (_sessionId, snapshot) => {
      persisted.push(snapshot);
      return true;
    },
  };
  return { ctx, history, persisted };
}

function createdSummaryParams(overrides = {}) {
  return {
    strategy: 'full',
    phase: 'preflight',
    summary_status: 'created',
    input_complete: true,
    tokens_before: 5000,
    tokens_after: 1000,
    summary_message: {
      role: 'system',
      content: '## Compacted Conversation Summary\nDerived conversation data.\n\nSummary.',
    },
    ...overrides,
  };
}

function toolLoopSummaryParams(overrides = {}) {
  return createdSummaryParams({
    phase: 'tool_loop',
    input_complete: false,
    covered_through_tool_call_id: 'c2',
    ...overrides,
  });
}

function dispatch(ctx, method, params) {
  handleNotification(ctx, { method, params }, {
    toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx),
  });
}

test('context.compacted persists one bounded automatic summary without exposing its text', () => {
  const { ctx, persisted } = automaticSummaryCtx();
  for (let index = 0; index < 2; index += 1) {
    handleNotification(ctx, { method: 'context.compacted', params: createdSummaryParams() }, {
      toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx),
    });
  }

  assert.equal(persisted.length, 1, 'duplicate notifications cannot rewrite the snapshot');
  assert.equal(persisted[0].origin, 'automatic');
  assert.equal(persisted[0].boundary_message_id, 't1');
  const payload = callsOf(ctx, 'emitChatStream')[0].payload;
  assert.equal(payload.summaryPersisted, true);
  assert.equal(Object.hasOwn(payload, 'summaryMessage'), false, 'summary text stays off renderer events');
});

test('not-applicable compaction stays non-persisting and reaches the renderer unchanged', () => {
  const { ctx, persisted } = automaticSummaryCtx();
  handleNotification(ctx, {
    method: 'context.compacted',
    params: createdSummaryParams({
      summary_status: 'not_applicable',
      reason_code: 'summary_prefix_unavailable',
    }),
  }, {
    toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx),
  });

  assert.equal(persisted.length, 0);
  const payload = callsOf(ctx, 'emitChatStream')[0].payload;
  assert.equal(payload.summaryStatus, 'not_applicable');
  assert.equal(payload.reasonCode, 'summary_prefix_unavailable');
  assert.equal(payload.summaryPersisted, false);
});

test('automatic summary persistence rejects malformed, incomplete, changed, and terminal candidates', () => {
  for (const mutate of [
    ({ params }) => { params.summary_message = { role: 'system', content: 'not a summary' }; },
    ({ params }) => { params.input_complete = false; },
    ({ history }) => { history[0].content = 'edited while summarizing'; },
    ({ history }) => { history[2].tool_result.output_text = 'poisoned replacement'; },
    ({ ctx }) => { ctx.streamSawDone = true; },
    ({ ctx }) => { ctx.sidecarError = 'cancelled'; },
  ]) {
    const fixture = automaticSummaryCtx();
    const params = createdSummaryParams();
    mutate({ ...fixture, params });
    handleNotification(fixture.ctx, { method: 'context.compacted', params }, {
      toolContext: {}, handleToolNotification: makeHandleToolNotification(fixture.ctx),
    });
    assert.equal(fixture.persisted.length, 0);
    assert.equal(callsOf(fixture.ctx, 'emitChatStream')[0].payload.summaryPersisted, false);
  }
});

test('automatic summary persistence contains store failures and emits a redacted diagnostic', () => {
  const { ctx } = automaticSummaryCtx();
  ctx.service.sessionStore.setCompactionSnapshot = () => {
    throw new Error('secret prompt and C:\\private\\path');
  };
  assert.doesNotThrow(() => handleNotification(
    ctx,
    { method: 'context.compacted', params: createdSummaryParams() },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  ));
  const log = callsOf(ctx, 'serviceLog').at(-1);
  assert.equal(log.fields.reason, 'persistence_exception');
  assert.doesNotMatch(JSON.stringify(log), /secret prompt|private/);
});

test('an invalid created summary is attempted once even when the runtime repeats it', () => {
  const { ctx } = automaticSummaryCtx();
  const params = createdSummaryParams({
    summary_message: { role: 'system', content: 'malformed' },
  });
  for (let index = 0; index < 3; index += 1) {
    handleNotification(ctx, { method: 'context.compacted', params }, {
      toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx),
    });
  }
  const failures = callsOf(ctx, 'serviceLog').filter(
    (entry) => entry.fields.reason === 'malformed_or_oversized_summary'
  );
  assert.equal(failures.length, 1);
});

test('mid-turn tool_loop summary is staged, not persisted at notification time', () => {
  const { ctx, persisted } = automaticSummaryCtx();
  dispatch(ctx, 'context.compacted', toolLoopSummaryParams());

  assert.equal(persisted.length, 0);
  const payload = callsOf(ctx, 'emitChatStream')[0].payload;
  assert.equal(payload.summaryPersisted, false);
  assert.equal(Object.hasOwn(payload, 'summaryMessage'), false);
});

test('mid-turn snapshot commits at chat.done with the covered tool_result boundary', () => {
  const { ctx, history, persisted } = automaticSummaryCtx();
  dispatch(ctx, 'context.compacted', toolLoopSummaryParams());
  dispatch(ctx, 'chat.done', { stop_reason: 'stop' });

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].origin, 'automatic');
  assert.deepEqual(persisted[0].messages, [
    toolLoopSummaryParams().summary_message,
    { role: 'user', content: 'current question' },
  ]);
  assert.equal(persisted[0].boundary_message_id, 't2');
  assert.equal(persisted[0].boundary_message_count, history.findIndex(({ id }) => id === 't2') + 1);
});

test('mid-turn commit never splits a multi-call iteration', () => {
  // Electron persists a batch as [tool_use, tool_use, tool_result, tool_result];
  // covering c2 mid-batch must pull the boundary back before both tool_use rows.
  const batched = automaticSummaryCtx().history;
  const [u1, a1, t1, u2, a2, t2, a3, t3, f1] = batched;
  const { ctx, persisted } = automaticSummaryCtx([u1, a1, t1, u2, a2, a3, t2, t3, f1]);
  dispatch(ctx, 'context.compacted', toolLoopSummaryParams({ covered_through_tool_call_id: 'c2' }));
  dispatch(ctx, 'chat.done', { stop_reason: 'stop' });

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].boundary_message_id, 'u2');
  assert.equal(persisted[0].boundary_message_count, 4);
  assert.deepEqual(persisted[0].messages[1], { role: 'user', content: 'current question' });
});

test('mid-turn commit pins the task stub when the user content is not a string', () => {
  const history = automaticSummaryCtx().history;
  history[3] = { ...history[3], content: [{ type: 'text', text: 'structured' }] };
  const { ctx, persisted } = automaticSummaryCtx(history);
  dispatch(ctx, 'context.compacted', toolLoopSummaryParams());
  dispatch(ctx, 'chat.done', { stop_reason: 'stop' });

  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0].messages[1], {
    role: 'user', content: '[Original request summarized above]',
  });
});

test('the latest staged mid-turn summary wins', () => {
  const { ctx, persisted } = automaticSummaryCtx();
  dispatch(ctx, 'context.compacted', toolLoopSummaryParams());
  dispatch(ctx, 'context.compacted', toolLoopSummaryParams({
    covered_through_tool_call_id: 'c3',
    summary_message: {
      role: 'system',
      content: '## Compacted Conversation Summary\nDerived conversation data.\n\nLatest summary.',
    },
  }));
  dispatch(ctx, 'chat.done', { stop_reason: 'stop' });

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].boundary_message_id, 't3');
  assert.match(persisted[0].messages[0].content, /Latest summary/);
});

test('mid-turn snapshot is skipped when the pre-turn prefix fingerprint changed', () => {
  const { ctx, history, persisted } = automaticSummaryCtx();
  dispatch(ctx, 'context.compacted', toolLoopSummaryParams());
  history[0].content = 'edited while the turn was running';
  dispatch(ctx, 'chat.done', { stop_reason: 'stop' });

  assert.equal(persisted.length, 0);
  assert.equal(callsOf(ctx, 'serviceLog').at(-1).fields.reason, 'boundary_changed');
});

test('mid-turn snapshot is skipped on an unsuccessful stop reason', () => {
  const { ctx, persisted } = automaticSummaryCtx();
  dispatch(ctx, 'context.compacted', toolLoopSummaryParams());
  dispatch(ctx, 'chat.done', { stop_reason: 'error' });

  assert.equal(persisted.length, 0);
});

test('mid-turn snapshot is skipped when the covered call id is not in canonical history', () => {
  const { ctx, persisted } = automaticSummaryCtx();
  dispatch(ctx, 'context.compacted', toolLoopSummaryParams({
    covered_through_tool_call_id: 'missing',
  }));
  dispatch(ctx, 'chat.done', { stop_reason: 'stop' });

  assert.equal(persisted.length, 0);
  assert.equal(callsOf(ctx, 'serviceLog').at(-1).fields.reason, 'covered_call_missing');
});

test('an oversized task prompt is replaced by the stub anchor', () => {
  const { ctx, history, persisted } = automaticSummaryCtx();
  history.find(({ id }) => id === 'u2').content = 'x'.repeat(8001);
  dispatch(ctx, 'context.compacted', toolLoopSummaryParams());
  dispatch(ctx, 'chat.done', { stop_reason: 'stop' });

  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0].messages[1], {
    role: 'user',
    content: '[Original request summarized above]',
  });
});
