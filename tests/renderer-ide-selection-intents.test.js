'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeSelectionIntents,
  INTENT_TEMPLATES,
} = require('../renderer/features/renderer-ide-selection-intents');
const {
  buildSendToJennyText,
  summarizeBlameCommits,
  pickMarkerUnderCursor,
  sliceSurroundingLines,
} = require('../renderer/features/renderer-ide-send-utils');

function fakeEditorHost(overrides = {}) {
  return {
    actions: [],
    addEditorAction(descriptor) {
      this.actions.push(descriptor);
      return { dispose() {} };
    },
    getActivePath() { return overrides.path !== undefined ? overrides.path : 'src/app.js'; },
    getSelectedText() { return overrides.code !== undefined ? overrides.code : 'const x = 1;'; },
    getSelectionRange() { return overrides.range !== undefined ? overrides.range : { startLine: 3, endLine: 5 }; },
    getActiveLanguageId() { return overrides.language || 'javascript'; },
    getCursorInfo() {
      return overrides.cursor !== undefined ? overrides.cursor : { lineNumber: 12, column: 3, selectedChars: 0 };
    },
    getMarkers() { return overrides.markers || []; },
    getValue() { return overrides.value !== undefined ? overrides.value : ''; },
  };
}

function fakeGitClient(result) {
  return { blameRange: async () => result };
}

// A git client whose blameRange resolves on demand, so two overlapping blame
// calls can be ordered deterministically without timers.
function deferredGitClient() {
  const calls = [];
  return {
    calls,
    blameRange() {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      calls.push({ resolve });
      return promise;
    },
  };
}

const BLAME_RESULT = Object.freeze({
  ok: true,
  available: true,
  isRepo: true,
  op: 'blameRange',
  path: 'src/app.js',
  startLine: 3,
  endLine: 5,
  found: true,
  lines: [
    { line: 3, sha: 'a'.repeat(40), shortSha: 'aaaaaaa', author: 'Jane Doe', dateISO: '2026-06-10T12:00:00.000Z', summary: 'Add input validation' },
    { line: 4, sha: 'a'.repeat(40), shortSha: 'aaaaaaa', author: 'Jane Doe', dateISO: '2026-06-10T12:00:00.000Z', summary: 'Add input validation' },
    { line: 5, sha: 'b'.repeat(40), shortSha: 'bbbbbbb', author: 'John Smith', dateISO: '2026-06-08T09:00:00.000Z', summary: 'Refactor parser loop' },
  ],
});

test('selection intents register the eight editor actions in the jenny group', () => {
  const host = fakeEditorHost();
  const intents = createIdeSelectionIntents({ editorHost: host, onSendToJenny: () => {} });
  intents.registerActions();

  assert.equal(host.actions.length, 8);
  assert.deepEqual(host.actions.map((a) => a.id), [
    'jenny.send-selection.current',
    'jenny.send-selection.new',
    'jenny.selection.explain',
    'jenny.selection.fix',
    'jenny.selection.refactor',
    'jenny.selection.tests',
    'jenny.selection.blame',
    'jenny.selection.fix-squiggle',
  ]);
  for (const action of host.actions) {
    assert.equal(action.contextMenuGroupId, 'jenny');
    assert.equal(typeof action.run, 'function');
  }
  // squiggle-fix acts on the cursor's diagnostic, so it carries no selection
  // precondition; every other action requires a selection.
  for (const action of host.actions) {
    if (action.id === 'jenny.selection.fix-squiggle') {
      assert.equal(action.precondition, undefined);
    } else {
      assert.equal(action.precondition, 'editorHasSelection');
    }
  }
  // contiguous context-menu ordering keeps the jenny group readable top-to-bottom
  assert.deepEqual(host.actions.map((a) => a.contextMenuOrder), [1, 2, 4, 5, 6, 7, 8, 9]);
});

test('an intent action carries the canned instruction; a plain send omits it', () => {
  const host = fakeEditorHost();
  const sent = [];
  const intents = createIdeSelectionIntents({ editorHost: host, onSendToJenny: (p) => sent.push(p) });
  intents.registerActions();
  const run = (id) => host.actions.find((a) => a.id === id).run();

  run('jenny.selection.explain');
  assert.equal(sent.at(-1).intent, INTENT_TEMPLATES.explain);
  assert.equal(sent.at(-1).target, 'current');
  assert.equal(sent.at(-1).kind, 'code_selection');
  assert.equal(sent.at(-1).path, 'src/app.js');

  run('jenny.selection.tests');
  assert.equal(sent.at(-1).intent, INTENT_TEMPLATES.tests);

  run('jenny.send-selection.current');
  assert.equal(sent.at(-1).intent, undefined, 'plain send has no intent');
  run('jenny.send-selection.new');
  assert.equal(sent.at(-1).target, 'new');
});

test('selection intents skip diff tabs and empty selections', () => {
  const sent = [];
  const diff = createIdeSelectionIntents({
    editorHost: fakeEditorHost({ path: 'diff://snapshot' }),
    isDiffTabId: (p) => String(p).startsWith('diff://'),
    onSendToJenny: (p) => sent.push(p),
  });
  diff.sendSelection('current', 'explain');
  assert.equal(sent.length, 0, 'diff tabs are read-only review surfaces');

  const empty = createIdeSelectionIntents({
    editorHost: fakeEditorHost({ code: '' }),
    onSendToJenny: (p) => sent.push(p),
  });
  empty.sendSelection('current', 'fix');
  assert.equal(sent.length, 0, 'an empty selection sends nothing');
});

test('buildSendToJennyText prepends the intent above the fenced block', () => {
  const text = buildSendToJennyText({
    kind: 'code_selection',
    path: 'src/app.js',
    code: 'const x = 1;',
    language: 'javascript',
    startLine: 3,
    endLine: 5,
    intent: INTENT_TEMPLATES.explain,
  });
  assert.ok(text.startsWith(`${INTENT_TEMPLATES.explain}\n\n`), 'intent leads the prefill');
  assert.match(text, /`src\/app\.js` \(lines 3-5\):/);
  assert.match(text, /```javascript\nconst x = 1;\n```/);

  const plain = buildSendToJennyText({
    kind: 'code_selection',
    path: 'src/app.js',
    code: 'const x = 1;',
    language: 'javascript',
    startLine: 3,
    endLine: 5,
  });
  assert.ok(plain.startsWith('`src/app.js`'), 'plain send still leads with the path');
  assert.ok(!plain.includes(INTENT_TEMPLATES.explain), 'plain send carries no intent text');
});

// ── blame-lite ──────────────────────────────────────────────────────────────

test('blame-lite composes a who-changed-this summary from the blamed commits', async () => {
  const host = fakeEditorHost();
  const sent = [];
  const intents = createIdeSelectionIntents({
    editorHost: host,
    gitClient: fakeGitClient(BLAME_RESULT),
    onSendToJenny: (p) => sent.push(p),
  });

  const ok = await intents.sendBlameSummary('current');
  assert.equal(ok, true);
  assert.equal(sent.length, 1);

  const payload = sent[0];
  assert.equal(payload.kind, 'code_selection');
  assert.equal(payload.target, 'current');
  assert.equal(payload.path, 'src/app.js');
  assert.equal(payload.startLine, 3);
  assert.equal(payload.endLine, 5);
  // The two 'a' lines collapse into one commit, plus the 'b' commit.
  assert.match(payload.intent, /Add input validation/);
  assert.match(payload.intent, /Refactor parser loop/);
  assert.match(payload.intent, /Jane Doe/);
  assert.match(payload.intent, /John Smith/);
  assert.match(payload.intent, /lines 3-5 of `src\/app\.js`/);
  assert.match(payload.intent, /`aaaaaaa`/);

  // End to end: the composed prefill carries the subjects above the fenced code.
  const text = buildSendToJennyText(payload);
  assert.ok(text.includes('Add input validation'));
  assert.ok(text.includes('Refactor parser loop'));
  assert.match(text, /```javascript\nconst x = 1;\n```/);
});

test('blame-lite surfaces a loading notice while the git lookup runs', async () => {
  const host = fakeEditorHost();
  const notices = [];
  const intents = createIdeSelectionIntents({
    editorHost: host,
    gitClient: fakeGitClient(BLAME_RESULT),
    onSendToJenny: () => {},
    onNotice: (m) => notices.push(m),
  });
  await intents.sendBlameSummary('current');
  assert.ok(
    notices.some((m) => /looking up who changed/i.test(m)),
    `expected an in-flight loading notice, got ${JSON.stringify(notices)}`
  );
});

test('blame-lite registers an action that drives the blame send', async () => {
  const host = fakeEditorHost();
  const sent = [];
  const intents = createIdeSelectionIntents({
    editorHost: host,
    gitClient: fakeGitClient(BLAME_RESULT),
    onSendToJenny: (p) => sent.push(p),
  });
  intents.registerActions();
  await host.actions.find((a) => a.id === 'jenny.selection.blame').run();
  assert.equal(sent.length, 1);
  assert.match(sent[0].intent, /Add input validation/);
});

test('blame-lite degrades on empty selection, no git, not-in-HEAD, and diff tabs', async () => {
  const emptySent = [];
  const empty = createIdeSelectionIntents({
    editorHost: fakeEditorHost({ code: '   ' }),
    gitClient: fakeGitClient(BLAME_RESULT),
    onSendToJenny: (p) => emptySent.push(p),
  });
  assert.equal(await empty.sendBlameSummary('current'), false);
  assert.equal(emptySent.length, 0);

  const noRangeSent = [];
  const noRange = createIdeSelectionIntents({
    editorHost: fakeEditorHost({ range: null }),
    gitClient: fakeGitClient(BLAME_RESULT),
    onSendToJenny: (p) => noRangeSent.push(p),
  });
  assert.equal(await noRange.sendBlameSummary('current'), false);
  assert.equal(noRangeSent.length, 0);

  const noGitSent = [];
  const noGit = createIdeSelectionIntents({
    editorHost: fakeEditorHost(),
    gitClient: fakeGitClient({ ok: false, available: false, isRepo: false, op: 'blameRange', reason: 'bridge_unavailable' }),
    onSendToJenny: (p) => noGitSent.push(p),
  });
  assert.equal(await noGit.sendBlameSummary('current'), false);
  assert.equal(noGitSent.length, 0);

  const notTrackedSent = [];
  const notTracked = createIdeSelectionIntents({
    editorHost: fakeEditorHost(),
    gitClient: fakeGitClient({ ok: true, available: true, isRepo: true, op: 'blameRange', found: false, reason: 'not_in_head', lines: [] }),
    onSendToJenny: (p) => notTrackedSent.push(p),
  });
  assert.equal(await notTracked.sendBlameSummary('current'), false);
  assert.equal(notTrackedSent.length, 0);

  const diffSent = [];
  const diff = createIdeSelectionIntents({
    editorHost: fakeEditorHost({ path: 'diff://snapshot' }),
    isDiffTabId: (p) => String(p).startsWith('diff://'),
    gitClient: fakeGitClient(BLAME_RESULT),
    onSendToJenny: (p) => diffSent.push(p),
  });
  assert.equal(await diff.sendBlameSummary('current'), false);
  assert.equal(diffSent.length, 0);
});

test('blame-lite is a no-op (with a notice) when the resolved client cannot blame', async () => {
  const sent = [];
  const notices = [];
  const intents = createIdeSelectionIntents({
    editorHost: fakeEditorHost(),
    // A client missing blameRange (e.g. an older bridge shape) must degrade.
    gitClient: { notAClient: true },
    onSendToJenny: (p) => sent.push(p),
    onNotice: (m) => notices.push(m),
  });
  assert.equal(await intents.sendBlameSummary('current'), false);
  assert.equal(sent.length, 0);
  assert.deepEqual(notices, ['Git is not available in this workspace.']);
});

test('blame-lite degrades when the range is tracked but yields no commits', async () => {
  // found:true with empty porcelain output (a distinct branch from found:false).
  const sent = [];
  const intents = createIdeSelectionIntents({
    editorHost: fakeEditorHost(),
    gitClient: fakeGitClient({ ok: true, available: true, isRepo: true, op: 'blameRange', found: true, lines: [] }),
    onSendToJenny: (p) => sent.push(p),
  });
  assert.equal(await intents.sendBlameSummary('current'), false);
  assert.equal(sent.length, 0);
});

test('blame-lite supersession: the latest click wins, the superseded one prefills nothing', async () => {
  const client = deferredGitClient();
  const sent = [];
  const intents = createIdeSelectionIntents({
    editorHost: fakeEditorHost(),
    gitClient: client,
    onSendToJenny: (p) => sent.push(p),
  });

  const first = intents.sendBlameSummary('current');
  const second = intents.sendBlameSummary('current');
  // Resolve the SECOND (latest) call, then the stale FIRST - proving the stale
  // one is dropped by the supersession token, not by resolution order.
  client.calls[1].resolve(BLAME_RESULT);
  client.calls[0].resolve({
    ok: true,
    available: true,
    isRepo: true,
    op: 'blameRange',
    found: true,
    lines: [{ line: 9, sha: 'c'.repeat(40), shortSha: 'ccccccc', author: 'Stale', dateISO: '', summary: 'STALE COMMIT' }],
  });
  const [firstOk, secondOk] = await Promise.all([first, second]);

  assert.equal(secondOk, true);
  assert.equal(firstOk, false, 'the superseded blame returns false');
  assert.equal(sent.length, 1, 'only the latest blame prefills');
  assert.match(sent[0].intent, /Add input validation/);
  assert.ok(!sent[0].intent.includes('STALE COMMIT'), 'the stale blame never reaches the composer');
});

// ── squiggle-fix ────────────────────────────────────────────────────────────

test('squiggle-fix sends the marker under the cursor + the surrounding range', () => {
  const value = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const host = fakeEditorHost({
    value,
    cursor: { lineNumber: 12, column: 5, selectedChars: 0 },
    markers: [
      { path: 'other.js', severity: 'error', message: 'wrong file', line: 12, column: 1, source: 'eslint', code: 'x' },
      { path: 'src/app.js', severity: 'warning', message: 'far away', line: 2, column: 1, source: 'eslint', code: 'a' },
      { path: 'src/app.js', severity: 'error', message: "'x' is assigned a value but never used", line: 12, column: 7, source: 'eslint', code: 'no-unused-vars' },
    ],
  });
  const sent = [];
  const intents = createIdeSelectionIntents({ editorHost: host, onSendToJenny: (p) => sent.push(p) });

  const ok = intents.sendSquiggleFix('current');
  assert.equal(ok, true);
  assert.equal(sent.length, 1);

  const payload = sent[0];
  assert.equal(payload.kind, 'code_selection');
  assert.equal(payload.path, 'src/app.js');
  // Picked the same-line (12) marker on the active path - not other.js, not line 2.
  assert.match(payload.intent, /'x' is assigned a value but never used/);
  assert.match(payload.intent, /no-unused-vars/);
  assert.match(payload.intent, /reported by eslint/);
  // Surrounding range = line 12 ± 8 = [4, 20].
  assert.equal(payload.startLine, 4);
  assert.equal(payload.endLine, 20);
  assert.ok(payload.code.startsWith('line 4\n'));
  assert.ok(payload.code.endsWith('\nline 20'));
});

test('squiggle-fix registers an action that drives the fix send', () => {
  const host = fakeEditorHost({
    value: 'a\nb\nc\nd\ne',
    cursor: { lineNumber: 3, column: 1, selectedChars: 0 },
    markers: [{ path: 'src/app.js', severity: 'error', message: 'boom', line: 3, column: 1, source: 'tsc', code: '2304' }],
  });
  const sent = [];
  const intents = createIdeSelectionIntents({ editorHost: host, onSendToJenny: (p) => sent.push(p) });
  intents.registerActions();
  host.actions.find((a) => a.id === 'jenny.selection.fix-squiggle').run();
  assert.equal(sent.length, 1);
  assert.match(sent[0].intent, /boom/);
  assert.match(sent[0].intent, /reported by tsc \(2304\)/);
});

test('squiggle-fix degrades with no marker, no cursor, and on diff tabs', () => {
  // Marker exists but on a different line than the cursor.
  const offLineSent = [];
  const offLine = createIdeSelectionIntents({
    editorHost: fakeEditorHost({
      value: 'a\nb\nc\nd\ne',
      cursor: { lineNumber: 3, column: 1, selectedChars: 0 },
      markers: [
        { path: 'src/app.js', severity: 'error', message: 'elsewhere', line: 5, column: 1, source: 'eslint', code: 'z' },
        { path: 'other.js', severity: 'error', message: 'other file', line: 3, column: 1, source: 'eslint', code: 'y' },
      ],
    }),
    onSendToJenny: (p) => offLineSent.push(p),
  });
  assert.equal(offLine.sendSquiggleFix('current'), false);
  assert.equal(offLineSent.length, 0);

  // No markers at all.
  const noMarkerSent = [];
  const noMarker = createIdeSelectionIntents({
    editorHost: fakeEditorHost({ value: 'a\nb\nc', markers: [] }),
    onSendToJenny: (p) => noMarkerSent.push(p),
  });
  assert.equal(noMarker.sendSquiggleFix('current'), false);
  assert.equal(noMarkerSent.length, 0);

  // No cursor info (no active file doc).
  const noCursorSent = [];
  const noCursor = createIdeSelectionIntents({
    editorHost: fakeEditorHost({ cursor: null, markers: [{ path: 'src/app.js', line: 1, column: 1, message: 'x', severity: 'error' }] }),
    onSendToJenny: (p) => noCursorSent.push(p),
  });
  assert.equal(noCursor.sendSquiggleFix('current'), false);
  assert.equal(noCursorSent.length, 0);

  // Diff tabs are read-only review surfaces.
  const diffSent = [];
  const diff = createIdeSelectionIntents({
    editorHost: fakeEditorHost({
      path: 'diff://snapshot',
      cursor: { lineNumber: 1, column: 1, selectedChars: 0 },
      markers: [{ path: 'diff://snapshot', line: 1, column: 1, message: 'x', severity: 'error' }],
    }),
    isDiffTabId: (p) => String(p).startsWith('diff://'),
    onSendToJenny: (p) => diffSent.push(p),
  });
  assert.equal(diff.sendSquiggleFix('current'), false);
  assert.equal(diffSent.length, 0);

  // Marker on the cursor line but the document yields no surrounding code
  // (getMarkers and getValue are independent sources).
  const emptySliceSent = [];
  const emptySlice = createIdeSelectionIntents({
    editorHost: fakeEditorHost({
      value: '',
      cursor: { lineNumber: 1, column: 1, selectedChars: 0 },
      markers: [{ path: 'src/app.js', line: 1, column: 1, message: 'x', severity: 'error' }],
    }),
    onSendToJenny: (p) => emptySliceSent.push(p),
  });
  assert.equal(emptySlice.sendSquiggleFix('current'), false);
  assert.equal(emptySliceSent.length, 0);
});

// ── degrade notices ─────────────────────────────────────────────────────────

test('blame-lite and squiggle-fix surface a notice on user-facing degrade paths', async () => {
  // blame: a real selection but the range has no git history -> notice.
  const blameNotices = [];
  const blame = createIdeSelectionIntents({
    editorHost: fakeEditorHost(),
    gitClient: fakeGitClient({ ok: true, available: true, isRepo: true, op: 'blameRange', found: false, reason: 'not_in_head', lines: [] }),
    onSendToJenny: () => {},
    onNotice: (m) => blameNotices.push(m),
  });
  assert.equal(await blame.sendBlameSummary('current'), false);
  // The in-flight loading notice fires first (lookup started), then the
  // no-history degrade notice once the blame returns empty.
  assert.deepEqual(blameNotices, [
    'Looking up who changed these lines…',
    'No git history found for these lines.',
  ]);

  // blame: empty selection is precondition-guarded -> stays silent.
  const blameSilent = [];
  const emptyBlame = createIdeSelectionIntents({
    editorHost: fakeEditorHost({ code: '   ' }),
    gitClient: fakeGitClient(BLAME_RESULT),
    onSendToJenny: () => {},
    onNotice: (m) => blameSilent.push(m),
  });
  assert.equal(await emptyBlame.sendBlameSummary('current'), false);
  assert.equal(blameSilent.length, 0);

  // squiggle: cursor present but no marker on the line -> notice (the action
  // has no precondition, so the user can click it anywhere).
  const squiggleNotices = [];
  const squiggle = createIdeSelectionIntents({
    editorHost: fakeEditorHost({
      value: 'a\nb\nc',
      cursor: { lineNumber: 2, column: 1, selectedChars: 0 },
      markers: [{ path: 'src/app.js', line: 99, column: 1, message: 'far', severity: 'error' }],
    }),
    onSendToJenny: () => {},
    onNotice: (m) => squiggleNotices.push(m),
  });
  assert.equal(squiggle.sendSquiggleFix('current'), false);
  assert.deepEqual(squiggleNotices, ['No problem at the cursor to fix.']);

  // squiggle: no cursor / no active doc -> not meaningfully invokable, silent.
  const squiggleSilent = [];
  const noCursor = createIdeSelectionIntents({
    editorHost: fakeEditorHost({ cursor: null, markers: [] }),
    onSendToJenny: () => {},
    onNotice: (m) => squiggleSilent.push(m),
  });
  assert.equal(noCursor.sendSquiggleFix('current'), false);
  assert.equal(squiggleSilent.length, 0);
});

// ── pure helpers ────────────────────────────────────────────────────────────

test('summarizeBlameCommits dedupes by sha, first-seen order', () => {
  const commits = summarizeBlameCommits(BLAME_RESULT.lines);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits.map((c) => c.summary), ['Add input validation', 'Refactor parser loop']);
  assert.equal(commits[0].shortSha, 'aaaaaaa');
  assert.equal(summarizeBlameCommits(null).length, 0);
  assert.equal(summarizeBlameCommits([{ author: 'x' }]).length, 0, 'sha-less rows are skipped');
});

test('pickMarkerUnderCursor matches path + line, nearest column wins', () => {
  const markers = [
    { path: 'src/app.js', line: 10, column: 2, message: 'left' },
    { path: 'src/app.js', line: 10, column: 9, message: 'right' },
    { path: 'src/app.js', line: 11, column: 1, message: 'next line' },
    { path: 'other.js', line: 10, column: 8, message: 'other file' },
  ];
  const near = pickMarkerUnderCursor(markers, { path: 'src/app.js', lineNumber: 10, column: 8 });
  assert.equal(near.message, 'right');
  const far = pickMarkerUnderCursor(markers, { path: 'src/app.js', lineNumber: 10, column: 1 });
  assert.equal(far.message, 'left');
  assert.equal(pickMarkerUnderCursor(markers, { path: 'src/app.js', lineNumber: 99, column: 1 }), null);
  assert.equal(pickMarkerUnderCursor(markers, { path: '', lineNumber: 10, column: 1 }), null);
});

test('sliceSurroundingLines clamps to the document bounds', () => {
  const text = Array.from({ length: 6 }, (_, i) => `L${i + 1}`).join('\r\n');
  // Centre at line 2, radius 8 -> clamps to [1, 6] and normalizes CRLF.
  const slice = sliceSurroundingLines(text, 2, 8);
  assert.equal(slice.startLine, 1);
  assert.equal(slice.endLine, 6);
  assert.equal(slice.code, 'L1\nL2\nL3\nL4\nL5\nL6');
  // Empty document -> empty snippet.
  assert.equal(sliceSurroundingLines('', 1, 8).code, '');
});
