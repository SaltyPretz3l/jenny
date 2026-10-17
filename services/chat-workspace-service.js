'use strict';

/* services/chat-workspace-service.js - main-process owner of the chat workspace
 * summary, rail view state and working-tree Changes reads (row 59 checkpoint 2).
 *
 * It composes facts the application already owns (session store, project
 * authority, session-scoped Git service, artifact metadata, Test Runner
 * activity) into the closed `chatWorkspace.*` bridge shapes. It owns no state
 * of record: the rail view persists through the coordination-record store
 * (C1), everything else is read. IDs received from the renderer select
 * resources inside the profile; they never grant filesystem access.
 *
 * Invalidations (`onChanged`) come from existing main-process signals only:
 * setView writes, terminal chat-stream events (context usage is persisted at
 * the terminal boundary), a tool result that registered artifacts, Test Runner
 * activity for the session and the Workspace IDE fs/git-meta watcher. They are
 * coalesced per session; nothing here polls.
 */

const {
  fail,
  section,
  succeed,
  validateChangeDiffRequest,
  validateSessionRequest,
  validateSetViewRequest,
} = require('./chat-workspace-contract');
const { createChangeNotifier } = require('./chat-workspace-change-notifier');
const {
  buildBackgroundTasksSection,
  buildChangesSection,
  buildContextSection,
  buildEnvironmentSection,
  buildOutputsSection,
  collectOutputs,
} = require('./chat-workspace-summary-sections');
const { createWorkspaceGitChangeSummary } = require('./workspace-git-change-summary');

const CHANGES_FRESH_MS = 2000;
const CHANGES_BUDGET_MS = 1500;
const PREVIEW_BUDGET_MS = 1500;
const PREVIEW_PENDING = Object.freeze({ status: 'unavailable', reason: 'preview_pending' });
const WORKTREE_CACHE_MS = 5000;
const MAX_TRACKED = 64;
const WATCH_TTL_MS = 10 * 60 * 1000;
const TERMINAL_STREAM_TYPES = new Set(['complete', 'error', 'question_batch', 'plan_proposal']);
const NO_STALE_REASONS = new Set(['feature_disabled', 'no_workspace', 'not_a_git_repository']);
// A child's chat-stream start or terminal event moves its parent's Background tasks.
const LINKED_STREAM_TYPES = new Set(['started', ...TERMINAL_STREAM_TYPES]);
const MAX_LINKED_CHILDREN = 32;
const LINKED_WORKS_PER_CHILD = 50;
const PARENT_CACHE_LIMIT = 512;

function boundedSet(map, key, value, limit = MAX_TRACKED) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

class ChatWorkspaceService {
  constructor({
    viewStore,
    getStore,
    getContextPreview = null,
    captureAuthority,
    resolveGitService,
    getProject = () => null,
    getWorktreeEntries = () => [],
    getExecutionEnvironment = () => 'local',
    getWorkspaceTestSource = () => null,
    getRuntimeStore = () => null,
    isActivityEnabled = () => false,
    changeSummary = createWorkspaceGitChangeSummary(),
    emit = () => {},
    log = () => {},
    now = () => new Date(),
    changesBudgetMs = CHANGES_BUDGET_MS,
    previewBudgetMs = PREVIEW_BUDGET_MS,
    changesFreshMs = CHANGES_FRESH_MS,
    notifierOptions = {},
  } = {}) {
    if (!viewStore || typeof viewStore.read !== 'function' || typeof viewStore.write !== 'function') {
      throw new TypeError('ChatWorkspaceService requires a workspace view store.');
    }
    this._viewStore = viewStore;
    this._getStore = getStore;
    this._getContextPreview = getContextPreview;
    this._captureAuthority = captureAuthority;
    this._resolveGitService = resolveGitService;
    this._getProject = getProject;
    this._getWorktreeEntries = getWorktreeEntries;
    this._getExecutionEnvironment = getExecutionEnvironment;
    this._getWorkspaceTestSource = getWorkspaceTestSource;
    this._getRuntimeStore = getRuntimeStore;
    this._isActivityEnabled = isActivityEnabled;
    this._changeSummary = changeSummary;
    this._log = log;
    this._now = now;
    this._changesBudgetMs = changesBudgetMs;
    this._previewBudgetMs = previewBudgetMs;
    this._previews = new Map(); // sessionId -> last estimated preview
    this._changesFreshMs = changesFreshMs;
    this._changes = new Map(); // sessionId -> { key, at, promise, value, lastAvailable }
    this._outputs = new Map(); // sessionId -> { key, outputs }
    this._watched = new Map(); // sessionId -> { rootId, seenAt } (sessions a renderer has read)
    this._parents = new Map(); // sessionId -> parent session id | null (spawned_from is immutable)
    this._worktrees = { at: 0, entries: [] };
    this._activity = { unsubscribe: null, signatures: new Map(), source: null };
    this._notifier = createChangeNotifier({
      emit,
      getRevision: (sessionId) => {
        const view = this._viewStore.read(sessionId);
        return view.ok ? view.coordination_revision : 0;
      },
      ...notifierOptions,
    });
    this._disposed = false;
  }

  // ---- bridge methods -----------------------------------------------------

  async getSummary(raw) {
    const checked = validateSessionRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const sessionId = checked.value.session_id;
    const known = this._readSession(sessionId);
    if (!known.ok) return fail(known.reason);
    const { view, session } = known;
    const sampledAt = this._iso();
    this._ensureActivitySubscription();
    const captured = this._authority(sessionId);
    const authority = captured.ok ? captured.authority : null;
    if (authority) this._touch(sessionId, authority);
    const [changes, preview] = await Promise.all([
      this._changesForSummary(sessionId, authority),
      this._previewForSummary(sessionId),
    ]);
    const hasWorkspace = Boolean(authority?.root_path);
    const environment = captured.ok ? this._safeSection('environment', () => buildEnvironmentSection({
      sampledAt,
      session,
      authority,
      project: this._getProject(authority.project_id),
      branch: changes?.state === 'available' || changes?.state === 'stale' ? changes.data?.branch ?? null : null,
      worktreeEntries: this._worktreeEntries(),
      executionEnvironment: this._getExecutionEnvironment(),
    })) : section('unavailable', { reason: captured.reason });
    const summary = {
      session_id: sessionId,
      session_incarnation: view.session_incarnation,
      revision: view.coordination_revision,
      environment,
      context: this._safeSection('context', () => buildContextSection({ sampledAt, session, preview })),
      outputs: this._safeSection('outputs', () => buildOutputsSection({
        sampledAt, outputs: this._outputsFor(sessionId, session),
      })),
      changes: captured.ok
        ? this._safeSection('changes', () => buildChangesSection({
          changes, workspaceId: authority.root_id, hasWorkspace,
        }))
        : section('unavailable', { reason: captured.reason }),
      background_tasks: this._safeSection('background_tasks', () => this._backgroundTasks(sessionId, authority, sampledAt)),
    };
    return succeed({
      summary,
      workspace_view: view.workspace_view,
      coordination_revision: view.coordination_revision,
    });
  }

  async setView(raw) {
    const checked = validateSetViewRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const { session_id: sessionId, expected_revision: expectedRevision, patch } = checked.value;
    let result;
    try {
      result = this._viewStore.write(sessionId, { expected_revision: expectedRevision, patch });
    } catch {
      result = { ok: false, reason: 'io_failed', retryable: true };
    }
    if (!result || result.ok !== true) {
      return fail(result?.reason, { currentRevision: result?.current_revision, retryable: result?.retryable });
    }
    this._notifier.notify(sessionId);
    return succeed({
      workspace_view: result.workspace_view,
      coordination_revision: result.coordination_revision,
    });
  }

  async listChanges(raw) {
    const checked = validateSessionRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const sessionId = checked.value.session_id;
    const known = this._readSession(sessionId);
    if (!known.ok) return fail(known.reason);
    const captured = this._authority(sessionId);
    if (!captured.ok) return this._changesEnvelope({ state: 'unavailable', reason: captured.reason });
    if (!captured.authority.root_path) return this._changesEnvelope({ state: 'unavailable', reason: 'no_workspace' });
    this._touch(sessionId, captured.authority);
    try {
      return this._changesEnvelope(await this._changesFor(sessionId, captured.authority));
    } catch {
      return this._changesEnvelope({ state: 'unavailable', reason: 'git_failed' });
    }
  }

  async getChangeDiff(raw) {
    const checked = validateChangeDiffRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const { session_id: sessionId, path } = checked.value;
    const known = this._readSession(sessionId);
    if (!known.ok) return fail(known.reason);
    const captured = this._authority(sessionId);
    if (!captured.ok) return fail('unavailable');
    const { authority } = captured;
    if (!authority.root_path) return fail('no_workspace');
    let result;
    try {
      const gitService = this._resolveGitService(authority, sessionId);
      result = await this._changeSummary.getChangeDiff({ gitService, root: authority.root_path, path });
    } catch {
      result = { ok: false, reason: 'git_failed' };
    }
    if (result.ok !== true) {
      if (result.reason === 'path_not_changed' || result.reason === 'path_outside_workspace') {
        this._log('WARN', 'chat_workspace.change_diff_refused', { reason: result.reason });
      }
      return fail(result.reason);
    }
    return succeed({
      path: result.path,
      change: result.change,
      binary: result.binary === true,
      truncated: result.truncated === true,
      diff: result.diff,
    });
  }

  // ---- invalidation sources (existing main-process hooks only) -------------

  // backendService 'chat-stream' events. Hot path: one set lookup per event.
  handleChatStreamEvent(event) {
    const sessionId = event && typeof event.sessionId === 'string' ? event.sessionId : '';
    if (!sessionId) return;
    const type = event.type;
    if (LINKED_STREAM_TYPES.has(type)) {
      const parentId = this._parentOf(sessionId);
      if (parentId) this._notifier.notify(parentId);
    }
    if (TERMINAL_STREAM_TYPES.has(type)) {
      this._expireChanges(sessionId);
      this._notifier.notify(sessionId);
    } else if (type === 'tool_result' && Array.isArray(event.generatedArtifacts) && event.generatedArtifacts.length) {
      this._outputs.delete(sessionId);
      this._notifier.notify(sessionId);
    }
  }

  // A coordination record other than the rail view changed (inline proposals,
  // row 59 checkpoint 3): the revision moved, so the rail refetches.
  notifyCoordinationChanged(sessionId) {
    this._notifier.notify(sessionId);
  }

  // Workspace IDE fs / git-meta watcher payload `{ context: { rootId } }`.
  handleWorkspaceChange(payload) {
    try {
      this._handleWorkspaceChange(payload);
    } catch {
      // Observational only: a watcher callback must never throw into the watcher.
    }
  }

  _handleWorkspaceChange(payload) {
    const rootId = typeof payload?.context?.rootId === 'string' ? payload.context.rootId : null;
    const cutoff = this._now().getTime() - WATCH_TTL_MS;
    for (const [sessionId, entry] of this._watched) {
      if (entry.seenAt < cutoff) {
        this._watched.delete(sessionId);
      } else if (!rootId || entry.rootId === rootId) {
        this._expireChanges(sessionId);
        this._notifier.notify(sessionId);
      }
    }
  }

  dispose() {
    this._disposed = true;
    this._notifier.dispose();
    try { this._activity.unsubscribe?.(); } catch { /* observational */ }
    this._activity = { unsubscribe: null, signatures: new Map(), source: null };
    this._changes.clear();
    this._outputs.clear();
    this._watched.clear();
    this._parents.clear();
  }

  // ---- internals ----------------------------------------------------------

  _iso() {
    return this._now().toISOString();
  }

  _readSession(sessionId) {
    const view = this._viewStore.read(sessionId);
    if (!view || view.ok !== true) return { ok: false, reason: view?.reason === 'not_found' ? 'not_found' : 'unavailable' };
    let session;
    try {
      session = this._getStore()?.getSessionSummary?.(sessionId) || null;
    } catch {
      session = null;
    }
    return session ? { ok: true, view, session } : { ok: false, reason: 'not_found' };
  }

  _authority(sessionId) {
    try {
      const authority = this._captureAuthority(sessionId);
      return authority && typeof authority === 'object'
        ? { ok: true, authority } : { ok: false, reason: 'project_unavailable' };
    } catch (error) {
      return { ok: false, reason: error?.reason === 'session_not_found' ? 'not_found' : 'project_unavailable' };
    }
  }

  _safeSection(name, build) {
    try {
      return build();
    } catch {
      this._log('WARN', 'chat_workspace.section_failed', { section: name });
      return section('unavailable', { reason: 'section_failed' });
    }
  }

  _touch(sessionId, authority) {
    boundedSet(this._watched, sessionId, {
      rootId: typeof authority.root_id === 'string' ? authority.root_id : null,
      seenAt: this._now().getTime(),
    });
  }

  _worktreeEntries() {
    const nowMs = this._now().getTime();
    if (nowMs - this._worktrees.at > WORKTREE_CACHE_MS) {
      let entries;
      try { entries = this._getWorktreeEntries() || []; } catch { entries = []; }
      this._worktrees = { at: nowMs, entries };
    }
    return this._worktrees.entries;
  }

  _outputsFor(sessionId, session) {
    const key = `${session.updated_at || ''}|${session.message_count ?? ''}`;
    const cached = this._outputs.get(sessionId);
    if (cached && cached.key === key) return cached.outputs;
    let messages;
    try {
      messages = this._getStore().peekSessionMessages(sessionId);
    } catch {
      return null;
    }
    const outputs = collectOutputs(messages);
    boundedSet(this._outputs, sessionId, { key, outputs });
    return outputs;
  }

  _backgroundTasks(sessionId, authority, sampledAt) {
    let rows = null;
    const failedSources = [];
    if (this._isActivityEnabled()) {
      try {
        const all = this._getWorkspaceTestSource()?.getActivityRuns?.();
        if (Array.isArray(all)) {
          rows = all.filter((row) => row?.scope?.session_id === sessionId
            && (!authority || row.scope.project_id === authority.project_id));
        }
      } catch {
        rows = null;
        failedSources.push('workspace_test');
      }
    }
    return buildBackgroundTasksSection({
      sampledAt,
      sessionId,
      rows: rows || [],
      workspaceTestSupported: rows !== null,
      linkedRows: this._linkedWorkRows(sessionId, failedSources),
      failedSources,
    });
  }

  // The session that spawned `sessionId`, from its summary's spawned_from (read
  // defensively: a summary without it, or a store without summaries, is a root).
  // A summary that cannot be read yet is not cached.
  _parentOf(sessionId) {
    if (this._parents.has(sessionId)) return this._parents.get(sessionId);
    let summary;
    try {
      summary = this._getStore()?.getSessionSummary?.(sessionId) || null;
    } catch {
      return null;
    }
    if (!summary) return null;
    const parent = summary.spawned_from?.parent_session_id;
    const parentId = typeof parent === 'string' && parent && parent !== sessionId ? parent : null;
    boundedSet(this._parents, sessionId, parentId, PARENT_CACHE_LIMIT);
    return parentId;
  }

  // Runtime work summaries of this session's direct linked children, or null
  // when the source cannot be read (no runtime store, no session listing, a
  // failed read): unsupported is not zero.
  _linkedWorkRows(sessionId, failedSources = []) {
    let store;
    let runtimeStore;
    try {
      store = this._getStore();
      runtimeStore = this._getRuntimeStore();
    } catch {
      failedSources.push('linked_chat_turn');
      return null;
    }
    if (typeof store?.listSessions !== 'function' || typeof runtimeStore?.listSummaries !== 'function') return null;
    try {
      const children = (store.listSessions() || [])
        .filter((child) => typeof child?.id === 'string' && child.id !== sessionId
          && child.spawned_from?.parent_session_id === sessionId)
        .slice(0, MAX_LINKED_CHILDREN);
      const rows = [];
      for (const child of children) {
        const page = runtimeStore.listSummaries({ sessionId: child.id, limit: LINKED_WORKS_PER_CHILD });
        for (const work of Array.isArray(page?.items) ? page.items : []) {
          if (work?.session_id !== child.id || typeof work.work_id !== 'string') continue;
          rows.push({
            work_id: work.work_id,
            status: work.status,
            created_at: work.created_at,
            updated_at: work.updated_at,
            child_session_id: child.id,
            title: child.title,
          });
        }
      }
      return rows;
    } catch {
      this._log('WARN', 'chat_workspace.linked_tasks_failed', {});
      failedSources.push('linked_chat_turn');
      return null;
    }
  }

  _changesEnvelope(result) {
    return succeed({
      state: result.state,
      reason: result.reason || null,
      sampled_at: result.sampled_at || null,
      data: result.state === 'available' || result.state === 'stale' ? result.data : null,
    });
  }

  // Shared, single-flight, briefly cached Changes read for one session.
  _changesFor(sessionId, authority) {
    const key = `${authority.root_id}|${authority.root_revision}`;
    const entry = this._changes.get(sessionId);
    const nowMs = this._now().getTime();
    if (entry && entry.key === key) {
      if (entry.promise) return entry.promise;
      if (entry.value && nowMs - entry.at < this._changesFreshMs) return Promise.resolve(entry.value);
    }
    const previous = entry && entry.key === key ? entry.lastAvailable : null;
    const record = { key, at: nowMs, promise: null, value: null, lastAvailable: previous };
    const run = (async () => {
      let result;
      try {
        const gitService = this._resolveGitService(authority, sessionId);
        result = await this._changeSummary.listChanges({
          gitService, root: authority.root_path, workspaceId: authority.root_id || null,
        });
      } catch {
        result = { state: 'unavailable', reason: 'git_failed', sampled_at: this._iso(), data: null };
      }
      if (result.state === 'available') {
        record.lastAvailable = result;
      } else if (result.state === 'unavailable' && record.lastAvailable && !NO_STALE_REASONS.has(result.reason)) {
        result = { ...result, state: 'stale', data: record.lastAvailable.data, sampled_at: record.lastAvailable.sampled_at };
      }
      record.value = result;
      // Invalidated while the read ran: the result predates the change, so it is not fresh and the
      // session is told to read again.
      record.at = record.dirty ? 0 : this._now().getTime();
      record.promise = null;
      if (record.dirty && !this._disposed) this._notifier.notify(sessionId);
      record.dirty = false;
      return result;
    })();
    record.promise = run;
    boundedSet(this._changes, sessionId, record);
    return run;
  }

  // Summary budget: a slow Git read reports `checking` and invalidates the
  // session when it lands, so the rail refetches a warm cache instead of the
  // whole summary waiting on a repository scan.
  // The estimate never holds the other sections: past the budget the last
  // estimate shows stale (or Checking) and a changed late result re-notifies.
  async _previewForSummary(sessionId) {
    if (!this._getContextPreview) return null;
    const last = this._previews.get(sessionId);
    let changed = false;
    const pending = Promise.resolve().then(() => this._getContextPreview(sessionId))
      .catch(() => ({ status: 'unavailable' }))
      .then((value) => {
        if (value?.status !== 'estimated') return value;
        const previous = this._previews.get(sessionId);
        changed = !previous || previous.used_tokens !== value.used_tokens
          || JSON.stringify(previous.breakdown) !== JSON.stringify(value.breakdown);
        boundedSet(this._previews, sessionId, value);
        return value;
      });
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), this._previewBudgetMs);
    });
    const result = await Promise.race([pending, timeout]);
    clearTimeout(timer);
    if (result) return result;
    pending.then(() => { if (changed && !this._disposed) this._notifier.notify(sessionId); }, () => {});
    return last ? { ...last, stale: true } : PREVIEW_PENDING;
  }

  async _changesForSummary(sessionId, authority) {
    if (!authority?.root_path) return null;
    let pending;
    try {
      pending = this._changesFor(sessionId, authority);
    } catch {
      return { state: 'unavailable', reason: 'git_failed', sampled_at: this._iso(), data: null };
    }
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), this._changesBudgetMs); // cleared as soon as the race settles
    });
    const result = await Promise.race([pending.catch(() => ({
      state: 'unavailable', reason: 'git_failed', sampled_at: this._iso(), data: null,
    })), timeout]);
    clearTimeout(timer);
    if (result) return result;
    pending.then(() => { if (!this._disposed) this._notifier.notify(sessionId); }, () => {});
    return { state: 'checking', reason: 'sampling', sampled_at: null, data: null };
  }

  _expireChanges(sessionId) {
    const entry = this._changes.get(sessionId);
    if (!entry) return;
    if (entry.promise) entry.dirty = true;
    else entry.at = 0;
  }

  // Test Runner activity is the one source with per-session rows. A change of
  // any session's row signature invalidates that session only.
  _ensureActivitySubscription() {
    if (this._disposed || !this._isActivityEnabled()) return;
    let source = null;
    try { source = this._getWorkspaceTestSource(); } catch { source = null; }
    if (!source || typeof source.subscribeActivity !== 'function' || this._activity.source === source) return;
    try { this._activity.unsubscribe?.(); } catch { /* observational */ }
    this._activity = { unsubscribe: null, signatures: new Map(), source };
    try {
      this._activity.unsubscribe = source.subscribeActivity(() => this._onActivity(source));
    } catch {
      this._activity.source = null;
    }
  }

  _onActivity(source) {
    if (this._disposed) return;
    let rows;
    try { rows = source.getActivityRuns(); } catch { return; }
    const next = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const sessionId = row?.scope?.session_id;
      if (typeof sessionId !== 'string' || !sessionId) continue;
      next.set(sessionId, `${next.get(sessionId) || ''}${row.runId}:${row.state}:${row.updatedAt};`);
    }
    const previous = this._activity.signatures;
    this._activity.signatures = next;
    for (const sessionId of new Set([...previous.keys(), ...next.keys()])) {
      if (previous.get(sessionId) !== next.get(sessionId)) this._notifier.notify(sessionId);
    }
  }
}

module.exports = { ChatWorkspaceService };
