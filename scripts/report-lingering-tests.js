#!/usr/bin/env node
'use strict';

// Finds test files whose process stays alive after its tests have finished
// (a leaked timer, child process or socket). Runs the safe runner over the
// given files or directories with scripts/tests/linger-probe.js preloaded and
// prints the lingering files, longest first:
//
//   npm run test:lingering -- tests/
//   npm run test:lingering -- tests/file-json-store.test.js
//
// The preload changes the child environment, so a handful of tests that pin
// the runner's exact output or environment can fail under it; read the linger
// list, not the pass/fail summary, and never use this run as a gate.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER_PATH = path.join(__dirname, 'run-node-tests-safe.js');
const PROBE_PATH = path.join(__dirname, 'tests', 'linger-probe.js');

function readLingerReport(reportPath, cwd = process.cwd()) {
  let raw;
  try {
    raw = fs.readFileSync(reportPath, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      rows.push({
        file: path.relative(cwd, String(row.file)).replace(/\\/g, '/'),
        lingerMs: Number(row.lingerMs) || 0,
        resources: Array.isArray(row.resources) ? row.resources : [],
      });
    } catch {
      // a torn line from a killed process is not worth failing the report
    }
  }
  return rows.sort((a, b) => b.lingerMs - a.lingerMs);
}

function formatLingerReport(rows) {
  if (rows.length === 0) return '[lingering-tests] no test file lingered after its tests finished';
  const totalSeconds = rows.reduce((sum, row) => sum + row.lingerMs, 0) / 1000;
  const lines = [`[lingering-tests] ${rows.length} file(s) lingered, ${totalSeconds.toFixed(1)}s in total:`];
  for (const row of rows) {
    const counts = new Map();
    for (const name of row.resources) counts.set(name, (counts.get(name) || 0) + 1);
    const held = [...counts].map(([name, count]) => (count > 1 ? `${name} x${count}` : name)).join(', ');
    lines.push(`[lingering-tests]   ${(row.lingerMs / 1000).toFixed(1)}s ${row.file}${held ? ` (${held})` : ''}`);
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linger-'));
  const reportPath = path.join(reportDir, 'lingering.jsonl');
  const preload = `--require=${PROBE_PATH.replace(/\\/g, '/')}`;
  const result = spawnSync(process.execPath, [RUNNER_PATH, ...(argv.length ? argv : ['tests/'])], {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      JENNY_LINGER_REPORT: reportPath,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '),
    },
  });
  console.log(formatLingerReport(readLingerReport(reportPath)));
  fs.rmSync(reportDir, { recursive: true, force: true });
  return result.status === null ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { PROBE_PATH, formatLingerReport, readLingerReport, main };
