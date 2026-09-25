'use strict';

// Gate C4 F5: quitting the app rewrote every chat without a model override
// whose effort the default model's inferred engine lacks ('medium' ->
// 'default') and bumped its updated_at. A stored effort is the user's choice;
// a clamp for the current model applies only to the outgoing request.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BackendService } = require('../services/backend/backend-service');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { unloadModel } = require('../services/backend/backend-runtime');
const { listSessions } = require('../services/backend/backend-sessions');

const BONSAI = 'ternary-bonsai-2-27b-pq2_0';
const UPDATED_AT = '2026-09-22T18:19:27.658Z';

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-effort-choice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
  const sessionId = store.createSession({ title: 'Quarterly statement' }).id;
  store._backend.upsertSession(sessionId, {
    ...store.getSession(sessionId),
    preferred_model: '',
    reasoning_effort: 'medium',
    updated_at: UPDATED_AT,
  });
  store.flush?.();
  const sessionFile = path.join(root, 'sessions', `${sessionId}.json`);
  const service = Object.create(BackendService.prototype);
  Object.assign(service, {
    sessionStore: store,
    shadowStore: { getSession: () => null, summarize: () => ({}), setSessionPreferences() {} },
    defaultModel: BONSAI,
    currentModel: BONSAI,
    currentEngineType: 'openai-compatible',
    currentStatus: { engine: 'openai-compatible', model: BONSAI, provider_capabilities: {} },
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: { async modelsUnload() {} },
    _buildManagedStatusSnapshot(overrides = {}) {
      return { engine: this.currentEngineType, model: this.currentModel, provider_capabilities: {}, ...overrides };
    },
  });
  return { store, service, sessionId, sessionFile, before: fs.readFileSync(sessionFile, 'utf8') };
}

function assertUntouched({ store, sessionId, sessionFile, before }) {
  store.flush?.();
  const session = store.getSession(sessionId);
  assert.equal(session.reasoning_effort, 'medium');
  assert.equal(session.updated_at, UPDATED_AT);
  assert.equal(fs.readFileSync(sessionFile, 'utf8'), before, 'the chat file must not be rewritten');
}

test('listing chats never rewrites a stored effort or bumps updated_at', async (t) => {
  const fixture = createFixture(t);
  await listSessions(fixture.service);
  assertUntouched(fixture);
});

test('unloading the model at shutdown never rewrites a stored effort or bumps updated_at', async (t) => {
  const fixture = createFixture(t);
  await unloadModel(fixture.service);
  assertUntouched(fixture);
});
