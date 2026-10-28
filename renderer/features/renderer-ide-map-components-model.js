/* renderer/features/renderer-ide-map-components-model.js - the pure, DOM-free
 * model of the File Map's Components lens (row 77 phase 3): indexes
 * `graph.components` (services/workspace-file-map-components.js), lays a level
 * out in rows, picks the links to draw, words the labels and re-finds an open
 * component after a rescan. The view lives in renderer-ide-map-components-lens.js.
 *
 * Exports:
 *   indexComponents(draft)          → { byId, childrenOf(id|null), filesOf(id), scopeOf(id|null) }
 *   levelRelations(draft, scopeId)  → the relations between one level's components
 *   strongLinks(relations)          → the links drawn at rest
 *   layoutRows(children, relations) → [{ components, unlinked }] top to bottom
 *   labelFor(component, parent, filesOf) → { key, params? } or { text }
 *   namePath / resolvePath          → an open component as names, and back
 *   leafCaptionKind(scope)          → 'small' | 'cohesive' | 'unsplit'
 *   axisKind(scope)                 → 'folder' | 'families' | 'roles' | 'merged'
 *   commonDir, heaviest, searchCount, languageMix, boxWidth, linkPath
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapComponentsModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROOT_SCOPE_ID = 'root';
  // Links drawn at rest: at least this share of the level's heaviest link,
  // at most STRONG_MAX of them. Hovering a box draws all of its links.
  const STRONG_SHARE = 0.1;
  const STRONG_MAX = 12;
  // Links that rank the rows: at least this share of the heaviest and 2.
  const RANK_SHARE = 0.03;
  const MAX_ROWS = 3;
  const BOX_MIN_W = 150;
  const BOX_GROW_W = 120;

  function compare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function indexComponents(draft) {
    const list = draft && Array.isArray(draft.components) ? draft.components : [];
    const byId = new Map();
    const kids = new Map();
    for (const component of list) {
      if (!component || typeof component.id !== 'string') continue;
      byId.set(component.id, component);
      const key = component.parentId == null ? null : component.parentId;
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(component);
    }
    const scopes = new Map((draft && Array.isArray(draft.scopes) ? draft.scopes : []).map((s) => [s.id, s]));
    const memo = new Map();
    function childrenOf(id) {
      return kids.get(id == null ? null : id) || [];
    }
    // Only leaves list their files (D15); a box's files are its leaves'.
    function filesOf(id) {
      if (memo.has(id)) return memo.get(id);
      const children = childrenOf(id);
      const component = byId.get(id);
      const files = children.length
        ? children.flatMap((child) => filesOf(child.id))
        : (component && Array.isArray(component.files) ? component.files : []);
      memo.set(id, files);
      return files;
    }
    function scopeOf(id) {
      return scopes.get(id == null ? ROOT_SCOPE_ID : id) || null;
    }
    return { byId, childrenOf, filesOf, scopeOf };
  }

  function levelRelations(draft, scopeId) {
    const key = scopeId == null ? ROOT_SCOPE_ID : scopeId;
    const list = draft && Array.isArray(draft.relations) ? draft.relations : [];
    return list.filter((r) => r && r.scopeId === key && Number.isFinite(r.weight));
  }

  function heaviest(relations) {
    return relations.reduce((max, r) => Math.max(max, r.weight), 1);
  }

  function strongLinks(relations) {
    const floor = heaviest(relations) * STRONG_SHARE;
    return relations
      .filter((r) => r.weight >= floor)
      .sort((a, b) => (b.weight - a.weight) || compare(a.from, b.from) || compare(a.to, b.to))
      .slice(0, STRONG_MAX);
  }

  function bySize(a, b) {
    return (b.fileCount - a.fileCount) || compare(a.id, b.id);
  }

  // Importers above what they import: rank by longest path over the links of
  // some weight (the heavier direction of a two-way pair), clamp to three
  // rows, order each row under the boxes it links to above. Boxes with no
  // import link at all take a last row of their own.
  function layoutRows(children, relations) {
    const ids = new Set(children.map((c) => c.id));
    const level = relations.filter((r) => ids.has(r.from) && ids.has(r.to));
    const weight = new Map(level.map((r) => [`${r.from}>${r.to}`, r.weight]));
    const floor = Math.max(2, heaviest(level) * RANK_SHARE);
    const ranking = level.filter((r) => {
      if (r.weight < floor) return false;
      const back = weight.get(`${r.to}>${r.from}`) || 0;
      return back < r.weight || (back === r.weight && r.from < r.to);
    });
    const rank = new Map(children.map((c) => [c.id, 0]));
    for (let pass = 0; pass < children.length; pass += 1) {
      let changed = false;
      for (const r of ranking) {
        const next = rank.get(r.from) + 1;
        if (next < children.length && rank.get(r.to) < next) {
          rank.set(r.to, next);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const linked = new Set(level.flatMap((r) => [r.from, r.to]));
    const rows = [];
    const unlinked = [];
    for (const component of children) {
      if (!linked.has(component.id)) {
        unlinked.push(component);
        continue;
      }
      const r = Math.min(rank.get(component.id), MAX_ROWS - 1);
      (rows[r] = rows[r] || []).push(component);
    }
    const out = rows.filter(Boolean).map((row) => row.sort(bySize));
    for (let i = 1; i < out.length; i += 1) {
      const above = new Map(out[i - 1].map((c, k) => [c.id, k]));
      const centre = new Map(out[i].map((c) => {
        const ks = ranking
          .filter((r) => (r.to === c.id && above.has(r.from)) || (r.from === c.id && above.has(r.to)))
          .map((r) => above.get(r.to === c.id ? r.from : r.to));
        return [c.id, ks.length ? ks.reduce((s, k) => s + k, 0) / ks.length : Infinity];
      }));
      out[i].sort((a, b) => (centre.get(a.id) - centre.get(b.id)) || bySize(a, b));
    }
    const result = out.map((components) => ({ components, unlinked: false }));
    if (unlinked.length) result.push({ components: unlinked.sort(bySize), unlinked: true });
    return result;
  }

  function commonDir(files) {
    if (!files.length) return '';
    let parts = String(files[0]).split('/').slice(0, -1);
    for (const file of files) {
      const other = String(file).split('/').slice(0, -1);
      let i = 0;
      while (i < parts.length && parts[i] === other[i]) i += 1;
      parts = parts.slice(0, i);
    }
    return parts.join('/');
  }

  // The label as an i18n descriptor, or literal text for names that come
  // from the workspace itself (folders, files, file-name families).
  function labelFor(component, parent, filesOf) {
    const label = component && component.label;
    if (!label || typeof label.kind !== 'string') return { text: String((component && component.name) || '') };
    switch (label.kind) {
      case 'family':
        return label.more
          ? { key: 'ide.map.components.label.familyMore', params: { name: `${label.stem}*` } }
          : { text: `${label.stem}*` };
      case 'residual':
        return { key: 'ide.map.components.label.residual', params: { name: label.text } };
      case 'other':
        return label.word
          ? { key: 'ide.map.components.label.otherWord', params: { word: label.word } }
          : { key: 'ide.map.components.label.other' };
      case 'all':
        return { key: 'ide.map.components.label.all' };
      case 'loose': {
        const dir = String(label.dir || '');
        const parentLabel = parent && parent.label;
        if (dir && parentLabel && parentLabel.kind === 'loose' && parentLabel.dir === dir) {
          return { key: 'ide.map.components.label.ungrouped' };
        }
        // Inside its own folder the breadcrumb already names the folder.
        if (!dir || (parent && commonDir(filesOf(parent.id)) === dir)) {
          return { key: 'ide.map.components.label.topLevel' };
        }
        return { key: 'ide.map.components.label.filesIn', params: { dir } };
      }
      default:
        return { text: String(component.name || label.text || label.word || '') };
    }
  }

  // An open component as the names on its path from the root: ids are
  // positions and can name another box after a rescan (F3).
  function namePath(index, id) {
    const names = [];
    for (let cur = index.byId.get(id); cur; cur = cur.parentId == null ? null : index.byId.get(cur.parentId)) {
      names.unshift(cur.name);
    }
    return names;
  }

  // The deepest component matching the names, or null for the root.
  function resolvePath(index, names) {
    let current = null;
    for (const name of Array.isArray(names) ? names : []) {
      const next = index.childrenOf(current).find((c) => c.name === name);
      if (!next) break;
      current = next.id;
    }
    return current;
  }

  function leafCaptionKind(scope) {
    if (!scope) return 'unsplit';
    return scope.leafKind === 'small' ? 'small' : 'cohesive';
  }

  function axisKind(scope) {
    const axis = scope ? (scope.axis || scope.rung) : '';
    if (axis === 'files') return 'families';
    if (axis === 'role') return 'roles';
    if (axis === 'unmerge' || (scope && scope.rung === 'unmerge')) return 'merged';
    return 'folder';
  }

  function searchCount(files, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return 0;
    let count = 0;
    for (const file of files) if (String(file).toLowerCase().includes(q)) count += 1;
    return count;
  }

  function languageMix(files, langClassFor, slots) {
    const counts = new Map();
    for (const file of files) {
      const lang = langClassFor(file);
      counts.set(lang, (counts.get(lang) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => (b[1] - a[1]) || compare(a[0], b[0]))
      .slice(0, slots || 4);
  }

  function boxWidth(fileCount, largest) {
    return Math.round(BOX_MIN_W + BOX_GROW_W * Math.sqrt(fileCount / Math.max(1, largest)));
  }

  // SVG path for a link between two box rects ({ l, r, t, b, cx, cy }):
  // down a vertical cubic, up a curve off to the right, along a row a lift.
  function linkPath(s, t) {
    if (t.t > s.b + 4) {
      const x1 = s.cx + (t.cx - s.cx) * 0.18;
      const x2 = t.cx - (t.cx - s.cx) * 0.18;
      const my = (s.b + t.t) / 2;
      return `M${x1},${s.b} C${x1},${my} ${x2},${my} ${x2},${t.t - 2}`;
    }
    if (s.t > t.b + 4) {
      const x1 = s.cx + 18;
      const x2 = t.cx + 18;
      const my = (t.b + s.t) / 2;
      return `M${x1},${s.t} C${x1 + 30},${my} ${x2 + 30},${my} ${x2},${t.b + 2}`;
    }
    const right = t.cx > s.cx;
    const x1 = right ? s.r : s.l;
    const x2 = right ? t.l : t.r;
    const lift = Math.min(40, Math.abs(x2 - x1) / 3);
    const dir = right ? 1 : -1;
    return `M${x1},${s.cy - 6} C${x1 + dir * 24},${s.cy - 6 - lift} ${x2 - dir * 24},${t.cy - 6 - lift} ${x2 - dir * 2},${t.cy - 6}`;
  }

  return {
    ROOT_SCOPE_ID,
    STRONG_MAX,
    axisKind,
    boxWidth,
    commonDir,
    heaviest,
    indexComponents,
    labelFor,
    languageMix,
    layoutRows,
    leafCaptionKind,
    levelRelations,
    linkPath,
    namePath,
    resolvePath,
    searchCount,
    strongLinks,
  };
});
