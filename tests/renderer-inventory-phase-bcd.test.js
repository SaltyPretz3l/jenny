const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

/* Load new inventory primitives. */
const FaviconBadge = require('../renderer/inventory/favicon-badge');
const progressBar = require('../renderer/inventory/progress-bar');
const ToggleSwitch = require('../renderer/inventory/toggle-switch');
const contextMenu = require('../renderer/inventory/context-menu');

/* Load renderer utils. */
const sourceUtils = require('../renderer/chat/renderer-source-utils');
const errorRecoveryUtils = require('../renderer/chat/renderer-error-recovery-utils');
const artifactCardUtils = require('../renderer/chat/renderer-artifact-card-utils');
const contextUsageUtils = require('../renderer/chat/renderer-context-usage-utils');

/* ══════════════════════════════════════════════════════
   FaviconBadge
   ══════════════════════════════════════════════════════ */

test('faviconBadge renders link with local initial glyph', () => {
  const html = FaviconBadge.faviconBadge({ url: 'https://example.com/page' });
  assert.ok(html.includes('class="inv-favicon-badge"'), 'has badge class');
  assert.ok(html.includes('href="https://example.com/page"'), 'has href');
  assert.ok(html.includes('target="_blank"'), 'opens in new tab');
  assert.ok(html.includes('inv-favicon-initial'), 'has local initial badge');
  assert.ok(!html.includes('google.com/s2/favicons'), 'does not use external favicon service');
});

test('faviconBadge renders title text', () => {
  const html = FaviconBadge.faviconBadge({ url: 'https://example.com', title: 'Example Site' });
  assert.ok(html.includes('Example Site'), 'title in badge');
});

test('faviconBadge escapes special characters', () => {
  const html = FaviconBadge.faviconBadge({ url: 'https://example.com', title: '<script>xss</script>' });
  assert.ok(!html.includes('<script>'), 'no raw script tag');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped');
});

test('faviconBadge falls back to domain when no title', () => {
  const html = FaviconBadge.faviconBadge({ url: 'https://docs.python.org/3/' });
  assert.ok(html.includes('docs.python.org'), 'domain shown');
});

test('faviconBadgeGroup renders multiple badges', () => {
  const html = FaviconBadge.faviconBadgeGroup({
    sources: [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ],
  });
  assert.ok(html.includes('inv-source-group'), 'has group wrapper');
  assert.ok(html.includes('A'), 'first badge');
  assert.ok(html.includes('B'), 'second badge');
});

test('faviconBadgeGroup returns empty string for no sources', () => {
  const html = FaviconBadge.faviconBadgeGroup({ sources: [] });
  assert.strictEqual(html, '', 'empty for no sources');
});

test('faviconBadgeGroup collapses overflow', () => {
  const sources = [];
  for (let i = 0; i < 12; i++) {
    sources.push({ url: `https://${i}.example.com`, title: `Site ${i}` });
  }
  const html = FaviconBadge.faviconBadgeGroup({ sources, maxVisible: 5 });
  assert.ok(html.includes('inv-source-toggle'), 'has toggle button');
  assert.ok(html.includes('+7 more'), 'shows overflow count');
  assert.ok(html.includes('inv-source-overflow'), 'has overflow container');
});

test('initFaviconHandlers updates aria-label and button text on overflow toggle', () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const root = dom.window.document.getElementById('root');
  root.innerHTML = FaviconBadge.faviconBadgeGroup({
    sources: [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
      { url: 'https://c.com', title: 'C' },
    ],
    maxVisible: 1,
    groupId: 'group-1',
  });

  FaviconBadge.initFaviconHandlers(root);
  const btn = root.querySelector('[data-inv-source-toggle="group-1"]');
  const overflow = root.querySelector('[data-inv-overflow-id="group-1"]');
  assert.equal(btn.getAttribute('aria-label'), 'Show 2 more sources');
  assert.equal(btn.textContent, '+2 more');
  assert.equal(overflow.hidden, true);

  btn.click();
  assert.equal(btn.getAttribute('aria-label'), 'Show fewer sources');
  assert.equal(btn.textContent, 'Show less');
  assert.equal(overflow.hidden, false);

  btn.click();
  assert.equal(btn.getAttribute('aria-label'), 'Show 2 more sources');
  assert.equal(btn.textContent, '+2 more');
  assert.equal(overflow.hidden, true);
});

test('extractDomain strips www prefix', () => {
  assert.strictEqual(FaviconBadge.extractDomain('https://www.example.com/page'), 'example.com');
});

/* ══════════════════════════════════════════════════════
   ProgressBar
   ══════════════════════════════════════════════════════ */

test('progressBar renders with value and max', () => {
  const html = progressBar({ value: 50, max: 100 });
  assert.ok(html.includes('role="progressbar"'), 'has progressbar role');
  assert.ok(html.includes('aria-valuenow="50"'), 'value now');
  assert.ok(html.includes('aria-valuemax="100"'), 'value max');
  assert.ok(html.includes('--progress: 50%'), 'css variable');
});

test('progressBar shows warning at threshold', () => {
  const html = progressBar({ value: 85, max: 100, warningThreshold: 0.8 });
  assert.ok(html.includes('inv-progress--warning'), 'has warning class');
});

test('progressBar shows danger at threshold', () => {
  const html = progressBar({ value: 98, max: 100, dangerThreshold: 0.95 });
  assert.ok(html.includes('inv-progress--danger'), 'has danger class');
});

test('progressBar shows display text', () => {
  const html = progressBar({ value: 50, max: 100, displayText: '50k / 100k tokens' });
  assert.ok(html.includes('50k / 100k tokens'), 'display text shown');
});

test('progressBar clamps to 0-100%', () => {
  const html = progressBar({ value: 200, max: 100 });
  assert.ok(html.includes('--progress: 100%'), 'clamped to 100');
});

test('progressBar strips unsafe custom className content', () => {
  const html = progressBar({
    value: 1,
    max: 2,
    className: 'progress-extra " onclick="alert(1)',
  });
  assert.ok(html.includes('progress-extra'), 'safe token preserved');
  assert.ok(!html.includes('onclick='), 'unsafe attribute content removed');
});

/* ══════════════════════════════════════════════════════
   ToggleSwitch
   ══════════════════════════════════════════════════════ */

test('toggleSwitch renders unchecked by default', () => {
  const html = ToggleSwitch.toggleSwitch({ id: 'test', label: 'Feature' });
  assert.ok(html.includes('role="switch"'), 'has switch role');
  assert.ok(html.includes('aria-checked="false"'), 'unchecked');
  assert.ok(html.includes('Feature'), 'label shown');
  assert.ok(html.includes('data-inv-toggle="test"'), 'has toggle id');
});

test('toggleSwitch renders checked state', () => {
  const html = ToggleSwitch.toggleSwitch({ id: 'test', label: 'On', checked: true });
  assert.ok(html.includes('aria-checked="true"'), 'checked');
  assert.ok(html.includes('inv-toggle--on'), 'on class');
});

test('toggleSwitch renders disabled state', () => {
  const html = ToggleSwitch.toggleSwitch({ id: 'test', label: 'Off', disabled: true });
  assert.ok(html.includes('disabled'), 'disabled attribute');
  assert.ok(html.includes('inv-toggle--disabled'), 'disabled class');
});

test('toggleSwitch exposes a disabled reason through aria-describedby', () => {
  const html = ToggleSwitch.toggleSwitch({
    id: 'blocked',
    label: 'Web',
    disabled: true,
    description: 'Set a workspace root to use this tool.',
    descriptionId: 'blocked-reason',
  });
  assert.match(html, /aria-describedby="blocked-reason"/);
  assert.match(html, /id="blocked-reason"/);
  assert.match(html, /Set a workspace root to use this tool\./);
});

test('toggleSwitch strips unsafe custom className content', () => {
  const html = ToggleSwitch.toggleSwitch({
    id: 'test',
    label: 'Feature',
    className: 'safe-toggle " onclick="bad',
  });
  assert.ok(html.includes('safe-toggle'), 'safe token preserved');
  assert.ok(!html.includes('onclick='), 'unsafe attribute content removed');
});

/* ══════════════════════════════════════════════════════
   Source Parser
   ══════════════════════════════════════════════════════ */

test('parseSources handles JSON web_search output', () => {
  const json = JSON.stringify({
    query: 'test',
    answer: 'Some answer',
    sources: [
      { url: 'https://example.com', title: 'Example', snippet: 'A snippet' },
      { url: 'https://other.org', title: 'Other', snippet: '' },
    ],
    citations: [],
  });
  const result = sourceUtils.parseSources(json);
  assert.strictEqual(result.answer, 'Some answer');
  assert.strictEqual(result.sources.length, 2);
  assert.strictEqual(result.sources[0].domain, 'example.com');
  assert.strictEqual(result.sources[1].url, 'https://other.org');
});

test('parseSources handles block format fallback', () => {
  const text = 'Title: Example Page\nURL: https://example.com\nSnippet: A description\n\nTitle: Other\nURL: https://other.org\nSnippet: More info';
  const result = sourceUtils.parseSources(text);
  assert.strictEqual(result.sources.length, 2);
  assert.strictEqual(result.sources[0].title, 'Example Page');
  assert.strictEqual(result.sources[0].url, 'https://example.com');
  assert.strictEqual(result.sources[1].title, 'Other');
});

test('parseSources returns empty for non-matching text', () => {
  const result = sourceUtils.parseSources('Just some random text');
  assert.strictEqual(result.sources.length, 0);
});

test('parseSources drops non-http citation URLs', () => {
  const json = JSON.stringify({
    answer: 'Unsafe links test',
    sources: [
      { url: 'javascript:alert(1)', title: 'Bad' },
      { url: 'https://example.com', title: 'Good' },
    ],
  });
  const result = sourceUtils.parseSources(json);
  assert.strictEqual(result.sources.length, 1);
  assert.strictEqual(result.sources[0].url, 'https://example.com');
});

test('parseSources returns empty for empty input', () => {
  const result = sourceUtils.parseSources('');
  assert.strictEqual(result.sources.length, 0);
});

/* ══════════════════════════════════════════════════════
   Error Classification
   ══════════════════════════════════════════════════��═══ */

test('isAllowedCitationUrl accepts http and https only', () => {
  assert.strictEqual(sourceUtils.isAllowedCitationUrl('https://example.com'), true);
  assert.strictEqual(sourceUtils.isAllowedCitationUrl('http://example.com'), true);
  assert.strictEqual(sourceUtils.isAllowedCitationUrl('javascript:alert(1)'), false);
  assert.strictEqual(sourceUtils.isAllowedCitationUrl('data:text/html,<h1>hi</h1>'), false);
  assert.strictEqual(sourceUtils.isAllowedCitationUrl('ftp://files.example.com'), false);
  assert.strictEqual(sourceUtils.isAllowedCitationUrl('file:///etc/passwd'), false);
  assert.strictEqual(sourceUtils.isAllowedCitationUrl(''), false);
  assert.strictEqual(sourceUtils.isAllowedCitationUrl(null), false);
});

test('classifyError recognizes transport errors', () => {
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-AI-0002'), 'transport');
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-CLOUD-1002'), 'transport');
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-CHAT-0002'), 'transport');
});

test('classifyError recognizes provider errors', () => {
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-AI-0003'), 'provider');
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-CLOUD-1001'), 'provider');
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-AI-0001'), 'provider');
});

test('classifyError recognizes tool errors by prefix', () => {
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-TOOL-0008'), 'tool');
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-MCP-0004'), 'tool');
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-WEB-0004'), 'tool');
});

test('classifyError recognizes context errors', () => {
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-CTX-0003'), 'context');
});

test('classifyError recognizes loop errors', () => {
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-LOOP-0001'), 'loop');
});

test('classifyError returns unknown for empty input', () => {
  assert.strictEqual(errorRecoveryUtils.classifyError(''), 'unknown');
  assert.strictEqual(errorRecoveryUtils.classifyError(null), 'unknown');
});

test('classifyError recognizes sidecar/render/interactive families', () => {
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-SIDECAR-0001'), 'transport');
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-RENDER-0001'), 'loop');
  assert.strictEqual(errorRecoveryUtils.classifyError('CMP-INTERACTIVE-0002'), 'loop');
});

test('isRetryable returns true for transport and loop', () => {
  assert.ok(errorRecoveryUtils.isRetryable('CMP-AI-0002'));
  assert.ok(errorRecoveryUtils.isRetryable('CMP-LOOP-0001'));
});

test('isRetryable returns true for known rate-limit providers and false for tool errors', () => {
  assert.ok(errorRecoveryUtils.isRetryable('CMP-AI-0003'));
  assert.ok(!errorRecoveryUtils.isRetryable('CMP-TOOL-0008'));
});

test('renderErrorRecovery renders retry button for transport errors', () => {
  const html = errorRecoveryUtils.renderErrorRecovery({
    errorCode: 'CMP-AI-0002',
    message: 'Connection failed',
  });
  assert.ok(html.includes('chat-error-card'), 'has unified card container');
  assert.ok(html.includes('Connection failed'), 'shows message');
  assert.ok(html.includes('data-inv-error-action="retry"'), 'has retry button');
});

test('renderErrorRecovery uses server recovery hint when present', () => {
  const html = errorRecoveryUtils.renderErrorRecovery({
    errorCode: 'CMP-SIDECAR-0003',
    message: 'Sidecar exited',
    recoveryHint: 'Restart the local sidecar, then retry this turn.',
  });
  assert.ok(
    html.includes('Restart the local sidecar, then retry this turn.'),
    'uses supplied recovery hint'
  );
});

test('renderErrorRecovery renders retry button for provider rate-limit errors', () => {
  const html = errorRecoveryUtils.renderErrorRecovery({
    errorCode: 'CMP-AI-0003',
    message: 'Rate limit exceeded',
  });
  assert.ok(html.includes('data-inv-error-action="retry"'), 'has retry button');
});

test('renderErrorRecovery renders settings button for non-retryable provider errors', () => {
  const html = errorRecoveryUtils.renderErrorRecovery({
    errorCode: 'CMP-AI-0005',
    message: 'Generation failed',
  });
  assert.ok(html.includes('data-inv-error-action="settings"'), 'has settings button');
});

test('renderErrorRecovery renders retry/skip for tool errors', () => {
  const html = errorRecoveryUtils.renderErrorRecovery({
    errorCode: 'CMP-TOOL-0008',
    message: 'Execution failed',
    callId: 'call_123',
  });
  assert.ok(html.includes('data-inv-error-action="retry-tool"'), 'has retry-tool');
  assert.ok(html.includes('data-inv-error-action="skip-tool"'), 'has skip-tool');
  assert.ok(html.includes('data-call-id="call_123"'), 'has call id');
});

test('renderErrorRecovery renders new session for context errors', () => {
  const html = errorRecoveryUtils.renderErrorRecovery({
    errorCode: 'CMP-CTX-0003',
    message: 'Budget exceeded',
  });
  assert.ok(html.includes('data-inv-error-action="new-session"'), 'has new-session');
});

test('renderEnhancedFailureNotice renders a card even without error code or metadata', () => {
  const html = errorRecoveryUtils.renderEnhancedFailureNotice({
    stream_error: 'Something went wrong',
  });
  assert.ok(html.includes('chat-error-card'), 'renders unified card');
  assert.ok(html.includes('Turn failed'), 'uses local fallback title');
  assert.ok(html.includes('Something went wrong'), 'shows error text');
  assert.ok(!html.includes('thinking-error-note'), 'no legacy fallback note');
});

test('renderEnhancedFailureNotice surfaces server-provided recovery copy (snake_case)', () => {
  const html = errorRecoveryUtils.renderEnhancedFailureNotice({
    stream_error: 'Sidecar exited unexpectedly',
    error_code: 'CMP-SIDECAR-0003',
    recovery_title: 'Sidecar connection issue',
    recovery_hint: 'Restart the local sidecar, then retry this turn.',
    next_action_label: 'Retry turn',
    retryable: true,
  });
  assert.ok(html.includes('chat-error-card-title'), 'renders title element');
  assert.ok(html.includes('Sidecar connection issue'), 'shows server-provided title');
  assert.ok(
    html.includes('Restart the local sidecar, then retry this turn.'),
    'shows server-provided hint'
  );
  assert.ok(html.includes('Retry turn</button>'), 'uses next_action_label as primary action label');
});

test('renderEnhancedFailureNotice prefers backend recovery actions when present', () => {
  const html = errorRecoveryUtils.renderEnhancedFailureNotice({
    stream_error: 'Sidecar exited unexpectedly',
    error_code: 'CMP-SIDECAR-0003',
    recovery_title: 'Sidecar connection issue',
    recovery_hint: 'Restart the local sidecar, then retry this turn.',
    next_action: 'retry_turn',
    next_action_label: { unsafe: 'object label' },
    retryable: true,
    recovery_actions: [
      { id: 'retry_turn', label: 'Retry turn' },
      { id: 'restart_sidecar', label: 'Restart sidecar' },
      { id: 'open_settings', label: 'Open settings' },
      { id: 'open_diagnostics', label: 'Open diagnostics' },
      { id: 'start_new_session', label: 'Start new session' },
      { id: 'retry_turn', label: { unsafe: 'object label' } },
      { id: { unsafe: 'object id' }, label: 'Unsafe action' },
    ],
  });

  assert.ok(html.includes('data-inv-error-action="retry_turn"'), 'uses backend retry action id');
  assert.ok(html.includes('data-inv-error-action="restart_sidecar"'), 'renders restart sidecar action');
  assert.ok(html.includes('data-inv-error-action="open_settings"'), 'renders open settings action');
  assert.ok(html.includes('data-inv-error-action="open_diagnostics"'), 'renders diagnostics action');
  assert.ok(html.includes('data-inv-error-action="start_new_session"'), 'renders start new session action');
  assert.ok(html.includes('Restart sidecar</button>'), 'uses backend action label');
  assert.ok(!html.includes('data-inv-error-action="retry"'), 'does not add legacy fallback actions');
  assert.ok(!html.includes('[object Object]'), 'does not stringify malformed action labels');
});

test('renderEnhancedFailureNotice ignores malformed recovery metadata without an error code', () => {
  const html = errorRecoveryUtils.renderEnhancedFailureNotice({
    stream_error: 'Plain stream failure',
    recovery_hint: { unsafe: 'object hint' },
    recovery_actions: [
      { id: { unsafe: 'object id' }, label: 'Unsafe action' },
      { id: '', label: 'Missing id' },
    ],
  });

  assert.ok(html.includes('chat-error-card'), 'renders unified card');
  assert.ok(html.includes('Plain stream failure'), 'shows error text');
  assert.ok(!html.includes('data-inv-error-action="retry_turn"'), 'ignores malformed backend actions');
  assert.ok(!html.includes('[object Object]'), 'does not stringify malformed recovery metadata');
});

test('renderEnhancedFailureNotice prefers server hint over local fallback', () => {
  const html = errorRecoveryUtils.renderEnhancedFailureNotice({
    stream_error: 'Connection failed',
    error_code: 'CMP-AI-0002',
    recovery_hint: 'Bespoke server hint copy.',
  });
  assert.ok(html.includes('Bespoke server hint copy.'), 'uses server hint');
  assert.ok(
    !html.includes('Connection issue — the request may succeed on retry.'),
    'omits local fallback hint'
  );
});

test('renderEnhancedFailureNotice accepts camelCase recovery keys', () => {
  const html = errorRecoveryUtils.renderEnhancedFailureNotice({
    stream_error: 'Sidecar exited unexpectedly',
    error_code: 'CMP-SIDECAR-0003',
    recoveryTitle: 'Sidecar connection issue',
    recoveryHint: 'Camelcase hint copy.',
    nextActionLabel: 'Try again',
    retryable: true,
  });
  assert.ok(html.includes('Sidecar connection issue'), 'shows camelCase title');
  assert.ok(html.includes('Camelcase hint copy.'), 'shows camelCase hint');
  assert.ok(html.includes('Try again</button>'), 'uses camelCase nextActionLabel');
});

/* ══════════════════════════════════════════════════════
   Artifact Cards
   ══════════════════════════════════════════════════════ */

test('renderArtifactCards renders image card with thumbnail', () => {
  const html = artifactCardUtils.renderArtifactCards([
    {
      artifact_kind: 'image',
      title: 'Chart',
      absolute_path: '/tmp/chart.png',
      display_path: '.jenny/artifacts/session-1/chart.png',
      session_id: 'session-1',
      local_trusted: true,
    },
  ], 'call_1');
  assert.ok(html.includes('inv-artifact-card--image'), 'image card class');
  assert.ok(html.includes('<img class="inv-artifact-thumb"'), 'has thumbnail');
  assert.ok(html.includes('src="file:///tmp/chart.png"'), 'uses trusted file URL');
  assert.ok(html.includes('Chart'), 'title shown');
  assert.ok(html.includes('data-inv-artifact-action="open"'), 'has open action');
});

test('renderArtifactCards blocks untrusted absolute local image preview sources', () => {
  const html = artifactCardUtils.renderArtifactCards([
    { artifact_kind: 'image', title: 'Local Chart', absolute_path: '/tmp/chart.png' },
  ], 'call_local');
  assert.ok(html.includes('inv-artifact-card--image'), 'still renders image card');
  assert.ok(!html.includes('<img class="inv-artifact-thumb"'), 'absolute image preview blocked');
  assert.ok(html.includes('inv-artifact-thumb-placeholder'), 'falls back to placeholder');
});

test('renderArtifactCards blocks non-local image preview sources', () => {
  const html = artifactCardUtils.renderArtifactCards([
    { artifact_kind: 'image', title: 'Remote Chart', absolute_path: 'https://example.com/chart.png' },
  ], 'call_remote');
  assert.ok(html.includes('inv-artifact-card--image'), 'still renders image card');
  assert.ok(!html.includes('<img class="inv-artifact-thumb"'), 'remote image preview blocked');
  assert.ok(html.includes('inv-artifact-thumb-placeholder'), 'falls back to placeholder');
});

test('renderArtifactCards renders file card', () => {
  const html = artifactCardUtils.renderArtifactCards([
    { artifact_kind: 'file', file_name: 'results.csv', language: 'csv', absolute_path: '/tmp/results.csv' },
  ], 'call_2');
  assert.ok(html.includes('inv-artifact-card--file'), 'file card class');
  assert.ok(html.includes('results.csv'), 'file name shown');
  assert.ok(html.includes('csv'), 'language shown');
});

test('renderArtifactCards renders generic card', () => {
  const html = artifactCardUtils.renderArtifactCards([
    { artifact_kind: 'data', title: 'Analysis Output' },
  ], 'call_3');
  assert.ok(html.includes('inv-artifact-card--generic'), 'generic card class');
  assert.ok(html.includes('Analysis Output'), 'title shown');
});

test('renderArtifactCards returns empty for no artifacts', () => {
  assert.strictEqual(artifactCardUtils.renderArtifactCards([], 'call_4'), '');
  assert.strictEqual(artifactCardUtils.renderArtifactCards(null, 'call_5'), '');
});

test('renderArtifactCards renders multiple cards', () => {
  const html = artifactCardUtils.renderArtifactCards([
    { artifact_kind: 'image', title: 'A', absolute_path: '/a.png' },
    { artifact_kind: 'file', file_name: 'b.txt', absolute_path: '/b.txt' },
  ], 'call_6');
  assert.ok(html.includes('inv-artifact-list'), 'has list wrapper');
  assert.ok(html.includes('inv-artifact-card--image'), 'image card');
  assert.ok(html.includes('inv-artifact-card--file'), 'file card');
});

test('renderArtifactCards disables actions when artifact_id is missing', () => {
  const html = artifactCardUtils.renderArtifactCards([
    { artifact_kind: 'file', file_name: 'notes.txt', absolute_path: '/tmp/notes.txt' },
  ], 'call_7');
  assert.ok(html.includes('data-inv-artifact-action="open"'));
  assert.ok(html.includes('disabled title="Artifact unavailable"'));
});

/* ══════════════════════════════════════════════════════
   Context Usage
   ══════════════════════════════════════════════════════ */

test('formatTokenCount formats thousands', () => {
  assert.strictEqual(contextUsageUtils.formatTokenCount(1500), '1.5k');
  assert.strictEqual(contextUsageUtils.formatTokenCount(200000), '200.0k');
});

test('formatTokenCount formats millions', () => {
  assert.strictEqual(contextUsageUtils.formatTokenCount(1000000), '1.0M');
});

test('formatTokenCount formats small numbers', () => {
  assert.strictEqual(contextUsageUtils.formatTokenCount(500), '500');
});

test('updateUsage stores usage data', () => {
  contextUsageUtils.updateUsage('sess1', {
    usage: { total_tokens: 5000 },
    context_tokens_estimate: 4000,
    context_window: 1000000,
    model: 'claude-4.6',
  });
  const data = contextUsageUtils.getUsage('sess1');
  assert.ok(data, 'data stored');
  assert.strictEqual(data.usedTokens, 4000);
  assert.strictEqual(data.contextLimit, 1000000);
  assert.strictEqual(data.model, 'claude-4.6');
  contextUsageUtils.clearUsage('sess1');
});

test('clearUsage removes data', () => {
  contextUsageUtils.updateUsage('sess2', {
    usage: { total_tokens: 100 },
    model: 'llama-3',
  });
  contextUsageUtils.clearUsage('sess2');
  assert.strictEqual(contextUsageUtils.getUsage('sess2'), null);
});

test('pruneUsage removes stale entries and respects keep list', () => {
  const staleNow = Date.now();
  contextUsageUtils.updateUsage('keep-session', { usage: { total_tokens: 10 }, model: 'llama-3' });
  contextUsageUtils.updateUsage('stale-session', { usage: { total_tokens: 20 }, model: 'llama-3' });

  const keep = contextUsageUtils.getUsage('keep-session');
  const stale = contextUsageUtils.getUsage('stale-session');
  keep.updatedAt = staleNow;
  stale.updatedAt = staleNow - (13 * 60 * 60 * 1000);

  const removed = contextUsageUtils.pruneUsage({
    maxAgeMs: 12 * 60 * 60 * 1000,
    keepSessionIds: ['keep-session'],
  });
  assert.equal(removed, 1);
  assert.ok(contextUsageUtils.getUsage('keep-session'));
  assert.equal(contextUsageUtils.getUsage('stale-session'), null);
  contextUsageUtils.clearAllUsage();
});

test('clearAllUsage removes all tracked usage entries', () => {
  contextUsageUtils.updateUsage('sess3', { usage: { total_tokens: 100 }, model: 'llama-3' });
  contextUsageUtils.updateUsage('sess4', { usage: { total_tokens: 200 }, model: 'llama-3' });
  contextUsageUtils.clearAllUsage();
  assert.equal(contextUsageUtils.getUsage('sess3'), null);
  assert.equal(contextUsageUtils.getUsage('sess4'), null);
});

test('F8: buildMessageTokenMeta estimates visible chat messages cumulatively', () => {
  const meta = contextUsageUtils.buildMessageTokenMeta([
    { id: 'user_1', role: 'user', content: '12345678' },
    { id: 'tool_1', role: 'assistant', kind: 'tool_use', content: '1234567890123456' },
    { id: 'assistant_1', role: 'assistant', content: '123456789' },
    { id: 'slash_1', role: 'assistant', kind: 'slash_command_output', content: 'ignored' },
    { id: 'suggestion_1', role: 'assistant', kind: 'proactive_suggestion', content: 'ignored too' },
    { id: 'assistant_error_1', role: 'assistant', kind: 'assistant_error', content: 'error notice' },
    { id: 'system_1', role: 'system', content: 'ignored too' },
  ]);

  assert.deepEqual(meta.get('user_1'), {
    messageTokens: 2,
    cumulativeTokens: 2,
    estimated: true,
  });
  assert.deepEqual(meta.get('assistant_1'), {
    messageTokens: 3,
    cumulativeTokens: 5,
    estimated: true,
  });
  assert.equal(meta.has('tool_1'), false);
  assert.equal(meta.has('slash_1'), false);
  assert.equal(meta.has('suggestion_1'), false);
  assert.equal(meta.has('assistant_error_1'), false);
  assert.equal(meta.has('system_1'), false);
});

test('F8: formatMessageTokenMeta labels estimated message and cumulative tokens', () => {
  const label = contextUsageUtils.formatMessageTokenMeta({
    messageTokens: 42,
    cumulativeTokens: 1800,
    estimated: true,
  });

  assert.equal(label, '~42 tokens est. · ~1.8k cumulative');
});

test('toggle() dispatches inv-toggle-change custom event payload', (t) => {
  const previousCustomEvent = global.CustomEvent;
  t.after(() => {
    global.CustomEvent = previousCustomEvent;
  });
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  global.CustomEvent = dom.window.CustomEvent;
  const root = dom.window.document.getElementById('root');
  root.innerHTML = ToggleSwitch.toggleSwitch({ id: 'evt-toggle', label: 'Event toggle' });
  ToggleSwitch.initToggleHandlers(root);
  const track = root.querySelector('[data-inv-toggle="evt-toggle"]');
  var received = null;
  root.addEventListener('inv-toggle-change', (event) => {
    received = event.detail;
  });

  track.click();
  assert.deepEqual(received, { id: 'evt-toggle', checked: true });
});

test('toggle click dispatches one inv-toggle-change event', () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const root = dom.window.document.getElementById('root');
  root.innerHTML = ToggleSwitch.toggleSwitch({ id: 'evt-toggle-once', label: 'Event toggle' });
  ToggleSwitch.initToggleHandlers(root);
  const track = root.querySelector('[data-inv-toggle="evt-toggle-once"]');
  var eventCount = 0;
  root.addEventListener('inv-toggle-change', () => {
    eventCount += 1;
  });

  track.click();
  assert.equal(eventCount, 1);
});

test('contextMenu forwards synchronous action failures to an error handler', (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const root = dom.window.document.getElementById('root');
  let captured = null;
  t.after(() => contextMenu.hide());

  contextMenu.show({
    rootEl: root,
    anchorX: 0,
    anchorY: 0,
    items: [{
      label: 'Explode',
      action() {
        throw new Error('menu failed');
      },
    }],
    onActionError(error, item) {
      captured = { error, item };
    },
  });

  root.ownerDocument.querySelector('.inv-context-menu-item').click();

  assert.equal(captured?.error?.message, 'menu failed');
  assert.equal(captured?.item?.label, 'Explode');
});

test('contextMenu marks danger items with the shared inventory class', (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const root = dom.window.document.getElementById('root');
  t.after(() => contextMenu.hide());
  contextMenu.show({ rootEl: root, anchorX: 0, anchorY: 0, items: [{ label: 'Delete', danger: true }] });
  assert.ok(root.ownerDocument.querySelector('.inv-context-menu-item--danger'));
});

test('contextMenu forwards rejected async action failures to an error handler', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const root = dom.window.document.getElementById('root');
  let captured = null;
  t.after(() => contextMenu.hide());

  contextMenu.show({
    rootEl: root,
    anchorX: 0,
    anchorY: 0,
    items: [{
      label: 'Async explode',
      action() {
        return Promise.reject(new Error('async menu failed'));
      },
    }],
    onActionError(error, item) {
      captured = { error, item };
    },
  });

  root.ownerDocument.querySelector('.inv-context-menu-item').click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(captured?.error?.message, 'async menu failed');
  assert.equal(captured?.item?.label, 'Async explode');
});

test('inventory index exports canonical keys and compatibility aliases', () => {
  const prevInventory = global.inventory;
  const prevDocument = global.document;
  const prevHandlersInstalled = global.__inventoryHandlersInstalled;
  const prevBadge = global.inventoryBadge;
  const prevSpinner = global.inventorySpinner;
  const prevCollapsible = global.inventoryCollapsible;
  const prevCodeBlock = global.inventoryCodeBlock;
  const prevFaviconBadge = global.inventoryFaviconBadge;
  const prevProgressBar = global.inventoryProgressBar;
  const prevStatusRow = global.inventoryStatusRow;
  const prevToggle = global.inventoryToggleSwitch;
  const prevSelectField = global.inventorySelectField;

  const dom = new JSDOM('<div></div>', { pretendToBeVisual: true });
  global.document = dom.window.document;
  global.__inventoryHandlersInstalled = false;
  var calls = {
    copy: 0,
    favicon: 0,
    toggle: 0,
    collapsible: 0,
  };
  global.inventoryBadge = () => 'badge';
  global.inventorySpinner = () => 'spinner';
  global.inventoryCollapsible = { initCollapsibleHandlers: () => { calls.collapsible += 1; } };
  global.inventoryCodeBlock = { initCopyHandlers: () => { calls.copy += 1; } };
  global.inventoryFaviconBadge = { initFaviconHandlers: () => { calls.favicon += 1; } };
  global.inventoryProgressBar = () => 'progress';
  global.inventoryStatusRow = () => 'status-row';
  // toggle-switch's UMD global is the module object; the barrel unwraps it to the
  // render function while still installing handlers from the module.
  global.inventoryToggleSwitch = {
    toggleSwitch: () => 'toggle',
    initToggleHandlers: () => { calls.toggle += 1; },
  };
  global.inventorySelectField = () => 'select-field';

  delete require.cache[require.resolve('../renderer/inventory/index')];
  const inventory = require('../renderer/inventory/index');

  assert.ok(inventory.collapsible, 'collapsible exported');
  assert.ok(inventory.codeBlock, 'codeBlock exported');
  assert.ok(inventory.faviconBadge, 'faviconBadge exported');
  assert.ok(inventory.statusRow, 'statusRow exported');
  assert.ok(inventory.toggleSwitch, 'toggleSwitch exported');
  assert.equal(typeof inventory.toggleSwitch, 'function', 'toggleSwitch is the render function');
  assert.ok(inventory.selectField, 'selectField exported');
  assert.strictEqual(inventory.Collapsible, undefined, 'no PascalCase alias for collapsible');
  assert.strictEqual(inventory.CodeBlock, undefined, 'no PascalCase alias for codeBlock');
  assert.strictEqual(inventory.FaviconBadge, undefined, 'no PascalCase alias for faviconBadge');
  assert.strictEqual(inventory.ToggleSwitch, undefined, 'no PascalCase alias for toggleSwitch');
  assert.equal(calls.copy, 1);
  assert.equal(calls.favicon, 1);
  assert.equal(calls.toggle, 1);
  assert.equal(calls.collapsible, 1);

  global.inventory = prevInventory;
  global.document = prevDocument;
  global.__inventoryHandlersInstalled = prevHandlersInstalled;
  global.inventoryBadge = prevBadge;
  global.inventorySpinner = prevSpinner;
  global.inventoryCollapsible = prevCollapsible;
  global.inventoryCodeBlock = prevCodeBlock;
  global.inventoryFaviconBadge = prevFaviconBadge;
  global.inventoryProgressBar = prevProgressBar;
  global.inventoryStatusRow = prevStatusRow;
  global.inventoryToggleSwitch = prevToggle;
  global.inventorySelectField = prevSelectField;
});
