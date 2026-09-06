const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeMermaidPreviewSource,
  sanitizeMermaidSource,
  sanitizeMermaidSvgMarkup,
} = require('../renderer/features/renderer-mermaid-sanitize-utils');

test('sanitizeMermaidSource repairs single-percent comments without changing directives', () => {
  assert.equal(
    sanitizeMermaidSource([
      'flowchart TD',
      '  % ordinary comment',
      '  %% already valid',
      '  %%{init: {"theme": "base"}}%%',
    ].join('\n')),
    [
      'flowchart TD',
      '  %% ordinary comment',
      '  %% already valid',
      '  %%{init: {"theme": "base"}}%%',
    ].join('\n')
  );
});

test('sanitizeMermaidSource preserves literal percentages in labels and sequence messages', () => {
  assert.equal(
    sanitizeMermaidSource('flowchart TD\nA[CPU 50% used]'),
    'flowchart TD\nA[CPU 50% used]'
  );
  assert.equal(
    sanitizeMermaidSource('sequenceDiagram\nA->>B: progress 50% complete'),
    'sequenceDiagram\nA->>B: progress 50% complete'
  );
});

test('sanitizeMermaidPreviewSource quotes flowchart labels with parentheses', () => {
  assert.equal(
    sanitizeMermaidPreviewSource([
      'flowchart TD',
      '  A[Outer Ring (Barrier)] --> B{Inner Ring (Check)}',
      '  B --> C(Pathway (Ready))',
      '  C --> D[(1) Officially Assembled]',
    ].join('\n')),
    [
      'flowchart TD',
      '  A["Outer Ring (Barrier)"] --> B{"Inner Ring (Check)"}',
      '  B --> C("Pathway (Ready)")',
      '  C --> D["(1) Officially Assembled"]',
    ].join('\n')
  );
});

test('sanitizeMermaidPreviewSource leaves non-flowchart diagrams unchanged except comments', () => {
  assert.equal(
    sanitizeMermaidPreviewSource('sequenceDiagram\n  A->>B: call (ok)\n  % note'),
    'sequenceDiagram\n  A->>B: call (ok)\n  %% note'
  );
});

test('sanitizeMermaidSvgMarkup strips scripts, event handlers, and javascript urls', () => {
  const sanitized = sanitizeMermaidSvgMarkup([
    '<svg onclick="alert(1)">',
    '<script>alert(1)</script>',
    '<a href="javascript:alert(1)" onfocus="bad()">bad</a>',
    '<image src="javascript:alert(2)" onload="bad()" />',
    '<path d="M0 0" />',
    '</svg>',
  ].join(''));

  assert.doesNotMatch(sanitized, /<script/i);
  assert.doesNotMatch(sanitized, /\son[a-z]+=/i);
  assert.doesNotMatch(sanitized, /javascript:/i);
  assert.match(sanitized, /<path d="M0 0"/);
});
