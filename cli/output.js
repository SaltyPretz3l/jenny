'use strict';

// Print-mode writers (Jenny CLI plan, decision 7): stdout carries data only,
// stderr carries diagnostics. `stream-json` writes every cli.v1 frame as one
// NDJSON line with the result frame last; `json` writes the result frame alone;
// `text` draws through the renderer (answer text to stdout, lines to stderr).
// No ANSI on stdout.

const { createRenderer } = require('./renderer');

function createOutput({ format = 'text', stdout = process.stdout, stderr = process.stderr, color = false, summary = false, onStdoutClosed = () => {} } = {}) {
  if (!['text', 'json', 'stream-json'].includes(format)) throw new TypeError(`unknown output format: ${format}`);
  const renderer = createRenderer({ color: color === true && stderr.isTTY === true, summary });
  // A caller that stopped reading closes the pipe; Node reports that as an
  // asynchronous EPIPE on stdout. Nothing more is written, and the run is told.
  let stdoutClosed = false;
  if (typeof stdout.on === 'function') {
    stdout.on('error', () => {
      if (stdoutClosed) return;
      stdoutClosed = true;
      onStdoutClosed();
    });
  }

  const write = (stream, text) => {
    if (stream === stdout && stdoutClosed) return;
    try { stream.write(text); } catch (_error) { /* a closed pipe must not fail the run */ }
  };
  const line = (stream, text) => write(stream, `${text}\n`);
  const apply = (ops) => { for (const op of ops) write(op.to === 'stdout' ? stdout : stderr, op.text); };

  function frame(event) {
    if (format === 'stream-json') {
      line(stdout, JSON.stringify(event));
      return;
    }
    if (format === 'json') {
      if (event.kind === 'result') line(stdout, JSON.stringify(event));
      return;
    }
    apply(renderer.render(event));
  }

  function diagnostic(message, tone = 'dim') {
    line(stderr, renderer.paint(tone, String(message)));
  }

  // Ends an open answer line before something else takes the terminal.
  function ensureLineBreak() {
    if (format === 'text') apply(renderer.breakLine());
  }

  return Object.freeze({ frame, diagnostic, ensureLineBreak, format, stdoutClosed: () => stdoutClosed });
}

module.exports = { createOutput };
