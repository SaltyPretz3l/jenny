'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { SessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const {
  createCheckpointResumeIdentity,
} = require('../../services/backend/session-turn-actor-resume');

const SESSION_ID = 'session_1';
const TURN_ID = 'turn_1';
const USER_MESSAGE_ID = 'user:canonical/1';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-resume-identity-'));
  const file = path.join(root, 'sessions.json');
  const store = new ElectronSessionStore(file, { writeDebounceMs: 0 });
  t.after(() => { store.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  store.createSessionWithId(SESSION_ID, { title: 'Resume identity' });
  store.appendMessage(SESSION_ID, { id: USER_MESSAGE_ID, turn_id: TURN_ID,
    role: 'user', kind: 'message', content: 'Inspect the workspace.',
    timestamp: '2026-09-10T12:00:00.000Z' });
  let nextId = 0;
  const registry = new SessionTurnActorRegistry({ createId: () => `identity_${++nextId}` });
  const activeStreams = new Map();
  const checkpointResume = createCheckpointResumeIdentity({ sessionId: SESSION_ID,
    turnId: TURN_ID, userMessageId: USER_MESSAGE_ID });
  const reserve = (patch = {}) => registry.reserveStart({ sessionId: SESSION_ID,
    store, activeStreams, prompt: 'resume', checkpointResume, ...patch });
  return { root, file, store, registry, activeStreams, checkpointResume, reserve };
}

test('validated checkpoint identity reuses its canonical user and logical turn with a fresh attempt', t => {
  const f = fixture(t);
  const first = f.reserve();
  assert.equal(first.identity.turnId, TURN_ID);
  assert.equal(first.identity.userMessageId, USER_MESSAGE_ID);
  assert.notEqual(first.identity.streamId, TURN_ID);
  assert.equal(first.reuseExistingUserMessage, true);
  assert.equal(first.editedMessageId, null);
  assert.equal(first.consumedContinuation, null);
  assert.deepEqual(f.store.getActiveTurn(SESSION_ID), first.activeTurnClaim);
  assert.equal(first.activeTurnClaim.request_id, TURN_ID);
  assert.equal(first.activeTurnClaim.stream_id, first.identity.streamId);
  assert.equal(f.store.getSessionMessages(SESSION_ID).length, 1);

  f.store.flush();
  const reopened = new ElectronSessionStore(f.file, { writeDebounceMs: 0 });
  try {
    assert.deepEqual(reopened.getActiveTurn(SESSION_ID), first.activeTurnClaim);
    assert.equal(reopened.getSessionMessages(SESSION_ID)[0].id, USER_MESSAGE_ID);
  } finally { reopened.dispose(); }

  assert.equal(f.registry.release(first, { status: 'cancelled' }).released, true);
  const second = f.reserve();
  assert.equal(second.identity.turnId, TURN_ID);
  assert.equal(second.identity.userMessageId, USER_MESSAGE_ID);
  assert.notEqual(second.identity.streamId, first.identity.streamId);
  assert.equal(second.identity.generation, first.identity.generation + 1);
  assert.equal(f.store.getSessionMessages(SESSION_ID).length, 1);
  f.registry.release(second, { status: 'cancelled' });
});

test('resume identity is exact, bounded, branded and preserves canonical message ID grammar', t => {
  const f = fixture(t);
  assert.equal(f.checkpointResume.userMessageId, USER_MESSAGE_ID);
  assert.equal(Object.isFrozen(f.checkpointResume), true);
  const longestMessageId = `u${'x'.repeat(255)}`;
  assert.equal(createCheckpointResumeIdentity({ sessionId: SESSION_ID,
    turnId: TURN_ID, userMessageId: longestMessageId }).userMessageId, longestMessageId);
  for (const value of [
    null,
    { sessionId: SESSION_ID, turnId: TURN_ID },
    { sessionId: SESSION_ID, turnId: TURN_ID, userMessageId: USER_MESSAGE_ID, extra: true },
    { sessionId: 'bad session', turnId: TURN_ID, userMessageId: USER_MESSAGE_ID },
    { sessionId: SESSION_ID, turnId: TURN_ID, userMessageId: `u${'x'.repeat(256)}` },
  ]) assert.throws(() => createCheckpointResumeIdentity(value), /Checkpoint resume identity/);
  assert.throws(() => f.registry.reserveStart({ sessionId: SESSION_ID, store: f.store,
    activeStreams: f.activeStreams, checkpointResume: { sessionId: SESSION_ID,
      turnId: TURN_ID, userMessageId: USER_MESSAGE_ID } }), error => (
    error.code === 'checkpoint_resume_invalid' && error.reason === 'identity_untrusted'
  ));
  assert.equal(f.store.getActiveTurn(SESSION_ID), null);
});

test('actor rechecks the persisted canonical user session, role and logical turn', t => {
  const f = fixture(t);
  f.store.appendMessage(SESSION_ID, { id: 'assistant_1', turn_id: TURN_ID,
    role: 'assistant', kind: 'message', content: 'old response' });
  const cases = [
    [{ sessionId: 'other_session', turnId: TURN_ID, userMessageId: USER_MESSAGE_ID }, 'session_mismatch'],
    [{ sessionId: SESSION_ID, turnId: TURN_ID, userMessageId: 'missing_1' }, 'user_message_unavailable'],
    [{ sessionId: SESSION_ID, turnId: TURN_ID, userMessageId: 'assistant_1' }, 'user_message_role_mismatch'],
    [{ sessionId: SESSION_ID, turnId: 'turn_other', userMessageId: USER_MESSAGE_ID }, 'turn_mismatch'],
  ];
  for (const [identity, reason] of cases) {
    const checkpointResume = createCheckpointResumeIdentity(identity);
    assert.throws(() => f.registry.reserveStart({ sessionId: SESSION_ID, store: f.store,
      activeStreams: f.activeStreams, checkpointResume }), error => (
      error.code === 'checkpoint_resume_invalid' && error.reason === reason
    ));
    assert.equal(f.store.getActiveTurn(SESSION_ID), null);
  }
});

test('checkpoint resume cannot mix with edit, logical-turn or interactive continuation admission', t => {
  const f = fixture(t);
  for (const patch of [
    { interactiveResponse: {} },
    { editedMessageId: USER_MESSAGE_ID },
    { deferEditValidation: true },
    { logicalTurnId: TURN_ID },
  ]) {
    assert.throws(() => f.reserve(patch), error => (
      error.code === 'checkpoint_resume_invalid' && error.reason === 'mixed_admission_mode'
    ));
    assert.equal(f.store.getActiveTurn(SESSION_ID), null);
  }
});
