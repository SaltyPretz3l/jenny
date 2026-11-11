'use strict';

/**
 * Earlier versions of workspace files for one hidden browser session.
 *
 * A "before" picture needs the page as it was, without rewriting the
 * workspace. This installs a `file` protocol handler on the session's own
 * partition: a listed file is answered from memory, a file that did not exist
 * yet answers 404, and every other request is read from disk through the
 * session's normal fetch, so the request filter still decides what disk may be
 * read. The table never reads disk and is never used outside its session.
 */

const { fileURLToPath } = require('url');

const MAX_OVERRIDE_ENTRIES = 200;
const MAX_OVERRIDE_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_OVERRIDE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ANCESTOR_STEPS = 64;

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
});

function isPathInside(pathImpl, parentPath, childPath) {
  const relative = pathImpl.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !pathImpl.isAbsolute(relative));
}

// Real path of a file that may not be on disk: the deepest existing ancestor is
// realpath-resolved, so a link or junction on the way is followed, and the
// missing tail is appended. Any error other than "not there" fails closed.
function resolveRealCandidate(candidate, { fsImpl, pathImpl }) {
  let current = pathImpl.resolve(String(candidate || ''));
  const tail = [];
  for (let step = 0; step < MAX_ANCESTOR_STEPS; step += 1) {
    try {
      const real = fsImpl.realpathSync(current);
      return {
        real: tail.length ? pathImpl.join(real, ...tail.reverse()) : real,
        exists: tail.length === 0,
      };
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return null;
      const parent = pathImpl.dirname(current);
      if (parent === current) return null;
      tail.push(pathImpl.basename(current));
      current = parent;
    }
  }
  return null;
}

function containedKey(filePath, { roots, fsImpl, pathImpl, platform }) {
  const resolved = resolveRealCandidate(filePath, { fsImpl, pathImpl });
  if (!resolved) return null;
  if (!roots.some((root) => isPathInside(pathImpl, root, resolved.real))) return null;
  return {
    key: platform === 'win32' ? resolved.real.toLowerCase() : resolved.real,
    exists: resolved.exists,
  };
}

function toBody(content) {
  if (content === null || content === undefined) return null;
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  throw new Error('A file override needs text, bytes or null.');
}

/**
 * entries: [{ id, filePath, content, poison }]
 *   content: string | Buffer for the earlier bytes; null when the file did not exist.
 *   poison: true when the earlier bytes are unknown. A request for it is
 *   answered 404 and reported, so the caller can discard the render.
 * Throws when an entry leaves the roots or the table is over its limits.
 */
function buildOverrideTable(entries, io) {
  if (!Array.isArray(entries)) throw new Error('File overrides must be a list.');
  if (entries.length > MAX_OVERRIDE_ENTRIES) throw new Error('Too many file overrides.');
  const table = new Map();
  let totalBytes = 0;
  for (const entry of entries) {
    const found = containedKey(entry?.filePath, io);
    if (!found) throw new Error('A file override is outside the allowed roots.');
    const poison = entry.poison === true;
    const body = poison ? null : toBody(entry.content);
    if (body && body.length > MAX_OVERRIDE_ENTRY_BYTES) throw new Error('A file override is too large.');
    totalBytes += body ? body.length : 0;
    if (totalBytes > MAX_OVERRIDE_TOTAL_BYTES) throw new Error('File overrides are too large in total.');
    table.set(found.key, {
      id: String(entry.id ?? entry.filePath),
      body,
      poison,
      contentType: CONTENT_TYPES[io.pathImpl.extname(String(entry.filePath)).toLowerCase()]
        || 'application/octet-stream',
    });
  }
  return table;
}

function lookup(rawUrl, table, io) {
  let filePath;
  try {
    filePath = fileURLToPath(String(rawUrl || ''));
  } catch (_) {
    return { status: 400 };
  }
  const found = containedKey(filePath, io);
  if (!found) return { status: 403 };
  return { status: 200, exists: found.exists, entry: table.get(found.key) || null };
}

/**
 * Installs the table on `session` (a BrowserSessionService session record).
 * Throws when the session cannot take a protocol handler: a caller that asked
 * for an earlier state must not get a render of the current one.
 */
function installFileOverrides(session, entries, {
  roots,
  fsImpl,
  pathImpl,
  logger = () => {},
  platform = process.platform,
}) {
  const browserSession = session.webContents?.session;
  if (typeof browserSession?.protocol?.handle !== 'function' || typeof browserSession.fetch !== 'function') {
    throw new Error('File overrides are unavailable in this browser session.');
  }
  const io = { roots: Array.isArray(roots) ? roots : [], fsImpl, pathImpl, platform };
  const table = buildOverrideTable(entries, io);
  const requested = new Set();
  let poisoned = false;

  browserSession.protocol.handle('file', async (request) => {
    try {
      const hit = lookup(request?.url, table, io);
      if (hit.status !== 200) return new Response(null, { status: hit.status });
      if (hit.entry) {
        requested.add(hit.entry.id);
        if (hit.entry.poison) poisoned = true;
        if (!hit.entry.body) return new Response(null, { status: 404 });
        return new Response(hit.entry.body, {
          status: 200,
          headers: { 'content-type': hit.entry.contentType, 'cache-control': 'no-store' },
        });
      }
      if (!hit.exists) return new Response(null, { status: 404 });
      // Read from disk; this request passes the session's request filter again.
      return await browserSession.fetch(request.url, { bypassCustomProtocolHandlers: true });
    } catch (error) {
      logger('WARN', 'browser.file_override_failed', {
        sessionId: session.sessionId,
        reason: String(error?.message || error).slice(0, 200),
      });
      return new Response(null, { status: 500 });
    }
  });

  return {
    // The request filter asks this for a URL whose file is not on disk.
    servesMissingFile(rawUrl) {
      const hit = lookup(rawUrl, table, io);
      return hit.status === 200 && hit.exists === false && Boolean(hit.entry);
    },
    report() {
      return { requested: [...requested], poisoned };
    },
    dispose() {
      browserSession.protocol.unhandle?.('file');
    },
  };
}

module.exports = {
  MAX_OVERRIDE_ENTRIES,
  MAX_OVERRIDE_ENTRY_BYTES,
  MAX_OVERRIDE_TOTAL_BYTES,
  installFileOverrides,
  isPathInside,
};
