'use strict';
// Row 82 G2: the quick diff peek (renderer/features/renderer-ide-hunk-peek.js): change
// blocks under a gutter line, Revert Change as one model edit, Stage Change through a
// built single-file patch (proved against real git), Previous / Next, and the popover.
// Cleanup wave G4 (an edit or a root switch during the index read cancels the stage) and
// G5 (a degraded diff yields one coarse block and the peek says so).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { JSDOM } = require('jsdom');

const { createIdeHunkPeek, blockAtLine, lineSpliceEdit, buildStagePatch } = require('../renderer/features/renderer-ide-hunk-peek');
const { diffChangeBlocks, headLineFor, splitLines } = require('../renderer/features/renderer-ide-gutter-decorations');
const { validateSingleFilePatch } = require('../services/workspace-git-service-extras');
const { WorkspaceGitService } = require('../services/workspace-git-service');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

const execFileAsync = promisify(execFile);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A tiny text model with Monaco's line/column addressing.
function textModel(initial, eol = '\n') {
  let text = initial;
  const lines = () => text.split(eol);
  const offsetAt = (line, column) => lines().slice(0, line - 1).reduce((sum, l) => sum + l.length + eol.length, 0) + column - 1;
  let version = 1;
  const model = {
    edits: [],
    getVersionId: () => version,
    getValue: () => text,
    getEOL: () => eol,
    getLineCount: () => lines().length,
    getLineMaxColumn: (line) => lines()[line - 1].length + 1,
    pushEditOperations(_selections, edits) {
      for (const edit of edits) {
        version += 1;
        model.edits.push(edit);
        const { range } = edit;
        text = text.slice(0, offsetAt(range.startLineNumber, range.startColumn)) + edit.text + text.slice(offsetAt(range.endLineNumber, range.endColumn));
      }
      return null;
    },
  };
  return model;
}

function revertBlock(head, buffer, line) {
  const model = textModel(buffer);
  const block = blockAtLine(diffChangeBlocks(splitLines(head), buffer), line);
  model.pushEditOperations([], [lineSpliceEdit(model, block.newStart0, block.newCount, block.oldLines, '\n')]);
  return model.getValue();
}

test('change blocks carry HEAD text in buffer coordinates; headLineFor maps around them', () => {
  const head = 'a\nb\nc\nd\n';
  const buffer = 'a\nB\nc\nnew\nd\n';
  const blocks = diffChangeBlocks(splitLines(head), buffer);
  assert.deepEqual(blocks.map((b) => [b.type, b.anchorLine, b.endLine, b.oldLines]), [
    ['modified', 2, 2, ['b']],
    ['added', 4, 4, []],
  ]);
  const headLines = splitLines(head);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((line) => headLineFor(blocks, line, headLines)), [1, null, 3, null, 4, null]);
  assert.equal(blockAtLine(blocks, 4).type, 'added');
  assert.equal(blockAtLine(blocks, 3), null);
});

test('Revert Change restores HEAD lines for modified, added, deleted and newline-only changes', () => {
  assert.equal(revertBlock('a\nb\nc\n', 'a\nB\nc\n', 2), 'a\nb\nc\n');
  assert.equal(revertBlock('a\nc\n', 'a\nnew\nc\n', 2), 'a\nc\n', 'an added middle line goes with its break');
  assert.equal(revertBlock('x\na\n', 'a\n', 1), 'x\na\n', 'a deleted first line comes back');
  assert.equal(revertBlock('a\nb', 'a', 1), 'a\nb', 'a deleted last line comes back');
  assert.equal(revertBlock('a\nb', 'a\nb\n', 3), 'a\nb', 'an added final newline goes');
  assert.equal(revertBlock('a\nb\n', 'a\nb\nc\nd\n', 3), 'a\nb\n', 'added lines at the end go');
});

describe('buildStagePatch', () => {
  test('stages only the blocks under the peeked range, with index context', () => {
    const index = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n';
    const buffer = 'l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\nL9\nl10\n';
    const { patch, blocks } = buildStagePatch('src/a.txt', index, buffer, 8, 1);
    assert.equal(blocks, 1);
    assert.equal(patch, [
      'diff --git a/src/a.txt b/src/a.txt', '--- a/src/a.txt', '+++ b/src/a.txt',
      '@@ -6,5 +6,5 @@', ' l6', ' l7', ' l8', '-l9', '+L9', ' l10', '',
    ].join('\n'));
    assert.deepEqual(validateSingleFilePatch(patch), { path: 'src/a.txt', hunks: 1 });
  });

  test('pure insertions, deletions, a missing final newline and a CRLF index', () => {
    const insert = buildStagePatch('a', 'x\ny\n', 'x\nnew\ny\n', 1, 1).patch;
    assert.match(insert, /@@ -1,2 \+1,3 @@\n x\n\+new\n y\n$/);
    const deletion = buildStagePatch('a', 'x\ny\nz\n', 'x\nz\n', 1, 0).patch;
    assert.match(deletion, /@@ -1,3 \+1,2 @@\n x\n-y\n z\n$/);
    const noNewline = buildStagePatch('a', 'x\ny\n', 'x\ny', 1, 1).patch;
    assert.match(noNewline, / x\n-y\n\+y\n\\ No newline at end of file\n$/);
    const crlf = buildStagePatch('a', 'x\r\ny\r\n', 'x\nY\n', 1, 1).patch;
    assert.match(crlf, / x\r\n-y\r\n\+Y\r\n$/);
    for (const patch of [insert, deletion, noNewline, crlf]) validateSingleFilePatch(patch);
    assert.equal(buildStagePatch('a', 'same\n', 'same\n', 0, 1).patch, '', 'nothing differs: no patch');
  });

  describe('against real git', () => {
    test.afterEach(async () => { await cleanupTrackedResources(); });

    test('the built patch stages exactly the peeked change and leaves the other unstaged', async () => {
      const repo = createTrackedTempDir('jenny-hunk-peek-');
      const git = (args) => execFileAsync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' });
      await git(['init']);
      await git(['config', 'user.email', 'jenny@example.invalid']);
      await git(['config', 'user.name', 'Jenny Tests']);
      await git(['config', 'core.autocrlf', 'false']);
      const original = Array.from({ length: 12 }, (_v, i) => `line ${i + 1}`).join('\n') + '\n';
      await fs.writeFile(path.join(repo, 'f.txt'), original, 'utf8');
      await git(['add', 'f.txt']);
      await git(['commit', '-m', 'initial']);
      const edited = original.replace('line 2\n', 'LINE 2\n').replace('line 11\n', 'LINE 11\n');
      await fs.writeFile(path.join(repo, 'f.txt'), edited, 'utf8');
      const svc = new WorkspaceGitService({
        configService: { getToolsWorkspaceRoot: () => repo },
        featureFlagProvider: () => ({ workspace_git: true }),
        logger() {},
      });
      const block = blockAtLine(diffChangeBlocks(splitLines(original), edited), 11);
      const index = await svc.getFileAtIndex({ path: 'f.txt' });
      const { patch } = buildStagePatch('f.txt', index.content, edited, block.newStart0, block.newCount);
      const res = await svc.applyPatch({ patch, cached: true });
      assert.equal(res.ok, true, JSON.stringify(res));
      const staged = (await git(['diff', '--cached'])).stdout;
      assert.match(staged, /\+LINE 11/);
      assert.doesNotMatch(staged, /LINE 2/);
      assert.equal(await fs.readFile(path.join(repo, 'f.txt'), 'utf8'), edited, 'the working tree is untouched');
    });

    // Review fixes: a CRLF index without a final newline, and end-of-file changes whose
    // gutter block sits on Monaco's trailing '' line, used to build no patch or a bad one.
    test('end-of-file changes stage exactly: CRLF without a final newline, an added newline, a trailing blank line', async () => {
      const repo = createTrackedTempDir('jenny-hunk-peek-eof-');
      const git = (args) => execFileAsync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' });
      await git(['init']);
      await git(['config', 'user.email', 'jenny@example.invalid']);
      await git(['config', 'user.name', 'Jenny Tests']);
      await git(['config', 'core.autocrlf', 'false']);
      const svc = new WorkspaceGitService({
        configService: { getToolsWorkspaceRoot: () => repo },
        featureFlagProvider: () => ({ workspace_git: true }),
        logger() {},
      });
      const cases = [
        { head: 'L3\r\nL1', buffer: 'L3\nL1x', staged: 'L3\r\nL1x' },
        { head: 'L1\nL0', buffer: 'L1\nL0\n', staged: 'L1\nL0\n' },
        { head: 'L1\n', buffer: 'L1\n\n', staged: 'L1\n\n' },
      ];
      for (const [n, c] of cases.entries()) {
        const file = `f${n}.txt`;
        await fs.writeFile(path.join(repo, file), c.head, 'utf8');
        await git(['add', file]);
        await git(['commit', '-m', `case ${n}`]);
        const blocks = diffChangeBlocks(splitLines(c.head), c.buffer);
        const block = blocks[blocks.length - 1];
        const index = await svc.getFileAtIndex({ path: file });
        const { patch } = buildStagePatch(file, index.content, c.buffer, block.newStart0, block.newCount);
        assert.notEqual(patch, '', `case ${n}: a patch is built`);
        const res = await svc.applyPatch({ patch, cached: true });
        assert.equal(res.ok, true, `case ${n}: ${JSON.stringify(res)}`);
        assert.equal((await git(['show', `:${file}`])).stdout, c.staged, `case ${n}: the index holds the change`);
      }
    });
  });
});

function peekHarness({ head = 'a\nb\nc\nd\ne\n', buffer = 'a\nB\nc\nd\nE\n', index, applyResult = { ok: true }, duringIndexRead = null } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="stage"></div></body>');
  const doc = dom.window.document;
  const stage = doc.getElementById('stage');
  const model = textModel(buffer);
  const calls = { reveal: [], toasts: [], index: [], apply: [], refresh: 0, focus: 0 };
  const root = { epoch: 1 };
  const editorNode = doc.createElement('div');
  stage.appendChild(editorNode);
  const editor = {
    getDomNode: () => editorNode,
    getScrolledVisiblePosition: () => ({ top: 40, height: 20 }),
    getLayoutInfo: () => ({ decorationsLeft: 30 }),
    focus: () => { calls.focus += 1; },
  };
  const editorHost = {
    getActivePath: () => 'src/a.txt',
    getValue: () => model.getValue(),
    getModel: () => model,
    editorFor: () => editor,
    revealPosition: (p, line) => calls.reveal.push(line),
  };
  const headLines = splitLines(head);
  const peek = createIdeHunkPeek({
    editorHost,
    getDom: () => ({ ideEditorStage: stage }),
    getChangeBlocks: () => ({ blocks: diffChangeBlocks(headLines, model.getValue()) }),
    gitClient: {
      getFileAtIndex: async (payload) => {
        calls.index.push(payload);
        if (duringIndexRead) duringIndexRead({ model, root });
        return index || { ok: true, found: true, content: head };
      },
      applyPatch: async (payload) => { calls.apply.push(payload); return applyResult; },
    },
    refreshGit: async () => { calls.refresh += 1; },
    showToastMessage: (message) => calls.toasts.push(message),
    getRootEpoch: () => root.epoch,
  });
  const click = (action) => stage.querySelector(`[data-ide-hunk-peek-action="${action}"]`).click();
  return { peek, stage, model, calls, click, doc };
}

test('opening at a change bar shows HEAD lines, the position and the actions', () => {
  const { peek, stage } = peekHarness();
  assert.equal(peek.openAt('src/a.txt', 3), false, 'no change on line 3');
  assert.equal(peek.openAt('src/a.txt', 2), true);
  const pop = stage.querySelector('[data-inv-popover="ide-hunk-peek"]');
  assert.equal(pop.hidden, false);
  assert.match(pop.textContent, /Change 1 of 2/);
  assert.equal(pop.querySelector('.ide-hunk-peek-lines').textContent, 'b');
  assert.deepEqual([...pop.querySelectorAll('[data-ide-hunk-peek-action]')].map((el) => el.dataset.ideHunkPeekAction),
    ['revert', 'stage', 'previous', 'next', 'close']);
  assert.equal(pop.style.getPropertyValue('inset-block-start'), '60px');
  assert.equal(pop.style.getPropertyValue('inset-inline-start'), '30px');
});

test('Revert Change edits the model once and closes; Next and Previous wrap', () => {
  const h = peekHarness();
  h.peek.openAt('src/a.txt', 2);
  h.click('next');
  assert.deepEqual(h.calls.reveal, [5]);
  assert.match(h.stage.textContent, /Change 2 of 2/);
  h.click('next');
  assert.deepEqual(h.calls.reveal, [5, 2], 'wraps to the first change');
  h.click('revert');
  assert.equal(h.model.getValue(), 'a\nb\nc\nd\nE\n');
  assert.equal(h.model.edits.length, 1);
  assert.equal(h.peek.isOpen(), false);
});

test('Stage Change applies a cached patch for this change only, then refreshes git', async () => {
  const h = peekHarness();
  h.peek.openAt('src/a.txt', 5);
  h.click('stage');
  await settle();
  assert.deepEqual(h.calls.index, [{ path: 'src/a.txt' }]);
  assert.equal(h.calls.apply.length, 1);
  assert.equal(h.calls.apply[0].cached, true);
  assert.match(h.calls.apply[0].patch, /-e\n\+E\n$/);
  assert.doesNotMatch(h.calls.apply[0].patch, /\+B/);
  assert.match(h.calls.toasts[0], /Change staged/);
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.peek.isOpen(), false);
});

test('Stage Change explains an untracked file, a conflicted file and a refused patch', async () => {
  const untracked = peekHarness({ index: { ok: true, found: false, reason: 'not_in_index' } });
  untracked.peek.openAt('src/a.txt', 2);
  assert.equal(await untracked.peek.stage(), false);
  assert.match(untracked.calls.toasts[0], /isn’t tracked yet/);
  const conflicted = peekHarness({ index: { ok: true, found: false, reason: 'unmerged' } });
  conflicted.peek.openAt('src/a.txt', 2);
  await conflicted.peek.stage();
  assert.match(conflicted.calls.toasts[0], /merge conflicts/);
  const refused = peekHarness({ applyResult: { ok: false, reason: 'patch_does_not_apply' } });
  refused.peek.openAt('src/a.txt', 2);
  assert.equal(await refused.peek.stage(), false);
  assert.match(refused.calls.toasts[0], /Couldn’t stage this change/);
  assert.equal(refused.calls.refresh, 0);
  assert.equal(refused.peek.isOpen(), true, 'a refusal keeps the peek open');
});

test('Escape closes the peek and gives the caret back to the editor', () => {
  const h = peekHarness();
  h.peek.openAt('src/a.txt', 2);
  const button = h.stage.querySelector('[data-ide-hunk-peek-action="revert"]');
  button.focus();
  button.dispatchEvent(new h.doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.peek.isOpen(), false);
  assert.equal(h.stage.querySelector('[data-inv-popover="ide-hunk-peek"]'), null);
  assert.equal(h.calls.focus, 1);
});

test('an edit landing during the index read cancels the stage', async () => {
  const typed = peekHarness({
    duringIndexRead: ({ model }) => model.pushEditOperations([], [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'x' }]),
  });
  typed.peek.openAt('src/a.txt', 5);
  assert.equal(await typed.peek.stage(), false);
  assert.equal(typed.calls.apply.length, 0, 'applyPatch never called');
  assert.deepEqual(typed.calls.toasts, ['The file changed while staging; try again.']);
  const switched = peekHarness({ duringIndexRead: ({ root }) => { root.epoch += 1; } });
  switched.peek.openAt('src/a.txt', 5);
  assert.equal(await switched.peek.stage(), false);
  assert.equal(switched.calls.apply.length, 0, 'a root switch during the read cancels too');
});

test('a 6,000-line file edited at both ends is one coarse block, and the peek says so', () => {
  const lines = Array.from({ length: 6000 }, (_v, i) => `line ${i + 1}`);
  const head = `${lines.join('\n')}\n`;
  const buffer = `${['FIRST', ...lines.slice(1, -1), 'LAST'].join('\n')}\n`;
  const blocks = diffChangeBlocks(splitLines(head), buffer);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].coarse, true);
  assert.equal(diffChangeBlocks(splitLines('a\nb\n'), 'a\nB\n')[0].coarse, undefined, 'an exact diff is not coarse');
  const h = peekHarness({ head, buffer });
  assert.equal(h.peek.openAt('src/a.txt', 1), true);
  assert.match(h.stage.querySelector('.ide-hunk-peek-coarse').textContent, /This change covers a large region; Revert and Stage act on all of it\./);
  const fine = peekHarness();
  fine.peek.openAt('src/a.txt', 2);
  assert.equal(fine.stage.querySelector('.ide-hunk-peek-coarse'), null);
});
