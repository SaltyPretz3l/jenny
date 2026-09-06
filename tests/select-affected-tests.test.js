'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'select-affected-tests.js');
const sel = require('../scripts/select-affected-tests');

// --- computeAffectedPlan: pure logic, fully injected fakes ------------------

test('all changed sources map (stem, coarse, or combined) -> affected with separate counts', () => {
  const fakeCollect = () => ({
    sources: ['services/a.js', 'renderer/b.js', 'services/c.js'],
    reason: null,
  });
  const fakeResolve = (relSource) => {
    if (relSource === 'services/a.js') return { tests: ['tests/a.test.js', 'tests/shared.test.js'], source: 'stem+coarse-map' };
    if (relSource === 'renderer/b.js') return { tests: ['tests/shared.test.js'], source: 'coarse-map' };
    if (relSource === 'services/c.js') return { tests: ['tests/c.test.js'], source: 'stem-match' };
    throw new Error(`unexpected source ${relSource}`);
  };

  const plan = sel.computeAffectedPlan(
    { root: ROOT },
    { collectChangedSources: fakeCollect, resolveTestsForSource: fakeResolve }
  );

  assert.equal(plan.mode, 'affected');
  // deduped, first-seen order
  assert.deepEqual(plan.tests, ['tests/a.test.js', 'tests/shared.test.js', 'tests/c.test.js']);
  assert.equal(plan.mappedCount, 3);
  assert.equal(plan.stemCount, 1);
  assert.equal(plan.coarseCount, 1);
  assert.equal(plan.combinedCount, 1);
  assert.deepEqual(plan.unmappedSources, []);
  assert.equal(plan.fallbackReason, null);
  assert.equal(plan.bannerLine, '[affected] 3 sources -> 3 tests (stem:1 coarse:1 combined:1)');
});

test('one changed source unmapped -> mode fallback, reason mentions the unmapped source', () => {
  const fakeCollect = () => ({
    sources: ['services/a.js', 'services/mystery.js'],
    reason: null,
  });
  const fakeResolve = (relSource) => {
    if (relSource === 'services/a.js') return { tests: ['tests/a.test.js'], source: 'stem-match' };
    return { tests: [], source: 'none' };
  };

  const plan = sel.computeAffectedPlan(
    { root: ROOT },
    { collectChangedSources: fakeCollect, resolveTestsForSource: fakeResolve }
  );

  assert.equal(plan.mode, 'fallback');
  assert.deepEqual(plan.unmappedSources, ['services/mystery.js']);
  assert.match(plan.fallbackReason, /services\/mystery\.js/);
  assert.match(plan.bannerLine, /falling back to stable lane/);
  assert.match(plan.bannerLine, /1 unmapped/);
});

test('zero changed sources -> mode fallback', () => {
  const fakeCollect = () => ({ sources: [], reason: null });
  const fakeResolve = () => {
    throw new Error('should not be called with zero sources');
  };

  const plan = sel.computeAffectedPlan(
    { root: ROOT },
    { collectChangedSources: fakeCollect, resolveTestsForSource: fakeResolve }
  );

  assert.equal(plan.mode, 'fallback');
  assert.equal(plan.tests.length, 0);
  assert.equal(plan.combinedCount, 0);
  assert.match(plan.fallbackReason, /no changed sources/);
  assert.equal(plan.bannerLine, '[affected] 0 sources -> falling back to stable lane');
});

test('git unavailable (non-null reason) -> mode fallback, reason mentions git', () => {
  const fakeCollect = () => ({ sources: [], reason: 'git unavailable (not a work tree)' });
  const fakeResolve = () => {
    throw new Error('should not be called when git is unavailable');
  };

  const plan = sel.computeAffectedPlan(
    { root: ROOT },
    { collectChangedSources: fakeCollect, resolveTestsForSource: fakeResolve }
  );

  assert.equal(plan.mode, 'fallback');
  assert.equal(plan.combinedCount, 0);
  assert.match(plan.fallbackReason, /git unavailable/);
  assert.equal(plan.bannerLine, '[affected] git unavailable -> falling back to stable lane');
});

// --- source admission: JS production sources plus sidecar python -------------

test('isAffectedSource admits JS production sources and sidecar/**/*.py, rejects the rest', () => {
  assert.equal(sel.isAffectedSource('services/feature-flags.js'), true);
  assert.equal(sel.isAffectedSource('renderer/chat/chat-thinking-utils.js'), true);
  assert.equal(sel.isAffectedSource('sidecar/runtime/approval.py'), true);
  assert.equal(sel.isAffectedSource('sidecar\\runtime\\approval.py'), true);
  assert.equal(sel.isAffectedSource('sidecar/ai/memory/store.py'), true);
  // non-python sidecar files and non-source trees stay out
  assert.equal(sel.isAffectedSource('sidecar/runtime/README.md'), false);
  assert.equal(sel.isAffectedSource('tests/sidecar/test_server.py'), false);
  assert.equal(sel.isAffectedSource('scripts/select-affected-tests.js'), false);
  // ...but a script the changed-target map names IS affected, end to end.
  const runGit = (args) => {
    if (args[0] === 'rev-parse') return 'true\n';
    if (args[0] === 'merge-base') return 'base\n';
    if (args.includes('--name-only')) return 'scripts/uninstall.js\n';
    if (args[0] === 'diff') return '';
    if (args[0] === 'status') return '';
    return null;
  };
  const found = require('../scripts/mutation-smoke').collectChangedSources(ROOT, {
    runGit,
    mergeBaseRefs: ['main'],
    sourceFilter: sel.isAffectedSource,
  });
  const plan = sel.computeAffectedPlan(
    { root: ROOT },
    { collectChangedSources: () => found }
  );
  assert.deepEqual(found.sources, ['scripts/uninstall.js']);
  assert.equal(plan.mode, 'affected');
  assert.ok(plan.tests.includes('tests/uninstall-script.test.js'));
  assert.equal(sel.isAffectedSource('docs/manifests/README.md'), false);
});

// --- lane partitioning: node vs pytest ---------------------------------------

test('partitionTests splits *.py into the python lane and everything else into the node lane', () => {
  const { nodeTests, pyTests } = sel.partitionTests([
    'tests/a.test.js',
    'tests/sidecar/runtime/test_capabilities.py',
    'tests/b.test.js',
    'tests/sidecar/test_server.py',
  ]);
  assert.deepEqual(nodeTests, ['tests/a.test.js', 'tests/b.test.js']);
  assert.deepEqual(pyTests, [
    'tests/sidecar/runtime/test_capabilities.py',
    'tests/sidecar/test_server.py',
  ]);
});

test('buildLanePlan (affected, mixed) -> node runner args plus pytest -q args', () => {
  const lanes = sel.buildLanePlan({
    mode: 'affected',
    tests: ['tests/a.test.js', 'tests/sidecar/runtime/test_capabilities.py'],
  });
  assert.deepEqual(lanes.nodeArgs, ['tests/a.test.js', '--timeout-ms=600000']);
  assert.deepEqual(lanes.pytestArgs, ['-m', 'pytest', '-q', 'tests/sidecar/runtime/test_capabilities.py']);
});

test('buildLanePlan (affected, python-only) -> node lane is null, pytest lane runs', () => {
  const lanes = sel.buildLanePlan({
    mode: 'affected',
    tests: ['tests/sidecar/test_server.py', 'tests/sidecar/test_approval.py'],
  });
  assert.equal(lanes.nodeArgs, null);
  assert.deepEqual(lanes.pytestArgs, [
    '-m', 'pytest', '-q',
    'tests/sidecar/test_server.py',
    'tests/sidecar/test_approval.py',
  ]);
});

test('buildLanePlan (affected, node-only) -> pytest lane is null', () => {
  const lanes = sel.buildLanePlan({ mode: 'affected', tests: ['tests/a.test.js'] });
  assert.deepEqual(lanes.nodeArgs, ['tests/a.test.js', '--timeout-ms=600000']);
  assert.equal(lanes.pytestArgs, null);
});

test('buildLanePlan (fallback) -> stable node lane only, no pytest lane', () => {
  const lanes = sel.buildLanePlan({ mode: 'fallback', tests: [] });
  assert.deepEqual(lanes.nodeArgs, ['tests/', '--parallel-only', '--timeout-ms=600000']);
  assert.equal(lanes.pytestArgs, null);
});

// --- subprocess-level smoke (real repo git state; loose assertions) ---------

test('CLI --dry-run exits 0 and prints the [affected] banner against the real repo', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[affected\]/);
  assert.ok(
    /sources ->/.test(result.stdout) || /falling back/.test(result.stdout),
    `expected stdout to mention "sources ->" or "falling back", got:\n${result.stdout}`
  );
});
