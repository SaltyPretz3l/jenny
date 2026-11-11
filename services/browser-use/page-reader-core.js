'use strict';

/* global document, window */

/**
 * Page-side helpers for the browser-use reader: text cleaning, visibility, the accessible name,
 * secret-field detection, refs and element facts. installReaderCore is serialised with
 * String(fn) and runs inside the page's isolated world, so it may only touch page globals and
 * the shared state object S. Nothing here may reference Node-side module scope.
 */
function installReaderCore(S) {
  const INVISIBLE = new RegExp('[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]', 'g');
  const INLINE_DISPLAY = /^(inline|inline-block|inline-flex|inline-grid|inline-table|contents|ruby|ruby-text|ruby-base)$/;
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'svg', 'canvas', 'video', 'audio', 'object', 'embed', 'datalist', 'option', 'optgroup']);
  const INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password', 'hidden', 'checkbox', 'radio', 'range', 'file', 'color', 'date', 'datetime-local', 'month', 'week', 'time', 'button', 'submit', 'reset', 'image']);
  const NO_VALUE_TYPES = new Set(['checkbox', 'radio', 'range', 'file', 'color', 'hidden', 'button', 'submit', 'reset', 'image']);
  const TEXT_ENTRY_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password', 'date', 'datetime-local', 'month', 'week', 'time']);
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'treeitem']);
  const INPUT_ROLES = { search: 'searchbox', number: 'spinbutton', range: 'slider', checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'file', color: 'color', password: 'password' };
  const SECRET_AUTOCOMPLETE = ['current-password', 'new-password', 'one-time-code'];
  const SECRET_NAME = [
    /card[\s_.-]*(?:no|num|number)(?![a-z])/, /credit[\s_.-]*card/, /(?<![a-z])cc[\s_.-]*(?:num|number|no)(?![a-z])/,
    /(?<![a-z])(?:cvv|cvc|cvn|csc)\d?(?![a-z])/, /security[\s_.-]*(?:code|number)/,
    /(?<![a-z])ssn(?![a-z])/, /social[\s_.-]*security/,
    /passw(?:or)?d/, /pass[\s_.-]?code/, /(?<![a-z])pwd(?![a-z])/,
    /(?<![a-z])pin(?:[\s_.-]?(?:code|number|no))?(?![a-z])/,
  ];
  const REF_PATTERN = /^r\d{1,12}$/;
  const MAX_REFS = 9999;

  S.refToEl = new Map();
  S.elToRef = new WeakMap();
  S.refCount = 0;
  S.passwordSeen = new WeakSet();
  S.layoutSeen = new WeakSet();
  S.SKIP_TAGS = SKIP_TAGS;
  S.INLINE_DISPLAY = INLINE_DISPLAY;

  function clean(value) {
    return String(value === null || value === undefined ? '' : value).replace(INVISIBLE, '');
  }
  function collapse(value) {
    return clean(value).replace(/\s+/g, ' ').trim();
  }
  function cut(value, max) {
    return value.length > max ? value.slice(0, max - 3) + '...' : value;
  }
  function styleOf(el) {
    try {
      const view = el.ownerDocument.defaultView || window;
      return view.getComputedStyle(el) || null;
    } catch (error) {
      return null;
    }
  }
  function clipsContent(cs) {
    return /hidden|clip|scroll|auto|overlay/.test(`${cs.overflow || ''} ${cs.overflowX || ''} ${cs.overflowY || ''}`);
  }
  // jsdom and detached documents report all-zero rects; then size rules and culling are skipped.
  function layoutOf(doc) {
    if (S.layoutSeen.has(doc)) return true;
    try {
      const ok = [doc.documentElement, doc.body].some((node) => {
        const r = node && node.getBoundingClientRect();
        return Boolean(r) && (r.width > 0 || r.height > 0);
      });
      if (ok) S.layoutSeen.add(doc);
      return ok;
    } catch (error) {
      return false;
    }
  }
  function frameOf(doc) {
    try {
      return (doc.defaultView && doc.defaultView.frameElement) || null;
    } catch (error) {
      return null;
    }
  }
  function frameOffset(doc) {
    let x = 0;
    let y = 0;
    let current = doc;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      const frame = frameOf(current);
      if (!frame) break;
      const r = frame.getBoundingClientRect();
      x += r.left + (frame.clientLeft || 0);
      y += r.top + (frame.clientTop || 0);
      current = frame.ownerDocument;
    }
    return { x, y };
  }
  function topRect(el) {
    const r = el.getBoundingClientRect();
    const o = frameOffset(el.ownerDocument);
    return { left: r.left + o.x, top: r.top + o.y, right: r.right + o.x, bottom: r.bottom + o.y, width: r.width, height: r.height };
  }
  // 'prune' drops the subtree; 'skip' drops only the element's own output.
  function hideKind(el, cs, rect) {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return 'prune';
    if (cs && (cs.display === 'none' || parseFloat(cs.opacity) === 0)) return 'prune';
    let kind = '';
    if (cs && (cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.fontSize) === 0)) kind = 'skip';
    // A page's body can measure 0 px tall with everything positioned outside it (YouTube), so size says nothing about the root.
    const isRoot = el === el.ownerDocument.body || el === el.ownerDocument.documentElement;
    if (rect && !isRoot && !(cs && cs.display === 'contents')) {
      const clips = cs ? clipsContent(cs) : false;
      const view = el.ownerDocument.defaultView || window;
      if (rect.width <= 1 && rect.height <= 1 && clips) return 'prune';
      if (rect.width <= 0 || rect.height <= 0) return clips ? 'prune' : 'skip';
      if (rect.right + (view.scrollX || 0) <= 0 || rect.bottom + (view.scrollY || 0) <= 0) return 'prune';
    }
    return kind;
  }
  function parentOf(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    if (root && root.host) return root.host;
    return frameOf(node.ownerDocument);
  }
  function isVisible(el) {
    if (!el.isConnected) return false;
    for (let node = parentOf(el), depth = 0; node && depth < 60; node = parentOf(node), depth += 1) {
      if (hideKind(node, styleOf(node), null) === 'prune') return false;
    }
    if (hideKind(el, styleOf(el), null) === 'prune') return false;
    const cs = styleOf(el);
    if (cs && (cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false;
    if (layoutOf(el.ownerDocument)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
    }
    return true;
  }

  function inputType(el) {
    if (el.localName !== 'input') return '';
    const t = (el.getAttribute('type') || 'text').trim().toLowerCase();
    return INPUT_TYPES.has(t) ? t : 'text';
  }
  function labelControl(el) {
    return el.localName === 'label' ? el.control || null : null;
  }
  // Whether the walker would print this element itself.
  function rendered(el) {
    const rect = layoutOf(el.ownerDocument) ? el.getBoundingClientRect() : null;
    return isVisible(el) && hideKind(el, styleOf(el), rect) === '';
  }
  function isEditableHost(el) {
    const v = el.getAttribute('contenteditable');
    return v !== null && /^(|true|plaintext-only)$/i.test(v.trim());
  }
  function isDisabled(el) {
    if (el.getAttribute('aria-disabled') === 'true') return true;
    try {
      return Boolean(el.matches(':disabled'));
    } catch (error) {
      return el.hasAttribute('disabled');
    }
  }
  function isTextEntry(el) {
    if (isDisabled(el)) return false;
    if (el.localName === 'textarea') return !el.hasAttribute('readonly');
    if (el.localName === 'input') return TEXT_ENTRY_TYPES.has(inputType(el)) && !el.hasAttribute('readonly');
    return isEditableHost(el);
  }
  function isFieldLike(el) {
    const tag = el.localName;
    if (tag === 'input') return !NO_VALUE_TYPES.has(inputType(el));
    return tag === 'textarea' || tag === 'select' || isEditableHost(el);
  }

  // Text of a subtree for names. Form-control contents are skipped so a label wrapping a
  // textarea or editor can never carry what the user typed.
  function textOf(el, max) {
    const parts = [];
    let len = 0;
    function visit(node, depth) {
      if (len > max + 50 || depth > 12) return;
      if (node.nodeType === 3) {
        const holder = node.parentElement;
        const hcs = holder && styleOf(holder);
        if (hcs && (hcs.visibility === 'hidden' || hcs.visibility === 'collapse')) return;
        parts.push(node.nodeValue);
        len += node.nodeValue.length;
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.localName;
      if (SKIP_TAGS.has(tag) || tag === 'textarea' || tag === 'select' || tag === 'input' || isEditableHost(node)) return;
      if (depth > 0 && (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true')) return;
      const cs = styleOf(node);
      if (cs && cs.display === 'none') return;
      if (tag === 'img') {
        const alt = node.getAttribute('alt');
        if (alt) parts.push(` ${alt} `);
        return;
      }
      const block = Boolean(cs) && !INLINE_DISPLAY.test(cs.display || 'inline');
      if (block) parts.push(' ');
      const kids = node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
      for (let i = 0; i < kids.length; i += 1) visit(kids[i], depth + 1);
      if (block) parts.push(' ');
    }
    visit(el, 0);
    return collapse(parts.join(''));
  }
  function byId(el, id) {
    const root = el.getRootNode && el.getRootNode();
    const found = root && typeof root.getElementById === 'function' ? root.getElementById(id) : null;
    return found || el.ownerDocument.getElementById(id);
  }
  function labelText(el) {
    const labels = el.labels;
    const list = labels && labels.length ? Array.from(labels) : [];
    if (!list.length && el.id) {
      const all = el.ownerDocument.querySelectorAll('label');
      for (let i = 0; i < all.length; i += 1) if (all[i].getAttribute('for') === el.id) list.push(all[i]);
    }
    if (!list.length && el.closest) {
      const wrap = el.closest('label');
      if (wrap) list.push(wrap);
    }
    return collapse(list.map((label) => textOf(label, 200)).join(' '));
  }
  function accName(el) {
    const tag = el.localName;
    const type = inputType(el);
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby.split(/\s+/).map((id) => byId(el, id)).filter(Boolean)
        .map((node) => collapse(node.getAttribute('aria-label')) || textOf(node, 200)).join(' ');
      if (collapse(text)) return collapse(text).slice(0, 200);
    }
    const aria = collapse(el.getAttribute('aria-label'));
    if (aria) return aria.slice(0, 200);
    // A label can wrap several buttons (a slider's ticks); each button's own words are what tell them apart.
    const ownWords = tag === 'button' ? textOf(el, 200) : '';
    if (ownWords) return ownWords.slice(0, 200);
    if (/^(input|select|textarea|button|meter|output|progress)$/.test(tag)) {
      const label = labelText(el);
      if (label) return label.slice(0, 200);
    }
    if (tag === 'img' || tag === 'area' || type === 'image') {
      const alt = collapse(el.getAttribute('alt'));
      if (alt) return alt.slice(0, 200);
    }
    if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset' || type === 'image')) {
      const value = collapse(el.getAttribute('value'));
      if (value) return value.slice(0, 200);
    }
    const title = collapse(el.getAttribute('title'));
    const placeholder = collapse(el.getAttribute('placeholder'));
    const field = tag === 'input' || tag === 'select' || tag === 'textarea' || isEditableHost(el);
    // Fields are named by title then placeholder; everything else by its content before its title.
    const text = field ? '' : textOf(el, 200);
    return (text || title || placeholder).slice(0, 200);
  }

  function isSecret(el) {
    if (!isFieldLike(el)) return false;
    if (S.passwordSeen.has(el)) return true;
    if (inputType(el) === 'password') {
      S.passwordSeen.add(el);
      return true;
    }
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.some((t) => SECRET_AUTOCOMPLETE.includes(t) || t.startsWith('cc-'))) return true;
    const haystack = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), accName(el)]
      .map((s) => clean(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()).join('|');
    return SECRET_NAME.some((pattern) => pattern.test(haystack));
  }

  function classify(el) {
    const tag = el.localName;
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
    if (tag === 'input') {
      const type = inputType(el);
      if (type === 'hidden') return null;
      return isSecret(el) && type !== 'password' ? 'textbox' : (INPUT_ROLES[type] || 'textbox');
    }
    // A styled toggle hides its input and shows the label, so the label has to carry the ref.
    if (tag === 'label') {
      const control = labelControl(el);
      if (control && /^(checkbox|radio|file)$/.test(inputType(control)) && !rendered(control)) return inputType(control);
    }
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'button') return 'button';
    if (tag === 'summary') return el.parentElement && el.parentElement.localName === 'details' ? 'summary' : null;
    if (isEditableHost(el)) return 'textbox';
    if (INTERACTIVE_ROLES.has(explicit)) return explicit;
    if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return 'link';
    if (el.hasAttribute('onclick')) return 'clickable';
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && /^\s*\d+\s*$/.test(tabindex)) return 'clickable';
    return null;
  }
  function roleOf(el) {
    return classify(el) || (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0] || '';
  }

  function resolveUrl(raw, el) {
    try {
      return new URL(String(raw).trim(), el.ownerDocument.baseURI);
    } catch (error) {
      return null;
    }
  }
  function hrefOf(el) {
    if (el.localName !== 'a' && el.localName !== 'area') return '';
    const raw = el.getAttribute('href');
    if (raw === null) return '';
    const url = resolveUrl(raw, el);
    return url && (url.protocol === 'http:' || url.protocol === 'https:') ? clean(url.href) : '';
  }
  function formInfo(el) {
    let form = null;
    const owner = el.getAttribute('form');
    if (owner) form = byId(el, owner);
    if (!form && el.closest) form = el.closest('form');
    if (!form || form.localName !== 'form') return { present: false, method: '', action: '', hasSecretField: false };
    const submits = el.localName === 'button' || inputType(el) === 'submit' || inputType(el) === 'image';
    const rawMethod = ((submits && el.getAttribute('formmethod')) || form.getAttribute('method') || '').trim().toLowerCase();
    const method = rawMethod === 'post' || rawMethod === 'dialog' ? rawMethod : 'get';
    const rawAction = (submits && el.getAttribute('formaction')) || form.getAttribute('action') || '';
    const url = resolveUrl(rawAction, el);
    const fields = form.querySelectorAll('input,textarea,select,[contenteditable]');
    let hasSecretField = false;
    for (let i = 0; i < fields.length && i < 300 && !hasSecretField; i += 1) hasSecretField = isSecret(fields[i]);
    return { present: true, method, action: url ? clean(url.href) : '', hasSecretField };
  }
  function fingerprint(el) {
    const form = formInfo(el);
    return [el.localName, roleOf(el), inputType(el), accName(el), hrefOf(el), isSecret(el), form.method, form.action].join('|');
  }

  function visibleCenter(rect, view) {
    const vw = view.innerWidth || rect.right;
    const vh = view.innerHeight || rect.bottom;
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, vw);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, vh);
    if (right > left && bottom > top) return { x: (left + right) / 2, y: (top + bottom) / 2 };
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  }
  function rectFacts(el) {
    const r = topRect(el);
    const c = visibleCenter(r, window);
    return { x: r.left, y: r.top, width: r.width, height: r.height, centerX: c.x, centerY: c.y };
  }
  function facts(el, ref) {
    const type = inputType(el);
    const control = labelControl(el);
    const secret = isSecret(el);
    const href = hrefOf(el);
    const checked = (type === 'checkbox' || type === 'radio') ? Boolean(el.checked) : el.getAttribute('aria-checked') === 'true';
    return {
      status: 'ready',
      ref,
      tag: el.localName,
      role: roleOf(el),
      // The consent gate needs a button's real type: only a submit button can send a form.
      inputType: el.localName === 'button' ? String(el.type || 'submit').toLowerCase() : type,
      name: accName(el),
      isAnchor: (el.localName === 'a' || el.localName === 'area') && el.hasAttribute('href'),
      href,
      // Clicking the label of a file input opens the same picker as clicking the input.
      isFileInput: type === 'file' || Boolean(control && inputType(control) === 'file'),
      isSecret: secret,
      isEditable: isTextEntry(el),
      disabled: isDisabled(el),
      checked,
      form: formInfo(el),
      rect: rectFacts(el),
      fingerprint: fingerprint(el),
    };
  }

  function assign(el) {
    const known = S.elToRef.get(el);
    if (known) return known;
    if (S.refCount >= MAX_REFS) return '';
    S.refCount += 1;
    const ref = `r${S.base + S.refCount}`;
    S.elToRef.set(el, ref);
    S.refToEl.set(ref, el);
    return ref;
  }
  function resolve(ref) {
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) return null;
    const el = S.refToEl.get(ref);
    return el && el.isConnected ? el : null;
  }
  function describe(el) {
    const name = accName(el);
    const role = roleOf(el) || el.localName;
    return name ? `${role} "${name.replace(/"/g, "'").slice(0, 40)}"` : role;
  }
  function allDocs() {
    const docs = [];
    (function collect(doc, depth) {
      docs.push(doc);
      if (depth >= 3) return;
      const frames = doc.querySelectorAll('iframe,frame');
      for (let i = 0; i < frames.length; i += 1) {
        try {
          if (frames[i].contentDocument && frames[i].contentDocument.documentElement) collect(frames[i].contentDocument, depth + 1);
        } catch (error) {
          // cross-origin frame
        }
      }
    }(document, 0));
    return docs;
  }

  Object.assign(S, {
    clean, collapse, cut, styleOf, clipsContent, layoutOf, topRect, frameOffset, hideKind, isVisible, inputType, labelControl, rendered, isEditableHost,
    isDisabled, isTextEntry, isFieldLike, textOf, accName, isSecret, classify, roleOf, hrefOf, formInfo, fingerprint,
    visibleCenter, rectFacts, facts, assign, resolve, describe, allDocs, parentOf,
  });
}

module.exports = { installReaderCore };
