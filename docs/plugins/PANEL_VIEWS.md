# Sandboxed panel views (V5)

A `panel` is a folder of HTML, JS, and CSS that Jenny renders in an isolated renderer partition. A typical panel asset folder contains `view/index.html`, `view/app.js`, and `view/styles.css`; the official package that exercises this shape is not included in the public repository.

## What the sandbox gives you

- Its own partition with deny-all permission handlers, no navigation, no popups, no downloads, no external protocols, no unapproved web requests.
- A Content Security Policy with nonces; inline scripts without the nonce do not run.
- Jenny's theme tokens.
- One bridge object. Nothing else: no Node, no `fetch` to arbitrary hosts, no local paths.

## The view bridge

Authority: `config/plugins/v1/plugin-view-bridge.schema.json` (frozen, version 1). Methods: `request`, `subscribe`, `unsubscribe`, `cancel`. Every message is bounded in size, validated against the schema, and bound to the view instance, the plugin generation, and the session incarnation. A message that names a session, provider, generation, or host identity the view did not receive from Jenny is rejected.

Typical loop: `request` to start an operation, `subscribe` to its progress stream, `cancel` if the user backs out, `unsubscribe` on unmount.

## Files and attachments

Views never receive filesystem paths. Generated files cross into Jenny's attachment store and come back as five-minute random attachment-ticket URLs bound to the view, generation, session incarnation, operation, digest, and WebContents.

## Behaviors Jenny expects

- Persist nothing authoritative in the view; Jenny owns session state and revisions.
- Render a truthful degraded state when the bridge reports the provider unavailable, the session stale, or consent missing.
- Full keyboard path, ARIA roles, focus stability under streaming, reduced motion respected.

Still thin in this public guide: exact request and event payload examples, the trust chrome the user sees around the panel, and the accessibility checklist used for release verification.
