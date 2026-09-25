'use strict';

// Classifies managed llama-server output for structured logging. llama.cpp
// prefixes each stderr line with an optional timestamp and a level letter
// ("0.00.047.868 I cmn  common_param: ..."); without a resolver every line,
// info chatter included, sank to the stderr default WARN. Lines without a
// letter fall back to the Ollama classifier, which reads the same embedded
// llama.cpp output (fatal load/VRAM patterns escalate, anomaly tokens warn).

const { resolveOllamaOutputLevel } = require('./ollama-stderr-level');

const LLAMA_LEVEL_PREFIX = /^(?:\d+(?:\.\d+){3}\s+)?([DIWE])\s/;
const LLAMA_LEVELS = Object.freeze({ D: 'DEBUG', I: 'INFO', W: 'WARN', E: 'ERROR' });

function resolveLlamaServerOutputLevel({ line, stream, defaultLevel }) {
  if (stream !== 'stderr') {
    return defaultLevel;
  }
  const match = LLAMA_LEVEL_PREFIX.exec(String(line || '').trim());
  if (match) {
    return LLAMA_LEVELS[match[1]];
  }
  return resolveOllamaOutputLevel({ line, stream, defaultLevel });
}

module.exports = {
  resolveLlamaServerOutputLevel,
};
