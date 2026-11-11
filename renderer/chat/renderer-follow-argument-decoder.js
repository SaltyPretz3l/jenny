/* renderer/chat/renderer-follow-argument-decoder.js - reads the JSON argument text of a write_file / edit_file call while it is still arriving (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererFollowArgumentDecoder = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* A streaming pushdown reader over JSON. push() walks only the new chunk;
     the text of a string is appended as it is decoded and is never re-read.
     It keeps what the model is writing in the shape the file views need:
     the path, the content, and the edits. Everything else is skipped.
     (The checklist reader in renderer-stream-activity-typed.js flattens
     escapes for a one-line label; this one reproduces the text exactly.) */

  const DEFAULT_MAX_CHARS = 524288;
  const KEY_MAX_CHARS = 64;
  const LITERAL_MAX_CHARS = 40;
  const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  const SIMPLE_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

  // What the next token may be.
  const START = 0;        // before the top-level {
  const KEY_OR_END = 1;   // after { : a key or }
  const KEY = 2;          // after , in an object: a key
  const COLON = 3;
  const VALUE = 4;        // a value (after a colon, or after a comma in an array)
  const VALUE_OR_END = 5; // after [ : a value or ]
  const COMMA_OR_END = 6; // after a value
  const STRING = 7;       // inside a string (value or key)
  const LITERAL = 8;      // inside a number, true, false or null
  const END = 9;

  function newSink() {
    return { text: '', pending: '', started: false, done: false };
  }

  function newEntry() {
    return { old: newSink(), next: newSink(), replaceAll: false };
  }

  function isHighSurrogate(code) {
    return code >= 0xD800 && code <= 0xDBFF;
  }

  function isWhitespace(code) {
    return code === 32 || code === 10 || code === 13 || code === 9;
  }

  function isHexDigit(code) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
  }

  function isLiteralChar(code) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || code === 45 || code === 43 || code === 46;
  }

  // Adds decoded characters to a sink. A trailing high surrogate is held until
  // the next code unit shows whether it completes a pair.
  function appendText(sink, text) {
    if (!text) return;
    let chunk = sink.pending ? sink.pending + text : text;
    sink.pending = '';
    if (isHighSurrogate(chunk.charCodeAt(chunk.length - 1))) {
      sink.pending = chunk.charAt(chunk.length - 1);
      chunk = chunk.slice(0, -1);
    }
    sink.text += chunk;
  }

  function closeSink(sink) {
    if (sink.pending) {
      sink.text += sink.pending;
      sink.pending = '';
    }
    sink.done = true;
  }

  function setEmptyDone(sink) {
    sink.text = '';
    sink.pending = '';
    sink.started = false;
    sink.done = true;
  }

  function openSink(sink) {
    sink.text = '';
    sink.pending = '';
    sink.started = true;
    sink.done = false;
  }

  function createFollowArgumentDecoder(options) {
    const settings = options && typeof options === 'object' ? options : {};
    const maxChars = Number.isFinite(settings.maxChars) && settings.maxChars >= 0
      ? Math.floor(settings.maxChars)
      : DEFAULT_MAX_CHARS;

    const pathSink = newSink();
    const contentSink = newSink();
    const keySink = newSink();
    let topEntry = null;
    let editEntries = [];

    // Containers still open. role: 'top' | 'edits' | 'edit' | 'skip'.
    const stack = [];
    let mode = START;
    let target = null;        // what the value after the current key is captured into
    let valueSink = null;     // the sink a string value is decoded into (null: skipped)
    let stringIsKey = false;
    let keyKept = false;      // the key being read belongs to a container whose keys are captured
    let escape = 0;           // 0 none, 1 after a backslash, 2 inside \uXXXX
    let unicode = '';
    let literal = '';
    let literalTarget = null;
    let pushed = 0;
    let done = false;
    let failed = false;
    let overflow = false;

    function fail() {
      failed = true;
    }

    // ---- keys and targets ----

    function ensureTopEntry() {
      if (!topEntry) topEntry = newEntry();
      return topEntry;
    }

    function resolveTarget(role, key, frame) {
      if (role === 'top') {
        switch (key) {
          case 'path': case 'file_path': return { sink: pathSink };
          case 'content': case 'file_content': return { sink: contentSink };
          case 'old_string': return { sink: ensureTopEntry().old };
          case 'new_string': return { sink: ensureTopEntry().next };
          case 'replace_all': return { entry: ensureTopEntry() };
          case 'edits': return { edits: true };
          default: return null;
        }
      }
      if (role === 'edit') {
        switch (key) {
          case 'old_string': return { sink: frame.entry.old };
          case 'new_string': return { sink: frame.entry.next };
          case 'replace_all': return { entry: frame.entry };
          default: return null;
        }
      }
      return null;
    }

    function finishKey(frame) {
      closeSink(keySink);
      const key = keyKept && keySink.text.length <= KEY_MAX_CHARS ? keySink.text : '';
      target = key ? resolveTarget(frame.role, key, frame) : null;
      mode = COLON;
    }

    // ---- values ----

    function pushFrame(kind, role, entry) {
      stack.push({ kind, role, entry: entry || null });
    }

    function beginValue(code) {
      const frame = stack[stack.length - 1];
      const captured = frame.kind === 'o' ? target : null;
      target = null;
      if (frame.role === 'edits' && code === 123) {
        const entry = newEntry();
        editEntries.push(entry);
        pushFrame('o', 'edit', entry);
        mode = KEY_OR_END;
        return;
      }
      if (captured && captured.edits) editEntries = [];
      if (captured && captured.entry) captured.entry.replaceAll = false;
      if (code === 34) { // "
        stringIsKey = false;
        valueSink = captured && captured.sink ? captured.sink : null;
        if (valueSink) openSink(valueSink);
        escape = 0;
        mode = STRING;
        return;
      }
      if (captured && captured.sink) setEmptyDone(captured.sink);
      if (code === 123) { // {
        pushFrame('o', 'skip');
        mode = KEY_OR_END;
        return;
      }
      if (code === 91) { // [
        pushFrame('a', captured && captured.edits ? 'edits' : 'skip');
        mode = VALUE_OR_END;
        return;
      }
      if (code === 45 || (code >= 48 && code <= 57) || code === 116 || code === 102 || code === 110) {
        literal = String.fromCharCode(code);
        literalTarget = captured;
        mode = LITERAL;
        return;
      }
      fail();
    }

    function finishLiteral() {
      const isTrue = literal === 'true';
      if (!(isTrue || literal === 'false' || literal === 'null' || NUMBER_RE.test(literal))) {
        fail();
        return;
      }
      if (literalTarget && literalTarget.entry) literalTarget.entry.replaceAll = isTrue;
      literal = '';
      literalTarget = null;
      mode = COMMA_OR_END;
    }

    function closeContainer(expectedKind) {
      const frame = stack[stack.length - 1];
      if (frame.kind !== expectedKind) {
        fail();
        return;
      }
      stack.pop();
      if (!stack.length) {
        done = true;
        mode = END;
        return;
      }
      mode = COMMA_OR_END;
    }

    // ---- strings ----

    function currentSink() {
      if (stringIsKey) return keyKept ? keySink : null;
      return valueSink;
    }

    function emitEscaped(text) {
      const sink = currentSink();
      if (sink) appendText(sink, text);
    }

    function endString() {
      if (stringIsKey) {
        finishKey(stack[stack.length - 1]);
        return;
      }
      if (valueSink) closeSink(valueSink);
      valueSink = null;
      mode = COMMA_OR_END;
    }

    // Reads string characters from `at`; returns the index to continue from.
    function scanString(text, at) {
      const length = text.length;
      let i = at;
      while (i < length && !failed) {
        if (escape === 1) {
          const ch = text.charAt(i);
          i += 1;
          if (ch === 'u') {
            escape = 2;
            unicode = '';
          } else if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, ch)) {
            escape = 0;
            emitEscaped(SIMPLE_ESCAPES[ch]);
          } else {
            fail();
          }
          continue;
        }
        if (escape === 2) {
          const ch = text.charAt(i);
          i += 1;
          if (!isHexDigit(ch.charCodeAt(0))) {
            fail();
            continue;
          }
          unicode += ch;
          if (unicode.length === 4) {
            escape = 0;
            emitEscaped(String.fromCharCode(parseInt(unicode, 16)));
            unicode = '';
          }
          continue;
        }
        let end = i;
        let code = 0;
        while (end < length) {
          code = text.charCodeAt(end);
          if (code === 34 || code === 92) break;
          end += 1;
        }
        if (end > i) {
          const sink = currentSink();
          if (sink && !(sink === keySink && sink.text.length > KEY_MAX_CHARS)) appendText(sink, text.slice(i, end));
        }
        if (end >= length) return length;
        i = end + 1;
        if (code === 92) {
          escape = 1;
        } else {
          endString();
          return i;
        }
      }
      return i;
    }

    // ---- the token loop ----

    function step(code) {
      const frame = stack[stack.length - 1];
      switch (mode) {
        case START:
          if (code === 123) {
            pushFrame('o', 'top');
            mode = KEY_OR_END;
          } else {
            fail();
          }
          return;
        case KEY_OR_END:
          if (code === 125) closeContainer('o');
          else startKey(code, frame);
          return;
        case KEY:
          startKey(code, frame);
          return;
        case COLON:
          if (code === 58) mode = VALUE;
          else fail();
          return;
        case VALUE:
          beginValue(code);
          return;
        case VALUE_OR_END:
          if (code === 93) closeContainer('a');
          else beginValue(code);
          return;
        case COMMA_OR_END:
          if (code === 44) {
            mode = frame.kind === 'o' ? KEY : VALUE;
          } else if (code === 125 && frame.kind === 'o') {
            closeContainer('o');
          } else if (code === 93 && frame.kind === 'a') {
            closeContainer('a');
          } else {
            fail();
          }
          return;
        default:
          fail();
      }
    }

    function startKey(code, frame) {
      if (code !== 34) {
        fail();
        return;
      }
      stringIsKey = true;
      valueSink = null;
      escape = 0;
      keySink.text = '';
      keySink.pending = '';
      // Keys of containers that capture nothing are scanned but not kept.
      keyKept = frame.role === 'top' || frame.role === 'edit';
      mode = STRING;
    }

    function run(text) {
      const length = text.length;
      let i = 0;
      while (i < length && !failed && !done) {
        if (mode === STRING) {
          i = scanString(text, i);
          continue;
        }
        const code = text.charCodeAt(i);
        if (mode === LITERAL) {
          if (isLiteralChar(code)) {
            literal += text.charAt(i);
            if (literal.length > LITERAL_MAX_CHARS) fail();
            i += 1;
          } else if (isWhitespace(code) || code === 44 || code === 125 || code === 93) {
            finishLiteral();
          } else {
            fail();
          }
          continue;
        }
        i += 1;
        if (isWhitespace(code)) continue;
        step(code);
      }
    }

    function push(chunk) {
      if (failed || done || overflow || typeof chunk !== 'string' || !chunk) return;
      let text = chunk;
      let exceeded = false;
      if (pushed + text.length > maxChars) {
        text = text.slice(0, Math.max(0, maxChars - pushed));
        exceeded = true;
      }
      pushed += text.length;
      run(text);
      if (exceeded) overflow = true;
    }

    function entryView(entry) {
      return {
        oldText: entry.old.text,
        oldDone: entry.old.done,
        newText: entry.next.text,
        newStarted: entry.next.started,
        newDone: entry.next.done,
        replaceAll: entry.replaceAll,
      };
    }

    function snapshot() {
      const edits = [];
      if (topEntry) edits.push(entryView(topEntry));
      for (let i = 0; i < editEntries.length; i += 1) edits.push(entryView(editEntries[i]));
      return {
        path: pathSink.text,
        pathDone: pathSink.done,
        content: contentSink.text,
        contentStarted: contentSink.started,
        contentDone: contentSink.done,
        edits,
        done,
        failed,
        overflow,
      };
    }

    return { push, snapshot };
  }

  return { createFollowArgumentDecoder, DEFAULT_MAX_CHARS };
});
