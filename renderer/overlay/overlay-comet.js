/* renderer/overlay/overlay-comet.js — simplified comet renderer for overlay window (core glow only, no tail). */
(function (root) {
  var requestFrame = typeof root.requestAnimationFrame === 'function'
    ? root.requestAnimationFrame.bind(root)
    : function (callback) { return root.setTimeout(callback, 16); };
  var cancelFrame = typeof root.cancelAnimationFrame === 'function'
    ? root.cancelAnimationFrame.bind(root)
    : function (handle) { root.clearTimeout(handle); };

  var STATE_COLORS = {
    idle:        { r: 100, g: 140, b: 255 },
    listening:   { r: 100, g: 200, b: 255 },
    thinking:    { r: 180, g: 120, b: 255 },
    responding:  { r: 100, g: 255, b: 180 },
    'tool-use':  { r: 255, g: 180, b: 80 },
    alert:       { r: 255, g: 100, b: 100 },
    happy:       { r: 255, g: 220, b: 80 },
    concerned:   { r: 200, g: 160, b: 100 },
  };

  function create(canvas) {
    if (!canvas || !canvas.getContext) return null;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    /* DPI scaling for crisp rendering on HiDPI displays */
    var dpr = (typeof root.devicePixelRatio === 'number' && root.devicePixelRatio > 0)
      ? root.devicePixelRatio : 1;
    var cssWidth = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 120));
    var cssHeight = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 120));
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    ctx.scale(dpr, dpr);

    var state = 'idle';
    var phaseKind = '';
    var terminalStatus = '';
    var cx = cssWidth / 2;
    var cy = cssHeight / 2;
    var baseRadius = 16;
    var phase = 0;
    var rafId = null;
    var disposed = false;

    /* Reduced motion: freeze the pulse loop — render single static frames,
       repainted only on state changes or preference flips. */
    var reducedMotionQuery = null;
    var reducedMotion = false;
    try {
      if (typeof root.matchMedia === 'function') {
        reducedMotionQuery = root.matchMedia('(prefers-reduced-motion: reduce)');
        reducedMotion = reducedMotionQuery.matches === true;
      }
    } catch (_err) { reducedMotionQuery = null; reducedMotion = false; }

    function getColor() {
      return STATE_COLORS[state] || STATE_COLORS.idle;
    }

    function tick() {
      if (disposed) return;
      rafId = null;
      if (!reducedMotion) phase += 0.03;

      var color = getColor();
      var pulse = reducedMotion ? 1 : 1 + Math.sin(phase) * 0.15;
      var r = baseRadius * pulse;

      ctx.clearRect(0, 0, cssWidth, cssHeight);

      /* outer glow */
      var outerGrad = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r * 2.5);
      outerGrad.addColorStop(0, 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',0.25)');
      outerGrad.addColorStop(1, 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',0)');
      ctx.fillStyle = outerGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 2.5, 0, Math.PI * 2);
      ctx.fill();

      /* core glow */
      var coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      coreGrad.addColorStop(0, 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',0.9)');
      coreGrad.addColorStop(0.6, 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',0.4)');
      coreGrad.addColorStop(1, 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',0)');
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      if (phaseKind === 'tool_use' || phaseKind === 'tool_result') {
        ctx.fillStyle = 'rgba(255, 200, 120, 0.95)';
        ctx.beginPath();
        ctx.arc(cx + (r * 0.8), cy - (r * 0.8), 5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (phaseKind === 'approval_wait' || state === 'alert') {
        ctx.strokeStyle = 'rgba(255, 215, 140, 0.75)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 2.9, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (reducedMotion) return;
      rafId = requestFrame(tick);
    }

    function scheduleFrame() {
      if (disposed || rafId) return;
      rafId = requestFrame(tick);
    }

    function setState(newState) {
      state = STATE_COLORS[newState] ? newState : 'idle';
      if (reducedMotion) scheduleFrame();
    }

    function applyPresence(data) {
      var next = data && typeof data === 'object' ? data : {};
      phaseKind = String(next.phaseKind || next.phase_kind || '').trim().toLowerCase();
      terminalStatus = String(next.terminalStatus || next.terminal_status || '').trim().toLowerCase();
      if (terminalStatus === 'cancelled' || terminalStatus === 'preempted') {
        phaseKind = '';
      }
      setState(next.state || 'idle');
    }

    var onMotionPrefChange = null;
    if (reducedMotionQuery && typeof reducedMotionQuery.addEventListener === 'function') {
      onMotionPrefChange = function (event) {
        reducedMotion = event && event.matches === true;
        scheduleFrame();
      };
      reducedMotionQuery.addEventListener('change', onMotionPrefChange);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (rafId) { cancelFrame(rafId); rafId = null; }
      if (reducedMotionQuery && onMotionPrefChange && typeof reducedMotionQuery.removeEventListener === 'function') {
        reducedMotionQuery.removeEventListener('change', onMotionPrefChange);
        onMotionPrefChange = null;
      }
      ctx.clearRect(0, 0, cssWidth, cssHeight);
    }

    /* start rendering */
    rafId = requestFrame(tick);

    return {
      applyPresence: applyPresence,
      setState: setState,
      dispose: dispose,
    };
  }

  root.overlayCometRenderer = { create: create };

})(typeof globalThis !== 'undefined' ? globalThis : this);
