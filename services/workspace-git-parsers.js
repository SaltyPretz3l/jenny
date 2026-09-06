/* Pure WorkspaceGitService output parsers; WorkspaceGitService re-exports them. */

// Unit-separator byte used as the field delimiter in `git log`/`git branch`
// --format strings. Shared with WorkspaceGitService, which builds those
// format strings.
const US = '\x1f';

function parseBranchHeader(header) {
  if (header.startsWith('No commits yet on ')) {
    return {
      branch: header.slice('No commits yet on '.length).trim(),
      detached: false,
      unborn: true,
      ahead: 0,
      behind: 0,
    };
  }
  if (header.startsWith('HEAD (no branch)') || header === 'HEAD') {
    return { branch: '(detached)', detached: true, unborn: false, ahead: 0, behind: 0 };
  }
  let branch = header;
  const trackIdx = header.indexOf('...');
  if (trackIdx >= 0) {
    branch = header.slice(0, trackIdx);
  } else {
    const spaceIdx = header.indexOf(' ');
    if (spaceIdx >= 0) {
      branch = header.slice(0, spaceIdx);
    }
  }
  const aheadMatch = header.match(/\bahead (\d+)/);
  const behindMatch = header.match(/\bbehind (\d+)/);
  return {
    branch: branch.trim(),
    detached: false,
    unborn: false,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

function deriveFileState(x, y) {
  if (x === '?' && y === '?') return 'untracked';
  if (x === '!' && y === '!') return 'ignored';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflicted';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

// Parse the NUL-delimited `git status --porcelain=v1 -b -z` payload.
function parseStatus(stdout) {
  const records = String(stdout || '').split('\0');
  let branch = '';
  let detached = false;
  let unborn = false;
  let ahead = 0;
  let behind = 0;
  const files = [];
  const summary = { staged_count: 0, modified_count: 0, untracked_count: 0 };

  let i = 0;
  if (records.length && records[0].startsWith('## ')) {
    const parsed = parseBranchHeader(records[0].slice(3));
    ({ branch, detached, unborn, ahead, behind } = parsed);
    i = 1;
  }
  for (; i < records.length; i += 1) {
    const rec = records[i];
    if (!rec) continue;
    const x = rec[0] || ' ';
    const y = rec[1] || ' ';
    const path = rec.slice(3);
    let origPath = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      // rename/copy: the following NUL record is the original path
      origPath = records[i + 1] != null ? records[i + 1] : null;
      i += 1;
    }
    const untracked = x === '?' && y === '?';
    const ignored = x === '!' && y === '!';
    if (ignored) continue;
    if (untracked) {
      summary.untracked_count += 1;
    } else {
      if (x !== ' ' && x !== '?') summary.staged_count += 1;
      if (y !== ' ' && y !== '?') summary.modified_count += 1;
    }
    files.push({
      path,
      origPath,
      index: x,
      worktree: y,
      state: deriveFileState(x, y),
      staged: x !== ' ' && x !== '?' && x !== '!',
    });
  }
  return { branch, detached, unborn, ahead, behind, files, summary };
}

function parseLog(stdout) {
  const commits = [];
  for (const record of String(stdout || '').split('\0')) {
    if (!record.trim()) continue;
    const parts = record.split(US);
    if (parts.length < 7) continue;
    const [sha, shortSha, author, email, dateISO, parents] = parts;
    // Subject is the LAST field: a US byte inside a commit subject rejoins here
    // instead of shifting the parents field.
    const subject = parts.slice(6).join(US);
    const parentShas = String(parents || '').trim() ? parents.trim().split(/\s+/) : [];
    commits.push({
      sha: sha || '',
      shortSha: shortSha || '',
      author: author || '',
      email: email || '',
      dateISO: dateISO || '',
      subject,
      parentShas,
      isMerge: parentShas.length > 1,
    });
  }
  return commits;
}

// Parse the NUL-delimited `git log --name-only -z --pretty=format:%H` payload.
//
// Empirically observed shape (verified against this worktree's real history,
// see the comment on getChangedFilesByCommit for the command): splitting the
// raw stdout on '\0' yields records where:
//  - `--pretty=format:%H` prints ONLY the hash with no trailing newline of its
//    own, but git's `--name-only` machinery inserts a single LITERAL '\n'
//    between the pretty-format output and the following file list. Because
//    '-z' only NUL-terminates whole records (not that internal newline), the
//    first file (if any) plumbs through as `"<hash>\n<file1>"` — one token,
//    newline-joined, not NUL-joined.
//  - A commit with ZERO changed files (e.g. a no-diff merge commit) produces
//    a bare empty-string token: the hash's own record, then an immediate
//    empty token, then the next commit's `"<hash>\n<file>"` token (i.e. a
//    double-NUL with nothing between).
//  - The LAST commit in the range has no trailing separator: its hash (or
//    hash+files) is simply the final token with nothing after it.
// A token is treated as "starts a new commit" when its content up to the
// first '\n' (or the whole token, if no '\n') looks like a bare hex SHA;
// every other token is a changed-file path for the current commit.
const COMMIT_HASH_LINE_RE = /^[0-9a-f]{7,64}$/i;

function parseChangedFilesByCommit(stdout) {
  const commits = [];
  const tokens = String(stdout || '').split('\0');
  let current = null;

  for (const token of tokens) {
    const newlineIdx = token.indexOf('\n');
    const head = newlineIdx === -1 ? token : token.slice(0, newlineIdx);
    if (COMMIT_HASH_LINE_RE.test(head)) {
      // Starts a new commit. Anything after the newline in THIS token (if
      // any) is that commit's first changed file.
      current = { hash: head, files: [] };
      commits.push(current);
      if (newlineIdx !== -1) {
        const firstFile = token.slice(newlineIdx + 1);
        if (firstFile) current.files.push(firstFile);
      }
      continue;
    }
    // Not a hash line: a changed-file path for the current commit, unless
    // it's the empty-string sentinel from a zero-file commit's double-NUL,
    // or stray leading/trailing empties from the split — both are no-ops
    // since an empty token pushes nothing.
    if (current && token) {
      current.files.push(token);
    }
  }
  return commits;
}

function parseBlamePorcelain(stdout) {
  const lines = [];
  const meta = new Map();
  const rows = String(stdout || '').split('\n');
  let cur = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const headerMatch = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/.exec(row);
    if (headerMatch) {
      const sha = headerMatch[1];
      cur = { sha, finalLine: Number(headerMatch[3]), author: '', summary: '', authorTime: null };
      if (meta.has(sha)) {
        Object.assign(cur, meta.get(sha));
        cur.sha = sha;
        cur.finalLine = Number(headerMatch[3]);
      }
      continue;
    }
    if (!cur) continue;
    if (row.startsWith('author ')) {
      cur.author = row.slice(7);
    } else if (row.startsWith('author-time ')) {
      cur.authorTime = Number(row.slice(12));
    } else if (row.startsWith('summary ')) {
      cur.summary = row.slice(8);
    } else if (row.startsWith('\t')) {
      meta.set(cur.sha, { author: cur.author, summary: cur.summary, authorTime: cur.authorTime });
      lines.push({
        line: cur.finalLine,
        sha: cur.sha,
        shortSha: cur.sha.slice(0, 7),
        author: cur.author,
        dateISO: Number.isFinite(cur.authorTime) && cur.authorTime
          ? new Date(cur.authorTime * 1000).toISOString()
          : '',
        summary: cur.summary,
      });
      cur = null;
    }
  }
  return lines;
}

module.exports = {
  US,
  parseBranchHeader,
  deriveFileState,
  parseStatus,
  parseLog,
  parseChangedFilesByCommit,
  parseBlamePorcelain,
};
