const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTranscriptThreadTree,
  collectThreadBranchIds,
  shouldShowThreadToggle,
} = require('../renderer/chat/renderer-thread-tree-utils');

function message(id, role, overrides = {}) {
  return {
    id,
    role,
    content: '',
    status: 'complete',
    kind: '',
    ...overrides,
  };
}

function userMessage(id, overrides = {}) {
  return message(id, 'user', overrides);
}

function assistantMessage(id, overrides = {}) {
  return message(id, 'assistant', overrides);
}

function buildRecapModel(message) {
  const recap = message?.interactive_round_recap || {};
  return {
    recapId: String(message?.id || ''),
    requestId: String(recap.request_id || message?.request_id || ''),
    askedCount: Number(recap.answer_count || 0),
    questionSummaries: [],
    sourceMessageRefs: [],
    isPartial: false,
  };
}

function maxTreeDepth(tree) {
  let maxDepth = 0;
  for (const node of tree.nodeById.values()) {
    let depth = 0;
    let cursor = node;
    const visited = new Set();
    while (cursor?.parentId && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      cursor = tree.nodeById.get(cursor.parentId);
      if (!cursor) {
        break;
      }
      depth += 1;
    }
    maxDepth = Math.max(maxDepth, depth);
  }
  return maxDepth;
}

test('thread tree keeps multi-iteration assistant/tool runs at bounded depth', () => {
  const tree = buildTranscriptThreadTree([
    userMessage('user_1'),
    assistantMessage('assistant_stream_1', {
      streamId: 'stream_1',
      content: 'Iteration 1.',
    }),
    assistantMessage('tool_use_read_1', {
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_read_1',
        parent_stream_id: 'stream_1',
      },
    }),
    assistantMessage('assistant_stream_1_seg1', {
      streamId: 'stream_1',
      content: 'Iteration 2.',
    }),
    assistantMessage('tool_use_read_2', {
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_read_2',
        parent_stream_id: 'stream_1',
      },
    }),
    assistantMessage('assistant_stream_1_seg2', {
      streamId: 'stream_1',
      content: 'Iteration 3.',
    }),
    assistantMessage('tool_use_read_3', {
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_read_3',
        parent_stream_id: 'stream_1',
      },
    }),
  ], { buildInteractiveRecapViewModel: buildRecapModel });

  assert.equal(maxTreeDepth(tree), 2);
  assert.deepEqual(
    tree.roots[0].children.map((node) => node.id),
    ['assistant_stream_1', 'assistant_stream_1_seg1', 'assistant_stream_1_seg2']
  );
  assert.equal(tree.nodeById.get('assistant_stream_1').parentId, 'user_1');
  assert.equal(tree.nodeById.get('assistant_stream_1_seg1').parentId, 'user_1');
  assert.equal(tree.nodeById.get('assistant_stream_1_seg2').parentId, 'user_1');
  assert.equal(tree.nodeById.get('tool_use_read_1').parentId, 'assistant_stream_1');
  assert.equal(tree.nodeById.get('tool_use_read_2').parentId, 'assistant_stream_1_seg1');
  assert.equal(tree.nodeById.get('tool_use_read_3').parentId, 'assistant_stream_1_seg2');
});

test('thread tree keeps single-iteration assistant/tool nesting unchanged', () => {
  const tree = buildTranscriptThreadTree([
    userMessage('user_1'),
    assistantMessage('assistant_stream_1', {
      streamId: 'stream_1',
      content: 'Single iteration.',
    }),
    assistantMessage('tool_use_read_1', {
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_read_1',
        parent_stream_id: 'stream_1',
      },
    }),
  ], { buildInteractiveRecapViewModel: buildRecapModel });

  assert.equal(maxTreeDepth(tree), 2);
  assert.deepEqual(tree.roots.map((node) => node.id), ['user_1']);
  assert.deepEqual(tree.roots[0].children.map((node) => node.id), ['assistant_stream_1']);
  assert.deepEqual(tree.roots[0].children[0].children.map((node) => node.id), ['tool_use_read_1']);
});

test('thread tree preserves message-array order: trailing unanswered prompts stay below their turn', () => {
  // Regression guard for the "user prompt below the response" bug. The render
  // layer is faithful to messages[] order — there is no sort — so DOM order
  // equals array order. A scrambled timeline therefore means the array was built
  // wrong upstream (the send/terminal-post-work gate), not that the tree
  // mis-sorts. This locks the invariant so a future change can't quietly move
  // ordering responsibility into the tree.
  const tree = buildTranscriptThreadTree([
    userMessage('user_1'),
    assistantMessage('assistant_1', { streamId: 'stream_1', content: 'Answer.' }),
    userMessage('user_2'),
    userMessage('user_3'),
  ], { buildInteractiveRecapViewModel: buildRecapModel });

  // Roots are the user turns in array order; the answered turn nests its reply,
  // the trailing unanswered prompts stay as bare roots after it.
  assert.deepEqual(tree.roots.map((node) => node.id), ['user_1', 'user_2', 'user_3']);
  assert.deepEqual(tree.roots[0].children.map((node) => node.id), ['assistant_1']);
  assert.equal(tree.roots[1].children.length, 0);
  assert.equal(tree.roots[2].children.length, 0);
});

test('thread tree flattens segmented assistant continuations beneath the user anchor', () => {
  const tree = buildTranscriptThreadTree([
    userMessage('user_1'),
    assistantMessage('assistant_stream_1', {
      streamId: 'stream_1',
      content: 'Let me check that.',
    }),
    assistantMessage('tool_use_read_1', {
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_read_1',
        parent_stream_id: 'stream_1',
      },
    }),
    assistantMessage('assistant_stream_1_seg1', {
      streamId: 'stream_1',
      content: 'Done.',
    }),
  ], { buildInteractiveRecapViewModel: buildRecapModel });

  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].id, 'user_1');
  assert.deepEqual(
    tree.roots[0].children.map((node) => node.id),
    ['assistant_stream_1', 'assistant_stream_1_seg1']
  );
  assert.deepEqual(
    tree.roots[0].children[0].children.map((node) => node.id),
    ['tool_use_read_1']
  );
  assert.equal(tree.nodeById.get('assistant_stream_1_seg1').parentId, 'user_1');
});

test('thread tree anchors post-tool assistant completions when the stream starts with a tool', () => {
  const tree = buildTranscriptThreadTree([
    userMessage('user_1'),
    assistantMessage('tool_use_read_1', {
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_read_1',
        parent_stream_id: 'stream_1',
      },
    }),
    assistantMessage('assistant_stream_1', {
      streamId: 'stream_1',
      content: 'Done.',
    }),
  ], { buildInteractiveRecapViewModel: buildRecapModel });

  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].id, 'user_1');
  assert.deepEqual(
    tree.roots[0].children.map((node) => node.id),
    ['tool_use_read_1', 'assistant_stream_1']
  );
  assert.equal(tree.nodeById.get('tool_use_read_1').parentId, 'user_1');
  assert.equal(tree.nodeById.get('assistant_stream_1').parentId, 'user_1');
});

test('thread tree uses question batches as stream owners when no assistant completion exists', () => {
  const tree = buildTranscriptThreadTree([
    userMessage('user_1'),
    assistantMessage('question_batch_stream_q1', {
      kind: 'question_batch',
      request_id: 'stream_q1',
      content: 'Need a few answers first.',
    }),
    assistantMessage('tool_use_search_1', {
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_search_1',
        parent_stream_id: 'stream_q1',
      },
    }),
  ], { buildInteractiveRecapViewModel: buildRecapModel });

  assert.equal(tree.roots[0].children.length, 1);
  assert.equal(tree.roots[0].children[0].id, 'question_batch_stream_q1');
  assert.deepEqual(
    tree.roots[0].children[0].children.map((node) => node.id),
    ['tool_use_search_1']
  );
});

test('thread tree attaches interactive recaps to the owning assistant request stream', () => {
  const tree = buildTranscriptThreadTree([
    userMessage('user_1'),
    assistantMessage('assistant_stream_recap', {
      request_id: 'stream_recap',
      content: 'Let me summarize that.',
    }),
    assistantMessage('interactive_round_recap_stream_recap', {
      kind: 'interactive_round_recap',
      interactive_round_recap: {
        request_id: 'stream_recap',
        answer_count: 2,
      },
    }),
  ], { buildInteractiveRecapViewModel: buildRecapModel });

  assert.equal(tree.roots[0].children.length, 1);
  assert.equal(tree.roots[0].children[0].id, 'assistant_stream_recap');
  assert.deepEqual(
    tree.roots[0].children[0].children.map((node) => node.id),
    ['interactive_round_recap_stream_recap']
  );
});

test('thread tree attaches interactive recaps to the owning question batch when no assistant completion exists', () => {
  const tree = buildTranscriptThreadTree([
    userMessage('user_1'),
    assistantMessage('question_batch_stream_recap', {
      kind: 'question_batch',
      request_id: 'stream_recap',
      content: 'Need a few answers first.',
    }),
    assistantMessage('interactive_round_recap_stream_recap', {
      kind: 'interactive_round_recap',
      interactive_round_recap: {
        request_id: 'stream_recap',
        answer_count: 2,
      },
    }),
  ], { buildInteractiveRecapViewModel: buildRecapModel });

  assert.equal(tree.roots[0].children.length, 1);
  assert.equal(tree.roots[0].children[0].id, 'question_batch_stream_recap');
  assert.deepEqual(
    tree.roots[0].children[0].children.map((node) => node.id),
    ['interactive_round_recap_stream_recap']
  );
});

test('thread tree keeps proactive suggestions and slash outputs as standalone roots', () => {
  const tree = buildTranscriptThreadTree([
    userMessage('user_1'),
    assistantMessage('assistant_stream_1', { content: 'Reply one.' }),
    assistantMessage('proactive_1', { kind: 'proactive_suggestion', content: 'Try this later.' }),
    assistantMessage('slash_1', { kind: 'slash_command_output', content: 'workspace: clean' }),
  ], { buildInteractiveRecapViewModel: buildRecapModel });

  assert.deepEqual(
    tree.roots.map((node) => node.id),
    ['user_1', 'proactive_1', 'slash_1']
  );
  assert.equal(tree.roots[0].children[0].id, 'assistant_stream_1');
});

test('thread tree falls back to the current user turn when a tool stream owner is missing', () => {
  const tree = buildTranscriptThreadTree([
    userMessage('user_1'),
    assistantMessage('tool_use_fallback', {
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_fallback',
        parent_stream_id: '',
      },
    }),
  ], { buildInteractiveRecapViewModel: buildRecapModel });

  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].id, 'user_1');
  assert.deepEqual(tree.roots[0].children.map((node) => node.id), ['tool_use_fallback']);
});

test('thread branch collection includes the active node and its ancestors for forced-open streaming paths', () => {
  const tree = buildTranscriptThreadTree([
    userMessage('user_1'),
    assistantMessage('assistant_stream_1', {
      streamId: 'stream_1',
      content: 'Working...',
    }),
    assistantMessage('tool_use_read_1', {
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_read_1',
        parent_stream_id: 'stream_1',
      },
    }),
  ], { buildInteractiveRecapViewModel: buildRecapModel });

  assert.deepEqual(
    Array.from(collectThreadBranchIds(tree.nodeById, 'tool_use_read_1')).sort(),
    ['assistant_stream_1', 'tool_use_read_1', 'user_1']
  );
});

test('thread branch collection treats segmented assistant continuations as anchored siblings', () => {
  const tree = buildTranscriptThreadTree([
    userMessage('user_1'),
    assistantMessage('assistant_stream_1', {
      streamId: 'stream_1',
      content: 'Thinking...',
    }),
    assistantMessage('tool_use_read_1', {
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_read_1',
        parent_stream_id: 'stream_1',
      },
    }),
    assistantMessage('assistant_stream_1_seg1', {
      streamId: 'stream_1',
      content: 'Finished.',
    }),
  ], { buildInteractiveRecapViewModel: buildRecapModel });

  assert.deepEqual(
    Array.from(collectThreadBranchIds(tree.nodeById, 'assistant_stream_1_seg1')).sort(),
    ['assistant_stream_1_seg1', 'user_1']
  );
});

test('thread branch collection stops on malformed parent cycles', () => {
  const nodeById = new Map([
    ['assistant_stream_1', {
      id: 'assistant_stream_1',
      parentId: 'tool_use_read_1',
    }],
    ['tool_use_read_1', {
      id: 'tool_use_read_1',
      parentId: 'assistant_stream_1',
    }],
  ]);

  assert.deepEqual(
    Array.from(collectThreadBranchIds(nodeById, 'assistant_stream_1')).sort(),
    ['assistant_stream_1', 'tool_use_read_1']
  );
});

test('thread toggle visibility favors meaningful children and dense tool runs', () => {
  const toolNodeWithAssistantReply = {
    id: 'tool_use_1',
    message: assistantMessage('tool_use_1', { kind: 'tool_use' }),
    children: [{ id: 'assistant_2', message: assistantMessage('assistant_2') }],
  };
  const assistantWithOneTool = {
    id: 'assistant_1',
    message: assistantMessage('assistant_1'),
    children: [{ id: 'tool_1', message: assistantMessage('tool_1', { kind: 'tool_use' }) }],
  };
  const assistantWithTwoTools = {
    id: 'assistant_2',
    message: assistantMessage('assistant_2'),
    children: [
      { id: 'tool_1', message: assistantMessage('tool_1', { kind: 'tool_use' }) },
      { id: 'tool_2', message: assistantMessage('tool_2', { kind: 'tool_use' }) },
    ],
  };
  const assistantWithRecap = {
    id: 'assistant_3',
    message: assistantMessage('assistant_3'),
    children: [{ id: 'recap_1', message: assistantMessage('recap_1', { kind: 'interactive_round_recap' }) }],
  };

  assert.equal(shouldShowThreadToggle(toolNodeWithAssistantReply), false);
  assert.equal(shouldShowThreadToggle(assistantWithOneTool), false);
  assert.equal(shouldShowThreadToggle(assistantWithTwoTools), true);
  assert.equal(shouldShowThreadToggle(assistantWithRecap), true);
});
