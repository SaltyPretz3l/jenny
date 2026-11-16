'use strict';

// Shared pieces of the member's project file transfers (row 123 slice 3-9, commit 3; TEAM_PROJECTS_SPEC "Upload and
// download"): the connection a part rides (the team manager's live link, borrowed as the team engine borrows it), the
// host's path and collision rules, a throttled progress push, and the wait for a reconnect. Nothing here logs a path.

const {
  isSensitiveSegment, sensitiveSegment, validateRelativePath, validateSegment,
} = require('../../server/team/path-segments');
const { TRANSFER_LIMITS, foldKey } = require('../../server/team/transfer-manifest');
const { failureAnswer } = require('./team-errors');

// The host's caps (server/team/project-files.js FILE_LIMITS, server/team/transfer-manifest.js TRANSFER_LIMITS).
const LIMITS = Object.freeze({
  beginFiles: 2_000, maxFileBytes: TRANSFER_LIMITS.maxFileBytes, maxUploadBytes: TRANSFER_LIMITS.maxUploadBytes,
  maxPartBytes: TRANSFER_LIMITS.maxPartBytes, projectFiles: 10_000,
  // A walk stops counting after this many entries (a folder this large is refused as too many files).
  walkEntries: 200_000,
  // At most two parts of one upload in flight (the host takes four per member across both routes).
  partsInFlight: 2,
  // A transfer that loses its link this many times in a row without moving a byte ends.
  stalledResumes: 3,
  progressMs: 500,
});
const SHA256 = /^[0-9a-f]{64}$/u;
const HOST_ID = /^[A-Za-z0-9_-]{1,128}$/u;

class TransferEnd extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

// A part or command that got no answer (no link, a reset, a timeout): the transfer waits for the team to come back.
class LinkDropped extends Error {}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

// A host refusal's reason as the renderer and the log may carry it (fix 3): the closed reason pattern, else a fixed word.
const failureReason = (answer) => failureAnswer(answer).error.reason;

/** The team's live link with a registered client, or null while the team is not online. */
async function liveLink(manager) {
  let state;
  try { state = manager.borrow(); } catch { return null; }
  if (!state?.online || !state.link) return null;
  const blocked = await state.ensureClient(state.link);
  return blocked || !state.link.client ? null : state.link;
}

/** One part call on the live link: the host's answer, LinkDropped when there was none, `aborted` once `signal` is. */
async function partCall(manager, run, signal = null) {
  const link = await liveLink(manager);
  if (signal?.aborted) throw new TransferEnd('aborted');
  if (!link) throw new LinkDropped();
  try {
    return await run(link.session, link.client);
  } catch {
    if (signal?.aborted) throw new TransferEnd('aborted');
    throw new LinkDropped();
  }
}

/** One command; LinkDropped when it got no answer (the manager throws a TeamError then, or answers not connected). */
async function commandCall(manager, operation, params) {
  let answer;
  try { answer = await manager.command(operation, params); } catch { throw new LinkDropped(); }
  if (answer?.ok !== true && ['team_not_connected', 'team_connection_stopped'].includes(answer?.error?.reason)) {
    throw new LinkDropped();
  }
  return answer;
}

// The host's own path rules for one relative path ('/'-separated), and its fold collision rule across a list.
const pathAllowed = (relative) => validateRelativePath(relative).ok === true;
const folderNameAllowed = (name) => validateSegment(name).ok === true;
// E69: the host's sensitive-name list (.git, .github, .vscode, .env, .jenny, case folded). `sensitiveName` answers
// the first such segment of a relative path, as spelled, or null; an upload is refused and a download skips it.
const sensitiveName = sensitiveSegment;
const sensitiveFolder = isSensitiveSegment;

// The host's fold rule, one path at a time: `add` answers false (and keeps nothing) when the path would land on a
// name already taken, as a file or as a folder spelled another way.
function createCollisionSet() {
  const files = new Set();
  const directories = new Map();
  return {
    add(relative) {
      const key = foldKey(relative);
      if (files.has(key) || directories.has(key)) return false;
      const segments = relative.split('/');
      const fresh = [];
      for (let depth = 1; depth < segments.length; depth += 1) {
        const spelled = segments.slice(0, depth).join('/');
        const folded = foldKey(spelled);
        if (files.has(folded)) return false;
        const seen = directories.get(folded);
        if (seen !== undefined && seen !== spelled) return false;
        if (seen === undefined) fresh.push([folded, spelled]);
      }
      files.add(key);
      for (const [folded, spelled] of fresh) directories.set(folded, spelled);
      return true;
    },
  };
}

function hasCollision(paths) {
  const set = createCollisionSet();
  return paths.some((relative) => !set.add(relative));
}

/** A progress pusher: at most one push per `LIMITS.progressMs` unless forced (every state change is forced). */
function progressPusher(push, clock, base) {
  let last = -Infinity;
  return (fields, force = false) => {
    const now = clock();
    if (!force && now - last < LIMITS.progressMs) return;
    last = now;
    try { push({ kind: 'transfer', ...base, ...fields }); } catch { /* the push is best effort */ }
  };
}

/** Waiters for the team's next reconnect (team-projects.js calls `reconnected`), each ended by its signal. */
function createReconnectWaiters() {
  const waiters = new Set();
  return {
    wait(signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new TransferEnd('aborted')); return; }
        const entry = { resolve: () => { cleanup(); resolve(); } };
        const onAbort = () => { cleanup(); reject(new TransferEnd('aborted')); };
        function cleanup() { waiters.delete(entry); signal.removeEventListener('abort', onAbort); }
        waiters.add(entry);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    reconnected() { for (const entry of [...waiters]) entry.resolve(); },
    size: () => waiters.size,
  };
}

module.exports = {
  HOST_ID, LIMITS, LinkDropped, SHA256, TransferEnd, commandCall, createCollisionSet, createReconnectWaiters, failureReason,
  folderNameAllowed, hasCollision, isCount, liveLink, partCall, pathAllowed, progressPusher, sensitiveFolder, sensitiveName,
};
