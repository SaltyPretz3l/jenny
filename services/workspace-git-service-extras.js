/* services/workspace-git-service-extras.js - row 82 G1/G2 verbs for the Workspace
 * IDE Source Control (docs/plans/IDE_VSCODE_PARITY_2026-10-26.md 5.8), split out of
 * workspace-git-service.js at its file-size ceiling. Every method runs through the
 * owning service's envelopes: reads through `_withRepo` (flag, root, toplevel and
 * resource admission), writes through the single `_runWrite` chokepoint (serialized
 * mutation lease, path containment, the WRITE_VERBS guard). Nothing here spawns git
 * on its own, and nothing here talks to a remote (G3 is held on owner pick O6).
 *
 * Reads: getFileAtIndex (`show :./<path>`), getFileAtCommit (`show <sha>[^]:./<path>`),
 * getCommitFiles (`diff-tree -r --name-status -z`), listStashes, getLastCommitMessage,
 * blameFile (`blame -L 1,20000 --porcelain HEAD`, the cleanup wave's G2).
 * Writes: commit (`--amend` / `-s` options), stash (push / pop / apply / drop, an
 * optional entry index), deleteBranch (`branch -d` only, never `-D`), applyPatch
 * (`apply --cached` of ONE validated single-file text patch; no --3way, no binary,
 * no rename, no create/delete), discardFiles (G3: chunked `restore --worktree` from
 * literal stdin pathspecs plus untracked files to the recycle bin, one lease). */

'use strict';

const { WORKSPACE_GIT_ERROR_CODES, workspaceGitError } = require('./workspace-git-errors');
const {
  MAX_COMMIT_MESSAGE_CHARS, MAX_STASH_MESSAGE_CHARS, buildPathspecCommand, literalPathspec,
} = require('./workspace-git-executor');
const { branchNameIsSafe } = require('./worktree-service');
const { US, parseBlamePorcelain } = require('./workspace-git-parsers');
const { normalizePathList } = require('./workspace-git-operation-context');

const HASH_RE = /^[0-9a-f]{7,64}$/i;
const MAX_STASH_INDEX = 999;
const MAX_STASH_LIST = 100;
const MAX_COMMIT_FILES = 1000;
const MAX_PATCH_BYTES = 1024 * 1024;
const STASH_OPS = new Set(['push', 'pop', 'apply', 'drop']);
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const APPLY_OPTION_KEYS = new Set(['patch', 'cached', 'signal']);
// G2: the editor's large-file cut is 20,000 lines, so one blame covers every file
// inline blame runs on; porcelain output stays inside the executor's 8 MiB buffer.
const MAX_BLAME_FILE_LINES = 20000;
// G3: restore paths per spawn, ls-files argv characters per spawn (Windows caps a
// command line at 32,767), and the whole-batch path cap (buildPathspecCommand's).
const DISCARD_RESTORE_CHUNK = 2000;
const LS_FILES_ARGV_CHARS = 24000;
const MAX_DISCARD_PATHS = 10000;

function ok(op, fields) {
  return { ok: true, available: true, isRepo: true, op, ...fields };
}

function patchError(message, reason) {
  return workspaceGitError(WORKSPACE_GIT_ERROR_CODES.PATCH_INVALID, message, { reason });
}

function assertHash(value) {
  const rev = String(value == null ? '' : value).trim();
  if (!HASH_RE.test(rev)) {
    throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.REF_INVALID, 'Invalid commit hash.', { hash: rev.slice(0, 80) });
  }
  return rev;
}

function stashIndexOf(value) {
  if (value == null) return null;
  const index = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(index) || index < 0 || index > MAX_STASH_INDEX) {
    throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.REF_INVALID, 'Invalid stash entry.', { index: String(value).slice(0, 40) });
  }
  return index;
}

function textOf(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}\n${result?.message || ''}`.slice(0, 16_000);
}

// `diff --git a/P b/P`, `--- a/P`, `+++ b/P`: the path after the prefix, unquoted only
// (git C-quotes names with special characters; those patches are refused).
// git cuts a header name at a tab (and never wants other control characters), so the
// validated name could differ from the file git patches: such headers are refused.
function assertNoControlChars(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) throw patchError('Patch paths may not contain control characters.', 'control_char');
  }
}

function headerPath(line, marker, prefix) {
  const rest = line.slice(marker.length);
  assertNoControlChars(rest);
  if (rest.startsWith('"')) throw patchError('Quoted patch paths are not supported.', 'quoted_path');
  if (rest === '/dev/null') throw patchError('A patch may not create or delete a file.', 'create_or_delete');
  if (!rest.startsWith(prefix) || rest.length === prefix.length) throw patchError('The patch header has an unexpected path.', 'bad_path');
  return rest.slice(prefix.length);
}

// The renderer builds one single-file text patch from a gutter hunk; the service only
// ever forwards a patch that has exactly this shape. Count-driven hunk parsing, so a
// removed line that happens to read "--- x" can never pass as a second file header.
function validateSingleFilePatch(input) {
  const patch = typeof input === 'string' ? input : '';
  if (!patch) throw patchError('The patch is empty.', 'empty');
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) throw patchError('The patch is too large.', 'too_large');
  if (patch.includes('\0')) throw patchError('The patch must not contain NUL bytes.', 'nul');
  if (/^(GIT binary patch|Binary files )/m.test(patch)) throw patchError('Binary patches are not supported.', 'binary');
  if (/^(rename|copy) (from|to) |^similarity index /m.test(patch)) throw patchError('Rename and copy patches are not supported.', 'rename');
  const lines = patch.endsWith('\n') ? patch.slice(0, -1).split('\n') : patch.split('\n');
  let i = 0;
  let gitPath = null;
  if (lines[i].startsWith('diff --git ')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[i]);
    assertNoControlChars(lines[i]);
    if (!match || match[1] !== match[2]) throw patchError('A patch may touch one file under the same name.', 'rename');
    gitPath = match[1];
    i += 1;
    if (i < lines.length && /^index [0-9a-f]+\.\.[0-9a-f]+( [0-7]{6})?$/.test(lines[i])) i += 1;
  }
  if (!lines[i] || !lines[i].startsWith('--- ') || !lines[i + 1] || !lines[i + 1].startsWith('+++ ')) {
    throw patchError('The patch header is not a single-file text diff (mode changes are not supported).', 'bad_header');
  }
  const oldPath = headerPath(lines[i], '--- ', 'a/');
  const newPath = headerPath(lines[i + 1], '+++ ', 'b/');
  if (oldPath !== newPath || (gitPath !== null && gitPath !== newPath)) {
    throw patchError('A patch may touch one file under the same name (no renames).', 'rename');
  }
  i += 2;
  let hunks = 0;
  while (i < lines.length) {
    const header = HUNK_HEADER_RE.exec(lines[i]);
    if (!header) {
      if (/^(--- |\+\+\+ |diff )/.test(lines[i])) throw patchError('A patch may touch only one file.', 'multi_file');
      throw patchError('The patch has an unexpected line outside a hunk.', 'unexpected_line');
    }
    let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    let newLeft = header[4] === undefined ? 1 : Number(header[4]);
    hunks += 1;
    i += 1;
    while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i].startsWith('\\'))) {
      const prefix = lines[i].charAt(0);
      if (prefix === ' ') { oldLeft -= 1; newLeft -= 1; }
      else if (prefix === '-') oldLeft -= 1;
      else if (prefix === '+') newLeft -= 1;
      else if (prefix !== '\\') throw patchError('The patch has an unexpected line inside a hunk.', 'unexpected_line');
      if (oldLeft < 0 || newLeft < 0) throw patchError('A patch hunk is longer than its header says.', 'bad_hunk');
      i += 1;
    }
    if (oldLeft !== 0 || newLeft !== 0) throw patchError('A patch hunk is shorter than its header says.', 'bad_hunk');
  }
  if (!hunks) throw patchError('The patch has no hunk.', 'no_hunk');
  return { path: newPath, hunks };
}

// A HEAD read that missed for a known reason (no commit yet, path not in HEAD), or ''.
function classifyHeadPathMiss(result) {
  const text = String(result?.message || result?.stderr || '');
  if (/invalid object name ['"]?head|ambiguous argument ['"]?head|unknown revision|bad revision ['"]?head|no such ref:?\s*head|does not have any commits|bad default revision/i.test(text)) {
    return 'no_head';
  }
  if (/path .+ does not exist in ['"]?head|path .+ exists on disk, but not in ['"]?head|no such path .+ in head/i.test(text)) {
    return 'not_in_head';
  }
  return '';
}

const TRASH_REFUSALS = {
  directory_unsupported: 'Discard works on single files. Delete the folder from your file manager instead.',
  trash_unavailable: "Discard is unavailable in this shell mode — the OS recycle bin isn't reachable. Delete the file from your file manager instead.",
  trash_failed: "The file couldn't be moved to the recycle bin. Delete it from your file manager instead.",
};

// UIUX-032: an untracked path "discards" by moving to the OS recycle bin. A folder is
// refused (trashItem would take any tracked files inside with it); a trash error that
// still left the file gone is the desired end state. { ok: true } or { reason, message }.
async function trashUntracked({ fs, path, trashItemImpl, root, relPath }) {
  const absolute = path.resolve(root, relPath);
  const statOf = () => fs.stat(absolute).then((stat) => stat, (error) => ({ missing: error?.code === 'ENOENT' }));
  const refuse = (reason) => ({ reason, message: TRASH_REFUSALS[reason] });
  const target = await statOf();
  if (typeof target.isDirectory === 'function' && target.isDirectory()) return refuse('directory_unsupported');
  if (!trashItemImpl) return refuse('trash_unavailable');
  try {
    await trashItemImpl(absolute);
  } catch {
    if ((await statOf()).missing !== true) return refuse('trash_failed');
  }
  return { ok: true };
}

// Splits a list into argv-sized groups by total character count.
function argvChunks(values, maxChars) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const value of values) {
    if (current.length && size + value.length + 1 > maxChars) { chunks.push(current); current = []; size = 0; }
    current.push(value);
    size += value.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function classifyIndexMiss(result) {
  const text = textOf(result);
  if (/is in the index, but not at stage 0/i.test(text)) return 'unmerged';
  if (/ambiguous argument|unknown revision|does not exist|not in the index|exists on disk, but not in/i.test(text)) return 'not_in_index';
  return '';
}

function classifyCommitMiss(result, parent) {
  const text = textOf(result);
  if (parent && /invalid object name|unknown revision|bad revision/i.test(text)) return 'no_parent';
  if (/does not exist in|exists on disk, but not in/i.test(text)) return 'not_in_commit';
  return '';
}

function parseNameStatus(stdout) {
  const tokens = String(stdout || '').split('\0');
  const files = [];
  let truncated = false;
  for (let i = 0; i < tokens.length;) {
    const code = tokens[i];
    if (!code) { i += 1; continue; }
    const status = code.charAt(0);
    const paired = status === 'R' || status === 'C';
    const entry = paired
      ? { status, path: tokens[i + 2] || '', origPath: tokens[i + 1] || '' }
      : { status, path: tokens[i + 1] || '', origPath: '' };
    i += paired ? 3 : 2;
    if (!entry.path) continue;
    if (files.length >= MAX_COMMIT_FILES) { truncated = true; break; }
    files.push(entry);
  }
  return { files, truncated };
}

function parseStashList(stdout) {
  const stashes = [];
  for (const record of String(stdout || '').split('\0')) {
    const fields = record.replace(/^\n+/, '').split(US);
    const match = /^stash@\{(\d+)\}$/.exec(fields[0] || '');
    if (!match) continue;
    stashes.push({ index: Number(match[1]), ref: fields[0], sha: fields[1] || '', subject: fields[2] || '', dateISO: fields[3] || '' });
    if (stashes.length >= MAX_STASH_LIST) break;
  }
  return stashes;
}

function validateCommitMessage(msg) {
  if (!msg.trim()) {
    throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.COMMIT_MESSAGE_EMPTY, 'Commit message cannot be empty.');
  }
  if (msg.length > MAX_COMMIT_MESSAGE_CHARS) {
    throw workspaceGitError(
      WORKSPACE_GIT_ERROR_CODES.COMMIT_MESSAGE_EMPTY,
      `Commit message cannot exceed ${MAX_COMMIT_MESSAGE_CHARS} characters.`
    );
  }
}

// Binds the verbs to one WorkspaceGitService instance (its private envelopes are the
// only way in: this module owns argv shapes and result shapes, never the guards).
function createWorkspaceGitExtras(svc) {
  const exec = (root, args, signal) => svc._exec(root, args, { signal });

  async function showBlob(op, { root, signal, spec, relPath, classify }) {
    const r = await exec(root, ['show', spec], signal);
    if (r.success) return ok(op, { path: relPath, found: true, content: r.stdout });
    const reason = classify(r);
    return reason ? ok(op, { path: relPath, found: false, reason }) : svc._execFailure(op, r);
  }

  function getFileAtIndex({ path: relInput, signal = null } = {}) {
    return svc._withRepo('getFileAtIndex', async (root, operationSignal) => {
      const relPath = (await svc._resolveInsideRoot(relInput, root)).relPath;
      return showBlob('getFileAtIndex', { root, signal: operationSignal, spec: `:./${relPath}`, relPath, classify: classifyIndexMiss });
    }, { signal });
  }

  function getFileAtCommit({ hash, path: relInput, parent = false, signal = null } = {}) {
    return svc._withRepo('getFileAtCommit', async (root, operationSignal) => {
      const rev = assertHash(hash);
      const relPath = (await svc._resolveInsideRoot(relInput, root)).relPath;
      const wantParent = parent === true;
      const result = await showBlob('getFileAtCommit', {
        root, signal: operationSignal, spec: `${rev}${wantParent ? '^' : ''}:./${relPath}`, relPath,
        classify: (r) => classifyCommitMiss(r, wantParent),
      });
      return result.ok ? { ...result, hash: rev, parent: wantParent } : result;
    }, { signal });
  }

  function getCommitFiles({ hash, signal = null } = {}) {
    return svc._withRepo('getCommitFiles', async (root, operationSignal) => {
      const rev = assertHash(hash);
      const r = await exec(root, ['diff-tree', '--no-commit-id', '-r', '--root', '-M', '--name-status', '-z', rev, '--'], operationSignal);
      if (!r.success) return svc._execFailure('getCommitFiles', r);
      return ok('getCommitFiles', { hash: rev, ...parseNameStatus(r.stdout) });
    }, { signal });
  }

  function listStashes({ signal = null } = {}) {
    return svc._withRepo('listStashes', async (root, operationSignal) => {
      const r = await exec(root, ['stash', 'list', '-z', `--max-count=${MAX_STASH_LIST}`, `--format=%gd${US}%H${US}%gs${US}%cI`], operationSignal);
      if (!r.success) return svc._execFailure('listStashes', r);
      return ok('listStashes', { stashes: parseStashList(r.stdout) });
    }, { signal });
  }

  // G2: the whole file's blame at HEAD, mapped to buffer lines by the renderer.
  function blameFile({ path: relInput, signal = null } = {}) {
    return svc._withRepo('blameFile', async (root, operationSignal) => {
      const relPath = (await svc._resolveInsideRoot(relInput, root)).relPath;
      const r = await exec(root, ['blame', '-L', `1,${MAX_BLAME_FILE_LINES}`, '--porcelain', 'HEAD', '--', relPath], operationSignal);
      const fields = { path: relPath, maxLines: MAX_BLAME_FILE_LINES };
      if (r.success) return ok('blameFile', { ...fields, found: true, lines: parseBlamePorcelain(r.stdout) });
      // An empty file has no line 1 to start the range at.
      if (/has only 0 lines/i.test(textOf(r))) return ok('blameFile', { ...fields, found: true, lines: [] });
      const reason = classifyHeadPathMiss(r);
      return reason ? ok('blameFile', { ...fields, found: false, reason, lines: [] }) : svc._execFailure('blameFile', r);
    }, { signal });
  }

  function getLastCommitMessage({ signal = null } = {}) {
    return svc._withRepo('getLastCommitMessage', async (root, operationSignal) => {
      const r = await exec(root, ['log', '-1', '--no-color', '--format=%B'], operationSignal);
      if (!r.success) {
        if (/does not have any commits|bad default revision|unknown revision/i.test(textOf(r))) {
          return ok('getLastCommitMessage', { found: false, message: '' });
        }
        return svc._execFailure('getLastCommitMessage', r);
      }
      return ok('getLastCommitMessage', { found: true, message: String(r.stdout || '').replace(/\s+$/, '').slice(0, MAX_COMMIT_MESSAGE_CHARS) });
    }, { signal });
  }

  async function commit({ message, amend = false, signoff = false, signal = null } = {}) {
    const msg = String(message != null ? message : '');
    const flags = [...(amend === true ? ['--amend'] : []), ...(signoff === true ? ['-s'] : [])];
    const r = await svc._runWrite('commit', {
      validate: () => validateCommitMessage(msg),
      buildArgs: () => ['commit', ...flags, '-m', msg],
      signal,
    });
    if (!r.ok) {
      if (r.error_code === WORKSPACE_GIT_ERROR_CODES.GIT_COMMAND_FAILED && r.reason === 'nothing_to_commit') {
        return ok('commit', { committed: false, reason: 'nothing_to_commit' });
      }
      if (amend === true && /nothing to amend/i.test(String(r.message || ''))) return { ...r, reason: 'nothing_to_amend' };
      return r;
    }
    const match = /\[[^\]]*\s([0-9a-f]{7,40})\]/.exec(r.stdout || '');
    return ok('commit', { committed: true, amended: amend === true, shortSha: match ? match[1] : '' });
  }

  // `stashed` reads "the operation did something" for every op (the branch
  // switcher's success field); `operation` says which.
  async function stash({ op = 'push', message = '', index = null, signal = null } = {}) {
    const operation = STASH_OPS.has(op) ? op : 'push';
    const r = await svc._runWrite('stash', {
      validate: () => { if (operation !== 'push') stashIndexOf(index); },
      buildArgs: () => {
        if (operation !== 'push') {
          const entry = stashIndexOf(index);
          return entry === null ? ['stash', operation] : ['stash', operation, `stash@{${entry}}`];
        }
        const msg = String(message != null ? message : '').trim();
        if (msg.length > MAX_STASH_MESSAGE_CHARS) throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.COMMIT_MESSAGE_EMPTY, `Stash message cannot exceed ${MAX_STASH_MESSAGE_CHARS} characters.`);
        return msg ? ['stash', 'push', '-m', msg] : ['stash', 'push'];
      },
      signal,
    });
    if (!r.ok) {
      if (r.error_code === WORKSPACE_GIT_ERROR_CODES.GIT_COMMAND_FAILED
        && (r.reason === 'nothing_to_stash' || r.reason === 'nothing_to_pop')) {
        return ok('stash', { operation, stashed: false, reason: r.reason });
      }
      return r;
    }
    if (operation === 'push' && /no local changes to save/i.test(`${r.stdout || ''}${r.stderr || ''}`)) {
      return ok('stash', { operation, stashed: false, reason: 'nothing_to_stash' });
    }
    return ok('stash', { operation, stashed: true });
  }

  async function deleteBranch({ name, signal = null } = {}) {
    const branch = String(name != null ? name : '').trim();
    const r = await svc._runWrite('deleteBranch', {
      validate: () => {
        if (!branchNameIsSafe(branch)) {
          throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.REF_INVALID, 'Invalid branch or ref name.', { ref: branch.slice(0, 200) });
        }
      },
      // Safe delete only: `-d` refuses an unmerged branch; `-D` is never built.
      buildArgs: () => ['branch', '-d', '--', branch],
      signal,
    });
    if (!r.ok) {
      const text = String(r.message || '');
      if (/not fully merged/i.test(text)) return { ...r, reason: 'not_fully_merged', message: '' };
      if (/checked out at|cannot delete branch .* (used by|checked out)/i.test(text)) return { ...r, reason: 'branch_checked_out' };
      if (/not found/i.test(text)) return { ...r, reason: 'branch_not_found' };
      return r;
    }
    return ok('deleteBranch', { name: branch, deleted: true });
  }

  async function applyPatch(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    // Refused before the envelope runs so no option can widen the argv: index-only,
    // never --3way, nothing beyond { patch, cached }.
    if (opts.threeWay || Object.keys(opts).some((key) => !APPLY_OPTION_KEYS.has(key))) {
      if (!svc._gitEnabled()) return svc._unavailable('applyPatch', 'feature_disabled');
      throw patchError('Only the index can be patched here (no 3-way merge, no extra options).', 'option_refused');
    }
    let parsed = null;
    let parseError = null;
    try {
      parsed = validateSingleFilePatch(opts.patch);
    } catch (error) {
      parseError = error;
    }
    const r = await svc._runWrite('applyPatch', {
      validate: () => {
        if (opts.cached !== true) throw patchError('Patches apply to the index only (cached).', 'index_only');
        if (parseError) throw parseError;
      },
      validatePaths: parsed ? [parsed.path] : [],
      buildArgs: ({ safePaths }) => {
        if (!parsed || safePaths[0] !== parsed.path) {
          throw patchError('The patch target must be a workspace-relative path.', 'bad_path');
        }
        return { args: ['apply', '--cached', '--whitespace=nowarn', '-'], input: opts.patch };
      },
      signal: opts.signal || null,
    });
    if (!r.ok) {
      return /patch does not apply|while searching for|corrupt patch/i.test(String(r.message || ''))
        ? { ...r, reason: 'patch_does_not_apply' }
        : r;
    }
    return ok('applyPatch', { path: r.safePaths[0], applied: true });
  }

  // The index entries among `paths` (ls-files lists a directory's children, never the
  // directory itself, so a folder reads as untracked and is refused like discardFile does).
  async function trackedAmong(root, paths, signal) {
    const tracked = new Set();
    for (const chunk of argvChunks(paths.map(literalPathspec), LS_FILES_ARGV_CHARS)) {
      const r = await exec(root, ['ls-files', '-z', '--', ...chunk], signal);
      if (!r.success) return { failure: r };
      for (const name of String(r.stdout || '').split('\0')) if (name) tracked.add(name);
    }
    return { tracked };
  }

  // G3: Discard All in one mutation lease. Tracked paths are classified exactly as
  // discardFile does (ls-files) and restored by chunked `restore --worktree` from literal
  // stdin pathspecs; untracked ones go to the recycle bin with discardFile's refusals,
  // reported per path in `failed` rather than failing the batch. The recycle bin runs
  // last, so a failed restore (or a pathspec over the stdin cap) trashes nothing.
  async function discardFiles({ paths = [], signal = null } = {}) {
    const list = [...new Set(normalizePathList(paths))];
    if (!list.length) return svc._withRepo('discardFiles', () => ok('discardFiles', { tracked: [], untracked: [], failed: [] }), { signal });
    let outcome = null;
    const r = await svc._runWrite('discardFiles', {
      validate: () => {
        if (list.length > MAX_DISCARD_PATHS) throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.PATH_INVALID, 'Too many paths were selected for one Git operation.');
      },
      validatePaths: list,
      buildArgs: async ({ root, safePaths, signal: opSignal }) => {
        const unique = [...new Set(safePaths)];
        const probe = await trackedAmong(root, unique, opSignal);
        if (probe.failure) return { skipExec: true, result: svc._execFailure('discardFiles', probe.failure) };
        outcome = { tracked: unique.filter((rel) => probe.tracked.has(rel)), untracked: [], failed: [] };
        const commands = [];
        for (let i = 0; i < outcome.tracked.length; i += DISCARD_RESTORE_CHUNK) {
          commands.push(buildPathspecCommand(['restore', '--worktree'], outcome.tracked.slice(i, i + DISCARD_RESTORE_CHUNK)));
        }
        const finish = async () => {
          for (const relPath of unique.filter((rel) => !probe.tracked.has(rel))) {
            if (opSignal && opSignal.aborted) break;
            const trashed = await trashUntracked({ fs: svc._fs, path: svc._path, trashItemImpl: svc._trashItemImpl, root, relPath });
            if (trashed.ok) outcome.untracked.push(relPath);
            else outcome.failed.push({ path: relPath, reason: trashed.reason, message: trashed.message });
          }
        };
        return { commands, finish };
      },
      signal,
    });
    return r.ok ? ok('discardFiles', outcome) : r;
  }

  return {
    getFileAtIndex,
    getFileAtCommit,
    getCommitFiles,
    listStashes,
    getLastCommitMessage,
    blameFile,
    commit,
    stash,
    deleteBranch,
    applyPatch,
    discardFiles,
  };
}

module.exports = {
  createWorkspaceGitExtras,
  classifyHeadPathMiss,
  trashUntracked,
  validateSingleFilePatch,
  parseNameStatus,
  parseStashList,
};
