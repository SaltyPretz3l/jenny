const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'markdown.css'), 'utf8');
const bubbleCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-bubble-v2.css'), 'utf8');
const threadCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-thread.css'), 'utf8');
const mediaCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-media-queries.css'), 'utf8');
const timelineTokens = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-timeline-tokens.css'), 'utf8');

test('tool results inherit the shared Markdown code token host', () => {
  assert.match(css, /:is\(\.chat-bubble-markdown, \.tool-result-body\)\s*\{/);
  assert.match(css, /:is\(\.chat-bubble-markdown, \.tool-result-body\) pre\s*\{/);
  assert.match(css, /--markdown-code-block-radius:/);
});

test('fenced code blocks use the flat timeline surface and plain expansion label', () => {
  assert.match(css, /--markdown-code-block-radius:\s*var\(--tl-radius-panel\)/);
  assert.match(css, /--markdown-code-block-bg:\s*var\(--tl-code-bg\)/);
  assert.match(css, /\.markdown-code-block\s*\{[\s\S]*?border:\s*0;/);
  const headerRule = css.match(/\.markdown-code-header\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(headerRule, /border:\s*0/);
  assert.match(headerRule, /border-radius:\s*0/);
  assert.match(headerRule, /background:\s*transparent/);
  assert.match(css, /\.markdown-code-block\.is-wrapped pre code\s*\{[\s\S]*?white-space:\s*pre-wrap/);
  const labelRule = css.match(/\.markdown-code-expand-overlay span\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(labelRule, /background:\s*transparent/);
  assert.match(labelRule, /border:\s*0/);
  assert.match(labelRule, /box-shadow:\s*none/);
});

test('Markdown links and native formatting actions have focus-visible treatment', () => {
  assert.match(css, /:is\(\.chat-bubble-markdown, \.tool-result-body\) a:focus-visible/);
  assert.match(css, /\.markdown-mermaid-retry:focus-visible/);
  assert.match(css, /\.markdown-code-expand-overlay:focus-visible/);
});

test('task lists, aligned tables, and responsive images have explicit contracts', () => {
  assert.match(css, /\.contains-task-list/);
  assert.match(css, /input\[type="checkbox"\]/);
  assert.match(css, /\.task-list-item\s*\{[\s\S]*?display:\s*grid/);
  assert.match(css, /:is\(th, td\)\[align="center"\]/);
  assert.match(css, /max-height: min\(70vh, 720px\)/);
});

test('Mermaid fullscreen uses the modal scrim token rather than the chat-stage overlay', () => {
  const overlayRule = css.match(/\.mermaid-fullscreen-overlay\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(overlayRule, /var\(--surface-auth-overlay,/);
  assert.doesNotMatch(overlayRule, /var\(--surface-main-stage-overlay,/);
});

test('markdown.css is the sole prose-element style owner', () => {
  assert.doesNotMatch(bubbleCss, /\.chat-bubble-markdown\s+(?:a|blockquote|table|:not\(pre\)\s*>\s*code)/);
  assert.doesNotMatch(css, /border-left\s*:/);
  assert.doesNotMatch(css, /tr:nth-child|tr:hover/);
  assert.match(css, /blockquote\s*\{[\s\S]*?border:\s*0/);
  assert.match(css, /tbody tr\s*\{[\s\S]*?border-bottom:\s*1px solid var\(--line\)/);
});

test('prose chrome uses quiet timeline tokens and no micro-motion', () => {
  assert.match(css, /--markdown-flow-gap:\s*0\.85em/);
  assert.match(css, /--markdown-block-gap:\s*1\.15em/);
  assert.match(css, /\.chat-bubble-markdown mark\s*\{/);
  assert.match(css, /\.chat-bubble-markdown kbd\s*\{/);
  assert.doesNotMatch(css, /(?:linear|radial)-gradient\(/);
  const radiusValues = [...css.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1].trim());
  assert.ok(radiusValues.every((value) => value === '0' || value.startsWith('var(')));
  assert.doesNotMatch(css, /translateY\(-0\.5px\)|translateY\(-1px\)|scale\(0\.96\)/);
  assert.doesNotMatch(css, /data-copy-status="copied"[^}]*![Ii]mportant/);
});

test('user bubbles use a flat timeline surface and the content column stays at 760px', () => {
  assert.match(timelineTokens, /--tl-user-bubble-bg:\s*color-mix\(in srgb, var\(--text-primary\) 6%, var\(--bg-surface\)\)/);
  const userBubble = threadCss.match(/\.chat-entry\.user \.chat-bubble\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(userBubble, /background:\s*var\(--tl-user-bubble-bg\)/);
  assert.match(userBubble, /border:\s*0/);
  assert.doesNotMatch(userBubble, /backdrop-filter|gradient/);
  assert.doesNotMatch(mediaCss, /--content-column-width:\s*min\(920px/);
  assert.match(mediaCss, /--composer-width:\s*min\(920px/);
});

test('collapsible code blocks interpolate between the collapsed cap and max-content', () => {
  const expandedRule = css.match(/\.markdown-code-block\.collapsible > pre\s*\{[\s\S]*?\}/)?.[0] || '';
  const collapsedRule = css.match(/\.markdown-code-block\.collapsible\.collapsed > pre\s*\{[\s\S]*?\}/)?.[0] || '';

  assert.match(expandedRule, /interpolate-size:\s*allow-keywords/);
  assert.match(expandedRule, /max-height:\s*max-content/);
  assert.match(expandedRule, /transition:\s*max-height/);
  assert.match(collapsedRule, /max-height:\s*250px/);
});
