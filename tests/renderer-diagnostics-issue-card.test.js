'use strict';

// The Diagnostics issue card (UX-007): one entry per explanation group with a
// plain title, a cause, one action and the evidence folded under details.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { renderIssueList, openGroupsIn, restoreOpenGroups, focusedControlIn, restoreFocus } = require('../renderer/shell/renderer-diagnostics-issue-card');

const ROOTLESS = "Error invoking remote method 'workspace-fs:watch-start': WorkspaceFsError: No workspace root is configured; choose a workspace folder first.";

function group(overrides) {
  const base = {
    component: 'renderer.lifecycle', event: 'ide.watch_start_failed', error_code: '', count: 1, severity: 'WARN',
    message: ROOTLESS, ts: '2026-10-07T13:59:32.291Z', remediation: '', correlations: {},
  };
  const merged = { ...base, ...overrides };
  merged.key = [merged.component, merged.event, merged.error_code].join('\u0000');
  return merged;
}

const WATCH = group({});
const TREE = group({ event: 'ide.tree_list_failed', ts: '2026-10-07T13:59:32.273Z', correlations: { request_id: 'req-1' } });
const SLOW = group({ component: 'electron.main', event: 'ipc.handler_slow', count: 5, message: 'ipc.handler_slow', ts: '2026-10-07T13:53:00.363Z' });
const MEMORY = group({
  component: 'sidecar.memory.index', event: 'memory.index_write_failed', error_code: 'CMP-MEM-0042', severity: 'ERROR',
  message: 'index write failed: database is locked', ts: '2026-10-07T14:02:00.000Z', remediation: 'Retry after the lock clears.',
  correlations: { session_id: 's-1', trace_id: '' },
});
const ENTRIES = [
  { component: 'electron.main', event: 'ipc.handler_slow', ts: SLOW.ts, level: 'WARN', data: { channel: 'models:list', durationMs: 5200 } },
  // Same event id and stamp in another area: never borrowed by the group above.
  { component: 'other.area', event: 'ipc.handler_slow', ts: SLOW.ts, level: 'WARN', data: { channel: 'wrong:channel', durationMs: 1 } },
];
const AVAILABLE = { 'choose-workspace-folder': true, 'show-diagnostics-performance': true };

function render(groups, options) {
  const dom = new JSDOM('<div id="host">' + renderIssueList(groups, options) + '</div>');
  return dom.window.document.getElementById('host');
}

test('groups that share an explanation merge into one entry with the evidence folded', () => {
  const host = render([WATCH, TREE, SLOW, MEMORY], { availableActions: AVAILABLE, entries: ENTRIES, formatDetailTime: (ts) => 'full ' + ts });
  const entries = Array.from(host.querySelectorAll('.diagnostics-issue'));
  assert.deepEqual(entries.map((node) => node.dataset.issueGroup), ['fallback:memory.index_write_failed', 'noWorkspaceFolder', 'slowRequest'], 'ERROR first, then newest');
  assert.equal(host.querySelector('.diagnostics-issue-header'), null);
  assert.equal(host.querySelectorAll('[data-label]').length, 0);

  const workspace = entries[1];
  assert.equal(workspace.getAttribute('role'), 'listitem');
  assert.equal(workspace.dataset.severity, 'WARN');
  assert.equal(workspace.querySelector('.diagnostics-issue-badge').textContent, 'Warning');
  assert.equal(workspace.querySelector('.diagnostics-issue-badge').dataset.tone, 'warning');
  assert.equal(workspace.querySelector('.diagnostics-issue-title strong').textContent, 'No workspace folder is open');
  assert.match(workspace.querySelector('.diagnostics-issue-when').textContent, /2 events$/);
  assert.equal(workspace.querySelector('.diagnostics-issue-when time').getAttribute('title'), 'full ' + WATCH.ts);
  assert.match(workspace.querySelector('.diagnostics-issue-cause').textContent, /no folder is chosen/);
  const button = workspace.querySelector('.diagnostics-issue-actions > button');
  assert.equal(button.dataset.action, 'choose-workspace-folder');
  assert.equal(button.textContent, 'Choose folder…');
  assert.ok(button.classList.contains('btn') && button.classList.contains('btn--sm'));
  const fold = workspace.querySelector('details.diagnostics-issue-tech');
  assert.equal(fold.dataset.issueGroup, 'noWorkspaceFolder');
  assert.equal(fold.hasAttribute('open'), false, 'closed by default');
  assert.equal(fold.querySelector('summary').textContent, 'Technical details');
  const body = fold.querySelector('dl.diagnostics-issue-tech-body').textContent;
  assert.match(body, /Events.*ide\.watch_start_failed.*×1.*ide\.tree_list_failed.*×1/s);
  assert.match(body, /Area.*renderer\.lifecycle.*Workspace/s);
  assert.match(body, /Recorded message.*No workspace root is configured/s);
  assert.doesNotMatch(body, /Code|Recorded advice/);
  const links = Array.from(fold.querySelectorAll('[data-action="inspect-diagnostic-issue"][data-issue]'));
  assert.deepEqual(links.map((node) => decodeURIComponent(node.dataset.issue)), [WATCH.key, TREE.key], 'one Inspect link per member event');
  assert.ok(links.every((node) => node.classList.contains('diagnostics-issue-link') && !node.classList.contains('btn')));
  assert.deepEqual(Array.from(workspace.querySelectorAll('.diagnostics-issue-correlations code')).map((node) => node.textContent), ['req-1']);
});

test('the slow-request entry interpolates the duration and shows the channel', () => {
  const host = render([SLOW], { availableActions: AVAILABLE, entries: ENTRIES });
  const entry = host.querySelector('.diagnostics-issue');
  assert.equal(entry.querySelector('strong').textContent, 'A background request was slow');
  assert.match(entry.querySelector('.diagnostics-issue-cause').textContent, /took 5\.2 s/);
  assert.match(entry.querySelector('.diagnostics-issue-when').textContent, /5 times$/);
  assert.equal(entry.querySelector('.diagnostics-issue-actions > button').dataset.action, 'show-diagnostics-performance');
  const body = entry.querySelector('.diagnostics-issue-tech-body').textContent;
  assert.match(body, /Request.*models:list/s);
  assert.match(body, /Recorded message.*None/s, 'a message equal to the event id counts as none');
});

test('an unmapped action falls back to Inspect activity as the button; the fold links only the members the button misses', () => {
  for (const options of [{}, { availableActions: {} }]) {
    const host = render([WATCH, TREE, MEMORY], options);
    for (const entry of host.querySelectorAll('.diagnostics-issue')) {
      const inspects = Array.from(entry.querySelectorAll('[data-action="inspect-diagnostic-issue"][data-issue]'));
      assert.equal(inspects[0], entry.querySelector('.diagnostics-issue-actions > button'));
      const members = entry.querySelectorAll('.diagnostics-issue-event').length;
      assert.equal(inspects.length, members, entry.dataset.issueGroup + ': one way into Activity per member');
      assert.deepEqual(inspects.slice(1).map((node) => node.closest('.diagnostics-issue-tech-body') !== null), new Array(members - 1).fill(true));
    }
    assert.deepEqual(Array.from(host.querySelectorAll('[data-issue-group="noWorkspaceFolder"] [data-action="inspect-diagnostic-issue"]'))
      .map((node) => decodeURIComponent(node.dataset.issue)), [WATCH.key, TREE.key], 'the button scopes the first member, the fold link the second');
    const memory = host.querySelector('[data-issue-group="fallback:memory.index_write_failed"]');
    assert.equal(memory.querySelector('.diagnostics-issue-badge').textContent, 'Error');
    assert.equal(memory.querySelector('.diagnostics-issue-badge').dataset.tone, 'danger');
    assert.equal(memory.querySelector('strong').textContent, 'Memory reported an error');
    assert.match(memory.querySelector('.diagnostics-issue-when').textContent, /once$/);
    assert.equal(decodeURIComponent(memory.querySelector('[data-action="inspect-diagnostic-issue"]').dataset.issue), MEMORY.key);
    const body = memory.querySelector('.diagnostics-issue-tech-body').textContent;
    assert.match(body, /Code.*CMP-MEM-0042/s);
    assert.match(body, /Recorded advice.*Retry after the lock clears\./s);
    assert.deepEqual(Array.from(memory.querySelectorAll('.diagnostics-issue-correlations code')).map((node) => node.textContent), ['s-1'], 'empty correlation values are skipped');
  }
});

test('the markup carries no fold state; open folds are read back from the live DOM and restored after a repaint', () => {
  const host = render([WATCH, TREE, SLOW], {});
  assert.equal(host.querySelectorAll('details[open]').length, 0, 'closed by default');
  host.querySelector('[data-issue-group="noWorkspaceFolder"] details').open = true;
  assert.deepEqual(Array.from(openGroupsIn(host)), ['noWorkspaceFolder']);
  assert.deepEqual(Array.from(openGroupsIn(null)), []);
  const open = openGroupsIn(host);
  const repainted = render([WATCH, TREE, SLOW], {});
  restoreOpenGroups(repainted, open);
  assert.equal(repainted.querySelector('[data-issue-group="noWorkspaceFolder"] details').open, true);
  assert.equal(repainted.querySelector('[data-issue-group="slowRequest"] details').open, false);
  restoreOpenGroups(null, open);
  restoreOpenGroups(repainted, null);
});

test('the focused control is found again after the list is repainted for new content', () => {
  const dom = new JSDOM('<div id="host">' + renderIssueList([WATCH, TREE, SLOW], { availableActions: AVAILABLE }) + '</div>');
  const host = dom.window.document.getElementById('host');
  assert.equal(focusedControlIn(host), '', 'nothing focused');
  host.querySelector('[data-issue-group="slowRequest"] summary').focus();
  const summary = focusedControlIn(host);
  assert.equal(summary, '[data-issue-group="slowRequest"] summary');
  host.querySelector('[data-issue-group="noWorkspaceFolder"] .diagnostics-issue-link').focus();
  const link = focusedControlIn(host);
  assert.match(link, /^\[data-issue-group="noWorkspaceFolder"\] \[data-action="inspect-diagnostic-issue"\]\[data-issue="/);
  // A new ERROR entry lands first; the same controls exist in the new markup.
  host.innerHTML = renderIssueList([MEMORY, WATCH, TREE, SLOW], { availableActions: AVAILABLE });
  restoreFocus(host, link);
  assert.equal(dom.window.document.activeElement, host.querySelector('[data-issue-group="noWorkspaceFolder"] .diagnostics-issue-link'));
  restoreFocus(host, summary);
  assert.equal(dom.window.document.activeElement.tagName, 'SUMMARY');
  restoreFocus(host, '[data-issue-group="gone"] summary');
  assert.equal(dom.window.document.activeElement.tagName, 'SUMMARY', 'a vanished control leaves focus where it is');
  restoreFocus(null, summary);
  restoreFocus(host, '');
});

test('every interpolated field is escaped and the count is formatted', () => {
  const hostile = '"><img src=x onerror=alert(1)>';
  const nasty = group({
    component: hostile, event: hostile, error_code: hostile, severity: 'ERROR', message: hostile,
    ts: hostile, count: 1234, remediation: hostile, correlations: { request_id: hostile }, data: { channel: hostile },
  });
  const host = render([nasty], { availableActions: {} });
  assert.equal(host.querySelector('img'), null, 'no raw tag survived');
  assert.ok(host.innerHTML.includes('&lt;img'), 'the markup escaped the tag');
  assert.match(host.querySelector('.diagnostics-issue-when').textContent, /1,234 times$/);
  assert.equal(decodeURIComponent(host.querySelector('[data-action="inspect-diagnostic-issue"]').dataset.issue), nasty.key);
});

test('correlation values pass through the caller redaction and labels', () => {
  const host = render([TREE], {
    safeCorrelationValue: (value) => value + ' [safe]',
    statusLabel: (key) => key.toUpperCase(),
  });
  const chip = host.querySelector('.diagnostics-issue-correlations > span');
  assert.equal(chip.querySelector('span').textContent, 'REQUEST');
  assert.equal(chip.querySelector('code').textContent, 'req-1 [safe]');
});

test('the list caps at twenty merged entries and tolerates an empty input', () => {
  const many = Array.from({ length: 25 }, (_, index) => group({ component: 'tool.run', event: 'tool.failed_' + index, severity: 'WARN', message: 'm' }));
  assert.equal(render(many, {}).querySelectorAll('.diagnostics-issue').length, 20);
  assert.equal(renderIssueList([], {}), '');
  assert.equal(renderIssueList(null), '');
});
