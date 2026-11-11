'use strict';

/* global document, window */

/**
 * Page-side outline walker and the read and find ops. Serialised with String(fn) and run in the
 * page's isolated world after installReaderCore; it may only touch page globals and S.
 */
function installReaderOutline(S) {
  const NODE_BUDGET = 20000;
  const LINE_MAX = 300;
  const MAX_FRAME_DEPTH = 3;
  const OPTIONS_SHOWN = 8;
  const STATE_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);
  const HEADING = /^h([1-6])$/;

  function intersects(rect, fr, vw, vh) {
    const top = rect.top + fr.oy;
    const bottom = rect.bottom + fr.oy;
    const left = rect.left + fr.ox;
    const right = rect.right + fr.ox;
    return bottom > 0 && top < vh && (vw <= 0 || (right > 0 && left < vw));
  }
  // The box plus any overflow it shows, so a short parent cannot hide the children spilling out of it.
  function contentBox(el, rect) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.left + Math.max(rect.width, el.scrollWidth || 0),
      bottom: rect.top + Math.max(rect.height, el.scrollHeight || 0),
    };
  }
  function textRect(node, parent) {
    try {
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(node);
      if (typeof range.getBoundingClientRect === 'function') {
        const b = range.getBoundingClientRect();
        if (b && (b.width > 0 || b.height > 0)) return b;
      }
    } catch (error) {
      // fall back to the parent box
    }
    return parent.getBoundingClientRect();
  }
  function wrapLine(text, prefix) {
    const out = [];
    let rest = text;
    while (rest.length > LINE_MAX) {
      let at = rest.lastIndexOf(' ', LINE_MAX);
      if (at < LINE_MAX / 2) at = LINE_MAX;
      out.push(prefix + rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    out.push(prefix + rest);
    return out;
  }
  function frameHost(frame) {
    const raw = frame.getAttribute('src');
    if (!raw) return '';
    try {
      return new URL(raw, frame.ownerDocument.baseURI).host || 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }
  // Any access exception means a cross-origin frame.
  function frameContent(frame) {
    try {
      const doc = frame.contentDocument;
      return { body: doc && doc.body ? doc.body : null, blocked: false };
    } catch (error) {
      return { body: null, blocked: true };
    }
  }
  function childNodesOf(el) {
    if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
    if (el.localName === 'slot' && typeof el.assignedNodes === 'function') {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return Array.from(el.childNodes);
  }
  function optionLabel(opt) {
    return S.collapse(opt.label || opt.textContent);
  }

  // The state flags and value for one interactive element. A secret field reports only
  // (filled) or (empty); its value is never read into any string.
  function valueParts(el, role, secret) {
    const tag = el.localName;
    const parts = [];
    if (secret) {
      const isControl = tag === 'select' || tag === 'input' || tag === 'textarea';
      const filled = isControl ? String(el.value || '').length > 0 : S.collapse(el.textContent).length > 0;
      parts.push(filled ? '(filled)' : '(empty)');
      return parts;
    }
    const type = S.inputType(el);
    if (tag === 'select') {
      const chosen = Array.from(el.selectedOptions || []).map(optionLabel).filter(Boolean).join(', ');
      if (chosen) parts.push(`value="${S.cut(chosen, 200).replace(/"/g, "'")}"`);
      const labels = Array.from(el.options || []).map(optionLabel);
      const shown = labels.slice(0, OPTIONS_SHOWN).map((l) => S.cut(l, 40)).join(', ');
      if (shown) parts.push(`options: ${shown}${labels.length > OPTIONS_SHOWN ? ` (+${labels.length - OPTIONS_SHOWN} more)` : ''}`);
    } else if (type === 'checkbox' || type === 'radio') {
      if (el.checked) parts.push('checked');
    } else if (type === 'file') {
      const names = Array.from(el.files || []).map((f) => f.name).join(', ');
      if (names) parts.push(`value="${S.cut(S.collapse(names), 200).replace(/"/g, "'")}"`);
    } else if (tag === 'input' && !/^(button|submit|reset|image|hidden|color)$/.test(type)) {
      const v = S.collapse(el.value);
      if (v) parts.push(`value="${S.cut(v, 200).replace(/"/g, "'")}"`);
    } else if (tag === 'textarea' || S.isEditableHost(el)) {
      const v = S.collapse(tag === 'textarea' ? el.value : el.textContent);
      if (v) parts.push(`value="${S.cut(v, 200).replace(/"/g, "'")}"`);
    }
    if (STATE_ROLES.has(role) && tag !== 'input' && el.getAttribute('aria-checked') === 'true') parts.push('checked');
    if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') parts.push('pressed');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true') parts.push('expanded');
    else if (expanded === 'false') parts.push('collapsed');
    if (tag === 'summary' && el.parentElement && el.parentElement.hasAttribute('open')) parts.push('expanded');
    return parts;
  }
  function controlItem(el, role) {
    const ref = S.assign(el);
    const name = S.accName(el);
    // A label standing in for a hidden toggle reports that toggle's state.
    const state = S.labelControl(el) || el;
    const secret = S.isSecret(state);
    const parts = [ref ? `[${ref}]` : '[-]', role];
    if (name) parts.push(`"${name.replace(/"/g, "'")}"`);
    const href = S.hrefOf(el);
    if (href) parts.push('->', S.cut(href, 120));
    parts.push(...valueParts(state, role, secret));
    if (S.isDisabled(state)) parts.push('disabled');
    return { kind: 'ctl', text: parts.join(' '), el, ref, role, name };
  }

  // The cells of one table row share a line, so a model reading it keeps the columns together.
  function joinRows(items) {
    const lines = [];
    let joining = false;
    for (const item of items) {
      if (joining) lines[lines.length - 1] += ` | ${item.text}`;
      else lines.push(item.text);
      joining = item.joinNext === true;
    }
    return lines;
  }
  function isCell(el) {
    return /^(td|th)$/.test(el.localName) || /^(cell|gridcell|columnheader|rowheader)$/.test(el.getAttribute('role') || '');
  }

  // Walks the rendered tree in DOM order and returns outline items. Options: cull (viewport
  // only), limit (stop once the collected text exceeds it).
  function walk(root, opts) {
    const st = { items: [], nodes: 0, chars: 0, stop: false, nodeCut: false, buf: '', bufEl: null, prefix: '', nameOnly: 0 };
    const vh = window.innerHeight || 0;
    const vw = window.innerWidth || 0;
    const cull = Boolean(opts.cull) && vh > 0;

    function push(item) {
      st.items.push(item);
      st.chars += item.text.length + 1;
      if (st.chars > opts.limit) st.stop = true;
    }
    function flush() {
      const text = S.collapse(st.buf);
      if (text) {
        const kind = st.prefix ? 'heading' : 'text';
        for (const line of wrapLine(text, st.prefix)) push({ kind, text: line, el: st.bufEl });
      }
      st.buf = '';
      st.bufEl = null;
    }
    function visitText(node, fr) {
      if (st.nameOnly) return;
      const parent = S.parentOf(node);
      if (!/\S/.test(node.nodeValue)) {
        if (st.buf) st.buf += ' ';
        return;
      }
      const cs = parent && S.styleOf(parent);
      if (cs && (cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.fontSize) === 0)) return;
      if (cull && parent && S.layoutOf(node.ownerDocument) && !intersects(textRect(node, parent), fr, vw, vh)) return;
      st.buf += node.nodeValue;
      if (!st.bufEl) st.bufEl = parent;
    }
    function visitFrame(el, fr, rect) {
      flush();
      const content = frameContent(el);
      if (!content.body) {
        const host = frameHost(el);
        if (host || content.blocked) push({ kind: 'frame', text: `[frame: ${host || 'unknown'}]`, el });
        return;
      }
      if (fr.depth >= MAX_FRAME_DEPTH) return;
      const inner = { ox: fr.ox + (rect ? rect.left + (el.clientLeft || 0) : 0), oy: fr.oy + (rect ? rect.top + (el.clientTop || 0) : 0), depth: fr.depth + 1 };
      visit(content.body, inner);
      flush();
    }
    function visitChildren(el, fr, onlySummary) {
      for (const kid of childNodesOf(el)) {
        if (st.stop) return;
        if (onlySummary && !(kid.nodeType === 1 && kid.localName === 'summary')) continue;
        visit(kid, fr);
      }
    }
    function visitRow(el, fr) {
      const start = st.items.length;
      for (const cell of childNodesOf(el)) {
        if (st.stop) break;
        if (cell.nodeType !== 1) continue;
        const before = st.items.length;
        visit(cell, fr);
        flush();
        // An empty cell still holds a column, or everything after it would shift left.
        if (st.items.length === before && !st.stop && isCell(cell) && S.hideKind(cell, S.styleOf(cell), null) !== 'prune') {
          push({ kind: 'text', text: '-', el: cell });
        }
      }
      for (let i = start; i < st.items.length - 1; i += 1) st.items[i].joinNext = true;
    }
    // A generic clickable (onclick or tabindex) is one line only when it is small and holds
    // no other control; a clickable container is walked instead.
    function isLeafControl(el, role) {
      if (role !== 'clickable') return true;
      if (S.textOf(el, 120).length > 100) return false;
      return !el.querySelector('a[href],button,input,select,textarea,summary,[tabindex],[onclick],[role],[contenteditable]');
    }
    function visitElement(el, fr) {
      const tag = el.localName;
      if (S.SKIP_TAGS.has(tag)) return;
      const doc = el.ownerDocument;
      const layout = S.layoutOf(doc);
      const cs = S.styleOf(el);
      const rect = layout ? el.getBoundingClientRect() : null;
      const hide = S.hideKind(el, cs, rect);
      if (hide === 'prune') return;
      if (cull && rect && rect.width > 0 && rect.height > 0 && !(cs && /^(fixed|sticky)$/.test(cs.position)) && !intersects(contentBox(el, rect), fr, vw, vh)) return;
      if (tag === 'iframe' || tag === 'frame') {
        if (hide !== 'skip') visitFrame(el, fr, rect);
        return;
      }
      const block = Boolean(cs) && !S.INLINE_DISPLAY.test(cs.display || 'inline');
      const role = hide === 'skip' ? null : S.classify(el);
      if (role && isLeafControl(el, role)) {
        flush();
        push(controlItem(el, role));
        return;
      }
      if (tag === 'br' || tag === 'hr') {
        flush();
        return;
      }
      // A layout table's outer row holds whole tables, which must not fold into one line.
      if ((tag === 'tr' || el.getAttribute('role') === 'row') && !el.querySelector('table')) {
        flush();
        visitRow(el, fr);
        flush();
        return;
      }
      const heading = HEADING.exec(tag) || (el.getAttribute('role') === 'heading' ? [null, String(Math.min(6, Math.max(1, parseInt(el.getAttribute('aria-level'), 10) || 2)))] : null);
      // The control this label belongs to already prints the label's words as its name.
      const control = S.labelControl(el);
      const nameOnly = Boolean(control) && S.rendered(control);
      if (block || heading) flush();
      if (heading) st.prefix = `${'#'.repeat(Number(heading[1]))} `;
      if (nameOnly) st.nameOnly += 1;
      visitChildren(el, fr, tag === 'details' && !el.hasAttribute('open'));
      if (nameOnly) st.nameOnly -= 1;
      if (block || heading) flush();
      if (heading) st.prefix = '';
    }
    function visit(node, fr) {
      if (st.stop) return;
      st.nodes += 1;
      if (st.nodes > NODE_BUDGET) {
        st.stop = true;
        st.nodeCut = true;
        return;
      }
      if (node.nodeType === 3) visitText(node, fr);
      else if (node.nodeType === 1) visitElement(node, fr);
    }

    visit(root, { ox: 0, oy: 0, depth: 0 });
    flush();
    return { items: st.items, stopped: st.stop, nodeCut: st.nodeCut };
  }

  function pageMetrics() {
    const de = document.documentElement;
    const body = document.body;
    return {
      scrollY: Math.round(window.scrollY || 0),
      viewportHeight: Math.round(window.innerHeight || 0),
      pageHeight: Math.round(Math.max((de && de.scrollHeight) || 0, (body && body.scrollHeight) || 0)),
    };
  }
  function noteFor(length) {
    return `[cut at ${length} chars: use find, scroll, or read with a ref]`;
  }

  // The media line: the one video or audio element worth telling the model about. Those tags stay out of the outline.
  function mediaArea(el) {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  }
  function pickMedia() {
    const els = Array.from(document.querySelectorAll('video, audio'));
    const playing = els.find((el) => !el.paused && !el.ended);
    if (playing) return playing;
    const known = els.filter((el) => !Number.isNaN(Number(el.duration)));
    return known.reduce((best, el) => (best && mediaArea(best) >= mediaArea(el) ? best : el), null);
  }
  function clock(seconds, long) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const sec = String(total % 60).padStart(2, '0');
    if (!long) return `${Math.floor(total / 60)}:${sec}`;
    return `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${sec}`;
  }
  function mediaPosition(el) {
    const duration = Number(el.duration);
    if (Number.isNaN(duration)) return null;
    if (!Number.isFinite(duration)) return 'live';
    const long = duration >= 3600;
    return `${clock(el.currentTime, long)} of ${clock(duration, long)}`;
  }
  function mediaState(el) {
    if (el.ended) return 'ended';
    if (el.paused) return 'paused';
    return el.readyState < 3 ? 'loading' : 'playing';
  }
  function mediaSound(el, state, sound) {
    if (el.muted || el.volume === 0) return 'muted by the page';
    if (sound === 'playing') return 'sound on';
    if (sound === 'muted') return 'muted in Jenny';
    return state === 'playing' || state === 'loading' ? 'no sound yet' : null;
  }
  function readMedia(sound) {
    const el = pickMedia();
    if (!el) return { line: sound === 'playing' ? '\nMedia: this page is playing sound.' : '', media: null };
    const ad = Boolean(el.closest('.ad-showing'));
    const kind = ad ? 'an ad' : el.localName;
    const state = mediaState(el);
    const position = mediaPosition(el);
    const parts = [`${kind} ${state}`, position, mediaSound(el, state, sound)].filter(Boolean);
    const duration = Number.isFinite(Number(el.duration)) ? Number(el.duration) : null;
    return { line: `\nMedia: ${parts.join(', ')}.`, media: { kind: el.localName, state, position, duration, ad } };
  }

  function read(args) {
    const hasRef = args.ref !== undefined && args.ref !== null && args.ref !== '';
    let root = document.body || document.documentElement;
    if (hasRef) {
      root = S.resolve(args.ref);
      if (!root) return { status: 'stale', ref: args.ref };
    }
    const viewportScope = !hasRef && args.scope !== 'full';
    const budget = viewportScope ? S.VIEWPORT_BUDGET : S.FULL_BUDGET;
    const m = pageMetrics();
    const cull = viewportScope && S.layoutOf(document);
    const { items, nodeCut } = walk(root, { cull, limit: budget });
    let showing;
    if (hasRef) {
      showing = `Showing the subtree of ${args.ref}. No viewport culling.`;
    } else if (viewportScope) {
      const bottom = m.pageHeight > 0 ? Math.min(m.scrollY + m.viewportHeight, m.pageHeight) : m.scrollY + m.viewportHeight;
      const more = m.scrollY > 0 || bottom < m.pageHeight;
      showing = `Showing ${m.scrollY}-${bottom} px of ${m.pageHeight} px.${more ? ' Scroll or find for more.' : ''}`;
    } else {
      showing = `Showing the full page (${m.pageHeight} px). No viewport culling.`;
    }
    const title = S.cut(S.collapse(document.title), 200);
    const url = S.cut(S.clean(window.location.href), 300);
    // The browser's own viewer draws a PDF outside the page, so a read finds nothing and would otherwise look like an empty page.
    const pdf = document.contentType === 'application/pdf' ? '\nThis is a PDF in the browser viewer. Its text cannot be read from here, so tell the user it is open for them to read.' : '';
    const mediaInfo = readMedia(args.sound);
    const head = `Page: ${title}\nURL: ${url}\n${showing}${pdf}${mediaInfo.line}`;
    const lines = joinRows(items);
    const build = (count) => (count ? `${head}\n\n${lines.slice(0, count).join('\n')}` : head);
    let text = build(lines.length);
    const truncated = nodeCut || text.length > budget;
    if (truncated) {
      // Drop whole trailing lines until the text plus the note fits the budget.
      let count = lines.length;
      let length = text.length;
      while (count > 0 && length + 1 + noteFor(length).length > budget) {
        count -= 1;
        length = build(count).length;
      }
      text = `${build(count)}\n${noteFor(length)}`;
    }
    return {
      status: 'ok', title, url, scrollY: m.scrollY, viewportHeight: m.viewportHeight, pageHeight: m.pageHeight,
      text, truncated, refCount: S.refCount, media: mediaInfo.media,
    };
  }

  const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton']); // not password: typing into one is refused
  function snippetAround(text, query) {
    const at = Math.max(0, text.toLowerCase().indexOf(query));
    const start = Math.max(0, at - 60);
    return text.slice(start, start + 160);
  }
  function find(args) {
    const query = S.collapse(args.query).toLowerCase();
    if (!query) return { status: 'ok', total: 0, matches: [], fields: 0 };
    const { items } = walk(document.body || document.documentElement, { cull: false, limit: Infinity });
    const controls = [];
    const texts = [];
    // How many places the page has to type or choose in, so "no match" can say whether a field exists at all.
    let fields = 0;
    let unseenFrame = false;
    // The kind matches too, so a field with no label can still be found ("textbox", "search"). Four letters
    // at least, or a short word would match every link and button.
    const kindMatches = (role) => query.length >= 4 && role.startsWith(query);
    for (const item of items) {
      if (item.kind === 'ctl') {
        if (FIELD_ROLES.has(item.role)) fields += 1;
        if (item.name.toLowerCase().includes(query) || kindMatches(item.role)) controls.push(item);
      } else if (item.kind === 'frame') {
        unseenFrame = true;
      } else if (item.text.toLowerCase().includes(query)) {
        texts.push(item);
      }
    }
    // A frame this search cannot see into may hold the field, so "none" would be a guess.
    if (unseenFrame && fields === 0) fields = null;
    const ordered = controls.concat(texts);
    const matches = ordered.slice(0, 20).map((item) => {
      if (item.kind === 'ctl') return { ref: item.ref, role: item.role, name: item.name, snippet: snippetAround(item.name, query) };
      const ref = item.el ? S.assign(item.el) : '';
      return { ref, role: item.kind === 'heading' ? 'heading' : 'text', name: '', snippet: snippetAround(item.text.replace(/^#+ /, ''), query) };
    });
    return { status: 'ok', total: ordered.length, matches, fields };
  }

  S.walk = walk;
  S.ops.read = read;
  S.ops.find = find;
}

module.exports = { installReaderOutline };
