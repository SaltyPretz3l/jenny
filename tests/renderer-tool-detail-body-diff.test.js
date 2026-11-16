// new-test-file: renderer-tool-detail-body.test.js is at the 600-line cap
const test = require('node:test');
const assert = require('node:assert/strict');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const fileDiffBindings = require('../renderer/chat/renderer-file-diff-bindings');
const { createToolDetailBody } = require('../renderer/chat/renderer-tool-detail-body');

const hunks = [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-const a = 1;', '+const a = 2;'] }];
const editModel = (input, extra) => ({
  toolName: 'edit_file', toolKind: 'Edit', callId: 'call-edit', sessionId: 'session-diff', domToken: 'edit-diff',
  input, inputExpected: true, inputRecorded: true, outputText: 'ok',
  metadata: { diff: { diff_id: 'diff:edit', status: 'modified', additions: 1, deletions: 1, hunks } },
  ...extra,
});

test.beforeEach(() => fileDiffBindings.disposeFileDiffBindings());
test.after(() => fileDiffBindings.disposeFileDiffBindings());

test('an Edit with a structured diff shows the bare diff, not its Input, and links to the editor', () => {
  const html = createToolDetailBody({ toolCallUtils }).buildDetailBodyMarkup(editModel({ path: 'src/a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' }));
  assert.doesNotMatch(html, /old_string|new_string/);
  assert.doesNotMatch(html, /file-diff-head/);
  assert.match(html, /file-diff--bare/);
  assert.match(html, /data-file-diff-materialized/);
  assert.match(html, /Open diff in editor/);
});

test('arguments the diff does not cover still show as Args', () => {
  const html = createToolDetailBody({ toolCallUtils }).buildDetailBodyMarkup(editModel({ path: 'src/a.js', old_string: 'x', new_string: 'y', replace_all: true }));
  assert.match(html, /tool-call-section-kicker">Args</);
  assert.match(html, /replace_all/);
  assert.doesNotMatch(html, /old_string|new_string/);
});

test('a Write error keeps its Input; several diffs keep their per-file rows', () => {
  const builder = createToolDetailBody({ toolCallUtils });
  const failed = builder.buildDetailBodyMarkup({
    toolName: 'write_file', toolKind: 'Write', callId: 'call-write', domToken: 'write-err', isError: true,
    input: { path: 'src/a.js', content: 'hello' }, inputExpected: true, inputRecorded: true, outputText: 'permission denied',
  });
  assert.match(failed, /tool-call-section-kicker">Input</);
  assert.match(failed, /hello/);
  const multi = builder.buildDetailBodyMarkup({
    toolName: 'write_file', toolKind: 'Write', callId: 'call-multi', sessionId: 'session-diff', domToken: 'multi-diff',
    input: { path: 'src/a.js' },
    metadata: { diffs: [
      { diff_id: 'diff:a', path: 'src/a.js', status: 'created', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }] },
      { diff_id: 'diff:b', path: 'src/b.css', status: 'modified', hunks },
    ] },
  });
  assert.equal((multi.match(/class="file-diff-head"/g) || []).length, 2);
  assert.doesNotMatch(multi, /file-diff--bare/);
  assert.match(multi, /file-diff-note">new file</);
});

test('a single summary-only diff keeps its head row and says why', () => {
  const html = createToolDetailBody({ toolCallUtils }).buildDetailBodyMarkup(editModel({ path: 'a.png', content: 'x' }, {
    metadata: { diff: { diff_id: 'diff:bin', status: 'modified', truncated: true, truncation_reason: 'binary', hunks: [] } },
  }));
  assert.match(html, /file-diff-head/);
  assert.match(html, /binary file/);
  assert.match(html, /tool-call-section-kicker">Input</, 'a summary-only diff covers nothing, so the Input stays');
});

test('a summary-only diff covers nothing, so the Write keeps its Input', () => {
  const html = createToolDetailBody({ toolCallUtils }).buildDetailBodyMarkup(editModel({ path: 'big.js', content: 'BIGCONTENT' }, {
    toolName: 'write_file', toolKind: 'Write',
    metadata: { diff: { diff_id: 'diff:big', status: 'created', truncated: true, truncation_reason: 'line_limit', hunks: [] } },
  }));
  assert.match(html, /BIGCONTENT/);
  assert.match(html, /too long to show here/);
});
