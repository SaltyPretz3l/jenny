'use strict';

// Row 184 W3: a delegate task in write mode works in a worktree that Electron creates and
// vouches for. The sidecar asks through `runtime.operation` with `kind: "helper_worktree"`:
// `create` issues a worktree of the request's project root and returns its root identity,
// which the sidecar puts in the child's execution context; `settle` removes a worktree the
// helper left unchanged. Ids are only valid on the binding that issued them, at most
// MAX_LIVE_HELPER_WORKTREES are live per binding, and no new one is issued while
// MAX_KEPT_HELPER_WORKTREES helper worktrees of the repository wait to be merged or deleted.
// When the binding closes, every unsettled worktree is offered to deleteWorktree, which
// refuses one with local changes; nothing here deletes a worktree with changes.

const crypto = require('node:crypto');
const fs = require('fs');
const { workspaceRootId } = require('../workspace-root-identity');
const { captureFilesystemIdentity } = require('../projects/project-workspace-pool');
const { PROJECT_ERROR_CODES, RUNTIME_ERROR_CODES, TOOL_ERROR_CODES } = require('./error-codes');

const HELPER_WORKTREE_KIND = 'helper_worktree';
const MAX_LIVE_HELPER_WORKTREES = 3;
const MAX_KEPT_HELPER_WORKTREES = 9;
const HELPER_BRANCH_RE = /(^|\/)jenny-helper\//;
const SCHEMA_VERSION = 1;
const SIDECAR_API_VERSION = '2026-10-15';
const MAX_TOKEN_CHARS = 256;
const ALLOWED_KEYS = new Set([
  'schema_version', 'api_version', 'kind', 'request_id', 'session_id', 'authority_revision',
  'operation_id', 'action', 'name', 'helper_worktree_id', 'keep',
]);
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function token(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= MAX_TOKEN_CHARS ? text : '';
}

function rejected(operationId, code, reason, message) {
  return {
    schema_version: SCHEMA_VERSION,
    status: 'rejected',
    operation_id: token(operationId),
    error: { code, reason, message },
  };
}

function granted(operationId, helperWorktree) {
  return {
    schema_version: SCHEMA_VERSION,
    status: 'granted',
    operation_id: operationId,
    helper_worktree: helperWorktree,
  };
}

function readParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).some((key) => !ALLOWED_KEYS.has(key))) return null;
  const read = {
    requestId: token(params.request_id),
    sessionId: token(params.session_id),
    authorityRevision: token(params.authority_revision),
    operationId: token(params.operation_id),
    action: params.action,
  };
  if (params.schema_version !== SCHEMA_VERSION || params.api_version !== SIDECAR_API_VERSION
    || params.kind !== HELPER_WORKTREE_KIND || !read.requestId || !read.sessionId
    || !read.authorityRevision || !read.operationId) return null;
  if (read.action === 'create') {
    if (params.name !== undefined && (typeof params.name !== 'string' || !NAME_RE.test(params.name))) return null;
    if (params.helper_worktree_id !== undefined || params.keep !== undefined) return null;
    return { ...read, name: params.name || 'helper' };
  }
  if (read.action === 'settle') {
    if (typeof params.helper_worktree_id !== 'string' || !ID_RE.test(params.helper_worktree_id)
      || typeof params.keep !== 'boolean' || params.name !== undefined) return null;
    return { ...read, worktreeId: params.helper_worktree_id, keep: params.keep };
  }
  return null;
}

// Why a binding may not issue a helper worktree, or '' when it may.
function writeRefusal(state) {
  if (!state.authority?.root_path) return 'The chat has no project folder to make a worktree of.';
  if (state.trustedContext?.handoffPreparation) return 'This turn may only complete the session handoff.';
  if (state.mode === 'plan' || state.proposeMode) return 'Writing helpers are unavailable in Plan and Propose mode.';
  if (state.readOnly) return 'Writing helpers are unavailable in a read-only request.';
  if (!state.autoRun) return 'Writing helpers run only when the run mode is Auto.';
  return '';
}

class HelperWorktreeAuthority {
  constructor({ resolveWorktreeService = () => null, fsImpl = fs, logger = null, randomBytes = crypto.randomBytes } = {}) {
    this._resolveWorktreeService = resolveWorktreeService;
    this._fs = fsImpl;
    this._logger = typeof logger === 'function' ? logger : null;
    this._randomBytes = randomBytes;
    this._live = new WeakMap();
  }

  liveCount(state) {
    const live = this._live.get(state);
    return live ? live.ids.size + live.pending : 0;
  }

  // On binding close: offer each unsettled worktree to deleteWorktree (a dirty one is refused
  // and kept). Never throws; the caller does not wait for it.
  async releaseAll(state) {
    const live = this._live.get(state);
    if (!live || !live.ids.size) return;
    const ids = [...live.ids];
    live.ids.clear();
    for (const worktreeId of ids) {
      try {
        const service = this._resolveWorktreeService();
        await service?.deleteWorktree?.({ workspaceRoot: state.authority.root_path, worktreeId });
      } catch (error) {
        this._log('WARN', 'helper_worktree.release_failed', { message: String(error?.message || error) });
      }
    }
  }

  // `assertCurrent` throws when the binding's project authority or run mode changed. A settle
  // skips it: it must still run after a cancel or a run-mode change, or an unchanged worktree
  // would be left behind; the binding match below is all a settle needs.
  async handle(state, params, assertCurrent = null) {
    if (params?.action !== 'settle' && assertCurrent) {
      try { assertCurrent(); } catch (error) {
        return rejected(params?.operation_id, PROJECT_ERROR_CODES.STALE, 'project_authority_stale',
          String(error?.message || error).slice(0, 300));
      }
    }
    const read = readParams(params);
    if (!read) {
      return rejected(params?.operation_id, RUNTIME_ERROR_CODES.ADMISSION_REJECTED, 'invalid_schema',
        'Helper worktree operation has an invalid schema.');
    }
    if (!state || state.closed || read.requestId !== state.requestId || read.sessionId !== state.sessionId
      || read.authorityRevision !== state.authorityRevision) {
      return rejected(read.operationId, RUNTIME_ERROR_CODES.ADMISSION_REJECTED, 'authority_mismatch',
        'Helper worktree operation does not match the active request.');
    }
    if (!this._live.has(state)) this._live.set(state, { ids: new Set(), pending: 0 });
    const live = this._live.get(state);
    return read.action === 'create' ? this._create(state, read, live) : this._settle(state, read, live);
  }

  async _create(state, read, live) {
    const refusal = writeRefusal(state);
    if (refusal) return rejected(read.operationId, TOOL_ERROR_CODES.POLICY_DENIED, 'helper_worktree_refused', refusal);
    if (live.ids.size + live.pending >= MAX_LIVE_HELPER_WORKTREES) {
      return rejected(read.operationId, TOOL_ERROR_CODES.POLICY_DENIED, 'helper_worktree_limit',
        `At most ${MAX_LIVE_HELPER_WORKTREES} writing helpers can work at once.`);
    }
    const service = this._resolveWorktreeService();
    if (!service || typeof service.createWorktree !== 'function') {
      return rejected(read.operationId, TOOL_ERROR_CODES.DISABLED, 'helper_worktree_unavailable',
        'Worktrees are unavailable here, so a helper cannot write.');
    }
    // The slot is held across the awaits, so concurrent creates cannot pass the limit.
    live.pending += 1;
    let created;
    try {
      if (await this._keptBacklog(service, state) >= MAX_KEPT_HELPER_WORKTREES) {
        return rejected(read.operationId, TOOL_ERROR_CODES.POLICY_DENIED, 'helper_worktree_backlog',
          `${MAX_KEPT_HELPER_WORKTREES} helper worktrees are waiting to be merged or deleted; clean them up first.`);
      }
      const tag = this._randomBytes(4).toString('hex');
      created = await service.createWorktree({
        workspaceRoot: state.authority.root_path,
        name: `${read.name}-${tag}`,
        branch: `jenny-helper/${read.name}-${tag}`,
        owner: { session_id: state.sessionId, task_id: read.operationId },
        signal: state.signal || null,
      });
    } finally {
      live.pending -= 1;
    }
    if (!created?.success || !created.worktree?.worktree_path) {
      return rejected(read.operationId, TOOL_ERROR_CODES.DISABLED, 'helper_worktree_unavailable',
        String(created?.message || 'The helper worktree could not be created.').slice(0, 300));
    }
    let identity;
    try {
      const rootPath = this._fs.realpathSync.native(created.worktree.worktree_path);
      identity = { root_path: rootPath, root_id: workspaceRootId(rootPath),
        ...captureFilesystemIdentity(rootPath, this._fs) };
    } catch (error) {
      this._log('WARN', 'helper_worktree.identity_failed', { message: String(error?.message || error) });
      return rejected(read.operationId, TOOL_ERROR_CODES.DISABLED, 'helper_worktree_unavailable',
        'The helper worktree was created but could not be identified; it is kept for inspection.');
    }
    live.ids.add(created.worktree.id);
    return granted(read.operationId, {
      id: created.worktree.id,
      branch: created.worktree.branch,
      base_ref: created.worktree.base_ref || '',
      ...identity,
    });
  }

  async _settle(state, read, live) {
    if (!live.ids.has(read.worktreeId)) {
      return rejected(read.operationId, TOOL_ERROR_CODES.POLICY_DENIED, 'helper_worktree_unknown',
        'The helper worktree was not issued for this request.');
    }
    live.ids.delete(read.worktreeId);
    if (read.keep) return granted(read.operationId, { id: read.worktreeId, kept: true });
    const service = this._resolveWorktreeService();
    // deleteWorktree refuses a worktree with local changes, so a wrong `keep: false` loses nothing.
    const removed = service && typeof service.deleteWorktree === 'function'
      ? await service.deleteWorktree({ workspaceRoot: state.authority.root_path, worktreeId: read.worktreeId })
      : null;
    return granted(read.operationId, {
      id: read.worktreeId,
      kept: removed?.success !== true,
      ...(removed?.success === true ? {} : { reason: String(removed?.reason || 'delete_unavailable').slice(0, 80) }),
    });
  }

  // Helper worktrees of this repository that still exist (kept for review). A failed list does
  // not block a create: the cap bounds disk use, it is not a security boundary.
  async _keptBacklog(service, state) {
    if (typeof service.listWorktrees !== 'function') return 0;
    const listed = await service.listWorktrees({ workspaceRoot: state.authority.root_path, signal: state.signal || null });
    if (!listed?.success || !Array.isArray(listed.worktrees)) return 0;
    return listed.worktrees.filter((row) => HELPER_BRANCH_RE.test(String(row?.branch || ''))
      && row.status === 'available').length;
  }

  _log(level, event, details) {
    try { this._logger?.(level, event, details); } catch (_error) { /* logging never fails a settle */ }
  }
}

module.exports = {
  HELPER_WORKTREE_KIND, HelperWorktreeAuthority, MAX_KEPT_HELPER_WORKTREES, MAX_LIVE_HELPER_WORKTREES,
};
