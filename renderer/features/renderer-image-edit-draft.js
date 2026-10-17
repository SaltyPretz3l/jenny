(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../inventory/image-edit-draft'), require('./renderer-image-selection'));
  else root.rendererImageEditDraft = factory(root.inventoryImageEditDraft, root.rendererImageSelection);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventory, selectionUtils) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || ((key, fallback) => fallback);
  const KEY = 'jenny.image-edit-drafts.v1';
  const ID = /^[a-zA-Z0-9_-]{1,240}$/;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function valid(record) {
    return record && ID.test(record.sessionId || '') && ID.test(record.artifactId || '')
      && Number.isInteger(record.width) && Number.isInteger(record.height) && record.width > 0 && record.height > 0 && record.width * record.height <= 4194304
      && (!record.region || (['box', 'ellipse', 'freehand'].includes(record.region.kind) && Array.isArray(record.region.points)
        && record.region.points.length >= (record.region.kind === 'freehand' ? 3 : 2) && record.region.points.length <= (record.region.kind === 'freehand' ? 128 : 2) && record.region.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
          && p[0] >= 0 && p[0] <= record.width && p[1] >= 0 && p[1] <= record.height)));
  }
  function normalize(record) {
    if (!valid(record)) return null;
    return { sessionId: record.sessionId, artifactId: record.artifactId, width: record.width, height: record.height,
      title: Array.from(String(record.title || '')).slice(0, 100).join(''), revision: String(record.revision || '').slice(0, 100),
      region: record.region ? { kind: record.region.kind, points: record.region.points.map(p => [p[0], p[1]]) } : null };
  }
  async function sendWithDraft(send, prompt, options, controller, sessionId, retry) {
    const supplied = options.imageEditSnapshot || retry?.imageEditSnapshot;
    const record = normalize(supplied || (options.attachImageEditDraft === true ? controller?.snapshot(sessionId) : null));
    const draft = record?.sessionId === sessionId ? record : null;
    if (draft) controller?.consume(draft); // claim before the first asynchronous preflight
    let accepted = false;
    try {
      const result = await send(prompt, { ...options, imageEditSnapshot: draft, imageEditContextIncluded: Boolean(retry) });
      accepted = Boolean(result && !result.rejected && !result.failed && (result.streamId || result.work_id || result.queued || result.acceptanceUnknown));
      return result;
    } finally { if (draft && !accepted && !options.outboxDispatch) controller?.restore(draft); }
  }
  function promptContext(record) {
    if (!valid(record)) return '';
    return '\n\n[Image selected by the user for editing in this chat. Use image_generate to edit this reference; do not generate an unrelated replacement. '
      + 'Copy source_artifact_id and region exactly; if region is absent, omit region. Omit width and height to keep the source size. Give the edited variant a short descriptive title.\n'
      + JSON.stringify({ source_artifact_id: record.artifactId, ...(record.region ? { region: normalize(record).region } : {}) }) + ']';
  }
  function createController({ documentRef: doc, windowRef: win, getBindings, readArtifact, storage }) {
    let disposed = false; let records = new Map(); const cards = new Map();
    try {
      const saved = storage?.getItem(KEY) || '';
      if (saved.length <= 65536) for (const record of JSON.parse(saved || '[]').slice(-16)) if (valid(record)) records.set(record.sessionId, normalize(record));
    } catch (_error) { /* corrupt or unavailable local draft storage */ }
    function save() { try { storage?.setItem(KEY, JSON.stringify([...records.values()])); } catch (_error) { /* live drafts still work */ } }
    function removeCard(host) {
      const view = cards.get(host); if (!view) return;
      view.image.onload = null; view.image.removeAttribute('src'); view.canvas.width = view.canvas.height = 0; view.root.remove(); cards.delete(host);
    }
    function clear(sessionId, revision) {
      if (revision && records.get(sessionId)?.revision !== revision) return;
      records.delete(sessionId); save(); refresh();
    }
    function refresh() {
      if (disposed) return;
      const bindings = getBindings() || []; const hosts = new Set(bindings.map(b => b.input?.closest('.composer') || b.input?.parentElement).filter(Boolean));
      for (const host of cards.keys()) if (!hosts.has(host)) removeCard(host);
      for (const binding of bindings) {
        const host = binding.input?.closest('.composer') || binding.input?.parentElement;
        if (!host) continue;
        const record = records.get(binding.sessionId);
        if (!record) { removeCard(host); continue; }
        if (cards.get(host)?.revision === record.revision) continue;
        removeCard(host);
        const view = inventory.createCard(doc, { remove: jt('imageEdit.remove', 'Remove image edit'), preview: jt('imageEdit.preview', 'Image selected for editing') });
        view.revision = record.revision; cards.set(host, view); host.prepend(view.root);
        const label = record.region ? jt('imageEdit.selectionDraft', 'Selected region') : jt('imageEdit.wholeDraft', 'Whole image');
        view.text.textContent = label + ' · ' + String(record.title || jt('imageViewer.title', 'Image viewer'));
        view.remove.addEventListener('click', () => clear(record.sessionId, record.revision));
        Promise.resolve(readArtifact(record.sessionId, record.artifactId)).then(result => {
          if (disposed || cards.get(host) !== view || !getBindings().some(b => b.sessionId === record.sessionId && (b.input?.closest('.composer') || b.input?.parentElement) === host)) return;
          const src = result?.asset_data_url;
          if (typeof src !== 'string' || !/^data:image\/png;base64,/.test(src)) throw new Error('unavailable');
          view.image.onload = () => { if (cards.get(host) === view) selectionUtils.draw(view.canvas, record.region, record.width, record.height, 0.12); };
          view.image.src = src;
        }).catch(() => { if (cards.get(host) === view) view.text.textContent = jt('chat.artifactFigure.unavailable', 'Image unavailable'); });
      }
    }
    function restore(record) {
      if (disposed || !valid(record) || records.has(record.sessionId)) return false;
      records.set(record.sessionId, normalize(record));
      while (records.size > 16) records.delete(records.keys().next().value);
      save(); refresh(); return true;
    }
    async function add(record) {
      if (disposed || !valid(record) || !getBindings().some(b => b.sessionId === record.sessionId)) return false;
      const read = await readArtifact(record.sessionId, record.artifactId);
      const binding = getBindings().find(b => b.sessionId === record.sessionId);
      if (disposed || !binding || !read?.asset_data_url?.startsWith('data:image/png;base64,')) return false;
      const item = { ...normalize(record), title: String(read.artifact?.title || '').slice(0, 100), revision: Date.now().toString(36) + Math.random().toString(36).slice(2) };
      records.delete(item.sessionId); records.set(item.sessionId, item);
      while (records.size > 16) records.delete(records.keys().next().value);
      save(); refresh(); return binding.input;
    }
    doc.addEventListener('composer-state-rendered', refresh);
    win.addEventListener('jenny:focused-chat-changed', refresh);
    refresh();
    return { add, restore, refresh, clear, snapshot: (id) => records.has(id) ? clone(records.get(id)) : null,
      consume: (record) => { if (record) clear(record.sessionId, record.revision); },
      dispose() { disposed = true; doc.removeEventListener('composer-state-rendered', refresh); win.removeEventListener('jenny:focused-chat-changed', refresh); for (const host of cards.keys()) removeCard(host); records.clear(); } };
  }
  return { createController, promptContext, valid, normalize, sendWithDraft };
});
