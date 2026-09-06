const { execFile } = require('child_process');

const { clipText, normalizeString } = require('../backend/path-utils');
const {
  formatDateKey,
  getSystemTimeZone,
} = require('../personality-workspace-service');

function clipMemorySnippet(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!lines.length) {
    return 'No notes yet.';
  }
  return clipText(lines[0], 180);
}

function normalizeWorkspaceRootStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      state: 'missing',
      message: 'No workspace root is configured. Workspace-dependent companion details are blocked.',
    };
  }
  return {
    state: String(value.state || 'missing').trim() || 'missing',
    message: String(value.message || '').trim(),
  };
}

function formatHomeDateLabel(date, timeZone) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(date);
  } catch (_error) {
    return date.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  }
}

function gitExec(execFileImpl, workspaceRoot, args) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      'git',
      ['-C', workspaceRoot, ...args],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || error)));
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

async function readGitSnapshot(workspaceRoot, execFileImpl = execFile) {
  try {
    const branch = clipText(
      await gitExec(execFileImpl, workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
      80
    ) || 'unknown';
    const statusRaw = await gitExec(execFileImpl, workspaceRoot, ['status', '--porcelain']);
    const statusLines = statusRaw
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    const recentCommitsRaw = await gitExec(
      execFileImpl,
      workspaceRoot,
      ['log', '-3', '--pretty=format:%h %s']
    ).catch(() => '');
    const recentCommits = recentCommitsRaw
      .split(/\r?\n/)
      .map((line) => clipText(line, 120))
      .filter(Boolean);
    const stagedCount = statusLines.filter(
      (line) => line.charAt(0) !== ' ' && line.charAt(0) !== '?'
    ).length;
    const untrackedCount = statusLines.filter((line) => line.startsWith('??')).length;
    return {
      available: true,
      branch,
      recentCommits,
      summary: `Git: branch ${branch}; ${statusLines.length} changed, ${stagedCount} staged, ${untrackedCount} untracked.`,
    };
  } catch (error) {
    const message = String(error && error.message || error).toLowerCase();
    if (message.includes('not a git repository')) {
      return {
        available: false,
        branch: '',
        recentCommits: [],
        summary: 'Workspace root is available, but it is not a git repository.',
      };
    }
    return {
      available: false,
      branch: '',
      recentCommits: [],
      summary: 'Git activity could not be read for this workspace.',
    };
  }
}

function unavailableGitSnapshot(summary) {
  return {
    available: false,
    branch: '',
    recentCommits: [],
    summary,
  };
}

function normalizeCachedGitSnapshot(gitSnapshot) {
  if (!gitSnapshot || typeof gitSnapshot !== 'object' || Array.isArray(gitSnapshot)) {
    return null;
  }
  return {
    available: gitSnapshot.available === true,
    branch: normalizeString(gitSnapshot.branch),
    recentCommits: Array.isArray(gitSnapshot.recentCommits)
      ? gitSnapshot.recentCommits.map((line) => clipText(line, 120)).filter(Boolean)
      : [],
    summary: normalizeString(gitSnapshot.summary),
  };
}

async function resolveWorkspaceGitSnapshot({
  normalizedWorkspaceRoot,
  normalizedWorkspaceStatus,
  gitSnapshot,
  execFileImpl,
}) {
  if (!normalizedWorkspaceRoot) {
    return unavailableGitSnapshot('Workspace root is not set, so repo-aware briefing is blocked.');
  }
  if (normalizedWorkspaceStatus.state !== 'ready') {
    return unavailableGitSnapshot(
      normalizedWorkspaceStatus.message || 'Workspace-dependent companion details are blocked.'
    );
  }
  return normalizeCachedGitSnapshot(gitSnapshot)
    || readGitSnapshot(normalizedWorkspaceRoot, execFileImpl);
}

async function resolveTimeZone(personalityWorkspace) {
  if (!personalityWorkspace || typeof personalityWorkspace.getResolvedTimeZone !== 'function') {
    return getSystemTimeZone();
  }
  try {
    return await personalityWorkspace.getResolvedTimeZone();
  } catch (_error) {
    return getSystemTimeZone();
  }
}

// Personality v3 retired the daily memory/YYYY-MM-DD.md files; MEMORY.md
// ("Long-term notes") is the only durable note surface left, so the briefing
// carries one Notes line instead of a yesterday/today pair.
async function readNotesSnapshot(personalityWorkspace) {
  if (
    !personalityWorkspace
    || typeof personalityWorkspace.getNotesSnapshot !== 'function'
  ) {
    return null;
  }
  try {
    const snapshot = await personalityWorkspace.getNotesSnapshot();
    return snapshot && snapshot.available ? snapshot : null;
  } catch (_error) {
    return null;
  }
}

async function buildDailyBriefingSnapshot({
  now = new Date(),
  timeZone = '',
  workspaceRoot = '',
  workspaceRootStatus = null,
  personalityWorkspace = null,
  execFileImpl = execFile,
  gitSnapshot = null,
} = {}) {
  const resolvedTimeZone = String(timeZone || '').trim()
    || await resolveTimeZone(personalityWorkspace);
  const dateKey = formatDateKey(now, resolvedTimeZone);
  const dateLabel = formatHomeDateLabel(now, resolvedTimeZone);
  const normalizedWorkspaceRoot = normalizeString(workspaceRoot);
  const normalizedWorkspaceStatus = normalizeWorkspaceRootStatus(workspaceRootStatus);
  const git = await resolveWorkspaceGitSnapshot({
    normalizedWorkspaceRoot,
    normalizedWorkspaceStatus,
    gitSnapshot,
    execFileImpl,
  });

  const notesSnapshot = await readNotesSnapshot(personalityWorkspace);
  const memory = {
    available: Boolean(notesSnapshot),
    notesSnippet: notesSnapshot ? clipMemorySnippet(notesSnapshot.notes) : 'No notes yet.',
  };

  const lines = [`Morning briefing for ${dateKey} (${resolvedTimeZone}).`];
  if (!normalizedWorkspaceRoot) {
    lines.push('Workspace root is not set, so repo-aware briefing is blocked.');
  } else if (normalizedWorkspaceStatus.state !== 'ready') {
    lines.push(normalizedWorkspaceStatus.message || 'Workspace-dependent companion details are blocked.');
  } else {
    lines.push(`Workspace root: ${normalizedWorkspaceRoot}`);
    lines.push(git.summary);
    if (git.recentCommits.length) {
      lines.push(`Recent commits: ${git.recentCommits.join(' | ')}`);
    }
  }
  if (memory.available) {
    lines.push(`Notes: ${memory.notesSnippet}`);
  } else {
    lines.push('Personality memory notes were unavailable.');
  }

  return {
    dateKey,
    dateLabel,
    timeZone: resolvedTimeZone,
    workspace: {
      root: normalizedWorkspaceRoot,
      status: normalizedWorkspaceStatus,
      git,
    },
    memory,
    lines,
  };
}

module.exports = {
  buildDailyBriefingSnapshot,
  clipMemorySnippet,
  formatHomeDateLabel,
  normalizeWorkspaceRootStatus,
  readGitSnapshot,
  resolveTimeZone,
};
