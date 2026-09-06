/* renderer/features/renderer-ide-send-utils.js - "Send to Jenny" bridge from
 * the Workspace IDE into the chat composer. Builds the prefill text (fenced
 * code block for editor selections, relative path for tabs/tree entries),
 * targets either the current (last visited) session or a freshly created one,
 * then switches to the chat view with the composer focused. Prefill only -
 * the user always reviews before sending. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeSendUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function noop() {}
  function noopAsync() { return Promise.resolve(); }

  // Longest backtick run inside the snippet decides the fence so embedded
  // ``` blocks (markdown files, docs) never terminate the fence early.
  function fenceFor(code) {
    let longest = 0;
    const matches = String(code || '').match(/`+/g) || [];
    for (const run of matches) {
      longest = Math.max(longest, run.length);
    }
    return '`'.repeat(Math.max(3, longest + 1));
  }

  // Dedupes a git-blame `lines` array (one entry per blamed line) down to the
  // unique commits that last touched the range, preserving first-seen order.
  // Each blame line is { sha, shortSha, author, dateISO, summary } from the
  // workspace-git service's porcelain parser.
  function summarizeBlameCommits(lines) {
    const out = [];
    const seen = new Set();
    for (const line of Array.isArray(lines) ? lines : []) {
      const sha = line && line.sha ? String(line.sha) : '';
      if (!sha || seen.has(sha)) {
        continue;
      }
      seen.add(sha);
      out.push({
        shortSha: String(line.shortSha || sha.slice(0, 7)),
        author: String(line.author || '').trim(),
        dateISO: String(line.dateISO || ''),
        summary: String(line.summary || '').trim(),
      });
    }
    return out;
  }

  // Composes the "who changed this & why" instruction prepended above the
  // fenced selection. `commits` comes from summarizeBlameCommits; `range`
  // carries { path, startLine, endLine } for the human-readable line span.
  function buildBlameSummaryIntent(commits, range) {
    const list = Array.isArray(commits) ? commits : [];
    const path = String(range?.path || '');
    const startLine = Number(range?.startLine) || 0;
    const endLine = Number(range?.endLine) || startLine;
    const where = startLine
      ? (endLine > startLine ? `lines ${startLine}-${endLine}` : `line ${startLine}`)
      : 'the selected lines';
    const bullets = list.map((commit) => {
      const date = commit.dateISO ? commit.dateISO.slice(0, 10) : '';
      const who = commit.author || 'unknown author';
      const when = date ? `, ${date}` : '';
      const subject = commit.summary || '(no commit message)';
      return `- \`${commit.shortSha}\` "${subject}" — ${who}${when}`;
    }).join('\n');
    return [
      `In plain English, summarize who last changed ${where} of \`${path}\` and why,`,
      'based on the git blame history below. Group related commits and explain the intent behind the changes.',
      '',
      'Commits that last touched these lines:',
      bullets,
    ].join('\n');
  }

  // Picks the diagnostic marker "under the cursor": the marker on the active
  // path whose start line matches the cursor line, breaking ties by the
  // nearest start column. Returns null when no marker sits on the cursor line
  // (getMarkers only exposes each marker's start position, so a multi-line
  // diagnostic is "under" the cursor only on its first line). `cursor` is
  // { path, lineNumber, column }.
  function pickMarkerUnderCursor(markers, cursor) {
    const list = Array.isArray(markers) ? markers : [];
    const path = String(cursor?.path || '');
    const line = Number(cursor?.lineNumber) || 0;
    if (!path || !line) {
      return null;
    }
    const column = Number(cursor?.column) || 1;
    let best = null;
    let bestColDist = Infinity;
    for (const marker of list) {
      if (!marker || String(marker.path || '') !== path || (Number(marker.line) || 0) !== line) {
        continue;
      }
      const colDist = Math.abs((Number(marker.column) || 1) - column);
      if (colDist < bestColDist) {
        bestColDist = colDist;
        best = marker;
      }
    }
    return best;
  }

  // Extracts the lines around a 1-based center line (± radius) from a document's
  // full text, returning the snippet plus its 1-based [startLine, endLine] span.
  // EOLs are normalized to \n so the snippet is stable across CRLF documents.
  // Splits the whole document once per call; that is fine here - squiggle-fix is
  // a one-click interactive action, never a hot path.
  function sliceSurroundingLines(text, centerLine, radius) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const total = lines.length;
    const center = Math.max(1, Math.min(total, Number(centerLine) || 1));
    const span = Math.max(0, Number(radius) || 0);
    const startLine = Math.max(1, center - span);
    const endLine = Math.min(total, center + span);
    return {
      code: lines.slice(startLine - 1, endLine).join('\n'),
      startLine,
      endLine,
    };
  }

  // Composes the "fix this problem" instruction prepended above the fenced
  // surrounding code. `marker` is the Problems-panel view-model shape
  // { severity, source, code, message, line }.
  function buildFixSquiggleIntent(marker) {
    const m = marker || {};
    const severity = String(m.severity || 'problem').trim() || 'problem';
    const source = String(m.source || '').trim();
    const code = String(m.code || '').trim();
    const message = String(m.message || '').trim();
    const line = Number(m.line) || 0;
    const codeSuffix = code ? ` (${code})` : '';
    const origin = source ? ` reported by ${source}${codeSuffix}` : codeSuffix;
    const at = line ? ` at line ${line}` : '';
    return [
      `Fix this ${severity}${origin}${at}, then explain what was wrong and how the fix resolves it:`,
      '',
      message || '(no diagnostic message)',
      '',
      'Here is the surrounding code for context:',
    ].join('\n');
  }

  function buildSendToJennyText(payload) {
    if (payload?.kind === 'file_map_query') {
      const question = String(payload.question || '').trim();
      if (!question) {
        return '';
      }
      const summary = String(payload.summary || '');
      return `${question}\n\nWorkspace file map summary:\n\`\`\`\n${summary}\n\`\`\`\n`;
    }
    const path = String(payload?.path || '').trim();
    if (!path) {
      return '';
    }
    if (payload?.kind === 'code_selection') {
      const code = String(payload.code || '').replace(/\r\n/g, '\n');
      if (!code.trim()) {
        return '';
      }
      const startLine = Number(payload.startLine) || 0;
      const endLine = Number(payload.endLine) || startLine;
      const lineSuffix = startLine
        ? (endLine > startLine ? ` (lines ${startLine}-${endLine})` : ` (line ${startLine})`)
        : '';
      const language = payload.language && payload.language !== 'plaintext'
        ? String(payload.language)
        : '';
      const fence = fenceFor(code);
      // A selection-action intent (Explain/Fix/Refactor/Generate tests) prepends
      // its canned instruction above the fenced block; plain sends omit it.
      const intent = String(payload.intent || '').trim();
      const prefix = intent ? `${intent}\n\n` : '';
      return `${prefix}\`${path}\`${lineSuffix}:\n${fence}${language}\n${code.replace(/\n$/, '')}\n${fence}\n`;
    }
    return `\`${path}\` `;
  }

  function createIdeSendToJenny(deps) {
    const state = deps?.state || {};
    const getChatInput = typeof deps?.getChatInput === 'function'
      ? deps.getChatInput
      : () => deps?.dom?.chatInput || null;
    const callbacks = deps?.callbacks || {};
    const {
      handleCreateSession = noopAsync,
      setActiveView = noop,
      syncComposerInputHeight = noop,
      renderComposerState = noop,
      renderAll = noop,
      showShellErrorToast = noop,
      appendClientLog = noop,
    } = callbacks;

    async function handleSendToJenny(payload) {
      const text = buildSendToJennyText(payload);
      const initialChatInput = getChatInput();
      if (!text || !initialChatInput) {
        return false;
      }
      const wantsNewSession = payload?.target === 'new';
      if (wantsNewSession || !String(state.currentSessionId || '').trim()) {
        let createdSessionId = '';
        try {
          createdSessionId = String(await handleCreateSession() || '').trim();
        } catch (_error) {
          /* the existing bounded toast below owns user-facing failure */
        }
        if (!createdSessionId && (wantsNewSession || !String(state.currentSessionId || '').trim())) {
          showShellErrorToast('Could not open a chat session to send to.', {
            title: 'Send to Jenny',
            dedupeKey: 'ide:send:no-session',
          });
          return false;
        }
      }
      // Switching away from Workspace may reparent (or rebuild) the composer
      // when the IDE chat dock is enabled. Complete that render before writing
      // or focusing so the prefill lands in the live, editable textarea.
      setActiveView('chat');
      renderAll();
      const chatInput = getChatInput() || initialChatInput;
      // Append below any draft already in the composer instead of clobbering
      // it - collecting several snippets into one message is a feature.
      const existing = String(chatInput.value || '');
      const nextValue = existing.trim() ? `${existing.replace(/\s+$/, '')}\n\n${text}` : text;
      chatInput.value = nextValue;
      syncComposerInputHeight();
      renderComposerState();
      // A composer render is allowed to swap its textarea factory. Preserve
      // the prefill and focus the current node rather than a detached one.
      const focusTarget = getChatInput() || chatInput;
      if (focusTarget !== chatInput) {
        focusTarget.value = nextValue;
        syncComposerInputHeight();
      }
      focusTarget.focus?.();
      appendClientLog('INFO', 'ide.send_to_jenny', {
        kind: String(payload?.kind || ''),
        target: wantsNewSession ? 'new' : 'current',
      });
      return true;
    }

    return {
      handleSendToJenny,
    };
  }

  return {
    buildSendToJennyText,
    buildBlameSummaryIntent,
    buildFixSquiggleIntent,
    createIdeSendToJenny,
    pickMarkerUnderCursor,
    sliceSurroundingLines,
    summarizeBlameCommits,
  };
});
