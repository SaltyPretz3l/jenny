'use strict';

// Classifies managed llama-server output for structured logging. llama.cpp
// prefixes each stderr line with an optional timestamp and a level letter
// ("0.00.047.868 I cmn  common_param: ..."); without a resolver every line,
// info chatter included, sank to the stderr default WARN. Lines without a
// letter fall back to the Ollama classifier, which reads the same embedded
// llama.cpp output (fatal load/VRAM patterns escalate, anomaly tokens warn).
// The one exception is the per-slot progress tick, which resolves to null (no
// log entry at all; see PROGRESS_TICK_LINE).

const { resolveOllamaOutputLevel } = require('./ollama-stderr-level');

const LLAMA_LEVEL_PREFIX = /^(?:\d+(?:\.\d+){3}\s+)?([DIWE])\s/;
const LLAMA_LEVELS = Object.freeze({ D: 'DEBUG', I: 'INFO', W: 'WARN', E: 'ERROR' });
const LLAMA_LINE_PREFIX = /^(?:\d+(?:\.\d+){3}\s+)?(?:[DIWE]\s+)?/;
// Per-request decode chatter (request log, slot lifecycle, prompt progress,
// timing blocks) repeats every few seconds while generating. At INFO it went
// to shell.log for every turn; demoted to DEBUG it stays off disk in a normal
// install. The engine-activity watchdog reads raw lines, not log levels.
const ROUTINE_DECODE_LINE = /^(?:slot\s|srv\s+(?:log_server_r|update_slots|params_from_)|(?:prompt eval|eval|total) time\s*=)/i;
// The per-slot progress tick fires every ~3 s while decoding and was ~54% of
// shell.log bytes; with the file sink at DEBUG (agent_test_hooks) demotion does
// not keep it off disk. It resolves to null: dropped from the log sinks but
// still delivered to onOutput, where the engine-activity watchdog uses it as
// its heartbeat (HB-025).
const PROGRESS_TICK_LINE = /^slot\s+print_timing:/i;

// A slot stopping on a full context is an abnormal outcome worth keeping.
const ABNORMAL_OUTCOME = /truncated\s*=\s*1\b/i;

function demoteRoutine(level, line) {
  const text = line.replace(LLAMA_LINE_PREFIX, '');
  return level === 'INFO' && ROUTINE_DECODE_LINE.test(text) && !ABNORMAL_OUTCOME.test(text)
    ? 'DEBUG'
    : level;
}

function dropProgressTick(level, line) {
  const text = line.replace(LLAMA_LINE_PREFIX, '');
  return (level === 'INFO' || level === 'DEBUG')
    && PROGRESS_TICK_LINE.test(text)
    && !ABNORMAL_OUTCOME.test(text)
    ? null
    : level;
}

function resolveLlamaServerOutputLevel({ line, stream, defaultLevel }) {
  if (stream !== 'stderr') {
    return defaultLevel;
  }
  const text = String(line || '').trim();
  const match = LLAMA_LEVEL_PREFIX.exec(text);
  if (match) {
    return dropProgressTick(demoteRoutine(LLAMA_LEVELS[match[1]], text), text);
  }
  return dropProgressTick(
    demoteRoutine(resolveOllamaOutputLevel({ line, stream, defaultLevel }), text),
    text
  );
}

module.exports = {
  resolveLlamaServerOutputLevel,
};
