#!/usr/bin/env node
'use strict';

// Read-only reporter over the safe runner's bounded history by default, with
// JUnit XML retained as an explicit single-run input. Prints the N slowest
// files with a lane tag so a human can spot sequential-risk suites vs
// perf/load tests vs ordinary parallel-lane files.
//
// No new npm dependency. Source of truth for the XML shape is
// scripts/run-node-tests-safe-support.js's buildJunitXml/escapeXml/
// writeJunitReport: one <testsuites><testsuite> containing one <testcase
// name="..." classname="..." time="D.DDD">...</testcase> per file, where name
// and classname both hold the repo-relative file path and time is seconds as
// a decimal string. That writer is in-repo and stable (not attacker-
// controlled input), so a small regex-based extraction of each <testcase ...>
// opening tag is sufficient here -- a full XML parser would be overkill.

const fs = require('fs');
const path = require('path');
const { isSequentialTestPath, expandDirectoryArg } = require('./run-node-tests-safe.js');
const { DEFAULT_CUT_MS, SLOW_LANE_LABEL, computeSlowLane, writeSlowLane } = require('./run-node-tests-safe-slow-lane');
const {
  HISTORY_PATH,
  readHistoryFile,
  resolveHistoryPath,
} = require('./run-node-tests-safe-history');

const LOAD_TEST_PATTERN = /\.load\.test\.(c|m)?js$/;
const DEFAULT_TOP = 20;
const DEFAULT_RUNS = 10;

const XML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function unescapeXml(value) {
  return String(value).replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity]);
}

// Extracts one { file, durationSec } record per <testcase ...> opening tag, in
// document order. Only reads attributes off the opening tag itself -- it does
// not need to look at the testcase body (error/failure/skipped children).
function parseJunitXml(xmlString) {
  const records = [];
  const testcaseTagPattern = /<testcase\b([^>]*)>/g;
  let match;
  while ((match = testcaseTagPattern.exec(String(xmlString))) !== null) {
    const attrs = match[1];
    const nameMatch = /\bname="([^"]*)"/.exec(attrs);
    const classnameMatch = /\bclassname="([^"]*)"/.exec(attrs);
    const timeMatch = /\btime="([\d.]+)"/.exec(attrs);
    const rawFile = nameMatch ? nameMatch[1] : classnameMatch ? classnameMatch[1] : '';
    const file = unescapeXml(rawFile);
    const durationSec = timeMatch ? Number(timeMatch[1]) : 0;
    records.push({ file, durationSec: Number.isFinite(durationSec) ? durationSec : 0 });
  }
  return records;
}

// Lane precedence: sequential first, then load, else parallel. Note
// isSequentialTestPath itself treats *.load.test.js as sequential-risk (perf
// tests are run in isolation), so the load check here must run first to give
// load files their own distinguishing [load] tag rather than folding into
// [sequential]; a plain sequential-basename match (e.g. managed-sidecar-*)
// still wins the [sequential] tag over [parallel].
function annotateLane(filePath) {
  const basename = path.basename(String(filePath));
  if (LOAD_TEST_PATTERN.test(basename)) return 'load';
  if (isSequentialTestPath(filePath)) return 'sequential';
  return 'parallel';
}

// Sorts by duration descending; ties preserve the original (document) order
// since Array#sort in V8/Node is a stable sort.
function formatTopSlowest(records, options = {}) {
  const top = Number.isFinite(options.top) && options.top > 0 ? Math.floor(options.top) : DEFAULT_TOP;
  const indexed = records.map((record, index) => ({ record, index }));
  indexed.sort((a, b) => b.record.durationSec - a.record.durationSec || a.index - b.index);
  const chosen = indexed.slice(0, top).map((entry) => entry.record);
  return chosen.map((record) => {
    const seconds = `${record.durationSec.toFixed(3)}s`;
    const sampleText = record.sampleCount ? ` median (${record.sampleCount} run${record.sampleCount === 1 ? '' : 's'}) ` : '  ';
    return `${seconds}${sampleText}${record.file}  [${annotateLane(record.file)}]`;
  });
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function recordsFromHistory(history, runCount = DEFAULT_RUNS) {
  const runs = history && Array.isArray(history.runs) ? history.runs.slice(0, runCount) : [];
  const durationsByFile = new Map();
  for (const run of runs) {
    for (const record of run && Array.isArray(run.files) ? run.files : []) {
      const durationMs = Number(record && record.durationMs);
      if (!record || record.timedOut || !['passed', 'failed', 'infra'].includes(record.status)) continue;
      if (!Number.isFinite(durationMs) || durationMs < 0) continue;
      if (!durationsByFile.has(record.file)) durationsByFile.set(record.file, []);
      durationsByFile.get(record.file).push(durationMs);
    }
  }
  return [...durationsByFile].map(([file, durations]) => ({
    file,
    durationSec: median(durations) / 1000,
    sampleCount: durations.length,
  }));
}

function parseArgs(argv) {
  let junitPath = null;
  let historyRequested = false;
  let historyPath = null;
  let top = DEFAULT_TOP;
  let runCount = DEFAULT_RUNS;
  let writeSlowLaneRequested = false;
  let cutMs = null;
  for (const arg of argv) {
    if (arg === '--write-slow-lane') {
      writeSlowLaneRequested = true;
      continue;
    }
    if (arg.startsWith('--cut-ms=')) {
      const candidate = Number(arg.slice('--cut-ms='.length));
      if (Number.isFinite(candidate) && candidate > 0) cutMs = Math.floor(candidate);
      continue;
    }
    if (arg.startsWith('--junit=')) {
      const value = arg.slice('--junit='.length).trim();
      if (value) junitPath = value;
      continue;
    }
    if (arg === '--history') {
      historyRequested = true;
      continue;
    }
    if (arg.startsWith('--history=')) {
      historyRequested = true;
      const value = arg.slice('--history='.length).trim();
      if (value) historyPath = value;
      continue;
    }
    if (arg.startsWith('--top=')) {
      const candidate = Number(arg.slice('--top='.length));
      if (Number.isFinite(candidate) && candidate > 0) top = Math.floor(candidate);
    }
    if (arg.startsWith('--runs=')) {
      const candidate = Number(arg.slice('--runs='.length));
      if (Number.isFinite(candidate) && candidate > 0) runCount = Math.floor(candidate);
    }
  }
  return { junitPath, historyRequested, historyPath, top, runCount, writeSlowLane: writeSlowLaneRequested, cutMs };
}

function printUsage() {
  console.log(
    [
      'report-slow-tests: prints slow test files from safe-runner history or JUnit.',
      '',
      'Usage:',
      '  npm run test:slowest',
      '  npm run test:slowest -- --history --runs=20',
      '  npm run test:slowest -- --junit=test-report.xml',
      '  node scripts/run-node-tests-safe.js tests/ --junit=test-report.xml',
      '',
      'Options:',
      `  --history[=<path>]  Read history (default ${HISTORY_PATH} when it exists).`,
      '  --runs=<N>          Read the newest N history runs (default 10).',
      '  --junit=<path>      Read one JUnit XML report instead.',
      '  --top=<N>           Show the N slowest files (default 20).',
      `  --write-slow-lane   Write ${SLOW_LANE_LABEL} from the passing full runs in the history.`,
      `  --cut-ms=<N>        With --write-slow-lane: a median at or over N ms is slow (default ${DEFAULT_CUT_MS}).`,
    ].join('\n')
  );
}

// Writes the fast lane's slow list (tests/.slow-lane.json). Refuses, without
// touching the file, when the history holds too few passing full runs.
function writeSlowLaneFromHistory(history, cutMs, cwd = process.cwd()) {
  const fullRunFileCount = expandDirectoryArg(path.join(cwd, 'tests'), { includeLoad: true }).length;
  const result = computeSlowLane(history, { cwd, cutMs, fullRunFileCount });
  if (!result.ok) {
    console.error(`[report-slow-tests] slow list not written: ${result.reason}`);
    return 1;
  }
  writeSlowLane(cwd, result);
  console.log(
    `[report-slow-tests] wrote ${SLOW_LANE_LABEL}: ${result.files.length} file(s) at or over ` +
      `${(result.cutMs / 1000).toFixed(1)}s (median of ${result.runsUsed} passing full runs); ` +
      `the fast lane keeps ${result.considered - result.files.length} of ${result.considered} stable-lane files`
  );
  return 0;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.junitPath && parsed.historyRequested) {
    console.error('[report-slow-tests] --history and --junit cannot be used together');
    process.exitCode = 1;
    return;
  }
  const defaultHistoryPath = resolveHistoryPath(process.cwd());
  const useHistory = !parsed.junitPath && (parsed.historyRequested || fs.existsSync(defaultHistoryPath));
  if (parsed.writeSlowLane && !useHistory) {
    console.error('[report-slow-tests] --write-slow-lane reads the run history: there is none yet, or --junit was given');
    process.exitCode = 1;
    return;
  }
  if (!parsed.junitPath && !useHistory) {
    printUsage();
    process.exitCode = 0;
    return;
  }
  if (useHistory) {
    const requestedPath = parsed.historyPath || defaultHistoryPath;
    const resolved = path.isAbsolute(requestedPath) ? requestedPath : path.join(process.cwd(), requestedPath);
    if (!fs.existsSync(resolved)) {
      console.error(`[report-slow-tests] failed to read history at ${requestedPath}: file does not exist`);
      process.exitCode = 1;
      return;
    }
    if (parsed.writeSlowLane) {
      process.exitCode = writeSlowLaneFromHistory(readHistoryFile(resolved), parsed.cutMs);
      return;
    }
    const records = recordsFromHistory(readHistoryFile(resolved), parsed.runCount);
    for (const line of formatTopSlowest(records, { top: parsed.top })) console.log(line);
    process.exitCode = 0;
    return;
  }
  const resolved = path.isAbsolute(parsed.junitPath)
    ? parsed.junitPath
    : path.join(process.cwd(), parsed.junitPath);
  let xmlString;
  try {
    xmlString = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    console.error(`[report-slow-tests] failed to read JUnit report at ${parsed.junitPath}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  let records;
  try {
    records = parseJunitXml(xmlString);
  } catch (error) {
    console.error(`[report-slow-tests] failed to parse JUnit report at ${parsed.junitPath}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const lines = formatTopSlowest(records, { top: parsed.top });
  for (const line of lines) {
    console.log(line);
  }
  process.exitCode = 0;
}

if (require.main === module) {
  main();
}

module.exports = {
  parseJunitXml,
  annotateLane,
  formatTopSlowest,
  recordsFromHistory,
  writeSlowLaneFromHistory,
  parseArgs,
  unescapeXml,
  main,
};
