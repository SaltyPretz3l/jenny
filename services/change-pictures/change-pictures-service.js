'use strict';

/**
 * Before and after pictures of the pages a change touched.
 *
 * A capture is a function of the change record and the disk. The renderer says
 * which files a turn changed and what each one's text hashed to before and
 * after. The After picture is the page as it is on disk. The Before picture is
 * the same page with the saved pre-change text served in place of the changed
 * files (browser-session-file-overrides.js), so the workspace is never
 * rewritten. If the disk no longer matches the turn's after hashes, the
 * workspace has moved on and the turn gets no pictures.
 *
 * Results carry picture URLs and workspace-relative paths only: no file bytes,
 * no absolute workspace path, no git output.
 */

const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { normalizeWorkspaceRelPath } = require('../workspace-ide-path-guard');
const { workspaceRootId } = require('../workspace-root-identity');
const { normalizeDiffInputText, sha256Text } = require('../tools/structured-diff');
const {
  MAX_OVERRIDE_ENTRY_BYTES,
  MAX_OVERRIDE_TOTAL_BYTES,
  isPathInside,
} = require('../browser-session-file-overrides');

const VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1280, height: 800 }),
  phone: Object.freeze({ width: 390, height: 844 }),
});
const MAX_FILES = 200;
const MAX_PAGES = 3;
const MAX_ID_LENGTH = 200;
const DEFAULT_SETTLE_MS = 400;
const WORKING_TREE_TURN_ID = '@working-tree';
// A turn's phone pictures are stored beside its desktop pictures, never in
// their place: the chat always shows the desktop pair. The Working tree page
// keeps one record.
const PHONE_SUFFIX = '@phone';
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const STATUSES = new Set(['created', 'modified', 'deleted']);
// Only these can change what a static page looks like; a turn that touched
// nothing else is never scanned.
const WEB_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf',
]);
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg']);

// No control characters: the store keys a turn by its two ids joined with a newline.
function isId(value) {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\u0000-\u001f]/.test(value);
}

function storeTurnId(turnId, viewport) {
  return viewport === 'phone' && turnId !== WORKING_TREE_TURN_ID ? turnId + PHONE_SUFFIX : turnId;
}

function hashOrNull(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value) ? value : null;
}

function createChangePicturesService({
  browserSessionService,
  snapshotStore,
  pictureStore,
  findAffectedPages,
  resolveWorkspaceRoot,
  loadWorkingTree = null,
  isEnabled = () => true,
  fsImpl = require('fs'),
  pathImpl = require('path'),
  logger = () => {},
  settleMs = DEFAULT_SETTLE_MS,
  setTimeoutImpl = setTimeout,
}) {
  // One capture at a time: each one opens hidden windows from a pool of four
  // that the preview and browser tools share.
  let tail = Promise.resolve();
  const inFlight = new Map();

  function enqueue(key, task) {
    if (inFlight.has(key)) return inFlight.get(key);
    const run = tail.then(task);
    tail = run.catch(() => {});
    const tracked = run.finally(() => inFlight.delete(key));
    inFlight.set(key, tracked);
    return tracked;
  }

  const extensionOf = (relPath) => pathImpl.extname(relPath).toLowerCase();
  const absoluteOf = (realRoot, relPath) => pathImpl.join(realRoot, ...relPath.split('/'));
  const settle = () => new Promise((resolve) => setTimeoutImpl(resolve, settleMs));

  function normalizeFiles(rawFiles) {
    const byPath = new Map();
    for (const raw of Array.isArray(rawFiles) ? rawFiles.slice(0, MAX_FILES * 4) : []) {
      let relPath;
      try {
        relPath = normalizeWorkspaceRelPath(raw?.path);
      } catch (_) {
        continue;
      }
      if (!WEB_EXTENSIONS.has(extensionOf(relPath)) || byPath.has(relPath)) continue;
      byPath.set(relPath, {
        path: relPath,
        status: STATUSES.has(raw.status) ? raw.status : 'modified',
        beforeHash: hashOrNull(raw.beforeHash),
        afterHash: hashOrNull(raw.afterHash),
      });
      if (byPath.size >= MAX_FILES) break;
    }
    return [...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  function signatureOf(viewport, parts) {
    return crypto.createHash('sha256').update(JSON.stringify([viewport, parts])).digest('hex').slice(0, 40);
  }

  async function resolveWorkspace(sessionId) {
    try {
      const root = String((await resolveWorkspaceRoot(sessionId)) || '').trim();
      if (!root) return null;
      const realRoot = await fsImpl.promises.realpath(root);
      const workspaceId = workspaceRootId(realRoot);
      return workspaceId ? { realRoot, workspaceId } : null;
    } catch (_) {
      return null;
    }
  }

  // Bytes of a workspace file, or null when it is missing, too large, or
  // reached through a link that leaves the root.
  async function readContained(realRoot, relPath) {
    try {
      const real = await fsImpl.promises.realpath(absoluteOf(realRoot, relPath));
      if (!isPathInside(pathImpl, realRoot, real)) return null;
      const stat = await fsImpl.promises.stat(real);
      if (!stat.isFile() || stat.size > MAX_OVERRIDE_ENTRY_BYTES) return null;
      return await fsImpl.promises.readFile(real);
    } catch (_) {
      return null;
    }
  }

  async function existsOnDisk(realRoot, relPath) {
    try {
      await fsImpl.promises.lstat(absoluteOf(realRoot, relPath));
      return true;
    } catch (_) {
      return false;
    }
  }

  // True while every file the turn changed is still as the turn left it.
  async function diskMatchesTurn(realRoot, files) {
    for (const file of files) {
      if (file.status === 'deleted') {
        if (await existsOnDisk(realRoot, file.path)) return false;
        continue;
      }
      if (!file.afterHash || !TEXT_EXTENSIONS.has(extensionOf(file.path))) {
        if (!(await existsOnDisk(realRoot, file.path))) return false;
        continue;
      }
      const bytes = await readContained(realRoot, file.path);
      if (!bytes) return false;
      const text = bytes.toString('utf8');
      // The file tools hash decoded text, which may or may not keep a byte-order mark.
      const withoutMark = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
      if (sha256Text(normalizeDiffInputText(text)) !== file.afterHash
        && sha256Text(normalizeDiffInputText(withoutMark)) !== file.afterHash) return false;
    }
    return true;
  }

  // One override per changed file. `readBefore(file)` resolves the earlier
  // text, or null when it is unknown; an unknown file poisons any page that
  // asks for it, so a wrong Before picture is never shown.
  async function buildOverrides(realRoot, files, readBefore) {
    const overrides = [];
    let totalBytes = 0;
    for (const file of files) {
      const entry = { id: file.path, filePath: absoluteOf(realRoot, file.path) };
      if (file.status === 'created') {
        overrides.push({ ...entry, content: null });
        continue;
      }
      // Earlier text only: a picture or a font read back as text would be served broken.
      let text = null;
      if (TEXT_EXTENSIONS.has(extensionOf(file.path))) {
        try {
          text = await readBefore(file);
        } catch (_) {
          text = null;
        }
      }
      const bytes = typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : -1;
      if (bytes < 0 || bytes > MAX_OVERRIDE_ENTRY_BYTES || totalBytes + bytes > MAX_OVERRIDE_TOTAL_BYTES) {
        overrides.push({ ...entry, poison: true });
        continue;
      }
      totalBytes += bytes;
      overrides.push({ ...entry, content: text });
    }
    return overrides;
  }

  async function render(realRoot, pagePath, viewport, overrides) {
    const sessionId = `change_pic_${crypto.randomBytes(8).toString('hex')}`;
    try {
      await browserSessionService.open({
        sessionId,
        streamId: 'change-pictures',
        url: pathToFileURL(absoluteOf(realRoot, pagePath)).toString(),
        // The size is the page's, not the window's with its frame, and a page
        // that scrolls shows no desktop scrollbar in its picture.
        bounds: { ...VIEWPORTS[viewport], contentSize: true },
        hideScrollbars: true,
        allowedFileRoots: [realRoot],
        strictWorkspaceOnly: true,
        fileOverrides: overrides,
      });
    } catch (error) {
      // open() closes its own session when it fails.
      return { ok: false, busy: /Maximum active browser sessions/.test(String(error?.message || '')) };
    }
    try {
      await settle();
      const shot = await browserSessionService.screenshot(sessionId, {});
      if (!Buffer.isBuffer(shot?.buffer) || shot.buffer.length === 0) return { ok: false };
      return {
        ok: true,
        buffer: shot.buffer,
        width: shot.width,
        height: shot.height,
        report: overrides ? browserSessionService.fileOverrideReport(sessionId) : null,
      };
    } catch (_) {
      return { ok: false };
    } finally {
      await Promise.resolve().then(() => browserSessionService.close(sessionId)).catch(() => {});
    }
  }

  // -> { busy: true } when no hidden window was free, else { pages, failed }.
  // `failed` says a render broke for a reason that may not repeat.
  async function capturePages(realRoot, pages, overrides, viewport) {
    const out = [];
    let failed = false;
    for (const page of pages) {
      let after = null;
      let before = null;
      if (page.status !== 'deleted') {
        after = await render(realRoot, page.path, viewport, null);
        if (after.busy) return { busy: true };
        if (page.status === 'created' && !after.ok) failed = true;
      }
      if (page.status !== 'created') {
        before = await render(realRoot, page.path, viewport, overrides);
        if (before.busy) return { busy: true };
        if (!before.ok) failed = true;
        // No Before, or a Before that needed a file whose earlier text is unknown.
        if (!before.ok || !before.report || before.report.poisoned) continue;
        // A page the finder guessed at that never asked for a changed file.
        if (page.status === 'unchanged' && before.report.requested.length === 0) continue;
      }
      const size = (shot) => ({ width: shot.width, height: shot.height });
      if (page.status === 'created') {
        if (after.ok) out.push({ path: page.path, state: 'new', before: null, after: after.buffer, ...size(after) });
      } else if (page.status === 'deleted') {
        out.push({ path: page.path, state: 'deleted', before: before.buffer, after: null, ...size(before) });
      } else if (!after.ok) {
        out.push({ path: page.path, state: 'after_failed', before: before.buffer, after: null, ...size(before) });
      } else if (before.buffer.equals(after.buffer)) {
        out.push({ path: page.path, state: 'same', before: null, after: after.buffer, ...size(after) });
      } else {
        out.push({ path: page.path, state: 'ready', before: before.buffer, after: after.buffer, ...size(after) });
      }
    }
    return { pages: out, failed };
  }

  function publicRecord(record) {
    if (!record) return null;
    const stored = String(record.turnId);
    return {
      sessionId: record.sessionId,
      turnId: record.viewport === 'phone' && stored.endsWith(PHONE_SUFFIX) ? stored.slice(0, -PHONE_SUFFIX.length) : stored,
      viewport: record.viewport,
      capturedAt: record.capturedAt,
      pages: (Array.isArray(record.pages) ? record.pages : []).map((page) => ({
        path: page.path,
        state: page.state,
        beforeUrl: page.beforeUrl || null,
        afterUrl: page.afterUrl || null,
        width: page.width,
        height: page.height,
      })),
    };
  }

  const done = (record) => ({ ok: true, enabled: true, record: publicRecord(record) });

  // `moved()` runs after the pictures are taken and resolves the answer to give
  // when the files changed meanwhile, else null: the renders take seconds, and a
  // picture of a later state must never be stored under this one's signature.
  async function captureAndStore({ workspace, sessionId, turnId, viewport, signature, files, readBefore, moved }) {
    const found = await findAffectedPages({
      realRoot: workspace.realRoot,
      files: files.map((file) => ({ path: file.path, status: file.status })),
      maxPages: MAX_PAGES,
    });
    let pages = [];
    if (found.pages.length > 0) {
      const overrides = await buildOverrides(workspace.realRoot, files, readBefore);
      const captured = await capturePages(workspace.realRoot, found.pages, overrides, viewport);
      if (captured.busy) return { ok: false, reason: 'busy' };
      const late = await moved();
      if (late) return late;
      // Nothing to show after a broken render is not remembered as "no pictures".
      if (captured.failed && captured.pages.length === 0) return { ok: false, reason: 'failed' };
      pages = captured.pages;
    }
    // An empty record is stored too: it remembers that this state has no pictures.
    return done(await pictureStore.write({
      workspaceId: workspace.workspaceId, sessionId, turnId: storeTurnId(turnId, viewport), viewport, signature, pages,
    }));
  }

  async function runCached({ workspace, sessionId, turnId, viewport, signature, force, task }) {
    // The signature and the retake flag are part of the key: a request for other
    // files, or a person's "Try again", never joins an older run's answer.
    const key = [workspace.workspaceId, sessionId, turnId, viewport, signature, force ? 'retake' : ''].join('\n');
    return enqueue(key, async () => {
      try {
        if (!force) {
          const stored = await pictureStore.read({ workspaceId: workspace.workspaceId, sessionId, turnId: storeTurnId(turnId, viewport) });
          if (stored && stored.signature === signature && stored.viewport === viewport) return done(stored);
        }
        return await task();
      } catch (error) {
        logger('WARN', 'change_pictures.capture_failed', { reason: String(error?.message || error).slice(0, 200) });
        return { ok: false, reason: 'failed' };
      }
    });
  }

  function readRequest(payload) {
    const sessionId = payload?.sessionId;
    if (!isId(sessionId)) return null;
    return {
      sessionId,
      viewport: payload.viewport === 'phone' ? 'phone' : 'desktop',
      force: payload.force === true,
    };
  }

  async function capture(payload) {
    const request = readRequest(payload);
    const turnId = payload?.turnId;
    if (!request || !isId(turnId) || turnId === WORKING_TREE_TURN_ID || turnId.endsWith(PHONE_SUFFIX)) return { ok: false, reason: 'invalid' };
    if (!isEnabled()) return { ok: true, enabled: false, record: null };
    const files = normalizeFiles(payload.files);
    const workspace = files.length > 0 ? await resolveWorkspace(request.sessionId) : null;
    if (!workspace) return done(null);
    const { sessionId, viewport, force } = request;
    const signature = signatureOf(viewport, files.map((file) => [file.path, file.status, file.afterHash]));
    return runCached({
      workspace, sessionId, turnId, viewport, signature, force,
      task: async () => {
        if (!(await diskMatchesTurn(workspace.realRoot, files))) return done(null);
        return captureAndStore({
          workspace, sessionId, turnId, viewport, signature, files,
          moved: async () => ((await diskMatchesTurn(workspace.realRoot, files)) ? null : done(null)),
          readBefore: async (file) => {
            if (!file.beforeHash) return null;
            const snapshot = await snapshotStore.read(file.beforeHash);
            return snapshot?.found === true && typeof snapshot.content === 'string' ? snapshot.content : null;
          },
        });
      },
    });
  }

  // The working tree against the last commit. `loadWorkingTree` owns git: it
  // resolves { files: [{ path, status }], readHead(path) -> text | null }.
  async function captureWorkingTree(payload) {
    const request = readRequest(payload);
    if (!request) return { ok: false, reason: 'invalid' };
    if (!isEnabled()) return { ok: true, enabled: false, record: null };
    const workspace = typeof loadWorkingTree === 'function' ? await resolveWorkspace(request.sessionId) : null;
    if (!workspace) return done(null);
    const { sessionId, viewport, force } = request;
    let tree = null;
    try {
      tree = await loadWorkingTree({ sessionId, realRoot: workspace.realRoot });
    } catch (_) {
      tree = null;
    }
    if (!tree) return done(null);
    const files = normalizeFiles(tree.files);
    // The cache key is each changed file's size and write time, never its
    // content: this runs on every listing, and a save after the last capture
    // retakes it.
    const stamp = async () => {
      const parts = [];
      for (const file of files) {
        const stat = file.status === 'deleted' ? null : await fsImpl.promises.stat(absoluteOf(workspace.realRoot, file.path)).catch(() => null);
        parts.push([file.path, file.status, stat ? `${stat.size}:${stat.mtimeMs}` : null]);
      }
      return signatureOf(viewport, parts);
    };
    const signature = await stamp();
    const turnId = WORKING_TREE_TURN_ID;
    return runCached({
      workspace, sessionId, turnId, viewport, signature, force,
      task: () => captureAndStore({
        workspace, sessionId, turnId, viewport, signature, files,
        // A save during the capture: the next listing asks again.
        moved: async () => ((await stamp()) === signature ? null : { ok: false, reason: 'busy' }),
        readBefore: (file) => tree.readHead(file.path),
      }),
    });
  }

  async function list(payload) {
    const sessionId = payload?.sessionId;
    if (!isId(sessionId)) return { ok: false, reason: 'invalid' };
    if (!isEnabled()) return { ok: true, enabled: false, records: [] };
    const workspace = await resolveWorkspace(sessionId);
    if (!workspace) return { ok: true, enabled: true, records: [] };
    try {
      const records = await pictureStore.list({ workspaceId: workspace.workspaceId, sessionId });
      return { ok: true, enabled: true, records: records.map(publicRecord) };
    } catch (_) {
      return { ok: true, enabled: true, records: [] };
    }
  }

  return { capture, captureWorkingTree, list };
}

module.exports = {
  VIEWPORTS,
  WORKING_TREE_TURN_ID,
  createChangePicturesService,
};
