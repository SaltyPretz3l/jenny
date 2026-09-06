'use strict';

// Tiny, dependency-free console formatting for the setup orchestrator.
// No colors library: we use raw ANSI escapes and degrade to plain text when
// stdout is not a TTY (e.g. piped into a log) so the output stays readable.

const SUPPORTS_COLOR = Boolean(process.stdout && process.stdout.isTTY);

function paint(code, text) {
  if (!SUPPORTS_COLOR) {
    return text;
  }
  return `[${code}m${text}[0m`;
}

const ui = {
  heading(text) {
    process.stdout.write(`\n${paint('1;36', `=== ${text} ===`)}\n`);
  },

  step(text) {
    process.stdout.write(`${paint('36', '›')} ${text}\n`);
  },

  ok(text) {
    process.stdout.write(`${paint('32', '✓')} ${text}\n`);
  },

  skip(text) {
    process.stdout.write(`${paint('90', '↷ skip')} ${text}\n`);
  },

  warn(text) {
    process.stdout.write(`${paint('33', '!')} ${text}\n`);
  },

  fail(text) {
    process.stdout.write(`${paint('31', '✗')} ${text}\n`);
  },

  info(text) {
    process.stdout.write(`  ${paint('90', text)}\n`);
  },

  // Single-line, in-place progress bar (e.g. for `ollama pull`). Falls back to
  // a newline-per-update when stdout is not a TTY.
  progress(label, percent) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    if (!SUPPORTS_COLOR) {
      process.stdout.write(`  ${label}: ${pct}%\n`);
      return;
    }
    const width = 24;
    const filled = Math.round((pct / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    process.stdout.write(`\r  ${label} ${paint('36', bar)} ${pct}%   `);
    if (pct >= 100) {
      process.stdout.write('\n');
    }
  },
};

module.exports = { ui };
