const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  projectCanonicalSessionMessagesForSend,
} = require('../services/backend/chat-send-frame-budget');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

test('keeps kind: tool_result messages', () => {
  assert.deepEqual(
    projectCanonicalSessionMessagesForSend([{ id: 'result', kind: 'tool_result', content: 'drop' }]),
    [{ id: 'result', kind: 'tool_result' }]
  );
});

test('keeps kind: tool_search_result messages', () => {
  const content = { discovered_tools: ['fetch_url'] };
  assert.deepEqual(
    projectCanonicalSessionMessagesForSend([{ id: 'search', kind: 'tool_search_result', content }]),
    [{ id: 'search', kind: 'tool_search_result', content }]
  );
});

test('keeps role: tool messages', () => {
  assert.deepEqual(
    projectCanonicalSessionMessagesForSend([{ id: 'role', role: 'tool', content: 'drop' }]),
    [{ id: 'role', role: 'tool' }]
  );
});

test('keeps messages with a bare tool_result object', () => {
  assert.deepEqual(
    projectCanonicalSessionMessagesForSend([{ id: 'bare', tool_result: { tool_name: 'read_file' } }]),
    [{ id: 'bare', tool_result: { tool_name: 'read_file' } }]
  );
});

test('drops prose and reasoning while retaining only the truthiness placeholder', () => {
  const messages = [
    { id: 'user', role: 'user', content: 'u'.repeat(50_000) },
    { id: 'assistant', role: 'assistant', content: 'a'.repeat(50_000), reasoning: 'r'.repeat(50_000) },
  ];
  const projected = projectCanonicalSessionMessagesForSend(messages);
  assert.deepEqual(projected, [{ id: 'assistant', kind: 'projected_placeholder' }]);
  assert.ok(
    Buffer.byteLength(JSON.stringify(projected))
      < Buffer.byteLength(JSON.stringify(messages)) * 0.01
  );
});

test('narrows ordinary tool_result payloads and drops their large output bodies', () => {
  const metadata = { path: 'notes.txt', read_snapshot: { path: 'notes.txt', scope: 'full' } };
  const [projected] = projectCanonicalSessionMessagesForSend([{
    id: 'read',
    kind: 'tool_result',
    role: 'tool',
    content: 'drop',
    tool_result: {
      tool_name: 'read_file',
      metadata,
      is_error: false,
      output: 'x'.repeat(100_000),
      call_id: 'call_1',
    },
  }]);
  assert.deepEqual(projected, {
    id: 'read',
    kind: 'tool_result',
    role: 'tool',
    tool_result: { tool_name: 'read_file', is_error: false, metadata },
  });
  assert.strictEqual(projected.tool_result.metadata, metadata);
});

test('preserves only the metadata-absent tool_search output fallback', () => {
  const legacyOutput = '- fetch_url: Fetch a URL';
  const projected = projectCanonicalSessionMessagesForSend([
    {
      id: 'legacy',
      role: 'tool',
      tool_result: { tool_name: 'tool_search', output: legacyOutput },
    },
    {
      id: 'metadata',
      role: 'tool',
      tool_result: {
        tool_name: 'tool_search',
        metadata: { kind: 'tool_search_result', discovered_tools: ['read_file'] },
        output: legacyOutput,
      },
    },
    {
      id: 'read',
      role: 'tool',
      tool_result: { tool_name: 'read_file', output: legacyOutput },
    },
    {
      id: 'non-dict-metadata',
      role: 'tool',
      tool_result: { tool_name: 'tool_search', metadata: 'present', output: legacyOutput },
    },
  ]);
  assert.equal(projected[0].tool_result.output, legacyOutput);
  assert.equal(Object.hasOwn(projected[1].tool_result, 'output'), false);
  assert.equal(Object.hasOwn(projected[2].tool_result, 'output'), false);
  assert.equal(projected[3].tool_result.metadata, 'present');
  assert.equal(Object.hasOwn(projected[3].tool_result, 'output'), false);
});

test('keeps content only for tool_search_result messages', () => {
  const discovered = { discovered_tools: ['fetch_url'] };
  const projected = projectCanonicalSessionMessagesForSend([
    { id: 'tool', role: 'tool', content: discovered },
    { id: 'search', kind: 'tool_search_result', content: discovered },
  ]);
  assert.equal(Object.hasOwn(projected[0], 'content'), false);
  assert.strictEqual(projected[1].content, discovered);
});

test('uses a placeholder only when a non-empty input has no consumer-shaped messages', () => {
  assert.deepEqual(
    projectCanonicalSessionMessagesForSend([{ id: 'last', role: 'assistant', content: 'hello' }]),
    [{ id: 'last', kind: 'projected_placeholder' }]
  );
  assert.deepEqual(projectCanonicalSessionMessagesForSend([]), []);
  assert.deepEqual(projectCanonicalSessionMessagesForSend(null), []);
});

test('does not mutate the input array or message objects', () => {
  const messages = [
    { id: 'user', role: 'user', content: 'hello', reasoning: 'thinking' },
    {
      id: 'tool',
      role: 'tool',
      kind: 'tool_result',
      tool_result: {
        tool_name: 'read_file',
        metadata: { path: 'notes.txt' },
        output: 'body',
      },
    },
  ];
  const before = JSON.parse(JSON.stringify(messages));
  projectCanonicalSessionMessagesForSend(messages);
  assert.deepEqual(messages, before);
});

// Equivalence oracle for tool_quotas.py:275 count_session_tool_results,
// tool_execution_snapshots.py:103 rebuild_read_snapshot_cache, and
// tool_search.py:376 scan_history_for_undeferrals. Keep these mirrors aligned
// with the Python consumers when their predicates change.
function countSessionToolResults(messages) {
  let count = 0;
  for (const message of messages || []) {
    if (!isRecord(message)) continue;
    if (message.kind === 'tool_result' && isRecord(message.tool_result)) {
      count += 1;
      continue;
    }
    if (message.role === 'tool') count += 1;
  }
  return count;
}

function collectReadSnapshots(messages) {
  const cache = {};
  for (const message of messages || []) {
    if (!isRecord(message) || !isRecord(message.tool_result)) continue;
    const toolResult = message.tool_result;
    const toolName = String(toolResult.tool_name || '').trim();
    const metadata = isRecord(toolResult.metadata) ? toolResult.metadata : {};
    if (toolResult.is_error === true || Object.keys(metadata).length === 0) continue;
    if (toolName === 'read_file') {
      const snapshot = metadata.read_snapshot;
      if (isRecord(snapshot) && typeof snapshot.path === 'string' && snapshot.scope === 'full') {
        cache[snapshot.path] = snapshot;
      }
    } else if (['write_file', 'edit_file', 'delete_file'].includes(toolName)) {
      if (typeof metadata.path === 'string' && metadata.path.trim()) {
        delete cache[metadata.path.trim()];
      }
    }
  }
  return cache;
}

function collectDiscoveredTools(messages) {
  const discoveredTools = new Set();
  for (const message of messages || []) {
    if (!isRecord(message)) continue;
    if (message.kind === 'tool_search_result') {
      const discovered = isRecord(message.content) ? message.content.discovered_tools : null;
      if (Array.isArray(discovered)) {
        for (const name of discovered) {
          if (typeof name === 'string' && name.trim()) discoveredTools.add(name.trim());
        }
      }
      continue;
    }
    const toolResult = message.tool_result;
    if (message.role !== 'tool' || !isRecord(toolResult) || toolResult.tool_name !== 'tool_search') {
      continue;
    }
    const metadata = toolResult.metadata;
    if (isRecord(metadata) && metadata.kind === 'tool_search_result') {
      for (const name of Array.isArray(metadata.discovered_tools) ? metadata.discovered_tools : []) {
        if (typeof name === 'string' && name.trim()) discoveredTools.add(name.trim());
      }
    }
    if (metadata !== undefined && metadata !== null) continue;
    if (typeof toolResult.output === 'string') {
      for (const line of toolResult.output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ') && trimmed.includes(':')) {
          const name = trimmed.slice(2).split(':')[0].trim();
          if (name) discoveredTools.add(name);
        }
      }
    }
  }
  return [...discoveredTools].sort();
}

test('projection is equivalent for all three Python consumers', () => {
  const messages = [
    { id: 'u1', role: 'user', content: 'question' },
    { id: 'a1', role: 'assistant', content: 'answer', reasoning: 'private reasoning' },
    {
      id: 'r1',
      kind: 'tool_result',
      role: 'tool',
      tool_result: {
        tool_name: 'read_file',
        is_error: false,
        metadata: {
          path: 'notes.txt',
          read_snapshot: {
            path: 'notes.txt', scope: 'full', size_bytes: 12, mtime_ns: 34, sha256: 'abc',
          },
        },
        output: 'large body'.repeat(1_000),
      },
    },
    { id: 'role-only', role: 'tool', content: 'legacy result' },
    {
      id: 'search-kind',
      kind: 'tool_search_result',
      content: { discovered_tools: [' fetch_url ', '', 42] },
    },
    {
      id: 'search-metadata',
      role: 'tool',
      tool_result: {
        tool_name: 'tool_search',
        metadata: { kind: 'tool_search_result', discovered_tools: ['read_file'] },
        output: '- ignored_tool: must not be parsed',
      },
    },
    {
      id: 'search-output',
      role: 'tool',
      tool_result: {
        tool_name: 'tool_search',
        output: '- fetch_url: Fetch a URL\n- write_file: Write a file',
      },
    },
    {
      id: 'search-non-dict-metadata',
      role: 'tool',
      tool_result: {
        tool_name: 'tool_search',
        metadata: 'present',
        output: '- ignored_non_dict: must not be parsed',
      },
    },
    {
      id: 'bare-result',
      tool_result: { tool_name: 'write_file', metadata: { path: 'notes.txt' }, is_error: false },
    },
    {
      id: 'r2',
      tool_result: {
        tool_name: 'read_file',
        metadata: {
          read_snapshot: {
            path: 'final.txt', scope: 'full', size_bytes: 56, mtime_ns: 78, sha256: 'def',
          },
        },
      },
    },
    { id: 'invalid-result-kind', kind: 'tool_result', tool_result: null },
    null,
    'not a message',
  ];
  const projected = projectCanonicalSessionMessagesForSend(messages);
  assert.equal(countSessionToolResults(projected), countSessionToolResults(messages));
  assert.deepEqual(collectReadSnapshots(projected), collectReadSnapshots(messages));
  assert.deepEqual(collectDiscoveredTools(projected), collectDiscoveredTools(messages));
  assert.ok(collectDiscoveredTools(projected).includes('fetch_url'));
  assert.equal(
    projected.find((message) => message.id === 'search-metadata').tool_result.output,
    undefined
  );
});

test('the prose-only placeholder is skipped by all three Python consumer predicates', () => {
  const projected = projectCanonicalSessionMessagesForSend([
    { id: 'assistant', role: 'assistant', content: 'answer', reasoning: 'thoughts' },
  ]);
  assert.deepEqual(projected, [{ id: 'assistant', kind: 'projected_placeholder' }]);
  assert.equal(countSessionToolResults(projected), 0);
  assert.deepEqual(collectReadSnapshots(projected), {});
  assert.deepEqual(collectDiscoveredTools(projected), []);
});
