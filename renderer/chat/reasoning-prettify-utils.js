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
  // enders). The stored entry text is never modified: this runs on the
  // markdown handed to the reasoning-panel renderer.
  //
  // Code segments follow backtick run length: a run of three or more opens a
  // fence that a run at least as long closes, and a run of one or two opens an
  // inline span that a run of the same length closes on the same line. Prose
  // rules never edit a code segment. A glued one-line fence becomes a real
  // fenced block; it loses a language prefix only when a statement keyword or
  // an opening character follows it, otherwise every character the model
  // wrote stays in the block. A fence with code lines below gets the same
  // split only when its opening line holds such a sure language.
  //
  // Prose is repaired per block (text between real blank lines), in order:
  // a space after a sentence ender glued to the next sentence, list items
  // from glued hyphen bullets, and paragraph breaks at discourse markers on
  // long lines. A line breaks once it reaches 400 characters while the raw
  // text above has no real paragraph break, and 1200 characters after one.
  // Line length, the straight-quote count and the list state carry across
  // the inline code inside a block; the line and the quote count restart at
  // every paragraph break, inserted ones included.
  // Every decision depends only on the text before it plus its pattern's few
  // characters of lookahead (and a token scan of at most 256 characters), so
  // a repair once shown is never withdrawn by later text, a short healthy
  // paragraph is never split, and f(f(x)) === f(x).
  //
  // Known limits: word-digit glue (`within10ms`) stays because legitimate
  // tokens include `utf8` and `sha256`; a capitalised one-word sentence
  // (`Right.Looking`) stays glued because it cannot be told from
  // `React.Component`; a `config.Models` identifier outside backticks is
  // split; a fence whose content holds a backtick run as long as its opener
  // ends early; indented code blocks are treated as prose; a fence with code
  // lines below keeps a closer glued to code or prose as the model wrote it,
  // and so does its opening line unless that holds a sure language and
  // code-looking text ("```console.log(x)" and "```pyimport os" stay, and an
  // early repair of the first is withdrawn when its newline arrives).

  // Order is free: no statement keyword starts with the letters that turn
  // one name into a longer one ("js" + "on", "py" + "thon", "java" + "script").
  const KNOWN_FENCE_LANGS = [
    'javascript', 'typescript', 'python', 'json', 'yaml', 'bash', 'html',
    'diff', 'jsx', 'tsx', 'css', 'cpp', 'sql', 'xml', 'java', 'py', 'sh',
    'ts', 'js', 'c',
  ];

  // A language name is split off a glued fence only when a statement keyword
  // follows it as a whole word, or an opening character (see FENCE_OPENER_RE).
  const FENCE_STATEMENT_KEYWORDS = new Set([
    'function', 'const', 'let', 'var', 'class', 'import', 'export', 'from',
    'def', 'return', 'if', 'for', 'while', 'async', 'await', 'print', 'echo',
    'select', 'insert', 'create', 'with', 'try', 'public', 'private', 'static',
    'void', 'int', 'interface', 'enum', 'struct', 'package', 'using',
    'namespace', 'switch', 'throw', 'cd',
  ]);
  const FENCE_OPENER_RE = /^(?:[{#@$]|\/\/|\/\*)/;

  const CODE_HINT_RE = /[{};=()<>[\]]/;

  // Sentence enders glued to a capitalized sentence start, I-statement, or
  // single-letter enumerator. ALL-CAPS starts remain untouched. The letter
  // before the ender may be any lowercase letter ("café.Then").
  const SENTENCE_GLUE_RE = /([\p{Ll})\]'"’”])([.!?])(?=(?:[A-Z][a-z]|I(?:['’]|\s)|\([a-z]\)\s))/gu;

  // Capitalized words that open a sentence ("misses.Let me" is glue). The
  // same word followed by "(", "<", "[" or a word character names a member
  // ("rows.Next()", "Assert.That(").
  const STRONG_STARTER_WORDS = 'Actually|Alternatively|But|Wait|Let|Hmm|Okay|OK|Now|Also|First|Next|Then|So|Good|The|This|That|It|Maybe|Yes|No|We|If|For|In|And|Or|An';
  const SENTENCE_STARTER_RE = new RegExp(`^(?:${STRONG_STARTER_WORDS}|A|I)(?![\\w(<[])`);
  const MEMBER_RIGHT_RE = /^[A-Z][a-z]+(?:[A-Z(.]|$)/;

  // A multi-letter starter followed by a space, comma or apostrophe is glue
  // even after a digit or capital ("42.Then", "JSON.Then") or an ellipsis
  // ("Hmm...Actually").
  const STRONG_GLUE_RE = new RegExp(`(?:[0-9A-Z][.!?]|\\.\\.\\.|…)(?=(?:${STRONG_STARTER_WORDS})[ ,'’])`, 'g');

  // A closed inline code span directly followed by a glued sentence ender.
  const INLINE_CODE_GLUE_RE = /^[.!?](?=[A-Z][a-z]|I(?:['’]|\s)|\([a-z]\)\s)/;

  // Glued hyphen bullets ("Plan:- first.- second") become Markdown list items.
  const GLUED_BULLET_RE = /([A-Za-z)\]'"’”][:.])- (?=[A-Za-z(])/g;

  // A blockquote line or a table row never takes a paragraph break.
  const QUOTE_OR_TABLE_LINE_RE = /^ {0,3}[>|]/;

  // A real paragraph break: one or more blank lines, which may hold spaces,
  // tabs or the "\r" of a CRLF line ending.
  const BLANK_LINES_RE = /(\n(?:[ \t\r]*\n)+)/;

  // Prose that ends at the start of a line, where a fence opener may stand.
  const LINE_START_RE = /(?:^|\n) {0,3}$/;

  // Discourse markers that open a new line of thought. Requiring the
  // trailing space/comma keeps a streaming tail that ends exactly on "So"
  // from being treated as a marker until the next character settles it.
  const PARAGRAPH_MARKER = /(?:Actually|Alternatively|But wait|Let me|Wait|Hmm|Okay|OK|Now|Also|First|Next|Then|So|Good|But)[ ,]/.source;
  // Sticky: tests a marker only at lastIndex.
  const PARAGRAPH_MARKER_AT_RE = new RegExp(PARAGRAPH_MARKER, 'y');

  // One left-to-right scan visits, in order of appearance: a newline, a
  // sentence ender glued through a closing quote to a capitalized start, and
  // an ender followed by a space and a discourse marker.
  const LINE_EVENT_RE = new RegExp(`\\n|([.!?])(["’”])(?=[A-Z])|([.!?]['")\\]’”]?) (?=${PARAGRAPH_MARKER})`, 'g');

  // Minimum length of a line before a discourse marker breaks it: while the
  // raw text above has no real paragraph break, and once it has one.
  const WALL_PARAGRAPH_CHARS = 400;
  const FORMATTED_PARAGRAPH_CHARS = 1200;
  const REASONING_GLUE_TOKEN_SCAN_CHARS = 256;

  function isStatementKeyword(word) {
    return FENCE_STATEMENT_KEYWORDS.has(word.toLowerCase());
  }

  // Splits a known language name off the front of trimmed glued-fence text,
  // or returns null. An explicit tag ("js const a") needs an opening
  // character or a statement keyword after it. A glued tag ("jsfunction")
  // needs the rest of the leading letters to be exactly a statement keyword;
  // the one-letter language is never split from glued letters.
  function splitKnownLang(trimmed) {
    const run = trimmed.match(/^[a-zA-Z]+/)?.[0] || '';
    const lower = run.toLowerCase();
    if (KNOWN_FENCE_LANGS.includes(lower)) {
      const code = trimmed.slice(run.length).replace(/^\s+/, '');
      const sure = FENCE_OPENER_RE.test(code) || isStatementKeyword(code.match(/^[a-zA-Z]+/)?.[0] || '');
      return sure ? { lang: lower, code } : null;
    }
    const lang = KNOWN_FENCE_LANGS.find((name) => name.length > 1
      && lower.startsWith(name) && isStatementKeyword(lower.slice(name.length)));
    return lang ? { lang, code: trimmed.slice(lang.length) } : null;
  }

  // The language and code of one-line glued-fence text, or null when the
  // text does not look like code. Closed and still-open fences classify the
  // same way, so the emitted prefix holds when the closer arrives.
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

  // Split into prose and code segments so prose rules never touch code.
  // Even indexes are prose, odd indexes are code, and the join is the input.
  // A run of three or more backticks (or tildes) opens a fence that ends with
  // the next run of the same character at least as long, or at the end of the
  // text. A run of one or two backticks opens an inline span that ends with
  // the next run of exactly that length before a newline; with no closer and
  // no newline it is an unfinished trailing span and runs to the end. Any
  // other opener is prose. One left-to-right pass, so the cost is linear.
  const CHAR_BACKTICK = 96;
  const CHAR_TILDE = 126;
  const CHAR_NEWLINE = 10;
  const CHAR_STRAIGHT_QUOTE = 34;

  function runLengthAt(text, index) {
    const code = text.charCodeAt(index);
    let end = index + 1;
    while (end < text.length && text.charCodeAt(end) === code) end += 1;
    return end - index;
  }

  // End offset of a fence opened by `size` marker characters ending at `from`.
  function fenceEnd(text, code, size, from) {
    let k = from;
    while (k < text.length) {
      if (text.charCodeAt(k) !== code) {
        k += 1;
        continue;
      }
      const run = runLengthAt(text, k);
      if (run >= size) return k + run;
      k += run;
    }
    return text.length;
  }

  // End offset of an inline span, text.length for an unfinished trailing
  // span, or -1 when the opener is plain prose.
  function inlineEnd(text, size, from) {
    let k = from;
    while (k < text.length) {
      const code = text.charCodeAt(k);
      if (code === CHAR_NEWLINE) return -1;
      if (code !== CHAR_BACKTICK) {
        k += 1;
        continue;
      }
      const run = runLengthAt(text, k);
      if (run === size) return k + run;
      k += run;
    }
    return text.length;
  }

  function splitCodeSegments(text) {
    const segments = [];
    let proseStart = 0;
    let i = 0;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code !== CHAR_BACKTICK && code !== CHAR_TILDE) {
        i += 1;
        continue;
      }
      const size = runLengthAt(text, i);
      const afterRun = i + size;
      let end = -1;
      if (size >= 3) {
        end = fenceEnd(text, code, size, afterRun);
      } else if (code === CHAR_BACKTICK) {
        end = inlineEnd(text, size, afterRun);
      }
      if (end === -1) {
        i = afterRun;
        continue;
      }
      segments.push(text.slice(proseStart, i), text.slice(i, end));
      proseStart = end;
      i = end;
    }
    segments.push(text.slice(proseStart));
    return segments;
  }

  // True for a code segment from splitCodeSegments that ends with its own
  // closer rather than at the end of the text.
  function isClosedCodeSegment(segment) {
    const open = runLengthAt(segment, 0);
    let close = 1;
    while (close < segment.length && segment[segment.length - 1 - close] === segment[0]) close += 1;
    if (segment[segment.length - 1] !== segment[0] || segment.length - close < open) return false;
    return open >= 3 ? close >= open : close === open;
  }

  // True for a one- or two-backtick inline span. One with prose after it is
  // closed: an unfinished span runs to the end of the text.
  function isInlineSpan(segment) {
    return segment.charCodeAt(0) === CHAR_BACKTICK && runLengthAt(segment, 0) < 3;
  }

  // Rebuilds a three-backtick fence glued to its surroundings: returns the
  // new text and whether a blank line follows it (one always precedes it),
  // or null when the segment stays as it is; `before` is the prose in front.
  // On one line ("```jsfunction reset(){...}```", closed or still open at the
  // streaming tail) code-looking text becomes a real fenced block. With code
  // lines below, an opening line that holds a sure language and code is split
  // the same way, so the early repair holds when the newline arrives, and an
  // opening line that is exactly a known language moves off the prose it is
  // glued to. The rebuilt opening line is a bare language or empty, so a
  // second pass leaves it alone.
  function rebuildGluedFence(segment, before) {
    if (!/^```(?!`)/.test(segment)) return null;
    const lineEnd = segment.indexOf('\n');
    if (lineEnd === -1) {
      const closed = isClosedCodeSegment(segment);
      let end = segment.length;
      while (closed && segment.charCodeAt(end - 1) === CHAR_BACKTICK) end -= 1;
      const split = classifyGluedFence(segment.slice(3, end));
      return split && { blockAfter: closed, text: `\`\`\`${split.lang}\n${split.code}${closed ? '\n```' : ''}` };
    }
    const opening = segment.slice(3, lineEnd).trim();
    const split = splitKnownLang(opening);
    if (split && CODE_HINT_RE.test(split.code)) {
      return { blockAfter: false, text: `\`\`\`${split.lang}\n${split.code}${segment.slice(lineEnd)}` };
    }
    const glued = KNOWN_FENCE_LANGS.includes(opening.toLowerCase()) && !LINE_START_RE.test(before);
    return glued ? { blockAfter: false, text: segment } : null;
  }

  // The prettify memo may split a text at a real paragraph break whenever
  // the text before the break ends outside code: every prose rule is local to
  // its block, and a fence or span left open in the prefix would swallow the
  // rest.
  function isProseBoundary(prefix) {
    const segments = splitCodeSegments(String(prefix == null ? '' : prefix));
    return segments.length === 1 || segments[segments.length - 1] !== ''
      || isClosedCodeSegment(segments[segments.length - 2]);
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

  // The whitespace-delimited token around offset, or null when it carries a
  // path separator: paths and dotted file names ("notes/plans/Foo.Md") are
  // not sentence boundaries.
  function nonPathToken(text, offset) {
    const token = tokenAround(text, offset);
    return token.includes('/') || token.includes('\\') ? null : token;
  }

  // A dotted member ("React.Component", "models.User(") is not glue; "!" and
  // "?" never join a member, and a sentence starter always is glue.
  function isMemberJoin(ender, left, right) {
    return ender === '.' && !SENTENCE_STARTER_RE.test(right)
      && (/^[A-Z]/.test(left) || MEMBER_RIGHT_RE.test(right));
  }

  // Inserts the missing space after a glued sentence ender in one piece of
  // prose. Enders glued through a closing quote are repaired with the
  // paragraph breaks, which share their quote count.
  function repairSentenceGlue(piece) {
    return piece.replace(SENTENCE_GLUE_RE, (match, before, ender, offset) => {
      const left = nonPathToken(piece, offset);
      const right = piece.slice(offset + match.length, offset + match.length + REASONING_GLUE_TOKEN_SCAN_CHARS);
      return left === null || isMemberJoin(ender, left, right) ? match : `${before}${ender} `;
    }).replace(STRONG_GLUE_RE, (match, offset, whole) => (
      nonPathToken(whole, offset) === null ? match : `${match} `
    ));
  }

  // A prose segment that starts right after a closed inline span with a
  // glued ender ("`reset()`.Then I") gets the missing space.
  function repairGlueAfterInlineCode(piece) {
    if (!INLINE_CODE_GLUE_RE.test(piece)) return piece;
    const right = piece.slice(1, 1 + REASONING_GLUE_TOKEN_SCAN_CHARS);
    return isMemberJoin(piece[0], '', right) ? piece : `${piece[0]} ${piece.slice(1)}`;
  }

  // Line state carried left to right through one block (the text between
  // real paragraph breaks), across the inline code inside it: characters on
  // the current line, straight quotes since the last paragraph break, whether
  // a list has started, and whether the line is a blockquote or table row.
  function startBlock(line) {
    line.col = 0;
    line.quotes = 0;
    line.listStarted = false;
    line.guarded = false;
  }

  // A glued bullet after ":" always becomes a list item and starts a list; a
  // glued bullet after "." becomes one only once a list has started in the
  // block (an earlier converted bullet or a line starting with "- ").
  function repairGluedBullets(piece, line) {
    const firstListLine = line.col === 0 && piece.startsWith('- ') ? 0 : piece.indexOf('\n- ');
    const repaired = piece.replace(GLUED_BULLET_RE, (match, lead, offset) => {
      line.listStarted = line.listStarted || lead.endsWith(':') || (firstListLine !== -1 && firstListLine < offset);
      return line.listStarted ? `${lead}\n- ` : match;
    });
    line.listStarted = line.listStarted || firstListLine !== -1;
    return repaired;
  }

  function countStraightQuotes(text, from, to) {
    let count = 0;
    for (let i = from; i < to; i += 1) {
      if (text.charCodeAt(i) === CHAR_STRAIGHT_QUOTE) count += 1;
    }
    return count;
  }

  // Repairs quoted enders and inserts paragraph breaks in one piece of prose.
  // An ender glued through a quote gets its space when the quote closes (a
  // curly quote, or a straight quote at an odd count). A discourse marker
  // becomes a paragraph break once the line before its space, ender included,
  // is at least minLine characters long; a blockquote line or table row is
  // never broken. The line and the quote count both restart at a break, so a
  // second pass, which sees that break as a block boundary, decides the same.
  function breakParagraphs(piece, line, minLine) {
    if (line.col === 0) line.guarded = QUOTE_OR_TABLE_LINE_RE.test(piece);
    let pos = 0;
    const advance = (to) => {
      line.quotes += countStraightQuotes(piece, pos, to);
      line.col += to - pos;
      pos = to;
    };
    const repaired = piece.replace(LINE_EVENT_RE, (match, quoteEnder, quote, markerEnder, offset) => {
      if (match === '\n') {
        advance(offset + 1);
        line.col = 0;
        line.guarded = QUOTE_OR_TABLE_LINE_RE.test(piece.slice(pos, pos + 4));
        return match;
      }
      const ender = quoteEnder ? match : markerEnder;
      if (quoteEnder) {
        advance(offset);
        const closes = quote !== '"' || line.quotes % 2 === 1;
        if (!closes || nonPathToken(piece, offset) === null) return match;
      }
      advance(offset + ender.length);
      PARAGRAPH_MARKER_AT_RE.lastIndex = pos;
      const atMarker = !quoteEnder || PARAGRAPH_MARKER_AT_RE.test(piece);
      if (!atMarker || line.col < minLine || line.guarded) {
        // The space after the ender: read from the piece, or inserted here.
        if (quoteEnder) line.col += 1;
        else advance(offset + match.length);
        return `${ender} `;
      }
      pos = offset + match.length;
      line.col = 0;
      line.quotes = 0;
      return `${ender}\n\n`;
    });
    advance(piece.length);
    return repaired;
  }

  function prettifyReasoningMarkdown(text) {
    const raw = String(text == null ? '' : text);
    if (!raw.trim()) {
      return raw;
    }
    const segments = splitCodeSegments(raw);
    const rebuilt = [];
    const line = {};
    startBlock(line);
    // seenBreak follows the raw text only: a real paragraph break or a
    // multi-line code segment, never a break inserted here.
    let seenBreak = false;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (i % 2 === 1) {
        const fence = rebuildGluedFence(segment, segments[i - 1]);
        if (fence) rebuilt.push([i, fence]);
        if (segment.includes('\n')) {
          startBlock(line);
          seenBreak = true;
          line.col = segment.length - 1 - segment.lastIndexOf('\n');
        } else if (fence) {
          // A rebuilt one-line fence stands in its own block on the next pass.
          startBlock(line);
        } else {
          line.col += segment.length;
        }
        continue;
      }
      const pieces = segment.split(BLANK_LINES_RE);
      for (let j = 0; j < pieces.length; j += 1) {
        if (j % 2 === 1) {
          startBlock(line);
          seenBreak = true;
          continue;
        }
        let piece = pieces[j];
        if (j === 0 && i > 0 && isInlineSpan(segments[i - 1])) {
          piece = repairGlueAfterInlineCode(piece);
        }
        piece = repairGluedBullets(repairSentenceGlue(piece), line);
        pieces[j] = breakParagraphs(piece, line, seenBreak ? FORMATTED_PARAGRAPH_CHARS : WALL_PARAGRAPH_CHARS);
      }
      segments[i] = pieces.join('');
    }
    // Blank lines around a rebuilt fence make it a block between paragraphs.
    for (const [i, fence] of rebuilt) {
      segments[i - 1] += '\n\n';
      if (fence.blockAfter) segments[i + 1] = `\n\n${segments[i + 1]}`;
      segments[i] = fence.text;
    }
    for (let i = 0; i < segments.length; i += 2) {
      segments[i] = segments[i].replace(/\n{3,}/g, '\n\n');
    }
    return segments.join('');
  }

  return {
    prettifyReasoningMarkdown,
    isProseBoundary,
  };
});
