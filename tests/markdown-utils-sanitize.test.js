const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

/* Ht-B Step B1 — sanitization guards.
 * A single jsdom window backs the whole file: markdown-utils resolves
 * marked/DOMPurify once (module-level ensureConfigured), matching how the
 * renderer loads it. */
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
const createDOMPurify = require('dompurify');
dom.window.DOMPurify = createDOMPurify(dom.window);

const markdownUtils = require('../renderer/shared/markdown-utils');
const sanitizeUtils = require('../renderer/features/renderer-mermaid-sanitize-utils');

test('frontmatter metadata mode strips only empty or mapping YAML and preserves horizontal-rule content', () => {
  const renderMetadata = (source) => markdownUtils.renderMarkdown(source, { frontmatter: 'metadata' });

  const valid = renderMetadata('\uFEFF---\r\ntitle: Hidden\r\nlabels:\r\n  - preview\r\n---\r\n# Visible');
  assert.match(valid, /Visible/);
  assert.doesNotMatch(valid, /Hidden|preview/);

  const empty = renderMetadata('---\n---\n# Empty body');
  assert.match(empty, /Empty body/);
  assert.equal((empty.match(/<hr>/g) || []).length, 0);

  const malformed = renderMetadata('---\ntitle: [broken\n---\n# Malformed body');
  assert.match(malformed, /title: \[broken/);
  assert.match(malformed, /Malformed body/);

  const unclosed = renderMetadata('---\ntitle: Unclosed\n# Body');
  assert.match(unclosed, /Unclosed/);

  const list = renderMetadata('---\n- ordinary\n- list\n---\n# Body');
  assert.match(list, /ordinary/);
  assert.equal((list.match(/<hr>/g) || []).length, 2, 'list YAML is content, not metadata');

  const rule = renderMetadata('Before\n\n---\n\nAfter');
  assert.equal((rule.match(/<hr>/g) || []).length, 1, 'ordinary horizontal rules survive');
});

test('frontmatter metadata mode keeps the existing sanitizer active for body and preserved malformed content', () => {
  const valid = markdownUtils.renderMarkdown(
    '---\ntitle: Hidden\n---\n# Body\n<script>alert(1)</script>\n<img src="file:///secret.png" onerror="alert(2)">\n<a href="javascript:alert(3)">bad</a>',
    { frontmatter: 'metadata' },
  );
  assert.doesNotMatch(valid, /Hidden|<script|onerror|file:|javascript:/i);
  assert.match(valid, /Body/);

  const malformed = markdownUtils.renderMarkdown(
    '---\ntitle: [broken\n---\n<script>alert(1)</script>\n# Preserved',
    { frontmatter: 'metadata' },
  );
  assert.match(malformed, /title: \[broken/);
  assert.doesNotMatch(malformed, /<script/i);
  assert.match(malformed, /Preserved/);
});

test('frontmatter metadata mode is isolated from default Markdown cache entries', () => {
  markdownUtils.clearMarkdownRenderCache();
  const source = '---\ntitle: Default content\n---\n# Body';

  const ordinary = markdownUtils.renderMarkdown(source);
  const metadata = markdownUtils.renderMarkdown(source, { frontmatter: 'metadata' });
  const ordinaryAgain = markdownUtils.renderMarkdown(source);

  assert.match(ordinary, /Default content/);
  assert.doesNotMatch(metadata, /Default content/);
  assert.equal(ordinaryAgain, ordinary, 'default render remains a cache hit with its original output');
});

test('renderMarkdown forces rel="noopener noreferrer" on links that carry target', () => {
  const html = markdownUtils.renderMarkdown('<a href="https://example.com" target="_blank">out</a>');
  const parsed = new JSDOM(html).window.document;
  const link = parsed.querySelector('a[target]');
  assert.ok(link, 'the target link should survive sanitization');
  assert.equal(
    link.getAttribute('rel'),
    'noopener noreferrer',
    'a targeted link must be reverse-tabnabbing safe'
  );
});

test('renderMarkdown leaves rel untouched on links without target', () => {
  const html = markdownUtils.renderMarkdown('[plain](https://example.com)');
  const parsed = new JSDOM(html).window.document;
  const link = parsed.querySelector('a');
  assert.ok(link);
  assert.equal(link.getAttribute('rel'), null, 'no rel is forced when no target is set');
});

test('renderMarkdown keeps dropping javascript: and data:text/html hrefs (regression pin)', () => {
  /* The pin is on the parsed DOM, not on the output string. Since the raw-HTML
   * policy (markdown-raw-html-policy.js) escapes a whole block that carries a
   * raw-text tag instead of handing it to DOMPurify, a hostile URL can survive
   * as inert *text* — which is safe, but no longer absent from the markup. What
   * must never survive is a navigable attribute. */
  const hostileUrls = (html) => [...new JSDOM(html).window.document.querySelectorAll('[href], [src]')]
    .map((node) => node.getAttribute('href') || node.getAttribute('src') || '')
    .filter((value) => /^\s*(?:javascript:|data:text\/html)/i.test(value));

  // No raw-text tag: DOMPurify keeps the anchor and drops the href outright.
  const jsHref = markdownUtils.renderMarkdown('<a href="javascript:alert(1)">x</a>');
  assert.doesNotMatch(jsHref, /javascript:/i);
  assert.doesNotMatch(jsHref, /href=/i);
  assert.deepEqual(hostileUrls(jsHref), []);

  // The <script> forces the escape path: the block becomes text, so no anchor
  // and no script element exist at all and the URL is never navigable.
  const dataHref = markdownUtils.renderMarkdown('<a href="data:text/html,<script>1</script>">x</a>');
  assert.deepEqual(hostileUrls(dataHref), []);
  const parsedDataHref = new JSDOM(dataHref).window.document;
  assert.equal(parsedDataHref.querySelector('a'), null, 'the escaped block must not yield an anchor');
  assert.equal(parsedDataHref.querySelector('script'), null, 'the escaped block must not yield a script');
});

test('renderMarkdown drops file: image sources under the live sanitizer config', () => {
  const html = markdownUtils.renderMarkdown('<img src="file:///C:/Users/example/secret.png" alt="local">');
  assert.doesNotMatch(html, /file:/i);
  const parsed = new JSDOM(html).window.document;
  const image = parsed.querySelector('img');
  assert.ok(image, 'inert image markup may remain');
  assert.equal(image.getAttribute('src'), null, 'local file URLs must never reach the renderer');
});

test('renderMarkdown strips application CSS gadget classes from untrusted HTML', () => {
  const html = markdownUtils.renderMarkdown(
    '<div class="mermaid-fullscreen-overlay chat-entry"><span class="markdown-code-block">Trap</span></div>'
  );
  assert.doesNotMatch(html, /mermaid-fullscreen-overlay|chat-entry|markdown-code-block/);
  assert.match(html, /Trap/);
});

test('renderMarkdown preserves only narrow Marked class contracts', () => {
  const html = markdownUtils.renderMarkdown('```brainfuck\n+++\n```\n\n- [x] done');
  assert.match(html, /class="language-brainfuck"/);
  assert.match(html, /contains-task-list/);
  assert.match(html, /task-list-item/);
  assert.doesNotMatch(html, /class="[^"]*(?:chat-|mermaid-fullscreen)/);
});

test('renderMarkdown preserves inert GFM task checkboxes and rejects arbitrary inputs', () => {
  const html = markdownUtils.renderMarkdown('- [x] done\n- [ ] todo\n\n<input type="text" value="unsafe">');
  const parsed = new JSDOM(html).window.document;
  const checkboxes = [...parsed.querySelectorAll('input[type="checkbox"]')];
  assert.equal(checkboxes.length, 2);
  assert.equal(checkboxes.every((input) => input.disabled), true);
  assert.equal(checkboxes[0].checked, true);
  assert.equal(checkboxes[1].checked, false);
  assert.equal(parsed.querySelector('input[type="text"]'), null);
});

test('renderMarkdown preserves bounded ordered-list starts and table alignment', () => {
  const listHtml = markdownUtils.renderMarkdown('3. third\n4. fourth');
  assert.match(listHtml, /<ol start="3">/);

  const tableHtml = markdownUtils.renderMarkdown('| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |');
  const parsed = new JSDOM(tableHtml).window.document;
  const headings = [...parsed.querySelectorAll('th')];
  assert.deepEqual(headings.map((cell) => cell.getAttribute('align')), ['left', 'center', 'right']);
});

test('renderMarkdown allows inert mark and kbd prose but keeps details unsupported', () => {
  const html = markdownUtils.renderMarkdown('<mark>highlight</mark> <kbd>Ctrl</kbd><details><summary>x</summary>hidden</details>');
  assert.match(html, /<mark>highlight<\/mark>/);
  assert.match(html, /<kbd>Ctrl<\/kbd>/);
  assert.doesNotMatch(html, /<details|<summary/);
});

test('renderMarkdown adds bounded lazy image hints after sanitization', () => {
  const html = markdownUtils.renderMarkdown('![diagram](data:image/png;base64,AA==)');
  const image = new JSDOM(html).window.document.querySelector('img');
  assert.ok(image);
  assert.equal(image.getAttribute('loading'), 'lazy');
  assert.equal(image.getAttribute('decoding'), 'async');
});

test('sanitizeMermaidSvgMarkup neutralizes active content smuggled through foreignObject', () => {
  const cases = [
    {
      name: 'inline script',
      svg: '<svg><foreignObject><script>window.x=1</script></foreignObject></svg>',
      forbidden: [/<script/i, /window\.x/],
    },
    {
      name: 'event handler attribute',
      svg: '<svg><foreignObject><div onpointerenter="window.x=1">Label</div></foreignObject></svg>',
      forbidden: [/onpointerenter/i, /window\.x/],
    },
    {
      name: 'iframe',
      svg: '<svg><foreignObject><iframe src="https://evil.example"></iframe></foreignObject></svg>',
      forbidden: [/<iframe/i, /evil\.example/],
    },
    {
      name: 'form + text control',
      svg: '<svg><foreignObject><form action="https://evil.example"><textarea>q</textarea></form></foreignObject></svg>',
      forbidden: [/<form/i, /<textarea/i],
    },
    {
      name: 'style element',
      svg: '<svg><foreignObject><style>svg{display:none}</style></foreignObject></svg>',
      forbidden: [/<style/i],
    },
  ];
  for (const item of cases) {
    const sanitized = sanitizeUtils.sanitizeMermaidSvgMarkup(item.svg, dom.window);
    assert.match(sanitized, /<foreignObject/i, `${item.name}: the foreignObject wrapper itself stays`);
    for (const forbidden of item.forbidden) {
      assert.doesNotMatch(sanitized, forbidden, `${item.name}: sanitized output must not contain ${forbidden}`);
    }
  }
});

test('sanitizeMermaidSvgMarkup keeps legitimate mermaid label text inside foreignObject', () => {
  const sanitized = sanitizeUtils.sanitizeMermaidSvgMarkup(
    '<svg><g class="node"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">Deploy step</span></div></foreignObject></g></svg>',
    dom.window
  );
  assert.match(sanitized, /Deploy step/, 'label text must survive');
  assert.doesNotMatch(sanitized, /<script/i);
});

test('sanitizeMermaidSvgMarkup drops javascript: hrefs on svg anchors (regression pin)', () => {
  const sanitized = sanitizeUtils.sanitizeMermaidSvgMarkup(
    '<svg><a href="javascript:alert(1)" xlink:href="javascript:alert(1)"><text>click</text></a></svg>',
    dom.window
  );
  assert.doesNotMatch(sanitized, /javascript:/i);
});
