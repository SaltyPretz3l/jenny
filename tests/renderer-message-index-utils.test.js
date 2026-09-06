const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMessageRenderSignature,
  computeDerivedMessageState,
  computeMessageFingerprintList,
  renderSignatureFromFingerprints,
  computeProjectionSignature,
  computeProjectionSignatureFromFingerprints,
  computeStructureHash,
  computeTurnStructureHash,
  computeTurnTailFingerprint,
  tailFingerprint,
} = require('../renderer/chat/renderer-message-index-utils');

const {
  getLatestAssistantMessageId,
} = require('../renderer/chat/chat-message-utils');

const {
  getLatestReplyAssistantMessageId,
} = require('../renderer/chat/chat-bubble-action-utils');

/* ── helpers ── */

function msg(id, role, overrides) {
  return { id, role, content: '', status: '', kind: '', finalizedAt: null, reasoning: null, ...overrides };
}

function assistantMsg(id, overrides) {
  return msg(id, 'assistant', { status: 'complete', ...overrides });
}

function userMsg(id, overrides) {
  return msg(id, 'user', overrides);
}

function thinkingPredicate(message) {
  return (
    message &&
    message.role === 'assistant' &&
    message.reasoning &&
    Array.isArray(message.reasoning.entries) &&
    message.reasoning.entries.length > 0 &&
    String(message.reasoning.source || '') === 'provider'
  );
}

/* ── computeDerivedMessageState ── */

test('computeDerivedMessageState returns empty defaults for empty array', () => {
  const result = computeDerivedMessageState([]);
  assert.equal(result.latestAssistantMessageId, '');
  assert.equal(result.latestReplyAssistantMessageId, '');
  assert.deepEqual(result.thinkingMessageIds, []);
  assert.equal(result.streamingMessage, null);
  assert.equal(result.idToIndex.size, 0);
});

test('computeDerivedMessageState returns empty defaults for non-array input', () => {
  const result = computeDerivedMessageState(null);
  assert.equal(result.latestAssistantMessageId, '');
  assert.equal(result.latestReplyAssistantMessageId, '');
});

test('computeDerivedMessageState finds latestAssistantMessageId from backward scan', () => {
  const messages = [
    userMsg('u1'),
    assistantMsg('a1'),
    userMsg('u2'),
    assistantMsg('a2'),
  ];
  const result = computeDerivedMessageState(messages);
  assert.equal(result.latestAssistantMessageId, 'a2');
  assert.equal(getLatestAssistantMessageId(messages), 'a2');
});

test('computeDerivedMessageState skips interactive_round_recap for latestAssistantMessageId', () => {
  const messages = [
    userMsg('u1'),
    assistantMsg('a1'),
    assistantMsg('recap', { kind: 'interactive_round_recap' }),
  ];
  const result = computeDerivedMessageState(messages);
  assert.equal(result.latestAssistantMessageId, 'a1');
  assert.equal(getLatestAssistantMessageId(messages), 'a1');
});

test('computeDerivedMessageState skips slash_command_output for latestAssistantMessageId', () => {
  const messages = [
    userMsg('u1'),
    assistantMsg('a1'),
    assistantMsg('slash1', { kind: 'slash_command_output' }),
  ];
  const result = computeDerivedMessageState(messages);
  assert.equal(result.latestAssistantMessageId, 'a1');
  assert.equal(getLatestAssistantMessageId(messages), 'a1');
});

test('computeDerivedMessageState finds latestReplyAssistantMessageId for complete messages', () => {
  const messages = [
    userMsg('u1'),
    assistantMsg('a1'),
    userMsg('u2'),
    assistantMsg('a2', { status: 'streaming' }),
  ];
  const result = computeDerivedMessageState(messages);
  assert.equal(result.latestReplyAssistantMessageId, 'a1');
  assert.equal(getLatestReplyAssistantMessageId(messages), 'a1');
});

test('computeDerivedMessageState skips non-reply kinds for latestReplyAssistantMessageId', () => {
  const nonReplyKinds = [
    'interactive_round_recap',
    'proactive_suggestion',
    'question_batch',
    'slash_command_output',
    'tool_use',
  ];
  for (const kind of nonReplyKinds) {
    const messages = [
      userMsg('u1'),
      assistantMsg('a1'),
      assistantMsg(`special_${kind}`, { kind }),
    ];
    const result = computeDerivedMessageState(messages);
    assert.equal(result.latestReplyAssistantMessageId, 'a1',
      `should skip kind=${kind}`);
    assert.equal(getLatestReplyAssistantMessageId(messages), 'a1',
      `cross-check failed for kind=${kind}`);
  }
});

test('computeDerivedMessageState detects streaming message correctly', () => {
  const messages = [
    userMsg('u1'),
    assistantMsg('a1', { status: 'streaming' }),
  ];
  const result = computeDerivedMessageState(messages);
  assert.equal(result.streamingMessage, messages[1]);
  assert.equal(result.latestAssistantMessageId, 'a1');
});

test('computeDerivedMessageState returns null streamingMessage for non-streaming latest', () => {
  const messages = [
    userMsg('u1'),
    assistantMsg('a1'),
  ];
  const result = computeDerivedMessageState(messages);
  assert.equal(result.streamingMessage, null);
});

test('computeDerivedMessageState returns null streamingMessage for ineligible streaming kinds', () => {
  for (const kind of ['question_batch', 'interactive_round_recap', 'slash_command_output']) {
    const messages = [
      userMsg('u1'),
      assistantMsg('a1', { status: 'streaming', kind }),
    ];
    const result = computeDerivedMessageState(messages);
    assert.equal(result.streamingMessage, null, `should not detect streaming for kind=${kind}`);
  }
});

test('computeDerivedMessageState collects thinking message ids in forward order', () => {
  const messages = [
    userMsg('u1'),
    assistantMsg('a1', {
      reasoning: { source: 'provider', entries: [{ text: 'thinking...' }] },
    }),
    userMsg('u2'),
    assistantMsg('a2', {
      reasoning: { source: 'provider', entries: [{ text: 'more thinking' }] },
    }),
    assistantMsg('a3'),
  ];
  const result = computeDerivedMessageState(messages, {
    shouldShowThinkingToggle: thinkingPredicate,
  });
  assert.deepEqual(result.thinkingMessageIds, ['a1', 'a2']);
});

test('computeDerivedMessageState excludes non-provider reasoning from thinking ids', () => {
  const messages = [
    userMsg('u1'),
    assistantMsg('a1', {
      reasoning: { source: 'none', entries: [{ text: 'internal' }] },
    }),
  ];
  const result = computeDerivedMessageState(messages, {
    shouldShowThinkingToggle: thinkingPredicate,
  });
  assert.deepEqual(result.thinkingMessageIds, []);
});

test('computeDerivedMessageState builds correct idToIndex map', () => {
  const messages = [
    userMsg('u1'),
    assistantMsg('a1'),
    userMsg('u2'),
    assistantMsg('a2'),
  ];
  const result = computeDerivedMessageState(messages);
  assert.equal(result.idToIndex.get('u1'), 0);
  assert.equal(result.idToIndex.get('a1'), 1);
  assert.equal(result.idToIndex.get('u2'), 2);
  assert.equal(result.idToIndex.get('a2'), 3);
  assert.equal(result.idToIndex.size, 4);
});

test('computeDerivedMessageState handles single user message', () => {
  const messages = [userMsg('u1', { content: 'hello' })];
  const result = computeDerivedMessageState(messages);
  assert.equal(result.latestAssistantMessageId, '');
  assert.equal(result.latestReplyAssistantMessageId, '');
  assert.equal(result.streamingMessage, null);
  assert.equal(result.idToIndex.get('u1'), 0);
});

test('computeDerivedMessageState cross-validates with individual functions for mixed transcript', () => {
  const messages = [
    userMsg('u1', { content: 'hello' }),
    assistantMsg('a1', { content: 'hi there' }),
    assistantMsg('tool1', { kind: 'tool_use', status: 'complete' }),
    msg('result1', 'tool', { kind: 'tool_result' }),
    assistantMsg('a2', { content: 'done', status: 'complete' }),
    userMsg('u2', { content: 'thanks' }),
    assistantMsg('a3', { status: 'streaming', content: 'let me...' }),
  ];
  const result = computeDerivedMessageState(messages);
  assert.equal(result.latestAssistantMessageId, getLatestAssistantMessageId(messages));
  assert.equal(result.latestReplyAssistantMessageId, getLatestReplyAssistantMessageId(messages));
  assert.equal(result.streamingMessage, messages[6]);
  assert.equal(result.idToIndex.get('tool1'), 2);
  assert.equal(result.idToIndex.get('result1'), 3);
});

test('computeDerivedMessageState works without shouldShowThinkingToggle option', () => {
  const messages = [
    userMsg('u1'),
    assistantMsg('a1', {
      reasoning: { source: 'provider', entries: [{ text: 'thinking' }] },
    }),
  ];
  const result = computeDerivedMessageState(messages);
  assert.deepEqual(result.thinkingMessageIds, []);
});

test('computeDerivedMessageState handles assistant with defaulted status (empty string)', () => {
  const messages = [
    userMsg('u1'),
    msg('a1', 'assistant', { content: 'reply' }),
  ];
  const result = computeDerivedMessageState(messages);
  // Empty status on assistant defaults to 'complete' per normalizeMessageStatus logic.
  assert.equal(result.latestReplyAssistantMessageId, 'a1');
  assert.equal(getLatestReplyAssistantMessageId(messages), 'a1');
});

/* ── computeStructureHash ── */

test('computeStructureHash returns stable output for same input', () => {
  const messages = [
    userMsg('u1'),
    assistantMsg('a1'),
  ];
  const hash1 = computeStructureHash(messages);
  const hash2 = computeStructureHash(messages);
  assert.equal(hash1, hash2);
  assert.equal(typeof hash1, 'number');
});

test('computeStructureHash returns 5381 seed for empty array', () => {
  // djb2 seed with no input should still be stable
  const hash = computeStructureHash([]);
  assert.equal(typeof hash, 'number');
  assert.equal(computeStructureHash([]), hash);
});

test('computeStructureHash changes when message status changes', () => {
  const base = [userMsg('u1'), assistantMsg('a1', { status: 'streaming' })];
  const after = [userMsg('u1'), assistantMsg('a1', { status: 'complete' })];
  assert.notEqual(computeStructureHash(base), computeStructureHash(after));
});

test('computeStructureHash changes when message is added', () => {
  const base = [userMsg('u1'), assistantMsg('a1')];
  const extended = [...base, userMsg('u2')];
  assert.notEqual(computeStructureHash(base), computeStructureHash(extended));
});

test('computeStructureHash unchanged when only content changes', () => {
  const before = [userMsg('u1', { content: 'hello' }), assistantMsg('a1', { content: 'hi' })];
  const after = [userMsg('u1', { content: 'goodbye' }), assistantMsg('a1', { content: 'bye' })];
  assert.equal(computeStructureHash(before), computeStructureHash(after));
});

test('computeStructureHash changes when finalizedAt changes', () => {
  const before = [assistantMsg('a1', { finalizedAt: null })];
  const after = [assistantMsg('a1', { finalizedAt: '2026-03-19T12:00:00Z' })];
  assert.notEqual(computeStructureHash(before), computeStructureHash(after));
});

test('computeStructureHash changes when reasoning appears', () => {
  const before = [assistantMsg('a1')];
  const after = [assistantMsg('a1', {
    reasoning: { source: 'provider', entries: [{ text: 'thinking' }] },
  })];
  assert.notEqual(computeStructureHash(before), computeStructureHash(after));
});

test('computeStructureHash unchanged when reasoning text changes but source stays', () => {
  const before = [assistantMsg('a1', {
    reasoning: { source: 'provider', entries: [{ text: 'v1' }] },
  })];
  const after = [assistantMsg('a1', {
    reasoning: { source: 'provider', entries: [{ text: 'v2 much longer' }] },
  })];
  // Both have hasReasoning=true so hash should be the same
  assert.equal(computeStructureHash(before), computeStructureHash(after));
});

test('computeStructureHash changes when reasoning phase metadata changes without a phase-count change', () => {
  const before = [assistantMsg('a1', {
    reasoning: { source: 'provider', entries: [{ text: 'thinking' }] },
    reasoning_phases: [
      {
        phaseId: 'phase_1',
        phaseKind: 'reasoning',
        iteration: 1,
        thinkingId: 'think_1',
        renderCollapsed: false,
        completed: true,
      },
    ],
  })];
  const after = [assistantMsg('a1', {
    reasoning: { source: 'provider', entries: [{ text: 'thinking' }] },
    reasoning_phases: [
      {
        phaseId: 'phase_1',
        phaseKind: 'reasoning',
        iteration: 1,
        thinkingId: 'think_1',
        renderCollapsed: true,
        completed: true,
      },
    ],
  })];

  assert.notEqual(computeStructureHash(before), computeStructureHash(after));
});

test('computeStructureHash handles null/undefined messages gracefully', () => {
  assert.equal(typeof computeStructureHash(null), 'number');
  assert.equal(typeof computeStructureHash(undefined), 'number');
});

/* ── projection signatures ── */

test('buildMessageRenderSignature changes when assistant content changes without a structural change', () => {
  const before = [assistantMsg('a1', { content: 'draft' })];
  const after = [assistantMsg('a1', { content: 'final' })];
  assert.notEqual(buildMessageRenderSignature(before), buildMessageRenderSignature(after));
});

test('buildMessageRenderSignature changes when reasoning phase summary changes', () => {
  const before = [assistantMsg('a1', {
    reasoning_phases: [{ phaseId: 'phase_1', phaseKind: 'reasoning', thinkingId: 'think_1', summary: 'Reading context' }],
  })];
  const after = [assistantMsg('a1', {
    reasoning_phases: [{ phaseId: 'phase_1', phaseKind: 'reasoning', thinkingId: 'think_1', summary: 'Synthesizing answer' }],
  })];
  assert.notEqual(buildMessageRenderSignature(before), buildMessageRenderSignature(after));
});

test('computeProjectionSignature changes when reasoning entry text changes', () => {
  const before = [assistantMsg('a1', {
    reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'plan A', timestamp: '2026-03-19T12:00:00Z' }] },
  })];
  const after = [assistantMsg('a1', {
    reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'plan B', timestamp: '2026-03-19T12:00:00Z' }] },
  })];
  assert.notEqual(computeProjectionSignature(before), computeProjectionSignature(after));
});

test('computeProjectionSignature changes when tool_result output changes', () => {
  const before = [msg('tool_result_1', 'tool', {
    kind: 'tool_result',
    tool_result: {
      call_id: 'call_1',
      tool_name: 'Read',
      summary: 'Read complete',
      output_text: 'alpha',
    },
  })];
  const after = [msg('tool_result_1', 'tool', {
    kind: 'tool_result',
    tool_result: {
      call_id: 'call_1',
      tool_name: 'Read',
      summary: 'Read complete',
      output_text: 'beta',
    },
  })];
  assert.notEqual(computeProjectionSignature(before), computeProjectionSignature(after));
});

/* ── shared fingerprint list (findings #1/#2) ── */

test('computeProjectionSignature changes when a streaming message gains a new visible segment', () => {
  const before = [assistantMsg('a1', {
    status: 'streaming',
    content: 'Hello',
    visible_segments: [{ segment_id: 'seg0', text: 'Hello' }],
  })];
  const after = [assistantMsg('a1', {
    status: 'streaming',
    content: 'Hello',
    visible_segments: [{ segment_id: 'seg0', text: 'Hello' }, { segment_id: 'seg1', text: 'next' }],
  })];
  assert.notEqual(computeProjectionSignature(before), computeProjectionSignature(after));
});

test('computeProjectionSignature changes when a streaming message settles to complete', () => {
  const streaming = [assistantMsg('a1', {
    status: 'streaming',
    content: 'Hello world',
    visible_segments: [{ segment_id: 'seg0', text: 'Hello world' }],
  })];
  const settled = [assistantMsg('a1', {
    status: 'complete',
    content: 'Hello world',
    visible_segments: [{ segment_id: 'seg0', text: 'Hello world' }],
  })];
  assert.notEqual(computeProjectionSignature(streaming), computeProjectionSignature(settled));
});

test('settled message content change still invalidates the projection signature', () => {
  // Settled messages hash their full content fingerprint so a late
  // tool-result/edit update is never masked by the per-message fingerprint cache.
  const before = [msg('tool_result_1', 'tool', {
    kind: 'tool_result',
    status: 'complete',
    tool_result: { call_id: 'c1', tool_name: 'Read', output_text: 'alpha', summary: 's' },
  })];
  const after = [msg('tool_result_1', 'tool', {
    kind: 'tool_result',
    status: 'complete',
    tool_result: { call_id: 'c1', tool_name: 'Read', output_text: 'beta', summary: 's' },
  })];
  assert.notEqual(computeProjectionSignature(before), computeProjectionSignature(after));
});

test('computeMessageFingerprintList returns the same cached entry for an unchanged settled message object', () => {
  const m = assistantMsg('a1', { content: 'stable' });
  const first = computeMessageFingerprintList([m])[0];
  const second = computeMessageFingerprintList([m])[0];
  assert.equal(first, second);
});

test('computeMessageFingerprintList recomputes when a settled message content length changes', () => {
  const m = assistantMsg('a1', { content: 'short' });
  const first = computeMessageFingerprintList([m])[0];
  m.content = 'a noticeably longer body';
  const second = computeMessageFingerprintList([m])[0];
  assert.notEqual(first, second);
  assert.notEqual(first.content, second.content);
});

test('renderSignatureFromFingerprints matches the fixed-size message render signature', () => {
  const messages = [
    userMsg('u1', { content: 'hi' }),
    assistantMsg('a1', { content: 'hello' }),
    assistantMsg('a2', { status: 'streaming', content: 'streaming...' }),
  ];
  assert.equal(
    renderSignatureFromFingerprints(computeMessageFingerprintList(messages)),
    buildMessageRenderSignature(messages)
  );
});

test('computeMessageFingerprintList detects a same-object same-length compatibility mutation', () => {
  const message = assistantMsg('a-same-length', { content: 'a'.repeat(100) });
  const first = computeMessageFingerprintList([message])[0];
  message.content = `${'a'.repeat(30)}b${'a'.repeat(69)}`;
  const second = computeMessageFingerprintList([message])[0];
  assert.notEqual(second, first);
  assert.notEqual(second.content, first.content);
});

test('message render signatures stay fixed-size as transcript content grows', () => {
  const small = [assistantMsg('a-small', { content: 'x' })];
  const large = [assistantMsg('a-large', { content: 'x'.repeat(2_000_000) })];
  assert.ok(buildMessageRenderSignature(small).length <= 32);
  assert.ok(buildMessageRenderSignature(large).length <= 32);
});

test('replacing one streaming message reuses every settled fingerprint entry', () => {
  const settled = Array.from({ length: 200 }, (_, index) => (
    assistantMsg(`settled-${index}`, { content: 'stable'.repeat(100) })
  ));
  const active = assistantMsg('active', { status: 'streaming', content: 'A'.repeat(500_000) });
  const first = computeMessageFingerprintList([...settled, active]);
  const second = computeMessageFingerprintList([
    ...settled,
    { ...active, content: `${active.content}B` },
  ]);
  for (let index = 0; index < settled.length; index += 1) {
    assert.equal(second[index], first[index]);
  }
  assert.notEqual(second.at(-1), first.at(-1));
  assert.ok(second.at(-1).content.length <= 16);
});

test('an equal-content object replacement inherits the projection fingerprint but advances the render revision', () => {
  // Hydration and reconcile replace message objects wholesale with
  // equal-content copies; the replacement must not mint a new PROJECTION
  // revision or the per-turn projection caches invalidate on every rehydrate.
  // The RENDER revision is per object: replacement is deliberately
  // authoritative for the render no-op guard (settled-refresh / CTL-012 pins).
  const original = assistantMsg('hydrated-1', { content: 'stable body', status: 'complete' });
  const first = computeMessageFingerprintList([original])[0];
  const copy = JSON.parse(JSON.stringify(original));
  const second = computeMessageFingerprintList([copy])[0];
  assert.equal(second.content, first.content);
  assert.equal(
    computeProjectionSignatureFromFingerprints([copy].map((m) => computeMessageFingerprintList([m])[0])),
    computeProjectionSignatureFromFingerprints([first])
  );
  assert.notEqual(
    renderSignatureFromFingerprints([second]),
    renderSignatureFromFingerprints([first]),
    'replacement objects must advance the render revision'
  );
});

test('a replacement carrying only a tool_result.metadata.monitor change mints a new projection fingerprint', () => {
  const monitorMessage = (progress) => msg('monitor_fp_1', 'tool', {
    kind: 'tool_result',
    status: 'complete',
    tool_result: {
      call_id: 'c1', tool_name: 'run_command', status: 'completed',
      metadata: { monitor: { progress, note: 'background job' } },
    },
  });
  const first = computeMessageFingerprintList([monitorMessage(0.2)])[0];
  const second = computeMessageFingerprintList([monitorMessage(0.9)])[0];
  assert.notEqual(second.content, first.content);
});

test('a same-object in-place monitor progress update invalidates the fingerprint', () => {
  const message = msg('monitor_fp_2', 'tool', {
    kind: 'tool_result',
    status: 'complete',
    tool_result: {
      call_id: 'c2', tool_name: 'run_command', status: 'completed',
      metadata: { monitor: { progress: 0.1 } },
    },
  });
  const first = computeMessageFingerprintList([message])[0];
  message.tool_result.metadata.monitor.progress = 0.8;
  const second = computeMessageFingerprintList([message])[0];
  assert.notEqual(second.content, first.content);
});

test('a replacement carrying only generated-artifact name/path changes mints a new projection fingerprint', () => {
  const artifactMessage = (name) => msg('artifact_fp_1', 'tool', {
    kind: 'tool_result',
    status: 'complete',
    tool_result: {
      call_id: 'c3', tool_name: 'create_artifact', status: 'completed',
      generated_artifacts: [{ name, path: `C:/artifacts/${name}` }],
    },
  });
  const first = computeMessageFingerprintList([artifactMessage('draft-v1.html')])[0];
  const second = computeMessageFingerprintList([artifactMessage('draft-v2.html')])[0];
  assert.notEqual(second.content, first.content);
});

test('a content-changed object replacement still mints a new fingerprint', () => {
  const original = assistantMsg('hydrated-2', { content: 'before edit', status: 'complete' });
  const first = computeMessageFingerprintList([original])[0];
  const copy = { ...JSON.parse(JSON.stringify(original)), content: 'after edit' };
  const second = computeMessageFingerprintList([copy])[0];
  assert.notEqual(second, first);
  assert.notEqual(second.content, first.content);
});

test('computeProjectionSignatureFromFingerprints matches computeProjectionSignature', () => {
  const messages = [
    userMsg('u1', { content: 'hi' }),
    assistantMsg('a1', { content: 'hello' }),
    assistantMsg('a2', { status: 'streaming', content: 'streaming...' }),
  ];
  assert.equal(
    computeProjectionSignatureFromFingerprints(computeMessageFingerprintList(messages)),
    computeProjectionSignature(messages)
  );
});

/* ── turn-local fast path helpers ── */

test('computeProjectionSignature changes when generated artifact metadata changes with the same artifact count', () => {
  const before = [msg('tool_result_1', 'tool', {
    kind: 'tool_result',
    tool_result: {
      call_id: 'call_1',
      tool_name: 'CreateArtifact',
      summary: 'Created plan',
      generated_artifacts: [{
        artifact_id: 'artifact_plan',
        artifact_kind: 'document',
        title: 'Plan A',
        file_name: 'plan.md',
        display_path: '.jenny/artifacts/session-1/plan.md',
        absolute_path: 'C:/workspace/.jenny/artifacts/session-1/plan.md',
        language: 'markdown',
        editable: true,
        status: 'available',
      }],
    },
  })];
  const after = [msg('tool_result_1', 'tool', {
    kind: 'tool_result',
    tool_result: {
      call_id: 'call_1',
      tool_name: 'CreateArtifact',
      summary: 'Created plan',
      generated_artifacts: [{
        artifact_id: 'artifact_plan',
        artifact_kind: 'document',
        title: 'Plan B',
        file_name: 'plan.md',
        display_path: '.jenny/artifacts/session-1/plan.md',
        absolute_path: 'C:/workspace/.jenny/artifacts/session-1/plan.md',
        language: 'markdown',
        editable: true,
        status: 'available',
      }],
    },
  })];
  assert.notEqual(computeProjectionSignature(before), computeProjectionSignature(after));
});

test('computeTurnStructureHash is stable for the same turn and rows', () => {
  const turnMeta = {
    turn_id: 'turn_1',
    primary_user_message_id: 'u1',
    primary_assistant_message_id: 'a1',
    source_message_ids: ['u1', 'a1', 'tool_use_1'],
  };
  const rows = [
    {
      kind: 'assistant_text',
      row_id: 'row:assistant_text',
      primary_message_id: 'a1',
      source_message_ids: ['a1'],
      source_events: ['turn_1:assistant_text_segment:0'],
      first_event_sort_key: [1, 0, 30],
      assistant_phase: 'commentary',
      payload: { text: 'Planning...' },
    },
    {
      kind: 'tool_step',
      row_id: 'row:tool_use',
      primary_message_id: 'tool_use_1',
      source_message_ids: ['tool_use_1', 'tool_result_1'],
      source_events: ['turn_1:tool_use:0', 'turn_1:tool_result:0'],
      first_event_sort_key: [2, 0, 40],
      tool_call_id: 'call_1',
      payload: { state: 'completed', result_summary: 'Done.' },
    },
  ];
  assert.equal(computeTurnStructureHash(turnMeta, rows), computeTurnStructureHash(turnMeta, rows));
});

test('computeTurnStructureHash changes when row order changes within a turn', () => {
  const turnMeta = {
    turn_id: 'turn_1',
    primary_user_message_id: 'u1',
    primary_assistant_message_id: 'a1',
    source_message_ids: ['u1', 'a1', 'tool_use_1'],
  };
  const baseRows = [
    {
      kind: 'assistant_text',
      row_id: 'row:assistant_text',
      primary_message_id: 'a1',
      source_message_ids: ['a1'],
      source_events: ['turn_1:assistant_text_segment:0'],
      first_event_sort_key: [1, 0, 30],
      payload: { text: 'Planning...' },
    },
    {
      kind: 'tool_step',
      row_id: 'row:tool_use',
      primary_message_id: 'tool_use_1',
      source_message_ids: ['tool_use_1'],
      source_events: ['turn_1:tool_use:0'],
      first_event_sort_key: [2, 0, 40],
      tool_call_id: 'call_1',
      payload: { state: 'running' },
    },
  ];
  const reorderedRows = [baseRows[1], baseRows[0]];
  assert.notEqual(computeTurnStructureHash(turnMeta, baseRows), computeTurnStructureHash(turnMeta, reorderedRows));
});

test('computeTurnTailFingerprint stays stable when only tail row text changes', () => {
  const turnMeta = {
    turn_id: 'turn_1',
    primary_user_message_id: 'u1',
    primary_assistant_message_id: 'a1',
    source_message_ids: ['u1', 'a1'],
  };
  const beforeRows = [
    {
      kind: 'assistant_text',
      row_id: 'row:assistant_text',
      primary_message_id: 'a1',
      source_message_ids: ['a1'],
      source_events: ['turn_1:assistant_text_segment:0'],
      first_event_sort_key: [1, 0, 30],
      payload: { text: 'draft answer' },
    },
  ];
  const afterRows = [
    {
      kind: 'assistant_text',
      row_id: 'row:assistant_text',
      primary_message_id: 'a1',
      source_message_ids: ['a1'],
      source_events: ['turn_1:assistant_text_segment:0'],
      first_event_sort_key: [1, 0, 30],
      payload: { text: 'final answer' },
    },
  ];
  assert.equal(computeTurnTailFingerprint(turnMeta, beforeRows), computeTurnTailFingerprint(turnMeta, afterRows));
});

/* ── tailFingerprint ── */

test('computeTurnTailFingerprint changes when a non-tail row render fingerprint changes', () => {
  const turnMeta = {
    turn_id: 'turn_1',
    primary_user_message_id: 'u1',
    primary_assistant_message_id: 'a1',
    source_message_ids: ['u1', 'a1', 'tool_use_1', 'tool_result_1'],
  };
  const beforeRows = [
    {
      kind: 'assistant_text',
      row_id: 'row:assistant_text',
      primary_message_id: 'a1',
      source_message_ids: ['a1'],
      source_events: ['turn_1:assistant_text_segment:0'],
      first_event_sort_key: [1, 0, 30],
      projection_fingerprint: 'assistant:before',
      payload: { text: 'Working through it.' },
    },
    {
      kind: 'tool_step',
      row_id: 'row:tool_use',
      primary_message_id: 'tool_use_1',
      source_message_ids: ['tool_use_1', 'tool_result_1'],
      source_events: ['turn_1:tool_use:0', 'turn_1:tool_result:0'],
      first_event_sort_key: [2, 0, 40],
      tool_call_id: 'call_1',
      projection_fingerprint: 'tool:before',
      payload: { state: 'completed', result_summary: 'Read package.json' },
    },
  ];
  const afterRows = [
    {
      ...beforeRows[0],
      projection_fingerprint: 'assistant:after',
    },
    beforeRows[1],
  ];
  assert.notEqual(computeTurnTailFingerprint(turnMeta, beforeRows), computeTurnTailFingerprint(turnMeta, afterRows));
});

test('computeTurnTailFingerprint changes when projected tool-result metadata changes without a row-shape change', () => {
  const turnMeta = {
    turn_id: 'turn_1',
    primary_user_message_id: 'u1',
    primary_assistant_message_id: 'a1',
    source_message_ids: ['u1', 'tool_use_1', 'tool_result_1'],
  };
  const beforeRows = [
    {
      kind: 'tool_step',
      row_id: 'row:tool_use',
      primary_message_id: 'tool_use_1',
      source_message_ids: ['tool_use_1', 'tool_result_1'],
      source_events: ['turn_1:tool_use:0', 'turn_1:tool_result:0'],
      first_event_sort_key: [2, 0, 40],
      tool_call_id: 'call_1',
      projection_fingerprint: 'tool:artifacts=0',
      payload: {
        state: 'completed',
        result_summary: 'Rendered artifact shell',
        output_text: 'done',
      },
    },
  ];
  const afterRows = [
    {
      ...beforeRows[0],
      projection_fingerprint: 'tool:artifacts=1',
    },
  ];
  assert.notEqual(computeTurnTailFingerprint(turnMeta, beforeRows), computeTurnTailFingerprint(turnMeta, afterRows));
});

test('tailFingerprint returns empty string for null', () => {
  assert.equal(tailFingerprint(null), '');
  assert.equal(tailFingerprint(undefined), '');
});

test('tailFingerprint produces colon-separated fields', () => {
  const fp = tailFingerprint(assistantMsg('a1', { kind: 'tool_use', finalizedAt: '2026-03-19T12:00:00Z' }));
  assert.equal(fp, 'a1:assistant:tool_use:complete:2026-03-19T12:00:00Z::');
});

test('tailFingerprint includes reasoning flag', () => {
  const fp = tailFingerprint(assistantMsg('a1', {
    reasoning: { source: 'provider', entries: [{ text: 'thinking' }] },
  }));
  assert.ok(fp.endsWith(':R'));
});

test('tailFingerprint changes when reasoning phase metadata changes without a phase-count change', () => {
  const before = tailFingerprint(assistantMsg('a1', {
    reasoning: { source: 'provider', entries: [{ text: 'thinking' }] },
    reasoning_phases: [
      {
        phaseId: 'phase_1',
        phaseKind: 'reasoning',
        iteration: 1,
        thinkingId: 'think_1',
        renderCollapsed: false,
        completed: true,
      },
    ],
  }));
  const after = tailFingerprint(assistantMsg('a1', {
    reasoning: { source: 'provider', entries: [{ text: 'thinking' }] },
    reasoning_phases: [
      {
        phaseId: 'phase_1',
        phaseKind: 'reasoning',
        iteration: 1,
        thinkingId: 'think_1',
        renderCollapsed: true,
        completed: true,
      },
    ],
  }));

  assert.notEqual(before, after);
});

test('tailFingerprint changes when status changes', () => {
  const fp1 = tailFingerprint(assistantMsg('a1', { status: 'streaming' }));
  const fp2 = tailFingerprint(assistantMsg('a1', { status: 'complete' }));
  assert.notEqual(fp1, fp2);
});

test('tailFingerprint changes when finalizedAt changes', () => {
  const fp1 = tailFingerprint(assistantMsg('a1'));
  const fp2 = tailFingerprint(assistantMsg('a1', { finalizedAt: '2026-03-19T12:00:00Z' }));
  assert.notEqual(fp1, fp2);
});

test('tailFingerprint is stable for same message', () => {
  const m = assistantMsg('a1', { finalizedAt: '2026-03-19T12:00:00Z' });
  assert.equal(tailFingerprint(m), tailFingerprint(m));
});

/* ── B8: structure/projection signature invariant ── */

test('B8 invariant: streaming content changes the projection signature but not the structure hash', () => {
  // Two streaming assistant messages identical in every structural field, differing
  // ONLY in content (a large delta so djb2 actually diverges). computeStructureHash
  // excludes raw content (so the timeline does not reflow on every token), while
  // computeProjectionSignature includes it (so streamed text still re-renders).
  const before = [assistantMsg('a1', { status: 'streaming', content: 'A'.repeat(50) })];
  const after = [assistantMsg('a1', { status: 'streaming', content: 'B'.repeat(50) })];

  assert.equal(
    computeStructureHash(before),
    computeStructureHash(after),
    'structure hash must be content-invariant',
  );
  assert.notEqual(
    computeProjectionSignature(before),
    computeProjectionSignature(after),
    'projection signature must diverge on streamed content',
  );
});

test('B8 invariant: a STREAMING_INELIGIBLE_KIND latest message is never picked as the streaming message', () => {
  // question_batch is a streaming-ineligible kind: even as the latest streaming
  // assistant message it must not be detected as the live streaming message
  // (asserted via behavior — the set is intentionally not exported).
  const ineligible = [
    userMsg('u1', { content: 'plan my week' }),
    assistantMsg('a1', { status: 'complete', content: 'Here is a plan.' }),
    assistantMsg('qb1', { status: 'streaming', kind: 'question_batch', content: 'One quick question.' }),
  ];
  assert.equal(
    computeDerivedMessageState(ineligible).streamingMessage,
    null,
    'an ineligible-kind latest message must not be the streaming message',
  );

  // Control: a plain assistant_text streaming message IS detected.
  const eligible = [
    userMsg('u2', { content: 'hello' }),
    assistantMsg('a2', { status: 'streaming', content: 'streaming reply' }),
  ];
  const derived = computeDerivedMessageState(eligible);
  assert.ok(derived.streamingMessage, 'an eligible streaming assistant message must be detected');
  assert.equal(derived.streamingMessage.id, 'a2');
});

test('SP-19: durability state changes invalidate a settled message projection', () => {
  const durable = [assistantMsg('assistant_1', { content: 'same reply' })];
  const unsaved = [assistantMsg('assistant_1', {
    content: 'same reply',
    durability: { state: 'unsaved', reason: 'write_failed', scope: 'assistant' },
  })];

  assert.notEqual(
    computeProjectionSignature(durable),
    computeProjectionSignature(unsaved),
    'the renderer must repaint when only the durability badge state changes'
  );
});

test('in-place tool_step status transition invalidates the render signature', () => {
  const message = assistantMsg('assistant_1', {
    content: 'running a tool',
    tool_steps: [{ callId: 'call_1', toolName: 'Read', status: 'running', toolResultMessageId: '' }],
  });
  const before = buildMessageRenderSignature([message]);
  message.tool_steps[0].status = 'completed';
  message.tool_steps[0].toolResultMessageId = 'tool_result_1';
  const after = buildMessageRenderSignature([message]);
  assert.notEqual(before, after,
    'a same-object tool step status transition must repaint the tool card');
});

test('in-place agent_status lifecycle transition invalidates the render signature', () => {
  const message = assistantMsg('assistant_1', {
    content: 'agent working',
    agent_status: { taskId: 'task_1', status: 'running', stage: 'scan', percent: 10, terminal: false },
  });
  const before = buildMessageRenderSignature([message]);
  message.agent_status.status = 'done';
  message.agent_status.stage = 'complete';
  message.agent_status.percent = 100;
  message.agent_status.terminal = true;
  const after = buildMessageRenderSignature([message]);
  assert.notEqual(before, after,
    'a same-object agent status transition must repaint the status card');
});

test('canonical agent progress snapshots hash transitions and identity safely', () => {
  const progress = {
    taskId: 'subagent_run:req:call', agentId: 'research@req:call:1', parentAgentId: 'main@req',
    status: 'running', stage: 'researching', percent: 50, terminal: false, success: false,
  };
  const message = assistantMsg('assistant_progress_1', {
    content: 'agent complete', agent_progress_snapshot: [progress],
  });
  const before = buildMessageRenderSignature([message]);
  Object.assign(progress, { status: 'completed', percent: 100, terminal: true, success: true });
  assert.notEqual(before, buildMessageRenderSignature([message]),
    'a same-object canonical progress array transition must repaint the durable status');
  for (const field of ['taskId', 'agentId', 'parentAgentId']) {
    const identityMessage = assistantMsg(`assistant_progress_identity_${field}`, {
      content: 'agent complete',
      agent_progress_snapshot: [
        { taskId: 'task-1', agentId: 'research@req:call:1', parentAgentId: 'main@req' },
        { taskId: 'task-2', agentId: 'research@req:call:2', parentAgentId: 'main@req' },
      ],
    });
    const identityBefore = buildMessageRenderSignature([identityMessage]);
    identityMessage.agent_progress_snapshot[1][field] += ':changed';
    assert.notEqual(identityBefore, buildMessageRenderSignature([identityMessage]));
  }
  for (const snapshot of [null, 'legacy', 42, { taskId: 'legacy-task' }, [null, 'bad', [], { futureShape: true }]]) {
    const legacyMessage = assistantMsg('assistant_progress_legacy', {
      content: 'agent complete', agent_progress_snapshot: snapshot,
    });
    assert.doesNotThrow(() => buildMessageRenderSignature([legacyMessage]));
  }
});

test('in-place tool_result error transition invalidates the render signature', () => {
  const message = assistantMsg('assistant_1', {
    kind: 'tool_result',
    tool_result: { call_id: 'call_1', tool_name: 'Read', status: 'complete', output_text: 'partial' },
  });
  const before = buildMessageRenderSignature([message]);
  message.tool_result.is_error = true;
  message.tool_result.error_code = 'CMP_TOOL_IO_FAILED';
  const after = buildMessageRenderSignature([message]);
  assert.notEqual(before, after,
    'a same-object tool result error transition must repaint the result row');
});
