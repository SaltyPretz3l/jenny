'use strict';

// HB-012 (owner rule 2026-09-28): real absolute paths are presented in the
// timeline, the persisted transcript and the model's history; path redaction
// runs only when a transcript is exported. Secrets stay redacted at persist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateTurnEvent } = require('../services/backend/canonical-turn-event');
const { handleToolNotification } = require('../services/backend/chat-stream-tool-handling');
const {
  convertToolResultToProviderMessage,
  convertToolUseToProviderMessage,
} = require('../services/backend/chat-stream-reasoning');
const {
  redactTranscriptExportContent,
  redactTranscriptPaths,
} = require('../services/backend/transcript-export-redaction');
const { buildSaveFileHandler } = require('../services/save-file-handler');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { projectRows } = require('./helpers/renderer-turn-row-projector-helpers');

const PROJECT_ROOT = 'D:\\Work\\bank_recon';
const AGENT_FILE = `${PROJECT_ROOT}\\agentj.md`;
const FILE_TEXT = `- Project: bank statement reconciler, ${PROJECT_ROOT}.\ntoken sk-livesecret1234567890 stays private`;

function createSessionStore() {
  const messagesBySession = new Map();
  return {
    getSessionMessages(sessionId) {
      return messagesBySession.get(sessionId) || [];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage(sessionId, messageId, patch) {
      const messages = messagesBySession.get(sessionId) || [];
      const index = messages.findIndex((message) => String(message.id || '') === String(messageId || ''));
      if (index === -1) return;
      messages[index] = { ...messages[index], ...patch };
    },
  };
}

function canonicalEvent(type, seq, payload) {
  const result = validateTurnEvent({
    v: 1, turn_id: 'turn_paths', stream_id: 'stream_paths', seq, type,
    tool_call_id: 'call_read', payload,
  });
  assert.equal(result.status, 'accepted');
  return result.event;
}

// Drives a read_file call through the canonical bridge shape: the sidecar's
// canonical payload (validated by the Electron contract) becomes the
// persisted tool_use and tool_result rows.
function persistCanonicalReadFile() {
  const sessionStore = createSessionStore();
  const service = {
    sessionStore, emit() {}, pendingToolApprovals: new Map(),
    currentModel: 'mock-model', options: { userDataPath: os.tmpdir() },
  };
  const context = {
    seenToolCalls: new Set(), toolSummaries: new Map(), model: 'mock-model',
    resolvedSessionId: 'session-paths', streamId: 'stream_paths',
    workspaceRoot: PROJECT_ROOT,
    eventBase: { sessionId: 'session-paths', streamId: 'stream_paths', model: 'mock-model' },
  };
  const toolInput = { path: AGENT_FILE, api_key: 'do-not-keep' };
  const started = canonicalEvent('tool_execution_started', 1, { tool_name: 'read_file', tool_input: toolInput });
  const completed = canonicalEvent('tool_execution_completed', 2, {
    tool_name: 'read_file', tool_input: toolInput, success: true, tool_output_summary: FILE_TEXT,
  });
  handleToolNotification(service, context, {
    method: 'tool.executing',
    params: { tool_call_id: 'call_read', tool_name: 'read_file', tool_input: started.payload.tool_input },
  }, { canonicalEvent: true });
  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call_read', tool_name: 'read_file', success: true,
      tool_input: completed.payload.tool_input, output: completed.payload.tool_output_summary, metadata: {},
    },
  }, { canonicalEvent: true });
  return sessionStore.getSessionMessages('session-paths');
}

test('the canonical contract keeps real paths and still redacts secrets', () => {
  const event = canonicalEvent('tool_execution_completed', 3, {
    tool_name: 'read_file', success: true, tool_output_summary: FILE_TEXT,
    tool_input: { path: AGENT_FILE, token: 'abc' },
  });
  assert.equal(event.payload.tool_input.path, AGENT_FILE);
  assert.equal(event.payload.tool_input.token, '[redacted:secret]');
  assert.match(event.payload.tool_output_summary, /D:\\Work\\bank_recon\./);
  assert.doesNotMatch(event.payload.tool_output_summary, /sk-livesecret/);
  assert.doesNotMatch(JSON.stringify(event), /redacted:path/);
});

test('a persisted tool call and result round-trip their real paths to the model', () => {
  const messages = persistCanonicalReadFile();
  const toolUse = messages.find((message) => message.kind === 'tool_use');
  const toolResult = messages.find((message) => message.kind === 'tool_result');
  const serialized = JSON.stringify(messages);
  assert.doesNotMatch(serialized, /redacted:path/);
  assert.doesNotMatch(serialized, /sk-livesecret|do-not-keep/, 'secrets stay redacted at persist');
  assert.equal(toolUse.tool_call.input.path, AGENT_FILE);
  assert.deepEqual(JSON.parse(toolUse.tool_call.input_json).path, AGENT_FILE);
  assert.match(toolUse.tool_call.summary, /agentj\.md/);
  assert.match(toolResult.tool_result.output_text, /D:\\Work\\bank_recon\./);

  const replayedCall = convertToolUseToProviderMessage(toolUse);
  assert.equal(JSON.parse(replayedCall.tool_calls[0].function.arguments).path, AGENT_FILE);
  const replayedResult = convertToolResultToProviderMessage(toolResult);
  assert.match(replayedResult.content, /D:\\Work\\bank_recon\./);
});

test('the timeline tool row presents the persisted real path', () => {
  const messages = persistCanonicalReadFile();
  const { rows } = projectRows([{ id: 'user-paths', role: 'user', content: 'Read it' }, ...messages]);
  const callRow = rows.find((row) => row.kind === 'tool_call');
  assert.ok(callRow, 'the persisted tool_use projects to a tool call row');
  const markup = createTurnRowToolRenderUtils({}).buildToolCallRowMarkup(callRow, [], {});
  assert.ok(markup.includes(AGENT_FILE), 'the row shows the real absolute path');
  assert.doesNotMatch(markup, /redacted:path/);
});

// The export boundary applies the path rules persisted turn events used
// before HB-012, so an exported transcript reads exactly as they did.
const EXPORT_PATH_CASES = [
  ['Roots C:\\ and C:\\etc then read C:\\Users\\alex\\proj\\src\\foo.js',
    'Roots C:\\ and [redacted:path] then read [redacted:path]\\foo.js'],
  ['Roots / and /etc then read /home/x/proj/dir/ and /home/x/y',
    'Roots / and [redacted:path] then read [redacted:path]/dir/ and [redacted:path]/y'],
  ['Read file:///C:/Users/alex/proj/foo.js', 'Read file:///[redacted:path]/foo.js'],
  ['open file:///Users/example/notes.md then https://example.com/docs/page?q=1',
    'open file:///[redacted:path]/notes.md then https://example.com/docs/page?q=1'],
  ['Read "/var/lib/jenny"', 'Read "[redacted:path]/jenny"'],
  ["Register app.get('/api/users', handler) then GET /api/users/42 in /Users/example/.config/app.toml",
    "Register app.get('/api/users', handler) then GET /api/users/42 in [redacted:path]/app.toml"],
];

test('export redaction keeps the historical filename-preserving path rules', () => {
  for (const [input, expected] of EXPORT_PATH_CASES) {
    assert.equal(redactTranscriptPaths(input), expected, input);
  }
});

test('JSON exports are redacted structurally and stay valid JSON', () => {
  const content = JSON.stringify({ messages: [{ content: `Read ${AGENT_FILE}`, [AGENT_FILE]: 1 }] }, null, 2);
  const redacted = redactTranscriptExportContent(content, 'session-json');
  const parsed = JSON.parse(redacted);
  assert.equal(parsed.messages[0].content, 'Read [redacted:path]\\agentj.md');
  assert.deepEqual(Object.keys(parsed.messages[0]), ['content', '[redacted:path]\\agentj.md']);
  assert.ok(redacted.includes('\n  '), 'pretty-printed exports stay pretty-printed');
  assert.equal(redactTranscriptExportContent('{"broken": "G:\\\\x\\\\y', 'json').includes('G:'), false);
});

test('the save-file export boundary anonymises transcript exports and nothing else', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-export-paths-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  let nextTarget = '';
  const handler = buildSaveFileHandler({
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: nextTarget }) },
  });
  const transcript = `Jenny read ${AGENT_FILE} for you.`;
  for (const format of ['markdown', 'plain']) {
    nextTarget = path.join(tempRoot, `export.${format}`);
    const result = await handler(null, { content: transcript, format, defaultName: 'x', anonymizePaths: true });
    const written = fs.readFileSync(nextTarget, 'utf8');
    assert.equal(written, 'Jenny read [redacted:path]\\agentj.md for you.', format);
    assert.equal(result.bytesWritten, Buffer.byteLength(written, 'utf8'));
  }
  for (const format of ['json', 'session-json']) {
    nextTarget = path.join(tempRoot, `export-${format}.json`);
    await handler(null, { content: JSON.stringify({ text: transcript }), format, anonymizePaths: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(nextTarget, 'utf8')), {
      text: 'Jenny read [redacted:path]\\agentj.md for you.',
    }, format);
  }
  // Artifact downloads, usage CSVs and audit logs share this handler and
  // must be written byte-exact.
  nextTarget = path.join(tempRoot, 'artifact.md');
  await handler(null, { content: transcript, format: 'markdown' });
  assert.equal(fs.readFileSync(nextTarget, 'utf8'), transcript);
});
