/* Hosted browser view. DOM composition stays here; transport and lifecycle
 * decisions belong to browser-bridge.js and app.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../inventory/action-button'),
      require('../inventory/text-field'),
      require('../inventory/select-field'),
      require('../inventory/checkbox'),
      require('../inventory/segmented-control'),
      require('../chat/chat-message-utils'),
      require('../chat/renderer-turn-tree-projector'),
      require('../chat/renderer-turn-row-projector'),
      require('marked'),
      require('dompurify'),
      require('../shared/markdown-sanitize-policy'),
    );
    return;
  }
  root.jennyBrowserView = factory(
    root.inventoryActionButton,
    root.inventoryTextField,
    root.inventorySelectField,
    root.inventoryCheckbox,
    root.inventorySegmentedControl,
    root.chatMessageUtils,
    root.rendererTurnTreeProjector,
    root.rendererTurnRowProjector,
    root.marked,
    root.DOMPurify,
    root.markdownSanitizePolicy,
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  actionButton,
  textField,
  selectField,
  checkboxModule,
  segmentedControl,
  messageUtils,
  turnTreeProjector,
  turnRowProjector,
  markedModule,
  domPurifyModule,
  sanitizePolicy,
) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };


  const escapeHtml = typeof actionButton?.escapeHtml === 'function'
    ? actionButton.escapeHtml
    : (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));

  function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function idToken(value, fallback = 'item') {
    const normalized = text(value).trim();
    return /^[A-Za-z][A-Za-z0-9_-]*$/.test(normalized) ? normalized : fallback;
  }

  function artifactId(value) {
    const normalized = text(value).trim();
    return /^[A-Za-z0-9_-]{1,512}$/.test(normalized) ? normalized : '';
  }

  function button(options) {
    return typeof actionButton === 'function' ? actionButton(options) : '';
  }

  function field(options) {
    return typeof textField === 'function' ? textField(options) : '';
  }

  function check(options) {
    const checkbox = checkboxModule?.checkbox || checkboxModule;
    return typeof checkbox === 'function' ? checkbox(options) : '';
  }

  function choice(options) {
    return typeof selectField === 'function' ? selectField(options) : '';
  }

  function markdown(value, options = {}) {
    const source = text(value);
    if (!source) return '';
    try {
      const marked = markedModule?.marked || markedModule;
      if (typeof marked?.parse === 'function') {
        const purifier = typeof domPurifyModule?.sanitize === 'function'
          ? domPurifyModule
          : (typeof domPurifyModule === 'function' && typeof window !== 'undefined' ? domPurifyModule(window) : null);
        if (purifier?.sanitize) {
          const config = sanitizePolicy?.config || { ALLOWED_TAGS: [], ALLOWED_ATTR: [] };
          const html = marked.parse(source, { gfm: true, breaks: options.breaks === true });
          if (sanitizePolicy?.hardenAttributes && purifier.addHook && !purifier.__jennyBrowserPolicyHook) {
            purifier.addHook('afterSanitizeAttributes', sanitizePolicy.hardenAttributes);
            purifier.__jennyBrowserPolicyHook = true;
          }
          return purifier.sanitize(html, config);
        }
      }
    } catch (_error) {
      // The sanitizer's escaped fallback is the safe last resort for a partial
      // browser bundle or an unavailable optional Markdown dependency.
    }
    return escapeHtml(source).replace(/\n/g, '<br>');
  }

  function appShell(state) {
    const selected = state.selectedSessionId ? text(state.selectedSessionId) : '';
    const current = (state.sessions || []).find((session) => session.session_id === selected) || null;
    const title = text(current?.title, jt("browserView.jennyHostedWorkspace", "Jenny hosted workspace"));
    const control = state.control || {};
    const canControl = control.owned === true;
    const mutationBlocked = state.mutationPending === true;
    const hasOwner = Boolean(text(control.ownerClientId) && !canControl);
    const controlAction = canControl ? 'release-control' : 'acquire-control';
    const controlLabel = canControl ? jt("browserView.releaseControl", "Release control") : hasOwner ? jt("browserView.takeOver", "Take over") : jt("remote.banner.takeControl", "Take control");
    const controlTitle = hasOwner
      ? jt("browserView.takeOverThisConversationFromTheCurrentBrowser", "Take over this conversation from the current browser")
      : canControl ? jt("browserView.releaseTheConversationController", "Release the conversation controller") : jt("browserView.becomeTheConversationController", "Become the conversation controller");

    const planMarkup = typeof segmentedControl === 'function'
      ? segmentedControl({
        id: 'plan-mode',
        ariaLabel: jt("browserView.planMode", "Plan mode"),
        value: state.planMode ? 'on' : 'off',
        disabled: !canControl || mutationBlocked,
        className: 'browser-plan-picker',
        options: [{ value: 'off', label: jt("shell.topNav.chat", "Chat") }, { value: 'on', label: jt("browserView.planMode", "Plan mode") }],
      })
      : '';
    return `<div class="browser-app" data-browser-app>
      <header class="browser-topbar">
        <div class="browser-brand"><span class="browser-brand-mark" aria-hidden="true">J</span><span>Jenny</span><span class="browser-host-badge">${escapeHtml(jt("models.library.hosted", "Hosted"))}</span></div>
          <div class="browser-top-actions">
           <span class="browser-connection" data-browser-connection aria-live="polite">${escapeHtml(connectionLabel(state))}</span>
           ${button({ id: 'manage-auth-sessions', label: jt("browserView.manageAccess", "Manage access"), variant: 'ghost', size: 'sm', ariaExpanded: state.authSessionsOpen === true })}
           ${button({ id: 'logout', label: jt("browserView.logOut", "Log out"), variant: 'ghost', size: 'sm' })}
           <div class="browser-auth-sessions" data-auth-sessions${state.authSessionsOpen === true ? '' : ' hidden'}></div>
         </div>
      </header>
      <div class="browser-layout">
        <aside class="browser-sessions" aria-label="${escapeHtml(jt("browserView.conversations", "Conversations"))}">
          <div class="browser-rail-heading"><span>${escapeHtml(jt("browserView.conversations", "Conversations"))}</span>${button({ id: 'new-session', label: jt("browserView.new", "New"), variant: 'secondary', size: 'sm', disabled: mutationBlocked })}</div>
          <div class="browser-session-list" data-session-list></div>
          <p class="browser-rail-note">${escapeHtml(jt("browserView.historyStaysOnTheJennyHost", "History stays on the Jenny host."))}</p>
        </aside>
        <main class="browser-conversation" aria-label="${escapeHtml(jt("browserView.conversation", "Conversation"))}">
          <header class="browser-conversation-header">
            <div class="browser-conversation-title"><h1 data-conversation-title>${escapeHtml(title)}</h1><span data-session-revision></span></div>
            <div class="browser-conversation-controls">
              ${planMarkup}
              ${button({ id: controlAction, label: controlLabel, variant: canControl ? 'ghost' : hasOwner ? 'primary' : 'secondary', size: 'sm', title: controlTitle, dataset: { takeover: hasOwner ? 'true' : 'false' } })}
            </div>
          </header>
          <div class="browser-transcript" data-transcript role="log" aria-live="polite" aria-relevant="additions text"></div>
          <div class="browser-pending" data-pending></div>
           <div class="browser-live" data-live aria-live="polite"></div>
           <div class="browser-artifact-previews" data-artifact-previews aria-live="polite"></div>
           <div class="browser-composer-wrap" data-composer-wrap></div>
          <div class="browser-status" data-browser-status role="status"></div>
          <div data-mutation-retry hidden>${button({ id: 'reconcile-request', label: jt("browserView.checkRequest", "Check request"), variant: 'secondary', size: 'sm', disabled: state.mutationChecking === true })}</div>
          <div data-snapshot-retry hidden>${button({ id: 'reload-conversation', label: jt("browserView.reloadConversation", "Reload conversation"), variant: 'secondary', size: 'sm' })}</div>
        </main>
      </div>
    </div>`;
  }

  function loginView(state) {
    return `<main class="browser-login" data-browser-login>
      <div class="browser-login-card">
        <div class="browser-brand browser-brand--login"><span class="browser-brand-mark" aria-hidden="true">J</span><span>Jenny</span></div>
        <h1>${escapeHtml(jt("browserView.signInToYourJennyHost", "Sign in to your Jenny host"))}</h1>
        <p class="browser-login-copy">${escapeHtml(jt("browserView.resumeYourLocalConversationsThroughThisPrivateHostedSurface", "Resume your local conversations through this private hosted surface."))}</p>
        ${field({ id: 'login-password', label: jt("browserView.hostPassword", "Host password"), type: 'password', placeholder: jt("browserView.enterYourPassword", "Enter your password"), autocomplete: 'current-password', maxLength: 512, className: 'browser-login-field' })}
        <div class="browser-login-actions">${button({ id: 'login-submit', label: state.busy ? jt("browserView.signingIn", "Signing in…") : jt("browserView.signIn", "Sign in"), variant: 'primary', size: 'lg', disabled: state.busy })}</div>
        <p class="browser-error" data-login-error${state.error ? '' : ' hidden'}>${escapeHtml(text(state.error))}</p>
      </div>
    </main>`;
  }

  function connectionLabel(state) {
    if (state.connectionState === 'connected') return 'Connected';
    if (state.connectionState === 'reconnecting' || state.connectionState === 'connecting') return 'Reconnecting…';
    if (state.connectionState === 'stopped') return 'Offline';
    return text(state.connectionState, 'Connecting…');
  }

  function renderSessionList(rootEl, state) {
    const list = rootEl.querySelector('[data-session-list]');
    if (!list) return;
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    if (!sessions.length) {
      list.innerHTML = `<p class="browser-empty">${escapeHtml(jt("browserView.noConversationsYet", "No conversations yet."))}</p>`;
      return;
    }
    list.innerHTML = sessions.map((session) => {
      const sessionId = text(session?.session_id);
      if (!sessionId) return '';
      const selected = sessionId === text(state.selectedSessionId);
      const editing = sessionId === text(state.editingSessionId);
      const safeId = idToken(sessionId, 'session');
      const title = text(session.title, jt("browserView.untitledConversation", "Untitled conversation"));
      const content = editing
        ? `<div class="browser-session-edit">${field({ id: `session-rename-${safeId}`, value: title, label: jt("browserView.conversationTitle", "Conversation title"), ariaLabel: jt("browserView.renameValue", "Rename {value1}", { value1: String(title) }), maxLength: 80, disabled: state.mutationPending === true, className: 'browser-rename-field' })}<div class="browser-session-edit-actions">${button({ id: 'save-session-title', label: jt("common.save", "Save"), variant: 'primary', size: 'sm', disabled: state.mutationPending === true, dataset: { 'session-id': sessionId } })}${button({ id: 'cancel-session-title', label: jt("common.cancel", "Cancel"), variant: 'ghost', size: 'sm', dataset: { 'session-id': sessionId } })}</div></div>`
        : button({
          id: 'select-session',
          plain: true,
          className: 'browser-session-select',
          ariaLabel: title,
          ariaSelected: selected,
          dataset: { 'session-id': sessionId, 'session-current': selected ? 'true' : 'false' },
          trustedHtml: `<span class="browser-session-title">${escapeHtml(title)}</span><span class="browser-session-meta">${escapeHtml(session.message_count == null ? '' : jt("browserView.valueMessages", "{value1} messages", { value1: String(session.message_count) }))}</span>`,
        });
      if (editing) return `<div class="browser-session browser-session--editing" data-session-id="${escapeHtml(sessionId)}">${content}</div>`;
      return `<div class="browser-session${selected ? ' browser-session--selected' : ''}" data-session-id="${escapeHtml(sessionId)}">${content}<div class="browser-session-actions">${button({ id: 'rename-session', disabled: !selected || !state.control?.owned || state.mutationPending === true, label: jt("common.rename", "Rename"), ariaLabel: jt("browserView.renameValue", "Rename {value1}", { value1: String(title) }), variant: 'ghost', size: 'sm', dataset: { 'session-id': sessionId } })}${button({ id: 'delete-session', disabled: !selected || !state.control?.owned || state.mutationPending === true, label: jt("common.delete", "Delete"), ariaLabel: jt("browserView.deleteValue", "Delete {value1}", { value1: String(title) }), variant: 'ghost', size: 'sm', dataset: { 'session-id': sessionId } })}</div></div>`;
    }).join('');
  }

  function projectRows(snapshot) {
    const messages = messageUtils?.normalizeChatMessages?.(snapshot?.messages) || [];
    const tree = turnTreeProjector?.projectTurnTree?.({
      ...snapshot,
      messages,
    });
    if (!tree || !Array.isArray(tree.turns)) return [];
    const rows = [];
    for (const turn of tree.turns) {
      const projected = turnRowProjector?.projectTurn?.(turn, { deterministicRowId: true });
      const turnRows = projected?.rows || turnRowProjector?.projectTurnRows?.(turn.events, { deterministicRowId: true }) || [];
      rows.push(...turnRows);
    }
    return rows;
  }

  const INERT_ARTIFACT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'";
  function buildInertArtifactDocument(source) { return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${INERT_ARTIFACT_CSP}"></head><body>${text(source)}</body></html>`; }
  function artifactMimeType(value) { const raw = text(value).toLowerCase(); const aliases = { 'text/html': 'html', 'text/markdown': 'markdown', 'image/svg+xml': 'svg+xml', 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'application/json': 'json' }; const normalized = aliases[raw] || raw; return new Set(['text/plain', 'html', 'markdown', 'svg+xml', 'png', 'jpeg', 'webp', 'json', 'octet-stream']).has(normalized) ? normalized : 'octet-stream'; }
  function artifactRefForId(snapshot, artifactIdentifier) {
    const id = artifactId(artifactIdentifier);
    if (!id) return null;
    const found = [];
    for (const message of (Array.isArray(snapshot?.messages) ? snapshot.messages : [])) { const result = message?.tool_result || message?.toolResult; if (Array.isArray(result?.generated_artifacts)) found.push(...result.generated_artifacts); }
    for (const row of projectRows(snapshot)) if (Array.isArray(row?.payload?.generated_artifacts)) found.push(...row.payload.generated_artifacts);
    return found.find((artifact) => text(artifact?.artifact_id || artifact?.artifactId) === id) || null;
  }
  function artifactFileName(value, fallback = 'artifact') { const name = text(value).split(/[\\/]/).pop().trim().slice(0, 255); return name || fallback; }
  function artifactDownloadName(disposition, ref) { const encoded = text(disposition).match(/filename\*=UTF-8''([^;]+)/i)?.[1]; if (encoded) { try { return artifactFileName(decodeURIComponent(encoded)); } catch (_error) { /* fallback */ } } const quoted = text(disposition).match(/filename="([^"]+)"/i)?.[1] || text(disposition).match(/filename=([^;]+)/i)?.[1]; return artifactFileName(quoted || ref?.file_name || ref?.fileName || ref?.title); }
  async function renderArtifactPreview(target, options = {}) {
    const { id, ref, result, sessionId, isCurrent, trackUrl } = options;
    const blob = result?.blob;
    if (!target || !blob || !Number.isSafeInteger(Number(blob.size)) || Number(blob.size) > 4 * 1024 * 1024) { if (target && isCurrent?.()) target.textContent = jt("browserView.previewUnavailableBecauseThisArtifactExceedsThe4Mib", "Preview unavailable because this artifact exceeds the 4 MiB preview limit."); return; }
    const kind = artifactMimeType(result.artifactMimeType || ref?.mime_type);
    const section = document.createElement('section'); section.className = 'browser-artifact-preview'; section.dataset.artifactPreview = text(id);
    section.appendChild(Object.assign(document.createElement('strong'), { textContent: jt("browserView.previewValue", "Preview · {value1}", { value1: String(artifactFileName(ref?.file_name || ref?.fileName || ref?.title)) }) }));
    let child;
    if (kind === 'text/plain' || kind === 'markdown' || kind === 'json') { if (typeof blob.text !== 'function') return; const content = await blob.text(); if (!isCurrent?.()) return; child = document.createElement('pre'); child.textContent = content; }
    else if (kind === 'html' || kind === 'svg+xml') { if (typeof blob.text !== 'function') return; const content = await blob.text(); if (!isCurrent?.()) return; child = document.createElement('iframe'); child.setAttribute('sandbox', ''); child.setAttribute('title', jt("browserView.previewOfValue", "Preview of {value1}", { value1: String(artifactFileName(ref?.file_name || ref?.fileName || ref?.title)) })); child.src = trackUrl(`${sessionId}:${id}:preview`, new Blob([buildInertArtifactDocument(content)], { type: 'text/html' })); }
    else if (kind === 'png' || kind === 'jpeg' || kind === 'webp') { child = document.createElement('img'); child.src = trackUrl(`${sessionId}:${id}:preview`, blob); child.alt = artifactFileName(ref?.file_name || ref?.fileName || ref?.title); }
    else { child = document.createElement('p'); child.textContent = jt("browserView.previewUnavailableForThisArtifactType", "Preview unavailable for this artifact type."); }
    section.appendChild(child); if (isCurrent?.()) target.replaceChildren(section);
  }

  function renderAttachmentList(attachments) {
    const entries = Array.isArray(attachments) ? attachments : [];
    if (!entries.length) return '';
    return `<div class="browser-attachments" data-attachment-list>${entries.map((attachment) => {
      const id = text(attachment?.id);
      const name = text(attachment?.display_name, 'Attachment');
      const type = text(attachment?.mime_type);
      const size = Number.isSafeInteger(attachment?.size_bytes) ? ` · ${Math.ceil(attachment.size_bytes / 1024)} KB` : '';
      const open = id ? button({ id: 'open-attachment', label: jt("common.open", "Open"), variant: 'ghost', size: 'sm', ariaLabel: jt("browserView.openValue", "Open {value1}", { value1: String(name) }), dataset: { 'attachment-id': id } }) : '';
      return `<span class="browser-attachment" data-attachment-id="${escapeHtml(id)}"><span class="browser-attachment-name">${escapeHtml(name)}</span><span class="browser-attachment-meta">${escapeHtml(`${type}${size}`)}</span>${open}</span>`;
    }).join('')}</div>`;
  }

  function renderArtifactList(artifacts) {
    const entries = Array.isArray(artifacts) ? artifacts : [];
    const valid = entries.map((artifact) => ({ artifact, id: artifactId(artifact?.artifact_id || artifact?.artifactId) })).filter((entry) => entry.id);
    if (!valid.length) return '';
    return `<div class="browser-artifacts" data-artifact-list>${valid.map(({ artifact, id }) => {
      const name = text(artifact?.file_name || artifact?.title, jt("artifacts.generated.defaultTitle", "Generated artifact"));
      const type = text(artifact?.mime_type || artifact?.language, 'artifact');
      return `<span class="browser-artifact" data-artifact-id="${escapeHtml(id)}"><span class="browser-artifact-name">${escapeHtml(name)}</span><span class="browser-artifact-meta">${escapeHtml(type)}</span>${button({ id: 'preview-artifact', label: jt("ide.rail.preview", "Preview"), variant: 'ghost', size: 'sm', ariaLabel: jt("browserView.previewValue2", "Preview {value1}", { value1: String(name) }), dataset: { 'artifact-id': id } })}${button({ id: 'download-artifact', label: jt("artifacts.actions.download", "Download"), variant: 'ghost', size: 'sm', ariaLabel: jt("browserView.downloadValue", "Download {value1}", { value1: String(name) }), dataset: { 'artifact-id': id } })}</span>`;
    }).join('')}</div>`;
  }

  function renderFullMessageAction(message, messageId) {
    if (message?.full_message_available !== true || !text(messageId)) return '';
    return `<div class="browser-full-message">${button({ id: 'load-full-message', label: jt("browserView.loadFullMessage", "Load full message"), variant: 'ghost', size: 'sm', dataset: { 'message-id': messageId } })}</div>`;
  }

  function renderRow(row, context = {}) {
    const payload = row?.payload || {};
    const kind = text(row?.kind);
    const rowClass = `browser-row browser-row--${idToken(kind, 'notice').toLowerCase()}`;
    const message = context.messageById?.get(text(row.primary_message_id));
    if (kind === 'user_bubble') return `<article class="${rowClass} browser-bubble browser-bubble--user" data-row-id="${escapeHtml(text(row.row_id))}"><div class="browser-bubble-label">${escapeHtml(jt("browserView.you", "You"))}</div><div class="browser-bubble-content">${escapeHtml(text(payload.content))}</div>${renderAttachmentList(payload.attachments)}${renderFullMessageAction(message, row.primary_message_id)}</article>`;
    if (kind === 'assistant_text') return `<article class="${rowClass} browser-bubble browser-bubble--assistant" data-row-id="${escapeHtml(text(row.row_id))}"><div class="browser-bubble-label">Jenny <span>${escapeHtml(text(row.assistant_phase || payload.assistant_phase))}</span></div><div class="browser-bubble-content markdown-body">${markdown(payload.text)}</div>${renderFullMessageAction(message, row.primary_message_id)}</article>`;
    if (kind === 'reasoning') {
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      return `<details class="${rowClass} browser-reasoning" data-row-id="${escapeHtml(text(row.row_id))}"><summary>${escapeHtml(payload.completed ? jt('browserView.reasoningComplete', 'Reasoning · complete') : jt('chat.reasoning.label', 'Reasoning'))}</summary><div class="browser-reasoning-body">${entries.map((entry) => `<p>${markdown(entry?.text, { mermaid: 'plain' })}</p>`).join('')}</div></details>`;
    }
    if (kind === 'tool_call' || kind === 'tool_step') {
      const state = text(payload.state, 'requested');
      const input = payload.input && typeof payload.input === 'object' ? JSON.stringify(payload.input, null, 2) : text(payload.input_json);
      return `<article class="${rowClass} browser-tool" data-row-id="${escapeHtml(text(row.row_id))}"><div class="browser-tool-head"><span class="browser-tool-name">${escapeHtml(text(payload.tool_name, 'Tool'))}</span><span class="browser-tool-state">${escapeHtml(state)}</span></div>${payload.summary ? `<p>${escapeHtml(text(payload.summary))}</p>` : ''}${input ? `<pre>${escapeHtml(input)}</pre>` : ''}</article>`;
    }
    if (kind === 'tool_result') {
      const output = text(payload.output_text);
       return `<article class="${rowClass} browser-tool browser-tool--result" data-row-id="${escapeHtml(text(row.row_id))}"><div class="browser-tool-head"><span class="browser-tool-name">${escapeHtml(text(payload.tool_name, jt("browserView.toolResult", "Tool result")))}</span><span class="browser-tool-state">${escapeHtml(text(payload.state, payload.is_error ? 'error' : 'complete'))}</span></div>${payload.result_summary ? `<p>${escapeHtml(text(payload.result_summary))}</p>` : ''}${output ? `<div class="browser-tool-output markdown-body">${markdown(output, { mermaid: 'plain' })}</div>` : ''}${renderArtifactList(payload.generated_artifacts)}</article>`;
    }
    if (kind === 'approval_gap') return `<aside class="${rowClass} browser-inline-notice" data-row-id="${escapeHtml(text(row.row_id))}"><strong>${escapeHtml(jt("browserView.approvalRequired", "Approval required"))}</strong><span>${escapeHtml(text(payload.tool_name || payload.prompt, jt("browserView.aOneOffToolApprovalIsWaiting", "A one-off tool approval is waiting.")))}</span></aside>`;
    if (kind === 'batch') return `<article class="${rowClass} browser-inline-notice" data-row-id="${escapeHtml(text(row.row_id))}"><strong>${escapeHtml(jt("browserView.jennyHasAQuestion", "Jenny has a question"))}</strong><div class="markdown-body">${markdown(payload.content)}</div></article>`;
    if (kind === 'attachment') return `<div class="${rowClass}" data-row-id="${escapeHtml(text(row.row_id))}">${renderAttachmentList(payload.attachments)}</div>`;
    if (kind === 'system_notice') return `<aside class="${rowClass} browser-inline-notice" data-row-id="${escapeHtml(text(row.row_id))}">${escapeHtml(text(payload.content || payload.subkind || jt("browserView.systemUpdate", "System update")))}</aside>`;
    const body = text(payload.content || payload.text || payload.summary);
    return body ? `<article class="${rowClass} browser-inline-notice" data-row-id="${escapeHtml(text(row.row_id))}">${markdown(body)}</article>` : '';
  }

  function renderTranscript(rootEl, state) {
    const transcript = rootEl.querySelector('[data-transcript]');
    if (!transcript) return;
    const snapshot = state.snapshot;
    if (!snapshot) {
      transcript.innerHTML = `<div class="browser-empty browser-empty--transcript">${escapeHtml(jt("browserView.selectAConversationToBegin", "Select a conversation to begin."))}</div>`;
      return;
    }
    const rows = projectRows(snapshot);
    const messageById = new Map((Array.isArray(snapshot.messages) ? snapshot.messages : [])
      .filter((message) => text(message?.id))
      .map((message) => [text(message.id), message]));
    const older = snapshot.has_more && text(snapshot.next_before_message_id)
      ? `<div class="browser-load-older">${button({ id: 'load-older', label: jt("browserView.loadOlderMessages", "Load older messages"), variant: 'ghost', size: 'sm' })}</div>`
      : '';
    transcript.innerHTML = older + (rows.length
      ? rows.map((row) => renderRow(row, { messageById, sessionId: state.selectedSessionId })).join('')
      : `<div class="browser-empty browser-empty--transcript">${escapeHtml(jt("browserView.thisConversationIsReadyForANewMessage", "This conversation is ready for a new message."))}</div>`);
  }

  function renderPending(rootEl, state) {
    const pending = rootEl.querySelector('[data-pending]');
    if (!pending) return;
    const snapshot = state.snapshot || {};
    const approvals = Array.isArray(snapshot.pending_approvals) ? snapshot.pending_approvals : [];
    const questions = Array.isArray(snapshot.pending_questions) ? snapshot.pending_questions : [];
    const canAct = state.control?.owned === true && state.mutationPending !== true;
    const chunks = [];
    for (const approval of approvals) {
      const approvalId = text(approval.approval_id);
      const streamId = text(approval.stream_id);
      if (!approvalId || !streamId) continue;
      const busy = state.pendingDecisionKey === `approval:${approvalId}`;
      chunks.push(`<section class="browser-decision browser-decision--approval"><div class="browser-decision-kicker">${escapeHtml(jt("browserView.oneOffApproval", "One-off approval"))}</div><h2>${escapeHtml(text(approval.tool_name, jt("browserView.toolRequest", "Tool request")))}</h2><p>${escapeHtml(text(approval.summary, jt("browserView.jennyIsWaitingForYourDecision", "Jenny is waiting for your decision.")))}</p>${approval.policy_consequence ? `<p class="browser-decision-note">${escapeHtml(text(approval.policy_consequence))}</p>` : ''}<div class="browser-decision-actions">${button({ id: 'approve-tool', label: busy ? jt("ide.changes.working", "Working…") : jt("browserView.approveOnce", "Approve once"), variant: 'primary', size: 'sm', disabled: !canAct || busy, dataset: { 'approval-id': approvalId, 'stream-id': streamId, 'decision-revision': text(approval.decision_revision), approved: 'true' } })}${button({ id: 'deny-tool', label: jt("approval.block.deny", "Deny"), variant: 'ghost', size: 'sm', disabled: !canAct || busy, dataset: { 'approval-id': approvalId, 'stream-id': streamId, 'decision-revision': text(approval.decision_revision), approved: 'false' } })}</div></section>`);
    }
    for (const batch of questions) {
      const questionRef = text(batch.question_ref);
      const streamId = text(batch.stream_id);
      if (!questionRef || !streamId) continue;
      const busy = state.pendingDecisionKey === `questions:${questionRef}`;
      const items = Array.isArray(batch.questions) ? batch.questions : [];
      chunks.push(`<section class="browser-decision browser-decision--questions"><div class="browser-decision-kicker">${escapeHtml(jt("browserView.jennyNeedsAnAnswer", "Jenny needs an answer"))}</div><div class="browser-question-list">${items.map((question, index) => {
        const questionId = text(question?.id);
        if (!questionId) return '';
        const options = Array.isArray(question.options) ? question.options.filter((option) => option?.id && option?.label).map((option) => ({ value: text(option.id), label: text(option.label) })) : [];
        const multiSelect = question.multi_select === true;
        let input;
        if (multiSelect && options.length) {
          input = `<div class="browser-question-options browser-question-options--checklist" role="group" aria-label="${escapeHtml(text(question.prompt))}">${options.map((option) => check({ id: `question-${idToken(questionId, `q${index}`)}-${idToken(option.value, 'option')}`, label: option.label, disabled: !canAct || busy, dataset: { 'question-id': questionId, 'question-option-id': option.value } })).join('')}</div>`;
        } else if (!multiSelect && options.length && options.length <= 4) {
          input = choice({ id: `question-${idToken(questionId, `q${index}`)}`, label: text(question.prompt), ariaLabel: text(question.prompt), options: [{ value: '', label: jt("browserView.chooseAnAnswer", "Choose an answer") }, ...options, ...(question.allow_other === true ? [{ value: '__other__', label: jt("common.other", "Other") }] : [])], disabled: !canAct || busy, dataset: { 'question-id': questionId } });
        } else {
          input = field({ id: `question-${idToken(questionId, `q${index}`)}`, label: text(question.prompt), placeholder: multiSelect ? jt("browserView.chooseOneOrMoreValues", "Choose one or more values") : jt("browserView.yourAnswer", "Your answer"), disabled: !canAct || busy, maxLength: 8000, dataset: { 'question-id': questionId, 'question-multi': multiSelect ? 'true' : 'false' } });
        }
        const other = question.allow_other === true
          ? field({ id: `question-other-${idToken(questionId, `q${index}`)}`, label: jt("browserView.otherOptional", "Other (optional)"), placeholder: jt("browserView.addYourOwnAnswer", "Add your own answer"), disabled: !canAct || busy, maxLength: 8000, dataset: { 'question-other-for': questionId } })
          : '';
        return `<div class="browser-question" data-question-block="${escapeHtml(questionId)}"><p class="browser-question-prompt">${escapeHtml(text(question.prompt))}</p>${input}${other}${options.length ? `<p class="browser-question-options">${options.map((option) => escapeHtml(option.label)).join(' · ')}</p>` : ''}</div>`;
      }).join('')}</div><div class="browser-decision-actions">${button({ id: 'answer-questions', label: busy ? jt("chat.send.sendingStatus", "Sending…") : jt("browserView.sendAnswers", "Send answers"), variant: 'primary', size: 'sm', disabled: !canAct || busy, dataset: { 'question-ref': questionRef, 'stream-id': streamId } })}${button({ id: 'decline-questions', label: jt("browserView.decline", "Decline"), variant: 'ghost', size: 'sm', disabled: !canAct || busy, dataset: { 'question-ref': questionRef, 'stream-id': streamId } })}</div></section>`);
    }
    pending.innerHTML = chunks.join('');
  }

  function renderLive(rootEl, state) {
    const live = rootEl.querySelector('[data-live]');
    if (!live) return;
    const projection = state.liveProjection;
    if (!projection || !text(projection.stream_id)) {
      live.innerHTML = '';
      return;
    }
    const reasoning = Array.isArray(projection.reasoning) ? projection.reasoning : [];
    const assistant = text(projection.assistant_text || projection.current_segment_text);
    live.innerHTML = `<section class="browser-live-card"><div class="browser-live-kicker">${escapeHtml(jt('browserView.liveTurnPhase', 'Live turn · {phase}', { phase: text(projection.phase || projection.thinking_status || 'working') }))}</div>${reasoning.length ? `<details class="browser-live-reasoning" open><summary>${escapeHtml(jt("browserView.reasoningInProgress", "Reasoning in progress"))}</summary>${reasoning.map((entry) => `<p>${markdown(entry?.text, { mermaid: 'plain' })}</p>`).join('')}</details>` : ''}${assistant ? `<div class="browser-live-answer markdown-body">${markdown(assistant)}</div>` : `<p class="browser-live-placeholder">${escapeHtml(jt("app.jennyIsWorking", "Jenny is working…"))}</p>`}</section>`;
  }

  function renderComposer(rootEl, state) {
    const wrap = rootEl.querySelector('[data-composer-wrap]');
    if (!wrap) return;
    const selected = Boolean(text(state.selectedSessionId));
    const canControl = state.control?.owned === true;
    const active = Boolean(state.activeStreamId || state.snapshot?.active_turn?.stream_id);
    const disabled = !selected || !canControl || state.mutationPending === true || (!active && (state.snapshotPending || state.snapshotUnavailable))
      || (active && state.composerMode !== 'cancel');
    const hint = !selected ? jt('browserView.selectConversation', 'Select a conversation.') : !canControl ? jt("browserView.takeControlToSendAMessage", "Take control to send a message.") : active ? jt("browserView.jennyIsWorkingYouCanCancelTheAdmittedTurn", "Jenny is working. You can cancel the admitted turn.") : state.executionEnabled ? jt("browserView.offlineSandboxHint", "Approved commands run offline; command file changes are discarded. File tools save changes.") : jt("browserView.hostedMvpSupportsChatAndApprovedTypedWorkspaceOperations", "Chat and approved file tools are available. Command sandbox is disabled.");
    const queue = Array.isArray(state.attachments) ? state.attachments : [];
    const queuedMarkup = queue.length
      ? `<div class="browser-composer-attachments" data-attachment-queue aria-label="${escapeHtml(jt("browserView.queuedAttachments", "Queued attachments"))}">${queue.map((item) => {
        const name = text(item?.attachment?.display_name || item?.displayName || item?.file?.name, 'Attachment');
        const status = text(item?.status, 'uploading');
         const image = text(item?.mimeType || item?.file?.type).toLowerCase() !== 'text/plain';
         const statusLabel = status === 'uploaded' ? image ? jt("browserView.imageStagedCheckedWhenSent", "Image staged; checked when sent") : jt('healthPill.ready', 'Ready') : status === 'error' ? text(item?.error, jt("browserView.uploadFailed", "Upload failed")) : jt('browserView.uploading', 'Uploading…');
        const itemId = text(item?.clientId);
        return `<div class="browser-queued-attachment" data-attachment-queue-id="${escapeHtml(itemId)}"><span class="browser-queued-attachment-name">${escapeHtml(name)}</span><span class="browser-queued-attachment-status browser-queued-attachment-status--${escapeHtml(idToken(status, 'pending'))}">${escapeHtml(statusLabel)}</span>${status === 'error' ? button({ id: 'retry-attachment', label: jt("common.retry", "Retry"), variant: 'ghost', size: 'sm', disabled: !canControl, dataset: { 'queue-id': itemId } }) : ''}${button({ id: 'remove-attachment', label: jt("common.remove", "Remove"), variant: 'ghost', size: 'sm', disabled: active, dataset: { 'queue-id': itemId } })}</div>`;
      }).join('')}</div>`
      : '';
    const canAttach = selected && canControl && !active && state.mutationPending !== true;
    const controls = active
      ? button({ id: 'cancel-chat', label: jt("browserView.cancelTurn", "Cancel turn"), variant: 'danger', size: 'md', disabled: !canControl || state.mutationPending === true })
      : button({ id: 'send-chat', label: jt("common.send", "Send"), variant: 'primary', size: 'md', disabled });
    wrap.innerHTML = `<div class="browser-composer"><div class="browser-composer-field">${field({ id: 'composer-prompt', multiline: true, rows: 1, value: text(state.draft), placeholder: canControl ? jt("dashboard.widgets.ask.placeholder", "Ask Jenny…") : jt("browserView.takeControlToWrite", "Take control to write"), ariaLabel: jt("composer.input.label", "Message Jenny"), disabled, maxLength: 100000, spellcheck: true, className: 'browser-prompt-field' })}</div>${queuedMarkup}<div class="browser-composer-footer"><span class="browser-composer-hint">${escapeHtml(hint)}</span><span data-attachment-picker></span>${button({ id: 'choose-attachment', label: jt("commandPalette.hints.attach", "Attach"), variant: 'ghost', size: 'md', disabled: !canAttach, title: jt("browserView.attachAnImageOrTextFile", "Attach an image or text file") })}${controls}</div></div>`;
  }

  function renderDetails(rootEl, state) {
    const current = (state.sessions || []).find((session) => session.session_id === text(state.selectedSessionId)) || null;
    const title = rootEl.querySelector('[data-conversation-title]');
    const revision = rootEl.querySelector('[data-session-revision]');
    const connection = rootEl.querySelector('[data-browser-connection]');
    const status = rootEl.querySelector('[data-browser-status]');
    const retry = rootEl.querySelector('[data-snapshot-retry]');
    const mutationRetry = rootEl.querySelector('[data-mutation-retry]');
    if (retry) retry.hidden = !state.snapshotUnavailable || state.snapshotPending;
    if (mutationRetry) {
      mutationRetry.hidden = state.mutationPending !== true;
      const action = mutationRetry.querySelector('[data-action="reconcile-request"]');
      if (action) action.disabled = state.mutationChecking === true;
    }
    const authPanel = rootEl.querySelector('[data-auth-sessions]');
    const authToggle = rootEl.querySelector('[data-action="manage-auth-sessions"]');
    if (title) title.textContent = text(current?.title, jt("browserView.jennyHostedWorkspace", "Jenny hosted workspace"));
    if (revision) revision.textContent = text(state.snapshot?.session?.revision) ? jt("browserView.revisionValue", "Revision {value1}", { value1: String(text(state.snapshot.session.revision)) }) : '';
    if (connection) connection.textContent = connectionLabel(state);
    if (status) {
      status.textContent = text(state.error || state.statusMessage);
      status.classList.toggle('browser-status--error', Boolean(state.error));
    }
    if (authPanel) {
      authPanel.hidden = state.authSessionsOpen !== true;
      const sessions = Array.isArray(state.authSessions) ? state.authSessions : [];
      authPanel.innerHTML = state.authSessionsBusy
        ? `<p class="browser-auth-sessions-status">${escapeHtml(jt("browserView.loadingDevices", "Loading devices…"))}</p>`
        : `<div class="browser-auth-sessions-heading">${escapeHtml(jt("browserView.signedInDevices", "Signed-in devices"))}</div>${state.authSessionsError ? `<p class="browser-auth-sessions-status browser-status--error">${escapeHtml(state.authSessionsError)}</p>` : ''}${sessions.length ? `<div class="browser-auth-session-list">${sessions.map((session) => { const id = text(session?.id); if (!id) return ''; const current = session.current === true; const label = current ? jt("browserView.thisDevice", "This device") : jt("browserView.deviceValue", "Device {value1}", { value1: String(id.slice(0, 12)) }); return `<div class="browser-auth-session"><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(text(session.last_seen_at || session.created_at, jt("browserView.lastSeenUnavailable", "Last seen unavailable")))}</small></span>${button({ id: 'revoke-auth-session', label: current ? jt("browserView.signOut", "Sign out") : jt("settings.remote.revoke", "Revoke"), variant: current ? 'danger' : 'ghost', size: 'sm', dataset: { 'session-id': id } })}</div>`; }).join('')}</div>` : `<p class="browser-auth-sessions-status">${escapeHtml(jt("browserView.noActiveDevicesFound", "No active devices found."))}</p>`}`;
    }
    if (authToggle) authToggle.setAttribute('aria-expanded', state.authSessionsOpen === true ? 'true' : 'false');
    const plan = rootEl.querySelector('[data-inv-segmented="plan-mode"]');
    if (plan && typeof segmentedControl?.select === 'function') {
      segmentedControl.select(plan, state.planMode ? 'on' : 'off');
      for (const control of plan.querySelectorAll('button, input')) {
        control.disabled = state.control?.owned !== true || state.mutationPending === true;
      }
    }
    const newSession = rootEl.querySelector('[data-action="new-session"]');
    if (newSession) newSession.disabled = state.mutationPending === true;
    const controlButton = rootEl.querySelector('[data-action="acquire-control"], [data-action="release-control"]');
    if (controlButton) {
      controlButton.textContent = state.control?.owned ? jt("browserView.releaseControl", "Release control") : state.control?.ownerClientId ? jt("browserView.takeOver", "Take over") : jt("remote.banner.takeControl", "Take control");
      controlButton.dataset.takeover = state.control?.ownerClientId && !state.control?.owned ? 'true' : 'false';
      controlButton.classList.toggle('btn--primary', !state.control?.owned && Boolean(state.control?.ownerClientId));
      controlButton.disabled = state.controlBusy === true;
    }
  }

  function mount(rootEl, state) {
    if (!rootEl) return;
    const wantsLogin = state.authenticated !== true;
    const currentMode = rootEl.hasAttribute('data-browser-mounted') ? rootEl.querySelector('[data-browser-app]') ? 'app' : 'login' : '';
    const nextMode = wantsLogin ? 'login' : 'app';
    if (currentMode !== nextMode) {
      rootEl.innerHTML = wantsLogin ? loginView(state) : appShell(state);
      rootEl.setAttribute('data-browser-mounted', nextMode);
    }
    if (nextMode === 'login') {
      const error = rootEl.querySelector('[data-login-error]');
      if (error) { error.hidden = !state.error; error.textContent = text(state.error); }
      const submit = rootEl.querySelector('[data-action="login-submit"]');
      if (submit) submit.disabled = state.busy === true;
      return;
    }
    segmentedControl?.initSegmentedHandlers?.(rootEl);
    renderSessionList(rootEl, state);
    renderDetails(rootEl, state);
    renderTranscript(rootEl, state);
    renderPending(rootEl, state);
    renderLive(rootEl, state);
    renderComposer(rootEl, state);
  }

  return { mount, loginView, appShell, projectRows, renderRow, renderSessionList, renderTranscript, renderPending, renderLive, renderComposer, renderArtifactList, connectionLabel, artifactId, artifactRefForId, artifactFileName, artifactDownloadName, renderArtifactPreview, buildInertArtifactDocument, artifactMimeType };
});
