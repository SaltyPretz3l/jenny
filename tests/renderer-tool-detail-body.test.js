const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const detailBodyModulePath = require.resolve('../renderer/chat/renderer-tool-detail-body');
function loadDetailBody() {
  delete require.cache[detailBodyModulePath];
  return require(detailBodyModulePath);
}
const detailBody = loadDetailBody();
const fileDiffBindings = require('../renderer/chat/renderer-file-diff-bindings');
const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');

function createBuilder(module = detailBody) {
  return module.createToolDetailBody({ toolCallUtils });
}

function captions(markup) {
  return Array.from(markup.matchAll(/tool-call-section-kicker(?:--error)?">([^<]+)/g), (match) => match[1]);
}

test('detail text registries enforce FIFO entry and UTF-8 byte bounds', () => {
  const entryBoundedDetailBody = loadDetailBody();
  for (let index = 0; index < 200; index += 1) {
    entryBoundedDetailBody.registerFullText(`entry-${index}`, `value-${index}`);
  }
  entryBoundedDetailBody.registerFullText('entry-0', 'value-0');
  entryBoundedDetailBody.registerFullText('entry-200', 'value-200');
  assert.equal(entryBoundedDetailBody.getFullText('entry-0'), null);
  assert.equal(entryBoundedDetailBody.getFullText('entry-1'), 'value-1');
  assert.equal(entryBoundedDetailBody.getFullText('entry-200'), 'value-200');

  const oversizedDetailBody = loadDetailBody();
  oversizedDetailBody.registerFullText('oversized', '😀'.repeat(2_100_000));
  assert.equal(oversizedDetailBody.getFullText('oversized'), null, 'a single entry cannot exceed the byte budget');
  oversizedDetailBody.registerFullText('newest', 'bounded');
  assert.equal(oversizedDetailBody.getFullText('oversized'), null);
  assert.equal(oversizedDetailBody.getFullText('newest'), 'bounded');

  const byteBoundedDetailBody = loadDetailBody();
  byteBoundedDetailBody.registerFullText('first-large', 'a'.repeat(5 * 1024 * 1024));
  byteBoundedDetailBody.registerFullText('second-large', 'b'.repeat(5 * 1024 * 1024));
  assert.equal(byteBoundedDetailBody.getFullText('first-large'), null, 'oldest entry is evicted at the byte budget');
  assert.equal(byteBoundedDetailBody.getFullText('second-large')?.length, 5 * 1024 * 1024);
});

test('module-level detail builder is usable without consumer initialization', () => {
  const html = detailBody.buildDetailBodyMarkup({
    toolName: 'Tool', outputText: 'direct output', domToken: 'direct',
  });
  assert.match(html, /data-tool-detail-body="true"/);
  assert.match(html, /direct output/);
});

test('generic details are flat, ordered, copyable sections with no legacy panel chrome', () => {
  const html = createBuilder().buildDetailBodyMarkup({
    toolName: 'read_file',
    toolKind: 'Read',
    input: { path: 'README.md', line: 4 },
    inputExpected: true,
    inputRecorded: true,
    outputText: 'hello',
    domToken: 'generic',
  });
  assert.deepEqual(captions(html), ['Input', 'Output']);
  assert.match(html, /class="tool-kv-grid"/);
  assert.match(html, /data-inv-copy-target="generic-input"/);
  assert.match(html, /title="Copy to clipboard"[^>]*data-inv-copy-target="generic-input"/);
  assert.doesNotMatch(html, /tool-io-panel|inv-codeblock-gutter|overflow-y/);
});

test('tool detail code sections carry language hints only for code-shaped content', () => {
  const builder = createBuilder();
  const bash = new JSDOM(`<body>${builder.buildDetailBodyMarkup({
    toolName: 'run_command', toolKind: 'Bash', domToken: 'languages-bash',
    input: { command: 'npm test', env: { CI: true } },
    metadata: { stdout: 'plain stdout' },
  })}</body>`).window.document;
  const bashSections = Object.fromEntries(Array.from(bash.querySelectorAll('.tool-call-section')).map((section) => [
    section.querySelector('.tool-call-section-kicker')?.textContent,
    section.querySelector('code'),
  ]));
  assert.equal(bashSections.Args.dataset.languageId, 'json');
  assert.equal(bashSections.Args.dataset.codeHighlight, 'pending');
  assert.equal(bashSections.Command.dataset.languageId, 'shell');
  assert.equal(bashSections.Command.classList.contains('language-shell'), true);
  assert.equal(bashSections.Stdout.hasAttribute('data-language-id'), false);
  assert.equal(bashSections.Stdout.hasAttribute('data-code-highlight'), false);

  const jsonStdout = new JSDOM(`<body>${builder.buildDetailBodyMarkup({
    toolName: 'run_command', toolKind: 'Bash', domToken: 'languages-json-stdout',
    input: { command: 'echo json' }, metadata: { stdout: '{"ok":true}' },
  })}</body>`).window.document;
  const stdoutCode = Array.from(jsonStdout.querySelectorAll('.tool-call-section')).find((section) => (
    section.querySelector('.tool-call-section-kicker')?.textContent === 'Stdout'
  )).querySelector('code');
  // Area 3 (owner addition): command output stays plain unless it parses as JSON.
  assert.equal(stdoutCode.dataset.languageId, 'json');
  assert.equal(stdoutCode.dataset.codeHighlight, 'pending');
  assert.equal(stdoutCode.textContent, '{\n  "ok": true\n}', 'pretty-printed with a two-space indent');

  const read = new JSDOM(`<body>${builder.buildDetailBodyMarkup({
    toolName: 'read_file', toolKind: 'Read', domToken: 'languages-read',
    input: { path: 'src/example.ts' }, outputText: 'const value: number = 1;',
  })}</body>`).window.document;
  const output = Array.from(read.querySelectorAll('.tool-call-section')).find((section) => (
    section.querySelector('.tool-call-section-kicker')?.textContent === 'Output'
  )).querySelector('code');
  assert.equal(output.dataset.languageId, 'typescript');
  assert.equal(output.dataset.codeHighlight, 'pending');

  const write = new JSDOM(`<body>${builder.buildDetailBodyMarkup({
    toolName: 'write_file', toolKind: 'Write', domToken: 'languages-write',
    path: 'src/example.js', outputText: 'Wrote 120 bytes to src/example.js',
  })}</body>`).window.document;
  assert.equal(
    write.querySelector('.tool-call-section code').hasAttribute('data-language-id'),
    false,
    'a write receipt is prose, not code in the file language'
  );

  const jsonOutput = new JSDOM(`<body>${builder.buildDetailBodyMarkup({
    toolName: 'custom_tool', domToken: 'languages-json-output', outputText: '{"ok":true}',
  })}</body>`).window.document;
  assert.equal(jsonOutput.querySelector('.tool-call-section code').dataset.languageId, 'json');

  const python = new JSDOM(`<body>${builder.buildDetailBodyMarkup({
    toolName: 'python_execute', toolKind: 'python_execute', domToken: 'languages-python',
    input: { code: 'print("ok")' }, outputText: '{"stdout":"ok"}',
  })}</body>`).window.document;
  assert.equal(python.querySelector('.tool-call-section code').dataset.languageId, 'python');
});

test('a failed tool error chip deep-links to Activity when the row carries a stream id', () => {
  // Owner report 2026-08-20: tool-row error chips rendered inert while the
  // assistant-error card chips deep-linked. The stream id (row.turn_id) now
  // threads through the detail model into buildErrorCodeChip.
  const builder = createBuilder();
  const linked = builder.buildDetailBodyMarkup({
    toolName: 'list_dir', isError: true, status: 'error',
    errorCode: 'CMP-TOOL-0042', streamId: 'stream-77',
    resultSummary: 'list_dir failed', domToken: 'err-linked',
  });
  assert.match(linked, /role="link"[^>]*data-inv-error-action="open_logs"[^>]*data-stream-id="stream-77"/);
  assert.match(linked, /CMP-TOOL-0042/);

  const inert = builder.buildDetailBodyMarkup({
    toolName: 'list_dir', isError: true, status: 'error',
    errorCode: 'CMP-TOOL-0042',
    resultSummary: 'list_dir failed', domToken: 'err-inert',
  });
  assert.match(inert, /CMP-TOOL-0042/, 'the code still renders as metadata');
  assert.doesNotMatch(inert, /data-stream-id/, 'no stream id -> inert chip, never a dead link');
});

test('settled single and multi-file structured diffs use the shared lazy view without raw Output JSON', () => {
  const builder = createBuilder();
  const single = builder.buildDetailBodyMarkup({
    toolName: 'edit_file', toolKind: 'Edit', callId: 'call-edit', sessionId: 'session-a',
    input: { path: 'src/a.js', old_text: 'old' }, inputExpected: true, inputRecorded: true,
    outputText: '{"should":"not render"}', domToken: 'edit-single',
    metadata: { diff: { diff_id: 'diff:single', additions: 1, deletions: 0, hunks: [{ oldStart: 1, newStart: 1, lines: ['+new'] }] } },
  });
  assert.match(single, /class="file-diff"/);
  assert.match(single, /src\/a\.js/);
  assert.match(single, /data-file-diff-pending/);
  assert.doesNotMatch(single, /should|tool-call-section-kicker">Output/);

  const multi = builder.buildDetailBodyMarkup({
    toolName: 'write_file', toolKind: 'Write', callId: 'call-write', sessionId: 'session-a',
    metadata: { diffs: [
      { diff_id: 'diff:a', path: 'src/a.js', hunks: [{ oldStart: 1, newStart: 1, lines: ['+a'] }] },
      { diff_id: 'diff:b', path: 'src/b.css', hunks: [{ oldStart: 2, newStart: 2, lines: ['-b'] }] },
    ] },
    outputText: '[raw output]', domToken: 'edit-multi',
  });
  assert.equal((multi.match(/class="file-diff"/g) || []).length, 2);
  assert.match(multi, /src\/a\.js/);
  assert.match(multi, /src\/b\.css/);
  assert.doesNotMatch(multi, /raw output|tool-call-section-kicker">Output/);
});

test('parent-expanded diffs open by default while explicit per-diff choices win', (t) => {
  fileDiffBindings.disposeFileDiffBindings();
  t.after(() => fileDiffBindings.disposeFileDiffBindings());
  const builder = createBuilder();
  const model = {
    toolName: 'write_file', toolKind: 'Write', callId: 'call-default-open', sessionId: 'session-default-open',
    input: { path: 'src/a.js' }, domToken: 'default-open', expandFileDiffsByDefault: true,
    metadata: { diffs: [
      { diff_id: 'diff:default-a', path: 'src/a.js', hunks: [{ oldStart: 1, newStart: 1, lines: ['+a'] }] },
      { diff_id: 'diff:default-b', path: 'src/b.js', hunks: [{ oldStart: 1, newStart: 1, lines: ['+b'] }] },
    ] },
  };

  const initiallyOpen = new JSDOM(`<body>${builder.buildDetailBodyMarkup(model)}</body>`).window.document;
  assert.equal(initiallyOpen.querySelectorAll('.file-diff[data-expanded="true"]').length, 2);
  assert.equal(initiallyOpen.querySelectorAll('[data-file-diff-materialized] .diff-line').length, 2);
  assert.equal(initiallyOpen.querySelectorAll('[data-file-diff-pending]').length, 0);

  fileDiffBindings.setFileDiffExpanded('diff:default-a', false);
  const rerendered = new JSDOM(`<body>${builder.buildDetailBodyMarkup(model)}</body>`).window.document;
  assert.equal(rerendered.querySelector('[data-diff-id="diff:default-a"]').dataset.expanded, 'false');
  assert.ok(rerendered.querySelector('[data-diff-id="diff:default-a"] [data-file-diff-pending]'));
  assert.equal(rerendered.querySelector('[data-diff-id="diff:default-b"]').dataset.expanded, 'true');
});

test('structured diff metadata selects the diff view independently of the file tool name', (t) => {
  fileDiffBindings.disposeFileDiffBindings();
  t.after(() => fileDiffBindings.disposeFileDiffBindings());
  const builder = createBuilder();

  for (const toolKind of ['Read', 'delete_file', 'future_file_operation']) {
    const html = builder.buildDetailBodyMarkup({
      toolName: toolKind, toolKind, callId: `call-${toolKind}`, sessionId: 'session-metadata-routing',
      input: { path: `src/${toolKind}.txt` }, expandFileDiffsByDefault: true,
      metadata: { diff: {
        diff_id: `diff:${toolKind}`, path: `src/${toolKind}.txt`,
        hunks: [{ oldStart: 1, newStart: 1, lines: ['+changed'] }],
      } },
    });
    assert.match(html, /class="file-diff"/, `${toolKind} should use its structured diff`);
    assert.match(html, /data-file-diff-materialized/, `${toolKind} diff should default open`);
    assert.doesNotMatch(html, /tool-call-section-kicker">Output/);
  }
});

test('pretty JSON memoization invalidates when a live row reuses its copy id with new output', () => {
  const isolatedDetailBody = loadDetailBody();
  const builder = createBuilder(isolatedDetailBody);
  builder.buildDetailBodyMarkup({ toolName: 'Tool', outputText: '{"value":1}', domToken: 'live-json' });
  const updated = builder.buildDetailBodyMarkup({ toolName: 'Tool', outputText: '{"value":2}', domToken: 'live-json' });
  assert.match(updated, /&quot;value&quot;: 2/);
  assert.doesNotMatch(updated, /&quot;value&quot;: 1/);
  assert.match(isolatedDetailBody.getFullText('live-json-output'), /"value": 2/);
});

test('a JSON output is parsed once per build: the pretty print decides the json language, a cached build parses nothing', () => {
  const isolatedDetailBody = loadDetailBody();
  const builder = createBuilder(isolatedDetailBody);
  const original = JSON.parse;
  let parses = 0;
  const build = () => {
    JSON.parse = function countingParse(...args) { parses += 1; return original.apply(this, args); };
    try {
      return builder.buildDetailBodyMarkup({ toolName: 'custom_tool', outputText: '{"ok":true}', domToken: 'parse-once' });
    } finally {
      JSON.parse = original;
    }
  };
  const first = build();
  assert.equal(parses, 1, 'one parse pretty-prints and tags the section');
  assert.match(first, /data-language-id="json"/);
  const second = build();
  assert.equal(parses, 1, 'the cached pretty text still knows it was JSON');
  assert.match(second, /data-language-id="json"/);
});

test('rehydrated Bash JSON reconstructs the same sections as live metadata', () => {
  const builder = createBuilder();
  const base = {
    toolName: 'run_command', toolKind: 'Bash',
    input: { command: 'printf ok', cwd: '/tmp' },
    inputExpected: true, inputRecorded: true, domToken: 'bash',
  };
  const live = builder.buildDetailBodyMarkup({
    ...base,
    metadata: { stdout: 'ok', stderr: 'warn', exitCode: 2 },
  });
  const rehydrated = builder.buildDetailBodyMarkup({
    ...base,
    outputText: JSON.stringify({ stdout: 'ok', stderr: 'warn', exit_code: 2 }),
  });
  assert.deepEqual(captions(rehydrated), captions(live));
  assert.deepEqual(captions(rehydrated), ['Args', 'Command', 'Stdout', 'Stderr']);
  assert.match(rehydrated, />exit 2</);
});

test('Bash recovery parses only bounded structured output and keeps oversized JSON generic', () => {
  const oversized = JSON.stringify({ stdout: 'x'.repeat(detailBody.TOOL_DETAIL_PREVIEW_MAX_CHARS) });
  const html = createBuilder().buildDetailBodyMarkup({
    toolName: 'run_command', toolKind: 'Bash', outputText: oversized, domToken: 'bash-large',
  });
  assert.deepEqual(captions(html), ['Output']);
  assert.match(html, /data-detail-capped="true"/);
  assert.doesNotMatch(html, /tool-call-section-kicker">Stdout/);
});

test('Python output falls back to the generic section when it is malformed or outside the known schema', () => {
  const builder = createBuilder();
  const malformed = builder.buildDetailBodyMarkup({
    toolName: 'python_execute', toolKind: 'python_execute', outputText: 'plain output', domToken: 'python-plain',
  });
  const unknown = builder.buildDetailBodyMarkup({
    toolName: 'python_execute', toolKind: 'python_execute', outputText: '{"value":1}', domToken: 'python-unknown',
  });
  assert.deepEqual(captions(malformed), ['Output']);
  assert.match(malformed, /plain output/);
  assert.deepEqual(captions(unknown), ['Output']);
  assert.match(unknown, /&quot;value&quot;: 1/);
});

test('default table sanitizer preserves Python tables through the production DOMPurify seam', (t) => {
  const previousPurify = globalThis.DOMPurify;
  t.after(() => {
    if (previousPurify === undefined) delete globalThis.DOMPurify;
    else globalThis.DOMPurify = previousPurify;
  });
  let receivedOptions = null;
  globalThis.DOMPurify = {
    sanitize: (_html, options) => {
      receivedOptions = options;
      return '<table class="safe"><tbody><tr><td>value</td></tr></tbody></table>';
    },
  };
  const html = createTurnRowToolRenderUtils({}).buildToolCallRowMarkup({
    row_id: 'python-table-row',
    payload: {
      tool_call_id: 'python-table', tool_name: 'python_execute', state: 'completed', input: { code: 'table()' },
    },
  }, [], {
    forceMaterializeToolDetails: true,
    pairedToolResultRow: {
      payload: { tool_call_id: 'python-table', output_text: JSON.stringify({ tables: [{ html: '<table>raw</table>' }] }) },
    },
  });
  assert.match(html, /<table class="safe">/);
  assert.deepEqual(receivedOptions.ALLOWED_ATTR, ['class']);
  assert.equal(receivedOptions.ALLOW_DATA_ATTR, false);
});

test('block and minimal row families emit identical section order for the same Bash turn', () => {
  const escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toolUse = {
    id: 'use-1', role: 'assistant', kind: 'tool_use',
    tool_call: { call_id: 'call-1', tool_name: 'run_command', status: 'completed', input: { command: 'echo ok', cwd: '/tmp' } },
  };
  const toolResult = {
    id: 'result-1', role: 'tool', kind: 'tool_result',
    tool_result: { call_id: 'call-1', tool_name: 'run_command', output_text: '', metadata: { stdout: 'ok', stderr: 'warn', exitCode: 1 } },
  };
  const blockHtml = createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils })
    .renderToolCallBlock(toolUse, [toolUse, toolResult], { forceMaterializeToolDetails: true });
  const minimalHtml = createTurnRowToolRenderUtils({ escapeHtml, normalizeId: (value) => String(value || '').trim() })
    .buildToolCallRowMarkup({
      row_id: 'row-1',
      payload: { tool_call_id: 'call-1', tool_name: 'run_command', state: 'completed', input: toolUse.tool_call.input },
    }, [], {
      pairedToolResultRow: { payload: { tool_call_id: 'call-1', tool_name: 'run_command', output_text: '', metadata: toolResult.tool_result.metadata } },
      forceMaterializeToolDetails: true,
    });
  assert.deepEqual(captions(blockHtml), captions(minimalHtml));
  assert.deepEqual(captions(blockHtml), ['Args', 'Command', 'Stdout', 'Stderr']);
});

test('block and minimal Python details preserve trusted attachment image parity', () => {
  const escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toolUse = {
    id: 'python-use', role: 'assistant', kind: 'tool_use',
    tool_call: { call_id: 'python-call', tool_name: 'python_execute', status: 'completed', input: { code: 'plot()' } },
  };
  const resultPayload = {
    call_id: 'python-call', tool_call_id: 'python-call', tool_name: 'python_execute',
    output_text: JSON.stringify({ images: [] }),
    trusted_attachment_refs: [{ asset_path: 'C:\\tmp\\plot.png' }],
  };
  const blockHtml = createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils })
    .renderToolCallBlock(toolUse, [toolUse, { id: 'python-result', role: 'tool', kind: 'tool_result', tool_result: resultPayload }], {
      forceMaterializeToolDetails: true,
    });
  const minimalHtml = createTurnRowToolRenderUtils({ escapeHtml })
    .buildToolCallRowMarkup({
      row_id: 'python-row',
      payload: { tool_call_id: 'python-call', tool_name: 'python_execute', state: 'completed', input: toolUse.tool_call.input },
    }, [], {
      pairedToolResultRow: { payload: resultPayload },
      forceMaterializeToolDetails: true,
    });
  assert.deepEqual(captions(blockHtml), captions(minimalHtml));
  assert.deepEqual(captions(blockHtml), ['Input', 'Images']);
  assert.match(blockHtml, /file:\/\/\/C:\/tmp\/plot\.png/);
  assert.match(minimalHtml, /file:\/\/\/C:\/tmp\/plot\.png/);
});

test('missing input stays absent while an unusable recorded input is explicit', () => {
  const builder = createBuilder();
  const missing = builder.buildDetailBodyMarkup({ toolName: 'Tool', domToken: 'missing' });
  const unusable = builder.buildDetailBodyMarkup({
    toolName: 'Tool', inputJson: '{bad', inputExpected: true, inputRecorded: false, domToken: 'bad',
  });
  assert.doesNotMatch(missing, /tool-call-section-kicker">Input/);
  assert.match(unusable, /tool-call-section-kicker">Input/);
  assert.match(unusable, /Not recorded\./);
  assert.doesNotMatch(unusable, /\{bad/);
});

test('capped payloads retain complete copy text and materialize it on Show more', () => {
  const isolatedDetailBody = loadDetailBody();
  const full = Array.from({ length: 600 }, (_, index) => `line-${index}-${'x'.repeat(20)}`).join('\n');
  const html = createBuilder(isolatedDetailBody).buildDetailBodyMarkup({
    toolName: 'Tool', outputText: full, domToken: 'large-output',
  });
  assert.equal(isolatedDetailBody.getFullText('large-output-output'), full);
  assert.match(html, /data-detail-capped="true"/);
  assert.doesNotMatch(html, /data-inv-truncation-marker/);
  assert.match(html, /Copy all \(/);
  assert.match(html, /Show 590 more lines/);
  assert.doesNotMatch(html, new RegExp(`line-599-${'x'.repeat(20)}`));

  const dom = new JSDOM(`<div>${html}</div>`);
  const control = dom.window.document.querySelector('[data-tool-detail-toggle]');
  assert.equal(control.getAttribute('title'), 'Show full output');
  const code = dom.window.document.querySelector('code');
  code.setAttribute('data-code-highlighted', 'tokenized');
  assert.equal(isolatedDetailBody.toggleDetailClamp(control), true);
  assert.equal(code.textContent, full);
  assert.equal(code.hasAttribute('data-code-highlighted'), false,
    'replacing the preview text invalidates the highlight marker so the full body is colored again');
  assert.equal(control.getAttribute('aria-expanded'), 'true');
  assert.equal(control.textContent, 'Show less');
  assert.equal(control.getAttribute('title'), 'Collapse output');
  dom.window.close();
});

test('capped scalar input remains a flat kv row and expands its complete value in place', () => {
  const isolatedDetailBody = loadDetailBody();
  const content = 'z'.repeat(isolatedDetailBody.TOOL_DETAIL_PREVIEW_MAX_CHARS + 25);
  const html = createBuilder(isolatedDetailBody).buildDetailBodyMarkup({
    // A non-code field: code / command / content get their own block (area 3).
    toolName: 'annotate_file', input: { path: 'large.txt', note: content },
    inputExpected: true, inputRecorded: true, domToken: 'large-input',
  });
  assert.match(html, /class="tool-kv-grid" data-detail-clamped="true" data-detail-capped="true"/);
  assert.match(html, /tool-detail-copy-all/);
  assert.match(html, /Show 25 more characters/);
  assert.doesNotMatch(html, /data-inv-truncation-marker/);
  const dom = new JSDOM(`<div>${html}</div>`);
  const control = dom.window.document.querySelector('[data-tool-detail-toggle]');
  isolatedDetailBody.toggleDetailClamp(control);
  assert.equal(dom.window.document.querySelector('[data-detail-field-key="note"]').textContent, content);
  dom.window.close();
});

test('errors stay inside the shared detail body with outcome and recovery markup', () => {
  const html = createBuilder().buildDetailBodyMarkup({
    toolName: 'run_command', toolKind: 'Bash', callId: 'call-error', domToken: 'error',
    isError: true, status: 'errored', errorCode: 'CMP-TOOL-0009', resultSummary: 'exit 1',
    retryMessageId: 'assistant-1', inputExpected: false,
  });
  assert.match(html, /^<div class="tool-detail-body"/);
  assert.match(html, /data-tool-result-outcome="failure"/);
  assert.match(html, /data-inv-error-action="retry"/);
  assert.doesNotMatch(html, /tool-io-panel/);
});

function sectionsByCaption(markup) {
  const doc = new JSDOM(`<body>${markup}</body>`).window.document;
  return Array.from(doc.querySelectorAll('.tool-call-section')).map((section) => ({
    caption: section.querySelector('.tool-call-section-kicker')?.textContent,
    code: section.querySelector('code'),
  }));
}

test('a read_file result takes its language from the path: header when the input has no path', () => {
  const sections = sectionsByCaption(createBuilder().buildDetailBodyMarkup({
    toolName: 'read_file', toolKind: 'Read', domToken: 'read-header',
    outputText: 'path: src/matcher.py\nrequested: offset=0, limit=2\nreturned: lines 1-2 of 40\n\nimport re\nMATCH = 1',
  }));
  const output = sections.find((section) => section.caption === 'Output').code;
  assert.equal(output.dataset.languageId, 'python');
  assert.equal(output.dataset.codeHighlight, 'pending');
});

test('a Python tool code input renders as a python block even when the output is not JSON', () => {
  const sections = sectionsByCaption(createBuilder().buildDetailBodyMarkup({
    toolName: 'python_execute', toolKind: 'python_execute', domToken: 'python-plain',
    input: { code: 'import math\nprint(math.pi)', timeout: 10 }, outputText: '3.141592653589793',
  }));
  const code = sections.find((section) => section.code?.dataset.languageId === 'python');
  assert.ok(code, 'the code field is its own python block');
  assert.equal(code.code.textContent, 'import math\nprint(math.pi)');
  const args = sections.find((section) => section.caption === 'Args');
  assert.ok(args, 'the remaining fields stay an Args section');
  assert.doesNotMatch(args.code ? args.code.textContent : '', /import math/);
});

test('Python stdout that parses as JSON is pretty-printed and tagged json, like bash stdout', () => {
  const sections = sectionsByCaption(createBuilder().buildDetailBodyMarkup({
    toolName: 'python_execute', toolKind: 'python_execute', domToken: 'python-json-stdout',
    input: { code: 'print(json.dumps({"ok": True}))' },
    outputText: JSON.stringify({ stdout: '{"ok": true}', stderr: '' }),
  }));
  const stdout = sections.find((section) => section.caption === 'Stdout');
  assert.ok(stdout, 'the structured Stdout section renders');
  assert.equal(stdout.code.dataset.languageId, 'json');
  assert.equal(stdout.code.textContent, '{\n  "ok": true\n}');

  const plain = sectionsByCaption(createBuilder().buildDetailBodyMarkup({
    toolName: 'python_execute', toolKind: 'python_execute', domToken: 'python-plain-stdout',
    input: { code: 'print(1)' }, outputText: JSON.stringify({ stdout: 'hello world' }),
  })).find((section) => section.caption === 'Stdout');
  assert.equal(plain.code.hasAttribute('data-language-id'), false, 'non-JSON stdout stays plain');
  assert.equal(plain.code.textContent, 'hello world');
});

test('command and content input fields render as their own shell and file-language blocks', () => {
  const command = sectionsByCaption(createBuilder().buildDetailBodyMarkup({
    toolName: 'custom_runner', domToken: 'generic-command', input: { command: 'ls -la', cwd: '.' }, outputText: 'ok',
  }));
  assert.equal(command.find((section) => section.caption === 'Command').code.dataset.languageId, 'shell');

  const write = sectionsByCaption(createBuilder().buildDetailBodyMarkup({
    toolName: 'write_file', toolKind: 'Write', domToken: 'write-content',
    input: { path: 'src/example.js', content: 'const a = 1;\nexport default a;' }, outputText: 'Wrote 30 bytes to src/example.js',
  }));
  const content = write.find((section) => section.code?.textContent === 'const a = 1;\nexport default a;');
  assert.ok(content, 'the file content is its own block');
  assert.equal(content.code.dataset.languageId, 'javascript');
  const receipt = write.find((section) => section.caption === 'Output').code;
  assert.equal(receipt.hasAttribute('data-language-id'), false, 'the receipt stays prose');
});
