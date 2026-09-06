// Fork-with-artifacts coverage for services/backend/session-branching.js:
// forkSessionWithArtifacts and the tool_result rewrite/strip helpers. The
// plain forkSession slice-and-link behavior stays in
// tests/session-branching.test.js (split to respect the test-file size gate).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  forkSessionWithArtifacts,
  dropInheritedArtifactReferences,
  rewriteInheritedArtifactReferences,
} = require('../services/backend/session-branching');

function createGeneratedArtifactEntry(sessionId, artifactId) {
  return {
    artifact_id: artifactId,
    artifact_kind: 'document',
    title: 'Scratch Plan',
    file_name: 'scratch-plan.md',
    display_path: `.jenny/artifacts/${sessionId}/scratch-plan.md`,
    absolute_path: `/ws/.jenny/artifacts/${sessionId}/scratch-plan.md`,
    language: 'markdown',
    status: 'available',
  };
}

function createArtifactBearingToolResultMessage(sessionId) {
  return {
    id: 'msg_2',
    role: 'assistant',
    kind: 'tool_result',
    content: '',
    tool_result: {
      call_id: 'call_1',
      tool_name: 'write_file',
      output_text: 'wrote 6 bytes',
      summary: 'Wrote scratch-plan.md',
      is_error: false,
      generated_artifacts: [createGeneratedArtifactEntry(sessionId, 'artifact_plan_1')],
      metadata: { path: 'scratch-plan.md' },
    },
  };
}

function createMockSessionStore(sessions = {}) {
  const store = {
    _sessions: { ...sessions },
    getSession(sessionId) {
      return store._sessions[sessionId] || null;
    },
    _read() {
      return { schema_version: 3, sessions: { ...store._sessions } };
    },
    _write(payload) {
      store._sessions = { ...(payload.sessions || {}) };
    },
    _toSummary(session) {
      return {
        id: session.id,
        title: session.title,
        message_count: (session.messages || []).length,
        linked_session_ids: session.linked_session_ids || [],
        branch_origin: session.branch_origin || null,
      };
    },
  };
  return store;
}
function createBranchRewriter(sourceSessionId, targetSessionId) {
  const sourcePrefix = `.jenny/artifacts/${sourceSessionId}/`;
  return (entry) => {
    const displayPath = String(entry?.display_path || '');
    if (!displayPath.startsWith(sourcePrefix)) {
      return null;
    }
    const rest = displayPath.slice(sourcePrefix.length);
    return {
      ...entry,
      artifact_id: `${String(entry.artifact_id)}_${targetSessionId}`,
      display_path: `.jenny/artifacts/${targetSessionId}/${rest}`,
      absolute_path: `/ws/.jenny/artifacts/${targetSessionId}/${rest}`,
    };
  };
}

function createFakeArtifactService({ cloneImpl } = {}) {
  const service = {
    calls: {
      clone: [],
      protect: [],
      release: [],
      deleted: [],
    },
    markSessionPruneProtected(sessionId) {
      service.calls.protect.push(sessionId);
      return () => {
        service.calls.release.push(sessionId);
      };
    },
    async cloneSessionArtifactsForBranch(sourceSessionId, targetSessionId, options) {
      service.calls.clone.push({ sourceSessionId, targetSessionId, options });
      if (typeof cloneImpl === 'function') {
        return cloneImpl(sourceSessionId, targetSessionId, options);
      }
      return {
        cloned: true,
        files: 1,
        bytes: 6,
        rewriteEntry: createBranchRewriter(sourceSessionId, targetSessionId),
      };
    },
    async deleteSessionArtifacts(sessionId) {
      service.calls.deleted.push(sessionId);
      return { deleted: true };
    },
  };
  return service;
}

function createArtifactSourceSessions() {
  return {
    sess_1: {
      id: 'sess_1',
      title: 'Original Chat',
      messages: [
        { id: 'msg_1', role: 'user', content: 'Write a plan' },
        createArtifactBearingToolResultMessage('sess_1'),
        { id: 'msg_3', role: 'assistant', content: 'Done' },
      ],
      linked_session_ids: [],
      last_model_used: '',
      preferred_model: '',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      context_preferences: {},
    },
  };
}

describe('forkSessionWithArtifacts', () => {
  it('copies artifacts and rewrites carried references onto the branch', async () => {
    const store = createMockSessionStore(createArtifactSourceSessions());
    const artifactService = createFakeArtifactService();

    const branch = await forkSessionWithArtifacts(store, 'sess_1', 'msg_3', { artifactService });

    assert.ok(branch);
    assert.equal(artifactService.calls.clone.length, 1);
    assert.equal(artifactService.calls.clone[0].sourceSessionId, 'sess_1');
    // The clone target and the persisted branch session must agree on the id.
    assert.equal(artifactService.calls.clone[0].targetSessionId, branch.id);
    assert.deepEqual(artifactService.calls.deleted, []);

    const branchedToolResult = store.getSession(branch.id).messages[1].tool_result;
    assert.equal(branchedToolResult.generated_artifacts.length, 1);
    const carried = branchedToolResult.generated_artifacts[0];
    assert.equal(carried.artifact_id, `artifact_plan_1_${branch.id}`);
    assert.equal(carried.display_path, `.jenny/artifacts/${branch.id}/scratch-plan.md`);
    assert.equal(carried.absolute_path, `/ws/.jenny/artifacts/${branch.id}/scratch-plan.md`);
    // Carried artifacts are not "not carried": no marker on either copy.
    assert.equal(branchedToolResult.artifacts_not_carried, undefined);
    assert.equal(branchedToolResult.metadata.artifacts_not_carried, undefined);
    // The source session's references are untouched.
    const sourceToolResult = store.getSession('sess_1').messages[1].tool_result;
    assert.equal(sourceToolResult.generated_artifacts[0].artifact_id, 'artifact_plan_1');
  });

  it('protects the branch id before copying and releases only after the branch persists', async () => {
    const store = createMockSessionStore(createArtifactSourceSessions());
    const events = [];
    const artifactService = createFakeArtifactService();
    const baseProtect = artifactService.markSessionPruneProtected;
    artifactService.markSessionPruneProtected = (sessionId) => {
      events.push({ type: 'protect', sessionId });
      const release = baseProtect.call(artifactService, sessionId);
      return () => {
        // The prune race-closure contract: release must strictly follow the
        // branch session becoming visible to listSessions/getSession.
        events.push({
          type: 'release',
          sessionId,
          branchPersisted: Boolean(store.getSession(sessionId)),
        });
        release();
      };
    };
    const baseClone = artifactService.cloneSessionArtifactsForBranch;
    artifactService.cloneSessionArtifactsForBranch = (...args) => {
      events.push({ type: 'clone', sessionId: args[1] });
      return baseClone.apply(artifactService, args);
    };

    const branch = await forkSessionWithArtifacts(store, 'sess_1', 'msg_3', { artifactService });

    assert.ok(branch);
    assert.deepEqual(events.map((event) => event.type), ['protect', 'clone', 'release']);
    assert.equal(events[0].sessionId, branch.id);
    assert.equal(events[2].branchPersisted, true, 'release must follow branch persistence');
  });

  it('falls back to strip-and-mark when the copy exceeds the size cap', async () => {
    const store = createMockSessionStore(createArtifactSourceSessions());
    const artifactService = createFakeArtifactService({
      cloneImpl: () => ({ cloned: false, reason: 'size_cap_exceeded', bytes: 999 }),
    });

    const branch = await forkSessionWithArtifacts(store, 'sess_1', 'msg_3', {
      artifactService,
      maxArtifactCopyBytes: 10,
    });

    assert.ok(branch);
    assert.equal(artifactService.calls.clone[0].options.maxTotalBytes, 10);
    // Nothing was copied, so nothing needs deleting.
    assert.deepEqual(artifactService.calls.deleted, []);
    assert.equal(artifactService.calls.release.length, 1);
    const branchedToolResult = store.getSession(branch.id).messages[1].tool_result;
    assert.deepEqual(branchedToolResult.generated_artifacts, []);
    assert.equal(branchedToolResult.metadata.artifacts_not_carried, true);
  });

  it('falls back to strip-and-mark and removes the copy when a reference cannot be rewritten', async () => {
    const store = createMockSessionStore(createArtifactSourceSessions());
    let cloneTargetId = '';
    const artifactService = createFakeArtifactService({
      cloneImpl: (sourceSessionId, targetSessionId) => {
        cloneTargetId = targetSessionId;
        return {
          cloned: true,
          files: 1,
          bytes: 6,
          rewriteEntry: () => null,
        };
      },
    });

    const branch = await forkSessionWithArtifacts(store, 'sess_1', 'msg_3', { artifactService });

    assert.ok(branch);
    // The half-usable copy is reclaimed instead of persisting a broken carry.
    assert.deepEqual(artifactService.calls.deleted, [cloneTargetId]);
    assert.equal(artifactService.calls.release.length, 1);
    const branchedToolResult = store.getSession(branch.id).messages[1].tool_result;
    assert.deepEqual(branchedToolResult.generated_artifacts, []);
    assert.equal(branchedToolResult.metadata.artifacts_not_carried, true);
  });

  it('falls back to strip-and-mark when the clone itself throws', async () => {
    const store = createMockSessionStore(createArtifactSourceSessions());
    const artifactService = createFakeArtifactService({
      cloneImpl: () => {
        throw new Error('disk on fire');
      },
    });

    const branch = await forkSessionWithArtifacts(store, 'sess_1', 'msg_3', { artifactService });

    assert.ok(branch);
    assert.deepEqual(artifactService.calls.deleted, []);
    assert.equal(artifactService.calls.release.length, 1);
    const branchedToolResult = store.getSession(branch.id).messages[1].tool_result;
    assert.deepEqual(branchedToolResult.generated_artifacts, []);
    assert.equal(branchedToolResult.metadata.artifacts_not_carried, true);
  });

  it('removes the copied dir and releases protection when the branch never persists', async () => {
    const sessions = createArtifactSourceSessions();
    const store = {
      getSession(sessionId) {
        return sessions[sessionId] || null;
      },
      _read() {
        return { schema_version: 11, sessions: { ...sessions } };
      },
      _write() {
        // Simulates the write-blocked path: no branch persists.
      },
      _toSummary(session) {
        return { id: session.id, title: session.title };
      },
    };
    const artifactService = createFakeArtifactService();

    const branch = await forkSessionWithArtifacts(store, 'sess_1', 'msg_3', { artifactService });

    assert.equal(branch, null);
    assert.equal(artifactService.calls.clone.length, 1);
    assert.deepEqual(artifactService.calls.deleted, [artifactService.calls.clone[0].targetSessionId]);
    assert.equal(artifactService.calls.release.length, 1);
  });

  it('skips the artifact copy entirely when the fork slice has no artifacts', async () => {
    const store = createMockSessionStore(createArtifactSourceSessions());
    const artifactService = createFakeArtifactService();

    // msg_1 sits before the artifact-bearing tool result.
    const branch = await forkSessionWithArtifacts(store, 'sess_1', 'msg_1', { artifactService });

    assert.ok(branch);
    assert.deepEqual(artifactService.calls.clone, []);
    assert.deepEqual(artifactService.calls.protect, []);
    assert.equal(store.getSession(branch.id).messages.length, 1);
  });

  it('behaves like plain forkSession when no artifact service is wired', async () => {
    const store = createMockSessionStore(createArtifactSourceSessions());

    const branch = await forkSessionWithArtifacts(store, 'sess_1', 'msg_3', {});

    assert.ok(branch);
    const branchedToolResult = store.getSession(branch.id).messages[1].tool_result;
    assert.deepEqual(branchedToolResult.generated_artifacts, []);
    assert.equal(branchedToolResult.metadata.artifacts_not_carried, true);
  });
});

describe('rewriteInheritedArtifactReferences', () => {
  it('rewrites every entry through the provided mapper', () => {
    const toolResult = {
      call_id: 'call_1',
      tool_name: 'write_file',
      generated_artifacts: [createGeneratedArtifactEntry('sess_1', 'artifact_plan_1')],
      metadata: { path: 'scratch-plan.md' },
    };
    const rewriter = createBranchRewriter('sess_1', 'sess_branch');

    const rewritten = rewriteInheritedArtifactReferences(toolResult, rewriter);

    assert.ok(rewritten);
    assert.notEqual(rewritten, toolResult);
    assert.equal(rewritten.generated_artifacts.length, 1);
    assert.equal(
      rewritten.generated_artifacts[0].display_path,
      '.jenny/artifacts/sess_branch/scratch-plan.md'
    );
    assert.equal(rewritten.artifacts_not_carried, undefined);
    // The source entry is untouched.
    assert.equal(
      toolResult.generated_artifacts[0].display_path,
      '.jenny/artifacts/sess_1/scratch-plan.md'
    );
  });

  it('degrades to strip-and-mark when a valid entry cannot be mapped', () => {
    const toolResult = {
      call_id: 'call_1',
      tool_name: 'write_file',
      generated_artifacts: [createGeneratedArtifactEntry('sess_1', 'artifact_plan_1')],
      metadata: {},
    };

    const rewritten = rewriteInheritedArtifactReferences(toolResult, () => null);

    assert.ok(rewritten);
    assert.equal(Object.prototype.hasOwnProperty.call(rewritten, 'generated_artifacts'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(rewritten, 'artifacts_not_carried'), false);
    assert.equal(rewritten.metadata.artifacts_not_carried, true);
  });

  it('silently drops entries that would not survive persistence anyway', () => {
    const toolResult = {
      call_id: 'call_1',
      tool_name: 'write_file',
      generated_artifacts: [
        createGeneratedArtifactEntry('sess_1', 'artifact_plan_1'),
        { artifact_id: 'malformed-only-id' },
      ],
      metadata: {},
    };
    const rewriter = createBranchRewriter('sess_1', 'sess_branch');

    const rewritten = rewriteInheritedArtifactReferences(toolResult, rewriter);

    assert.ok(rewritten);
    assert.equal(rewritten.generated_artifacts.length, 1);
    assert.equal(rewritten.artifacts_not_carried, undefined);
  });

  it('returns null when there is nothing to rewrite', () => {
    const rewriter = createBranchRewriter('sess_1', 'sess_branch');
    assert.equal(rewriteInheritedArtifactReferences(null, rewriter), null);
    assert.equal(
      rewriteInheritedArtifactReferences({ call_id: 'call_1', tool_name: 'list_dir' }, rewriter),
      null
    );
  });
});

describe('dropInheritedArtifactReferences', () => {
  it('omits generated_artifacts and marks the fresh tool_result', () => {
    const toolResult = {
      call_id: 'call_1',
      tool_name: 'write_file',
      generated_artifacts: [createGeneratedArtifactEntry('sess_1', 'artifact_plan_1')],
      metadata: { path: 'scratch-plan.md' },
    };

    const stripped = dropInheritedArtifactReferences(toolResult);

    assert.ok(stripped);
    assert.notEqual(stripped, toolResult);
    assert.equal(Object.prototype.hasOwnProperty.call(stripped, 'generated_artifacts'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(stripped, 'artifacts_not_carried'), false);
    assert.equal(stripped.metadata.artifacts_not_carried, true);
    assert.equal(stripped.metadata.path, 'scratch-plan.md');
    assert.notEqual(stripped.metadata, toolResult.metadata);
  });

  it('returns null when there is nothing to strip', () => {
    assert.equal(dropInheritedArtifactReferences(null), null);
    assert.equal(dropInheritedArtifactReferences(undefined), null);
    assert.equal(dropInheritedArtifactReferences([]), null);
    assert.equal(
      dropInheritedArtifactReferences({ call_id: 'call_1', tool_name: 'list_dir' }),
      null
    );
    assert.equal(
      dropInheritedArtifactReferences({
        call_id: 'call_1',
        tool_name: 'list_dir',
        generated_artifacts: [],
      }),
      null
    );
  });
});
