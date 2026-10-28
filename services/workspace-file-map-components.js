'use strict';

// Workspace File Map: Components view, the ladder (row 77).
//
// Draws a workspace as a tree of components: per scope at most LIMIT boxes
// (folded toward BUDGET along import links), each opening onto its own scope,
// down to leaves of about LEAF_UNITS files. Folder and file names make the
// boxes; import links only decide where a small folder belongs. Pure and
// deterministic: same files and links -> byte-identical output.
//
// A JavaScript port of the name-tree partition in CodeBoarding
// (https://github.com/CodeBoarding/CodeBoarding, read at 9591385,
// static_analyzer/clustering/names/draft.py, the affinity grouper),
// MIT License, Copyright (c) 2025 CodeBoarding. Design and measurements:
// docs/plans/FILE_MAP_COMPONENTS_2026-10-25.md.

const {
  KIND,
  ROLE_WORDS,
  buildTrie,
  compareStrings,
  isFallbackOnly,
  pathKey,
  replay,
  samePath,
  stems,
  tokenize,
  unitsFromPaths,
  walk,
} = require('./workspace-file-map-components-names');
const {
  BUDGET,
  LOOSE_NAME,
  affinityGroups,
  candidateLabel,
  dedupe,
  linkKey,
  nameOf,
} = require('./workspace-file-map-components-fold');
const { isDependencyContentPath } = require('./workspace-file-map-scan-rules');

const ROOT_SCOPE_ID = 'root';
const MIN_UNITS = 2;
const GUARD_SHARE = 0.05;
// Files at or under which a component is a leaf.
const LEAF_UNITS = 7;
// Files above which a component transposes a layered sub-tree.
const LEAF_CAP = 135;
// Children a scope never exceeds; settle() pools the smallest past it.
const LIMIT = 15;
const ISLAND_SHARE = 1 / 3;
const ISLAND_STRAYS = 1;
const OTHER_NAME = 'Other files';
const DEFAULT_MAX_DEPTH = 3;

const RUNG = Object.freeze({
  UNMERGE: 'unmerge', FRONTIER: 'frontier', SEGMENT: 'segment', LAYERS: 'layers',
  FILES: 'files', ROLE: 'role', ISLAND: 'island', LEAF: 'leaf',
});

function floorFor(unitCount) {
  return Math.max(MIN_UNITS, Math.floor(GUARD_SHARE * unitCount));
}

function fileLabel(key) {
  const last = key.length ? key[key.length - 1] : '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

function commonPrefix(units) {
  if (!units.length) return [];
  const shared = [];
  const first = units[0].position;
  for (let i = 0; i < first.length; i += 1) {
    if (units.some((unit) => unit.position[i] !== first[i])) break;
    shared.push(first[i]);
  }
  return shared;
}

function candidateRule(candidate) {
  const label = candidateLabel(candidate);
  return {
    id: '',
    name: nameOf(label),
    label,
    prefixes: candidate.prefixes,
    terms: candidate.terms,
    fallbackPrefixes: candidate.fallbackPrefixes,
    parts: [],
    origin: candidate.kind,
  };
}

// ---------------------------------------------------------------------------
// Rungs
// ---------------------------------------------------------------------------

// Size, links and projects per candidate, from a replay of the candidates as rules.
function groupingContext(scope, candidates, rung) {
  const provisional = {
    rung,
    rules: candidates.map((c) => ({ ...candidateRule(c), id: c.key })),
  };
  const partition = replay(scope.units, provisional);
  const links = new Map();
  const calls = new Map();
  for (const [key, weight] of scope.links) {
    const [from, to] = key.split('\u0000');
    const left = partition.assignment.get(from);
    const right = partition.assignment.get(to);
    if (left && right && left !== right) {
      const pair = left < right ? linkKey(left, right) : linkKey(right, left);
      links.set(pair, (links.get(pair) || 0) + weight);
      calls.set(linkKey(left, right), (calls.get(linkKey(left, right)) || 0) + weight);
    }
  }
  const projects = new Set();
  for (const candidate of candidates) {
    for (const unit of partition.members.get(candidate.key) || []) {
      if (unit.project && candidate.prefixes.some((prefix) => samePath(prefix, unit.project))) projects.add(candidate.key);
    }
  }
  const sizes = new Map(candidates.map((c) => [c.key, (partition.members.get(c.key) || []).length]));
  return { rung, unitCount: scope.units.length, sizes, links, calls, projects, floor: floorFor(scope.units.length) };
}

function rulesFromGroups(groups, candidates) {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const seen = groups.flatMap((g) => g.keys);
  if (seen.length !== byKey.size || new Set(seen).size !== seen.length || seen.some((k) => !byKey.has(k))) {
    throw new Error('workspace-file-map-components: a grouping must cover every candidate once');
  }
  return groups.map((group) => {
    const members = group.keys.map((k) => byKey.get(k));
    return {
      id: '',
      name: nameOf(group.label),
      label: group.label,
      prefixes: members.flatMap((c) => c.prefixes),
      terms: dedupe([...group.terms, ...members.flatMap((c) => c.terms)]),
      fallbackPrefixes: members.flatMap((c) => c.fallbackPrefixes),
      parts: members.length > 1 ? members.map(candidateRule) : [],
      origin: members.length > 1 ? 'grouped' : members[0].kind,
    };
  });
}

function frontierRules(scope, rung, transpose, layers = false) {
  const frontier = walk(buildTrie(scope.units), ROLE_WORDS, { transpose, layers });
  const candidates = frontier.candidates.slice().sort((a, b) => compareStrings(a.key, b.key));
  if (!candidates.length) return { rules: [], axis: frontier.axis };
  const context = groupingContext(scope, candidates, rung);
  return { rules: rulesFromGroups(affinityGroups(candidates, context), candidates), axis: frontier.axis };
}

function unmergeRules(scope, parts) {
  const candidates = parts.map((part, index) => ({
    key: `part:${index}:${part.name}`,
    kind: part.origin,
    label: part.origin === KIND.RESIDUAL ? part.name.replace(/ \(residual\)$/, '') : part.name,
    named: part.label,
    prefixes: part.prefixes,
    fallbackPrefixes: part.fallbackPrefixes,
    terms: part.terms,
  }));
  const context = groupingContext(scope, candidates, RUNG.UNMERGE);
  return { rules: rulesFromGroups(affinityGroups(candidates, context), candidates), axis: 'structural' };
}

function fileCandidates(units) {
  const byKey = new Map();
  for (const unit of units) byKey.set(pathKey(unit.key), unit.key);
  return Array.from(byKey.keys()).sort(compareStrings).map((k) => {
    const key = byKey.get(k);
    return { key: `${KIND.FILE}:${key.join('/')}`, kind: KIND.FILE, label: fileLabel(key), prefixes: [key], fallbackPrefixes: [], terms: [] };
  });
}

// Group the candidates; groups under the floor pool into one loose bucket.
function groupedRules(scope, candidates, rung) {
  if (candidates.length < 2) return [];
  const context = groupingContext(scope, candidates, rung);
  const groups = affinityGroups(candidates, context);
  const sizeOf = (g) => g.keys.reduce((sum, k) => sum + (context.sizes.get(k) || 0), 0);
  const strong = groups.filter((g) => g.standing || sizeOf(g) >= context.floor);
  if (strong.length < 2) return [];
  const kept = new Set(strong.flatMap((g) => g.keys));
  const rules = rulesFromGroups(strong, candidates.filter((c) => kept.has(c.key)));
  if (strong.length < groups.length) rules.push(looseRule(scope.units));
  return rules;
}

function fileRules(scope) {
  return { rules: groupedRules(scope, fileCandidates(scope.units), RUNG.FILES), axis: RUNG.FILES };
}

// One candidate per head word of the file names (`controller`, `view`).
function roleRules(scope) {
  const byHead = new Map();
  for (const unit of scope.units) {
    const words = stems(fileLabel(unit.key));
    if (!words.length) continue;
    const head = words[words.length - 1];
    if (!byHead.has(head)) byHead.set(head, []);
    byHead.get(head).push(unit);
  }
  const candidates = Array.from(byHead.keys()).sort(compareStrings).map((word) => {
    const seen = new Map();
    for (const unit of byHead.get(word)) seen.set(pathKey(unit.key), unit.key);
    return { key: `${KIND.HEAD}:${word}`, kind: KIND.HEAD, label: word, prefixes: Array.from(seen.values()), fallbackPrefixes: [], terms: [word] };
  });
  return { rules: groupedRules(scope, candidates, RUNG.ROLE), axis: RUNG.ROLE };
}

function restLabel(units) {
  const heads = new Map();
  for (const unit of units) {
    const words = tokenize(fileLabel(unit.key));
    if (words.length) {
      const head = words[words.length - 1].toLowerCase();
      heads.set(head, (heads.get(head) || 0) + 1);
    }
  }
  let best = null;
  for (const [word, count] of heads) if (best === null || count > heads.get(best)) best = word;
  return { kind: 'other', word: best === null || heads.get(best) < units.length / 2 ? '' : best };
}

// One family that links to itself and nobody else, against the rest of a fan.
function islandRules(scope) {
  const candidates = fileCandidates(scope.units);
  if (candidates.length < 2) return { rules: [], axis: RUNG.ISLAND };
  const context = groupingContext(scope, candidates, RUNG.ISLAND);
  const groups = affinityGroups(candidates, context);
  const strong = groups.filter((g) => g.keys.reduce((sum, k) => sum + (context.sizes.get(k) || 0), 0) >= context.floor);
  if (strong.length !== 1) return { rules: [], axis: RUNG.ISLAND };
  const familyKeys = new Set(strong[0].keys);
  const inFamily = (unit) => familyKeys.has(`${KIND.FILE}:${unit.key.join('/')}`);
  const family = scope.units.filter(inFamily);
  const rest = scope.units.filter((unit) => !inFamily(unit));
  if (family.length < ISLAND_SHARE * scope.units.length || rest.length < context.floor) return { rules: [], axis: RUNG.ISLAND };
  const familyIds = new Set(family.map((u) => u.id));
  const restIds = new Set(rest.map((u) => u.id));
  let crossing = 0;
  for (const [key, weight] of scope.links) {
    const [from, to] = key.split('\u0000');
    if ((familyIds.has(from) && restIds.has(to)) || (restIds.has(from) && familyIds.has(to))) crossing += weight;
  }
  if (crossing > ISLAND_STRAYS) return { rules: [], axis: RUNG.ISLAND };
  const rules = rulesFromGroups(strong, candidates.filter((c) => familyKeys.has(c.key)));
  const restKeys = new Map(rest.map((u) => [pathKey(u.key), u.key]));
  const restGroup = restLabel(rest);
  rules.push({
    id: '', name: nameOf(restGroup), label: restGroup, prefixes: Array.from(restKeys.values()), terms: [],
    fallbackPrefixes: [commonPrefix(scope.units)], parts: [], origin: RUNG.ISLAND,
  });
  return { rules, axis: RUNG.ISLAND };
}

function looseRule(units) {
  const prefix = commonPrefix(units);
  return candidateRule({ key: `${KIND.LOOSE}:${prefix.join('/')}`, kind: KIND.LOOSE, label: '', prefixes: [], fallbackPrefixes: [prefix], terms: [] });
}

// ---------------------------------------------------------------------------
// Settle: guard, limit, ids
// ---------------------------------------------------------------------------

function nextId(scope) {
  scope.lastId += 1;
  return scope.scopeId === ROOT_SCOPE_ID ? String(scope.lastId) : `${scope.scopeId}.${scope.lastId}`;
}

function withinLimit(rules, sizes, room) {
  const bySize = (sizeOf) => (a, b) => (sizeOf(b) - sizeOf(a)) || compareStrings(a.name, b.name);
  const ordered = rules.slice().sort(bySize((r) => sizes.get(r.id)));
  const poolable = ordered.slice().reverse().filter((r) => !isFallbackOnly(r));
  const excess = ordered.length - room;
  if (excess <= 0 || poolable.length < 2) return ordered;
  const pooled = poolable.slice(0, excess + 1);
  const pool = {
    id: '?pool',
    name: OTHER_NAME,
    label: { kind: 'other', word: '' },
    prefixes: pooled.flatMap((r) => r.prefixes),
    terms: dedupe(pooled.flatMap((r) => r.terms)),
    fallbackPrefixes: pooled.flatMap((r) => r.fallbackPrefixes),
    parts: pooled,
    origin: 'grouped',
  };
  const pooledSize = pooled.reduce((sum, r) => sum + sizes.get(r.id), 0);
  const remaining = ordered.filter((r) => !pooled.includes(r));
  return [...remaining, pool].sort(bySize((r) => (r === pool ? pooledSize : sizes.get(r.id))));
}

// Replay the rules, apply the guard and the limit, number the survivors and
// give what is left to a loose-files rule. Null when the rung does not count.
function settle(scope, rules, rung, { guard, minRules = 2 }) {
  if (rules.length < minRules) return null;
  const provisional = rules.map((rule, index) => ({ ...rule, id: `?${index}` }));
  let partition = replay(scope.units, { rung, rules: provisional });
  const sizes = new Map(provisional.map((r) => [r.id, partition.members.get(r.id).length]));
  const floor = guard ? floorFor(scope.units.length) : 1;
  const strong = provisional.filter((r) => !isFallbackOnly(r) && sizes.get(r.id) >= floor);
  if (strong.length < minRules) return null;
  const kept = provisional.filter((r) => sizes.get(r.id) || isFallbackOnly(r));
  const ordered = withinLimit(kept, sizes, LIMIT - (partition.unplaced.length ? 1 : 0));
  const spec = { scopeId: scope.scopeId, rung, axis: '', leafReason: '', lastId: 0, rules: [] };
  for (const rule of ordered) spec.rules.push({ ...rule, id: nextId(spec) });
  partition = replay(scope.units, spec);
  if (partition.unplaced.length) {
    spec.rules.push({ ...looseRule(scope.units), id: nextId(spec) });
    partition = replay(scope.units, spec);
  }
  return { spec, partition };
}

// The leaf reason as a kind the renderer can word (D16).
function leafKind(unitCount) {
  if (unitCount <= LEAF_UNITS) return 'small';
  return unitCount <= LEAF_CAP ? 'cohesive' : 'exhausted';
}

function leafReason(scopeId, unitCount, parts, rungs) {
  if (scopeId === ROOT_SCOPE_ID) return `no rung (${rungs.join(', ')}) yields two children of ${unitCount} files`;
  const unmerge = parts.length >= 2 ? 'un-merge failed the guard' : 'nothing to un-merge';
  if (unitCount <= LEAF_UNITS) return `small: ${unitCount} files, at most ${LEAF_UNITS}; ${unmerge}`;
  const tried = rungs.filter((r) => r !== RUNG.UNMERGE).join(', ');
  return `${unitCount <= LEAF_CAP ? 'cohesive' : 'exhausted'}: ${unitCount} files; ${unmerge}; no rung (${tried}) yields two children`;
}

// Draft one scope: the first rung that yields two children above the floor wins.
function draftScope(scope, parts) {
  const isRoot = scope.scopeId === ROOT_SCOPE_ID;
  const rungs = [];
  if (parts.length >= 2) rungs.push([RUNG.UNMERGE, () => unmergeRules(scope, parts)]);
  if (isRoot || scope.units.length > LEAF_UNITS) {
    const transpose = isRoot || scope.units.length > LEAF_CAP;
    const first = isRoot ? RUNG.FRONTIER : RUNG.SEGMENT;
    rungs.push([first, () => frontierRules(scope, first, transpose)]);
    rungs.push([RUNG.LAYERS, () => frontierRules(scope, RUNG.LAYERS, false, true)]);
    rungs.push([RUNG.FILES, () => fileRules(scope)]);
    rungs.push([RUNG.ROLE, () => roleRules(scope)]);
    rungs.push([RUNG.ISLAND, () => islandRules(scope)]);
  }
  const produced = new Map();
  for (const [rung, produce] of rungs) {
    const result = produce();
    produced.set(rung, result);
    const settled = settle(scope, result.rules, rung, { guard: rung !== RUNG.FRONTIER });
    if (settled) {
      settled.spec.axis = result.axis;
      return settled;
    }
  }
  if (isRoot && scope.units.length) {
    const result = produced.get(RUNG.FRONTIER);
    const settled = settle(scope, result.rules, RUNG.FRONTIER, { guard: false, minRules: 1 });
    if (settled) {
      settled.spec.axis = result.axis;
      return settled;
    }
  }
  return {
    spec: {
      scopeId: scope.scopeId, rung: RUNG.LEAF, axis: '', lastId: 0, rules: [],
      leafReason: leafReason(scope.scopeId, scope.units.length, parts, rungs.map(([rung]) => rung)),
      leafKind: leafKind(scope.units.length),
    },
    partition: { assignment: new Map(), members: new Map(), unplaced: [] },
  };
}

function scopeLinks(units, links) {
  const ids = new Set(units.map((u) => u.id));
  const out = new Map();
  for (const [key, weight] of links) {
    const [from, to] = key.split('\u0000');
    if (ids.has(from) && ids.has(to)) out.set(key, weight);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Which files are partitioned (D14)
// ---------------------------------------------------------------------------

// Upstream's default ignore list, approximated: tests, fixtures, mocks,
// examples, hidden directories, build output and tool configs are not
// architecture. Only source files are partitioned; the rest is reported
// beside the tree as `outside` groups.
const TEST_DIRS = new Set([
  '__tests__', 'tests', 'test', '__test__', 'testing', 'testutil', 'testdata', '__mocks__', 'mocks',
  'fixtures', 'fixture', 'stubs', 'stub', 'fakes', 'fake', 'e2e', 'integration-tests',
]);
const DOC_DIRS = new Set(['docs', 'doc', 'documentation', 'examples', 'example', 'samples']);
const NON_SOURCE_DIRS = new Set([
  'node_modules', '__pycache__', 'build', 'dist', 'coverage', 'out', 'bin', 'obj', 'target', 'vendor',
  'venv', 'env', 'temp', 'cache',
]);
const TEST_FILE_RE = /(?:\.test\.|\.spec\.|_test\.[^/]+$|(?:^|\/)test_[^/]*\.py$)/i;
const DOC_FILE_RE = /\.(?:md|mdx|markdown|rst|adoc|txt)$/i;
const GENERATED_OR_TOOLING_RE = /(?:\.bundle\.js|\.min\.(?:js|css)$|\.chunk\.js|\.config\.|(?:^|\/)(?:esbuild|webpack|rollup|gulpfile|gruntfile)[^/]*$)/i;

// 'source', 'tests', 'docs' or 'other' for a workspace-relative path.
function classifyPath(relPath) {
  const dirs = relPath.split('/').slice(0, -1).map((seg) => seg.toLowerCase());
  if (dirs.some((seg) => TEST_DIRS.has(seg)) || TEST_FILE_RE.test(relPath)) return 'tests';
  if (dirs.some((seg) => DOC_DIRS.has(seg)) || DOC_FILE_RE.test(relPath)) return 'docs';
  if (!isDependencyContentPath(relPath)) return 'other';
  if (dirs.some((seg) => seg.startsWith('.') || NON_SOURCE_DIRS.has(seg)) || GENERATED_OR_TOOLING_RE.test(relPath)) return 'other';
  return 'source';
}

const OUTSIDE_GROUPS = Object.freeze(['tests', 'docs', 'other']);

// Draft the component tree of a File Map graph. `graph` is the engine's
// `{ nodes, edges }`; import edges are the links. Returns every drafted scope
// (rules, rung, leaf reason), the components with their files, the import
// relations between sibling components, and the files outside the tree
// (tests, docs, other) with their imports into each root component.
function draftComponents(graph, { maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const kindById = new Map();
  for (const node of nodes) {
    if (typeof node?.id === 'string' && node.id) kindById.set(node.id, classifyPath(node.id));
  }
  const units = unitsFromPaths(Array.from(kindById.keys()).filter((id) => kindById.get(id) === 'source'));
  const links = new Map();
  const outsideImports = [];
  for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
    if (edge?.kind !== 'import' || edge.from === edge.to) continue;
    const fromKind = kindById.get(edge.from);
    const toKind = kindById.get(edge.to);
    if (fromKind === 'source' && toKind === 'source') links.set(linkKey(edge.from, edge.to), 1);
    else if (fromKind && fromKind !== 'source' && toKind === 'source') outsideImports.push([fromKind, edge.from, edge.to]);
  }
  const scopes = [];
  const components = [];
  const relations = [];
  const build = (scopeId, scopeUnits, parts, depth, parentId) => {
    const scope = { scopeId, units: scopeUnits, links: scopeLinks(scopeUnits, links) };
    const { spec, partition } = draftScope(scope, parts);
    scopes.push({ id: scopeId, rung: spec.rung, axis: spec.axis, leafReason: spec.leafReason, leafKind: spec.leafKind || '', ruleCount: spec.rules.length });
    const owner = partition.assignment;
    const weights = new Map();
    for (const [key] of scope.links) {
      const [from, to] = key.split('\u0000');
      const left = owner.get(from);
      const right = owner.get(to);
      if (left && right && left !== right) weights.set(linkKey(left, right), (weights.get(linkKey(left, right)) || 0) + 1);
    }
    for (const [key, weight] of weights) {
      const [from, to] = key.split('\u0000');
      relations.push({ scopeId, from, to, weight });
    }
    for (const rule of spec.rules) {
      const members = partition.members.get(rule.id) || [];
      // An empty rule (a loose-files fallback whose files the word vote
      // took) stays in the spec but is not drawn.
      if (!members.length) continue;
      components.push({
        id: rule.id,
        parentId,
        name: rule.name,
        label: rule.label,
        origin: rule.origin,
        depth,
        files: members.map((u) => u.id),
        parts: rule.parts.map((part) => part.name),
      });
      if (depth < maxDepth && members.length) build(rule.id, members, rule.parts, depth + 1, rule.id);
    }
  };
  build(ROOT_SCOPE_ID, units, [], 1, null);
  relations.sort((a, b) => compareStrings(a.scopeId, b.scopeId) || compareStrings(a.from, b.from) || compareStrings(a.to, b.to));

  const rootOf = new Map();
  for (const component of components) {
    if (component.parentId === null) for (const file of component.files) rootOf.set(file, component.id);
  }
  // Per outside group and root component: the distinct outside files that
  // import into it ("tested by" for tests).
  const importers = new Map();
  for (const [group, from, to] of outsideImports) {
    const root = rootOf.get(to);
    if (!root) continue;
    const key = linkKey(group, root);
    if (!importers.has(key)) importers.set(key, new Set());
    importers.get(key).add(from);
  }
  const outsideRelations = Array.from(importers.entries())
    .map(([key, files]) => {
      const [from, to] = key.split('\u0000');
      return { from, to, files: files.size };
    })
    .sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));
  const outsideCounts = new Map();
  for (const kind of kindById.values()) outsideCounts.set(kind, (outsideCounts.get(kind) || 0) + 1);
  const outside = OUTSIDE_GROUPS
    .filter((id) => outsideCounts.has(id))
    .map((id) => ({ id, fileCount: outsideCounts.get(id) }));
  return { version: 1, scopes, components: withLeafFiles(components), relations, outside, outsideRelations };
}

// Payload shape (phase 2): every component carries its fileCount, but only a
// leaf lists its files; an opened box's files are its leaves', since each
// scope's components partition the box. Without this every file is listed
// once per depth (~685 KB of components on Jenny's own tree).
function withLeafFiles(components) {
  const opened = new Set(components.map((component) => component.parentId).filter((id) => id !== null));
  return components.map(({ files, parts, ...component }) => (opened.has(component.id)
    ? { ...component, fileCount: files.length, parts }
    : { ...component, fileCount: files.length, files, parts }));
}

module.exports = {
  BUDGET,
  LIMIT,
  LEAF_UNITS,
  ROOT_SCOPE_ID,
  classifyPath,
  draftComponents,
};
