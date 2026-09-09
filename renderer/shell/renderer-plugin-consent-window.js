'use strict';
var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

(async function initializeConsentWindow() {
  const bridge = window.jennyPluginConsent;
  const result = await bridge?.initialize?.();
  if (!result?.ok) { window.close(); return; }
  const { model, nonce, epoch } = result;
  const text = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = String(value || '—'); };
  text('consentTitle', model.title); text('publisher', model.publisher); text('packageVersion', model.packageVersion);
  text('contribution', model.contribution); text('digest', `sha256:${String(model.executableDigest || '').slice(0, 8)}…${String(model.executableDigest || '').slice(-8)}`);
  text('containment', jt('plugins.consent.containment', 'Containment: {containment}', { containment: model.containment || jt('plugins.consent.defaultContainment', 'supervised process tree, not sandboxed') }));
  text('limits', jt('plugins.consent.limits', 'Limits: {limits}', { limits: model.limits || jt('plugins.consent.defaultLimits', 'bounded memory and session lifetime') }));
  const acknowledge = document.getElementById('acknowledge');
  const approve = document.getElementById('approve');
  const settle = async (approved) => { await bridge.decide({ nonce, epoch, approved, acknowledged: acknowledge.checked }); };
  acknowledge.addEventListener('change', () => { approve.disabled = !acknowledge.checked; });
  approve.addEventListener('click', () => { if (!approve.disabled) void settle(true); });
  document.getElementById('cancel').addEventListener('click', () => void settle(false));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') void settle(false); });
  acknowledge.focus({ preventScroll: true });
})();
