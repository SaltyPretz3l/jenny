'use strict';

// Shared fixture for the hosted command-router tests (split out of
// tests/server/command-router.test.js to keep it under the 600-line ratchet).

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { ClientRegistry } = require('../../server/client-registry');
const { CommandReceipts } = require('../../server/command-receipts');
const { ControlLeases } = require('../../server/control-leases');
const { createCommandRouter } = require('../../server/command-router');

const BOOT = 'boot_test';

class BackendHarness extends EventEmitter {
  constructor(root) {
    super();
    this.sessionStore = new ElectronSessionStore(path.join(root, 'sessions.json'));
    this.activeStreams = new Map();
    this.pendingToolApprovals = new Map();
    this.pendingUserQuestions = new Map();
    this.startCalls = [];
    this.workStreams = new Map();
    // Router-only fixture. Real runtime scheduling and preparation fencing are
    // covered by runtime-commands.test.js; this edge admits a controlled stream.
    this.runtimeApplicationService = { submit: async (payload, { beforeCommit }) => {
      beforeCommit();
      const handle = await this.startChatStream({ sessionId: payload.session_id, prompt: payload.prompt,
        preferredModel: payload.preferred_model, planMode: payload.plan_mode, approvalMode: payload.approval_mode });
      const workId = `work_${handle.streamId}`;
      this.workStreams.set(workId, handle.streamId);
      return { ok: true, work_id: workId, turn_id: `turn_${handle.streamId}`,
        session_id: payload.session_id, revision: 1, status: 'pending' };
    } };
    this.failStart = false;
    this.renameGate = null;
    this.renameEntered = null;
    this.nextStream = 0;
    this.projectCalls = [];
    this.projectApplicationService = {
      listProjects: () => ({
        ok: true,
        projects: [{
          id: 'project_alpha', name: 'Alpha', root_path: '/workspace/alpha', root_revision: 1,
          authority_key: `authority_${'a'.repeat(64)}`,
        }],
        storage: { read_only: false, reason: null },
      }),
      createProject: (params) => {
        this.projectCalls.push(['create', params]);
        return {
          ok: true,
          project: {
            id: 'project_created', name: params.name, root_path: null, root_revision: 0,
            authority_key: `authority_${'b'.repeat(64)}`,
          },
        };
      },
      assignSessionProject: ({ session_id: sessionId, project_id: projectId }) => {
        this.projectCalls.push(['assign', { session_id: sessionId, project_id: projectId }]);
        const session = this.sessionStore.updateSession(sessionId, { project_id: projectId });
        return session ? { ok: true, session } : {
          ok: false, error: { code: 'CMP-PROJECT-0002', reason: 'session_not_found' },
        };
      },
    };
  }

  async listSessions() {
    const data = this.sessionStore.listSessions();
    return { object: 'list', data, total: data.length };
  }

  async createSession({ title }) {
    return { object: 'session', data: this.sessionStore.createSession({ title }) };
  }

  async renameSession(sessionId, title) {
    if (this.renameEntered) this.renameEntered();
    if (this.renameGate) await this.renameGate;
    return { object: 'session', data: this.sessionStore.renameSession(sessionId, title) };
  }

  async setSessionPreferences(sessionId, preferences) {
    return { object: 'session', data: this.sessionStore.setSessionPreferences(sessionId, preferences) };
  }

  async deleteSession(sessionId) {
    return { deleted: this.sessionStore.deleteSession(sessionId) };
  }

  async startChatStream({ sessionId, prompt, preferredModel, planMode, approvalMode }) {
    if (this.failStart) throw new Error('provider unavailable');
    this.startCalls.push({ sessionId, prompt, preferredModel, planMode, approvalMode });
    const streamId = `stream_${++this.nextStream}`;
    const message = { id: `message_${this.nextStream}`, role: 'user', content: prompt };
    if (!this.sessionStore.appendMessage(sessionId, message)) throw new Error('append failed');
    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    this.activeStreams.set(streamId, { _pendingPromise: pending, settle, sessionId });
    this.sessionStore.setActiveTurn(sessionId, { request_id: streamId, stream_id: streamId,
      user_message_id: message.id, started_at: new Date().toISOString(), last_event_at: new Date().toISOString(), status: 'awaiting_assistant' });
    return { sessionId, streamId };
  }

  cancelChatStream(streamId) {
    const controller = this.activeStreams.get(streamId);
    if (!controller) return false;
    this.finish(streamId, 'error');
    return true;
  }

  finish(streamId, type = 'complete') {
    const controller = this.activeStreams.get(streamId);
    if (!controller) return false;
    this.activeStreams.delete(streamId);
    this.sessionStore.clearActiveTurn(controller.sessionId, { streamId });
    this.emit('chat-stream', { type, sessionId: controller.sessionId, streamId });
    controller.settle();
    return true;
  }

  dispose() { this.sessionStore.dispose(); }
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-command-router-'));
  const backend = new BackendHarness(root);
  const clients = new ClientRegistry();
  const leases = new ControlLeases();
  const receipts = new CommandReceipts({ filePath: path.join(root, 'receipts.json') });
  const eventStream = {
    cursor: 0,
    events: [],
    publish(type, payload) { this.events.push({ type, payload }); this.cursor += 1; },
  };
  const router = createCommandRouter({ backend, clients, leases, receipts, bootEpoch: BOOT, eventStream });
  const a = clients.register('device-a');
  const b = clients.register('device-b');
  const context = (auth, deviceId) => ({
    deviceId, clientToken: auth.client_token, isAuthenticated: () => true,
  });
  return {
    root, backend, clients, leases, router, a, b,
    contextA: context(a, 'device-a'), contextB: context(b, 'device-b'), eventStream,
    async close() { router.dispose(); backend.dispose(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function admittedStream(f, ack) { return f.backend.workStreams.get(ack.work_id); }

let sequence = 0;
function command(auth, operation, params = {}, extra = {}) {
  return {
    api_version: 1,
    operation,
    request_id: `request_${++sequence}`,
    client_id: auth.client_id,
    boot_epoch: BOOT,
    params,
    ...extra,
  };
}

async function createSession(fixture) {
  const result = await fixture.router.dispatch(
    command(fixture.a, 'sessions.create', { title: 'Router test' }), fixture.contextA,
  );
  assert.equal(result.ok, true);
  return result.session.session_id;
}

async function acquire(fixture, sessionId, auth, context, takeover = false) {
  const result = await fixture.router.dispatch(
    command(auth, 'control.acquire', { takeover }, { session_id: sessionId }), context,
  );
  assert.equal(result.ok, true);
  return result.lease;
}

module.exports = { BOOT, BackendHarness, createFixture, admittedStream, command, createSession, acquire };
