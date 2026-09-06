'use strict';

// Golden corpus for services/workspace-file-map-engine.js.
//
// Freeze mechanism mirrors tests/timeline-replay-corpus.test.js in spirit:
//  - REQUIRED_SCENARIOS is a frozen, ordered list; the corpus dir must match it
//    exactly (no extra, none missing).
//  - EXPECTED_FILE_MAP_CORPUS_SHA256 is a digest over every fixture file
//    (sorted relative paths, CRLF->LF normalized) so accidental fixture drift
//    fails loudly.
//  - Each scenario builds the graph via buildGraph() and deep-equals it against
//    that scenario's expected.json.
//
// Determinism / comparison normalization:
//  - meta.durationMs is non-deterministic wall time. It is normalized to 0 in
//    BOTH the actual output and the fixture before comparing, and is EXCLUDED
//    from the corpus SHA by only hashing input/, cochange.json, and
//    expected.json (never a separately-timed value).
//  - nodes are sorted by id; edges are sorted by (from, to, kind); importance
//    is rounded by the engine (IMPORTANCE_PRECISION) so float drift is stable.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildGraph } = require('../services/workspace-file-map-engine');
const { parseTsconfigAliases, EMPTY_ALIASES } = require('../services/workspace-file-map-scan-rules');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'file-map-scan');

const REQUIRED_SCENARIOS = Object.freeze([
  '01-js-relative-resolve',
  '02-index-fallback',
  '03-extension-inference',
  '04-bare-external-drop',
  '05-python-dotted',
  '06-css-import',
  '07-html-script-src',
  '08-cycle-break',
  '09-test-detection',
  '10-dedupe-edges',
  '11-tsconfig-paths-alias',
  '12-reexport-from',
  '13-dynamic-import-literal',
  '14-cochange-edges',
  '15-importance-blend',
  '16-findings-hub-cycle-orphan',
]);

// Frozen digest over the fixture corpus. Any accidental fixture drift flips
// this and fails loudly. Recompute intentionally (and record the rationale)
// when a fixture genuinely changes.
const EXPECTED_FILE_MAP_CORPUS_SHA256 = 'e0e3ed2e3c8e8b5b1a0f37828e213086b7a8ee53efc39dd548d332f9ef35909a';

// ---------------------------------------------------------------------------
// Fixture IO helpers
// ---------------------------------------------------------------------------

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Recursively list every file under `dir`, returned as POSIX relPaths relative
// to `dir`, sorted. Used both to enumerate a scenario's workspace files and to
// compute the corpus digest.
function listFilesRecursive(dir, baseDir = dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, baseDir));
    } else {
      out.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return out.sort();
}

// Every fixture file that participates in the frozen digest, per scenario:
// all input/** files, plus the optional cochange.json, plus expected.json.
function scenarioDigestFiles(scenarioDir) {
  const files = [];
  const inputDir = path.join(scenarioDir, 'input');
  if (fs.existsSync(inputDir)) {
    for (const rel of listFilesRecursive(inputDir)) {
      files.push(path.join('input', rel));
    }
  }
  const cochange = path.join(scenarioDir, 'cochange.json');
  if (fs.existsSync(cochange)) files.push('cochange.json');
  const expected = path.join(scenarioDir, 'expected.json');
  if (fs.existsSync(expected)) files.push('expected.json');
  return files.map((rel) => rel.replace(/\\/g, '/')).sort();
}

function computeCorpusDigest(rootDir) {
  const hash = crypto.createHash('sha256');
  const scenarioNames = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const scenarioName of scenarioNames) {
    const scenarioDir = path.join(rootDir, scenarioName);
    for (const rel of scenarioDigestFiles(scenarioDir)) {
      hash.update(`${scenarioName}/${rel}`);
      hash.update('\n');
      // Normalize CRLF->LF so the locked digest is stable on Windows checkouts.
      hash.update(fs.readFileSync(path.join(scenarioDir, rel), 'utf8').replace(/\r\n/g, '\n'));
      hash.update('\n');
    }
  }

  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Graph build + canonicalization
// ---------------------------------------------------------------------------

function loadCochangeCommits(scenarioDir) {
  const cochange = path.join(scenarioDir, 'cochange.json');
  if (!fs.existsSync(cochange)) return [];
  const parsed = readJson(cochange);
  return Array.isArray(parsed.commits) ? parsed.commits : [];
}

// Build the graph for a scenario from its input/ directory, treating every
// file under input/ as a workspace file with its real POSIX relPath.
function buildScenarioGraph(scenarioDir) {
  const inputDir = path.join(scenarioDir, 'input');
  const files = listFilesRecursive(inputDir);

  const readContent = (relPath) => fs.readFileSync(path.join(inputDir, relPath), 'utf8');

  // Alias scenario: load tsconfig aliases from the input dir (a real workspace
  // file). Every other scenario passes EMPTY_ALIASES.
  const hasTsconfig = files.includes('tsconfig.json');
  const tsconfigAliases = hasTsconfig
    ? parseTsconfigAliases(fs.readFileSync(path.join(inputDir, 'tsconfig.json'), 'utf8'))
    : EMPTY_ALIASES;

  const cochangeCommits = loadCochangeCommits(scenarioDir);

  return buildGraph({ files, readContent, cochangeCommits, tsconfigAliases });
}

// Canonical order: nodes by id; edges by (from, to, kind). durationMs -> 0.
function canonicalizeGraph(graph) {
  const plain = JSON.parse(JSON.stringify(graph));
  plain.nodes = (plain.nodes || []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  plain.edges = (plain.edges || []).slice().sort((a, b) => {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
  if (plain.meta) plain.meta.durationMs = 0;
  return plain;
}

// ---------------------------------------------------------------------------
// Freeze tests
// ---------------------------------------------------------------------------

test('file-map corpus contains exactly the required scenarios', () => {
  const scenarioNames = fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(scenarioNames, [...REQUIRED_SCENARIOS].sort());
  // Also assert the frozen order/content is exactly the required set.
  assert.deepEqual([...REQUIRED_SCENARIOS], REQUIRED_SCENARIOS.slice());
});

test('file-map corpus checksum matches the locked fixture set', () => {
  assert.equal(computeCorpusDigest(FIXTURE_ROOT), EXPECTED_FILE_MAP_CORPUS_SHA256);
});

for (const scenarioName of REQUIRED_SCENARIOS) {
  test(`file-map scenario ${scenarioName} matches expected.json`, () => {
    const scenarioDir = path.join(FIXTURE_ROOT, scenarioName);
    const expected = readJson(path.join(scenarioDir, 'expected.json'));
    const actual = canonicalizeGraph(buildScenarioGraph(scenarioDir));
    // Normalize the fixture's durationMs the same way (fixtures pin it to 0).
    if (expected.meta) expected.meta.durationMs = 0;
    assert.deepEqual(actual, expected);
  });
}
