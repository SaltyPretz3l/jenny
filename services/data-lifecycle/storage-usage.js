'use strict';

// "Your data" (row 95): the size of every category of data Jenny keeps, and a
// previewed, token-confirmed clear for the categories that can be cleared. The
// renderer sends a category id and a preview token only; every path is resolved
// here from the registry (storage-usage-registry.js) and acted on through the
// no-follow containment primitives. Absolute paths leave this module only as
// display text for the location line.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_ERROR_CODES } = require('../backend/error-codes');
const { dataLifecycleFailure, dataLifecycleResult } = require('./data-lifecycle-result');
const { listOwnedDerivedFiles } = require('./cleanup-service');
const { resolveContained } = require('../fs-contained');
const { planArtifacts, planChats } = require('./storage-usage-artifact-plan');
const { failureList, runChatUnits, runFileUnits } = require('./storage-usage-exec');
const {
  buildItems, hashUnits, planCaches, planLeftovers, planLogs,
} = require('./storage-usage-plans');
const {
  CATEGORY_IDS, categoryRoots, displayLocation, isCategoryId, isClearableCategory, primaryFolderCandidates,
} = require('./storage-usage-registry');
const { createBudget, measureRoots } = require('./storage-usage-walk');

const TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_LIVE_TOKENS = 16;
const RECENT_FLOOR_MS = 10 * 60 * 1000;
const PLAN_MAX_FILES = 200_000;
// A chat clear's own re-measure of the chats category answers the renderer's refresh that follows it.
const AFTER_CLEAR_REUSE_MS = 10_000;
const MAX_CHATS_PER_CLEAR = 5000;
const MAX_CHAT_CLEAR_MS = 10 * 60 * 1000;

const PLANNERS = Object.freeze({
  logs: planLogs, caches: planCaches, leftovers: planLeftovers, artifacts: planArtifacts, chats: planChats,
});

function invalid(reason) {
  return dataLifecycleFailure({ code: DATA_ERROR_CODES.INVALID_REQUEST, reason });
}

// stale and busy are refusals, not successes: ok false, with the status the renderer branches on.
function refusal(status, code, reason) {
  return { ...dataLifecycleFailure({ code, reason }), status };
}

class StorageUsageService {
  constructor({
    userDataPath,
    runtimePath = '',
    getWorkspaceRoot = () => '',
    sessionStore = null,
    listChatSummaries = null,
    deleteChat = null,
    clearBrowserCaches = null,
    openPath = null,
    getTrackedJobIds = null,
    acquireWorkspaceLease = null,
    platform = process.platform,
    env = process.env,
    now = Date.now,
    logger = () => {},
    caps = {},
    recentFloorMs = RECENT_FLOOR_MS,
    tokenTtlMs = TOKEN_TTL_MS,
    maxChatsPerClear = MAX_CHATS_PER_CLEAR,
    maxChatClearMs = MAX_CHAT_CLEAR_MS,
    planMaxFiles = PLAN_MAX_FILES,
  } = {}) {
    if (!String(userDataPath || '').trim()) throw new TypeError('StorageUsageService requires userDataPath.');
    this.userDataPath = userDataPath;
    this.runtimePath = runtimePath;
    this.getWorkspaceRoot = getWorkspaceRoot;
    this.sessionStore = sessionStore;
    this.listChatSummaries = listChatSummaries || (() => sessionStore?.listSessions?.() || []);
    this.deleteChat = deleteChat;
    this.clearBrowserCaches = clearBrowserCaches;
    this.openPath = openPath;
    this.getTrackedJobIds = getTrackedJobIds;
    this.acquireWorkspaceLease = acquireWorkspaceLease;
    this.platform = platform;
    this.env = env;
    this.now = now;
    this.logger = logger;
    this.caps = caps;
    this.recentFloorMs = recentFloorMs;
    this.tokenTtlMs = tokenTtlMs;
    this.maxChatsPerClear = maxChatsPerClear;
    this.maxChatClearMs = maxChatClearMs;
    this.planMaxFiles = planMaxFiles;
    this.tokens = new Map();
    this.clearing = false;
    this.usageInflight = new Map();
    this.afterClear = null;
  }

  // The artifacts category needs a bound workspace; every other category always exists.
  _available(categoryId, ctx) {
    return categoryId !== 'artifacts' || Boolean(ctx.workspaceRoot);
  }

  _workspaceRoot() {
    try {
      return String(this.getWorkspaceRoot() || '');
    } catch (_error) {
      return '';
    }
  }

  async _context() {
    let userDataEntries = [];
    try {
      userDataEntries = await fs.promises.readdir(this.userDataPath);
    } catch (_error) { /* an absent profile has nothing to count */ }
    let derivedNames = [];
    try {
      derivedNames = listOwnedDerivedFiles(this.userDataPath);
    } catch (_error) { /* counted as nothing */ }
    return {
      userDataPath: this.userDataPath,
      runtimePath: this.runtimePath,
      workspaceRoot: this._workspaceRoot(),
      userDataEntries,
      derivedNames,
    };
  }

  async _measure(categoryId, context) {
    const ctx = context || await this._context();
    return measureRoots(categoryRoots(categoryId, ctx), {
      budget: createBudget({ ...this.caps, now: this.now }),
    });
  }

  _primaryFolder(categoryId, ctx) {
    const candidates = primaryFolderCandidates(categoryId, ctx);
    for (const candidate of candidates) {
      const fallback = candidate.segments.length === 0;
      try {
        const resolved = fallback
          ? (fs.statSync(candidate.base).isDirectory() ? { path: candidate.base } : null)
          : resolveContained(candidate.base, candidate.segments);
        if (resolved && (fallback || resolved.stat.isDirectory())) return resolved.path;
      } catch (_error) { /* try the next candidate */ }
    }
    const last = candidates[candidates.length - 1];
    return last ? path.join(last.base, ...last.segments) : '';
  }

  // The chats re-measure a clear just made, handed out once to the refresh right behind it.
  _takeAfterClear(categoryId) {
    const held = this.afterClear;
    this.afterClear = null;
    return held && held.categoryId === categoryId && held.expiresAt > this.now() ? held.measured : null;
  }

  // request: { categoryIds?: string[] }. Without it every category is measured
  // and totalBytes is their sum; with it (closed ids, 1..7) only those are, and
  // totalBytes is null. Identical calls in flight share one measurement.
  async getStorageUsage(request) {
    const requested = request && typeof request === 'object' ? request.categoryIds : undefined;
    let ids = CATEGORY_IDS;
    if (requested !== undefined) {
      if (!Array.isArray(requested) || !requested.length || requested.length > CATEGORY_IDS.length
        || !requested.every(isCategoryId)) return invalid('unknown_category');
      ids = CATEGORY_IDS.filter((id) => requested.includes(id));
    }
    const key = ids.join(',');
    const running = this.usageInflight.get(key);
    if (running) return running;
    const task = this._measureUsage(ids, requested !== undefined);
    this.usageInflight.set(key, task);
    try {
      return await task;
    } finally {
      if (this.usageInflight.get(key) === task) this.usageInflight.delete(key);
    }
  }

  async _measureUsage(ids, partialRequest) {
    const ctx = await this._context();
    const categories = [];
    let totalBytes = 0;
    for (const id of ids) {
      const available = this._available(id, ctx);
      let measured = { bytes: 0, files: 0, partial: false };
      if (available) {
        measured = (partialRequest && ids.length === 1 && this._takeAfterClear(id)) || await this._measure(id, ctx);
      }
      totalBytes += measured.bytes;
      categories.push({
        id,
        bytes: measured.bytes,
        files: measured.files,
        clearable: isClearableCategory(id),
        available,
        partial: measured.partial,
        locationDisplay: available
          ? displayLocation(this._primaryFolder(id, ctx), { platform: this.platform, env: this.env })
          : '',
      });
    }
    return dataLifecycleResult('ok', { categories, totalBytes: partialRequest ? null : totalBytes });
  }

  async _buildPlan(categoryId) {
    const ctx = await this._context();
    const planContext = {
      ...ctx,
      now: this.now,
      recentFloorMs: this.recentFloorMs,
      planBudget: createBudget({ maxFiles: this.planMaxFiles, maxMs: Infinity, now: this.now }),
      sessionStore: this.sessionStore,
      listChatSummaries: this.listChatSummaries,
      getTrackedJobIds: this.getTrackedJobIds,
      clearBrowserCaches: this.clearBrowserCaches,
      measureCategory: (id) => this._measure(id, ctx),
    };
    return PLANNERS[categoryId](planContext);
  }

  _checkClearable(categoryId) {
    if (!isCategoryId(categoryId)) return invalid('unknown_category');
    if (!isClearableCategory(categoryId)) return invalid('not_clearable');
    if (!this._available(categoryId, { workspaceRoot: this._workspaceRoot() })) return invalid('category_unavailable');
    if (categoryId === 'chats' && typeof this.deleteChat !== 'function') return invalid('category_unavailable');
    return null;
  }

  _issueToken(categoryId, hash, confirmCount) {
    const nowMs = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= nowMs || entry.categoryId === categoryId) this.tokens.delete(token);
    }
    while (this.tokens.size >= MAX_LIVE_TOKENS) this.tokens.delete(this.tokens.keys().next().value);
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, { categoryId, hash, confirmCount, expiresAt: nowMs + this.tokenTtlMs });
    return token;
  }

  async previewClear({ categoryId } = {}) {
    const refused = this._checkClearable(categoryId);
    if (refused) return refused;
    const plan = await this._buildPlan(categoryId);
    const items = buildItems(plan.units, plan.groupTotals);
    const confirmCount = categoryId === 'chats' ? plan.confirmCount : undefined;
    const previewToken = this._issueToken(categoryId, hashUnits(categoryId, plan.units), confirmCount);
    return dataLifecycleResult('ok', {
      categoryId,
      previewToken,
      items,
      totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
      totalFiles: items.reduce((sum, item) => sum + item.files, 0),
      kept: plan.kept,
      partial: plan.partial === true,
      ...(confirmCount === undefined ? {} : { confirmCount }),
    });
  }

  _takeToken(categoryId, previewToken, confirmCount) {
    const entry = this.tokens.get(previewToken);
    if (!entry || entry.categoryId !== categoryId) return { stale: 'preview_unknown' };
    if (entry.expiresAt <= this.now()) {
      this.tokens.delete(previewToken);
      return { stale: 'preview_expired' };
    }
    if (categoryId === 'chats' && confirmCount !== entry.confirmCount) return { invalid: 'confirm_count_mismatch' };
    this.tokens.delete(previewToken);
    return { entry };
  }

  async clearCategory({ categoryId, previewToken, confirmCount } = {}) {
    if (this.clearing) return refusal('busy', DATA_ERROR_CODES.BUSY, 'clear_in_progress');
    const refused = this._checkClearable(categoryId);
    if (refused) return refused;
    if (typeof previewToken !== 'string' || !previewToken) return invalid('preview_required');
    this.clearing = true;
    let lease = null;
    try {
      // The lease comes first: a workspace that is switching must not spend the preview token.
      if (categoryId === 'artifacts' && this.acquireWorkspaceLease) {
        lease = this.acquireWorkspaceLease();
        if (lease?.acquired !== true) {
          lease = null;
          return refusal('busy', DATA_ERROR_CODES.BUSY, 'workspace_transitioning');
        }
      }
      const taken = this._takeToken(categoryId, previewToken, confirmCount);
      if (taken.invalid) return invalid(taken.invalid);
      if (taken.stale) return refusal('stale', DATA_ERROR_CODES.INVALID_REQUEST, taken.stale);
      const plan = await this._buildPlan(categoryId);
      if (hashUnits(categoryId, plan.units) !== taken.entry.hash) {
        return refusal('stale', DATA_ERROR_CODES.INVALID_REQUEST, 'target_set_changed');
      }
      return await this._execute(categoryId, plan);
    } catch (error) {
      return dataLifecycleFailure(error);
    } finally {
      lease?.release?.();
      this.clearing = false;
    }
  }

  async _execute(categoryId, plan) {
    const deps = {
      userDataPath: this.userDataPath,
      walkOptions: { ...this.caps, now: this.now },
      clearBrowserCaches: this.clearBrowserCaches,
      deleteChat: this.deleteChat,
      now: this.now,
      maxChats: this.maxChatsPerClear,
      maxMs: this.maxChatClearMs,
    };
    const outcome = categoryId === 'chats'
      ? await runChatUnits(plan.units, deps)
      : await runFileUnits(plan.units, deps);
    if (categoryId === 'chats' && plan.groupTotals?.chats && !plan.partial) {
      const after = await this._measure('chats');
      this.afterClear = { categoryId: 'chats', measured: after, expiresAt: this.now() + AFTER_CLEAR_REUSE_MS };
      if (!after.partial) outcome.freedBytes = Math.max(outcome.freedBytes, plan.groupTotals.chats.bytes - after.bytes);
    }
    const failed = failureList(outcome);
    this.logger('INFO', 'data_usage.cleared', {
      categoryId, freedBytes: outcome.freedBytes, freedFiles: outcome.freedFiles, failed: failed.length,
    });
    return dataLifecycleResult(failed.length ? 'partial' : 'ok', {
      categoryId,
      freedBytes: outcome.freedBytes,
      freedFiles: outcome.freedFiles,
      failed,
    });
  }

  async revealCategory({ categoryId } = {}) {
    if (!isCategoryId(categoryId)) return invalid('unknown_category');
    if (typeof this.openPath !== 'function') return invalid('reveal_unavailable');
    const ctx = await this._context();
    if (!this._available(categoryId, ctx)) return invalid('category_unavailable');
    const folder = this._primaryFolder(categoryId, ctx);
    let plain = false;
    try {
      const stat = fs.lstatSync(folder);
      plain = stat.isDirectory() && (!stat.isSymbolicLink() || folder === this.userDataPath);
    } catch (_error) { /* missing */ }
    if (!plain) return invalid('folder_missing');
    const failure = await this.openPath(folder);
    if (typeof failure === 'string' && failure) return invalid('open_failed');
    return dataLifecycleResult('ok', { categoryId });
  }
}

module.exports = { StorageUsageService };
