const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

const policy = require('../renderer/shared/markdown-sanitize-policy');
const { sanitizeMermaidSvgMarkup } = require('../renderer/features/renderer-mermaid-sanitize-utils');

/* markdown-utils installs policy.hardenAttributes as an afterSanitizeAttributes
 * hook on the page's SHARED DOMPurify instance, so the hook also runs when
 * renderer-mermaid-sanitize-utils sanitizes a rendered Mermaid SVG. Mermaid's
 * palette bake-in (normalizeMermaidLabelContainers) selects nodes by class;
 * stripping those classes left every node the SVG default fill (black) in
 * every palette (2026-09-07). */
function windowWithPolicyHook() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const windowRef = dom.window;
  windowRef.DOMPurify = createDOMPurify(windowRef);
  windowRef.DOMPurify.addHook('afterSanitizeAttributes', policy.hardenAttributes);
  return windowRef;
}

const MERMAID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" id="d1">'
  + '<g class="node default" id="flowchart-A-0" data-look="classic">'
  + '<rect class="basic label-container" x="1" y="1" width="10" height="10"></rect>'
  + '<g class="label"><foreignObject width="10" height="10"><div><span class="nodeLabel"><p>A</p></span></div></foreignObject></g>'
  + '</g></svg>';

test('the markdown policy hook leaves Mermaid SVG classes intact', () => {
  const windowRef = windowWithPolicyHook();
  const cleaned = sanitizeMermaidSvgMarkup(MERMAID_SVG, windowRef);
  assert.match(cleaned, /<g class="node default"/);
  assert.match(cleaned, /<rect class="basic label-container"/);
  assert.match(cleaned, /<g class="label">/);
  assert.doesNotMatch(cleaned, /<span/, 'HTML inside foreignObject is still reduced to text');
});

test('the markdown policy hook still strips arbitrary classes from HTML', () => {
  const windowRef = windowWithPolicyHook();
  const cleaned = windowRef.DOMPurify.sanitize(
    '<p class="evil"><code class="language-js x">a</code><span class="also-evil">b</span></p>',
    policy.config
  );
  assert.equal(cleaned, '<p><code class="language-js">a</code><span>b</span></p>');
});
