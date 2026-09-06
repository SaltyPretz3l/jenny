'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const mut = require('../scripts/mutation-smoke');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-smoke-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- catalog + mutation primitives ------------------------------------------

test('catalog covers comparison/logic/boolean operators only', () => {
  const names = mut.MUTATION_CATALOG.map((op) => op.name).sort();
  assert.deepEqual(names, [
    'and->or', 'false->true', 'gte->gt', 'lte->lt', 'or->and', 'strict-eq->neq', 'strict-neq->eq', 'true->false',
  ]);
  // No catalog token is a substring of another -> per-occurrence replacement is safe.
  for (const a of mut.MUTATION_CATALOG) {
    for (const b of mut.MUTATION_CATALOG) {
      if (a !== b) assert.ok(!a.find.includes(b.find), `${a.find} must not contain ${b.find}`);
    }
  }
});

test('findOccurrences respects word boundaries for boolean tokens', () => {
  assert.deepEqual(mut.findOccurrences('return true;', 'true', true), [7]);
  assert.deepEqual(mut.findOccurrences('const truthy = trueish;', 'true', true), []);
  assert.deepEqual(mut.findOccurrences('a === b === c', '===', false), [2, 8]);
});

test('mutateAt replaces only the targeted occurrence', () => {
  const indices = mut.findOccurrences('a && b && c', '&&', false);
  assert.deepEqual(indices, [2, 7]);
  assert.equal(mut.mutateAt('a && b && c', indices[1], '&&', '||'), 'a && b || c');
});

test('generateFileMutants skips comments/blank lines and enumerates real operators', () => {
  const text = [
    '// a === b should be ignored',
    '',
    'const ok = x === y && z;',
    'return age >= 18;',
  ].join('\n');
  const mutants = mut.generateFileMutants(text);
  const ops = mutants.map((m) => `${m.lineNo}:${m.op}`).sort();
  assert.deepEqual(ops, ['3:and->or', '3:strict-eq->neq', '4:gte->gt']);
});

test('generateFileMutants keeps executable tokens before trailing comments but excludes comment tokens', () => {
  const text = 'const ok = value === expected; // true means matched\n';

  const mutants = mut.generateFileMutants(text);

  assert.deepEqual(mutants.map((mutant) => mutant.op), ['strict-eq->neq']);
  assert.equal(mutants[0].after, 'const ok = value !== expected; // true means matched');
});

test('comment masking survives astral characters instead of crashing on them', () => {
  // maskCommentSpans has to index by UTF-16 code unit, the same unit String#[]
  // and String#slice use. Spreading the text into an array yields one element
  // per CODE POINT, so a single emoji plus any later comment shortens the mask
  // by one unit per surrogate pair -- the mask then has fewer lines than the
  // source and mutant generation dies on an undefined line.
  // renderer/features/renderer-scratchpad-pin.js is a real production source
  // that hits exactly this.
  const text = 'const icon = "\u{1F600}"; // pinned\nconst ok = a === b;\n';

  const mutants = mut.generateFileMutants(text);

  assert.deepEqual(mutants.map((mutant) => `${mutant.lineNo}:${mutant.op}`), ['2:strict-eq->neq']);
  assert.equal(mutants[0].after, 'const ok = a !== b;');
});

test('an escaped slash inside a regex literal does not open a comment', () => {
  // `\/\/` is how every URL regex in this repo spells "//", and the second
  // escaped slash sits next to the literal's closing slash. Reading that pair
  // as a line comment masks the rest of the line, so real operators after a URL
  // regex would silently stop producing mutants.
  const text = 'const isHttp = /^https?:\\/\\//.test(url) === expected;\n';

  const mutants = mut.generateFileMutants(text);

  assert.deepEqual(mutants.map((mutant) => mutant.op), ['strict-eq->neq']);
  assert.equal(mutants[0].after, 'const isHttp = /^https?:\\/\\//.test(url) !== expected;');
});

test('applyMutant rebuilds full content with exactly one line changed', () => {
  const text = 'line1\nconst ok = a === b;\nline3';
  const [mutant] = mut.generateFileMutants(text);
  const out = mut.applyMutant(text, mutant);
  assert.equal(out, 'line1\nconst ok = a !== b;\nline3');
});

test('CRLF line endings survive a round-trip through applyMutant', () => {
  const text = 'a\r\nconst ok = a === b;\r\nc\r\n';
  const [mutant] = mut.generateFileMutants(text);
  const out = mut.applyMutant(text, mutant);
  assert.equal(out, 'a\r\nconst ok = a !== b;\r\nc\r\n');
});

// --- production-source filter ------------------------------------------------

test('isProductionSource includes services/renderer/top-level, excludes the rest', () => {
  assert.equal(mut.isProductionSource('services/foo.js'), true);
  assert.equal(mut.isProductionSource('renderer/shell/bar.js'), true);
  assert.equal(mut.isProductionSource('main.js'), true);
  assert.equal(mut.isProductionSource('services/foo.test.js'), false);
  assert.equal(mut.isProductionSource('tests/foo.js'), false);
  assert.equal(mut.isProductionSource('scripts/x.js'), false);
  assert.equal(mut.isProductionSource('vendor/lib.js'), false);
  assert.equal(mut.isProductionSource('renderer/x.min.js'), false);
  assert.equal(mut.isProductionSource('docs/readme.md'), false);
});

// --- source -> test resolution against the real tree -------------------------

test('resolveTestsForSource unions stem and coarse matches for a real renderer source', () => {
  const { tests, source } = mut.resolveTestsForSource('renderer/shell/renderer-view-panel-registry.js', { root: ROOT });
  assert.equal(source, 'stem+coarse-map');
  assert.ok(tests.includes('tests/renderer-view-panel-registry.test.js'), `got ${tests.join(',')}`);
  assert.ok(tests.includes('tests/renderer-shell.test.js'), `got ${tests.join(',')}`);
});

test('resolveTestsForSource preserves exact-file selectors and deduplicates their tests', () => {
  const exact = mut.resolveTestsForSource('services/backend/backend-auth.js', { root: ROOT });
  assert.equal(exact.source, 'stem+coarse-map');
  assert.ok(exact.tests.includes('tests/backend-service-dark-paths.test.js'));
  assert.ok(exact.tests.includes('tests/secure-store.test.js'));
  assert.equal(new Set(exact.tests).size, exact.tests.length);

  const sibling = mut.resolveTestsForSource('services/backend/backend-auth-extra.js', { root: ROOT });
  assert.equal(sibling.source, 'coarse-map');
  assert.equal(sibling.tests.includes('tests/backend-service-dark-paths.test.js'), false);
  assert.equal(sibling.tests.includes('tests/secure-store.test.js'), false);
});

test('resolveTestsForSource returns none when neither stem nor coarse-map matches', () => {
  // A top-level name that matches no stem test and no coarse-map prefix
  // (the coarse map keys on services/ , renderer/ , renderer- , sidecar/...).
  const { tests, source } = mut.resolveTestsForSource('zzz-nonexistent-module.js', { root: ROOT });
  assert.equal(source, 'none');
  assert.deepEqual(tests, []);
});

// --- changed-source discovery ------------------------------------------------

// origin/main must win over local main: on a checkout of main itself the
// local-main merge base is HEAD, so the diff is empty and the sweep is vacuous.
test('collectChangedSources uses origin/main before local main', () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return 'true\n';
    if (args.join(' ') === 'merge-base origin/main HEAD') return 'remote-base\n';
    if (args.join(' ') === 'diff --name-only --diff-filter=ACMR remote-base...HEAD') {
      return 'services/changed.js\n';
    }
    if (args[0] === 'status') return '';
    return null;
  };

  const result = mut.collectChangedSources('C:/repo', { runGit });

  assert.deepEqual(result.sources, ['services/changed.js']);
  assert.equal(calls.some((args) => args.join(' ') === 'merge-base main HEAD'), false);
});

test('collectChangedSources falls back to local main and includes working tree changes', () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return 'true\n';
    if (args.join(' ') === 'merge-base origin/main HEAD') return null;
    if (args.join(' ') === 'merge-base main HEAD') return 'local-base\n';
    if (args.join(' ') === 'diff --name-only --diff-filter=ACMR local-base...HEAD') {
      return 'renderer/committed.js\n';
    }
    if (args[0] === 'status') return ' M services/working.js\n';
    return null;
  };

  const result = mut.collectChangedSources('C:/repo', { runGit });

  assert.deepEqual(result.sources, ['renderer/committed.js', 'services/working.js']);
  assert.equal(calls.some((args) => args.join(' ') === 'merge-base main HEAD'), true);
});

test('collectChangedSources parses committed and working-tree zero-context hunks into changed lines', () => {
  const runGit = (args) => {
    const command = args.join(' ');
    if (args[0] === 'rev-parse') return 'true\n';
    if (command === 'merge-base origin/main HEAD') return 'remote-base\n';
    if (command === 'diff --name-only --diff-filter=ACMR remote-base...HEAD') {
      return 'services/committed.js\n';
    }
    if (command === 'diff --unified=0 --diff-filter=ACMR remote-base...HEAD') {
      return [
        'diff --git a/services/committed.js b/services/committed.js',
        '--- a/services/committed.js',
        '+++ b/services/committed.js',
        '@@ -8 +8,2 @@',
        '+const first = true;',
        '+const second = false;',
      ].join('\n');
    }
    if (command === 'diff --unified=0 --diff-filter=ACMR HEAD') {
      return [
        'diff --git a/renderer/working.js b/renderer/working.js',
        '--- a/renderer/working.js',
        '+++ b/renderer/working.js',
        '@@ -20,2 +21 @@',
        '+const changed = left === right;',
      ].join('\n');
    }
    if (args[0] === 'status') return ' M renderer/working.js\n';
    return null;
  };

  const result = mut.collectChangedSources('C:/repo', { runGit });

  assert.deepEqual(result.sources, ['renderer/working.js', 'services/committed.js']);
  assert.deepEqual([...result.changedLinesBySource.get('services/committed.js')], [8, 9]);
  assert.deepEqual([...result.changedLinesBySource.get('renderer/working.js')], [21]);
});

// --- restore safety guarantee ------------------------------------------------

test('runWithMutation restores exact original bytes even when the run throws', (t) => {
  const dir = makeTempDir(t);
  const file = path.join(dir, 'subject.js');
  const original = Buffer.from('const ok = a === b;\n', 'utf8');
  fs.writeFileSync(file, original);

  assert.throws(() => {
    mut.runWithMutation(file, original, 'const ok = a !== b;\n', () => {
      // Observe the mutation is on disk mid-run, then blow up.
      assert.match(fs.readFileSync(file, 'utf8'), /!==/);
      throw new Error('boom');
    });
  }, /boom/);

  assert.deepEqual(fs.readFileSync(file), original, 'original bytes must be restored after a throw');
});

test('runWithMutation surfaces a CRITICAL error and fails when restore is impossible', (t) => {
  const dir = makeTempDir(t);
  const file = path.join(dir, 'subject.js');
  const original = Buffer.from('const ok = a === b;\n', 'utf8');
  fs.writeFileSync(file, original);

  const prevExitCode = process.exitCode;
  const prevError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    // Destroy the directory mid-run so the finally-restore write hits ENOENT.
    mut.runWithMutation(file, original, 'const ok = a !== b;\n', () => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    assert.ok(errors.some((m) => /CRITICAL/.test(m)), 'must log a CRITICAL restore failure');
    assert.ok(errors.some((m) => /git checkout/.test(m)), 'must point at the git recovery path');
    assert.equal(process.exitCode, 1, 'must fail the process on an unrecoverable restore');
  } finally {
    console.error = prevError;
    // Clear the dangling pendingRestore (points at a now-deleted path) so the
    // process exit guard does not re-fire, and restore the test-process exit code.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, original);
    mut.runWithMutation(file, original, original.toString('utf8'), () => {});
    process.exitCode = prevExitCode;
  }
});

// --- end-to-end acceptance: weak oracle leaves a survivor; strong kills it ----

function writeFixture(dir) {
  const calc = "'use strict';\nfunction isAdult(age) {\n  return age >= 18;\n}\nmodule.exports = { isAdult };\n";
  fs.writeFileSync(path.join(dir, 'calc.js'), calc);
  const weak = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { isAdult } = require('./calc');\ntest('weak', () => { assert.equal(typeof isAdult, 'function'); assert.ok(isAdult(25)); });\n";
  fs.writeFileSync(path.join(dir, 'calc-weak.test.js'), weak);
  const strong = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { isAdult } = require('./calc');\ntest('strong', () => { assert.equal(isAdult(18), true); assert.equal(isAdult(17), false); });\n";
  fs.writeFileSync(path.join(dir, 'calc-strong.test.js'), strong);
  return { calc: path.join(dir, 'calc.js'), weak: path.join(dir, 'calc-weak.test.js'), strong: path.join(dir, 'calc-strong.test.js') };
}

// Hermetic test runner: run node --test on the given files (no safe runner, no git).
// Strip NODE_TEST_CONTEXT so the nested runner does not enter managed-child mode
// (inherited because these self-tests themselves run under `node --test`), which
// would mask the child's pass/fail exit code. The production path avoids this by
// going through the safe runner, which sanitizes child env.
function nodeTestRunner(testFiles) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', ...testFiles], { encoding: 'utf8', timeout: 60000, windowsHide: true, env });
  return { passed: r.status === 0, status: r.status, timedOut: false };
}

test('e2e: a weak oracle lets the >=->> mutant survive', (t) => {
  const dir = makeTempDir(t);
  const fx = writeFixture(dir);
  const original = fs.readFileSync(fx.calc);

  const report = mut.runMutationSmoke({
    sources: [fx.calc],
    root: dir,
    runTests: nodeTestRunner,
    resolveTests: () => ({ tests: [fx.weak], source: 'stem-match' }),
    log: () => {},
  });

  assert.equal(report.totalSurvivors, 1, 'weak oracle should leave exactly one survivor');
  assert.equal(report.files[0].survivors[0].op, 'gte->gt');
  assert.equal(report.files[0].killed, 0);
  assert.deepEqual(fs.readFileSync(fx.calc), original, 'source restored after the run');
});

test('e2e: a strong oracle kills the >=->> mutant (zero survivors)', (t) => {
  const dir = makeTempDir(t);
  const fx = writeFixture(dir);
  const original = fs.readFileSync(fx.calc);

  const report = mut.runMutationSmoke({
    sources: [fx.calc],
    root: dir,
    runTests: nodeTestRunner,
    resolveTests: () => ({ tests: [fx.strong], source: 'stem-match' }),
    log: () => {},
  });

  assert.equal(report.totalSurvivors, 0, 'strong oracle should kill every mutant');
  assert.equal(report.files[0].killed, 1);
  assert.deepEqual(fs.readFileSync(fx.calc), original, 'source restored after the run');
});

test('runMutationSmoke filters to changed lines before applying the per-file cap', (t) => {
  const dir = makeTempDir(t);
  const source = path.join(dir, 'subject.js');
  fs.writeFileSync(source, 'const oldLine = a === b;\nconst changedLine = c === d;\n');
  const observedMutations = [];

  const report = mut.runMutationSmoke({
    sources: [source],
    root: dir,
    changedLinesBySource: new Map([[source, new Set([2])]]),
    maxMutantsPerFile: 1,
    runTests: () => {
      observedMutations.push(fs.readFileSync(source, 'utf8'));
      return { passed: true, status: 0, timedOut: false };
    },
    resolveTests: () => ({ tests: ['subject.test.js'], source: 'stem-match' }),
    log: () => {},
  });

  assert.equal(report.files[0].tested, 1);
  assert.match(observedMutations[1], /const oldLine = a === b;/);
  assert.match(observedMutations[1], /const changedLine = c !== d;/);
});

test('e2e: a baseline-red file is skipped, not falsely reported', (t) => {
  const dir = makeTempDir(t);
  const fx = writeFixture(dir);
  // A test that fails even on the unmutated source -> baseline red.
  const redTest = path.join(dir, 'calc-red.test.js');
  fs.writeFileSync(redTest, "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\ntest('always red', () => { assert.equal(1, 2); });\n");

  const report = mut.runMutationSmoke({
    sources: [fx.calc],
    root: dir,
    runTests: nodeTestRunner,
    resolveTests: () => ({ tests: [redTest], source: 'stem-match' }),
    log: () => {},
  });

  assert.equal(report.files.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /baseline/);
});

// --- arg parsing -------------------------------------------------------------

test('parseArgs surfaces flags and positional sources', () => {
  const opts = mut.parseArgs(['--changed', '--strict', 'services/a.js', '--max-mutants-per-file=20', '--json=r.json']);
  assert.equal(opts.changed, true);
  assert.equal(opts.strict, true);
  assert.equal(opts.maxMutantsPerFile, 20);
  assert.equal(opts.jsonPath, 'r.json');
  assert.deepEqual(opts.sources, ['services/a.js']);
});

test('help distinguishes changed-line mode from positional whole-file mutation', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'mutation-smoke.js'), '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--changed[^\n]*changed lines/i);
  assert.match(result.stdout, /positional[^\n]*whole files/i);
});
