/* renderer/shared/ansi-stream-utils.js — shared incremental ANSI/OSC stripper.
 *
 * UIUX-035: the prior per-consumer approach (renderer-ide-terminal-panel.js)
 * ran a single stateless regex over each incoming chunk independently. Two
 * real defects fall out of that: (1) an OSC sequence (ESC ] ... ) is only
 * legally terminated by BEL (0x07) or ST (ESC \) — a regex written as
 * `ESC\][^ESC]*` has no BEL/ST awareness, so it greedily swallows every
 * character up to the NEXT escape byte, silently eating real output that
 * follows a BEL terminator within the same chunk; (2) a CSI/OSC sequence
 * split across two separate PTY chunks (fully plausible — the pty write
 * boundary has no relationship to escape-sequence boundaries) is invisible
 * to a stateless per-chunk regex: chunk 1 leaks a truncated `ESC[` (or
 * `ESC]...`) as literal text, and chunk 2's tail (missing its opening ESC)
 * leaks as literal text too, corrupting the visible transcript with raw
 * control bytes and parameter text.
 *
 * This module tracks a tiny state machine (one of NONE/ESC/CSI/OSC/OSC_ESC)
 * across calls to push(), so escape sequences are recognized correctly
 * regardless of where the PTY happened to split the underlying chunks, and
 * OSC sequences terminate on BEL or ST exactly per ECMA-48/xterm control
 * sequence rules. It never buffers unbounded content: CSI/OSC bytes are
 * discarded one at a time as they stream through, with a hard length cap on
 * an in-flight (unterminated) sequence so a malformed/adversarial stream
 * cannot suppress all future output forever (AGENTS.md section 9 — bounded
 * state, no silent unbounded suppression).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAnsiStreamUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ESC = 0x1b; // ESC
  const ESC_STRING = String.fromCharCode(ESC); // ESC as a string, for indexOf run-scanning
  const BEL = 0x07; // BEL (legacy OSC terminator)
  const BACKSLASH = 0x5c; // '\' — second byte of ST (ESC \)
  const OPEN_BRACKET = 0x5b; // '[' — CSI introducer
  const CLOSE_BRACKET = 0x5d; // ']' — OSC introducer

  const STATE_NONE = 0;
  const STATE_ESC = 1;
  const STATE_CSI = 2;
  const STATE_OSC = 3;
  const STATE_OSC_ESC = 4;

  // A real CSI/OSC sequence is always short (a handful of parameter bytes).
  // If a sequence runs past this many bytes without terminating, give up on
  // it and resume normal text mode rather than swallowing output forever.
  const MAX_PENDING_ESCAPE_BYTES = 4096;

  function isCsiFinalByte(code) {
    // ECMA-48 CSI final byte: 0x40-0x7E ('@'-'~').
    return code >= 0x40 && code <= 0x7e;
  }

  /**
   * Create one incremental ANSI/OSC stripper. Each terminal/session should
   * own its own instance — state must never be shared across unrelated
   * output streams — and callers should reset() on Clear/Restart so a fresh
   * session never inherits a mid-escape-sequence state from the old one.
   */
  function createAnsiStreamStripper() {
    let state = STATE_NONE;
    let pendingLength = 0;

    function reset() {
      state = STATE_NONE;
      pendingLength = 0;
    }

    /**
     * Feed the next chunk of raw PTY/process output. Returns the visible
     * text with all recognized CSI/OSC control sequences removed; carriage
     * return normalization and any other post-processing stays the caller's
     * job (unchanged from the prior per-chunk contract).
     */
    function push(chunk) {
      const text = String(chunk == null ? '' : chunk);
      let out = '';
      for (let i = 0; i < text.length; i += 1) {
        if (state === STATE_NONE) {
          // Fast path: plain text dominates real output, so copy the whole
          // run up to the next ESC as one slice instead of per-character
          // concatenation (a multi-KB escape-free chunk is one allocation,
          // not thousands).
          const nextEsc = text.indexOf(ESC_STRING, i);
          if (nextEsc === -1) {
            out += text.slice(i);
            break;
          }
          if (nextEsc > i) out += text.slice(i, nextEsc);
          state = STATE_ESC;
          pendingLength = 1;
          i = nextEsc; // the loop increment steps past the ESC itself
          continue;
        }
        const code = text.charCodeAt(i);
        if (state === STATE_ESC) {
          if (code === OPEN_BRACKET) {
            state = STATE_CSI;
            pendingLength += 1;
          } else if (code === CLOSE_BRACKET) {
            state = STATE_OSC;
            pendingLength += 1;
          } else if (code === ESC) {
            // Per ECMA-48/xterm, a second ESC restarts the escape sequence
            // rather than terminating it: emit nothing and stay in STATE_ESC
            // (this ESC becomes the new pending one) so e.g. `ESC ESC [ 0 m`
            // does not leak a visible `[0m` from the first, abandoned ESC.
            pendingLength = 1;
          } else {
            // Not a CSI/OSC introducer — this module only recognizes CSI and
            // OSC (matching the prior stripper's scope); any other escape
            // passes through untouched, same as before.
            out += String.fromCharCode(ESC) + text[i];
            state = STATE_NONE;
            pendingLength = 0;
          }
          continue;
        }
        if (state === STATE_CSI) {
          pendingLength += 1;
          if (isCsiFinalByte(code)) {
            state = STATE_NONE;
            pendingLength = 0;
          } else if (pendingLength > MAX_PENDING_ESCAPE_BYTES) {
            // Safety valve: an unterminated CSI cannot suppress output
            // forever. Give up on it and resume normal text mode.
            state = STATE_NONE;
            pendingLength = 0;
          }
          continue;
        }
        if (state === STATE_OSC) {
          pendingLength += 1;
          if (code === BEL) {
            state = STATE_NONE;
            pendingLength = 0;
          } else if (code === ESC) {
            state = STATE_OSC_ESC;
          } else if (pendingLength > MAX_PENDING_ESCAPE_BYTES) {
            state = STATE_NONE;
            pendingLength = 0;
          }
          continue;
        }
        if (state === STATE_OSC_ESC) {
          pendingLength += 1;
          if (code === BACKSLASH) {
            // ST = ESC \ — the OSC sequence is complete.
            state = STATE_NONE;
            pendingLength = 0;
          } else if (pendingLength > MAX_PENDING_ESCAPE_BYTES) {
            state = STATE_NONE;
            pendingLength = 0;
          } else {
            // Not a valid ST — treat the lone ESC as still inside the OSC
            // body (real-world OSC payloads do not contain bare ESC bytes
            // except as an ST lead-in) and keep discarding.
            state = STATE_OSC;
          }
          continue;
        }
      }
      return out;
    }

    return { push, reset };
  }

  return { createAnsiStreamStripper };
});
