'use strict';

function buildEnvironment() {
  const previousIO = global.IntersectionObserver;
  const observers = [];
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options || {};
      this.observed = new Set();
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) { this.observed.add(target); }
    unobserve(target) { this.observed.delete(target); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
    _fire(records) { if (!this.disconnected) this.callback(records); }
  }
  global.IntersectionObserver = FakeIntersectionObserver;
  return {
    observers,
    restore() { global.IntersectionObserver = previousIO; },
  };
}

function matchesSelector(node, selector) {
  if (!node) return false;
  const cls = (node.getAttribute && node.getAttribute('class')) || '';
  const classes = cls.split(/\s+/).filter(Boolean);
  if (selector.startsWith('.chat-thread-root[data-thread-message-id=')) {
    if (!classes.includes('chat-thread-root')) return false;
    const match = selector.match(/data-thread-message-id="([^"]+)"/);
    return Boolean(match && node.getAttribute('data-thread-message-id') === match[1]);
  }
  return selector.startsWith('.') && classes.includes(selector.slice(1));
}

function makeArticle({
  messageId,
  role = 'assistant',
  height = 400,
  innerHtml = '<div class="chat-bubble-markdown">hi</div>',
  rowIds = [],
  toolCallIds = [],
}) {
  const attrs = new Map([
    ['class', 'chat-entry'],
    ['data-message-id', messageId],
    ['data-message-role', role],
    ['tabindex', '-1'],
    ['aria-label', role === 'user' ? 'Your message' : 'Message from Jenny'],
  ]);
  const makeDataNode = (name, value) => ({
    getAttribute(attr) { return attr === name ? value : null; },
  });
  const article = {
    tagName: 'ARTICLE',
    classList: { contains: (className) => attrs.get('class').split(' ').includes(className) },
    _height: height,
    _measureCount: 0,
    _parent: null,
    isConnected: true,
    innerHTML: innerHtml,
    style: { minHeight: '' },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    hasAttribute(name) { return attrs.has(name); },
    removeAttribute(name) { attrs.delete(name); },
    closest(selector) {
      let node = article;
      while (node) {
        if (matchesSelector(node, selector)) return node;
        node = node._parent || null;
      }
      return null;
    },
    contains(node) {
      let cursor = node;
      while (cursor) {
        if (cursor === article) return true;
        cursor = cursor._parent || null;
      }
      return false;
    },
    querySelector(selector) {
      if (selector === '.chat-bubble-streaming' && article.innerHTML.includes('chat-bubble-streaming')) {
        return { tagName: 'DIV' };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-row-id]') return rowIds.map((id) => makeDataNode('data-row-id', id));
      if (selector === '[data-tool-call-id], [data-call-id]') {
        return toolCallIds.map((id) => makeDataNode('data-tool-call-id', id));
      }
      return [];
    },
    getBoundingClientRect() {
      article._measureCount += 1;
      return { height: article._height, top: 0, bottom: article._height, left: 0, right: 100, width: 100 };
    },
  };
  return article;
}

function makeRoot({ messageId }) {
  const attrs = new Map([
    ['class', 'chat-thread-root chat-thread-root-assistant'],
    ['data-thread-message-id', messageId],
  ]);
  return {
    tagName: 'DIV',
    _children: [],
    _parent: null,
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    removeAttribute(name) { attrs.delete(name); },
    closest(selector) { return matchesSelector(this, selector) ? this : null; },
    contains() { return false; },
    querySelectorAll(selector) {
      return selector === '.chat-entry'
        ? this._children.filter((child) => child.tagName === 'ARTICLE')
        : [];
    },
  };
}

function makeChatTimeline(entries) {
  const all = entries.slice();
  return {
    _entries: all,
    querySelectorAll(selector) { return selector === '.chat-entry' ? all : []; },
    querySelector(selector) {
      if (selector === '.chat-bubble-streaming') {
        return all.some((entry) => entry.innerHTML && entry.innerHTML.includes('chat-bubble-streaming'))
          ? { tagName: 'DIV' }
          : null;
      }
      if (selector.startsWith('.chat-thread-root[data-thread-message-id=')) {
        const match = selector.match(/data-thread-message-id="([^"]+)"/);
        if (!match) return null;
        for (const entry of all) {
          let node = entry._parent;
          while (node) {
            if (node.getAttribute && node.getAttribute('data-thread-message-id') === match[1]
                && (node.getAttribute('class') || '').includes('chat-thread-root')) {
              return node;
            }
            node = node._parent || null;
          }
        }
      }
      return null;
    },
  };
}

function makeFakeDocument() {
  return { activeElement: null };
}

function bulkEntries(count, options = {}) {
  const list = [];
  for (let index = 0; index < count; index += 1) {
    list.push(makeArticle({
      messageId: `m${index}`,
      role: options.role || (index % 2 === 0 ? 'user' : 'assistant'),
      height: options.height != null ? options.height : 400,
      innerHtml: `<div class="chat-bubble-markdown">payload-${index}</div>`,
    }));
  }
  return list;
}

module.exports = {
  buildEnvironment,
  bulkEntries,
  makeArticle,
  makeChatTimeline,
  makeFakeDocument,
  makeRoot,
};
