'use strict';

// The text renderer (Jenny CLI plan, decision 10): a pure function from
// cli.v1 frames to write operations, so print mode's text output and the
// interactive loop draw the same way and the drawing is testable without a
// terminal. Inline and append-only: answer text goes to stdout as it streams,
// everything else is a line on stderr. Restrained ANSI, only when asked.

const COLOR = Object.freeze({ dim: '\u001b[2m', red: '\u001b[31m', yellow: '\u001b[33m', bold: '\u001b[1m', reset: '\u001b[0m' });
const PLAN_STEP_LIMIT = 20;

function seconds(ms) {
  return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)} s`;
}

function createRenderer({ color = false, summary = false } = {}) {
  const paint = (tone, text) => (color && COLOR[tone] ? `${COLOR[tone]}${text}${COLOR.reset}` : text);
  let textOpen = false;
  let wroteText = false;
  const out = (text) => ({ to: 'stdout', text });
  const err = (text, tone = 'dim') => ({ to: 'stderr', text: `${paint(tone, text)}\n` });

  // Ends an open answer line so the next line starts at column one.
  function breakLine() {
    if (!textOpen) return [];
    textOpen = false;
    return [out('\n')];
  }

  function decisionLine(payload) {
    const subject = payload.tool_name || payload.request;
    if (payload.outcome === 'deny' || payload.outcome === 'decline') {
      return err(`[${payload.outcome}] ${subject}${payload.rule ? ` (${payload.rule})` : ''}`, 'yellow');
    }
    if (payload.by === 'user') {
      if (payload.outcome === 'answer') return err('[answered]');
      return err(`[allowed${payload.rule === 'allowed_this_run' ? ' for this run' : ' once'}] ${subject}`);
    }
    return null;
  }

  function render(event) {
    const ops = [];
    switch (event.kind) {
      case 'delta':
        ops.push(out(event.payload.text));
        textOpen = true;
        wroteText = true;
        break;
      case 'reset':
        if (event.payload.discard_scope !== 'none') {
          ops.push(...breakLine(), err('[answer restarted]'));
        }
        break;
      case 'tool_use':
        ops.push(...breakLine(), err(`[tool] ${event.payload.tool_name}${event.payload.summary ? `: ${event.payload.summary}` : ''}`));
        break;
      case 'tool_result':
        if (event.payload.status !== 'ok') ops.push(err(`[tool ${event.payload.status}] ${event.payload.tool_name}`, 'yellow'));
        break;
      case 'plan_proposed': {
        ops.push(...breakLine(), err(`[plan] ${event.payload.title || ''}`.trimEnd(), 'bold'));
        const steps = Array.isArray(event.payload.steps) ? event.payload.steps.slice(0, PLAN_STEP_LIMIT) : [];
        steps.forEach((step, index) => ops.push(err(`  ${index + 1}. ${typeof step === 'string' ? step : step?.title || step?.text || ''}`, 'plain')));
        break;
      }
      case 'decision': {
        const line = decisionLine(event.payload);
        if (line) ops.push(...breakLine(), line);
        break;
      }
      case 'status':
        if (event.payload.phase === 'context_compacted') ops.push(...breakLine(), err('[context compacted]'));
        break;
      case 'error':
        ops.push(...breakLine(), err(`[error ${event.payload.code}] ${event.payload.message || ''}`.trimEnd(), 'red'));
        break;
      case 'result': {
        const payload = event.payload;
        if (textOpen) ops.push(out('\n'));
        else if (!wroteText && payload.result) ops.push(out(`${payload.result}\n`));
        textOpen = false;
        wroteText = false;
        if (payload.is_error) ops.push(err(`[${payload.subtype}] exit ${payload.exit_code}`, 'red'));
        else if (summary) {
          const turns = Number(payload.num_turns) || 0;
          const tokens = Number(payload.usage?.output_tokens) || 0;
          ops.push(err(`[done] ${turns} turn${turns === 1 ? '' : 's'} · ${seconds(payload.duration_ms)}${tokens ? ` · ${tokens} output tokens` : ''}`));
        }
        break;
      }
      default:
        break;
    }
    return ops;
  }

  return Object.freeze({ render, breakLine, paint, textOpen: () => textOpen });
}

module.exports = { COLOR, createRenderer };
