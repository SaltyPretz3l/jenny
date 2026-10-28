'use strict';

// Coverage for the context-assembly tasks in
// services/backend/chat-stream-context-assembly.js.
//
// These blocks used to be SPLICED INTO preparedMessages as {role:'system'} rows.
// That made them inert: preparedMessages is sent verbatim as chat.send
// params.messages, which the sidecar treats as untrusted request history and
// filters every system row out of (sidecar/ai/context/messages.py). They are now
// returned as TYPED context blocks and travel on params.context_blocks, where
// the sidecar folds them into the trusted system tier.
//
// So the load-bearing assertions here are twofold: the right blocks are built
// and trimmed, AND they never land back in preparedMessages.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assembleContextForChat, assertNoSystemRowsSpliced, blockOfKind, makeOptions, makeService,
  normalizeContextPreferences, withProjectAuthority,
} = require('./helpers/chat-stream-active-file-harness');
const { buildLeanContextPreferences } = require('../services/backend/managed-sidecar-chat-helpers');

test('emits the active-file block on the typed channel when the flag is on', async () => {
  const service = makeService(true);
  const options = makeOptions();
  const result = await assembleContextForChat(service, options);
  assert.equal(result.memoryPolicy.project_id, 'project_general');
  assert.deepEqual(Object.keys(result.memoryPolicy).sort(), ['capture', 'enabled', 'policy_epoch', 'project_id', 'recall']);

  const activeFile = blockOfKind(result, 'active_file');
  assert.ok(activeFile, 'active-file block emitted');
  assert.match(activeFile, /renderer\/foo\.js/);
  assert.match(activeFile, /function foo/);
  // The untrusted history is untouched.
  assert.equal(options.preparedMessages.length, 1);
  assertNoSystemRowsSpliced(options.preparedMessages);
  assert.ok(result.promptContributions.active_file_block);
  assert.equal(result.contextAssemblyBreakdown.includedActiveFileContext, true);
});

test('emits NO block when the workspace_active_file_context flag is off', async () => {
  const service = makeService(false);
  const options = makeOptions();
  const result = await assembleContextForChat(service, options);

  assert.deepEqual(result.contextBlocks, []);
  assert.equal(options.preparedMessages.length, 1);
  assert.equal(result.promptContributions.active_file_block, undefined);
  assert.equal(result.contextAssemblyBreakdown.includedActiveFileContext, false);
});

test('emits NO block when include_active_file_context preference is false', async () => {
  const service = makeService(true);
  const prefs = normalizeContextPreferences({
    history_scope: 'fresh',
    include_personality: false,
    include_memory: false,
    include_git_context: false,
    include_codebase_context: false,
    include_active_file_context: false,
  });
  const options = makeOptions({ contextPreferences: prefs });
  const result = await assembleContextForChat(service, options);
  assert.deepEqual(result.contextBlocks, []);
  assert.equal(options.preparedMessages.length, 1);
});

test('builds the block from @-mentions alone when there is no active slice', async () => {
  const service = makeService(true);
  const options = makeOptions({
    activeFileContext: null,
    mentionContents: [{ path: 'src/util.js', content: 'export const ok = true;' }],
  });
  const result = await assembleContextForChat(service, options);
  const activeFile = blockOfKind(result, 'active_file');
  assert.ok(activeFile);
  assert.match(activeFile, /src\/util\.js/);
  assert.match(activeFile, /export const ok/);
  assert.equal(options.preparedMessages.length, 1);
});

test('emits NO block when there is neither a slice nor any mentions', async () => {
  const service = makeService(true);
  const options = makeOptions({ activeFileContext: null, mentionContents: [] });
  const result = await assembleContextForChat(service, options);
  assert.deepEqual(result.contextBlocks, []);
  assert.equal(options.preparedMessages.length, 1);
});


test('lean context preferences suppress the active-file block', async () => {
  const lean = buildLeanContextPreferences();
  assert.equal(lean.include_active_file_context, false);

  const service = makeService(true);
  const options = makeOptions({ contextPreferences: lean });
  const result = await assembleContextForChat(service, options);
  assert.deepEqual(result.contextBlocks, []);
  assert.equal(options.preparedMessages.length, 1);
});

// ── Context-budget trim (Deliverable 1) ──
// On a small effective context window, oversized stacked blocks must be
// priority-trimmed to fit so the turn never overflows on message 1. The
// highest-priority block (active-file) is shrunk/kept; lower-priority blocks
// (personality here) are dropped. The trim is deterministic and model-free.

const {
  estimateMessagesTokens,
  computeEffectiveContextBudget,
} = require('../services/backend/context-budget-trimmer');

// The blocks now travel beside preparedMessages rather than inside them, so the
// budget assertion has to measure the full model-facing set: history + blocks.
function estimateAssembledTokens(preparedMessages, contextBlocks) {
  return estimateMessagesTokens([
    ...preparedMessages,
    ...(contextBlocks || []).map((block) => ({ role: 'system', content: block.content })),
  ]);
}

test('trims oversized stacked blocks to fit a small effective budget (no overflow)', async () => {
  const hugePersonality = '## IDENTITY\n' + 'persona line\n'.repeat(4000); // ~13K tokens
  const service = withProjectAuthority({
    featureFlags: { workspace_active_file_context: true },
    _memoryRecallCache: {},
    _emitServiceLog() {},
    // 4K window => effective budget 2976 tokens (the window less the larger
    // generation reservation, as the sidecar); after history + the system
    // reserve only ~1.5K is left for the stacked blocks.
    currentStatus: { effective_context_length: 4000 },
    personalityWorkspace: {
      getCompiledContext: async () => hugePersonality,
    },
  });
  const prefs = normalizeContextPreferences({
    history_scope: 'fresh',
    include_personality: true,
    include_memory: false,
    include_git_context: false,
    include_codebase_context: false,
  });
  const options = makeOptions({
    contextPreferences: prefs,
    activeFileContext: {
      path: 'renderer/foo.js',
      languageId: 'javascript',
      cursor: { lineNumber: 50 },
      startLine: 1,
      endLine: 200,
      totalLines: 200,
      slice: 'function foo() {\n' + '  doThing();\n'.repeat(1500) + '}', // huge slice
    },
  });

  const result = await assembleContextForChat(service, options);

  // Active-file (highest priority) is preserved; oversized personality is dropped.
  assert.ok(result.promptContributions.active_file_block, 'active-file block kept');
  assert.equal(result.promptContributions.personality_block, undefined, 'personality dropped');
  assert.equal(blockOfKind(result, 'personality'), null);

  // The assembled context fits within the effective budget — no "Conversation
  // too long" would be tripped on turn 1.
  const effective = computeEffectiveContextBudget(4000);
  assert.equal(effective, 2976);
  const totalTokens = estimateAssembledTokens(options.preparedMessages, result.contextBlocks);
  assert.ok(totalTokens <= effective, `assembled ${totalTokens} tokens <= ${effective}`);

  // The active-file block itself was shrunk (it alone exceeded the budget).
  const activeFile = blockOfKind(result, 'active_file');
  assert.ok(activeFile, 'an active-file block survived');
  assert.match(activeFile, /renderer\/foo\.js/);
});

test('large local context budget preserves personality in a representative long session', async () => {
  const personality = '## IDENTITY\n' + 'persona line\n'.repeat(4000);
  const service = withProjectAuthority({
    featureFlags: {},
    _memoryRecallCache: {},
    _emitServiceLog() {},
    currentStatus: { effective_context_length: 272000 },
    personalityWorkspace: {
      getCompiledContext: async () => personality,
    },
  });
  const prefs = normalizeContextPreferences({
    history_scope: 'full',
    include_personality: true,
    include_memory: false,
    include_git_context: false,
    include_codebase_context: false,
    include_active_file_context: false,
  });
  const options = makeOptions({
    engineType: 'openai-compatible',
    contextPreferences: prefs,
    activeFileContext: null,
    preparedMessages: [{ role: 'user', content: 'history '.repeat(50000) }],
  });

  const result = await assembleContextForChat(service, options);

  assert.ok(result.promptContributions.personality_block, 'personality survives native window');
  assert.equal(blockOfKind(result, 'personality'), personality.trim());
  assertNoSystemRowsSpliced(options.preparedMessages);
});

test('ChatGPT subscription skips personality compilation but keeps non-personality context', async () => {
  let personalityCompileCalls = 0;
  const service = withProjectAuthority({
    featureFlags: { workspace_active_file_context: true },
    _memoryRecallCache: {},
    _emitServiceLog() {},
    personalityWorkspace: {
      getCompiledContext: async () => {
        personalityCompileCalls += 1;
        return '## IDENTITY\nCompanion personality';
      },
    },
  });
  const prefs = normalizeContextPreferences({
    history_scope: 'fresh',
    include_personality: true,
    include_memory: false,
    include_git_context: false,
    include_codebase_context: false,
    include_active_file_context: true,
  });
  const options = makeOptions({
    engineType: 'chatgpt',
    contextPreferences: prefs,
  });

  const result = await assembleContextForChat(service, options);

  assert.equal(personalityCompileCalls, 0);
  assert.equal(blockOfKind(result, 'personality'), null);
  assert.equal(result.promptContributions.personality_block, undefined);
  assert.equal(result.contextAssemblyBreakdown.includedPersonality, false);
  assert.ok(blockOfKind(result, 'active_file'), 'non-personality context remains available');
});

test('leaves blocks untouched when the effective window is unknown (inert)', async () => {
  // No currentStatus => budget null => trim is inert and behaviour is unchanged.
  const service = makeService(true);
  const options = makeOptions();
  const result = await assembleContextForChat(service, options);
  assert.equal(result.contextBlocks.length, 1);
  assert.ok(result.promptContributions.active_file_block);
});

// ── Cross-source dedupe: active-file vs codebase (H1) ──
// With BOTH context flags on, the open file must appear only once — in the
// active-file block (its cursor slice) — and never be re-grounded by the
// codebase keyword search. A non-active sibling that matches still appears.

const os = require('os');
const fs = require('fs');
const path = require('path');

function makeCodebaseTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ctx-dedupe-'));
  fs.mkdirSync(path.join(dir, 'renderer'), { recursive: true });
  // The active file (foo.js) AND a sibling (bar.js) both match the query, so the
  // only thing keeping foo.js out of the codebase block is the exclude.
  fs.writeFileSync(path.join(dir, 'renderer', 'foo.js'), 'const widget = 1; // widget for foo\n');
  fs.writeFileSync(path.join(dir, 'renderer', 'bar.js'), 'const widget = 2; // widget for bar\n');
  return dir;
}

function makeCodebaseService(dir, { activeFileFlag = true } = {}) {
  return withProjectAuthority({
    featureFlags: {
      workspace_active_file_context: activeFileFlag,
      workspace_codebase_context: true,
    },
    _memoryRecallCache: {},
    _emitServiceLog() {},
    // tools_workspace_root drives the codebase search root.
    configService: { get: (key) => (key === 'tools_workspace_root' ? dir : '') },
  });
}

function makeDedupeOptions(dir) {
  const prefs = normalizeContextPreferences({
    history_scope: 'fresh',
    include_personality: false,
    include_memory: false,
    include_git_context: false,
    include_codebase_context: true,
    include_active_file_context: true,
  });
  return makeOptions({
    contextPreferences: prefs,
    prompt: 'where is widget defined',
    activeFileContext: {
      path: 'renderer/foo.js',
      languageId: 'javascript',
      cursor: { lineNumber: 1 },
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      slice: 'const widget = 1;',
    },
  });
}

test('codebase block excludes the active file (the open file is not grounded twice)', async () => {
  const dir = makeCodebaseTempDir();
  try {
    const service = makeCodebaseService(dir);
    const options = makeDedupeOptions(dir);
    const result = await assembleContextForChat(service, options);

    const activeBlock = blockOfKind(result, 'active_file');
    const codebaseBlock = blockOfKind(result, 'codebase');

    assert.ok(activeBlock, 'active-file block emitted');
    assert.match(activeBlock, /renderer\/foo\.js/);
    assert.ok(codebaseBlock, 'codebase grounding block emitted (sibling matched)');
    assert.match(codebaseBlock, /renderer\/bar\.js/, 'sibling still cited');
    assert.ok(
      !codebaseBlock.includes('renderer/foo.js'),
      `active file was re-grounded by the codebase search:\n${codebaseBlock}`
    );
    assert.equal(result.contextAssemblyBreakdown.includedActiveFileContext, true);
    assert.equal(result.contextAssemblyBreakdown.includedCodebaseContext, true);
    assert.ok(result.promptContributions.active_file_block);
    assert.ok(result.promptContributions.codebase_block);
    assertNoSystemRowsSpliced(options.preparedMessages);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does NOT exclude the active file from codebase when active-file context is off', async () => {
  const dir = makeCodebaseTempDir();
  try {
    // Active-file flag off => no active-file block, so there is no double-send to
    // dedupe and the open file is allowed to appear in the codebase grounding.
    const service = makeCodebaseService(dir, { activeFileFlag: false });
    const options = makeDedupeOptions(dir);
    const result = await assembleContextForChat(service, options);

    const codebaseBlock = blockOfKind(result, 'codebase');
    assert.ok(codebaseBlock, 'codebase block present');
    assert.ok(
      codebaseBlock.includes('renderer/foo.js'),
      `foo.js should ground normally when active-file context is off:\n${codebaseBlock}`
    );
    assert.equal(result.contextAssemblyBreakdown.includedActiveFileContext, false);
    assert.equal(blockOfKind(result, 'active_file'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Memory v2 (row 58 W1 S4): the per-request policy combines the chat's
// include_memory / memory_opt_out with the three global memory settings.
test('memory_policy follows the settings and per-chat matrix', async () => {
  const cases = [
    ['default', {}, {}, { enabled: true, recall: true, capture: 'auto' }],
    ['useInChats off', { useInChats: false }, {}, { enabled: false, recall: false, capture: 'auto' }],
    ['include_memory off', {}, { include_memory: false }, { enabled: false, recall: false, capture: 'auto' }],
    ['pauseSaving', { pauseSaving: true, askBeforeSaving: true }, {}, { enabled: true, recall: true, capture: 'off' }],
    ['memory_opt_out', { askBeforeSaving: true }, { memory_opt_out: true }, { enabled: true, recall: true, capture: 'off' }],
    ['askBeforeSaving', { askBeforeSaving: true }, {}, { enabled: true, recall: true, capture: 'ask' }],
  ];
  for (const [label, memorySettings, prefPatch, expected] of cases) {
    const service = withProjectAuthority({
      featureFlags: {},
      configService: { getState: () => ({ memory: memorySettings }) },
      memoryPolicyEpoch: () => 7,
      _emitServiceLog() {},
    });
    const options = makeOptions({
      activeFileContext: null,
      contextPreferences: normalizeContextPreferences({
        history_scope: 'fresh',
        include_personality: false,
        include_git_context: false,
        include_codebase_context: false,
        ...prefPatch,
      }),
    });
    const result = await assembleContextForChat(service, options);
    assert.deepEqual(result.memoryPolicy, { ...expected, project_id: 'project_general', policy_epoch: 7 }, label);
  }
});

test('memory_policy defaults when the service has no config or epoch counter', async () => {
  const result = await assembleContextForChat(makeService(false), makeOptions({ activeFileContext: null }));
  assert.deepEqual(result.memoryPolicy, {
    enabled: false, project_id: 'project_general', capture: 'auto', recall: false, policy_epoch: 0,
  });
});


test('memory policy selects bounded eligible same-project summaries only', async () => {
  const service = makeService(false);
  service.featureFlags.session_offline_lockdown = true;
  service.featureFlags.memory_v2_enabled = true;
  const summary = (id, extra = {}) => ({ id, project_id: 'project_general', message_count: 2, title: id, ...extra });
  const good = [summary('active', { active_turn: {} }), summary('long', { title: 'x'.repeat(201) }),
    summary('untitled', { title: null, project_id: null }), ...Array.from({ length: 6 }, (_, i) => summary('good' + i))];
  service.sessionStore = { listSessions: () => [summary('s1'), summary('empty', { message_count: 0 }),
    summary('other', { project_id: 'project_other' }), summary('optout', { context_preferences: { memory_opt_out: true } }),
    summary('locked', { lockdown: true }), summary('diagnostic', { diagnostic_mode: true }), summary('', {}), ...good],
  getSession() { assert.fail('candidate selection must not load messages'); } };
  const options = makeOptions();
  options.contextPreferences = { ...options.contextPreferences, include_memory: true, history_scope: 'full' };
  const result = await assembleContextForChat(service, options);
  assert.deepEqual(result.memoryPolicy.recent_chats, good.slice(0, 6).map(s => ({ session_id: s.id, title: typeof s.title === 'string' ? s.title.slice(0, 200) : '' })));
  const { buildMemoryPolicy } = require('../services/backend/backend-memory');
  assert.equal(Object.hasOwn(buildMemoryPolicy(service, { includeMemory: true, projectId: 'project_general' }), 'recent_chats'), false);
  service.featureFlags.memory_v2_enabled = false;
  const killed = await assembleContextForChat(service, options);
  assert.equal(Object.hasOwn(killed.memoryPolicy, 'recent_chats'), false, 'the memory_v2 kill switch drops recap candidates');
  Object.assign(service.featureFlags, { memory_v2_enabled: true, session_offline_lockdown: false });
  const flagOff = await assembleContextForChat(service, options);
  assert.ok(!flagOff.memoryPolicy.recent_chats.some(c => c.session_id === 'locked'), 'a stored lockdown hides the chat with the flag off');
});

test('memory candidates are omitted with fresh history, recall off or no candidates', async () => {
  for (const [include_memory, history_scope, useInChats, summaries] of [
    [true, 'fresh', true, [{ id: 'old', message_count: 1 }]],
    [false, 'full', true, [{ id: 'old', message_count: 1 }]],
    [true, 'full', false, [{ id: 'old', message_count: 1 }]], [true, 'full', true, []],
  ]) {
    const service = makeService(false);
    service.configService = { getState: () => ({ memory: { useInChats } }) };
    service.sessionStore = { listSessions: () => summaries };
    const options = makeOptions();
    options.contextPreferences = { ...options.contextPreferences, include_memory, history_scope };
    const result = await assembleContextForChat(service, options);
    assert.equal(Object.hasOwn(result.memoryPolicy, 'recent_chats'), false);
  }
});
