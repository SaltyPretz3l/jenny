const {
  buildDailyBriefingSnapshot,
  readGitSnapshot,
  resolveTimeZone,
} = require('./proactive/briefing');
const { normalizeString } = require('../renderer/shared/string-utils');

function buildBriefingCacheKey({
  dateKey,
  timeZone,
  workspaceRoot,
  workspaceRootStatus,
}) {
  return JSON.stringify({
    dateKey,
    timeZone,
    workspaceRoot: normalizeString(workspaceRoot),
    workspaceState: normalizeString(workspaceRootStatus?.state),
    workspaceMessage: normalizeString(workspaceRootStatus?.message),
  });
}

function shouldReadGitSnapshot({ workspaceRoot, workspaceRootStatus }) {
  return Boolean(
    normalizeString(workspaceRoot)
    && normalizeString(workspaceRootStatus?.state) === 'ready'
  );
}

function createDailyBriefingCache({
  formatDateKey,
  buildSnapshot = buildDailyBriefingSnapshot,
  readGitSnapshotImpl = readGitSnapshot,
} = {}) {
  if (typeof formatDateKey !== 'function') {
    throw new Error('formatDateKey is required for createDailyBriefingCache.');
  }
  let gitEntry = null;

  async function getGitSnapshot(params, key) {
    if (!shouldReadGitSnapshot(params)) {
      return null;
    }
    if (gitEntry?.key === key) {
      return gitEntry.promise || gitEntry.snapshot;
    }
    const promise = readGitSnapshotImpl(params.workspaceRoot, params.execFileImpl);
    gitEntry = { key, promise, snapshot: null };
    try {
      const snapshot = await promise;
      if (gitEntry?.key === key && gitEntry?.promise === promise) {
        gitEntry = { key, promise: null, snapshot };
      }
      return snapshot;
    } catch (error) {
      if (gitEntry?.promise === promise) {
        gitEntry = null;
      }
      throw error;
    }
  }

  return {
    async getSnapshot(params = {}) {
      const timeZone = await resolveTimeZone(params.personalityWorkspace);
      const dateKey = formatDateKey(params.now, timeZone);
      const key = buildBriefingCacheKey({
        dateKey,
        timeZone,
        workspaceRoot: params.workspaceRoot,
        workspaceRootStatus: params.workspaceRootStatus,
      });
      const gitSnapshot = await getGitSnapshot(params, key);
      return buildSnapshot({
        ...params,
        timeZone,
        gitSnapshot,
      });
    },
  };
}

module.exports = {
  createDailyBriefingCache,
};
