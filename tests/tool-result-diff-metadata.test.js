const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { workspaceRootId } = require('../services/workspace-root-identity');

const {
  handleToolNotification,
} = require('../services/backend/chat-stream-tool-handling');
const {
  normalizePersistedToolResultMetadata,
  normalizeScriptedChangeReview,
  normalizeToolResultMetadataForStorage,
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


// Dogfood B11: the timeline reads a tool row's status from the tool_result
// turn event, whose metadata is this normalizer's output.
test('persisted metadata keeps the shell tool timed_out flag and nothing else from it', () => {
  assert.deepEqual(
    normalizePersistedToolResultMetadata({ timed_out: true, timeout_seconds: 10, shell: 'cmd' }),
    { timed_out: true },
  );
  assert.equal(normalizePersistedToolResultMetadata({ timed_out: false, shell: 'cmd' }), null);
});

// Dogfood HB-035 (B12): the row's "exit N" label reads the exit status from
// the tool_result turn event, whose metadata is this normalizer's output.
test('persisted metadata keeps the shell tool exit status', () => {
  assert.deepEqual(normalizePersistedToolResultMetadata({ exit_code: 1, shell: 'cmd' }), { exit_code: 1 });
  assert.deepEqual(normalizePersistedToolResultMetadata({ exitCode: 0 }), { exit_code: 0 });
  assert.equal(normalizePersistedToolResultMetadata({ exit_code: '1', shell: 'cmd' }), null);
});

// Row 34 S5: the user-only scripted_change_review v1 record from run_command,
// run_temp_script and python_execute results.
function scriptedReview(overrides = {}) {
  return {
    schema_version: 1,
    state: 'observed',
    certainty: 'observed_during_call',
    call_outcome: 'succeeded',
    changed_paths: ['src/app.js'],
    changed_path_count: 1,
    diff_count: 1,
    summary_only_count: 0,
    omitted_count: 0,
    coverage: 'git_status_paths',
    ...overrides,
  };
}

test('scripted change review keeps every known state and rejects anything else', () => {
  for (const state of ['observed', 'partial', 'unavailable', 'unsupported']) {
    assert.equal(normalizeScriptedChangeReview(scriptedReview({ state })).state, state);
  }
  for (const value of [
    scriptedReview({ state: 'checking' }),
    scriptedReview({ state: undefined }),
    scriptedReview({ schema_version: 2 }),
    scriptedReview({ schema_version: '1' }),
    null,
    [],
    'observed',
  ]) {
    assert.equal(normalizeScriptedChangeReview(value), null);
  }
});

test('scripted change review keeps known certainty, outcome and reason values', () => {
  for (const certainty of ['observed_during_call', 'background_window']) {
    assert.equal(normalizeScriptedChangeReview(scriptedReview({ certainty })).certainty, certainty);
  }
  assert.equal(
    normalizeScriptedChangeReview(scriptedReview({ certainty: 'certain' })).certainty,
    'background_window',
    'an unknown certainty falls back to the weaker claim'
  );
  for (const outcome of ['succeeded', 'failed', 'cancelled', 'timed_out']) {
    assert.equal(normalizeScriptedChangeReview(scriptedReview({ call_outcome: outcome })).call_outcome, outcome);
  }
  assert.equal(normalizeScriptedChangeReview(scriptedReview({ call_outcome: 'exploded' })).call_outcome, 'unknown');
  for (const reason of [
    'not_git', 'status_over_limit', 'probe_failed', 'disabled', 'no_workspace', 'background', 'payload_over_limit',
  ]) {
    assert.equal(normalizeScriptedChangeReview(scriptedReview({ state: 'unavailable', reason })).reason, reason);
  }
  const dropped = normalizeScriptedChangeReview(scriptedReview({ state: 'unavailable', reason: 'C:\\secret' }));
  assert.equal(Object.hasOwn(dropped, 'reason'), false);
  assert.equal(Object.hasOwn(normalizeScriptedChangeReview(scriptedReview()), 'reason'), false);
});

test('scripted change review bounds paths and counts', () => {
  const paths = Array.from({ length: 51 }, (_, index) => `src/file-${index}.js`);
  const review = normalizeScriptedChangeReview(scriptedReview({
    changed_paths: [...paths.slice(0, 3), '../escape.js', 'C:\\abs.js', ...paths.slice(3)],
    changed_path_count: 2,
    diff_count: -4,
    summary_only_count: 'many',
    omitted_count: 10_000_000,
    coverage: 'everything',
    extra: 'dropped',
  }));
  assert.equal(review.changed_paths.length, 50);
  assert.deepEqual(review.changed_paths.slice(0, 4), ['src/file-0.js', 'src/file-1.js', 'src/file-2.js', 'src/file-3.js']);
  assert.equal(review.changed_path_count, 50, 'the count never reads lower than the kept paths');
  assert.equal(review.diff_count, 0);
  assert.equal(review.summary_only_count, 0);
  assert.equal(review.omitted_count, 100000);
  assert.equal(Object.hasOwn(review, 'coverage'), false);
  assert.equal(Object.hasOwn(review, 'extra'), false);
  assert.equal(normalizeScriptedChangeReview(scriptedReview()).coverage, 'git_status_paths');
});

test('scripted summary-only diff reasons survive normalization', () => {
  for (const reason of ['preimage_unavailable', 'sensitive_path', 'time_limit']) {
    const [diff] = normalizeToolResultDiffsMetadata([{
      diff_id: `diff:${reason}`, path: '.env', status: 'modified', review_state: 'summary_only',
      body_kind: 'summary_only', additions: 0, deletions: 0, truncated: true, truncation_reason: reason,
      before_hash: null, after_hash: null, hunks: [],
    }]);
    assert.equal(diff.truncation_reason, reason);
    assert.equal(diff.review_state, 'summary_only');
  }
});

test('storage keeps only the normalized scripted change review', () => {
  const metadata = {
    stdout: 'ok',
    exit_code: 1,
    scripted_change_review: scriptedReview({ call_outcome: 'failed', secret: 'x', changed_paths: ['/etc/passwd', 'a.txt'] }),
  };
  const persisted = normalizePersistedToolResultMetadata(metadata);
  assert.deepEqual(persisted.scripted_change_review.changed_paths, ['a.txt']);
  const stored = normalizeToolResultMetadataForStorage(metadata);
  assert.equal(stored.stdout, 'ok');
  assert.deepEqual(stored.scripted_change_review, persisted.scripted_change_review);
  assert.equal(Object.hasOwn(stored.scripted_change_review, 'secret'), false);
  const invalid = normalizeToolResultMetadataForStorage({ scripted_change_review: { state: 'observed' } });
  assert.equal(Object.hasOwn(invalid, 'scripted_change_review'), false);
});

test('scripted change review keeps a bounded restore point and drops a malformed one', () => {
  const checkpoint = { kind: 'git_checkpoint', ref: 'refs/jenny/checkpoints/s1/3', created_at: '2026-10-05T12:00:00.000Z' };
  assert.deepEqual(normalizeScriptedChangeReview(scriptedReview({ restore_point: { ...checkpoint, extra: 1 } })).restore_point, checkpoint);
  assert.deepEqual(
    normalizeScriptedChangeReview(scriptedReview({ restore_point: { kind: 'head', created_at: '2026-10-05T12:00:00Z' } })).restore_point,
    { kind: 'head', created_at: '2026-10-05T12:00:00Z' }
  );
  assert.deepEqual(
    normalizeScriptedChangeReview(scriptedReview({ restore_point: { kind: 'none', reason: 'not_git' } })).restore_point,
    { kind: 'none', reason: 'not_git' }
  );
  for (const bad of [
    { ...checkpoint, ref: 'refs/heads/main' },
    { ...checkpoint, ref: 'refs/jenny/checkpoints/../x/1' },
    { ...checkpoint, created_at: 'yesterday' },
    { kind: 'none', reason: 'because' },
    { kind: 'head' },
    'refs/jenny/checkpoints/s1/3',
  ]) {
    assert.equal(Object.hasOwn(normalizeScriptedChangeReview(scriptedReview({ restore_point: bad })), 'restore_point'), false);
  }
});
