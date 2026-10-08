'use strict';

// A project's `.jenny` folder holds Jenny's private local state (artifacts,
// backups, scheduled tasks, recovery receipts). Like `.venv` or
// `.pytest_cache`, it ignores itself for Git: whenever Jenny creates or writes
// into it, `.jenny/.gitignore` = `*` is dropped so the folder never shows as
// untracked in Source Control and cannot be committed by accident.
//
// Contract (kept in sync with sidecar/ai/tools/jenny_state_dir.py):
//  - only a directory literally named `.jenny` is touched, never the profile;
//  - an existing `.jenny/.gitignore` is never overwritten (exclusive create,
//    which also refuses to follow a link planted at that name);
//  - a `.jenny` that is a link/junction or not a directory is left alone;
//  - best-effort: any failure is swallowed so the caller's operation proceeds.
// Callers pass the `.jenny` path they already built behind their own
// workspace-root containment checks; this module adds no other path inputs.

const fsDefault = require('fs');
const path = require('path');

const JENNY_STATE_DIR_NAME = '.jenny';
const JENNY_GITIGNORE_NAME = '.gitignore';
const JENNY_GITIGNORE_CONTENT = "# Created by Jenny: this folder holds Jenny's local state.\n*\n";

function isJennyStateDirPath(jennyDir) {
  return typeof jennyDir === 'string' && jennyDir !== ''
    && path.basename(jennyDir) === JENNY_STATE_DIR_NAME;
}

function isPlainDirectory(stat) {
  return !!stat && stat.isDirectory() && !stat.isSymbolicLink();
}

async function ensureJennyDirGitignore(jennyDir, { fs = fsDefault.promises } = {}) {
  if (!isJennyStateDirPath(jennyDir)) return false;
  try {
    if (!isPlainDirectory(await fs.lstat(jennyDir))) return false;
    await fs.writeFile(path.join(jennyDir, JENNY_GITIGNORE_NAME), JENNY_GITIGNORE_CONTENT, { flag: 'wx' });
    return true;
  } catch (_error) {
    return false;
  }
}

function ensureJennyDirGitignoreSync(jennyDir, { fs = fsDefault } = {}) {
  if (!isJennyStateDirPath(jennyDir)) return false;
  try {
    if (!isPlainDirectory(fs.lstatSync(jennyDir))) return false;
    fs.writeFileSync(path.join(jennyDir, JENNY_GITIGNORE_NAME), JENNY_GITIGNORE_CONTENT, { flag: 'wx' });
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  JENNY_GITIGNORE_CONTENT,
  JENNY_STATE_DIR_NAME,
  ensureJennyDirGitignore,
  ensureJennyDirGitignoreSync,
};
