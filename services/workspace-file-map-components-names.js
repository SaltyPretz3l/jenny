'use strict';

// Workspace File Map: Components view, names layer (row 77).
//
// Words, the trie of file positions, the frontier walk over it, and replay:
// the one function that places a file in a component. Pure and deterministic.
//
// A JavaScript port of the name-tree partition in CodeBoarding
// (https://github.com/CodeBoarding/CodeBoarding, read at 9591385,
// static_analyzer/clustering/names/{tokens,inventory,frontier,replay}.py),
// MIT License, Copyright (c) 2025 CodeBoarding. The role-word list is copied
// as data. Design and measurements: docs/plans/FILE_MAP_COMPONENTS_2026-10-25.md.
//
// Paths are arrays of segments relative to the workspace root ("prefixes").

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const TOKEN_RE = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g;
const INTERFACE_PREFIX_RE = /^I(?=[A-Z][a-z])/;
const SUFFIXES = [['ies', 'y'], ['ing', ''], ['ions', 'ion'], ['ed', ''], ['es', ''], ['s', '']];

function tokenize(identifier) {
  const name = String(identifier).split('(', 1)[0].trim().replace(INTERFACE_PREFIX_RE, '');
  return (name.match(TOKEN_RE) || []).filter((word) => !/^\d+$/.test(word));
}

// Fold the inflections names carry, so `Ordering`, `Orders` and `Order` are
// one word. Idempotent.
function stem(word) {
  let lowered = String(word).toLowerCase();
  for (;;) {
    let stripped = lowered;
    for (const [suffix, replacement] of SUFFIXES) {
      if (lowered.length <= suffix.length + 2 || !lowered.endsWith(suffix)) continue;
      if (suffix === 'es' && !'sxzh'.includes(lowered[lowered.length - 3])) {
        // `services`, `types`, `nodes`: the `e` is part of the word.
        stripped = lowered.slice(0, -1);
      } else if (suffix !== 's' || !'sui'.includes(lowered[lowered.length - 2])) {
        // `class`, `status`, `analysis` are singular.
        stripped = lowered.slice(0, -suffix.length) + replacement;
      }
      break;
    }
    if (stripped === lowered) return lowered;
    lowered = stripped;
  }
}

function stems(identifier) {
  return tokenize(identifier).map(stem);
}

// The closed class of words that name how software is built rather than what
// it is about. Fixed: upstream measured a list learned from identifier
// frequencies to be worse.
const ROLE_WORDS = new Set(`
  api apis application applications domain infrastructure infra contracts contract platform core
  common shared util utils utilities helpers helper extensions extension abstractions abstraction
  interfaces interface impl implementation internal internals models model viewmodels viewmodel views
  view services service controllers controller repositories repository persistence data dto dtos
  commands command queries query handlers handler events event behaviors behaviours validations
  validation validators validator exceptions exception config configuration configurations settings
  options middleware middlewares filters filter mappers mapper mapping converters converter
  resources resource assets components component pages page layouts layout hooks hook types typings
  constants enums entities entity migrations migration seed seeds fixtures fixture mocks mock tests
  test testing spec specs e2e docs doc examples example samples sample scripts tools tooling bin
  build dist out generated gen proto protos client clients server servers web ui app apps lib
  base framework frameworks integration integrations io net http grpc rest graphql
  init index main mod module program startup
`.split(/\s+/).filter(Boolean).map(stem));

const MIN_UBIQUITOUS = 3;

// Words carried by at least three siblings and at least half of them: a
// product namesake, not what tells siblings apart.
function ubiquitousWords(names) {
  const listed = Array.from(names);
  const counts = new Map();
  for (const name of listed) {
    for (const word of new Set(stems(name))) counts.set(word, (counts.get(word) || 0) + 1);
  }
  const out = new Set();
  for (const [word, count] of counts) {
    if (count >= MIN_UBIQUITOUS && count >= listed.length / 2) out.add(word);
  }
  return out;
}

function isRoleNamed(name, roleWords, ubiquitous = new Set()) {
  const words = stems(name).filter((word) => !ubiquitous.has(word));
  return words.length > 0 && words.every((word) => roleWords.has(word));
}

function distinctiveWord(name, roleWords, ubiquitous = new Set()) {
  for (const word of stems(name)) {
    if (!roleWords.has(word) && !ubiquitous.has(word)) return word;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Prefixes
// ---------------------------------------------------------------------------

function startsWith(path, prefix) {
  if (prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (path[i] !== prefix[i]) return false;
  }
  return true;
}

function samePath(left, right) {
  return left.length === right.length && startsWith(left, right);
}

// Tuple order: "\u0000" sorts below every character a segment can hold.
function pathKey(path) {
  return path.join('\u0000');
}

function compareStrings(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Units and the trie
// ---------------------------------------------------------------------------

const PROJECT_MANIFESTS = new Set([
  'package.json', 'pyproject.toml', 'setup.py', 'go.mod', 'Cargo.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'composer.json',
]);

function isProjectManifest(fileName) {
  return PROJECT_MANIFESTS.has(fileName) || /\.(?:cs|fs)proj$/i.test(fileName);
}

// One unit per file. Its position is its directory, its key the position plus
// the file name, its one name the path without extension (every segment votes
// for the words a rule owns). A file sits in a project when a manifest sits at
// or above its directory (the workspace root does not count).
function unitsFromPaths(relPaths) {
  const sorted = Array.from(new Set(relPaths)).sort(compareStrings);
  const projectDirs = new Set();
  for (const relPath of sorted) {
    const parts = relPath.split('/');
    if (parts.length > 1 && isProjectManifest(parts[parts.length - 1])) {
      projectDirs.add(pathKey(parts.slice(0, -1)));
    }
  }
  return sorted.map((relPath) => {
    const parts = relPath.split('/');
    const position = parts.slice(0, -1);
    let project = null;
    for (let depth = position.length; depth > 0; depth -= 1) {
      if (projectDirs.has(pathKey(position.slice(0, depth)))) {
        project = position.slice(0, depth);
        break;
      }
    }
    return {
      id: relPath,
      names: [relPath.replace(/\.[^./]+$/, '')],
      position,
      key: parts,
      project,
    };
  });
}

function buildTrie(units) {
  const root = { path: [], children: new Map(), units: [], count: 0 };
  for (const unit of units) {
    let node = root;
    unit.position.forEach((segment, depth) => {
      if (!node.children.has(segment)) {
        node.children.set(segment, { path: unit.position.slice(0, depth + 1), children: new Map(), units: [], count: 0 });
      }
      node = node.children.get(segment);
    });
    node.units.push(unit);
  }
  const count = (node) => {
    node.count = node.units.length;
    for (const child of node.children.values()) node.count += count(child);
    return node.count;
  };
  count(root);
  return root;
}

function sortedChildren(node) {
  return Array.from(node.children.entries()).sort((a, b) => compareStrings(a[0], b[0]));
}

// ---------------------------------------------------------------------------
// The frontier walk
// ---------------------------------------------------------------------------

// A child holding this share of its parent is stepped through, whatever it is
// called (`src`, `src/main/java`, the one package of a library).
const NEARLY_ALL = 0.8;
// A node this much of whose files sit under role-named children is layered.
const ROLE_SHARE = 0.6;
const MIN_LAYERS = 3;

const KIND = Object.freeze({
  BOX: 'box', FEATURE: 'feature', LOOSE: 'loose', RESIDUAL: 'residual', FILE: 'file', HEAD: 'head',
});

function boxCandidate(node) {
  return {
    key: `${KIND.BOX}:${node.path.join('/')}`,
    kind: KIND.BOX,
    label: node.path.length ? node.path[node.path.length - 1] : '',
    prefixes: [node.path],
    fallbackPrefixes: [],
    terms: [],
  };
}

function looseCandidate(node) {
  return {
    key: `${KIND.LOOSE}:${node.path.join('/')}`,
    kind: KIND.LOOSE,
    label: '',
    prefixes: [],
    fallbackPrefixes: [node.path],
    terms: [],
  };
}

// The candidates of a trie: boxes, features of a transposed layered node,
// layer residues, and the loose files of a node.
function walk(root, roleWords, { transpose = true, layers = false } = {}) {
  const out = { candidates: [], axis: 'flat', notes: [] };
  let top = root;
  while (top.children.size === 1 && top.units.length === 0) top = top.children.values().next().value;
  visit(top, roleWords, out, transpose, layers, true);
  return out;
}

function visit(node, roleWords, out, transpose, layers, top = false) {
  const children = sortedChildren(node);
  if (children.length === 1 && node.units.length === 0) {
    visit(children[0][1], roleWords, out, transpose, layers, top);
    return;
  }
  const ubiquitous = ubiquitousWords(children.map(([name]) => name));
  const stepped = new Set(children.filter(([, child]) => child.count >= NEARLY_ALL * node.count).map(([name]) => name));
  const roleChildren = children.filter(([name]) => isRoleNamed(name, roleWords, ubiquitous));
  const roleUnits = roleChildren.reduce((sum, [, child]) => sum + child.count, 0);
  if (stepped.size === 0 && roleChildren.length >= MIN_LAYERS && node.count && roleUnits / node.count >= ROLE_SHARE) {
    layered(node, ubiquitous, roleWords, out, transpose, layers, top);
    return;
  }
  if (top) out.axis = 'structural';
  let loose = node.units.length > 0;
  let scopes = 0;
  for (const [name, child] of children) {
    if (child.count === 1) {
      loose = true;
      continue;
    }
    scopes += 1;
    if (stepped.has(name)) {
      visit(child, roleWords, out, transpose, layers);
      continue;
    }
    out.candidates.push(boxCandidate(child));
  }
  if (!scopes) {
    // Only files and one-file children: a flat scope is one box.
    out.candidates.push(boxCandidate(node));
  } else if (loose) {
    out.candidates.push(looseCandidate(node));
  }
}

// The shallowest feature-named directories under a layer, looking through its
// role-named ones.
function featureDirectories(node, roleWords, ubiquitous) {
  const found = [];
  for (const [name, child] of sortedChildren(node)) {
    if (isRoleNamed(name, roleWords, ubiquitous)) found.push(...featureDirectories(child, roleWords, ubiquitous));
    else found.push([name, child]);
  }
  return found;
}

function featureStem(name, roleWords, ubiquitous) {
  const words = stems(name);
  return distinctiveWord(name, roleWords, ubiquitous) || (words.length ? words[0] : name.toLowerCase());
}

// A node whose children are layers: transpose onto the features recurring
// under two of them, else draw the layers.
function layered(node, ubiquitousIn, roleWords, out, transpose, layers, top) {
  const where = node.path.join('/') || '<root>';
  const byName = sortedChildren(node);
  let ubiquitous = ubiquitousIn;
  for (;;) {
    const found = byName.flatMap(([, layer]) => featureDirectories(layer, roleWords, ubiquitous).map(([name]) => name));
    const widened = new Set([...ubiquitous, ...ubiquitousWords(found)]);
    if (widened.size === ubiquitous.size) break;
    ubiquitous = widened;
  }
  const layersByFeature = new Map();
  const display = new Map();
  for (const [layerName, layer] of byName) {
    for (const [name] of featureDirectories(layer, roleWords, ubiquitous)) {
      const feature = featureStem(name, roleWords, ubiquitous);
      if (!layersByFeature.has(feature)) layersByFeature.set(feature, new Set());
      layersByFeature.get(feature).add(layerName);
      if (!display.has(feature)) display.set(feature, name);
    }
  }
  const features = Array.from(layersByFeature.entries())
    .filter(([, featureLayers]) => featureLayers.size >= 2)
    .map(([feature]) => feature)
    .sort(compareStrings);
  const grid = features.length >= 2;
  if (grid && !transpose && !layers) {
    out.notes.push(`${where}: layered, kept as one box`);
    out.candidates.push(boxCandidate(node));
    return;
  }
  if (!grid || !transpose) {
    if (top) out.axis = 'structural';
    out.notes.push(`${where}: role-named children, ${grid ? 'a grid drawn layer by layer' : 'no recurring features'}; layers as boxes`);
    for (const [, layer] of byName) {
      if (layer.count > 1) out.candidates.push(boxCandidate(layer));
    }
    if (node.units.length || Array.from(node.children.values()).some((layer) => layer.count === 1)) {
      out.candidates.push(looseCandidate(node));
    }
    return;
  }
  if (top) out.axis = 'transposed';
  out.notes.push(`transposed ${where} onto ${features.join(', ')}`);
  const prefixesByFeature = new Map(features.map((feature) => [feature, []]));
  for (const [, layer] of byName) {
    for (const [name, child] of featureDirectories(layer, roleWords, ubiquitous)) {
      const feature = featureStem(name, roleWords, ubiquitous);
      if (prefixesByFeature.has(feature)) prefixesByFeature.get(feature).push(child.path);
    }
  }
  for (const feature of features) {
    out.candidates.push({
      key: `${KIND.FEATURE}:${node.path.join('/')}:${feature}`,
      kind: KIND.FEATURE,
      label: display.get(feature),
      prefixes: prefixesByFeature.get(feature),
      fallbackPrefixes: [],
      terms: [feature],
    });
  }
  if (node.units.length) out.candidates.push(looseCandidate(node));
  for (const [name, layer] of byName) {
    out.candidates.push({
      key: `${KIND.RESIDUAL}:${layer.path.join('/')}`,
      kind: KIND.RESIDUAL,
      label: name,
      prefixes: [],
      fallbackPrefixes: [layer.path],
      terms: [],
    });
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function isFallbackOnly(rule) {
  return rule.prefixes.length === 0 && rule.terms.length === 0;
}

function longestMatch(path, pairs) {
  let best = null;
  let bestLength = -1;
  for (const [prefix, id] of pairs) {
    if (prefix.length > bestLength && startsWith(path, prefix)) {
      best = id;
      bestLength = prefix.length;
    }
  }
  return best;
}

// Weighted votes of a file's words for the rules owning them: a word nearer
// the end of a name segment weighs more.
function termVotes(unit, ownerByTerm) {
  const votes = new Map();
  for (const name of unit.names) {
    for (const part of name.split('/').filter(Boolean)) {
      const words = tokenize(part);
      words.forEach((word, position) => {
        const owner = ownerByTerm.get(stem(word));
        if (owner !== undefined) votes.set(owner, (votes.get(owner) || 0) + 2 ** (position - (words.length - 1)));
      });
    }
  }
  return votes;
}

// Place every unit of a scope by its rules: longest prefix, then the word
// vote, then the longest fallback prefix; what is left is unplaced. A unit's
// component depends on its own names and the rules alone.
function replay(units, scope) {
  const members = new Map(scope.rules.map((rule) => [rule.id, []]));
  const assignment = new Map();
  const unplaced = [];
  const rank = new Map(scope.rules.map((rule, index) => [rule.id, index]));
  const primary = scope.rules.flatMap((rule) => rule.prefixes.map((prefix) => [prefix, rule.id]));
  const fallback = scope.rules.flatMap((rule) => rule.fallbackPrefixes.map((prefix) => [prefix, rule.id]));
  const ownerByTerm = new Map();
  for (const rule of scope.rules) {
    for (const term of rule.terms) if (!ownerByTerm.has(term)) ownerByTerm.set(term, rule.id);
  }
  for (const unit of units) {
    // Prefixes match the unit's key (position plus file name): a directory
    // prefix matches it exactly when it matches the position, since a file
    // and a directory never share a path, and a file prefix (files, role and
    // island rungs) matches only its own file. Upstream switches on the
    // scope's rung instead, which loses a file-keyed fold's files to the word
    // vote once the un-merge rung reopens it (deviation D13 in the plan).
    let owner = longestMatch(unit.key, primary);
    if (owner === null && ownerByTerm.size) {
      const votes = termVotes(unit, ownerByTerm);
      for (const [id, weight] of votes) {
        // Ties go to the rule that comes first in the scope.
        if (owner === null || weight > votes.get(owner) || (weight === votes.get(owner) && rank.get(id) < rank.get(owner))) {
          owner = id;
        }
      }
    }
    if (owner === null) owner = longestMatch(unit.position, fallback);
    if (owner === null) {
      unplaced.push(unit);
      continue;
    }
    assignment.set(unit.id, owner);
    members.get(owner).push(unit);
  }
  return { assignment, members, unplaced };
}

module.exports = {
  KIND,
  ROLE_WORDS,
  buildTrie,
  compareStrings,
  distinctiveWord,
  isFallbackOnly,
  pathKey,
  replay,
  samePath,
  stem,
  stems,
  tokenize,
  ubiquitousWords,
  unitsFromPaths,
  walk,
};
