'use strict';

// A change-pictures service over a temp workspace, a real picture store and a
// fake hidden browser, for the service tests.

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const { createTrackedTempDir } = require('./resource-cleanup');
const { createChangePicturesService } = require('../../services/change-pictures/change-pictures-service');
const { findAffectedPages } = require('../../services/change-pictures/page-finder');
const { createChangePictureStore } = require('../../services/change-pictures/picture-store');
const { normalizeDiffInputText, sha256Text } = require('../../services/tools/structured-diff');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const hashOf = (text) => sha256Text(normalizeDiffInputText(text));

// Stands in for the hidden browser: a "picture" is the page text followed by
// the text of every file it links, read through the overrides the way the
// protocol handler would serve them.
// `blockedHosts(options)` answers the external hosts the session refused.
// `waitsOnBlocked(options)` says the page waits on a refused script.
// `frame(options, shotNumber)` answers { mark, thumbnail } for a page that
// moves: the mark is added to that screenshot's bytes.
function createFakeBrowser({
  busy = () => false, failOpen = () => false, blockedHosts = () => [], waitsOnBlocked = () => false, frame = () => null,
} = {}) {
  const sessions = new Map();
  const browser = {
    opened: [],
    closed: [],
    async open(options) {
      if (busy(options)) throw new Error('Maximum active browser sessions reached.');
      if (failOpen(options)) throw new Error('Strict browser sessions require a contained workspace file URL.');
      browser.opened.push(options);
      sessions.set(options.sessionId, { options, shots: 0, report: { requested: [], poisoned: false } });
    },
    async screenshot(sessionId) {
      const session = sessions.get(sessionId);
      const { options, report } = session;
      const table = new Map((options.fileOverrides || []).map((entry) => [path.resolve(entry.filePath).toLowerCase(), entry]));
      const load = (absolute) => {
        const entry = table.get(path.resolve(absolute).toLowerCase());
        if (entry) {
          report.requested.push(entry.id);
          if (entry.poison) {
            report.poisoned = true;
            return '';
          }
          return entry.content === null ? '' : String(entry.content);
        }
        try {
          return fs.readFileSync(absolute, 'utf8');
        } catch (_) {
          return '';
        }
      };
      const pagePath = fileURLToPath(options.url);
      const html = load(pagePath);
      let painted = html;
      for (const match of html.matchAll(/href="([^"]+)"/g)) {
        painted += `\n${load(path.join(path.dirname(pagePath), match[1]))}`;
      }
      session.shots += 1;
      const moving = frame(options, session.shots);
      return {
        buffer: Buffer.concat([PNG_SIGNATURE, Buffer.from(painted + (moving?.mark || ''), 'utf8')]),
        width: options.bounds.width,
        height: options.bounds.height,
        thumbnail: moving?.thumbnail || null,
      };
    },
    fileOverrideReport(sessionId) {
      return sessions.get(sessionId)?.report || null;
    },
    blockedExternalHosts(sessionId) {
      return sessions.has(sessionId) ? blockedHosts(sessions.get(sessionId).options).slice() : [];
    },
    async pageWaitsOnBlockedAsset(sessionId) {
      return sessions.has(sessionId) ? waitsOnBlocked(sessions.get(sessionId).options) === true : false;
    },
    async close(sessionId) {
      browser.closed.push(sessionId);
      sessions.delete(sessionId);
    },
  };
  return browser;
}

function makeHarness({ browserOptions, enabled = () => true, loadWorkingTree = null } = {}) {
  const base = fs.realpathSync(createTrackedTempDir('jenny-change-pictures-'));
  const root = path.join(base, 'site');
  const storeRoot = path.join(base, 'user-data', 'change-pictures');
  fs.mkdirSync(root);
  const snapshots = new Map();
  const browser = createFakeBrowser(browserOptions);
  const write = (relPath, text) => {
    const absolute = path.join(root, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
  };
  // Records a turn's edit the way the file tools do: the old text is saved
  // under its hash and the new text is on disk.
  const edit = (relPath, beforeText, afterText) => {
    const change = { path: relPath, status: 'modified', beforeHash: null, afterHash: null };
    if (beforeText === null) change.status = 'created';
    else {
      change.beforeHash = hashOf(beforeText);
      snapshots.set(change.beforeHash, beforeText);
    }
    if (afterText === null) {
      change.status = 'deleted';
      fs.rmSync(path.join(root, ...relPath.split('/')), { force: true });
    } else {
      change.afterHash = hashOf(afterText);
      write(relPath, afterText);
    }
    return change;
  };
  const service = createChangePicturesService({
    browserSessionService: browser,
    snapshotStore: {
      async read(hash) {
        return snapshots.has(hash) ? { found: true, content: snapshots.get(hash) } : { found: false };
      },
    },
    pictureStore: createChangePictureStore({ rootDir: storeRoot }),
    findAffectedPages,
    resolveWorkspaceRoot: async (sessionId) => (sessionId === 'no-workspace' ? '' : root),
    loadWorkingTree,
    isEnabled: enabled,
    settleMs: 0,
    stillMs: 0,
  });
  return { service, browser, root, storeRoot, snapshots, write, edit };
}

function pictureText(url) {
  return fs.readFileSync(fileURLToPath(url)).subarray(PNG_SIGNATURE.length).toString('utf8');
}

module.exports = {
  hashOf,
  makeHarness,
  pictureText,
};
