'use strict';

// Fork x artifact-workspace integration: the B1 strip-and-mark contract and
// the B2 branch-clone carry path (scratch-dir copy, size cap, partial-failure
// fallback, orphan-prune protection).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const {
  ArtifactWorkspaceService,
  SESSION_ARTIFACT_ROOT,
} = require('../services/artifact-workspace-service');
const {
  forkSession,
  forkSessionWithArtifacts,
} = require('../services/backend/session-branching');

function createWorkspaceRoot() {
  return createTrackedTempDir('jenny-artifacts-branch-');
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('ArtifactWorkspaceService reports NOT_FOUND for artifacts left behind by a forked session', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
  });
  const created = await service.createArtifact('session-fork-source', {
    artifact_kind: 'document',
    title: 'Source Plan',
    content: '# Source plan',
    language: 'markdown',
  });

  const sourceSession = {
    id: 'session-fork-source',
    title: 'Source Chat',
    messages: [
      { id: 'msg_1', role: 'user', content: 'Write a plan' },
      {
        id: 'msg_2',
        role: 'assistant',
        kind: 'tool_result',
        content: '',
        tool_result: {
          call_id: 'call_1',
          tool_name: 'create_artifact',
          summary: 'Created Source Plan',
          generated_artifacts: [created.metadata],
        },
      },
      { id: 'msg_3', role: 'assistant', content: 'Done' },
    ],
    linked_session_ids: [],
    last_model_used: '',
    preferred_model: '',
    reasoning_effort: 'default',
    conversation_mode: 'chat',
    context_preferences: {},
  };
  const sessionStore = {
    _sessions: { 'session-fork-source': sourceSession },
    getSession(sessionId) {
      return sessionStore._sessions[sessionId] || null;
    },
    _read() {
      return { schema_version: 3, sessions: { ...sessionStore._sessions } };
    },
    _write(payload) {
      sessionStore._sessions = { ...(payload.sessions || {}) };
    },
    _toSummary(session) {
      return { id: session.id, title: session.title };
    },
  };
  const branch = forkSession(sessionStore, 'session-fork-source', 'msg_3');
  assert.ok(branch);

  const lookupService = new ArtifactWorkspaceService({
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    sessionMessageReader: async (sessionId) => (
      sessionStore.getSession(sessionId)?.messages || []
    ),
  });

  // The source session still resolves its own artifact.
  const sourceArtifact = await lookupService.resolveArtifact(
    'session-fork-source',
    created.metadata.artifact_id
  );
  assert.equal(sourceArtifact.status, 'available');

  // The branch dropped the reference at fork time, so the id simply is not in
  // its history: a bounded NOT_FOUND, never PATH_OUTSIDE_SCRATCH.
  await assert.rejects(
    () => lookupService.resolveArtifact(branch.id, created.metadata.artifact_id),
    (error) => {
      assert.equal(error.code, 'CMP-ARTIFACT-0010');
      return true;
    }
  );
});

function createConfigService(workspaceRoot) {
  return {
    getState() {
      return { toolsWorkspaceRoot: workspaceRoot };
    },
  };
}

function createForkFixture(createdMetadata) {
  const sourceSession = {
    id: 'session-clone-source',
    title: 'Source Chat',
    messages: [
      { id: 'msg_1', role: 'user', content: 'Write a plan' },
      {
        id: 'msg_2',
        role: 'assistant',
        kind: 'tool_result',
        content: '',
        tool_result: {
          call_id: 'call_1',
          tool_name: 'create_artifact',
          summary: 'Created Source Plan',
          generated_artifacts: [createdMetadata],
        },
      },
      { id: 'msg_3', role: 'assistant', content: 'Done' },
    ],
    linked_session_ids: [],
    last_model_used: '',
    preferred_model: '',
    reasoning_effort: 'default',
    conversation_mode: 'chat',
    context_preferences: {},
  };
  const sessionStore = {
    _sessions: { 'session-clone-source': sourceSession },
    getSession(sessionId) {
      return sessionStore._sessions[sessionId] || null;
    },
    _read() {
      return { schema_version: 3, sessions: { ...sessionStore._sessions } };
    },
    _write(payload) {
      sessionStore._sessions = { ...(payload.sessions || {}) };
    },
    _toSummary(session) {
      return { id: session.id, title: session.title };
    },
  };
  return { sessionStore };
}

test('ArtifactWorkspaceService clones a scratch dir for a branch and rewrites carried references end-to-end', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: createConfigService(workspaceRoot),
  });
  const created = await service.createArtifact('session-clone-source', {
    artifact_kind: 'document',
    title: 'Source Plan',
    content: '# Source plan',
    language: 'markdown',
  });
  const { sessionStore } = createForkFixture(created.metadata);

  const branch = await forkSessionWithArtifacts(
    sessionStore,
    'session-clone-source',
    'msg_3',
    { artifactService: service }
  );
  assert.ok(branch);

  const branchToolResult = sessionStore.getSession(branch.id).messages[1].tool_result;
  assert.equal(branchToolResult.generated_artifacts.length, 1);
  const carried = branchToolResult.generated_artifacts[0];
  // Ids and paths are rebased onto the branch session.
  assert.notEqual(carried.artifact_id, created.metadata.artifact_id);
  assert.equal(carried.artifact_id.startsWith(`artifact_file_${branch.id}_`), true);
  assert.equal(carried.display_path, `.jenny/artifacts/${branch.id}/${created.metadata.file_name}`);
  assert.equal(branchToolResult.metadata.artifacts_not_carried, undefined);
  // The copied file exists on disk in the branch scratch dir.
  const branchFile = path.join(workspaceRoot, SESSION_ARTIFACT_ROOT, branch.id, created.metadata.file_name);
  assert.equal(fs.existsSync(branchFile), true);
  assert.equal(fs.readFileSync(branchFile, 'utf8'), '# Source plan');

  const lookupService = new ArtifactWorkspaceService({
    configService: createConfigService(workspaceRoot),
    sessionMessageReader: async (sessionId) => (
      sessionStore.getSession(sessionId)?.messages || []
    ),
  });
  // Both sessions resolve their own copies independently.
  const branchArtifact = await lookupService.resolveArtifact(branch.id, carried.artifact_id);
  assert.equal(branchArtifact.status, 'available');
  const sourceArtifact = await lookupService.resolveArtifact(
    'session-clone-source',
    created.metadata.artifact_id
  );
  assert.equal(sourceArtifact.status, 'available');
  // The branch copy is a real copy: editing it must not touch the source file.
  await lookupService.saveArtifact(branch.id, carried.artifact_id, '# Branch edit');
  assert.equal(fs.readFileSync(branchFile, 'utf8'), '# Branch edit');
  assert.equal(
    fs.readFileSync(path.join(workspaceRoot, created.metadata.display_path), 'utf8'),
    '# Source plan'
  );
});

test('ArtifactWorkspaceService falls back to strip-and-mark when the branch copy exceeds the size cap', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: createConfigService(workspaceRoot),
  });
  const created = await service.createArtifact('session-clone-source', {
    artifact_kind: 'document',
    title: 'Source Plan',
    content: '# Source plan that is comfortably larger than the tiny test cap',
    language: 'markdown',
  });
  const { sessionStore } = createForkFixture(created.metadata);

  const cloneResult = await service.cloneSessionArtifactsForBranch(
    'session-clone-source',
    'session-clone-branch-direct',
    { maxTotalBytes: 4 }
  );
  assert.equal(cloneResult.cloned, false);
  assert.equal(cloneResult.reason, 'size_cap_exceeded');
  assert.ok(cloneResult.bytes > 4);
  // Nothing was materialized for the target session.
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, SESSION_ARTIFACT_ROOT, 'session-clone-branch-direct')),
    false
  );

  const branch = await forkSessionWithArtifacts(
    sessionStore,
    'session-clone-source',
    'msg_3',
    { artifactService: service, maxArtifactCopyBytes: 4 }
  );
  assert.ok(branch);
  const branchToolResult = sessionStore.getSession(branch.id).messages[1].tool_result;
  assert.deepEqual(branchToolResult.generated_artifacts, []);
  assert.equal(branchToolResult.metadata.artifacts_not_carried, true);
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, SESSION_ARTIFACT_ROOT, branch.id)),
    false
  );
});

test('ArtifactWorkspaceService removes the partial copy and reports copy_failed when the clone breaks midway', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const realFs = require('fs/promises');
  const service = new ArtifactWorkspaceService({
    configService: createConfigService(workspaceRoot),
    fsImpl: new Proxy(realFs, {
      get(target, prop) {
        if (prop === 'copyFile') {
          return async () => {
            throw new Error('injected copy failure');
          };
        }
        return target[prop];
      },
    }),
  });
  const seedService = new ArtifactWorkspaceService({
    configService: createConfigService(workspaceRoot),
  });
  await seedService.createArtifact('session-clone-source', {
    artifact_kind: 'document',
    title: 'Source Plan',
    content: '# Source plan',
    language: 'markdown',
  });

  const cloneResult = await service.cloneSessionArtifactsForBranch(
    'session-clone-source',
    'session-clone-branch-broken'
  );
  assert.equal(cloneResult.cloned, false);
  assert.equal(cloneResult.reason, 'copy_failed');
  // The partially created target dir is cleaned up.
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, SESSION_ARTIFACT_ROOT, 'session-clone-branch-broken')),
    false
  );
});

test('ArtifactWorkspaceService reports source_scratch_missing when the source session has no scratch dir', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: createConfigService(workspaceRoot),
  });

  const cloneResult = await service.cloneSessionArtifactsForBranch(
    'session-without-artifacts',
    'session-clone-branch'
  );
  assert.equal(cloneResult.cloned, false);
  assert.equal(cloneResult.reason, 'source_scratch_missing');
});

test('ArtifactWorkspaceService branch rewriter refuses entries outside the source scratch dir', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: createConfigService(workspaceRoot),
  });
  const created = await service.createArtifact('session-clone-source', {
    artifact_kind: 'document',
    title: 'Source Plan',
    content: '# Source plan',
    language: 'markdown',
  });

  const cloneResult = await service.cloneSessionArtifactsForBranch(
    'session-clone-source',
    'session-clone-branch'
  );
  assert.equal(cloneResult.cloned, true);
  assert.equal(cloneResult.files, 1);
  // A foreign session's display path must not be rebased onto the branch.
  assert.equal(
    cloneResult.rewriteEntry({
      ...created.metadata,
      display_path: '.jenny/artifacts/some-other-session/scratch-plan.md',
    }),
    null
  );
  // Malformed entries do not rewrite either.
  assert.equal(cloneResult.rewriteEntry({ artifact_id: 'only-an-id' }), null);
  // The happy mapping keeps every metadata field and rebases id/paths.
  const mapped = cloneResult.rewriteEntry(created.metadata);
  assert.ok(mapped);
  assert.equal(mapped.title, 'Source Plan');
  assert.equal(mapped.artifact_id.startsWith('artifact_file_session-clone-branch_'), true);
  assert.equal(mapped.display_path, `.jenny/artifacts/session-clone-branch/${created.metadata.file_name}`);
  // A redacted stored path stays redacted: only display_path is rebased and
  // resolveArtifact later rebuilds the concrete path from it.
  const redactedMapped = cloneResult.rewriteEntry({
    ...created.metadata,
    absolute_path: '[redacted:path]',
  });
  assert.ok(redactedMapped);
  assert.equal(redactedMapped.absolute_path, '[redacted:path]');
  assert.equal(
    redactedMapped.display_path,
    `.jenny/artifacts/session-clone-branch/${created.metadata.file_name}`
  );
});

test('ArtifactWorkspaceService branch clone refuses scratch dirs with too many entries', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: createConfigService(workspaceRoot),
  });
  await service.createArtifact('session-clone-source', {
    artifact_kind: 'document',
    title: 'Plan A',
    content: '# A',
    language: 'markdown',
  });
  await service.createArtifact('session-clone-source', {
    artifact_kind: 'document',
    title: 'Plan B',
    content: '# B',
    language: 'markdown',
  });

  const cloneResult = await service.cloneSessionArtifactsForBranch(
    'session-clone-source',
    'session-clone-branch-entries',
    { maxEntries: 1 }
  );
  assert.equal(cloneResult.cloned, false);
  assert.equal(cloneResult.reason, 'entry_cap_exceeded');
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, SESSION_ARTIFACT_ROOT, 'session-clone-branch-entries')),
    false
  );
});

test('ArtifactWorkspaceService prune re-resolves active sessions before each deletion', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: createConfigService(workspaceRoot),
  });
  await service.createArtifact('session-persisted-mid-prune', {
    artifact_kind: 'document',
    title: 'Branch Copy',
    content: '# Copy',
    language: 'markdown',
  });
  const scratchDir = path.join(workspaceRoot, SESSION_ARTIFACT_ROOT, 'session-persisted-mid-prune');

  // Simulates a fork persisting its branch session while a prune pass is
  // mid-flight: the initial snapshot does not know the session, but the
  // pre-deletion re-resolve does - the dir must survive.
  let resolveCalls = 0;
  const provider = () => {
    resolveCalls += 1;
    return resolveCalls === 1 ? [] : ['session-persisted-mid-prune'];
  };
  const pruneResult = await service.pruneOrphanedArtifacts(provider);
  assert.equal(pruneResult.removed, 0);
  assert.ok(resolveCalls >= 2);
  assert.equal(fs.existsSync(scratchDir), true);

  // A provider that consistently omits the session still prunes it.
  const secondResult = await service.pruneOrphanedArtifacts(() => []);
  assert.equal(secondResult.removed, 1);
  assert.equal(fs.existsSync(scratchDir), false);

  // A throwing provider fails closed: nothing is pruned.
  await service.createArtifact('session-fail-closed', {
    artifact_kind: 'document',
    title: 'Survivor',
    content: '# S',
    language: 'markdown',
  });
  const failClosedResult = await service.pruneOrphanedArtifacts(() => {
    throw new Error('store unavailable');
  });
  assert.equal(failClosedResult.removed, 0);
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, SESSION_ARTIFACT_ROOT, 'session-fail-closed')),
    true
  );
});

test('ArtifactWorkspaceService prune protection shields an in-flight branch copy until released', async () => {
  const workspaceRoot = createWorkspaceRoot();
  const service = new ArtifactWorkspaceService({
    configService: createConfigService(workspaceRoot),
  });
  await service.createArtifact('session-inflight-branch', {
    artifact_kind: 'document',
    title: 'Branch Copy',
    content: '# Copy',
    language: 'markdown',
  });
  const scratchDir = path.join(workspaceRoot, SESSION_ARTIFACT_ROOT, 'session-inflight-branch');
  assert.equal(fs.existsSync(scratchDir), true);

  const releaseFirst = service.markSessionPruneProtected('session-inflight-branch');
  const releaseSecond = service.markSessionPruneProtected('session-inflight-branch');
  // The branch session is not persisted yet, so it is absent from activeIds -
  // protection must keep the prune away from its scratch dir.
  let pruneResult = await service.pruneOrphanedArtifacts([]);
  assert.equal(pruneResult.removed, 0);
  assert.equal(fs.existsSync(scratchDir), true);

  // Release is idempotent per holder: double-releasing the first holder must
  // not underflow the second holder's protection.
  releaseFirst();
  releaseFirst();
  pruneResult = await service.pruneOrphanedArtifacts([]);
  assert.equal(pruneResult.removed, 0);
  assert.equal(fs.existsSync(scratchDir), true);

  releaseSecond();
  pruneResult = await service.pruneOrphanedArtifacts([]);
  assert.equal(pruneResult.removed, 1);
  assert.equal(fs.existsSync(scratchDir), false);
});
