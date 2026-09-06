'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ToolPathPolicy } = require('../../services/tools/tool-path-policy');
const { normalizeWorkspaceRelPath } = require('../../services/workspace-ide-path-guard');
const { WorkspaceImportService } = require('../../services/workspace-import-service');
const {
  WorkspaceRootOperationManager,
} = require('../../services/workspace-root-operation');
const {
  VERSIONED_WORKSPACE_FILE_ERROR_CODES,
  VersionedWorkspaceFileService,
} = require('../../services/versioned-workspace-file-service');

let importSourceCounter = 0;

function reasonFor(error) {
  return String(error?.code || error?.error_code || error?.message || 'refused');
}

async function realpathForMissing(targetPath) {
  let current = targetPath;
  const trailing = [];
  while (current !== path.dirname(current)) {
    try {
      let resolved = await fsp.realpath(current);
      for (let index = trailing.length - 1; index >= 0; index -= 1) {
        resolved = path.join(resolved, trailing[index]);
      }
      return resolved;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      trailing.push(path.basename(current));
      current = path.dirname(current);
    }
  }
  return path.resolve(targetPath);
}

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return !relative
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function createRootContext(rootDir) {
  const context = Object.freeze({
    rootPath: rootDir,
    rootId: 'path-guard-parity-root',
    generation: 1,
    phase: 'ready',
  });
  const coordinator = {
    captureContext: () => context,
    isCurrent: (candidate) => candidate === context,
    acquireOperation({ kind, cancellable = false } = {}) {
      let released = false;
      return {
        acquired: true,
        operationId: `parity-${kind || 'read'}`,
        context,
        signal: new AbortController().signal,
        kind,
        cancellable,
        release() {
          if (released) return false;
          released = true;
          return true;
        },
        isCurrent: () => !released && coordinator.isCurrent(context),
      };
    },
  };
  return coordinator;
}

function scenarioFor(value) {
  return value && typeof value === 'object'
    ? value
    : { requested: value, mutate: null };
}

function buildAdapters({ rootDir }) {
  const context = { workingDirectory: rootDir };
  const rootContext = createRootContext(rootDir);
  const rootRealPromise = fsp.realpath(rootDir);
  const policy = new ToolPathPolicy({ fs: fsp, path });
  const rootOperations = new WorkspaceRootOperationManager({
    rootContextProvider: () => rootContext,
    fs: fsp,
    path,
  });
  importSourceCounter += 1;
  const importSource = `.workspace-import-parity-source-${importSourceCounter}.txt`;
  fs.writeFileSync(path.join(rootDir, importSource), 'parity', { encoding: 'utf8', flag: 'wx' });

  return [
    {
      name: 'ide-path-guard',
      async resolve(value) {
        try {
          return {
            allowed: true,
            normalized: normalizeWorkspaceRelPath(value, { strictName: true }),
          };
        } catch (error) {
          return { allowed: false, reason: reasonFor(error) };
        }
      },
    },
    {
      name: 'tool-path-policy',
      async resolve(value) {
        const { requested, mutate } = scenarioFor(value);
        try {
          const resolvedPath = policy.resolvePath(requested, context);
          let realPath = await policy.assertInsideRoot(resolvedPath, context);
          let postMutationEscape = false;
          if (typeof mutate === 'function') {
            await mutate();
            realPath = await fsp.realpath(resolvedPath);
            postMutationEscape = !isInside(await rootRealPromise, realPath);
          }
          return { allowed: true, realPath, postMutationEscape };
        } catch (error) {
          return { allowed: false, reason: reasonFor(error) };
        }
      },
    },
    {
      name: 'root-operation',
      async resolve(value) {
        const { requested, mutate } = scenarioFor(value);
        let operation = null;
        try {
          operation = rootOperations.acquire({ kind: 'read' });
          const root = await rootOperations.prepareRoot(operation);
          const leaf = await rootOperations.resolveLeaf(root, requested, operation, {
            allowMissing: true,
          });
          if (typeof mutate === 'function') {
            await mutate();
            const revalidated = await rootOperations.revalidateLeaf(root, leaf, operation);
            if (typeof revalidated.currentRealPath === 'string') {
              leaf.realPath = revalidated.currentRealPath;
            }
          }
          return { allowed: true, realPath: leaf.realPath };
        } catch (error) {
          return { allowed: false, reason: reasonFor(error) };
        } finally {
          operation?.release();
        }
      },
    },
    {
      name: 'versioned-file',
      async resolve(value) {
        const { requested, mutate } = scenarioFor(value);
        let mutated = false;
        const service = new VersionedWorkspaceFileService({
          rootContext,
          hooks: {
            async afterTargetOpen() {
              if (mutated || typeof mutate !== 'function') return;
              mutated = true;
              await mutate();
            },
          },
        });
        try {
          const result = await service.readText({ path: requested });
          const realPath = await fsp.realpath(
            path.resolve(rootDir, ...result.path.split('/'))
          );
          return { allowed: true, realPath };
        } catch (error) {
          if (error?.code !== VERSIONED_WORKSPACE_FILE_ERROR_CODES.NOT_FOUND) {
            return { allowed: false, reason: reasonFor(error) };
          }
          try {
            const normalized = String(requested).trim().replace(/\\/g, '/');
            const candidate = path.resolve(rootDir, ...normalized.split('/'));
            const [rootReal, realPath] = await Promise.all([
              rootRealPromise,
              realpathForMissing(candidate),
            ]);
            if (!isInside(rootReal, realPath)) {
              return { allowed: false, reason: `${error.code}:outside_ancestor` };
            }
            return { allowed: true, realPath };
          } catch (resolutionError) {
            return { allowed: false, reason: reasonFor(resolutionError) };
          }
        }
      },
    },
    {
      name: 'workspace-import',
      async resolve(value) {
        const { requested, mutate } = scenarioFor(value);
        let mutated = false;
        const service = new WorkspaceImportService({
          rootContextProvider: () => rootContext,
          fs: fsp,
          path,
          isQolEnabled: () => true,
          hooks: {
            async beforeLeafMutation() {
              if (mutated || typeof mutate !== 'function') return;
              mutated = true;
              await mutate();
            },
          },
        });
        try {
          const result = await service.copyEntry({
            from: importSource,
            to: requested,
            onCollision: 'fail',
          });
          return {
            allowed: true,
            realPath: await fsp.realpath(path.resolve(rootDir, ...result.to.split('/'))),
          };
        } catch (error) {
          return { allowed: false, reason: reasonFor(error) };
        }
      },
    },
  ];
}

const BASE_CASES = [
  {
    id: 'relative-parent-escape',
    description: '../ relative escape to an existing outside file',
    setup(rootDir, outsideDir) {
      const target = path.join(outsideDir, 'outside.txt');
      fs.writeFileSync(target, 'outside', 'utf8');
      return path.relative(rootDir, target).replace(/\\/g, '/');
    },
    expected: {
      'tool-path-policy': 'reject',
      'root-operation': 'reject',
      'versioned-file': 'reject',
    },
    universal: 'never_escape',
  },
  {
    id: 'relative-nested-escape',
    description: 'nested a/../../ escape to an existing outside file',
    setup(rootDir, outsideDir) {
      fs.mkdirSync(path.join(rootDir, 'a'));
      const target = path.join(outsideDir, 'outside.txt');
      fs.writeFileSync(target, 'outside', 'utf8');
      return `a/../../${path.basename(outsideDir)}/outside.txt`;
    },
    expected: {
      'tool-path-policy': 'reject',
      'root-operation': 'reject',
      'versioned-file': 'reject',
    },
    universal: 'never_escape',
  },
  {
    id: 'backslash-only-escape',
    description: 'backslash-only relative escape to an existing outside file',
    setup(rootDir, outsideDir) {
      const target = path.join(outsideDir, 'outside.txt');
      fs.writeFileSync(target, 'outside', 'utf8');
      return path.relative(rootDir, target).replace(/\//g, '\\');
    },
    expected: {
      'tool-path-policy': 'reject_or_allow',
      'root-operation': 'reject_or_allow',
      'versioned-file': 'reject',
    },
    universal: 'never_escape',
  },
  {
    id: 'absolute-outside',
    description: 'absolute path to an existing file outside the workspace',
    setup(_rootDir, outsideDir) {
      const target = path.join(outsideDir, 'outside.txt');
      fs.writeFileSync(target, 'outside', 'utf8');
      return target;
    },
    expected: {
      'tool-path-policy': 'reject',
      'root-operation': 'reject_or_allow',
      'versioned-file': 'reject',
    },
    universal: 'never_escape',
  },
  {
    id: 'absolute-inside',
    description: 'absolute path to an existing file inside the workspace',
    setup(rootDir) {
      const target = path.join(rootDir, 'inside.txt');
      fs.writeFileSync(target, 'inside', 'utf8');
      return target;
    },
    expected: {
      'tool-path-policy': 'allow',
      'root-operation': 'reject_or_allow',
      'versioned-file': 'reject',
    },
    universal: 'never_escape',
  },
  {
    id: 'win32-drive-absolute',
    description: 'drive-letter absolute path',
    win32Only: true,
    setup() {
      return 'C:\\Windows\\system32';
    },
    expected: {
      'tool-path-policy': 'reject',
      'root-operation': 'allow',
      'versioned-file': 'reject',
    },
    universal: 'never_escape',
  },
  {
    id: 'win32-drive-relative',
    description: 'drive-relative path',
    win32Only: true,
    setup() {
      return 'C:foo';
    },
    expected: {
      'tool-path-policy': 'reject_or_allow',
      'root-operation': 'allow',
      'versioned-file': 'reject',
    },
    universal: 'never_escape',
  },
  {
    id: 'win32-unc',
    description: 'UNC path',
    win32Only: true,
    setup() {
      return '\\\\localhost\\jenny-path-guard-parity-missing\\x';
    },
    expected: {
      'tool-path-policy': 'reject',
      'root-operation': 'allow',
      'versioned-file': 'reject',
    },
    universal: 'never_escape',
  },
  {
    id: 'linked-directory-escape',
    description: 'directory link inside root points to an outside file',
    setup(rootDir, outsideDir) {
      const link = path.join(rootDir, 'link');
      fs.writeFileSync(path.join(outsideDir, 'file.txt'), 'outside', 'utf8');
      try {
        fs.symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        return { skip: `directory-link creation unavailable: ${error.code || error.message}` };
      }
      return 'link/file.txt';
    },
    expected: {
      'tool-path-policy': 'reject',
      'root-operation': 'reject',
      'versioned-file': 'reject',
    },
    universal: 'never_escape',
  },
  {
    id: 'junction-swap-mid-operation',
    description: 'validated in-root parent is swapped for an outside directory link',
    setup(rootDir, outsideDir) {
      const parent = path.join(rootDir, 'swap');
      const displaced = path.join(rootDir, 'swap-original');
      const probe = path.join(rootDir, 'link-probe');
      fs.mkdirSync(parent);
      fs.writeFileSync(path.join(parent, 'file.txt'), 'inside', 'utf8');
      fs.writeFileSync(path.join(outsideDir, 'file.txt'), 'outside', 'utf8');
      try {
        fs.symlinkSync(outsideDir, probe, process.platform === 'win32' ? 'junction' : 'dir');
        if (process.platform === 'win32') fs.rmdirSync(probe);
        else fs.unlinkSync(probe);
      } catch (error) {
        return { skip: `directory-link swap unavailable: ${error.code || error.message}` };
      }
      return {
        requested: 'swap/file.txt',
        mutate() {
          fs.renameSync(parent, displaced);
          fs.symlinkSync(outsideDir, parent, process.platform === 'win32' ? 'junction' : 'dir');
        },
      };
    },
    expected: {
      'tool-path-policy': 'allow',
      'root-operation': 'reject',
      'versioned-file': 'reject',
    },
    expectedEscape: ['tool-path-policy'],
    universal: 'never_escape',
  },
  ...[
    ['win32-trailing-dot', 'evil.'],
    ['win32-trailing-space', 'evil '],
    ['win32-trailing-dots', 'evil...'],
  ].map(([id, requested]) => ({
    id,
    description: `Win32 trailing-dot/space alias ${JSON.stringify(requested)}`,
    win32Only: true,
    setup(rootDir) {
      fs.writeFileSync(path.join(rootDir, 'evil'), 'inside', 'utf8');
      return requested;
    },
    expected: {
      'tool-path-policy': 'allow',
      'root-operation': 'allow',
      'versioned-file': 'allow',
    },
    universal: 'never_escape',
  })),
  {
    id: 'win32-short-name-alias',
    description: '8.3 short-name alias of a long in-root directory',
    win32Only: true,
    setup() {
      // realpathSync.native expands aliases but cannot derive an 8.3 alias. The
      // contract forbids fsutil, so this row remains explicit and skip-by-default.
      return { skip: '8.3 alias derivation unavailable without shelling out' };
    },
    expected: {
      'tool-path-policy': 'reject_or_allow',
      'root-operation': 'reject_or_allow',
      'versioned-file': 'reject_or_allow',
    },
    universal: 'never_escape',
  },
  {
    id: 'symlink-parent-missing-leaf',
    description: 'outside directory link with a not-yet-existing leaf',
    setup(rootDir, outsideDir) {
      const link = path.join(rootDir, 'missing-link');
      try {
        fs.symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        return { skip: `directory-link creation unavailable: ${error.code || error.message}` };
      }
      return 'missing-link/new-file.txt';
    },
    expected: {
      'tool-path-policy': 'reject',
      'root-operation': 'reject',
      'versioned-file': 'reject',
    },
    universal: 'never_escape',
  },
  {
    id: 'win32-case-only-variant',
    description: 'case-only path variant resolves to the same in-root file',
    win32Only: true,
    setup(rootDir) {
      fs.mkdirSync(path.join(rootDir, 'src'));
      fs.writeFileSync(path.join(rootDir, 'src', 'file.txt'), 'inside', 'utf8');
      return 'SRC/file.txt';
    },
    expected: {
      'tool-path-policy': 'allow',
      'root-operation': 'allow',
      'versioned-file': 'allow',
    },
    universal: 'never_escape',
  },
];

const CASES = BASE_CASES.map((parityCase) => ({
  ...parityCase,
  expected: { ...parityCase.expected, 'workspace-import': 'reject' },
}));

const NAME_CASES = [
  ['colon', 'foo:bar', 'reject'],
  ['reserved-con', 'con', 'reject'],
  ['reserved-con-extension', 'CON.txt', 'reject'],
  ['reserved-lpt-extension', 'lpt9.log', 'reject'],
  ['reserved-aux-multiple-extensions', 'aux.tar.gz', 'reject'],
  ['trailing-period', 'evil.', 'reject'],
  ['trailing-space', 'evil ', 'reject'],
  ['double-quote', 'a".txt', 'reject'],
  ['less-than', 'a<b', 'reject'],
  ['pipe', 'a|b', 'reject'],
  ['too-long', 'a'.repeat(256), 'reject'],
  ['collision-suffix', 'report (2).xlsx', 'allow'],
  ['dotfile', '.env', 'allow'],
  ['multiple-extensions', 'ok.name.txt', 'allow'],
  ['illegal-parent-legal-leaf', 'foo:bar/ok.txt', 'allow'],
  ['drive-like-parent', 'a:b/ok.txt', 'reject'],
  ['com-zero', 'COM0', 'allow'],
  ['com-ten', 'COM10', 'allow'],
  ['reserved-prefix-word', 'console.log', 'allow'],
].map(([id, candidate, outcome]) => ({
  id,
  candidate,
  expected: { 'ide-path-guard': outcome },
}));

module.exports = {
  buildAdapters,
  CASES,
  NAME_CASES,
};
