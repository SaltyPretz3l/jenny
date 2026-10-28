'use strict';

// Workspace File Map: Components view, the grouper (row 77).
//
// The one judgement in the component tree: turn one rung's candidates into
// named components. Kinship merges candidates sharing their distinctive word;
// the fold then places small candidates by their role in the import links
// (hub, application, project, helper) and folds toward BUDGET along links
// that carry at least half of what a candidate exchanges. A grouper sees
// candidates, never files, so a wrong grouping can only merge boxes.
//
// A JavaScript port of the affinity grouper in CodeBoarding
// (https://github.com/CodeBoarding/CodeBoarding, read at 9591385,
// static_analyzer/clustering/names/draft.py), MIT License, Copyright (c)
// 2025 CodeBoarding. Design and measurements:
// docs/plans/FILE_MAP_COMPONENTS_2026-10-25.md.

const {
  KIND,
  ROLE_WORDS,
  compareStrings,
  distinctiveWord,
  stem,
  stems,
  tokenize,
  ubiquitousWords,
} = require('./workspace-file-map-components-names');

const UNMERGE_RUNG = 'unmerge';
// Components a scope is folded toward along its links.
const BUDGET = 9;
// Links two candidates must exchange before they count as affine.
const MIN_LINKS = 2;
// Share of its siblings that must import a candidate for it to be a hub.
const HUB_SHARE = 0.4;
const MIN_HUB_PARTNERS = 3;
const MIN_HUB_UNITS = 3;
// No fold grows a component past this share of its scope.
const CAP_SHARE = 0.6;
// Share of a small candidate's links a small home must carry.
const PARTNER_SHARE = 0.25;
// Groups above which the fold does not run (D10).
const MAX_FOLD_GROUPS = 400;
const LOOSE_NAME = 'Loose files';
// Code that uses the scope without being part of it: it owns no helper.
const CONSUMER_WORDS = new Set(['test', 'spec', 'e2e', 'sample', 'example', 'doc', 'bench', 'benchmark', 'snippet', 'demo', 'script', 'cypress']);

function dedupe(values) {
  return Array.from(new Set(values));
}

function linkKey(from, to) {
  return `${from}\u0000${to}`;
}

function capitalize(word) {
  return word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word;
}

// Every component name is drawn from a structured label (D16): the renderer
// words and localizes the label; `name` is its English rendering, kept for
// the Ask-the-Map summary and the harness. Kinds: folder, file, family,
// role, loose, other, residual, all.
function nameOf(label) {
  switch (label.kind) {
    case 'loose': return label.dir ? `${LOOSE_NAME} in ${label.dir.split('/').join('.')}` : LOOSE_NAME;
    case 'residual': return `${label.text} (residual)`;
    case 'role': return capitalize(label.word);
    case 'all': return 'All files';
    case 'family': return `${label.stem}*${label.more ? ' and more' : ''}`;
    case 'other':
      if (!label.word) return 'Other files';
      return label.word.endsWith('s') ? `Other ${label.word}` : `Other ${label.word}s`;
    default: return label.text;
  }
}

// A candidate re-offered by the un-merge rung keeps the label it was drawn with.
function candidateLabel(candidate) {
  if (candidate.named) return candidate.named;
  if (candidate.kind === KIND.LOOSE) {
    return { kind: 'loose', dir: candidate.fallbackPrefixes.length ? candidate.fallbackPrefixes[0].join('/') : '' };
  }
  if (candidate.kind === KIND.RESIDUAL) return { kind: 'residual', text: candidate.label };
  if (candidate.kind === KIND.HEAD) return { kind: 'role', word: candidate.label };
  if (candidate.kind === KIND.BOX && !candidate.label) return { kind: 'all' };
  return { kind: candidate.kind === KIND.FILE ? 'file' : 'folder', text: candidate.label };
}

function candidateName(candidate) {
  return nameOf(candidateLabel(candidate));
}

// The member whose label says the least beyond the group's word.
function plainest(members) {
  const plainness = (candidate) => {
    const words = tokenize(candidate.label);
    return [words.filter((word) => !ROLE_WORDS.has(stem(word))).length, words.length, candidate.label];
  };
  const best = members.slice().sort((a, b) => {
    const [pa, pb] = [plainness(a), plainness(b)];
    return (pa[0] - pb[0]) || (pa[1] - pb[1]) || compareStrings(pa[2], pb[2]);
  })[0];
  return candidateLabel(best);
}

const WORD_RE = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g;

// A label's words with where each ends, digit-only words dropped as
// tokenize() drops them.
function wordSpans(label) {
  return Array.from(label.matchAll(WORD_RE))
    .filter((m) => !/^\d+$/.test(m[0]))
    .map((m) => ({ stem: stem(m[0]), start: m.index, end: m.index + m[0].length }));
}

// The most common `words`-word start (by stem) among `entries`, with the
// entries carrying it.
function commonestStart(entries, words) {
  const byStart = new Map();
  for (const entry of entries) {
    if (entry.spans.length < words) continue;
    const key = entry.spans.slice(0, words).map((s) => s.stem).join(' ');
    if (!byStart.has(key)) byStart.set(key, []);
    byStart.get(key).push(entry);
  }
  let best = null;
  for (const [key, carriers] of byStart) {
    if (!best || carriers.length > best.carriers.length || (carriers.length === best.carriers.length && key < best.key)) {
      best = { key, carriers };
    }
  }
  return best;
}

// `renderer-stream-*` for a box of files: the longest start of names that
// at least half of its files share; when no start reaches half, the most
// common first word and "and more". Spelled as the shortest carrier spells
// it. Upstream leaves these names to its naming agent; Jenny names them here
// (deviation D12).
function familyLabel(members) {
  const all = members.filter((c) => c.kind === KIND.FILE).map((c) => ({ label: c.label, spans: wordSpans(c.label) }));
  if (all.length < 2) return null;
  let carriers = all;
  let words = 0;
  for (;;) {
    const next = commonestStart(carriers, words + 1);
    if (!next || next.carriers.length < 2 || next.carriers.length * 2 < all.length) break;
    carriers = next.carriers;
    words += 1;
  }
  let more = false;
  if (words === 0) {
    const first = commonestStart(all, 1);
    if (!first || first.carriers.length < 2) return null;
    carriers = first.carriers;
    words = 1;
    more = true;
  }
  const spelled = carriers
    .map((entry) => ({ text: entry.label.slice(0, entry.spans[words - 1].end), label: entry.label }))
    .reduce((a, b) => (b.text.length < a.text.length || (b.text.length === a.text.length && b.text < a.text) ? b : a));
  const longer = carriers.find((entry) => entry.label.length > entry.spans[words - 1].end);
  const separator = longer ? longer.label[longer.spans[words - 1].end] : '-';
  return { kind: 'family', stem: `${spelled.text}${/[-_.]/.test(separator) ? separator : '-'}`, more };
}

// ---------------------------------------------------------------------------
// Grouping: kinship, then the fold along the links
// ---------------------------------------------------------------------------

// Merge candidates that share their distinctive word.
function kinshipGroups(candidates, context) {
  if (context.rung === UNMERGE_RUNG) {
    return candidates.map((candidate) => ({ label: candidateLabel(candidate), keys: [candidate.key], terms: [], standing: false }));
  }
  const ubiquitous = ubiquitousWords(candidates.filter((c) => c.label).map((c) => c.label));
  const byWord = new Map();
  const solo = [];
  for (const candidate of candidates) {
    const word = candidate.label ? distinctiveWord(candidate.label, ROLE_WORDS, ubiquitous) : '';
    if (word) {
      if (!byWord.has(word)) byWord.set(word, []);
      byWord.get(word).push(candidate);
    } else {
      solo.push(candidate);
    }
  }
  const groups = Array.from(byWord.entries()).map(([word, members]) => ({
    label: plainest(members), keys: members.map((c) => c.key), terms: [word], standing: false,
  }));
  for (const candidate of solo) groups.push({ label: candidateLabel(candidate), keys: [candidate.key], terms: [], standing: false });
  return groups;
}

class Fold {
  constructor(groups, candidates, context) {
    this.context = context;
    this.byKey = new Map(candidates.map((c) => [c.key, c]));
    this.members = groups.map((g) => g.keys.slice());
    this.terms = groups.map((g) => g.terms.slice());
    this.sizes = groups.map((g) => g.keys.reduce((sum, key) => sum + (context.sizes.get(key) || 0), 0));
    const n = groups.length;
    this.links = this.members.map((left) => this.members.map((right) => this.between(left, right, false)));
    this.calls = this.members.map((left) => this.members.map((right) => this.between(left, right, true)));
    for (let i = 0; i < n; i += 1) this.links[i][i] = this.calls[i][i] = 0;
    this.floor = context.floor;
    this.cap = CAP_SHARE * context.unitCount;
    const live = this.live();
    const threshold = Math.max(MIN_HUB_PARTNERS, HUB_SHARE * (live.length - 1));
    this.hubs = new Set(live.filter((i) => live.filter((j) => this.calls[j][i] >= MIN_LINKS).length >= threshold));
    this.projects = new Set(this.members.map((keys, i) => (keys.some((k) => context.projects.has(k)) ? i : -1)).filter((i) => i >= 0));
    this.fallback = new Set(this.members.map((keys, i) => (
      keys.length && keys.every((k) => [KIND.LOOSE, KIND.RESIDUAL].includes(this.byKey.get(k).kind)) ? i : -1
    )).filter((i) => i >= 0));
    this.consumers = new Set(live.filter((i) => this.isConsumer(i)));
    this.kept = new Set();
    const loose = this.members.findIndex((keys) => keys.some((k) => this.byKey.get(k).kind === KIND.LOOSE));
    this.loose = loose >= 0 ? loose : null;
  }

  between(left, right, ordered) {
    let sum = 0;
    for (const a of left) {
      for (const b of right) {
        if (ordered) sum += this.context.calls.get(linkKey(a, b)) || 0;
        else sum += this.context.links.get(a < b ? linkKey(a, b) : linkKey(b, a)) || 0;
      }
    }
    return sum;
  }

  live() {
    return this.sizes.map((size, i) => i).filter((i) => this.sizes[i]).sort((a, b) => (this.sizes[a] - this.sizes[b]) || (a - b));
  }

  isConsumer(index) {
    if (this.fallback.has(index)) return true;
    return this.members[index].some((key) => stems(this.byKey.get(key).label).some((word) => CONSUMER_WORDS.has(word)));
  }

  merge(source, target) {
    this.members[target].push(...this.members[source]);
    this.terms[target] = dedupe([...this.terms[target], ...this.terms[source]]);
    this.sizes[target] += this.sizes[source];
    this.sizes[source] = 0;
    for (let other = 0; other < this.members.length; other += 1) {
      this.links[target][other] += this.links[source][other];
      this.links[other][target] += this.links[other][source];
      this.calls[target][other] += this.calls[source][other];
      this.calls[other][target] += this.calls[other][source];
      this.links[source][other] = this.links[other][source] = 0;
      this.calls[source][other] = this.calls[other][source] = 0;
    }
    this.links[target][target] = this.calls[target][target] = 0;
    this.members[source] = [];
    for (const flagged of [this.hubs, this.projects, this.kept]) {
      if (flagged.has(source)) flagged.add(target);
    }
  }

  // Every candidate under the floor, by its role in the imports: a hub, an
  // application or a project stays; a helper of one sibling goes inside it;
  // one shared by two goes into the larger; one linked to nothing is loose.
  place() {
    for (const index of this.live()) {
      if (this.sizes[index] >= this.floor || this.fallback.has(index)) continue;
      const live = this.live();
      const callers = new Set(live.filter((j) => j !== index && !this.consumers.has(j) && this.calls[j][index] >= MIN_LINKS));
      const owners = Array.from(callers).filter((j) => !this.hubs.has(j));
      const outgoing = live.filter((j) => j !== index).reduce((sum, j) => sum + this.calls[index][j], 0);
      const fitting = owners.filter((j) => this.sizes[j] + this.sizes[index] <= this.cap);
      if (this.hubs.has(index)) {
        if (this.sizes[index] < MIN_HUB_UNITS && this.loose !== null && this.loose !== index) this.merge(index, this.loose);
        else this.kept.add(index);
      } else if (this.projects.has(index) || callers.size >= 3) {
        this.kept.add(index);
      } else if ((owners.length === 1 || owners.length === 2) && fitting.length) {
        const target = fitting.slice().sort((a, b) => (this.sizes[b] - this.sizes[a]) || (a - b))[0];
        this.merge(index, target);
      } else if (callers.size || outgoing >= MIN_LINKS) {
        this.kept.add(index);
      } else if (this.loose !== null && this.loose !== index) {
        this.merge(index, this.loose);
      } else {
        this.kept.add(index);
      }
    }
  }

  // Over the budget the smallest candidate joins the sibling holding half of
  // the links it could follow, never a hub; under it, small leftovers join
  // whoever they link to most.
  towardBudget() {
    for (;;) {
      const live = this.live();
      const overBudget = live.length > BUDGET;
      const sources = overBudget ? live : live.filter((i) => this.sizes[i] < this.floor && !this.kept.has(i));
      let merged = false;
      for (const source of sources) {
        if (this.hubs.has(source) || this.fallback.has(source) || this.consumers.has(source)) continue;
        const home = this.home(source, overBudget);
        if (home !== null) {
          this.merge(source, home);
          merged = true;
          break;
        }
      }
      if (!merged) return;
    }
  }

  home(source, overBudget) {
    const live = this.live();
    const takers = live.filter((t) => t !== source && !this.hubs.has(t) && !this.consumers.has(t) && !this.fallback.has(t));
    const linked = takers.filter((t) => this.links[source][t] >= MIN_LINKS && this.sizes[source] + this.sizes[t] <= this.cap);
    if (!linked.length) return null;
    const home = linked.slice().sort((a, b) => (
      (this.links[source][b] - this.links[source][a]) || (this.sizes[a] - this.sizes[b]) || (a - b)
    ))[0];
    if (!overBudget) return home;
    const count = this.links[source][home];
    const degree = live.reduce((sum, other) => sum + this.links[source][other], 0);
    if (this.sizes[source] >= this.floor) return count * 2 >= degree ? home : null;
    if (this.sizes[source] < MIN_HUB_UNITS) return home;
    const followable = takers.reduce((sum, t) => sum + this.links[source][t], 0);
    if (count * 2 < followable || (this.sizes[home] < this.floor && count < PARTNER_SHARE * degree)) return null;
    return home;
  }

  groups() {
    const out = [];
    this.members.forEach((keys, index) => {
      if (!keys.length) return;
      const standing = this.hubs.has(index) || this.projects.has(index);
      const loose = keys.map((k) => this.byKey.get(k)).find((c) => c.kind === KIND.LOOSE);
      if (loose) {
        out.push({ label: candidateLabel(loose), keys, terms: this.terms[index], standing: false });
        return;
      }
      // A family of files is named by what its names share; otherwise the
      // biggest member names a fold.
      const biggest = Math.max(...keys.map((k) => this.context.sizes.get(k) || 0));
      const label = familyLabel(keys.map((k) => this.byKey.get(k)))
        || plainest(keys.filter((k) => (this.context.sizes.get(k) || 0) === biggest).map((k) => this.byKey.get(k)));
      out.push({ label, keys, terms: this.terms[index], standing });
    });
    return out;
  }
}

function affinityGroups(candidates, context) {
  const kin = kinshipGroups(candidates, context);
  // The fold is quadratic in memory and up to cubic in time over the groups;
  // past the cap (a flat directory of thousands of files) kinship alone
  // groups, and the ladder's limit pools the rest (D10).
  if (kin.length > MAX_FOLD_GROUPS) return kin;
  const fold = new Fold(kin, candidates, context);
  fold.place();
  fold.towardBudget();
  return fold.groups();
}

module.exports = {
  BUDGET,
  LOOSE_NAME,
  MAX_FOLD_GROUPS,
  affinityGroups,
  candidateLabel,
  candidateName,
  dedupe,
  kinshipGroups,
  linkKey,
  nameOf,
};
