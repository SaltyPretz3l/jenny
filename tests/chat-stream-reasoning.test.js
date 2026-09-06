const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendPersistedReasoningEntry,
  buildPromptWithAttachments,
  buildPreparedMessages,
  extractProviderReasoningDelta,
  mergeReasoningEntries,
  normalizeReasoningSentence,
  sanitizePersistedReasoningText,
  selectContextHistoryMessages,
} = require('../services/backend/chat-stream-reasoning');

test('normalizeReasoningSentence keeps a concise one-sentence provider summary', () => {
  assert.equal(
    normalizeReasoningSentence('Checking the request intent. Considering a fallback path afterward.'),
    'Checking the request intent.'
  );
});

test('extractProviderReasoningDelta normalizes provider reasoning payloads into entries', () => {
  const delta = extractProviderReasoningDelta(
    {
      choices: [
        {
          delta: {
            reasoning: { summary: 'Checking the request intent. Considering extra details later.' },
            reasoning_text: 'Forming a concise answer.',
          },
        },
      ],
    },
    '2026-03-12T15:12:00.000Z'
  );

  assert.equal(delta.source, 'provider');
  assert.equal(delta.entriesDelta.length, 2);
  assert.equal(delta.entriesDelta[0].text, 'Checking the request intent.');
  assert.equal(delta.entriesDelta[1].timestamp, '2026-03-12T15:12:00.000Z');
});

test('sanitizePersistedReasoningText strips think wrappers and passes content through', () => {
  assert.deepEqual(
    sanitizePersistedReasoningText('<think>Checking the request intent.</think>'),
    { text: 'Checking the request intent.' }
  );
  assert.deepEqual(
    sanitizePersistedReasoningText('<|channel>thoughtChecking the request intent.<channel|>'),
    { text: 'Checking the request intent.' }
  );
  assert.deepEqual(
    sanitizePersistedReasoningText('<think>## Plan\n\n- keep markdown\n- keep spacing</think>'),
    { text: '## Plan\n\n- keep markdown\n- keep spacing' }
  );
  assert.deepEqual(
    sanitizePersistedReasoningText("_thought I'd inspect the workspace first."),
    { text: "I'd inspect the workspace first." }
  );
  assert.deepEqual(
    sanitizePersistedReasoningText('{"token":"secret","path":"C:\\\\Users\\\\demo\\\\work\\\\notes.txt"}'),
    { text: '{"token":"secret","path":"C:\\\\Users\\\\demo\\\\work\\\\notes.txt"}' }
  );
});

test('appendPersistedReasoningEntry deduplicates and enforces persistence budgets', () => {
  let entries = [];
  const first = appendPersistedReasoningEntry(entries, 'Checking the request intent.', '2026-03-12T15:12:00.000Z');
  entries = first.entries;
  const duplicate = appendPersistedReasoningEntry(entries, 'Checking the request intent.', '2026-03-12T15:12:01.000Z');
  assert.equal(entries.length, 1);
  assert.equal(duplicate.entry, null);

  const oversized = appendPersistedReasoningEntry(
    entries,
    `tool_input=${'x'.repeat(49000)}`,
    '2026-03-12T15:12:02.000Z'
  );
  assert.equal(oversized.entries.length, 2);
  assert.equal(oversized.truncated, true);
  assert.match(
    String(oversized.entry.text || ''),
    /\n\n_\[reasoning truncated - \d+ more characters not stored\]_$/
  );
});

test('appendPersistedReasoningEntry coalesces live reasoning updates into a markdown-safe block', () => {
  let entries = [];
  const first = appendPersistedReasoningEntry(entries, '## Analyze\n\n- first item', '2026-03-12T15:12:00.000Z', {
    coalesceTail: true,
  });
  entries = first.entries;
  const second = appendPersistedReasoningEntry(entries, '\n- second item', '2026-03-12T15:12:01.000Z', {
    coalesceTail: true,
  });

  assert.equal(second.entries.length, 1);
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(
    second.entry.text,
    '## Analyze\n\n- first item\n- second item'
  );
});

test('appendPersistedReasoningEntry strips gemma reasoning markers while coalescing', () => {
  let entries = [];
  const first = appendPersistedReasoningEntry(
    entries,
    '<|channel>thought## Analyze',
    '2026-03-12T15:12:00.000Z',
    { coalesceTail: true }
  );
  entries = first.entries;
  const second = appendPersistedReasoningEntry(
    entries,
    '\n- item<channel|>',
    '2026-03-12T15:12:01.000Z',
    { coalesceTail: true }
  );

  assert.equal(second.entries.length, 1);
  assert.equal(second.entry.text, '## Analyze\n- item');
});

test('appendPersistedReasoningEntry preserves word boundaries when coalescing streaming chunks', () => {
  let entries = [];
  const first = appendPersistedReasoningEntry(entries, 'Thinking', '2026-03-18T10:00:00.000Z', {
    coalesceTail: true,
  });
  entries = first.entries;
  const second = appendPersistedReasoningEntry(entries, ' Process:', '2026-03-18T10:00:01.000Z', {
    coalesceTail: true,
  });
  entries = second.entries;
  const third = appendPersistedReasoningEntry(entries, '\n1. **Analyze', '2026-03-18T10:00:02.000Z', {
    coalesceTail: true,
  });

  assert.equal(third.entries.length, 1);
  assert.equal(third.entry.id, first.entry.id);
  assert.equal(
    third.entry.text,
    'Thinking Process:\n1. **Analyze'
  );
});

test('appendPersistedReasoningEntry preserves chunk-final newlines when the caller threads rawTailText', () => {
  // Without the raw tail, coalescing joins onto the SANITIZED (trailing-
  // trimmed) previous text, destroying every newline that ends a chunk.
  let entries = [];
  let rawTail = '';
  const chunks = ['I will proceed sequentially:\n', '1. Create the haiku\n', '2. Edit the file'];
  for (const chunk of chunks) {
    const result = appendPersistedReasoningEntry(entries, chunk, '2026-07-06T00:00:00.000Z', {
      coalesceTail: true,
      rawTailText: rawTail,
    });
    entries = result.entries;
    rawTail = result.rawText;
  }
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].text,
    'I will proceed sequentially:\n1. Create the haiku\n2. Edit the file'
  );
});

test('mergeReasoningEntries preserves distinct thinkingId values across phases', () => {
  const merged = mergeReasoningEntries(
    [
      {
        id: 'reason_1',
        text: 'First phase',
        timestamp: '2026-03-18T10:00:00.000Z',
        thinkingId: 'think_req_iter1',
      },
    ],
    [
      {
        id: 'reason_2',
        text: 'Second phase',
        timestamp: '2026-03-18T10:00:01.000Z',
        thinkingId: 'think_req_iter2',
      },
    ]
  );

  assert.deepEqual(merged, [
    {
      id: 'reason_1',
      text: 'First phase',
      timestamp: '2026-03-18T10:00:00.000Z',
      thinkingId: 'think_req_iter1',
    },
    {
      id: 'reason_2',
      text: 'Second phase',
      timestamp: '2026-03-18T10:00:01.000Z',
      thinkingId: 'think_req_iter2',
    },
  ]);
});

test('mergeReasoningEntries keeps same-text entries from separate thinking phases', () => {
  const merged = mergeReasoningEntries(
    [
      {
        id: 'reason_iter1',
        text: 'Repeated summary',
        timestamp: '2026-04-13T12:00:00.000Z',
        thinkingId: 'think_req_iter1',
      },
    ],
    [
      {
        id: 'reason_iter2',
        text: 'Repeated summary',
        timestamp: '2026-04-13T12:00:00.000Z',
        thinkingId: 'think_req_iter2',
      },
    ]
  );

  assert.deepEqual(merged, [
    {
      id: 'reason_iter1',
      text: 'Repeated summary',
      timestamp: '2026-04-13T12:00:00.000Z',
      thinkingId: 'think_req_iter1',
    },
    {
      id: 'reason_iter2',
      text: 'Repeated summary',
      timestamp: '2026-04-13T12:00:00.000Z',
      thinkingId: 'think_req_iter2',
    },
  ]);
});

test('buildPreparedMessages excludes reasoning metadata from outbound context', () => {
  const prepared = buildPreparedMessages(
    [
      {
        role: 'assistant',
        content: 'Completed reply.',
        reasoning: {
          source: 'provider',
          entries: [{ id: 'reason_1', text: 'This should stay local.', timestamp: '2026-03-12T15:15:00.000Z' }],
        },
      },
    ],
    'Follow-up question'
  );

  assert.deepEqual(prepared, [
    { role: 'assistant', content: 'Completed reply.' },
    { role: 'user', content: 'Follow-up question' },
  ]);
});

test('buildPreparedMessages excludes structured diff metadata from outbound tool context', () => {
  const prepared = buildPreparedMessages(
    [
      {
        id: 'tool_result_diff_context',
        role: 'tool',
        kind: 'tool_result',
        content: 'Wrote file.',
        tool_result: {
          call_id: 'call_diff_context',
          tool_name: 'Write',
          output_text: 'Wrote file.',
          summary: 'Write src/app.js',
          metadata: {
            diff: {
              additions: 1,
              deletions: 1,
              hunks: [{
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ['-secret old line', '+secret new line'],
              }],
            },
          },
        },
      },
    ],
    'Follow-up question'
  );

  assert.deepEqual(prepared, [
    {
      role: 'tool',
      tool_call_id: 'call_diff_context',
      content: 'Wrote file.',
      // W1 forwards the structured fields; `diff` is not whitelisted, so the
      // envelope stays bare and the secret-leak assertions below still bite.
      name: 'Write',
      tool_envelope: { v: 1 },
    },
    { role: 'user', content: 'Follow-up question' },
  ]);
  assert.equal(JSON.stringify(prepared).includes('secret old line'), false);
  assert.equal(JSON.stringify(prepared).includes('"diff"'), false);
});

test('buildPreparedMessages reconstructs interactive recap messages for outbound context', () => {
  const prepared = buildPreparedMessages(
    [
      {
        role: 'assistant',
        content: 'Completed reply.',
      },
      {
        role: 'assistant',
        kind: 'interactive_round_recap',
        content: 'Asked 1 question',
        interactive_round_recap: {
          round_index: 1,
          answer_count: 1,
          items: [
            {
              question_id: 'q1',
              prompt: 'What kind of pace feels right?',
              answer_label: 'Steady',
            },
          ],
          collapsed: true,
        },
      },
    ],
    'Follow-up question'
  );

  assert.deepEqual(prepared, [
    { role: 'assistant', content: 'Completed reply.' },
    {
      role: 'user',
      content: [
        "User answered Jenny's follow-up questions:",
        '- What kind of pace feels right?: Steady',
      ].join('\n'),
    },
    { role: 'user', content: 'Follow-up question' },
  ]);
});

test('buildPreparedMessages reconstructs full question batches for outbound context', () => {
  const prepared = buildPreparedMessages(
    [
      {
        role: 'user',
        content: 'Help me decide.',
      },
      {
        role: 'assistant',
        kind: 'question_batch',
        content: 'A couple quick questions.',
        interactive_batch: {
          batch_id: 'ib_1',
          round_index: 1,
          intro_text: 'A couple quick questions.',
          questions: [
            {
              id: 'q1',
              prompt: 'What kind of pace feels right?',
              options: [
                { id: 'steady', label: 'Steady' },
                { id: 'fast', label: 'Fast' },
              ],
            },
            {
              id: 'q2',
              prompt: 'What should I optimize for first?',
              options: [
                { id: 'alignment', label: 'Stakeholder alignment' },
                { id: 'speed', label: 'Speed' },
              ],
            },
          ],
        },
      },
    ],
    'Use those answers now'
  );

  assert.deepEqual(prepared, [
    { role: 'user', content: 'Help me decide.' },
    {
      role: 'assistant',
      content: [
        'Jenny asked follow-up questions:',
        'A couple quick questions.',
        '',
        '1. What kind of pace feels right?',
        'Options: Steady / Fast',
        '',
        '2. What should I optimize for first?',
        'Options: Stakeholder alignment / Speed',
      ].join('\n'),
    },
    { role: 'user', content: 'Use those answers now' },
  ]);
});

test('selectContextHistoryMessages omits prior transcript when history scope is fresh', () => {
  const selected = selectContextHistoryMessages([
    { role: 'user', content: 'First prompt' },
    { role: 'assistant', content: 'First reply' },
  ], {
    history_scope: 'fresh',
  });

  assert.deepEqual(selected, []);
});

test('selectContextHistoryMessages keeps the last six user-anchored turn groups for recent mode', () => {
  const messages = [];
  for (let index = 1; index <= 8; index += 1) {
    messages.push({ role: 'user', content: `Question ${index}` });
    messages.push({ role: 'assistant', content: `Answer ${index}` });
    messages.push({
      role: 'assistant',
      kind: 'tool_use',
      content: `Tool ${index}`,
      tool_call: { call_id: `call-${index}`, tool_name: 'Read' },
    });
    messages.push({
      role: 'tool',
      kind: 'tool_result',
      content: `Result ${index}`,
      tool_result: { call_id: `call-${index}`, tool_name: 'Read' },
    });
  }

  const selected = selectContextHistoryMessages(messages, {
    history_scope: 'recent',
  });

  assert.equal(selected.length, 24);
  assert.equal(selected[0].content, 'Question 3');
  assert.equal(selected.at(-1).content, 'Result 8');
  assert.equal(selected.some((message) => message.content === 'Question 2'), false);
});

test('buildPreparedMessages still excludes non-semantic local-only kinds after recent context selection', () => {
  const prepared = buildPreparedMessages(
    [
      { role: 'user', content: 'First prompt' },
      { role: 'assistant', content: 'First reply' },
      {
        role: 'assistant',
        kind: 'proactive_suggestion',
        content: 'Local-only suggestion',
        proactive_suggestion: { promptSuggestion: 'Use this' },
      },
      {
        role: 'assistant',
        kind: 'interactive_round_recap',
        content: 'Asked 1 question',
        interactive_round_recap: {
          round_index: 1,
          answer_count: 1,
          items: [
            {
              question_id: 'q1',
              prompt: 'What pace?',
              answer_label: 'Steady',
            },
          ],
        },
      },
      {
        role: 'assistant',
        kind: 'question_batch',
        content: 'Question batch',
        interactive_batch: {
          batch_id: 'batch-1',
          round_index: 1,
          questions: [
            {
              id: 'q1',
              prompt: 'What pace?',
              options: [
                { id: 'steady', label: 'Steady' },
                { id: 'fast', label: 'Fast' },
              ],
            },
          ],
        },
      },
      { role: 'user', content: 'Second prompt' },
      { role: 'assistant', content: 'Second reply' },
    ],
    'Follow-up question',
    {
      contextPreferences: {
        history_scope: 'recent',
      },
    }
  );

  assert.deepEqual(prepared, [
    { role: 'user', content: 'First prompt' },
    { role: 'assistant', content: 'First reply' },
    {
      role: 'user',
      content: [
        "User answered Jenny's follow-up questions:",
        '- What pace?: Steady',
      ].join('\n'),
    },
    {
      role: 'assistant',
      content: [
        'Jenny asked follow-up questions:',
        '',
        '1. What pace?',
        'Options: Steady / Fast',
      ].join('\n'),
    },
    { role: 'user', content: 'Second prompt' },
    { role: 'assistant', content: 'Second reply' },
    { role: 'user', content: 'Follow-up question' },
  ]);
});

test('buildPreparedMessages compacts prior inspect_harness results in outbound context', () => {
  const oversizedSnapshot = '{"tools":' + '"x"'.repeat(20000) + '}';
  const prepared = buildPreparedMessages(
    [
      { role: 'user', content: 'Inspect the harness' },
      {
        role: 'assistant',
        kind: 'tool_use',
        content: 'Inspect Harness',
        tool_call: { call_id: 'call-inspect', tool_name: 'inspect_harness', input: {}, input_json: '{}' },
      },
      {
        role: 'tool',
        kind: 'tool_result',
        content: 'Inspect Harness',
        tool_result: {
          call_id: 'call-inspect',
          tool_name: 'inspect_harness',
          summary: 'Inspect Harness',
          output_text: oversizedSnapshot,
          metadata: { result_kind: 'harness_snapshot' },
        },
      },
    ],
    'What changed?'
  );

  const toolMessage = prepared.find((message) => message.role === 'tool');
  assert.equal(
    toolMessage.content,
    'Inspect Harness completed in a prior turn. Use jenny_status for a current report.'
  );
  assert.equal(toolMessage.content.includes(oversizedSnapshot), false);
});

test('buildPromptWithAttachments appends readable attachment blocks to the final user prompt', () => {
  const prompt = buildPromptWithAttachments('Review these notes', [
    {
      promptName: 'notes.txt',
      text: 'alpha\nbeta',
    },
    {
      promptName: 'src/app.js',
      text: 'console.log("ok");',
    },
  ]);

  assert.match(prompt, /Review these notes/);
  assert.match(prompt, /Attached files:/);
  assert.match(prompt, /--- file: notes\.txt ---/);
  assert.match(prompt, /--- file: src\/app\.js ---/);
  assert.match(prompt, /--- end file ---/);
});

test('buildPromptWithAttachments ignores image attachments in the text prompt injection path', () => {
  const prompt = buildPromptWithAttachments('Review this image', [
    {
      kind: 'image',
      displayName: 'capture.png',
      assetPath: 'C:/captures/capture.png',
    },
  ]);

  assert.equal(prompt, 'Review this image');
});
