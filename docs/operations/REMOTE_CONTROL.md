---
kind: operations-doc
last_reviewed: 2026-09-09
---

# Remote Control availability and setup

Remote Control is an optional desktop feature that uses a signed plugin and
an owner-deployed relay with a phone portal. It is separate from
[Docker browser hosting](HOSTED_QUICKSTART.md), where browsers connect to one
persistent host.

## Availability in the public source

The core integration is present, but the current public source export does not
include the signed plugin package or relay/portal source. A Settings section
alone does not make Remote Control usable. The 1.1.0 draft does not announce a
public package, deployed relay or completed phone qualification.

Check the [release notes](../../RELEASE_NOTES.md) and
[release assets](https://github.com/SaltyPretz3l/jenny/releases) for a future
explicitly qualified distribution. Public users do not need the maintainer's
signing key and should not attempt the private signing ceremony.

## When a qualified distribution is available

Follow the installation and relay-deployment instructions supplied with that
exact package. Install and enable the signed plugin, configure the relay
address in Settings > Remote Control, then select **Turn on** and **Add device**
to pair a phone. Turn on alone does not open pairing. Shared chats are visible
to every paired phone.

Turning Remote Control off and choosing **Forget all devices** removes device
access in Jenny. Relay removal is separate and follows the distribution's
deployment instructions. The core feature flag cannot substitute for plugin
installation or explicit enablement.

## Trust and privacy

Jenny and the phone are outbound clients. The relay sees connection metadata
and message sizes but encrypted application frames protect conversation content.
It has no offline message mailbox.

The phone portal is a trusted endpoint: modified portal JavaScript can steal
pairing or device credentials despite transport encryption. Use the portal
associated with the reviewed distribution. Never share pairing fragments in
logs or screenshots.

Real-phone pairing, simultaneous decisions, disabling during active work,
restart behavior and private-network operation require qualification before
this feature is described as ready to use.

## Maintainer source checkout

For maintainers with the private relay/portal sources, install the locked relay
tooling with `npm --prefix remote/relay ci`, then authenticate the pinned CLI with
`npm --prefix remote/relay exec wrangler login`. Follow the relay package's
deployment configuration for the intended account; these commands do not deploy
a relay or make a public distribution available.

The `hs1` and `hs2` envelopes expose pairing or device IDs to the relay.
Handshake proof, credentials, and application frames are encrypted; connection
metadata is still visible. The portal remains a trusted endpoint.
