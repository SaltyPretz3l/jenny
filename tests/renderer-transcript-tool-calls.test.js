const assert = require('node:assert/strict');
const test = require('node:test');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const {
  createTranscriptToolCallRenderer,
} = require('../renderer/chat/renderer-transcript-tool-calls');

function createRenderer() {
  return createTranscriptToolCallRenderer({
    escapeHtml,
    toolCallUtils,
  });
}

test('delegate terminal results render the subagent inspector summary', () => {
  const renderer = createRenderer();
  const toolUseMessage = {
    id: 'tool_use_delegate',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_delegate',
      tool_name: 'delegate',
      input: { tasks: ['Inspect the repository'] },
      status: 'completed',
    },
  };
  const toolResultMessage = {
    id: 'tool_result_delegate',
    role: 'tool',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call_delegate',
      tool_name: 'delegate',
      output_text: '{"status":"completed"}',
      summary: 'Delegation completed.',
      is_error: false,
      metadata: {
        subagent_batch_report: {
          batch_id: 'delegate:request:call_delegate',
          source_tool: 'delegate',
          status: 'completed',
          execution: 'single',
          tasks: [{
            task_id: 'delegate:request:call_delegate:task:1',
            ordinal: 1,
            label: 'Task 1',
            status: 'completed',
            summary: 'Repository inspected.',
            evidence: [],
            tools_used: ['read_file'],
            budget: { elapsed_ms: 1_000 },
          }],
          budget: { elapsed_ms: 1_000 },
        },
      },
    },
  };

  const html = renderer.renderToolCallBlock(
    toolUseMessage,
    [toolUseMessage, toolResultMessage]
  );

  assert.match(html, /subagent-summary-trigger/);
  assert.match(html, /data-subagent-open="call_delegate"/);
  assert.match(html, /Delegated research/);
  assert.doesNotMatch(html, /tool-call-disclosure/);
});

test('tool transcript view model can be derived from a projected tool_step row with paired result metadata', () => {
  const renderer = createRenderer();
  const toolUseMessage = {
    id: 'tool_use_call_1',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_1',
      tool_name: 'run_command',
      input: { command: 'npm test' },
      input_json: '{"command":"npm test"}',
      summary: 'run_command npm test',
      status: 'completed',
    },
  };
  const toolResultMessage = {
    id: 'tool_result_call_1',
    role: 'assistant',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call_1',
      tool_name: 'run_command',
      output_text: 'ok',
      summary: 'Tests passed.',
      is_error: false,
      duration_ms: 2500,
      generated_artifacts: [{ artifactId: 'artifact_1', title: 'log.txt' }],
      metadata: { exitCode: 0 },
    },
  };
  const projectedToolRow = {
    kind: 'tool_step',
    tool_call_id: 'call_1',
    primary_message_id: 'tool_use_call_1',
    source_message_ids: ['tool_use_call_1', 'tool_result_call_1'],
    payload: {
      tool_call_id: 'call_1',
      tool_name: 'run_command',
      input: { command: 'npm test' },
      input_json: '{"command":"npm test"}',
      summary: 'run_command npm test',
      state: 'completed',
      output_text: 'ok',
      result_summary: 'Tests passed.',
      result_is_error: false,
      error_code: '',
    },
  };
  const messageById = new Map([
    ['tool_use_call_1', toolUseMessage],
    ['tool_result_call_1', toolResultMessage],
  ]);

  const viewModel = renderer.buildToolCallViewModel(
    toolUseMessage,
    [toolUseMessage, toolResultMessage],
    {
      projectedToolRow,
      messageById,
    }
  );

  assert.equal(viewModel.callId, 'call_1');
  assert.equal(viewModel.status, 'completed');
  assert.equal(viewModel.toolKind, 'Bash');
  assert.equal(viewModel.outputText, 'ok');
  assert.equal(viewModel.metadata.exitCode, 0);
  assert.equal(viewModel.generatedArtifacts.length, 1);
  assert.equal(viewModel.durationLabel, '2.5s');
});

test('tool transcript legacy view model treats a successful result as completed after a stale running use', () => {
  const renderer = createRenderer();
  const toolUseMessage = {
    id: 'tool_use_call_success_after_running',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_success_after_running',
      tool_name: 'Read',
      input: { file_path: 'notes.md' },
      input_json: '{"file_path":"notes.md"}',
      summary: 'Read notes.md',
      status: 'running',
      duration_ms: 1200,
    },
  };
  const toolResultMessage = {
    id: 'tool_result_call_success_after_running',
    role: 'assistant',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call_success_after_running',
      tool_name: 'Read',
      output_text: 'These are the notes.',
      summary: 'Read complete.',
      is_error: false,
      duration_ms: 0,
      generated_artifacts: [],
      metadata: {},
    },
  };

  const viewModel = renderer.buildToolCallViewModel(
    toolUseMessage,
    [toolUseMessage, toolResultMessage]
  );

  assert.equal(viewModel.status, 'completed');
  assert.equal(viewModel.isRunning, false);
  assert.equal(viewModel.statusLabel, 'Success');
  assert.equal(viewModel.defaultExpanded, false);
  assert.equal(viewModel.outputText, 'These are the notes.');
  assert.equal(viewModel.durationLabel, '1.2s');
});

test('tool transcript row view model settles a stuck running projected row to completed when a result exists', () => {
  // Defense in depth for the trace-mode "stuck on Running…" bug: even with no
  // canonical match, a projected tool_call row carrying state 'running' must
  // settle to a terminal status when a real result is present for the call.
  const renderer = createRenderer();
  const toolUseMessage = {
    id: 'tool_use_row_stuck_running',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_row_stuck',
      tool_name: 'worktree_create',
      input: { action: 'invoke' },
      status: 'running',
    },
  };
  const toolResultMessage = {
    id: 'tool_result_row_stuck_running',
    role: 'assistant',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call_row_stuck',
      tool_name: 'worktree_create',
      output_text: 'invoked',
      summary: 'Invoked the interaction card.',
      is_error: false,
    },
  };
  const projectedToolRow = {
    kind: 'tool_call',
    tool_call_id: 'call_row_stuck',
    primary_message_id: 'tool_use_row_stuck_running',
    source_message_ids: ['tool_use_row_stuck_running'],
    payload: {
      tool_call_id: 'call_row_stuck',
      tool_name: 'worktree_create',
      input: { action: 'invoke' },
      state: 'running',
    },
  };

  // No canonicalToolCall is threaded, mirroring the unmatched-call_id path.
  const viewModel = renderer.buildToolCallViewModel(
    toolUseMessage,
    [toolUseMessage, toolResultMessage],
    { projectedToolRow }
  );

  assert.equal(viewModel.status, 'completed');
  assert.equal(viewModel.isRunning, false);
  assert.equal(viewModel.statusLabel, 'Success');
});

test('legacy fallback never attaches a repeated call id result from an earlier turn', () => {
  const renderer = createRenderer();
  const earlierUse = {
    id: 'tool_use_old', role: 'assistant', kind: 'tool_use',
    tool_call: { call_id: 'call_1', tool_name: 'run_command', status: 'running', input: { command: 'old' } },
  };
  const earlierResult = {
    id: 'tool_result_old', role: 'assistant', kind: 'tool_result',
    tool_result: { call_id: 'call_1', output_text: 'OLD OUTPUT', is_error: false },
  };
  const nextUser = { id: 'user_next', role: 'user', kind: 'message', content: 'next' };
  const currentUse = {
    id: 'tool_use_new', role: 'assistant', kind: 'tool_use',
    tool_call: { call_id: 'call_1', tool_name: 'run_command', status: 'running', input: { command: 'new' } },
  };
  const viewModel = renderer.buildToolCallViewModel(
    currentUse,
    [earlierUse, earlierResult, nextUser, currentUse]
  );
  assert.equal(viewModel.status, 'running');
  assert.equal(viewModel.outputText, '');
});

test('projected rows settle stale interrupted and approval states from authoritative results', () => {
  const renderer = createRenderer();
  for (const staleState of ['interrupted', 'awaiting_approval']) {
    const callId = `call_${staleState}`;
    const use = {
      id: `use_${staleState}`, role: 'assistant', kind: 'tool_use',
      tool_call: { call_id: callId, tool_name: 'run_command', status: staleState },
    };
    const result = {
      id: `result_${staleState}`, role: 'assistant', kind: 'tool_result',
      tool_result: { call_id: callId, output_text: 'done', is_error: false },
    };
    const row = {
      kind: 'tool_call', turn_id: `turn_${staleState}`, row_id: `row_${staleState}`,
      primary_message_id: use.id, source_message_ids: [use.id, result.id],
      payload: { tool_call_id: callId, tool_name: 'run_command', state: staleState },
    };
    const viewModel = renderer.buildToolCallViewModel(use, [use, result], {
      projectedToolRow: row,
      messageById: new Map([[use.id, use], [result.id, result]]),
    });
    assert.equal(viewModel.status, 'completed', `${staleState} must settle`);
  }
});

test('tool transcript row view model leaves a running projected row untouched when no result exists', () => {
  // The guard must only fire when a result is actually present, so a genuinely
  // in-flight tool keeps its live status.
  const renderer = createRenderer();
  const toolUseMessage = {
    id: 'tool_use_row_live_running',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_row_live',
      tool_name: 'worktree_create',
      input: { action: 'invoke' },
      status: 'running',
    },
  };
  const projectedToolRow = {
    kind: 'tool_call',
    tool_call_id: 'call_row_live',
    primary_message_id: 'tool_use_row_live_running',
    source_message_ids: ['tool_use_row_live_running'],
    payload: {
      tool_call_id: 'call_row_live',
      tool_name: 'worktree_create',
      input: { action: 'invoke' },
      state: 'running',
    },
  };

  const viewModel = renderer.buildToolCallViewModel(
    toolUseMessage,
    [toolUseMessage],
    { projectedToolRow }
  );

  assert.equal(viewModel.status, 'running');
  assert.equal(viewModel.isRunning, true);
});

test('tool transcript legacy view model accepts camelCase result compatibility fields', () => {
  const renderer = createRenderer();
  const toolUseMessage = {
    id: 'tool_use_call_camel_result',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_camel_result',
      tool_name: 'Read',
      input: { file_path: 'compat.md' },
      input_json: '{"file_path":"compat.md"}',
      summary: 'Read compat.md',
      status: 'running',
    },
  };
  const toolResultMessage = {
    id: 'tool_result_call_camel_result',
    role: 'assistant',
    kind: 'tool_result',
    tool_result: {
      callId: 'call_camel_result',
      toolName: 'Read',
      outputText: 'Compatibility result.',
      summary: 'Read complete.',
      isError: false,
      durationMs: 80,
      generatedArtifacts: [{ artifactId: 'artifact_compat', title: 'compat.md' }],
      metadata: { exitCode: 0 },
    },
  };

  const viewModel = renderer.buildToolCallViewModel(
    toolUseMessage,
    [toolUseMessage, toolResultMessage]
  );

  assert.equal(viewModel.status, 'completed');
  assert.equal(viewModel.isRunning, false);
  assert.equal(viewModel.outputText, 'Compatibility result.');
  assert.equal(viewModel.durationLabel, '0.1s');
  assert.equal(viewModel.generatedArtifacts.length, 1);
  assert.equal(viewModel.metadata.exitCode, 0);
});

test('tool transcript view model normalizes canonical approval and interrupted row states', () => {
  const renderer = createRenderer();
  const toolUseMessage = {
    id: 'tool_use_call_2',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_2',
      tool_name: 'Read',
      input: { path: 'notes.md' },
      input_json: '{"path":"notes.md"}',
      summary: 'Read notes.md',
      status: 'pending_approval',
    },
  };

  const awaitingApprovalViewModel = renderer.buildToolCallViewModel(
    toolUseMessage,
    [toolUseMessage],
    {
      projectedToolRow: {
        kind: 'tool_step',
        tool_call_id: 'call_2',
        primary_message_id: 'tool_use_call_2',
        source_message_ids: ['tool_use_call_2'],
        payload: {
          tool_call_id: 'call_2',
          tool_name: 'Read',
          input: { path: 'notes.md' },
          input_json: '{"path":"notes.md"}',
          summary: 'Read notes.md',
          state: 'awaiting_approval',
        },
      },
      messageById: new Map([['tool_use_call_2', toolUseMessage]]),
    }
  );

  assert.equal(awaitingApprovalViewModel.status, 'awaiting_approval');
  assert.equal(awaitingApprovalViewModel.isPending, true);
  assert.equal(awaitingApprovalViewModel.defaultExpanded, true);

  const interruptedViewModel = renderer.buildToolCallViewModel(
    toolUseMessage,
    [toolUseMessage],
    {
      projectedToolRow: {
        kind: 'tool_step',
        tool_call_id: 'call_2',
        primary_message_id: 'tool_use_call_2',
        source_message_ids: ['tool_use_call_2'],
        payload: {
          tool_call_id: 'call_2',
          tool_name: 'Read',
          input: { path: 'notes.md' },
          input_json: '{"path":"notes.md"}',
          summary: 'Read notes.md',
          state: 'interrupted',
        },
      },
      messageById: new Map([['tool_use_call_2', toolUseMessage]]),
    }
  );

  assert.equal(interruptedViewModel.status, 'interrupted');
  assert.equal(interruptedViewModel.isPending, false);
  assert.equal(interruptedViewModel.defaultExpanded, false);
});

test('tool transcript projected rows still recover real tool_result metadata when provenance ids are incomplete', () => {
  const renderer = createRenderer();
  const toolUseMessage = {
    id: 'tool_use_call_3',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_3',
      tool_name: 'run_command',
      input: { command: 'npm run lint' },
      input_json: '{"command":"npm run lint"}',
      summary: 'run_command npm run lint',
      status: 'completed',
      duration_ms: 1200,
    },
  };
  const toolResultMessage = {
    id: 'tool_result_call_3',
    role: 'assistant',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call_3',
      tool_name: 'run_command',
      output_text: 'lint ok',
      summary: 'Lint passed.',
      is_error: false,
      duration_ms: 1800,
      generated_artifacts: [{ artifactId: 'artifact_lint', title: 'lint.log' }],
      metadata: { exitCode: 0 },
    },
  };

  const viewModel = renderer.buildToolCallViewModel(
    toolUseMessage,
    [toolUseMessage, toolResultMessage],
    {
      projectedToolRow: {
        kind: 'tool_step',
        tool_call_id: 'call_3',
        primary_message_id: 'tool_use_call_3',
        source_message_ids: ['tool_use_call_3'],
        payload: {
          tool_call_id: 'call_3',
          tool_name: 'run_command',
          input: { command: 'npm run lint' },
          input_json: '{"command":"npm run lint"}',
          summary: 'run_command npm run lint',
          state: 'completed',
        },
      },
      messageById: new Map([
        ['tool_use_call_3', toolUseMessage],
      ]),
    }
  );

  assert.equal(viewModel.outputText, 'lint ok');
  assert.equal(viewModel.metadata.exitCode, 0);
  assert.equal(viewModel.generatedArtifacts.length, 1);
  assert.equal(viewModel.durationLabel, '1.8s');
});

test('tool transcript omits duplicate summary when it only repeats the display name', () => {
  const renderer = createRenderer();
  const toolUseMessage = {
    id: 'tool_use_harness',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_harness',
      tool_name: 'inspect_harness',
      summary: 'Inspect Harness',
      status: 'completed',
    },
  };

  const viewModel = renderer.buildToolCallViewModel(
    toolUseMessage,
    [toolUseMessage],
    {
      projectedToolRow: {
        kind: 'tool_step',
        tool_call_id: 'call_harness',
        primary_message_id: 'tool_use_harness',
        source_message_ids: ['tool_use_harness'],
        payload: {
          tool_call_id: 'call_harness',
          tool_name: 'inspect_harness',
          summary: 'Inspect Harness',
          state: 'completed',
        },
      },
      messageById: new Map([['tool_use_harness', toolUseMessage]]),
    }
  );

  assert.equal(viewModel.displayToolName, 'Inspect Harness');
  assert.equal(viewModel.summary, '');
});

test('tool transcript projected rows ignore malformed payload input and fall back to the tool_use input', () => {
  const renderer = createRenderer();
  const toolUseMessage = {
    id: 'tool_use_call_4',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_4',
      tool_name: 'Read',
      input: { file_path: 'notes.md' },
      input_json: '{"file_path":"notes.md"}',
      summary: 'Read notes.md',
      status: 'requested',
    },
  };

  const viewModel = renderer.buildToolCallViewModel(
    toolUseMessage,
    [toolUseMessage],
    {
      projectedToolRow: {
        kind: 'tool_step',
        tool_call_id: 'call_4',
        primary_message_id: 'tool_use_call_4',
        source_message_ids: ['tool_use_call_4'],
        payload: {
          tool_call_id: 'call_4',
          tool_name: 'Read',
          input: ['notes.md'],
          input_json: '',
          summary: '',
          state: 'requested',
        },
      },
      messageById: new Map([['tool_use_call_4', toolUseMessage]]),
    }
  );

  assert.deepEqual(viewModel.input, { file_path: 'notes.md' });
  assert.equal(viewModel.summary, 'Read notes.md');
  assert.equal(viewModel.inputJson, '{"file_path":"notes.md"}');
});

/* ──────────────────────────────────────────────────────────────────────
 * Phase 7 §4a: collapsed-default + session-scoped expansion persistence.
 *
 * Status-derived auto-expand still fires for action-required rows
 * (errored / awaiting_approval / etc.). A user toggle, recorded via
 * setToolCallExpansion, takes precedence over the default for the
 * remainder of the session, regardless of direction.
 * ────────────────────────────────────────────────────────────────────── */

/* Tool fixture presets keyed by status — single source of per-status
 * payload shape so the builder below can stay generic. */
const RUN_COMMAND_FIXTURE = {
  toolName: 'run_command',
  input: { command: 'npm test' },
  inputJson: '{"command":"npm test"}',
  summary: 'run_command npm test',
};

const TOOL_FIXTURE_PRESETS = {
  completed: {
    toolName: 'Read',
    input: { file_path: 'notes.md' },
    inputJson: '{"file_path":"notes.md"}',
    summary: 'Read notes.md',
    state: 'completed',
    resultIsError: false,
  },
  // The three run_command presets differ only in state and whether a result
  // came back as an error, so they share one payload shape.
  awaiting_approval: { ...RUN_COMMAND_FIXTURE, state: 'awaiting_approval', resultIsError: false },
  errored: { ...RUN_COMMAND_FIXTURE, state: 'errored', resultIsError: true },
  blocked: { ...RUN_COMMAND_FIXTURE, state: 'blocked', resultIsError: true },
};

function buildToolViewModelFixture(renderer, callId, presetKey) {
  const preset = TOOL_FIXTURE_PRESETS[presetKey];
  if (!preset) throw new Error('unknown tool fixture preset: ' + presetKey);
  const messageId = 'tool_use_' + callId;
  const toolUseMessage = {
    id: messageId,
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: callId,
      tool_name: preset.toolName,
      input: preset.input,
      input_json: preset.inputJson,
      summary: preset.summary,
      status: preset.state,
    },
  };
  return renderer.buildToolCallViewModel(
    toolUseMessage,
    [toolUseMessage],
    {
      projectedToolRow: {
        kind: 'tool_step',
        tool_call_id: callId,
        primary_message_id: messageId,
        source_message_ids: [messageId],
        payload: {
          tool_call_id: callId,
          tool_name: preset.toolName,
          input: preset.input,
          input_json: preset.inputJson,
          summary: preset.summary,
          state: preset.state,
          result_is_error: preset.resultIsError,
        },
      },
      messageById: new Map([[messageId, toolUseMessage]]),
    }
  );
}

test('phase 7: completed tool calls default to collapsed', () => {
  const renderer = createRenderer();
  const viewModel = buildToolViewModelFixture(renderer, 'phase7_call_collapsed_default', 'completed');
  assert.equal(viewModel.status, 'completed');
  assert.equal(viewModel.defaultExpanded, false,
    'completed rows should default to collapsed');
  assert.equal(viewModel.detailsMaterialized, false);
});

test('legacy fallback defers collapsed payload DOM and bounds first materialization', () => {
  const renderer = createRenderer();
  const hugeCommand = `echo ${'x'.repeat(1_000_000)}`;
  const message = {
    id: 'legacy_huge_tool',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'legacy_huge_call',
      tool_name: 'run_command',
      status: 'completed',
      input: { command: hugeCommand },
      input_json: JSON.stringify({ command: hugeCommand }),
    },
  };

  const collapsed = renderer.renderToolCallBlock(message, [message], {
    sessionId: 'session-a', turnId: 'turn-a', rowId: 'row-a',
  });
  assert.match(collapsed, /data-tool-details-materialized="false"/);
  assert.doesNotMatch(collapsed, /inv-codeblock|tool-call-input|x{100}/);
  assert.ok(collapsed.length < 10_000);

  const materialized = renderer.renderToolCallBlock(message, [message], {
    sessionId: 'session-a', turnId: 'turn-a', rowId: 'row-a', forceMaterializeToolDetails: true,
  });
  assert.match(materialized, /data-tool-details-materialized="true"/);
  assert.match(materialized, /data-detail-capped="true"/);
  assert.match(materialized, /Copy all \(/);
  assert.doesNotMatch(materialized, /data-inv-truncation-marker/);
  assert.ok(materialized.length < 30_000, `materialized legacy preview must stay bounded, got ${materialized.length}`);
});

test('phase 7: only a call still awaiting the user auto-expands by default', () => {
  const renderer = createRenderer();
  const waiting = buildToolViewModelFixture(renderer, 'phase7_call_awaiting_default', 'awaiting_approval');
  assert.equal(waiting.defaultExpanded, true,
    'a call still waiting on the user should open itself');
  // Failures are settled rows: the status label and severity tint report them.
  for (const status of ['errored', 'blocked']) {
    const viewModel = buildToolViewModelFixture(renderer, `phase7_call_${status}_default`, status);
    assert.equal(viewModel.status, status);
    assert.equal(viewModel.defaultExpanded, false,
      `${status} rows should stay collapsed like every other finished row`);
  }
});

test('phase 7: user expansion override wins over the collapsed default', () => {
  const renderer = createRenderer();
  const callId = 'phase7_call_user_expanded';

  const before = buildToolViewModelFixture(renderer, callId, 'completed');
  assert.equal(before.defaultExpanded, false);

  renderer.setToolCallExpansion(before.rowKey, true);
  assert.equal(renderer.getToolCallExpansion(before.rowKey), true);

  const after = buildToolViewModelFixture(renderer, callId, 'completed');
  assert.equal(after.defaultExpanded, true,
    'a user-recorded expand should override the collapsed default');
});

test('phase 7: user collapse override wins over a status-derived auto-expand', () => {
  const renderer = createRenderer();
  const callId = 'phase7_call_user_collapsed_awaiting';

  const before = buildToolViewModelFixture(renderer, callId, 'awaiting_approval');
  assert.equal(before.defaultExpanded, true);

  renderer.setToolCallExpansion(before.rowKey, false);
  assert.equal(renderer.getToolCallExpansion(before.rowKey), false);

  const after = buildToolViewModelFixture(renderer, callId, 'awaiting_approval');
  assert.equal(after.defaultExpanded, false,
    'a user-recorded collapse should suppress the awaiting-approval auto-expand');
});

test('phase 7: clearToolCallExpansionOverrides reverts every row to its status-derived default', () => {
  const renderer = createRenderer();
  const completedCallId = 'phase7_call_clear_completed';
  const awaitingCallId = 'phase7_call_clear_awaiting';

  const completedBefore = buildToolViewModelFixture(renderer, completedCallId, 'completed');
  const awaitingBefore = buildToolViewModelFixture(renderer, awaitingCallId, 'awaiting_approval');
  renderer.setToolCallExpansion(completedBefore.rowKey, true);
  renderer.setToolCallExpansion(awaitingBefore.rowKey, false);
  assert.equal(buildToolViewModelFixture(renderer, completedCallId, 'completed').defaultExpanded, true);
  assert.equal(buildToolViewModelFixture(renderer, awaitingCallId, 'awaiting_approval').defaultExpanded, false);

  renderer.clearToolCallExpansionOverrides();
  assert.equal(renderer.getToolCallExpansion(completedBefore.rowKey), undefined);
  assert.equal(renderer.getToolCallExpansion(awaitingBefore.rowKey), undefined);
  assert.equal(buildToolViewModelFixture(renderer, completedCallId, 'completed').defaultExpanded, false,
    'after clear, completed reverts to collapsed default');
  assert.equal(buildToolViewModelFixture(renderer, awaitingCallId, 'awaiting_approval').defaultExpanded, true,
    'after clear, awaiting approval reverts to auto-expand default');
});

test('phase 7: empty / blank call ids are silently ignored by setToolCallExpansion', () => {
  const renderer = createRenderer();
  renderer.setToolCallExpansion('', true);
  renderer.setToolCallExpansion('   ', true);
  renderer.setToolCallExpansion(null, true);
  renderer.setToolCallExpansion(undefined, true);
  assert.equal(renderer.getToolCallExpansion(''), undefined);
  assert.equal(renderer.getToolCallExpansion('   '), undefined);
  assert.equal(renderer.getToolCallExpansion(null), undefined);
  assert.equal(renderer.getToolCallExpansion(undefined), undefined);
});

function buildToolCallRowWithDiff(overrides = {}) {
  const toolUseMessage = {
    id: 'tool_use_call_diff',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_diff',
      tool_name: 'Write',
      input: { path: 'src/example.js', content: 'const a = 1;' },
      input_json: '{"path":"src/example.js","content":"const a = 1;"}',
      summary: 'Write src/example.js',
      status: 'completed',
    },
  };
  const toolResultMessage = {
    id: 'tool_result_call_diff',
    role: 'assistant',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call_diff',
      tool_name: 'Write',
      output_text: '',
      summary: 'wrote file',
      is_error: false,
      duration_ms: 100,
      generated_artifacts: [],
      metadata: overrides.metadata || {
        diff: {
          diff_id: 'turn_diff:call_diff:0:abc',
          operation_index: 0,
          status: 'modified',
          review_state: 'full',
          body_kind: 'inline_hunks',
          additions: 1,
          deletions: 0,
          truncated: false,
          hunks: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] },
          ],
          path: 'src/example.js',
        },
      },
    },
  };
  const projectedToolRow = {
    kind: 'tool_step',
    tool_call_id: 'call_diff',
    turn_id: 'turn_diff',
    primary_message_id: 'tool_use_call_diff',
    source_message_ids: ['tool_use_call_diff', 'tool_result_call_diff'],
    payload: {
      tool_call_id: 'call_diff',
      tool_name: 'Write',
      input: { path: 'src/example.js' },
      input_json: '{"path":"src/example.js"}',
      summary: 'Write src/example.js',
      state: 'completed',
      output_text: '',
      result_summary: 'wrote file',
      result_is_error: false,
      error_code: '',
      metadata: overrides.metadata || toolResultMessage.tool_result.metadata,
    },
  };
  const messageById = new Map([
    ['tool_use_call_diff', toolUseMessage],
    ['tool_result_call_diff', toolResultMessage],
  ]);
  return { toolUseMessage, toolResultMessage, projectedToolRow, messageById };
}

test('phase 3B: successful Write tool row surfaces a reviewableChange on the view model', () => {
  const renderer = createRenderer();
  const fixture = buildToolCallRowWithDiff();
  const viewModel = renderer.buildToolCallViewModel(
    fixture.toolUseMessage,
    [fixture.toolUseMessage, fixture.toolResultMessage],
    {
      projectedToolRow: fixture.projectedToolRow,
      messageById: fixture.messageById,
    }
  );
  assert.ok(viewModel.reviewableChange, 'reviewableChange should be attached');
  assert.equal(viewModel.reviewableChange.turnId, 'turn_diff');
  assert.equal(viewModel.reviewableChange.path, 'src/example.js');
  assert.equal(viewModel.reviewableChange.toolName, 'Write');
});

test('phase 3B: tool row without diff metadata does not attach a reviewableChange', () => {
  const renderer = createRenderer();
  const fixture = buildToolCallRowWithDiff({ metadata: { someOther: 'thing' } });
  const viewModel = renderer.buildToolCallViewModel(
    fixture.toolUseMessage,
    [fixture.toolUseMessage, fixture.toolResultMessage],
    {
      projectedToolRow: fixture.projectedToolRow,
      messageById: fixture.messageById,
    }
  );
  assert.equal(viewModel.reviewableChange, null);
});

test('phase 3B: failed-diff tool row still surfaces a reviewableChange so the affordance can render', () => {
  const renderer = createRenderer();
  const failedMetadata = {
    diff: {
      operation_index: 0,
      status: 'modified',
      review_state: 'failed',
      body_kind: 'none',
      additions: 0,
      deletions: 0,
      truncated: true,
      truncation_reason: 'diff_generation_failed',
      hunks: [],
      path: 'src/example.js',
    },
  };
  const fixture = buildToolCallRowWithDiff({ metadata: failedMetadata });
  const viewModel = renderer.buildToolCallViewModel(
    fixture.toolUseMessage,
    [fixture.toolUseMessage, fixture.toolResultMessage],
    {
      projectedToolRow: fixture.projectedToolRow,
      messageById: fixture.messageById,
    }
  );
  assert.ok(viewModel.reviewableChange, 'reviewableChange should still attach for failed diffs');
  assert.equal(viewModel.reviewableChange.reviewState, 'failed');
});

test('phase 3B: renderToolCallBlock emits the Review changes affordance with code-review datasets', () => {
  const renderer = createRenderer();
  const fixture = buildToolCallRowWithDiff();
  const html = renderer.renderToolCallBlock(
    fixture.toolUseMessage,
    [fixture.toolUseMessage, fixture.toolResultMessage],
    {
      projectedToolRow: fixture.projectedToolRow,
      messageById: fixture.messageById,
    }
  );
  assert.ok(html.includes('data-jenny-code-review'), 'HTML should contain the data-jenny-code-review affordance');
  assert.ok(html.includes('data-scope="change"'));
  assert.ok(html.includes('data-turn-id="turn_diff"'));
  assert.ok(/data-change-id="[^"]+"/.test(html));
  assert.ok(html.includes('title="Review this change in the diff panel"'));
});

test('apply_patch multi-file tool row routes review to the turn scope', () => {
  const renderer = createRenderer();
  const metadata = {
    diffs: [
      {
        diff_id: 'turn_diff:call_diff:0:one',
        operation_index: 0,
        status: 'modified',
        review_state: 'full',
        body_kind: 'inline_hunks',
        additions: 1,
        deletions: 0,
        truncated: false,
        hunks: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] },
        ],
        path: 'src/one.js',
      },
      {
        diff_id: 'turn_diff:call_diff:1:two',
        operation_index: 1,
        status: 'modified',
        review_state: 'full',
        body_kind: 'inline_hunks',
        additions: 1,
        deletions: 1,
        truncated: false,
        hunks: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
        ],
        path: 'src/two.js',
      },
    ],
  };
  const fixture = buildToolCallRowWithDiff({ metadata });
  const viewModel = renderer.buildToolCallViewModel(
    fixture.toolUseMessage,
    [fixture.toolUseMessage, fixture.toolResultMessage],
    {
      projectedToolRow: fixture.projectedToolRow,
      messageById: fixture.messageById,
    }
  );

  assert.ok(viewModel.reviewableChange, 'reviewableChange should be attached');
  assert.equal(viewModel.reviewableChange.scope, 'turn');
  assert.equal(viewModel.reviewableChange.turnId, 'turn_diff');
  assert.equal(viewModel.reviewableChange.changeCount, 2);

  const html = renderer.renderToolCallBlock(
    fixture.toolUseMessage,
    [fixture.toolUseMessage, fixture.toolResultMessage],
    {
      projectedToolRow: fixture.projectedToolRow,
      messageById: fixture.messageById,
    }
  );

  assert.ok(html.includes('data-jenny-code-review'), 'HTML should contain the data-jenny-code-review affordance');
  assert.ok(html.includes('data-scope="turn"'));
  assert.ok(html.includes('data-turn-id="turn_diff"'));
  assert.equal(/data-change-id=/.test(html), false);
});

test('module-level expansion facade forwards to the active renderer (search-overlay contract)', () => {
  // renderer-chat-search-overlay.js reaches in via
  // rendererTranscriptToolCallUtils.setToolCallExpansion to transiently expand
  // classic .tool-call-block rows around a search jump; the facade must stay
  // on the module surface even though the chat event handler gets the
  // per-instance setter by injection.
  const moduleSurface = require('../renderer/chat/renderer-transcript-tool-calls');
  assert.equal(typeof moduleSurface.setToolCallExpansion, 'function');
  assert.equal(typeof moduleSurface.getToolCallExpansion, 'function');
  assert.equal(typeof moduleSurface.clearToolCallExpansionOverrides, 'function');

  const renderer = createRenderer();
  moduleSurface.setToolCallExpansion('row_facade_probe', true);
  assert.equal(renderer.getToolCallExpansion('row_facade_probe'), true);
  assert.equal(moduleSurface.getToolCallExpansion('row_facade_probe'), true);

  moduleSurface.clearToolCallExpansionOverrides();
  assert.equal(renderer.getToolCallExpansion('row_facade_probe'), undefined);
});
