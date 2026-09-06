const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

/* Load inventory primitives as Node modules. */
const badge = require('../renderer/inventory/badge');
const spinner = require('../renderer/inventory/spinner');
const Collapsible = require('../renderer/inventory/collapsible');
const CodeBlock = require('../renderer/inventory/codeblock');
const statusRow = require('../renderer/inventory/status-row');
const { toggleSwitch } = require('../renderer/inventory/toggle-switch');
const selectField = require('../renderer/inventory/select-field');
const numberInput = require('../renderer/inventory/number-input');
const actionButton = require('../renderer/inventory/action-button');
const Tooltip = require('../renderer/inventory/tooltip');

/* ── Badge ── */

test('badge renders default tone and size', () => {
  const html = badge({ text: 'Hello' });
  assert.ok(html.includes('class="inv-badge"'), 'has base class');
  assert.ok(html.includes('>Hello<'), 'contains text');
  assert.ok(!html.includes('inv-badge--'), 'no tone modifier for default');
});

test('badge renders success tone', () => {
  const html = badge({ tone: 'success', text: 'OK' });
  assert.ok(html.includes('inv-badge--success'), 'has success modifier');
});

test('badge renders pending tone', () => {
  const html = badge({ tone: 'pending', text: 'Working' });
  assert.ok(html.includes('inv-badge--pending'), 'has pending modifier');
});

test('badge renders warning tone', () => {
  const html = badge({ tone: 'warning', text: 'Heads up' });
  assert.ok(html.includes('inv-badge--warning'), 'has warning modifier');
});

test('badge renders danger tone', () => {
  const html = badge({ tone: 'danger', text: 'Fail' });
  assert.ok(html.includes('inv-badge--danger'), 'has danger modifier');
});

test('badge renders muted tone', () => {
  const html = badge({ tone: 'muted', text: '0' });
  assert.ok(html.includes('inv-badge--muted'), 'has muted modifier');
});

test('badge falls back to default tone for invalid values', () => {
  const html = badge({ tone: 'loud', text: 'Hello' });
  assert.ok(html.includes('class="inv-badge"'), 'has base class');
  assert.ok(!html.includes('inv-badge--loud'), 'invalid tone class not rendered');
});

test('badge renders small size', () => {
  const html = badge({ size: 'sm', text: '3' });
  assert.ok(html.includes('inv-badge--sm'), 'has sm modifier');
});

test('badge escapes HTML in text', () => {
  const html = badge({ text: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>'), 'script tag is escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped properly');
});

test('badge always escapes text and ignores html option', () => {
  const html = badge({ text: '<strong>Bold</strong>', html: '<em>Unsafe</em>' });
  assert.ok(!html.includes('<em>Unsafe</em>'));
  assert.ok(html.includes('&lt;strong&gt;Bold&lt;/strong&gt;'));
});

test('badge adds custom className', () => {
  const html = badge({ text: 'x', className: 'my-class' });
  assert.ok(html.includes('my-class'), 'custom class present');
});

test('badge strips unsafe custom className content', () => {
  const html = badge({ text: 'x', className: 'safe-class " onclick="alert(1)' });
  assert.ok(html.includes('safe-class'), 'safe token preserved');
  assert.ok(!html.includes('onclick='), 'unsafe attribute content removed');
});

/* ── Spinner ── */

test('spinner renders with default label', () => {
  const html = spinner();
  assert.ok(html.includes('class="inv-spinner"'), 'has spinner class');
  assert.ok(html.includes('role="status"'), 'has status role');
  assert.ok(html.includes('aria-label="Loading"'), 'default aria-label');
});

test('spinner renders with custom label', () => {
  const html = spinner({ label: 'Running' });
  assert.ok(html.includes('aria-label="Running"'), 'custom aria-label');
});

test('spinner renders small variant', () => {
  const html = spinner({ size: 'sm' });
  assert.ok(html.includes('inv-spinner--sm'), 'has sm modifier');
});

test('spinner escapes label', () => {
  const html = spinner({ label: '<img>' });
  assert.ok(html.includes('&lt;img&gt;'), 'label is escaped');
});

test('spinner strips unsafe custom className content', () => {
  const html = spinner({ className: 'ok-class " onmouseover="bad' });
  assert.ok(html.includes('ok-class'), 'safe token preserved');
  assert.ok(!html.includes('onmouseover='), 'unsafe attribute content removed');
});

/* -- Status Row -- */

test('status row renders label, message, and badge text', () => {
  const html = statusRow({
    tone: 'success',
    label: 'Runtime',
    message: 'Local runtime is ready.',
    badgeText: 'Ready',
  });

  assert.ok(html.includes('inv-status-row'), 'has base class');
  assert.ok(html.includes('inv-status-row--success'), 'has tone modifier');
  // The row is flat: one tone dot, then a single inline message line that
  // carries the label and the trailing qualifier. No meta/header/badge-slot
  // wrappers, and crucially no card container around any of it.
  assert.ok(html.includes('inv-status-row-dot'), 'renders the tone dot');
  assert.ok(html.includes('<span class="inv-status-row-label">Runtime</span>'), 'renders label inline');
  assert.ok(html.includes('<span class="inv-status-row-badge">Ready</span>'), 'renders badge as text');
  assert.ok(html.includes('Local runtime is ready.'), 'renders message');
  assert.ok(!html.includes('inv-status-row-meta'), 'no meta wrapper');
  assert.ok(!html.includes('inv-status-row-badge-slot'), 'no badge slot');
  assert.ok(!html.includes('inv-badge'), 'badge is plain text, not a badge pill');
});

test('status row falls back to default tone for invalid values', () => {
  const html = statusRow({
    tone: 'loud',
    message: 'Hello',
  });
  assert.ok(html.includes('inv-status-row'), 'has base class');
  assert.ok(!html.includes('inv-status-row--loud'), 'invalid tone class not rendered');
});

test('status row supports aria-live status semantics', () => {
  const html = statusRow({
    message: 'Saving your changes.',
    ariaLive: 'polite',
  });
  assert.ok(html.includes('role="status"'), 'has status role');
  assert.ok(html.includes('aria-live="polite"'), 'has aria-live attribute');
});

test('status row renders spinner and progress affordances', () => {
  const html = statusRow({
    tone: 'pending',
    message: 'Downloading model...',
    spinner: true,
    progress: {
      value: 25,
      max: 100,
      displayText: '25%',
    },
  });
  // `spinner: true` pulses the tone dot rather than drawing a spinner glyph;
  // the pulse itself is CSS, keyed off the --with-spinner modifier.
  assert.ok(html.includes('inv-status-row--with-spinner'), 'flags the pulsing dot');
  assert.ok(html.includes('inv-status-row-dot'), 'renders the tone dot');
  assert.ok(!html.includes('inv-spinner'), 'no spinner glyph is drawn');
  assert.ok(html.includes('role="progressbar"'), 'renders progressbar');
  assert.ok(html.includes('25%'), 'renders progress text');
});

test('status row escapes label, badge, and message content', () => {
  const html = statusRow({
    label: '<strong>Unsafe</strong>',
    badgeText: '<img>',
    message: '<script>alert(1)</script>',
  });
  assert.ok(!html.includes('<script>'), 'message is escaped');
  assert.ok(html.includes('&lt;strong&gt;Unsafe&lt;/strong&gt;'), 'label is escaped');
  assert.ok(html.includes('&lt;img&gt;'), 'badge text is escaped');
});

test('status row strips unsafe custom className content', () => {
  const html = statusRow({
    message: 'All set',
    className: 'status-extra " onclick="alert(1)',
  });
  assert.ok(html.includes('status-extra'), 'safe token preserved');
  assert.ok(!html.includes('onclick='), 'unsafe attribute content removed');
});

/* -- Number Input -- */

test('form primitives render escaped optional tooltips on their root labels', () => {
  const toggleHtml = toggleSwitch({ id: 'feature', label: 'Feature', tooltip: 'Toggle "feature"' });
  const selectHtml = selectField({
    id: 'mode', label: 'Mode', tooltip: 'Choose <mode>', options: [{ value: 'a', label: 'A' }],
  });
  const numberHtml = numberInput({ id: 'limit', label: 'Limit', tooltip: 'Set limit & units' });

  assert.ok(toggleHtml.includes('<label class="inv-toggle" title="Toggle &quot;feature&quot;">'));
  assert.ok(selectHtml.includes('<label class="inv-select-field" for="mode" title="Choose &lt;mode&gt;">'));
  assert.ok(numberHtml.includes('<label class="inv-number-input" for="limit" title="Set limit &amp; units">'));
});

test('toggle tooltip is reachable when focus enters the inner control', async (t) => {
  const dom = new JSDOM(`<!doctype html><body>${toggleSwitch({
    id: 'feature', label: 'Feature', tooltip: 'Hover text',
  })}</body>`);
  const { document, FocusEvent } = dom.window;
  t.after(() => {
    Tooltip.hide({ force: true });
    dom.window.close();
  });
  Tooltip.initTooltipHandlers(document);

  document.querySelector('[role="switch"]').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 450));

  assert.equal(document.querySelector('[role="tooltip"]')?.textContent, 'Hover text');
});

test('number input renders bounded numeric control and escapes attributes', () => {
  const html = numberInput({
    id: 'cpu-threshold',
    label: 'CPU threshold',
    value: 75,
    min: 50,
    max: 100,
    step: 1,
    suffix: '%',
    ariaLabel: 'CPU alert threshold',
    className: 'threshold-control',
  });

  assert.ok(html.includes('inv-number-input'), 'has base class');
  assert.ok(html.includes('threshold-control'), 'preserves safe class');
  assert.ok(html.includes('id="cpu-threshold"'), 'renders id');
  assert.ok(html.includes('type="number"'), 'renders number input');
  assert.ok(html.includes('min="50"'), 'renders min');
  assert.ok(html.includes('max="100"'), 'renders max');
  assert.ok(html.includes('value="75"'), 'renders value');
  assert.ok(html.includes('CPU threshold'), 'renders label');
  assert.ok(html.includes('%'), 'renders suffix');
});

test('number input clamps default value and strips unsafe class names', () => {
  const html = numberInput({
    id: 'ram-threshold',
    label: '<RAM>',
    value: 150,
    min: 50,
    max: 100,
    className: 'safe-class " onclick="bad',
  });

  assert.ok(html.includes('value="100"'), 'clamps value to max');
  assert.ok(html.includes('&lt;RAM&gt;'), 'escapes label');
  assert.ok(html.includes('safe-class'), 'safe token preserved');
  assert.ok(!html.includes('onclick='), 'unsafe attribute content removed');
});

/* -- Action Button -- */

test('action button supports plain styled controls with trusted inner markup', () => {
  /* Neutral disclosure example: exercises plain + domId + ariaControls + dataset
     + trustedHtml together. Decoupled from any specific UI element so retiring a
     control (e.g. the old latency toggle) can't leave this primitive test stale. */
  const html = actionButton({
    plain: true,
    domId: 'demoDisclosureToggle',
    className: 'demo-disclosure-toggle',
    trustedHtml: '<span class="demo-disclosure-label">Show</span>',
    title: 'Show or hide the panel',
    ariaExpanded: false,
    ariaControls: 'demoDisclosurePanel',
    dataset: { 'demo-action': 'toggle' },
  });

  assert.ok(html.startsWith('<button'), 'renders a real button');
  assert.ok(html.includes('class="demo-disclosure-toggle"'), 'uses caller-owned class in plain mode');
  assert.ok(html.includes('id="demoDisclosureToggle"'), 'renders DOM id');
  assert.ok(html.includes('aria-expanded="false"'), 'renders aria-expanded');
  assert.ok(html.includes('aria-controls="demoDisclosurePanel"'), 'renders aria-controls');
  assert.ok(html.includes('data-demo-action="toggle"'), 'renders dataset');
  assert.ok(html.includes('<span class="demo-disclosure-label">Show</span>'), 'renders trusted inner markup');
});

/* ── Collapsible ── */

test('collapsible trigger renders with correct ARIA attributes', () => {
  const html = Collapsible.trigger({ id: 'panel-1', children: '<span>Click</span>' });
  assert.ok(html.includes('role="button"'), 'has button role');
  assert.ok(html.includes('tabindex="0"'), 'is focusable');
  assert.ok(html.includes('aria-expanded="false"'), 'starts collapsed');
  assert.ok(html.includes('aria-controls="panel-1"'), 'points to content');
  assert.ok(html.includes('data-inv-collapsible="panel-1"'), 'has data attribute');
  assert.ok(html.includes('<span>Click</span>'), 'children rendered');
});

test('collapsible trigger renders open state', () => {
  const html = Collapsible.trigger({ id: 'panel-2', open: true });
  assert.ok(html.includes('aria-expanded="true"'), 'expanded when open');
});

test('collapsible trigger adds custom className', () => {
  const html = Collapsible.trigger({ id: 'p', className: 'tool-call-header' });
  assert.ok(html.includes('inv-collapsible-trigger tool-call-header'), 'both classes present');
});

test('collapsible trigger strips unsafe custom className content', () => {
  const html = Collapsible.trigger({ id: 'p', className: 'safe-trigger " onclick="bad' });
  assert.ok(html.includes('safe-trigger'), 'safe token preserved');
  assert.ok(!html.includes('onclick='), 'unsafe attribute content removed');
});

test('collapsible trigger escapes id', () => {
  const html = Collapsible.trigger({ id: '"><script>' });
  assert.ok(!html.includes('<script>'), 'id is escaped');
});

test('collapsible content renders hidden when closed', () => {
  const html = Collapsible.content({ id: 'panel-1', children: '<p>Body</p>' });
  assert.ok(html.includes('id="panel-1"'), 'has id');
  assert.ok(html.includes('hidden'), 'hidden when closed');
  assert.ok(html.includes('data-state="closed"'), 'closed state');
  assert.ok(!html.includes('expanded'), 'no expanded class');
  assert.ok(html.includes('<p>Body</p>'), 'children rendered');
});

test('collapsible content renders visible when open', () => {
  const html = Collapsible.content({ id: 'panel-1', open: true, children: 'Open' });
  assert.ok(!html.includes(' hidden'), 'not hidden when open');
  assert.ok(html.includes('data-state="open"'), 'open state');
  assert.ok(html.includes('expanded'), 'has expanded class');
});

test('collapsible content adds custom className', () => {
  const html = Collapsible.content({ id: 'p', className: 'tool-call-details' });
  assert.ok(html.includes('inv-collapsible-content'), 'base class');
  assert.ok(html.includes('tool-call-details'), 'custom class');
});

test('collapsible content strips unsafe custom className content', () => {
  const html = Collapsible.content({ id: 'p', className: 'safe-panel " onmouseover="bad' });
  assert.ok(html.includes('safe-panel'), 'safe token preserved');
  assert.ok(!html.includes('onmouseover='), 'unsafe attribute content removed');
});

test('collapsible trigger and content IDs match', () => {
  const triggerId = 'shared-id-42';
  const triggerHtml = Collapsible.trigger({ id: triggerId });
  const contentHtml = Collapsible.content({ id: triggerId });
  assert.ok(triggerHtml.includes(`aria-controls="${triggerId}"`), 'trigger points to ID');
  assert.ok(contentHtml.includes(`id="${triggerId}"`), 'content has matching ID');
});

test('collapsible delegated keyboard handler toggles trigger on Enter/Space', (t) => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousRaf = global.requestAnimationFrame;
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    global.requestAnimationFrame = previousRaf;
  });

  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const { document, KeyboardEvent } = dom.window;
  global.window = dom.window;
  global.document = document;
  global.requestAnimationFrame = (cb) => cb();

  const root = document.getElementById('root');
  root.innerHTML = Collapsible.trigger({ id: 'panel-1', children: 'Toggle' })
    + Collapsible.content({ id: 'panel-1', children: 'Body' });
  Collapsible.initCollapsibleHandlers(document);

  const trigger = root.querySelector('[data-inv-collapsible]');
  const content = root.querySelector('#panel-1');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(content.hidden, true);

  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(content.hidden, false);

  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('collapsible toggle does not store timer state on DOM expando properties', (t) => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousRaf = global.requestAnimationFrame;
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    global.requestAnimationFrame = previousRaf;
  });

  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const { document } = dom.window;
  global.window = dom.window;
  global.document = document;
  global.requestAnimationFrame = (cb) => cb();

  const root = document.getElementById('root');
  root.innerHTML = Collapsible.trigger({ id: 'panel-weakmap', children: 'Toggle' })
    + Collapsible.content({ id: 'panel-weakmap', children: 'Body' });
  const trigger = root.querySelector('[data-inv-collapsible]');
  const content = root.querySelector('#panel-weakmap');

  Collapsible.toggle(trigger, true);
  assert.equal(Object.prototype.hasOwnProperty.call(content, '__invTimer'), false);
});

test('collapsible toggle uses pretext prediction when the DOM reports zero height and the gate is enabled', (t) => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousRaf = global.requestAnimationFrame;
  const previousPretextUtils = global.rendererPretextUtils;
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    global.requestAnimationFrame = previousRaf;
    global.rendererPretextUtils = previousPretextUtils;
  });

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { document } = dom.window;
  global.window = dom.window;
  global.document = document;
  global.requestAnimationFrame = (cb) => cb();
  document.documentElement.dataset.pretextLayout = 'true';
  global.rendererPretextUtils = {
    resolveFontString() {
      return 'normal normal 400 15px sans-serif';
    },
    resolveElementWidth() {
      return 240;
    },
    predictTextHeight() {
      return { height: 72 };
    },
  };

  const root = document.getElementById('root');
  root.innerHTML = Collapsible.trigger({ id: 'panel-pretext', children: 'Toggle' })
    + Collapsible.content({ id: 'panel-pretext', children: 'Hidden body text' });
  const trigger = root.querySelector('[data-inv-collapsible]');
  const content = root.querySelector('#panel-pretext');
  Object.defineProperty(content, 'scrollHeight', { configurable: true, get() { return 0; } });
  Object.defineProperty(content, 'offsetHeight', { configurable: true, get() { return 0; } });

  Collapsible.toggle(trigger, true);

  assert.equal(content.hidden, false);
  assert.equal(content.style.maxHeight, '72px');
});

test('collapsible pretext fallback uses the default font when direct font resolution is unavailable', (t) => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousRaf = global.requestAnimationFrame;
  const previousPretextUtils = global.rendererPretextUtils;
  let capturedFont = null;
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    global.requestAnimationFrame = previousRaf;
    global.rendererPretextUtils = previousPretextUtils;
  });

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { document } = dom.window;
  global.window = dom.window;
  global.document = document;
  global.requestAnimationFrame = (cb) => cb();
  document.documentElement.dataset.pretextLayout = 'true';
  global.rendererPretextUtils = {
    resolveFontString() {
      return null;
    },
    resolveDefaultFontString() {
      return 'normal normal 400 15px Fallback Sans';
    },
    resolveElementWidth() {
      return 240;
    },
    predictTextHeight(_cacheKey, _text, font) {
      capturedFont = font;
      return { height: 88 };
    },
  };

  const root = document.getElementById('root');
  root.innerHTML = Collapsible.trigger({ id: 'panel-pretext-fallback', children: 'Toggle' })
    + Collapsible.content({ id: 'panel-pretext-fallback', children: 'Hidden body text' });
  const trigger = root.querySelector('[data-inv-collapsible]');
  const content = root.querySelector('#panel-pretext-fallback');
  Object.defineProperty(content, 'scrollHeight', { configurable: true, get() { return 0; } });
  Object.defineProperty(content, 'offsetHeight', { configurable: true, get() { return 0; } });

  Collapsible.toggle(trigger, true);

  assert.equal(capturedFont, 'normal normal 400 15px Fallback Sans');
  assert.equal(content.style.maxHeight, '88px');
});

/* ── CodeBlock ── */

test('codeblock renders basic code', () => {
  const html = CodeBlock.codeblock({ code: 'hello world' });
  assert.ok(html.includes('class="inv-codeblock-wrap"'), 'has wrapper');
  assert.ok(html.includes('<pre class="inv-codeblock"'), 'has pre element');
  assert.ok(html.includes('<code>hello world</code>'), 'code content');
});

test('codeblock renders language label', () => {
  const html = CodeBlock.codeblock({ code: 'x', language: 'python' });
  assert.ok(html.includes('class="language-python"'), 'language class on code');
  assert.ok(html.includes('inv-codeblock-toolbar'), 'toolbar present');
  assert.ok(html.includes('python'), 'language label shown');
});

test('codeblock renders copy button when copyable', () => {
  const html = CodeBlock.codeblock({ code: 'x', copyable: true, copyId: 'copy-1' });
  assert.ok(html.includes('inv-codeblock-copy'), 'copy button present');
  assert.ok(html.includes('data-inv-copy-target="copy-1"'), 'copy target attribute');
  assert.ok(html.includes('aria-label="Copy code"'), 'accessible label');
});

test('codeblock does not render copy button when not copyable', () => {
  const html = CodeBlock.codeblock({ code: 'x' });
  assert.ok(!html.includes('inv-codeblock-copy'), 'no copy button');
});

test('codeblock escapes code content', () => {
  const html = CodeBlock.codeblock({ code: '<div class="xss">' });
  assert.ok(!html.includes('<div class="xss">'), 'HTML is escaped');
  assert.ok(html.includes('&lt;div class=&quot;xss&quot;&gt;'), 'properly escaped');
});

test('codeblock renders accessible label', () => {
  const html = CodeBlock.codeblock({ code: 'x', ariaLabel: 'Test output' });
  assert.ok(html.includes('aria-label="Test output"'), 'custom aria-label');
});

test('codeblock strips unsafe custom className content', () => {
  const html = CodeBlock.codeblock({ code: 'x', className: 'safe-wrap " onclick="bad' });
  assert.ok(html.includes('safe-wrap'), 'safe token preserved');
  assert.ok(!html.includes('onclick='), 'unsafe attribute content removed');
});

test('codeblockTruncated truncates at maxChars', () => {
  const longCode = 'A'.repeat(200);
  const html = CodeBlock.codeblockTruncated({ code: longCode, maxChars: 100 });
  assert.ok(html.includes('(truncated)'), 'truncation marker present');
  assert.ok(html.includes('inv-codeblock-truncated'), 'truncation class');
});

test('codeblockTruncated passes through short code', () => {
  const html = CodeBlock.codeblockTruncated({ code: 'short', maxChars: 100 });
  assert.ok(!html.includes('(truncated)'), 'no truncation');
  assert.ok(html.includes('short'), 'full code shown');
});

test('codeblockTruncated defaults to 10000 char limit', () => {
  const code = 'B'.repeat(10001);
  const html = CodeBlock.codeblockTruncated({ code: code });
  assert.ok(html.includes('(truncated)'), 'truncated at default limit');
});

test('codeblockTruncated preserves copy button', () => {
  const longCode = 'C'.repeat(200);
  const html = CodeBlock.codeblockTruncated({
    code: longCode, maxChars: 100, copyable: true, copyId: 'cp',
  });
  assert.ok(html.includes('inv-codeblock-copy'), 'copy button in truncated block');
  assert.ok(html.includes('(truncated)'), 'truncation marker');
});

test('copy handler excludes visual truncation marker from copied text', async (t) => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    if (previousNavigatorDescriptor) {
      Object.defineProperty(global, 'navigator', previousNavigatorDescriptor);
    }
  });

  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const { document } = dom.window;
  global.window = dom.window;
  global.document = document;
  var copiedText = '';
  Object.defineProperty(global, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(global.navigator, 'clipboard', {
    value: {
      writeText: (text) => {
        copiedText = text;
        return Promise.resolve();
      },
    },
    configurable: true,
  });

  const root = document.getElementById('root');
  root.innerHTML = CodeBlock.codeblockTruncated({
    code: 'A'.repeat(20),
    maxChars: 10,
    copyable: true,
    copyId: 'copy-target-1',
  });

  CodeBlock.initCopyHandlers(document);
  const button = root.querySelector('.inv-codeblock-copy');
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(copiedText, 'A'.repeat(10), 'copied text should not include truncation marker');
});

test('copy handler resolves registered full text before the capped DOM preview', async (t) => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  t.after(() => {
    CodeBlock.registerCopyTextResolver(null);
    global.window = previousWindow;
    global.document = previousDocument;
    if (previousNavigatorDescriptor) Object.defineProperty(global, 'navigator', previousNavigatorDescriptor);
    else delete global.navigator;
  });

  const dom = new JSDOM('<div id="root"><div class="inv-codeblock-wrap"><button class="inv-codeblock-copy" data-inv-copy-target="full-output">Copy</button><pre><code>preview</code></pre></div></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  let copiedText = '';
  Object.defineProperty(global.navigator, 'clipboard', {
    value: { writeText: (text) => { copiedText = text; return Promise.resolve(); } },
    configurable: true,
  });
  CodeBlock.registerCopyTextResolver((copyId) => copyId === 'full-output' ? 'complete payload' : null);
  CodeBlock.initCopyHandlers(dom.window.document);
  dom.window.document.querySelector('.inv-codeblock-copy').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(copiedText, 'complete payload');
  dom.window.close();
});

test('copy handler contains resolver failures and restores custom button labels', async (t) => {
  const previousDocument = global.document;
  const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  const previousSetTimeout = global.setTimeout;
  t.after(() => {
    CodeBlock.registerCopyTextResolver(null);
    global.document = previousDocument;
    global.setTimeout = previousSetTimeout;
    if (previousNavigatorDescriptor) Object.defineProperty(global, 'navigator', previousNavigatorDescriptor);
    else delete global.navigator;
  });

  const dom = new JSDOM('<div class="inv-codeblock-wrap"><button class="inv-codeblock-copy" data-inv-copy-target="missing">Copy output</button><pre><code>DOM fallback</code></pre></div>');
  global.document = dom.window.document;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  let copiedText = '';
  Object.defineProperty(global.navigator, 'clipboard', {
    value: { writeText: (text) => { copiedText = text; return Promise.resolve(); } },
    configurable: true,
  });
  const resetCallbacks = [];
  global.setTimeout = (callback) => { resetCallbacks.push(callback); return resetCallbacks.length; };
  CodeBlock.registerCopyTextResolver(() => { throw new Error('resolver unavailable'); });
  CodeBlock.initCopyHandlers(dom.window.document);
  const button = dom.window.document.querySelector('.inv-codeblock-copy');
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(copiedText, 'DOM fallback');
  resetCallbacks.forEach((callback) => callback());
  assert.equal(button.textContent, 'Copy output');
  dom.window.close();
});

test('initCopyHandlers is idempotent and does not install duplicate listeners', async (t) => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    if (previousNavigatorDescriptor) {
      Object.defineProperty(global, 'navigator', previousNavigatorDescriptor);
    }
  });

  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const { document } = dom.window;
  global.window = dom.window;
  global.document = document;
  var writes = 0;
  Object.defineProperty(global, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(global.navigator, 'clipboard', {
    value: {
      writeText: () => {
        writes += 1;
        return Promise.resolve();
      },
    },
    configurable: true,
  });

  const root = document.getElementById('root');
  root.innerHTML = CodeBlock.codeblock({
    code: 'echo one',
    copyable: true,
    copyId: 'copy-target-2',
  });

  CodeBlock.initCopyHandlers(document);
  CodeBlock.initCopyHandlers(document);
  const button = root.querySelector('.inv-codeblock-copy');
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(writes, 1, 'single click should trigger one clipboard write');
});

test('codeblock renders a label caption override and an icon copy button', () => {
  const html = CodeBlock.codeblock({
    code: 'x', language: 'json', label: 'Input',
    copyable: true, copyIcon: true, copyId: 'cp-in',
  });
  // Caption uses the label, code class still uses the language.
  assert.ok(html.includes('<span class="inv-codeblock-language">Input</span>'), 'label caption');
  assert.ok(html.includes('class="language-json"'), 'language class preserved');
  // Icon copy button: marker class + data attr + both glyph spans, aria from label.
  assert.ok(html.includes('inv-codeblock-copy inv-codeblock-copy--icon'), 'icon copy class');
  assert.ok(html.includes('data-copy-icon'), 'icon-mode marker attribute');
  assert.ok(html.includes('inv-copy-idle'), 'idle glyph span');
  assert.ok(html.includes('inv-copy-done'), 'done glyph span');
  assert.ok(html.includes('aria-label="Copy input"'), 'accessible label derives from the label');
  assert.ok(!html.includes('>Copy</button>'), 'no literal "Copy" text in icon mode');
});

test('codeblock renders a line-number gutter matching the code line count', () => {
  const html = CodeBlock.codeblock({ code: 'a\nb\nc', lineNumbers: true });
  assert.ok(html.includes('class="inv-codeblock-body"'), 'flex body wrapper');
  assert.ok(html.includes('inv-codeblock--numbered'), 'numbered content variant');
  assert.ok(
    html.includes('<pre class="inv-codeblock-gutter" aria-hidden="true">1\n2\n3</pre>'),
    'gutter lists one number per code line',
  );
});

test('icon-mode copy keeps the SVG glyphs intact and announces via aria-label', async (t) => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    if (previousNavigatorDescriptor) {
      Object.defineProperty(global, 'navigator', previousNavigatorDescriptor);
    }
  });

  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const { document } = dom.window;
  global.window = dom.window;
  global.document = document;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(global.navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
  });

  const root = document.getElementById('root');
  root.innerHTML = CodeBlock.codeblock({
    code: 'value', label: 'Output', copyable: true, copyIcon: true, copyId: 'cp-out',
  });
  CodeBlock.initCopyHandlers(document);
  const button = root.querySelector('.inv-codeblock-copy');
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The SVG spans must survive the copy (textContent was NOT overwritten).
  assert.ok(button.querySelector('.inv-copy-idle'), 'idle SVG span intact after copy');
  assert.ok(button.querySelector('.inv-copy-done'), 'done SVG span intact after copy');
  assert.equal(button.getAttribute('data-copy-status'), 'copied', 'status drives the CSS glyph swap');
  // Success is announced on the accessible name since there is no visible text.
  assert.equal(button.getAttribute('aria-label'), 'Copied', 'aria-label mirrors copy success');
});
