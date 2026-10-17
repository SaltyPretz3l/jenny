'use strict';

/* Shared fixtures for the chat workspace service tests (row 59 checkpoint 2):
 * fake coordination view store, session store, change-summary reader and a
 * ChatWorkspaceService factory with a controllable clock. */

const os = require('node:os');
const path = require('node:path');

const { ChatWorkspaceService } = require('../../services/chat-workspace-service');

const SESSION = 'sess_one';
const OTHER = 'sess_two';
const ROOT = path.join(os.tmpdir(), 'jenny-chatws-fake-root');

function makeClock(start = Date.parse('2026-10-15T12:00:00.000Z')) {
  const clock = { ms: start };
  clock.now = () => new Date(clock.ms);
  clock.advance = (ms) => { clock.ms += ms; };
  return clock;
}

function artifact(id, title, status = 'available', kind = 'document') {
  return {
    artifact_id: id,
    artifact_kind: kind,
    title,
    file_name: `${id}.md`,
    display_path: `.jenny/artifacts/${id}.md`,
    absolute_path: path.join(ROOT, `${id}.md`),
    status,
  };
}

function fakeViewStore(initial = {}) {
  const sessions = new Map(Object.entries({
    [SESSION]: { revision: 0, view: { schema_version: 1, rail_visible: null, disclosures: {}, children_expanded: null } },
    [OTHER]: { revision: 7, view: { schema_version: 1, rail_visible: false, disclosures: { outputs: true }, children_expanded: null } },
    ...initial,
  }));
  const calls = [];
  return {
    calls,
    sessions,
    read(id) {
      const record = sessions.get(id);
      if (!record) return { ok: false, reason: 'not_found' };
      return { ok: true, session_incarnation: `inc_${id}`, workspace_view: record.view, coordination_revision: record.revision };
    },
    write(id, request) {
      calls.push([id, request]);
      const record = sessions.get(id);
      if (!record) return { ok: false, reason: 'not_found' };
      if (request.expected_revision !== record.revision) {
        return { ok: false, reason: 'revision_conflict', current_revision: record.revision };
      }
      if (request.patch.bad) return { ok: false, reason: 'invalid_patch' };
      if (request.patch.io) return { ok: false, reason: 'io_failed', retryable: true, current_revision: record.revision };
      record.revision += 1;
      record.view = { ...record.view, ...(request.patch.rail_visible !== undefined ? { rail_visible: request.patch.rail_visible } : {}) };
      return { ok: true, workspace_view: record.view, coordination_revision: record.revision };
    },
  };
}

function fakeStore({ messages = [], summaries = {} } = {}) {
  const peeks = { count: 0 };
  return {
    peeks,
    getSessionSummary(id) {
      if (id !== SESSION && id !== OTHER) return null;
      return {
        id,
        project_id: 'project_a',
        updated_at: '2026-10-15T11:00:00.000Z',
        message_count: messages.length,
        run_mode: 'assist',
        context_usage: {
          version: 1,
          used_tokens: 4000,
          context_window: 8000,
          compact_threshold_tokens: 6000,
          usage_source: 'provider',
          updated_at: '2026-10-15T10:59:00.000Z',
        },
        ...summaries[id],
      };
    },
    peekSessionMessages() { peeks.count += 1; return messages; },
  };
}

function authorityOf(overrides = {}) {
  return { project_id: 'project_a', root_id: 'root_a', root_path: ROOT, root_revision: 1, ...overrides };
}

function fakeChanges(overrides = {}) {
  const calls = { list: 0, diff: [] };
  return {
    calls,
    async listChanges() {
      calls.list += 1;
      return overrides.list ? overrides.list(calls.list) : {
        state: 'available',
        reason: null,
        sampled_at: '2026-10-15T12:00:00.000Z',
        data: {
          workspace_id: 'root_a', scope: 'working_tree', ref: 'main', head: 'abc1234', branch: 'main',
          files: [{ path: 'a.txt', orig_path: null, change: 'modified', binary: false, additions: 2, deletions: 1 }],
          file_count: 1, additions: 2, deletions: 1, truncated: false,
        },
      };
    },
    async getChangeDiff(args) {
      calls.diff.push(args);
      return overrides.diff ? overrides.diff(args) : { ok: true, path: args.path, change: 'modified', binary: false, truncated: false, diff: 'd' };
    },
  };
}

function makeService(options = {}) {
  const clock = options.clock || makeClock();
  const events = [];
  const logs = [];
  const viewStore = options.viewStore || fakeViewStore();
  const store = options.store || fakeStore(options.storeOptions);
  const changes = options.changes || fakeChanges();
  const service = new ChatWorkspaceService({
    viewStore,
    getStore: () => store,
    getContextPreview: options.getContextPreview,
    captureAuthority: options.captureAuthority || (() => authorityOf()),
    resolveGitService: () => ({ marker: 'git' }),
    getProject: (id) => (id === 'project_a' ? { id, name: 'Alpha' } : null),
    getWorktreeEntries: options.getWorktreeEntries || (() => []),
    getExecutionEnvironment: options.getExecutionEnvironment || (() => 'local'),
    getWorkspaceTestSource: () => options.testSource || null,
    isActivityEnabled: () => options.activityEnabled === true,
    changeSummary: changes,
    emit: (event) => events.push(event),
    log: (level, event, details) => logs.push([level, event, details]),
    now: clock.now,
    changesBudgetMs: options.changesBudgetMs ?? 1000,
    previewBudgetMs: options.previewBudgetMs ?? 1000,
    changesFreshMs: options.changesFreshMs ?? 2000,
    notifierOptions: { intervalMs: 0, ...(options.notifierOptions || {}) },
  });
  return { service, events, logs, viewStore, store, changes, clock };
}

const req = (extra = {}) => ({ schema_version: 1, session_id: SESSION, ...extra });

module.exports = {
  OTHER,
  ROOT,
  SESSION,
  artifact,
  authorityOf,
  fakeChanges,
  fakeStore,
  fakeViewStore,
  makeClock,
  makeService,
  req,
};
