'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../renderer/chat/renderer-subagent-monitor-view');
const progressView = require('../renderer/chat/renderer-transcript-agent-progress');
const { createTranscriptThinkingRenderer } = require('../renderer/chat/renderer-transcript-thinking');

const metadata = {
  subagent_report: {
    task_id: 'child-1',
    label: '<Inspect persistence>',
    status: 'failed',
    terminal_reason: 'deadline_exceeded',
    summary: '<script>alert(1)</script>',
    evidence: [{ relative_path: 'services/backend/store.js', summary: 'Canonical writer.' }],
    tools_used: ['read_file'],
    budget: { elapsed_ms: 1_500 },
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    error: { code: 'CMP-AGENT-0001', message: 'Timed out', retryable: true },
  },
};

test('terminal summary uses the inventory action primitive and stable inspector hook', () => {
  const html = view.renderTerminalSummary(metadata, { key: 'call-1' });
  assert.match(html, /<button/);
  assert.match(html, /data-subagent-open="call-1"/);
  assert.match(html, /aria-controls="subagentInspector"/);
  assert.match(html, /title="Open subagent monitor: &lt;Inspect persistence&gt;,/);
  assert.doesNotMatch(html, /<script>/);
});

test('live delegate source routes to the subagent summary without task-type metadata', () => {
  const step = {
    source: 'delegate',
    toolCallId: 'call-live',
    childTaskId: 'child-live',
    childOrdinal: 1,
    childCount: 1,
    childLabel: 'Task 1',
    status: 'running',
    startedAt: Date.now(),
  };

  const progressHtml = progressView.renderAgentProgressRow({ steps: [step] });
  const thinkingHtml = createTranscriptThinkingRenderer({
    escapeHtml(value) { return String(value); },
  }).renderAgentStatusWidget({ agent_status_steps: [step] });

  assert.match(progressHtml, /data-subagent-open="call-live"/);
  assert.match(thinkingHtml, /data-subagent-open="call-live"/);
});

test('live summary renders only the newest active delegate call', () => {
  const steps = [{
    source: 'delegate', toolCallId: 'call-older', childTaskId: 'child-older',
    childOrdinal: 1, childCount: 1, childLabel: 'Older task', status: 'completed',
    childTerminal: true, startedAt: 1_000, updatedAt: 1_500,
  }, {
    source: 'delegate', toolCallId: 'call-newer', childTaskId: 'child-newer',
    childOrdinal: 1, childCount: 1, childLabel: 'Newer task', status: 'running',
    startedAt: 2_000, updatedAt: 2_500,
  }];

  const html = view.renderLiveSummary(steps, { now: 3_000 });

  assert.match(html, /data-subagent-open="call-newer"/);
  assert.match(html, /1 subagent/);
  assert.doesNotMatch(html, /call-older/);
});
const modelUtils = require('../renderer/chat/renderer-subagent-monitor-model');

function batchModel(tasks, extra = {}) {
  return modelUtils.buildMonitorViewModel({ terminal: { kind: 'batch', report: { status: 'completed', tasks, ...extra } }, key: 'call-1' });
}

const CHILDREN = [
  { task_id: 'a', label: 'Survey <renderer>', status: 'completed', summary: 'Summary A.', budget: { elapsed_ms: 41_000, tool_results_used: 7 }, usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200, model: 'qwen-test' } },
  { task_id: 'b', label: 'Survey sidecar', status: 'failed', terminal_reason: 'budget_exhausted', summary: 'Summary B.', budget: { elapsed_ms: 12_000 } },
];

test('the tree page: parent row, one treeitem button per child, footer totals', () => {
  const parts = view.renderMonitor(batchModel(CHILDREN), { page: 'tree' });
  assert.match(parts.header, /<h2[^>]*>Subagents<\/h2>/);
  assert.match(parts.header, /data-subagent-close="true"/);
  assert.match(parts.body, /role="tree"/);
  assert.match(parts.body, /Jenny<\/span>/);
  assert.match(parts.body, /Delegated research/);
  const rows = parts.body.match(/<button[^>]*role="treeitem"[^>]*>/g) || [];
  assert.equal(rows.length, 2, 'each child is one actionButton treeitem');
  assert.match(rows[0], /data-subagent-select="a"/);
  assert.match(parts.body, /Survey &lt;renderer&gt;/);
  assert.match(parts.body, /Completed · <span>41s<\/span> · 7 steps/);
  assert.match(parts.body, /Failed · Reached its work limit/);
  assert.equal(parts.footer.replace(/<[^>]+>/g, ''), '2 tasks · 7 steps · 1.2k tokens · partially reported');
  assert.doesNotMatch(parts.body, /subagent-monitor-master|subagent-monitor-detail\b/, 'no two-column markup');
});

test('the tree footer says "Tokens not reported" when no usage came back', () => {
  const parts = view.renderMonitor(batchModel([{ task_id: 'a', status: 'completed', summary: 'A' }, { task_id: 'b', status: 'completed', summary: 'B' }]), { page: 'tree' });
  assert.match(parts.footer, /Tokens not reported/);
  assert.doesNotMatch(parts.footer, /Unavailable/);
});

test('the drill-in page: back control, title and status line, steps, answer, evidence, uncertainties', () => {
  const steps = [
    { tool: 'read_file', display: 'Read file', ok: true, target: 'src/a.js' },
    { tool: 'read_file', display: 'Read file', ok: false, target: 'src/missing.js', detail: 'File not found', error_code: 'CMP-TOOL-1' },
  ];
  const parts = view.renderMonitor(batchModel([{
    ...CHILDREN[0], steps, answer: '## Findings\n\n- one\n- two', uncertainties: ['Not sure about X'],
    evidence: [{ relative_path: 'services/backend/store.js', line_start: 8, line_end: 9, summary: 'Canonical writer.', provenance: 'tool_observed' }],
  }]), { page: 'detail' });
  assert.match(parts.header, /data-subagent-back="true"/);
  assert.match(parts.body, /Tool observed/, 'tool-observed provenance is labelled');
  assert.match(parts.header, /title="Back to subagent list"/);
  assert.match(parts.body, /<h2[^>]*class="subagent-detail-title"[^>]*>Survey &lt;renderer&gt;<\/h2>/);
  assert.match(parts.body, /Completed · <span>41s<\/span> · qwen-test/);
  assert.match(parts.body, /subagent-step--ok/);
  assert.match(parts.body, /subagent-step--error/);
  assert.match(parts.body, /<span class="subagent-step-detail">File not found<\/span>/);
  assert.match(parts.body, />Answer</);
  assert.match(parts.body, /Findings/, 'the answer renders through markdown, not as a raw paragraph');
  assert.doesNotMatch(parts.body, /## Findings/);
  assert.match(parts.body, /data-chat-path-open="services\/backend\/store.js"/);
  assert.match(parts.body, /services\/backend\/store.js:8-9/);
  assert.match(parts.body, />Uncertainties</);
  assert.match(parts.body, /Not sure about X/);
  assert.doesNotMatch(parts.body, /Technical details/, 'the technical disclosure is for errors only');
  assert.match(parts.footer, /1\.2k tokens/);
  assert.match(parts.footer, /data-inv-collapsible/, 'the usage grid sits behind a Details disclosure');
  assert.match(parts.footer, />Details</);
});

test('a script in the answer is escaped or sanitized, never injected', () => {
  const parts = view.renderMonitor(batchModel([{
    ...CHILDREN[0], answer: 'Before <script>alert(1)</script> after <img src=x onerror=alert(2)>',
  }]), { page: 'detail' });
  assert.doesNotMatch(parts.body, /<script/i);
  assert.doesNotMatch(parts.body, /<img[^>]*onerror/i);
  assert.match(parts.body, /Before/, 'the text around the payload still renders');
  assert.match(parts.body, /after/);
});

test('a report without an answer shows its summary as Summary and says the answer was not kept', () => {
  const parts = view.renderMonitor(batchModel([CHILDREN[0]]), { page: 'detail' });
  assert.match(parts.body, /Summary A\./);
  assert.match(parts.body, />Summary</);
  assert.doesNotMatch(parts.body, />Answer</);
  assert.match(parts.body, /The full answer wasn&#39;t saved for this run\.|The full answer wasn't saved for this run\./);
});

test('a failed child without an answer shows its summary but no not-saved note', () => {
  const parts = view.renderMonitor(batchModel([CHILDREN[1]]), { page: 'detail' });
  assert.match(parts.body, /Summary B\./);
  assert.match(parts.body, />Summary</);
  assert.doesNotMatch(parts.body, /wasn/);
});

test('a report with an answer titles it Answer and adds no not-saved note', () => {
  const parts = view.renderMonitor(batchModel([{ ...CHILDREN[0], answer: 'Full answer.' }]), { page: 'detail' });
  assert.match(parts.body, />Answer</);
  assert.doesNotMatch(parts.body, /wasn/);
  assert.doesNotMatch(parts.body, /Summary A\./);
});

test('a report with no step log lists its tools and step count, never "not recorded"', () => {
  const parts = view.renderMonitor(batchModel([{
    ...CHILDREN[0], tools_used: ['read_file'], steps: [], budget: { tool_results_used: 7, elapsed_ms: 1_000 },
  }]), { page: 'detail' });
  assert.match(parts.body, /<p class="subagent-step-note">read_file · 7 steps<\/p>/);
  assert.doesNotMatch(parts.body, /not recorded/);
});

test('more than five step rows collapse behind "+ N more"; unrecorded steps are noted', () => {
  const steps = Array.from({ length: 11 }, (_, index) => ({ tool: 'grep', display: `Step ${index}`, ok: true, target: `file${index}.js` }));
  const parts = view.renderMonitor(batchModel([{
    ...CHILDREN[0], steps, budget: { tool_results_used: 14, elapsed_ms: 1_000 },
  }]), { page: 'detail' });
  assert.match(parts.body, /\+ 6 more/);
  assert.equal((parts.body.match(/subagent-step subagent-step--ok/g) || []).length, 11, 'every recorded step renders (six inside the collapsible)');
  assert.match(parts.body, /class="inv-collapsible-content subagent-more-detail"[^>]*hidden/);
  assert.match(parts.body, /\+ 3 steps not recorded/);
});

test('a running child shows its live stage summary and the pending-steps placeholder', () => {
  const live = modelUtils.buildMonitorViewModel({ now: 5_000, steps: [{
    source: 'delegate', toolCallId: 'call-1', childTaskId: 'child-1', childOrdinal: 1, childCount: 1,
    childLabel: 'Live survey', status: 'running', summary: 'Reading the repo', startedAt: 1_000, updatedAt: 4_000,
  }], key: 'call-1' });
  const parts = view.renderMonitor(live, { page: 'detail' });
  assert.match(parts.body, /Reading the repo/);
  assert.match(parts.body, /Tool steps appear here as they run\./);
  assert.match(parts.body, /data-subagent-live-elapsed="child:child-1"/);
  assert.doesNotMatch(parts.body, />Answer</, 'no answer section while running');
});

test('an error child shows the technical details disclosure; the ids take the pane suffix', () => {
  const parts = view.renderMonitor(batchModel([{
    ...CHILDREN[1], error: { code: 'CMP-AGENT-0001', message: 'Timed out', retryable: true },
  }]), { page: 'detail', idSuffix: '-pane1' });
  assert.match(parts.body, /Technical details · CMP-AGENT-0001/);
  assert.match(parts.body, /id="subagentInspectorTitle-pane1"/);
  assert.ok([...parts.body.matchAll(/ id="([^"]+)"/g)].every((match) => match[1].endsWith('-pane1')), 'every id is suffixed');
});

test('old reports without steps fall back to the tool names', () => {
  const parts = view.renderMonitor(batchModel([{ ...CHILDREN[0], budget: { elapsed_ms: 1_000 }, tools_used: ['read_file', 'grep'] }]), { page: 'detail' });
  assert.match(parts.body, /read_file · grep/);
});

test('a child with unreported usage never shows the batch subtotal as its own', () => {
  const model = modelUtils.buildMonitorViewModel({
    terminal: { kind: 'batch', report: {
      status: 'completed',
      tasks: [CHILDREN[0], { ...CHILDREN[1], status: 'completed' }],
      usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200, partial: true },
    } },
    key: 'call-1',
    selectedKey: 'b',
  });
  assert.equal(model.selected.label, 'Survey sidecar');
  assert.equal(model.selected.usage, null);
  const parts = view.renderMonitor(model, { page: 'detail' });
  assert.match(parts.footer, /Tokens not reported/);
  assert.doesNotMatch(parts.footer, /1\.2k tokens|partially reported/);
  assert.doesNotMatch(parts.footer, /subagent-usage-grid/);
  const tree = view.renderMonitor(model, { page: 'tree' });
  assert.match(tree.footer, /1\.2k tokens · partially reported/, 'the aggregate stays in the tree footer');
});

test('the drill-in reads Task, Answer, Steps in that order; the task is escaped plain text', () => {
  const prompt = 'Read the quarterly <script>x</script> statement.\nFind Schedule D Part 3.\nQuote the last common-stock row.\nCite the page.';
  const parts = view.renderMonitor(batchModel([{
    ...CHILDREN[0], prompt, answer: 'Found it.', steps: [{ tool: 'read_file', display: 'Read File', ok: true, target: 'a.pdf' }],
  }]), { page: 'detail' });
  const task = parts.body.indexOf('>Task<');
  const answer = parts.body.indexOf('>Answer<');
  const steps = parts.body.indexOf('>Steps<');
  assert.ok(task > 0 && task < answer && answer < steps, 'Task, then Answer, then Steps');
  assert.doesNotMatch(parts.body, /<script>x/);
  assert.match(parts.body, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(parts.body, /subagent-task-preview/, 'four lines get the clamp and Show all');
  assert.match(parts.body, />Show all</);
});

test('a short task the title already says, or an old report without one, adds no Task section', () => {
  const same = view.renderMonitor(batchModel([{ ...CHILDREN[0], prompt: 'Survey <renderer>' }]), { page: 'detail' });
  assert.doesNotMatch(same.body, />Task</);
  const old = view.renderMonitor(batchModel([CHILDREN[0]]), { page: 'detail' });
  assert.doesNotMatch(old.body, />Task</);
  const short = view.renderMonitor(batchModel([{ ...CHILDREN[0], prompt: 'Survey the renderer for dead code.' }]), { page: 'detail' });
  assert.match(short.body, />Task</);
  assert.doesNotMatch(short.body, />Show all</, 'a short task shows whole');
});

test('the answer has a Copy button; the cut note shows only when the answer was cut', () => {
  const whole = view.renderMonitor(batchModel([{ ...CHILDREN[0], answer: 'Full answer.' }]), { page: 'detail' });
  assert.match(whole.body, /data-subagent-copy="a"/);
  assert.match(whole.body, /data-subagent-copy-status/);
  assert.doesNotMatch(whole.body, /Cut at 4,000 characters/);
  const cut = view.renderMonitor(batchModel([{ ...CHILDREN[0], answer: 'Long answer.', answer_truncated: true }]), { page: 'detail' });
  assert.match(cut.body, /Cut at 4,000 characters\./);
});

test('a child that spent every turn says so under its status, unless its reason already does', () => {
  const hit = view.renderMonitor(batchModel([{ ...CHILDREN[0], budget: { max_steps: 10, iterations_used: 10, elapsed_ms: 1_000 } }]), { page: 'detail' });
  assert.match(hit.body, /Reached its step limit \(10 of 10\)\. The answer may be incomplete\./);
  const under = view.renderMonitor(batchModel([{ ...CHILDREN[0], budget: { max_steps: 10, iterations_used: 8, elapsed_ms: 1_000 } }]), { page: 'detail' });
  assert.doesNotMatch(under.body, /step limit/);
  const reason = view.renderMonitor(batchModel([{ ...CHILDREN[1], budget: { max_steps: 10, iterations_used: 10 } }]), { page: 'detail' });
  assert.doesNotMatch(reason.body, /step limit \(/, 'budget_exhausted already reads "Reached its work limit"');
});

test('repeated calls on one file group into one row with xN and their ranges; a failure stands alone', () => {
  const read = (range) => ({ tool: 'read_file', display: 'Read File', ok: true, target: 'docs/a.pdf', path: 'docs/a.pdf', range });
  const steps = [read('p1–3'), read('p4–6'), read('p4–6'), read('cont.'),
    { tool: 'read_file', display: 'Read File', ok: false, detail: "missing required argument 'path'" },
    { tool: 'grep_search', display: 'Grep Search', ok: true, target: '"Schedule D" in docs/a.pdf' }];
  const parts = view.renderMonitor(batchModel([{ ...CHILDREN[0], steps }]), { page: 'detail' });
  assert.match(parts.body, /subagent-step--group/);
  assert.match(parts.body, /×4/);
  assert.match(parts.body, /p1–3 · p4–6 · cont\./, 'distinct ranges, in order');
  assert.match(parts.body, /class="inv-collapsible-content subagent-step-group-calls"[^>]*hidden/, 'the calls sit behind the group');
  const trigger = parts.body.match(/<div class="inv-collapsible-trigger subagent-step-group-trigger"[\s\S]*?<\/div>/)[0];
  assert.doesNotMatch(trigger, /data-chat-path-open/, 'the group trigger holds no link');
  assert.match(parts.body, /data-chat-path-open="docs\/a.pdf"/, 'each call inside opens its file');
  assert.match(parts.body, /subagent-step--error[\s\S]*missing required argument/);
  assert.doesNotMatch(parts.body, /data-chat-path-open="&quot;Schedule/, 'a pattern target is plain text');
  assert.match(parts.body, /<span class="subagent-section-meta">7 steps<\/span>/, 'the heading counts the reported tool results');
});

test('a step group disclosure is keyed on its first call, not its position', () => {
  const read = { tool: 'read_file', display: 'Read File', ok: true, target: 'a.pdf' };
  const steps = [{ tool: 'glob', display: 'Glob', ok: true }, { tool: 'glob', display: 'Glob', ok: true, target: 'x' }, read, read];
  const parts = view.renderMonitor(batchModel([{ ...CHILDREN[0], steps }]), { page: 'detail' });
  const ids = [...parts.body.matchAll(/id="([^"]*step-group[^"]*)"/g)].map((match) => match[1]);
  assert.ok(ids.length && ids.every((id) => /-2(?:-|$)/.test(id)), ids.join(','));
});

const TRANSCRIPT = [
  { kind: 'thought', text: 'Find the file first. Then the contents.', ms: 3_100 },
  { kind: 'tool', call_id: 'c1', tool: 'glob_files', display: 'Glob Files', status: 'completed', input: '{"pattern":"docs/*.pdf"}', output: 'docs/a.pdf', ms: 40 },
  { kind: 'text', text: 'Found it. Reading the <b>contents</b>.' },
  { kind: 'tool', call_id: 'c2', tool: 'read_file', display: 'Read File', status: 'completed', input: '{"path":"docs/a.pdf","pages":"1-3"}', output: 'page 1 <script>x</script>', output_chars: 9_412, ms: 820 },
  { kind: 'tool', call_id: 'c3', tool: 'read_file', display: 'Read File', status: 'failed', input: '{}', output: "missing required argument 'path'", error_code: 'CMP-TOOL-0001' },
  { kind: 'thought', text: 'The last row is Zebra.', ms: 1_800, truncated: true },
];

test('a child with a transcript gets the Overview | Transcript switch; Overview stays the default', () => {
  const parts = view.renderMonitor(batchModel([{ ...CHILDREN[0], prompt: 'Find the figure.', answer: 'Zebra.', transcript: TRANSCRIPT }]), { page: 'detail' });
  assert.match(parts.body, /class="inv-segmented subagent-view-switch"[^>]*data-subagent-view="a"/);
  assert.match(parts.body, /aria-checked="true"[^>]*data-value="overview"|data-value="overview"[^>]*aria-checked="true"/);
  assert.match(parts.body, />Steps</, 'Overview is today\'s drill-in');
  const old = view.renderMonitor(batchModel([CHILDREN[0]]), { page: 'detail' });
  assert.doesNotMatch(old.body, /subagent-view-switch/, 'no transcript, no switch');
});

test('the Transcript reads: what Jenny asked, notes open, work folded into chat-style runs, then the answer and evidence', () => {
  const child = { ...CHILDREN[0], prompt: 'Find the figure.', answer: 'Zebra.', transcript: TRANSCRIPT,
    evidence: [{ relative_path: 'docs/a.pdf', summary: 'Row.' }] };
  const parts = view.renderMonitor(batchModel([child]), { page: 'detail', transcriptKeys: new Set(['a']) });
  const body = parts.body;
  assert.doesNotMatch(body, />Steps</, 'the Overview sections give way');
  const order = ['>Jenny asked<', 'Searched once, thought once', 'Found it.', 'Read 2 files, thought once', '>Answer<', '>Evidence<'].map((needle) => body.indexOf(needle));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), JSON.stringify(order));
  assert.match(body, /subagent-transcript-note[^>]*>[\s\S]*?Found it\. Reading the/, 'a note shows openly, in its own row');
  assert.doesNotMatch(body, /<script>x/, 'tool output is escaped');
  assert.match(body, /page 1 &lt;script&gt;x&lt;\/script&gt;/);
  assert.match(body, /Output cut: 25 of 9,412 characters kept\./);
  assert.match(body, /class="inv-collapsible-content subagent-transcript-run"[^>]*hidden/, 'runs start folded');
  assert.match(body, /tool-run-failed/, 'a failed call marks its run');
  assert.match(body, /Cut to keep the chat light\./, 'a cut thought says so');
  assert.match(body, /data-chat-path-open="docs\/a.pdf"/, 'evidence keeps its file link');
  assert.doesNotMatch(body, /data-tool-run-toggle|data-reasoning-toggle/, 'the chat\'s own toggles stay out of the monitor');
});

test('a running child\'s transcript shimmers its live thought and shows no answer yet', () => {
  const model = modelUtils.buildMonitorViewModel({ steps: [{
    source: 'delegate', toolCallId: 'call-live', childTaskId: 'child-live', childOrdinal: 1, childCount: 1, status: 'running',
    childActivity: { sequence: 3, steps: [], step_count: 1, text: '', transcript_version: 2, transcript: [
      { kind: 'tool', call_id: 'c1', tool: 'glob_files', display: 'Glob Files', status: 'completed', input: '{"pattern":"*.md"}', output: 'a.md' },
      { kind: 'thought', text: '', live: true },
    ] },
  }], key: 'call-live' });
  const parts = view.renderMonitor(model, { page: 'detail', transcriptKeys: new Set(['child-live']) });
  assert.match(parts.body, /shimmer-active[^>]*>Thinking…/);
  assert.doesNotMatch(parts.body, />Answer</);
});

test('later transcript entries that were not kept are counted', () => {
  const parts = view.renderMonitor(batchModel([{ ...CHILDREN[0], transcript: TRANSCRIPT, transcript_dropped: 4 }]), { page: 'detail', transcriptKeys: new Set(['a']) });
  assert.match(parts.body, /4 later steps were not kept\./);
});

test('transcript call bodies stay out of the chat\'s shared Show more / copy registry', () => {
  const detailBody = require('../renderer/chat/renderer-tool-detail-body');
  const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const transcript = [{ kind: 'tool', call_id: 'c1', tool: 'grep_search', display: 'Grep Search', status: 'completed', input: '{"pattern":"x"}', output: long }];
  const parts = view.renderMonitor(batchModel([{ ...CHILDREN[0], transcript }]), { page: 'detail', transcriptKeys: new Set(['a']) });
  const copyId = /<code id="(subagent-call-[^"]+)"/.exec(parts.body)?.[1];
  assert.ok(copyId, 'the call body renders');
  assert.match(parts.body, /data-detail-clamped="true"/, 'a long output still clamps behind Show more');
  assert.equal(detailBody.getFullText(copyId), null, 'nothing was registered');
});

test('a running child shows the switch before its first transcript entry', () => {
  const model = modelUtils.buildMonitorViewModel({ steps: [{
    source: 'delegate', toolCallId: 'call-new', childTaskId: 'child-new', childOrdinal: 1, childCount: 1, status: 'running',
    childActivity: { sequence: 1, steps: [], step_count: 0, text: '' },
  }], key: 'call-new' });
  assert.match(view.renderMonitor(model, { page: 'detail' }).body, /subagent-view-switch/);
});
