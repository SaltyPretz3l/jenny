/* renderer/features/renderer-ide-pdf-password.js - the in-pane password
 * prompt for an encrypted PDF in the Workspace IDE (row 65 W4). The host
 * shows it inside that document's own container, so it appears only when
 * the tab is shown. The password is handed straight back to pdf.js; this
 * module keeps no copy and never logs it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePdfPassword = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const LOCK_ICON = '<svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  let promptCounter = 0;

  // Resolves with the entered password; `incorrect` shows the retry line.
  // A later call on the same container replaces the earlier prompt.
  function openPasswordPrompt(container, { actionButton, textField, incorrect = false } = {}) {
    const documentRef = container.ownerDocument;
    container.querySelector('.ide-pdf-password')?.remove();
    promptCounter += 1;
    const id = 'idePdfPassword' + promptCounter;
    const titleId = id + '-title';
    const prompt = documentRef.createElement('div');
    prompt.className = 'ide-pdf-password';
    prompt.setAttribute('role', 'group');
    prompt.setAttribute('aria-labelledby', titleId);
    prompt.innerHTML = `<span class="ide-pdf-password-icon">${LOCK_ICON}</span>`
      + `<div class="ide-pdf-password-title" id="${titleId}">${actionButton.escapeHtml(jt('ide.pdf.passwordTitle', 'This PDF is password-protected'))}</div>`
      + `<div class="ide-pdf-password-copy">${actionButton.escapeHtml(jt('ide.pdf.passwordCopy', 'Enter its password to open it. Jenny keeps it only while this tab is open.'))}</div>`
      + '<div class="ide-pdf-password-row">'
      + textField({ id, type: 'password', value: '', ariaLabel: jt('ide.pdf.passwordField', 'PDF password'), className: 'ide-pdf-password-field' })
      + actionButton({ variant: 'primary', size: 'sm', label: jt('ide.pdf.passwordOpen', 'Open'), dataset: { 'ide-pdf-password-open': 'true' } })
      + '</div>'
      + `<div class="ide-pdf-password-error" role="alert"${incorrect ? '' : ' hidden'}>${actionButton.escapeHtml(jt('ide.pdf.passwordIncorrect', 'That password did not work. Try again.'))}</div>`;
    container.appendChild(prompt);
    const input = prompt.querySelector('input');
    return new Promise((resolve) => {
      const submit = () => {
        const value = String(input?.value || '');
        if (!value) {
          input?.focus();
          return;
        }
        if (input) input.value = '';
        prompt.querySelector('[data-ide-pdf-password-open]')?.setAttribute('disabled', '');
        resolve(value);
      };
      prompt.addEventListener('click', (event) => {
        if (event.target.closest?.('[data-ide-pdf-password-open]')) submit();
      });
      prompt.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing && event.target === input) {
          event.preventDefault();
          submit();
        }
      });
    });
  }

  function focusPasswordPrompt(container) {
    container.querySelector('.ide-pdf-password input')?.focus?.({ preventScroll: true });
  }

  function closePasswordPrompt(container) {
    container.querySelector('.ide-pdf-password')?.remove();
  }

  return { closePasswordPrompt, focusPasswordPrompt, openPasswordPrompt };
});
