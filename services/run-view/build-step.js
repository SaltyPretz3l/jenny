'use strict';

/*
 * build-step.js — the build process of a live run (row 197, "The run").
 *
 * The command's build step runs through the shell in the run's working folder.
 * Its output is never kept whole: only the last BUILD_TAIL_CHARS characters of
 * stdout and stderr together, which is what the panel shows when the build
 * fails. A build that outlives its timeout is ended with its whole process
 * tree.
 *
 * This file also holds what a run and its build share: the environment block
 * and the containment check on the program and the working folder.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isChildPath, resolveRealPathSafe } = require('../backend/path-utils');
const { unanchoredOnWindows } = require('./run-command-store');

const BUILD_TAIL_CHARS = 8_000;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const STRIPPED_ENV_PREFIXES = Object.freeze(['JENNY_', 'ELECTRON_']);
const EXIT_GRACE_MS = 3_000; // after the build process exits, how long its output may still arrive

// The app's environment without its own control variables, then the command's pairs. On Windows names
// ignore case, so a command's PATH replaces the app's Path instead of sitting beside it.
function buildEnvBlock(baseEnv, commandEnv, platform = process.platform) {
  const block = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    const upper = key.toUpperCase();
    if (typeof value !== 'string' || STRIPPED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    block[key] = value;
  }
  for (const [key, value] of Object.entries(commandEnv || {})) {
    if (platform === 'win32') {
      for (const existing of Object.keys(block)) if (existing.toUpperCase() === key.toUpperCase()) delete block[existing];
    }
    block[key] = value;
  }
  return block;
}

// Ends a process and everything it started. On Windows taskkill runs in the background (the main process never
// waits for it); a taskkill that cannot start is ignored, like a process that is already gone.
function killTreeDetached(pid, {
  platform = process.platform, spawn = childProcess.spawn, kill = (target) => process.kill(target), env = process.env,
} = {}) {
  if (platform !== 'win32') {
    kill(-pid);
    return;
  }
  const taskkill = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  const child = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

function defaultKillTree(pid) {
  killTreeDetached(pid);
}

function safeKill(killTree, pid) {
  if (!Number.isInteger(pid)) return;
  try { killTree(pid); } catch { /* the process may already be gone */ }
}

/*
 * Starts the build and returns { cancel, done }. `done` resolves once, with
 * { exitCode, tail, cancelled, timedOut }; it never rejects.
 */
function startBuild({
  command, cwd, env, spawnBuild = childProcess.spawn, killTree = defaultKillTree,
  setTimeout: setTimer = setTimeout, clearTimeout: clearTimer = clearTimeout,
  timeoutMs = BUILD_TIMEOUT_MS,
}) {
  let tail = '';
  let cancelled = false;
  let timedOut = false;
  let child = null;
  let timer = null;
  let grace = null;
  const addTail = (chunk) => { tail = (tail + String(chunk)).slice(-BUILD_TAIL_CHARS); };

  const done = new Promise((resolve) => {
    let finished = false;
    const finish = (exitCode) => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimer(timer);
      if (grace !== null) clearTimer(grace);
      resolve({ exitCode, tail, cancelled, timedOut });
    };
    try {
      child = spawnBuild(command, {
        shell: true, cwd, env, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      addTail(`could not start the build: ${error?.message || 'unknown error'}`);
      finish(null);
      return;
    }
    child.stdout?.on('data', addTail);
    child.stderr?.on('data', addTail);
    child.on('error', (error) => { addTail(`\n${error?.message || 'build error'}`); finish(null); });
    child.on('close', (code) => finish(Number.isInteger(code) ? code : null));
    // A process the build left behind can hold its output open forever: the exit, plus a short grace, ends it.
    child.on('exit', (code) => {
      if (grace === null) grace = setTimer(() => finish(Number.isInteger(code) ? code : null), EXIT_GRACE_MS);
    });
    timer = setTimer(() => {
      timedOut = true;
      addTail('\n[the build was stopped after 10 minutes]');
      safeKill(killTree, child.pid);
    }, timeoutMs);
  });

  function cancel() {
    cancelled = true;
    safeKill(killTree, child?.pid);
  }

  return { cancel, done };
}

function isFile(target) {
  try { return fs.statSync(target).isFile(); } catch { return false; }
}

// The root itself is an allowed folder; isChildPath alone says no to it.
function cwdInsideRoot(root, cwd) {
  return resolveRealPathSafe(cwd) === resolveRealPathSafe(root) || isChildPath(root, cwd);
}

// { launch: { program, cwd } } or { reason }.
function resolveLaunch(command, rootPath, { requireProgram, platform = process.platform }) {
  if (unanchoredOnWindows(command.program, platform)) return { reason: 'program_not_anchored' };
  const relative = !path.isAbsolute(command.program);
  const program = relative ? path.resolve(rootPath, command.program) : command.program;
  const cwd = path.resolve(rootPath, command.cwd || '.');
  if (relative && !isChildPath(rootPath, program)) return { reason: 'program_outside_root' };
  if (!cwdInsideRoot(rootPath, cwd)) return { reason: 'cwd_outside_root' };
  if (requireProgram && !isFile(program)) return { reason: 'program_missing' };
  return { launch: { program, cwd } };
}

module.exports = {
  BUILD_TAIL_CHARS,
  BUILD_TIMEOUT_MS,
  buildEnvBlock,
  killTreeDetached,
  resolveLaunch,
  startBuild,
};
