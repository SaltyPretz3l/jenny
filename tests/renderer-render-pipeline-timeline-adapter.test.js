const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRenderPipelineTimelineAdapter,
} = require('../renderer/chat/renderer-render-pipeline-timeline-adapter');

test('render pipeline timeline adapter derives fallback message state and thread helpers', () => {
  const adapter = createRenderPipelineTimelineAdapter({
    threadTreeUtils: {},
    buildTimelineStructureSignature(messages) {
      return `sig:${Array.isArray(messages) ? messages.length : 0}`;
    },
  });
  const messages = [
    { id: 'u1', role: 'user', status: 'complete' },
    { id: 'a1', role: 'assistant', status: 'complete' },
    { id: 'tool1', role: 'assistant', kind: 'tool_use', status: 'complete' },
    { id: 'a2', role: 'assistant', status: 'streaming' },
    { id: 'slash', role: 'assistant', kind: 'slash_command_output', status: 'complete' },
  ];

  const derived = adapter.computeDerivedMessageState(messages, {
    shouldShowThinkingToggle(message) {
      return message.id === 'a1';
    },
  });
  const threadTree = adapter.buildTranscriptThreadTree(messages);
  const branchIds = adapter.collectThreadBranchIds(threadTree.nodeById, 'a2');

  assert.equal(derived.latestAssistantMessageId, 'a2');
  assert.equal(derived.latestReplyAssistantMessageId, 'a1');
  assert.equal(derived.streamingMessage, messages[3]);
  assert.deepEqual(derived.thinkingMessageIds, ['a1']);
  assert.equal(derived.idToIndex.get('tool1'), 2);
  assert.deepEqual(threadTree.roots.map((node) => node.id), ['u1', 'a1', 'tool1', 'a2', 'slash']);
  assert.equal(threadTree.hasNestedNodes, false);
  assert.deepEqual([...branchIds], ['a2']);
  assert.equal(adapter.computeStructureHash(messages), 'sig:5');
  assert.deepEqual(adapter.deriveTimelineTimeDividers(), []);
  assert.deepEqual([...adapter.buildTimeDividerMap().entries()], []);
  assert.equal(adapter.buildTimelineDividerInputSignature(), '');
  assert.equal(adapter.shouldShowThreadToggle(), false);
});

test('fallback derived state preserves a live assistant target followed by tool plumbing', () => {
  const adapter = createRenderPipelineTimelineAdapter({
    messageIndexUtils: {},
    threadTreeUtils: {},
  });
  const liveAssistant = {
    id: 'assistant-live',
    role: 'assistant',
    status: 'streaming',
    content: 'Partial response',
  };
  const toolUse = {
    id: 'tool-use-1',
    role: 'assistant',
    kind: 'tool_use',
    status: 'complete',
  };

  const derived = adapter.computeDerivedMessageState([
    { id: 'user-1', role: 'user', status: 'complete' },
    liveAssistant,
    toolUse,
  ]);

  assert.equal(derived.latestAssistantMessageId, 'tool-use-1');
  assert.equal(derived.streamingMessage, liveAssistant);
});
