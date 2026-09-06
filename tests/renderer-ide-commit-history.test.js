'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createIdeCommitHistory,
  formatRelativeTime,
  formatExactTime,
  toCardModel,
  toCardModels,
} = require('../renderer/features/renderer-ide-commit-history');
const { createIdeSourceControlPanel } = require('../renderer/features/renderer-ide-source-control-panel');
const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A fixed clock so relative-time assertions are deterministic.
const NOW = Date.parse('2026-06-17T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function commit(overrides) {
  return Object.assign({
    sha: '1111111111111111111111111111111111111111',
    shortSha: '1111111',
    author: 'Ada Lovelace',
    email: 'ada@example.com',
    dateISO: ago(3 * HOUR),
    subject: 'Add the friendly history view',
    parentShas: ['2222222'],
    isMerge: false,
  }, overrides || {});
}

// ── Pure: formatRelativeTime ───────────────────────────────────────────────

test('formatRelativeTime spans from "just now" to years, singular/plural', () => {
  assert.equal(formatRelativeTime(ago(5 * SECOND), NOW), 'just now');
  assert.equal(formatRelativeTime(ago(59 * SECOND), NOW), 'just now');
  assert.equal(formatRelativeTime(ago(1 * MINUTE), NOW), '1 minute ago');
  assert.equal(formatRelativeTime(ago(5 * MINUTE), NOW), '5 minutes ago');
  assert.equal(formatRelativeTime(ago(1 * HOUR), NOW), '1 hour ago');
  assert.equal(formatRelativeTime(ago(3 * HOUR), NOW), '3 hours ago');
  assert.equal(formatRelativeTime(ago(1 * DAY), NOW), '1 day ago');
  assert.equal(formatRelativeTime(ago(6 * DAY), NOW), '6 days ago');
  assert.equal(formatRelativeTime(ago(31 * DAY), NOW), '1 month ago');
  assert.equal(formatRelativeTime(ago(90 * DAY), NOW), '3 months ago');
  assert.equal(formatRelativeTime(ago(400 * DAY), NOW), '1 year ago');
  assert.equal(formatRelativeTime(ago(800 * DAY), NOW), '2 years ago');
});

test('formatRelativeTime clamps a future timestamp to "just now" and rejects junk', () => {
  assert.equal(formatRelativeTime(new Date(NOW + 5 * MINUTE).toISOString(), NOW), 'just now');
  assert.equal(formatRelativeTime('', NOW), '');
  assert.equal(formatRelativeTime('not-a-date', NOW), '');
  assert.equal(formatRelativeTime(null, NOW), '');
});

test('formatExactTime returns a string for a valid date and empty for junk', () => {
  assert.equal(typeof formatExactTime(ago(1 * HOUR)), 'string');
  assert.ok(formatExactTime(ago(1 * HOUR)).length > 0);
  assert.equal(formatExactTime('nope'), '');
});

// ── Pure: toCardModel / toCardModels ───────────────────────────────────────

test('toCardModel maps the raw commit to a friendly display model', () => {
  const model = toCardModel(commit(), NOW);
  assert.equal(model.subject, 'Add the friendly history view');
  assert.equal(model.author, 'Ada Lovelace');
  assert.equal(model.shortHash, '1111111');
  assert.equal(model.relativeTime, '3 hours ago');
  assert.equal(model.isMerge, false);
});

test('toCardModel fills friendly placeholders for empty fields and a merge flag', () => {
  const model = toCardModel(commit({ subject: '', author: '', isMerge: true }), NOW);
  assert.equal(model.subject, '(no commit message)');
  assert.equal(model.author, 'Unknown author');
  assert.equal(model.isMerge, true);
});

test('toCardModel derives the short hash from the full sha when shortSha is absent', () => {
  const model = toCardModel(commit({ shortSha: '', sha: 'abcdef1234567890' }), NOW);
  assert.equal(model.shortHash, 'abcdef1');
});

test('toCardModel takes only the first line of a multi-line subject', () => {
  const model = toCardModel(commit({ subject: 'First line\n\nbody text' }), NOW);
  assert.equal(model.subject, 'First line');
});

test('toCardModels maps an array and tolerates a non-array', () => {
  assert.equal(toCardModels([commit(), commit()], NOW).length, 2);
  assert.deepEqual(toCardModels(null, NOW), []);
  assert.deepEqual(toCardModels(undefined, NOW), []);
});

// ── Controller: createIdeCommitHistory ─────────────────────────────────────

function controllerSetup(opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div data-ide-scm-history></div></body>');
  const mount = dom.window.document.querySelector('[data-ide-scm-history]');
  const calls = { getLog: 0 };
  const history = createIdeCommitHistory({
    onGetLog: async () => {
      calls.getLog += 1;
      if (typeof opts.onGetLog === 'function') {
        return opts.onGetLog();
      }
      return opts.result !== undefined
        ? opts.result
        : { ok: true, available: true, isRepo: true, op: 'getLog', commits: opts.commits || [commit()] };
    },
    getMount: () => mount,
    actionButton,
    nowFn: () => NOW,
    limit: opts.limit,
  });
  return { dom, mount, history, calls };
}

test('refresh renders commit cards with subject, author, relative time, and hash', async () => {
  const { mount, history } = controllerSetup({
    commits: [
      commit({ subject: 'Add the app entry point', shortSha: 'aaa1111', dateISO: ago(2 * HOUR) }),
      commit({ subject: 'Add a friendly readme', shortSha: 'bbb2222', dateISO: ago(2 * DAY) }),
    ],
  });
  await history.refresh();
  assert.match(mount.textContent, /History \(2\)/);
  assert.match(mount.textContent, /Add the app entry point/);
  assert.match(mount.textContent, /Add a friendly readme/);
  assert.match(mount.textContent, /Ada Lovelace/);
  assert.match(mount.textContent, /2 hours ago/);
  assert.match(mount.textContent, /2 days ago/);
  assert.match(mount.textContent, /aaa1111/);
  assert.equal(mount.querySelectorAll('.ide-scm-card').length, 2);
});

test('an empty repo shows the no-commits-yet state, not cards', async () => {
  const { mount, history } = controllerSetup({ commits: [] });
  await history.refresh();
  assert.match(mount.textContent, /No commits yet/);
  assert.equal(mount.querySelectorAll('.ide-scm-card').length, 0);
});

test('a non-repo result keeps the History silent (panel owns that message)', async () => {
  const { mount, history } = controllerSetup({ result: { ok: true, available: true, isRepo: false } });
  await history.refresh();
  assert.equal(mount.innerHTML, '');
});

test('an unavailable git layer keeps the History silent', async () => {
  const { mount, history } = controllerSetup({ result: { ok: false, available: false } });
  await history.refresh();
  assert.equal(mount.innerHTML, '');
});

test('a load failure with no prior commits shows an error and a Try again control', async () => {
  const { mount, history } = controllerSetup({ result: { ok: false, available: true, isRepo: true } });
  await history.refresh();
  assert.match(mount.textContent, /Couldn.t load recent commits/);
  assert.ok(mount.querySelector('[data-ide-scm-action="history-retry"]'), 'retry control present');
});

test('a later load failure keeps the last good cards instead of blanking them', async () => {
  let mode = 'ok';
  const { mount, history } = controllerSetup({
    onGetLog: () => (mode === 'ok'
      ? { ok: true, available: true, isRepo: true, commits: [commit({ subject: 'Good commit' })] }
      : { ok: false, available: true, isRepo: true }),
  });
  await history.refresh();
  assert.match(mount.textContent, /Good commit/);
  mode = 'fail';
  await history.refresh();
  assert.match(mount.textContent, /Good commit/, 'previous cards survive a transient failure');
  assert.doesNotMatch(mount.textContent, /Couldn.t load/);
});

test('toggle collapses the cards but keeps the header', async () => {
  const { mount, history } = controllerSetup({ commits: [commit(), commit()] });
  await history.refresh();
  assert.equal(mount.querySelectorAll('.ide-scm-card').length, 2);
  history.toggle();
  assert.equal(mount.querySelectorAll('.ide-scm-card').length, 0, 'cards hidden when collapsed');
  assert.match(mount.textContent, /History/, 'header still visible');
  history.toggle();
  assert.equal(mount.querySelectorAll('.ide-scm-card').length, 2, 're-expands');
});

test('overlapping refreshes coalesce; the awaited promise reflects the final fetch', async () => {
  const { history, calls } = controllerSetup({ commits: [commit()] });
  const first = history.refresh();
  history.refresh();
  history.refresh();
  // The loop keeps `first` pending until the trailing re-run settles, so by the
  // time it resolves both fetches have run (no stray settle needed).
  await first;
  assert.equal(calls.getLog, 2, 'one initial fetch + exactly one trailing re-run');
});

test('disposing Source Control fences an in-flight History refresh and disposes its owner', async () => {
  let resolveLog;
  const { mount, history } = controllerSetup({
    onGetLog: () => new Promise((resolve) => { resolveLog = resolve; }),
  });
  const pending = history.refresh();
  mount.innerHTML = 'TEARDOWN';
  assert.equal(typeof history.dispose, 'function', 'History exposes an idempotent disposal seam');
  history.dispose();
  history.dispose();
  resolveLog({ ok: true, available: true, isRepo: true, commits: [commit({ subject: 'Late commit' })] });
  await pending;
  assert.equal(mount.innerHTML, 'TEARDOWN', 'the late refresh cannot repaint after disposal');

  let disposeCalls = 0;
  const dom = new JSDOM('<!doctype html><body><div id="ideRailPanel"></div></body>');
  const panel = createIdeSourceControlPanel({
    getDom: () => ({ ideRailPanel: dom.window.document.getElementById('ideRailPanel') }),
    getIde: () => ({ railPanel: 'source-control' }),
    store: { getSnapshot: () => ({ available: true, isRepo: true, files: [] }) },
    onGetLog: async () => ({ ok: true, available: true, isRepo: true, commits: [] }),
    createCommitHistory: () => ({
      dispose: () => { disposeCalls += 1; },
      ensureLoaded() {}, render() {}, reset() {}, refresh() {}, toggle() {},
    }),
  });
  panel.dispose();
  assert.equal(disposeCalls, 1, 'the Source Control owner disposes History');
  dom.window.close();
});

test('ensureLoaded fetches once and is a no-op once the log has loaded', async () => {
  const { history, calls } = controllerSetup({ commits: [commit()] });
  await history.ensureLoaded();
  assert.equal(calls.getLog, 1);
  await history.ensureLoaded();
  await history.ensureLoaded();
  assert.equal(calls.getLog, 1, 'staging-style re-renders never re-pull the log');
});

test('refresh always re-pulls after a load (the commit / HEAD-move path)', async () => {
  const { history, calls } = controllerSetup({ commits: [commit()] });
  await history.ensureLoaded();
  assert.equal(calls.getLog, 1);
  await history.refresh();
  assert.equal(calls.getLog, 2, 'an explicit refresh re-pulls even when already loaded');
});

test('cards render static (no open-commit action) when onGetCommitDiff is absent', async () => {
  const { mount, history } = controllerSetup({ commits: [commit()] });
  await history.refresh();
  assert.equal(mount.querySelectorAll('.ide-scm-card').length, 1);
  assert.equal(mount.querySelector('[data-ide-scm-action="history-open"]'), null, 'no open action without an opener');
});

test('cards become clickable and openCommit forwards the full ref', async () => {
  const calls = [];
  const dom = new JSDOM('<!doctype html><body><div data-ide-scm-history></div></body>');
  const mount = dom.window.document.querySelector('[data-ide-scm-history]');
  const history = createIdeCommitHistory({
    onGetLog: async () => ({
      ok: true, available: true, isRepo: true,
      commits: [commit({ sha: 'abcdef1234567890', shortSha: 'abcdef1' })],
    }),
    onGetCommitDiff: async (payload) => { calls.push(payload); return { opened: true }; },
    getMount: () => mount,
    actionButton,
    nowFn: () => NOW,
  });
  await history.refresh();
  const card = mount.querySelector('.ide-scm-card[data-ide-scm-action="history-open"]');
  assert.ok(card, 'card carries the open-commit action');
  assert.equal(card.dataset.ideScmHash, 'abcdef1234567890', 'full sha is the ref');
  await history.openCommit(card.dataset.ideScmHash);
  assert.deepEqual(calls, [{ hash: 'abcdef1234567890' }]);
});

test('limit caps the number of cards rendered', async () => {
  const many = Array.from({ length: 10 }, (_value, index) => commit({ subject: `commit ${index}` }));
  const { mount, history } = controllerSetup({ commits: many, limit: 3 });
  await history.refresh();
  assert.equal(mount.querySelectorAll('.ide-scm-card').length, 3);
});

// ── Panel integration (the real Source Control panel wiring) ───────────────

function panelSetup(logResult) {
  const dom = new JSDOM('<!doctype html><body><div id="ideRailPanel"></div></body>');
  const panelEl = dom.window.document.getElementById('ideRailPanel');
  const snapshot = { available: true, isRepo: true, branch: 'main', files: [] };
  const panel = createIdeSourceControlPanel({
    getDom: () => ({ ideRailPanel: panelEl }),
    getIde: () => ({ railPanel: 'source-control' }),
    actionButton,
    store: { getSnapshot: () => snapshot },
    onGetLog: async () => logResult,
    createCommitHistory: createIdeCommitHistory,
  });
  panel.bindEvents();
  panel.renderSourceControlPanel();
  return { dom, panelEl, panel };
}

test('the panel mounts the History container and fills it from onGetLog', async () => {
  const { panelEl } = panelSetup({
    ok: true, available: true, isRepo: true,
    commits: [commit({ subject: 'Wire up the panel', shortSha: 'ccc3333', dateISO: ago(1 * HOUR) })],
  });
  assert.ok(panelEl.querySelector('[data-ide-scm-history]'), 'history container present');
  await settle();
  await settle();
  const historyEl = panelEl.querySelector('[data-ide-scm-history]');
  assert.match(historyEl.textContent, /Wire up the panel/);
  // The panel uses the real clock (no injected nowFn), so assert a relative-time
  // phrase rather than a fixed one.
  assert.match(historyEl.textContent, /ago|just now/);
  assert.match(historyEl.textContent, /ccc3333/);
});

test('clicking the History toggle collapses the cards through panel delegation', async () => {
  const { panelEl } = panelSetup({
    ok: true, available: true, isRepo: true,
    commits: [commit({ subject: 'Collapse me' })],
  });
  await settle();
  await settle();
  assert.equal(panelEl.querySelectorAll('.ide-scm-card').length, 1);
  panelEl.querySelector('[data-ide-scm-action="history-toggle"]').click();
  assert.equal(panelEl.querySelectorAll('.ide-scm-card').length, 0, 'collapsed via delegated click');
});

test('a successful commit re-pulls the History so the new commit card appears', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="ideRailPanel"></div></body>');
  const panelEl = dom.window.document.getElementById('ideRailPanel');
  const snapshot = {
    available: true, isRepo: true, branch: 'main',
    files: [{ path: 'a.js', state: 'modified', staged: true, worktree: ' ', index: 'M' }],
  };
  let log = [commit({ subject: 'Old commit' })];
  const panel = createIdeSourceControlPanel({
    getDom: () => ({ ideRailPanel: panelEl }),
    getIde: () => ({ railPanel: 'source-control' }),
    actionButton,
    textField,
    store: { getSnapshot: () => snapshot },
    onCommit: async () => {
      // Model the post-commit world: HEAD moved + the staged file left the list.
      log = [commit({ subject: 'Brand new commit' }), ...log];
      snapshot.files = snapshot.files.filter((file) => !file.staged);
      return { committed: true };
    },
    onGetLog: async () => ({ ok: true, available: true, isRepo: true, commits: log }),
    createCommitHistory: createIdeCommitHistory,
  });
  panel.bindEvents();
  panel.renderSourceControlPanel();
  await settle();
  await settle();
  assert.match(panelEl.querySelector('[data-ide-scm-history]').textContent, /Old commit/);

  const input = panelEl.querySelector('[data-ide-scm-input="commit"]');
  input.value = 'ship it';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  panelEl.querySelector('[data-ide-scm-action="commit"]').click();
  await settle();
  await settle();
  assert.match(
    panelEl.querySelector('[data-ide-scm-history]').textContent,
    /Brand new commit/,
    'the new commit surfaces without reopening the panel',
  );
});

test('clicking a commit card opens its diff through panel delegation -> onGetCommitDiff', async () => {
  const opened = [];
  const dom = new JSDOM('<!doctype html><body><div id="ideRailPanel"></div></body>');
  const panelEl = dom.window.document.getElementById('ideRailPanel');
  const snapshot = { available: true, isRepo: true, branch: 'main', files: [] };
  const panel = createIdeSourceControlPanel({
    getDom: () => ({ ideRailPanel: panelEl }),
    getIde: () => ({ railPanel: 'source-control' }),
    actionButton,
    store: { getSnapshot: () => snapshot },
    onGetLog: async () => ({
      ok: true, available: true, isRepo: true,
      commits: [commit({ subject: 'Open me', sha: 'abcdef1234567890', shortSha: 'abcdef1' })],
    }),
    onGetCommitDiff: async (payload) => { opened.push(payload); return { opened: true }; },
    createCommitHistory: createIdeCommitHistory,
  });
  panel.bindEvents();
  panel.renderSourceControlPanel();
  await settle();
  await settle();
  const card = panelEl.querySelector('.ide-scm-card[data-ide-scm-action="history-open"]');
  assert.ok(card, 'a clickable commit card rendered');
  card.click();
  await settle();
  assert.equal(opened.length, 1, 'the card click reached onGetCommitDiff exactly once');
  assert.equal(opened[0].hash, 'abcdef1234567890', 'the clicked commit ref is forwarded');
});

test('pressing Enter on a focused commit card opens its diff (keyboard activation)', async () => {
  const opened = [];
  const dom = new JSDOM('<!doctype html><body><div id="ideRailPanel"></div></body>');
  const panelEl = dom.window.document.getElementById('ideRailPanel');
  const snapshot = { available: true, isRepo: true, branch: 'main', files: [] };
  const panel = createIdeSourceControlPanel({
    getDom: () => ({ ideRailPanel: panelEl }),
    getIde: () => ({ railPanel: 'source-control' }),
    actionButton,
    store: { getSnapshot: () => snapshot },
    onGetLog: async () => ({
      ok: true, available: true, isRepo: true,
      commits: [commit({ subject: 'Open me', sha: 'abcdef1234567890', shortSha: 'abcdef1' })],
    }),
    onGetCommitDiff: async (payload) => { opened.push(payload); return { opened: true }; },
    createCommitHistory: createIdeCommitHistory,
  });
  panel.bindEvents();
  panel.renderSourceControlPanel();
  await settle();
  await settle();
  const card = panelEl.querySelector('.ide-scm-card[data-ide-scm-action="history-open"]');
  assert.equal(card.getAttribute('role'), 'button', 'card is an ARIA button');
  assert.equal(card.getAttribute('tabindex'), '0', 'card is focusable');
  card.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.equal(opened.length, 1, 'Enter activated the focused card');
  assert.equal(opened[0].hash, 'abcdef1234567890', 'the focused commit ref is forwarded');
});

test('the panel has no History section when onGetLog is not wired (graceful degrade)', () => {
  const dom = new JSDOM('<!doctype html><body><div id="ideRailPanel"></div></body>');
  const panelEl = dom.window.document.getElementById('ideRailPanel');
  const panel = createIdeSourceControlPanel({
    getDom: () => ({ ideRailPanel: panelEl }),
    getIde: () => ({ railPanel: 'source-control' }),
    actionButton,
    store: { getSnapshot: () => ({ available: true, isRepo: true, branch: 'main', files: [] }) },
  });
  panel.bindEvents();
  panel.renderSourceControlPanel();
  assert.equal(panelEl.querySelector('[data-ide-scm-history]'), null, 'no history container');
  assert.match(panelEl.textContent, /Nothing to commit/, 'rest of the panel still renders');
});
