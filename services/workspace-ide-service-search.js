/* services/workspace-ide-service-search.js - find-in-files orchestration extracted from
 * WorkspaceIdeService (keeps that file under the 1000-line ceiling). The function takes the
 * service instance and uses its pinned-root plumbing; the scan itself lives in
 * workspace-ide-search.js. */

'use strict';

const { resolveWalkIgnorePolicy } = require('./workspace-ide-ignore-policy');
const { searchWorkspaceFiles } = require('./workspace-ide-search');
const { sanitizeGlobList } = require('../renderer/features/renderer-ide-search-filters');

// Streamed find-in-files over the pinned workspace root; enumeration, byte,
// result, and deadline budgets live in workspace-ide-search.js.
async function searchInFilesForService(service, payload = {}, existingOperation = null) {
  service._activeSearchController?.abort();
  const searchController = new AbortController();
  service._activeSearchController = searchController;
  const query = String(payload.query ?? '');
  // Optional filters: non-array globs are ignored, entries coerced/capped (sanitizeGlobList).
  const wholeWord = payload.wholeWord === true;
  const include = sanitizeGlobList(payload.include);
  const exclude = sanitizeGlobList(payload.exclude);
  try {
    return await service._withRootOperation('read', payload, existingOperation, async (operation) => {
      let scope = '';
      let scopeInvalid = false;
      if (typeof payload.scope === 'string' && payload.scope.trim()) {
        try {
          scope = service._normalizeRelPath(payload.scope.trim());
        } catch (_error) {
          scopeInvalid = true;
        }
      }
      const root = operation.root;
      const ignorePolicy = await resolveWalkIgnorePolicy({
        gitService: service._gitServiceProvider?.(), signal: operation.signal,
        platform: service._platform, extraSkipNames: ['node_modules'],
      });
      const result = await searchWorkspaceFiles({
        root: scopeInvalid ? '' : root.realPath,
        query,
        caseSensitive: payload.caseSensitive === true,
        wholeWord,
        include,
        exclude,
        maxResults: payload.maxResults,
        maxFileBytes: payload.maxFileBytes,
        maxTotalBytes: payload.maxTotalBytes,
        maxFiles: payload.maxFiles,
        maxDirectories: payload.maxDirectories,
        maxEntries: payload.maxEntries,
        maxDurationMs: payload.maxDurationMs,
        scope,
        fs: service._fs,
        path: service._path,
        ignorePolicy,
        resolveDirectory: async (relPath) => {
          await service._rootOperations.revalidateRoot(root, operation);
          if (!relPath) return root.realPath;
          const directory = await service._rootOperations.resolveLeaf(root, relPath, operation);
          return directory.stats?.isDirectory?.() ? directory.realPath : null;
        },
        resolveFile: async (relPath) => {
          const file = await service._rootOperations.resolveLeaf(root, relPath, operation);
          if (!file.stats?.isFile?.()) return null;
          return { filePath: file.operationPath, stats: file.stats, token: file };
        },
        revalidateFile: async (target) => {
          await service._rootOperations.revalidateLeaf(root, target.token, operation);
          return true;
        },
        signal: searchController.signal,
        assertCurrent: () => service._rootOperations.assertCurrent(operation),
        now: service._now,
        onWarning: (reason) => service._log('WARN', 'workspace_fs.search_cleanup_degraded', {
          reason,
        }),
      });
      service._log(result.truncated ? 'WARN' : 'INFO', 'workspace_fs.search', {
        query_length: query.length,
        scoped: Boolean(scope),
        whole_word: wholeWord,
        include_count: include.length,
        exclude_count: exclude.length,
        result_count: result.results.length,
        files_scanned: result.filesScanned,
        directories_scanned: result.directoriesScanned,
        entries_scanned: result.entriesScanned,
        limit_hit: result.limitHit,
        ...(result.truncationReason ? { truncation_reason: result.truncationReason } : {}),
      });
      return {
        ...result,
        rootId: operation.context.rootId,
        generation: operation.context.generation,
      };
    });
  } finally {
    if (service._activeSearchController === searchController) {
      service._activeSearchController = null;
    }
  }
}

module.exports = { searchInFilesForService };
