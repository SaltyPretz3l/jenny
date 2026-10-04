# Sandboxed panel views (V5)

A `panel` contains HTML, JS and CSS assets that Jenny renders in an isolated renderer partition. A typical asset folder contains `view/index.html`, `view/app.js` and `view/styles.css`; every served asset is declared and digest-bound. No official package source tree remains in this checkout. Sandboxed views (`panel` and namespaced `artifact_renderer`) survive the 2026-10-02 retirement; setup scenes, provider descriptors and session-bound views are retired. A view is never bound to a chat session (`services/plugins/stage7-control-plane.js`).

## What the sandbox gives you

- Its own partition with deny-all permission handlers, no navigation, no popups, no downloads, no external protocols, no unapproved web requests.
- A fixed Content Security Policy: `script-src 'self'`, `style-src 'self'`, `connect-src 'none'`. Load scripts and styles from declared packaged files; inline code and remote resources are blocked. The protocol adds no nonce or automatic theme-token injection.
- One bridge object. Nothing else: no Node, no `fetch` to arbitrary hosts, no local paths.

## The view bridge

Envelope authority: `config/plugins/v1/plugin-view-bridge.schema.json`; calls, results and events use the frozen V5 schemas. The public preload object is `window.jennyPlugin` with `request(operation, payload)`, `subscribe(topic, listener)` and `cancel(requestId)`. `subscribe` returns an unsubscribe callback; there is no public `unsubscribe` method. Jenny builds the envelope and binds every bounded message to the sender, view instance, contribution, package digest, commit epoch and lifecycle epoch.

The content file lists permitted `allowed_bridge_operations` and
`allowed_event_topics`. The current host supplies `get_context`, `read_settings`,
`update_settings`, `artifact_read_chunk`, `artifact_ready` and `artifact_error`.
Frozen schemas still name provider operations, but content that requests those
operations, `provider_auth_changed` or a nonempty `provider_ref` is rejected.
An allowed operation without a host handler returns `bridge_operation_unavailable`;
a declaration does not create a capability.

For example, from a declared external `view/app.js`:

```javascript
const result = await window.jennyPlugin.request('get_context');
if (result.status === 'succeeded') {
  const context = JSON.parse(result.payload_json);
  // Only bounded plugin/contribution/generation identities are returned.
  document.querySelector('#status').textContent = context.plugin_id;
} else {
  document.querySelector('#status').textContent = result.reason_code;
}
```

The view content must allow `get_context`. Results are V5 envelopes with
`status`, `reason_code`, `retryable` and JSON text in `payload_json`. Use the
callback returned by `subscribe` to release a subscription on unmount; topics
in the schema do not guarantee that a host publishes events. The preload
returns an operation result promise, not a request handle for a progress stream.

## Files and attachments

Views never receive filesystem paths. The attachment-ticket path that once carried session-provider output into a view was retired on 2026-10-02; a request for it is just an unknown asset path.

## Behaviors Jenny expects

- Persist nothing authoritative in the view; Jenny owns state and revisions.
- Render a truthful degraded state when the bridge reports an operation unavailable or rejected.
- Full keyboard path, ARIA roles, focus stability under streaming, reduced motion respected.

Real-app panel layout, keyboard behavior and accessibility still require the
owner-run application gate; bridge/protocol tests cover bounded contracts.
