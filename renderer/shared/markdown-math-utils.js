/**
 * renderer/shared/markdown-math-utils.js – KaTeX math protect-then-render pipeline.
 *
 * Chat markdown and .md artifact documents route through markdown-utils'
 * renderSanitizedMarkdown, whose DOMPurify SANITIZE_CONFIG would strip KaTeX
 * markup. The contract here mirrors the inline-Mermaid precedent:
 *
 *   1. protectMath(text) runs BEFORE marked.parse — every $…$ / $$…$$ span
 *      outside code fences / inline code becomes an inert alphanumeric
 *      placeholder token, so marked's emphasis/code/link tokenizers never see
 *      raw LaTeX.
 *   2. restoreMathPlaceholders(html, map) runs AFTER sanitize +
 *      decorateCodeBlocks — placeholder tokens in text nodes become
 *      self-describing <span class="markdown-math" data-math-tex …> wrappers
 *      whose text content is the original raw source (so an unrendered
 *      placeholder degrades to exactly today's literal $…$ text). Tokens that
 *      leaked into attribute values (e.g. math inside a link target) are
 *      restored to raw source instead of markup.
 *   3. renderMathInto(rootEl) runs against the LIVE DOM at the same consumer
 *      seams as renderInlineMermaidBlocks — it typesets each unrendered
 *      wrapper via katex.renderToString({ throwOnError: false }). DOMPurify
 *      never sees KaTeX output, and SANITIZE_CONFIG stays untouched.
 *
 * The wrappers carry their own tex source, so markdown-utils' render cache
 * (B3) can safely memoize math-bearing HTML: a cache hit still restores.
 *
 * In Electron renderer: loaded via <script defer> after the KaTeX runtime loader.
 * In Node.js tests: plain require, katexLib injectable.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.markdownMathUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Feature-state sync updates this toggle; it starts false until the first state payload so unsynchronized surfaces retain raw math text.
  let _mathRenderingEnabled = false;

  function setMathRenderingEnabled(enabled) {
    _mathRenderingEnabled = enabled === true;
  }

  function isMathRenderingEnabled() {
    return _mathRenderingEnabled === true;
  }

  /* ── placeholder tokens ─────────────────────────────────────────────── */

  // Pure-alphanumeric tokens survive marked's tokenizers (no punctuation to
  // trigger emphasis/code/link parsing) and DOMPurify (plain text). The djb2
  // fingerprint of the raw source keeps a token from colliding with
  // user-typed lookalikes; the per-render nonce makes a token unforgeable —
  // input that spells out a literal token can never precompute the nonce, so
  // restore leaves it as inert visible text (map lookup misses).
  const TOKEN_RE = /MJNYMATH\d+K[0-9a-f]{1,8}N[0-9a-f]{8}Z/g;

  function djb2Hex(value) {
    const source = String(value || '');
    let hash = 5381;
    for (let index = 0; index < source.length; index += 1) {
      hash = ((hash << 5) + hash) + source.charCodeAt(index);
      hash >>>= 0;
    }
    return hash.toString(16);
  }

  // 8 hex chars, fresh per protectMath call. Not cryptographically critical
  // (the value is never observable by the message author), but prefer
  // webcrypto when present.
  function randomNonceHex() {
    try {
      if (typeof globalThis !== 'undefined' && globalThis.crypto
          && typeof globalThis.crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(4);
        globalThis.crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (_err) { /* fall through to Math.random */ }
    return Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  }

  function buildToken(index, raw, nonce) {
    return 'MJNYMATH' + index + 'K' + djb2Hex(raw) + 'N' + nonce + 'Z';
  }

  /* ── code-region masking (raw markdown source) ──────────────────────── */

  const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
  const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

  // Ranges of the raw source that belong to fenced code blocks. Indented
  // code blocks are disabled in this repo's marked config, so only fences
  // count. An unclosed fence masks to end-of-text (marked treats it as code
  // to EOF too).
  function computeFenceRanges(text) {
    const ranges = [];
    let fenceChar = null;
    let fenceLen = 0;
    let fenceStart = 0;
    let offset = 0;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineStart = offset;
      offset += line.length + 1;
      if (fenceChar) {
        const close = FENCE_CLOSE_RE.exec(line);
        if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
          ranges.push([fenceStart, Math.min(offset, text.length)]);
          fenceChar = null;
        }
        continue;
      }
      const open = FENCE_OPEN_RE.exec(line);
      if (open) {
        const info = line.slice(open[0].length);
        // CommonMark: a backtick fence's info string may not contain backticks.
        if (open[1][0] === '~' || info.indexOf('`') < 0) {
          fenceChar = open[1][0];
          fenceLen = open[1].length;
          fenceStart = lineStart;
        }
      }
    }
    if (fenceChar) {
      ranges.push([fenceStart, text.length]);
    }
    return ranges;
  }

  function positionInRanges(ranges, position) {
    for (let i = 0; i < ranges.length; i += 1) {
      if (position >= ranges[i][0] && position < ranges[i][1]) {
        return true;
      }
    }
    return false;
  }

  function spanOverlapsRanges(ranges, start, end) {
    for (let i = 0; i < ranges.length; i += 1) {
      if (start < ranges[i][1] && end > ranges[i][0]) {
        return true;
      }
    }
    return false;
  }

  // Inline code spans per CommonMark: a run of N backticks opens, the next
  // run of exactly N backticks closes. Runs inside fence ranges are ignored.
  function computeInlineCodeRanges(text, fenceRanges) {
    const runs = [];
    const runRe = /`+/g;
    let match;
    while ((match = runRe.exec(text)) !== null) {
      if (!positionInRanges(fenceRanges, match.index)) {
        runs.push([match.index, match.index + match[0].length]);
      }
    }
    const ranges = [];
    let i = 0;
    while (i < runs.length) {
      const openLen = runs[i][1] - runs[i][0];
      let j = i + 1;
      while (j < runs.length && (runs[j][1] - runs[j][0]) !== openLen) {
        j += 1;
      }
      if (j < runs.length) {
        ranges.push([runs[i][0], runs[j][1]]);
        i = j + 1;
      } else {
        i += 1;
      }
    }
    return ranges;
  }

  /* ── math delimiter scan ────────────────────────────────────────────── */

  // Display math: $$…$$, may span lines, non-empty body; neither delimiter
  // may be escaped with a backslash.
  const DISPLAY_MATH_RE = /(?<!\\)\$\$(?!\$)([\s\S]+?)(?<!\\)\$\$/g;

  // Inline math: $…$ on one line. Opening $ must not be escaped, doubled, or
  // followed by whitespace; the body allows escaped characters but no bare $
  // or newline; the closing $ must follow a non-space, non-backslash char and
  // must not be followed by a digit (so "costs $5 and $10" never matches) or
  // another $. Consequence (by design): adjacent inline spans with no
  // separating whitespace ("$a$$b$") are ambiguous with display math and
  // degrade to raw text — do not loosen this without re-checking the
  // currency guard.
  const INLINE_MATH_RE = /(?<![\\$])\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?![0-9$])/g;

  // Conservative line scanner for the streaming stable-prefix guard. It is
  // deliberately narrower than protectMath: only display delimiters can
  // cross a blank-line block boundary, and backtick spans stay inert.
  function advanceDisplayMathState(line, initialOpen) {
    const source = String(line || '');
    let open = initialOpen === true;
    let inlineTicks = 0;
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === '`') {
        let end = index + 1;
        while (source[end] === '`') end += 1;
        const length = end - index;
        inlineTicks = inlineTicks === length ? 0 : (inlineTicks === 0 ? length : inlineTicks);
        index = end - 1;
        continue;
      }
      if (!inlineTicks && source[index] === '$' && source[index + 1] === '$'
          && (index === 0 || source[index - 1] !== '\\')) {
        open = !open;
        index += 1;
      }
    }
    return open;
  }

  /**
   * Replace $…$ / $$…$$ spans with inert placeholder tokens before the text
   * reaches marked.parse. Escaped \$ is never a delimiter; anything inside a
   * fenced code block or inline code span is left untouched; $$…$$ wins over
   * $…$ so "$$x$$" is one display span, not two inline ones.
   *
   * Returns { text, map } where map is Map<token, { tex, displayMode, raw }>.
   * Never throws: any unexpected failure returns the input untouched.
   */
  function protectMath(text) {
    const source = String(text == null ? '' : text);
    const map = new Map();
    if (source.indexOf('$') < 0) {
      return { text: source, map };
    }
    try {
      const fenceRanges = computeFenceRanges(source);
      const codeRanges = fenceRanges.concat(computeInlineCodeRanges(source, fenceRanges));
      const matches = [];

      DISPLAY_MATH_RE.lastIndex = 0;
      let match;
      while ((match = DISPLAY_MATH_RE.exec(source)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (spanOverlapsRanges(codeRanges, start, end)) continue;
        if (!match[1].trim()) continue;
        matches.push({ start, end, tex: match[1], displayMode: true, raw: match[0] });
      }

      const displayRanges = matches.map((entry) => [entry.start, entry.end]);
      INLINE_MATH_RE.lastIndex = 0;
      while ((match = INLINE_MATH_RE.exec(source)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (spanOverlapsRanges(codeRanges, start, end)) continue;
        if (spanOverlapsRanges(displayRanges, start, end)) continue;
        matches.push({ start, end, tex: match[1], displayMode: false, raw: match[0] });
      }

      if (!matches.length) {
        return { text: source, map };
      }

      matches.sort((a, b) => a.start - b.start);
      const nonce = randomNonceHex();
      let protectedText = '';
      let cursor = 0;
      matches.forEach((entry, index) => {
        const token = buildToken(index, entry.raw, nonce);
        map.set(token, { tex: entry.tex, displayMode: entry.displayMode, raw: entry.raw });
        protectedText += source.slice(cursor, entry.start) + token;
        cursor = entry.end;
      });
      protectedText += source.slice(cursor);
      return { text: protectedText, map };
    } catch (_err) {
      // Fail open to today's behavior: raw $ text, nothing protected.
      return { text: source, map: new Map() };
    }
  }

  /* ── placeholder restore (post-sanitize HTML string) ────────────────── */

  function getIsolatedDocument() {
    if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
      return document;
    }
    try {
      const { JSDOM } = require('jsdom');
      return new JSDOM('').window.document;
    } catch (_err) {
      return null;
    }
  }

  function restoreTokensInTextNode(textNode, map) {
    const text = String(textNode.textContent || '');
    TOKEN_RE.lastIndex = 0;
    if (!TOKEN_RE.test(text)) return;
    const ownerDocument = textNode.ownerDocument;
    const fragment = ownerDocument.createDocumentFragment();
    let cursor = 0;
    TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = TOKEN_RE.exec(text)) !== null) {
      const entry = map.get(match[0]);
      if (!entry) continue;
      if (match.index > cursor) {
        fragment.appendChild(ownerDocument.createTextNode(text.slice(cursor, match.index)));
      }
      // Always an inline <span>, even for display mode: swapping in a block
      // element would need paragraph splitting here. KaTeX's block-level
      // .katex-display inside <p> is tolerated by browsers and styled by
      // styles/markdown.css.
      const wrapper = ownerDocument.createElement('span');
      wrapper.className = 'markdown-math';
      wrapper.setAttribute('data-math-tex', entry.tex);
      wrapper.setAttribute('data-math-display', entry.displayMode ? 'true' : 'false');
      // Raw source as fallback text: if renderMathInto never runs (surface
      // not wired, katex unavailable), the user sees exactly today's output.
      wrapper.textContent = entry.raw;
      fragment.appendChild(wrapper);
      cursor = match.index + match[0].length;
    }
    if (cursor === 0) return;
    if (cursor < text.length) {
      fragment.appendChild(ownerDocument.createTextNode(text.slice(cursor)));
    }
    textNode.replaceWith(fragment);
  }

  function restoreTokensInAttributes(element, map) {
    const attributes = element.attributes;
    if (!attributes || !attributes.length) return;
    for (let i = 0; i < attributes.length; i += 1) {
      const attribute = attributes[i];
      const value = String(attribute.value || '');
      TOKEN_RE.lastIndex = 0;
      if (!TOKEN_RE.test(value)) continue;
      // A token inside an attribute value (math inside a link destination or
      // title) cannot host a rendered span — de-protect back to raw source so
      // the attribute is not left corrupted by an opaque token.
      const restored = value.replace(TOKEN_RE, (token) => {
        const entry = map.get(token);
        return entry ? entry.raw : token;
      });
      element.setAttribute(attribute.name, restored);
    }
  }

  /**
   * Replace placeholder tokens in sanitized/decorated HTML with inert,
   * self-describing .markdown-math wrapper spans. Runs AFTER DOMPurify —
   * wrapper attributes are set through setAttribute, and the tex payload is
   * only ever consumed by katex.renderToString. Never throws; on failure the
   * input HTML is returned unchanged (tokens degrade to visible text, which
   * the parity tests treat as a bug — this is a last-resort guard).
   */
  function restoreMathPlaceholders(html, map) {
    const source = String(html == null ? '' : html);
    if (!source || !map || typeof map.get !== 'function' || map.size === 0) {
      return source;
    }
    try {
      const doc = getIsolatedDocument();
      if (!doc) return source;
      const template = doc.createElement('template');
      template.innerHTML = source;
      const walkerRoot = template.content;
      const textNodes = [];
      const elements = [];
      (function collect(node) {
        const children = node.childNodes;
        for (let i = 0; i < children.length; i += 1) {
          const child = children[i];
          if (child.nodeType === 3) {
            textNodes.push(child);
          } else if (child.nodeType === 1) {
            elements.push(child);
            collect(child);
          }
        }
      })(walkerRoot);
      textNodes.forEach((textNode) => restoreTokensInTextNode(textNode, map));
      elements.forEach((element) => restoreTokensInAttributes(element, map));
      return template.innerHTML;
    } catch (_err) {
      return source;
    }
  }

  /* ── live-DOM typeset pass (post-insert, mermaid-precedent seam) ────── */

  function resolveKatexRuntimeLoader() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererKatexRuntimeLoader) {
      return globalThis.rendererKatexRuntimeLoader;
    }
    return null;
  }

  /**
   * Typeset every unrendered .markdown-math wrapper under rootEl via
   * katex.renderToString({ throwOnError: false, displayMode }). Mutates only
   * the wrapper spans — sibling sanitized content is untouched. Never throws:
   * a missing/broken katexLib leaves the raw-source fallback text visible and
   * counts the span in `errored` (unrendered wrappers stay unmarked so a
   * later pass can retry once katex has loaded; a wrapper whose render threw
   * is marked so a poisonous input isn't retried every render).
   *
   * options.katexLib is injectable for tests; default globalThis.katex,
   * resolved at CALL time so a lazy runtime load can schedule one retry.
   */
  function renderMathInto(rootEl, options) {
    return renderMathPass(rootEl, options, true);
  }

  // allowRuntimeRetry is deliberately NOT on renderMathInto's signature: it is an
  // internal one-shot latch, and a caller able to set it could either disable the
  // lazy load or re-arm it into a loop.
  function renderMathPass(rootEl, options, allowRuntimeRetry) {
    const result = { rendered: 0, errored: 0 };
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') {
      return result;
    }
    let wrappers;
    try {
      wrappers = rootEl.querySelectorAll('.markdown-math[data-math-tex]:not([data-math-rendered])');
    } catch (_err) {
      return result;
    }
    if (!wrappers || !wrappers.length) {
      return result;
    }
    const katexLib = (options && options.katexLib)
      || (typeof globalThis !== 'undefined' ? globalThis.katex : null);
    const katexUnavailable = !katexLib || typeof katexLib.renderToString !== 'function';
    for (let i = 0; i < wrappers.length; i += 1) {
      const wrapper = wrappers[i];
      // Reasoning panels opt out of rich rendering (the mermaid 'plain'
      // precedent): any wrapper that reaches one via cached markup stays
      // inert as raw text.
      if (typeof wrapper.closest === 'function' && wrapper.closest('.reasoning-row-panel')) {
        continue;
      }
      if (katexUnavailable) {
        result.errored += 1;
        continue;
      }
      const tex = wrapper.getAttribute('data-math-tex') || '';
      const displayMode = wrapper.getAttribute('data-math-display') === 'true';
      // Error path safety (pinned by tests/markdown-math-utils.test.js):
      // renderToString fully evaluates before the innerHTML setter runs, so a
      // throw leaves the raw-source text node untouched — no markup from `tex`
      // ever reaches the DOM — and the 'error' latch stops a poisonous input
      // being retried every render. The options object must stay minimal:
      // KaTeX's `trust` defaults off, and enabling it would let tex inject
      // \href/\htmlClass markup.
      try {
        wrapper.innerHTML = katexLib.renderToString(tex, {
          throwOnError: false,
          displayMode,
        });
        wrapper.setAttribute('data-math-rendered', 'true');
        result.rendered += 1;
      } catch (_err) {
        wrapper.setAttribute('data-math-rendered', 'error');
        result.errored += 1;
      }
    }
    if (allowRuntimeRetry && katexUnavailable && result.errored > 0) {
      const runtimeLoader = resolveKatexRuntimeLoader();
      if (runtimeLoader && typeof runtimeLoader.ensureKatexRuntime === 'function') {
        runtimeLoader.ensureKatexRuntime().then(function retryWhenReady(ready) {
          if (ready) {
            renderMathPass(rootEl, options, false);
          }
        }).catch(function ignoreRetryFailure() {
          // The raw-source fallback text is already visible; a failed retry is a
          // no-op, never a renderer error.
        });
      }
    }
    return result;
  }

  return {
    protectMath,
    advanceDisplayMathState,
    restoreMathPlaceholders,
    renderMathInto,
    setMathRenderingEnabled,
    isMathRenderingEnabled,
  };
});
