'use strict';

// A page-actions instance over a fake reader, gate, settler and web contents, logging every call in order.
const { createPageActions } = require('../../services/browser-use/page-actions');
const { createCallLog, createFakeWebContents } = require('./fake-web-contents-view');

const READY_PROBE = Object.freeze({
  status: 'ready', ref: 'r12', isEditable: true, isFileInput: false, isSecret: false,
  fingerprint: 'fp-12', rect: { centerX: 10, centerY: 10 },
});
const PAGE = Object.freeze({ status: 'ok', url: 'https://example.test/', outline: ['r1 link Home'] });
const DEFAULT_REPLIES = {
  read: PAGE,
  find: { matches: [{ ref: 'r3', text: 'Pay' }], total: 1 },
  probe: READY_PROBE,
  probeFocused: { status: 'none' },
  verify: { status: 'ready', rect: { centerX: 100.4, centerY: 200.6 } },
  focusForTyping: { status: 'ready' },
  focusIs: { status: 'ready' },
  select: { status: 'selected' },
  scroll: { status: 'scrolled', moved: 300, atEnd: false },
  secretMask: { status: 'ok' },
  paints: { status: 'ok', paints: true },
  pressSeen: { status: 'ok', seen: true },
};

// replies: reader op -> value | Error | async fn(args); gateReplies likewise.
function harness({ wc = {}, replies = {}, gateReplies = {}, gateExtras = {}, settle, armView } = {}) {
  const log = createCallLog();
  const webContents = createFakeWebContents({ log, ...wc });
  const readerCalls = [];
  const pick = (table, key, fallback) => (Object.hasOwn(table, key) ? table[key] : fallback);
  const resolveReply = async (reply, args) => {
    const value = typeof reply === 'function' ? await reply(...args) : reply;
    if (value instanceof Error) throw value;
    return value;
  };
  const reader = {
    async call(op, args) {
      log.push({ who: 'reader', name: op, args: [args] });
      readerCalls.push({ op, args });
      return resolveReply(pick(replies, op, DEFAULT_REPLIES[op]), [args]);
    },
  };
  const gate = {};
  for (const name of ['beforeNavigate', 'beforeClick', 'beforeType', 'beforeSelect', 'beforePress']) {
    gate[name] = async (...args) => {
      log.push({ who: 'gate', name, args });
      return resolveReply(pick(gateReplies, name, { proceed: true }), args);
    };
  }
  for (const [name, fn] of Object.entries(gateExtras)) {
    gate[name] = () => (log.push({ who: 'gate', name, args: [] }), fn());
  }
  const settler = {
    waitForSettle: async (args) => {
      log.push({ who: 'settler', name: 'waitForSettle', args: [args.mode] });
      return settle ? settle(args) : { settled: true, reason: 'quiet' };
    },
  };
  const warnings = [];
  const actions = createPageActions({
    webContents, reader, gate, settler, logger: { warn: (...a) => warnings.push(a) },
    armView: armView && ((options) => (log.push({ who: 'host', name: 'armView', args: [] }), armView(options))),
  });
  const calls = (op) => readerCalls.filter(c => c.op === op);
  return { actions, log, webContents, readerCalls, calls, warnings };
}

module.exports = { DEFAULT_REPLIES, PAGE, READY_PROBE, harness };
