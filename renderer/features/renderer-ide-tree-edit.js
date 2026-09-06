/* renderer/features/renderer-ide-tree-edit.js - Workspace tree inline editing.
 * services/workspace-ide-path-guard.js duplicates the non-collision name rules;
 * services cannot require renderer modules, so tests enforce their parity. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTreeEdit = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ERROR_ID = 'ide-tree-edit-error';
  const INVALID_CLASS = 'ide-tree-edit-field--invalid';

  function comparableName(name, isWin32) {
    const value = String(name || '');
    return isWin32 ? value.toLocaleLowerCase() : value;
  }

  const NAME_RULES = [
    {
      matches: (name) => name.trim() === '',
      message: () => 'Enter a name.',
    },
    {
      matches: (name) => name === '.' || name === '..',
      message: () => 'A name can\'t be "." or "..".',
    },
    {
      matches: (name) => /[\\/:*?"<>|]/.test(name)
        || Array.prototype.some.call(name, (ch) => ch.charCodeAt(0) < 0x20),
      message: () => 'A name can\'t contain any of: \\ / : * ? " < > |',
    },
    {
      matches: (name) => /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(name),
      message: (name) => `"${name}" is a reserved name in Windows.`,
    },
    {
      matches: (name) => /[. ]$/.test(name),
      message: () => 'A name can\'t end with a space or a period.',
    },
    {
      matches: (name) => name.length > 255,
      message: () => 'That name is too long (255 characters max).',
    },
    {
      matches: (name, context) => {
        const candidate = comparableName(name, context.isWin32);
        const current = comparableName(context.currentName, context.isWin32);
        if (current && candidate === current) {
          return false;
        }
        return context.siblings.some(
          (sibling) => comparableName(sibling, context.isWin32) === candidate
        );
      },
      message: (name) => `A file or folder named "${name}" already exists here.`,
    },
  ];

  function validateEntryName(name, options = {}) {
    const value = String(name == null ? '' : name);
    const context = {
      siblings: Array.isArray(options.siblings) ? options.siblings : [],
      currentName: String(options.currentName || ''),
      isWin32: options.isWin32 === true,
    };
    for (const rule of NAME_RULES) {
      if (rule.matches(value, context)) {
        return { ok: false, message: rule.message(value, context) };
      }
    }
    return { ok: true };
  }

  function createIdeTreeEditSession(deps = {}) {
    const getPendingEdit = typeof deps.getPendingEdit === 'function'
      ? deps.getPendingEdit : () => null;
    const getMountEl = typeof deps.getMountEl === 'function' ? deps.getMountEl : () => null;
    const childrenByDir = deps.childrenByDir instanceof Map ? deps.childrenByDir : new Map();
    const isWin32 = deps.isWin32 === true;
    let blurCommitTimer = null;
    let currentEdit = null;
    let currentMessage = '';

    function contextFor(edit) {
      const entries = childrenByDir.get(edit?.dirPath || '');
      return {
        siblings: Array.isArray(entries) ? entries.map((entry) => entry?.name) : [],
        currentName: edit?.mode === 'rename' ? edit.originalName : '',
        isWin32,
      };
    }

    function validate(name, edit = getPendingEdit()) {
      return validateEntryName(name, contextFor(edit));
    }

    function controlFor(panel = getMountEl()) {
      return panel?.querySelector?.('[data-ide-tree-edit-control]') || null;
    }

    function clearControlError(control) {
      control?.classList?.remove(INVALID_CLASS);
      control?.removeAttribute?.('aria-invalid');
      control?.removeAttribute?.('aria-describedby');
      control?.closest?.('.ide-tree-row--edit')?.querySelector?.(`.${ERROR_ID}`)?.remove?.();
    }

    function paintControlError(control, message) {
      if (!control) {
        return;
      }
      if (!message) {
        clearControlError(control);
        return;
      }
      const row = control.closest?.('.ide-tree-row--edit');
      if (!row) {
        return;
      }
      let error = row.querySelector(`.${ERROR_ID}`);
      if (!error) {
        error = row.ownerDocument.createElement('div');
        error.id = ERROR_ID;
        error.className = ERROR_ID;
        error.setAttribute('role', 'alert');
        row.appendChild(error);
      }
      error.textContent = message;
      control.classList.add(INVALID_CLASS);
      control.setAttribute('aria-invalid', 'true');
      control.setAttribute('aria-describedby', ERROR_ID);
    }

    function rememberResult(edit, result) {
      currentEdit = edit;
      currentMessage = result.ok ? '' : result.message;
      edit.validationMessage = currentMessage;
    }

    function onInput(control) {
      const edit = getPendingEdit();
      if (!edit || !control) {
        return { ok: true };
      }
      const value = String(control.value == null ? '' : control.value);
      edit.draftName = value;
      const result = validate(value, edit);
      rememberResult(edit, result);
      paintControlError(control, result.ok ? '' : result.message);
      return result;
    }

    function paintError(message, { edit = getPendingEdit(), value } = {}) {
      if (!edit || getPendingEdit() !== edit) {
        return;
      }
      if (value !== undefined) {
        edit.draftName = String(value == null ? '' : value);
      }
      const result = message ? { ok: false, message: String(message) } : { ok: true };
      rememberResult(edit, result);
      paintControlError(controlFor(), result.ok ? '' : result.message);
    }

    function repaint(panel) {
      const edit = getPendingEdit();
      const control = controlFor(panel);
      if (!edit || !control) {
        return;
      }
      control.value = edit.draftName ?? edit.originalName ?? '';
      currentEdit = edit;
      currentMessage = String(edit.validationMessage || '');
      paintControlError(control, currentMessage);
      if (edit.selectionApplied) {
        return;
      }
      edit.selectionApplied = true;
      if (edit.mode === 'rename' && typeof control.setSelectionRange === 'function') {
        const editName = String(edit.originalName || '');
        const finalDot = editName.lastIndexOf('.');
        const stemLength = edit.kind === 'directory' || finalDot <= 0
          ? editName.length : finalDot;
        control.setSelectionRange(0, stemLength);
      } else {
        control.select?.();
      }
    }

    function isInvalid() {
      return currentEdit === getPendingEdit() && Boolean(currentMessage);
    }

    function getMessage() {
      return currentEdit === getPendingEdit() ? currentMessage : '';
    }

    function cancelBlurCommit() {
      if (blurCommitTimer === null) {
        return false;
      }
      clearTimeout(blurCommitTimer);
      blurCommitTimer = null;
      return true;
    }

    function queueBlurCommit(fn) {
      cancelBlurCommit();
      blurCommitTimer = setTimeout(() => {
        blurCommitTimer = null;
        fn();
      }, 0);
    }

    function clear() {
      const cancelled = cancelBlurCommit();
      clearControlError(controlFor());
      currentEdit = null;
      currentMessage = '';
      return cancelled;
    }

    return {
      repaint,
      onInput,
      validate,
      paintError,
      isInvalid,
      getMessage,
      queueBlurCommit,
      cancelBlurCommit,
      clear,
    };
  }

  return {
    validateEntryName,
    createIdeTreeEditSession,
  };
});
