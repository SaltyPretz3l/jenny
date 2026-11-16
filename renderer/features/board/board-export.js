/* renderer/features/board/board-export.js - getting a board out of Jenny, and a .jennyboard file back in (UMD, global
 * rendererBoardExport; row 150 slice B10, plan PROJECT_BOARD_2026-11-13 D14).
 *
 * Pure builders take a board document and return text, touching no DOM. boardToSvg: the content box plus 24 px, all
 * board text XML-escaped, only svg/g/rect/text/tspan/line/path/polygon/image/defs/marker/clipPath/title written, a
 * picture only as a data URI of the four picture types, colours from `palette` (hex strings read from the theme).
 * boardToExcalidraw: a rectangle and bound text per card and group, a bound arrow per connector, ids from the item ids,
 * seeds from a small hash (no clock, no randomness). boardToMarkdown: an outline in reading order with Markdown
 * characters escaped, so a card cannot forge a heading, a link or an image. svgToPngBase64 draws through an Image and a
 * canvas, refused past 16,384 px a side or 64 megapixels. createBoardTransferActions is the Export menu and the Import
 * call: the four page-built files save through jennyShell.dialog.saveFile (as renderer-sketch-export.js does); the
 * .jennyboard file and import go through the source (main shows the dialog). Every outcome is one notice, except a
 * dialog the person closed, which says nothing; nothing exported is ever inserted into the page as markup. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardExport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const [MARGIN, FONT, LINE, PAD, CHAR_W] = [24, 13, 18, 10, 7.2]; // CHAR_W: an average glyph at 13 px, for wrapping
  const FONT_FAMILY = ['system-ui', '-apple-system', 'sans-serif'].join(', '); // a font stack, not words to translate
  const [MAX_SIDE, MAX_PIXELS] = [16384, 64 * 1000 * 1000];
  const MIB = 1024 * 1024;
  const [PICTURE_MAX, PICTURES_TOTAL, SAVE_BASE64_MAX] = [10 * MIB, 24 * MIB, 32 * MIB]; // the last is the save dialog's cap
  const BOARD_CAP = 20; // the model's LIMITS.boards_per_project
  const MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const TONES = Object.freeze(['amber', 'blue', 'green', 'red']);
  const DEFAULT_PALETTE = Object.freeze({ background: '#ffffff', card: '#f6f6f7', border: '#d4d4da', text: '#1d1d22', muted: '#6b6b76',
    group: '#b4b4bf', amber: '#c98a00', blue: '#2f6fdf', green: '#2e9d57', red: '#d64545' });
  const PALETTE_TOKENS = Object.freeze({ background: '--bg-base', card: '--bg-surface', border: '--border-subtle', text: '--text-primary',
    muted: '--text-muted', group: '--border-default', amber: '--accent-amber', blue: '--state-info', green: '--state-success', red: '--state-danger' });
  const EXCALI_TONES = Object.freeze({ amber: '#ffec99', blue: '#a5d8ff', green: '#b2f2bb', red: '#ffc9c9' });
  const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
  const WEB_RE = /^https?:\/\/[^\s/?#]+\S*$/i;
  const hasOwn = Object.prototype.hasOwnProperty;

  /* ---------------------------------------------------------------- shared */

  const values = (map) => (map && typeof map === 'object' ? Object.keys(map).map((key) => map[key]) : []);
  const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);
  const fmt = (n) => String(Math.round(n * 100) / 100);
  const str = (v) => (typeof v === 'string' ? v : '');
  const aliasNum = (alias) => (typeof alias === 'string' && alias ? Number(alias.slice(1)) || Infinity : Infinity);
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const rectOf = (item) => ({ x: num(item.x, 0), y: num(item.y, 0), w: Math.max(8, num(item.w, 200)), h: Math.max(8, num(item.h, 100)) });
  const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const toneOf = (tone) => (TONES.indexOf(tone) >= 0 ? tone : '');

  function readingSort(a, b) {
    return num(a.y, 0) - num(b.y, 0) || num(a.x, 0) - num(b.x, 0) || aliasNum(a.alias) - aliasNum(b.alias) || byId(a, b);
  }

  /** Groups in reading order (aliased first by alias, as board-text.js does), each with its cards; then the cards outside. */
  function sections(board) {
    const groups = values(board.groups).sort((a, b) => aliasNum(a.alias) - aliasNum(b.alias) || readingSort(a, b));
    const inGroup = Object.create(null);
    groups.forEach((group) => { inGroup[group.id] = []; });
    const outside = [];
    values(board.cards).forEach((card) => { (card.group_id && inGroup[card.group_id] ? inGroup[card.group_id] : outside).push(card); });
    return { outside: outside.sort(readingSort), groups: groups.map((group) => ({ group, cards: inGroup[group.id].sort(readingSort) })) };
  }

  const labelled = (word, text) => (text ? `${word}: ${text}` : word);
  const pictureWord = (card) => labelled(jt('board.export.picture', 'Picture'), str(card.data && card.data.alt));
  const drawingWord = (card) => labelled(jt('board.export.drawing', 'Drawing'), str(card.data && card.data.title));

  /** A card's one-line name: a note's first line, a link's title or address, a file's title or path. */
  function cardTitle(card) {
    const d = card.data || {};
    switch (card.kind) {
      case 'note': return str(d.text).split('\n')[0];
      case 'link': return str(d.title) || str(d.url);
      case 'file': return str(d.title) || str(d.path);
      case 'image': return pictureWord(card);
      case 'chat': return str(d.title) || jt('board.export.chat', 'Chat');
      default: return drawingWord(card);
    }
  }

  /* ---------------------------------------------------------------- SVG */

  function escapeXml(text) {
    return String(text)
      // eslint-disable-next-line no-control-regex -- characters XML 1.0 cannot hold are dropped.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Text wrapped to `maxChars` per line, cut to `maxLines` (the last line ends with an ellipsis when cut). */
  function wrap(text, maxChars, maxLines) {
    const out = [];
    const paragraphs = String(text).replace(/\t/g, '  ').split('\n');
    for (let p = 0; p < paragraphs.length && out.length <= maxLines; p += 1) {
      let line = '';
      const words = paragraphs[p].split(' ');
      for (let i = 0; i < words.length; i += 1) {
        let word = words[i];
        while (word.length > maxChars) {
          if (line) { out.push(line); line = ''; }
          out.push(word.slice(0, maxChars));
          word = word.slice(maxChars);
        }
        if (!line) line = word;
        else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
        else { out.push(line); line = word; }
      }
      out.push(line);
    }
    if (out.length <= maxLines) return out;
    const kept = out.slice(0, maxLines);
    kept[maxLines - 1] = cut(`${kept[maxLines - 1]} …`, maxChars);
    return kept;
  }

  /** Where the line from r's centre toward the point (tx, ty) leaves r. */
  function edgePoint(r, tx, ty) {
    const [cx, cy] = [r.x + r.w / 2, r.y + r.h / 2];
    const [dx, dy] = [tx - cx, ty - cy];
    const t = Math.min(1, dx ? (r.w / 2) / Math.abs(dx) : Infinity, dy ? (r.h / 2) / Math.abs(dy) : Infinity);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  /** A connector's two ends: from centre to centre, cut where each card's edge is. */
  function connectorEnds(a, b) {
    return { start: edgePoint(a, b.x + b.w / 2, b.y + b.h / 2), end: edgePoint(b, a.x + a.w / 2, a.y + a.h / 2) };
  }

  function boardToSvg(board, options) {
    const opts = options || {};
    const palette = opts.palette || {};
    const pictures = opts.pictures || {};
    const colour = (key) => (typeof palette[key] === 'string' && HEX_RE.test(palette[key]) ? palette[key] : DEFAULT_PALETTE[key]);
    const cards = values(board.cards).sort((a, b) => num(a.z, 0) - num(b.z, 0) || byId(a, b));
    const groups = sections(board).groups.map((entry) => entry.group);
    const rects = Object.create(null);
    cards.forEach((card) => { rects[card.id] = rectOf(card); });
    const boxes = cards.map((card) => rects[card.id]).concat(groups.map(rectOf));
    if (!boxes.length) boxes.push({ x: 0, y: 0, w: 240, h: 80 });
    const [minX, minY] = [Math.min(...boxes.map((r) => r.x)), Math.min(...boxes.map((r) => r.y))];
    const [x0, y0] = [minX - MARGIN, minY - MARGIN];
    const width = Math.max(...boxes.map((r) => r.x + r.w)) - minX + 2 * MARGIN;
    const height = Math.max(...boxes.map((r) => r.y + r.h)) - minY + 2 * MARGIN;
    const textAttrs = (fill, extra) => `font-family="${FONT_FAMILY}" font-size="${FONT}" fill="${fill}"${extra || ''}`;
    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="${fmt(x0)} ${fmt(y0)} ${fmt(width)} ${fmt(height)}">`);
    out.push(`<title>${escapeXml(str(board.name))}</title>`);
    const used = Object.create(null);
    const connectorParts = [];
    values(board.connectors).sort(byId).forEach((con) => {
      const from = rects[con.from];
      const to = rects[con.to];
      if (!from || !to || con.from === con.to) return;
      const ends = connectorEnds(from, to);
      const tone = toneOf(con.tone) || 'muted';
      const marker = `arrow-${tone}`;
      const arrows = con.ends === 'both' ? ` marker-start="url(#${marker})" marker-end="url(#${marker})"` : con.ends === 'none' ? '' : ` marker-end="url(#${marker})"`;
      if (arrows) used[tone] = true;
      const dash = con.style === 'dashed' ? ' stroke-dasharray="5 4"' : '';
      connectorParts.push(`<line x1="${fmt(ends.start.x)}" y1="${fmt(ends.start.y)}" x2="${fmt(ends.end.x)}" y2="${fmt(ends.end.y)}" stroke="${colour(tone)}" stroke-width="1.5"${dash}${arrows}/>`);
      const label = str(con.label);
      if (label) {
        const mx = (ends.start.x + ends.end.x) / 2;
        const my = (ends.start.y + ends.end.y) / 2;
        const shown = cut(label, 60);
        const w = shown.length * CHAR_W + 12;
        connectorParts.push(`<rect x="${fmt(mx - w / 2)}" y="${fmt(my - 11)}" width="${fmt(w)}" height="20" rx="4" fill="${colour('background')}"/>`);
        connectorParts.push(`<text x="${fmt(mx)}" y="${fmt(my + 4)}" text-anchor="middle" ${textAttrs(colour('muted'))}>${escapeXml(shown)}</text>`);
      }
    });
    const markers = Object.keys(used).map((key) => `<marker id="arrow-${key}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8"`
      + ` orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${colour(key)}"/></marker>`);
    if (markers.length) out.push(`<defs>${markers.join('')}</defs>`);
    out.push(`<rect x="${fmt(x0)}" y="${fmt(y0)}" width="${fmt(width)}" height="${fmt(height)}" fill="${colour('background')}"/>`);
    groups.forEach((group) => {
      const r = rectOf(group);
      const stroke = colour(toneOf(group.tone) || 'group');
      const title = cut(str(group.title), Math.max(1, Math.floor((r.w - 24) / CHAR_W)));
      out.push(`<g><rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}" rx="10" fill="${colour('card')}" fill-opacity="0.5" stroke="${stroke}" stroke-dasharray="6 4"/>`
        + `<text x="${fmt(r.x + 12)}" y="${fmt(r.y + 22)}" font-weight="600" ${textAttrs(colour('text'))}>${escapeXml(title)}</text></g>`);
    });
    cards.forEach((card, index) => {
      const r = rects[card.id];
      const d = card.data || {};
      const tone = toneOf(d.tone);
      const clip = `clip-${index + 1}`;
      const parts = [`<rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}" rx="8" fill="${colour('card')}" stroke="${colour('border')}"/>`];
      if (tone) parts.push(`<rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}" rx="8" fill="${colour(tone)}" fill-opacity="0.14"/>`);
      parts.push(`<clipPath id="${clip}"><rect x="${fmt(r.x + 1)}" y="${fmt(r.y + 1)}" width="${fmt(r.w - 2)}" height="${fmt(r.h - 2)}" rx="8"/></clipPath>`);
      const picture = card.kind === 'image' && typeof d.asset === 'string' && hasOwn.call(pictures, d.asset) ? pictures[d.asset] : null;
      if (picture && MIMES.indexOf(picture.mime) >= 0 && typeof picture.base64 === 'string' && BASE64_RE.test(picture.base64)) {
        parts.push(`<image x="${fmt(r.x + 4)}" y="${fmt(r.y + 4)}" width="${fmt(Math.max(1, r.w - 8))}" height="${fmt(Math.max(1, r.h - 8))}" preserveAspectRatio="xMidYMid meet" clip-path="url(#${clip})" href="data:${picture.mime};base64,${picture.base64}"/>`);
      } else {
        const maxChars = Math.max(1, Math.floor((r.w - 2 * PAD) / CHAR_W));
        const maxLines = Math.max(1, Math.floor((r.h - 2 * PAD + (LINE - FONT)) / LINE));
        const lines = [];
        const add = (text, style) => { wrap(text, maxChars, maxLines).forEach((line) => lines.push({ text: line, style })); };
        if (card.kind === 'note') add(str(d.text), '');
        else if (card.kind === 'link') { if (str(d.title)) add(d.title, 'bold'); add(str(d.url), 'muted'); }
        else if (card.kind === 'file') { if (str(d.title)) add(d.title, 'bold'); add(str(d.path), 'muted'); }
        else if (card.kind === 'chat') add(cardTitle(card), 'bold');
        else if (card.kind === 'diagram') { if (str(d.title)) add(d.title, 'bold'); add(jt('board.export.drawing', 'Drawing'), 'muted'); }
        else add(pictureWord(card), 'muted');
        const spans = lines.slice(0, maxLines).map((line, i) => {
          const style = line.style === 'bold' ? ' font-weight="600"' : line.style === 'muted' ? ` fill="${colour('muted')}"` : '';
          return `<tspan x="${fmt(r.x + PAD)}" y="${fmt(r.y + PAD + FONT + i * LINE)}"${style}>${escapeXml(line.text)}</tspan>`;
        });
        parts.push(`<text ${textAttrs(colour('text'), ` clip-path="url(#${clip})"`)}>${spans.join('')}</text>`);
      }
      out.push(`<g>${parts.join('')}</g>`);
    });
    return out.concat(connectorParts, ['</svg>']).join('\n');
  }

  /* ---------------------------------------------------------------- Excalidraw */

  /** FNV-1a over the string: a positive 31-bit seed that is the same on every run. */
  function seedOf(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return (h % 2147483646) + 1;
  }

  function boardToExcalidraw(board) {
    const elements = [];
    const index = Object.create(null);
    const base = (id, type, r, extra) => {
      const element = Object.assign({ id, type, x: r.x, y: r.y, width: r.w, height: r.h, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
        seed: seedOf(id), version: 1, versionNonce: seedOf(`${id}#`), isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }, extra);
      elements.push(element);
      index[id] = element;
      return element;
    };
    const attach = (element, ref) => { element.boundElements = (element.boundElements || []).concat([ref]); };
    // Text bound to a shape, wrapped to it (an arrow's label to 200 px), so it moves with it in Excalidraw.
    const bind = (container, text, top) => {
      const raw = String(text);
      const width = container.type === 'arrow' ? 200 : Math.max(8, container.width - 16);
      const lines = wrap(raw, Math.max(1, Math.floor(width / 9.6)), 400);
      const height = lines.length * 20;
      const id = `${container.id}-text`;
      base(id, 'text', { x: container.x + 8, y: top ? container.y + 8 : container.y + (container.height - height) / 2, w: width, h: height },
        { text: lines.join('\n'), originalText: raw, fontSize: 16, fontFamily: 5, textAlign: top ? 'left' : 'center',
          verticalAlign: top ? 'top' : 'middle', containerId: container.id, autoResize: true, lineHeight: 1.25 });
      attach(container, { type: 'text', id });
    };
    sections(board).groups.forEach(({ group }) => {
      const rect = base(`group-${group.id}`, 'rectangle', rectOf(group), { strokeStyle: 'dashed', roundness: { type: 3 }, strokeColor: '#868e96' });
      bind(rect, str(group.title), true);
    });
    const cards = values(board.cards).sort((a, b) => num(a.z, 0) - num(b.z, 0) || byId(a, b));
    const rects = Object.create(null);
    cards.forEach((card) => {
      const d = card.data || {};
      const tone = toneOf(d.tone);
      rects[card.id] = rectOf(card);
      const rect = base(`card-${card.id}`, 'rectangle', rects[card.id], { backgroundColor: tone ? EXCALI_TONES[tone] : '#ffffff', roundness: { type: 3 } });
      let text = cardTitle(card);
      if (card.kind === 'note') text = str(d.text);
      else if (card.kind === 'link' && str(d.title)) text = `${d.title}\n${d.url}`;
      else if (card.kind === 'file' && str(d.title)) text = `${d.title}\n${d.path}`;
      bind(rect, text, card.kind === 'note');
    });
    values(board.connectors).sort(byId).forEach((con) => {
      const from = rects[con.from];
      const to = rects[con.to];
      if (!from || !to || con.from === con.to) return;
      const ends = connectorEnds(from, to);
      const dx = ends.end.x - ends.start.x;
      const dy = ends.end.y - ends.start.y;
      const id = `arrow-${con.id}`;
      const arrow = base(id, 'arrow', { x: ends.start.x, y: ends.start.y, w: Math.abs(dx), h: Math.abs(dy) }, {
        points: [[0, 0], [dx, dy]], lastCommittedPoint: null, strokeStyle: con.style === 'dashed' ? 'dashed' : 'solid',
        startBinding: { elementId: `card-${con.from}`, focus: 0, gap: 4 }, endBinding: { elementId: `card-${con.to}`, focus: 0, gap: 4 },
        startArrowhead: con.ends === 'both' ? 'arrow' : null, endArrowhead: con.ends === 'none' ? null : 'arrow' });
      attach(index[`card-${con.from}`], { type: 'arrow', id });
      attach(index[`card-${con.to}`], { type: 'arrow', id });
      if (str(con.label)) bind(arrow, con.label, false);
    });
    return JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} }, null, 2);
  }

  /* ---------------------------------------------------------------- Markdown */

  /** One line of board text as Markdown text: every character that could start markup is escaped. */
  function escapeMd(text) {
    return String(text).replace(/\t/g, ' ').replace(/^\s+/, '')
      .replace(/[\\`*_[\]()<>!|~&#]/g, '\\$&')
      .replace(/^([-+=])/, '\\$1')
      .replace(/^(\d+)([.)])/, '$1\\$2');
  }

  function codeSpan(text) {
    const fence = '`'.repeat((String(text).match(/`+/g) || []).reduce((n, run) => Math.max(n, run.length), 0) + 1);
    const pad = /^`|`$/.test(text) ? ' ' : '';
    return `${fence}${pad}${text}${pad}${fence}`;
  }

  function linkTarget(url) {
    // A `&` is escaped so that `&lt;` or `&#46;` in an address stays what the card holds instead of being read as an entity.
    return url.replace(/[\s"<>()\\`]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`).replace(/&/g, '\\&');
  }

  function cardMarkdown(card) {
    const d = card.data || {};
    const more = (text) => str(text).split('\n').map(escapeMd).filter(Boolean).map((line) => `  ${line}`);
    switch (card.kind) {
      case 'note': return [`- ${escapeMd(cardTitle(card))}`].concat(more(str(d.text).split('\n').slice(1).join('\n')));
      // Only a web address becomes a link; anything else is shown as escaped text.
      case 'link': return [WEB_RE.test(str(d.url)) ? `- [${escapeMd(str(d.title) || d.url)}](<${linkTarget(d.url)}>)` : `- ${escapeMd([str(d.title), str(d.url)].filter(Boolean).join(' '))}`];
      case 'file': return [`- ${codeSpan(str(d.path))}${str(d.title) ? ` ${escapeMd(d.title)}` : ''}`];
      case 'chat': return [`- ${escapeMd(cardTitle(card))}`].concat(more(d.excerpt));
      default: return [`- ${escapeMd(cardTitle(card))}`];
    }
  }

  function boardToMarkdown(board) {
    const parts = sections(board);
    const out = [`# ${escapeMd(str(board.name))}`, ''];
    if (parts.outside.length) out.push(...parts.outside.flatMap(cardMarkdown), '');
    parts.groups.forEach(({ group, cards }) => {
      out.push(`## ${escapeMd(str(group.title))}`, '');
      if (cards.length) out.push(...cards.flatMap(cardMarkdown), '');
    });
    const connectors = values(board.connectors).sort(byId).filter((con) => board.cards[con.from] && board.cards[con.to]);
    if (connectors.length) {
      out.push(`## ${jt('board.export.connections', 'Connections')}`, '');
      connectors.forEach((con) => {
        const arrow = con.ends === 'both' ? '\\<->' : con.style === 'dashed' ? '-->' : '->';
        const label = str(con.label) ? `: ${escapeMd(cut(con.label, 60))}` : '';
        out.push(`- ${escapeMd(cut(cardTitle(board.cards[con.from]), 60))} ${arrow} ${escapeMd(cut(cardTitle(board.cards[con.to]), 60))}${label}`);
      });
      out.push('');
    }
    return out.join('\n');
  }

  /* ---------------------------------------------------------------- PNG */

  /** Draws the SVG through an Image and a canvas: { ok: true, base64 } | { ok: false, reason: 'too_large' | 'failed' | 'invalid' }. */
  function svgToPngBase64(svgText, options) {
    const opts = options || {};
    const head = /^<svg\b[^>]*>/.exec(String(svgText));
    const w = head && /\swidth="([0-9.]+)"/.exec(head[0]);
    const h = head && /\sheight="([0-9.]+)"/.exec(head[0]);
    if (!w || !h) return Promise.resolve({ ok: false, reason: 'invalid' });
    const scale = typeof opts.scale === 'number' && opts.scale > 0 && isFinite(opts.scale) ? opts.scale : 1;
    const [sw, sh] = [Number(w[1]), Number(h[1])];
    const [pw, ph] = [Math.ceil(sw * scale), Math.ceil(sh * scale)];
    if (!(pw >= 1 && ph >= 1) || pw > MAX_SIDE || ph > MAX_SIDE || pw * ph > MAX_PIXELS) return Promise.resolve({ ok: false, reason: 'too_large' });
    const win = opts.windowRef || globalThis;
    const makeImage = opts.createImage || (() => new win.Image());
    const makeCanvas = opts.createCanvas || (() => win.document.createElement('canvas'));
    const failed = { ok: false, reason: 'failed' };
    return new Promise((resolve) => {
      let done = false;
      const finish = (answer) => { if (!done) { done = true; clearTimeout(timer); resolve(answer); } };
      const timer = setTimeout(() => finish(failed), num(opts.timeoutMs, 15000));
      const attempt = (body) => { try { body(); } catch (_error) { finish(failed); } };
      attempt(() => {
        const image = makeImage();
        image.onerror = () => finish(failed);
        image.onload = () => attempt(() => {
          const canvas = makeCanvas();
          canvas.width = pw;
          canvas.height = ph;
          const context = canvas.getContext('2d');
          context.scale(scale, scale);
          context.drawImage(image, 0, 0, sw, sh);
          const url = String(canvas.toDataURL('image/png'));
          finish(url.indexOf('data:image/png;base64,') === 0 ? { ok: true, base64: url.slice(22) } : failed);
        });
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
      });
    });
  }

  /* ---------------------------------------------------------------- the page's side */

  /** The theme's colours as plain hex strings, read once per export; a token that is not a plain colour is left out. */
  function readPalette(windowRef) {
    const out = {};
    try {
      const style = windowRef.getComputedStyle(windowRef.document.documentElement);
      Object.keys(PALETTE_TOKENS).forEach((key) => {
        const value = String(style.getPropertyValue(PALETTE_TOKENS[key]) || '').trim();
        const rgb = /^rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})/.exec(value);
        if (HEX_RE.test(value)) out[key] = value;
        else if (rgb) out[key] = `#${rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
      });
    } catch (_error) { /* the default colours */ }
    return out;
  }

  function safeFileName(name) {
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in a file name.
    const base = String(name || '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/[. ]+$/, '');
    return base || 'board';
  }

  function picturesNotice(count) {
    if (!count) return '';
    return count === 1 ? jt('board.transfer.pictureMissing', '1 picture could not be included.')
      : jt('board.transfer.picturesMissing', '{count} pictures could not be included.', { count });
  }

  /** One plain sentence per outcome; `context` is 'export' or 'import'. */
  function outcomeText(result, context) {
    const r = result || {};
    const importing = context === 'import';
    if (r.ok) return importing ? jt('board.transfer.imported', 'Board imported.') : jt('board.transfer.saved', 'Saved as {name}.', { name: r.name });
    switch (r.reason) {
      case 'too_large': return importing ? jt('board.transfer.fileTooLarge', 'That file is larger than 64 MB.') : jt('board.transfer.boardTooLarge', 'This board is too large to export.');
      case 'picture_too_large': return jt('board.transfer.pictureTooLarge', 'This board is too large for a picture. Try the SVG.');
      case 'not_json':
      case 'format': return jt('board.transfer.notBoard', 'That file is not a Jenny board.');
      case 'version': return jt('board.transfer.newer', 'That board was made by a newer version of Jenny.');
      case 'unknown_key': return jt('board.transfer.unknownKey', 'That file holds more than a Jenny board, so it was not imported.');
      case 'asset': return jt('board.transfer.asset', 'A picture in that file is damaged, so it was not imported.');
      case 'invalid': return importing ? jt('board.transfer.damaged', 'That board file is damaged, so it was not imported.') : jt('board.transfer.failed', 'That did not work. Try again.');
      case 'limit': return r.limit === 'boards_per_project' ? jt('board.transfer.limitBoards', 'This project already has {limit} boards.', { limit: BOARD_CAP })
        : jt('board.transfer.limitSize', 'That board is larger than a board can be.');
      case 'not_file': return jt('board.transfer.notFile', 'That is not a file Jenny can open.');
      case 'not_found': return importing ? jt('board.transfer.projectGone', 'This project no longer exists.') : jt('board.transfer.boardGone', 'This board no longer exists.');
      case 'unreadable': return jt('board.transfer.unreadable', 'This board cannot be read, so it cannot be exported.');
      case 'protected': return jt('board.transfer.protected', 'Jenny does not save files inside its own data folder.');
      case 'io': return jt('board.transfer.io', 'Jenny could not read or write that file.');
      case 'disabled': return jt('board.transfer.disabled', 'Export and import are not available right now.');
      default: return jt('board.transfer.failed', 'That did not work. Try again.');
    }
  }

  function contextMenuApi() {
    return globalThis.inventoryContextMenu || (typeof require === 'function' ? require('../../inventory/context-menu') : null);
  }

  function toBase64(bytes, windowRef) {
    const encode = (windowRef && windowRef.btoa) || globalThis.btoa;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return encode(binary);
  }

  /**
   * The Export menu and the Import call. deps: { windowRef, source, notify(message, { tone }), available(name) (false
   * for a call an older bridge lacks), onChange() (a call answered `disabled`: redraw the controls) }.
   */
  function createBoardTransferActions(deps) {
    const windowRef = deps.windowRef;
    const source = deps.source;
    const notify = typeof deps.notify === 'function' ? deps.notify : () => {};
    const off = new Set();
    const can = (name) => !off.has(name) && typeof source[name] === 'function' && (typeof deps.available !== 'function' || deps.available(name) !== false);
    const saveDialog = () => { const shell = windowRef && windowRef.jennyShell; return shell && shell.dialog && typeof shell.dialog.saveFile === 'function' ? shell.dialog : null; };
    const unavailable = () => jt('board.export.unavailable', 'Export is not available right now.');
    const tell = (message, ok) => { notify(message, { tone: ok ? 'success' : 'warning' }); };
    const closed = (result) => Boolean(result && result.ok !== true && result.reason === 'cancelled'); // the person closed the dialog: no notice
    const join = (...parts) => parts.filter(Boolean).join(' ');
    const note = (name, result) => { // a call that answered `disabled` is off from now on, and the controls redraw
      if (!result || result.reason !== 'disabled' || off.has(name)) return;
      off.add(name);
      if (typeof deps.onChange === 'function') deps.onChange();
    };

    // Each picture at most 10 MiB, 24 MiB in all; past that (or unreadable) it is drawn as a box and counted.
    async function readPictures(boardId, board) {
      const pictures = {};
      let [total, skipped] = [0, 0];
      for (const asset of new Set(values(board.cards).filter((card) => card.kind === 'image').map((card) => card.data.asset))) {
        const read = total < PICTURES_TOTAL && typeof source.readAsset === 'function' ? await Promise.resolve(source.readAsset({ boardId, asset })).catch(() => null) : null;
        const raw = read && read.ok ? read.bytes : null;
        const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
        if (!bytes || MIMES.indexOf(read.mime) < 0 || bytes.byteLength > PICTURE_MAX || total + bytes.byteLength > PICTURES_TOTAL) { skipped += 1; continue; }
        total += bytes.byteLength;
        pictures[asset] = { mime: read.mime, base64: toBase64(bytes, windowRef) };
      }
      return { pictures, skipped };
    }

    async function build(kind, boardId, board) {
      if (kind === 'markdown') return { content: boardToMarkdown(board), ext: 'md', format: 'markdown', filter: jt('board.export.filterMarkdown', 'Markdown') };
      if (kind === 'excalidraw') return { content: boardToExcalidraw(board), ext: 'excalidraw', format: 'plain', filter: jt('board.export.filterExcalidraw', 'Excalidraw drawing') };
      const read = await readPictures(boardId, board);
      const svg = boardToSvg(board, { palette: readPalette(windowRef), pictures: read.pictures });
      if (kind === 'svg') return { content: svg, ext: 'svg', format: 'plain', filter: jt('board.export.filterSvg', 'SVG image'), skipped: read.skipped };
      let png = await svgToPngBase64(svg, { windowRef, scale: 2 });
      if (!png.ok && png.reason === 'too_large') png = await svgToPngBase64(svg, { windowRef, scale: 1 });
      if (!png.ok || png.base64.length > SAVE_BASE64_MAX) return { refusal: { ok: false, reason: png.ok || png.reason === 'too_large' ? 'picture_too_large' : 'failed' } };
      return { content: png.base64, encoding: 'base64', ext: 'png', format: 'plain', filter: jt('board.export.filterPng', 'PNG image'), skipped: read.skipped };
    }

    /** Builds a picture, drawing or outline of one board in the page and saves it through the save dialog. */
    async function exportAs(kind, boardId) {
      const shell = saveDialog();
      if (!shell) { tell(outcomeText({ ok: false, reason: 'disabled' }, 'export'), false); return; }
      const got = await source.get({ boardId });
      if (!got || got.ok !== true || !got.board) { tell(outcomeText(got && got.ok ? { ok: false, reason: 'unreadable' } : got, 'export'), false); return; }
      const made = await build(kind, boardId, got.board).catch(() => ({ refusal: { ok: false, reason: 'failed' } }));
      if (made.refusal) { tell(outcomeText(made.refusal, 'export'), false); return; }
      const payload = Object.assign({ defaultName: `${safeFileName(got.board.name)}.${made.ext}`, title: jt('board.export.dialogTitle', 'Export board'),
        format: made.format, filters: [{ name: made.filter, extensions: [made.ext] }], content: made.content }, made.encoding ? { encoding: made.encoding } : {});
      const result = await Promise.resolve().then(() => shell.saveFile(payload)).catch(() => 'failed');
      if (result === 'failed') { tell(jt('board.transfer.saveFailed', 'Could not save the file.'), false); return; }
      if (!result || result.canceled !== false) return;
      const name = String(result.path || '').split(/[\\/]/).pop() || payload.defaultName;
      tell(join(outcomeText({ ok: true, name }, 'export'), picturesNotice(made.skipped)), true);
    }

    /** The .jennyboard file: the main process shows the dialog and writes. */
    async function exportPackage(boardId) {
      const result = can('exportFile') ? await source.exportFile({ boardId }) : { ok: false, reason: 'disabled' };
      note('exportFile', result);
      if (closed(result)) return;
      tell(result && result.ok ? join(outcomeText(result, 'export'), picturesNotice(result.missingPictures)) : outcomeText(result, 'export'), Boolean(result && result.ok));
    }

    /** Import board…: resolves the new board's id, or '' when nothing was imported. */
    async function importBoard(projectId) {
      const result = can('importFile') ? await source.importFile({ projectId }) : { ok: false, reason: 'disabled' };
      note('importFile', result);
      if (closed(result)) return '';
      const ok = Boolean(result && result.ok && result.board && typeof result.board.id === 'string');
      tell(ok ? join(outcomeText(result, 'import'), picturesNotice(result.skippedPictures)) : outcomeText(result && result.ok ? { ok: false } : result, 'import'), ok);
      return ok ? result.board.id : '';
    }

    // `onCopyToTeam` (row 151 T7): given by the page while this board can be copied to a team project; it adds the last item.
    function openMenu({ boardId, anchorEl, rootEl, onCopyToTeam }) {
      const menu = contextMenuApi();
      if (!menu || !anchorEl) return false;
      const built = Boolean(saveDialog());
      const packaged = can('exportFile');
      const item = (label, value, enabled, action) => ({ label, value, disabled: !enabled, description: enabled ? '' : unavailable(), action });
      anchorEl.setAttribute('aria-expanded', 'true');
      menu.show({
        rootEl: rootEl || anchorEl, anchorEl, ariaLabel: jt('board.export.menuLabel', 'Export board as'), restoreFocusTo: anchorEl,
        onHide: () => { anchorEl.setAttribute('aria-expanded', 'false'); },
        items: [
          item(jt('board.export.png', 'Picture (PNG)'), 'png', built, () => exportAs('png', boardId)),
          item(jt('board.export.svg', 'Drawing (SVG)'), 'svg', built, () => exportAs('svg', boardId)),
          item(jt('board.export.excalidraw', 'Excalidraw file'), 'excalidraw', built, () => exportAs('excalidraw', boardId)),
          item(jt('board.export.markdown', 'Outline (Markdown)'), 'markdown', built, () => exportAs('markdown', boardId)),
          item(jt('board.export.jennyboard', 'Jenny board file (.jennyboard)'), 'jennyboard', packaged, () => exportPackage(boardId)),
        ].concat(typeof onCopyToTeam === 'function' ? [{ label: jt('board.team.copyTo', 'Copy to a team project…'), value: 'copy-team', action: onCopyToTeam }] : []),
      });
      return true;
    }

    return {
      openMenu, exportAs, exportPackage, importBoard,
      exportReason: () => (saveDialog() || can('exportFile') ? '' : unavailable()),
      importReason: () => (can('importFile') ? '' : jt('board.import.unavailable', 'Import is not available right now.')),
    };
  }

  return { boardToSvg, boardToExcalidraw, boardToMarkdown, svgToPngBase64, readPalette, outcomeText, createBoardTransferActions };
});
