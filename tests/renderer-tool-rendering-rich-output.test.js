const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp } = require('./helpers/renderer-shell-harness');
const { waitForUiState } = require('./helpers/wait-for-ui-state');
const toolShellUtils = require('../renderer/chat/renderer-tool-shell-utils');
const transcriptUtils = require('../renderer/chat/renderer-transcript-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const badge = require('../renderer/inventory/badge');
const spinner = require('../renderer/inventory/spinner');
const Collapsible = require('../renderer/inventory/collapsible');
const CodeBlock = require('../renderer/inventory/codeblock');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

function createToolSessionStartStream(sessionId, title) {
  return async function startStream(payload, { state }) {
    state.sessions = [{
      id: sessionId,
      title,
      conversation_mode: payload.conversationMode || 'chat',
      preferred_model: payload.preferredModel || 'gpt-test',
      reasoning_effort: payload.reasoningEffort || 'default',
      interactive_round_count: 0,
      interactive_sequence_state: 'idle',
      pending_question_batch: null,
      updated_at: new Date().toISOString(),
    }];
    state.messagesBySession.set(sessionId, []);
    return { sessionId, streamId: `stream-${sessionId}` };
  };
}

async function submitPrompt(window, promptText) {
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  input.value = promptText;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUiState(
    window,
    () => Boolean(window.document.querySelector('.chat-entry.user')),
    { message: 'Timed out waiting for the sent user turn to render.' }
  );
}

async function waitForToolBlock(window, callId, ready = () => true) {
  let block = null;
  await waitForUiState(
    window,
    () => {
      block = window.document.querySelector(
        `.tool-call-block[data-call-id="${callId}"], .tool-call-row[data-tool-call-id="${callId}"]`
      );
      return Boolean(block && ready(block));
    },
    { message: `Timed out waiting for settled tool block ${callId} to render.` }
  );
  return block;
}

async function expandToolDetails(window, callId, ready) {
  let block = await waitForToolBlock(window, callId);
  let header = block.querySelector('.tool-call-header, .tool-call-row-toggle');
  assert.ok(header, `expected tool header for ${callId}`);

  let details = null;
  const findCurrentDetails = () => {
    block = window.document.querySelector(
      `.tool-call-block[data-call-id="${callId}"], .tool-call-row[data-tool-call-id="${callId}"]`
    );
    header = block?.querySelector('.tool-call-header, .tool-call-row-toggle');
    const controlsId = header?.getAttribute('aria-controls');
    details = controlsId ? window.document.getElementById(controlsId) : null;
    return details;
  };
  findCurrentDetails();
  await waitForUiState(
    window,
    () => {
      findCurrentDetails();
      if (header?.isConnected && header.getAttribute('aria-expanded') !== 'true') {
        header.click();
      }
      return Boolean(
        details
        && details.hidden === false
        && (!ready || ready(block, details))
      );
    },
    { message: `Timed out waiting for tool details ${callId} to expand.` }
  );
  return details;
}

function ensureFrameWindow(iframe) {
  if (iframe.contentWindow) {
    return iframe.contentWindow;
  }
  const stubWindow = { postMessage() {} };
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: stubWindow,
  });
  return stubWindow;
}

async function resolveMermaidFrame(window, selector, options = {}) {
  const iframe = typeof selector === 'string' ? window.document.querySelector(selector) : selector;
  assert.ok(iframe, 'expected Mermaid preview iframe');
  const frameWindow = ensureFrameWindow(iframe);
  const postedMessages = [];
  frameWindow.postMessage = (payload) => {
    postedMessages.push(payload);
  };

  iframe.dispatchEvent(new window.Event('load'));
  await waitForUiState(
    window,
    () => postedMessages.length === 1,
    { message: 'Timed out waiting for the Mermaid frame render request.' }
  );

  assert.equal(postedMessages.length, 1, 'expected a render request to be posted into the frame');
  window.dispatchEvent(new window.MessageEvent('message', {
    source: frameWindow,
    origin: window.location.origin,
    data: {
      type: 'rendered',
      requestId: postedMessages[0].requestId,
      ok: options.ok !== false,
      height: options.height || 180,
      error: options.error,
    },
  }));
  await waitForUiState(
    window,
    () => iframe.style.height === `${options.height || 180}px`,
    { message: 'Timed out waiting for the Mermaid frame to settle its rendered height.' }
  );
  return { iframe, requestId: postedMessages[0].requestId };
}

test('renderer keeps malformed JSON stdout raw and escapes bash stderr content', async (t) => {
  const sessionId = 'session-bash-raw';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Bash Raw Session'),
      },
    },
  });

  await submitPrompt(window, 'Run malformed JSON command');

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-bash-raw',
    toolName: 'run_command',
    summary: 'run_command echo',
    input: { command: 'echo {"oops"}' },
    status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-bash-raw',
    toolName: 'run_command',
    input: { command: 'echo {"oops"}' },
    summary: 'run_command echo',
    content: '{"oops"\n<b>bad</b>',
    isError: true,
    approvalState: 'auto',
    durationMs: 5,
    metadata: {
      stdout: '{"oops"',
      stderr: '<b>bad</b>',
      exitCode: 2,
    },
  });
  const details = await expandToolDetails(window, 'call-bash-raw', (_block, candidateDetails) => (
    candidateDetails.textContent.includes('<b>bad</b>')
  ));
  assert.match(details.textContent, /\{"oops"/);
  assert.match(details.textContent, /<b>bad<\/b>/);
  assert.equal(details.querySelector('b'), null);
});

test('renderer read shell surfaces requested line range metadata', async (t) => {
  const sessionId = 'session-read-range';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Read Range Session'),
      },
    },
  });

  await submitPrompt(window, 'Read a subset');

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-read-range',
    toolName: 'read_file',
    summary: 'read_file README.md',
    input: { file_path: 'README.md', offset: 10, limit: 5 },
    status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-read-range',
    toolName: 'read_file',
    input: { file_path: 'README.md', offset: 10, limit: 5 },
    summary: 'read_file README.md',
    content: 'line1\nline2\nline3\nline4\nline5',
    isError: false,
    approvalState: 'auto',
    durationMs: 4,
    metadata: {},
  });
  const details = await expandToolDetails(window, 'call-read-range', (_block, candidateDetails) => (
    /README\.md \(lines 10-15\)/.test(candidateDetails.textContent || '')
  ));
  assert.match(details.textContent, /README\.md \(lines 10-15\)/);
});

test('renderer truncates long bash stderr output', async (t) => {
  const sessionId = 'session-bash-stderr-trunc';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Bash stderr trunc Session'),
      },
    },
  });

  await submitPrompt(window, 'Trigger stderr truncation');

  const longStderr = 'E'.repeat(12050);
  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-bash-stderr-trunc',
    toolName: 'run_command',
    summary: 'run_command failing',
    input: { command: 'failing-command' },
    status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-bash-stderr-trunc',
    toolName: 'run_command',
    input: { command: 'failing-command' },
    summary: 'run_command failing',
    content: '',
    isError: true,
    approvalState: 'auto',
    durationMs: 5,
    metadata: {
      stdout: '',
      stderr: longStderr,
      exitCode: 1,
    },
  });
  const details = await expandToolDetails(window, 'call-bash-stderr-trunc', (_block, candidateDetails) => (
    Boolean(candidateDetails.querySelector('.tool-detail-copy-all'))
  ));
  const stderrSection = Array.from(details.querySelectorAll('.tool-call-section'))
    .find((node) => /Stderr/.test(node.textContent));
  assert.ok(stderrSection, 'stderr section should render');
  assert.ok(stderrSection.querySelector('[data-detail-capped="true"]'), 'stderr should render a bounded preview');
  assert.ok(stderrSection.querySelector('.tool-detail-copy-all'), 'stderr should retain a full-payload copy action');
  assert.equal(stderrSection.querySelector('.inv-codeblock-truncated'), null, 'the footer replaces the legacy truncation marker');
});

test('renderer timeout badge does not duplicate timed out label', async (t) => {
  const sessionId = 'session-bash-timeout-label';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Timeout Label Session'),
      },
    },
  });

  await submitPrompt(window, 'Run timeout command');

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-bash-timeout',
    toolName: 'run_command',
    summary: 'run_command sleep',
    input: { command: 'sleep 999' },
    status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-bash-timeout',
    toolName: 'run_command',
    input: { command: 'sleep 999' },
    summary: 'run_command sleep',
    content: '',
    isError: true,
    approvalState: 'auto',
    durationMs: 1000,
    metadata: {
      stdout: '',
      stderr: '',
      timedOut: true,
      exitCode: null,
    },
  });
  // A finished row stays collapsed, so the exit badge only renders once the
  // reader opens the row; the header must not pre-empt it with its own label.
  await expandToolDetails(window, 'call-bash-timeout');
  const block = await waitForToolBlock(
    window,
    'call-bash-timeout',
    (candidate) => /timed out/.test(candidate.textContent)
  );
  const labelMatches = (block.textContent.match(/timed out/g) || []).length;
  assert.equal(labelMatches, 1, 'timed out should appear once');
});

test('renderer generic tool details keep full expanded output for diagnosis', async (t) => {
  const sessionId = 'session-generic-tool-full-output';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Generic Tool Session'),
      },
    },
  });

  await submitPrompt(window, 'Run a custom tool');

  const longOutput = 'X'.repeat(260);
  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-generic-1',
    toolName: 'custom_tool',
    summary: 'custom_tool',
    input: { payload: 'demo' },
    status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-generic-1',
    toolName: 'custom_tool',
    input: { payload: 'demo' },
    summary: 'custom_tool',
    content: longOutput,
    isError: false,
    approvalState: 'auto',
    durationMs: 3,
    metadata: {},
  });
  const block = await waitForToolBlock(window, 'call-generic-1');
  const header = block.querySelector('.tool-call-header, .tool-call-row-toggle');
  const initialDetails = window.document.getElementById(header?.getAttribute('aria-controls'));
  assert.ok(header);
  assert.ok(initialDetails);

  const details = await expandToolDetails(
    window,
    'call-generic-1',
    (_currentBlock, candidateDetails) => candidateDetails.textContent.includes(longOutput)
  );

  assert.ok(details.textContent.includes(longOutput), 'expanded generic details should preserve full output');
  assert.doesNotMatch(details.textContent, /\.\.\.$/, 'generic details should not truncate expanded output');
});

test('renderer mermaid shell renders a preview and keeps source fallback visible', async (t) => {
  const sessionId = 'session-mermaid-shell';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Mermaid Shell Session'),
      },
    },
  });

  await submitPrompt(window, 'Create a Mermaid diagram');

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-mermaid-shell-1',
    toolName: 'mermaid_generate',
    summary: 'Mermaid scaffold',
    input: { prompt: 'butterfly effect', diagram_type: 'flowchart' },
    status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-mermaid-shell-1',
    toolName: 'mermaid_generate',
    input: { prompt: 'butterfly effect', diagram_type: 'flowchart' },
    summary: 'Mermaid scaffold',
    content: JSON.stringify({
      diagram_type: 'flowchart',
      mermaid: 'flowchart TD\nA[Butterfly] --> B[Storm]',
    }),
    isError: false,
    approvalState: 'auto',
    durationMs: 6,
    metadata: {},
  });
  let block = await waitForToolBlock(
    window,
    'call-mermaid-shell-1',
    (candidate) => Boolean(candidate.querySelector('.tool-mermaid-preview'))
  );
  assert.doesNotMatch(block.querySelector('.tool-call-summary').textContent, /expand for preview/i);

  // The chart preview is the primary surface: visible without expanding the
  // disclosure, as a sibling of the collapsed details.
  let header = block.querySelector('.tool-call-header');
  let details = window.document.getElementById(header.getAttribute('aria-controls'));
  assert.ok(details);
  assert.equal(details.hidden, true);
  assert.ok(block.querySelector('.tool-mermaid-preview'), 'preview host should render outside the disclosure');
  assert.equal(details.querySelector('.tool-mermaid-preview'), null, 'preview should no longer live inside the details');
  await waitForUiState(
    window,
    () => Boolean(block.querySelector('.tool-mermaid-preview iframe')),
    { message: 'Timed out waiting for the Mermaid preview iframe to render.' }
  );
  await resolveMermaidFrame(window, '[data-call-id="call-mermaid-shell-1"] .tool-mermaid-preview iframe');
  assert.ok(block.querySelector('.tool-mermaid-preview iframe'));

  header.click();
  await waitForUiState(
    window,
    () => {
      block = window.document.querySelector('.tool-call-block[data-call-id="call-mermaid-shell-1"]');
      header = block?.querySelector('.tool-call-header');
      details = window.document.getElementById(header?.getAttribute('aria-controls'));
      return Boolean(details && details.hidden === false);
    },
    { message: 'Timed out waiting for Mermaid tool details to expand.' }
  );
  assert.match(details.textContent, /flowchart TD/);
});

test('renderer only renders allowlisted python image sources and blocks remote/UNC paths', async (t) => {
  const sessionId = 'session-python-images';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Python Image Session'),
      },
    },
  });

  await submitPrompt(window, 'Run python images');

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-python-images',
    toolName: 'python_execute',
    summary: 'python_execute',
    input: { code: 'print("hi")' },
    status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-python-images',
    toolName: 'python_execute',
    input: { code: 'print("hi")' },
    summary: 'python_execute',
    content: JSON.stringify({
      stdout: 'done',
      images: [
        'https://tracker.example/image.png',
        'file:///C:/safe/output.png',
        '\\\\server\\share\\leak.png',
        'C:\\safe\\local.png',
      ],
    }),
    isError: false,
    approvalState: 'auto',
    durationMs: 6,
    metadata: {},
  });
  const details = await expandToolDetails(window, 'call-python-images', (_block, candidateDetails) => {
    return Boolean(
      candidateDetails
      && candidateDetails.querySelectorAll('.python-output-image').length === 2
    );
  });
  const images = Array.from(details.querySelectorAll('.python-output-image'));
  assert.equal(images.length, 2);
  assert.ok(images.every((img) => !img.getAttribute('src').startsWith('https://')));
  assert.ok(details.textContent.includes('2 image output(s) are unavailable.'));
});

test('transcript attachment renderer encodes hash characters in file URLs', () => {
  const renderer = transcriptUtils.createTranscriptRenderer({
    buildMessageActionModel: () => ({ actions: {} }),
    escapeHtml: (value) => String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;'),
    getReasoningEntries: () => [],
    isInteractiveRecapExpanded: () => false,
    renderMarkdown: () => '',
    renderStreamingMarkdownUnits: () => ({ html: '', units: [], fingerprints: [], changedStartIndex: -1 }),
    shouldShowThinkingToggle: () => false,
    thinkingController: null,
    toolCallUtils: {},
  });

  const html = renderer.renderMessageAttachments({
    attachments: [{
      kind: 'image',
      assetPath: 'C:\\tmp\\folder#1\\img #2.png',
      displayName: 'img #2.png',
    }],
  });

  assert.ok(html.includes('%23'), 'hash characters should be percent-encoded');
});

test('tool shell fallback logs throttled warn diagnostics on renderer exception', (t) => {
  const previousInventory = global.inventory;
  const previousWarn = console.warn;
  const warnCalls = [];

  t.after(() => {
    global.inventory = previousInventory;
    console.warn = previousWarn;
  });

  global.inventory = {
    badge,
    spinner,
    collapsible: Collapsible,
    codeBlock: CodeBlock,
  };
  console.warn = (...args) => { warnCalls.push(args); };

  const renderer = toolShellUtils.createToolShellRenderer({
    escapeHtml: null,
    toolCallUtils: {},
    renderDiffHunks: null,
    sanitizeHtmlFragment: null,
  });
  assert.ok(renderer && typeof renderer.renderToolShell === 'function');

  const model = {
    toolKind: 'Bash',
    callId: 'call-debug-1',
    displayToolName: 'Bash',
    summary: 'debug',
    status: 'completed',
    statusLabel: 'Completed',
    isRunning: false,
    durationLabel: '',
    metadata: {},
    outputText: '',
  };

  assert.equal(renderer.renderToolShell(model), null);
  assert.equal(warnCalls.length, 1, 'first exception should log');
  assert.equal(renderer.renderToolShell({ ...model, callId: 'call-debug-2' }), null);
  assert.equal(warnCalls.length, 1, 'second exception in throttle window should be suppressed');
});
