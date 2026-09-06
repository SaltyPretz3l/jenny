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
  const audit = globalRef.__jennyStartupAudit || {
    enabled: false,
    config: null,
    marks: [],
    flushedCount: 0,
    flushScheduled: false,
    flushInFlight: null,
    mark(name, details = {}) {
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
        ts_ms: Date.now(),
        details: details && typeof details === 'object' && !Array.isArray(details) ? details : {},
      };
      this.marks.push(entry);
      this.flush();
    },
    enable(config = {}) {
      this.enabled = config?.enabled === true;
      this.config = config && typeof config === 'object' ? config : {};
      this.flush();
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
