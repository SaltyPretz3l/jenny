'use strict';

/**
 * tests/renderer-attention-inbox-model.test.js
 *
 * Runtime UX A3 (JEN-045) gate — the "Needs you" model. The model is the only
 * place that decides what is waiting on the person, across every session,
 * opened or not. It is pure: no DOM, no bridge, no clock. Honesty rules it
 * must not break — an approval row always carries its tool, its argument
 * preview and the writes-or-not facts; "Always allow" is never offered for an
 * approval the transcript would refuse to offer it for; an approval belonging
 * to a session that is gone is dropped rather than rendered against a title
 * the model had to invent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAttentionInbox } = require('../renderer/shell/renderer-attention-inbox-model');

function factsStub() {
  const calls = [];
  return {
    calls,
    getApprovalFacts(toolName, input) {
      calls.push(['facts', toolName, input]);
      if (input?.command) return [{ kind: 'execute', label: 'Jenny cannot check what this does' }];
      return input?.path ? [{ kind: 'write', label: `Writes ${input.path}` }] : [];
    },
    getApprovalCommandPreview(toolName, input) {
      calls.push(['preview', toolName, input]);
      return String(input?.command || input?.path || '');
    },
  };
}

function session(id, extra = {}) {
  return { id, title: `Chat ${id}`, pending_question_batch: null, ...extra };
}

function questionBatch(batchId, count = 1, introText = 'Pick one') {
  return {
    batch_id: batchId,
    round_index: 1,
    intro_text: introText,
    questions: Array.from({ length: count }, (_value, index) => ({
      id: `q${index + 1}`,
      prompt: `Question ${index + 1}`,
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    })),
  };
}

/* The live producer (renderer-stream-handler-tools.js) writes every field. */
function liveApproval(overrides = {}) {
  return {
    approvalId: 'appr-1',
    callId: 'call-1',
    toolName: 'Write',
    input: { path: 'notes.md' },
    streamId: 'stream-1',
    sessionId: 's1',
    summary: 'Write notes.md',
    policyScope: 'session',
    policyConsequence: 'writes',
    oneOffOnly: false,
    ...overrides,
  };
}

/* The session-open rehydration producer (renderer-session-lifecycle-utils.js)
 * writes the seven base fields plus the policy fields it can read off the
 * persisted approval; the shape below is what a persisted call with no policy
 * yields. */
function rehydratedApproval(overrides = {}) {
  return {
    approvalId: 'appr-r',
    callId: 'call-r',
    toolName: 'Bash',
    input: { command: 'ls -la' },
    streamId: 'stream-r',
    sessionId: 's1',
    summary: 'Run ls',
    ...overrides,
  };
}

function build(options = {}) {
  return buildAttentionInbox({
    sessions: options.sessions || [],
    pendingToolApprovals: options.pendingToolApprovals || new Map(),
    currentSessionId: options.currentSessionId || '',
    facts: 'facts' in options ? options.facts : factsStub(),
  });
}

function approvalMap(entries) {
  return new Map(entries.map((entry) => [entry.approvalId || entry.callId, entry]));
}

test('nothing waiting is a hidden inbox with zero counts and no rows', () => {
  const inbox = build({ sessions: [session('s1')] });
  assert.equal(inbox.hidden, true);
  assert.deepEqual(inbox.rows, []);
  assert.deepEqual({ ...inbox.counts }, { approvals: 0, planReviews: 0, questions: 0, answerable: 0 });
});

test('the whole result, its rows and its counts are frozen', () => {
  const inbox = build({
    sessions: [session('s1', { pending_question_batch: questionBatch('b1') })],
    pendingToolApprovals: approvalMap([liveApproval()]),
  });
  assert.equal(Object.isFrozen(inbox), true);
  assert.equal(Object.isFrozen(inbox.rows), true);
  assert.equal(Object.isFrozen(inbox.counts), true);
  inbox.rows.forEach((row) => assert.equal(Object.isFrozen(row), true, `${row.key} must be frozen`));
  assert.equal(Object.isFrozen(inbox.rows[0].facts), true, 'facts travel frozen too');
});

test('an approval row carries the tool, the argument preview and the facts from the injected helper', () => {
  const facts = factsStub();
  const inbox = build({
    sessions: [session('s1')],
    pendingToolApprovals: approvalMap([liveApproval()]),
    facts,
  });
  assert.equal(inbox.hidden, false);
  assert.equal(inbox.rows.length, 1);
  const row = inbox.rows[0];
  assert.equal(row.kind, 'approval');
  assert.equal(row.sessionId, 's1');
  assert.equal(row.sessionTitle, 'Chat s1');
  assert.equal(row.callId, 'call-1');
  assert.equal(row.approvalId, 'appr-1');
  assert.equal(row.toolName, 'Write');
  assert.equal(row.preview, 'notes.md');
  assert.deepEqual(row.facts, [{ kind: 'write', label: 'Writes notes.md' }]);
  assert.equal(row.canAlwaysAllow, true);
  assert.equal(row.order, 0);
  assert.equal(facts.calls.length, 2, 'the model asks the helper once for facts and once for the preview');
});

test('both producer shapes render: the rehydrated entry has no policy fields and still gets a full row', () => {
  const inbox = build({
    sessions: [session('s1')],
    pendingToolApprovals: approvalMap([liveApproval(), rehydratedApproval()]),
  });
  assert.equal(inbox.rows.length, 2);
  const rehydrated = inbox.rows.find((row) => row.callId === 'call-r');
  assert.equal(rehydrated.toolName, 'Bash');
  assert.equal(rehydrated.preview, 'ls -la');
  assert.deepEqual(rehydrated.facts, [{ kind: 'execute', label: 'Jenny cannot check what this does' }]);
  assert.equal(rehydrated.canAlwaysAllow, true, 'a missing oneOffOnly is not a one-off');
});

test('oneOffOnly, in either spelling, withholds Always allow exactly as the transcript block does', () => {
  const inbox = build({
    sessions: [session('s1')],
    pendingToolApprovals: approvalMap([
      liveApproval({ approvalId: 'a-camel', callId: 'c-camel', oneOffOnly: true }),
      { ...rehydratedApproval({ approvalId: 'a-snake', callId: 'c-snake' }), one_off_only: true },
    ]),
  });
  assert.deepEqual(inbox.rows.map((row) => row.canAlwaysAllow), [false, false]);
});

test('one row per call id: the same approval filed under two keys is not two waits', () => {
  const entry = liveApproval();
  const map = new Map([
    ['appr-1', entry],
    ['call-1', { ...entry, approvalId: 'call-1' }],
    ['appr-1-again', { ...entry, approvalId: 'appr-1-again' }],
  ]);
  const inbox = build({ sessions: [session('s1')], pendingToolApprovals: map });
  assert.equal(inbox.rows.length, 1);
  assert.equal(inbox.rows[0].approvalId, 'appr-1', 'the first entry seen wins, so the oldest wait keeps its place');
  assert.equal(inbox.counts.approvals, 1);
});

test('an approval whose session is gone is dropped rather than rendered against an invented title', () => {
  const inbox = build({
    sessions: [session('s1')],
    pendingToolApprovals: approvalMap([liveApproval(), liveApproval({ approvalId: 'a2', callId: 'c2', sessionId: 'finalized' })]),
  });
  assert.deepEqual(inbox.rows.map((row) => row.sessionId), ['s1']);
  assert.equal(inbox.counts.approvals, 1);
});

test('exit_plan_mode is a plan review, never an approval row', () => {
  const inbox = build({
    sessions: [session('s1')],
    pendingToolApprovals: approvalMap([liveApproval({ approvalId: 'p1', callId: 'plan-1', toolName: 'exit_plan_mode', input: { plan: 'do it' } })]),
  });
  assert.equal(inbox.rows.length, 1);
  assert.equal(inbox.rows[0].kind, 'plan_review');
  assert.equal(inbox.rows[0].callId, 'plan-1');
  assert.equal(inbox.counts.planReviews, 1);
  assert.equal(inbox.counts.approvals, 0);
});

test('a session with a pending question batch gets one question row, with a bounded intro', () => {
  const longIntro = 'x'.repeat(200);
  const inbox = build({
    sessions: [session('s1', { pending_question_batch: questionBatch('b1', 3, longIntro) })],
  });
  assert.equal(inbox.rows.length, 1);
  const row = inbox.rows[0];
  assert.equal(row.kind, 'question');
  assert.equal(row.batchId, 'b1');
  assert.equal(row.questionCount, 3);
  assert.equal(row.introText.length, 121, 'the intro is clipped to 120 characters plus the ellipsis');
  assert.equal(row.introText.endsWith('…'), true, 'a clipped intro never reads as a whole sentence');
  assert.equal(row.callId, undefined, 'a question row has no approval to answer in place');
  assert.equal(inbox.counts.questions, 1);
});

test('a null or empty question batch is not a wait', () => {
  const inbox = build({
    sessions: [
      session('s1'),
      session('s2', { pending_question_batch: { batch_id: 'b2', questions: [] } }),
      session('s3', { pending_question_batch: {} }),
    ],
  });
  assert.equal(inbox.hidden, true);
  assert.equal(inbox.rows.length, 0);
});

test('approvals and questions in the same session are two different waits', () => {
  const inbox = build({
    sessions: [session('s1', { pending_question_batch: questionBatch('b1', 2) })],
    pendingToolApprovals: approvalMap([liveApproval()]),
  });
  assert.deepEqual(inbox.rows.map((row) => row.kind), ['approval', 'question']);
  assert.deepEqual({ ...inbox.counts }, { approvals: 1, planReviews: 0, questions: 1, answerable: 2 });
});

test('ordering is approvals, then plan reviews, then questions, oldest first inside each kind', () => {
  const inbox = build({
    sessions: [
      session('s1', { pending_question_batch: questionBatch('b1') }),
      session('s2', { pending_question_batch: questionBatch('b2') }),
    ],
    pendingToolApprovals: approvalMap([
      liveApproval({ approvalId: 'p-old', callId: 'plan-old', toolName: 'exit_plan_mode' }),
      liveApproval({ approvalId: 'a-old', callId: 'call-old' }),
      liveApproval({ approvalId: 'a-new', callId: 'call-new', sessionId: 's2' }),
      liveApproval({ approvalId: 'p-new', callId: 'plan-new', toolName: 'exit_plan_mode', sessionId: 's2' }),
    ]),
  });
  assert.deepEqual(inbox.rows.map((row) => row.key), [
    'approval:call-old', 'approval:call-new',
    'plan_review:plan-old', 'plan_review:plan-new',
    'question:s1:b1', 'question:s2:b2',
  ]);
  assert.deepEqual(inbox.rows.map((row) => row.order), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual({ ...inbox.counts }, { approvals: 2, planReviews: 2, questions: 2, answerable: 6 });
});

test('the conversation on screen keeps its rows but sorts last inside its kind', () => {
  const inbox = build({
    currentSessionId: 's1',
    sessions: [
      session('s1', { pending_question_batch: questionBatch('b1') }),
      session('s2', { pending_question_batch: questionBatch('b2') }),
    ],
    pendingToolApprovals: approvalMap([
      liveApproval({ approvalId: 'a-here', callId: 'call-here', sessionId: 's1' }),
      liveApproval({ approvalId: 'a-there', callId: 'call-there', sessionId: 's2' }),
    ]),
  });
  assert.deepEqual(inbox.rows.map((row) => row.key), [
    'approval:call-there', 'approval:call-here',
    'question:s2:b2', 'question:s1:b1',
  ]);
});

test('a session with no title still names itself rather than rendering an empty row', () => {
  const inbox = build({
    sessions: [{ id: 's1', title: '   ', pending_question_batch: null }],
    pendingToolApprovals: approvalMap([liveApproval()]),
  });
  assert.equal(inbox.rows[0].sessionTitle, 'Untitled chat');
});

test('no facts helper still yields a row, with an empty fact list rather than a thrown build', () => {
  const inbox = build({
    sessions: [session('s1')],
    pendingToolApprovals: approvalMap([liveApproval()]),
    facts: null,
  });
  assert.equal(inbox.rows.length, 1);
  assert.deepEqual(inbox.rows[0].facts, []);
  assert.equal(inbox.rows[0].preview, '');
});

test('junk input builds an empty inbox instead of throwing', () => {
  assert.equal(buildAttentionInbox().hidden, true);
  assert.equal(buildAttentionInbox({ sessions: null, pendingToolApprovals: null }).rows.length, 0);
  assert.equal(buildAttentionInbox({ sessions: [null, 'x', { id: '' }], pendingToolApprovals: [] }).rows.length, 0);
});

test('the argument preview is bounded, and the clip says how much it hid in the transcript card\'s words', () => {
  const command = 'python scripts/refresh.py ' + 'x'.repeat(500);
  const inbox = build({
    sessions: [session('s1')],
    pendingToolApprovals: approvalMap([liveApproval({ input: { command } })]),
  });
  const row = inbox.rows[0];
  assert.equal(row.preview.startsWith('python scripts/refresh.py '), true);
  assert.equal(row.preview.length < 300, true, 'a 500-character payload is not a 500-character row');
  assert.match(row.preview, /… \(\+\d+ more chars\)$/, 'the clip names the hidden length');
  const short = build({
    sessions: [session('s1')],
    pendingToolApprovals: approvalMap([liveApproval({ input: { command: 'ls  -la\n\n/tmp' } })]),
  }).rows[0];
  assert.equal(short.preview, 'ls -la /tmp', 'a short payload is shown whole, on one line');
});

test('an approval row carries the backend\'s scope and consequence, and a stated reason outranks the consequence', () => {
  const inbox = build({
    sessions: [session('s1')],
    pendingToolApprovals: approvalMap([
      liveApproval({ policyScope: 'Workspace files', policyConsequence: 'May change data in this scope.' }),
      liveApproval({
        approvalId: 'appr-2', callId: 'call-2', policyScope: 'Local command execution',
        policyConsequence: 'May run a local command and change local state.',
        reason: 'This command can delete or overwrite files (rm). Approve to continue.',
      }),
      { ...rehydratedApproval({ approvalId: 'appr-3', callId: 'call-3' }), policy_scope: 'Requested tool' },
    ]),
  });
  assert.deepEqual(inbox.rows.map((row) => [row.policyScope, row.consequence]), [
    ['Workspace files', 'May change data in this scope.'],
    ['Local command execution', 'This command can delete or overwrite files (rm). Approve to continue.'],
    ['Requested tool', ''],
  ]);
});

test('an approval with no call id cannot be answered, so it is not listed', () => {
  const inbox = build({
    sessions: [session('s1')],
    pendingToolApprovals: approvalMap([liveApproval({ approvalId: 'a-blank', callId: '' })]),
  });
  assert.equal(inbox.rows.length, 0);
});
