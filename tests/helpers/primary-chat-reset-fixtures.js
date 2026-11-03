'use strict';

// Shared fixture for tests/primary-chat-reset.test.js: resetPrimaryChat / forgetPreview over a real
// ElectronSessionStore and a minimal fake BackendService.

const { createSessionMailStore } = require('../../services/backend/session-mail-store');
const { GENERAL_PROJECT_ID } = require('../../services/projects/project-schema');
const { freshStore, seedConversation } = require('./session-truncate-fixtures');
const F = require('./session-mail-fixtures');

// A fake BackendService: real store, recorders for every port the module reaches.
function setup(t, options = {}) {
  const { store, userDataPath } = freshStore();
  t.after(() => store.dispose());
  const created = store.createSession({ title: 'Jenny', projectId: GENERAL_PROJECT_ID, sessionRole: 'primary' });
  const sessionId = created.id;
  store.setSessionMeta(sessionId, { pinned: true });
  seedConversation(store, sessionId);
  const calls = {
    cancel: [], discard: [], decide: [], journal: [], logs: [], rpc: [], prefs: [], history: [], order: [],
  };
  const memories = options.memories || [];
  const candidates = options.candidates || [];
  const mailStore = createSessionMailStore(store);
  const service = {
    sessionStore: store,
    featureFlags: options.featureFlags || {},
    options: { userDataPath: options.userDataPath || userDataPath },
    _emitServiceLog: (level, event, details) => calls.logs.push({ level, event, details }),
    sessionTurnActors: {
      runSessionMutation(id, site, operation, commit, opts) {
        calls.order.push('lease');
        if (opts?.requireIdle && store.getActiveTurn(id)) {
          return Promise.reject(Object.assign(new Error('a turn is already running'), { code: 'session_busy' }));
        }
        return Promise.resolve().then(operation).then(commit);
      },
    },
    sessionRuntime: {
      async cancelSessionAndWait(id, opts) {
        calls.order.push('cancel');
        calls.cancel.push({ id, opts });
        return options.cancelResult || { ok: true };
      },
    },
    chatMessages: {
      async discard(request) {
        calls.order.push('discard');
        calls.discard.push(structuredClone(request));
        if (options.discardResult) return options.discardResult;
        const ids = new Set(request.message_ids);
        const moved = mailStore.mutate(request.session_id, ({ mail }) => ({
          mail: {
            ...mail,
            inbox: mail.inbox.filter((record) => !ids.has(record.envelope.message_id)),
            discarded: [...mail.discarded, ...mail.inbox
              .filter((record) => ids.has(record.envelope.message_id))
              .map((record) => F.makeDiscard(Number(record.receive_sequence)))],
          },
        }));
        return { ok: moved.ok, updated_count: ids.size };
      },
    },
    chatProposals: {
      async decide(request) {
        calls.order.push('decide');
        calls.decide.push(structuredClone(request));
        return options.decideResult || { ok: true };
      },
    },
    turnEventJournal: {
      purgeTurnsAfter(id, surviving, opts) {
        calls.order.push('journal');
        calls.journal.push({ id, surviving: [...surviving], opts });
        return options.journalResult || { ok: true, purged: 1, durable: true, reason: null };
      },
      flush() {},
    },
    sidecarClient: {
      connected: true,
      async request(method, params) {
        calls.rpc.push({ method, params });
        switch (method) {
          case 'memory.list': return { memories, next_cursor: null };
          case 'memory.pending.list': return { candidates, next_cursor: null };
          case 'memory.delete': return { deleted: true, memory_id: params.memory_id };
          case 'memory.pending.delete': return { deleted: true };
          case 'conversations.purge': return { ok: true };
          default: throw new Error(`unexpected rpc ${method}`);
        }
      },
    },
    projectAuthority: { captureSession: () => ({ project_id: GENERAL_PROJECT_ID }) },
    async setSessionPreferences(id, preferences) {
      calls.prefs.push({ id, preferences });
      return store.setSessionPreferences(id, preferences);
    },
    primaryChatControls: { recordHistory: (kind) => calls.history.push(kind) },
    ...(options.service || {}),
  };
  return { service, store, calls, sessionId, userDataPath, mailStore };
}

const rpcCount = (calls, method) => calls.rpc.filter((entry) => entry.method === method).length;

module.exports = { setup, rpcCount };
