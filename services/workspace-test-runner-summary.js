'use strict';
// Pure, ReDoS-guarded parse of a test run's stdout tail into advisory
// { passedCount, failedCount } for the Workspace IDE Test Runner (S17). The run
// STATUS is always authoritative from the exit code; these counts only enrich the
// trend widget and are OMITTED on any miss/malformation. This module NEVER throws.
//
// Threat model: the command and summaryRegex are user-authored LOCALLY (per spec
// gate A2 — not pulled from a repo), so this is NOT a trust boundary. It is still
// defense-in-depth because the parse runs SYNCHRONOUSLY on the Electron main
// process, where a runaway regex would freeze the whole UI (worse than the runner's
// own child process, which is timeout- and abort-bounded).
//
// Guards:
//   (a) the scanned input is tail-sliced to MAX_INPUT_TAIL chars;
//   (b) a regex source longer than MAX_REGEX_SOURCE is rejected before compile;
//   (c) a source with a NESTED QUANTIFIER (the classic catastrophic-backtracking
//       shape, e.g. (a+)+, (a*)*, ([a-z]+)+, (\d+){2,}) is rejected before compile;
//   (d) compile + exec run inside try/catch so any throw -> no counts.
//
// parseSummary remains the worker-local pure evaluator. Product callers use
// parseSummaryBounded, which runs even alternation-overlap patterns in a one-shot
// worker with a wall-clock deadline so regex execution never blocks Electron main.
//
// Group contract: prefer named groups (?<passed>\d+) / (?<failed>\d+); fall back
// to positional capture groups 1 (passed) and 2 (failed).

const MAX_REGEX_SOURCE = 200;
const MAX_INPUT_TAIL = 16_000;
const DEFAULT_REGEX_DEADLINE_MS = 250;

function toCount(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

// Guard (c): a quantifier ('*', '+', or '{n,m}') applied to a group whose body
// itself contains an unbounded quantifier is the canonical nested-quantifier
// catastrophe. The quantifier must be IMMEDIATELY adjacent to the group close to
// apply to it. The detector regex is itself linear (a single char-class star), so
// running it is safe. Two adjacent but SEPARATE quantified groups (e.g.
// "(\d+) passed, (\d+) failed") are NOT flagged — neither group is itself
// quantified.
function hasNestedQuantifier(source) {
  const quantifiedGroup = /\(([^()]*)\)(?:[*+]|\{\d+,?\d*\})/g;
  let match;
  while ((match = quantifiedGroup.exec(source)) !== null) {
    if (/[*+]|\{\d+,?\d*\}/.test(match[1])) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} stdoutTail - the run's captured stdout tail (may be empty/nullish).
 * @param {string} summaryRegex - a user-authored pattern (non-string -> no counts).
 * @returns {{passedCount?:number, failedCount?:number}} omitted-on-miss; never throws.
 */
function parseSummary(stdoutTail, summaryRegex) {
  if (typeof summaryRegex !== 'string' || !summaryRegex || summaryRegex.length > MAX_REGEX_SOURCE) {
    return {};
  }
  if (hasNestedQuantifier(summaryRegex)) {
    return {};
  }
  const text = typeof stdoutTail === 'string' ? stdoutTail : '';
  const scanned = text.length > MAX_INPUT_TAIL ? text.slice(text.length - MAX_INPUT_TAIL) : text;

  let match;
  try {
    // Non-global: a single exec from index 0; named groups are still available.
    match = new RegExp(summaryRegex).exec(scanned);
  } catch (_error) {
    return {};
  }
  if (!match) {
    return {};
  }

  const groups = match.groups || {};
  const passedCount = toCount(groups.passed !== undefined ? groups.passed : match[1]);
  const failedCount = toCount(groups.failed !== undefined ? groups.failed : match[2]);

  const out = {};
  if (passedCount !== undefined) {
    out.passedCount = passedCount;
  }
  if (failedCount !== undefined) {
    out.failedCount = failedCount;
  }
  return out;
}

function sanitizeWorkerCounts(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  const passedCount = toCount(source.passedCount);
  const failedCount = toCount(source.failedCount);
  if (passedCount !== undefined) out.passedCount = passedCount;
  if (failedCount !== undefined) out.failedCount = failedCount;
  return out;
}

function defaultCreateWorker(payload) {
  const path = require('node:path');
  const { Worker } = require('node:worker_threads');
  return new Worker(path.join(__dirname, 'workspace-test-runner-summary-worker.js'), { workerData: payload });
}

function parseSummaryBounded(stdoutTail, summaryRegex, options = {}) {
  if (typeof summaryRegex !== 'string' || !summaryRegex || summaryRegex.length > MAX_REGEX_SOURCE) {
    return Promise.resolve({});
  }
  if (hasNestedQuantifier(summaryRegex)) return Promise.resolve({});
  const text = typeof stdoutTail === 'string' ? stdoutTail : '';
  const scanned = text.length > MAX_INPUT_TAIL ? text.slice(text.length - MAX_INPUT_TAIL) : text;
  const createWorker = typeof options.createWorker === 'function' ? options.createWorker : defaultCreateWorker;
  const setTimeoutImpl = typeof options.setTimeoutImpl === 'function' ? options.setTimeoutImpl : setTimeout;
  const clearTimeoutImpl = typeof options.clearTimeoutImpl === 'function' ? options.clearTimeoutImpl : clearTimeout;
  const requestedDeadline = Math.trunc(Number(options.deadlineMs));
  const deadlineMs = Number.isFinite(requestedDeadline) && requestedDeadline > 0
    ? Math.min(requestedDeadline, 1000)
    : DEFAULT_REGEX_DEADLINE_MS;
  return new Promise((resolve) => {
    let worker;
    try {
      worker = createWorker({ stdoutTail: scanned, summaryRegex });
    } catch (_error) {
      resolve({});
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeoutImpl(timer);
      try { Promise.resolve(worker.terminate?.()).catch(() => {}); } catch (_error) { /* best-effort */ }
      resolve(sanitizeWorkerCounts(value));
    };
    worker.once?.('message', finish);
    worker.once?.('error', () => finish({}));
    worker.once?.('exit', () => finish({}));
    timer = setTimeoutImpl(() => finish({}), deadlineMs);
    timer?.unref?.();
  });
}

module.exports = {
  parseSummary,
  parseSummaryBounded,
  hasNestedQuantifier,
  MAX_REGEX_SOURCE,
  MAX_INPUT_TAIL,
};
