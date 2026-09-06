'use strict';

/* Shared jsdom harness for Workspace IDE renderer tests (rail, search panel,
 * watcher reconciliation). Mirrors the fake-bridge pattern proven in
 * tests/renderer-ide-tree.test.js: a virtual workspace where directories
 * derive from file-key prefixes so file operations show up in later listings,
 * plus W4 surfaces - searchInFiles scans the virtual files, watchStart/Stop
 * record calls, and emitChange() drives the workspaceFs.onChange path. */

const { JSDOM } = require('jsdom');

const { createIdeController } = require('../../renderer/features/renderer-ide-controller');

function buildIdeDom() {
  const dom = new JSDOM(`
    <div id="ideView">
      <div id="ideShell" data-rail-side="right">
        <div id="ideMain">
          <div id="ideTabStrip"></div>
          <nav id="ideBreadcrumbs" class="hidden"></nav>
          <div id="ideDiffToolbar" class="hidden"></div>
          <div id="ideEditorStage">
            <div id="ideEditorHost"></div>
            <textarea id="ideEditorFallback" class="hidden"></textarea>
            <div id="idePreviewHost" class="hidden"></div>
            <div id="ideEmptyState">
              <p id="ideEmptyStateCopy"></p>
              <div id="ideEmptyStateAction" class="hidden"></div>
            </div>
          </div>
          <div id="ideBottomResizer" class="hidden" tabindex="0"></div>
          <div id="ideBottomPanel" class="hidden" data-open="false">
            <nav id="ideBottomTabs"></nav>
            <div id="ideBottomTerminalHost" class="hidden"></div>
            <div id="ideBottomPanelContent"></div>
          </div>
          <div id="ideBottomHandle" class="hidden"></div>
          <div id="ideStatusBar" class="hidden"></div>
        </div>
        <div id="ideRail">
          <div id="ideRailResizer" tabindex="0"></div>
          <nav id="ideActivityBar"></nav>
          <div id="ideRailPanel"></div>
        </div>
        <aside id="ideSecondarySidebar" class="hidden">
          <div id="ideSecondarySidebarResizer" class="hidden" tabindex="0"></div>
          <nav id="ideSecondarySidebarHeader"></nav>
          <div id="ideSecondarySidebarPanel"></div>
        </aside>
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
      ideMain: byId('ideMain'),
      ideTabStrip: byId('ideTabStrip'),
      ideBreadcrumbs: byId('ideBreadcrumbs'),
      ideDiffToolbar: byId('ideDiffToolbar'),
      ideStatusBar: byId('ideStatusBar'),
      ideEditorStage: byId('ideEditorStage'),
      ideEditorHost: byId('ideEditorHost'),
      ideEditorFallback: byId('ideEditorFallback'),
      idePreviewHost: byId('idePreviewHost'),
      ideEmptyState: byId('ideEmptyState'),
      ideEmptyStateCopy: byId('ideEmptyStateCopy'),
      ideEmptyStateAction: byId('ideEmptyStateAction'),
      ideRail: byId('ideRail'),
      ideRailResizer: byId('ideRailResizer'),
      ideActivityBar: byId('ideActivityBar'),
      ideRailPanel: byId('ideRailPanel'),
      ideBottomResizer: byId('ideBottomResizer'),
      ideBottomPanel: byId('ideBottomPanel'),
      ideBottomTabs: byId('ideBottomTabs'),
      ideBottomPanelContent: byId('ideBottomPanelContent'),
      ideBottomTerminalHost: byId('ideBottomTerminalHost'),
      ideBottomHandle: byId('ideBottomHandle'),
      ideSecondarySidebar: byId('ideSecondarySidebar'),
      ideSecondarySidebarResizer: byId('ideSecondarySidebarResizer'),
      ideSecondarySidebarHeader: byId('ideSecondarySidebarHeader'),
      ideSecondarySidebarPanel: byId('ideSecondarySidebarPanel'),
    }),
  };
}

function createBridgeStub({
  files = {},
  dirs = [],
  persisted = null,
  snapshots = {},
  // W6: rootPath '' simulates the unconfigured-workspace state (listings
  // throw CMP-WORKSPACEFS-0001); the workspace-root transition switches to
  // chooseRootResult (null = the user cancelled the dialog).
  rootPath = 'G:/fake-root',
  chooseRootResult = 'G:/fake-root',
  // Tier-2 git slice: an in-memory git model for the workspaceGit.* bridge.
  // null => the namespace degrades to { available:false } (flag-off / no repo),
  // exactly like the real service when the feature flag is off.
  git = null,
} = {}) {
  const calls = {
    listDirectory: [],
    listAllFiles: [],
    readImage: [],
    readFileBase64: [],
    createFile: [],
    createDirectory: [],
    rename: [],
    delete: [],
    readFile: [],
    readText: [],
    writeFile: [],
    writeText: [],
    updateSettings: [],
    updateState: [],
    searchInFiles: [],
    watchStart: [],
    watchStop: [],
    readPreChange: [],
    revealInFolder: [],
    openInDefaultApp: [],
    clipboardWriteText: [],
    chooseRoot: [],
    terminalStart: [],
    terminalWrite: [],
    terminalSignal: [],
    terminalKill: [],
    gitGetStatus: [],
    gitStage: [],
    gitUnstage: [],
    gitCommit: [],
    gitDiscard: [],
    gitFileAtHead: [],
  };
  // snapshots: beforeHash -> pre-change content (the W5 snapshot store fake).
  const state = {
    files: { ...files },
    dirs: new Set(dirs),
    snapshots: { ...snapshots },
    rootPath: String(rootPath || ''),
    rootGeneration: 1,
  };
  let pendingRootTransition = null;

  // In-memory git model. `git` (null when the feature is off) carries
  // { branch, files:[], head:{path:content}, isRepo, unborn, available }.
  function normalizeGitFile(entry) {
    const index = String(entry.index || ' ');
    const worktree = String(entry.worktree || ' ');
    const staged = entry.staged != null
      ? Boolean(entry.staged)
      : (index !== ' ' && index !== '?' && index !== '!');
    return {
      path: String(entry.path || ''),
      origPath: entry.origPath || null,
      index,
      worktree,
      state: String(entry.state || 'modified'),
      staged,
    };
  }
  const gitState = {
    available: git ? git.available !== false : false,
    isRepo: git ? git.isRepo !== false : false,
    unborn: Boolean(git && git.unborn),
    branch: String((git && git.branch) || 'main'),
    files: ((git && git.files) || []).map(normalizeGitFile),
    head: { ...((git && git.head) || {}) },
    lastCommitMessage: '',
  };
  function gitDisabled(op) {
    return { ok: false, available: false, isRepo: false, op, reason: 'feature_disabled' };
  }
  function gitNotRepo(op) {
    return { ok: false, available: true, isRepo: false, op };
  }
  function gitOk(op, extra) {
    return Object.assign({ ok: true, available: true, isRepo: true, op }, extra || {});
  }
  function gitStatusSummary() {
    return {
      staged_count: gitState.files.filter((file) => file.staged).length,
      modified_count: gitState.files.filter((file) => file.worktree === 'M').length,
      untracked_count: gitState.files.filter((file) => file.worktree === '?').length,
    };
  }
  const changeListeners = [];
  const watchLifecycleListeners = [];
  const terminalDataListeners = [];
  const terminalExitListeners = [];
  let terminalSessionCounter = 0;
  let terminalRunning = '';
  let mtimeCounter = 1000;
  let fileVersionCounter = 0;
  const fileVersions = new Map(Object.keys(state.files).map((filePath) => [filePath, `vf2_${++fileVersionCounter}`]));
  const filePathKey = (filePath) => (process.platform === 'win32'
    ? String(filePath).toLowerCase()
    : String(filePath));

  function noRootError() {
    const error = new Error('Choose a workspace root first.');
    error.code = 'CMP-WORKSPACEFS-0001';
    return error;
  }

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

  // Literal case-insensitive scan over the virtual files, one result per
  // matching line - the same shape services/workspace-ide-search.js returns.
  // An optional `scope` (Find-in-Folder) narrows the scan to a root-relative
  // folder, mirroring the backend glob so scoped-search tests see real results.
  function scanFiles(query, scope) {
    const needle = String(query || '').toLowerCase();
    const scopeDir = String(scope || '');
    const results = [];
    const matchedFiles = new Set();
    for (const relPath of Object.keys(state.files).sort()) {
      if (scopeDir && relPath !== scopeDir && !relPath.startsWith(`${scopeDir}/`)) {
        continue;
      }
      const lines = String(state.files[relPath]).split('\n');
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const matchStart = lines[lineIndex].toLowerCase().indexOf(needle);
        if (matchStart === -1) {
          continue;
        }
        matchedFiles.add(relPath);
        results.push({
          path: relPath,
          line: lineIndex + 1,
          column: matchStart + 1,
          preview: {
            text: lines[lineIndex],
            matchStart,
            matchEnd: matchStart + needle.length,
          },
        });
      }
    }
    return { query, results, fileCount: matchedFiles.size, filesScanned: 0, limitHit: false };
  }

  function rootContext(rootPath = state.rootPath, phase = 'ready', generation = state.rootGeneration) {
    return { rootPath, rootId: rootPath ? 'root_fake' : null, generation, phase };
  }

  function prepareRootTransition(rootPath) {
    if (rootPath === null) return { prepared: false, changed: false, canceled: true };
    if (rootPath === state.rootPath) return { prepared: false, changed: false, canceled: false };
    pendingRootTransition = { transitionId: 'root-test-transition', rootPath };
    return {
      prepared: true, transitionId: pendingRootTransition.transitionId, changed: true, canceled: false,
      candidate: rootContext(rootPath, 'preparing', state.rootGeneration + 1),
    };
  }

  return {
    calls,
    state,
    gitState,
    emitChange(payload) {
      const contextualPayload = payload?.context ? payload : {
        ...payload,
        context: { rootId: 'root-test', generation: state.rootGeneration },
      };
      for (const listener of [...changeListeners]) {
        listener(contextualPayload);
      }
    },
    get changeListenerCount() {
      return changeListeners.length;
    },
    emitWatchLifecycle(payload) {
      for (const listener of [...watchLifecycleListeners]) {
        listener(payload);
      }
    },
    get watchLifecycleListenerCount() {
      return watchLifecycleListeners.length;
    },
    emitTerminalData(payload) {
      for (const listener of [...terminalDataListeners]) {
        listener(payload);
      }
    },
    emitTerminalExit(payload) {
      terminalRunning = '';
      for (const listener of [...terminalExitListeners]) {
        listener(payload);
      }
    },
    get terminalSessionId() {
      return terminalRunning;
    },
    jennyShell: {
      workspaceRoot: {
        async captureContext() {
          return rootContext();
        },
        async prepareChoose() {
          calls.chooseRoot.push({});
          return prepareRootTransition(chooseRootResult ? String(chooseRootResult) : null);
        },
        async prepareClear() {
          return prepareRootTransition('');
        },
        async commit({ transitionId } = {}) {
          if (!pendingRootTransition || transitionId !== pendingRootTransition.transitionId) {
            return { committed: false, changed: false, blocked: true };
          }
          state.rootPath = pendingRootTransition.rootPath;
          state.rootGeneration += 1;
          pendingRootTransition = null;
          return { committed: true, changed: true, context: rootContext() };
        },
        async cancel() {
          pendingRootTransition = null;
          return { canceled: true, changed: false };
        },
      },
      workspaceFs: {
        async getRootState() {
          return {
            workspaceRoot: state.rootPath,
            workspaceRootStatus: { state: state.rootPath ? 'ready' : 'missing', message: '' },
          };
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
          calls.readText.push(payload);
          calls.readFile.push({ path: payload.path });
          if (!(payload.path in state.files)) {
            return { ok: false, code: 'CMP-WORKSPACEFS-0004', message: 'File not found in the workspace.', details: {} };
          }
          const fileVersion = fileVersions.get(payload.path) || `vf2_${++fileVersionCounter}`;
          fileVersions.set(payload.path, fileVersion);
          return {
            ok: true,
            path: payload.path,
            pathKey: filePathKey(payload.path),
            requestedPath: payload.path,
            requestedPathKey: filePathKey(payload.path),
            content: state.files[payload.path],
            size: state.files[payload.path].length,
            mtimeMs: (mtimeCounter += 10),
            eol: 'lf',
            rootId: 'root-test',
            generation: state.rootGeneration,
            fileVersion,
            encoding: 'utf-8',
            editable: true,
            truncated: false,
          };
        },
        async stat(payload) {
          return { path: payload.path, exists: payload.path in state.files, kind: 'file', size: 0, mtimeMs: 0 };
        },
        async readFileBase64(payload) {
          calls.readFileBase64.push(payload);
          if (!(payload.path in state.files)) {
            const error = new Error('File not found in the workspace.');
            error.code = 'CMP-WORKSPACEFS-0004';
            throw error;
          }
          const content = String(state.files[payload.path]);
          const extension = (payload.path.split('/').pop() || '').split('.').pop().toLowerCase();
          const mime = { png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg' }[extension]
            || 'application/octet-stream';
          return {
            path: payload.path,
            base64: Buffer.from(content, 'utf8').toString('base64'),
            mime,
            size: content.length,
            mtimeMs: (mtimeCounter += 10),
          };
        },
        async readImage(payload) {
          calls.readImage.push(payload);
          if (!(payload.path in state.files)) {
            return { ok: false, code: 'CMP-WORKSPACEFS-0004', message: 'File not found in the workspace.', details: {} };
          }
          const content = String(state.files[payload.path]);
          const extension = (payload.path.split('/').pop() || '').split('.').pop().toLowerCase();
          const mime = { png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg' }[extension];
          if (!mime) {
            return { ok: false, code: 'CMP-WORKSPACEFS-0014', message: 'Only supported workspace image files can be opened as images.', details: {} };
          }
          const base64 = Buffer.from(content, 'utf8').toString('base64');
          const fileVersion = `vf2_${++fileVersionCounter}`;
          fileVersions.set(payload.path, fileVersion);
          return {
            ok: true,
            path: payload.path,
            pathKey: filePathKey(payload.path),
            requestedPath: payload.path,
            requestedPathKey: filePathKey(payload.path),
            base64,
            mime,
            size: Buffer.byteLength(content),
            mtimeMs: (mtimeCounter += 10),
            rootId: 'root-test',
            generation: state.rootGeneration,
            fileVersion,
            kind: 'image',
            representation: 'base64',
            editable: false,
            truncated: false,
          };
        },
        async writeFile(payload) {
          calls.writeFile.push(payload);
          state.files[payload.path] = payload.content;
          return { path: payload.path, size: payload.content.length, mtimeMs: (mtimeCounter += 10) };
        },
        async writeText(payload) {
          calls.writeText.push(payload);
          calls.writeFile.push(payload);
          if (fileVersions.get(payload.path) !== payload.expectedFileVersion) {
            return { ok: false, code: 'CMP-WORKSPACEFS-0020', message: 'File changed on disk since it was loaded.', details: {} };
          }
          state.files[payload.path] = payload.content;
          const nextVersion = `vf2_${++fileVersionCounter}`;
          fileVersions.set(payload.path, nextVersion);
          return {
            ok: true,
            path: payload.path,
            pathKey: filePathKey(payload.path),
            size: payload.content.length,
            mtimeMs: (mtimeCounter += 10),
            rootId: 'root-test',
            generation: state.rootGeneration,
            fileVersion: nextVersion,
            encoding: 'utf-8',
            editable: true,
            truncated: false,
            eol: 'lf',
          };
        },
        async listDirectory(payload) {
          calls.listDirectory.push(payload);
          if (!state.rootPath) {
            throw noRootError();
          }
          return { path: payload.path || '', entries: listChildren(payload.path || ''), truncated: false };
        },
        async listAllFiles() {
          calls.listAllFiles.push({});
          if (!state.rootPath) {
            throw noRootError();
          }
          return { files: Object.keys(state.files).sort(), truncated: false };
        },
        async createFile(payload) {
          calls.createFile.push(payload);
          if (payload.path in state.files || isDir(payload.path)) {
            throw conflictError();
          }
          state.files[payload.path] = '';
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
          if (payload.to in state.files || isDir(payload.to)) {
            throw conflictError();
          }
          if (payload.from in state.files) {
            state.files[payload.to] = state.files[payload.from];
            delete state.files[payload.from];
            return { from: payload.from, to: payload.to, kind: 'file' };
          }
          const prefix = `${payload.from}/`;
          for (const key of Object.keys(state.files)) {
            if (key.startsWith(prefix)) {
              state.files[`${payload.to}/${key.slice(prefix.length)}`] = state.files[key];
              delete state.files[key];
            }
          }
          state.dirs.delete(payload.from);
          state.dirs.add(payload.to);
          return { from: payload.from, to: payload.to, kind: 'directory' };
        },
        async delete(payload) {
          calls.delete.push(payload);
          if (payload.path in state.files) {
            delete state.files[payload.path];
            return { path: payload.path, trashed: true, kind: 'file' };
          }
          const prefix = `${payload.path}/`;
          for (const key of Object.keys(state.files)) {
            if (key.startsWith(prefix)) {
              delete state.files[key];
            }
          }
          state.dirs.delete(payload.path);
          return { path: payload.path, trashed: true, kind: 'directory' };
        },
        async searchInFiles(payload) {
          calls.searchInFiles.push(payload);
          return scanFiles(payload.query, payload.scope);
        },
        async readPreChange(payload) {
          calls.readPreChange.push(payload);
          const hash = String(payload.beforeHash || '');
          if (hash in state.snapshots) {
            return { path: payload.path, found: true, content: state.snapshots[hash] };
          }
          return { path: payload.path, found: false, reason: 'missing' };
        },
        async revealInFolder(payload) {
          calls.revealInFolder.push(payload);
          if (!(payload.path in state.files) && !isDir(payload.path)) {
            const error = new Error('File or folder not found in the workspace.');
            error.code = 'CMP-WORKSPACEFS-0004';
            throw error;
          }
          return { path: payload.path, revealed: true };
        },
        async openInDefaultApp(payload) {
          calls.openInDefaultApp.push(payload);
          if (!(payload.path in state.files) && !isDir(payload.path)) {
            const error = new Error('File or folder not found in the workspace.');
            error.code = 'CMP-WORKSPACEFS-0004';
            throw error;
          }
          return { path: payload.path, opened: true };
        },
        async watchStart() {
          calls.watchStart.push({});
          if (!state.rootPath) {
            throw noRootError();
          }
          return { watching: true };
        },
        async watchStop() {
          calls.watchStop.push({});
          return { watching: false };
        },
        onChange(listener) {
          changeListeners.push(listener);
          return () => {
            const index = changeListeners.indexOf(listener);
            if (index !== -1) {
              changeListeners.splice(index, 1);
            }
          };
        },
        // WIDE-028: typed watcher lifecycle push (emitWatchLifecycle drives it).
        onWatchLifecycle(listener) {
          watchLifecycleListeners.push(listener);
          return () => {
            const index = watchLifecycleListeners.indexOf(listener);
            if (index !== -1) {
              watchLifecycleListeners.splice(index, 1);
            }
          };
        },
      },
      clipboard: {
        async writeText(text) {
          calls.clipboardWriteText.push(String(text));
        },
      },
      workspaceTerminal: {
        async start() {
          calls.terminalStart.push({});
          if (!state.rootPath) {
            const error = new Error('No workspace root is configured; choose a workspace folder first.');
            error.code = 'CMP-TERMINAL-0002';
            throw error;
          }
          if (!terminalRunning) {
            terminalSessionCounter += 1;
            terminalRunning = `term-${terminalSessionCounter}`;
          }
          return { sessionId: terminalRunning, shell: 'powershell.exe', cwd: state.rootPath };
        },
        async write(payload) {
          calls.terminalWrite.push(payload);
          return { written: String(payload?.data || '').length };
        },
        async signal(payload) {
          calls.terminalSignal.push(payload);
          return { signaled: true };
        },
        async kill(payload) {
          calls.terminalKill.push(payload);
          terminalRunning = '';
          return { killed: true };
        },
        onData(listener) {
          terminalDataListeners.push(listener);
          return () => {
            const index = terminalDataListeners.indexOf(listener);
            if (index !== -1) {
              terminalDataListeners.splice(index, 1);
            }
          };
        },
        onExit(listener) {
          terminalExitListeners.push(listener);
          return () => {
            const index = terminalExitListeners.indexOf(listener);
            if (index !== -1) {
              terminalExitListeners.splice(index, 1);
            }
          };
        },
      },
      workspaceIde: {
        async getState() {
          const value = persisted || {
            openTabs: [],
            activeTabPath: '',
            expandedDirs: [],
            railPanel: 'explorer',
            railSide: 'left',
            railWidth: 300,
          };
          return {
            ok: true,
            context: {
              rootPath: state.rootPath,
              rootId: state.rootPath ? 'root_fake' : null,
              generation: state.rootGeneration,
              phase: 'ready',
            },
            ...value,
          };
        },
        async updateSettings(patch) {
          calls.updateSettings.push(patch);
          return { updated: true, ...patch };
        },
        async updateState(payload) {
          calls.updateState.push(payload);
          return {
            updated: true,
            context: {
              rootPath: state.rootPath,
              rootId: state.rootPath ? 'root_fake' : null,
              generation: state.rootGeneration,
              phase: 'ready',
            },
          };
        },
      },
      workspaceGit: {
        async getStatus(payload) {
          calls.gitGetStatus.push(payload || {});
          if (!gitState.available) {
            return gitDisabled('getStatus');
          }
          if (!gitState.isRepo) {
            return gitNotRepo('getStatus');
          }
          return gitOk('getStatus', {
            branch: gitState.branch,
            detached: false,
            unborn: gitState.unborn,
            ahead: 0,
            behind: 0,
            files: gitState.files.map((file) => ({ ...file })),
            summary: gitStatusSummary(),
          });
        },
        async stage(payload) {
          calls.gitStage.push(payload || {});
          if (!gitState.available) { return gitDisabled('stage'); }
          if (!gitState.isRepo) { return gitNotRepo('stage'); }
          const paths = [].concat((payload && payload.paths) || []);
          for (const file of gitState.files) {
            if (paths.includes(file.path)) {
              file.staged = true;
              file.index = file.worktree === '?' ? 'A' : 'M';
              file.worktree = ' ';
              file.state = file.state === 'untracked' ? 'added' : file.state;
            }
          }
          return gitOk('stage', { staged: paths.length, paths });
        },
        async unstage(payload) {
          calls.gitUnstage.push(payload || {});
          if (!gitState.available) { return gitDisabled('unstage'); }
          if (!gitState.isRepo) { return gitNotRepo('unstage'); }
          const paths = [].concat((payload && payload.paths) || []);
          for (const file of gitState.files) {
            if (paths.includes(file.path)) {
              file.staged = false;
              file.worktree = file.index === 'A' ? '?' : 'M';
              file.index = ' ';
              file.state = file.worktree === '?' ? 'untracked' : 'modified';
            }
          }
          return gitOk('unstage', { unstaged: paths.length, paths });
        },
        async commit(payload) {
          calls.gitCommit.push(payload || {});
          if (!gitState.available) { return gitDisabled('commit'); }
          if (!gitState.isRepo) { return gitNotRepo('commit'); }
          const message = String((payload && payload.message) || '').trim();
          if (!message) {
            const error = new Error('Commit message is empty.');
            error.code = 'CMP-GIT-0020';
            throw error;
          }
          const staged = gitState.files.filter((file) => file.staged);
          if (!staged.length) {
            return gitOk('commit', { committed: false, reason: 'nothing_to_commit' });
          }
          gitState.lastCommitMessage = message;
          gitState.files = gitState.files.filter((file) => !file.staged);
          return gitOk('commit', { committed: true, shortSha: 'abc1234' });
        },
        async discardFile(payload) {
          calls.gitDiscard.push(payload || {});
          if (!gitState.available) { return gitDisabled('discardFile'); }
          if (!gitState.isRepo) { return gitNotRepo('discardFile'); }
          const path = String((payload && payload.path) || '');
          gitState.files = gitState.files.filter((file) => file.path !== path || file.staged);
          return gitOk('discardFile', { path, discarded: true });
        },
        async getFileAtHead(payload) {
          calls.gitFileAtHead.push(payload || {});
          if (!gitState.available) { return gitDisabled('getFileAtHead'); }
          if (!gitState.isRepo) { return gitNotRepo('getFileAtHead'); }
          const path = String((payload && payload.path) || '');
          if (Object.prototype.hasOwnProperty.call(gitState.head, path)) {
            return gitOk('getFileAtHead', { path, found: true, content: gitState.head[path] });
          }
          return gitOk('getFileAtHead', {
            path,
            found: false,
            reason: gitState.unborn ? 'no_head' : 'not_in_head',
          });
        },
        async getDiff(payload) {
          if (!gitState.available) { return gitDisabled('getDiff'); }
          return gitOk('getDiff', { path: (payload && payload.path) || null, diff: '', truncated: false, containsBinary: false });
        },
        async getLog() {
          if (!gitState.available) { return gitDisabled('getLog'); }
          return gitOk('getLog', { commits: [] });
        },
        async getBranches() {
          if (!gitState.available) { return gitDisabled('getBranches'); }
          return gitOk('getBranches', { branches: [gitState.branch], current: gitState.branch, detached: false, unborn: gitState.unborn });
        },
        async blameRange() {
          if (!gitState.available) { return gitDisabled('blameRange'); }
          return gitOk('blameRange', { found: false, reason: 'not_in_head', lines: [] });
        },
        async checkout(payload) {
          if (!gitState.available) { return gitDisabled('checkout'); }
          return gitOk('checkout', { ref: (payload && payload.ref) || '', created: false, switched: true });
        },
        async stash() {
          if (!gitState.available) { return gitDisabled('stash'); }
          return gitOk('stash', { operation: 'push', stashed: true });
        },
        async undoLastCommit() {
          if (!gitState.available) { return gitDisabled('undoLastCommit'); }
          return gitOk('undoLastCommit', { undone: true });
        },
      },
    },
  };
}

async function settle(ms = 10) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createHarness({ bridgeOptions, turnViewModels = [], featureFlags, workspaceRootService, extraCallbacks = {} } = {}) {
  const { dom, getDom } = buildIdeDom();
  const bridge = createBridgeStub(bridgeOptions);
  const previousWindow = globalThis.window;
  const previousMonacoUtils = globalThis.rendererMonacoEditorUtils;
  globalThis.window = dom.window;
  dom.window.jennyShell = bridge.jennyShell;
  // No Monaco in jsdom (real pure helpers spread through; only the loader is faked).
  globalThis.rendererMonacoEditorUtils = {
    ...require('../../renderer/features/renderer-monaco-editor-utils'),
    async ensureMonacoEditorApi() { return null; },
    normalizeEditorLanguage: () => 'plaintext',
    // The editor host composes the fallback (no-Monaco) diff textarea through
    // monacoUtils; mirror the pure formatter so diff tabs render under jsdom.
    composeFallbackDiffText(doc) {
      if (doc && doc.placeholderText) {
        return doc.placeholderText;
      }
      return [
        '=== Original (before change) ===',
        doc ? doc.original : '',
        '',
        '=== Current ===',
        doc ? doc.modified : '',
      ].join('\n');
    },
  };
  const cleanups = [];
  const toasts = [];
  const infoToasts = [];
  const sentToJenny = [];
  const state = {
    ui: { activeView: 'ide', ide: null },
    currentSessionId: 'session-1',
    workspaceRoot: { rootId: 'root_fake', generation: 1, path: 'G:/fake-root' },
  };
  // Optional flags; unset keeps existing callers all-off.
  if (featureFlags) {
    state.features = { featureFlags: { ...featureFlags } };
  }
  const controller = createIdeController({
    state,
    workspaceRootService: workspaceRootService || {
      async choose(...args) {
        const prepared = await bridge.jennyShell.workspaceRoot.prepareChoose(...args);
        if (prepared?.prepared !== true) {
          return { committed: false, changed: false, canceled: prepared?.canceled === true };
        }
        return bridge.jennyShell.workspaceRoot.commit({ transitionId: prepared.transitionId });
      },
      async clear(...args) {
        const prepared = await bridge.jennyShell.workspaceRoot.prepareClear(...args);
        if (prepared?.prepared !== true) {
          return { committed: false, changed: false, canceled: prepared?.canceled === true };
        }
        return bridge.jennyShell.workspaceRoot.commit({ transitionId: prepared.transitionId });
      },
      getState: (...args) => bridge.jennyShell.workspaceRoot.getState?.(...args),
      captureContext: (...args) => bridge.jennyShell.workspaceRoot.captureContext?.(...args),
    },
    getDom,
    registerCleanup: (fn) => cleanups.push(fn),
    callbacks: {
      appendClientLog: () => {},
      showToastMessage: (message, meta) => infoToasts.push({ message, meta }),
      showShellErrorToast: (message, meta) => toasts.push({ message, meta }),
      toErrorMessage: (error, fallback) => String(error?.message || fallback || ''),
      // W5 changes panel: array or () => array of canonical turn view-models.
      getTurnViewModelsForActiveSession: () => (
        typeof turnViewModels === 'function' ? turnViewModels() : turnViewModels
      ),
      onSendToJenny: (payload) => sentToJenny.push(payload),
      // Optional per-test callback overrides/spies; spread last so a test wins.
      ...extraCallbacks,
    },
  });
  return {
    dom,
    getDom,
    bridge,
    controller,
    state,
    toasts,
    infoToasts,
    sentToJenny,
    dispose() {
      for (const cleanup of cleanups.splice(0)) {
        try { cleanup(); } catch (_error) { /* noop */ }
      }
      globalThis.window = previousWindow;
      globalThis.rendererMonacoEditorUtils = previousMonacoUtils;
    },
  };
}
// Minimal completed file-edit view model for the Jenny change ledger.
function buildChangeTurn({
  turnId = 'turn-1',
  toolCallId = 'tool-1',
  path,
  status = 'modified',
  beforeHash = null,
  afterHash = 'sha256:after',
  additions = 0,
  deletions = 0,
  hunks = [],
  reviewState = null,
  truncated = false,
  truncationReason = null, workspaceId = 'root_fake',
} = {}) {
  return {
    turnId,
    rootMessageIds: { assistant: `${turnId}-assistant` },
    toolCalls: [{
      toolCallId,
      toolName: 'edit_file',
      state: 'completed',
      resultIsError: false,
      resultMetadata: {
        workspace_id: workspaceId,
        diff: {
          path,
          status,
          before_hash: beforeHash,
          after_hash: afterHash,
          additions,
          deletions,
          hunks,
          ...(reviewState ? { review_state: reviewState } : {}),
          truncated,
          truncation_reason: truncationReason,
        },
      },
    }],
  };
}

function findMenuItem(doc, label) {
  return [...doc.body.querySelectorAll('.inv-context-menu-item')]
    .find((item) => item.textContent.includes(label)) || null;
}

function openContextMenu(harness, element) {
  element.dispatchEvent(new harness.dom.window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 12,
    clientY: 24,
  }));
}

function pressKey(harness, element, key) {
  element.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
}

function dispatchInput(harness, input, value) {
  input.value = value;
  input.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
}

module.exports = {
  buildChangeTurn,
  buildIdeDom,
  createBridgeStub,
  createHarness,
  dispatchInput,
  findMenuItem,
  openContextMenu,
  pressKey,
  settle,
};
