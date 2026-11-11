'use strict';

/* services/workspace-git-neutralize.js - repository-config neutralization for
 * the Workspace Git panel's READ-ONLY git calls (row 103).
 *
 * Reference: sidecar/ai/tools/builtins/git_process.py
 * (`neutralizing_config_arguments`, the configured-key discovery and its
 * stat-keyed cache). A repository's own config can name programs git runs on a
 * plain read: clean/smudge/process filters on `status`/`diff`, diff
 * `textconv`/`command` drivers on `diff`/`show`, `core.fsmonitor`, and so on.
 * Every read first lists the configured key NAMES and overrides each executable
 * one with a command-scoped `-c key=`; a listing that cannot be verified refuses
 * the read. As in the sidecar's git_ops, `diff` and `show` also get
 * `--no-ext-diff --no-textconv` (an emptied `diff.external` or driver would
 * otherwise be spawned as ""), `blame` gets `--no-textconv`, and `status` and
 * `diff` get `--ignore-submodules=dirty`, because the parent's overrides cannot
 * name a filter only a submodule's config defines.
 *
 * User-initiated writes (stage, commit, restore, checkout, stash, conflict
 * resolution) never come through here: they run the repository's filters, as
 * in any editor (neutralizing `clean` on `git add` would store raw content in an
 * LFS repository). The one exception is the row 106 sandbox restore point
 * (workspace-git-sandbox-checkpoint), which runs EVERY verb, its checkpoint
 * writes included, through this wrapper with `ignoreSubmodules: 'all'`: no
 * repository program runs on the host for a sandboxed command's restore point.
 */

const fsPromises = require('fs/promises');
const nodePath = require('path');

const { t } = require('./i18n-main');
const { CHECKPOINT_WRITE_VERBS } = require('./workspace-git-checkpoint');

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

// The sidecar's fixed set, minus `core.quotePath=false`: that one is an output
// preference there, and the panel's parsers expect git's default quoting.
const ALWAYS_NEUTRAL_CONFIG = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', NULL_DEVICE],
  ['diff.external', ''],
  ['core.sshCommand', ''],
  ['core.askPass', ''],
  ['credential.helper', ''],
  ['core.pager', 'cat'],
  ['log.showSignature', 'false'],
]);
const EXECUTABLE_CONFIG_KEY = /^(?:filter\..+\.(?:clean|smudge|process|required)|diff\..+\.(?:command|textconv)|credential\..+\.helper)$/is;
// `-c` splits at the first "=", so a key whose name contains one cannot be
// overridden on the command line; such a config refuses the read instead.
const MAX_DYNAMIC_KEYS = 256;
const DISCOVERY_ARGS = Object.freeze(['config', '--list', '-z', '--name-only']);
const READ_FLAGS_BY_VERB = new Map([
  ['status', ['--ignore-submodules=dirty']],
  ['diff', ['--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty']],
  ['show', ['--no-ext-diff', '--no-textconv']],
  ['blame', ['--no-textconv']],
]);
// `ignoreSubmodules: 'all'`: submodules are never inspected, so no submodule
// config (whose filters the parent's overrides cannot name) is ever read.
const ALL_SUBMODULES_READ_FLAGS = new Map([...READ_FLAGS_BY_VERB].map(([verb, flags]) => [
  verb, flags.map((flag) => (flag === '--ignore-submodules=dirty' ? '--ignore-submodules=all' : flag)),
]));
const ALL_SUBMODULES_CONFIG = Object.freeze(['-c', 'diff.ignoreSubmodules=all', '-c', 'submodule.recurse=false']);

const CONFIG_KEYS_TTL_MS = 30_000;
const CONFIG_KEYS_CACHE_LIMIT = 64;
const GIT_POINTER_MAX_BYTES = 8 * 1024;

function neutralizingConfigArguments(configuredKeys) {
  const dynamicKeys = [...new Set(
    [...configuredKeys].filter((key) => EXECUTABLE_CONFIG_KEY.test(String(key)))
  )].sort((a, b) => {
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    if (left !== right) return left < right ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const settings = [
    ...ALWAYS_NEUTRAL_CONFIG,
    ...dynamicKeys.map((key) => [key, /\.required$/i.test(key) ? 'false' : '']),
  ];
  return settings.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}

// Null when the listing proves the read can be neutralized, else the reason.
function unneutralizableReason(keys) {
  const dynamic = keys.filter((key) => EXECUTABLE_CONFIG_KEY.test(key));
  if (dynamic.length > MAX_DYNAMIC_KEYS) return 'too_many_executable_keys';
  if (dynamic.some((key) => key.includes('='))) return 'unoverridable_key';
  return null;
}

function withReadFlags(args, flagsByVerb = READ_FLAGS_BY_VERB) {
  const flags = (flagsByVerb.get(args[0]) || []).filter((flag) => (
    !args.some((arg) => String(arg).split('=')[0] === flag.split('=')[0])
  ));
  return flags.length ? [args[0], ...flags, ...args.slice(1)] : args;
}

async function readPointer(fs, file) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(GIT_POINTER_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > GIT_POINTER_MAX_BYTES) throw new Error('git pointer file is too large');
    return buffer.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await handle.close();
  }
}

// The checkout's own git dir and the common dir that holds its `config`.
async function gitDirs(fs, path, root) {
  const entry = path.join(root, '.git');
  if ((await fs.stat(entry)).isDirectory()) return [entry, entry];
  const pointer = await readPointer(fs, entry);
  if (!/^gitdir:/i.test(pointer)) throw new Error('unsupported .git file');
  const raw = pointer.slice('gitdir:'.length).trim();
  const gitDir = path.isAbsolute(raw) ? raw : path.join(root, raw);
  let common;
  try {
    common = await readPointer(fs, path.join(gitDir, 'commondir'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [gitDir, gitDir];
    throw error;
  }
  return [gitDir, path.isAbsolute(common) ? common : path.join(gitDir, common)];
}

async function statIdentity(fs, file) {
  try {
    const stat = await fs.stat(file, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// Stat identity of every config file a repository-controlled edit could touch
// (repo, worktree and global config), or null when it cannot be established.
async function configCacheKey({ fs, path, env }, root) {
  try {
    const [gitDir, commonDir] = await gitDirs(fs, path, root);
    // A `.git` pointer file (a worktree) is keyed by its stat; a `.git` directory is not: git touches its mtime on
    // every status (index.lock), which would miss the cache on every read.
    const dotGit = path.join(root, '.git');
    const files = [...(gitDir === dotGit ? [] : [dotGit]), path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree')];
    for (const homeKey of ['HOME', 'USERPROFILE']) {
      const home = env[homeKey];
      if (home) files.push(path.join(home, '.gitconfig'), path.join(home, '.config', 'git', 'config'));
    }
    const stats = await Promise.all(files.map(async (file) => [file, await statIdentity(fs, file)]));
    const normalizedRoot = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
    return JSON.stringify([normalizedRoot, stats]);
  } catch (_error) {
    return null;
  }
}

/**
 * Wrap a workspace git executor `(cwd, args, options) => result` so every call
 * runs neutralized. Use the wrapped function for reads only; writes keep the
 * unwrapped executor (except the sandbox restore point, see the header).
 * `ignoreSubmodules: 'all'` also skips submodules entirely.
 */
function createReadOnlyGitExec(exec, {
  fs = fsPromises,
  path = nodePath,
  env = process.env,
  now = () => Date.now(),
  ignoreSubmodules = 'dirty',
} = {}) {
  if (typeof exec !== 'function') throw new TypeError('Workspace Git executor must be a function.');
  const cache = new Map();
  const allSubmodules = ignoreSubmodules === 'all';
  const flagsByVerb = allSubmodules ? ALL_SUBMODULES_READ_FLAGS : READ_FLAGS_BY_VERB;

  function cached(key) {
    if (key === null) return null;
    const entry = cache.get(key);
    if (!entry) return null;
    if (now() - entry.at > CONFIG_KEYS_TTL_MS) {
      cache.delete(key);
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.keys;
  }

  function store(key, keys) {
    // An included file can change without touching any stat-keyed file.
    if (key === null || keys.some((name) => /^include(?:if)?\./i.test(name))) return;
    cache.set(key, { at: now(), keys });
    while (cache.size > CONFIG_KEYS_CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  async function configuredKeys(root, signal) {
    const key = await configCacheKey({ fs, path, env }, root);
    const hit = cached(key);
    if (hit) return { keys: hit };
    const listed = await exec(root, [...DISCOVERY_ARGS], { signal });
    if (!listed?.success || listed.truncated === true || typeof listed.stdout !== 'string') {
      return { refused: true, listed };
    }
    const keys = listed.stdout.split('\0').filter(Boolean);
    if (unneutralizableReason(keys)) return { refused: true, listed };
    store(key, keys);
    return { keys };
  }

  return async function readOnlyGit(root, args, options = {}) {
    const discovered = await configuredKeys(root, options?.signal || null);
    if (discovered.refused) {
      const listed = discovered.listed || {};
      return {
        success: false,
        // A timed-out or aborted listing keeps its reason; a listing that ran
        // but cannot be neutralized is a plain failure.
        reason: listed.success === false && listed.reason ? listed.reason : 'git_failed',
        stdout: '',
        stderr: '',
        message: t('main.workspaceGit.configUnverified', "The repository's Git configuration could not be verified, so the read-only command was not run."),
        cleanupConfirmed: listed.cleanupConfirmed === true,
      };
    }
    const overrides = [
      ...neutralizingConfigArguments(discovered.keys),
      ...(allSubmodules ? ALL_SUBMODULES_CONFIG : []),
    ];
    const result = await exec(root, [...overrides, ...withReadFlags(args, flagsByVerb)], options);
    if (result?.success !== false || typeof result.message !== 'string') return result;
    // A spawn failure message echoes the argv ("Command failed: git ..."); keep
    // it as callers (and the user) saw it before the overrides.
    return { ...result, message: result.message.split(`git ${overrides.join(' ')} `).join('git ') };
  };
}

// Checkpoint transactions share one executor for reads and writes; their writes
// (CHECKPOINT_WRITE_VERBS, after the `-c user.*` identity prefix) keep the
// repository's filters like any other write, so restored content matches what
// `git add` would have stored.

function checkpointVerb(args) {
  let index = 0;
  while (args[index] === '-c') index += 2;
  return args[index];
}

function createCheckpointGitExec({ read, write }) {
  return (root, args, options) => (CHECKPOINT_WRITE_VERBS.has(checkpointVerb(args)) ? write : read)(root, args, options);
}

module.exports = {
  ALWAYS_NEUTRAL_CONFIG,
  CONFIG_KEYS_TTL_MS,
  DISCOVERY_ARGS,
  READ_FLAGS_BY_VERB,
  createCheckpointGitExec,
  createReadOnlyGitExec,
  neutralizingConfigArguments,
};
