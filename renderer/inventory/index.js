/**
 * renderer/inventory/index.js
 *
 * Barrel file — aggregates inventory primitives into globalThis.inventory
 * and performs one-time initialization (copy handlers).
 */
(function (root) {
  'use strict';

  var badge = root.inventoryBadge;
  var spinner = root.inventorySpinner;
  var collapsible = root.inventoryCollapsible;
  var codeBlock = root.inventoryCodeBlock;
  var faviconBadge = root.inventoryFaviconBadge;
  var progressBar = root.inventoryProgressBar;
  var statusRow = root.inventoryStatusRow;
  var numberInput = root.inventoryNumberInput;
  var selectField = root.inventorySelectField;
  // toggle-switch's UMD returns a { toggleSwitch, toggle, setChecked,
  // initToggleHandlers } module object. The barrel exposes the render FUNCTION
  // with the imperative helpers attached (the segmentedControl
  // convention), so `inventory.toggleSwitch.setChecked(...)` works the same as
  // reaching the raw inventoryToggleSwitch module.
  var toggleSwitchModule = root.inventoryToggleSwitch;
  var toggleSwitchFn = toggleSwitchModule
    ? (typeof toggleSwitchModule === 'function' ? toggleSwitchModule : toggleSwitchModule.toggleSwitch)
    : undefined;
  if (toggleSwitchFn && toggleSwitchModule && typeof toggleSwitchModule !== 'function') {
    toggleSwitchFn.toggle = toggleSwitchModule.toggle;
    toggleSwitchFn.setChecked = toggleSwitchModule.setChecked;
    toggleSwitchFn.initToggleHandlers = toggleSwitchModule.initToggleHandlers;
  }
  var checkboxModule = root.inventoryCheckbox;
  var checkboxFn = checkboxModule
    ? (typeof checkboxModule === 'function' ? checkboxModule : checkboxModule.checkbox)
    : undefined;
  if (checkboxFn && checkboxModule) checkboxFn.setChecked = checkboxModule.setChecked;
  var tooltip = root.inventoryTooltip;
  var contextMenu = root.inventoryContextMenu;
  var anchoredListbox = root.inventoryAnchoredListbox;
  var orbitCard = root.inventoryOrbitCard;
  var stepModal = root.inventoryStepModal;
  var chatWayfinderAffordance = root.inventoryChatWayfinderAffordance;
  var actionButton = root.inventoryActionButton;
  var chip = root.inventoryChip;
  var popover = root.inventoryPopover;
  var segmentedControl = root.inventorySegmentedControl;
  // settings-field's UMD returns the render FUNCTION directly (like
  // segmentedControl) with setFieldError/setFieldBusy/findField
  // already attached by the module itself — no re-attachment step needed here.
  var settingsField = root.inventorySettingsField;

  var inventory = {
    badge: badge,
    spinner: spinner,
    collapsible: collapsible,
    codeBlock: codeBlock,
    faviconBadge: faviconBadge,
    progressBar: progressBar,
    statusRow: statusRow,
    numberInput: numberInput,
    selectField: selectField,
    toggleSwitch: toggleSwitchFn,
    checkbox: checkboxFn,
    tooltip: tooltip,
    contextMenu: contextMenu,
    anchoredListbox: anchoredListbox,
    orbitCard: orbitCard,
    stepModal: stepModal,
    chatWayfinderAffordance: chatWayfinderAffordance,
    actionButton: actionButton,
    chip: chip,
    popover: popover,
    segmentedControl: segmentedControl,
    settingsField: settingsField,
  };

  /* Install delegated handlers once. */
  if (typeof document !== 'undefined' && !root.__inventoryHandlersInstalled) {
    root.__inventoryHandlersInstalled = true;
    if (inventory.codeBlock && typeof inventory.codeBlock.initCopyHandlers === 'function') {
      inventory.codeBlock.initCopyHandlers(document);
    }
    if (inventory.faviconBadge && typeof inventory.faviconBadge.initFaviconHandlers === 'function') {
      inventory.faviconBadge.initFaviconHandlers(document);
    }
    if (toggleSwitchModule && typeof toggleSwitchModule.initToggleHandlers === 'function') {
      toggleSwitchModule.initToggleHandlers(document);
    }
    if (inventory.collapsible && typeof inventory.collapsible.initCollapsibleHandlers === 'function') {
      inventory.collapsible.initCollapsibleHandlers(document);
    }
    if (inventory.tooltip && typeof inventory.tooltip.initTooltipHandlers === 'function') {
      inventory.tooltip.initTooltipHandlers(document);
    }
    if (inventory.popover && typeof inventory.popover.initPopoverHandlers === 'function') {
      inventory.popover.initPopoverHandlers(document);
    }
    if (inventory.segmentedControl && typeof inventory.segmentedControl.initSegmentedHandlers === 'function') {
      inventory.segmentedControl.initSegmentedHandlers(document);
    }
  }

  root.inventory = inventory;

  if (typeof module === 'object' && module.exports) {
    module.exports = inventory;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
