const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { workspaceRootId } = require('../services/workspace-root-identity');

const {
  handleToolNotification,
} = require('../services/backend/chat-stream-tool-handling');
const {
  normalizePersistedToolResultMetadata,
  normalizeToolResultDiffsMetadata,
  normalizeToolResultDiffMetadata,
} = require('../services/backend/tool-result-diff-metadata');

test('persisted diff metadata keeps only canonical workspace provenance', () => {
  const diff = { path: 'src/app.js', additions: 1, deletions: 0 };
  assert.equal(
    normalizePersistedToolResultMetadata({
      workspace_id: 'ROOT_AAAAAAAAAAAAAAAAAAAAAAAA',
      diff,
    }).workspace_id,
    'root_aaaaaaaaaaaaaaaaaaaaaaaa'
  );
  assert.equal(
    Object.hasOwn(normalizePersistedToolResultMetadata({ workspace_id: 'root_fake', diff }), 'workspace_id'),
    false
  );
});

function makeToolResultHarness(sessionId) {
  const messagesBySession = new Map([[sessionId, []]]);
  const turnEvents = [];
  const sessionStore = {
    getSessionMessages(id) {
      return messagesBySession.get(id) || [];
    },
    appendMessage(id, message) {
      const messages = messagesBySession.get(id) || [];
      messages.push(message);
      messagesBySession.set(id, messages);
    },
    updateMessage(id, messageId, patch) {
      const messages = messagesBySession.get(id) || [];
      const index = messages.findIndex((message) => String(message.id || '') === String(messageId || ''));
      if (index === -1) return;
      messages[index] = { ...messages[index], ...patch };
      messagesBySession.set(id, messages);
    },
  };
  const streamId = `${sessionId}-stream`;
  const service = {
    sessionStore,
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
  };
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'mock-model',
    resolvedSessionId: sessionId,
    streamId,
    eventBase: { sessionId, streamId, model: 'mock-model' },
    turnEventCollector: {
      noteEvent(event) {
        turnEvents.push(event);
        return event;
      },
    },
  };
  return { context, service, sessionStore, turnEvents };
}

test('handleToolNotification persists bounded diff metadata on tool_result turn events', () => {
  const { context, service, turnEvents } = makeToolResultHarness('session-diff');
  context.workspaceRoot = `${os.tmpdir()}/jenny-origin-workspace`;

  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-diff',
      tool_name: 'write_file',
      success: true,
      output: 'Wrote file.',
      tool_input: { path: 'src/app.js' },
      metadata: {
        diff: {
          diff_id: 'custom-diff-id',
          operation_index: 7,
          status: 'modified',
          review_state: 'full',
          body_kind: 'inline_hunks',
          additions: 1,
          deletions: 1,
          truncated: false,
          truncation_reason: null,
          before_hash: `sha256:${'b'.repeat(64)}`,
          after_hash: `sha256:${'a'.repeat(64)}`,
          hash_kind: 'diff_input_text',
          hunks: [{
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-old', '+new'],
          }],
        },
      },
    },
  });

  const turnToolResult = turnEvents.find((event) => event.kind === 'tool_result');
  assert.ok(turnToolResult);
  assert.equal(
    turnToolResult.payload.metadata.workspace_id,
    workspaceRootId(context.workspaceRoot)
  );
  assert.deepEqual(turnToolResult.payload.metadata.diff, {
    diff_id: 'custom-diff-id',
    operation_index: 7,
    status: 'modified',
    review_state: 'full',
    body_kind: 'inline_hunks',
    additions: 1,
    deletions: 1,
    truncated: false,
    truncation_reason: null,
    before_hash: `sha256:${'b'.repeat(64)}`,
    after_hash: `sha256:${'a'.repeat(64)}`,
    hash_kind: 'diff_input_text',
    hunks: [{
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ['-old', '+new'],
    }],
    path: 'src/app.js',
  });
});

test('handleToolNotification persists validated subagent reports for terminal reload', () => {
  const { context, service, sessionStore, turnEvents } = makeToolResultHarness('session-subagent-report');
  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-subagent',
      tool_name: 'subagent_run',
      success: true,
      output: '{"status":"completed"}',
      metadata: {
        subagent_report: {
          task_id: 'child-1', label: 'Inspect persistence', status: 'completed',
          summary: 'Canonical persistence was verified.',
          evidence: [{ relative_path: 'services/backend/store.js', summary: 'Writer.' }],
          tools_used: ['read_file'], uncertainties: [], budget: { elapsed_ms: 1200 },
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          raw_usage: { prompt: 'must not persist' },
        },
      },
    },
  });

  const event = turnEvents.find((entry) => entry.kind === 'tool_result');
  const message = sessionStore.getSessionMessages('session-subagent-report')
    .find((entry) => entry.tool_result?.call_id === 'call-subagent');
  assert.equal(event.payload.metadata.subagent_report.label, 'Inspect persistence');
  assert.equal(message.tool_result.metadata.subagent_report.usage.total_tokens, 120);
  assert.equal(Object.hasOwn(message.tool_result.metadata.subagent_report, 'raw_usage'), false);
});

test('handleToolNotification persists plural diff metadata and apply-patch summaries', () => {
  const { context, service, turnEvents } = makeToolResultHarness('session-apply-patch-diffs');

  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-apply-patch',
      tool_name: 'apply_patch',
      success: true,
      output: 'Applied patch.',
      tool_input: { patch: '*** Begin Patch\n*** End Patch\n' },
      metadata: {
        patch: {
          operation_count: 2,
          changed_file_count: 2,
          changed_paths: ['src/one.js', 'src/two.js', 'C:\\secret\\drop.js'],
          atomicity: 'all_or_nothing',
          success: true,
        },
        files: [
          {
            path: 'src/one.js',
            operation: 'add',
            changed: true,
            checkpoint_created: false,
          },
          {
            path: 'src/two.js',
            operation: 'update',
            changed: true,
            checkpoint_created: true,
            checkpoint_version: 3,
            checkpoint_display_path: '.jenny/backups/file@v3.bak',
          },
        ],
        diffs: [
          {
            path: 'src/one.js',
            diff_id: 'diff-one',
            operation_index: 0,
            status: 'created',
            review_state: 'full',
            body_kind: 'inline_hunks',
            additions: 1,
            deletions: 0,
            before_hash: null,
            after_hash: `sha256:${'c'.repeat(64)}`,
            hunks: [{
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              lines: ['+one'],
            }],
          },
          {
            path: 'src/two.js',
            operation_index: 1,
            status: 'modified',
            additions: 1,
            deletions: 1,
            before_hash: `sha256:${'d'.repeat(64)}`,
            after_hash: `sha256:${'e'.repeat(64)}`,
            hunks: [{
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ['-old', '+new'],
            }],
          },
        ],
      },
    },
  });

  const turnToolResult = turnEvents.find((event) => event.kind === 'tool_result');
  assert.ok(turnToolResult);
  assert.deepEqual(turnToolResult.payload.metadata.patch, {
    operation_count: 2,
    changed_file_count: 2,
    changed_paths: ['src/one.js', 'src/two.js'],
    atomicity: 'all_or_nothing',
    success: true,
  });
  assert.deepEqual(turnToolResult.payload.metadata.files, [
    {
      path: 'src/one.js',
      operation: 'add',
      changed: true,
      checkpoint_created: false,
    },
    {
      path: 'src/two.js',
      operation: 'update',
      changed: true,
      checkpoint_created: true,
      checkpoint_version: 3,
      checkpoint_display_path: '.jenny/backups/file@v3.bak',
    },
  ]);
  assert.equal(turnToolResult.payload.metadata.diffs.length, 2);
  assert.equal(turnToolResult.payload.metadata.diffs[0].path, 'src/one.js');
  assert.equal(turnToolResult.payload.metadata.diffs[0].status, 'created');
  assert.equal(turnToolResult.payload.metadata.diffs[1].path, 'src/two.js');
  assert.equal(turnToolResult.payload.metadata.diffs[1].operation_index, 1);
});

test('normalizeToolResultDiffMetadata bounds identifiers, hashes, and embedded hunk lines', () => {
  const diff = normalizeToolResultDiffMetadata({
    diff_id: `${'unsafe/'.repeat(100)}diff`,
    additions: 1,
    deletions: 0,
    before_hash: `sha256:${'z'.repeat(1000)}`,
    after_hash: `sha256:${'A'.repeat(64)}`,
    hunks: [{
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      lines: ['+first line\n+second line'],
    }],
  }, {
    streamId: 'stream/unsafe',
    callId: 'call?unsafe',
    input: { path: 'C:\\Users\\example\\secret\\file.js' },
  });

  assert.ok(diff);
  assert.match(diff.diff_id, /^stream_unsafe:call_unsafe:0:path-[a-f0-9]{16}$/);
  assert.equal(diff.diff_id.length < 80, true);
  assert.equal(diff.before_hash, null);
  assert.equal(diff.after_hash, `sha256:${'a'.repeat(64)}`);
  assert.equal(diff.truncated, true);
  assert.equal(diff.truncation_reason, 'line_limit');
  assert.deepEqual(diff.hunks, []);
});

test('normalizeToolResultDiffsMetadata drops plural entries without safe per-diff paths', () => {
  const diffs = normalizeToolResultDiffsMetadata([
    {
      operation_index: 0,
      status: 'modified',
      additions: 1,
      deletions: 0,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' a', '+b'] }],
    },
    {
      path: '..\\escape.js',
      operation_index: 1,
      status: 'modified',
      additions: 1,
      deletions: 0,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' a', '+b'] }],
    },
    {
      path: 'src/safe.js',
      operation_index: 2,
      status: 'modified',
      additions: 1,
      deletions: 0,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' a', '+b'] }],
    },
  ], {
    streamId: 'stream',
    callId: 'call',
    input: { path: 'src/fallback.js' },
  });

  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].path, 'src/safe.js');
  assert.equal(diffs[0].operation_index, 2);
});

test('handleToolNotification bounds oversized diff metadata without dropping the tool result', () => {
  const { context, service, sessionStore, turnEvents } = makeToolResultHarness('session-diff-big');

  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-diff-big',
      tool_name: 'write_file',
      success: true,
      output: 'Wrote file.',
      tool_input: { path: 'src/huge.js' },
      metadata: {
        diff: {
          additions: 1,
          deletions: 0,
          hunks: [{
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [`+${'x'.repeat(3000)}`],
          }],
        },
      },
    },
  });

  const messages = sessionStore.getSessionMessages('session-diff-big');
  assert.equal(messages.filter((message) => message.kind === 'tool_result').length, 1);
  const turnToolResult = turnEvents.find((event) => event.kind === 'tool_result');
  assert.ok(turnToolResult);
  assert.equal(turnToolResult.payload.metadata.diff.additions, 1);
  assert.equal(turnToolResult.payload.metadata.diff.truncated, true);
  assert.equal(turnToolResult.payload.metadata.diff.truncation_reason, 'line_limit');
  assert.equal(turnToolResult.payload.metadata.diff.review_state, 'summary_only');
  assert.deepEqual(turnToolResult.payload.metadata.diff.hunks, []);
});
