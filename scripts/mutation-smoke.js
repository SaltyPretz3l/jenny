#!/usr/bin/env node
'use strict';

// Scoped changed-line mutation smoke (P2-3 of the test-suite A-rating plan).
//
// Formalizes the repo's manual "mutation-spot-checked" convention (see
// scripts/checks/check_vacuous_oracle.py) into an automated, owner-local,
// ADVISORY pass: it applies a small canonical catalog of high-signal token
// mutations to changed production source lines, runs the test(s) mapped to each
// file, and reports SURVIVING mutants -- a mutation no mapped test detected.
//
// A surviving mutant means the mapped tests did not catch the change: either a
// weak oracle (the bug we want to find) OR the mutated line is not exercised by
// the mapped tests. The tool prints that caveat; it is a smell finder, not a
// gate. It exits 0 by default (advisory) so it is NEVER a PR gate; pass --strict
// to make survivors a non-zero exit for a deliberate, owner-run deep audit.
//
// It adds NO dependency (no Stryker/mutmut -- those stay out of the locked deps;
// reserve them for pre-release deep audits). Mutations are applied in place and
// the original bytes are ALWAYS restored -- even on crash/Ctrl-C -- via a process
// guard, so the working tree is never left mutated.
//
// Usage:
//   node scripts/mutation-smoke.js --changed            # files changed vs local main + working tree
//   node scripts/mutation-smoke.js services/foo.js ...  # explicit production source files
//   node scripts/mutation-smoke.js --changed --strict   # exit 1 if any mutant survives
//   node scripts/mutation-smoke.js --changed --json=mutation-report.json
//   node scripts/mutation-smoke.js --changed --max-mutants-per-file=20

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MAX_MUTANTS_PER_FILE = 15;
const DEFAULT_TIMEOUT_MS = 120000;
// origin/main first: merge-base against local main is HEAD when running on
// main itself, which yields an empty changed set and a vacuous pass.
const DEFAULT_MERGE_BASE_REFS = ['origin/main', 'main'];
const WORD_CHAR = /[A-Za-z0-9_$]/;

// Canonical catalog: unambiguous, high-signal token swaps targeting the
// comparison / boolean-logic gaps that weak oracles miss. Deliberately excludes
// bare `==`/`+`/numeric mutations (ambiguous, string/JSX-mangling, low signal).
// None of these tokens is a substring of another here, so per-occurrence
// replacement never cross-contaminates.
const MUTATION_CATALOG = [
  { name: 'strict-eq->neq', find: '===', to: '!==' },
  { name: 'strict-neq->eq', find: '!==', to: '===' },
  { name: 'and->or', find: '&&', to: '||' },
  { name: 'or->and', find: '||', to: '&&' },
  { name: 'gte->gt', find: '>=', to: '>' },
  { name: 'lte->lt', find: '<=', to: '<' },
  { name: 'true->false', find: 'true', to: 'false', word: true },
  { name: 'false->true', find: 'false', to: 'true', word: true },
];

const PRODUCTION_PREFIXES = ['services/', 'renderer/'];
const PRODUCTION_TOPLEVEL = new Set(['main.js', 'preload.js', 'preload-overlay.js', 'overlay-window.js']);
const NON_SOURCE_PREFIXES = ['tests/', 'scripts/', 'node_modules/', 'vendor/', 'dist/', 'build/', 'out/'];

function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

function isProductionSource(relPath) {
  const rel = toPosix(relPath);
  if (!rel.endsWith('.js')) return false;
  if (rel.endsWith('.test.js') || rel.endsWith('.min.js')) return false;
  if (NON_SOURCE_PREFIXES.some((prefix) => rel.startsWith(prefix))) return false;
  if (PRODUCTION_PREFIXES.some((prefix) => rel.startsWith(prefix))) return true;
  return PRODUCTION_TOPLEVEL.has(rel);
}

function isSkippableLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

// All occurrence indices of `find` in `line`; for word ops, only standalone words.
function findOccurrences(line, find, word) {
  const indices = [];
  let from = 0;
  for (;;) {
    const at = line.indexOf(find, from);
    if (at === -1) break;
    if (word) {
      const before = at > 0 ? line[at - 1] : '';
      const after = at + find.length < line.length ? line[at + find.length] : '';
      if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) indices.push(at);
    } else {
      indices.push(at);
    }
    from = at + find.length;
  }
  return indices;
}

function mutateAt(line, index, find, to) {
  return line.slice(0, index) + to + line.slice(index + find.length);
}

// Blank out comment spans while keeping every UTF-16 code unit in place, so
// masked[i] still lines up with text[i] and a mutant's column stays valid
// against the ORIGINAL line. Two properties this must not lose:
//   - `text.split('')` splits by code unit, the same unit String#[] and
//     String#slice use. Spreading (`[...text]`) splits by code POINT, so one
//     emoji anywhere before a comment shortens the mask by a unit per
//     surrogate pair and the two line arrays stop lining up --
//     renderer/features/renderer-scratchpad-pin.js is a real source that hits it.
//   - a `/` escaped by a backslash never opens a comment. `\/\/` is how every
//     URL regex in this repo spells `//`, and its second escaped slash sits
//     right against the literal's closing slash.
// This is a scanner, not a JS parser: it does not track expression position, so
// a regex literal holding an UNescaped `//` or `/*` still reads as a comment.
// That direction only ever drops mutants, never mutates the wrong bytes, which
// is the safe way for an advisory tool to be wrong.
function maskCommentSpans(text) {
  const masked = text.split('');
  let quote = null;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    const next = text[i + 1];
    if (inBlockComment) {
      if (character !== '\r' && character !== '\n') masked[i] = ' ';
      if (character === '*' && next === '/') {
        masked[i + 1] = ' ';
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') {
        i += 1;
      } else if (character === quote) {
        quote = null;
      } else if (character === '\n' && quote !== '`') {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '/' && next === '/' && text[i - 1] !== '\\') {
      while (i < text.length && text[i] !== '\n') {
        if (text[i] !== '\r') masked[i] = ' ';
        i += 1;
      }
      i -= 1;
    } else if (character === '/' && next === '*' && text[i - 1] !== '\\') {
      masked[i] = ' ';
      masked[i + 1] = ' ';
      i += 1;
      inBlockComment = true;
    }
  }
  return masked.join('');
}

// Every (line, operator, occurrence) mutant for a file's text. Returns objects
// with enough context to rebuild the full mutated content and to report.
function generateFileMutants(text) {
  const lines = text.split('\n');
  const candidateLines = maskCommentSpans(text).split('\n');
  const mutants = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const candidateLine = candidateLines[i];
    if (isSkippableLine(candidateLine)) continue;
    for (const op of MUTATION_CATALOG) {
      for (const index of findOccurrences(candidateLine, op.find, op.word)) {
        mutants.push({
          lineNo: i + 1,
          op: op.name,
          find: op.find,
          to: op.to,
          before: line.replace(/\r$/, ''),
          after: mutateAt(line, index, op.find, op.to).replace(/\r$/, ''),
          _lineIndex: i,
          _columnIndex: index,
        });
      }
    }
  }
  return mutants;
}

function applyMutant(text, mutant) {
  const lines = text.split('\n');
  const line = lines[mutant._lineIndex];
  lines[mutant._lineIndex] = mutateAt(line, mutant._columnIndex, mutant.find, mutant.to);
  return lines.join('\n');
}

// --- Source -> test resolution ---------------------------------------------

let cachedTestFiles = null;
function listTestFiles(root) {
  if (cachedTestFiles) return cachedTestFiles;
  const testsDir = path.join(root, 'tests');
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        out.push(toPosix(path.relative(root, abs)));
      }
    }
  };
  walk(testsDir);
  cachedTestFiles = out;
  return out;
}

function loadCoarseMap(root) {
  try {
    const raw = fs.readFileSync(path.join(root, 'scripts', 'checks', 'changed_target_test_map.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.rules) ? parsed.rules : [];
  } catch {
    return [];
  }
}

function targetSelectorMatches(relPath, rawSelector) {
  const selector = toPosix(String(rawSelector || '').trim()).replace(/^\.\//, '');
  if (!selector) return false;
  return selector.endsWith('/') || selector.endsWith('-')
    ? relPath.startsWith(selector)
    : relPath === selector;
}

// Union any basename stem matches with every matching selector from the
// changed-target map. Directory and dash-namespace selectors are prefixes;
// all other selectors are exact files.
function resolveTestsForSource(relSource, { root }) {
  const rel = toPosix(relSource);
  const stem = path.basename(rel).replace(/\.js$/, '');
  const exactName = `${stem}.test.js`;
  const all = listTestFiles(root);
  const stemHits = all.filter((testRel) => {
    const base = path.basename(testRel);
    return base === exactName || (base.startsWith(`${stem}-`) && base.endsWith('.test.js'));
  });
  const coarseHits = [];
  for (const rule of loadCoarseMap(root)) {
    const selectors = Array.isArray(rule.target_prefixes) ? rule.target_prefixes : [];
    if (selectors.some((selector) => targetSelectorMatches(rel, selector))) {
      for (const test of rule.required_tests || []) {
        if (!coarseHits.includes(test) && fs.existsSync(path.join(root, test))) coarseHits.push(test);
      }
    }
  }
  const tests = [...new Set([...stemHits, ...coarseHits])];
  let source = 'none';
  if (stemHits.length && coarseHits.length) source = 'stem+coarse-map';
  else if (stemHits.length) source = 'stem-match';
  else if (coarseHits.length) source = 'coarse-map';
  return { tests, source };
}

// --- git changed-file discovery (mirrors check_doc_as_code.py priority) ------

function git(args, root) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || r.error) return null;
  return r.stdout;
}

function collectChangedLines(diffText, changedLinesBySource) {
  let currentSource = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const diffPath = line.slice(4).trim();
      currentSource = diffPath === '/dev/null'
        ? null
        : toPosix(diffPath.startsWith('b/') ? diffPath.slice(2) : diffPath);
      if (currentSource && !changedLinesBySource.has(currentSource)) {
        changedLinesBySource.set(currentSource, new Set());
      }
      continue;
    }
    if (!currentSource || !line.startsWith('@@ ')) continue;
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    const changedLines = changedLinesBySource.get(currentSource);
    for (let lineNo = start; lineNo < start + count; lineNo += 1) {
      changedLines.add(lineNo);
    }
  }
}

function collectChangedSources(root, { runGit = git, mergeBaseRefs = DEFAULT_MERGE_BASE_REFS, sourceFilter = isProductionSource } = {}) {
  if (runGit(['rev-parse', '--is-inside-work-tree'], root) === null) {
    return { sources: [], changedLinesBySource: new Map(), reason: 'git unavailable (not a work tree)' };
  }
  const set = new Set();
  const changedLinesBySource = new Map();
  for (const mergeBaseRef of mergeBaseRefs) {
    const mergeBase = runGit(['merge-base', mergeBaseRef, 'HEAD'], root);
    if (mergeBase === null || !mergeBase.trim()) continue;
    const range = `${mergeBase.trim()}...HEAD`;
    const diff = runGit(['diff', '--name-only', '--diff-filter=ACMR', range], root);
    if (diff === null) continue;
    diff.split('\n').forEach((line) => line.trim() && set.add(line.trim()));
    const lineDiff = runGit(['diff', '--unified=0', '--diff-filter=ACMR', range], root);
    if (lineDiff !== null) collectChangedLines(lineDiff, changedLinesBySource);
    break;
  }
  const status = runGit(['status', '--porcelain', '--untracked-files=all'], root);
  if (status !== null) {
    for (const line of status.split('\n')) {
      if (!line.trim()) continue;
      let p = line.slice(3).trim();
      if (p.includes(' -> ')) p = p.split(' -> ')[1].trim();
      if (p) set.add(p);
    }
  }
  const workingDiff = runGit(['diff', '--unified=0', '--diff-filter=ACMR', 'HEAD'], root);
  if (workingDiff !== null) collectChangedLines(workingDiff, changedLinesBySource);
  const sources = [...set].map(toPosix).filter(sourceFilter).sort();
  return { sources, changedLinesBySource, reason: null };
}

// --- test execution ---------------------------------------------------------

function defaultRunTests(testFiles, { root, timeoutMs }) {
  const r = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'run-node-tests-safe.js'), ...testFiles, '--no-lock', `--timeout-ms=${timeoutMs}`],
    { cwd: root, encoding: 'utf8', timeout: timeoutMs + 30000, windowsHide: true },
  );
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  // passed iff the runner exited 0. A non-test runner failure (signal kill, OOM,
  // timeout) yields passed=false, so the mutant is counted KILLED. Systematic
  // causes (bad path/cwd/env) are caught first by the baseline gate -- a red
  // baseline skips the file; only a transient runner failure on a mutated run can
  // spuriously "kill" a would-be survivor, which makes this advisory smoke
  // UNDER-report (the safe direction: never a false alarm, never a false gate).
  return { passed: !timedOut && r.status === 0, timedOut, status: r.status };
}

// --- restore safety guard ----------------------------------------------------

let pendingRestore = null; // { file, buffer }
let guardsInstalled = false;

function restorePending() {
  if (!pendingRestore) return;
  const { file, buffer } = pendingRestore;
  try {
    fs.writeFileSync(file, buffer);
    pendingRestore = null;
  } catch (err) {
    // The one hard invariant is "never leave the tree mutated". If the restore
    // write itself fails (disk full, file locked, read-only FS), do NOT swallow
    // it: the file is currently MUTATED on disk. Surface loudly, fail the
    // process, and leave pendingRestore set so the exit guard retries. The
    // original bytes are still recoverable via git.
    console.error(`[mutation-smoke] CRITICAL: could not restore ${file} after mutation: ${err && err.message}`);
    console.error(`[mutation-smoke] The file is left MUTATED on disk. Recover it with: git checkout -- "${file}"`);
    process.exitCode = 1;
  }
}

function installRestoreGuards() {
  if (guardsInstalled) return;
  guardsInstalled = true;
  process.on('exit', restorePending);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      restorePending();
      process.exit(130);
    });
  }
}

// Write the mutant, run fn, then ALWAYS restore the exact original bytes (the
// same code path the exit/signal guards use, so a restore failure is surfaced
// loudly in one place rather than swallowed).
function runWithMutation(file, originalBuffer, mutatedText, fn) {
  pendingRestore = { file, buffer: originalBuffer };
  try {
    fs.writeFileSync(file, mutatedText, 'utf8');
    return fn();
  } finally {
    restorePending();
  }
}

// --- orchestration -----------------------------------------------------------

function runMutationSmoke(options) {
  const {
    sources,
    root = ROOT,
    maxMutantsPerFile = DEFAULT_MAX_MUTANTS_PER_FILE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    runTests = defaultRunTests,
    resolveTests = resolveTestsForSource,
    changedLinesBySource = null,
    log = () => {},
  } = options;

  installRestoreGuards();
  const files = [];
  const skipped = [];

  for (const relSource of sources) {
    const abs = path.isAbsolute(relSource) ? relSource : path.join(root, relSource);
    const { tests, source: mapSource } = resolveTests(relSource, { root });
    if (tests.length === 0) {
      skipped.push({ source: relSource, reason: 'no mapped test (stem-match or coarse-map)' });
      log(`SKIP ${relSource}: no mapped test`);
      continue;
    }

    const originalBuffer = fs.readFileSync(abs);
    const originalText = originalBuffer.toString('utf8');

    const baseline = runTests(tests, { root, timeoutMs });
    if (!baseline.passed) {
      skipped.push({ source: relSource, reason: 'baseline tests not green; cannot mutation-test', tests });
      log(`SKIP ${relSource}: baseline RED (cannot trust mutation results)`);
      continue;
    }

    let mutants = generateFileMutants(originalText);
    const changedLines = changedLinesBySource
      && (changedLinesBySource.get(relSource) || changedLinesBySource.get(toPosix(relSource)));
    if (changedLines) mutants = mutants.filter((mutant) => changedLines.has(mutant.lineNo));
    const generated = mutants.length;
    let cappedNote = null;
    if (mutants.length > maxMutantsPerFile) {
      cappedNote = `capped ${generated} -> ${maxMutantsPerFile} mutants (raise --max-mutants-per-file to cover the rest)`;
      mutants = mutants.slice(0, maxMutantsPerFile);
      log(`NOTE ${relSource}: ${cappedNote}`);
    }

    const survivors = [];
    let killed = 0;
    log(`MUTATE ${relSource} (${mutants.length} mutants, tests: ${tests.join(', ')})`);
    for (const mutant of mutants) {
      const mutatedText = applyMutant(originalText, mutant);
      const result = runWithMutation(abs, originalBuffer, mutatedText, () => runTests(tests, { root, timeoutMs }));
      if (pendingRestore) {
        // restorePending failed (CRITICAL already printed); stop before mutating further.
        log(`ABORT ${relSource}: restore failed; stopping to avoid leaving more files mutated`);
        break;
      }
      if (result.passed) {
        survivors.push({ lineNo: mutant.lineNo, op: mutant.op, before: mutant.before, after: mutant.after });
      } else {
        killed += 1;
      }
    }

    files.push({
      source: relSource,
      tests,
      mapSource,
      generated,
      tested: mutants.length,
      killed,
      survivors,
      cappedNote,
    });
  }

  const totalSurvivors = files.reduce((sum, file) => sum + file.survivors.length, 0);
  return { files, skipped, totalSurvivors };
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    changed: false,
    strict: false,
    help: false,
    sources: [],
    jsonPath: null,
    maxMutantsPerFile: DEFAULT_MAX_MUTANTS_PER_FILE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (const arg of argv) {
    if (arg === '--changed') opts.changed = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--json=')) opts.jsonPath = arg.slice('--json='.length);
    else if (arg.startsWith('--max-mutants-per-file=')) opts.maxMutantsPerFile = Number(arg.split('=')[1]) || DEFAULT_MAX_MUTANTS_PER_FILE;
    else if (arg.startsWith('--timeout-ms=')) opts.timeoutMs = Number(arg.split('=')[1]) || DEFAULT_TIMEOUT_MS;
    else if (arg.startsWith('--')) { /* ignore unknown flags */ }
    else opts.sources.push(arg);
  }
  return opts;
}

const HELP = `mutation-smoke -- scoped, advisory changed-line mutation smoke

  node scripts/mutation-smoke.js --changed  # mutate changed lines from Git diffs
  node scripts/mutation-smoke.js services/foo.js renderer/shell/bar.js  # positional paths mutate whole files
  node scripts/mutation-smoke.js --changed --strict --json=mutation-report.json

Reports surviving mutants (a change no mapped test detected = weak oracle or
untested line). Exits 0 by default (advisory, never a PR gate); --strict makes
survivors exit 1. Adds no dependency; always restores the original source.`;

function printReport(report, log) {
  for (const file of report.files) {
    log(`\n${file.source}  [${file.mapSource}: ${file.tests.length} test file(s)]`);
    log(`  mutants: ${file.tested} tested${file.generated !== file.tested ? ` of ${file.generated}` : ''}, killed ${file.killed}, survived ${file.survivors.length}`);
    if (file.cappedNote) log(`  NOTE: ${file.cappedNote}`);
    for (const s of file.survivors) {
      log(`  SURVIVOR L${s.lineNo} [${s.op}]`);
      log(`    - ${s.before.trim()}`);
      log(`    + ${s.after.trim()}`);
    }
  }
  for (const skip of report.skipped) {
    log(`\nSKIPPED ${skip.source}: ${skip.reason}`);
  }
  log('');
  if (report.totalSurvivors === 0 && report.files.length > 0) {
    log('PASS: no surviving mutants in the mapped tests.');
  } else if (report.files.length === 0) {
    log('NOTE: no production source files with mapped tests to mutate.');
  } else {
    log(`SURVIVORS: ${report.totalSurvivors} mutant(s) survived. Each is a weak-oracle smell OR an untested line -- investigate.`);
  }
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const positionalSources = opts.sources.filter((p) => isProductionSource(p));
  let sources = positionalSources;
  let changedLinesBySource = null;
  const ignored = opts.sources.filter((p) => !isProductionSource(p));
  if (ignored.length) console.error(`[mutation-smoke] ignoring non-production-source args: ${ignored.join(', ')}`);

  if (opts.changed) {
    const { sources: changed, changedLinesBySource: collectedLines, reason } = collectChangedSources(ROOT);
    if (reason) {
      console.error(`[mutation-smoke] WARN: ${reason}; nothing to mutate (advisory, passing).`);
      return 0;
    }
    changedLinesBySource = collectedLines;
    for (const positionalSource of positionalSources) changedLinesBySource.delete(toPosix(positionalSource));
    sources = [...new Set([...sources, ...changed])];
  }

  if (sources.length === 0) {
    if (!opts.changed) console.error('[mutation-smoke] no production source files given. Use --changed or pass paths. (--help for usage)');
    else console.error('[mutation-smoke] no changed production source files to mutate.');
    return 0;
  }

  const report = runMutationSmoke({
    sources,
    changedLinesBySource,
    maxMutantsPerFile: opts.maxMutantsPerFile,
    timeoutMs: opts.timeoutMs,
    log: (msg) => console.log(msg),
  });
  printReport(report, (msg) => console.log(msg));

  if (opts.jsonPath) {
    fs.writeFileSync(path.resolve(ROOT, opts.jsonPath), JSON.stringify(report, null, 2));
    console.log(`[mutation-smoke] wrote ${opts.jsonPath}`);
  }

  return opts.strict && report.totalSurvivors > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  DEFAULT_MERGE_BASE_REFS,
  MUTATION_CATALOG,
  isProductionSource,
  isSkippableLine,
  findOccurrences,
  mutateAt,
  generateFileMutants,
  applyMutant,
  resolveTestsForSource,
  loadCoarseMap,
  targetSelectorMatches,
  collectChangedSources,
  runWithMutation,
  runMutationSmoke,
  parseArgs,
  defaultRunTests,
};
