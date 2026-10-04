'use strict';

/**
 * W3-F11: "Compact now" must measure and summarize the SAME prepared history
 * the next chat.send puts on the wire: same selection (history scope), same
 * persisted-snapshot substitution, and the same tool-result text (the full
 * `tool_result.output_text`, not the short summary stored in `content`).
 *
 * 1.2.0 gate B5/2: a nine-read tool turn counted 550 tokens on the manual
 * path while the meter showed 25.1k and the next send measured 26.3k, because
 * every stored tool_result row carries only its one-line summary in `content`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCompactPayload } = require('../services/backend/backend-compact-payload');
const { BackendService } = require('../services/backend/backend-service');
const { buildPreparedContextHistory } = require('../services/backend/chat-stream-reasoning');
const { estimateMessagesTokens } = require('../services/backend/context-budget-trimmer');
const {
  buildAutomaticCompactionSnapshot,
  normalizeCompactionSnapshot,
} = require('../services/backend/session-compaction-snapshot');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const LEAN = {
  include_personality: false,
  include_memory: false,
  include_git_context: false,
  include_codebase_context: false,
  include_active_file_context: false,
};
const SUMMARY = '## Compacted Conversation Summary\nDerived conversation data.\n\nNine parts were read.';
const PART_OUTPUT = 'line of part text with a codeword somewhere in it. '.repeat(210); // ~10.7 KB

function createManagedService() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-bs-compact-basis-'));
  trackDirectory(userDataPath);
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });
  service.featureFlags = { ...service.featureFlags, compaction_manual: true, context_compaction: true };
  service.sidecarManager.process = { pid: 4242 };
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.ollamaManager.ensureRunning = async () => ({ ready: true, started: false, external: false, skipped: true });
  service.ollamaManager.start = async () => ({ started: false, external: false, skipped: true });
  service.ollamaManager.stop = async () => {};
  service._resolveModel = async () => 'mock-v1';
  return service;
}

function toolRound(prefix, index, output) {
  const callId = `${prefix}-call-${index}`;
  return [
    { id: `${prefix}-say-${index}`, role: 'assistant', content: `Reading part ${index}.` },
    {
      id: `${prefix}-tu-${index}`, role: 'assistant', kind: 'tool_use', content: 'read_file',
      tool_call: { call_id: callId, tool_name: 'read_file', input_json: `{"path":"b5/part-${index}.txt"}` },
    },
    {
      id: `${prefix}-tr-${index}`, role: 'tool', kind: 'tool_result',
      content: `Read b5/part-${index}.txt (120 lines)`,
      tool_result: { call_id: callId, tool_name: 'read_file', summary: `Read b5/part-${index}.txt`, output_text: output },
    },
  ];
}

// The gate's shape: one user turn with several file-read rounds, then a
// second, smaller turn.
function gateHistory() {
  return [
    { id: 'u1', role: 'user', content: 'Read the nine files one per call.' },
    ...toolRound('t1', 1, PART_OUTPUT),
    ...toolRound('t1', 2, PART_OUTPUT),
    ...toolRound('t1', 3, PART_OUTPUT),
    { id: 'a1', role: 'assistant', content: 'AMBER-FOX-41, FROST-LYNX-59, HAZEL-PIKE-63.' },
    { id: 'p1', role: 'assistant', kind: 'proactive_suggestion', content: 'Want me to read more?' },
    { id: 'u2', role: 'user', content: 'Now read note-01.' },
    ...toolRound('t2', 1, 'NOTE-01 body. '.repeat(40)),
    { id: 'a2', role: 'assistant', content: 'The codeword is IRIS-CRANE-07.' },
  ];
}

function seed(service, sessionId, messages, contextPreferences = LEAN) {
  service.sessionStore.createSessionWithId(sessionId, { title: 'F11' });
  service.sessionStore.setSessionPreferences(sessionId, { context_preferences: contextPreferences });
  for (const message of messages) service.sessionStore.appendMessage(sessionId, message);
}

// Wire-neutral projection so the compact row and the chat.send row compare on
// what the model reads: role, text, and tool identity.
function project(rows) {
  return rows.map((row) => ({
    role: row.role,
    content: row.content == null ? '' : String(row.content),
    ...(row.tool_calls ? { tool_calls: row.tool_calls } : {}),
    ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}),
  }));
}

function stubSidecar(service, captured, compactReply = () => ({ status: 'ok', compacted: false })) {
  service.sidecarClient = {
    async chatCompact(sessionId, messages) {
      captured.push({ method: 'chat.compact', sessionId, messages });
      return compactReply(messages);
    },
    async chatSend(params, { onNotification }) {
      captured.push({ method: 'chat.send', params });
      onNotification({ method: 'chat.token', params: { request_id: params.request_id, session_id: params.session_id, delta: 'ok' } });
      onNotification({ method: 'chat.done', params: { request_id: params.request_id, session_id: params.session_id } });
      return { status: 'completed' };
    },
    dispose: () => {},
    off: () => {},
  };
}

async function sendOnce(service, sessionId, prompt) {
  const completed = new Promise((resolve) => {
    service.on('chat-stream', (event) => { if (event.type === 'complete') resolve(event); });
  });
  await service.startChatStream({ sessionId, prompt });
  await completed;
}

async function compactAndSend(service, sessionId) {
  const captured = [];
  stubSidecar(service, captured);
  await service.compactContextNow(sessionId);
  await sendOnce(service, sessionId, 'NEXT PROMPT');
  const compact = captured.find((entry) => entry.method === 'chat.compact');
  const send = captured.find((entry) => entry.method === 'chat.send');
  return { compactRows: compact.messages, sendHistory: send.params.messages.slice(0, -1) };
}

test('compact payload counts the same tool output the next send carries (gate B5/2 basis)', async () => {
  const service = createManagedService();
  seed(service, 'sess-basis', gateHistory());

  const { compactRows, sendHistory } = await compactAndSend(service, 'sess-basis');

  const compactTokens = estimateMessagesTokens(compactRows);
  const sendTokens = estimateMessagesTokens(sendHistory);
  assert.ok(sendTokens > 7000, `fixture must carry ~8k tokens of tool output, got ${sendTokens}`);
  assert.equal(compactTokens, sendTokens,
    `manual compaction measured ${compactTokens} tokens; the next send carries ${sendTokens}`);
  assert.deepEqual(project(compactRows), project(sendHistory));
  service.sidecarClient = null;
  service.dispose();
});

function turnPairs(count) {
  const history = [];
  for (let turn = 1; turn <= count; turn += 1) {
    history.push({ id: `u${turn}`, role: 'user', content: `question ${turn}` });
    history.push({ id: `a${turn}`, role: 'assistant', content: `answer ${turn}` });
  }
  return history;
}

test('compact payload carries the whole history under recent scope while the send history is narrowed', async () => {
  const service = createManagedService();
  const history = turnPairs(12);
  seed(service, 'sess-recent', history, { ...LEAN, history_scope: 'recent' });

  const { compactRows, sendHistory } = await compactAndSend(service, 'sess-recent');

  assert.ok(sendHistory.length < history.length, 'recent scope must narrow the send history');
  assert.deepEqual(project(compactRows), project(history),
    'the saved summary must cover every row the snapshot replaces, so the summarizer sees all of it');
  assert.equal(compactRows[0].content, 'question 1');
  service.sidecarClient = null;
  service.dispose();
});

test('compact payload keeps an empty history under fresh scope', () => {
  const { messages } = buildCompactPayload(turnPairs(3), { contextPreferences: { ...LEAN, history_scope: 'fresh' } });
  assert.deepEqual(messages, []);
});

test('recent-scope compaction keeps its summary on the next send and after a switch to session scope', async () => {
  const service = createManagedService();
  const history = turnPairs(10);
  seed(service, 'sess-recent-snap', history, { ...LEAN, history_scope: 'recent' });
  const captured = [];
  stubSidecar(service, captured, (messages) => ({
    status: 'ok', compacted: true, strategy: 'full', tokens_before: 9000, tokens_after: 700,
    messages: [{ role: 'system', content: SUMMARY }, ...messages.slice(-2)],
  }));

  const result = await service.compactContextNow('sess-recent-snap');

  assert.equal(result.snapshot_persisted, true);
  const compact = captured.find((entry) => entry.method === 'chat.compact');
  assert.equal(compact.messages[0].content, 'question 1', 'nothing unsummarized hides behind the snapshot');
  assert.equal(compact.messages.length, history.length);

  await sendOnce(service, 'sess-recent-snap', 'NEXT PROMPT');
  const recentSend = captured.filter((entry) => entry.method === 'chat.send')[0];
  assert.deepEqual(
    recentSend.params.messages.slice(0, -1).map((row) => row.content),
    [SUMMARY, 'question 10', 'answer 10'],
    'under recent scope the summary leads the retained tail'
  );

  service.sessionStore.setSessionPreferences('sess-recent-snap', {
    context_preferences: { ...LEAN, history_scope: 'session' },
  });
  await sendOnce(service, 'sess-recent-snap', 'AFTER SWITCH');
  const sessionSend = captured.filter((entry) => entry.method === 'chat.send')[1];
  const contents = sessionSend.params.messages.slice(0, -1).map((row) => row.content);
  assert.deepEqual(contents.slice(0, 3), [SUMMARY, 'question 10', 'answer 10']);
  assert.ok(!contents.includes('question 1'), 'the summarized prefix stays replaced under session scope');
  service.sidecarClient = null;
  service.dispose();
});

test('compact payload substitutes a persisted snapshot exactly like the send path', async () => {
  const service = createManagedService();
  seed(service, 'sess-snap', gateHistory());
  const snapshot = normalizeCompactionSnapshot({
    version: 2, origin: 'manual', strategy: 'full', tokens_before: 9000, tokens_after: 300,
    boundary_message_id: 'p1', boundary_message_count: 12,
    messages: [{ role: 'system', content: SUMMARY }],
  });
  assert.ok(service.sessionStore.setCompactionSnapshot('sess-snap', snapshot));

  const { compactRows, sendHistory } = await compactAndSend(service, 'sess-snap');

  assert.equal(compactRows[0].content, SUMMARY, 'the snapshot summary leads the compact payload');
  assert.ok(!compactRows.some((row) => String(row.content || '').includes('AMBER-FOX-41')),
    'the summarized prefix must not be re-sent to the summarizer');
  assert.deepEqual(project(compactRows), project(sendHistory));
  service.sidecarClient = null;
  service.dispose();
});

test('a full result maps its verbatim tail back to the canonical boundary across folded rows', async () => {
  const service = createManagedService();
  seed(service, 'sess-fold', gateHistory());
  const captured = [];
  stubSidecar(service, captured, (messages) => {
    const tailStart = messages.map((row) => row.role).lastIndexOf('user');
    return {
      status: 'ok', compacted: true, strategy: 'full', tokens_before: 9000, tokens_after: 700,
      messages: [{ role: 'system', content: SUMMARY }, ...messages.slice(tailStart)],
    };
  });

  const result = await service.compactContextNow('sess-fold');

  assert.equal(result.snapshot_persisted, true);
  const persisted = service.sessionStore.getSession('sess-fold').compaction_snapshot;
  // u2 is canonical row 12; the snapshot covers rows 0..11 (through p1).
  assert.equal(persisted.boundary_message_count, 12);
  assert.equal(persisted.boundary_message_id, 'p1');
  assert.deepEqual(persisted.messages, [{ role: 'system', content: SUMMARY }]);

  await sendOnce(service, 'sess-fold', 'NEXT PROMPT');
  const send = captured.find((entry) => entry.method === 'chat.send');
  const contents = send.params.messages.map((row) => String(row.content || ''));
  assert.equal(contents[0], SUMMARY);
  assert.ok(!contents.some((content) => content.includes('AMBER-FOX-41')));
  assert.ok(send.params.messages.some((row) => row.tool_call_id === 't2-call-1'),
    'the kept round still reaches the next send with its tool result');
  service.sidecarClient = null;
  service.dispose();
});

test('a tail that starts inside a substituted snapshot is not persisted', async () => {
  const service = createManagedService();
  seed(service, 'sess-auto', gateHistory());
  const automatic = buildAutomaticCompactionSnapshot({
    summaryMessage: { role: 'system', content: SUMMARY },
    taskMessage: { role: 'user', content: 'Now read note-01.' },
    tokensBefore: 9000,
    tokensAfter: 300,
    boundaryMessageId: 'u2',
    boundaryMessageCount: 13,
  });
  assert.ok(service.sessionStore.setCompactionSnapshot('sess-auto', automatic));
  const captured = [];
  stubSidecar(service, captured, (messages) => ({
    status: 'ok', compacted: true, strategy: 'full', tokens_before: 900, tokens_after: 700,
    messages: [{ role: 'system', content: SUMMARY }, ...messages.slice(1)],
  }));

  const result = await service.compactContextNow('sess-auto');

  assert.equal(captured[0].messages[1].content, 'Now read note-01.', 'the task pin is the latest user row');
  assert.equal(result.snapshot_persisted, false);
  assert.equal(service.sessionStore.getSession('sess-auto').compaction_snapshot.origin, 'automatic',
    'the existing snapshot stays in place');
  service.sidecarClient = null;
  service.dispose();
});

test('run-wise preparation equals the send path list when a filtered row sits inside a fold', () => {
  const canonical = [
    { id: 'u1', role: 'user', content: 'go' },
    { id: 's1', role: 'assistant', content: 'Checking.' },
    { id: 'p1', role: 'assistant', kind: 'proactive_suggestion', content: 'tip' },
    ...toolRound('x', 1, 'OUT-1').slice(1),
    ...toolRound('x', 2, 'OUT-2').slice(1),
    { id: 'a1', role: 'assistant', content: 'done' },
  ];

  const { messages, anchors } = buildCompactPayload(canonical, { contextPreferences: LEAN });

  assert.deepEqual(project(messages), project(buildPreparedContextHistory(canonical, LEAN)));
  assert.equal(messages[1].content, 'Checking.', 'the text folds into the call across the filtered row');
  assert.deepEqual(anchors.map((anchor) => [anchor.index, anchor.origin]), [[0, 0], [1, 1], [2, 4], [4, 6], [5, 7]]);
});
