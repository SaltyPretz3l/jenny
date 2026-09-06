/* renderer/features/renderer-ide-exploded-graph.js - async orchestration for
 * the Workspace IDE "Exploded View": a node-graph of one source file's
 * functions, data, and imports, wired together by call/read/import edges.
 *
 * All the deterministic logic (nav-tree walk, classification, import/export
 * scans, containment index, prune/degree/zone/rank/layout) lives in the pure
 * sibling module renderer-ide-exploded-graph-utils.js. This file owns only:
 *   - resolving the TS/JS language worker (cloning the getWorker(model.uri)
 *     pattern from renderer-ide-symbol-nav.js's navTreeForModel), or accepting
 *     an injected workerClient for tests / non-Monaco callers;
 *   - the reference-query fan-out (getDocumentHighlights, falling back to
 *     getReferencesAtPosition) that turns each surviving symbol into call/
 *     read/import edges, bounded to CONCURRENCY in-flight queries per chunk;
 *   - never throwing - every worker call and every precondition check
 *     degrades to an empty, diagnosable result instead.
 *
 * Public API: buildExplodedGraph({ monacoApi, model, workerClient, getText,
 * symbolCap, isCancelled }) -> Promise<{ nodes, edges, diagnostics }>. See the
 * module docstring in the utils sibling for the full node/edge/diagnostics
 * schema this assembles.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-ide-exploded-graph-utils'));
    return;
  }
  root.rendererIdeExplodedGraph = factory(root.rendererIdeExplodedGraphUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (utils) {
  'use strict';

  const DEFAULT_SYMBOL_CAP = 150;

  // Bounded fan-out for the per-symbol reference queries (step 8). Kept well
  // under typical TS-worker request-queue limits so a large file's wiring
  // pass can't starve other worker consumers (e.g. live diagnostics).
  const CONCURRENCY = 24;

  function emptyEmitted() {
    return { functions: 0, methods: 0, data: 0, imports: 0 };
  }

  function makeDiagnostics(overrides) {
    return Object.assign({
      parsed: false,
      workerAvailable: false,
      language: null,
      symbolCount: 0,
      emitted: emptyEmitted(),
      truncated: false,
      symbolCap: DEFAULT_SYMBOL_CAP,
      unresolvedRefs: 0,
      degraded: true,
      reason: null,
      durationMs: 0,
    }, overrides || {});
  }

  function degradeResult(reason, extra) {
    return { nodes: [], edges: [], diagnostics: makeDiagnostics(Object.assign({ reason }, extra || {})) };
  }

  // Accepts either a real Monaco model, a minimal fake model object
  // ({ uri, getLanguageId, isDisposed, getValue }), or a bare uri string (test
  // path, language inferred from the extension).
  function resolveTarget(model) {
    if (typeof model === 'string') {
      return { uriStr: model, language: utils.inferLanguageFromUri(model), disposed: false };
    }
    if (model && typeof model === 'object') {
      let uriStr = '';
      if (model.uri && typeof model.uri.toString === 'function') uriStr = model.uri.toString();
      else if (typeof model.uri === 'string') uriStr = model.uri;
      const language = typeof model.getLanguageId === 'function'
        ? model.getLanguageId()
        : utils.inferLanguageFromUri(uriStr);
      const disposed = typeof model.isDisposed === 'function' ? Boolean(model.isDisposed()) : false;
      return { uriStr, language, disposed };
    }
    return { uriStr: '', language: null, disposed: false };
  }

  // Clone of renderer-ide-symbol-nav.js's navTreeForModel worker-resolution
  // pattern: pick getJavaScriptWorker/getTypeScriptWorker by language, await
  // the factory, then await getWorker(model.uri) to force-sync the model
  // before any client method is called.
  async function resolveWorkerClient(monacoApi, model, language) {
    if (!monacoApi || !model || typeof model !== 'object') return null;
    const namespace = monacoApi.languages && monacoApi.languages.typescript;
    if (!namespace) return null;
    const factory = language === 'javascript' ? namespace.getJavaScriptWorker : namespace.getTypeScriptWorker;
    if (typeof factory !== 'function') return null;
    let getWorker;
    try {
      getWorker = await factory.call(namespace);
    } catch (_error) {
      return null;
    }
    if (typeof getWorker !== 'function') return null;
    try {
      return await getWorker(model.uri);
    } catch (_error) {
      return null;
    }
  }

  // getDocumentHighlights(uri, pos, [uri]) -> [{fileName, highlightSpans:[{textSpan,kind}]}].
  // Definitions are excluded here (the caller only wants reference sites).
  function flattenHighlights(highlights, uriStr) {
    if (!Array.isArray(highlights)) return null;
    const spans = [];
    for (const entry of highlights) {
      if (!entry || (entry.fileName && entry.fileName !== uriStr)) continue;
      const highlightSpans = Array.isArray(entry.highlightSpans) ? entry.highlightSpans : [];
      for (const span of highlightSpans) {
        if (!span || span.kind === 'definition') continue;
        const textSpan = span.textSpan || {};
        if (!Number.isFinite(textSpan.start)) continue;
        spans.push({ start: textSpan.start, length: Number(textSpan.length) || 0, isWrite: span.kind === 'writtenReference' });
      }
    }
    return spans;
  }

  // getReferencesAtPosition(uri, pos) fallback -> ReferenceEntry[]. Filters to
  // this file, drops string-literal false positives, and drops the
  // declaration site itself (textSpan.start === nameOffset).
  function filterReferences(raw, uriStr, nameOffset) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
      if (!entry) continue;
      if (entry.fileName && entry.fileName !== uriStr) continue;
      if (entry.isInString) continue;
      const textSpan = entry.textSpan || {};
      if (!Number.isFinite(textSpan.start)) continue;
      if (textSpan.start === nameOffset) continue;
      out.push({ start: textSpan.start, length: Number(textSpan.length) || 0, isWrite: Boolean(entry.isWriteAccess) });
    }
    return out;
  }

  async function queryReferenceSites(client, uriStr, target) {
    let spans = null;
    if (typeof client.getDocumentHighlights === 'function') {
      try {
        const highlights = await client.getDocumentHighlights(uriStr, target.nameOffset, [uriStr]);
        spans = flattenHighlights(highlights, uriStr);
      } catch (_error) {
        spans = null;
      }
    }
    if (spans && spans.length) return spans;
    if (typeof client.getReferencesAtPosition === 'function') {
      try {
        const raw = await client.getReferencesAtPosition(uriStr, target.nameOffset);
        return filterReferences(raw, uriStr, target.nameOffset);
      } catch (_error) {
        return [];
      }
    }
    return spans || [];
  }

  // target function/method: 'call' if the reference site is immediately
  // followed by '(' (a value-ref, e.g. passing the function around, is
  // dropped in v1). target import: always 'import'. target data: always
  // 'read'.
  function edgeKindFor(target, text, refOffset, refLength) {
    if (target.kind === 'import') return 'import';
    if (target.kind === 'function' || target.kind === 'method') {
      return utils.charAfterIsOpenParen(text, refOffset + refLength) ? 'call' : null;
    }
    if (target.kind === 'data') return 'read';
    return null;
  }

  async function wireEdges({ client, uriStr, text, targets, resolveContainer, isCancelledFn }) {
    const edgeMap = new Map();
    let unresolvedRefs = 0;

    function accumulate(from, to, kind, isWrite) {
      const key = `${from}|${to}|${kind}`;
      let entry = edgeMap.get(key);
      if (!entry) {
        entry = { from, to, kind, weight: 0, write: false };
        edgeMap.set(key, entry);
      }
      entry.weight += 1;
      if (isWrite) entry.write = true;
    }

    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      if (isCancelledFn()) break;
      const chunk = targets.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(async (target) => ({
        target,
        refs: await queryReferenceSites(client, uriStr, target),
      })));
      for (const { target, refs } of results) {
        for (const ref of refs) {
          const user = resolveContainer(ref.start);
          if (!user) { unresolvedRefs += 1; continue; }
          if (user.id === target.id) continue;
          const kind = edgeKindFor(target, text, ref.start, ref.length);
          if (!kind) continue;
          accumulate(user.id, target.id, kind, kind === 'read' && ref.isWrite === true);
        }
      }
      if (isCancelledFn()) break;
    }

    const edges = Array.from(edgeMap.values()).map((e) => (
      e.kind === 'read' ? e : { from: e.from, to: e.to, kind: e.kind, weight: e.weight }
    ));
    return { edges, unresolvedRefs };
  }

  /**
   * buildExplodedGraph({ monacoApi, model, workerClient, getText, symbolCap,
   * isCancelled }) -> Promise<{ nodes, edges, diagnostics }>.
   *
   * Prod path: pass monacoApi + a real Monaco model; the worker is resolved
   * via the symbol-nav getWorker(model.uri) pattern.
   * Test path: pass workerClient + getText + (a fake model object or a bare
   * uri string) - no Monaco required.
   *
   * Never throws: every precondition gap or worker failure degrades to
   * { nodes: [], edges: [], diagnostics: { parsed:false, ..., reason } }.
   */
  async function buildExplodedGraph(options) {
    const opts = options || {};
    const started = Date.now();
    const symbolCap = Number.isFinite(opts.symbolCap) && opts.symbolCap > 0 ? opts.symbolCap : DEFAULT_SYMBOL_CAP;
    const isCancelledFn = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;

    try {
      const { uriStr, language, disposed } = resolveTarget(opts.model);
      const suppliedText = typeof opts.getText === 'function' ? opts.getText() : null;
      const text = typeof opts.getText === 'function'
        ? String(suppliedText == null ? '' : suppliedText)
        : (opts.model && typeof opts.model.getValue === 'function' ? String(opts.model.getValue()) : '');

      if (!utils.isSupportedLanguage(language)) {
        return degradeResult('unsupported-language', { language, symbolCap, durationMs: Date.now() - started });
      }
      if (!uriStr || disposed) {
        return degradeResult('no-worker', { language, symbolCap, durationMs: Date.now() - started });
      }

      let client = opts.workerClient || null;
      if (!client) {
        client = await resolveWorkerClient(opts.monacoApi, opts.model, language);
      }
      if (!client || typeof client.getNavigationTree !== 'function') {
        return degradeResult('no-worker', { language, symbolCap, durationMs: Date.now() - started });
      }

      let tree = null;
      try {
        tree = await client.getNavigationTree(uriStr);
      } catch (_error) {
        tree = null;
      }
      if (!tree) {
        return degradeResult('parse-failed', { language, workerAvailable: true, symbolCap, durationMs: Date.now() - started });
      }

      const allNodes = utils.buildSymbolNodes(tree, text);
      const { survivors, truncated } = utils.applySymbolCap(allNodes, symbolCap);
      const resolveContainer = utils.createContainerResolver(survivors);

      const { edges, unresolvedRefs } = await wireEdges({
        client, uriStr, text, targets: survivors, resolveContainer, isCancelledFn,
      });

      const finalGraph = utils.finalizeGraph(survivors, edges);

      const emitted = emptyEmitted();
      finalGraph.nodes.forEach((n) => {
        if (n.kind === 'function') emitted.functions += 1;
        else if (n.kind === 'method') emitted.methods += 1;
        else if (n.kind === 'data') emitted.data += 1;
        else if (n.kind === 'import') emitted.imports += 1;
      });

      return {
        nodes: finalGraph.nodes,
        edges: finalGraph.edges,
        diagnostics: makeDiagnostics({
          parsed: true,
          workerAvailable: true,
          language,
          symbolCount: allNodes.length,
          emitted,
          truncated,
          symbolCap,
          unresolvedRefs,
          degraded: false,
          reason: truncated ? 'symbol-cap' : null,
          durationMs: Date.now() - started,
        }),
      };
    } catch (_error) {
      return degradeResult('internal-error', { symbolCap, durationMs: Date.now() - started });
    }
  }

  return { buildExplodedGraph };
});
