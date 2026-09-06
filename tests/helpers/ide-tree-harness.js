'use strict';

const { JSDOM } = require('jsdom');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function buildIdeDom() {
  const dom = new JSDOM(`
    <div id="ideView">
      <div id="ideShell" data-rail-side="right">
        <div id="ideTabStrip"></div>
        <div id="ideEditorHost"></div>
        <textarea id="ideEditorFallback" class="hidden"></textarea>
        <div id="ideEmptyState"><p id="ideEmptyStateCopy"></p></div>
        <div id="ideRailPanel"></div>
      </div>
    </div>
  `);
  const doc = dom.window.document;
  const byId = (id) => doc.getElementById(id);
  return {
    dom,
    getDom: () => ({
      ideView: byId('ideView'),
      ideShell: byId('ideShell'),
      ideTabStrip: byId('ideTabStrip'),
      ideEditorHost: byId('ideEditorHost'),
      ideEditorFallback: byId('ideEditorFallback'),
      ideEmptyState: byId('ideEmptyState'),
      ideEmptyStateCopy: byId('ideEmptyStateCopy'),
      ideRailPanel: byId('ideRailPanel'),
    }),
  };
}

// Virtual workspace: files is relPath -> content; directories derive from
// path prefixes plus the explicit dirs list, so file operations show up in
// later listDirectory calls exactly like the real service.
function createBridgeStub({
  files = {},
  dirs = [],
  persisted = null,
  failRename = false,
  failDelete = false,
  failWriteText = false,
} = {}) {
  const calls = {
    listDirectory: [],
    createFile: [],
    createDirectory: [],
    rename: [],
    delete: [],
    readFile: [],
    writeFile: [],
    updateSettings: [],
    updateState: [],
    revealInFolder: [],
    openInDefaultApp: [],
    clipboardWriteText: [],
  };
  const state = { files: { ...files }, dirs: new Set(dirs) };
  let mtimeCounter = 1000;
  let versionCounter = 0;
  const versions = new Map(Object.keys(state.files).map((key) => [key, `vf2_${++versionCounter}`]));

  function conflictError() {
    const error = new Error('A file or folder with that name already exists.');
    error.code = 'CMP-WORKSPACEFS-0030';
    return error;
  }

  function isDir(relPath) {
    if (state.dirs.has(relPath)) {
      return true;
    }
    const prefix = `${relPath}/`;
    return Object.keys(state.files).some((key) => key.startsWith(prefix));
  }

  function listChildren(dirPath) {
    const prefix = dirPath ? `${dirPath}/` : '';
    const dirNames = new Set();
    const fileNames = [];
    for (const key of Object.keys(state.files)) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        fileNames.push(rest);
      } else {
        dirNames.add(rest.slice(0, slash));
      }
    }
    for (const dir of state.dirs) {
      if (dir === dirPath || !dir.startsWith(prefix)) {
        continue;
      }
      const rest = dir.slice(prefix.length);
      const slash = rest.indexOf('/');
      dirNames.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    return [
      ...[...dirNames].sort().map((name) => ({
        name, relPath: prefix + name, kind: 'directory', size: 0, mtimeMs: 1,
      })),
      ...fileNames.sort().map((name) => ({
        name, relPath: prefix + name, kind: 'file', size: 1, mtimeMs: 1,
      })),
    ];
  }

  return {
    calls,
    state,
    jennyShell: {
      workspaceFs: {
        async getRootState() {
          return { workspaceRoot: 'G:/fake-root', workspaceRootStatus: { state: 'ready', message: '' } };
        },
        async readFile(payload) {
          calls.readFile.push(payload);
          if (!(payload.path in state.files)) {
            const error = new Error('File not found in the workspace.');
            error.code = 'CMP-WORKSPACEFS-0004';
            throw error;
          }
          return {
            path: payload.path,
            content: state.files[payload.path],
            size: state.files[payload.path].length,
            mtimeMs: (mtimeCounter += 10),
            eol: 'lf',
          };
        },
        async readText(payload) {
          try {
            const result = await this.readFile(payload);
            return {
              ok: true, ...result, pathKey: process.platform === 'win32' ? result.path.toLowerCase() : result.path,
              requestedPath: payload.path, requestedPathKey: process.platform === 'win32' ? payload.path.toLowerCase() : payload.path,
              rootId: 'root-test', generation: 1, fileVersion: versions.get(result.path),
              encoding: 'utf-8', editable: true, truncated: false,
            };
          } catch (error) {
            return { ok: false, code: error.code, message: error.message, details: {} };
          }
        },
        async stat(payload) {
          return { path: payload.path, exists: payload.path in state.files, kind: 'file', size: 0, mtimeMs: 0 };
        },
        async writeFile(payload) {
          calls.writeFile.push(payload);
          state.files[payload.path] = payload.content;
          return { path: payload.path, size: payload.content.length, mtimeMs: (mtimeCounter += 10) };
        },
        async writeText(payload) {
          if (failWriteText) {
            return {
              ok: false,
              code: 'CMP-WORKSPACEFS-0025',
              message: 'The file could not be saved.',
              details: {},
            };
          }
          const result = await this.writeFile(payload);
          const fileVersion = `vf2_${++versionCounter}`;
          versions.set(payload.path, fileVersion);
          return {
            ok: true, ...result, pathKey: process.platform === 'win32' ? result.path.toLowerCase() : result.path,
            rootId: 'root-test', generation: 1, fileVersion,
          };
        },
        async listDirectory(payload) {
          calls.listDirectory.push(payload);
          return { path: payload.path || '', entries: listChildren(payload.path || ''), truncated: false };
        },
        async createFile(payload) {
          calls.createFile.push(payload);
          if (payload.path in state.files || isDir(payload.path)) {
            throw conflictError();
          }
          state.files[payload.path] = '';
          versions.set(payload.path, `vf2_${++versionCounter}`);
          return { path: payload.path, kind: 'file', size: 0, mtimeMs: (mtimeCounter += 10) };
        },
        async createDirectory(payload) {
          calls.createDirectory.push(payload);
          if (payload.path in state.files || isDir(payload.path)) {
            throw conflictError();
          }
          state.dirs.add(payload.path);
          return { path: payload.path, kind: 'directory' };
        },
        async rename(payload) {
          calls.rename.push(payload);
          if (failRename) {
            throw new Error('rename refused');
          }
          if (payload.to in state.files || isDir(payload.to)) {
            throw conflictError();
          }
          if (payload.from in state.files) {
            state.files[payload.to] = state.files[payload.from];
            delete state.files[payload.from];
            versions.set(payload.to, versions.get(payload.from) || `vf2_${++versionCounter}`);
            versions.delete(payload.from);
            return { from: payload.from, to: payload.to, kind: 'file' };
          }
          const prefix = `${payload.from}/`;
          for (const key of Object.keys(state.files)) {
            if (key.startsWith(prefix)) {
              const renamed = `${payload.to}/${key.slice(prefix.length)}`;
              state.files[renamed] = state.files[key];
              delete state.files[key];
              versions.set(renamed, versions.get(key) || `vf2_${++versionCounter}`);
              versions.delete(key);
            }
          }
          state.dirs.delete(payload.from);
          state.dirs.add(payload.to);
          return { from: payload.from, to: payload.to, kind: 'directory' };
        },
        async delete(payload) {
          calls.delete.push(payload);
          if (failDelete) {
            throw new Error(typeof failDelete === 'string' ? failDelete : 'delete refused');
          }
          if (payload.path in state.files) {
            delete state.files[payload.path];
            versions.delete(payload.path);
            return { path: payload.path, trashed: true, kind: 'file' };
          }
          const prefix = `${payload.path}/`;
          for (const key of Object.keys(state.files)) {
            if (key.startsWith(prefix)) {
              delete state.files[key];
              versions.delete(key);
            }
          }
          state.dirs.delete(payload.path);
          return { path: payload.path, trashed: true, kind: 'directory' };
        },
        async revealInFolder(payload) {
          calls.revealInFolder.push(payload);
          return { path: payload.path, revealed: true };
        },
        async openInDefaultApp(payload) {
          calls.openInDefaultApp.push(payload);
          return { path: payload.path, opened: true };
        },
      },
      clipboard: {
        async writeText(text) {
          calls.clipboardWriteText.push(String(text));
        },
      },
      workspaceIde: {
        async getState() {
          return {
            ok: true,
            context: {
              rootPath: 'G:/fake-root', rootId: 'root_fake', generation: 1, phase: 'ready',
            },
            ...(persisted || {
            openTabs: [],
            activeTabPath: '',
            expandedDirs: [],
            railPanel: 'explorer',
            railSide: 'right',
            railWidth: 300,
            }),
          };
        },
        async updateSettings(patch) {
          calls.updateSettings.push(patch);
          return patch;
        },
        async updateState(payload) {
          calls.updateState.push(payload);
          return { updated: true };
        },
      },
    },
  };
}

async function settle(ms = 10) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { buildIdeDom, createBridgeStub, settle, deferred };
