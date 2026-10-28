'use strict';

// Shared setup for the chat-stream active-file context suites.

const assert = require('node:assert/strict');

const {
  assembleContextForChat: assembleContextForChatWithAuthority,
} = require('../../services/backend/chat-stream-context-assembly');
const {
  SessionExecutionAuthority,
} = require('../../services/backend/session-execution-authority');
const { normalizeContextPreferences } = require('../../services/backend/context-preferences');

function withProjectAuthority(service) {
  const rootPath = service.configService?.get?.('tools_workspace_root') || 'G:\\projects\\general';
  const authority = Object.freeze({
    project_id: 'project_general',
    root_path: rootPath,
    root_id: 'root-project-general',
    root_revision: 1,
    device_id: '7',
    inode: '11',
  });
  const projectAuthority = {
    captureSession(sessionId) {
      assert.equal(sessionId, 's1');
      return authority;
    },
    requireCurrent(candidate) {
      assert.deepEqual(candidate, authority);
      return candidate;
    },
  };
  const result = {
    ...service,
    projectAuthority,
  };
  result.sessionExecutionAuthority = new SessionExecutionAuthority({
    projectAuthority,
    permissionStore: { getSnapshot: () => ({ version: 3, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  return result;
}

function assembleContextForChat(service, options) {
  const executionAuthority = service.sessionExecutionAuthority.captureSession('s1', {
    requestId: options.streamId,
  });
  return assembleContextForChatWithAuthority(service, { ...options, executionAuthority });
}

// Minimal service: everything other than the active-file task is disabled via
// the context preferences below, so no personality/memory/git/codebase deps run.
function makeService(flagOn) {
  return withProjectAuthority({
    featureFlags: { workspace_active_file_context: flagOn === true },
    _memoryRecallCache: {},
    _emitServiceLog() {},
  });
}

function makeOptions(overrides = {}) {
  const prefs = normalizeContextPreferences({
    history_scope: 'fresh',
    include_personality: false,
    include_memory: false,
    include_git_context: false,
    include_codebase_context: false,
  });
  const options = {
    resolvedSessionId: 's1',
    streamId: 'stream1',
    contextPreferences: prefs,
    sessionSummary: {},
    sessionMessages: [],
    prompt: 'what does foo do?',
    recentUserTurns: [],
    preparedMessages: [{ role: 'user', content: 'what does foo do?' }],
    recallQuery: '',
    logTiming() {},
    activeFileContext: {
      path: 'renderer/foo.js',
      languageId: 'javascript',
      cursor: { lineNumber: 3 },
      startLine: 1,
      endLine: 6,
      totalLines: 6,
      slice: 'function foo() { return 1; }',
    },
    mentionContents: [],
    ...overrides,
  };
  if (options.activeFileContext && options.activeFileContext.workspace_id == null) {
    options.activeFileContext = {
      ...options.activeFileContext,
      workspace_id: 'root-project-general',
    };
  }
  options.mentionContents = options.mentionContents.map((entry) => (
    entry.workspace_id == null ? { ...entry, workspace_id: 'root-project-general' } : entry
  ));
  return options;
}

function blockOfKind(result, kind) {
  const blocks = result.contextBlocks || [];
  const matches = blocks.filter((block) => block.kind === kind);
  assert.ok(matches.length <= 1, `expected at most one ${kind} block, got ${matches.length}`);
  return matches.length === 1 ? matches[0].content : null;
}

function assertNoSystemRowsSpliced(preparedMessages) {
  const spliced = preparedMessages.filter((m) => m.role === 'system');
  assert.deepEqual(
    spliced,
    [],
    'context blocks must NOT ride params.messages — the sidecar drops system rows there'
  );
}

module.exports = {
  assembleContextForChat,
  assertNoSystemRowsSpliced,
  blockOfKind,
  makeOptions,
  makeService,
  normalizeContextPreferences,
  withProjectAuthority,
};
