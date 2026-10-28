'use strict';

// Fake pdf.js 6.x core/viewer modules and a jsdom-hosted IDE PDF pane for
// the renderer-ide-pdf-host tests.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createIdePdfPane } = require('../../renderer/features/renderer-ide-pdf-host');

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'documents', 'text.pdf');

class FakeEventBus {
  constructor() {
    this.listeners = new Map();
    this.events = [];
  }

  on(name, listener) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  off(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name, detail) {
    this.events.push({ name, detail });
    for (const listener of this.listeners.get(name) || []) {
      listener(detail || {});
    }
  }
}

class FakePDFLinkService {
  constructor(options) {
    this.options = options;
    this.externalLinkTarget = null;
  }

  setDocument(document, baseUrl) {
    this.document = document;
    this.baseUrl = baseUrl;
  }

  setViewer(viewer) {
    this.viewer = viewer;
  }
}

class FakePDFFindController {
  constructor(options) {
    this.options = options;
  }
}

class FakePDFViewer {
  constructor(options) {
    this.options = options;
    this.currentPageNumber = 1;
    this.currentScaleValue = 1;
    this.annotationEditorMode = { mode: 0 };
    this.cleanupCalls = 0;
    FakePDFViewer.instances.push(this);
  }

  setDocument(document) {
    this.document = document;
    if (document && FakePDFViewer.failPages) {
      // pdf.js logs the failure and rejects pagesPromise; pagesinit never fires.
      this.pagesPromise = Promise.reject(new Error('Unable to initialize viewer'));
    } else if (document) {
      this.options.eventBus.dispatch('pagesinit', { source: this });
    }
  }

  cleanup() {
    this.cleanupCalls += 1;
  }

  update() {
    this.updatedWhileVisible = !this.options.container.closest('.hidden');
  }
}
FakePDFViewer.instances = [];
FakePDFViewer.failPages = false;

function makeDocument(label = '') {
  const storage = {
    onSetModified: null,
    onResetModified: null,
    resetCalls: 0,
    size: 0,
    resetModified() {
      this.resetCalls += 1;
      this.onResetModified?.();
    },
  };
  return {
    label,
    numPages: 2,
    annotationStorage: storage,
    destroyCalls: 0,
    async saveDocument() {
      return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    },
    async getData() {
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
    async getPage() {
      return {};
    },
    destroy() {
      this.destroyCalls += 1;
    },
  };
}

// pdf.js's password handshake: the task asks through onPassword (1 = need,
// 2 = incorrect) until updatePassword gets `password`; destroy() rejects.
function protectWithPassword(task, document, password) {
  let settle;
  task.passwordsTried = [];
  task.promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const ask = (reason) => task.onPassword?.((value) => {
    task.passwordsTried.push(value);
    if (value === password) settle.resolve(document);
    else setTimeout(() => ask(2), 0);
  }, reason);
  setTimeout(() => ask(1), 0);
  task.destroy = function destroy() {
    this.destroyCalls += 1;
    document.destroy();
    settle.reject(new Error('Loading aborted'));
  };
}

function makePdfjsHarness(options = {}) {
  const params = [];
  const tasks = [];
  const documents = [];
  let loadCount = 0;
  FakePDFViewer.instances = [];
  FakePDFViewer.failPages = false;
  const pdfjs = {
    AnnotationEditorType: { NONE: 0, FREETEXT: 3, HIGHLIGHT: 9, INK: 15 },
    AnnotationMode: { ENABLE_FORMS: 2 },
    PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
    getDocument(loadParams) {
      params.push(loadParams);
      const document = makeDocument(`doc-${loadCount}`);
      if (options.annotationStorage) document.annotationStorage = options.annotationStorage;
      documents.push(document);
      const rejection = options.rejections?.[loadCount];
      loadCount += 1;
      const task = {
        destroyCalls: 0,
        promise: rejection ? Promise.reject(rejection) : Promise.resolve(document),
        destroy() {
          this.destroyCalls += 1;
          document.destroy();
        },
      };
      // `password`: one for every load, or an array with one per load.
      const password = Array.isArray(options.password) ? options.password[tasks.length] : options.password;
      if (password) protectWithPassword(task, document, password);
      tasks.push(task);
      return task;
    },
  };
  const viewer = {
    EventBus: FakeEventBus,
    PDFLinkService: FakePDFLinkService,
    PDFFindController: FakePDFFindController,
    PDFViewer: FakePDFViewer,
  };
  return {
    documents,
    params,
    pdfjs,
    tasks,
    viewer,
    loadPdfjs: options.importError
      ? async () => { throw options.importError; }
      : async () => ({ pdfjs, viewer }),
  };
}

function makePane(options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', {
    url: 'file:///D:/Projects/jenny/index.html',
  });
  const host = dom.window.document.getElementById('host');
  options.setupWindow?.(dom.window);
  const harness = options.harness || makePdfjsHarness();
  const dirtyEvents = [];
  let saveRequests = 0;
  const pane = createIdePdfPane({
    getHost: () => host,
    loadPdfjs: harness.loadPdfjs,
    onDirtyChange: (filePath, dirty) => dirtyEvents.push([filePath, dirty]),
    onEdit: options.onEdit,
    log: options.log,
    onSaveRequest: () => { saveRequests += 1; },
  });
  return { dom, host, harness, pane, dirtyEvents, get saveRequests() { return saveRequests; } };
}

async function loadFixture(env, filePath = 'docs/text.pdf') {
  const bytes = fs.readFileSync(FIXTURE_PATH);
  const result = await env.pane.load(filePath, {
    base64: bytes.toString('base64'),
    size: bytes.length,
    mtimeMs: 123,
  });
  return { bytes, result };
}

function click(env, selector) {
  const element = env.host.querySelector(selector);
  assert.ok(element, `missing ${selector}`);
  element.dispatchEvent(new env.dom.window.MouseEvent('click', { bubbles: true }));
  return element;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function keydown(env, target, init) {
  const event = new env.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

module.exports = {
  FIXTURE_PATH,
  FakePDFViewer,
  click,
  keydown,
  loadFixture,
  makePane,
  makePdfjsHarness,
  tick,
};
