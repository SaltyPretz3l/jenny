'use strict';

/* Beginner-friendly branch switcher + gentle git guardrails. Two layers:
 *   (1) pure decision helpers — dirty-tree guard choice, create-branch name
 *       validation, ahead/behind + guard label formatting, error de-jargoning;
 *   (2) the op flows driven through the exposed programmatic methods with fake
 *       git client + confirm dialog (no DOM) — switch (clean / dirty-guard /
 *       cancel), create, undo-last-commit, shelve / restore, palette items.
 * The overlay/DOM path is covered by the real-app CDP smoke (jsdom can't drive
 * the picker + git). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../renderer/features/renderer-ide-branch-switcher');
const {
  createIdeBranchSwitcher,
  needsDirtyGuard,
  formatDirtyGuardMessage,
  formatAheadBehindHint,
  validateNewBranchName,
  buildBranchRows,
  describeGitError,
} = mod;

// --- Pure helpers ------------------------------------------------------------

test('needsDirtyGuard: only a non-empty working tree triggers the guard', () => {
  assert.equal(needsDirtyGuard(0), false);
  assert.equal(needsDirtyGuard(), false);
  assert.equal(needsDirtyGuard(1), true);
  assert.equal(needsDirtyGuard(7), true);
});

test('formatDirtyGuardMessage: computed, pluralized count', () => {
  assert.equal(formatDirtyGuardMessage(1), 'You have 1 uncommitted change.');
  assert.equal(formatDirtyGuardMessage(3), 'You have 3 uncommitted changes.');
  assert.equal(formatDirtyGuardMessage(0), 'You have 0 uncommitted changes.');
});

test('formatAheadBehindHint: calm hint, empty when level/unknown', () => {
  assert.equal(formatAheadBehindHint(0, 0), '');
  assert.equal(formatAheadBehindHint(1, 0), '1 commit ahead of the remote.');
  assert.equal(formatAheadBehindHint(2, 0), '2 commits ahead of the remote.');
  assert.equal(formatAheadBehindHint(0, 1), '1 commit behind the remote.');
  assert.equal(formatAheadBehindHint(0, 3), '3 commits behind the remote.');
  assert.equal(formatAheadBehindHint(2, 3), '2 ahead, 3 behind the remote.');
});

test('validateNewBranchName: accepts safe names, rejects the common mistakes', () => {
  assert.equal(validateNewBranchName('feature/login', []).ok, true);
  assert.equal(validateNewBranchName('fix-123', []).ok, true);
  assert.equal(validateNewBranchName('  spaced.name  ', []).value, 'spaced.name');

  // empty
  assert.equal(validateNewBranchName('', []).ok, false);
  assert.match(validateNewBranchName('   ', []).error, /Type a name/);
  // spaces
  const spaced = validateNewBranchName('my feature', []);
  assert.equal(spaced.ok, false);
  assert.match(spaced.error, /can’t contain spaces/);
  // duplicate
  const dup = validateNewBranchName('main', ['main', 'dev']);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already exists/);
  // shape violations (mirror branchNameIsSafe)
  for (const bad of ['-lead', '/lead', 'trail/', 'a..b', 'a//b', 'a@{b', 'end.', 'thing.lock', 'a\\b', '.dot']) {
    assert.equal(validateNewBranchName(bad, []).ok, false, `${bad} should be rejected`);
  }
});

test('buildBranchRows: marks current, filters/sorts by query', () => {
  const branches = ['main', 'feature/login', 'fix/bug'];
  const all = buildBranchRows(branches, 'main', '', null);
  assert.deepEqual(all.map((r) => r.name), branches);
  assert.equal(all.find((r) => r.name === 'main').isCurrent, true);
  assert.equal(all.find((r) => r.name === 'fix/bug').isCurrent, false);

  // substring fallback (no scorer)
  const filtered = buildBranchRows(branches, 'main', 'fix', null);
  assert.deepEqual(filtered.map((r) => r.name), ['fix/bug']);

  // with a scorer: higher score sorts first
  const scorer = (text, q) => (text.includes(q) ? { score: text === 'fix/bug' ? 10 : 1, ranges: [] } : null);
  const scored = buildBranchRows(branches, 'main', 'i', scorer);
  assert.equal(scored[0].name, 'fix/bug');
});

test('describeGitError: de-jargons availability + conflict, else passes message', () => {
  assert.match(describeGitError({ available: false }, 'x'), /isn’t available/);
  assert.match(
    describeGitError({ available: true, message: 'Your local changes would be overwritten by checkout' }, 'x'),
    /conflict/
  );
  assert.equal(describeGitError({ available: true, message: 'boom' }, 'fallback'), 'boom');
  assert.equal(describeGitError({ available: true, message: '' }, 'fallback'), 'fallback');
});

// --- Op flows (fake client + confirm dialog, no DOM) -------------------------

function makeGitClient(overrides = {}) {
  const calls = [];
  const wrap = (name, fallback) => async (payload) => {
    calls.push([name, payload]);
    const impl = overrides[name];
    return typeof impl === 'function' ? impl(payload) : (impl || fallback);
  };
  return {
    calls,
    getBranches: wrap('getBranches', { ok: true, branches: ['main', 'feature'], current: 'main' }),
    checkout: wrap('checkout', { ok: true }),
    stash: wrap('stash', { ok: true, stashed: true }),
    undoLastCommit: wrap('undoLastCommit', { ok: true, undone: true }),
  };
}

function makeSwitcher(opts = {}) {
  const toasts = [];
  const errors = [];
  let refreshed = 0;
  const gitClient = opts.gitClient || makeGitClient(opts.clientOverrides);
  const confirmDialog = opts.confirmDialog || {
    confirmBranchSwitch: async () => (opts.guardChoice || 'cancel'),
    confirm: async () => (opts.confirm !== false),
  };
  const sw = createIdeBranchSwitcher({
    getDom: () => ({}),
    gitClient,
    confirmDialog,
    showToastMessage: (message) => toasts.push(String(message)),
    showShellErrorToast: (message) => errors.push(String(message)),
    callbacks: {
      getCurrentBranch: () => (opts.currentBranch || 'main'),
      getDirtyCount: () => (opts.dirtyCount || 0),
      isRepo: () => (opts.isRepo !== false),
      isAvailable: () => (opts.isAvailable !== false),
      refreshGit: () => { refreshed += 1; return Promise.resolve(); },
    },
  });
  return { sw, gitClient, toasts, errors, getRefreshed: () => refreshed };
}

function callsTo(gitClient, name) {
  return gitClient.calls.filter(([op]) => op === name);
}

test('switchToBranch (clean tree): checks out directly, refreshes, toasts', async () => {
  const ctx = makeSwitcher({ dirtyCount: 0 });
  await ctx.sw.switchToBranch('feature');
  assert.deepEqual(callsTo(ctx.gitClient, 'checkout'), [['checkout', { ref: 'feature' }]]);
  assert.equal(callsTo(ctx.gitClient, 'stash').length, 0, 'no stash on a clean tree');
  assert.equal(ctx.getRefreshed(), 1);
  assert.ok(ctx.toasts.some((m) => /Switched to/.test(m)));
});

test('switchToBranch (dirty + Shelve & switch): stashes then checks out', async () => {
  const ctx = makeSwitcher({ dirtyCount: 2, guardChoice: 'shelve' });
  await ctx.sw.switchToBranch('feature');
  assert.equal(callsTo(ctx.gitClient, 'stash')[0][1].op, 'push');
  assert.deepEqual(callsTo(ctx.gitClient, 'checkout'), [['checkout', { ref: 'feature' }]]);
  assert.ok(ctx.toasts.some((m) => /shelved/i.test(m)));
});

test('switchToBranch (dirty + Switch anyway): checks out without stashing', async () => {
  const ctx = makeSwitcher({ dirtyCount: 2, guardChoice: 'switch' });
  await ctx.sw.switchToBranch('feature');
  assert.equal(callsTo(ctx.gitClient, 'stash').length, 0);
  assert.deepEqual(callsTo(ctx.gitClient, 'checkout'), [['checkout', { ref: 'feature' }]]);
});

test('switchToBranch (dirty + Cancel): does nothing', async () => {
  const ctx = makeSwitcher({ dirtyCount: 2, guardChoice: 'cancel' });
  await ctx.sw.switchToBranch('feature');
  assert.equal(ctx.gitClient.calls.length, 0, 'no git ops on cancel');
});

test('switchToBranch to the current branch is a no-op', async () => {
  const ctx = makeSwitcher({ currentBranch: 'main', dirtyCount: 0 });
  await ctx.sw.switchToBranch('main');
  assert.equal(callsTo(ctx.gitClient, 'checkout').length, 0);
});

test('switchToBranch surfaces a checkout failure as an error toast', async () => {
  const ctx = makeSwitcher({ dirtyCount: 0, clientOverrides: { checkout: { ok: false, available: true, message: 'nope' } } });
  await ctx.sw.switchToBranch('feature');
  assert.equal(ctx.toasts.length, 0);
  assert.ok(ctx.errors.some((m) => /nope/.test(m)));
});

test('undoLastCommit: confirmed + undone refreshes and reassures', async () => {
  const ctx = makeSwitcher({ confirm: true });
  await ctx.sw.undoLastCommit();
  assert.equal(callsTo(ctx.gitClient, 'undoLastCommit').length, 1);
  assert.equal(ctx.getRefreshed(), 1);
  assert.ok(ctx.toasts.some((m) => /undone/i.test(m)));
});

test('undoLastCommit: declined does nothing', async () => {
  const ctx = makeSwitcher({ confirm: false });
  await ctx.sw.undoLastCommit();
  assert.equal(ctx.gitClient.calls.length, 0);
});

test('undoLastCommit: no prior commit gives a gentle info toast', async () => {
  const ctx = makeSwitcher({ confirm: true, clientOverrides: { undoLastCommit: { ok: true, undone: false } } });
  await ctx.sw.undoLastCommit();
  assert.ok(ctx.toasts.some((m) => /no commit to undo/i.test(m)));
});

test('shelveChanges / restoreShelved: push + pop with friendly empty states', async () => {
  const shelve = makeSwitcher({ confirm: true });
  await shelve.sw.shelveChanges();
  assert.equal(callsTo(shelve.gitClient, 'stash')[0][1].op, 'push');
  assert.ok(shelve.toasts.some((m) => /shelved/i.test(m)));

  const nothing = makeSwitcher({ confirm: true, clientOverrides: { stash: { ok: true, stashed: false } } });
  await nothing.sw.shelveChanges();
  assert.ok(nothing.toasts.some((m) => /no changes to shelve/i.test(m)));

  const restore = makeSwitcher({ confirm: true });
  await restore.sw.restoreShelved();
  assert.equal(callsTo(restore.gitClient, 'stash')[0][1].op, 'pop');
  assert.ok(restore.toasts.some((m) => /restored/i.test(m)));
});

test('getCommandItems: 5 Workspace git items in a repo, [] otherwise', () => {
  const inRepo = makeSwitcher({ isRepo: true });
  const items = inRepo.sw.getCommandItems();
  assert.deepEqual(
    items.map((i) => i.id),
    ['ide:git-switch-branch', 'ide:git-create-branch', 'ide:git-undo-last-commit', 'ide:git-shelve-changes', 'ide:git-restore-shelved']
  );
  assert.ok(items.every((i) => i.group === 'Workspace' && typeof i.run === 'function'));

  const noRepo = makeSwitcher({ isRepo: false });
  assert.deepEqual(noRepo.sw.getCommandItems(), []);

  const unavailable = makeSwitcher({ isRepo: true, isAvailable: false });
  assert.deepEqual(unavailable.sw.getCommandItems(), [], 'an unavailable Git backend exposes no commands');
});

test('switchToBranch (dirty) passes the static guard headline to the confirm dialog', async () => {
  let captured = null;
  const confirmDialog = {
    confirmBranchSwitch: async (payload) => { captured = payload; return 'cancel'; },
    confirm: async () => true,
  };
  const ctx = makeSwitcher({ dirtyCount: 3, confirmDialog });
  await ctx.sw.switchToBranch('feature');
  assert.equal(captured.count, 3);
  // formatDirtyGuardMessage is the single live source of the headline.
  assert.equal(captured.message, 'You have 3 uncommitted changes.');
});

test('switchToBranch (dirty + shelve): reassures when the checkout fails AFTER stashing', async () => {
  const ctx = makeSwitcher({
    dirtyCount: 2,
    guardChoice: 'shelve',
    clientOverrides: {
      stash: { ok: true, stashed: true },
      checkout: { ok: false, available: true, message: 'would be overwritten by checkout' },
    },
  });
  await ctx.sw.switchToBranch('feature');
  assert.equal(callsTo(ctx.gitClient, 'stash')[0][1].op, 'push');
  assert.ok(ctx.errors.some((m) => /shelved/i.test(m)), 'tells the user their work is safely shelved');
});

test('restoreShelved: nothing to restore gives a gentle info toast', async () => {
  const ctx = makeSwitcher({ confirm: true, clientOverrides: { stash: { ok: true, stashed: false } } });
  await ctx.sw.restoreShelved();
  assert.equal(callsTo(ctx.gitClient, 'stash')[0][1].op, 'pop');
  assert.ok(ctx.toasts.some((m) => /no shelved changes/i.test(m)));
});

test('a busy switcher notifies instead of silently dropping a second action', async () => {
  // A checkout that never resolves keeps busy=true for the duration.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = makeSwitcher({ dirtyCount: 0, clientOverrides: { checkout: () => gate } });
  const first = ctx.sw.switchToBranch('feature'); // takes the busy lock
  await ctx.sw.switchToBranch('other');           // rejected with a notice
  assert.ok(ctx.toasts.some((m) => /finishing the last git action/i.test(m)));
  assert.equal(callsTo(ctx.gitClient, 'checkout').length, 1, 'the second switch did not start a checkout');
  release({ ok: true });
  await first;
});

test('destructive confirmation reserves the busy lock before the dialog settles', async () => {
  const confirmations = [];
  let releaseGit;
  const ctx = makeSwitcher({
    confirmDialog: {
      confirmBranchSwitch: async () => 'cancel',
      confirm: () => new Promise((resolve) => confirmations.push(resolve)),
    },
    clientOverrides: {
      undoLastCommit: () => new Promise((resolve) => { releaseGit = resolve; }),
    },
  });

  const first = ctx.sw.undoLastCommit();
  await Promise.resolve();
  const second = ctx.sw.undoLastCommit();
  await Promise.resolve();

  assert.equal(confirmations.length, 1, 'the second action cannot open another confirmation');
  assert.ok(ctx.toasts.some((message) => /finishing the last git action/i.test(message)));
  confirmations[0](true);
  while (!releaseGit) await Promise.resolve();
  releaseGit({ ok: true, undone: true });
  await Promise.all([first, second]);
  assert.equal(callsTo(ctx.gitClient, 'undoLastCommit').length, 1);
});

// --- Render-path tests (jsdom): the one invariant this feature must never lose
// is that branch names are HTML-escaped, since git ref names may legally contain
// '<' '>' '"' '&'. Also covers the calm ahead/behind hint wiring.

function withStage(run) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="stage"></div></body>');
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  return Promise.resolve()
    .then(() => run(dom.window.document.getElementById('stage')))
    .finally(() => { globalThis.window = prevWindow; });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('branch names with HTML-significant chars are escaped in the rendered picker', async () => {
  await withStage(async (stage) => {
    const evil = 'feat/<xss>"&t';
    // The pure helper keeps the raw name; escaping is a render-time concern.
    assert.equal(buildBranchRows([evil], 'main', '', null)[0].name, evil);
    const sw = createIdeBranchSwitcher({
      getDom: () => ({ ideEditorStage: stage }),
      gitClient: makeGitClient({ getBranches: { ok: true, branches: [evil, 'main'], current: 'main' } }),
      callbacks: { getCurrentBranch: () => 'main', isRepo: () => true },
    });
    sw.open();
    await tick();
    // THE invariant: the name never becomes markup. If it were rendered
    // unescaped, parsing the row would create an <xss> element. (Serialized
    // innerHTML keeps '<' literal inside quoted attribute values per the HTML
    // spec — safe — so assert against the parsed DOM, not the HTML string.)
    assert.equal(stage.querySelector('xss'), null, 'no element is created from the branch name');
    const row = stage.querySelector('[data-ide-branch-picker] [data-branch-name]');
    assert.equal(row.getAttribute('data-branch-name'), evil, 'the raw name is preserved for selection');
    assert.equal(
      row.querySelector('.ide-quick-open-name').textContent,
      evil,
      'the name renders as text, not markup'
    );
    sw.dispose();
  });
});

test('the picker shows a calm ahead/behind hint for the current branch', async () => {
  await withStage(async (stage) => {
    const sw = createIdeBranchSwitcher({
      getDom: () => ({ ideEditorStage: stage }),
      gitClient: makeGitClient({ getBranches: { ok: true, branches: ['main'], current: 'main' } }),
      callbacks: {
        getCurrentBranch: () => 'main',
        isRepo: () => true,
        getAheadBehind: () => ({ ahead: 2, behind: 0 }),
      },
    });
    sw.open();
    await tick();
    const html = stage.querySelector('[data-ide-branch-picker]').innerHTML;
    assert.match(html, /2 commits ahead of the remote/);
    sw.dispose();
  });
});
