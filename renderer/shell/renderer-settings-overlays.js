(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsOverlays = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function positionPopover(button, popover, windowRef) {
    if (!button || !popover || !windowRef || typeof button.getBoundingClientRect !== 'function') {
      return;
    }
    const buttonRect = button.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = Number(windowRef.innerWidth || 0) || 0;
    const top = Math.max(buttonRect.top - popoverRect.height - 10, 16);
    const left = Math.min(
      Math.max(buttonRect.right - popoverRect.width, 16),
      Math.max(viewportWidth - popoverRect.width - 16, 16)
    );
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }

  function computeCommandPopoverPosition(buttonRect, popoverRect, viewport, margin = 16, gap = 10) {
    const viewportWidth = Math.max(Number(viewport?.width || 0), margin * 2);
    const viewportHeight = Math.max(Number(viewport?.height || 0), margin * 2);
    const popoverWidth = Math.max(Number(popoverRect?.width || 0), 0);
    const popoverHeight = Math.max(Number(popoverRect?.height || 0), 0);
    const availableAbove = Math.max(Number(buttonRect?.top || 0) - margin - gap, 0);
    const availableBelow = Math.max(viewportHeight - Number(buttonRect?.bottom || 0) - margin - gap, 0);
    const placeAbove = availableAbove >= Math.min(popoverHeight, 220) || availableAbove >= availableBelow;
    const maxHeight = Math.max(placeAbove ? availableAbove : availableBelow, 96);
    const visibleHeight = Math.min(popoverHeight, maxHeight);
    const top = placeAbove
      ? Math.max(Number(buttonRect?.top || 0) - visibleHeight - gap, margin)
      : Math.min(Number(buttonRect?.bottom || 0) + gap, viewportHeight - visibleHeight - margin);
    const left = Math.min(
      Math.max(Number(buttonRect?.right || 0) - popoverWidth, margin),
      Math.max(viewportWidth - popoverWidth - margin, margin)
    );
    return { top, left, maxHeight };
  }

  function createSettingsOverlayRenderer(deps) {
    const state = deps?.state || {};
    const windowRef = deps?.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    const {
      composerSettingsPopover,
      composerSettingsButton,
      composerChatZoomSelect,
      composerChatZoomStatus,
      composerCommandPopover,
      composerCommandPopoverList,
      composerTerminalShortcut,
    } = deps?.dom || {};
    const {
      listSlashCommands = () => [],
      escapeHtml = (value) => String(value || ''),
      getChatZoomOptions = () => [],
      normalizeChatZoomPercent = (value) => Number(value) || 100,
      buildSelectOptionMarkup = () => '',
    } = deps?.callbacks || {};
    let commandFingerprint = '';
    let commandPositionFrame = 0;
    let disposed = false;

    function renderComposerPopover() {
      const open = Boolean(state.ui.composerPopoverOpen);
      if (!composerSettingsPopover || !composerSettingsButton) return;
      composerSettingsPopover.classList.toggle('hidden', !open);
      composerSettingsButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) {
        return;
      }
      const chatZoomPercent = normalizeChatZoomPercent(state.ui.chatZoomPercent);
      if (composerChatZoomSelect) {
        composerChatZoomSelect.innerHTML = buildSelectOptionMarkup(getChatZoomOptions(), String(chatZoomPercent));
        composerChatZoomSelect.value = String(chatZoomPercent);
      }
      if (composerChatZoomStatus) {
        composerChatZoomStatus.textContent = `${chatZoomPercent}% · Ctrl + wheel adjusts · Ctrl+0 resets.`;
      }
      positionPopover(composerSettingsButton, composerSettingsPopover, windowRef);
    }

    function positionCommandPopover() {
      if (!composerTerminalShortcut || !composerCommandPopover || disposed) return;
      const buttonRect = composerTerminalShortcut.getBoundingClientRect();
      const popoverRect = composerCommandPopover.getBoundingClientRect();
      const next = computeCommandPopoverPosition(buttonRect, popoverRect, {
        width: Number(windowRef.innerWidth || 0),
        height: Number(windowRef.innerHeight || 0),
      });
      const top = `${next.top}px`;
      const left = `${next.left}px`;
      const maxHeight = `${next.maxHeight}px`;
      if (composerCommandPopover.style.top !== top) composerCommandPopover.style.top = top;
      if (composerCommandPopover.style.left !== left) composerCommandPopover.style.left = left;
      if (composerCommandPopover.style.maxHeight !== maxHeight) composerCommandPopover.style.maxHeight = maxHeight;
    }

    function scheduleCommandPosition() {
      if (commandPositionFrame || disposed) return;
      const requestFrame = windowRef.requestAnimationFrame || ((callback) => { callback(); return 0; });
      commandPositionFrame = requestFrame(() => {
        commandPositionFrame = 0;
        if (state.ui.commandPopoverOpen) positionCommandPopover();
      });
    }

    function buildCommandMarkup(commands) {
      const actionButton = windowRef.inventoryActionButton || globalThis.inventoryActionButton;
      if (typeof actionButton !== 'function') return '';
      return commands.map((command, index) => {
        const available = command.available !== false;
        const reason = available ? '' : String(command.unavailableReason || 'Command unavailable.');
        const actionLabel = String(command.actionLabel || (command.action === 'insert' ? 'Insert' : 'Run'));
        return actionButton({
          className: 'composer-popover-action composer-command-item' + (available ? '' : ' composer-command-item--unavailable'),
          dataset: {
            'command-name': command.name,
            'command-action': command.action,
            'command-available': available ? 'true' : 'false',
            'command-reason': reason,
          },
          plain: true,
          role: 'menuitem',
          tabIndex: index === 0 ? 0 : -1,
          ariaLabel: [command.name, command.description, actionLabel, reason].filter(Boolean).join('. '),
          title: reason || `${actionLabel} ${command.name}`,
          trustedHtml:
            '<span class="composer-command-item-body">'
              + '<span class="composer-command-name">' + escapeHtml(command.name) + '</span>'
              + '<span class="composer-popover-copy">' + escapeHtml(command.description) + '</span>'
            + '</span>'
            + '<span class="composer-command-action-badge">' + escapeHtml(actionLabel) + '</span>',
        });
      }).join('');
    }

    function renderCommandPopover(renderOptions) {
      if (!composerCommandPopover || !composerTerminalShortcut || !composerCommandPopoverList) return;
      const open = Boolean(state.ui.commandPopoverOpen);
      if (composerCommandPopover.classList.contains('hidden') === open) {
        composerCommandPopover.classList.toggle('hidden', !open);
      }
      const expanded = open ? 'true' : 'false';
      if (composerTerminalShortcut.getAttribute('aria-expanded') !== expanded) {
        composerTerminalShortcut.setAttribute('aria-expanded', expanded);
      }
      if (!open) {
        if (commandPositionFrame && typeof windowRef.cancelAnimationFrame === 'function') {
          windowRef.cancelAnimationFrame(commandPositionFrame);
        }
        commandPositionFrame = 0;
        return;
      }
      if (renderOptions?.positionOnly === true) {
        scheduleCommandPosition();
        return;
      }
      const commands = typeof listSlashCommands === 'function' ? listSlashCommands() : [];
      const nextFingerprint = JSON.stringify(commands.map((command) => [
        command.name,
        command.description,
        command.action,
        command.actionLabel,
        command.available !== false,
        command.unavailableReason || '',
      ]));
      if (nextFingerprint !== commandFingerprint) {
        const focusedCommand = composerCommandPopoverList.ownerDocument?.activeElement?.dataset?.commandName || '';
        const markup = buildCommandMarkup(commands);
        composerCommandPopoverList.innerHTML = markup || '<p class="composer-command-empty" role="status">Commands are unavailable.</p>';
        for (const item of composerCommandPopoverList.querySelectorAll('[data-command-name]')) {
          if (item.dataset.commandAvailable === 'false') item.setAttribute('aria-disabled', 'true');
        }
        commandFingerprint = nextFingerprint;
        if (focusedCommand) {
          const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(focusedCommand)
            : focusedCommand.replace(/["\\]/g, '\\$&');
          composerCommandPopoverList.querySelector(`[data-command-name="${escaped}"]`)?.focus?.();
        }
      }
      positionCommandPopover();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (commandPositionFrame && typeof windowRef.cancelAnimationFrame === 'function') {
        windowRef.cancelAnimationFrame(commandPositionFrame);
      }
      commandPositionFrame = 0;
    }

    return {
      renderComposerPopover,
      renderCommandPopover,
      dispose,
    };
  }

  return { computeCommandPopoverPosition, createSettingsOverlayRenderer };
});
