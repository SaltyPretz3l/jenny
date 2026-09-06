function normalizeJennyLevel(value, fallback = 'INFO') {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'ERROR' || token === 'WARN' || token === 'INFO' || token === 'DEBUG') {
    return token;
  }
  return fallback;
}

function mapStructuredLogLevelToken(token, fallback) {
  const normalized = String(token || '').trim().toUpperCase();
  if (normalized === 'TRACE' || normalized === 'DEBUG') {
    return 'DEBUG';
  }
  if (normalized === 'INFO') {
    return 'INFO';
  }
  if (normalized === 'WARN' || normalized === 'WARNING') {
    return 'WARN';
  }
  if (normalized === 'ERROR' || normalized === 'FATAL' || normalized === 'PANIC') {
    return 'ERROR';
  }
  return fallback;
}

function resolveStructuredLogLevel({ line, defaultLevel = 'INFO' } = {}) {
  const fallback = normalizeJennyLevel(defaultLevel, 'INFO');
  const text = String(line || '');
  const structuredPrefix = text.split(/\smsg=/, 1)[0];
  const match = /(?:^|\s)level="?([A-Za-z]+)"?(?=\s|$)/.exec(structuredPrefix);
  if (!match) {
    return fallback;
  }
  return mapStructuredLogLevelToken(match[1], fallback);
}

module.exports = {
  mapStructuredLogLevelToken,
  normalizeJennyLevel,
  resolveStructuredLogLevel,
};
