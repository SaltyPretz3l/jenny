/* Image-space region geometry; DOM and image IO stay with the viewer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.rendererImageSelection = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clone = (value) => value ? JSON.parse(JSON.stringify(value)) : null;
  function imagePoint(x, y, { width, height, zoom, rotation, panX, panY, rect }) {
    const dx = (x - rect.left - rect.width / 2 - panX) / zoom;
    const dy = (y - rect.top - rect.height / 2 - panY) / zoom;
    const angle = -rotation * Math.PI / 180;
    return [Math.max(0, Math.min(width, dx * Math.cos(angle) - dy * Math.sin(angle) + width / 2)),
      Math.max(0, Math.min(height, dx * Math.sin(angle) + dy * Math.cos(angle) + height / 2))].map(Math.round);
  }
  function createSelection() {
    let region = null; let mode = 'pan'; let active = null;
    function choose(next, width, height) {
      if (mode === next) return;
      mode = next; active = null;
      if (next === 'pan') return;
      if (region && next !== 'freehand') {
        const xs = region.points.map(p => p[0]); const ys = region.points.map(p => p[1]);
        region = { kind: next, points: [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]] };
      } else if (!region && next !== 'freehand') region = { kind: next, points: [[Math.round(width / 4), Math.round(height / 4)], [Math.round(width * 3 / 4), Math.round(height * 3 / 4)]] };
      else if (next === 'freehand' && region?.kind !== 'freehand') region = null;
    }

    function start(point, zoom) {
      if (mode === 'pan') return false;
      const handle = region?.kind !== 'freehand' ? region?.points.findIndex(p => Math.hypot(p[0] - point[0], p[1] - point[1]) < 12 / zoom) : -1;
      if (handle >= 0) active = { handle };
      else { region = { kind: mode, points: [point, [...point]] }; active = { handle: 1 }; }
      return true;
    }
    function move(point, square) {
      if (!active || !region) return false;
      if (region.kind === 'freehand') {
        if (region.points.length >= 128) region.points = region.points.filter((_, i) => i % 2 === 0);
        if (Math.hypot(point[0] - region.points.at(-1)[0], point[1] - region.points.at(-1)[1]) >= 2) region.points.push(point);
      } else {
        if (square && region.kind === 'ellipse') {
          const origin = region.points[1 - active.handle];
          const extent = Math.min(Math.abs(point[0] - origin[0]), Math.abs(point[1] - origin[1]));
          point = [origin[0] + Math.sign(point[0] - origin[0]) * extent, origin[1] + Math.sign(point[1] - origin[1]) * extent];
        }
        region.points[active.handle] = point;
      }
      return true;
    }
    function hasRegion() {
      if (!region || region.points.length < (region.kind === 'freehand' ? 3 : 2)) return false;
      const xs = region.points.map(p => p[0]); const ys = region.points.map(p => p[1]);
      return Math.max(...xs) - Math.min(...xs) >= 4 && Math.max(...ys) - Math.min(...ys) >= 4;
    }
    function snapshot() { return hasRegion() ? clone(region) : null; }
    function nudge(dx, dy, resize, width, height) {
      if (mode === 'pan' || !region) return false;
      const next = clone(region);
      next.points = next.points.map((p, i) => resize && region.kind !== 'freehand' && i === 0 ? p : [p[0] + dx, p[1] + dy]);
      if (next.points.every(p => p[0] >= 0 && p[1] >= 0 && p[0] <= width && p[1] <= height)) region = next;
      return true;
    }
    return { choose, start, move, snapshot, hasRegion, nudge, end: () => { active = null; },
      clear: (resetMode = false) => { region = active = null; if (resetMode) mode = 'pan'; }, mode: () => mode, current: () => region };
  }
  function draw(canvas, region, width, height, zoom = 1) {
    if (!region) { if (canvas.width || canvas.height) canvas.width = canvas.height = 0; return; }
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = '#ff00ff'; ctx.lineWidth = 2 / zoom; ctx.beginPath();
    const [a, b] = region.points;
    if (region.kind === 'box') ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    else if (region.kind === 'ellipse') ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(a[0] - b[0]) / 2, Math.abs(a[1] - b[1]) / 2, 0, 0, Math.PI * 2);
    else { region.points.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath(); }
    ctx.stroke();
    if (region.kind !== 'freehand') for (const p of region.points) {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(p[0] - 4 / zoom, p[1] - 4 / zoom, 8 / zoom, 8 / zoom);
    }
  }
  return { imagePoint, createSelection, draw };
});
