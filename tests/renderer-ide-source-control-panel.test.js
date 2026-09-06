'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeSourceControlPanel } = require('../renderer/features/renderer-ide-source-control-panel');
const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Fresh snapshot per test (mutated by the fake onCommit to model the store
// refresh that drops staged files after a successful commit).
function repo() {
  return {
    available: true,
    isRepo: true,
    branch: 'main',
    files: [
      { path: 'src/a.js', state: 'modified', staged: false, worktree: 'M', index: ' ' },
      { path: 'new.txt', state: 'untracked', staged: false, worktree: '?', index: ' ' },
      { path: 'staged.js', state: 'modified', staged: true, worktree: ' ', index: 'M' },
    ],
  };
}

function setup(snapshot, opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="ideRailPanel"></div></body>');
  const doc = dom.window.document;
  const panelEl = doc.getElementById('ideRailPanel');
  const calls = { stage: [], unstage: [], stageAll: [], discard: [], delete: [], diff: [], commit: [], getDiff: 0, write: [] };
  const store = { getSnapshot: () => snapshot };
  const deps = {
    getDom: () => ({ ideRailPanel: panelEl }),
    getIde: () => ({ railPanel: opts.railPanel || 'source-control' }),
    actionButton,
    textField,
    store,
    onStage: (paths) => calls.stage.push(paths),
    onUnstage: (paths) => calls.unstage.push(paths),
    onStageAll: (paths) => calls.stageAll.push(paths),
    onDiscard: (path) => calls.discard.push(path),
    onDelete: (path) => calls.delete.push(path),
    onOpenDiff: (path) => calls.diff.push(path),
    onCommit: typeof opts.onCommit === 'function'
      ? (message) => opts.onCommit(message, { calls, snapshot })
      : async (message) => {
        calls.commit.push(message);
        const result = opts.commitResult || { committed: true };
        if (result.committed === true) {
          // Model the store refresh: committed (staged) files leave the list.
          snapshot.files = snapshot.files.filter((file) => !file.staged);
        }
        return result;
      },
  };
  if (!opts.noWrite) {
    deps.onGetDiff = async () => {
      calls.getDiff += 1;
      return opts.diff !== undefined
        ? opts.diff
        : { ok: true, diff: 'diff --git a/staged.js b/staged.js\n+hello' };
    };
    deps.onWriteMessage = async (diff) => {
      calls.write.push(diff);
      if (opts.writeThrows) {
        throw new Error('model boom');
      }
      return opts.generated !== undefined ? opts.generated : 'feat: add staged feature';
    };
  }
  const panel = createIdeSourceControlPanel(deps);
  panel.bindEvents();
  panel.renderSourceControlPanel();
  return { dom, doc, panelEl, panel, calls };
}

test('renders Changed and Ready to commit groups with the right per-row actions', () => {
  const { panelEl } = setup(repo());
  assert.match(panelEl.textContent, /Ready to commit/);
  assert.match(panelEl.textContent, /Changed/);

  const stagedRow = panelEl.querySelector('[data-ide-scm-path="staged.js"]');
  const unstage = stagedRow.querySelector('[data-ide-scm-action="unstage"]');
  assert.ok(unstage, 'staged row has Unstage');
  assert.equal(unstage.title, 'Remove this file from the next commit');
  assert.equal(stagedRow.querySelector('[data-ide-scm-action="discard"]'), null, 'staged row has no Discard');

  const aRow = panelEl.querySelector('[data-ide-scm-path="src/a.js"]');
  assert.ok(aRow.querySelector('[data-ide-scm-action="stage"]'), 'changed row has Stage');
  assert.ok(aRow.querySelector('[data-ide-scm-action="discard"]'), 'changed row has Discard');
  assert.equal(aRow.querySelector('[data-ide-scm-action="stage"]').title, 'Stage this file for commit');
  assert.equal(aRow.querySelector('[data-ide-scm-action="discard"]').title, 'Discard changes to this file (cannot be undone)');
  assert.ok(aRow.querySelector('[data-ide-scm-action="diff"]'), 'changed row has open-diff');
  const newRow = panelEl.querySelector('[data-ide-scm-path="new.txt"]');
  assert.ok(newRow.querySelector('[data-ide-scm-action="delete"]'), 'untracked row has Delete');
  assert.equal(newRow.querySelector('[data-ide-scm-action="delete"]').title, 'Move this untracked file to the recycle bin');
  assert.equal(newRow.querySelector('[data-ide-scm-action="discard"]'), null, 'untracked row never offers tracked-file Discard');
});

// UIUX-032: getStatus's own 8MB execFile-buffer truncation used to be dropped
// silently between the store and the panel. The panel must surface it as
// explicit partial-status metadata, not render a seemingly-complete list.
test('a backend-truncated status shows an explicit partial-status notice', () => {
  const snapshot = repo();
  snapshot.truncated = true;
  snapshot.droppedBytes = 12345;
  const { panelEl } = setup(snapshot);
  assert.match(panelEl.textContent, /truncated|partial|large working tree/i);
});

test('a clean (non-truncated) status shows no partial-status notice', () => {
  const { panelEl } = setup(repo());
  assert.doesNotMatch(panelEl.textContent, /truncated|partial status/i);
});

// UIUX-032: "bound the render" — a pathological dirty tree must not hand the
// panel an unbounded files array to paint one DOM row per file. The panel
// renders off snapshot.panelFiles (the store's capped, render-facing view)
// when present, and surfaces how many were omitted.
test('renders off the capped panelFiles list and shows an omitted-count notice', () => {
  const snapshot = repo();
  snapshot.panelFiles = [snapshot.files[0]]; // only src/a.js survives the cap
  snapshot.panelFilesOmitted = 2;
  const { panelEl } = setup(snapshot);
  assert.ok(panelEl.querySelector('[data-ide-scm-path="src/a.js"]'), 'the panel-facing file is rendered');
  assert.equal(panelEl.querySelector('[data-ide-scm-path="new.txt"]'), null, 'a file outside the cap is not rendered');
  assert.match(panelEl.textContent, /2 more/i);
});

test('falls back to the full files list when panelFiles is absent (raw snapshot fixtures)', () => {
  const { panelEl } = setup(repo());
  assert.ok(panelEl.querySelector('[data-ide-scm-path="src/a.js"]'));
  assert.ok(panelEl.querySelector('[data-ide-scm-path="new.txt"]'));
  assert.ok(panelEl.querySelector('[data-ide-scm-path="staged.js"]'));
});

test('row actions and Stage All route to the right callbacks', () => {
  const { panelEl, calls } = setup(repo());
  panelEl.querySelector('[data-ide-scm-path="src/a.js"] [data-ide-scm-action="stage"]').click();
  panelEl.querySelector('[data-ide-scm-path="staged.js"] [data-ide-scm-action="unstage"]').click();
  panelEl.querySelector('[data-ide-scm-path="src/a.js"] [data-ide-scm-action="discard"]').click();
  panelEl.querySelector('[data-ide-scm-path="new.txt"] [data-ide-scm-action="delete"]').click();
  panelEl.querySelector('[data-ide-scm-path="new.txt"] [data-ide-scm-action="diff"]').click();
  panelEl.querySelector('[data-ide-scm-action="stage-all"]').click();

  assert.deepEqual(calls.stage, [['src/a.js']]);
  assert.deepEqual(calls.unstage, [['staged.js']]);
  assert.deepEqual(calls.discard, ['src/a.js']);
  assert.deepEqual(calls.delete, ['new.txt']);
  assert.deepEqual(calls.diff, ['new.txt']);
  assert.deepEqual(calls.stageAll, [['src/a.js', 'new.txt']]);
});

test('commit with a message calls onCommit and clears the field', async () => {
  const { panelEl, calls } = setup(repo());
  const input = panelEl.querySelector('[data-ide-scm-input="commit"]');
  input.value = 'ship it';
  input.dispatchEvent(new panelEl.ownerDocument.defaultView.Event('input', { bubbles: true }));
  panelEl.querySelector('[data-ide-scm-action="commit"]').click();
  await settle();
  assert.deepEqual(calls.commit, ['ship it']);
  const inputAfter = panelEl.querySelector('[data-ide-scm-input="commit"]');
  assert.equal(inputAfter.value, '', 'message cleared after commit');
});

test('commit ignores duplicate activation while the git write is in flight', async () => {
  let resolveCommit;
  const { panelEl, calls } = setup(repo(), {
    onCommit: (message, ctx) => {
      ctx.calls.commit.push(message);
      return new Promise((resolve) => {
        resolveCommit = () => {
          ctx.snapshot.files = ctx.snapshot.files.filter((file) => !file.staged);
          resolve({ committed: true });
        };
      });
    },
  });
  const input = panelEl.querySelector('[data-ide-scm-input="commit"]');
  input.value = 'ship it once';
  input.dispatchEvent(new panelEl.ownerDocument.defaultView.Event('input', { bubbles: true }));

  panelEl.querySelector('[data-ide-scm-action="commit"]').click();
  panelEl.querySelector('[data-ide-scm-action="commit"]').click();
  await settle();

  assert.deepEqual(calls.commit, ['ship it once'], 'the second click does not issue a second commit');
  assert.ok(panelEl.querySelector('[data-ide-scm-action="commit"]').hasAttribute('disabled'), 'button disabled while committing');
  resolveCommit();
  await settle();
  assert.equal(panelEl.querySelector('[data-ide-scm-input="commit"]').value, '', 'message cleared after commit settles');
});

test('the committing latch drops a re-entrant commit even when the button is re-enabled mid-write', async () => {
  // The disabled attribute is UI feedback; the JS `committing` flag is the actual
  // double-fire guard (it must survive a store-driven re-render). The prior test
  // leans on jsdom refusing to dispatch a click on a disabled button, so it would
  // still pass with the guard removed. Here we force the button back to enabled --
  // as a racing re-render could -- so ONLY the JS latch can stop the second commit.
  let resolveCommit;
  const { panelEl, calls } = setup(repo(), {
    onCommit: (message, ctx) => {
      ctx.calls.commit.push(message);
      return new Promise((resolve) => {
        resolveCommit = () => {
          ctx.snapshot.files = ctx.snapshot.files.filter((file) => !file.staged);
          resolve({ committed: true });
        };
      });
    },
  });
  const input = panelEl.querySelector('[data-ide-scm-input="commit"]');
  input.value = 'ship it once';
  input.dispatchEvent(new panelEl.ownerDocument.defaultView.Event('input', { bubbles: true }));

  panelEl.querySelector('[data-ide-scm-action="commit"]').click();
  await settle();
  assert.deepEqual(calls.commit, ['ship it once'], 'the first activation issues the commit');

  const btn = panelEl.querySelector('[data-ide-scm-action="commit"]');
  btn.removeAttribute('disabled'); // simulate the button becoming clickable again mid-write
  btn.click();
  await settle();

  assert.deepEqual(calls.commit, ['ship it once'], 'the committing latch drops the second commit while the first is pending');

  resolveCommit();
  await settle();
  assert.equal(panelEl.querySelector('[data-ide-scm-input="commit"]').value, '', 'message cleared after commit settles');
});

test('a failed commit keeps the typed message and surfaces a hint (no silent clear)', async () => {
  // A git failure degrades to { ok:false } with no committed field (e.g.
  // CMP-GIT-0040 when git identity isn't configured).
  const { panelEl, calls } = setup(repo(), { commitResult: { ok: false, error_code: 'CMP-GIT-0040' } });
  const input = panelEl.querySelector('[data-ide-scm-input="commit"]');
  input.value = 'my hard work';
  input.dispatchEvent(new panelEl.ownerDocument.defaultView.Event('input', { bubbles: true }));
  panelEl.querySelector('[data-ide-scm-action="commit"]').click();
  await settle();
  assert.deepEqual(calls.commit, ['my hard work'], 'commit was attempted');
  assert.match(panelEl.textContent, /Could not commit/, 'failure hint shown');
  assert.equal(
    panelEl.querySelector('[data-ide-scm-input="commit"]').value,
    'my hard work',
    'message preserved on failure',
  );
});

test('an empty commit message is guarded - no onCommit, an inline hint shows', async () => {
  const { panelEl, calls } = setup(repo());
  panelEl.querySelector('[data-ide-scm-action="commit"]').click();
  await settle();
  assert.equal(calls.commit.length, 0);
  assert.match(panelEl.textContent, /Enter a commit message/);
});

test('the Commit button is disabled when nothing is staged', () => {
  const { panelEl } = setup({
    available: true, isRepo: true, branch: 'main',
    files: [{ path: 'a.js', state: 'modified', staged: false, worktree: 'M', index: ' ' }],
  });
  const commitBtn = panelEl.querySelector('[data-ide-scm-action="commit"]');
  assert.ok(commitBtn.hasAttribute('disabled'), 'Commit disabled with nothing staged');
});

test('degrades to an empty state when unavailable or not a repo', () => {
  const off = setup({ available: false });
  assert.match(off.panelEl.textContent, /isn.t available/);
  assert.equal(off.panelEl.querySelector('[data-ide-scm-action]'), null);

  const notRepo = setup({ available: true, isRepo: false });
  assert.match(notRepo.panelEl.textContent, /isn.t a Git repository/);
});

test('a clean repo shows the nothing-to-commit state', () => {
  const { panelEl } = setup({ available: true, isRepo: true, branch: 'main', files: [] });
  assert.match(panelEl.textContent, /Nothing to commit/);
});

// ── branch header: detached HEAD vs unborn repo ───────────────────────────────

test('detached HEAD renders a distinct warning label', () => {
  const { panelEl } = setup({
    available: true, isRepo: true, branch: '(detached)', detached: true, unborn: false, files: [],
  });
  assert.match(panelEl.textContent, /Detached HEAD/);
  const head = panelEl.querySelector('.ide-scm-branch--detached');
  assert.ok(head, 'styled with the detached modifier');
  assert.equal(head.dataset.gitHead, 'detached');
});

test('an unborn repo reads as a benign "no commits yet" note, not the detached warning', () => {
  const { panelEl } = setup({
    available: true, isRepo: true, branch: 'main', detached: false, unborn: true, files: [],
  });
  assert.match(panelEl.textContent, /No commits yet/);
  assert.match(panelEl.textContent, /main/, 'still names the unborn branch');
  assert.equal(panelEl.querySelector('.ide-scm-branch--detached'), null, 'unborn is not styled as detached');
  assert.equal(panelEl.querySelector('[data-git-head="unborn"]').dataset.gitHead, 'unborn');
});

test('a normal branch renders its plain name with no head-state modifier', () => {
  const { panelEl } = setup(repo());
  const branch = panelEl.querySelector('.ide-scm-branch');
  assert.equal(branch.textContent, 'main');
  assert.equal(branch.className, 'ide-scm-branch', 'no detached/unborn modifier on a normal branch');
});

test('does not render when the rail is showing a different panel', () => {
  const { panelEl } = setup(repo(), { railPanel: 'explorer' });
  assert.equal(panelEl.innerHTML, '', 'no render off-panel');
});

// ── AI "Write message" ────────────────────────────────────────────────────

test('Write message button renders and is disabled when nothing is staged', () => {
  const staged = setup(repo());
  assert.ok(
    staged.panelEl.querySelector('[data-ide-scm-action="write-message"]'),
    'write-message button present when callbacks are wired',
  );

  const nothingStaged = setup({
    available: true, isRepo: true, branch: 'main',
    files: [{ path: 'a.js', state: 'modified', staged: false, worktree: 'M', index: ' ' }],
  });
  const btn = nothingStaged.panelEl.querySelector('[data-ide-scm-action="write-message"]');
  assert.ok(btn.hasAttribute('disabled'), 'write-message disabled with nothing staged');
});

test('Write message is absent when the callbacks are not wired (graceful degrade)', () => {
  const { panelEl } = setup(repo(), { noWrite: true });
  assert.equal(panelEl.querySelector('[data-ide-scm-action="write-message"]'), null);
  // The rest of the panel still renders.
  assert.ok(panelEl.querySelector('[data-ide-scm-action="commit"]'), 'commit button still present');
});

test('Write message feeds the staged diff to the model and populates the commit field', async () => {
  const { panelEl, calls } = setup(repo(), { generated: 'fix(scm): handle staged diff' });
  panelEl.querySelector('[data-ide-scm-action="write-message"]').click();
  await settle();
  assert.equal(calls.getDiff, 1, 'staged diff was requested');
  assert.deepEqual(calls.write, ['diff --git a/staged.js b/staged.js\n+hello'], 'diff handed to the model');
  assert.equal(
    panelEl.querySelector('[data-ide-scm-input="commit"]').value,
    'fix(scm): handle staged diff',
    'generated message dropped into the editable field',
  );
});

test('Write message warns when the diff was truncated before the model saw it', async () => {
  // A truncated-diff result still populates the field, but adds an informational
  // hint naming how many files the model never saw, so the user reviews it.
  const { panelEl } = setup(repo(), {
    generated: {
      ok: true,
      message: 'chore: sweeping change',
      truncated: true,
      omittedFiles: 4,
      totalFiles: 9,
    },
  });
  panelEl.querySelector('[data-ide-scm-action="write-message"]').click();
  await settle();
  assert.equal(
    panelEl.querySelector('[data-ide-scm-input="commit"]').value,
    'chore: sweeping change',
    'the generated message still populates the field',
  );
  assert.match(panelEl.textContent, /4 files not shown to the model/);
});

test('Write message shows no truncation hint for a within-cap diff', async () => {
  const { panelEl } = setup(repo(), { generated: 'feat: complete view' });
  panelEl.querySelector('[data-ide-scm-action="write-message"]').click();
  await settle();
  assert.doesNotMatch(panelEl.textContent, /not shown to the model/);
});

test('Write message shows a loading state during generation', async () => {
  const { panelEl } = setup(repo());
  panelEl.querySelector('[data-ide-scm-action="write-message"]').click();
  // Synchronous re-render happened before the awaited diff/model calls resolve.
  const busyBtn = panelEl.querySelector('[data-ide-scm-action="write-message"]');
  assert.ok(busyBtn.hasAttribute('disabled'), 'button disabled while writing');
  assert.match(busyBtn.textContent, /Writing/, 'shows a Writing… label');
  await settle();
  const settledBtn = panelEl.querySelector('[data-ide-scm-action="write-message"]');
  assert.ok(!settledBtn.hasAttribute('disabled'), 're-enabled after settle');
  assert.match(settledBtn.textContent, /Write message/);
});

test('Write message with no staged diff shows a hint and never calls the model', async () => {
  const { panelEl, calls } = setup(repo(), { diff: { ok: true, diff: '' } });
  panelEl.querySelector('[data-ide-scm-action="write-message"]').click();
  await settle();
  assert.equal(calls.write.length, 0, 'model not called with an empty diff');
  assert.match(panelEl.textContent, /No staged changes to summarize/);
});

test('Write message failure shows a hint and preserves the typed message', async () => {
  const { panelEl } = setup(repo(), { generated: '' });
  const input = panelEl.querySelector('[data-ide-scm-input="commit"]');
  input.value = 'my draft';
  input.dispatchEvent(new panelEl.ownerDocument.defaultView.Event('input', { bubbles: true }));
  panelEl.querySelector('[data-ide-scm-action="write-message"]').click();
  await settle();
  assert.match(panelEl.textContent, /Could not write a message/);
  assert.equal(
    panelEl.querySelector('[data-ide-scm-input="commit"]').value,
    'my draft',
    'typed message preserved on failure',
  );
});

test('Write message swallows a thrown model error into a hint', async () => {
  const { panelEl, calls } = setup(repo(), { writeThrows: true });
  panelEl.querySelector('[data-ide-scm-action="write-message"]').click();
  await settle();
  assert.equal(calls.write.length, 1, 'model was attempted');
  assert.match(panelEl.textContent, /Could not write a message/);
  // No unhandled rejection; button recovers.
  assert.ok(!panelEl.querySelector('[data-ide-scm-action="write-message"]').hasAttribute('disabled'));
});

test('Write message distinguishes an empty model response from an unloaded model', async () => {
  // An { ok:false } shape carries a reason; an empty response is not the same as
  // a missing model, so the hint must differ.
  const empty = setup(repo(), { generated: { ok: false, reason: 'empty_message' } });
  empty.panelEl.querySelector('[data-ide-scm-action="write-message"]').click();
  await settle();
  assert.match(empty.panelEl.textContent, /returned an empty message/);
  assert.doesNotMatch(empty.panelEl.textContent, /is the local model loaded/);

  const unloaded = setup(repo(), { generated: { ok: false, reason: 'model_not_loaded' } });
  unloaded.panelEl.querySelector('[data-ide-scm-action="write-message"]').click();
  await settle();
  assert.match(unloaded.panelEl.textContent, /is the local model loaded/);
});

test('Write message replaces an existing typed draft (generate-on-demand contract)', async () => {
  // Clicking "Write message" is an explicit request to generate, so a SUCCESSFUL
  // generation intentionally replaces whatever was typed (a draft is only
  // preserved on failure/empty-diff — see the test above). This documents the
  // conscious overwrite contract.
  const { panelEl } = setup(repo(), { generated: 'feat: generated over the draft' });
  const input = panelEl.querySelector('[data-ide-scm-input="commit"]');
  input.value = 'half-written draft';
  input.dispatchEvent(new panelEl.ownerDocument.defaultView.Event('input', { bubbles: true }));
  panelEl.querySelector('[data-ide-scm-action="write-message"]').click();
  await settle();
  assert.equal(
    panelEl.querySelector('[data-ide-scm-input="commit"]').value,
    'feat: generated over the draft',
    'a successful generation replaces the typed draft',
  );
});

test('resetForRoot clears the old root\'s draft, hint, and busy flags (hyg-W4-37-F03)', () => {
  const snapshot = repo();
  const { panelEl, panel } = setup(snapshot);
  const input = panelEl.querySelector('[data-ide-scm-input="commit"]');
  input.value = 'message for root A';
  input.dispatchEvent(new panelEl.ownerDocument.defaultView.Event('input', { bubbles: true }));
  assert.equal(typeof panel.resetForRoot, 'function', 'the panel exposes the root-switch seam');
  snapshot.branch = 'root-b';
  snapshot.files = [{ path: 'b.js', state: 'modified', staged: true, worktree: ' ', index: 'M' }];
  panel.resetForRoot();
  panel.renderSourceControlPanel();
  assert.equal(
    panelEl.querySelector('[data-ide-scm-input="commit"]').value,
    '',
    'the new root must not inherit the old root\'s typed draft'
  );
});

test('a generated message resolving after resetForRoot is discarded, not applied to the new root (hyg-W4-37-F03)', async () => {
  let resolveWrite = null;
  const dom2 = new JSDOM('<!doctype html><body><div id="ideRailPanel"></div></body>');
  const panelEl2 = dom2.window.document.getElementById('ideRailPanel');
  const snapshot2 = repo();
  const panel2 = createIdeSourceControlPanel({
    getDom: () => ({ ideRailPanel: panelEl2 }),
    getIde: () => ({ railPanel: 'source-control' }),
    actionButton,
    textField,
    store: { getSnapshot: () => snapshot2 },
    onCommit: async () => ({ committed: true }),
    onGetDiff: async () => ({ ok: true, diff: 'diff --git a/staged.js b/staged.js\n+hello' }),
    onWriteMessage: () => new Promise((resolve) => { resolveWrite = resolve; }),
  });
  panel2.bindEvents();
  panel2.renderSourceControlPanel();
  const writeButton = panelEl2.querySelector('[data-ide-scm-action="write-message"]');
  assert.ok(writeButton, 'the write-message control renders');
  writeButton.dispatchEvent(new dom2.window.Event('click', { bubbles: true }));
  await settle();
  panel2.resetForRoot();
  resolveWrite('feat: stale message for the OLD root');
  await settle();
  panel2.renderSourceControlPanel();
  assert.equal(
    panelEl2.querySelector('[data-ide-scm-input="commit"]').value,
    '',
    'a post-reset generation result must be discarded'
  );
});
