'use strict';

// Suggested changes (row 35 W3): how suggestions relate. Groups are changes
// that only work together (applied as one unit once every member is
// accepted); `depends_on` names suggestions that must be applied first. Pure
// functions over the normalized record (suggested-changes-records.js).
//
// UI spec §4.2: reject never cascades. A dependent of a rejected change becomes
// `needs_attention` (skipped by default, "Apply anyway" behind a confirm), and
// returns to review when that change is restored.

const MAX_ID_CHARS = 128;
const LIVE = new Set(['to_review', 'accepted', 'later', 'revising', 'out_of_date', 'needs_attention']);
// Unapplied dependents that a rejected dependency puts on hold.
const HOLDABLE = new Set(['to_review', 'accepted', 'later', 'out_of_date']);

function safeLabel(value) {
  return typeof value === 'string' ? value.trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) : '';
}

// A group is scoped to the turn that named it, so two turns' "api" labels differ.
function groupIdFor(turnId, label) {
  const name = safeLabel(label);
  if (!name) return null;
  const turn = String(turnId || 'turn').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'turn';
  return `grp:${turn}:${name}`.slice(0, MAX_ID_CHARS);
}

// Suggestion ids, or this turn's own tool call ids (the sidecar cannot know the
// stored id of a suggestion made earlier in the same turn).
function resolveReferences(state, refs, turnId) {
  const ids = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const text = typeof ref === 'string' ? ref.trim() : '';
    if (!text) continue;
    const entry = state.entries.find((item) => item.id === text)
      || (turnId ? state.entries.find((item) => item.tool_call_id === text && item.turn_id === turnId) : null);
    if (entry && !ids.includes(entry.id)) ids.push(entry.id);
  }
  return ids.slice(0, 20);
}

function groupMembers(state, groupId) {
  if (!groupId) return [];
  return state.entries.filter((entry) => entry.group_id === groupId && LIVE.has(entry.status));
}

function withEntries(state, map) {
  return { ...state, entries: state.entries.map(map) };
}

/**
 * Takes one change out of its group (Ungroup, or a member rejected). The
 * group's consent changed, so its accepted members return to review; a group
 * left with one live member dissolves.
 */
function leaveGroup(state, entryId, now) {
  const entry = state.entries.find((item) => item.id === entryId);
  const groupId = entry && entry.group_id;
  if (!groupId) return state;
  const remaining = groupMembers(state, groupId).filter((item) => item.id !== entryId);
  const dissolve = remaining.length < 2;
  return withEntries(state, (item) => {
    if (item.id === entryId) {
      return { ...item, group_id: null, status: item.status === 'accepted' ? 'to_review' : item.status, updated_at: now };
    }
    if (item.group_id !== groupId) return item;
    const status = item.status === 'accepted' ? 'to_review' : item.status;
    if (!dissolve && status === item.status) return item;
    return { ...item, group_id: dissolve ? null : groupId, status, updated_at: now };
  });
}

// A rejected change puts its unapplied dependents on hold.
function holdDependents(state, rejectedId, now) {
  return withEntries(state, (item) => (
    item.depends_on.includes(rejectedId) && HOLDABLE.has(item.status)
      ? { ...item, status: 'needs_attention', updated_at: now }
      : item
  ));
}

// A dependent on hold returns to review once none of its dependencies is rejected.
function releaseDependents(state, now) {
  const rejected = new Set(state.entries.filter((item) => item.status === 'rejected').map((item) => item.id));
  return withEntries(state, (item) => (
    item.status === 'needs_attention' && !item.depends_on.some((id) => rejected.has(id))
      ? { ...item, status: 'to_review', updated_at: now }
      : item
  ));
}

/* ── Derived facts (working spec decision 4: derived facts plus labelled assumptions) ──
 * Only what the text proves: an import of a file another suggestion creates,
 * or a name another suggestion adds that this one starts to use. Facts point at
 * earlier suggestions only, so they never form a cycle. */

const MAX_FACT_TEXT = 65536;
const MAX_NAMES = 50;
const PY_IMPORT = /^[ \t]*(?:from[ \t]+([.\w]+)[ \t]+import|import[ \t]+([.\w]+))/gm;
const JS_IMPORT = /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*|^\s*import\s*)['"](\.{1,2}\/[^'"\n]+)['"]/gm;
const DEFINITIONS = [
  /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w{2,})/gm,
  /^[ \t]*class[ \t]+([A-Za-z_]\w{2,})/gm,
  /\bfunction\s+([A-Za-z_$][\w$]{2,})/g,
  /^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]{2,})[ \t]*=/gm,
];

function factText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_FACT_TEXT) : '';
}

function matchesOf(pattern, value) {
  const found = [];
  for (const match of factText(value).matchAll(pattern)) {
    const name = match.slice(1).find(Boolean);
    if (name) found.push(name);
  }
  return found;
}

function dirOf(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function stripExtension(path) {
  return path.replace(/\.(?:[cm]?[jt]sx?|py)$/, '').replace(/\/(?:index|__init__)$/, '');
}

function resolveRelative(fromDir, spec) {
  const parts = fromDir ? fromDir.split('/') : [];
  for (const piece of spec.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece && piece !== '.') parts.push(piece);
  }
  return parts.join('/');
}

// Module paths a Python or JS/TS file imports, as workspace paths without extension.
function importTargets(path, text) {
  const targets = new Set();
  if (/\.py$/.test(path)) {
    for (const module of matchesOf(PY_IMPORT, text)) {
      const dots = module.match(/^\.*/)[0].length;
      const rest = module.slice(dots).replace(/\./g, '/');
      if (dots) {
        let base = dirOf(path);
        for (let up = 1; up < dots; up += 1) base = dirOf(base);
        targets.add(base && rest ? `${base}/${rest}` : base || rest);
      } else if (rest) {
        targets.add(rest);
      }
    }
  } else {
    for (const spec of matchesOf(JS_IMPORT, text)) targets.add(resolveRelative(dirOf(path), spec));
  }
  return targets;
}

function importsNewly(entry, createdPath) {
  const target = stripExtension(createdPath);
  const hit = (targets) => [...targets].some((item) => item === target || target.endsWith(`/${item}`));
  return hit(importTargets(entry.path, entry.new_string)) && !hit(importTargets(entry.path, entry.old_string));
}

function addedNames(entry) {
  const before = new Set(DEFINITIONS.flatMap((pattern) => matchesOf(pattern, entry.old_string)));
  const names = DEFINITIONS.flatMap((pattern) => matchesOf(pattern, entry.new_string)).filter((name) => !before.has(name));
  return [...new Set(names)].slice(0, MAX_NAMES);
}

function usesNewly(entry, name) {
  const word = new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
  return word.test(factText(entry.new_string)) && !word.test(factText(entry.old_string));
}

/**
 * Relations of `entry` to the live suggestions made before it: derived facts
 * (`import`, `defines`) and the model's own `declared` dependencies, which the
 * UI labels as Jenny's assumption.
 */
function deriveRelations(state, entry, declaredIds = []) {
  const relations = [];
  // Record order, not timestamps: a new entry is not in the state yet, and a
  // revision keeps its place, so a fact can never point forward.
  const position = state.entries.findIndex((other) => other.id === entry.id);
  const earlier = (position < 0 ? state.entries : state.entries.slice(0, position))
    .filter((other) => LIVE.has(other.status));
  for (const other of earlier) {
    if (other.kind === 'create' && importsNewly(entry, other.path)) {
      relations.push({ id: other.id, kind: 'import', name: other.path.split('/').pop() });
      continue;
    }
    const name = addedNames(other).find((candidate) => usesNewly(entry, candidate));
    if (name) relations.push({ id: other.id, kind: 'defines', name });
  }
  for (const id of declaredIds) {
    if (!relations.some((item) => item.id === id)) relations.push({ id, kind: 'declared', name: '' });
  }
  return relations.slice(0, 20);
}

// True when `fromId` reaches `targetId` through recorded dependencies.
function dependsOn(state, fromId, targetId) {
  const seen = new Set();
  const queue = [fromId];
  while (queue.length) {
    const id = queue.shift();
    if (id === targetId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = state.entries.find((item) => item.id === id);
    if (entry) queue.push(...entry.depends_on);
  }
  return false;
}

/** Relations that would close a cycle back to `entryId` are dropped. */
function withoutCycles(state, entryId, found) {
  return found.filter((item) => !dependsOn(state, item.id, entryId));
}

/** Dependencies of `entry` the person rejected; applying it anyway needs a confirm. */
function rejectedDependencies(state, entry) {
  return entry.depends_on
    .map((id) => state.entries.find((item) => item.id === id))
    .filter((dep) => dep && dep.status === 'rejected');
}

/** Dependencies of `entry` still waiting to be applied (outside its own group). */
function pendingDependencies(state, entry) {
  return entry.depends_on
    .map((id) => state.entries.find((item) => item.id === id))
    .filter((dep) => dep && LIVE.has(dep.status) && !(entry.group_id && dep.group_id === entry.group_id));
}

module.exports = {
  deriveRelations,
  groupIdFor,
  groupMembers,
  holdDependents,
  leaveGroup,
  pendingDependencies,
  rejectedDependencies,
  releaseDependents,
  resolveReferences,
  withoutCycles,
};
