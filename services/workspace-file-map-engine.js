'use strict';

// Workspace File Map — engine core.
//
// Pure, DOM-free, IPC-free. Given the list of workspace files, a sync content
// reader, raw co-change commit data, and optional tsconfig aliases, build a
// dependency graph (nodes + import/cochange edges), score node importance,
// surface findings (hubs/cycles/orphans), lay nodes out on a deterministic
// grid, and answer neighbor/dependents/dependencies/hubs queries.
//
// The scanner accuracy layer (specifier extraction + resolution) is the frozen
// dependency `workspace-file-map-scan-rules.js`; this module owns the graph
// aggregation, scoring, findings, layout, and query algorithms on top of it.
//
// All workspace paths are POSIX-style (forward slash), relative to the
// workspace root, with no leading "./".

const {
  extract,
  resolveSpecifier,
  EMPTY_ALIASES,
} = require('./workspace-file-map-scan-rules');

// ---------------------------------------------------------------------------
// Named constants (exported for test assertions)
// ---------------------------------------------------------------------------

// Import inbound degree is the strongest structural importance signal;
// co-change coupling is a secondary signal (and the ONLY signal in a repo with
// no resolvable imports, e.g. the renderer's own case); LOC is a small
// tiebreak so two structurally-equivalent nodes still order deterministically.
// Weights sum to 1.0 so the blended score is a weighted average of the three
// normalized [0,1] signals before the final min-max renormalization.
const IMPORTANCE_WEIGHTS = Object.freeze({
  importDegree: 0.6,
  cochangeDegree: 0.3,
  loc: 0.1,
});

// A file pair must co-occur in at least this many commits before we treat it
// as a real co-change relationship (filters one-off incidental co-edits).
const COCHANGE_MIN = 2;

// Default number of top-importance nodes reported as hubs.
const HUB_COUNT = 5;

// Maximum number of distinct import cycles reported by findings(). A pathological
// densely-cyclic graph could otherwise emit an unbounded list; 20 is enough to
// surface the structural problem without flooding the output.
const MAX_CYCLES = 20;

// Deterministic layout grid constants. Exact pixel values are not
// corpus-critical — the renderer re-derives positions later — but the layout
// ALGORITHM must be deterministic (same input -> byte-identical output).
const COLUMN_WIDTH = 220;
const ROW_HEIGHT = 90;
const OFFSET_HEIGHT = 24;

// Importance is rounded to this many decimal places so the corpus float
// comparison is stable across floating-point drift.
const IMPORTANCE_PRECISION = 4;

const DEFAULT_BUILD_BUDGETS = Object.freeze({
  maxNodes: 20_000,
  maxEdges: 50_000,
  maxCochangePairs: 100_000,
  maxFilesPerCommit: 256,
});

function boundedInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, fallback);
}

function normalizeBuildBudgets(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    maxNodes: boundedInteger(raw.maxNodes, DEFAULT_BUILD_BUDGETS.maxNodes),
    maxEdges: boundedInteger(raw.maxEdges, DEFAULT_BUILD_BUDGETS.maxEdges),
    maxCochangePairs: boundedInteger(raw.maxCochangePairs, DEFAULT_BUILD_BUDGETS.maxCochangePairs),
    maxFilesPerCommit: boundedInteger(raw.maxFilesPerCommit, DEFAULT_BUILD_BUDGETS.maxFilesPerCommit),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function basename(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

// TOP-LEVEL path segment. 'src' for 'src/a/b.js'; '.' for a root-level file
// like 'index.js'. This is the value layout() clusters into columns.
function topLevelDir(relPath) {
  const idx = relPath.indexOf('/');
  return idx === -1 ? '.' : relPath.slice(0, idx);
}

// isTest heuristic: true when the relPath either matches the test/spec suffix
// pattern (`.test.js`, `.spec.tsx`, etc.) OR contains a path segment named
// `__tests__` or `tests` (case-insensitive). Documented so the corpus
// fixtures can be reasoned about by hand.
const TEST_SUFFIX_RE = /\.(test|spec)\.[jt]sx?$/i;
function isTestPath(relPath) {
  if (TEST_SUFFIX_RE.test(relPath)) return true;
  const segments = relPath.split('/');
  return segments.some((seg) => {
    const lower = seg.toLowerCase();
    return lower === '__tests__' || lower === 'tests';
  });
}

// Exact line count: split on \n. An empty string is 0 lines. A non-empty
// string with a trailing newline has its lines counted by the \n-split minus
// the trailing empty element; a non-empty string with no trailing newline
// counts the final partial line too. Implemented directly so it stays exact.
function countLines(content) {
  if (typeof content !== 'string' || content.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') count += 1;
  }
  // A trailing newline means the last increment counted a phantom empty line.
  if (content[content.length - 1] === '\n') count -= 1;
  return count;
}

function edgeKey(from, to, kind) {
  return `${from}\0${to}\0${kind}`;
}

// ---------------------------------------------------------------------------
// Co-change edge aggregation
// ---------------------------------------------------------------------------

/**
 * From raw commit/changed-file pairs, count how many commits each unordered
 * file pair co-occurs in, then emit a canonical-direction cochange edge for
 * every pair meeting COCHANGE_MIN. Only pairs where BOTH files are real nodes
 * (present in nodeIds) are considered — a commit touching a file outside the
 * current file list contributes nothing for that file.
 * @returns {Array<{from, to, kind:'cochange', weight:number}>}
 */
function buildCochangeEdges(cochangeCommits, nodeIds, limits, budgetState) {
  const pairCounts = new Map(); // "a\0b" (a<b) -> sharedCount
  const commits = Array.isArray(cochangeCommits) ? cochangeCommits : [];

  for (const commit of commits) {
    const rawFiles = commit && Array.isArray(commit.files) ? commit.files : [];
    // Dedup + restrict to real nodes, then sort so pair canonicalization is stable.
    const files = Array.from(new Set(rawFiles)).filter((f) => nodeIds.has(f)).sort();
    if (files.length > limits.maxFilesPerCommit) {
      budgetState.bulkCommitsSkipped += 1;
      budgetState.truncationReasons.add('bulk_commit_skipped');
      continue;
    }
    for (let i = 0; i < files.length; i += 1) {
      for (let j = i + 1; j < files.length; j += 1) {
        if (budgetState.cochangePairsConsidered >= limits.maxCochangePairs) {
          budgetState.truncationReasons.add('cochange_pair_limit');
          break;
        }
        budgetState.cochangePairsConsidered += 1;
        const a = files[i];
        const b = files[j];
        // files is sorted, so a < b already; canonical from<to holds.
        const key = `${a}\0${b}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
      if (budgetState.truncationReasons.has('cochange_pair_limit')) break;
    }
    if (budgetState.truncationReasons.has('cochange_pair_limit')) break;
  }

  const edges = [];
  for (const [key, sharedCount] of pairCounts.entries()) {
    if (sharedCount < COCHANGE_MIN) continue;
    if (edges.length >= limits.maxEdges) {
      budgetState.truncationReasons.add('edge_limit');
      break;
    }
    const [from, to] = key.split('\0');
    edges.push({ from, to, kind: 'cochange', weight: sharedCount });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Import edge extraction
// ---------------------------------------------------------------------------

/**
 * Extract + resolve every import-like specifier in `content` originating from
 * `relPath`, returning resolved target relPaths and a count of external
 * (unresolvable/bare) specifiers. Non-literal / empty specifiers that the
 * scanner never produced as a real specifier are simply absent from extract()'s
 * output, so they neither resolve nor bump externalRefs.
 * @returns {{ targets: string[], externalRefs: number }}
 */
function resolveImportsForFile(relPath, content, fileSet, aliases) {
  const specifiers = extract(relPath, content);
  const targets = [];
  let externalRefs = 0;

  for (const spec of specifiers) {
    const resolved = resolveSpecifier({
      fromPath: relPath,
      specifier: spec.raw,
      fileSet,
      aliases,
    });
    if (resolved && fileSet.has(resolved)) {
      // A file importing itself is not a meaningful edge; skip self-loops.
      if (resolved !== relPath) targets.push(resolved);
    } else {
      // Bare / unresolvable / external specifier.
      externalRefs += 1;
    }
  }

  return { targets, externalRefs };
}

// ---------------------------------------------------------------------------
// Importance scoring
// ---------------------------------------------------------------------------

/**
 * Blend normalized import-inbound-degree + normalized cochangeDegree +
 * normalized LOC into a per-node importance in [0,1]. Min-max normalize each
 * signal across the node set first (so signals are comparable), take the
 * weighted average, then min-max normalize the blended scores to [0,1].
 *
 * Callable standalone on a hand-built { nodes, edges } graph; idempotent
 * (recomputes purely from node.inbound / node.cochangeDegree / node.loc, so
 * running twice yields identical numbers). When every signal is flat (or the
 * graph is empty/trivial) importance is 0 for every node — never NaN.
 */
function computeImportance(graph) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (nodes.length === 0) return graph;

  const importDegrees = nodes.map((n) => Number(n.inbound) || 0);
  const cochangeDegrees = nodes.map((n) => Number(n.cochangeDegree) || 0);
  const locs = nodes.map((n) => Number(n.loc) || 0);

  const normalize = (values) => {
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min;
    // All equal (including all-zero) -> every normalized value is 0. This is
    // what makes a flat signal contribute nothing rather than a divide-by-zero.
    if (span === 0) return values.map(() => 0);
    return values.map((v) => (v - min) / span);
  };

  const nImport = normalize(importDegrees);
  const nCochange = normalize(cochangeDegrees);
  const nLoc = normalize(locs);

  const blended = nodes.map((_, i) => (
    IMPORTANCE_WEIGHTS.importDegree * nImport[i]
    + IMPORTANCE_WEIGHTS.cochangeDegree * nCochange[i]
    + IMPORTANCE_WEIGHTS.loc * nLoc[i]
  ));

  // Final min-max normalization to [0,1] across the blended scores.
  const finalNorm = normalize(blended);

  for (let i = 0; i < nodes.length; i += 1) {
    nodes[i].importance = roundImportance(finalNorm[i]);
  }
  return graph;
}

function roundImportance(value) {
  const factor = 10 ** IMPORTANCE_PRECISION;
  // Guard against -0 and floating noise.
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

// ---------------------------------------------------------------------------
// Findings: hubs, cycles, orphans
// ---------------------------------------------------------------------------

function buildImportAdjacency(nodes, edges) {
  const forward = new Map(); // from -> Set(to)
  const backward = new Map(); // to -> Set(from)
  for (const node of nodes) {
    forward.set(node.id, new Set());
    backward.set(node.id, new Set());
  }
  for (const edge of edges) {
    if (edge.kind !== 'import') continue;
    if (!forward.has(edge.from) || !forward.has(edge.to)) continue;
    forward.get(edge.from).add(edge.to);
    backward.get(edge.to).add(edge.from);
  }
  return { forward, backward };
}

/**
 * Top `limit` node ids by importance descending; ties broken by id string
 * compare for determinism. Never exceeds available node count.
 */
function topHubs(nodes, limit) {
  const sorted = nodes.slice().sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted.slice(0, Math.min(limit, sorted.length)).map((n) => n.id);
}

/**
 * Detect cycles in the import-edge-only directed subgraph via DFS. Each cycle
 * is reported as node ids in traversal order with the repeated closing node
 * omitted (a->b->c->a reports ['a','b','c']). Distinct cycles are deduplicated
 * by their canonical rotation so the same cycle isn't reported twice from
 * different entry points; capped at MAX_CYCLES. Nodes are visited in sorted-id
 * order for deterministic output.
 */
function detectCycles(nodes, forward) {
  const cycles = [];
  const seenCanonical = new Set();
  const ids = nodes.map((n) => n.id).sort();

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(ids.map((id) => [id, WHITE]));
  const stack = [];
  const onStackIndex = new Map();

  const canonicalOf = (cycleNodes) => {
    // Rotate so the lexicographically-smallest id leads; this makes two
    // reports of the same cycle (found from different entry points) collapse.
    let minIdx = 0;
    for (let i = 1; i < cycleNodes.length; i += 1) {
      if (cycleNodes[i] < cycleNodes[minIdx]) minIdx = i;
    }
    return cycleNodes.slice(minIdx).concat(cycleNodes.slice(0, minIdx)).join('\0');
  };

  const visit = (startId) => {
    const frames = [];

    const pushFrame = (id) => {
      color.set(id, GRAY);
      onStackIndex.set(id, stack.length);
      stack.push(id);
      frames.push({
        id,
        neighbors: Array.from(forward.get(id) || []).sort(),
        nextIndex: 0,
      });
    };

    pushFrame(startId);
    while (frames.length > 0 && cycles.length < MAX_CYCLES) {
      const frame = frames[frames.length - 1];
      if (frame.nextIndex >= frame.neighbors.length) {
        frames.pop();
        stack.pop();
        onStackIndex.delete(frame.id);
        color.set(frame.id, BLACK);
        continue;
      }

      const next = frame.neighbors[frame.nextIndex];
      frame.nextIndex += 1;
      const nextColor = color.get(next);
      if (nextColor === WHITE) {
        pushFrame(next);
        continue;
      }
      if (nextColor === GRAY) {
        const startIdx = onStackIndex.get(next);
        const cycleNodes = stack.slice(startIdx);
        const canonical = canonicalOf(cycleNodes);
        if (!seenCanonical.has(canonical)) {
          seenCanonical.add(canonical);
          cycles.push(cycleNodes.slice());
        }
      }
    }
  };

  for (const id of ids) {
    if (cycles.length >= MAX_CYCLES) break;
    if (color.get(id) === WHITE) visit(id);
  }

  return cycles;
}

/**
 * Node ids touched by zero edges of any kind (no import in/out, no cochange).
 * Returned sorted for determinism.
 */
function findOrphans(nodes, edges) {
  const touched = new Set();
  for (const edge of edges) {
    touched.add(edge.from);
    touched.add(edge.to);
  }
  return nodes
    .filter((n) => !touched.has(n.id))
    .map((n) => n.id)
    .sort();
}

/**
 * findings(graph) — callable standalone on a hand-built graph. Reports the top
 * HUB_COUNT hubs by importance, all distinct import cycles, and true orphans.
 */
function findings(graph) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const { forward } = buildImportAdjacency(nodes, edges);
  return {
    hubs: topHubs(nodes, HUB_COUNT),
    cycles: detectCycles(nodes, forward),
    orphans: findOrphans(nodes, edges),
  };
}

// ---------------------------------------------------------------------------
// Deterministic layered-grid layout
// ---------------------------------------------------------------------------

/**
 * layout(nodes, edges) — pure, deterministic layered grid.
 *
 * column = index of the node's `dir` in the alphabetically-sorted list of
 *          distinct dirs.
 * row    = import depth: nodes with import-inbound 0 are depth 0; each import
 *          edge hop increments depth. Depth is assigned by processing nodes in
 *          sorted-id order and walking forward edges; the FIRST depth written
 *          for a node wins (first-writer-wins), so cycles cannot cause infinite
 *          recursion or nondeterministic depth.
 * Within a (column,row) collision, nodes are offset by a stable secondary index
 * (sorted by id) so no two nodes share an exact {x,y}.
 *
 * Same input always produces byte-identical output.
 */
function layout(nodes, edges) {
  const nodeList = Array.isArray(nodes) ? nodes : [];
  if (nodeList.length === 0) return [];

  const { forward, backward } = buildImportAdjacency(nodeList, Array.isArray(edges) ? edges : []);

  // Columns: distinct dirs, alphabetically ordered.
  const dirs = Array.from(new Set(nodeList.map((n) => n.dir))).sort();
  const columnOf = new Map(dirs.map((dir, idx) => [dir, idx]));

  // Depth (row) via BFS from import roots, iterating in sorted-id order.
  const sortedIds = nodeList.map((n) => n.id).sort();
  const nodeById = new Map(nodeList.map((node) => [node.id, node]));
  const depth = new Map();

  // Roots: nodes with zero import-inbound edges. If EVERY node has inbound
  // (a fully cyclic import graph), fall back to treating all nodes as roots so
  // depth assignment still terminates and is deterministic.
  let roots = sortedIds.filter((id) => (backward.get(id) || new Set()).size === 0);
  if (roots.length === 0) roots = sortedIds.slice();

  const queue = [];
  for (const id of roots) {
    if (!depth.has(id)) {
      depth.set(id, 0);
      queue.push(id);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const id = queue[head];
    head += 1;
    const d = depth.get(id);
    const neighbors = Array.from(forward.get(id) || []).sort();
    for (const next of neighbors) {
      if (!depth.has(next)) {
        // First-writer-wins: a node reached later keeps its earliest depth.
        depth.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  // Any node not reached from a root (isolated in the import graph or only in a
  // cycle unreachable from roots) gets depth 0 deterministically.
  for (const id of sortedIds) {
    if (!depth.has(id)) depth.set(id, 0);
  }

  // Collision offsets: group by (column,row), assign a stable index by sorted id.
  const cellCounts = new Map(); // "col\0row" -> next offset index
  const result = [];
  for (const id of sortedIds) {
    const node = nodeById.get(id);
    const column = columnOf.get(node.dir) || 0;
    const row = depth.get(id) || 0;
    const cellKey = `${column}\0${row}`;
    const offset = cellCounts.get(cellKey) || 0;
    cellCounts.set(cellKey, offset + 1);
    result.push({
      id,
      x: column * COLUMN_WIDTH,
      y: row * ROW_HEIGHT + offset * OFFSET_HEIGHT,
    });
  }
  // Return in sorted-id order (already built that way) for determinism.
  return result;
}

// ---------------------------------------------------------------------------
// buildGraph
// ---------------------------------------------------------------------------

/**
 * buildGraph({ files, readContent, cochangeCommits, tsconfigAliases }) -> Graph
 * End-to-end: reads each file, extracts + resolves imports, aggregates
 * co-change edges, computes per-node counts, then calls computeImportance,
 * findings, and layout internally so the returned graph is complete.
 */
function buildGraph({ files, readContent, cochangeCommits, tsconfigAliases, budgets } = {}) {
  const started = Date.now();
  const limits = normalizeBuildBudgets(budgets);
  const sourceFiles = Array.isArray(files) ? files : [];
  const selectedIds = new Set();
  const fileList = [];
  let nodeLimitReached = false;
  for (const relPath of sourceFiles) {
    if (selectedIds.has(relPath)) continue;
    if (fileList.length >= limits.maxNodes) {
      nodeLimitReached = true;
      break;
    }
    selectedIds.add(relPath);
    fileList.push(relPath);
  }
  const budgetState = {
    nodesSeen: sourceFiles.length,
    nodesAccepted: fileList.length,
    cochangePairsConsidered: 0,
    bulkCommitsSkipped: 0,
    truncationReasons: new Set(),
  };
  if (nodeLimitReached) {
    budgetState.truncationReasons.add('node_limit');
  }
  const aliases = tsconfigAliases || EMPTY_ALIASES;
  const reader = typeof readContent === 'function' ? readContent : () => '';

  const fileSet = selectedIds;
  const nodeIds = fileSet;

  // First pass: read content, build node scaffolds + import targets.
  const nodesById = new Map();
  const importPairs = []; // { from, to }
  const importSeen = new Set();
  let scanned = 0;

  for (const relPath of fileList) {
    let content = '';
    let readable = true;
    try {
      const raw = reader(relPath);
      content = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
    } catch {
      // Unreadable file: still create its node (loc 0, no outgoing edges).
      readable = false;
    }

    const node = {
      id: relPath,
      label: basename(relPath),
      dir: topLevelDir(relPath),
      isTest: isTestPath(relPath),
      loc: readable ? countLines(content) : 0,
      inbound: 0,
      outbound: 0,
      cochangeDegree: 0,
      importance: 0,
      externalRefs: 0,
      x: 0,
      y: 0,
    };
    nodesById.set(relPath, node);

    if (readable) {
      scanned += 1;
      const { targets, externalRefs } = resolveImportsForFile(relPath, content, fileSet, aliases);
      node.externalRefs = externalRefs;
      for (const to of targets) {
        const key = edgeKey(relPath, to, 'import');
        if (importSeen.has(key)) continue;
        if (importPairs.length >= limits.maxEdges) {
          budgetState.truncationReasons.add('edge_limit');
          break;
        }
        importSeen.add(key);
        importPairs.push({ from: relPath, to });
      }
    }
  }

  const importEdges = importPairs.map(({ from, to }) => ({ from, to, kind: 'import', weight: 1 }));

  // Co-change edges (already canonical from<to, one per pair).
  const cochangeEdges = buildCochangeEdges(
    cochangeCommits,
    nodeIds,
    { ...limits, maxEdges: Math.max(0, limits.maxEdges - importEdges.length) },
    budgetState
  );

  const edges = importEdges.concat(cochangeEdges);

  // Per-node counts derived from deduped edges.
  for (const edge of importEdges) {
    const fromNode = nodesById.get(edge.from);
    const toNode = nodesById.get(edge.to);
    if (fromNode) fromNode.outbound += 1;
    if (toNode) toNode.inbound += 1;
  }
  for (const edge of cochangeEdges) {
    const fromNode = nodesById.get(edge.from);
    const toNode = nodesById.get(edge.to);
    // cochangeDegree = count of distinct OTHER nodes sharing a cochange edge.
    // Each cochange edge is one canonical pair, so both endpoints gain 1.
    if (fromNode) fromNode.cochangeDegree += 1;
    if (toNode) toNode.cochangeDegree += 1;
  }

  const nodes = Array.from(nodesById.values());
  const graph = {
    nodes,
    edges,
    findings: { hubs: [], cycles: [], orphans: [] },
    meta: {
      scanned,
      total: sourceFiles.length,
      durationMs: 0,
    },
  };
  if (budgetState.truncationReasons.size > 0) {
    Object.assign(graph.meta, {
      partial: true,
      truncated: true,
      truncationReasons: Array.from(budgetState.truncationReasons).sort(),
      budget: {
        nodesSeen: budgetState.nodesSeen,
        nodesAccepted: budgetState.nodesAccepted,
        edgesAccepted: edges.length,
        cochangePairsConsidered: budgetState.cochangePairsConsidered,
        bulkCommitsSkipped: budgetState.bulkCommitsSkipped,
      },
    });
  }

  // Fill importance, then findings (importance-dependent), then layout.
  computeImportance(graph);
  graph.findings = findings(graph);

  const positions = layout(nodes, edges);
  const posById = new Map(positions.map((p) => [p.id, p]));
  for (const node of nodes) {
    const p = posById.get(node.id);
    if (p) {
      node.x = p.x;
      node.y = p.y;
    }
  }

  graph.meta.durationMs = Date.now() - started;
  return graph;
}

module.exports = {
  buildGraph,
  computeImportance,
  findings,
  layout,
  IMPORTANCE_WEIGHTS,
  COCHANGE_MIN,
  HUB_COUNT,
};
