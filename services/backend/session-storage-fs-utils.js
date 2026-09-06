const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Session ids are produced by createSessionId() (sess_<ts>_<hex>) and never
// contain path separators. File ids are still encoded defensively for import
// and compatibility seams that can surface unusual ids; valid ids survive
// untouched while malformed ids become a collision-resistant filename token.
function sanitizeSessionId(sessionId) {
  const raw = String(sessionId || 'unknown_session');
  if (/^[a-zA-Z0-9_-]+$/.test(raw)) {
    return raw;
  }
  return `~${crypto.createHash('sha256').update(raw || 'unknown_session').digest('hex')}`;
}

async function readJsonFileAsync(filePath) {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJsonAtomicAsync(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.promises.unlink(tempPath);
    } catch (_cleanupError) {
      void _cleanupError;
    }
    throw error;
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function unlinkIfExists(filePath) {
  if (!filePath) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!error || error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

// Both stores derive their per-session directory from the legacy monolithic
// file path: <userData>/sessions.json -> <userData>/sessions/. Centralized so
// the canonical and shadow stores can't drift apart on path semantics.
function deriveSessionsDirectory(filePath) {
  const dirname = path.dirname(filePath);
  const basename = path.basename(filePath, path.extname(filePath));
  return path.join(dirname, basename);
}

function summariesEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  // Both summaries come from the same `_summarizeSession` factory so the key
  // order is stable; JSON.stringify is a cheap structural compare for these
  // flat-ish records (scalars + a small `linked_session_ids` array + a
  // normalized `context_preferences` sub-object).
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

module.exports = {
  sanitizeSessionId,
  readJsonFileAsync,
  writeJsonAtomicAsync,
  yieldToEventLoop,
  unlinkIfExists,
  deriveSessionsDirectory,
  summariesEqual,
  hasOwn,
};
