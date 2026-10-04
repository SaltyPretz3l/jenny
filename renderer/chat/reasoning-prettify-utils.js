(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.reasoningPrettifyUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Display-time repair for thinking text from models that stop emitting
  // whitespace on long reasoning streams (small local models under
  // repeat_penalty drop the newline token first, then spaces after sentence
  // enders). The stored entry text is never modified — this runs on the
  // markdown handed to the reasoning-panel renderer.
  //
  // Every transform is idempotent (f(f(x)) === f(x)). Append stability holds
  // only within the tail window: arriving lookahead can rewrite earlier
  // output, which the stream renderer handles.
  // Straight double quotes use segment-local parity, and paragraph markers
  // stay inline on short synthesized list-item lines.
  // Deliberate non-goal: word-digit glue (`within10ms`, `and375x812`) stays
  // untouched because legitimate tokens include `utf8`, `sha256`, and `es6`.

  // Longest-first so "python" wins over "py" and "jsx"/"json" over "js".
  const KNOWN_FENCE_LANGS = [
    'javascript', 'typescript', 'python', 'json', 'yaml', 'bash', 'html',
    'diff', 'jsx', 'tsx', 'css', 'cpp', 'sql', 'xml', 'java', 'py', 'sh',
    'ts', 'js', 'c',
  ].sort((a, b) => b.length - a.length);

  // Short language tags also prefix ordinary code words. This frozen list
  // contains only collisions with KNOWN_FENCE_LANGS; matching the whole
  // leading word keeps "jsfunction" repairable while protecting "const".
  const FENCE_LANG_COLLISION_WORDS = [
    'const', 'constructor', 'class', 'char', 'case', 'catch', 'continue',
    'cout', 'shell', 'short', 'show', 'csv', 'tsconfig', 'pytest', 'shift',
    'pythonic', 'pythonpath', 'pythonhome', 'jsonify', 'jsonl',
  ];

  const CODE_HINT_RE = /[{};=()<>[\]]/;

  // Sentence enders glued to a capitalized sentence start, I-statement, or
  // single-letter enumerator. ALL-CAPS starts remain untouched.
  const SENTENCE_GLUE_RE = /([a-z)\]'"’”])([.!?])(?=(?:[A-Z][a-z]|I(?:['’]|\s)|\([a-z]\)\s))/g;

  // Sentence enders glued through a closing quote to a capitalized start.
  const QUOTED_SENTENCE_GLUE_RE = /([.!?])(["’”])(?=[A-Z])/g;

  // Capitalized words that open a sentence and never name a dotted member
  // ("misses.Let me" is glue; "React.Component" is not).
  const SENTENCE_STARTER_RE = /^(?:Actually|Alternatively|But|Wait|Let|Hmm|Okay|OK|Now|Also|First|Next|Then|So|Good|The|This|That|It|I|Maybe|Yes|No|We|If|For|In|And|Or|A|An)\b/;

  // Glued hyphen bullets ("Plan:- first- second") become Markdown list items.
  const GLUED_BULLET_RE = /([A-Za-z)\]'"’”][:.])- (?=[A-Za-z(])/g;

  // Discourse markers that open a new line of thought. Requiring the
  // trailing space/comma keeps a streaming tail that ends exactly on "So"
  // from being treated as a marker until the next character settles it.
  const PARAGRAPH_MARKER_RE = /([.!?]['")\]’”]?) (?=(?:Actually|Alternatively|But wait|Let me|Wait|Hmm|Okay|OK|Now|Also|First|Next|Then|So|Good|But)[ ,])/g;

  // One prettified fence per glued pair; blank lines around it so the
  // markdown renderer sees a real fenced block between prose paragraphs.
  const GLUED_FENCE_PAIR_RE = /```([^`\n]+)```/g;

  // Sparse = effectively unformatted (fewer than one newline per 400 chars).
  // A model that already writes paragraphs is left alone by the paragraph
  // synthesizer; only glue repair applies.
  const SPARSE_NEWLINE_CHARS_PER_BREAK = 400;
  const REASONING_GLUE_TOKEN_SCAN_CHARS = 256;

  function countNewlines(text) {
    let count = 0;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
      count += 1;
    }
    return count;
  }

  function hasSparseNewlines(text) {
    return countNewlines(text) * SPARSE_NEWLINE_CHARS_PER_BREAK < text.length;
  }

  function splitKnownLang(inner) {
    const trimmed = inner.replace(/^\s+/, '');
    const leadingRun = trimmed.match(/^[a-zA-Z]+/)?.[0] || '';
    const normalizedRun = leadingRun.toLowerCase();

    // A complete leading token is an explicit language tag. The following
    // non-letter starts the code, so no prefix guess is needed.
    if (KNOWN_FENCE_LANGS.includes(normalizedRun)) {
      const rest = trimmed.slice(leadingRun.length);
      if (!rest.trim()) {
        return null;
      }
      // Emit the canonical lowercase tag ("JS" → "js") like the glued path.
      return { lang: normalizedRun, code: rest.trim() };
    }

    // For a glued token, reject known code-word collisions before accepting
    // a language prefix. The caller may still rebuild it without a language.
    if (FENCE_LANG_COLLISION_WORDS.some((word) => normalizedRun.startsWith(word))) {
      return null;
    }
    for (const lang of KNOWN_FENCE_LANGS) {
      if (!normalizedRun.startsWith(lang)) {
        continue;
      }
      const rest = trimmed.slice(lang.length);
      return { lang, code: rest.trim() };
    }
    return null;
  }

  // Classify once for both closed and streaming-open repair so the emitted
  // prefix stays identical when a closing fence arrives.
  function classifyGluedFence(inner) {
    const trimmed = inner.trim();
    const split = splitKnownLang(trimmed);
    if (split && CODE_HINT_RE.test(split.code)) {
      return split;
    }
    // Code-looking content remains a fence even when its language cannot be
    // inferred safely. Keeping the whole text prevents keyword decapitation.
    if (CODE_HINT_RE.test(trimmed)) {
      return { lang: '', code: trimmed };
    }
    return null;
  }

  // "```jsfunction reset(){...}```" → a real fenced block. Only fires when
  // the fence pair sits on one line AND code-looking content can be retained,
  // so legitimate multi-line fences and odd inline triple-backtick spans are
  // untouched. Idempotent: the rewritten block contains newlines, which the
  // one-line pair pattern can never rematch.
  function repairGluedFencePairs(text) {
    return text.replace(GLUED_FENCE_PAIR_RE, (match, inner) => {
      const split = classifyGluedFence(inner);
      if (!split) {
        return match;
      }
      return `\n\n\`\`\`${split.lang}\n${split.code}\n\`\`\`\n\n`;
    });
  }

  // A still-open glued fence at the streaming tail ("...:```jsfunction re")
  // renders as garbage until the closer arrives. Opening it early keeps the
  // live tail readable and is prefix-stable with the pair rewrite above:
  // once the closer streams in, the pair rule produces the same prefix plus
  // the closing fence line.
  function repairTrailingOpenFence(text) {
    const lastFence = text.lastIndexOf('```');
    if (lastFence === -1) {
      return text;
    }
    const tail = text.slice(lastFence + 3);
    if (tail.includes('```') || tail.includes('\n')) {
      return text;
    }
    const split = classifyGluedFence(tail);
    if (!split) {
      return text;
    }
    return `${text.slice(0, lastFence)}\n\n\`\`\`${split.lang}\n${split.code}`;
  }

  // Split into prose and code segments so prose rules never touch code.
  // Odd-indexed capture groups are code: fenced blocks (closed or trailing
  // open), tilde fences, and closed or unfinished trailing inline spans.
  const CODE_SEGMENT_RE = /(```[\s\S]*?```|```[\s\S]*$|~~~[\s\S]*?~~~|~~~[\s\S]*$|`[^`\n]+`|`[^`\n]*$)/;

  // Paragraph and list synthesis apply per \n\n-delimited prose block, so a
  // late real list or paragraph cannot retract the repairs above it. A block
  // qualifies when its newlines are rare AND it is part of a text with no
  // paragraph break at all (a newline-free wall is repaired from its first
  // character), a long block carrying glue evidence of a starved stream, or a
  // very long block; the paragraphs of an already-formatted text stay
  // untouched. Length is judged after glue repair so a repaired block cannot
  // change class on the next pass (idempotence); glue is judged on the raw
  // block because the repair removes it.
  const STARVED_BLOCK_CHARS = 3 * SPARSE_NEWLINE_CHARS_PER_BREAK;

  function hasGlueEvidence(block) {
    return block.search(SENTENCE_GLUE_RE) !== -1
      || block.search(QUOTED_SENTENCE_GLUE_RE) !== -1
      || block.search(GLUED_BULLET_RE) !== -1;
  }

  function isSparseBlock(rawBlock, repairedBlock, wall) {
    if (!hasSparseNewlines(repairedBlock)) return false;
    if (wall || repairedBlock.length >= STARVED_BLOCK_CHARS) return true;
    return repairedBlock.length >= SPARSE_NEWLINE_CHARS_PER_BREAK && hasGlueEvidence(rawBlock);
  }

  function proseSegments(raw) {
    return String(raw == null ? '' : raw).split(CODE_SEGMENT_RE).filter((_, index) => index % 2 === 0);
  }

  // The prettify memo may split a text at a paragraph break only when the
  // text before the break ends outside code and the prose segment holding the
  // break has balanced straight quotes: glue repair tracks quote parity per
  // prose segment, and a fence left open in the prefix would swallow the rest.
  function isProseBoundary(prefix) {
    const segments = String(prefix == null ? '' : prefix).split(CODE_SEGMENT_RE);
    const tail = segments[segments.length - 1];
    if (!tail && segments.length > 1) {
      const code = segments[segments.length - 2];
      const closed = (/^(```|~~~)[\s\S]*\1$/.test(code) && code.length >= 6) || /^`[^`\n]+`$/.test(code);
      if (!closed) return false;
    }
    return (tail.match(/"/g)?.length || 0) % 2 === 0;
  }

  function tokenAround(text, offset) {
    let start = offset;
    const startLimit = Math.max(0, offset - REASONING_GLUE_TOKEN_SCAN_CHARS);
    while (start > startLimit && !/\s/.test(text[start - 1])) {
      start -= 1;
    }
    let end = offset;
    const endLimit = Math.min(text.length, offset + REASONING_GLUE_TOKEN_SCAN_CHARS);
    while (end < endLimit && !/\s/.test(text[end])) {
      end += 1;
    }
    return text.slice(start, end);
  }

  function repairSentenceGlue(prose) {
    // Glue repair only inserts spaces, so path separators cannot appear later.
    // Avoid scanning every boundary when this segment contains no path at all.
    const hasPathSeparator = prose.includes('/') || prose.includes('\\');
    const repaired = prose.replace(SENTENCE_GLUE_RE, (match, before, ender, offset) => {
      // Paths and dotted file names ("notes/plans/Foo.Md") are not sentence
      // boundaries — leave any token carrying a path separator alone.
      const token = hasPathSeparator ? tokenAround(prose, offset) : '';
      if (token.includes('/') || token.includes('\\')) {
        return match;
      }
      // Dotted identifiers ("React.Component", "models.User(") are not glue;
      // "!" and "?" never join a member, and a sentence starter always is glue.
      const left = token || tokenAround(prose, offset);
      const right = prose.slice(offset + match.length, offset + match.length + REASONING_GLUE_TOKEN_SCAN_CHARS);
      if (ender === '.' && !SENTENCE_STARTER_RE.test(right)
        && (/^[A-Z]/.test(left) || /^[A-Z][a-z]+(?:[A-Z(.]|$)/.test(right))) {
        return match;
      }
      return `${before}${ender} `;
    });
    let lastScannedOffset = 0;
    let runningQuoteCount = 0;
    return repaired.replace(QUOTED_SENTENCE_GLUE_RE, (match, ender, quote, offset) => {
      const token = hasPathSeparator ? tokenAround(repaired, offset) : '';
      if (token.includes('/') || token.includes('\\')) {
        return match;
      }
      // Replace callbacks visit matches in ascending offset order.
      runningQuoteCount += repaired.slice(lastScannedOffset, offset).match(/"/g)?.length || 0;
      lastScannedOffset = offset;
      if (quote === '"' && runningQuoteCount % 2 === 0) {
        return match;
      }
      return `${ender}${quote} `;
    });
  }

  function synthesizeParagraphs(prose) {
    // Track line starts forward so each marker does not rescan the full prefix.
    let lineStart = 0;
    let nextNewline = prose.indexOf('\n');
    return prose.replace(PARAGRAPH_MARKER_RE, (match, ender, offset) => {
      while (nextNewline !== -1 && nextNewline < offset) {
        lineStart = nextNewline + 1;
        nextNewline = prose.indexOf('\n', lineStart);
      }
      return prose.startsWith('- ', lineStart) && offset - lineStart <= 160 ? match : `${ender}\n\n`;
    });
  }

  function prettifyReasoningMarkdown(text) {
    const raw = String(text == null ? '' : text);
    if (!raw.trim()) {
      return raw;
    }
    const segments = raw.split(CODE_SEGMENT_RE);
    const wall = !/\n{2,}/.test(proseSegments(raw).join(''));
    for (let i = 1; i < segments.length; i += 2) {
      if (!segments[i].startsWith('```')) continue;
      const blocks = segments[i - 1].split(/\n{2,}/);
      let fence = repairGluedFencePairs(segments[i]);
      if (fence === segments[i] && hasSparseNewlines(blocks[blocks.length - 1] || segments[i])) {
        fence = repairTrailingOpenFence(fence);
      }
      if (fence === segments[i]) continue;
      segments[i - 1] += '\n\n';
      segments[i + 1] = (fence.endsWith('\n\n') ? '\n\n' : '') + segments[i + 1];
      segments[i] = fence.replace(/^\n\n|\n\n$/g, '');
    }
    for (let i = 0; i < segments.length; i += 2) {
      const blocks = segments[i].split(/(\n{2,})/);
      const repaired = repairSentenceGlue(segments[i]).split(/(\n{2,})/);
      for (let j = 0; j < repaired.length; j += 2) {
        if (isSparseBlock(blocks[j], repaired[j], wall)) {
          repaired[j] = synthesizeParagraphs(repaired[j].replace(GLUED_BULLET_RE, '$1\n- '));
        }
      }
      segments[i] = repaired.join('').replace(/\n{3,}/g, '\n\n');
    }
    return segments.join('');
  }

  return {
    prettifyReasoningMarkdown,
    hasSparseNewlines,
    isProseBoundary,
  };
});
