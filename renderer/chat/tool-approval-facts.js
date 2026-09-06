/* renderer/chat/tool-approval-facts.js derives the approval card's app-derived
 * facts, the stated-purpose bound and the verbatim command preview from a tool
 * call's input. Facts are never inferred from free command/code text. Loaded
 * before tool-call-utils.js, which binds it at factory time and re-exports it
 * so consumers keep calling toolCallUtils.getApprovalFacts and related APIs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.toolApprovalFacts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Names for the effects a payload can declare -- not an ordering.
  // getApprovalFacts returns each tool's facts most consequential first.
  const APPROVAL_FACT_KINDS = Object.freeze({
    READ: 'read',
    WRITE: 'write',
    DELETE: 'delete',
    NETWORK: 'network',
    EXECUTE: 'execute',
  });

  const APPROVAL_PREVIEW_VALUE_MAX_CHARS = 240;
  const PATH_FACT_TARGETS = {
    Read: [APPROVAL_FACT_KINDS.READ, 'Reads'], Write: [APPROVAL_FACT_KINDS.WRITE, 'Writes'],
    Edit: [APPROVAL_FACT_KINDS.WRITE, 'Changes'], delete_file: [APPROVAL_FACT_KINDS.DELETE, 'Deletes'],
  };
  const APPROVAL_PURPOSE_MAX_CHARS = 240;

  function createToolApprovalFacts(deps) {
    const { normalizeToolKind, normalizeString } = deps || {};
    if (typeof normalizeToolKind !== 'function' || typeof normalizeString !== 'function') {
      throw new TypeError('normalizeToolKind and normalizeString must be functions');
    }

    function getApprovalPurpose(input) {
      const args = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
      if (!args || typeof args.purpose !== 'string') return '';
      const characters = Array.from(args.purpose.replace(/\s+/gu, ' ').trim());
      return characters.length > APPROVAL_PURPOSE_MAX_CHARS
        ? characters.slice(0, APPROVAL_PURPOSE_MAX_CHARS - 3).join('') + '...' : characters.join('');
    }

    function getApprovalFacts(toolName, input) {
      const args = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
      if (!args) return [];

      const kind = normalizeToolKind(toolName);
      const path = normalizeString(args.path || args.file_path);
      switch (kind) {
        case 'Bash':
        case 'python_execute':
        case 'run_temp_script': {
          const source = normalizeString(
            kind === 'Bash' ? args.command : kind === 'python_execute' ? args.code : args.script
          );
          if (!source) return [];
          // Command/code text conceals any effect: never scan it for facts. cwd is declared.
          const facts = [{ kind: APPROVAL_FACT_KINDS.EXECUTE, label: 'Jenny cannot check what this does' }];
          const cwd = kind === 'python_execute' ? '' : normalizeString(args.cwd);
          if (cwd) facts.push({ kind: APPROVAL_FACT_KINDS.EXECUTE, label: 'Runs in ' + cwd });
          return facts;
        }
        case 'Read':
        case 'Write':
        case 'Edit':
        case 'delete_file': {
          if (!path) return [];
          const [factKind, verb] = PATH_FACT_TARGETS[kind];
          const subtree = kind === 'delete_file' && args.recursive === true ? ' and everything under it' : '';
          return [{ kind: factKind, label: verb + ' ' + path + subtree }];
        }
        case 'Move':
        case 'move_file': {
          const moves = Array.isArray(args.moves) ? args.moves : [args];
          const hasInvalidPair = !moves.length || moves.some((move) => !move || typeof move !== 'object'
            || !normalizeString(move.source) || !normalizeString(move.destination));
          if (hasInvalidPair) return [];
          // overwrite is the declared difference between a move and a replacement.
          const writeVerb = args.overwrite === true ? 'Replaces ' : 'Writes ';
          const one = moves.length === 1 ? moves[0] : null;
          return [
            { kind: APPROVAL_FACT_KINDS.DELETE,
              label: 'Removes ' + (one ? normalizeString(one.source) : moves.length + ' source paths') },
            { kind: APPROVAL_FACT_KINDS.WRITE,
              label: writeVerb + (one ? normalizeString(one.destination) : moves.length + ' destination paths') },
          ];
        }
        case 'fetch_url': {
          const url = normalizeString(args.url);
          if (!url) return [];
          try {
            const host = new URL(url).host;
            return host ? [{ kind: APPROVAL_FACT_KINDS.NETWORK, label: 'Connects to ' + host }] : [];
          } catch (_error) {
            return [];
          }
        }
        case 'web_search':
          return normalizeString(args.query)
            ? [{ kind: APPROVAL_FACT_KINDS.NETWORK, label: 'Searches the web' }] : [];
        case 'Glob':
        case 'glob_files':
        case 'Grep':
        case 'grep_search': {
          const noun = kind === 'Glob' || kind === 'glob_files' ? 'file names' : 'files';
          const label = path ? 'Reads ' + noun + ' under ' + path : 'Reads matching ' + noun;
          return normalizeString(args.pattern) ? [{ kind: APPROVAL_FACT_KINDS.READ, label }] : [];
        }
        default:
          return [];
      }
    }

    function formatApprovalPreviewValue(value) {
      const text = value == null ? String(value) : String(value).replace(/\s+/gu, ' ').trim();
      return text.length <= APPROVAL_PREVIEW_VALUE_MAX_CHARS ? text
        : text.slice(0, APPROVAL_PREVIEW_VALUE_MAX_CHARS - 3) + '...';
    }

    /**
     * The exact payload the user is being asked to allow, for the approval
     * card's command preview. Shell/code tools show their verbatim command or
     * code (the risk lives there); path tools show the target; everything else
     * falls back to the full input as pretty JSON so nothing is hidden.
     * Returns '' when there is nothing meaningful to preview.
     */
    function getApprovalCommandPreview(toolName, input) {
      const args = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
      if (!args) return '';
      switch (normalizeToolKind(toolName)) {
        case 'Bash':
          return normalizeString(args.command);
        case 'python_execute':
          return normalizeString(args.code);
        case 'Read':
        case 'Write':
        case 'Edit':
        case 'delete_file':
          return normalizeString(args.path || args.file_path);
        case 'fetch_url':
          return normalizeString(args.url);
        case 'web_search':
          return normalizeString(args.query);
        case 'run_temp_script':
          return normalizeString(args.script);
        case 'Move':
        case 'move_file':
          return (Array.isArray(args.moves) ? args.moves : [args])
            .filter((move) => move && typeof move === 'object')
            .map((move) => normalizeString(move.source) + ' -> ' + normalizeString(move.destination))
            .filter((pair) => pair !== ' -> ').join('\n');
        // Both spellings: TOOL_KIND_ALIASES does not rewrite the manifest names,
        // so matching only the alias sent every glob/grep approval to the dump.
        case 'Glob':
        case 'glob_files':
        case 'Grep':
        case 'grep_search':
          return normalizeString(args.pattern);
        default: {
          const entries = Object.entries(args).filter(([key]) => key !== 'purpose');
          if (!entries.length) return '';
          const isFlat = entries.every(([, value]) => value === null || typeof value !== 'object');
          if (isFlat) {
            return entries.map(([key, value]) => key + ': ' + formatApprovalPreviewValue(value)).join('\n');
          }
          try {
            return JSON.stringify(Object.fromEntries(entries), null, 2);
          } catch (_error) {
            return '';
          }
        }
      }
    }

    return Object.freeze({
      APPROVAL_FACT_KINDS,
      getApprovalPurpose,
      getApprovalFacts,
      getApprovalCommandPreview,
      formatApprovalPreviewValue,
    });
  }

  return {
    APPROVAL_FACT_KINDS,
    createToolApprovalFacts,
  };
});
