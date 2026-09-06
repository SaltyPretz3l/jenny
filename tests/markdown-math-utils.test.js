const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const mathUtils = require('../renderer/shared/markdown-math-utils');
const { protectMath, advanceDisplayMathState, restoreMathPlaceholders, renderMathInto } = mathUtils;

function makeStubKatex(calls = []) {
  return {
    renderToString(tex, options) {
      calls.push({ tex, options });
      const mode = options && options.displayMode ? 'display' : 'inline';
      return `<span class="katex katex-stub-${mode}">${tex.replace(/</g, '&lt;')}</span>`;
    },
  };
}

/* ── protectMath: round-trip basics ── */

test('display-math scanner tracks only unescaped delimiters outside inline code', () => {
  assert.equal(advanceDisplayMathState('$$', false), true);
  assert.equal(advanceDisplayMathState('x + y $$', true), false);
  assert.equal(advanceDisplayMathState('`$$`', false), false);
  assert.equal(advanceDisplayMathState('\\$$', false), false);
});

test('protectMath protects a simple inline span and records tex + mode', () => {
  const { text, map } = protectMath('the square $x^2$ grows');
  assert.equal(map.size, 1);
  const [token, entry] = [...map.entries()][0];
  assert.ok(text.includes(token), `token missing from protected text: ${text}`);
  assert.ok(!text.includes('$x^2$'), `raw math survived protection: ${text}`);
  assert.equal(entry.tex, 'x^2');
  assert.equal(entry.displayMode, false);
  assert.equal(entry.raw, '$x^2$');
  assert.equal(text, `the square ${token} grows`);
});

test('protectMath protects a display span (multi-line) as displayMode', () => {
  const { text, map } = protectMath('before\n\n$$\\int_0^1 f\\,dx\n= F$$\n\nafter');
  assert.equal(map.size, 1);
  const entry = [...map.values()][0];
  assert.equal(entry.displayMode, true);
  assert.equal(entry.tex, '\\int_0^1 f\\,dx\n= F');
  assert.ok(!text.includes('$$'), `display delimiters survived: ${text}`);
});

test('protectMath treats $$x$$ as ONE display span, never two inline spans', () => {
  const { map } = protectMath('so $$x$$ holds');
  assert.equal(map.size, 1);
  const entry = [...map.values()][0];
  assert.equal(entry.displayMode, true);
  assert.equal(entry.tex, 'x');
});

test('protectMath distinguishes adjacent inline and display spans', () => {
  const { map } = protectMath('inline $a+b$ then\n\n$$c = d$$');
  assert.equal(map.size, 2);
  const modes = [...map.values()].map((entry) => entry.displayMode).sort();
  assert.deepEqual(modes, [false, true]);
});

/* ── protectMath: the two correctness traps ── */

test('protectMath leaves escaped \\$ completely untouched', () => {
  const source = '\\$5\\$ is just a price';
  const { text, map } = protectMath(source);
  assert.equal(map.size, 0);
  assert.equal(text, source);
});

test('protectMath leaves a bare unmatched $ (a price) untouched', () => {
  const source = 'it costs $5 total';
  const { text, map } = protectMath(source);
  assert.equal(map.size, 0);
  assert.equal(text, source);
});

test('protectMath does not pair two prices across a sentence', () => {
  const source = 'costs $5 and $10 together';
  const { text, map } = protectMath(source);
  assert.equal(map.size, 0);
  assert.equal(text, source);
});

test('protectMath ignores $…$ inside a fenced code block', () => {
  const source = 'text\n\n```js\nconst price = "$x^2$";\n```\n\nmore';
  const { text, map } = protectMath(source);
  assert.equal(map.size, 0);
  assert.equal(text, source);
});

test('protectMath ignores $$…$$ inside an unclosed fence (masks to EOF)', () => {
  const source = 'text\n\n```\n$$a$$\nstill code';
  const { text, map } = protectMath(source);
  assert.equal(map.size, 0);
  assert.equal(text, source);
});

test('protectMath ignores $…$ inside an inline code span', () => {
  const source = 'run `echo $x$ done` now';
  const { text, map } = protectMath(source);
  assert.equal(map.size, 0);
  assert.equal(text, source);
});

test('protectMath still protects math OUTSIDE code while skipping math inside it', () => {
  const source = 'real $y^2$ but `fake $x$` stays';
  const { text, map } = protectMath(source);
  assert.equal(map.size, 1);
  assert.equal([...map.values()][0].tex, 'y^2');
  assert.ok(text.includes('`fake $x$`'), `code span was altered: ${text}`);
});

test('protectMath requires delimiters hugging content ($ x$ / $x $ are not math)', () => {
  assert.equal(protectMath('a $ x$ b').map.size, 0);
  assert.equal(protectMath('a $x $ b').map.size, 0);
});

test('protectMath allows an escaped \\$ inside a math body', () => {
  const { map } = protectMath('cost fn $c = \\$5k$ here');
  assert.equal(map.size, 1);
  assert.equal([...map.values()][0].tex, 'c = \\$5k');
});

test('protectMath does not let inline math span a newline', () => {
  const source = 'a $x\ny$ b';
  const { map } = protectMath(source);
  assert.equal(map.size, 0);
});

test('protectMath handles null/empty input without throwing', () => {
  assert.equal(protectMath(null).text, '');
  assert.equal(protectMath('').map.size, 0);
});

/* ── restoreMathPlaceholders ── */

test('restore turns a token in a text node into a self-describing wrapper with raw fallback text', () => {
  const { text, map } = protectMath('so $x^2$ holds');
  const html = `<p>${text}</p>`;
  const restored = restoreMathPlaceholders(html, map);
  assert.ok(restored.includes('class="markdown-math"'), restored);
  assert.ok(restored.includes('data-math-tex="x^2"'), restored);
  assert.ok(restored.includes('data-math-display="false"'), restored);
  assert.ok(restored.includes('$x^2$'), `raw fallback text missing: ${restored}`);
  const token = [...map.keys()][0];
  assert.ok(!restored.includes(token), `token leaked into restored HTML: ${restored}`);
});

test('restore escapes tex payloads safely into attributes', () => {
  const { text, map } = protectMath('edge $a<b & "c"$ case');
  const restored = restoreMathPlaceholders(`<p>${text}</p>`, map);
  // Round-trip through a fresh parse: the tex payload must survive intact as
  // an attribute (no element named <b> may materialize from it).
  const dom = new JSDOM(restored);
  const wrapper = dom.window.document.querySelector('.markdown-math');
  assert.ok(wrapper, 'wrapper span missing');
  assert.equal(wrapper.getAttribute('data-math-tex'), 'a<b & "c"');
  assert.equal(dom.window.document.querySelector('b'), null, `tex leaked as markup: ${restored}`);
  assert.ok(wrapper.textContent.includes('a<b & "c"'), wrapper.textContent);
});

test('restore de-protects a token that leaked into an attribute value back to raw source', () => {
  const { text, map } = protectMath('link [here](http://e.com/$x^2$) end');
  // marked would place the token inside href; simulate that shape directly.
  const token = [...map.keys()][0];
  assert.ok(text.includes(token));
  const html = `<p><a href="http://e.com/${token}">here</a> end</p>`;
  const restored = restoreMathPlaceholders(html, map);
  assert.ok(restored.includes('href="http://e.com/$x^2$"'), `attribute not de-protected: ${restored}`);
  assert.ok(!restored.includes(token), `token left in attribute: ${restored}`);
});

test('restore leaves HTML without tokens byte-identical', () => {
  const html = '<p>no math here</p>';
  assert.equal(restoreMathPlaceholders(html, new Map()), html);
});

test('a forged literal token cannot mint a math wrapper (per-render nonce)', () => {
  // An attacker can compute the djb2 hash of a real sibling span, but never
  // the per-render nonce — so a token spelled out in the message body must
  // stay inert visible text while the real span still restores.
  const djb2Hex = (value) => {
    let hash = 5381;
    for (let i = 0; i < value.length; i += 1) {
      hash = (((hash << 5) + hash) + value.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
  };
  const forged = `MJNYMATH0K${djb2Hex('$y$')}N00000000Z`;
  const { text, map } = protectMath(`${forged} then $y$`);
  assert.equal(map.size, 1);
  const realToken = [...map.keys()][0];
  assert.notEqual(realToken, forged);
  const restored = restoreMathPlaceholders(`<p>${text}</p>`, map);
  const dom = new JSDOM(`<body>${restored}</body>`);
  const wrappers = dom.window.document.querySelectorAll('.markdown-math');
  assert.equal(wrappers.length, 1, `forged token minted a wrapper: ${restored}`);
  assert.ok(restored.includes(forged), `forged token should stay visible text: ${restored}`);
});

/* ── renderMathInto (live DOM, stub katex) ── */

function domWithRestoredMath(source) {
  const { text, map } = protectMath(source);
  const restored = restoreMathPlaceholders(`<div id="root"><p>${text}</p></div>`, map);
  const dom = new JSDOM(`<body>${restored}</body>`);
  return { dom, root: dom.window.document.getElementById('root') };
}

test('renderMathInto replaces wrapper content via katexLib and reports counts', () => {
  const calls = [];
  const { root } = domWithRestoredMath('inline $a+b$ and $$c$$');
  const result = renderMathInto(root, { katexLib: makeStubKatex(calls) });
  assert.equal(result.rendered, 2);
  assert.equal(result.errored, 0);
  assert.equal(calls.length, 2);
  const byMode = Object.fromEntries(calls.map((c) => [c.options.displayMode ? 'display' : 'inline', c.tex]));
  assert.equal(byMode.inline, 'a+b');
  assert.equal(byMode.display, 'c');
  for (const call of calls) {
    assert.equal(call.options.throwOnError, false);
  }
  assert.equal(root.querySelectorAll('.markdown-math[data-math-rendered="true"]').length, 2);
  assert.ok(root.innerHTML.includes('katex-stub-inline'), root.innerHTML);
  assert.ok(root.innerHTML.includes('katex-stub-display'), root.innerHTML);
});

test('renderMathInto is idempotent (rendered wrappers are not re-typeset)', () => {
  const calls = [];
  const stub = makeStubKatex(calls);
  const { root } = domWithRestoredMath('just $x$');
  renderMathInto(root, { katexLib: stub });
  renderMathInto(root, { katexLib: stub });
  assert.equal(calls.length, 1);
});

test('renderMathInto never throws when katexLib.renderToString throws; marks the wrapper errored', () => {
  const throwingKatex = {
    renderToString() {
      throw new Error('\\frac{1}{ unbalanced');
    },
  };
  const { root } = domWithRestoredMath('bad $\\frac{1}{$x');
  assert.equal(root.querySelectorAll('.markdown-math').length, 1);
  let result;
  assert.doesNotThrow(() => {
    result = renderMathInto(root, { katexLib: throwingKatex });
  });
  assert.equal(result.rendered, 0);
  assert.equal(result.errored, 1);
  const wrapper = root.querySelector('.markdown-math');
  assert.equal(wrapper.getAttribute('data-math-rendered'), 'error');
  // Degrade path: the original literal source stays visible.
  assert.ok(wrapper.textContent.includes('$'), wrapper.textContent);
  // Poisonous input is not retried.
  const calls = [];
  renderMathInto(root, { katexLib: makeStubKatex(calls) });
  assert.equal(calls.length, 0);
});

test('renderMathInto assigns NO markup to the wrapper when the render throws', () => {
  // Intent: this fails if the error path is ever changed to assign the raw
  // source (or any other string) to wrapper.innerHTML. The tex payload here
  // carries HTML-ish characters, so an innerHTML assignment would materialize
  // a real element inside the wrapper instead of leaving inert text.
  const throwingKatex = {
    renderToString() {
      throw new Error('katex exploded');
    },
  };
  const { root } = domWithRestoredMath('bad $a<b \\wedge <img src=x onerror=x>$ tail');
  const wrapper = root.querySelector('.markdown-math');
  assert.ok(wrapper, 'wrapper span missing');
  assert.ok(wrapper.getAttribute('data-math-tex').includes('<'), wrapper.getAttribute('data-math-tex'));

  const result = renderMathInto(root, { katexLib: throwingKatex });
  assert.equal(result.rendered, 0);
  assert.equal(result.errored, 1);

  // No element was ever created inside the wrapper.
  assert.equal(wrapper.children.length, 0, `markup assigned on error: ${wrapper.innerHTML}`);
  assert.equal(wrapper.querySelector('*'), null, `markup assigned on error: ${wrapper.innerHTML}`);
  // A text node's '<' serializes as '&lt;', so a literal '<' in innerHTML means
  // real markup got assigned.
  assert.ok(!/</.test(wrapper.innerHTML), `raw '<' in innerHTML means markup: ${wrapper.innerHTML}`);
  // The raw source is still visible as text.
  assert.ok(wrapper.textContent.includes('$a<b'), wrapper.textContent);
  assert.ok(wrapper.textContent.includes('<img src=x onerror=x>$'), wrapper.textContent);
});

test('renderMathInto passes katex EXACTLY {throwOnError, displayMode} — no trust, no extras', () => {
  // Intent: the tex payload is author-controlled, so KaTeX's `trust` option
  // must stay at its default (off) — with trust on, tex could inject \href and
  // other markup straight into the DOM. Adding ANY key to this options object
  // must be a deliberate act that updates this test after a security review of
  // why the new key is safe.
  const calls = [];
  const { root } = domWithRestoredMath('just $x^2$');
  const result = renderMathInto(root, { katexLib: makeStubKatex(calls) });
  assert.equal(result.rendered, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].options).sort(), ['displayMode', 'throwOnError']);
  assert.equal(calls[0].options.throwOnError, false);
  assert.equal(calls[0].options.trust, undefined);
});

test('renderMathInto degrades when katexLib is missing: raw text stays, wrapper left retryable', () => {
  const { root } = domWithRestoredMath('keep $x^2$ visible');
  const result = renderMathInto(root, { katexLib: null });
  assert.equal(result.rendered, 0);
  assert.equal(result.errored, 1);
  const wrapper = root.querySelector('.markdown-math');
  assert.equal(wrapper.getAttribute('data-math-rendered'), null);
  assert.equal(wrapper.textContent, '$x^2$');
  // A later pass with a working katex picks it up.
  const calls = [];
  const retry = renderMathInto(root, { katexLib: makeStubKatex(calls) });
  assert.equal(retry.rendered, 1);
  assert.equal(calls.length, 1);
});

test('renderMathInto retries unrendered wrappers once the lazy KaTeX runtime is ready', async (t) => {
  const prevKatex = global.katex;
  const prevRuntimeLoader = global.rendererKatexRuntimeLoader;
  const calls = [];
  let ensureRuntimeCalls = 0;
  delete global.katex;
  global.rendererKatexRuntimeLoader = {
    ensureKatexRuntime() {
      ensureRuntimeCalls += 1;
      global.katex = makeStubKatex(calls);
      return Promise.resolve(true);
    },
  };
  t.after(() => {
    global.katex = prevKatex;
    global.rendererKatexRuntimeLoader = prevRuntimeLoader;
  });

  const { root } = domWithRestoredMath('lazy $x^2$ math');
  const initial = renderMathInto(root, { katexLib: null });
  assert.deepEqual(initial, { rendered: 0, errored: 1 });

  await new Promise((resolve) => setImmediate(resolve));

  const wrapper = root.querySelector('.markdown-math');
  assert.equal(ensureRuntimeCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(wrapper.getAttribute('data-math-rendered'), 'true');
  assert.ok(wrapper.querySelector('.katex'), wrapper.innerHTML);
});

test('renderMathInto bounds the lazy-runtime retry when readiness does not expose KaTeX', async (t) => {
  const prevKatex = global.katex;
  const prevRuntimeLoader = global.rendererKatexRuntimeLoader;
  let ensureRuntimeCalls = 0;
  delete global.katex;
  global.rendererKatexRuntimeLoader = {
    ensureKatexRuntime() {
      ensureRuntimeCalls += 1;
      return ensureRuntimeCalls === 1
        ? Promise.resolve(true)
        : new Promise(() => {});
    },
  };
  t.after(() => {
    global.katex = prevKatex;
    global.rendererKatexRuntimeLoader = prevRuntimeLoader;
  });

  const { root } = domWithRestoredMath('still raw $x$');
  const originalQuerySelectorAll = root.querySelectorAll.bind(root);
  let passCount = 0;
  root.querySelectorAll = function countRenderPasses(selector) {
    passCount += 1;
    return originalQuerySelectorAll(selector);
  };

  renderMathInto(root, { katexLib: null });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(passCount, 2, 'one originating pass should schedule at most one retry pass');
  assert.equal(ensureRuntimeCalls, 1, 'the retry pass must not request the runtime again');
  assert.equal(root.querySelector('.markdown-math').getAttribute('data-math-rendered'), null);
});

test('renderMathInto with injected KaTeX keeps existing behavior and never consults the loader', (t) => {
  const prevRuntimeLoader = global.rendererKatexRuntimeLoader;
  let ensureRuntimeCalls = 0;
  global.rendererKatexRuntimeLoader = {
    ensureKatexRuntime() {
      ensureRuntimeCalls += 1;
      return Promise.resolve(true);
    },
  };
  t.after(() => {
    global.rendererKatexRuntimeLoader = prevRuntimeLoader;
  });

  const calls = [];
  const { root } = domWithRestoredMath('already $x+y$ available');
  const result = renderMathInto(root, { katexLib: makeStubKatex(calls) });

  assert.deepEqual(result, { rendered: 1, errored: 0 });
  assert.equal(calls.length, 1);
  assert.equal(ensureRuntimeCalls, 0);
  assert.equal(root.querySelector('.markdown-math').getAttribute('data-math-rendered'), 'true');
});

test('renderMathInto skips wrappers inside a reasoning panel (plain-surface opt-out)', () => {
  const { text, map } = protectMath('reasoned $x$');
  const restored = restoreMathPlaceholders(`<div class="reasoning-row-panel"><p>${text}</p></div>`, map);
  const dom = new JSDOM(`<body><div id="root">${restored}</div></body>`);
  const root = dom.window.document.getElementById('root');
  const calls = [];
  const result = renderMathInto(root, { katexLib: makeStubKatex(calls) });
  assert.equal(result.rendered, 0);
  assert.equal(calls.length, 0);
});

test('renderMathInto tolerates a null/duck-typed root', () => {
  assert.deepEqual(renderMathInto(null), { rendered: 0, errored: 0 });
  assert.deepEqual(renderMathInto({}), { rendered: 0, errored: 0 });
});

/* ── real KaTeX integration (the dependency is direct now) ── */

test('renderMathInto with the real katex library produces .katex markup', () => {
  const katex = require('katex');
  const { root } = domWithRestoredMath('real $x^2$ math');
  const result = renderMathInto(root, { katexLib: katex });
  assert.equal(result.rendered, 1);
  assert.ok(root.querySelector('.markdown-math .katex'), root.innerHTML);
});

test('real katex display markup carries .katex-display inside the wrapper; inline does not', () => {
  const katex = require('katex');
  const { root } = domWithRestoredMath('inline $a$ and $$b$$');
  renderMathInto(root, { katexLib: katex });
  const wrappers = [...root.querySelectorAll('.markdown-math')];
  assert.equal(wrappers.length, 2);
  const inline = wrappers.find((w) => w.getAttribute('data-math-display') === 'false');
  const display = wrappers.find((w) => w.getAttribute('data-math-display') === 'true');
  assert.ok(inline.querySelector('.katex'), 'inline .katex missing');
  assert.equal(inline.querySelector('.katex-display'), null, 'inline must not carry .katex-display');
  assert.ok(display.querySelector('.katex-display'), 'display .katex-display missing');
});

test('real katex with throwOnError:false renders bad LaTeX as its own error markup, no throw', () => {
  const katex = require('katex');
  const { root } = domWithRestoredMath('bad $\\frac{1}{$ tail');
  assert.equal(root.querySelectorAll('.markdown-math').length, 1);
  let result;
  assert.doesNotThrow(() => {
    result = renderMathInto(root, { katexLib: katex });
  });
  // katex may either render error markup (rendered) or throw a ParseError that
  // renderMathInto absorbs (errored) — either way, never an uncaught exception
  // and never an empty pane.
  assert.equal(result.rendered + result.errored, 1);
  const wrapper = root.querySelector('.markdown-math');
  assert.ok(wrapper.textContent.length > 0, 'wrapper went blank');
});

/* ── enable toggle ── */

test('setMathRenderingEnabled toggles and coerces to strict boolean', () => {
  const { setMathRenderingEnabled, isMathRenderingEnabled } = mathUtils;
  assert.equal(isMathRenderingEnabled(), false);
  setMathRenderingEnabled(true);
  assert.equal(isMathRenderingEnabled(), true);
  setMathRenderingEnabled('yes');
  assert.equal(isMathRenderingEnabled(), false);
  setMathRenderingEnabled(true);
  setMathRenderingEnabled(false);
  assert.equal(isMathRenderingEnabled(), false);
});
