(function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : window;
  const currentScript = typeof document !== 'undefined' ? document.currentScript : null;
  const phase = String(currentScript?.dataset?.startupAuditPhase || 'mark').trim();
  function scheduleMicrotask(callback) {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(callback);
      return;
    }
    Promise.resolve().then(callback).catch(() => {});
  }
  async function reportMarksIndividually(diagnostics, marks) {
    if (typeof diagnostics?.reportStartupMark !== 'function') {
      return 0;
    }
    let delivered = 0;
    for (const entry of marks) {
      try {
        await diagnostics.reportStartupMark(entry);
        delivered += 1;
      } catch (_error) {
        break;
      }
    }
    return delivered;
  }
  // Composer usable: present, enabled, writable, outside an inert subtree and
  // laid out (a hidden composer has no client rects).
  function composerUsable(doc) {
    const input = doc && typeof doc.getElementById === 'function' ? doc.getElementById('chatInput') : null;
    if (!input || input.disabled || input.readOnly) {
      return false;
    }
    if (typeof input.closest === 'function' && input.closest('[inert]')) {
      return false;
    }
    return typeof input.getClientRects !== 'function' || input.getClientRects().length > 0;
  }
  const COMPOSER_WATCH_MS = 60000;
  const audit = globalRef.__jennyStartupAudit || {
    enabled: false,
    config: null,
    marks: [],
    flushedCount: 0,
    flushScheduled: false,
    flushInFlight: null,
    onceMarks: new Set(),
    paintObserver: null,
    composerWatch: null,
    // options.tsMs carries a mark's real time when it is observed after the
    // fact (paint entries); otherwise the mark is stamped now.
    mark(name, details = {}, options = {}) {
      const normalizedName = String(name || '').trim();
      if (!normalizedName) {
        return;
      }
      try {
        globalRef.performance?.mark?.(`jenny-startup-audit:${normalizedName}`);
      } catch (_error) {
        // Best effort only.
      }
      const entry = {
        mark: normalizedName,
        source: 'renderer',
        performanceNow: Number(globalRef.performance?.now?.() || 0),
        timeOrigin: Number(globalRef.performance?.timeOrigin || 0),
        ts_ms: Number.isFinite(Number(options?.tsMs)) && Number(options.tsMs) > 0
          ? Math.round(Number(options.tsMs)) : Date.now(),
        details: details && typeof details === 'object' && !Array.isArray(details) ? details : {},
      };
      this.marks.push(entry);
      this.flush();
    },
    // Boot milestones fire once per renderer: later reloads of the same
    // surface (session reloads, re-renders) are not startup.
    markOnce(name, details = {}, options = {}) {
      const normalizedName = String(name || '').trim();
      if (!normalizedName || this.onceMarks.has(normalizedName)) {
        return false;
      }
      this.onceMarks.add(normalizedName);
      this.mark(normalizedName, details, options);
      return true;
    },
    enable(config = {}) {
      this.enabled = config?.enabled === true;
      this.config = config && typeof config === 'object' ? config : {};
      if (this.enabled) {
        this.observeFirstContentfulPaint();
      }
      this.flush();
    },
    // Installed only once the audit is enabled; buffered:true replays the
    // paint entry that happened before the config arrived.
    observeFirstContentfulPaint() {
      const Observer = globalRef.PerformanceObserver;
      if (this.paintObserver || this.onceMarks.has('first-contentful-paint') || typeof Observer !== 'function') {
        return;
      }
      const timeOrigin = Number(globalRef.performance?.timeOrigin || 0);
      try {
        this.paintObserver = new Observer((list) => {
          const entry = list.getEntries().find((candidate) => candidate.name === 'first-contentful-paint');
          if (!entry) {
            return;
          }
          this.markOnce('first-contentful-paint', { startTime: Math.round(entry.startTime) }, {
            tsMs: timeOrigin > 0 ? timeOrigin + entry.startTime : 0,
          });
          this.paintObserver?.disconnect?.();
        });
        this.paintObserver.observe({ type: 'paint', buffered: true });
      } catch (_error) {
        this.paintObserver = null;
      }
    },
    // Called where the startup curtain releases input. Marks now when the
    // composer is usable; otherwise (audit on only) watches until it is, for
    // at most COMPOSER_WATCH_MS.
    markComposerInteractive(doc, source = '') {
      if (this.onceMarks.has('composer-interactive')) {
        return;
      }
      if (composerUsable(doc)) {
        this.markOnce('composer-interactive', { source });
        return;
      }
      const Observer = globalRef.MutationObserver;
      if (!this.enabled || this.composerWatch || typeof Observer !== 'function' || !doc?.body) {
        return;
      }
      const stop = () => {
        this.composerWatch?.observer?.disconnect?.();
        clearTimeout(this.composerWatch?.timer);
      };
      const observer = new Observer(() => {
        if (composerUsable(doc)) {
          stop();
          this.markOnce('composer-interactive', { source, deferred: true });
        }
      });
      observer.observe(doc.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'readonly', 'inert', 'class', 'hidden', 'style'],
      });
      this.composerWatch = { observer, timer: setTimeout(stop, COMPOSER_WATCH_MS) };
    },
    flush() {
      const diagnostics = globalRef.jennyShell?.diagnostics;
      if (
        !this.enabled
        || (!diagnostics?.reportStartupMarksBatch && !diagnostics?.reportStartupMark)
        || this.flushScheduled
        || this.flushInFlight
      ) {
        return;
      }
      this.flushScheduled = true;
      scheduleMicrotask(() => {
        this.flushScheduled = false;
        const activeDiagnostics = globalRef.jennyShell?.diagnostics;
        if (
          !this.enabled
          || (!activeDiagnostics?.reportStartupMarksBatch && !activeDiagnostics?.reportStartupMark)
          || this.flushedCount >= this.marks.length
        ) {
          return;
        }
        const pending = this.marks.slice(this.flushedCount).map((entry) => ({
          ...entry,
          runId: this.config?.runId || '',
        }));
        const startIndex = this.flushedCount;
        let delivered = 0;
        const flushPending = async () => {
          if (typeof activeDiagnostics.reportStartupMarksBatch === 'function') {
            try {
              await activeDiagnostics.reportStartupMarksBatch({ marks: pending });
              delivered = pending.length;
            } catch (_error) {
              const fallbackDiagnostics = globalRef.jennyShell?.diagnostics || activeDiagnostics;
              delivered = await reportMarksIndividually(fallbackDiagnostics, pending);
            }
          } else {
            delivered = await reportMarksIndividually(activeDiagnostics, pending);
          }
          if (delivered > 0) {
            this.flushedCount = Math.max(this.flushedCount, startIndex + delivered);
          }
        };
        this.flushInFlight = flushPending()
          .catch(() => {})
          .finally(() => {
            const marksQueuedBehindBatch = this.marks.length > startIndex + pending.length;
            this.flushInFlight = null;
            if (this.flushedCount < this.marks.length && (delivered > 0 || marksQueuedBehindBatch)) {
              this.flush();
            }
          });
      });
    },
  };
  globalRef.__jennyStartupAudit = audit;
  if (phase === 'start') {
    audit.mark('renderer-script-start', {
      readyState: typeof document !== 'undefined' ? document.readyState : '',
    });
  } else if (phase === 'scripts-parsed') {
    audit.mark('scripts-parsed', {
      scriptCount: typeof document !== 'undefined' ? document.scripts.length : 0,
      readyState: typeof document !== 'undefined' ? document.readyState : '',
    });
  }
}());
