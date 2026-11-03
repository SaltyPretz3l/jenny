'use strict';

// propose_session fork_of_session_id (row 94 P2, owner pick F1): primary only, checked where project_id
// is, never with project_id, only for a chat the primary's session directory shows, never the primary
// itself, only with a message to fork from, and off with the primary_chat_placement flag. Refusal
// sentences never echo the id.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const S = require('../services/backend/chat-proposal-session-records');
const proposeSessionTool = require('../services/tools/builtin/propose-session-tool');
const toolManifest = require('../services/tools/tool-manifest.json');

const FORK = 'sess_1730000000000_abcdef012345';
const OFFER = { schema_version: 1, initiation: 'offer', title: 'Try another approach' };

function makeHarness({
  primary = true, sessions = null, inScope = (id) => id !== 'sess_hidden', flags = {},
} = {}) {
  const authorityRecord = Object.freeze({
    project_id: 'project_1', root_path: os.tmpdir(), root_id: 'root_1', root_revision: 1, device_id: 'dev_1', inode: 'ino_1',
  });
  const callerSummary = { id: 'sess_1', session_role: primary ? 'primary' : null, run_mode: 'ask' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: {
      _sessionStore: { getSessionSummary: () => callerSummary },
      captureSession: () => authorityRecord,
      requireCurrent: (captured) => captured,
    },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    randomUUID: () => 'authority_revision_1',
  });
  const executionAuthority = authority.captureSession('sess_1', { requestId: 'stream_1', mode: 'assist', approvalMode: 'prompt' });
  const store = sessions || {
    sess_1: { id: 'sess_1', session_role: primary ? 'primary' : null, messages: [{ id: 'm0', role: 'user' }] },
    [FORK]: { id: FORK, title: 'Parser work', project_id: 'proj_src', messages: [{ id: 'm1', role: 'user' }, { id: 'm2', role: 'assistant' }] },
    sess_empty: { id: 'sess_empty', messages: [{ id: 'n1', role: 'context' }, { id: 'n2', role: 'assistant', kind: 'tool_use' }] },
    sess_other_primary: { id: 'sess_other_primary', session_role: 'primary', messages: [{ id: 'p1', role: 'user' }] },
    sess_hidden: { id: 'sess_hidden', messages: [{ id: 'h1', role: 'user' }] },
  };
  const calls = { published: [], captured: [], transcripts: [] };
  const backendService = {
    featureFlags: flags,
    sessionStore: {
      getActiveTurn: () => ({ stream_id: 'stream_1', turn_id: 'turn_1', session_incarnation: 'inc_1' }),
      getSessionSummary: () => callerSummary,
      peekSessionSummary: (id) => (id === 'sess_1' ? callerSummary : (store[id] || null)),
      peekSession: (id) => store[id] || null,
    },
    projectAuthority: { captureSession: () => authorityRecord },
    projectService: { get: (id) => (id === 'proj_9' ? { id } : null) },
    chatProposals: {
      async publish(request) {
        calls.published.push(request);
        return {
          ok: true, created: true,
          proposal: {
            proposal_id: `proposal_${'a'.repeat(64)}`, revision: 1, decision_state: 'pending', action_state: 'none', group_id: null,
            display: { title: 't', description: null, initiation: 'offer', authorization_required: false },
          },
        };
      },
    },
  };
  const context = {
    sessionId: 'sess_1', streamId: 'stream_1', logicalTurnId: 'turn_1', sessionIncarnation: 'inc_1', callId: 'call_1',
    executionAuthority, backendService, abortSignal: null,
    sessionDirectoryService: {
      async transcript({ callerSessionId, sessionId }) {
        calls.transcripts.push({ callerSessionId, sessionId });
        return store[sessionId] && inScope(sessionId) ? { ok: true, session_id: sessionId, rows: [] } : { ok: false, reason: 'not_found' };
      },
    },
    proposalDeps: {
      records: S,
      binding: {
        async captureSessionBinding(_context, live) {
          calls.captured.push(live);
          return { ok: true, binding: { workspace_id: null, session: { source_run_mode: 'ask', lockdown: false } } };
        },
      },
      supportsProducerTool: () => true,
    },
  };
  return { context, calls, backendService };
}

function assertRefused(result, harness, pattern) {
  assert.equal(result.isError, true, result.content);
  assert.match(result.content, pattern);
  assert.equal(result.content.includes(FORK), false, 'never echoes the id');
  assert.equal(String(result.errorCode).startsWith('CMP-PROPOSAL-'), true);
  assert.equal(harness.calls.published.length, 0);
  assert.equal(harness.calls.captured.length, 0);
}

test('the primary forks a chat it can see: the id reaches publish in the input', async () => {
  const harness = makeHarness();
  const result = await proposeSessionTool.execute({ ...OFFER, fork_of_session_id: FORK }, harness.context);
  assert.equal(result.isError, false, result.content);
  assert.equal(harness.calls.published.length, 1);
  assert.equal(harness.calls.published[0].input.fork_of_session_id, FORK);
  assert.deepEqual(harness.calls.transcripts, [{ callerSessionId: 'sess_1', sessionId: FORK }], 'the directory scope decides visibility');
  const plain = await proposeSessionTool.execute(OFFER, harness.context);
  assert.equal(plain.isError, false);
  assert.equal(Object.hasOwn(harness.calls.published[1].input, 'fork_of_session_id'), false);
});

test('any other chat is refused with its own sentence before publish', async () => {
  const harness = makeHarness({ primary: false });
  const result = await proposeSessionTool.execute({ ...OFFER, fork_of_session_id: FORK }, harness.context);
  assertRefused(result, harness, /Only the Jenny chat can fork a chat; omit fork_of_session_id\./u);
});

test('a fork cannot also name a project', async () => {
  const harness = makeHarness();
  const result = await proposeSessionTool.execute({ ...OFFER, fork_of_session_id: FORK, project_id: 'proj_9' }, harness.context);
  assertRefused(result, harness, /A fork stays in the project of the chat it copies; omit project_id when you set fork_of_session_id\./u);
});

test('the primary_chat_placement flag turns forking off; undefined means on', async () => {
  const off = makeHarness({ flags: { primary_chat_placement: false } });
  assertRefused(await proposeSessionTool.execute({ ...OFFER, fork_of_session_id: FORK }, off.context), off,
    /Forking a chat is turned off; omit fork_of_session_id\./u);
  const plainOff = await proposeSessionTool.execute(OFFER, off.context);
  assert.equal(plainOff.isError, false, 'an ordinary proposal is untouched by the flag');
  const on = makeHarness({ flags: { primary_chat_placement: true } });
  assert.equal((await proposeSessionTool.execute({ ...OFFER, fork_of_session_id: FORK }, on.context)).isError, false);
});

test('an unknown chat, one outside the directory scope, or no directory at all reads as unknown', async () => {
  const unknown = /No chat with that id that you can fork\. Use a session_id from sessions_list, or omit fork_of_session_id\./u;
  const missing = makeHarness();
  assertRefused(await proposeSessionTool.execute({ ...OFFER, fork_of_session_id: 'sess_missing' }, missing.context), missing, unknown);
  const hidden = makeHarness();
  assertRefused(await proposeSessionTool.execute({ ...OFFER, fork_of_session_id: 'sess_hidden' }, hidden.context), hidden, unknown);
  const noDirectory = makeHarness();
  delete noDirectory.context.sessionDirectoryService;
  assertRefused(await proposeSessionTool.execute({ ...OFFER, fork_of_session_id: FORK }, noDirectory.context), noDirectory, unknown);
  const throwing = makeHarness();
  throwing.context.sessionDirectoryService.transcript = async () => { throw new Error('boom'); };
  assertRefused(await proposeSessionTool.execute({ ...OFFER, fork_of_session_id: FORK }, throwing.context), throwing, unknown);
});

test('the Jenny chat itself, or any primary, cannot be forked', async () => {
  const pattern = /The Jenny chat cannot be forked\. Use another chat's session_id, or omit fork_of_session_id\./u;
  const self = makeHarness();
  assertRefused(await proposeSessionTool.execute({ ...OFFER, fork_of_session_id: 'sess_1' }, self.context), self, pattern);
  const other = makeHarness();
  assertRefused(await proposeSessionTool.execute({ ...OFFER, fork_of_session_id: 'sess_other_primary' }, other.context), other, pattern);
});

test('a chat with no message a fork can start from is refused', async () => {
  const harness = makeHarness();
  assertRefused(await proposeSessionTool.execute({ ...OFFER, fork_of_session_id: 'sess_empty' }, harness.context), harness,
    /That chat has no messages to fork yet\. Omit fork_of_session_id to start an empty chat\./u);
});

test('the manifest entry carries fork_of_session_id as a bounded string for the primary only', () => {
  const entry = toolManifest.tools.find((tool) => tool.name === 'propose_session');
  const field = entry.parameters.properties.fork_of_session_id;
  assert.equal(field.type, 'string');
  assert.equal(field.maxLength, 256);
  assert.match(field.description, /Jenny chat/u);
  assert.match(field.description, /project_id/u);
  assert.deepEqual(entry.parameters.required, ['initiation', 'title']);
  assert.deepEqual(proposeSessionTool.parameters, entry.parameters);
});
