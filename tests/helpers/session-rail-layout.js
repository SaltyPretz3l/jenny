/* global document, window, getComputedStyle */
'use strict';

/* Shared pieces of the session rail's layout gate (tests/renderer-session-rail-layout.test.js): the injected rail
   modules, a fake bridge and a host element standing in for the Chat workbench's Session view. */

const fs = require('node:fs');
const path = require('node:path');
const { frames } = require('./chat-reading-layout-harness');

const ROOT = path.resolve(__dirname, '../..');

const inject = (page, files) => files.reduce((chain, file) => chain.then(() => page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, file), 'utf8') })), Promise.resolve());

/* Mounts the injected rails the way renderer-chat-event-transcript-bindings does: one per pane, its
   own session, hosted in one fixed element (the workbench's Session view). */
async function installRails(page, { summaryDelayMs = 0 } = {}) {
  await page.addStyleTag({ content: fs.readFileSync(path.join(ROOT, 'styles/chat-session-rail.css'), 'utf8') });
  await inject(page, [
    'renderer/chat/renderer-context-usage-model.js',
    'renderer/chat/renderer-context-preview.js',
    'renderer/chat/renderer-session-rail-model.js',
    'renderer/chat/renderer-session-rail-render.js',
    'renderer/chat/renderer-session-rail.js',
  ]);
  await page.evaluate(({ delayMs }) => {
    const wrap = (data, state = 'available') => ({ state, sampled_at: '2026-10-15T10:00:00.000Z', reason: null, data });
    const summaryFor = (sessionId) => ({
      session_id: sessionId, session_incarnation: `inc_${sessionId}`, revision: 1,
      environment: wrap({
        project_id: `p_${sessionId}`, project_name: sessionId === 'sess_two' ? 'second-project-with-a-rather-long-name-that-must-ellipsize' : 'jenny',
        workspace_id: 'w', display_path: 'D:\\Work\\jenny\\renderer\\features\\some\\very\\long\\directory\\name\\that\\cannot\\fit',
        branch: 'feature/session-rail-with-a-very-long-descriptive-branch-name', worktree_id: null, execution_environment: 'local', run_mode: 'auto',
      }),
      context: wrap({ turn_id: null, used_tokens: sessionId === 'sess_two' ? 29000 : 20480, capacity_tokens: 32000, available_tokens: 3000, measurement: 'actual', scope: 'request' }),
      outputs: wrap({ items: [{ artifact_id: `${sessionId}_a1`, display_name: 'a_rather_long_generated_file_name_for_the_probe.py', kind: 'code', availability: 'available' }, { artifact_id: `${sessionId}_a2`, display_name: 'results.md', kind: 'document', availability: 'available' }], total_count: 2, next_cursor: null }),
      changes: wrap({ workspace_id: 'w', scope: 'working_tree', file_count: 6, additions: 412, deletions: 37, ref: 'main', head: 'abc1234' }),
      background_tasks: wrap({ scope: 'session_and_direct_children', counts: { active: 1, waiting: 0, failed: 0, completed: 12 }, coverage: 'partial', unsupported_sources: ['linked_chat_turn'], items: [{ source_kind: 'workspace_test', operation_id: 'op_1', session_id: sessionId, state: 'running', started_at: null, finished_at: null, output_ref: null }] }),
    });
    const writes = [];
    const persisted = { disclosures: {} };
    window.__railWrites = writes;
    window.jennyShell = {
      chatWorkspace: {
        getSummary: async ({ session_id: sessionId }) => (await new Promise((resolve) => setTimeout(resolve, delayMs)), { schema_version: 1, ok: true, summary: summaryFor(sessionId), workspace_view: { schema_version: 1, disclosures: {}, children_expanded: null }, coordination_revision: 0 }),
        setView: async (request) => {
          writes.push(request);
          Object.assign(persisted.disclosures, request.patch.disclosures || {});
          return { schema_version: 1, ok: true, workspace_view: { schema_version: 1, ...persisted, children_expanded: null }, coordination_revision: writes.length };
        },
        onChanged: () => () => {},
      },
    };
    window.rendererChatWorkspaceDetail = { open: (request) => { window.__railDetail = request; } };
    const host = document.createElement('div');
    host.id = 'railHost';
    host.style.cssText = 'position:fixed;inset-block:0;inset-inline-end:0;inline-size:320px;overflow:auto;z-index:1000;';
    document.body.appendChild(host);
    window.rendererSessionRail.configure({ getHost: () => host });
    window.__rails = [];
    document.querySelectorAll('#chatView .chat-pane').forEach((paneEl) => {
      const sessionId = paneEl.dataset.paneId === '1' ? 'sess_two' : 'sess_one';
      window.__rails.push(window.rendererSessionRail.mountSessionRail({
        pane: paneEl, chatTimeline: paneEl.querySelector('.chat-timeline'), getSessionId: () => sessionId,
      }));
    });
  }, { delayMs: summaryDelayMs });
  await frames(page, 6);
}

module.exports = { ROOT, inject, installRails };
