const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const {
  buildMarkdownArtifactDocumentHtml,
  buildMarkdownArtifactDocumentSignature,
  decorateMarkdownArtifactDocument,
  detectArtifactDocumentHint,
  slugifyArtifactDocumentHeadingText,
} = require('../renderer/features/renderer-artifact-document-render.js');

function markdownStub(source) {
  return String(source || '')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^> \[!(IMPORTANT|CAUTION|WARNING|NOTE|TIP)\]\n> (.+)$/gm, '<blockquote><p>[!$1]<br>$2</p></blockquote>')
    .replace(/```(\w+)\n([\s\S]*?)```/gm, '<div class="markdown-code-block"><div class="markdown-code-header"><span class="markdown-code-language">$1</span></div><pre><code>$2</code></pre></div>');
}

test('buildMarkdownArtifactDocumentHtml renders sanitized markdown inside document shell', () => {
  const html = buildMarkdownArtifactDocumentHtml({
    title: 'Implementation Plan',
    content: '# Implementation Plan\n\n```powershell\nnpm test\n```',
    mode: 'read',
    editable: true,
  }, {
    renderMarkdown: markdownStub,
    escapeHtml: (value) => String(value || '').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });

  assert.match(html, /artifact-document/);
  assert.match(html, /data-artifact-document-mode="read"/);
  assert.match(html, /Implementation Plan/);
  assert.match(html, /data-artifact-document-view="source"/);
  assert.match(html, /data-artifact-document-progress/);
  assert.match(html, /data-artifact-document-back-to-top/);
  assert.match(html, /markdown-code-block/);

  const fallbackHtml = buildMarkdownArtifactDocumentHtml({
    content: '<script>alert(1)</script>',
  });
  assert.match(fallbackHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const thrownRendererHtml = buildMarkdownArtifactDocumentHtml({
    content: '<img src=x onerror=alert(1)>',
  }, {
    renderMarkdown() {
      throw new Error('parser unavailable');
    },
  });
  assert.match(thrownRendererHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(thrownRendererHtml, /<img src=x/);
});

test('buildMarkdownArtifactDocumentHtml skips markdown rendering in source mode', () => {
  let renderCalls = 0;
  const html = buildMarkdownArtifactDocumentHtml({
    title: 'Source Only',
    content: '# Hidden Read View',
    mode: 'source',
    editable: true,
  }, {
    renderMarkdown() {
      renderCalls += 1;
      return '<h1>Hidden Read View</h1>';
    },
  });

  assert.equal(renderCalls, 0);
  assert.match(html, /data-artifact-document-mode="source"/);
  assert.doesNotMatch(html, /<h1>Hidden Read View<\/h1>/);
});

test('slugifyArtifactDocumentHeadingText normalizes rendered heading text into selector-safe ids', () => {
  assert.equal(slugifyArtifactDocumentHeadingText('Formatted Heading!'), 'formatted-heading');
  assert.equal(slugifyArtifactDocumentHeadingText('Plan: API/IPC & UI'), 'plan-api-ipc-ui');
  assert.equal(slugifyArtifactDocumentHeadingText('Résumé Findings'), 'resume-findings');
  assert.equal(slugifyArtifactDocumentHeadingText('2026 Launch Plan'), 'section-2026-launch-plan');
  assert.equal(slugifyArtifactDocumentHeadingText('🔥 ✅'), '');
});

test('decorateMarkdownArtifactDocument assigns stable unique heading ids and outline buttons', () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const root = dom.window.document.getElementById('root');
  root.innerHTML = buildMarkdownArtifactDocumentHtml({
    title: 'Heading Cases',
    content: '# ignored',
    mode: 'read',
    editable: true,
  }, {
    renderMarkdown: () => [
      '<h1><em>Formatted</em> Heading!</h1>',
      '<h2>Plan: API/IPC &amp; UI</h2>',
      '<h2>Plan: API/IPC &amp; UI</h2>',
      '<h3>🔥 ✅</h3>',
      '<h2 id="existing-safe_id">Existing ID</h2>',
      '<h2 id="unsafe id?">Unsafe ID</h2>',
    ].join(''),
  });

  const result = decorateMarkdownArtifactDocument(root, { documentRef: dom.window.document });

  assert.deepEqual(
    Array.from(root.querySelectorAll('h1,h2,h3')).map((heading) => heading.id),
    ['formatted-heading', 'plan-api-ipc-ui', 'plan-api-ipc-ui-2', 'section-4', 'existing-safe_id', 'unsafe-id']
  );
  assert.equal(result.outline.length, 6);
  assert.equal(root.querySelector('[data-artifact-document-outline-shell]').hidden, false);
  assert.equal(root.querySelectorAll('[data-artifact-document-outline-target]').length, 6);
  assert.equal(root.querySelector('[data-artifact-document-outline-target="formatted-heading"]').getAttribute('aria-current'), 'true');
  assert.equal(root.querySelector('[data-artifact-document-outline]').getAttribute('aria-label'), 'Document outline');
});

test('decorateMarkdownArtifactDocument omits short outlines and caps long outlines', () => {
  const shortDom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const shortRoot = shortDom.window.document.getElementById('root');
  shortRoot.innerHTML = buildMarkdownArtifactDocumentHtml({
    content: '# Short\n\n## Tiny',
  }, {
    renderMarkdown: markdownStub,
  });

  decorateMarkdownArtifactDocument(shortRoot, { documentRef: shortDom.window.document });

  const shortShell = shortRoot.querySelector('[data-artifact-document-outline-shell]');
  assert.equal(shortShell.hidden, false);
  assert.equal(shortShell.getAttribute('aria-hidden'), 'true');
  assert.equal(shortShell.dataset.artifactDocumentOutlineVisible, 'false');
  assert.equal(shortRoot.querySelectorAll('[data-artifact-document-outline-target]').length, 0);

  const longDom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const longRoot = longDom.window.document.getElementById('root');
  const longMarkdown = Array.from({ length: 30 }, (_value, index) => `## Section ${index + 1}`).join('\n\n');
  longRoot.innerHTML = buildMarkdownArtifactDocumentHtml({
    content: longMarkdown,
  }, {
    renderMarkdown: markdownStub,
  });

  decorateMarkdownArtifactDocument(longRoot, { documentRef: longDom.window.document });

  assert.equal(longRoot.querySelectorAll('[data-artifact-document-outline-target]').length, 24);
  assert.equal(longRoot.querySelector('[data-artifact-document-outline-shell]').dataset.outlineCapped, 'true');
  assert.equal(longRoot.querySelector('[data-artifact-document-outline-target="section-24"]').textContent.trim(), 'Section 24');
});

test('decorateMarkdownArtifactDocument applies subtle document hints without changing generic documents', () => {
  const planDom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const planRoot = planDom.window.document.getElementById('root');
  planRoot.innerHTML = buildMarkdownArtifactDocumentHtml({
    content: '# Plan\n\n## User Review Required\n\n## Proposed Changes\n\n## Verification Plan',
  }, {
    renderMarkdown: markdownStub,
  });

  decorateMarkdownArtifactDocument(planRoot, { documentRef: planDom.window.document });

  assert.equal(planRoot.querySelector('.artifact-document').dataset.artifactDocumentHint, 'plan');
  assert.equal(planRoot.querySelector('[data-artifact-document-kind-badge]').hidden, false);
  assert.match(planRoot.querySelector('[data-artifact-document-kind-badge]').textContent, /Plan/);

  const ambiguous = detectArtifactDocumentHint([
    'Scope of Review',
    'Issues Found',
    'Summary',
    'User Review Required',
    'Proposed Changes',
    'Verification Plan',
  ]);
  assert.equal(ambiguous, 'generic');

  const genericDom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const genericRoot = genericDom.window.document.getElementById('root');
  genericRoot.innerHTML = buildMarkdownArtifactDocumentHtml({
    content: '# Notes\n\n## Random\n\n## Other\n\n## Last',
  }, {
    renderMarkdown: markdownStub,
  });

  decorateMarkdownArtifactDocument(genericRoot, { documentRef: genericDom.window.document });

  assert.equal(genericRoot.querySelector('.artifact-document').dataset.artifactDocumentHint, 'generic');
  assert.equal(genericRoot.querySelector('[data-artifact-document-kind-badge]').hidden, true);
});

test('buildMarkdownArtifactDocumentSignature is stable for unchanged reader inputs', () => {
  const first = buildMarkdownArtifactDocumentSignature({
    title: 'Plan',
    content: '# Plan',
    mode: 'read',
    editable: true,
    surfaceKey: 'full',
  });
  const same = buildMarkdownArtifactDocumentSignature({
    title: 'Plan',
    content: '# Plan',
    mode: 'read',
    editable: true,
    surfaceKey: 'full',
  });
  const changedMode = buildMarkdownArtifactDocumentSignature({
    title: 'Plan',
    content: '# Plan',
    mode: 'source',
    editable: true,
    surfaceKey: 'full',
  });
  const changedContent = buildMarkdownArtifactDocumentSignature({
    title: 'Plan',
    content: '# Plan\n\n## More',
    mode: 'read',
    editable: true,
    surfaceKey: 'full',
  });
  const changedStatusOnly = buildMarkdownArtifactDocumentSignature({
    title: 'Plan',
    content: '# Plan',
    mode: 'read',
    editable: true,
    surfaceKey: 'full',
    status: 'loading',
    error: 'transient',
  });

  assert.equal(first, same);
  assert.notEqual(first, changedMode);
  assert.notEqual(first, changedContent);
  assert.equal(first, changedStatusOnly);
});

test('buildMarkdownArtifactDocumentSignature uses metadata instead of full content text', () => {
  const first = buildMarkdownArtifactDocumentSignature({
    title: 'Plan',
    content: 'abcd',
    contentRevision: 7,
    artifactId: 'artifact-1',
    mode: 'read',
    editable: true,
    surfaceKey: 'full',
  });
  const sameLengthSameRevision = buildMarkdownArtifactDocumentSignature({
    title: 'Plan',
    content: 'wxyz',
    contentRevision: 7,
    artifactId: 'artifact-1',
    mode: 'read',
    editable: true,
    surfaceKey: 'full',
  });
  const sameLengthNextRevision = buildMarkdownArtifactDocumentSignature({
    title: 'Plan',
    content: 'wxyz',
    contentRevision: 8,
    artifactId: 'artifact-1',
    mode: 'read',
    editable: true,
    surfaceKey: 'full',
  });

  assert.equal(first, sameLengthSameRevision);
  assert.notEqual(first, sameLengthNextRevision);
});

test('artifact document CSS keeps the full-surface reader grid stable', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'artifact-document.css'), 'utf8');

  assert.match(
    css,
    /\.artifact-document\[data-artifact-document-surface="full"\]\s+\.artifact-document-reader-layout\s*\{[^}]*grid-template-columns:\s*minmax\(160px,\s*220px\)\s+minmax\(0,\s*1fr\)/s
  );
  assert.doesNotMatch(
    css,
    /data-artifact-document-has-outline="true"[^{]+\.artifact-document-reader-layout\s*\{[^}]*grid-template-columns/s
  );
});

test('artifact document CSS is registered between studio and HTML preview styles', () => {
  const imports = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const studioIndex = imports.indexOf('@import url("./styles/artifacts-studio.css");');
  const documentIndex = imports.indexOf('@import url("./styles/artifact-document.css");');
  const htmlPreviewIndex = imports.indexOf('@import url("./styles/artifact-html-preview.css");');

  assert.ok(studioIndex >= 0, 'artifacts-studio.css import is missing');
  assert.ok(documentIndex > studioIndex, 'artifact-document.css must follow artifacts-studio.css');
  assert.ok(htmlPreviewIndex > documentIndex, 'artifact-document.css must precede artifact-html-preview.css');
});

test('decorateMarkdownArtifactDocument upgrades portable callouts and code copy buttons', () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const root = dom.window.document.getElementById('root');
  root.innerHTML = buildMarkdownArtifactDocumentHtml({
    title: 'Hardening Review',
    content: '# Hardening Review\n\n> [!CAUTION]\n> Severity: High\n\n```diff\n+ok\n```',
    mode: 'read',
    editable: true,
  }, {
    renderMarkdown: markdownStub,
    escapeHtml: (value) => String(value || '').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });

  decorateMarkdownArtifactDocument(root, { documentRef: dom.window.document });

  const callout = root.querySelector('.artifact-document-callout');
  assert.ok(callout);
  assert.equal(callout.dataset.calloutType, 'caution');
  assert.match(callout.querySelector('.artifact-document-callout-label').textContent, /CAUTION/);
  assert.doesNotMatch(callout.textContent, /\[!CAUTION\]/);
  assert.notEqual(callout.querySelector('p')?.firstElementChild?.tagName, 'BR');

  const copyButton = root.querySelector('[data-artifact-document-copy-code]');
  assert.ok(copyButton);
  assert.equal(copyButton.getAttribute('type'), 'button');
  assert.match(copyButton.getAttribute('aria-label'), /Copy code/);
});

/* ── KaTeX math in .md artifact documents (katex_math) ── */

test('.md artifact document renders KaTeX markup when katex_math is on, raw $ text when off', () => {
  const markdownUtils = require('../renderer/shared/markdown-utils.js');
  const markdownMathUtils = require('../renderer/shared/markdown-math-utils.js');
  const katex = require('katex');
  const previous = markdownMathUtils.isMathRenderingEnabled();
  try {
    const buildDocument = () => buildMarkdownArtifactDocumentHtml({
      title: 'math.md',
      content: 'Pythagoras: $a^2 + b^2 = c^2$\n\n$$c = \\sqrt{a^2 + b^2}$$',
      mode: 'read',
      editable: false,
    }, {
      renderMarkdown: markdownUtils.renderMarkdown,
    });

    // Flag ON: same sequence the artifacts surface controller runs —
    // build → insert → decorate → renderMathInto on the live preview node.
    markdownMathUtils.setMathRenderingEnabled(true);
    markdownUtils.clearMarkdownRenderCache();
    const onDom = new JSDOM(`<div id="preview">${buildDocument()}</div>`);
    const preview = onDom.window.document.getElementById('preview');
    decorateMarkdownArtifactDocument(preview);
    const result = markdownMathUtils.renderMathInto(preview, { katexLib: katex });
    assert.equal(result.rendered, 2, `expected inline + display typeset, got ${JSON.stringify(result)}`);
    assert.ok(preview.querySelector('.markdown-math .katex'), 'inline .katex markup missing');
    assert.ok(preview.querySelector('.markdown-math .katex-display'), 'display .katex-display markup missing');

    // Flag OFF: byte-level parity — raw delimiters survive, no wrappers.
    markdownMathUtils.setMathRenderingEnabled(false);
    markdownUtils.clearMarkdownRenderCache();
    const offHtml = buildDocument();
    assert.ok(offHtml.includes('$a^2 + b^2 = c^2$'), `raw inline math lost: ${offHtml}`);
    assert.ok(offHtml.includes('$$c = \\sqrt{a^2 + b^2}$$'), `raw display math lost: ${offHtml}`);
    assert.ok(!offHtml.includes('markdown-math'), 'flag-off artifact must not emit math wrappers');
  } finally {
    markdownMathUtils.setMathRenderingEnabled(previous);
  }
});
