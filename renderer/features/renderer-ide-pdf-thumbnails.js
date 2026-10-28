/* renderer/features/renderer-ide-pdf-thumbnails.js - lazy page thumbnails
 * for the Workspace IDE PDF sidebar: a bounded LRU of object URLs fed by a
 * cancellable, most-recent-first render queue. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePdfThumbnails = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const ROOT_MARGIN = '200px 0px';

  function createPdfThumbnailRenderer({
    pdfDocument,
    documentRef = globalRef.document,
    width = 104,
    maxLive = 60,
    concurrency = 2,
    scrollRoot = null,
    IntersectionObserver: Observer = globalRef.IntersectionObserver,
    createObjectURL = (blob) => globalRef.URL.createObjectURL(blob),
    revokeObjectURL = (url) => globalRef.URL.revokeObjectURL(url),
    devicePixelRatio = globalRef.devicePixelRatio || 1,
    log = () => {},
  } = {}) {
    const liveLimit = Math.max(1, Math.floor(maxLive));
    const slots = Math.max(1, Math.floor(concurrency));
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const cache = new Map(); // page -> { url, width, height }; Map order is LRU order
    const requests = new Map(); // page -> request, queued or in flight
    const queue = []; // queued page numbers, most recently requested first
    const bindings = new Map(); // element -> { page, onReady, shownUrl, visible }
    let inFlight = 0;
    let disposed = false;
    const observer = typeof Observer === 'function'
      ? new Observer(onIntersect, { root: scrollRoot, rootMargin: ROOT_MARGIN })
      : null;

    function validPage(pageNumber) {
      const total = Number(pdfDocument?.numPages);
      return Number.isInteger(pageNumber) && pageNumber >= 1 && (!Number.isFinite(total) || pageNumber <= total);
    }

    function touch(page) {
      const entry = cache.get(page);
      if (entry) {
        cache.delete(page);
        cache.set(page, entry);
      }
      return entry || null;
    }

    function store(page, entry) {
      cache.set(page, entry);
      while (cache.size > liveLimit) {
        const [oldPage, oldEntry] = cache.entries().next().value;
        cache.delete(oldPage);
        revokeObjectURL(oldEntry.url);
        for (const binding of bindings.values()) {
          if (binding.page === oldPage && binding.shownUrl === oldEntry.url) {
            binding.shownUrl = null;
            binding.onReady(null);
          }
        }
      }
    }

    function request(page) {
      const existing = requests.get(page);
      if (existing) {
        const index = queue.indexOf(page);
        if (index > 0) {
          queue.splice(index, 1);
          queue.unshift(page);
        }
        return existing;
      }
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      const req = { page, promise, resolve, task: null, started: false, cancelled: false, explicit: false };
      requests.set(page, req);
      queue.unshift(page);
      pump();
      return req;
    }

    function finish(req, result) {
      if (requests.get(req.page) === req) {
        requests.delete(req.page);
      }
      if (result && !req.cancelled && !disposed) {
        store(req.page, result);
        req.resolve(result);
      } else {
        if (result) {
          revokeObjectURL(result.url);
        }
        req.resolve(null);
      }
    }

    function pump() {
      while (!disposed && inFlight < slots && queue.length) {
        const req = requests.get(queue.shift());
        req.started = true;
        inFlight += 1;
        draw(req).then((result) => {
          inFlight -= 1;
          finish(req, result);
          pump();
        });
      }
    }

    async function draw(req) {
      let canvas = null;
      try {
        const page = await pdfDocument.getPage(req.page);
        if (req.cancelled) return null;
        const base = page.getViewport({ scale: 1 });
        const scale = width / base.width;
        const viewport = page.getViewport({ scale: scale * ratio });
        canvas = documentRef.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        // pdf.js 6 takes the canvas itself and creates its own 2d context.
        req.task = page.render({ canvas, viewport });
        await req.task.promise;
        req.task = null;
        if (req.cancelled) return null;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve));
        if (req.cancelled) return null;
        if (!blob) throw new Error('thumbnail encode failed');
        return { url: createObjectURL(blob), width, height: Math.round(base.height * scale) };
      } catch (error) {
        if (!req.cancelled && error?.name !== 'RenderingCancelledException') {
          log('warn', 'ide.pdf.thumbnail_failed', { page: req.page, message: String(error?.message || error) });
        }
        return null;
      } finally {
        // Release the backing store now rather than at GC time.
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
    }

    function render(pageNumber) {
      if (disposed || !validPage(pageNumber)) return Promise.resolve(null);
      const cached = touch(pageNumber);
      if (cached) return Promise.resolve(cached);
      const req = request(pageNumber);
      req.explicit = true;
      return req.promise;
    }

    function deliver(binding, entry) {
      if (binding.shownUrl !== entry.url) {
        binding.shownUrl = entry.url;
        binding.onReady(entry);
      }
    }

    function want(element, binding) {
      const cached = touch(binding.page);
      if (cached) {
        deliver(binding, cached);
        return;
      }
      request(binding.page).promise.then((entry) => {
        if (entry && bindings.get(element) === binding && cache.get(binding.page) === entry) {
          deliver(binding, entry);
        }
      });
    }

    // A queued page nobody is looking at any more leaves the queue, so a fast
    // scroll does not render (and then LRU-evict towards) pages it passed.
    function dropIfUnwanted(page) {
      const req = requests.get(page);
      if (!req || req.started || req.explicit) return;
      for (const binding of bindings.values()) {
        if (binding.page === page && binding.visible) return;
      }
      queue.splice(queue.indexOf(page), 1);
      requests.delete(page);
      req.resolve(null);
    }

    function onIntersect(entries) {
      if (disposed) return;
      for (const entry of entries) {
        const binding = bindings.get(entry.target);
        if (!binding) continue;
        binding.visible = Boolean(entry.isIntersecting);
        if (binding.visible) {
          want(entry.target, binding);
        } else {
          dropIfUnwanted(binding.page);
        }
      }
    }

    function observe(element, pageNumber, onReady) {
      if (disposed || !element || !validPage(pageNumber) || typeof onReady !== 'function') return;
      unobserve(element);
      const binding = { page: pageNumber, onReady, shownUrl: null, visible: false };
      bindings.set(element, binding);
      if (observer) {
        observer.observe(element);
      } else {
        binding.visible = true;
        want(element, binding);
      }
    }

    function unobserve(element) {
      const binding = bindings.get(element);
      if (disposed || !binding) return;
      bindings.delete(element);
      observer?.unobserve(element);
      dropIfUnwanted(binding.page);
    }

    function cancelPending() {
      if (disposed) return;
      queue.length = 0;
      for (const req of requests.values()) {
        req.cancelled = true;
        req.task?.cancel();
        req.resolve(null);
      }
      requests.clear();
    }

    function dispose() {
      if (disposed) return;
      cancelPending();
      disposed = true;
      for (const entry of cache.values()) {
        revokeObjectURL(entry.url);
      }
      cache.clear();
      bindings.clear();
      observer?.disconnect();
    }

    return { observe, unobserve, render, cancelPending, dispose };
  }

  return { createPdfThumbnailRenderer };
});
