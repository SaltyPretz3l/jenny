// Split view W1-1: the pane wrapper, the pane kicker and divider hosts, and the
// inert second-pane template in index.html.
//
// W1-1 is the first slice that changes pane 0's DOM tree, and it is still
// invisible: nothing opens a second pane until W1-4. So the acceptance is
// "the wrapper is the ONLY structural change". This suite pins that from four
// sides: the id set inside #chatView (frozen from the pre-W1 markup), the
// exact child order of #chatView and #chatPane0, the resolver's answer for
// pane 0 (every name by id) and for a clone of the template (exactly the 20
// hosts a second pane owns: Wave 1's 18, W2-2b's attachment tray and W3-2's
// subagent inspector; W3-1's three notice hosts are template-only, see
// PANE_TEMPLATE_NOTICE_NAMES), and a real renderer boot.
//
// The template law: `<template>` content is inert and is not in the document
// tree, but it still lives in index.html, so it carries `data-chat-node` and
// classes ONLY -- no id (a clone would duplicate it) and no raw
// <button>/<input>/<select> (the down-only raw-primitive allowance counts tags
// inside <template> too; W1-4 builds every control at runtime through the
// inventory action-button primitive).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const {
  CHAT_PANE_NODE_NAMES,
  resolveChatPaneDom,
} = require('../renderer/shell/renderer-bootstrap-dom.js');
const { loadRendererApp } = require('./helpers/renderer-shell-harness');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Every [id] inside #chatView BEFORE W1-1, generated once from
// `git show eded14308:index.html` (main tip 2026-09-25) with jsdom:
// [...chatView.querySelectorAll('[id]')].map((n) => n.id).sort().
// 107 ids (the 2026-09-16 spec counted 106; the post-1.2.0 sweep added one).
const PRE_W1_CHAT_VIEW_IDS = Object.freeze([
  'artifactReviewCollapseButton', 'artifactReviewDeleteButton', 'artifactReviewDetailEmpty',
  'artifactReviewDetailKicker', 'artifactReviewDetailMeta', 'artifactReviewDetailNote',
  'artifactReviewDetailPanel', 'artifactReviewDetailPath', 'artifactReviewDetailStatus',
  'artifactReviewDetailTitle', 'artifactReviewDirtyBadge', 'artifactReviewEditorFallback',
  'artifactReviewEditorHost', 'artifactReviewEditorShell', 'artifactReviewJumpButton',
  'artifactReviewOpenExternalButton', 'artifactReviewPanel', 'artifactReviewPreviewContent',
  'artifactReviewPreviewShell', 'artifactReviewProvenanceTimeline', 'artifactReviewResizer',
  'artifactReviewRevealButton', 'artifactReviewRevertButton', 'artifactReviewSaveButton',
  'artifactReviewStatus', 'artifactSplitViewToggle', 'attachmentNotice', 'attachmentTray',
  'backgroundJobsStrip', 'chatAssistantSprite', 'chatContextPanel', 'chatInput', 'chatOriginChip',
  'chatOriginLabel', 'chatScrollSentinel', 'chatSearchOverlayHost', 'chatSelectionOverlayHost',
  'chatSpriteLayer', 'chatSurface', 'chatSurfaceEffectLeft', 'chatSurfaceEffects',
  'chatThreadColumn', 'chatThreadScroll', 'chatThreadStage', 'chatTimeline',
  'chatTimelineUtilityCluster', 'composerAttachShortcut', 'composerAttachmentPreviewPill',
  'composerContextUsageSlot', 'composerEffortDisabledReason', 'composerEffortSelect',
  'composerGearPostureDot', 'composerHelpText', 'composerHolo', 'composerModeChips',
  'composerModeChipsAnnouncer', 'composerModelDisabledReason', 'composerModelPillSlot',
  'composerModelPopover', 'composerModelSelect', 'composerPlanUsageSlot', 'composerProjectPillSlot',
  'composerRunModeHint', 'composerRunModeSlot',
  'composerSendDisabledReason', 'composerSettingsButton', 'composerSettingsDisabledReason',
  'composerStatusNotice', 'composerTerminalShortcut', 'composerToolToggleSlot', 'composerTurnTimer',
  'composerV2FailedSendNotice', 'composerWayfinderHost', 'composerWrap', 'contextArtifactCount',
  'contextArtifactExpand', 'contextArtifactList', 'contextArtifactSection', 'contextLogCount',
  'contextLogDisclosure', 'contextLogSection', 'contextPanelToggle',
  // 2026-09-27: contextPulse + contextPulseSection dropped (Session Pulse removed from the context rail).
  'contextSessionLogs', 'heroAvatar', 'heroRuntimeHint', 'heroStack',
  'heroStage', 'heroSubtitle', 'heroTitle', 'jumpToBottomButton', 'jumpToLastPromptButton',
  'jumpToTopButton', 'pluginSessionFallback', 'pluginSessionFallbackAction', 'runtimeQueue',
  'sendButton', 'sendOutbox', 'stopStreamButton', 'subagentInspector',
]);

// 2026-09-29 (artifact panel area 3, deliberate pin change): the static
// children of #artifactReviewPanel are gone from index.html. The V3 chrome
// (renderer-artifact-panel-chrome-render.js buildPanelHtml) replaced them at
// install anyway and re-creates every id the manager reads; the <aside> and
// its resizer stay.
const REMOVED_LEGACY_ARTIFACT_PANEL_IDS = Object.freeze([
  'artifactReviewCollapseButton', 'artifactReviewDeleteButton', 'artifactReviewDetailEmpty',
  'artifactReviewDetailKicker', 'artifactReviewDetailMeta', 'artifactReviewDetailNote',
  'artifactReviewDetailPanel', 'artifactReviewDetailPath', 'artifactReviewDetailStatus',
  'artifactReviewDetailTitle', 'artifactReviewDirtyBadge', 'artifactReviewEditorFallback',
  'artifactReviewEditorHost', 'artifactReviewEditorShell', 'artifactReviewJumpButton',
  'artifactReviewOpenExternalButton', 'artifactReviewPreviewContent', 'artifactReviewPreviewShell',
  'artifactReviewProvenanceTimeline', 'artifactReviewRevealButton', 'artifactReviewRevertButton',
  'artifactReviewSaveButton', 'artifactReviewStatus',
]);

// The only ids W1-1 may add inside #chatView: the pane wrapper, its kicker
// host, the pane divider, and the <template> element itself (its CONTENT
// carries no id; see below).
const W1_ADDED_IDS = Object.freeze(['chatPane0', 'chatPaneKicker', 'chatPaneResizer', 'chatPaneTemplate']);
// W3-3 (2026-09-26) adds one wrapper on purpose: pane 0's composer settings
// group (display: contents until the toolbar collapses into the summary pill).
const W3_ADDED_IDS = Object.freeze(['composerSettingsGroup']);
const CHAT_PANEL_IDS = ['composerChatChipHost', 'composerChatPanel', 'composerChatPanelTitle',
  'composerChatPanelChips', 'composerChatPanelList', 'composerChatPosture', 'composerChatPostureDot', 'composerChatPostureText'];
const REMOVED_GEAR_IDS = ['composerSettingsButton', 'composerSettingsDisabledReason', 'composerGearPostureDot', 'composerRunModeHint'];

// The three resolution groups for a clone of #chatPaneTemplate. 20 + 9 + 3 = 32
// (2026-09-29: timelineCollapseExpandToggle retired with transcript views).
// Hosts a second pane owns (present in the template; W2-2b adds attachmentTray,
// W3-2 adds subagentInspector).
const TEMPLATE_HOST_NAMES = Object.freeze([
  'chatPaneKicker', 'heroStage', 'chatThreadStage', 'chatSearchOverlayHost',
  'chatSelectionOverlayHost', 'chatSurface', 'chatThreadScroll', 'chatThreadColumn',
  'chatSpriteLayer', 'chatAssistantSprite', 'chatOriginChip', 'chatOriginLabel', 'chatTimeline',
  'chatScrollSentinel', 'chatTimelineUtilityCluster', 'composerWayfinderHost', 'composerWrap',
  'chatInput', 'attachmentTray', 'subagentInspector',
]);
// Controls W1-4 builds at runtime through renderer/inventory/action-button.js
// (the template may not carry raw <button> markup; W2-2b adds the attach button;
// W3-3 adds the settings group, which pane 1's composer rail builds at mount).
const RUNTIME_BUILT_CONTROL_NAMES = Object.freeze([
  'jumpToTopButton', 'jumpToLastPromptButton', 'jumpToBottomButton', 'artifactSplitViewToggle',
  'composerTerminalShortcut', 'stopStreamButton', 'sendButton',
  'composerAttachShortcut', 'composerSettingsGroup',
]);
// Split view W3-1 (deliberate pin change): pane 1's template carries its own
// preview pill, composer status notice and failed-send notice, named after
// pane 0's ids. They are NOT pane node names: pane 0 keeps reaching its nodes
// by id and gains no data-chat-node (one pane stays byte-identical), so
// CHAT_PANE_NODE_NAMES and the 19 + 9 + 3 split are unchanged and the pane
// composition resolves these three inside the pane root.
const PANE_TEMPLATE_NOTICE_NAMES = Object.freeze([
  'composerAttachmentPreviewPill', 'composerStatusNotice', 'composerV2FailedSendNotice',
]);
// View-level grid columns that stay pane 0's until Wave 2 gives the artifact
// panel to a pane.
const PANE_ZERO_ONLY_COLUMN_NAMES = Object.freeze([
  'chatContextPanel', 'artifactReviewResizer', 'artifactReviewPanel',
]);

function indexHtmlDocument() {
  return new JSDOM(INDEX_HTML).window.document;
}

function childIds(element) {
  return [...element.children].map((child) => child.id || `<${child.tagName.toLowerCase()}>`);
}

function templateSourceSlice() {
  const start = INDEX_HTML.indexOf('<template id="chatPaneTemplate">');
  const end = INDEX_HTML.indexOf('</template>', start);
  assert.ok(start > 0 && end > start, 'index.html carries exactly one #chatPaneTemplate block');
  return INDEX_HTML.slice(start, end + '</template>'.length);
}

function cloneTemplateInto(documentRef) {
  const template = documentRef.getElementById('chatPaneTemplate');
  const fragment = documentRef.importNode(template.content, true);
  const paneRoot = fragment.firstElementChild;
  documentRef.body.appendChild(fragment);
  return paneRoot;
}

test('the three resolution groups partition CHAT_PANE_NODE_NAMES (20 + 9 + 3 = 32)', () => {
  const groups = [...TEMPLATE_HOST_NAMES, ...RUNTIME_BUILT_CONTROL_NAMES, ...PANE_ZERO_ONLY_COLUMN_NAMES];
  assert.equal(TEMPLATE_HOST_NAMES.length, 20);
  assert.equal(RUNTIME_BUILT_CONTROL_NAMES.length, 9);
  assert.equal(PANE_ZERO_ONLY_COLUMN_NAMES.length, 3);
  assert.equal(new Set(groups).size, groups.length, 'no name sits in two groups');
  assert.equal(CHAT_PANE_NODE_NAMES.length, 32, 'W1-1 adds chatPaneKicker: 28 -> 29; W2-2b adds attachmentTray and composerAttachShortcut: 31; W3-2 adds subagentInspector: 32; W3-3 adds composerSettingsGroup: 33; transcript views retire timelineCollapseExpandToggle: 32');
  assert.deepEqual([...groups].sort(), [...CHAT_PANE_NODE_NAMES].sort());
});

test('one-pane identity: #chatView ids are the pre-W1 set plus exactly the four W1 ids and the one W3-3 id', () => {
  const documentRef = indexHtmlDocument();
  const chatView = documentRef.getElementById('chatView');
  const ids = [...chatView.querySelectorAll('[id]')].map((node) => node.id).sort();

  assert.equal(PRE_W1_CHAT_VIEW_IDS.length, 99); // 107 less the two Session Pulse ids (2026-09-27), less timelineCollapseExpandToggle (transcript views, 2026-09-29), less the four remote banner ids (Remote Control removed, 2026-10-02), less chatSpriteHolo (sprite holo retired, 2026-10-02)
  assert.deepEqual(
    ids,
    [...PRE_W1_CHAT_VIEW_IDS.filter((id) => !REMOVED_LEGACY_ARTIFACT_PANEL_IDS.includes(id) && !REMOVED_GEAR_IDS.includes(id)), ...W1_ADDED_IDS, ...W3_ADDED_IDS, ...CHAT_PANEL_IDS].sort(),
    'pane wrappers and the Chat panel add their owned ids; legacy artifact children, the composer gear and the run-mode hint row are removed'
  );
  assert.equal(new Set(ids).size, ids.length, 'no id inside #chatView is duplicated');

  // The template is inert: its content is a separate fragment, and it must
  // carry no id at all (a clone would duplicate it into the live document).
  const template = documentRef.getElementById('chatPaneTemplate');
  assert.equal(template.tagName.toLowerCase(), 'template');
  assert.equal(template.content.querySelectorAll('[id]').length, 0, 'the template carries no id');
  assert.equal(
    new RegExp('\\sid="').test(templateSourceSlice().replace('<template id="chatPaneTemplate">', '')),
    false,
    'no id attribute anywhere inside the template source'
  );
});

test('structure: the wrapper holds exactly the four pane children behind the kicker', () => {
  const documentRef = indexHtmlDocument();
  const chatView = documentRef.getElementById('chatView');
  const pane = documentRef.getElementById('chatPane0');

  assert.deepEqual(childIds(chatView), [
    'chatSurfaceEffects',
    'chatPane0',
    'chatPaneResizer',
    'artifactReviewResizer',
    'artifactReviewPanel',
    'chatContextPanel',
    'chatPaneTemplate',
  ]);
  assert.deepEqual(childIds(pane), [
    'chatPaneKicker',
    'heroStage',
    'chatThreadStage',
    'chatTimelineUtilityCluster',
    'composerWrap',
  ]);

  assert.equal(chatView.getAttribute('data-pane-count'), '1');
  assert.equal(pane.classList.contains('chat-pane'), true);
  assert.equal(pane.getAttribute('data-pane-id'), '0');
  assert.equal(pane.getAttribute('data-pane-focused'), 'true');

  const kicker = documentRef.getElementById('chatPaneKicker');
  assert.equal(kicker.classList.contains('chat-pane-kicker'), true);
  assert.equal(kicker.hasAttribute('hidden'), true, 'the kicker is hidden with one pane');
  assert.equal(kicker.children.length, 0, 'the kicker host is empty until W1-4 fills it');
  assert.equal(kicker.textContent, '');

  const resizer = documentRef.getElementById('chatPaneResizer');
  assert.equal(resizer.classList.contains('chat-pane-resizer'), true);
  assert.equal(resizer.classList.contains('artifact-review-resizer'), true, 'shares the artifact divider look');
  assert.equal(resizer.classList.contains('hidden'), true, 'the divider is hidden with one pane');
});

test('resolver: pane 0 resolves all 32 by id; the data-chat-node set outside the template is the list', () => {
  const documentRef = indexHtmlDocument();
  const resolved = resolveChatPaneDom(documentRef, null);
  for (const name of CHAT_PANE_NODE_NAMES) {
    assert.notEqual(resolved[name], null, `${name} resolves for pane 0`);
    assert.equal(resolved[name], documentRef.getElementById(name));
  }
  const pane = documentRef.getElementById('chatPane0');
  for (const name of [...TEMPLATE_HOST_NAMES, ...RUNTIME_BUILT_CONTROL_NAMES]) {
    assert.equal(pane.contains(resolved[name]), true, `${name} lives inside #chatPane0`);
  }
  for (const name of PANE_ZERO_ONLY_COLUMN_NAMES) {
    assert.equal(pane.contains(resolved[name]), false, `${name} stays a view-level column`);
  }

  // querySelectorAll does not enter <template> content, so this is the live
  // document's attribute set.
  const marked = [...documentRef.querySelectorAll('[data-chat-node]')]
    .map((node) => node.getAttribute('data-chat-node'))
    .sort();
  assert.deepEqual(marked, [...CHAT_PANE_NODE_NAMES].sort());
});

test('resolver: a cloned template resolves exactly the 20 hosts and null for the 10 + 3', () => {
  const documentRef = indexHtmlDocument();
  const paneZero = resolveChatPaneDom(documentRef, null);
  const paneRoot = cloneTemplateInto(documentRef);

  assert.equal(paneRoot.classList.contains('chat-pane'), true, 'the template content is one div.chat-pane');
  assert.equal(paneRoot.hasAttribute('id'), false);
  assert.equal(paneRoot.hasAttribute('data-pane-id'), false, 'W1-4 sets data-pane-id');
  assert.equal(paneRoot.hasAttribute('data-pane-focused'), false, 'W1-4 sets data-pane-focused');

  const resolved = resolveChatPaneDom(documentRef, paneRoot);
  for (const name of TEMPLATE_HOST_NAMES) {
    assert.notEqual(resolved[name], null, `${name} resolves inside the clone`);
    assert.equal(paneRoot.contains(resolved[name]), true, `${name} is the clone's own node`);
    assert.notEqual(resolved[name], paneZero[name], `${name} is not pane 0's node`);
  }
  for (const name of [...RUNTIME_BUILT_CONTROL_NAMES, ...PANE_ZERO_ONLY_COLUMN_NAMES]) {
    assert.equal(resolved[name], null, `${name} is not in the template`);
  }

  const templateMarked = [...paneRoot.querySelectorAll('[data-chat-node]')]
    .map((node) => node.getAttribute('data-chat-node'));
  if (paneRoot.hasAttribute('data-chat-node')) templateMarked.push(paneRoot.getAttribute('data-chat-node'));
  assert.deepEqual([...templateMarked].sort(), [...TEMPLATE_HOST_NAMES, ...PANE_TEMPLATE_NOTICE_NAMES].sort(), 'no stray data-chat-node');
  for (const name of PANE_TEMPLATE_NOTICE_NAMES) {
    assert.equal(CHAT_PANE_NODE_NAMES.includes(name), false, `${name} is template-only, not a pane node name`);
  }

  // Direct children, in pane 0's order.
  assert.deepEqual(
    [...paneRoot.children].map((child) => child.getAttribute('data-chat-node')),
    ['chatPaneKicker', 'heroStage', 'chatThreadStage', 'chatTimelineUtilityCluster', 'composerWrap']
  );
  assert.equal(resolved.chatPaneKicker.hasAttribute('hidden'), true);
  assert.equal(resolved.composerWayfinderHost.hasAttribute('hidden'), true);
  assert.equal(resolved.chatSearchOverlayHost.hasAttribute('hidden'), true);
  assert.equal(resolved.chatSelectionOverlayHost.hasAttribute('hidden'), true);
  assert.equal(resolved.chatInput.tagName.toLowerCase(), 'textarea');
  assert.equal(resolved.chatInput.hasAttribute('aria-describedby'), false, 'its target would be an id');
  // Explicit spellcheck="true" is the delegated spell-menu eligibility boundary
  // (tests/renderer-spellcheck-field-inventory.test.js counts it per file), so
  // the template leaves it off; W1-4 sets it on the clone at runtime.
  assert.equal(resolved.chatInput.hasAttribute('spellcheck'), false);
  assert.equal(resolved.chatTimeline.getAttribute('role'), 'log');
  for (const attribute of ['aria-live', 'aria-atomic', 'aria-busy', 'aria-label', 'data-i18n-aria-label']) {
    assert.equal(
      resolved.chatTimeline.getAttribute(attribute),
      paneZero.chatTimeline.getAttribute(attribute),
      `the template timeline keeps pane 0's ${attribute}`
    );
  }

  // Wave 1 hosts only: the jump cluster and composer rail are EMPTY hosts, and
  // the id-keyed singletons stay pane 0's.
  const jumpHost = paneRoot.querySelector('.composer-jump-tools');
  assert.ok(jumpHost, 'the jump-tools host is present');
  assert.equal(jumpHost.children.length, 0, 'W1-4 builds the three jump buttons');
  assert.equal(paneRoot.querySelector('.composer-toolbar-left').children.length, 0);
  assert.equal(paneRoot.querySelector('.composer-toolbar-right.composer-rail').children.length, 0);
  for (const selector of [
    '.plugin-session-fallback', '.send-outbox',
    '.runtime-queue', '.composer-mode-chips', '.composer-holo',
    '.attachment-notice',
  ]) {
    assert.equal(paneRoot.querySelector(selector), null, `${selector} is a pane-0 singleton`);
  }
  // W2-2b: the attachment tray is per pane, in pane 0's position (inside the
  // composer wrap, before the composer). W3-1: so are the preview pill, the
  // status notice and the failed-send notice, in pane 0's relative order.
  const trays = paneRoot.querySelectorAll('.attachment-tray');
  assert.equal(trays.length, 1, 'the template carries one attachment tray');
  assert.equal(trays[0].getAttribute('data-chat-node'), 'attachmentTray');
  assert.equal(trays[0].classList.contains('hidden'), true);
  assert.equal(trays[0].getAttribute('aria-live'), 'polite');
  const wrap = paneRoot.querySelector('[data-chat-node="composerWrap"]');
  assert.equal(trays[0].parentElement, wrap);
  assert.deepEqual(
    [...wrap.children].map((child) => child.getAttribute('data-chat-node') || child.className),
    ['composerAttachmentPreviewPill', 'attachmentTray', 'composerStatusNotice', 'composerV2FailedSendNotice', 'composer'],
    'the template wrap keeps pane 0\'s order: pill, tray, status notice, failed-send notice, composer'
  );
  const paneZeroWrap = documentRef.getElementById('composerWrap');
  for (const name of PANE_TEMPLATE_NOTICE_NAMES) {
    const clone = wrap.querySelector(`[data-chat-node="${name}"]`);
    const original = paneZeroWrap.querySelector(`#${name}`);
    assert.equal(clone.className, original.className, `${name} keeps pane 0's classes`);
    for (const attribute of ['role', 'aria-live', 'data-composer-v2']) {
      assert.equal(clone.getAttribute(attribute), original.getAttribute(attribute), `${name} mirrors pane 0's ${attribute}`);
    }
    assert.equal(original.hasAttribute('data-chat-node'), false, `pane 0's #${name} markup is unchanged`);
  }
  // W3-2: the subagent inspector is per pane, in pane 0's position (inside the
  // thread stage, after the thread shell, before the jump cluster), hidden,
  // with pane 0's attributes minus the id-keyed aria-labelledby.
  const inspectors = paneRoot.querySelectorAll('.subagent-monitor-inspector');
  assert.equal(inspectors.length, 1, 'the template carries one subagent inspector');
  const inspector = inspectors[0];
  const paneZeroInspector = documentRef.getElementById('subagentInspector');
  assert.equal(inspector.tagName, paneZeroInspector.tagName);
  assert.equal(inspector.getAttribute('data-chat-node'), 'subagentInspector');
  assert.equal(inspector.parentElement, resolved.chatThreadStage);
  assert.equal(inspector.previousElementSibling, resolved.chatSurface);
  assert.equal(inspector.nextElementSibling, paneRoot.querySelector('.composer-jump-tools'));
  assert.equal(paneZeroInspector.previousElementSibling, paneZero.chatSurface, 'pane 0 has the same position');
  for (const attribute of ['role', 'aria-hidden', 'hidden']) {
    assert.equal(inspector.getAttribute(attribute), paneZeroInspector.getAttribute(attribute), `the template inspector keeps pane 0's ${attribute}`);
  }
  assert.equal(inspector.hasAttribute('aria-labelledby'), false, 'its target would be an id');
});

test('the template carries no raw button, input or select (DOM and source text)', () => {
  const documentRef = indexHtmlDocument();
  const template = documentRef.getElementById('chatPaneTemplate');
  assert.equal(template.content.querySelectorAll('button, input, select').length, 0);
  const primitive = new RegExp('<(button|input|select)\\b', 'i');
  assert.equal(primitive.test(templateSourceSlice()), false, 'the raw-primitive allowance cannot move');
});

test('the template copies pane 0 i18n markers and never invents one', () => {
  const documentRef = indexHtmlDocument();
  const paneZero = documentRef.getElementById('chatPane0');
  const template = documentRef.getElementById('chatPaneTemplate');
  const markerAttributes = ['data-i18n', 'data-i18n-aria-label', 'data-i18n-title', 'data-i18n-placeholder'];
  const paneZeroMarkers = new Set();
  for (const attribute of markerAttributes) {
    for (const node of paneZero.querySelectorAll(`[${attribute}]`)) {
      paneZeroMarkers.add(`${attribute}=${node.getAttribute(attribute)}`);
    }
  }
  let templateMarkerCount = 0;
  for (const attribute of markerAttributes) {
    for (const node of template.content.querySelectorAll(`[${attribute}]`)) {
      templateMarkerCount += 1;
      assert.equal(
        paneZeroMarkers.has(`${attribute}=${node.getAttribute(attribute)}`),
        true,
        `${attribute}=${node.getAttribute(attribute)} must exist on pane 0 too`
      );
    }
  }
  assert.ok(templateMarkerCount >= 8, 'the hero, timeline, cluster and composer markers are kept');
});

test('the pane divider mirrors the artifact divider attribute names plus the aria-value range', () => {
  const documentRef = indexHtmlDocument();
  const artifact = documentRef.getElementById('artifactReviewResizer');
  const pane = documentRef.getElementById('chatPaneResizer');
  const mirrored = ['role', 'aria-orientation', 'aria-label', 'data-i18n-aria-label', 'title', 'data-i18n-title', 'tabindex'];
  for (const attribute of mirrored) {
    assert.equal(artifact.hasAttribute(attribute), true, `the artifact divider has ${attribute}`);
    assert.equal(pane.hasAttribute(attribute), true, `the pane divider has ${attribute}`);
  }
  assert.equal(pane.getAttribute('role'), 'separator');
  assert.equal(pane.getAttribute('aria-orientation'), 'vertical');
  assert.equal(pane.getAttribute('tabindex'), '-1');
  assert.equal(pane.getAttribute('data-i18n-aria-label'), 'chat.panes.resizeLabel');
  assert.equal(pane.getAttribute('data-i18n-title'), 'chat.panes.resizeTitle');
  assert.equal(pane.getAttribute('aria-valuemin'), '20');
  assert.equal(pane.getAttribute('aria-valuemax'), '80');
  assert.equal(pane.getAttribute('aria-valuenow'), '50');
  const allowed = new Set([...mirrored, 'class', 'id', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow']);
  const extra = [...pane.attributes].map((attribute) => attribute.name).filter((name) => !allowed.has(name));
  assert.deepEqual(extra, [], 'nothing beyond the mirrored set');
});

test('a real renderer boot is green with the wrapper and resolves all 32 names', async (t) => {
  const app = await loadRendererApp({});
  t.after(async () => { await app.dispose(); });
  const { window } = app;
  const documentRef = window.document;

  const resolved = window.rendererBootstrapDom.resolveChatPaneDom(documentRef, null);
  const missing = [...CHAT_PANE_NODE_NAMES].filter(
    (name) => resolved[name] == null || resolved[name] !== documentRef.getElementById(name)
  );
  assert.deepEqual(missing, []);
  const pane = documentRef.getElementById('chatPane0');
  assert.ok(pane, 'the booted document has #chatPane0');
  assert.equal(pane.contains(documentRef.getElementById('chatTimeline')), true);
  assert.equal(pane.contains(documentRef.getElementById('chatInput')), true);
  assert.equal(documentRef.getElementById('chatView').getAttribute('data-pane-count'), '1');
});
