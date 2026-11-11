'use strict';

/**
 * What the working tree changed since the last commit, for the Working tree
 * pictures. Git stays behind the session's own WorkspaceGitService, which owns
 * the root and repository guards; this only reshapes its status list and reads
 * a file's committed text. Nothing here takes a ref, a path outside the status
 * list, or returns git output.
 */

// -> [{ path, status }] in the capture service's vocabulary, or null when the
// tree is mid-merge: a half-merged file has no honest Before or After.
function workingTreeFiles(statusFiles) {
  const files = [];
  for (const file of Array.isArray(statusFiles) ? statusFiles : []) {
    const filePath = typeof file?.path === 'string' ? file.path : '';
    if (!filePath) continue;
    const state = String(file.state || 'modified');
    if (state === 'conflicted') return null;
    if (state === 'deleted') {
      files.push({ path: filePath, status: 'deleted' });
    } else if (state === 'untracked' || state === 'added' || state === 'copied') {
      files.push({ path: filePath, status: 'created' });
    } else if (state === 'renamed') {
      files.push({ path: filePath, status: 'created' });
      if (typeof file.origPath === 'string' && file.origPath) files.push({ path: file.origPath, status: 'deleted' });
    } else {
      files.push({ path: filePath, status: 'modified' });
    }
  }
  return files;
}

function createWorkingTreeLoader({ resolveGitService }) {
  return async function loadWorkingTree({ sessionId }) {
    const git = await resolveGitService(sessionId);
    if (!git || typeof git.getStatus !== 'function' || typeof git.getFileAtHead !== 'function') return null;
    const status = await git.getStatus({});
    // A cut-off list would picture some changed files as if they were committed.
    if (status?.ok !== true || status.isRepo !== true || status.truncated === true) return null;
    const files = workingTreeFiles(status.files);
    if (!files) return null;
    return {
      files,
      async readHead(relPath) {
        const result = await git.getFileAtHead({ path: relPath });
        return result?.ok === true && result.found === true && typeof result.content === 'string'
          ? result.content
          : null;
      },
    };
  };
}

module.exports = { createWorkingTreeLoader, workingTreeFiles };
